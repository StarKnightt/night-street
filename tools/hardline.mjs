/* Is the horizon an edge?
 *
 * haze.ts's notes record the horizon as "a hard plane", and an edge is a
 * measurable thing rather than an impression: the ground apron is a finite disc
 * and the fog had only converged about nine tenths of the way to the sky by the
 * time it reached the rim, so the row where apron becomes background carried a
 * step. A screenshot pair either has that step or does not.
 *
 * Row-mean luma down a column strip, then the largest single-row jump in it.
 * Mean over the strip rather than a single column because a hard plane is
 * horizontal and coherent across x, which is exactly what makes it read as an
 * edge, while noise and building detail are not.
 *
 *   node tools/hardline.mjs a.png b.png [--x0 60] [--x1 260] [--y0 290] [--y1 400]
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--') && a.endsWith('.png'));
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : +args[i + 1]; };
const X0 = flag('x0', 60), X1 = flag('x1', 260), Y0 = flag('y0', 290), Y1 = flag('y1', 400);

/** Minimal PNG reader: 8-bit truecolour, the only thing shoot.mjs writes. */
function readPng(file) {
  const buf = fs.readFileSync(file);
  let p = 8, w = 0, h = 0, colour = 0, bits = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bits = data[8]; colour = data[9];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bits !== 8 || (colour !== 2 && colour !== 6)) {
    throw new Error(`hardline: only 8-bit RGB/RGBA, got bits=${bits} colour=${colour}`);
  }
  const ch = colour === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * ch);
  const stride = w * ch;
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[y * stride + x - ch] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= ch && y > 0 ? out[(y - 1) * stride + x - ch] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { w, h, ch, data: out };
}

for (const f of files) {
  const { w, ch, data } = readPng(f);
  const rows = [];
  for (let y = Y0; y < Y1; y++) {
    let t = 0, n = 0;
    for (let x = X0; x < X1; x++) {
      const i = (y * w + x) * ch;
      t += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      n++;
    }
    rows.push(t / n);
  }
  let jump = 0, at = 0;
  for (let i = 1; i < rows.length; i++) {
    const d = Math.abs(rows[i] - rows[i - 1]);
    if (d > jump) { jump = d; at = Y0 + i; }
  }
  const span = Math.max(...rows) - Math.min(...rows);
  console.log(`${f.padEnd(34)} largest single-row step ${jump.toFixed(2)} counts at y=${at}`
    + `   (band spans ${span.toFixed(1)} counts over ${Y1 - Y0} rows)`);
}
