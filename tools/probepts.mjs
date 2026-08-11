/* Sample a capture at projected world points.
 *
 * Placement questions — "is the kerb at z = -42 in the sun at stop three" —
 * are answerable from the frames already on disk, but only if the world point
 * can be turned into a pixel. This projects through the same camera the
 * report.json records and averages a small patch around each hit, which is the
 * cheapest way to settle a lighting argument without a capture round.
 *
 *   node tools/probepts.mjs shots/sys3c/40.png 0.05,1.65,-35.2 45 "x,y,z" ...
 */
import { readPNG } from './pxfile.mjs';

const [file, camS, fovS, ...pts] = process.argv.slice(2);
const cam = camS.split(',').map(Number);
const fov = Number(fovS);
const img = readPNG(file);
const aspect = img.w / img.h;
const th = Math.tan((fov * Math.PI) / 360);

const patch = (px, py, r = 6) => {
  let s = [0, 0, 0], n = 0;
  for (let y = py - r; y <= py + r; y++) {
    for (let x = px - r; x <= px + r; x++) {
      if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
      const k = (y * img.w + x) * img.ch;
      s = [s[0] + img.data[k], s[1] + img.data[k + 1], s[2] + img.data[k + 2]];
      n++;
    }
  }
  return n ? s.map((v) => v / n / 255) : null;
};

for (const p of pts) {
  const [X, Y, Z] = p.split(',').map(Number);
  const rx = X - cam[0], ry = Y - cam[1], rz = Z - cam[2];
  if (rz >= -0.05) { console.log(`  ${p}  behind camera`); continue; }
  const nx = rx / -rz / (th * aspect), ny = ry / -rz / th;
  const px = Math.round(((nx + 1) / 2) * img.w);
  const py = Math.round(((1 - ny) / 2) * img.h);
  const c = patch(px, py);
  console.log(`  ${p.padEnd(18)} -> ${String(px).padStart(4)},${String(py).padStart(4)}  ` +
    (c ? `${c.map((v) => v.toFixed(3)).join(' ')}  luma ${(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]).toFixed(3)}`
       : 'off frame'));
}
