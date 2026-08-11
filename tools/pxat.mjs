/* Sample a rendered frame at named pixel coordinates.
 *
 * px.mjs samples fixed fractions of a live viewport, which is the right
 * instrument for "is the shaded frontage colder than the sunlit one". It is the
 * wrong one for answering a critique, because a critique arrives as a list of
 * pixel coordinates in a PNG that has already been shot — and re-deriving those
 * as viewport fractions loses exactly the precision the argument turns on.
 *
 * Reports the mean sRGB and the 0-255 luma of a small box about each point,
 * which is the number the reports quote as L, plus the scene radiance that
 * lands on it.
 *
 * That last column used to be computed from display = 0.284 * L^0.4545, which
 * is withdrawn — it was low by about a factor of two and every radiance this
 * tool has ever printed was wrong by roughly that. It now inverts the real
 * transform, three's AgX at exposure 0.296 plus the sensor pedestal plus the
 * sRGB encode, through tools/agx.mjs. See NOTES.md, "The display response".
 *
 *   node tools/pxat.mjs shots/sys4c-car/glass.png 625,641 390,703
 */
import sharp from 'sharp';
import { invert } from './agx.mjs';

const [file, ...pts] = process.argv.slice(2);
const box = Number(process.env.BOX ?? 5);

const img = sharp(file);
const { width, height } = await img.metadata();
const data = await img.raw().toBuffer();
const ch = data.length / (width * height);

console.log(`\n  ${file}  ${width}x${height}  ${box}x${box} boxes\n`);
console.log('  point         sRGB mean          L(0-255)   linear');
for (const p of pts) {
  const [cx, cy] = p.split(',').map(Number);
  let r = 0, g = 0, b = 0, n = 0;
  const h = box >> 1;
  for (let y = cy - h; y <= cy + h; y++) {
    for (let x = cx - h; x <= cx + h; x++) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const i = (y * width + x) * ch;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
  }
  r /= n * 255; g /= n * 255; b /= n * 255;
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  // The shipped display transform, inverted numerically. Neutral: a saturated
  // colour does not invert like a grey of the same luma, so for chroma work read
  // the three channels out and put them through `node tools/agx.mjs r g b`.
  const lin = invert(Math.round(L * 255), { sensor: true });
  console.log(
    `  ${p.padEnd(12)}  ${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)}`
    + `   ${(L * 255).toFixed(0).padStart(6)}   ${lin.toFixed(3)}`,
  );
}
console.log('');
