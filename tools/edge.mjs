/* Scan a row or column of a capture and print where it steps.
 *
 * Written to answer one question — "is the straight boundary in the sky a
 * geometric silhouette or a sampling artifact" — and kept because "print the
 * values either side of the edge the reviewer is pointing at" is the first thing
 * worth doing every time and reconstructing it from px.mjs each round is waste.
 *
 *   node tools/edge.mjs shots/probe/40.png row 0.36 0.55 1.00
 *   node tools/edge.mjs shots/probe/40.png col 0.93 0.10 0.65
 */
import { readPNG } from './pxfile.mjs';

const [file, axis, atS, fromS, toS] = process.argv.slice(2);
const img = readPNG(file);
const at = +atS, from = +fromS, to = +toS;
const px = (x, y) => {
  const k = (Math.min(img.h - 1, y) * img.w + Math.min(img.w - 1, x)) * img.ch;
  return [img.data[k] / 255, img.data[k + 1] / 255, img.data[k + 2] / 255];
};

const N = 64;
let prev = null;
console.log(`\n  ${file}  ${axis} at ${at}   ${img.w}x${img.h}`);
for (let i = 0; i <= N; i++) {
  const t = from + (to - from) * (i / N);
  const c = axis === 'row'
    ? px(Math.round(t * img.w), Math.round(at * img.h))
    : px(Math.round(at * img.w), Math.round(t * img.h));
  const d = prev ? Math.max(...c.map((v, j) => Math.abs(v - prev[j]))) : 0;
  console.log(`  ${t.toFixed(4)}  ${c.map((v) => v.toFixed(3)).join(' ')}` +
    (d > 0.02 ? `   <-- step ${d.toFixed(3)}` : ''));
  prev = c;
}
console.log('');
