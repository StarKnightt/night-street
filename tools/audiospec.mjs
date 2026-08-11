/* What the mix actually is, in the numbers that decide whether it is audible.
 *
 *   node tools/audiospec.mjs <file> [<file> ...] [--phone]
 *
 * Every other audio tool in this project checks a generator. `tools/audio.mjs`
 * renders the DSP functions and measures them, and it passed for weeks while
 * the graph they were loaded into threw on its first line and the street was
 * silent on every machine. So this one refuses to look at source at all: it
 * takes a delivered file, decodes it, and reports what a listener gets.
 *
 * The measurements are the ones that caught the second failure, which was
 * subtler than silence. The track was there, it was in step with the picture,
 * and 95% of its energy was below 160 Hz — so on a phone speaker, which
 * reproduces almost nothing under 400 Hz, it was still effectively silent.
 * Full-band RMS cannot see that. What sees it is `hi500`, the band above
 * 500 Hz measured on its own, and the phone simulation at the bottom, which
 * is the same file through a 4th-order 500 Hz highpass: whatever is left is
 * the whole of what most of the audience will hear.
 *
 * LUFS and true peak come from ffmpeg's ebur128 rather than from here, because
 * a K-weighted gated integration re-implemented at four in the morning is a
 * worse number than one from a reference implementation.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
if (files.length === 0) {
  console.error('usage: node tools/audiospec.mjs <file> [...] ');
  process.exit(1);
}

const SR = 48000;

/** Decode anything ffmpeg can read to interleaved float32 stereo at 48 kHz. */
export function decode(file, extraFilters = []) {
  const af = extraFilters.length ? ['-af', extraFilters.join(',')] : [];
  const raw = execFileSync('ffmpeg', [
    '-v', 'error', '-i', file, ...af,
    '-ac', '2', '-ar', String(SR), '-f', 'f32le', '-',
  ], { maxBuffer: 1 << 30 });
  const n = Math.floor(raw.length / 8);
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = raw.readFloatLE(8 * i);
    R[i] = raw.readFloatLE(8 * i + 4);
  }
  return { L, R, n };
}

const db = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(1) : '  -inf');

function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
}

/* ── FFT, iterative radix-2 ─────────────────────────────────────────────── */

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
 * Welch power spectrum, in absolute units: the sum over all bins equals the
 * mean square of the signal, so a band's share of the total is a genuine
 * energy fraction and `10*log10(sum)` over a band is that band's dBFS RMS.
 */
export function spectrum(x, nfft = 8192) {
  const hop = nfft / 2;
  const win = new Float32Array(nfft);
  let wsum = 0;
  for (let i = 0; i < nfft; i++) {
    win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nfft);   // Hann
    wsum += win[i] * win[i];
  }
  const bins = nfft / 2 + 1;
  const acc = new Float64Array(bins);
  let frames = 0;
  for (let off = 0; off + nfft <= x.length; off += hop) {
    const re = new Float64Array(nfft), im = new Float64Array(nfft);
    for (let i = 0; i < nfft; i++) re[i] = x[off + i] * win[i];
    fft(re, im);
    for (let k = 0; k < bins; k++) {
      const p = re[k] * re[k] + im[k] * im[k];
      acc[k] += (k === 0 || k === bins - 1 ? 1 : 2) * p;
    }
    frames++;
  }
  const norm = 1 / Math.max(1, frames) / (wsum * nfft);
  for (let k = 0; k < bins; k++) acc[k] *= norm;
  return { psd: acc, hz: (k) => (k * SR) / nfft };
}

const bandPower = (psd, hz, lo, hi) => {
  let s = 0;
  for (let k = 0; k < psd.length; k++) { const f = hz(k); if (f >= lo && f < hi) s += psd[k]; }
  return s;
};

const OCTAVES = [
  [20, 40], [40, 80], [80, 160], [160, 320], [320, 640], [640, 1250],
  [1250, 2500], [2500, 5000], [5000, 10000], [10000, 20000],
];

/* ── ffmpeg's loudness meter ────────────────────────────────────────────── */

function ebur128(file) {
  /* ebur128 writes its summary to stderr and exits zero, so this has to be a
   * spawn with stderr captured rather than an execFileSync in a try/catch. */
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-i', file,
    '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'],
    { encoding: 'utf8', maxBuffer: 1 << 28 });
  const out = String(r.stderr || '');
  const summary = out.slice(out.lastIndexOf('Summary'));
  const pick = (label) => {
    const m = summary.match(new RegExp('\\n\\s*' + label + ':\\s*(-?[\\d.]+|-inf)'));
    return m ? parseFloat(m[1]) : NaN;
  };
  return { lufs: pick('I'), lra: pick('LRA'), truePeakDb: pick('Peak') };
}

/* ── One file ───────────────────────────────────────────────────────────── */

export function measure(file) {
  const { L, R, n } = decode(file);
  const mono = new Float32Array(n), side = new Float32Array(n);
  for (let i = 0; i < n; i++) { mono[i] = 0.5 * (L[i] + R[i]); side[i] = 0.5 * (L[i] - R[i]); }

  const { psd, hz } = spectrum(mono);
  const total = bandPower(psd, hz, 0, SR / 2);
  const hi500 = bandPower(psd, hz, 500, SR / 2);
  const lo160 = bandPower(psd, hz, 0, 160);

  // Correlation is on the raw channels; a mix of independent noise reads ~0
  // and a near-mono low end reads close to +1.
  let sLR = 0, sLL = 0, sRR = 0;
  for (let i = 0; i < n; i++) { sLR += L[i] * R[i]; sLL += L[i] * L[i]; sRR += R[i] * R[i]; }
  const corr = sLR / Math.max(1e-20, Math.sqrt(sLL * sRR));

  // Correlation per octave, which is the number that says whether the width is
  // physical. Below 200 Hz a wavelength is metres across and a real field is
  // nearly mono; independent noise there is a synthesis artefact.
  const specL = spectrum(L).psd, specR = spectrum(R).psd;
  const specM = spectrum(mono).psd, specS = spectrum(side).psd;
  const octaves = OCTAVES.map(([lo, hi]) => {
    const p = bandPower(psd, hz, lo, hi);
    const m = bandPower(specM, hz, lo, hi), s = bandPower(specS, hz, lo, hi);
    return {
      lo, hi,
      db: +db(Math.sqrt(p)).toFixed(1),
      pct: +(100 * p / Math.max(1e-30, total)).toFixed(2),
      // Mid/side ratio in dB: large positive is mono, 0 dB is fully spread.
      msDb: +(10 * Math.log10(Math.max(1e-30, m) / Math.max(1e-30, s))).toFixed(1),
      lrDb: +(10 * Math.log10(Math.max(1e-30, bandPower(specL, hz, lo, hi))
        / Math.max(1e-30, bandPower(specR, hz, lo, hi)))).toFixed(1),
    };
  });

  let peak = 0;
  for (let i = 0; i < n; i++) { peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i])); }

  const loud = ebur128(file);

  // The phone. A 4th-order highpass at 500 Hz is generous to a phone speaker,
  // whose real response falls away from about 700 Hz down and is 20 dB down by
  // 400. Whatever survives this is the upper bound on what the audience hears.
  const phone = decode(file, ['highpass=f=500:poles=2', 'highpass=f=500:poles=2']);
  const phoneRms = db(rms(phone.L) / Math.SQRT1_2 + 1e-30);
  let phonePeak = 0;
  for (let i = 0; i < phone.n; i++) phonePeak = Math.max(phonePeak, Math.abs(phone.L[i]), Math.abs(phone.R[i]));

  return {
    file, seconds: +(n / SR).toFixed(2),
    fullDb: +db(Math.sqrt(total)).toFixed(1),
    hi500Db: +db(Math.sqrt(hi500)).toFixed(1),
    hi500Pct: +(100 * hi500 / Math.max(1e-30, total)).toFixed(2),
    lo160Pct: +(100 * lo160 / Math.max(1e-30, total)).toFixed(2),
    corr: +corr.toFixed(4),
    midDb: +db(rms(mono)).toFixed(1),
    sideDb: +db(rms(side)).toFixed(1),
    samplePeakDb: +db(peak).toFixed(2),
    truePeakDb: loud.truePeakDb,
    lufs: loud.lufs,
    lra: loud.lra,
    octaves,
    phoneRmsDb: +db(rms(phone.L)).toFixed(1),
    phonePeakDb: +db(phonePeak).toFixed(1),
    phoneVsFullDb: +(db(rms(phone.L)) - db(rms(L))).toFixed(1),
    _unused: phoneRms,
  };
}

export function print(m) {
  console.log(`\n  ${path.relative(process.cwd(), m.file)}   ${m.seconds}s`);
  console.log(`    full band     ${f1(m.fullDb)} dBFS`);
  console.log(`    above 500 Hz  ${f1(m.hi500Db)} dBFS   (${m.hi500Pct}% of energy)`);
  console.log(`    below 160 Hz  ${m.lo160Pct}% of energy`);
  console.log(`    L/R corr      ${m.corr}    mid ${f1(m.midDb)} dB  side ${f1(m.sideDb)} dB`);
  console.log(`    sample peak   ${f1(m.samplePeakDb)} dBFS    true peak ${f1(m.truePeakDb)} dBTP`);
  console.log(`    loudness      ${f1(m.lufs)} LUFS   LRA ${f1(m.lra)}`);
  console.log('    octave         dBFS    share   mid-side   L-R');
  for (const o of m.octaves) {
    const bar = '#'.repeat(Math.max(0, Math.round(o.pct / 2)));
    console.log(`      ${String(o.lo).padStart(5)}-${String(o.hi).padEnd(6)} ${f1(o.db).padStart(6)}  ${String(o.pct).padStart(6)}%  ${String(o.msDb).padStart(6)} dB ${String(o.lrDb).padStart(6)} dB  ${bar}`);
  }
  console.log(`    phone (hp 500 Hz, 4th order)  ${f1(m.phoneRmsDb)} dBFS rms, peak ${f1(m.phonePeakDb)} dB`);
  console.log(`      that is ${f1(-m.phoneVsFullDb)} dB below the full-band level`);
}

if (import.meta.url.startsWith('file:') && process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const out = [];
  for (const f of files) {
    if (!fs.existsSync(f)) { console.error(`  ✗ no such file: ${f}`); continue; }
    const m = measure(f);
    out.push(m);
    print(m);
  }
  if (process.env.AUDIOSPEC_JSON) fs.writeFileSync(process.env.AUDIOSPEC_JSON, JSON.stringify(out, null, 2));
  console.log('');
}
