/* System 7 — the DSP, with no Web Audio in it.
 *
 * Everything in this file is arithmetic on Float32Arrays. That is deliberate
 * and it is the single most important decision in the audio system: it means
 * every generator can be rendered and measured in Node, on the CPU, with no
 * browser, no GPU and no listening. `tools/audio.mjs` imports this exact file
 * — not a reimplementation of it — and checks that each source produces the
 * spectrum and the level it is supposed to.
 *
 * The recurring failure mode in a Web Audio graph is silence: a node left
 * unconnected, a gain left at zero, a buffer left full of zeros. None of those
 * raise. The defence is to measure the buffers before they ever reach a node,
 * which is what the tool does, and then to measure the graph's own gain
 * structure separately, which the debug surface does.
 *
 * A note on filters. `lp`/`hp` etc. below are the RBJ audio-EQ-cookbook
 * biquads, which is what the Web Audio specification's BiquadFilterNode is
 * defined in terms of, so a filter applied here offline and the same filter
 * applied by a node at runtime are the same filter. The one trap is that the
 * spec's `Q` AudioParam for lowpass and highpass is in *decibels*, not a
 * linear Q. `qToWebAudio` below converts, and every runtime filter is set
 * through it rather than by hand.
 */

export type Rng = () => number;

/**
 * A block of samples.
 *
 * `Float32Array` on its own now means `Float32Array<ArrayBufferLike>`, which
 * includes SharedArrayBuffer and which `AudioBuffer.copyToChannel` will not
 * accept. Every array in this file is a plain one, so naming the backing store
 * once here is tidier than casting at each of the places the generators meet
 * the Web Audio API.
 */
export type Samples = Float32Array<ArrayBuffer>;

/** xorshift32, the same generator world/noise.ts uses. Duplicated rather than
 *  imported so that this module has no `@/` path alias in it and Node can load
 *  it directly. */
export function makeRng(seed: number): Rng {
  let s = seed >>> 0 || 1;
  return function rng(): number {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

export const dbToLin = (db: number): number => Math.pow(10, db / 20);
export const linToDb = (x: number): number => 20 * Math.log10(Math.max(1e-12, Math.abs(x)));
export const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
export const TAU = Math.PI * 2;
/** Speed of sound at about 20 C. Used for reflection delays and doppler. */
export const C_AIR = 343;

/* ── Biquads ───────────────────────────────────────────────────────────── */

export type Biquad = { b0: number; b1: number; b2: number; a1: number; a2: number };

/** Web Audio's lowpass/highpass Q AudioParam is in dB. Everything in this file
 *  works in linear Q, so runtime node setup goes through here. */
export const qToWebAudio = (q: number): number => 20 * Math.log10(q);

const norm = (b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): Biquad =>
  ({ b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 });

export function lp(sr: number, fc: number, q = Math.SQRT1_2): Biquad {
  const w = TAU * clamp(fc, 1, sr * 0.49) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q);
  return norm((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
}

export function hp(sr: number, fc: number, q = Math.SQRT1_2): Biquad {
  const w = TAU * clamp(fc, 1, sr * 0.49) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q);
  return norm((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
}

/** Constant 0 dB peak gain bandpass, which is what Web Audio's 'bandpass' is. */
export function bp(sr: number, fc: number, q = 1): Biquad {
  const w = TAU * clamp(fc, 1, sr * 0.49) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q);
  return norm(al, 0, -al, 1 + al, -2 * c, 1 - al);
}

export function peaking(sr: number, fc: number, q: number, gainDb: number): Biquad {
  const A = Math.pow(10, gainDb / 40);
  const w = TAU * clamp(fc, 1, sr * 0.49) / sr, c = Math.cos(w), al = Math.sin(w) / (2 * q);
  return norm(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
}

export function lowshelf(sr: number, fc: number, gainDb: number): Biquad {
  const A = Math.pow(10, gainDb / 40);
  const w = TAU * clamp(fc, 1, sr * 0.49) / sr, c = Math.cos(w);
  // Web Audio fixes the shelf slope at S = 1, which reduces alpha to this.
  const al = (Math.sin(w) / 2) * Math.SQRT2;
  const sa = 2 * Math.sqrt(A) * al;
  return norm(
    A * ((A + 1) - (A - 1) * c + sa),
    2 * A * ((A - 1) - (A + 1) * c),
    A * ((A + 1) - (A - 1) * c - sa),
    (A + 1) + (A - 1) * c + sa,
    -2 * ((A - 1) + (A + 1) * c),
    (A + 1) + (A - 1) * c - sa,
  );
}

export function highshelf(sr: number, fc: number, gainDb: number): Biquad {
  const A = Math.pow(10, gainDb / 40);
  const w = TAU * clamp(fc, 1, sr * 0.49) / sr, c = Math.cos(w);
  const al = (Math.sin(w) / 2) * Math.SQRT2;
  const sa = 2 * Math.sqrt(A) * al;
  return norm(
    A * ((A + 1) + (A - 1) * c + sa),
    -2 * A * ((A - 1) + (A + 1) * c),
    A * ((A + 1) + (A - 1) * c - sa),
    (A + 1) - (A - 1) * c + sa,
    2 * ((A - 1) - (A + 1) * c),
    (A + 1) - (A - 1) * c - sa,
  );
}

/**
 * Direct form I, in place, `times` passes.
 *
 * Each pass starts from zero state, which is what a fresh BiquadFilterNode
 * does. Two passes of a Butterworth 2-pole is a 24 dB/octave Linkwitz-Riley,
 * and that is what "heard through a wall" needs — a 12 dB slope leaves far too
 * much of the top of a kick drum in the street.
 */
export function biquadInPlace(x: Samples, c: Biquad, times = 1): Samples {
  for (let pass = 0; pass < times; pass++) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const x0 = x[i];
      const y0 = c.b0 * x0 + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
      x2 = x1; x1 = x0; y2 = y1; y1 = y0;
      x[i] = y0;
    }
  }
  return x;
}

/** One-pole lowpass with a per-sample cutoff, for sweeps a biquad cannot do
 *  cheaply offline. `fc` is in Hz and may change every sample. */
export function onePoleSweep(x: Samples, sr: number, fcAt: (i: number) => number): Samples {
  let y = 0;
  for (let i = 0; i < x.length; i++) {
    const a = 1 - Math.exp(-TAU * clamp(fcAt(i), 4, sr * 0.45) / sr);
    y += a * (x[i] - y);
    x[i] = y;
  }
  return x;
}

/* ── Noise ─────────────────────────────────────────────────────────────── */

/**
 * Approximately Gaussian white noise, sigma ~ 1/3 so that ±3 sigma is unity.
 *
 * The distribution matters more than it looks like it should. Uniform noise
 * has a crest factor of 4.8 dB and a footstep built from it has a flat,
 * synthetic transient; three summed uniforms is close enough to Gaussian to
 * give the ~11 dB crest that a real noise burst has, for two extra adds.
 */
export function white(n: number, rng: Rng): Samples {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (rng() + rng() + rng() - 1.5) * 0.6667;
  return out;
}

/** Paul Kellet's refined pink filter. -3 dB/octave to within 0.05 dB. */
export function pink(n: number, rng: Rng): Samples {
  const out = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = rng() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520;
    b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.0168980;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return out;
}

/** Leaky integrator; -6 dB/octave. The tyre-and-engine end of a traffic bed. */
export function brown(n: number, rng: Rng): Samples {
  const out = new Float32Array(n);
  let b = 0;
  for (let i = 0; i < n; i++) {
    b = (b + 0.02 * (rng() * 2 - 1)) / 1.02;
    out[i] = b * 3.5;
  }
  return out;
}

/* ── Level helpers ─────────────────────────────────────────────────────── */

export function rms(x: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
}

export function peak(x: ArrayLike<number>): number {
  let p = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > p) p = a; }
  return p;
}

export function scale(x: Samples, g: number): Samples {
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

/** Scale to a target RMS in dBFS. The measurement that keeps every generator
 *  landing where the mix expects it, instead of at whatever the synthesis
 *  happened to produce. */
export function rmsNormalise(x: Samples, targetDb: number): Samples {
  const r = rms(x);
  return r > 1e-9 ? scale(x, dbToLin(targetDb) / r) : x;
}

/**
 * Scale to a target *peak* in dBFS.
 *
 * Which of the two normalisations a generator uses is not a detail. A bed is
 * budgeted by RMS, because what it contributes to the mix is its average
 * power and its peaks are meaningless. A transient is budgeted by peak,
 * because a footstep with a 22 dB crest normalised to -20 dBFS RMS peaks at
 * +2 dBFS and is clipped before it reaches a gain node — which is exactly what
 * the first run of tools/audio.mjs caught. Continuous sources here use
 * `rmsNormalise`; one-shots use this.
 */
export function peakNormalise(x: Samples, targetDb = -3): Samples {
  const p = peak(x);
  return p > 1e-9 ? scale(x, dbToLin(targetDb) / p) : x;
}

/** Scale down if, and only if, the peak is over the ceiling. Unlike
 *  `peakNormalise` this leaves an RMS budget intact in the common case. */
export function peakCeiling(x: Samples, ceilingDb: number): Samples {
  const p = peak(x), c = dbToLin(ceilingDb);
  return p > c ? scale(x, c / p) : x;
}

/**
 * Turn `n + fade` samples of material into an `n`-sample seamless loop.
 *
 * The head is crossfaded with the material that ran past the end, so the last
 * sample of the loop leads into the first with no discontinuity and no
 * amplitude notch. An equal-power fade rather than linear, because the two
 * halves are uncorrelated noise and a linear fade would dip by 3 dB in the
 * middle — which is audible as a soft pulse once per loop, i.e. exactly the
 * periodicity the loop was supposed to hide.
 */
export function loopify(src: Samples, fade: number): Samples {
  const n = src.length - fade;
  const out = new Float32Array(n);
  out.set(src.subarray(0, n));
  for (let i = 0; i < fade; i++) {
    const t = (i + 0.5) / fade;
    const a = Math.sin(t * Math.PI * 0.5), b = Math.cos(t * Math.PI * 0.5);
    out[i] = src[i] * a + src[n + i] * b;
  }
  return out;
}

/** Snap a frequency to the nearest bin of a loop of `n` samples, so that an
 *  additive partial completes a whole number of cycles and the loop is exact. */
export const binSnap = (hz: number, sr: number, n: number): number =>
  Math.max(1, Math.round((hz * n) / sr)) * (sr / n);

/* ── Slow parameter drift ──────────────────────────────────────────────── */

/**
 * A smooth bounded random walk in [-1, 1], for driving anything that must
 * change slowly without ever repeating on a beat.
 *
 * Nothing in a city moves at a fixed rate, so every slow modulation in this
 * system is a low-rate noise source played back through a gain rather than an
 * oscillator. Generated at `sr` of about 100 Hz and resampled by the playback
 * rate, so the buffers are tiny.
 */
export function driftBuffer(sr: number, seconds: number, seed: number, smoothHz = 0.35): Samples {
  const n = Math.max(8, Math.round(sr * seconds) + Math.round(sr * 2));
  const raw = white(n, makeRng(seed));
  biquadInPlace(raw, lp(sr, smoothHz, 0.6), 2);
  const out = loopify(raw, Math.round(sr * 2));
  const p = peak(out);
  return p > 1e-9 ? scale(out, 0.98 / p) : out;
}

/* ── 1. Traffic bed ────────────────────────────────────────────────────── */

export type TrafficOpts = {
  sr: number;
  seconds: number;
  seed: number;
  /** Corner of the distance/occlusion lowpass. */
  lpHz: number;
  /** Engine-band bump, roughly where a diesel's firing order lives. */
  bumpHz: number;
  bumpDb: number;
  /** How much upper-mid survives. Evening, not 3 a.m.: this is not zero. */
  airDb: number;
  targetDb: number;
};

/**
 * One layer of the continuous city noise floor.
 *
 * The bed is three of these at incommensurate lengths rather than one, because
 * a single noise loop of any length is heard as a loop the moment its
 * amplitude contour comes round again. Brown noise carries the tyre roar,
 * pink fills the band above it, and the whole thing is then lowpassed hard,
 * which is what distance and a row of buildings actually do: a street two
 * blocks away is not quieter, it is duller.
 *
 * Generated at a low sample rate on purpose. There is nothing above 1.5 kHz in
 * the result, so 12 kHz of bandwidth is four times more than the content needs
 * and a quarter of the memory; the AudioBuffer carries its own sample rate and
 * the context resamples on playback.
 */
export function trafficLayer(o: TrafficOpts): Samples {
  const rng = makeRng(o.seed);
  const fade = Math.round(o.sr * 1.5);
  const n = Math.round(o.sr * o.seconds) + fade;

  const b = brown(n, rng);
  const p = pink(n, rng);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = b[i] * 1.0 + p[i] * 0.42;

  /* The ebb and flow. A real street's noise floor swings several dB over tens
   * of seconds as bunches of traffic arrive from a light somewhere upstream,
   * and a bed without that swing is instantly recognisable as a loop even when
   * its spectrum is perfect. Driven from a second noise source at a rate that
   * shares no factor with the loop length. */
  const swell = driftBuffer(o.sr, o.seconds + 2, o.seed ^ 0x5bd1, 0.055);
  for (let i = 0; i < n; i++) x[i] *= 1 + 0.30 * swell[i % swell.length];

  // Subsonic content is wasted headroom on any speaker and mud on the rest.
  biquadInPlace(x, hp(o.sr, 26, 0.6), 1);
  biquadInPlace(x, peaking(o.sr, o.bumpHz, 0.85, o.bumpDb), 1);
  // 24 dB/octave. This is the distance, and it is most of the realism.
  biquadInPlace(x, lp(o.sr, o.lpHz, Math.SQRT1_2), 2);
  // What comes back over the top of the lowpass: the hiss of tyres on a wet-ish
  // road that has not gone home yet. Small, but its absence reads as 3 a.m.
  biquadInPlace(x, highshelf(o.sr, 900, o.airDb), 1);

  return rmsNormalise(loopify(x, fade), o.targetDb);
}

/* ── 2. Vehicle pass-by ────────────────────────────────────────────────── */

export type PassByOpts = {
  sr: number;
  seed: number;
  seconds: number;
  /** Closest approach in metres. Big numbers here; these are all distant. */
  closest: number;
  /** Road speed, m/s. */
  speed: number;
  /** Engine firing fundamental at that speed. */
  engineHz: number;
  targetDb: number;
};

/**
 * How much of a pass-by is baked and how much is the panner.
 *
 * The buffer carries the two things a PannerNode cannot: the moving lowpass,
 * and the doppler shift on the engine. It deliberately does *not* carry the
 * level swell, because the panner is already applying an inverse distance law
 * along the same trajectory and baking a second one in would double the
 * rolloff and turn a car into a whip crack. What the buffer does carry at its
 * edges is a fade, so that a source which starts at full level fifty metres
 * away does not start with a click.
 */
const PASSBY_EDGE_FADE = 0.18;

/**
 * A single car going past, somewhere else.
 *
 * The level envelope, the spectral envelope and the pitch are all derived from
 * one distance function rather than drawn by hand, which is why it reads as a
 * vehicle rather than as a swell. Three things happen at once as it passes:
 * amplitude goes as 1/d, the lowpass corner opens as the air path shortens,
 * and the engine tone drops through the doppler shift at the moment of closest
 * approach. Leave any one of them out and it stops being a car.
 *
 * The doppler is done by phase accumulation over an instantaneous frequency,
 * so it is exact and costs nothing; PannerNode has not had a doppler
 * implementation since the API was cleaned up, so baking it here is the only
 * way to have one.
 */
export function passByBuffer(o: PassByOpts): Samples {
  const n = Math.round(o.sr * o.seconds);
  const rng = makeRng(o.seed);
  const t0 = o.seconds * 0.5;

  const dist = (t: number) => Math.hypot(o.closest, (t - t0) * o.speed);
  /** Radial velocity, positive when receding. */
  const vr = (t: number) => {
    const along = (t - t0) * o.speed;
    return (along * o.speed) / Math.max(0.5, Math.hypot(o.closest, along));
  };

  // Tyre roar: broadband, and the dominant term for anything but a lorry.
  const tyre = white(n, rng);
  biquadInPlace(tyre, lp(o.sr, 1500, 0.8), 1);
  biquadInPlace(tyre, hp(o.sr, 55, 0.7), 1);

  /* The engine, as a wavetable rather than six sines a sample.
   *
   * Six harmonics with a little phase roughness, which is what makes it a
   * piston engine rather than a sine; the amplitudes fall faster than 1/n
   * because the top of an engine's spectrum is the first thing distance
   * removes. The waveform never changes — only its frequency does, under the
   * doppler — so evaluating it once into a table and interpolating is exactly
   * equivalent and around six times faster. That matters more than it sounds
   * like it should: six pass-by variants were three hundred milliseconds of
   * the six hundred the whole system took to build, all of it spent on the
   * least important source in the mix.
   */
  const TABLE = 2048;
  const tab = new Float32Array(TABLE + 1);
  for (let i = 0; i <= TABLE; i++) {
    const ph = (TAU * i) / TABLE;
    let v = 0;
    for (let h = 1; h <= 6; h++) {
      v += (Math.sin(ph * h + h * 0.7) / Math.pow(h, 1.45)) * (h === 2 ? 1.4 : 1);
    }
    tab[i] = v;
  }

  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / o.sr;
    // Doppler on the engine only; the tyre noise is broadband enough that the
    // shift is not audible on it.
    const f = o.engineHz * (C_AIR / (C_AIR + vr(t)));
    phase += f / o.sr;
    phase -= Math.floor(phase);
    const p = phase * TABLE, pi = p | 0;
    const eng = tab[pi] + (tab[pi + 1] - tab[pi]) * (p - pi);
    // Edges only. See PASSBY_EDGE_FADE: the swell belongs to the panner.
    const fadeT = o.seconds * PASSBY_EDGE_FADE;
    const edge = Math.min(1, t / fadeT) * Math.min(1, (o.seconds - t) / fadeT);
    const env = 0.5 - 0.5 * Math.cos(Math.PI * edge);
    out[i] = (tyre[i] * 1.0 + eng * 0.16) * env;
  }

  /* The moving lowpass. 8 kHz of bandwidth at a metre, falling to a few
   * hundred Hz at a hundred metres — the same exponential air-plus-obstruction
   * law the runtime uses on every positional source, so a baked pass-by and a
   * live one agree about what distance sounds like. */
  onePoleSweep(out, o.sr, (i) => airCutoff(dist(i / o.sr)));
  biquadInPlace(out, hp(o.sr, 40, 0.7), 1);

  return rmsNormalise(out, o.targetDb);
}

/**
 * Lowpass corner for a source `d` metres away, in Hz.
 *
 * This one function is doing more for the realism of the whole system than any
 * other line in it. Atmospheric absorption is strongly frequency dependent —
 * at 20 C and half humidity it is about 0.1 dB per 100 m at 250 Hz and 8 dB
 * per 100 m at 8 kHz — and in a built-up street, diffraction round buildings
 * adds far more of the same shape. Modelling it as a single-pole corner that
 * halves every 26 m is crude and lands within a few dB of the real curve over
 * the range that matters here.
 *
 * The floor of 220 Hz matters: without it a horn at 150 m filters down to
 * nothing and simply vanishes, when what a real one does is turn into a dull
 * blare that is still perfectly audible.
 */
export function airCutoff(d: number): number {
  return clamp(18000 * Math.exp(-d / 26), 220, 18000);
}

/* ── 3. Car horn ───────────────────────────────────────────────────────── */

export type HornOpts = {
  sr: number;
  seed: number;
  seconds: number;
  /** The two notes. A car horn is a pair of diaphragms a minor third apart. */
  f1: number;
  f2: number;
  /** One-shots are budgeted by peak, not RMS. */
  peakDb: number;
};

/**
 * A horn, synthesised close and left to the distance filter to make far.
 *
 * Two tones a minor third apart is not a stylisation, it is what is bolted to
 * the front of most cars: a pair of tuned diaphragm horns, usually around
 * 400-500 Hz, deliberately dissonant enough to be unignorable. The beating
 * between the two stacks is a large part of the character.
 *
 * The partials are slightly stretched — a vibrating steel diaphragm is not an
 * ideal string, and its overtones run sharp. That inharmonicity is why a horn
 * sounds like metal being driven rather than like a sawtooth.
 */
export function hornBuffer(o: HornOpts): Samples {
  const n = Math.round(o.sr * o.seconds);
  const rng = makeRng(o.seed);
  const out = new Float32Array(n);

  // A small pressure-driven pitch rise at the start and a wobble through the
  // note, both from noise rather than an LFO.
  const wob = driftBuffer(200, o.seconds + 1, o.seed ^ 0x91af, 6.0);

  const stacks: [number, number][] = [[o.f1, 1.0], [o.f2, 0.82]];
  for (const [f0, amp] of stacks) {
    const detune = 1 + (rng() - 0.5) * 0.004;
    for (let h = 1; h <= 14; h++) {
      const fh = f0 * detune * h * (1 + 0.00085 * h * h);
      if (fh > o.sr * 0.45) break;
      const a = amp / Math.pow(h, 1.15) * (h === 2 ? 1.25 : h === 3 ? 1.1 : 1);
      const ph = rng() * TAU;
      for (let i = 0; i < n; i++) {
        const t = i / o.sr;
        const rise = 1 - 0.022 * Math.exp(-t / 0.028);
        const w = 1 + 0.0016 * wob[Math.floor(t * 200) % wob.length];
        out[i] += a * Math.sin(TAU * fh * rise * w * t + ph);
      }
    }
  }

  /* Envelope. 14 ms to open, which is a real solenoid horn; anything faster
   * clicks and anything slower is a foghorn. The tail is 55 ms because the
   * diaphragm has mass. */
  for (let i = 0; i < n; i++) {
    const t = i / o.sr, rem = o.seconds - t;
    const atk = 1 - Math.exp(-t / 0.014);
    const rel = 1 - Math.exp(-Math.max(0, rem) / 0.055);
    // A touch of overshoot at the onset: the pressure spike before it settles.
    out[i] *= atk * rel * (1 + 0.22 * Math.exp(-t / 0.02));
  }

  return peakNormalise(out, o.peakDb);
}

/* ── 4. Footsteps ──────────────────────────────────────────────────────── */

export type StepOpts = {
  sr: number;
  seed: number;
  /** 0 or 1. The two feet are not the same and a listener knows it. */
  foot: 0 | 1;
  peakDb: number;
};

/**
 * One footstep on concrete.
 *
 * A footstep is three events, not one, and getting the middle one wrong is why
 * game footsteps sound like a click: heel strike, then the roll onto the flat
 * of the shoe twenty to fifty milliseconds later, then grit. The heel is a
 * short bandpassed burst high enough to read as a hard surface, with a small
 * low thump under it for the mass of a person; the roll is longer, quieter and
 * duller; the grit is two or three needles of high noise that make the
 * pavement gritty rather than polished.
 *
 * The generator is called a dozen times at startup to fill a bank. Variation
 * per step then comes from choosing from the bank, from playback rate, from
 * gain, and from a per-step filter — the product of which is far more distinct
 * steps than a walk contains, at four nodes a step.
 */
export function footstepBuffer(o: StepOpts): Samples {
  const rng = makeRng(o.seed);
  const n = Math.round(o.sr * 0.24);
  const out = new Float32Array(n);
  // The trailing foot lands a little softer and a little brighter, because it
  // is carrying less and is further through the stride.
  const heavy = o.foot === 0 ? 1.0 : 0.86;
  const bright = o.foot === 0 ? 1.0 : 1.08;

  // Heel strike.
  const heelF = (1500 + rng() * 1700) * bright;
  const heelT = 0.013 + rng() * 0.011;
  const heel = white(n, rng);
  biquadInPlace(heel, bp(o.sr, heelF, 1.05), 1);
  const body = white(n, rng);
  biquadInPlace(body, bp(o.sr, 320 + rng() * 190, 1.5), 1);
  for (let i = 0; i < n; i++) {
    const t = i / o.sr;
    const e = Math.exp(-t / heelT);
    out[i] += (heel[i] * 1.0 + body[i] * 0.55) * e * heavy;
  }

  // The low thump. Concrete does not boom, so this is deliberately small; it
  // is felt as weight rather than heard as a note.
  const thumpF = 74 + rng() * 34;
  for (let i = 0; i < n; i++) {
    const t = i / o.sr;
    out[i] += Math.sin(TAU * thumpF * t) * Math.exp(-t / 0.028) * 0.20 * heavy;
  }

  // Roll onto the sole.
  const rollAt = 0.026 + rng() * 0.028;
  const rollT = 0.030 + rng() * 0.035;
  const rollF = (900 + rng() * 1200) * bright;
  const rollG = dbToLin(-9 - rng() * 6);
  const roll = white(n, rng);
  biquadInPlace(roll, lp(o.sr, rollF, 0.9), 1);
  biquadInPlace(roll, hp(o.sr, 220, 0.7), 1);
  for (let i = 0; i < n; i++) {
    const t = i / o.sr - rollAt;
    if (t < 0) continue;
    out[i] += roll[i] * Math.exp(-t / rollT) * (1 - Math.exp(-t / 0.006)) * rollG * heavy;
  }

  // Grit. Two to four, in the first eighty milliseconds, quiet and sharp.
  const grit = white(n, rng);
  biquadInPlace(grit, hp(o.sr, 3200, 0.8), 2);
  const nGrit = 2 + Math.floor(rng() * 3);
  for (let g = 0; g < nGrit; g++) {
    const at = Math.round((0.004 + rng() * 0.075) * o.sr);
    const gt = 0.0018 + rng() * 0.004;
    const gg = dbToLin(-19 - rng() * 9);
    for (let i = at; i < Math.min(n, at + Math.round(gt * o.sr * 6)); i++) {
      out[i] += grit[i] * Math.exp(-(i - at) / (gt * o.sr)) * gg;
    }
  }

  // A short fade at both ends so a playback-rate change cannot produce a click.
  const ed = Math.round(o.sr * 0.0015);
  for (let i = 0; i < ed; i++) { out[i] *= i / ed; out[n - 1 - i] *= i / ed; }

  return peakNormalise(out, o.peakDb);
}

/* ── 5. Air conditioning ───────────────────────────────────────────────── */

export type AcOpts = {
  sr: number;
  seed: number;
  seconds: number;
  /** Compressor hum fundamental. Twice mains, give or take a slipping motor. */
  humHz: number;
  /** Fan blade-pass rate: shaft speed times blade count. */
  bladeHz: number;
  targetDb: number;
};

/**
 * A wall-mounted condenser, as one seamless loop.
 *
 * Deliberately periodic, because the thing itself is. A compressor running at
 * a constant load produces a genuinely steady tone at twice mains frequency
 * with a strong harmonic series, and pretending otherwise sounds worse, not
 * better. Every partial is snapped to a bin of the loop length so the loop is
 * sample-exact and can run for the whole walk without a seam.
 *
 * What must not be periodic is the mechanical rattle, so that is not in here:
 * it is scheduled as separate events at runtime. Between the two, and the
 * playback-rate detune that gives each unit on the street its own pitch, four
 * condensers share one buffer and none of them sounds like the others.
 */
export function acLoopBuffer(o: AcOpts): Samples {
  const n = Math.round(o.sr * o.seconds);
  const rng = makeRng(o.seed);
  const out = new Float32Array(n);

  // Compressor hum. Even harmonics dominate on a reciprocating compressor.
  for (let h = 1; h <= 8; h++) {
    const f = binSnap(o.humHz * h, o.sr, n);
    if (f > o.sr * 0.45) break;
    const a = (1 / Math.pow(h, 1.45)) * (h % 2 === 0 ? 1.35 : 0.8);
    const ph = rng() * TAU;
    for (let i = 0; i < n; i++) out[i] += a * Math.sin((TAU * f * i) / o.sr + ph);
  }

  // Blade pass. Low, felt more than heard, and the reason a condenser sounds
  // like something turning rather than something buzzing.
  for (let h = 1; h <= 3; h++) {
    const f = binSnap(o.bladeHz * h, o.sr, n);
    const ph = rng() * TAU;
    for (let i = 0; i < n; i++) out[i] += (0.30 / h) * Math.sin((TAU * f * i) / o.sr + ph);
  }

  // Fan noise, chopped at the blade rate. The chop depth is what stops the
  // noise reading as a hiss laid over a hum.
  const fanFade = Math.round(o.sr * 0.6);
  const fanRaw = pink(n + fanFade, rng);
  biquadInPlace(fanRaw, lp(o.sr, 1600, 0.8), 1);
  biquadInPlace(fanRaw, hp(o.sr, 240, 0.7), 1);
  const fan = loopify(fanRaw, fanFade);
  const chop = binSnap(o.bladeHz, o.sr, n);
  for (let i = 0; i < n; i++) {
    const m = 1 + 0.22 * Math.sin((TAU * chop * i) / o.sr);
    out[i] += fan[i] * 2.6 * m;
  }

  // Sheet-steel casing resonance, and a hard corner above it: a condenser is a
  // box of thin metal and it has a strong voice around 200-300 Hz.
  biquadInPlace(out, peaking(o.sr, 246, 1.6, 5.0), 1);
  biquadInPlace(out, lp(o.sr, 3200, 0.7), 1);
  biquadInPlace(out, hp(o.sr, 62, 0.7), 1);

  return rmsNormalise(out, o.targetDb);
}

/** One rattle of a loose panel: a burst of closely spaced resonant strikes. */
export function rattleBuffer(sr: number, seed: number, peakDb: number): Samples {
  const rng = makeRng(seed);
  const n = Math.round(sr * 0.34);
  const out = new Float32Array(n);
  const f = 780 + rng() * 1900;
  const q = 8 + rng() * 12;
  const src = white(n, rng);
  const hits = 2 + Math.floor(rng() * 5);
  let at = 0;
  for (let k = 0; k < hits; k++) {
    const dec = 0.012 + rng() * 0.05;
    const g = dbToLin(-rng() * 9) * Math.pow(0.72, k);
    for (let i = at; i < n; i++) {
      const t = (i - at) / sr;
      const e = Math.exp(-t / dec);
      if (e < 1e-4) break;
      out[i] += src[i] * e * g;
    }
    at += Math.round((0.008 + rng() * 0.022) * sr);
    if (at >= n) break;
  }
  biquadInPlace(out, bp(sr, f, q), 1);
  biquadInPlace(out, bp(sr, f * (1.9 + rng() * 0.5), q * 0.6), 1);
  const ed = Math.round(sr * 0.002);
  for (let i = 0; i < ed; i++) { out[i] *= i / ed; out[n - 1 - i] *= i / ed; }
  return peakNormalise(out, peakDb);
}

/* ── 6. The bar ────────────────────────────────────────────────────────── */

/**
 * Kick drum. Pitch envelope from 122 Hz to 46 Hz in sixty milliseconds.
 *
 * The click on the front is generated even though the wall will remove all of
 * it, because the wall filter is applied at runtime and the same buffer is
 * what would be heard if a door opened. Do not remove it here in the name of
 * efficiency; that is the sort of "optimisation" that makes the system unable
 * to represent the thing it is modelling.
 */
export function kickBuffer(sr: number, seed: number, peakDb: number): Samples {
  const rng = makeRng(seed);
  const n = Math.round(sr * 0.55);
  const out = new Float32Array(n);
  const f0 = 118 + rng() * 12, f1 = 44 + rng() * 6;
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = f1 + (f0 - f1) * Math.exp(-t / 0.038);
    ph += (TAU * f) / sr;
    out[i] = Math.sin(ph) * Math.exp(-t / 0.115) * (1 - Math.exp(-t / 0.0012));
  }
  const click = white(n, rng);
  biquadInPlace(click, bp(sr, 1900, 0.9), 1);
  for (let i = 0; i < n; i++) out[i] += click[i] * Math.exp(-(i / sr) / 0.004) * 0.32;
  return peakNormalise(out, peakDb);
}

/**
 * A bass note, additive and band-limited by construction.
 *
 * Additive rather than a sawtooth through a filter, because these buffers are
 * generated at 8 kHz to keep them small and a real sawtooth would alias into
 * the one part of the spectrum — under 200 Hz — that survives the wall. A
 * partial sum that stops below Nyquist cannot alias at all.
 */
export function barBassNote(sr: number, seed: number, hz: number, seconds: number, targetDb: number): Samples {
  const rng = makeRng(seed);
  const n = Math.round(sr * seconds);
  const out = new Float32Array(n);
  for (let h = 1; h <= 12; h++) {
    const f = hz * h;
    if (f > sr * 0.42) break;
    const a = 1 / Math.pow(h, 1.1);
    const ph = rng() * TAU;
    for (let i = 0; i < n; i++) out[i] += a * Math.sin((TAU * f * i) / sr + ph);
  }
  for (let i = 0; i < n; i++) {
    const t = i / sr, rem = seconds - t;
    const atk = 1 - Math.exp(-t / 0.008);
    const dec = 0.35 + 0.65 * Math.exp(-t / 0.18);
    const rel = 1 - Math.exp(-Math.max(0, rem) / 0.025);
    out[i] *= atk * dec * rel;
  }
  // Sustained, so budgeted by RMS, with a ceiling in case the partial stack
  // happens to line up in phase somewhere.
  return peakCeiling(rmsNormalise(out, targetDb), -1.5);
}

/** Whatever is on the backbeat. Through a wall it is a thud, so it is built as
 *  one: a short noise body with a tuned shell tone under it. */
export function barBodyHit(sr: number, seed: number, peakDb: number): Samples {
  const rng = makeRng(seed);
  const n = Math.round(sr * 0.30);
  const out = new Float32Array(n);
  const noise = white(n, rng);
  biquadInPlace(noise, bp(sr, 340 + rng() * 160, 0.9), 1);
  const shell = 178 + rng() * 40;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    out[i] = noise[i] * Math.exp(-t / 0.055) + Math.sin(TAU * shell * t) * Math.exp(-t / 0.045) * 0.5;
  }
  return peakNormalise(out, peakDb);
}

export type BarEvent = {
  /** Seconds from the start of the bar. */
  t: number;
  kind: 'kick' | 'body' | 'bass';
  /** Bass fundamental in Hz; absent for drums. */
  note?: number;
  gainDb: number;
  rate: number;
};

/**
 * One bar of whatever is playing in there.
 *
 * Generated fresh each bar from a running seed rather than looped. A
 * thirty-second walk past a bar covers about fourteen bars at this tempo, and
 * any loop shorter than that is heard as a loop — through a wall especially,
 * because the wall strips out everything except the rhythm and the rhythm is
 * the part a listener locks onto.
 *
 * The kick is on one and three because it always is; everything else is
 * decided per bar, and every hit carries a few milliseconds of jitter so that
 * nothing in the pattern lands exactly on a grid.
 *
 * Lives here, rather than in the sequencer, so that `tools/audio.mjs` can
 * render the real pattern offline instead of a plausible-looking copy of it.
 */
export function barPattern(
  rng: Rng, bar: number, notes: readonly number[], beat: number, jitter: number,
): BarEvent[] {
  const out: BarEvent[] = [];
  const jit = () => (rng() - 0.5) * 2 * jitter;
  for (let step = 0; step < 8; step++) {
    const t = step * beat * 0.5;
    if (step === 0 || step === 4 || (step === 7 && rng() < 0.30) || (step === 3 && rng() < 0.18)) {
      out.push({ t: t + jit(), kind: 'kick', gainDb: -1 - rng() * 2, rate: 1 });
    }
    if (step === 2 || step === 6) {
      out.push({ t: t + jit(), kind: 'body', gainDb: -6 - rng() * 3, rate: 1 });
    }
    if (rng() < 0.72) {
      const idx = (bar * 3 + step) % notes.length;
      out.push({
        t: t + jit(), kind: 'bass',
        // Mostly the root, so the line has a tonic to come back to.
        note: notes[rng() < 0.55 ? 0 : idx],
        gainDb: -4 - rng() * 4, rate: 0.99 + rng() * 0.02,
      });
    }
  }
  return out;
}

/* ── 7. Neon ───────────────────────────────────────────────────────────── */

/**
 * Ballast buzz plus tube sizzle, as a seamless loop.
 *
 * A magnetic ballast buzzes at twice mains with a very rich harmonic series —
 * it is a laminated core being pulled about by a distorted current, not a
 * loudspeaker — and the tube itself re-strikes twice per cycle, which is heard
 * as a sizzle amplitude-modulated at 120 Hz with a sharp duty cycle rather
 * than as a smooth tremolo.
 *
 * At golden hour the signs are only just warming up, so this is mixed
 * extremely low and gated by a flicker envelope at runtime. It is here to be
 * noticed once, close to the sign, and never again.
 */
export function neonBuffer(sr: number, seed: number, seconds: number, targetDb: number): Samples {
  const n = Math.round(sr * seconds);
  const rng = makeRng(seed);
  const out = new Float32Array(n);
  const f0 = binSnap(120, sr, n);

  for (let h = 1; h <= 24; h++) {
    const f = f0 * h;
    if (f > sr * 0.42) break;
    // Odd harmonics dominate a symmetric magnetic distortion.
    const a = (1 / Math.pow(h, 0.95)) * (h % 2 === 1 ? 1 : 0.45);
    const ph = rng() * TAU;
    for (let i = 0; i < n; i++) out[i] += a * Math.sin((TAU * f * i) / sr + ph);
  }
  scale(out, 0.35);

  const sizFade = Math.round(sr * 0.4);
  const siz = loopify(pink(n + sizFade, rng), sizFade);
  biquadInPlace(siz, bp(sr, 4200, 0.7), 1);
  for (let i = 0; i < n; i++) {
    const g = Math.pow(Math.abs(Math.sin((Math.PI * f0 * i) / sr)), 7);
    // 3.4 put the spectral centroid at 844 Hz, which is a hum with a hiss on
    // it rather than the sizzle of a gas discharge re-striking twice a cycle.
    out[i] += siz[i] * g * 5.6;
  }

  biquadInPlace(out, hp(sr, 95, 0.7), 1);
  return rmsNormalise(out, targetDb);
}

/* ── 8. The canyon ─────────────────────────────────────────────────────── */

export type IrOpts = {
  sr: number;
  seed: number;
  /** Distance to each building line from where the walker usually is. */
  nearWall: number;
  farWall: number;
  /** Kerb-to-kerb plus footways: the round trip of the flutter. */
  width: number;
  eyeHeight: number;
  seconds: number;
  /** RT60 in the low, mid and high bands. */
  rtLow: number;
  rtMid: number;
  rtHigh: number;
  /**
   * Total energy of the pair, in dB, not RMS and not peak.
   *
   * A convolution's output level is the input times the square root of the
   * impulse response's energy, so an IR is the one buffer in this system that
   * must be budgeted that way. Normalising it by RMS like everything else gave
   * a 1.25-second response whose energy summed to +31 dB, and since
   * ConvolverNode is left with `normalize = false` — deliberately, so the
   * decay the generator designed is the decay that is heard — that is a thirty
   * dB error in the reverb return that no amount of send trimming would have
   * made sense of. At 0 dB the convolver passes what it is given.
   */
  energyDb: number;
};

/**
 * A street canyon impulse response, generated rather than recorded.
 *
 * Two parts, and they do different jobs. The discrete early reflections carry
 * the *size* of the street: the ear reads the width of a space almost entirely
 * from the delay of the first lateral reflection, and at 11.4 m between
 * building lines those land at 28 and 38 ms with a flutter repeating every
 * 33 ms as the sound bounces between two parallel hard faces. Put those in and
 * the geometry is audible even with no tail at all.
 *
 * The diffuse tail carries the *material*. It is exponentially decaying noise
 * in three bands with three different decay times, because brick, glass and
 * air all absorb high frequencies far faster than low ones — a canyon tail
 * that decays evenly across the spectrum sounds like a plate, not a street.
 *
 * The tail is short on purpose. This is an evening street with traffic in it,
 * not an empty one at three in the morning; the long, obvious, bright tail
 * that a deserted canyon gives you is the single loudest way to import the
 * wrong hour into a mix.
 */
export function streetIR(o: IrOpts): { left: Samples; right: Samples } {
  const n = Math.round(o.sr * o.seconds);

  const build = (side: -1 | 1, seed: number): Samples => {
    const r = makeRng(seed);
    const out = new Float32Array(n);

    /* Early reflections.
     *
     * `side` decides which wall is the near one for this channel, which is
     * what gives the reverb its width: the same room, heard from two ears a
     * little way apart, has its first reflection arrive at different times on
     * each side. Doing it this way rather than by decorrelating two noise
     * tails is what makes the result read as a street rather than as stereo
     * mush.
     */
    const near = side < 0 ? o.nearWall : o.farWall;
    const far = side < 0 ? o.farWall : o.nearWall;
    const taps: [number, number][] = [
      // Ground bounce. Always first, always there, always a bit dull.
      [(2 * o.eyeHeight) / C_AIR, 0.42],
      [(2 * near) / C_AIR, 0.62],
      [(2 * far) / C_AIR, 0.50],
    ];
    // The flutter between the two parallel faces. Six bounces is where facade
    // absorption has taken it below the diffuse tail anyway.
    for (let k = 1; k <= 6; k++) {
      const t = (2 * near + k * o.width * 2) / C_AIR;
      if (t >= o.seconds) break;
      taps.push([t, 0.46 * Math.pow(0.60, k)]);
    }
    for (const [t, g] of taps) {
      const i = Math.round(t * o.sr);
      if (i < 1 || i >= n - 2) continue;
      // Jitter the sign and a little of the level: real facades are broken up
      // by reveals and shopfronts, and a train of identical-polarity taps
      // combs the spectrum audibly.
      const s = r() < 0.5 ? -1 : 1;
      out[i] += g * s * (0.75 + r() * 0.5);
      out[i + 1] += g * s * 0.35;
    }

    /* Diffuse tail, three bands, three decay rates.
     *
     * The band splits are four-pole rather than two. That is not fussiness:
     * with a 12 dB/octave split the mid band is only 12 dB down at 4 kHz, and
     * because it decays half a second slower than the high band it *becomes*
     * the tail up there after the first two hundred milliseconds. Measured
     * RT60 at 4 kHz came out at 0.7 s against a design of 0.48 and the
     * spectral tilt that makes a canyon sound like a canyon had gone. At
     * 24 dB/octave the leak is 24 dB down and the measurement lands. */
    const bands: [number, number, (x: Samples) => void][] = [
      [o.rtLow, 1.00, (x) => { biquadInPlace(x, lp(o.sr, 260, 0.7), 2); }],
      [o.rtMid, 0.85, (x) => { biquadInPlace(x, hp(o.sr, 260, 0.7), 2); biquadInPlace(x, lp(o.sr, 2000, 0.7), 2); }],
      [o.rtHigh, 0.55, (x) => { biquadInPlace(x, hp(o.sr, 2000, 0.7), 2); }],
    ];
    for (const [rt, w, filt] of bands) {
      const b = white(n, r);
      filt(b);
      const k = 6.907755 / rt;   // ln(1000): -60 dB at t = rt
      for (let i = 0; i < n; i++) {
        const t = i / o.sr;
        // Build-up: no diffuse energy before the first reflections have had
        // time to break up. A tail that starts at t=0 reads as a fade-in on
        // every transient.
        const onset = 1 - Math.exp(-t / 0.022);
        out[i] += b[i] * Math.exp(-k * t) * onset * w;
      }
    }
    return out;
  };

  const left = build(-1, o.seed ^ 0x1f3d);
  const right = build(+1, o.seed ^ 0x77c1);
  // One gain for both channels, so the stereo image is not skewed by whichever
  // channel happened to get the louder noise.
  let e = 0;
  for (let i = 0; i < n; i++) e += left[i] * left[i] + right[i] * right[i];
  const g = dbToLin(o.energyDb) / Math.max(1e-9, Math.sqrt(e));
  scale(left, g); scale(right, g);
  return { left, right };
}
