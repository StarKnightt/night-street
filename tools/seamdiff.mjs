/* Column-wise difference between two captures over a band of rows.
 *
 * For deciding whether a vertical margin in a frame is something a change
 * introduced or something a change merely made visible: if the column
 * difference between the before and after frames is flat across the margin,
 * the margin was already there.
 *
 *   node tools/seamdiff.mjs a.png b.png x0 x1 y0 y1   (native pixels)
 */
import { readPNG } from './pxfile.mjs';

const [pa, pb, x0, x1, y0, y1] = process.argv.slice(2);
const a = readPNG(pa), b = readPNG(pb);
const rows = [];
for (let x = +x0; x < +x1; x++) {
  let d = 0, la = 0, lb = 0, n = 0;
  for (let y = +y0; y < +y1; y++) {
    const k = (y * a.w + x) * a.ch;
    for (let c = 0; c < 3; c++) {
      d += Math.abs(a.data[k + c] - b.data[k + c]);
      la += a.data[k + c]; lb += b.data[k + c]; n++;
    }
  }
  rows.push([x, d / n, la / n, lb / n]);
}
for (const [x, d, la, lb] of rows) {
  const bar = '#'.repeat(Math.min(60, Math.round(d * 2)));
  console.log(`${x}  diff ${d.toFixed(1).padStart(5)}  a ${la.toFixed(1).padStart(6)}  b ${lb.toFixed(1).padStart(6)}  ${bar}`);
}
