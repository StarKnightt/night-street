/* Where along a take is there any air in the frame?
 *
 *   node tools/airtime.mjs <base> <nodust> [--shot walk] [--fps 60] [--t 10]
 *
 * `air.mjs` answers "is the dust a field of objects or is it noise" on a
 * handful of frames. This answers the other half, which is a composition
 * question rather than a rendering one: over thirty seconds, when is the dust
 * actually on screen at all? The atmosphere pass measured that on the old
 * route and found the answer was "between t 17 and t 22 and essentially
 * nowhere else", which is a third of a clip carrying an effect the whole
 * atmosphere system exists to produce.
 *
 * Same method as air.mjs — two driven captures of the same route differing in
 * one switch, differenced frame for frame — but reported as a curve against
 * time and against z, which is what a route is chosen from.
 *
 * The threshold defaults to 10 counts rather than air.mjs's 4. Both captures
 * are JPEG, and two independent encodes of the same image disagree by two or
 * three counts over a large fraction of the frame, which at a threshold of 4
 * swamps the dust with several hundred pixels of codec noise per frame and
 * drags the persistence measurement toward the random-scatter answer. Ten is
 * comfortably above the codec and well below a lit mote.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const [A, B] = args.filter((a) => !a.startsWith('--'));
const SHOT = flag('shot', 'walk');
const FPS = +flag('fps', 60);
const THRESH = +flag('t', 10);
const EVERY = +flag('every', 10);

const dirOf = (t) => path.join(ROOT, 'shots', t, SHOT);
const rows = JSON.parse(fs.readFileSync(path.join(ROOT, 'shots', A, 'reel.json'), 'utf8'))
  .shots.find((s) => s.name === SHOT).rows;

const probe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height', '-of', 'csv=p=0:nk=1',
  path.join(dirOf(A), '00000.jpg')], { encoding: 'utf8' });
const [W, H] = probe.stdout.trim().split(/[,\r\n]+/).map(Number);

/* Decoded in chunks. A full 1800-frame 1080p luma plane pair is 7 GB and node
 * will not hand back a buffer that size from spawnSync. */
function chunk(tag, start, n) {
  const r = spawnSync('ffmpeg', [
    '-v', 'error', '-start_number', String(start), '-i', path.join(dirOf(tag), '%05d.jpg'),
    '-frames:v', String(n), '-pix_fmt', 'gray', '-f', 'rawvideo', '-',
  ], { maxBuffer: 1 << 30 });
  if (r.status !== 0) { console.error(String(r.stderr)); process.exit(1); }
  return r.stdout;
}

const total = fs.readdirSync(dirOf(A)).filter((f) => f.endsWith('.jpg')).length;
const size = W * H;
const STEP = 60;

console.log(`\n  ${A} vs ${B}, ${W}x${H}, ${total} frames, threshold ${THRESH} counts\n`);
console.log('    t      z       dust px   brightest   % of frame');

const series = [];
for (let s = 0; s < total; s += STEP) {
  const n = Math.min(STEP, total - s);
  const a = chunk(A, s, n), b = chunk(B, s, n);
  for (let i = 0; i < n; i += EVERY) {
    const o = i * size;
    let cnt = 0, peak = 0;
    for (let p = 0; p < size; p++) {
      const d = Math.abs(a[o + p] - b[o + p]);
      if (d >= THRESH) { cnt++; if (d > peak) peak = d; }
    }
    const f = s + i;
    series.push({ f, t: f / FPS, z: rows[f]?.z ?? NaN, cnt, peak });
  }
}

for (const r of series) {
  if (r.f % (FPS * 2) !== 0) continue;
  const bar = '█'.repeat(Math.min(40, Math.round(r.cnt / 8)));
  console.log(`  ${r.t.toFixed(0).padStart(4)}  ${r.z.toFixed(1).padStart(7)}  ` +
    `${String(r.cnt).padStart(7)}   ${String(r.peak).padStart(7)}   ` +
    `${(100 * r.cnt / size).toFixed(4).padStart(8)}  ${bar}`);
}

const cnts = series.map((r) => r.cnt).sort((x, y) => x - y);
const mean = cnts.reduce((x, y) => x + y, 0) / cnts.length;
const lit = series.filter((r) => r.cnt >= 30).length / series.length;
console.log(`\n  mean ${mean.toFixed(0)} px/frame, median ${cnts[cnts.length >> 1]}, ` +
  `peak ${cnts[cnts.length - 1]}`);
console.log(`  ${(100 * lit).toFixed(0)}% of the take has 30 or more dust pixels in frame\n`);
