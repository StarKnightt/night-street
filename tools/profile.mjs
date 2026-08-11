/* A one-dimensional cut through a capture.
 *
 * "Is this a sine, a sawtooth or a square wave" is a question about a
 * waveform, and neither a mean nor a standard deviation can answer it. This
 * averages each row of a rectangle into one number and prints the column of
 * values with a bar, so the shape of a corrugation or a shadow terminator can
 * be read directly off the frame.
 *
 *   node tools/profile.mjs shots/sys3b-face/40.png 700,300,810,400 [--of 1024] [--axis y]
 */
import { readPNG } from './pxfile.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const [src, rect] = args;
const OF = +flag('of', 1024);
const AXIS = flag('axis', 'y');

const img = readPNG(src);
const s = img.w / OF;
const [rx0, ry0, rx1, ry1] = rect.split(',').map(Number);
const x0 = Math.round(rx0 * s), y0 = Math.round(ry0 * s);
const x1 = Math.round(rx1 * s), y1 = Math.round(ry1 * s);

const lum = (i, j) => {
  const k = (j * img.w + i) * img.ch;
  return 0.2126 * img.data[k] + 0.7152 * img.data[k + 1] + 0.0722 * img.data[k + 2];
};

const out = [];
if (AXIS === 'y') {
  for (let j = y0; j < y1; j++) {
    let a = 0; for (let i = x0; i < x1; i++) a += lum(i, j);
    out.push([j, a / (x1 - x0)]);
  }
} else {
  for (let i = x0; i < x1; i++) {
    let a = 0; for (let j = y0; j < y1; j++) a += lum(i, j);
    out.push([i, a / (y1 - y0)]);
  }
}

const vals = out.map((o) => o[1]);
const lo = Math.min(...vals), hi = Math.max(...vals);
console.log(`${src}  ${AXIS}=${AXIS === 'y' ? y0 : x0}..${AXIS === 'y' ? y1 : x1}` +
  `  range ${lo.toFixed(1)}..${hi.toFixed(1)}`);
for (const [n, v] of out) {
  const w = Math.round(((v - lo) / Math.max(1e-6, hi - lo)) * 58);
  console.log(`${String(n).padStart(4)} ${v.toFixed(1).padStart(6)} ${'#'.repeat(w)}`);
}
