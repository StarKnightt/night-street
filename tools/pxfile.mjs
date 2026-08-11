/* Region sampler, for frames already on disk.
 *
 * px.mjs samples the live canvas, which is the right tool while authoring but
 * useless for answering "was it warmer last round" — by the time the question
 * is asked the code that produced last round's frame is gone. The PNGs are
 * not. This averages the same fractional rectangles out of any capture, so a
 * claim about hue can be checked against the picture the critic actually saw.
 *
 *   node tools/pxfile.mjs shots/sys2b/40.png [shots/sys2c/40.png ...]
 *
 * The decoder handles what the harness writes and nothing else: 8-bit
 * non-interlaced RGB or RGBA.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

export function readPNG(file) {
  const buf = fs.readFileSync(file);
  let p = 8, w = 0, h = 0, depth = 0, type = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const tag = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (tag === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      depth = data[8]; type = data[9];
      if (depth !== 8 || (type !== 2 && type !== 6) || data[12] !== 0) {
        throw new Error(`unsupported PNG: depth ${depth} type ${type} interlace ${data[12]}`);
      }
    } else if (tag === 'IDAT') idat.push(data);
    else if (tag === 'IEND') break;
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = type === 6 ? 4 : 3;
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let q = 0;
  for (let y = 0; y < h; y++) {
    const filter = raw[q++];
    const row = raw.subarray(q, q + stride); q += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= ch ? prev[x - ch] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 255;
    }
  }
  return { w, h, ch, data: out };
}

export function meanRect(img, [fx, fy, fw, fh]) {
  const x0 = Math.round(fx * img.w), y0 = Math.round(fy * img.h);
  const x1 = Math.min(img.w, x0 + Math.max(1, Math.round(fw * img.w)));
  const y1 = Math.min(img.h, y0 + Math.max(1, Math.round(fh * img.h)));
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const k = (y * img.w + x) * img.ch;
      r += img.data[k]; g += img.data[k + 1]; b += img.data[k + 2]; n++;
    }
  }
  return [r / n / 255, g / n / 255, b / n / 255];
}

/* Same rectangles as px.mjs --walls, so live and on-disk measurements of the
 * same view are directly comparable. */
export const WALLS = {
  shadeHiR: [0.82, 0.20, 0.09, 0.13],
  shadeMidR: [0.80, 0.40, 0.09, 0.10],
  shadeLowR: [0.76, 0.56, 0.08, 0.06],
  sunHiL: [0.04, 0.20, 0.09, 0.13],
  sunMidL: [0.07, 0.40, 0.09, 0.10],
  zenith: [0.45, 0.02, 0.10, 0.04],
  skyBand: [0.40, 0.06, 0.20, 0.14],
  roadShade: [0.44, 0.72, 0.12, 0.05],
};

// Only when run directly. Importing this for readPNG used to run the whole CLI
// against the importer's arguments, which is a confusing way to fail.
if (process.argv[2] && process.argv[1].endsWith('pxfile.mjs')) {
  const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  for (const file of process.argv.slice(2)) {
    const img = readPNG(file);
    console.log(`\n  ${file}   ${img.w}x${img.h}`);
    console.log(`  region        sRGB mean          luma    B/R`);
    for (const [k, rect] of Object.entries(WALLS)) {
      const c = meanRect(img, rect);
      console.log(`  ${k.padEnd(12)}  ${c.map((v) => v.toFixed(3)).join(' ')}   ` +
        `${luma(c).toFixed(3)}   ${(c[2] / Math.max(c[0], 1e-4)).toFixed(3)}`);
    }
  }
  console.log('');
}
