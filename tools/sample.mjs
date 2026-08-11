/* Average an arbitrary rectangle out of a capture.
 *
 * pxfile.mjs samples a fixed set of regions chosen for the road and the
 * footway, which is the wrong instrument for "is the inside of that shop warm
 * or is it grey". This takes the rectangle on the command line.
 *
 *   node tools/sample.mjs shots/sys3a-probe/store.png 0.35,0.45,0.55,0.62 ...
 *
 * Rectangles are x0,y0,x1,y1 as fractions of the frame, y down from the top.
 */
import { readPNG } from './pxfile.mjs';

const [file, ...rects] = process.argv.slice(2);
const img = readPNG(file);

for (const r of rects) {
  const [x0, y0, x1, y1] = r.split(',').map(Number);
  let R = 0, G = 0, B = 0, n = 0;
  const lums = [];
  for (let j = Math.floor(y0 * img.h); j < Math.ceil(y1 * img.h); j++) {
    for (let i = Math.floor(x0 * img.w); i < Math.ceil(x1 * img.w); i++) {
      const k = (j * img.w + i) * img.ch;
      R += img.data[k]; G += img.data[k + 1]; B += img.data[k + 2]; n++;
      lums.push(0.2126 * img.data[k] + 0.7152 * img.data[k + 1] + 0.0722 * img.data[k + 2]);
    }
  }
  R /= n; G /= n; B /= n;
  /* Standard deviation is the number that answers "does this surface have any
   * texture on it", which a mean cannot. A flat field and a busy one average
   * to the same colour. */
  const mu = lums.reduce((a, b) => a + b, 0) / lums.length;
  const sd = Math.sqrt(lums.reduce((a, b) => a + (b - mu) ** 2, 0) / lums.length);
  const lum = 0.2126 * R + 0.7152 * G + 0.0722 * B;
  /* Saturation as max-min over max, on the sRGB values a viewer sees rather
   * than on linear radiance: the question these numbers answer is whether a
   * surface reads as coloured, and that is a perceptual question. */
  const sat = (Math.max(R, G, B) - Math.min(R, G, B)) / Math.max(1, Math.max(R, G, B));
  console.log(
    `${r.padEnd(24)} rgb ${R.toFixed(1).padStart(6)}${G.toFixed(1).padStart(7)}${B.toFixed(1).padStart(7)}` +
    `   lum ${lum.toFixed(1).padStart(5)}   sd ${sd.toFixed(2).padStart(5)}` +
    `   sat ${(sat * 100).toFixed(1).padStart(5)}%   R/B ${(R / Math.max(1, B)).toFixed(2)}`,
  );
}
