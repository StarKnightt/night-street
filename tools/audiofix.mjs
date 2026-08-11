/* The master stage: tilt, bass mono, limit, normalise. Offline.
 *
 *   node tools/audiofix.mjs <in> <out.wav> [--tilt 12] [--low -6]
 *                           [--lufs -14] [--tp -3] [--report]
 *
 * This is deliberately a *separate* pass over a finished take rather than a
 * change to the graph, because it is the version that can be produced and
 * checked in one minute when the deadline is in three hours. The same shelves
 * exist in the engine (see MASTER.tilt in src/audio/design.ts) so that the
 * interactive page sounds like the file; this tool is what turns a recording
 * into a delivery — the loudness normalisation and the true-peak ceiling,
 * neither of which a real-time graph can do because both need to see the
 * whole take before deciding a gain.
 *
 * Three things happen, in this order and for these reasons.
 *
 * The tilt. A high shelf at 500 Hz and a low shelf at 100 Hz. The street's
 * energy was 95% below 160 Hz, which is inaudible on a phone speaker — the
 * shelves do not invent content, they raise the content that was already
 * there (footstep transients, the horn, the door leak, the top of the AC) to
 * where a small speaker can reproduce it.
 *
 * The bass mono-maker. The recording's channels were independent noise at
 * every frequency, including 40-80 Hz where a wavelength is four to eight
 * metres and no real pair of ears could hear a difference. That is a
 * synthesis artefact and it is also a mono-compatibility hazard, so
 * everything below the crossover is summed. Complementary rather than a
 * crossover pair: the high path is the signal minus the low path, so the sum
 * reconstructs exactly and there is no phase notch at the corner.
 *
 * The limiter and the normalise. Loudness to -14 LUFS integrated, ceiling at
 * -3 dBTP measured on a 4x oversampled signal, which is what a platform
 * transcode will see. The delivered take was at -1.5 and would have clipped.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const SR = 48000;
const args = process.argv.slice(2);
const pos = args.filter((a) => !a.startsWith('--'));
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const has = (k) => args.includes('--' + k);

/* ── Biquads, RBJ cookbook ──────────────────────────────────────────────── */

function highShelf(f0, gainDb, S = 0.9) {
  const A = Math.pow(10, gainDb / 40);
  const w = (2 * Math.PI * f0) / SR;
  const cw = Math.cos(w), sw = Math.sin(w);
  const al = (sw / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
  const t = 2 * Math.sqrt(A) * al;
  return norm([
    A * (A + 1 + (A - 1) * cw + t),
    -2 * A * (A - 1 + (A + 1) * cw),
    A * (A + 1 + (A - 1) * cw - t),
    A + 1 - (A - 1) * cw + t,
    2 * (A - 1 - (A + 1) * cw),
    A + 1 - (A - 1) * cw - t,
  ]);
}

function lowShelf(f0, gainDb, S = 0.9) {
  const A = Math.pow(10, gainDb / 40);
  const w = (2 * Math.PI * f0) / SR;
  const cw = Math.cos(w), sw = Math.sin(w);
  const al = (sw / 2) * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
  const t = 2 * Math.sqrt(A) * al;
  return norm([
    A * (A + 1 - (A - 1) * cw + t),
    2 * A * (A - 1 - (A + 1) * cw),
    A * (A + 1 - (A - 1) * cw - t),
    A + 1 + (A - 1) * cw + t,
    -2 * (A - 1 + (A + 1) * cw),
    A + 1 + (A - 1) * cw - t,
  ]);
}

function lowpass(f0, Q = Math.SQRT1_2) {
  const w = (2 * Math.PI * f0) / SR;
  const cw = Math.cos(w), sw = Math.sin(w);
  const al = sw / (2 * Q);
  return norm([(1 - cw) / 2, 1 - cw, (1 - cw) / 2, 1 + al, -2 * cw, 1 - al]);
}

function highpass(f0, Q = Math.SQRT1_2) {
  const w = (2 * Math.PI * f0) / SR;
  const cw = Math.cos(w), sw = Math.sin(w);
  const al = sw / (2 * Q);
  return norm([(1 + cw) / 2, -(1 + cw), (1 + cw) / 2, 1 + al, -2 * cw, 1 - al]);
}

function norm([b0, b1, b2, a0, a1, a2]) {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

function biquad(x, c) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

/* ── True peak, by 4x oversampling ──────────────────────────────────────── */

/** Windowed-sinc upsampler, 4x, 32 taps a phase. Enough to land within about
 *  0.05 dB of a compliant ITU-R BS.1770 true-peak meter, which is checked
 *  against ffmpeg's ebur128 at the end of every run. */
function truePeak(chs) {
  const L = 32, U = 4;
  const taps = [];
  for (let p = 0; p < U; p++) {
    const t = new Float64Array(L);
    for (let k = 0; k < L; k++) {
      const x = k - L / 2 + 1 - p / U;
      const s = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      t[k] = s * (0.54 - 0.46 * Math.cos((2 * Math.PI * (k + 0.5)) / L));
    }
    // Unity DC gain per phase, or the estimate is a constant few tenths of a
    // dB out and the ceiling lands somewhere other than where it was asked to.
    let sum = 0;
    for (let k = 0; k < L; k++) sum += t[k];
    for (let k = 0; k < L; k++) t[k] /= sum;
    taps.push(t);
  }
  let peak = 0;
  for (const x of chs) {
    for (let i = L; i < x.length - L; i++) {
      for (let p = 0; p < U; p++) {
        let s = 0;
        const t = taps[p];
        for (let k = 0; k < L; k++) s += x[i - L / 2 + k] * t[k];
        if (Math.abs(s) > peak) peak = Math.abs(s);
      }
    }
  }
  return peak;
}

/* ── Limiter ────────────────────────────────────────────────────────────── */

/**
 * Lookahead peak limiter. 2 ms of lookahead, so the gain is already down when
 * the transient arrives rather than a millisecond after it, which on footsteps
 * is the difference between a limiter and a click.
 */
function limit(L, R, ceiling) {
  const look = Math.round(0.002 * SR);
  const rel = Math.exp(-1 / (0.12 * SR));
  const n = L.length;
  const env = new Float32Array(n);
  let e = 0;
  for (let i = n - 1; i >= 0; i--) {                 // reverse pass = lookahead
    const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    e = Math.max(a, e * 0.9995);
    env[i] = e;
  }
  const g = new Float32Array(n);
  let gs = 1;
  for (let i = 0; i < n; i++) {
    const j = Math.min(n - 1, i + look);
    const want = env[j] > ceiling ? ceiling / env[j] : 1;
    gs = want < gs ? want : want + (gs - want) * rel;
    g[i] = gs;
  }
  let reduced = 0, worst = 1, sum = 0;
  for (let i = 0; i < n; i++) {
    if (g[i] < 0.999) { reduced++; sum += -20 * Math.log10(g[i]); }
    if (g[i] < worst) worst = g[i];
    L[i] *= g[i]; R[i] *= g[i];
  }
  return {
    fraction: reduced / n,
    maxDb: +(-20 * Math.log10(worst)).toFixed(2),
    meanDb: +(sum / Math.max(1, reduced)).toFixed(2),
  };
}

/* ── I/O ────────────────────────────────────────────────────────────────── */

function decode(file) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-ac', '2', '-ar', String(SR), '-f', 'f32le', '-'],
    { maxBuffer: 1 << 30 });
  const n = Math.floor(raw.length / 8);
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = raw.readFloatLE(8 * i); R[i] = raw.readFloatLE(8 * i + 4); }
  return { L, R, n };
}

function writeWav(file, L, R) {
  const n = L.length;
  const buf = Buffer.alloc(8 * n);
  for (let i = 0; i < n; i++) { buf.writeFloatLE(L[i], 8 * i); buf.writeFloatLE(R[i], 8 * i + 4); }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(SR), '-ac', '2',
    '-i', 'pipe:0', '-c:a', 'pcm_s24le', file], { input: buf, maxBuffer: 1 << 30 });
}

function lufsOf(file) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file,
    '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const s = String(r.stderr || '');
  const tail = s.slice(s.lastIndexOf('Summary'));
  const pick = (k) => { const m = tail.match(new RegExp('\\n\\s*' + k + ':\\s*(-?[\\d.]+|-inf)')); return m ? parseFloat(m[1]) : NaN; };
  return { lufs: pick('I'), tp: pick('Peak') };
}

/* ── The chain ──────────────────────────────────────────────────────────── */

export function master(inFile, outFile, opts = {}) {
  const tiltDb = opts.tiltDb ?? 12;
  const tiltHz = opts.tiltHz ?? 500;
  const lowDb = opts.lowDb ?? -6;
  const lowHz = opts.lowHz ?? 100;
  const monoHz = opts.monoHz ?? 220;
  const targetLufs = opts.lufs ?? -14;
  const ceilingDb = opts.tp ?? -3;

  const { L, R, n } = decode(inFile);

  // 1. Tilt.
  const hs = highShelf(tiltHz, tiltDb);
  const ls = lowShelf(lowHz, lowDb);
  let l = biquad(biquad(L, hs), ls);
  let r = biquad(biquad(R, hs), ls);

  /* 2. Bass mono, over a fourth-order Linkwitz-Riley crossover.
   *
   * Not `x - lowpass(x)`, which is the tempting one-liner and which measured,
   * on the first version of this tool, as doing almost nothing above 60 Hz: a
   * second-order section is a quarter-cycle out at its own corner, so the
   * difference signal there comes back 1.7 dB up instead of gone. Two matched
   * LR4 legs sum to an all-pass and actually split the bands. */
  const lp = lowpass(monoHz), hp = highpass(monoHz);
  const lLo = biquad(biquad(l, lp), lp), rLo = biquad(biquad(r, lp), lp);
  const lHi = biquad(biquad(l, hp), hp), rHi = biquad(biquad(r, hp), hp);
  for (let i = 0; i < n; i++) {
    const m = 0.5 * (lLo[i] + rLo[i]);
    l[i] = lHi[i] + m;
    r[i] = rHi[i] + m;
  }

  // 3. Gain to the loudness target, measured rather than guessed. K-weighting
  //    is close enough to flat above 500 Hz that the tilt moves LUFS by an
  //    amount there is no point predicting: write, measure, correct, write.
  const tmp = path.join(path.dirname(outFile), '.audiofix-probe.wav');
  writeWav(tmp, l, r);
  const before = lufsOf(tmp);
  let gain = Math.pow(10, (targetLufs - before.lufs) / 20);
  for (let i = 0; i < n; i++) { l[i] *= gain; r[i] *= gain; }

  // 4. Ceiling. The limiter only engages on what is over it, and how much of
  //    the take that is gets reported, because a limiter working on 30% of a
  //    thirty-second walk is a mix problem and not a mastering one.
  const ceiling = Math.pow(10, ceilingDb / 20);
  const tpBefore = truePeak([l, r]);
  const worked = tpBefore > ceiling
    ? limit(l, r, ceiling * 0.995)
    : { fraction: 0, maxDb: 0, meanDb: 0 };

  writeWav(outFile, l, r);
  fs.rmSync(tmp, { force: true });

  /* Trust ffmpeg's meter over this file's, and trim if they disagree. The
   * oversampler above is 32 taps and honest about it; a tenth of a dB over
   * the ceiling is not a delivery. */
  let after = lufsOf(outFile);
  for (let i = 0; i < 3 && after.tp > ceilingDb; i++) {
    const trim = Math.pow(10, (ceilingDb - 0.05 - after.tp) / 20);
    for (let k = 0; k < n; k++) { l[k] *= trim; r[k] *= trim; }
    gain *= trim;
    writeWav(outFile, l, r);
    after = lufsOf(outFile);
  }

  return {
    inFile, outFile, seconds: +(n / SR).toFixed(2),
    tiltDb, tiltHz, lowDb, lowHz, monoHz,
    gainDb: +(20 * Math.log10(gain)).toFixed(2),
    tpBeforeLimitDb: +(20 * Math.log10(tpBefore)).toFixed(2),
    limitedFraction: +(100 * worked.fraction).toFixed(2),
    limitMaxDb: worked.maxDb, limitMeanDb: worked.meanDb,
    lufs: after.lufs, truePeakDb: after.tp,
  };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  if (pos.length < 2) { console.error('usage: node tools/audiofix.mjs <in> <out.wav> [--tilt 12] [--low -6] [--lufs -14] [--tp -3]'); process.exit(1); }
  const rep = master(pos[0], pos[1], {
    tiltDb: +flag('tilt', 12), tiltHz: +flag('tilthz', 500),
    lowDb: +flag('low', -6), lowHz: +flag('lowhz', 100),
    monoHz: +flag('monohz', 220),
    lufs: +flag('lufs', -14), tp: +flag('tp', -3),
  });
  console.log(`\n  ${path.relative(process.cwd(), rep.inFile)} -> ${path.relative(process.cwd(), rep.outFile)}   ${rep.seconds}s`);
  console.log(`    tilt        +${rep.tiltDb} dB above ${rep.tiltHz} Hz, ${rep.lowDb} dB below ${rep.lowHz} Hz`);
  console.log(`    bass mono   below ${rep.monoHz} Hz`);
  console.log(`    make-up     ${rep.gainDb >= 0 ? '+' : ''}${rep.gainDb} dB`);
  console.log(`    limiter     true peak was ${rep.tpBeforeLimitDb} dBTP, engaged on ${rep.limitedFraction}% of samples, ${rep.limitMeanDb} dB mean / ${rep.limitMaxDb} dB worst`);
  console.log(`    delivered   ${rep.lufs} LUFS, ${rep.truePeakDb} dBTP`);
  if (has('report')) console.log(JSON.stringify(rep, null, 2));
  console.log('');
}
