/* Does the graph actually connect to anything?
 *
 * tools/audio.mjs measures the sound. This measures the wiring, and the two
 * failures it exists to catch are the ones that produce no error and no
 * output: a node that was created and configured and never connected, and a
 * gain that was left at zero. Web Audio reports neither. A source feeding a
 * filter feeding nothing is a completely legal graph that makes silence, and
 * the only way to find it without ears is to walk the edges.
 *
 * So this stands up a fake AudioContext that records every `connect`, builds
 * the *real* CityAudio engine against it — the same src/audio/engine.ts the
 * browser runs, not a transcription of it — drives thirty-five seconds of a
 * walk down the street, and then asks three questions:
 *
 *   1. Can every buffer source reach the destination?
 *   2. Is any gain on one of those paths zero?
 *   3. Did the schedulers fire a plausible number of events over the walk?
 *
 * It cannot tell you what anything sounds like. It can tell you that nothing
 * is disconnected, which is the failure this codebase has had before.
 *
 *   node tools/audiograph.mjs [--verbose]
 */
import { register } from 'node:module';
register('./ts-hooks.mjs', import.meta.url);

const VERBOSE = process.argv.includes('--verbose');

/* ── A recording AudioContext ──────────────────────────────────────────── */

let uid = 0;
const nodes = [];
const edges = [];     // live connections, spliced when a node disconnects
const edgeLog = [];   // every connection ever made, for the reachability pass

function param(value = 0) {
  const p = {
    value,
    _events: 0,
    setValueAtTime(v) { p.value = v; p._events++; return p; },
    linearRampToValueAtTime(v) { p.value = v; p._events++; return p; },
    exponentialRampToValueAtTime(v) { p.value = v; p._events++; return p; },
    setTargetAtTime(v) { p.value = v; p._events++; return p; },
    cancelScheduledValues() { return p; },
  };
  return p;
}

function node(kind, extra = {}) {
  const n = {
    id: uid++, kind,
    connect(dst) {
      const e = { from: n.id, to: dst && dst.id !== undefined ? dst.id : -1 };
      edges.push(e);
      edgeLog.push(e);
      return dst;
    },
    disconnect() {
      for (let i = edges.length - 1; i >= 0; i--) if (edges[i].from === n.id) edges.splice(i, 1);
    },
    ...extra,
  };
  nodes.push(n);
  return n;
}

class FakeAudioContext {
  constructor() {
    this.sampleRate = 48000;
    this.currentTime = 0;
    this.state = 'suspended';
    this.destination = node('destination');
    this.listener = {
      positionX: param(), positionY: param(), positionZ: param(),
      forwardX: param(), forwardY: param(), forwardZ: param(0),
      upX: param(), upY: param(1), upZ: param(),
    };
    this.buffersMade = 0;
    this.sampleBytes = 0;
  }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }

  createGain() { return node('gain', { gain: param(1) }); }
  createBiquadFilter() {
    return node('biquad', { type: 'lowpass', frequency: param(350), Q: param(1), gain: param(0), detune: param(0) });
  }
  createStereoPanner() { return node('stereoPanner', { pan: param(0) }); }
  createAnalyser() {
    return node('analyser', {
      fftSize: 2048,
      // A tiny non-zero signal, so the engine's own meters do not report
      // silence and mask the thing this tool is looking for.
      getFloatTimeDomainData(a) { for (let i = 0; i < a.length; i++) a[i] = Math.sin(i * 0.1) * 0.01; },
    });
  }
  createConvolver() { return node('convolver', { normalize: true, buffer: null }); }
  createDynamicsCompressor() {
    return node('compressor', {
      threshold: param(-24), knee: param(30), ratio: param(12),
      attack: param(0.003), release: param(0.25), reduction: 0,
    });
  }
  createPanner() {
    return node('panner', {
      panningModel: 'equalpower', distanceModel: 'inverse',
      refDistance: 1, rolloffFactor: 1, maxDistance: 10000,
      coneInnerAngle: 360, coneOuterAngle: 360, coneOuterGain: 0,
      positionX: param(), positionY: param(), positionZ: param(),
      orientationX: param(1), orientationY: param(), orientationZ: param(),
    });
  }
  createBufferSource() {
    const n = node('bufferSource', {
      buffer: null, loop: false, loopStart: 0, loopEnd: 0,
      playbackRate: param(1), detune: param(0), onended: null,
      _started: false, _ended: false, _endsAt: Infinity,
      start(when = 0) {
        n._started = true;
        n._startedAt = when;
        /* A looping source never ends; a one-shot ends after its buffer, sped
         * up or slowed down by the playback rate. Modelling this is the only
         * way to exercise the onended handlers, and those handlers are the
         * entire cleanup path — every one-shot in the system disconnects
         * itself from there and nowhere else. */
        if (!n.loop && n.buffer) n._endsAt = when + n.buffer.duration / (n.playbackRate.value || 1);
      },
      stop(when = 0) { n._endsAt = Math.min(n._endsAt, when); },
    });
    return n;
  }
  createBuffer(channels, length, sampleRate) {
    this.buffersMade++;
    this.sampleBytes += channels * length * 4;
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return {
      numberOfChannels: channels, length, sampleRate, duration: length / sampleRate,
      copyToChannel(src, ch) { data[ch].set(src.subarray(0, length)); },
      getChannelData(ch) { return data[ch]; },
      _data: data,
    };
  }
}

const ctx = new FakeAudioContext();
globalThis.window = { AudioContext: function () { return ctx; } };
globalThis.AudioContext = globalThis.window.AudioContext;

/* ── Build and drive ───────────────────────────────────────────────────── */

const THREE = await import('three');
const { CityAudio } = await import('../src/audio/engine.ts');

let pass = 0, fail = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) pass++; else { fail++; failures.push(`${name}: ${detail}`); }
};

console.log('System 7 — graph connectivity and scheduler behaviour');

const t0 = performance.now();
const audio = new CityAudio();
await audio.resume();
audio.build();
const buildMs = performance.now() - t0;

check('context resumed', ctx.state === 'running', `context is ${ctx.state}`);
check('graph built', audio.isBuilt, 'build() left the engine unbuilt');

/* Walk the block. The camera goes where the walker goes — 1.4 m/s from
 * z = +4 to z = -94 — because half the graph's behaviour depends on distance
 * to the listener and a stationary test would never retune a single filter. */
const camera = new THREE.Object3D();
camera.add(audio.listener);
const DT = 1 / 60;
const WALK = 35;
let steps = 0, phase = 0;
let peakLiveEdges = 0, peakVoices = 0;
const stageMs = [];

/** Fire onended for anything whose buffer has run out, as the browser would. */
function retire(now) {
  for (const n of nodes) {
    if (n.kind !== 'bufferSource' || n._ended || !n._started) continue;
    if (now < n._endsAt) continue;
    n._ended = true;
    if (typeof n.onended === 'function') n.onended();
  }
}

for (let f = 0; f * DT < WALK; f++) {
  const t = f * DT;
  ctx.currentTime = t;
  camera.position.set(-0.85, 1.65, Math.max(-94, 4 - 1.4 * t));
  // Two steps a second, which is what walker.ts produces at full pace.
  phase += Math.PI * 2.0 * DT;
  if (phase >= Math.PI) { phase -= Math.PI; audio.footstep(steps++ & 1); }
  retire(t);
  const before = audio.report().pendingStages;
  const fr0 = performance.now();
  audio.update(DT, camera);
  const cost = performance.now() - fr0;
  const r = audio.report();
  // A frame that costs more than a millisecond is a build stage landing.
  if (cost > 1) stageMs.push({ remaining: before, cost });
  peakLiveEdges = Math.max(peakLiveEdges, edges.length);
  peakVoices = Math.max(peakVoices, r.voices);
}
retire(WALK + 60);   // let the long tails finish, then look for what is left

const rep = audio.report();

/* ── 1. Reachability ───────────────────────────────────────────────────── */

const out = new Map();
for (const e of edgeLog) {
  if (!out.has(e.from)) out.set(e.from, new Set());
  out.get(e.from).add(e.to);
}
const byId = new Map(nodes.map((n) => [n.id, n]));

/** Everything that can reach the destination, by walking edges backwards. */
const reaches = new Set([ctx.destination.id]);
let grew = true;
while (grew) {
  grew = false;
  for (const e of edgeLog) {
    if (reaches.has(e.to) && !reaches.has(e.from)) { reaches.add(e.from); grew = true; }
  }
}

const sources = nodes.filter((n) => n.kind === 'bufferSource');
const orphanSources = sources.filter((n) => !reaches.has(n.id));
const orphanOther = nodes.filter((n) => n.kind !== 'destination' && !reaches.has(n.id) && (out.get(n.id)?.size ?? 0) === 0);

console.log(`\n  ${nodes.length} nodes over the walk, ${edgeLog.length} connections made, ${ctx.buffersMade} AudioBuffers, ${Math.round(ctx.sampleBytes / 1024)} kB of samples`);
const worstStage = Math.max(0, ...stageMs.map((s) => s.cost));
console.log(`  first stage ${buildMs.toFixed(0)} ms, then ${stageMs.length} staged frames, worst ${worstStage.toFixed(0)} ms, ${rep.buildMs.toFixed(0)} ms in total`);
if (VERBOSE) console.log(`  stages: ${stageMs.map((s) => `${s.cost.toFixed(0)}`).join(', ')} ms`);
console.log(`  steady state: ${edges.length} live connections at the end, peak ${peakLiveEdges}, peak ${peakVoices} voices`);
if (VERBOSE) {
  const counts = {};
  for (const n of nodes) counts[n.kind] = (counts[n.kind] ?? 0) + 1;
  console.log(`  by kind: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}`);
}

check('every source reaches the destination', orphanSources.length === 0,
  `${orphanSources.length} buffer sources are connected to nothing that leads out: ${orphanSources.map((n) => n.id).join(', ')}`);
check('no dead-end nodes', orphanOther.length === 0,
  `${orphanOther.length} nodes were created, configured and never connected: ${orphanOther.map((n) => `${n.kind}#${n.id}`).join(', ')}`);
check('every source was started', sources.every((n) => n._started),
  `${sources.filter((n) => !n._started).length} buffer sources were built and never start()ed`);
check('every source has a buffer', sources.every((n) => n.buffer),
  `${sources.filter((n) => !n.buffer).length} buffer sources are playing null`);

/* ── 2. Zero gains on live paths ───────────────────────────────────────── */

const zeroGains = nodes.filter((n) => n.kind === 'gain' && reaches.has(n.id) && Math.abs(n.gain.value) < 1e-6);
check('no zero gains in the signal path', zeroGains.length === 0,
  `${zeroGains.length} gain nodes on a live path sit at exactly zero, which is silence with no error`);

const conv = nodes.find((n) => n.kind === 'convolver');
check('convolver has an impulse response', conv && conv.buffer, 'the ConvolverNode buffer is null; the reverb send goes nowhere');
check('convolver normalisation off', conv && conv.normalize === false,
  'ConvolverNode.normalize is on, which will discard the decay the IR generator designed');
check('convolver is fed', conv && edges.some((e) => e.to === conv.id), 'nothing sends to the reverb');
check('convolver reaches the output', conv && reaches.has(conv.id), 'the reverb return is not connected to the master');

/* ── 3. What the schedulers did over one walk ──────────────────────────── */

console.log(`\n  over ${WALK} s of walking:`);
console.log(`    footsteps  ${rep.counts.steps}`);
console.log(`    horns      ${rep.counts.horns}`);
console.log(`    pass-bys   ${rep.counts.passBys}`);
console.log(`    rattles    ${rep.counts.rattles}`);
console.log(`    bar hits   ${rep.counts.barHits}`);
console.log(`    live voices left over: ${rep.voices} (of ${sources.length} sources started)`);

// The brief says two or three horns across the walk, at most.
check('horn count', rep.counts.horns >= 1 && rep.counts.horns <= 4,
  `${rep.counts.horns} horns in ${WALK} s; the brief allows two or three across the walk`);
check('pass-by count', rep.counts.passBys >= 2 && rep.counts.passBys <= 6,
  `${rep.counts.passBys} pass-bys in ${WALK} s`);
check('footsteps fired', rep.counts.steps > 50, `only ${rep.counts.steps} footsteps from ${WALK} s at two a second`);
check('bar kept playing', rep.counts.barHits > 100, `only ${rep.counts.barHits} bar hits; the sequencer stalled`);
check('rattles fired', rep.counts.rattles > 2, `${rep.counts.rattles} rattles; the AC units are perfectly maintained`);

/* ── 3b. Cleanup ───────────────────────────────────────────────────────────
 *
 * Every one-shot in this system disconnects itself from its own `ended`
 * handler and from nowhere else, so if a handler is ever missed the node stays
 * in the graph for the life of the page. Two thousand footsteps into a long
 * session that is a real leak, and it is completely invisible from a listening
 * test. The retire() pass above fires those handlers on schedule, so what is
 * left standing here is what would really be left standing.
 */
const loops = sources.filter((n) => n.loop);
const oneShots = sources.filter((n) => !n.loop);
const stillConnected = oneShots.filter((n) => edges.some((e) => e.from === n.id));

check('every one-shot ended', oneShots.every((n) => n._ended),
  `${oneShots.filter((n) => !n._ended).length} one-shot sources never reached their end time`);
check('every one-shot disconnected itself', stillConnected.length === 0,
  `${stillConnected.length} finished sources are still wired into the graph; their ended handler never ran`);
check('the loops are still running', loops.every((n) => !n._ended && edges.some((e) => e.from === n.id)),
  'a looping source was retired or disconnected; the bed or an AC unit has gone silent');
// The engine only counts one-shots as voices; the loops are permanent and are
// checked above. So after everything has ended the count must be exactly zero.
check('voice count returns to zero', rep.voices === 0,
  `${rep.voices} voices left after every one-shot ended; that many nodes leaked`);

/* The steady-state graph should be the loops and their fixed chains, nothing
 * more. This is the number that would grow over a long session. */
check('graph does not grow', edges.length <= peakLiveEdges && edges.length < 260,
  `${edges.length} live connections left after the walk, peak ${peakLiveEdges}`);

/* ── 3c. The staged build ──────────────────────────────────────────────────
 *
 * The whole system took 620 ms to render, on the click that also takes pointer
 * lock. It is now one stage a frame, and no single frame may cost anything
 * like a frame's budget. */
check('first stage is short', buildMs < 120, `the click stalls for ${buildMs.toFixed(0)} ms before any sound`);
check('no stage blows a frame', worstStage < 60, `worst staged frame cost ${worstStage.toFixed(0)} ms`);
check('the build finished', rep.pendingStages === 0, `${rep.pendingStages} build stages never ran`);

/* ── 4. Spot placement and filtering ───────────────────────────────────── */

console.log('\n  positional sources at the end of the walk:');
for (const s of rep.spots) {
  console.log(`    ${s.name.padEnd(16)} ${JSON.stringify(s.pos).padEnd(22)} ${String(s.dist).padStart(6)} m  fc ${String(s.cutoffHz).padStart(6)} Hz  gain ${String(s.gainDb).padStart(6)} dB`);
}
check('spots exist', rep.spots.length >= 8, `only ${rep.spots.length} positional sources`);
/* The air filter has to have moved. A cutoff still at its 18 kHz initial value
 * after a walk means the per-frame retune is not running, which would be
 * invisible in a listening test on a short walk and very audible on a long one.
 */
const retuned = rep.spots.filter((s) => s.cutoffHz < 17000);
check('air filters are tracking distance', retuned.length === rep.spots.length,
  `${rep.spots.length - retuned.length} spots still sit at their initial cutoff; the per-frame retune is not reaching them`);

/* ── 5. The meters ─────────────────────────────────────────────────────── */

console.log('\n  buses:');
for (const [name, b] of Object.entries(rep.buses)) {
  console.log(`    ${name.padEnd(8)} gain ${String(b.gainDb).padStart(6)} dB   ever ${String(b.everDb).padStart(7)} dBFS`);
}
/* In this harness the analysers are fed a synthetic tone, so `everDb` proves
 * the meter is wired rather than that the bus has signal. That is still worth
 * checking: an unread meter is the debug surface lying to the next agent. */
check('all buses metered', Object.values(rep.buses).every((b) => Number.isFinite(b.everDb)),
  `buses with no meter reading at all: ${Object.entries(rep.buses).filter(([, b]) => !Number.isFinite(b.everDb)).map(([k]) => k).join(', ')}`);
check('master gain faded up', rep.master.gainDb > -12 && rep.master.gainDb < 0,
  `master is at ${rep.master.gainDb} dBFS after ${WALK} s; the fade-in did not complete`);
check('debug surface reports no silence', rep.silent.length === 0,
  `report().silent lists ${rep.silent.join(', ')}`);

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(fail ? 1 : 0);
