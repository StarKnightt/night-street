/* The two frames the road argument is actually about, and nothing else.
 *
 * The critic's numbers for the shaded carriageway are read off the delivered
 * take at t = 29.5 s, and the delivered take costs a five-minute capture. This
 * reproduces the *camera state* of that frame — position, yaw and pitch copied
 * out of `shots/heroE/reel.json` row 1770 — plus a sunlit control taken from
 * row 0 of the same file, and renders one frame at each. Two frames, about
 * fifteen seconds, and the regions are `reel.json`'s own rectangles so a number
 * printed here is directly comparable with a number printed by the reel.
 *
 * Two things it deliberately does not do. It does not walk: the walker is
 * teleported and settled, so the gait phase differs from the take's and the
 * bob height is the resting one. And it does not encode: the frame is read
 * back off the canvas after `renderOnce`, which the grade wraps, so this is
 * the graded picture the reel writes and not the raw scene pass.
 *
 *   node tools/withlock.mjs roadprobe -- node tools/roadprobe.mjs before
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture, finish } from './harness.mjs';
import { readPNG } from './pxfile.mjs';
import { invertRGB } from './pxrgb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = args[0] && !args[0].startsWith('--') ? args[0] : 'roadprobe';
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const QUERY = flag('q', '');

/* Straight out of shots/heroE/reel.json. `clock` is the second of the take the
 * row was written at, and it is in the name so a reader can go and look at the
 * frame. */
const STOPS = [
  { name: 'shade295', clock: 29.52, x: 0.4482, z: -62.0294, yaw: 0.0311, pitch: -0.016 },
  { name: 'sun00', clock: 0.02, x: -5.0, z: -22.0027, yaw: 0.02, pitch: -0.05 },
];

/* reel.json's regions, verbatim, as fractions of the frame. */
const REGIONS = {
  sky: [0.4, 0.05, 0.2, 0.12],
  facadeL: [0.05, 0.22, 0.12, 0.26],
  facadeR: [0.83, 0.22, 0.12, 0.26],
  farRoad: [0.44, 0.52, 0.12, 0.05],
  midRoad: [0.42, 0.64, 0.16, 0.07],
  nearRoad: [0.36, 0.82, 0.28, 0.14],
  gutterL: [0.1, 0.76, 0.1, 0.08],
  walkR: [0.8, 0.7, 0.14, 0.1],
};

/** Mean and per-pixel spatial standard deviation of one rectangle, in codes. */
function stat(img, [fx, fy, fw, fh]) {
  const x0 = Math.round(fx * img.w), y0 = Math.round(fy * img.h);
  const x1 = Math.min(img.w, x0 + Math.round(fw * img.w));
  const y1 = Math.min(img.h, y0 + Math.round(fh * img.h));
  let r = 0, g = 0, b = 0, n = 0, l = 0, l2 = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const k = (y * img.w + x) * img.ch;
      const R = img.data[k], G = img.data[k + 1], B = img.data[k + 2];
      const lum = 0.2126 * R + 0.7152 * G + 0.0722 * B;
      r += R; g += G; b += B; l += lum; l2 += lum * lum; n++;
    }
  }
  const code = [r / n, g / n, b / n];
  const mx = Math.max(...code), mn = Math.min(...code);
  return {
    code,
    sat: mx <= 0 ? 0 : (mx - mn) / mx,
    sd: Math.sqrt(Math.max(0, l2 / n - (l / n) ** 2)),
  };
}

const outDir = path.join(ROOT, 'shots', tag);
fs.mkdirSync(outDir, { recursive: true });

const url = 'http://127.0.0.1:3000' + (QUERY ? '?' + QUERY : '');

await run({ width: 1920, height: 1080, url }, async ({ page, errs, readShaderErrors }) => {
  const report = { tag, when: new Date().toISOString(), query: QUERY, stops: [] };

  for (const st of STOPS) {
    /* placeAt() first so the collider's depenetration and the ground snap run,
     * then the exact x/z on top of them and a second snap. Setting x and z
     * without snapGround leaves groundY at the previous stop's height, which
     * is a camera 145 mm out over a kerb and a frame nobody can reconcile with
     * the take. */
    const got = await page.evaluate((s0) => {
      const s = window.__scene, w = s.walker;
      w.placeAt(0.5);
      w.x = s0.x; w.z = s0.z;
      w.snapGround();
      w.advanceGait(0);
      w.yaw = s0.yaw; w.pitch = s0.pitch;
      s.warp(1.5);
      s.setYaw(s0.yaw); s.setPitch(s0.pitch);
      const p = s.camera.position;
      return { x: +p.x.toFixed(4), y: +p.y.toFixed(4), z: +p.z.toFixed(4) };
    }, st);
    await page.waitForTimeout(120);

    /* Prove the teleport landed before believing anything measured off the
     * frame. A stop that silently stayed where it was is the whole reason this
     * file exists rather than a --js one-liner. */
    const off = Math.hypot(got.x - st.x, got.z - st.z);
    if (off > 0.05) {
      console.error(`  ✗ ${st.name}: asked for x=${st.x} z=${st.z}, got x=${got.x} z=${got.z}`);
      process.exitCode = 1;
    }

    const file = path.join(outDir, `${st.name}.png`);
    await capture(page, file);
    const img = readPNG(file);
    const rows = {};
    console.log(`\n  ${st.name}  (t=${st.clock}s)  cam ${got.x}, ${got.y}, ${got.z}`);
    console.log('  region      sRGB code           sat    B-R    sd    L(radiance)');
    for (const [k, rect] of Object.entries(REGIONS)) {
      const s = stat(img, rect);
      const { L } = invertRGB(s.code);
      rows[k] = { code: s.code.map((v) => +v.toFixed(1)), sat: +s.sat.toFixed(3),
        sd: +s.sd.toFixed(2), L: L.map((v) => +v.toFixed(4)) };
      console.log(`  ${k.padEnd(10)} ${s.code.map((v) => v.toFixed(1).padStart(6)).join(' ')}   `
        + `${s.sat.toFixed(3)}  ${(s.code[2] - s.code[0]).toFixed(1).padStart(6)}  `
        + `${s.sd.toFixed(2).padStart(5)}   ${L.map((v) => v.toFixed(4)).join(' ')}`);
    }
    report.stops.push({ ...st, cam: got, regions: rows });
  }

  report.shaderErrors = await readShaderErrors();
  report.errors = [...new Set(errs)];
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n  → ${path.relative(ROOT, outDir)}   shaderErrors=${report.shaderErrors.length}`);
});

finish(process.exitCode || 0);
