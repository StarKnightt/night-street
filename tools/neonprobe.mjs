/* Is the OPEN sign a tube or a decal, in numbers rather than in adjectives.
 *
 * Three things are being argued about and each has a measurement here.
 *
 *   Level.       TECHNIQUE §3.7 asks for display 200-235 over "a few hundred
 *                pixels". So: how many pixels are pinned at 255 in all three
 *                channels, how many are over 200, and what is the peak. A
 *                clipped pixel has no colour, which is why the count matters
 *                more than the peak does.
 *   Profile.     A gas discharge is limb *brightened*: the phosphor is a shell
 *                on the inside of the glass, so a view ray cuts a longer chord
 *                near the silhouette than through the middle and the stroke is
 *                two bright rails around a duller core. A stroke that peaks in
 *                the middle is a backlit panel. Measured by taking the
 *                brightest row of the sign and reporting, for each run of ink
 *                across it, whether the ends beat the centre.
 *   Colour.      A clipped stroke reads white. Reported as the mean saturation
 *                of the ink pixels.
 *
 * The camera is aimed at the store frontage from the carriageway by arithmetic
 * rather than by eye - the frontage position comes out of tools/aim.mjs, which
 * reads the same layout the page builds - so the framing is reproducible
 * across builds and two runs can be differenced.
 *
 *   node tools/withlock.mjs neon -- node tools/neonprobe.mjs np-before
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture, finish } from './harness.mjs';
import { readPNG } from './pxfile.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = args[0] && !args[0].startsWith('--') ? args[0] : 'neonprobe';
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const QUERY = flag('q', '');
const W = +flag('w', 1600), H = +flag('h', 900);

/* The store frontage, from tools/aim.mjs. The sign hangs inside the glass at
 * about 1.98 m over the shop floor. */
const SIGN = { x: -6.06, z: -26.11, y: 2.12 };
/* A place on the carriageway with a clear line to it. */
const EYE = { x: 0.0, z: -22.0 };

const dx = SIGN.x - EYE.x, dz = SIGN.z - EYE.z;
const dist = Math.hypot(dx, dz);
// Walker convention: yaw 0 faces -Z, forward = (-sin y, -cos y).
const YAW = Math.atan2(-dx / dist, -dz / dist);
const PITCH = Math.atan2(SIGN.y - 1.65, dist);


const VIEWS = [
  { name: 'open', fov: 20 },
  { name: 'openwide', fov: 50 },
];

/* Everything the sign argument needs, off one frame.
 *
 * Everything is counted inside a box around the sign rather than over the
 * whole frame, and finding that box is not optional: the first run of this
 * tool counted 606,376 "ink" pixels because a sunlit brick frontage fills most
 * of the picture and is also warm and also bright. The box is the bounding
 * rectangle of the only genuinely *white* thing in a golden-hour street — the
 * clipped core of the sign — grown by a margin, and if there is no such thing
 * the tool says so rather than measuring the wall.
 */
function measure(img) {
  const { w, h, ch, data } = img;
  const at = (x, y) => {
    const k = (y * w + x) * ch;
    return [data[k], data[k + 1], data[k + 2]];
  };

  let bx0 = 1e9, by0 = 1e9, bx1 = -1, by1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = at(x, y);
      if (Math.min(r, g, b) > 170) {
        if (x < bx0) bx0 = x; if (x > bx1) bx1 = x;
        if (y < by0) by0 = y; if (y > by1) by1 = y;
      }
    }
  }
  /* Once the sign stops clipping there is no white left to find it by, so the
   * box has to be able to come from a previous run. --box x0,y0,x1,y1 pins it,
   * which is also the only way two builds are measured over the same pixels. */
  const pinned = flag('box', null);
  if (pinned) [bx0, by0, bx1, by1] = pinned.split(',').map(Number);
  else if (bx1 < 0) return { found: false };
  else {
    const m = 14;
    bx0 = Math.max(0, bx0 - m); by0 = Math.max(0, by0 - m);
    bx1 = Math.min(w - 1, bx1 + m); by1 = Math.min(h - 1, by1 + m);
  }

  let clip = 0, over200 = 0, peak = [0, 0, 0], peakSum = -1;
  /* Ink is any pixel the sign could plausibly own, inside the box. */
  const ink = [];
  for (let y = by0; y <= by1; y++) {
    for (let x = bx0; x <= bx1; x++) {
      const [r, g, b] = at(x, y);
      if (r >= 255 && g >= 255 && b >= 255) clip++;
      if (r > 200 && g > 200 && b > 200) over200++;
      if (r + g + b > peakSum) { peakSum = r + g + b; peak = [r, g, b]; }
      if (r > 150 && r > b + 25) ink.push([x, y, r, g, b]);
    }
  }
  let sat = 0;
  for (const [, , r, g, b] of ink) {
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    sat += mx <= 0 ? 0 : (mx - mn) / mx;
  }
  sat = ink.length ? sat / ink.length : 0;

  /* The cross-stroke profile. Take the row with the most ink in it, walk it,
   * and for every run of ink at least five pixels wide compare the mean of the
   * two end pixels with the mean of the middle three. A tube wins; a panel
   * loses. */
  const perRow = new Map();
  for (const [, y] of ink) perRow.set(y, (perRow.get(y) ?? 0) + 1);
  let bestRow = -1, bestN = 0;
  for (const [y, n] of perRow) if (n > bestN) { bestN = n; bestRow = y; }
  const runs = [];
  if (bestRow >= 0) {
    const isInk = (x) => { const [r, , b] = at(x, bestRow); return r > 150 && r > b + 25; };
    let x = bx0;
    while (x <= bx1) {
      if (!isInk(x)) { x++; continue; }
      let e = x;
      while (e + 1 <= bx1 && isInk(e + 1)) e++;
      const wid = e - x + 1;
      if (wid >= 5) {
        const lum = (p) => { const [r, g, b] = at(p, bestRow); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const c = Math.floor((x + e) / 2);
        const rails = (lum(x) + lum(e)) / 2;
        const core = (lum(c - 1) + lum(c) + lum(c + 1)) / 3;
        runs.push({ x, w: wid, rails: +rails.toFixed(1), core: +core.toFixed(1),
          ratio: +(rails / Math.max(core, 1e-3)).toFixed(3) });
      }
      x = e + 1;
    }
  }
  return { found: true, box: [bx0, by0, bx1, by1], clip, over200, peak,
    inkPixels: ink.length, sat: +sat.toFixed(3), bestRow, runs };
}

/* Offline mode. The frames are on disk; re-reading one costs nothing and does
 * not take the GPU lock away from the video agent. */
const OFFLINE = args.filter((a) => a.endsWith('.png'));
if (OFFLINE.length) {
  for (const f of OFFLINE) report1(f, measure(readPNG(f)));
  process.exit(0);
}

function report1(name, m) {
  if (!m.found) { console.log(`\n  ${name}: no clipped core to locate the sign by`); return; }
  console.log(`\n  ${name}   box ${m.box.join(',')}`);
  console.log(`    clipped white ${m.clip}   over 200 ${m.over200}   peak ${m.peak.join(',')}`);
  console.log(`    ink pixels ${m.inkPixels}   mean saturation ${m.sat}`);
  console.log(`    brightest row ${m.bestRow}, ${m.runs.length} stroke runs:`);
  for (const r of m.runs) {
    console.log(`      x=${String(r.x).padStart(4)} w=${String(r.w).padStart(3)}  `
      + `rails ${String(r.rails).padStart(6)}  core ${String(r.core).padStart(6)}  `
      + `rails/core ${r.ratio}  ${r.ratio > 1.05 ? 'TUBE' : r.ratio < 0.95 ? 'PANEL' : 'flat'}`);
  }
}

const outDir = path.join(ROOT, 'shots', tag);
fs.mkdirSync(outDir, { recursive: true });
const url = 'http://127.0.0.1:3000' + (QUERY ? '?' + QUERY : '');

await run({ width: W, height: H, url }, async ({ page, errs, readShaderErrors }) => {
  const report = { tag, when: new Date().toISOString(), query: QUERY, yaw: YAW, pitch: PITCH, views: [] };
  console.log(`  aiming at the store frontage: yaw ${YAW.toFixed(4)} pitch ${PITCH.toFixed(4)} at ${dist.toFixed(2)} m`);

  for (const v of VIEWS) {
    const got = await page.evaluate(([e, yaw, pitch, fov]) => {
      const s = window.__scene, wk = s.walker;
      wk.placeAt(0.5);
      wk.x = e.x; wk.z = e.z;
      wk.snapGround();
      wk.advanceGait(0);
      s.setYaw(yaw); s.setPitch(pitch);
      s.warp(1.2);
      s.setYaw(yaw); s.setPitch(pitch);
      s.camera.fov = fov; s.camera.updateProjectionMatrix();
      const p = s.camera.position;
      return { x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3) };
    }, [EYE, YAW, PITCH, v.fov]);
    await page.waitForTimeout(120);
    if (Math.hypot(got.x - EYE.x, got.z - EYE.z) > 0.05) {
      console.error(`  ✗ ${v.name}: camera did not land — asked ${EYE.x},${EYE.z} got ${got.x},${got.z}`);
      process.exitCode = 1;
    }

    const file = path.join(outDir, `${v.name}.png`);
    await capture(page, file);
    const m = measure(readPNG(file));
    report.views.push({ ...v, cam: got, ...m });
    report1(`${v.name}  fov ${v.fov}`, m);
  }

  report.shaderErrors = await readShaderErrors();
  report.errors = [...new Set(errs)];
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n  → ${path.relative(ROOT, outDir)}   shaderErrors=${report.shaderErrors.length}`);
});

finish(process.exitCode || 0);
