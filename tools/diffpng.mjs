/* Where did two captures actually differ, and by how much.
 *
 * Sampling a rectangle answers "is this region darker"; it cannot answer "did
 * my change reach any pixels at all", and that is the question that matters
 * first when a fix appears to have done nothing. This reports the changed
 * fraction of the frame and locates the change, so a null result can be told
 * apart from a mis-aimed sample rectangle.
 *
 *   node tools/diffpng.mjs a.png b.png [threshold=2]
 */
import { readPNG } from './pxfile.mjs';

const [fa, fb, thr = '2'] = process.argv.slice(2);
const A = readPNG(fa), B = readPNG(fb);
if (A.w !== B.w || A.h !== B.h) throw new Error('size mismatch');

const T = +thr;
let changed = 0, total = 0, sum = 0, peak = 0;
let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
// A coarse map, so the reader can see where the change is without opening it.
const GX = 16, GY = 9;
const grid = Array.from({ length: GY }, () => new Array(GX).fill(0));
const cells = Array.from({ length: GY }, () => new Array(GX).fill(0));

for (let j = 0; j < A.h; j++) {
  for (let i = 0; i < A.w; i++) {
    const k = (j * A.w + i) * A.ch;
    const d = Math.max(
      Math.abs(A.data[k] - B.data[k]),
      Math.abs(A.data[k + 1] - B.data[k + 1]),
      Math.abs(A.data[k + 2] - B.data[k + 2]),
    );
    total++;
    const gy = Math.min(GY - 1, (j * GY / A.h) | 0), gx = Math.min(GX - 1, (i * GX / A.w) | 0);
    cells[gy][gx]++;
    if (d >= T) {
      changed++; sum += d; peak = Math.max(peak, d);
      grid[gy][gx]++;
      if (i < x0) x0 = i; if (i > x1) x1 = i;
      if (j < y0) y0 = j; if (j > y1) y1 = j;
    }
  }
}

console.log(`${fa}\n${fb}`);
console.log(`changed ${(100 * changed / total).toFixed(2)}% of pixels at threshold ${T}` +
  (changed ? `, mean delta ${(sum / changed).toFixed(1)}, peak ${peak}` : ''));
if (!changed) { console.log('IDENTICAL — the change reached no pixels'); process.exit(0); }
console.log(`bbox x ${x0}..${x1}  y ${y0}..${y1}   (frame ${A.w}x${A.h})`);
console.log('map (percent of each cell changed):');
for (let g = 0; g < GY; g++) {
  console.log('  ' + grid[g].map((n, i) => {
    const p = 100 * n / cells[g][i];
    return p < 0.5 ? ' .' : String(Math.min(99, Math.round(p))).padStart(2);
  }).join(' '));
}
