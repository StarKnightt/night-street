/* Does the air read as motes, or as grain?
 *
 *   node tools/air.mjs <base> <nodust> <nograin> [--frames 120]
 *
 * The grade's sensor grain and System 6's dust are, in a still, the same
 * thing: a scatter of pixels a few counts above their neighbours. They are not
 * the same thing in motion, and the difference is the whole reason the dust is
 * in the scene — a mote is an object at a distance, so it persists frame to
 * frame and slides with a parallax set by its depth, and grain is redrawn from
 * nothing every frame. If the finished clip's air reads as noise, that is what
 * has happened, and this is the instrument that says so.
 *
 * It works off three captures of the *same* route at the same frame indices,
 * one plain, one with `?haze=nodust`, one with `?nograin`. Because the reel is
 * driven — every frame is exactly 1/fps of simulated time, with no wall clock
 * anywhere in the loop — the three runs agree frame for frame on everything
 * except the one term that was switched off, so a per-pixel difference isolates
 * that term exactly. Nothing here is a threshold on absolute brightness, which
 * is what makes it work on a frame whose shaded road sits at code 28.
 *
 * Persistence is the number that matters. For every dust pixel in frame N it
 * takes the distance to the nearest dust pixel in frame N-1:
 *
 *   a few px    the same motes, displaced by their own parallax. Air.
 *   ~0.5/sqrt(density) px   no relationship at all between frames. Grain.
 *
 * The random-scatter expectation is computed from the measured density and
 * printed next to the measurement, so the comparison is on the page.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const tags = args.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a));
if (tags.length < 3) {
  console.error('usage: node tools/air.mjs <base> <nodust> <nograin> [--shot walk] [--frames 120]');
  process.exit(2);
}
const SHOT = flag('shot', 'walk');
const N = +flag('frames', 120);
const THRESH = +flag('t', 4);          // 8-bit counts; below this is JPEG ringing

/** Decode a JPEG sequence to 8-bit luma planes, N frames of w*h bytes. */
function planes(tag, w, h, n) {
  const dir = path.join(ROOT, 'shots', tag, SHOT);
  const r = spawnSync('ffmpeg', [
    '-v', 'error', '-i', path.join(dir, '%05d.jpg'),
    '-frames:v', String(n), '-pix_fmt', 'gray', '-f', 'rawvideo', '-',
  ], { maxBuffer: 1 << 30 });
  if (r.status !== 0) { console.error(String(r.stderr)); process.exit(1); }
  const buf = r.stdout;
  const size = w * h;
  if (buf.length < size * n) { console.error(`short decode for ${tag}: ${buf.length} bytes`); process.exit(1); }
  return Array.from({ length: n }, (_, i) => buf.subarray(i * size, (i + 1) * size));
}

const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height', '-of', 'csv=p=0:nk=1',
  path.join(ROOT, 'shots', tags[0], SHOT, '00000.jpg')], { encoding: 'utf8' });
const [W, H] = probe.stdout.trim().split(/[,\r\n]+/).map(Number);
console.log(`\n  ${W}x${H}, ${N} frames, threshold ${THRESH} counts\n`);

const [base, nodust, nograin] = tags.map((t) => planes(t, W, H, N));

/* Column indices of the set pixels, per row, so the nearest-neighbour search
 * only ever scans the rows it has to. A dust mask is well under a per cent of
 * the frame, so this is cheap; a full distance transform is not needed and
 * would cost more than the decode. */
function mask(a, b) {
  const rows = Array.from({ length: H }, () => []);
  let n = 0;
  for (let y = 0; y < H; y++) {
    const o = y * W;
    for (let x = 0; x < W; x++) {
      if (Math.abs(a[o + x] - b[o + x]) >= THRESH) { rows[y].push(x); n++; }
    }
  }
  return { rows, n };
}

function nearest(rows, x, y, cap = 64) {
  let best = cap;
  for (let dy = 0; dy <= cap; dy++) {
    if (dy >= best) break;
    for (const sy of dy === 0 ? [y] : [y - dy, y + dy]) {
      if (sy < 0 || sy >= H) continue;
      for (const sx of rows[sy]) {
        const d = Math.hypot(sx - x, sy - y);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

const report = (label, series) => {
  const tot = series.reduce((a, b) => a + b.n, 0) / series.length;
  const amp = series.reduce((a, b) => a + b.amp, 0) / series.length;
  console.log(`  ${label.padEnd(9)} ${tot.toFixed(0).padStart(7)} px/frame  ` +
    `${(100 * tot / (W * H)).toFixed(3)}% of frame   mean amplitude ${amp.toFixed(2)} counts`);
  return tot;
};

const amplitude = (a, b) => {
  let s = 0, n = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d >= THRESH) { s += d; n++; }
  }
  return n ? s / n : 0;
};

const dust = [], grain = [];
for (let i = 0; i < N; i++) {
  const md = mask(base[i], nodust[i]);
  const mg = mask(base[i], nograin[i]);
  dust.push({ ...md, amp: amplitude(base[i], nodust[i]) });
  grain.push({ ...mg, amp: amplitude(base[i], nograin[i]) });
}

console.log('  what the two terms cost, per frame\n');
const dn = report('dust', dust);
const gn = report('grain', grain);
console.log(`\n  grain covers ${(gn / Math.max(dn, 1)).toFixed(1)}x the pixels the dust does`);

/* Persistence, on a sample of frames rather than all of them: the answer is a
 * property of the field and not of any one frame, and the search is O(dust
 * pixels x rows scanned). */
const step = Math.max(1, Math.floor(N / 12));
let sum = 0, cnt = 0;
for (let i = step; i < N; i += step) {
  const cur = dust[i], prev = dust[i - 1];
  if (!cur.n || !prev.n) continue;
  for (let y = 0; y < H; y++) {
    for (const x of cur.rows[y]) { sum += nearest(prev.rows, x, y); cnt++; }
  }
}
const persist = cnt ? sum / cnt : NaN;
const density = dn / (W * H);
const random = 0.5 / Math.sqrt(density);
console.log(`\n  persistence  ${persist.toFixed(2)} px to the nearest dust pixel of the previous frame`);
console.log(`               ${random.toFixed(1)} px would be the answer for the same number of`);
console.log('               points thrown down at random, i.e. for grain');
console.log(`  ${persist < random / 4 ? '→ the air is a field of objects, not noise'
  : '✗ the dust is not persisting — it is reading as noise'}\n`);
