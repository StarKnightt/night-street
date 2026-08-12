/* How much of the frame is a flat, featureless region.
 *
 *   node tools/flat.mjs shots/dens0 shots/dens3 [--tile 12] [--thr 2.0]
 *
 * The brief for the density pass asked for "every pixel has something in it",
 * and that is not a thing an eye can report as a number across six frames and
 * two builds. This is the proxy: tile the frame, take the standard deviation
 * of luminance inside each tile, and count the fraction of the frame whose
 * tiles are below a threshold. A blank wall, an untextured slab of paving and
 * a clear patch of sky all score flat; brickwork, a fire escape, a bin, a
 * shadow edge and a run of cast iron do not.
 *
 * Two things it is not. It is not a quality measure — a frame filled with
 * noise scores perfectly and looks terrible — so it is only meaningful as a
 * before-and-after on the same viewpoints, which is why it takes two folders
 * and prints them side by side. And it counts sky, which is legitimately flat
 * and which nothing in this pass is trying to fill, so the absolute number is
 * always going to be well above zero and only the delta means anything.
 *
 * The threshold is in 8-bit luminance counts. 2.0 is about where a gradient
 * across a lit wall stops registering as content, measured by running it up
 * until the sunlit east footway in dens0/40.png — which is genuinely a flat
 * beige triangle — reads as flat.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readPNG } from './pxfile.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const dirs = args.filter((a) => !a.startsWith('--') && !/^[\d.]+$/.test(a));
const TILE = +flag('tile', 12);
const THR = +flag('thr', 2.0);
/* Restrict to a horizontal band of the frame, as a fraction of its height.
 *
 * The reason is a confound rather than a preference. The baseline folder for
 * the density pass was captured before a cloud layer landed from separate
 * work, so differencing the two whole frames credits the props with the sky.
 * `--from 0.45` cuts everything above the roofline and leaves the street,
 * which is the only part either pass is allowed to touch. */
const FROM = +flag('from', 0);
const TO = +flag('to', 1);

/** Fraction of the frame whose tiles have a luminance sigma below THR. */
function flatFraction(file) {
  const { w, h, data } = readPNG(file);
  let flat = 0, total = 0;
  const yA = Math.floor(h * FROM), yB = Math.floor(h * TO);
  for (let ty = yA; ty + TILE <= yB; ty += TILE) {
    for (let tx = 0; tx + TILE <= w; tx += TILE) {
      let s = 0, s2 = 0;
      for (let y = ty; y < ty + TILE; y++) {
        for (let x = tx; x < tx + TILE; x++) {
          const i = (y * w + x) * 4;
          const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
          s += l; s2 += l * l;
        }
      }
      const n = TILE * TILE;
      const v = Math.max(0, s2 / n - (s / n) ** 2);
      total++;
      if (Math.sqrt(v) < THR) flat++;
    }
  }
  return flat / total;
}

const stops = fs.readdirSync(dirs[0]).filter((f) => f.endsWith('.png')).sort();
console.log(`\n  FLAT — fraction of frame in tiles of sigma < ${THR}, ${TILE} px tiles\n`);
console.log(`  ${'stop'.padEnd(10)}${dirs.map((d) => path.basename(d).padEnd(10)).join('')}delta`);
const means = dirs.map(() => 0);
let n = 0;
for (const s of stops) {
  const vals = dirs.map((d) => (fs.existsSync(path.join(d, s)) ? flatFraction(path.join(d, s)) : NaN));
  if (vals.some(Number.isNaN)) continue;
  vals.forEach((v, i) => { means[i] += v; });
  n++;
  const d = vals[vals.length - 1] - vals[0];
  console.log(
    `  ${s.padEnd(10)}${vals.map((v) => `${(v * 100).toFixed(1)}%`.padEnd(10)).join('')}` +
    `${d >= 0 ? '+' : ''}${(d * 100).toFixed(1)} pts`,
  );
}
const avg = means.map((m) => m / n);
console.log(
  `\n  ${'mean'.padEnd(10)}${avg.map((v) => `${(v * 100).toFixed(1)}%`.padEnd(10)).join('')}` +
  `${avg[avg.length - 1] - avg[0] >= 0 ? '+' : ''}${((avg[avg.length - 1] - avg[0]) * 100).toFixed(1)} pts\n`,
);
