/* What System 7 actually produces, measured rather than asserted.
 *
 * This is the audio equivalent of tools/shoot.mjs, and it exists for the same
 * reason: the only way to know whether a generator is right is to look at the
 * numbers it makes, and for audio you can do that entirely on the CPU. It
 * imports src/audio/dsp.ts and src/audio/design.ts directly — the real
 * generators and the real constants, not a reimplementation — renders every
 * source into a Float32Array, pushes it through the same filter chain the
 * runtime graph will apply, and reports RMS, peak, crest factor, spectral
 * centroid and an octave-band breakdown against what each one is supposed to
 * be.
 *
 * The check it exists for above all others is the first one in every row:
 * non-silence. A Web Audio graph with a disconnected node or a zero gain
 * raises nothing and produces nothing, and a generator that returns an array
 * of zeros is indistinguishable from a correct one until somebody puts
 * headphones on. Everything here runs in about two seconds and needs no
 * browser, no GPU and no ears.
 *
 *   node tools/audio.mjs            all checks, one line each
 *   node tools/audio.mjs --verbose  plus the full octave-band table
 *   node tools/audio.mjs --only bar just one group
 *
 * Node strips the types on import; no build step and no bundler.
 */
import {
  makeRng, lp, hp, bp, peaking, biquadInPlace, rms, peak, linToDb, dbToLin,
  trafficLayer, passByBuffer, hornBuffer, footstepBuffer, acLoopBuffer,
  rattleBuffer, kickBuffer, barBassNote, barBodyHit, neonBuffer, streetIR,
  barPattern, airCutoff,
} from '../src/audio/dsp.ts';
import {
  SR, BED, BED_LAYERS, PASSBY, PASSBY_LANES, HORN, HORN_SPOTS, HORN_VOICES,
  STEPS, AC, AC_UNITS, AC_BUFFERS, BAR, NEON, IR, SENDS, MASTER, PANNER,
  PEAK_DB, airCutoffHz, stepVariation, GEO, bedLayerOpts,
} from '../src/audio/design.ts';

/* Where the mix is measured from.
 *
 * Everything audible is judged against the bed, because that is what it has
 * to be heard over: an absolute dBFS threshold is meaningless when the whole
 * mix can be moved by the master gain, but "twelve dB under the traffic" is a
 * statement about whether a listener will notice the thing. */
const BED_AT_LISTENER = BED.bufDb + BED.busDb + MASTER.gainDb;

const args = process.argv.slice(2);
const VERBOSE = args.includes('--verbose');
const ONLY = (() => { const i = args.indexOf('--only'); return i < 0 ? null : args[i + 1]; })();

/* ── Spectral machinery ────────────────────────────────────────────────── */

/** In-place iterative radix-2 FFT. re/im are Float64Array of length 2^k. */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/**
 * Welch power spectrum: Hann-windowed, half-overlapped, averaged.
 *
 * A single transform of a whole buffer is a spectrum of one particular noise
 * realisation and is far too ragged to compare a centroid against a threshold.
 * Averaging thirty frames turns it into an estimate with a usable variance.
 */
function spectrum(x, sr, size = 4096) {
  const n = Math.min(size, 1 << Math.floor(Math.log2(Math.max(64, x.length))));
  const hop = n >> 1;
  const win = new Float64Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  const acc = new Float64Array(n / 2 + 1);
  const re = new Float64Array(n), im = new Float64Array(n);
  let frames = 0;
  for (let off = 0; off + n <= x.length; off += hop) {
    for (let i = 0; i < n; i++) { re[i] = x[off + i] * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= n / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    frames++;
  }
  if (frames === 0) {
    for (let i = 0; i < n && i < x.length; i++) { re[i] = (x[i] ?? 0) * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k <= n / 2; k++) acc[k] = re[k] * re[k] + im[k] * im[k];
    frames = 1;
  }
  for (let k = 0; k <= n / 2; k++) acc[k] /= frames;
  return { power: acc, binHz: sr / n };
}

const OCTAVES = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];

function analyse(x, sr) {
  const p = peak(x), r = rms(x);
  const { power, binHz } = spectrum(x, sr);
  let tot = 0, wsum = 0;
  for (let k = 1; k < power.length; k++) { tot += power[k]; wsum += power[k] * k * binHz; }
  const centroid = tot > 0 ? wsum / tot : 0;

  const bands = OCTAVES.map((fc) => {
    const lo = fc / Math.SQRT2, hi = fc * Math.SQRT2;
    let s = 0;
    for (let k = 1; k < power.length; k++) {
      const f = k * binHz;
      if (f >= lo && f < hi) s += power[k];
    }
    return tot > 0 ? s / tot : 0;
  });

  const fracBelow = (f) => {
    let s = 0;
    for (let k = 1; k < power.length; k++) if (k * binHz < f) s += power[k];
    return tot > 0 ? s / tot : 0;
  };
  /** Frequency of the largest spectral peak, refined by parabolic fit. */
  const peakHz = () => {
    let best = 1;
    for (let k = 2; k < power.length - 1; k++) if (power[k] > power[best]) best = k;
    const a = power[best - 1], b = power[best], c = power[best + 1];
    const d = a - 2 * b + c;
    const off = Math.abs(d) > 1e-30 ? (0.5 * (a - c)) / d : 0;
    return (best + off) * binHz;
  };

  return {
    rmsDb: linToDb(r), peakDb: linToDb(p),
    crestDb: linToDb(p) - linToDb(r),
    centroid, bands, fracBelow, peakHz: peakHz(),
    dur: x.length / sr,
  };
}

/* ── Reporting ─────────────────────────────────────────────────────────── */

let pass = 0, fail = 0;
const failures = [];

const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : String(v));
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

function check(name, ok, detail) {
  if (ok) { pass++; } else { fail++; failures.push(`${name}: ${detail}`); }
  return ok;
}

/** Every generator gets this one, unconditionally. */
function notSilent(name, a) {
  return check(`${name} silent`, a.rmsDb > -60,
    `RMS ${f1(a.rmsDb)} dBFS — the buffer is empty or nearly so`);
}

function inRange(name, what, v, lo, hi, unit = '') {
  return check(`${name} ${what}`, v >= lo && v <= hi,
    `${what} = ${f1(v)}${unit}, wanted ${f1(lo)}..${f1(hi)}${unit}`);
}

function row(name, a, extra = '') {
  console.log(
    `  ${pad(name, 22)} ${padL(f1(a.rmsDb), 7)} ${padL(f1(a.peakDb), 7)} ${padL(f1(a.crestDb), 6)} ` +
    `${padL(Math.round(a.centroid), 7)} ${padL(a.dur.toFixed(2), 6)}  ${extra}`);
}

function header(title) {
  console.log(`\n${title}`);
  console.log(`  ${pad('source', 22)} ${padL('rms', 7)} ${padL('peak', 7)} ${padL('crest', 6)} ${padL('cent', 7)} ${padL('dur', 6)}`);
}

function bandTable(name, a) {
  if (!VERBOSE) return;
  const cells = a.bands.map((b, i) => `${OCTAVES[i] >= 1000 ? OCTAVES[i] / 1000 + 'k' : OCTAVES[i]}:${(b * 100).toFixed(1)}`);
  console.log(`      ${name} octaves %  ${cells.join('  ')}`);
}

const want = (group) => !ONLY || ONLY === group;

/* ── Shared helpers ────────────────────────────────────────────────────── */

/** Linear-interpolating resample of a looping buffer into `out`. */
function loopInto(out, src, rate, startFrac) {
  let pos = startFrac * src.length;
  for (let i = 0; i < out.length; i++) {
    const i0 = Math.floor(pos) % src.length;
    const i1 = (i0 + 1) % src.length;
    const fr = pos - Math.floor(pos);
    out[i] += src[i0] * (1 - fr) + src[i1] * fr;
    pos += rate;
    if (pos >= src.length) pos -= src.length;
  }
  return out;
}

/** Mix a one-shot into a track at a time offset, with gain and playback rate. */
function mixAt(track, src, sr, atSec, gain, rate = 1) {
  const start = Math.round(atSec * sr);
  for (let i = 0; i < Math.floor(src.length / rate); i++) {
    const j = start + i;
    if (j < 0 || j >= track.length) continue;
    const p = i * rate;
    const p0 = Math.floor(p), p1 = Math.min(src.length - 1, p0 + 1), fr = p - p0;
    track[j] += (src[p0] * (1 - fr) + src[p1] * fr) * gain;
  }
  return track;
}

/**
 * PannerNode's inverse distance law, in dB.
 *
 * Replicated from the specification rather than measured, so that the
 * predicted level at the listener below is the level the graph will actually
 * produce and a mistake in the gain structure shows up here instead of in a
 * listening test.
 */
function distanceDb(d) {
  const { refDistance: ref, rolloffFactor: k, maxDistance: max } = PANNER;
  const dd = Math.min(Math.max(d, ref), max);
  return linToDb(ref / (ref + k * (dd - ref)));
}

/* The walker's line, and the two distances that matter.
 *
 * A source is judged at its *closest* approach, because that is where it has
 * to be audible, and reported at mid-walk for context. Measuring the horn
 * behind the player from the middle of the block said it was inaudible; it is
 * twenty-six metres away at the start of the walk, which is where it is heard.
 */
const walkAt = (z) => [-0.85, GEO.eyeHeight, Math.max(GEO.walkEndZ, Math.min(GEO.walkStartZ, z))];
const midWalk = walkAt((GEO.walkStartZ + GEO.walkEndZ) / 2);
const dist3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const distFromWalk = (p) => dist3(p, midWalk);
/** Closest the walker ever gets to a fixed point. */
const nearestOnWalk = (p) => dist3(p, walkAt(p[2]));

/**
 * Apply the runtime air filter for a given distance, plus any fixed occlusion.
 *
 * The guard is not a shortcut. Generators run at their own sample rates — the
 * bar's are 8 kHz, because nothing in a kick drum heard through a wall needs
 * more — and a lowpass at the 15 kHz corner a source six metres away gets is
 * far past what a biquad can represent at that rate. It does not roll off, it
 * blows up: this measured the bar at +7.8 dBFS and sent the design chasing a
 * twenty-one dB make-up gain that was never needed. Above 0.4 of the sample
 * rate the filter is a no-op on the content anyway, so skipping it is both
 * safe and what the runtime graph, running at 48 kHz, actually does.
 */
function airFilter(x, sr, d, occludeHz = 0) {
  const fc = airCutoffHz(d);
  if (fc < sr * 0.4) biquadInPlace(x, lp(sr, fc, Math.SQRT1_2), 1);
  if (occludeHz > 0 && occludeHz < sr * 0.4) biquadInPlace(x, lp(sr, occludeHz, Math.SQRT1_2), 1);
  return x;
}

/** Absolute power above a frequency, for a true transmission loss rather than
 *  a ratio of two normalised fractions. */
function powerAbove(x, sr, f) {
  const { power, binHz } = spectrum(x, sr);
  let s = 0;
  for (let k = 1; k < power.length; k++) if (k * binHz >= f) s += power[k];
  return s;
}

/**
 * Is a wrap-around discontinuity a click, or just the signal?
 *
 * The first version compared the seam to a two-point linear extrapolation,
 * which fails every buffer with any high-frequency content in it because
 * linear extrapolation is a poor predictor of the next sample of *anything*
 * broadband. The honest test is whether the jump across the wrap is unusual
 * compared with the jumps the signal makes everywhere else, so: the seam
 * difference against a high percentile of the ordinary sample-to-sample
 * difference.
 */
function seamRatio(x) {
  const n = x.length;
  const diffs = new Float64Array(Math.min(n - 1, 20000));
  const stride = Math.max(1, Math.floor((n - 1) / diffs.length));
  for (let i = 0; i < diffs.length; i++) diffs[i] = Math.abs(x[i * stride + 1] - x[i * stride]);
  diffs.sort();
  const p999 = diffs[Math.floor(diffs.length * 0.999)] || 1e-12;
  return Math.abs(x[0] - x[n - 1]) / p999;
}

console.log('System 7 — offline generator analysis');
console.log(`  node ${process.version}   levels in dBFS   centroid in Hz`);

/* ── 0. The two copies of the distance law must agree ──────────────────── */

if (want('air')) {
  header('0. distance law');
  let worst = 0;
  for (const d of [0, 1, 5, 12, 26, 50, 100, 200, 400]) {
    worst = Math.max(worst, Math.abs(airCutoff(d) - airCutoffHz(d)));
  }
  check('air law agreement', worst < 1e-9,
    `dsp.airCutoff and design.airCutoffHz differ by up to ${worst} Hz`);
  console.log(`  cutoff at 1/12/26/60/150 m: ${[1, 12, 26, 60, 150].map((d) => Math.round(airCutoffHz(d))).join(' / ')} Hz`);
}

/* ── 1. Traffic bed ────────────────────────────────────────────────────── */

let bedLayers = null;
if (want('bed')) {
  header('1. traffic bed');
  // Through the same assembler the engine uses, so the bed this tool measures
  // and the bed the graph plays cannot drift apart. They did once, and the
  // result passed here and was inaudible there.
  bedLayers = BED_LAYERS.map((L) => trafficLayer({ sr: SR.bed, ...bedLayerOpts(L) }));

  bedLayers.forEach((x, i) => {
    const L = BED_LAYERS[i];
    const a = analyse(x, SR.bed);
    row(`layer ${i} (${L.lpHz} Hz)`, a, `below500 ${(a.fracBelow(500) * 100).toFixed(1)}%`);
    bandTable(`layer${i}`, a);
    notSilent(`bed.layer${i}`, a);
    inRange(`bed.layer${i}`, 'render level', a.rmsDb, BED.bufDb - 0.2, BED.bufDb + 0.2, ' dB');
    // A loop with a seam in it clicks once per period, which is the most
    // audible possible failure of a bed.
    const sr_ = seamRatio(x);
    check(`bed.layer${i} seam`, sr_ < 1.5,
      `the wrap jumps ${f1(sr_)} times further than the largest ordinary sample step; that is a click every ${L.seconds} s`);
  });

  /* The sum, as the graph will build it, over a walk and a half. Each layer is
   * resampled at its own playback rate and started at its own offset, which is
   * exactly what the three AudioBufferSourceNodes do. */
  const secs = 45;
  const sum = new Float32Array(SR.bed * secs);
  const rng = makeRng(0x1234);
  BED_LAYERS.forEach((L, i) => {
    const g = dbToLin(L.gainDb);
    const tmp = new Float32Array(sum.length);
    loopInto(tmp, bedLayers[i], L.rate, rng());
    for (let j = 0; j < sum.length; j++) sum[j] += tmp[j] * g;
  });

  const a = analyse(sum, SR.bed);
  const atListener = a.rmsDb + BED.busDb + MASTER.gainDb;
  row('sum at listener', { ...a, rmsDb: atListener, peakDb: a.peakDb + BED.busDb + MASTER.gainDb },
    `below500 ${(a.fracBelow(500) * 100).toFixed(1)}%`);
  bandTable('bed.sum', a);
  notSilent('bed.sum', a);
  inRange('bed', 'level at listener', atListener, BED.expectDb[0], BED.expectDb[1], ' dB');
  console.log(`      the bed sits at ${f1(atListener)} dBFS; every audibility check below is relative to it`);
  check('bed centroid', a.centroid <= BED.maxCentroidHz,
    `centroid ${Math.round(a.centroid)} Hz, wanted <= ${BED.maxCentroidHz} — not enough distance filtering`);
  check('bed low fraction', a.fracBelow(500) >= BED.minLowFraction,
    `${(a.fracBelow(500) * 100).toFixed(1)}% below 500 Hz, wanted >= ${BED.minLowFraction * 100}%`);
  /* And the check that was missing, which is the one that mattered.
   *
   * A bed that is 98% below 500 Hz passes every test above and is inaudible on
   * a phone speaker, because a phone speaker reproduces almost nothing below
   * 400 Hz. Both ends, from now on. */
  check('bed not all bottom', a.fracBelow(500) <= BED.maxLowFraction,
    `${(a.fracBelow(500) * 100).toFixed(1)}% below 500 Hz, wanted <= ${BED.maxLowFraction * 100}% — nothing here survives a small speaker`);
  check('bed high fraction', 1 - a.fracBelow(500) >= BED.minHighFraction,
    `only ${((1 - a.fracBelow(500)) * 100).toFixed(1)}% above 500 Hz, wanted >= ${BED.minHighFraction * 100}%`);

  /* Periodicity.
   *
   * The claim being tested is that three loops at incommensurate lengths and
   * off-unity rates do not produce an audible repeat inside a walk. The test
   * is an autocorrelation of the bed's *envelope* rather than of the waveform,
   * because what a listener recognises in a noise bed is the pattern of
   * swells, not the sample values. Anything over about 0.3 here would be
   * heard as a loop.
   */
  const envHz = 50;
  const envN = Math.floor(secs * envHz);
  const env = new Float64Array(envN);
  const per = Math.floor(SR.bed / envHz);
  for (let i = 0; i < envN; i++) {
    let s = 0;
    for (let j = 0; j < per; j++) s += sum[i * per + j] ** 2;
    env[i] = Math.sqrt(s / per);
  }
  let mean = 0;
  for (let i = 0; i < envN; i++) mean += env[i];
  mean /= envN;
  let den = 0;
  for (let i = 0; i < envN; i++) den += (env[i] - mean) ** 2;
  let worstLag = 0, worstR = 0;
  for (let lag = Math.floor(envHz * 1.0); lag < envN / 2; lag++) {
    let num = 0;
    for (let i = 0; i + lag < envN; i++) num += (env[i] - mean) * (env[i + lag] - mean);
    const r = num / den;
    if (r > worstR) { worstR = r; worstLag = lag / envHz; }
  }
  check('bed periodicity', worstR < 0.30,
    `envelope autocorrelation peaks at ${worstR.toFixed(2)} at a lag of ${worstLag.toFixed(1)} s — that will be heard as a loop`);
  console.log(`      strongest envelope repeat: r=${worstR.toFixed(2)} at ${worstLag.toFixed(1)} s (walk is 30 s)`);
}

/* ── 2. Pass-bys ───────────────────────────────────────────────────────── */

if (want('passby')) {
  header('2. pass-bys');
  PASSBY_LANES.forEach((lane, li) => {
    for (let k = 0; k < PASSBY.variants; k++) {
      const x = passByBuffer({
        sr: SR.passBy, seed: 0x1000 + li * 97 + k * 13, seconds: lane.seconds,
        closest: lane.closest, speed: lane.speed, engineHz: lane.engineHz * (0.88 + 0.22 * k),
        targetDb: BED.bufDb,
      });
      const a = analyse(x, SR.passBy);
      notSilent(`passby.${lane.name}.${k}`, a);

      /* The swell belongs to the panner, not to the buffer, so measuring the
       * buffer alone measures the wrong thing — the first version of this
       * check failed all six variants for having "only" 3.4 dB of swell when
       * the graph was about to add another eleven, and the fix was to take the
       * baked attenuation out and test the combination instead. So: walk the
       * panner along the lane, apply its inverse distance law sample by sample
       * and then the air filter, and measure what arrives at the ear. */
      const ear = walkAt((lane.from[2] + lane.to[2]) / 2);
      const along = (u) => [
        lane.from[0] + (lane.to[0] - lane.from[0]) * u,
        lane.from[1] + (lane.to[1] - lane.from[1]) * u,
        lane.from[2] + (lane.to[2] - lane.from[2]) * u,
      ];
      const dAt = (u) => dist3(along(u), ear);
      const y = Float32Array.from(x);
      for (let i = 0; i < y.length; i++) y[i] *= dbToLin(distanceDb(dAt(i / y.length)));
      let uMin = 0;
      for (let u = 0; u <= 1; u += 0.005) if (dAt(u) < dAt(uMin)) uMin = u;
      airFilter(y, SR.passBy, dAt(uMin), lane.occludeHz);

      const seg = (t0, t1) => rms(y.subarray(Math.floor(t0 * y.length), Math.floor(t1 * y.length)));
      const closeDb = linToDb(seg(Math.max(0, uMin - 0.05), Math.min(1, uMin + 0.05)));
      const swellDb = closeDb - linToDb(seg(0.0, 0.1));
      const wa = analyse(y, SR.passBy);
      const atListener = closeDb + lane.gainDb + MASTER.gainDb;
      row(`${lane.name}.${k}`, a,
        `closest ${Math.round(dAt(uMin))} m  swell +${f1(swellDb)} dB  peaks ${f1(atListener)} dBFS`);
      bandTable(`${lane.name}.${k}`, wa);
      check(`passby.${lane.name}.${k} swell`, swellDb > 7,
        `only ${f1(swellDb)} dB louder at closest approach than at the edges; it will read as a swell, not a car`);
      check(`passby.${lane.name}.${k} centroid`, wa.centroid <= PASSBY.maxCentroidHz,
        `centroid ${Math.round(wa.centroid)} Hz at the listener, wanted <= ${PASSBY.maxCentroidHz}`);
      check(`passby.${lane.name}.${k} audible`,
        atListener > BED_AT_LISTENER - 14 && atListener < BED_AT_LISTENER + 8,
        `peaks at ${f1(atListener)} dBFS against a bed at ${f1(BED_AT_LISTENER)}`);
    }
  });
}

/* ── 3. Horn ───────────────────────────────────────────────────────────── */

if (want('horn')) {
  header('3. horn');
  HORN_VOICES.forEach((v, i) => {
    const dry = hornBuffer({ sr: SR.horn, seed: v.seed, seconds: v.seconds, f1: v.f1, f2: v.f2, peakDb: PEAK_DB });
    const a = analyse(dry, SR.horn);
    row(`voice ${i} dry (${v.f1}/${v.f2})`, a, `peakHz ${Math.round(a.peakHz)}`);
    bandTable(`horn${i}.dry`, a);
    notSilent(`horn.${i}`, a);
    // The two diaphragms have to actually be there, and the strongest peak
    // should be one of the two fundamentals rather than some harmonic.
    const nearF = Math.min(Math.abs(a.peakHz - v.f1), Math.abs(a.peakHz - v.f2));
    check(`horn.${i} fundamental`, nearF < v.f1 * 0.06,
      `strongest partial at ${Math.round(a.peakHz)} Hz is not one of ${v.f1}/${v.f2}`);
    inRange(`horn.${i}`, 'dry centroid', a.centroid, 500, 3000, ' Hz');

    /* Now the distance, which is the entire realism argument: a far horn is a
     * dull horn. Filtered at the range of the spot it will actually play from
     * and checked for how much top survives. */
    for (const spot of HORN_SPOTS) {
      /* Judged at the closest the walker ever gets, not at mid-block. The
       * first version used mid-walk for all three and declared the horn behind
       * the player inaudible; it is twenty-six metres away at the start of the
       * walk, which is exactly where it is meant to be heard. */
      const d = nearestOnWalk(spot.pos);
      const wet = airFilter(Float32Array.from(dry), SR.horn, d, spot.occludeHz);
      const w = analyse(wet, SR.horn);
      const highFrac = 1 - w.fracBelow(2000);
      const atListener = w.peakDb + HORN.gainDb + distanceDb(d) + MASTER.gainDb;
      const limit = HORN.maxHighFraction[spot.name];
      if (i === 0) {
        row(`  at ${spot.name}`, { ...w, peakDb: atListener },
          `${Math.round(d)} m  fc ${Math.round(airCutoffHz(d))} Hz  >2k ${(highFrac * 100).toFixed(2)}%`);
      }
      check(`horn at ${spot.name} dulled`, highFrac <= limit,
        `${(highFrac * 100).toFixed(2)}% of power still above 2 kHz at ${Math.round(d)} m, wanted <= ${limit * 100}%`);
      check(`horn at ${spot.name} audible`, atListener > BED_AT_LISTENER - 12,
        `peaks at ${f1(atListener)} dBFS at its closest, against a bed at ${f1(BED_AT_LISTENER)} — it will not be heard`);
      check(`horn at ${spot.name} not close`, atListener < BED_AT_LISTENER + 10,
        `peaks at ${f1(atListener)} dBFS, which is a horn in this street rather than two streets away`);
    }

    /* The whole point of three spots is that they do not sound alike. The one
     * behind the terminating wall must be measurably duller than the one seen
     * straight down the gap in the frontage, or the occlusion filter is
     * decoration. */
    if (i === 0) {
      const hf = (spot) => 1 - analyse(
        airFilter(Float32Array.from(dry), SR.horn, nearestOnWalk(spot.pos), spot.occludeHz), SR.horn,
      ).fracBelow(2000);
      const occluded = hf(HORN_SPOTS[0]), clear = hf(HORN_SPOTS[1]);
      console.log(`      occluded spot keeps ${(occluded * 100).toFixed(2)}% above 2 kHz, the clear one ${(clear * 100).toFixed(2)}%`);
      check('horn occlusion differentiates', clear > occluded * 3,
        `${(occluded * 100).toFixed(2)}% against ${(clear * 100).toFixed(2)}% — not different enough to be worth modelling`);
    }
  });
}

/* ── 4. Footsteps ──────────────────────────────────────────────────────── */

if (want('steps')) {
  header('4. footsteps');
  const bank = [0, 1].map((foot) =>
    Array.from({ length: STEPS.bankPerFoot }, (_, k) => footstepBuffer({
      sr: SR.step, seed: 0x5000 + foot * 331 + k * 29, foot, peakDb: PEAK_DB,
    })));

  bank.forEach((bufs, foot) => {
    bufs.forEach((x, k) => {
      const a = analyse(x, SR.step);
      if (k === 0) row(`foot ${foot} bank 0`, a, `peakHz ${Math.round(a.peakHz)}`);
      notSilent(`step.${foot}.${k}`, a);
      inRange(`step.${foot}.${k}`, 'centroid', a.centroid, 600, 4200, ' Hz');
      check(`step.${foot}.${k} crest`, a.crestDb > 9,
        `crest ${f1(a.crestDb)} dB — a footstep with no transient is a thud`);
    });
  });

  /* The check that matters: twenty-four consecutive steps through the real
   * per-step randomisation must not be the same sound twenty-four times.
   * Identical footsteps are the single most recognisable tell in game audio,
   * and "I added variation" is a claim, not a measurement. */
  const rng = makeRng(0x9f2c);
  const cents = [], peaks = [];
  for (let s = 0; s < 24; s++) {
    const foot = s & 1;
    const v = stepVariation(rng, foot, 1.0);
    const src = bank[foot][v.bank];
    // Resample at the step's playback rate, then its own lowpass and gain.
    const n = Math.floor(src.length / v.rate);
    const y = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = i * v.rate, p0 = Math.floor(p), p1 = Math.min(src.length - 1, p0 + 1);
      y[i] = (src[p0] * (1 - (p - p0)) + src[p1] * (p - p0)) * dbToLin(v.gainDb);
    }
    biquadInPlace(y, lp(SR.step, v.lpHz, 0.8), 1);
    const a = analyse(y, SR.step);
    cents.push(a.centroid);
    peaks.push(a.peakDb);
  }
  const mean = cents.reduce((p, c) => p + c, 0) / cents.length;
  const sd = Math.sqrt(cents.reduce((p, c) => p + (c - mean) ** 2, 0) / cents.length);
  const spreadPct = (sd / mean) * 100;
  const peakSpread = Math.max(...peaks) - Math.min(...peaks);
  console.log(`      24 steps: centroid ${Math.round(mean)} Hz +/- ${spreadPct.toFixed(1)}%, peak spread ${f1(peakSpread)} dB`);
  check('step variation, timbre', spreadPct >= STEPS.minCentroidSpreadPct,
    `centroid varies by only ${spreadPct.toFixed(1)}%, wanted >= ${STEPS.minCentroidSpreadPct}% — the steps will sound identical`);
  check('step variation, level', peakSpread >= STEPS.minPeakSpreadDb,
    `peak spread only ${f1(peakSpread)} dB, wanted >= ${STEPS.minPeakSpreadDb}`);
  // And no two consecutive steps may be the same buffer at the same rate.
  check('step variation, no repeats', new Set(cents.map((c) => Math.round(c))).size > 18,
    `only ${new Set(cents.map((c) => Math.round(c))).size} distinct step timbres in 24 steps`);
}

/* ── 5. AC ─────────────────────────────────────────────────────────────── */

if (want('ac')) {
  header('5. air conditioning');
  const bufs = AC_BUFFERS.map((cfg) => acLoopBuffer({
    sr: SR.ac, seed: cfg.seed, seconds: cfg.seconds, humHz: cfg.humHz,
    bladeHz: cfg.bladeHz, targetDb: BED.bufDb,
  }));

  bufs.forEach((x, i) => {
    const cfg = AC_BUFFERS[i];
    const a = analyse(x, SR.ac);
    row(`unit buffer ${i}`, a, `peakHz ${Math.round(a.peakHz)} (hum ${cfg.humHz})`);
    bandTable(`ac${i}`, a);
    notSilent(`ac.${i}`, a);
    inRange(`ac.${i}`, 'centroid', a.centroid, AC.centroidHz[0], AC.centroidHz[1], ' Hz');
    /* A condenser without a tonal hum is a fan. The strongest partial has to
     * be at the hum fundamental or one of its first harmonics. */
    const ratio = a.peakHz / cfg.humHz;
    check(`ac.${i} tonal`, Math.abs(ratio - Math.round(ratio)) < 0.06 && Math.round(ratio) <= 4,
      `strongest partial at ${Math.round(a.peakHz)} Hz is not a harmonic of the ${cfg.humHz} Hz hum`);
    // Seamless loop: this one runs for the whole walk, so the wrap must be
    // clean or there is a click every five seconds for thirty seconds.
    const sr_ = seamRatio(x);
    check(`ac.${i} seam`, sr_ < 1.5,
      `the wrap jumps ${f1(sr_)} times further than the largest ordinary sample step`);
  });

  const rat = Array.from({ length: AC.rattleVariants }, (_, k) => rattleBuffer(SR.rattle, 0x2200 + k * 41, PEAK_DB));
  const rc = rat.map((x) => analyse(x, SR.rattle));
  row('rattle bank', rc[0], `${AC.rattleVariants} variants, centroids ${rc.map((a) => Math.round(a.centroid)).join('/')}`);
  rc.forEach((a, k) => {
    notSilent(`rattle.${k}`, a);
    check(`rattle.${k} sharp`, a.crestDb > 9, `crest ${f1(a.crestDb)} dB — a rattle has to be a transient`);
    inRange(`rattle.${k}`, 'centroid', a.centroid, 500, 5000, ' Hz');
  });

  // Predicted level of each installed unit, from where the walker passes it.
  for (const u of AC_UNITS) {
    const d = Math.hypot(u.pos[0] - midWalk[0], u.pos[1] - midWalk[1], 0);   // as the walker draws level
    const x = airFilter(Float32Array.from(bufs[u.buf]), SR.ac, d);
    const a = analyse(x, SR.ac);
    const atListener = a.rmsDb + u.gainDb + distanceDb(d) + AC.busDb + MASTER.gainDb;
    const rel = atListener - BED_AT_LISTENER;
    console.log(`      ${pad(u.name, 8)} abeam at ${f1(d)} m: fc ${Math.round(airCutoffHz(d))} Hz, ${f1(atListener)} dBFS (${rel > 0 ? '+' : ''}${f1(rel)} vs bed)`);
    /* The window is narrow on purpose. A wall unit you cannot hear as you pass
     * under it is not modelled, and one you can hear from the far end of the
     * block is a jet engine bolted to a shop. */
    check(`${u.name} audible abeam`, rel > -14,
      `${f1(rel)} dB relative to the bed as the walker draws level; it will vanish`);
    check(`${u.name} not dominant`, rel < 0,
      `${f1(rel)} dB relative to the bed — louder than the traffic, which no wall unit is`);
  }
}

/* ── 6. The bar ────────────────────────────────────────────────────────── */

if (want('bar')) {
  header('6. bar, through the wall');
  const kick = Array.from({ length: 3 }, (_, k) => kickBuffer(SR.bar, 0x3300 + k * 17, PEAK_DB));
  const body = Array.from({ length: 3 }, (_, k) => barBodyHit(SR.bar, 0x4900 + k * 19, PEAK_DB));
  const bass = new Map(BAR.notes.map((hz, i) => [hz, barBassNote(SR.bar, 0x4400 + i * 23, hz, 0.55, BED.bufDb)]));

  notSilent('bar.kick', analyse(kick[0], SR.bar));
  notSilent('bar.body', analyse(body[0], SR.bar));
  notSilent('bar.bass', analyse(bass.get(BAR.notes[0]), SR.bar));
  const ka = analyse(kick[0], SR.bar);
  row('kick, dry', ka, `peakHz ${Math.round(ka.peakHz)}`);
  check('bar.kick pitch', ka.peakHz > 35 && ka.peakHz < 95,
    `kick fundamental settles at ${Math.round(ka.peakHz)} Hz`);

  /* Sixteen bars of the real pattern, rendered dry, then pushed through the
   * wall. Using barPattern rather than a hand-written approximation is the
   * point: if the sequencer changes, this measures the change. */
  const beat = 60 / BAR.bpm;
  const barLen = beat * 4;
  const nBars = BAR.patternBars;
  const rng = makeRng(0x77aa);
  const dry = new Float32Array(Math.ceil(SR.bar * (nBars * barLen + 1)));
  let events = 0;
  for (let b = 0; b < nBars; b++) {
    for (const e of barPattern(rng, b, BAR.notes, beat, BAR.swingJitter)) {
      const src = e.kind === 'kick' ? kick[b % 3] : e.kind === 'body' ? body[b % 3] : bass.get(e.note);
      if (!src) continue;
      mixAt(dry, src, SR.bar, b * barLen + e.t, dbToLin(e.gainDb), e.rate);
      events++;
    }
  }
  const dryA = analyse(dry, SR.bar);
  row('16 bars, dry', dryA, `${events} hits, ${(nBars * barLen).toFixed(1)} s`);
  bandTable('bar.dry', dryA);

  /* The wall, exactly as the graph builds it: make-up gain, then a highpass,
   * the partition resonance, two lowpass poles, and in parallel the gap under
   * the door. */
  const through = (x, makeupDb = BAR.wallMakeupDb) => {
    const main = Float32Array.from(x);
    if (makeupDb !== 0) for (let i = 0; i < main.length; i++) main[i] *= dbToLin(makeupDb);
    const leak = Float32Array.from(main);
    biquadInPlace(main, hp(SR.bar, BAR.wallHpHz, 0.7), 1);
    biquadInPlace(main, peaking(SR.bar, BAR.wallResHz, BAR.wallResQ, BAR.wallResDb), 1);
    biquadInPlace(main, lp(SR.bar, BAR.wallLpHz, Math.SQRT1_2), BAR.wallLpPoles);
    biquadInPlace(leak, bp(SR.bar, BAR.leakHz, BAR.leakQ), 1);
    const g = dbToLin(BAR.leakDb);
    for (let i = 0; i < main.length; i++) main[i] += leak[i] * g;
    return main;
  };

  const d = nearestOnWalk(BAR.pos);
  const wet = through(dry);
  const insertion = analyse(wet, SR.bar).rmsDb - dryA.rmsDb;
  airFilter(wet, SR.bar, d);
  const wetA = analyse(wet, SR.bar);
  const highFrac = 1 - wetA.fracBelow(500);
  const atListener = wetA.rmsDb + BAR.busDb + distanceDb(d) + MASTER.gainDb;
  row('through the wall', { ...wetA, rmsDb: atListener }, `>500 ${(highFrac * 100).toFixed(3)}%  ${f1(d)} m`);
  bandTable('bar.wet', wetA);

  notSilent('bar.wet', wetA);
  check('bar centroid', wetA.centroid <= BAR.maxCentroidHz,
    `centroid ${Math.round(wetA.centroid)} Hz, wanted <= ${BAR.maxCentroidHz} — too much of the track is getting out`);
  check('bar wall rejection', highFrac <= BAR.maxHighFraction,
    `${(highFrac * 100).toFixed(3)}% of power above 500 Hz, wanted <= ${BAR.maxHighFraction * 100}%`);

  /* Transmission loss, in absolute band power rather than as a ratio of two
   * normalised fractions, and measured on the wall alone with the make-up
   * taken out. The first version of the wall measured eighty-two dB, which is
   * not a wall, it is a vault: nothing whatever above 500 Hz and no sense of a
   * room on the other side. The gap under the door is what brings it back into
   * the range a building surveyor would recognise. */
  const tl = 10 * Math.log10(powerAbove(dry, SR.bar, 500) / Math.max(1e-30, powerAbove(through(dry, 0), SR.bar, 500)));
  console.log(`      transmission loss above 500 Hz: ${f1(tl)} dB   overall insertion loss: ${f1(-insertion)} dB`);
  inRange('bar', 'transmission loss', tl, BAR.tlDb[0], BAR.tlDb[1], ' dB');
  /* The wall must not change the *level* much, only the content. That is the
   * counter-intuitive part and it is worth pinning down: everything in this
   * mix is already below 205 Hz, so a lowpass at 205 Hz has almost nothing to
   * take out of it. A large insertion loss here would mean the filter is
   * eating the bass, which is the one thing that is supposed to get through. */
  inRange('bar', 'wall insertion loss', -insertion, -6, 8, ' dB');
  check('bar rhythm survives', wetA.crestDb > 8,
    `crest ${f1(wetA.crestDb)} dB — the kick pattern has been squashed into a drone`);
  const rel = atListener - BED_AT_LISTENER;
  console.log(`      outside the door at ${f1(d)} m: ${f1(atListener)} dBFS, ${rel > 0 ? '+' : ''}${f1(rel)} dB against the bed`);
  check('bar audible', rel > -14, `${f1(rel)} dB against the bed at its closest; nobody will hear it`);
  check('bar not dominant', rel < 2, `${f1(rel)} dB against the bed — that is a bar with the door open`);
}

/* ── 7. Neon ───────────────────────────────────────────────────────────── */

if (want('neon')) {
  header('7. neon');
  const x = neonBuffer(SR.neon, NEON.seed, NEON.seconds, BED.bufDb);
  const a = analyse(x, SR.neon);
  const d = nearestOnWalk(NEON.pos);
  const wet = airFilter(Float32Array.from(x), SR.neon, d);
  const atListener = analyse(wet, SR.neon).rmsDb + NEON.busDb + distanceDb(d) + MASTER.gainDb;
  const rel = atListener - BED_AT_LISTENER;
  row('ballast + tube', a, `peakHz ${Math.round(a.peakHz)}  at ${f1(d)} m ${f1(atListener)} dBFS`);
  bandTable('neon', a);
  notSilent('neon', a);
  check('neon centroid', a.centroid >= NEON.minCentroidHz,
    `centroid ${Math.round(a.centroid)} Hz, wanted >= ${NEON.minCentroidHz} — a ballast buzz is bright, not a hum`);
  check('neon mains harmonic', Math.abs(a.peakHz % 120) < 8 || Math.abs((a.peakHz % 120) - 120) < 8,
    `strongest partial at ${Math.round(a.peakHz)} Hz is not a multiple of 120`);
  /* Deliberately nearly inaudible: golden hour, not eleven at night, and there
   * is a street full of traffic on top of it. If this ever creeps up to within
   * twelve dB of the bed the scene has quietly become a night scene again. */
  check('neon subordinate', rel < -NEON.minBelowBedDb,
    `${f1(rel)} dB against the bed even at its closest approach of ${f1(d)} m; that is the 11 pm mix`);
  console.log(`      closest approach ${f1(d)} m, ${f1(rel)} dB under the bed — findable, never prominent`);
}

/* ── 8. The canyon ─────────────────────────────────────────────────────── */

if (want('ir')) {
  header('8. canyon impulse response');
  const { left, right } = streetIR({
    sr: SR.ir, seed: IR.seed, nearWall: IR.nearWall, farWall: IR.farWall,
    width: IR.width, eyeHeight: IR.eyeHeight, seconds: IR.seconds,
    rtLow: IR.rtLow, rtMid: IR.rtMid, rtHigh: IR.rtHigh, energyDb: IR.energyDb,
  });
  const la = analyse(left, SR.ir);
  row('IR left', la, `${(left.length / SR.ir).toFixed(2)} s`);
  bandTable('ir.left', la);
  notSilent('ir.left', la);
  notSilent('ir.right', analyse(right, SR.ir));

  /* The early reflections carry the width of the street, so check they are
   * where the geometry says they should be. A tap in the wrong place is a
   * street of the wrong width, and it is audible long before the tail is. */
  const C = 343;
  const expectMs = [
    ['ground', (2 * IR.eyeHeight * 1000) / C],
    ['near wall', (2 * IR.nearWall * 1000) / C],
    ['far wall', (2 * IR.farWall * 1000) / C],
    ['flutter 1', ((2 * IR.nearWall + 2 * IR.width) * 1000) / C],
  ];
  for (const [name, ms] of expectMs) {
    const i = Math.round((ms / 1000) * SR.ir);
    // Local prominence: the tap against the diffuse floor either side of it.
    const near = Math.max(Math.abs(left[i]), Math.abs(left[i + 1]), Math.abs(left[i - 1]));
    let floor = 0, cnt = 0;
    for (let k = i + 12; k < i + 90 && k < left.length; k++) { floor += Math.abs(left[k]); cnt++; }
    floor /= Math.max(1, cnt);
    const prom = linToDb(near / Math.max(1e-9, floor));
    console.log(`      tap ${pad(name, 10)} at ${ms.toFixed(1).padStart(5)} ms  ${f1(prom).padStart(5)} dB above the diffuse floor`);
    check(`IR tap ${name}`, prom > 6,
      `only ${f1(prom)} dB of prominence at ${ms.toFixed(1)} ms; the street's width will not be audible`);
  }

  /**
   * RT60 by Schroeder backward integration, fitted over the T20 range.
   *
   * Fitting -5 to -25 dB and extrapolating is the standard method and it is
   * the right one here because the first few milliseconds are discrete
   * reflections rather than a decaying field, and including them biases the
   * slope.
   */
  const rt60 = (x, sr) => {
    let e = 0;
    const sch = new Float64Array(x.length);
    for (let i = x.length - 1; i >= 0; i--) { e += x[i] * x[i]; sch[i] = e; }
    const ref = sch[0];
    if (ref <= 0) return NaN;
    let i5 = -1, i25 = -1;
    for (let i = 0; i < x.length; i++) {
      const db = 10 * Math.log10(sch[i] / ref);
      if (i5 < 0 && db <= -5) i5 = i;
      if (i25 < 0 && db <= -25) { i25 = i; break; }
    }
    if (i5 < 0 || i25 < 0 || i25 <= i5) return NaN;
    return ((i25 - i5) / sr) * 3;
  };

  const bands = [['low', 125, IR.rtLow], ['mid', 1000, IR.rtMid], ['high', 4000, IR.rtHigh]];
  for (const [name, fc, wantRt] of bands) {
    const b = Float32Array.from(left);
    biquadInPlace(b, bp(SR.ir, fc, 1.4), 2);
    const got = rt60(b, SR.ir);
    console.log(`      RT60 ${pad(name, 5)} at ${padL(fc, 5)} Hz: ${f1(got)} s   designed ${wantRt} s`);
    check(`IR RT60 ${name}`, Number.isFinite(got) && Math.abs(got - wantRt) <= IR.rtTolerance,
      `measured ${f1(got)} s against a design of ${wantRt} s (tolerance ${IR.rtTolerance})`);
  }
  /* High frequencies must die faster than low ones. This is the difference
   * between a street and a plate reverb and it is worth its own check. */
  const rtOf = (fc) => { const b = Float32Array.from(left); biquadInPlace(b, bp(SR.ir, fc, 1.4), 2); return rt60(b, SR.ir); };
  check('IR spectral decay tilt', rtOf(125) > rtOf(4000) * 1.6,
    'the top of the tail is not decaying faster than the bottom; that is a plate, not a canyon');

  // Stereo: two channels that are the same are not a stereo reverb.
  let num = 0, dl = 0, dr = 0;
  for (let i = 0; i < left.length; i++) { num += left[i] * right[i]; dl += left[i] ** 2; dr += right[i] ** 2; }
  const corr = num / Math.sqrt(dl * dr);
  console.log(`      inter-channel correlation ${corr.toFixed(3)} (want well under 0.5 for a wide field)`);
  check('IR decorrelated', Math.abs(corr) < 0.5, `channels correlate at ${corr.toFixed(3)}`);
}

/* ── 9. The mix as a whole ─────────────────────────────────────────────── */

if (want('mix') && !ONLY) {
  header('9. gain structure');
  const rows = [
    ['bed', 'rms', BED.bufDb, BED.busDb, 0, SENDS.bed],
    ['ac', 'rms', BED.bufDb, AC.busDb + AC_UNITS[1].gainDb, distanceDb(6), SENDS.ac],
    ['bar', 'rms', BED.bufDb, BAR.busDb + BAR.wallMakeupDb, distanceDb(nearestOnWalk(BAR.pos)), SENDS.bar],
    ['steps', 'peak', PEAK_DB, STEPS.busDb, 0, SENDS.steps],
    ['horn', 'peak', PEAK_DB, HORN.gainDb, distanceDb(nearestOnWalk(HORN_SPOTS[1].pos)), SENDS.events],
    ['passby', 'rms', BED.bufDb, PASSBY_LANES[0].gainDb, distanceDb(10), SENDS.events],
    ['neon', 'rms', BED.bufDb, NEON.busDb, distanceDb(nearestOnWalk(NEON.pos)), SENDS.neon],
  ];
  for (const [name, kind, buf, bus, dist, send] of rows) {
    const at = buf + bus + dist + MASTER.gainDb;
    console.log(
      `  ${pad(name, 7)} ${pad(kind, 5)} buffer ${padL(f1(buf), 6)} + gains ${padL(f1(bus), 6)} + distance ${padL(f1(dist), 6)} ` +
      `+ master ${padL(f1(MASTER.gainDb), 5)} = ${padL(f1(at), 7)} dBFS   send ${Number.isFinite(send) ? f1(send) : 'none'}`);
    check(`${name} gain set`, Number.isFinite(bus) && bus > -60, `the gain chain is ${bus} dB, which is silence`);
  }
  console.log(`  the bed sits at ${f1(BED_AT_LISTENER)} dBFS; everything above is measured against that`);
  /* The limiter is insurance, not a mix tool. If its threshold sits near the
   * bed it will duck the whole street every time a horn lands, which is a very
   * recognisable and very wrong pumping. */
  check('limiter headroom', MASTER.limiter.thresholdDb > BED_AT_LISTENER + 6,
    `the threshold at ${MASTER.limiter.thresholdDb} is too close to the bed at ${f1(BED_AT_LISTENER)}; it will pump on the bed itself`);
}

/* ── Result ────────────────────────────────────────────────────────────── */

console.log(`\n${pass} passed, ${fail} failed`);
for (const f of failures) console.log(`  FAIL  ${f}`);
process.exit(fail ? 1 : 0);
