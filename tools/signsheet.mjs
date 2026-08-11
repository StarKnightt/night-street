/* Bake the sign atlas outside the browser and write it out as a PNG.
 *
 * The letterforms are the one thing in this project that is wrong if it is
 * merely plausible: a fascia that spells nothing reads as a rendering error,
 * and that failure is invisible in a capture until the sign is large enough
 * to read. So the atlas is inspected directly, at the size it is drawn, before
 * anything is shot.
 *
 *   npx tsc src/scene/signs.ts --outDir .tmp --module es2020 --target es2020 \
 *     --moduleResolution bundler --skipLibCheck
 *   node tools/signsheet.mjs crops/signs.png
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { signAtlas, SIGN_CAP, SIGN_ROW } from '../.tmp/signs.js';

const dst = process.argv[2] || 'crops/signs.png';
const a = signAtlas();
const src = a.texture.image;
const W = src.width, H = src.height;
const d = src.data;

const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) {
  const row = y * (W * 3 + 1);
  for (let x = 0; x < W; x++) {
    const v = d[y * W + x];
    const o = row + 1 + x * 3;
    /* Ink dark on a pale ground, which is how most of these are painted and
     * also the easier direction to judge letterforms in. */
    raw[o] = raw[o + 1] = raw[o + 2] = 235 - v * 0.85;
  }
}

const TBL = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TBL[n] = c;
}
const crc32 = (b) => {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = TBL[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (tag, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(tag, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 2;
fs.writeFileSync(dst, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
  chunk('IEND', Buffer.alloc(0)),
]));

console.log(`${dst}  ${W}x${H}   cap ${SIGN_CAP}px  row ${SIGN_ROW}px  rows ${a.meta.length}`);
console.log(`fascia ${a.fascia0}..${a.fascia0 + a.fasciaN - 1}  ` +
  `name ${a.name0}..${a.name0 + a.nameN - 1}  plate ${a.plate0}..${a.plate0 + a.plateN - 1}`);
for (let i = 0; i < a.meta.length; i++) {
  console.log(`  row ${String(i).padStart(2)}  width ${(a.meta[i].x * W).toFixed(0).padStart(4)}px  ` +
    `aspect ${(a.meta[i].x * W / SIGN_CAP).toFixed(2).padStart(6)}  mean ink ${a.meta[i].y.toFixed(3)}`);
}
