/* Cut a region out of a capture and magnify it.
 *
 * Reviews arrive as pixel rectangles against a 1024-wide contact sheet, and
 * judging "is this corrugation a square wave or a sawtooth" from a 1600x900
 * frame viewed whole is not possible — the feature under discussion is four
 * pixels tall. This crops the named rectangle and scales it up with nearest
 * neighbour, so what comes out is the pixels themselves rather than an
 * interpolation of them.
 *
 *   node tools/crop.mjs shots/sys3b/95.png out.png 890,375,1024,460 [--of 1024] [--zoom 6]
 *
 * The rectangle is in the coordinates of a contact sheet `--of` pixels wide,
 * defaulting to 1024, because that is how the review states them.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { readPNG } from './pxfile.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const [src, dst, rect] = args;
const OF = +flag('of', 1024);
const ZOOM = +flag('zoom', 6);

const img = readPNG(src);
const s = img.w / OF;
let [x0, y0, x1, y1] = rect.split(',').map(Number);
x0 = Math.max(0, Math.round(x0 * s)); y0 = Math.max(0, Math.round(y0 * s));
x1 = Math.min(img.w, Math.round(x1 * s)); y1 = Math.min(img.h, Math.round(y1 * s));
const cw = x1 - x0, ch = y1 - y0;
const w = cw * ZOOM, h = ch * ZOOM;

const raw = Buffer.alloc((w * 3 + 1) * h);
for (let j = 0; j < h; j++) {
  const row = j * (w * 3 + 1);
  raw[row] = 0;
  const sj = y0 + ((j / ZOOM) | 0);
  for (let i = 0; i < w; i++) {
    const si = x0 + ((i / ZOOM) | 0);
    const k = (sj * img.w + si) * img.ch;
    const o = row + 1 + i * 3;
    raw[o] = img.data[k]; raw[o + 1] = img.data[k + 1]; raw[o + 2] = img.data[k + 2];
  }
}

const chunk = (tag, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(tag, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
};
let TBL = null;
function crc32(buf) {
  if (!TBL) {
    TBL = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TBL[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = TBL[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
ihdr[8] = 8; ihdr[9] = 2;
fs.writeFileSync(dst, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
  chunk('IEND', Buffer.alloc(0)),
]));
console.log(`${dst}  ${cw}x${ch} source px  ->  ${w}x${h}  (from ${src} at ${x0},${y0})`);
