/* System 7 — the graph.
 *
 * All of the sound is made in dsp.ts and all of the numbers are in design.ts;
 * this file only builds nodes, places them in the street and decides when
 * things happen. Keeping it that way is what lets the whole system be checked
 * on the CPU: nothing here invents a level or a frequency.
 *
 * Two structural decisions worth knowing before reading it.
 *
 * The first is that every positional source is a `Spot` — an input gain, a
 * lowpass whose corner tracks distance, a panner, and a reverb send taken off
 * the mono point before the panner. The lowpass is the important one. Three's
 * PositionalAudio gives you an inverse-square level rolloff and a pan, and
 * that is *not* what distance sounds like; a horn two streets away is not a
 * quiet horn, it is a dull one. Attenuation without the filter reads as a
 * volume knob, which is the commonest way for a game street to sound wrong.
 *
 * The second is that all the spots are allocated once. Events borrow a spot
 * that already exists rather than building a panner per horn, so a walk that
 * fires forty rattles and three horns creates forty-three buffer sources and
 * no filters, panners or sends at all.
 */
import * as THREE from 'three';
import {
  trafficLayer, passByBuffer, hornBuffer, footstepBuffer, acLoopBuffer,
  rattleBuffer, kickBuffer, barBassNote, barBodyHit, neonBuffer, streetIR,
  barPattern, makeRng, dbToLin, linToDb, clamp, qToWebAudio, type Rng, type Samples,
} from './dsp';
import {
  SR, BED, BED_LAYERS, PASSBY, PASSBY_LANES, HORN, HORN_SPOTS, HORN_VOICES,
  STEPS, AC, AC_UNITS, AC_BUFFERS, BAR, NEON, IR, SENDS, MASTER, PANNER,
  PEAK_DB, airCutoffHz, stepVariation,
} from './design';

/* ── Debug surface types ───────────────────────────────────────────────── */

export type BusReport = {
  gainDb: number;
  /** Level right now. Zero for a bus whose sources are all transient. */
  nowDb: number;
  /** Decaying peak hold, so a transient bus reads as alive between events. */
  holdDb: number;
  /** Loudest thing this bus has ever passed. A bus still at -Infinity after a
   *  walk has a disconnected node or a zero gain in it, and that is the whole
   *  reason this field exists. */
  everDb: number;
};

export type SpotReport = {
  name: string;
  bus: string;
  pos: [number, number, number];
  /** Metres from the listener. */
  dist: number;
  /** Where the air-and-obstruction lowpass currently sits. */
  cutoffHz: number;
  gainDb: number;
  playing: boolean;
};

export type AudioReport = {
  state: string;
  built: boolean;
  buildMs: number;
  /** Build stages not yet run. Non-zero for the first few frames after the click. */
  pendingStages: number;
  sampleRate: number;
  time: number;
  /** Total sample memory held in AudioBuffers, in kilobytes. */
  bufferKb: number;
  /** Live AudioNodes created for one-shot events and not yet reclaimed. */
  voices: number;
  soloed: string | null;
  master: { gainDb: number; reductionDb: number };
  buses: Record<string, BusReport>;
  spots: SpotReport[];
  counts: { steps: number; horns: number; passBys: number; rattles: number; barHits: number };
  next: { hornIn: number; passByIn: number };
  /** Buses that have never passed a sample. Empty is the only good answer,
   *  and it is the answer to "is anything silently broken". */
  silent: string[];
};

export type AudioDebug = {
  /** Everything, right now. Cheap enough to poll but not free: it reads seven
   *  analysers, so it is a call rather than a live object. */
  report(): AudioReport;
  resume(): Promise<void>;
  setMasterDb(db: number): void;
  /** Mute every bus but one, or pass null to clear. For a listening test. */
  solo(bus: string | null): void;
  /** Force an event now, so a horn can be heard without waiting for one. */
  fire(what: 'horn' | 'passby' | 'step' | 'rattle' | 'sputter'): void;
  /** The engine, for anything the surface above did not anticipate. */
  engine: unknown;
};

/* ── Small helpers ─────────────────────────────────────────────────────── */

const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.min(xs.length - 1, Math.floor(rng() * xs.length))];
const range = (rng: Rng, r: readonly [number, number]): number => r[0] + rng() * (r[1] - r[0]);

/** Mono Float32Array to AudioBuffer, keeping the generator's own sample rate. */
function toBuffer(ctx: BaseAudioContext, x: Samples, sr: number): AudioBuffer {
  const b = ctx.createBuffer(1, x.length, sr);
  b.copyToChannel(x, 0);
  return b;
}

/**
 * Mono to a decorrelated stereo AudioBuffer by circular shift.
 *
 * Free width. Two copies of the same noise offset by a few tens of
 * milliseconds are uncorrelated everywhere above about 30 Hz, and because the
 * buffer loops the shift is circular and the seam stays seamless. Alternating
 * which channel leads across the three bed layers keeps the sum centred.
 */
function toStereoShifted(ctx: BaseAudioContext, x: Samples, sr: number, shiftMs: number): AudioBuffer {
  const n = x.length;
  const b = ctx.createBuffer(2, n, sr);
  const s = Math.round((Math.abs(shiftMs) / 1000) * sr) % n;
  const y = new Float32Array(n);
  for (let i = 0; i < n; i++) y[i] = x[(i + s) % n];
  b.copyToChannel(x, shiftMs >= 0 ? 0 : 1);
  b.copyToChannel(y, shiftMs >= 0 ? 1 : 0);
  return b;
}

/* ── Buses ─────────────────────────────────────────────────────────────── */

class Bus {
  gain: GainNode;
  analyser: AnalyserNode;
  private probe: Samples;
  private hold = 0;
  private ever = 0;
  private nowRms = 0;
  gainDb: number;

  constructor(ctx: AudioContext, gainDb: number, dest: AudioNode) {
    this.gainDb = gainDb;
    this.gain = ctx.createGain();
    this.gain.gain.value = dbToLin(gainDb);
    this.analyser = ctx.createAnalyser();
    /* 512 samples is about eleven milliseconds, which is long enough to
     * measure a bed and short enough that a footstep transient does not get
     * averaged away to nothing. */
    this.analyser.fftSize = 512;
    this.probe = new Float32Array(this.analyser.fftSize);
    this.gain.connect(this.analyser);
    this.analyser.connect(dest);
  }

  /** Called a few times a second, not per frame. */
  meter(dt: number): void {
    this.analyser.getFloatTimeDomainData(this.probe);
    let s = 0;
    for (let i = 0; i < this.probe.length; i++) s += this.probe[i] * this.probe[i];
    const r = Math.sqrt(s / this.probe.length);
    this.nowRms = r;
    if (r > this.ever) this.ever = r;
    // Three dB a second of decay on the hold, so a horn is still visible in
    // the debug surface for a couple of seconds after it has stopped.
    this.hold = Math.max(r, this.hold * Math.pow(10, (-3 * dt) / 20));
  }

  report(): BusReport {
    return {
      gainDb: this.gainDb,
      nowDb: +linToDb(this.nowRms).toFixed(1),
      holdDb: +linToDb(this.hold).toFixed(1),
      everDb: +linToDb(this.ever).toFixed(1),
    };
  }
}

/* ── Spot: one place in the street that makes a noise ──────────────────── */

class Spot {
  input: GainNode;
  air: BiquadFilterNode;
  /** A fixed extra lowpass for a source that is behind a building. Distance
   *  filtering alone cannot express occlusion: forty metres of clear air and
   *  forty metres with a four-storey block in the middle of it are the same
   *  distance and nothing like the same sound. */
  occl: BiquadFilterNode | null = null;
  panner: PannerNode;
  send: GainNode | null = null;
  pos: [number, number, number];
  /** Set for the pass-by lanes, which move. */
  posAt: ((t: number) => [number, number, number]) | null = null;
  dist = 0;
  playing = false;

  readonly name: string;
  readonly busName: string;

  /* Plain fields and explicit assignment rather than TypeScript's constructor
   * parameter properties. That is not a style preference: `tools/audiograph.mjs`
   * loads this module in bare Node, whose type stripper only erases types and
   * cannot synthesise the assignments a parameter property implies. Anything in
   * src/audio that the offline tools import has to survive that. */
  constructor(
    ctx: AudioContext,
    name: string,
    busName: string,
    pos: readonly number[],
    bus: Bus,
    sendDb: number,
    verb: AudioNode | null,
    occludeHz = 0,
  ) {
    this.name = name;
    this.busName = busName;
    this.pos = [pos[0], pos[1], pos[2]];
    this.input = ctx.createGain();

    this.air = ctx.createBiquadFilter();
    this.air.type = 'lowpass';
    // Q in dB for a lowpass, per the Web Audio spec. Butterworth is -3.01.
    this.air.Q.value = qToWebAudio(Math.SQRT1_2);
    this.air.frequency.value = 18000;

    this.panner = ctx.createPanner();
    this.panner.panningModel = PANNER.panningModel;
    this.panner.distanceModel = PANNER.distanceModel;
    this.panner.refDistance = PANNER.refDistance;
    this.panner.rolloffFactor = PANNER.rolloffFactor;
    this.panner.maxDistance = PANNER.maxDistance;
    this.panner.positionX.value = this.pos[0];
    this.panner.positionY.value = this.pos[1];
    this.panner.positionZ.value = this.pos[2];

    this.input.connect(this.air);
    let mono: AudioNode = this.air;
    if (occludeHz > 0) {
      this.occl = ctx.createBiquadFilter();
      this.occl.type = 'lowpass';
      this.occl.frequency.value = occludeHz;
      this.occl.Q.value = qToWebAudio(Math.SQRT1_2);
      this.air.connect(this.occl);
      mono = this.occl;
    }
    mono.connect(this.panner);
    this.panner.connect(bus.gain);

    if (verb && Number.isFinite(sendDb)) {
      this.send = ctx.createGain();
      this.send.gain.value = dbToLin(sendDb);
      // Taken off the mono point on purpose: a stereo input would make the
      // convolver do four convolutions instead of two for no audible gain.
      mono.connect(this.send);
      this.send.connect(verb);
    }
  }

  /** Point the panner's cone, for the bar doorway. */
  cone(dir: readonly number[], inner: number, outer: number, outerGain: number): this {
    this.panner.orientationX.value = dir[0];
    this.panner.orientationY.value = dir[1];
    this.panner.orientationZ.value = dir[2];
    this.panner.coneInnerAngle = inner;
    this.panner.coneOuterAngle = outer;
    this.panner.coneOuterGain = outerGain;
    return this;
  }

  moveTo(t: number, ctxTime: number): void {
    if (!this.posAt) return;
    const p = this.posAt(t);
    this.pos = p;
    this.panner.positionX.setValueAtTime(p[0], ctxTime);
    this.panner.positionY.setValueAtTime(p[1], ctxTime);
    this.panner.positionZ.setValueAtTime(p[2], ctxTime);
  }

  /** Retune the air filter from the current listener distance. */
  refresh(lx: number, ly: number, lz: number, ctxTime: number): void {
    this.dist = Math.hypot(this.pos[0] - lx, this.pos[1] - ly, this.pos[2] - lz);
    const fc = airCutoffHz(this.dist);
    this.air.frequency.setTargetAtTime(fc, ctxTime, PANNER.filterGlide);
  }

  report(): SpotReport {
    return {
      name: this.name,
      bus: this.busName,
      pos: [+this.pos[0].toFixed(2), +this.pos[1].toFixed(2), +this.pos[2].toFixed(2)],
      dist: +this.dist.toFixed(1),
      cutoffHz: Math.round(Math.min(this.air.frequency.value, this.occl ? this.occl.frequency.value : Infinity)),
      gainDb: +linToDb(this.input.gain.value).toFixed(1),
      playing: this.playing,
    };
  }
}

/* ── The engine ────────────────────────────────────────────────────────── */

type Buffers = {
  bed: AudioBuffer[];
  passBy: AudioBuffer[][];
  horn: AudioBuffer[];
  steps: AudioBuffer[][];
  ac: AudioBuffer[];
  rattle: AudioBuffer[];
  kick: AudioBuffer[];
  bass: Map<number, AudioBuffer>;
  body: AudioBuffer[];
  neon: AudioBuffer | null;
  ir: AudioBuffer | null;
};

/** The shape everything starts in, before the staged build fills it. */
function emptyBuffers(): Buffers {
  return {
    bed: [], passBy: [], horn: [], steps: [], ac: [], rattle: [],
    kick: [], bass: new Map(), body: [], neon: null, ir: null,
  };
}

const LOOKAHEAD = 0.35;

export class CityAudio {
  readonly listener: THREE.AudioListener;
  readonly ctx: AudioContext;

  private master!: GainNode;
  private limiter!: DynamicsCompressorNode;
  private verb!: ConvolverNode;
  private buses = new Map<string, Bus>();
  private spots = new Map<string, Spot>();
  private bufs: Buffers = emptyBuffers();
  private rng: Rng = makeRng(0x7a1de);

  private built = false;
  private buildMs = 0;
  private bufferBytes = 0;
  private voices = 0;
  private soloed: string | null = null;
  private meterAcc = 0;
  private frame = 0;

  private counts = { steps: 0, horns: 0, passBys: 0, rattles: 0, barHits: 0 };
  private nextHorn = 0;
  private nextPassBy = 0;
  private nextRattle: number[] = [];
  private nextSputter = 0;
  private nextBar = 0;
  private barIndex = 0;
  private lastStepAt = 0;

  constructor() {
    /* Three's AudioListener owns the AudioContext for the whole page and
     * updates the Web Audio listener's position and orientation from its own
     * world matrix. That is the only thing it is used for here — the sources
     * are raw PannerNodes rather than PositionalAudio objects, because a
     * PositionalAudio is an Object3D per sound and this system wants an air
     * filter and a reverb send in the chain that PositionalAudio does not
     * expose cleanly. */
    this.listener = new THREE.AudioListener();
    this.ctx = this.listener.context as AudioContext;
  }

  get isBuilt(): boolean { return this.built; }
  get state(): string { return this.ctx.state; }

  /** Hang this off the same gesture that takes pointer lock. */
  async resume(): Promise<void> {
    if (this.ctx.state !== 'running') {
      try { await this.ctx.resume(); } catch { /* a rejected resume is not fatal */ }
    }
  }

  /* ── Construction ────────────────────────────────────────────────────── */

  /**
   * Stage one: get sound out, then build the rest across later frames.
   *
   * Rendering everything took 620 ms of straight-line arithmetic, and it was
   * running on the click that also takes pointer lock — a third of a second of
   * frozen frame at the exact moment the player starts walking. Splitting it
   * means the traffic bed starts almost at once and the rest of the street
   * arrives over the next handful of frames, none of which costs more than
   * about a tenth of a second.
   *
   * The order is by how much each source is missed. The bed is the whole noise
   * floor and has to be first; footsteps are next because the player is
   * already walking; the bar, the neon and the event sources can all afford to
   * be a few frames late because none of them is doing anything yet.
   */
  build(): void {
    if (this.built) return;
    const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0;   // faded up once everything is connected
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = MASTER.limiter.thresholdDb;
    this.limiter.knee.value = MASTER.limiter.knee;
    this.limiter.ratio.value = MASTER.limiter.ratio;
    this.limiter.attack.value = MASTER.limiter.attack;
    this.limiter.release.value = MASTER.limiter.release;
    this.master.connect(this.limiter);
    this.limiter.connect(this.listener.getInput());

    this.bufs = emptyBuffers();

    this.addBus('verb', IR.returnDb);
    this.addBus('bed', BED.busDb);
    this.addBus('ac', AC.busDb);
    this.addBus('bar', BAR.busDb);
    this.addBus('steps', STEPS.busDb);
    this.addBus('events', 0);
    this.addBus('neon', NEON.busDb);

    /* The canyon and the first layer of the bed, now. The reverb has to exist
     * before anything can be wired to it, and the bed has to be making a noise
     * before the click that started all this feels like it did anything. */
    this.renderIr(ctx);
    this.buildBedLayer(ctx, 0);

    const now = ctx.currentTime;
    this.master.gain.setValueAtTime(0, now);
    this.master.gain.linearRampToValueAtTime(dbToLin(MASTER.gainDb), now + MASTER.fadeInSec);
    this.built = true;

    /* The rest, one per frame. `update` drains this, so the stages are paced
     * by the render loop rather than by a timer and cannot pile up on a slow
     * machine. Every scheduler below guards on its own buffers being present,
     * because for the first few frames they are not. */
    this.pending = [];
    for (let i = 1; i < BED_LAYERS.length; i++) this.pending.push(() => this.buildBedLayer(ctx, i));
    this.pending.push(() => { this.renderSteps(ctx); this.buildSteps(); });

    AC_BUFFERS.forEach((_, i) => this.pending.push(() => this.renderAcLoop(ctx, i)));
    this.pending.push(() => {
      this.renderRattles(ctx);
      this.buildAc();
      this.nextRattle = AC_UNITS.map(() => this.ctx.currentTime + range(this.rng, AC.rattleEvery));
    });

    this.pending.push(() => { this.renderBar(ctx); this.buildBar(); this.nextBar = this.ctx.currentTime + 0.4; });
    this.pending.push(() => { this.renderNeon(ctx); this.buildNeon(); this.nextSputter = this.ctx.currentTime + range(this.rng, NEON.sputterEvery); });

    HORN_VOICES.forEach((_, i) => this.pending.push(() => this.renderHorn(ctx, i)));
    this.pending.push(() => {
      this.buildEventSpots();
      this.nextHorn = this.ctx.currentTime + range(this.rng, HORN.firstAt);
    });

    PASSBY_LANES.forEach((_, li) => {
      for (let k = 0; k < PASSBY.variants; k++) this.pending.push(() => this.renderPassBy(ctx, li, k));
    });
    this.pending.push(() => { this.nextPassBy = this.ctx.currentTime + range(this.rng, PASSBY.firstAt); });

    this.buildMs = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  }

  private pending: (() => void)[] = [];

  private addBus(name: string, gainDb: number): Bus {
    const b = new Bus(this.ctx, gainDb, this.master);
    this.buses.set(name, b);
    return b;
  }

  private count(b: AudioBuffer): void {
    this.bufferBytes += b.length * b.numberOfChannels * 4;
  }

  private mono(ctx: AudioContext, x: Samples, sr: number): AudioBuffer {
    const b = toBuffer(ctx, x, sr);
    this.count(b);
    return b;
  }

  /* ── Buffer rendering, one stage at a time ───────────────────────────────
   *
   * Each of these fills one slice of `this.bufs` and is sized to stay well
   * inside a frame. They are called from the queue `build` leaves behind. */

  /**
   * One pass-by variant. Nine seconds of doppler at twelve kilohertz is the
   * most expensive thing the system renders even after the engine became a
   * wavetable, so each variant gets a stage of its own rather than a lane.
   */
  private renderPassBy(ctx: AudioContext, laneIndex: number, k: number): void {
    const lane = PASSBY_LANES[laneIndex];
    if (!lane) return;
    const buf = this.mono(ctx, passByBuffer({
      sr: SR.passBy, seed: 0x1000 + laneIndex * 97 + k * 13, seconds: lane.seconds,
      closest: lane.closest, speed: lane.speed, engineHz: lane.engineHz * (0.88 + 0.22 * k),
      targetDb: BED.bufDb,
    }), SR.passBy);
    (this.bufs.passBy[laneIndex] ??= []).push(buf);
  }

  private renderHorn(ctx: AudioContext, i: number): void {
    const v = HORN_VOICES[i];
    this.bufs.horn[i] = this.mono(ctx, hornBuffer({
      sr: SR.horn, seed: v.seed, seconds: v.seconds, f1: v.f1, f2: v.f2, peakDb: PEAK_DB,
    }), SR.horn);
  }

  private renderSteps(ctx: AudioContext): void {
    this.bufs.steps = [0, 1].map((foot) =>
      Array.from({ length: STEPS.bankPerFoot }, (_, k) => this.mono(ctx, footstepBuffer({
        sr: SR.step, seed: 0x5000 + foot * 331 + k * 29, foot: foot as 0 | 1, peakDb: PEAK_DB,
      }), SR.step)));
  }

  private renderAcLoop(ctx: AudioContext, i: number): void {
    const a = AC_BUFFERS[i];
    this.bufs.ac[i] = this.mono(ctx, acLoopBuffer({
      sr: SR.ac, seed: a.seed, seconds: a.seconds, humHz: a.humHz,
      bladeHz: a.bladeHz, targetDb: BED.bufDb,
    }), SR.ac);
  }

  private renderRattles(ctx: AudioContext): void {
    this.bufs.rattle = Array.from({ length: AC.rattleVariants }, (_, k) =>
      this.mono(ctx, rattleBuffer(SR.rattle, 0x2200 + k * 41, PEAK_DB), SR.rattle));
  }

  private renderBar(ctx: AudioContext): void {
    this.bufs.kick = Array.from({ length: 3 }, (_, k) =>
      this.mono(ctx, kickBuffer(SR.bar, 0x3300 + k * 17, PEAK_DB), SR.bar));
    BAR.notes.forEach((hz, i) => {
      this.bufs.bass.set(hz, this.mono(ctx, barBassNote(SR.bar, 0x4400 + i * 23, hz, 0.55, BED.bufDb), SR.bar));
    });
    this.bufs.body = Array.from({ length: 3 }, (_, k) =>
      this.mono(ctx, barBodyHit(SR.bar, 0x4900 + k * 19, PEAK_DB), SR.bar));
  }

  private renderNeon(ctx: AudioContext): void {
    this.bufs.neon = this.mono(ctx, neonBuffer(SR.neon, NEON.seed, NEON.seconds, BED.bufDb), SR.neon);
  }

  private renderIr(ctx: AudioContext): void {
    /* Rendered at the context's rate, not at `SR.ir`.
     *
     * Every other buffer in this engine is generated at whatever rate suits
     * the material and played through an AudioBufferSourceNode, which
     * resamples on the way out — which is why the bed can be 12 kHz and the
     * neon 24 kHz for free. ConvolverNode is the one node in the graph that
     * does not: it throws `NotSupportedError` outright if the impulse
     * response's rate differs from the context's.
     *
     * It did. `SR.ir` is 24000 and the context comes up at 48000, so
     * `build()` threw on this line, and it threw *before* the bed, the
     * spot sources and the footsteps were built — so the entire audio system
     * was silent, on every machine, in every capture. Nothing above the
     * pageerror log said so, and the numeric verification this engine passed
     * ran against the DSP functions rather than against the graph.
     *
     * 1.25 s of stereo at 48 kHz is a 60000-tap convolution per channel,
     * which is what a browser's partitioned convolver is for. */
    const sr = ctx.sampleRate;
    const irPair = streetIR({
      sr, seed: IR.seed, nearWall: IR.nearWall, farWall: IR.farWall,
      width: IR.width, eyeHeight: IR.eyeHeight, seconds: IR.seconds,
      rtLow: IR.rtLow, rtMid: IR.rtMid, rtHigh: IR.rtHigh, energyDb: IR.energyDb,
    });
    const ir = ctx.createBuffer(2, irPair.left.length, sr);
    ir.copyToChannel(irPair.left, 0);
    ir.copyToChannel(irPair.right, 1);
    this.count(ir);
    this.bufs.ir = ir;

    this.verb = ctx.createConvolver();
    this.verb.normalize = false;   // the IR is already normalised, by energy
    this.verb.buffer = ir;
    this.verb.connect(this.buses.get('verb')!.gain);
  }

  /* ── The bed: everywhere, so no panner and no reverb ─────────────────── */

  /**
   * One layer of the bed, rendered and started.
   *
   * The layers come up one frame apart rather than together. That is only
   * audible if you are listening for it during the master fade-in, and it
   * halves the stall on the click that starts everything.
   */
  private buildBedLayer(ctx: AudioContext, i: number): void {
    const L = BED_LAYERS[i];
    const x = trafficLayer({
      sr: SR.bed, seconds: L.seconds, seed: L.seed, lpHz: L.lpHz,
      bumpHz: L.bumpHz, bumpDb: L.bumpDb, airDb: L.airDb, targetDb: BED.bufDb,
    });
    const buf = toStereoShifted(ctx, x, SR.bed, (i % 2 === 0 ? 1 : -1) * (BED.spreadMs + i * 14));
    this.count(buf);
    this.bufs.bed[i] = buf;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    /* The rate is not decoration. It shifts the layer's period off the
     * nominal length as well as its pitch, so three loops whose lengths
     * already share no factor become three loops whose lengths are not even
     * rational multiples of each other. */
    src.playbackRate.value = L.rate;
    const g = ctx.createGain();
    g.gain.value = dbToLin(L.gainDb);
    src.connect(g);
    g.connect(this.buses.get('bed')!.gain);
    // Start each layer at a different point in its own buffer so they do not
    // all begin on the same swell.
    src.start(ctx.currentTime, this.rng() * L.seconds);
  }

  /* ── AC units ─────────────────────────────────────────────────────────── */

  private buildAc(): void {
    const bus = this.buses.get('ac')!;
    for (const u of AC_UNITS) {
      const spot = new Spot(this.ctx, u.name, 'ac', u.pos, bus, SENDS.ac, this.verb);
      spot.input.gain.value = dbToLin(u.gainDb);
      const src = this.ctx.createBufferSource();
      src.buffer = this.bufs.ac[u.buf];
      src.loop = true;
      src.playbackRate.value = u.rate;
      src.connect(spot.input);
      src.start(this.ctx.currentTime, this.rng() * AC_BUFFERS[u.buf].seconds);
      spot.playing = true;
      this.spots.set(u.name, spot);
    }
  }

  /* ── The bar ──────────────────────────────────────────────────────────── */

  private barIn!: GainNode;

  private buildBar(): void {
    const ctx = this.ctx;
    const bus = this.buses.get('bar')!;
    const spot = new Spot(ctx, 'bar', 'bar', BAR.pos, bus, SENDS.bar, this.verb);
    spot.cone(BAR.orientation, BAR.coneInner, BAR.coneOuter, BAR.coneOuterGain);
    spot.playing = true;
    this.spots.set('bar', spot);

    /* The wall, feeding the spot's input, with the make-up gain in front of
     * it so that the filters work on the level the buffers were rendered at
     * and the compensation is one explicit, checkable number. */
    this.barIn = ctx.createGain();
    const makeup = ctx.createGain();
    makeup.gain.value = dbToLin(BAR.wallMakeupDb);
    this.barIn.connect(makeup);
    const hpN = ctx.createBiquadFilter();
    hpN.type = 'highpass';
    hpN.frequency.value = BAR.wallHpHz;
    hpN.Q.value = qToWebAudio(0.7);
    const res = ctx.createBiquadFilter();
    res.type = 'peaking';
    res.frequency.value = BAR.wallResHz;
    res.Q.value = BAR.wallResQ;        // peaking Q is a plain Q, not dB
    res.gain.value = BAR.wallResDb;

    makeup.connect(hpN); hpN.connect(res);
    let tail: AudioNode = res;
    for (let i = 0; i < BAR.wallLpPoles; i++) {
      const lpN = ctx.createBiquadFilter();
      lpN.type = 'lowpass';
      lpN.frequency.value = BAR.wallLpHz;
      lpN.Q.value = qToWebAudio(Math.SQRT1_2);
      tail.connect(lpN);
      tail = lpN;
    }
    tail.connect(spot.input);

    // The gap under the door: a narrow band of the top, thirty dB down.
    const leak = ctx.createBiquadFilter();
    leak.type = 'bandpass';
    leak.frequency.value = BAR.leakHz;
    leak.Q.value = BAR.leakQ;          // bandpass Q is a plain Q, not dB
    const leakG = ctx.createGain();
    leakG.gain.value = dbToLin(BAR.leakDb);
    makeup.connect(leak); leak.connect(leakG); leakG.connect(spot.input);
  }

  /* ── Neon ─────────────────────────────────────────────────────────────── */

  private neonGain!: GainNode;

  private buildNeon(): void {
    const bus = this.buses.get('neon')!;
    const spot = new Spot(this.ctx, 'neon', 'neon', NEON.pos, bus, SENDS.neon, this.verb);
    spot.playing = true;
    this.spots.set('neon', spot);
    this.neonGain = this.ctx.createGain();
    this.neonGain.gain.value = 1;
    const src = this.ctx.createBufferSource();
    src.buffer = this.bufs.neon;
    src.loop = true;
    src.connect(this.neonGain);
    this.neonGain.connect(spot.input);
    src.start(this.ctx.currentTime, this.rng() * NEON.seconds);
  }

  /* ── Horn and pass-by spots ───────────────────────────────────────────── */

  private buildEventSpots(): void {
    const bus = this.buses.get('events')!;
    for (const h of HORN_SPOTS) {
      this.spots.set(`horn.${h.name}`, new Spot(this.ctx, `horn.${h.name}`, 'events', h.pos, bus, SENDS.events, this.verb, h.occludeHz));
    }
    PASSBY_LANES.forEach((lane) => {
      const s = new Spot(this.ctx, `pass.${lane.name}`, 'events', lane.from, bus, SENDS.events, this.verb, lane.occludeHz);
      s.posAt = (u: number) => [
        lane.from[0] + (lane.to[0] - lane.from[0]) * u,
        lane.from[1] + (lane.to[1] - lane.from[1]) * u,
        lane.from[2] + (lane.to[2] - lane.from[2]) * u,
      ];
      this.spots.set(`pass.${lane.name}`, s);
    });
  }

  /* ── Footsteps ────────────────────────────────────────────────────────── */

  private stepBus!: Bus;
  private stepSend!: GainNode;

  private buildSteps(): void {
    this.stepBus = this.buses.get('steps')!;
    this.stepSend = this.ctx.createGain();
    this.stepSend.gain.value = dbToLin(SENDS.steps);
    this.stepSend.connect(this.verb);
  }

  /**
   * One footstep.
   *
   * Called from the walker's gait, which is already computing the phase; this
   * only decides what it sounds like. Four nodes and no allocation beyond
   * them: the bank was rendered at startup and the per-step variation is
   * playback rate, gain and a lowpass corner, which between them turn twelve
   * buffers into more distinct footsteps than a walk can contain.
   *
   * Cadence comes from the interval between calls rather than from a speed
   * that would have to be plumbed through, which also means a player edging
   * forward gets quieter, slower steps for free.
   */
  footstep(foot: number): void {
    if (!this.built || this.ctx.state !== 'running') return;
    if (this.bufs.steps.length === 0) return;   // still in the staged build
    const now = this.ctx.currentTime;
    const gap = this.lastStepAt > 0 ? now - this.lastStepAt : 0.5;
    this.lastStepAt = now;
    const cadence = clamp(1 / Math.max(0.12, gap), 0.4, 3.2);
    const effort = clamp(cadence / STEPS.fullCadence, 0.35, 1.15);

    const f = foot & 1;
    const v = stepVariation(this.rng, f, effort);
    const src = this.ctx.createBufferSource();
    src.buffer = this.bufs.steps[f][v.bank];
    src.playbackRate.value = v.rate;

    const lpN = this.ctx.createBiquadFilter();
    lpN.type = 'lowpass';
    lpN.frequency.value = v.lpHz;
    lpN.Q.value = qToWebAudio(0.8);

    const pan = this.ctx.createStereoPanner();
    // The foot is a little to one side and well below the ear, so the image is
    // narrow. Anything wider reads as walking with your legs apart.
    pan.pan.value = v.pan;

    const g = this.ctx.createGain();
    g.gain.value = dbToLin(v.gainDb);

    src.connect(lpN); lpN.connect(g);
    g.connect(pan); pan.connect(this.stepBus.gain);
    g.connect(this.stepSend);

    this.voices++;
    src.onended = () => { this.voices--; src.disconnect(); lpN.disconnect(); g.disconnect(); pan.disconnect(); };
    src.start(now);
    this.counts.steps++;
  }

  /* ── One-shots ────────────────────────────────────────────────────────── */

  /** Play a buffer into a spot, cleaning up after itself. */
  private oneShot(spot: Spot, buf: AudioBuffer, gainDb: number, when: number, rate = 1): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = dbToLin(gainDb);
    src.connect(g);
    g.connect(spot.input);
    this.voices++;
    spot.playing = true;
    src.onended = () => { this.voices--; src.disconnect(); g.disconnect(); };
    src.start(when);
    return src;
  }

  private fireHorn(when: number): void {
    const horns = [...this.spots.values()].filter((s) => s.name.startsWith('horn.'));
    if (horns.length === 0) return;   // spots arrive a frame after the buffers
    const spot = pick(this.rng, horns);
    const vi = Math.floor(this.rng() * this.bufs.horn.length);
    const buf = this.bufs.horn[vi];
    const rate = 0.94 + this.rng() * 0.13;
    const gainDb = -this.rng() * 5;
    this.oneShot(spot, buf, gainDb, when, rate);
    /* A double parp is the commonest thing a real horn does, and the gap is
     * short — a fifth of a second, not a beat. The second is always quieter,
     * because the second push on a horn button is shorter. */
    if (this.rng() < HORN.doubleChance) {
      const gap = 0.16 + this.rng() * 0.13;
      this.oneShot(spot, buf, gainDb - 2.5, when + buf.duration / rate + gap, rate * 1.01);
    }
    this.counts.horns++;
  }

  private firePassBy(when: number): void {
    // Only lanes whose buffers the staged build has reached; for the first few
    // frames that may be one lane or none.
    const ready: number[] = [];
    for (let i = 0; i < PASSBY_LANES.length; i++) if (this.bufs.passBy[i]?.length) ready.push(i);
    if (ready.length === 0) return;
    const li = ready[Math.floor(this.rng() * ready.length)];
    const lane = PASSBY_LANES[li];
    const spot = this.spots.get(`pass.${lane.name}`);
    if (!spot) return;
    const buf = pick(this.rng, this.bufs.passBy[li]);
    this.oneShot(spot, buf, lane.gainDb - this.rng() * 4, when, 0.93 + this.rng() * 0.15);
    // The panner walks the lane over the life of the buffer.
    this.passByUntil.set(spot.name, { start: when, end: when + lane.seconds });
    this.counts.passBys++;
  }

  private passByUntil = new Map<string, { start: number; end: number }>();

  private fireRattle(unitIndex: number, when: number): void {
    const u = AC_UNITS[unitIndex];
    const spot = this.spots.get(u.name)!;
    this.oneShot(spot, pick(this.rng, this.bufs.rattle), AC.rattleGainDb - this.rng() * 7, when, 0.8 + this.rng() * 0.55);
    this.counts.rattles++;
  }

  /**
   * A tube that has not settled.
   *
   * Three or four fast gain steps rather than a smooth dip, because a neon
   * tube either strikes or it does not; a gentle fade is a dimmer, and there
   * are no dimmers on neon.
   */
  private fireSputter(when: number): void {
    const g = this.neonGain.gain;
    g.cancelScheduledValues(when);
    let t = when;
    const n = 3 + Math.floor(this.rng() * 4);
    for (let i = 0; i < n; i++) {
      g.setValueAtTime(this.rng() < 0.5 ? 0.06 : 1.35, t);
      t += 0.018 + this.rng() * 0.075;
    }
    g.setValueAtTime(1, t);
  }

  /* ── The bar's sequencer ──────────────────────────────────────────────── */

  /**
   * One bar of music, scheduled ahead.
   *
   * Generated bar by bar from a running seed rather than looped, which is the
   * only way a thirty-second walk past a bar does not hear the same eight
   * seconds twice. The kick is on one and three because it always is, and
   * everything else — the offbeats, whether the bass moves, which note it
   * moves to — is decided fresh each bar, with a few milliseconds of timing
   * jitter on every hit so that nothing lands exactly on a grid.
   *
   * None of the detail survives the wall anyway. That is the point: what
   * reaches the street is a pattern of low thuds whose *rhythm* is legible and
   * whose content is not, which is precisely what a bar sounds like from
   * outside it.
   */
  private scheduleBar(at: number): number {
    const beat = 60 / BAR.bpm;
    const evs = barPattern(this.rng, this.barIndex++, BAR.notes, beat, BAR.swingJitter);
    for (const e of evs) {
      const buf = e.kind === 'kick' ? pick(this.rng, this.bufs.kick)
        : e.kind === 'body' ? pick(this.rng, this.bufs.body)
          : this.bufs.bass.get(e.note!);
      if (buf) this.playBar(buf, at + e.t, e.gainDb, e.rate);
    }
    return at + beat * 4;
  }

  private playBar(buf: AudioBuffer, when: number, gainDb: number, rate = 1): void {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = dbToLin(gainDb);
    src.connect(g);
    g.connect(this.barIn);
    this.voices++;
    src.onended = () => { this.voices--; src.disconnect(); g.disconnect(); };
    src.start(Math.max(when, this.ctx.currentTime));
    this.counts.barHits++;
  }

  /* ── Per-frame ────────────────────────────────────────────────────────── */

  update(dt: number, camera: THREE.Object3D): void {
    if (!this.built || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    this.frame++;

    /* One build stage a frame. Taking a single stage rather than draining the
     * queue is the whole point: the cost is spread across frames instead of
     * being moved from one frame to another. */
    const stage = this.pending.shift();
    if (stage) {
      const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      stage();
      this.buildMs += (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
    }

    /* The listener. Three updates the Web Audio listener from the object's
     * world matrix, and forcing the camera's matrix here removes any
     * dependence on whether the renderer has already walked the graph this
     * frame — a listener one frame behind is inaudible but a listener that
     * never updates at all is a very confusing bug. */
    camera.updateMatrixWorld(true);

    const lp = camera.matrixWorld;
    const lx = lp.elements[12], ly = lp.elements[13], lz = lp.elements[14];

    // Moving spots first, so their air filter is retuned from the new place.
    for (const [name, span] of this.passByUntil) {
      const s = this.spots.get(name);
      if (!s) continue;
      if (now > span.end) { this.passByUntil.delete(name); s.playing = false; continue; }
      s.moveTo(clamp((now - span.start) / (span.end - span.start), 0, 1), now);
    }

    if (this.frame % PANNER.filterEveryFrames === 0) {
      for (const s of this.spots.values()) s.refresh(lx, ly, lz, now);
    }

    this.schedule(now);

    this.meterAcc += dt;
    if (this.meterAcc > 0.1) {
      for (const b of this.buses.values()) b.meter(this.meterAcc);
      this.meterAcc = 0;
    }
  }

  private schedule(now: number): void {
    const horizon = now + LOOKAHEAD;

    /* Everything below clamps its next-event time forward if it has fallen
     * behind. A backgrounded tab suspends the context clock, and without the
     * clamp the first frame after it comes back fires every horn that would
     * have happened while it was away, all at once. */
    if (this.nextHorn < now - 1) this.nextHorn = now + 1;
    if (this.bufs.horn.length > 0 && this.nextHorn < horizon) {
      this.fireHorn(Math.max(this.nextHorn, now));
      this.nextHorn += range(this.rng, HORN.every);
    }

    if (this.nextPassBy < now - 1) this.nextPassBy = now + 1;
    if (this.bufs.passBy.length > 0 && this.nextPassBy < horizon) {
      this.firePassBy(Math.max(this.nextPassBy, now));
      this.nextPassBy += range(this.rng, PASSBY.every);
    }

    if (this.nextSputter < now - 1) this.nextSputter = now + 2;
    if (this.bufs.neon && this.nextSputter < horizon) {
      this.fireSputter(Math.max(this.nextSputter, now));
      this.nextSputter += range(this.rng, NEON.sputterEvery);
    }

    for (let i = 0; i < this.nextRattle.length; i++) {
      if (this.nextRattle[i] < now - 1) this.nextRattle[i] = now + 1;
      if (this.bufs.rattle.length > 0 && this.nextRattle[i] < horizon) {
        const spot = this.spots.get(AC_UNITS[i].name)!;
        // Skip, do not defer: a unit forty metres away rattling into a filter
        // that removes it is two nodes spent on nothing.
        if (spot.dist < AC.rattleRange) this.fireRattle(i, Math.max(this.nextRattle[i], now));
        this.nextRattle[i] += range(this.rng, AC.rattleEvery);
      }
    }

    if (this.bufs.kick.length > 0) {
      if (this.nextBar < now - 2) this.nextBar = now + 0.2;
      while (this.nextBar < horizon + 0.6) this.nextBar = this.scheduleBar(this.nextBar);
    }
  }

  /* ── Debug ────────────────────────────────────────────────────────────── */

  report(): AudioReport {
    const buses: Record<string, BusReport> = {};
    const silent: string[] = [];
    for (const [k, v] of this.buses) {
      const r = v.report();
      buses[k] = r;
      if (!Number.isFinite(r.everDb)) silent.push(k);
    }
    const now = this.ctx.currentTime;
    return {
      state: this.ctx.state,
      built: this.built,
      buildMs: +this.buildMs.toFixed(1),
      pendingStages: this.pending.length,
      sampleRate: this.ctx.sampleRate,
      time: +now.toFixed(2),
      bufferKb: Math.round(this.bufferBytes / 1024),
      voices: this.voices,
      soloed: this.soloed,
      master: {
        gainDb: this.built ? +linToDb(this.master.gain.value).toFixed(1) : -Infinity,
        reductionDb: this.built ? +this.limiter.reduction.toFixed(2) : 0,
      },
      buses,
      spots: [...this.spots.values()].map((s) => s.report()),
      counts: { ...this.counts },
      next: {
        hornIn: +(this.nextHorn - now).toFixed(1),
        passByIn: +(this.nextPassBy - now).toFixed(1),
      },
      silent,
    };
  }

  /** The stable control object installed on `window`. Built once. */
  debug(): AudioDebug {
    return {
      report: () => this.report(),
      resume: () => this.resume(),
      setMasterDb: (db: number) => { if (this.built) this.master.gain.value = dbToLin(db); },
      solo: (bus: string | null) => {
        this.soloed = bus;
        if (!this.built) return;
        for (const [k, v] of this.buses) {
          v.gain.gain.value = bus === null || k === bus || k === 'verb' ? dbToLin(v.gainDb) : 0;
        }
      },
      fire: (what) => {
        if (!this.built) return;
        const t = this.ctx.currentTime + 0.05;
        if (what === 'horn') this.fireHorn(t);
        else if (what === 'passby') this.firePassBy(t);
        else if (what === 'step') this.footstep(this.counts.steps & 1);
        else if (what === 'rattle') this.fireRattle(Math.floor(this.rng() * AC_UNITS.length), t);
        else if (what === 'sputter') this.fireSputter(t);
      },
      engine: this,
    };
  }

  dispose(): void {
    try { this.master?.disconnect(); } catch { /* already gone */ }
    try { void this.ctx.close(); } catch { /* already closed */ }
  }
}
