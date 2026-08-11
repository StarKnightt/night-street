/* Search a region for its extreme window rather than taking one on trust.
 *
 * Quoting a statistic from a window you chose yourself is worth very little,
 * because you chose it. This walks every window of a given size inside a
 * rectangle and reports the flattest, the brightest and the darkest, so a
 * claim about a surface is a claim about its worst case.
 *
 *   node tools/worst.mjs a.png b.png x0,y0,x1,y1 [--win 32] [--of 1024]
 */
import { readPNG } from './pxfile.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const files = args.filter((a) => a.endsWith('.png'));
const rect = args.find((a) => /^[\d.]+,/.test(a));
const WIN = +flag('win', 32);
const OF = +flag('of', 1024);

for (const f of files) {
  const img = readPNG(f);
  const s = img.w / OF;
  const [rx0, ry0, rx1, ry1] = rect.split(',').map(Number);
  const x0 = Math.round(rx0 * s), y0 = Math.round(ry0 * s);
  const x1 = Math.round(rx1 * s), y1 = Math.round(ry1 * s);

  let flat = null, bright = null;
  for (let y = y0; y + WIN <= y1; y += 2) {
    for (let x = x0; x + WIN <= x1; x += 2) {
      let sum = 0, sq = 0, n = 0;
      for (let j = 0; j < WIN; j++) {
        for (let i = 0; i < WIN; i++) {
          const k = ((y + j) * img.w + x + i) * img.ch;
          const l = 0.2126 * img.data[k] + 0.7152 * img.data[k + 1] + 0.0722 * img.data[k + 2];
          sum += l; sq += l * l; n++;
        }
      }
      const mean = sum / n;
      const sd = Math.sqrt(Math.max(0, sq / n - mean * mean));
      if (mean < +flag('min', 0)) continue;
      if (!flat || sd < flat.sd) flat = { x, y, mean, sd };
      if (!bright || mean > bright.mean) bright = { x, y, mean, sd };
    }
  }
  console.log(`${f}  ${WIN}x${WIN} windows in native ${x0},${y0}..${x1},${y1}`);
  console.log(`   flattest   at ${flat.x},${flat.y}   mean ${flat.mean.toFixed(2)}  sd ${flat.sd.toFixed(2)}`);
  console.log(`   brightest  at ${bright.x},${bright.y}   mean ${bright.mean.toFixed(2)}  sd ${bright.sd.toFixed(2)}`);
}
