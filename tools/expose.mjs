/* The exposure arc of a take, second by second.
 *
 *   node tools/expose.mjs shots/heroE/walk.mp4 shots/provG/walkG.mp4
 *
 * The critique that redirected this whole delivery was one table: median
 * luminance 125.8 at t 3.5 against 43.4 at t 29.3, 0.31% of pixels clipped
 * against 0.001%, brightest pixel 255 against 227. Not a word of it is about
 * composition. A golden-hour clip whose last second contains no highlight is
 * an underexposed dusk frame however it is framed, and no instrument in this
 * repo could say so: reel.json's region means sample nine fixed rectangles,
 * which is the right tool for "does the gutter sparkle" and the wrong one for
 * "is there any light in this frame at all".
 *
 * So: ffmpeg's signalstats over the whole frame, per frame, reduced to one row
 * per second. YAVG is the mean, YLOW and YHIGH are the 10th and 90th
 * percentiles, YMAX is the brightest pixel in two million. The shape of YHIGH
 * across thirty seconds *is* the arc, and comparing two takes on it is the
 * whole point — a route change is only worth a capture slot if this number
 * moves.
 *
 * Reported in video-range code values as the critique was, not normalised.
 */
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const files = argv.filter((a) => !a.startsWith('--') && !/^[\d.,]+$/.test(a));
if (!files.length) {
  console.error('usage: node tools/expose.mjs <file.mp4> [more.mp4 ...] [--at 3.5,29.3]');
  process.exit(2);
}

/* --at t1,t2: the exact four measures the critique was written from.
 *
 * signalstats' percentiles are coarse and it has no notion of "clipped", so
 * for the numbers that go in a report the frame is decoded to raw gray8 and
 * the histogram is counted here. Two million bytes per frame through a pipe is
 * nothing, and it means p50, p99, the brightest pixel and the clipped fraction
 * are the real values rather than an estimator's. */
const ati = argv.indexOf('--at');
const AT = ati >= 0 ? argv[ati + 1].split(',').map(Number) : null;

function frameHistogram(file, t) {
  return new Promise((resolve, reject) => {
    /* Expand to display range before counting.
     *
     * The review encode off the frame sequence is full-range yuvj420p; the
     * delivered file is limited-range tv, because that is what plays correctly
     * everywhere. Read raw, they are not the same measurement — the same
     * highlight reads 255 in one and 243 in the other, and 243 against a
     * threshold of 250 says "no highlight" about a pixel that is clipping on
     * screen. `out_range=full` makes ffmpeg apply whatever the file is tagged
     * with, so every number below is a display code value regardless of how
     * the file happens to be stored. */
    const ff = spawn('ffmpeg', ['-v', 'error', '-ss', String(t), '-i', file,
      '-frames:v', '1', '-vf', 'scale=out_range=full', '-pix_fmt', 'gray',
      '-f', 'rawvideo', '-']);
    const chunks = [];
    ff.stdout.on('data', (d) => chunks.push(d));
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}`));
      const buf = Buffer.concat(chunks);
      const h = new Float64Array(256);
      for (let i = 0; i < buf.length; i++) h[buf[i]]++;
      const n = buf.length;
      const pct = (p) => {
        let acc = 0;
        for (let v = 0; v < 256; v++) { acc += h[v]; if (acc >= p * n) return v; }
        return 255;
      };
      let max = 255; while (max > 0 && h[max] === 0) max--;
      let clipped = 0; for (let v = 250; v < 256; v++) clipped += h[v];
      resolve({ n, p50: pct(0.5), p99: pct(0.99), max, clipped: 100 * clipped / n });
    });
  });
}

if (AT) {
  const w = Math.max(4, ...files.map((f) => f.length)) + 2;
  console.log(`\n  ${'file'.padEnd(w)}${'t'.padEnd(7)}${'p50'.padEnd(7)}${'p99'.padEnd(7)}` +
    `${'max'.padEnd(7)}clipped`);
  for (const file of files) {
    for (const t of AT) {
      const s = await frameHistogram(file, t);
      console.log(`  ${file.padEnd(w)}${String(t).padEnd(7)}${String(s.p50).padEnd(7)}` +
        `${String(s.p99).padEnd(7)}${String(s.max).padEnd(7)}${s.clipped.toFixed(3)}%`);
    }
  }
  console.log();
  process.exit(0);
}

function stats(file) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-v', 'error', '-i', file,
      '-vf', 'scale=out_range=full,signalstats,metadata=print:file=-',
      '-f', 'null', '-',
    ]);
    let buf = '';
    ff.stdout.on('data', (d) => { buf += d; });
    ff.stderr.on('data', () => {});
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exited ${code}`));
      const frames = [];
      let cur = null;
      for (const line of buf.split('\n')) {
        const t = line.match(/pts_time:([\d.]+)/);
        if (t) { cur = { t: +t[1] }; frames.push(cur); continue; }
        const kv = line.match(/lavfi\.signalstats\.(\w+)=([-\d.]+)/);
        if (kv && cur) cur[kv[1]] = +kv[2];
      }
      resolve(frames);
    });
  });
}

for (const file of files) {
  const frames = await stats(file);
  if (!frames.length) { console.log(`\n  ${file}: no frames\n`); continue; }

  console.log(`\n  ${file}  —  ${frames.length} frames\n`);
  console.log(`  ${'t'.padEnd(6)}${'mean'.padEnd(8)}${'p10'.padEnd(8)}${'p90'.padEnd(8)}${'max'.padEnd(8)}arc`);

  const rows = [];
  for (let s = 0; s < Math.ceil(frames[frames.length - 1].t); s++) {
    const win = frames.filter((f) => f.t >= s && f.t < s + 1);
    if (!win.length) continue;
    const mean = (k) => win.reduce((a, b) => a + (b[k] ?? 0), 0) / win.length;
    rows.push({ s, avg: mean('YAVG'), low: mean('YLOW'), high: mean('YHIGH'), max: mean('YMAX') });
  }
  const top = Math.max(...rows.map((r) => r.high));
  for (const r of rows) {
    const bar = '█'.repeat(Math.max(0, Math.round(28 * r.high / top)));
    console.log(`  ${String(r.s).padEnd(6)}${r.avg.toFixed(1).padEnd(8)}${r.low.toFixed(0).padEnd(8)}` +
      `${r.high.toFixed(0).padEnd(8)}${r.max.toFixed(0).padEnd(8)}${bar}`);
  }

  /* The two numbers the critique turned on. */
  const at = (t) => rows.reduce((a, b) => (Math.abs(b.s - t) < Math.abs(a.s - t) ? b : a));
  const open = at(3), close = at(29);
  const d = close.high - open.high;
  console.log(`\n  p90 opens ${open.high.toFixed(0)}, closes ${close.high.toFixed(0)} — ` +
    `${d >= 0 ? `+${d.toFixed(0)}, ends brighter than it starts` : `${d.toFixed(0)}, decays`}`);
  console.log(`  brightest pixel in the last second: ${close.max.toFixed(0)}` +
    `${close.max >= 250 ? ' — clips' : ' — no highlight'}\n`);
}
