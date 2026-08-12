/* A repeatable close framing on one parked car, at delivery resolution.
 *
 * shoot.mjs frames from the route's own stops, which is the right instrument
 * for judging a composition and the wrong one for judging a wheel arch: the
 * defects being worked on here are 100-200 px features and they have to be
 * shot at the size the delivered file shows them at, from the same place
 * every run, before and after a change.
 *
 * The camera is placed by writing the walker's own x/z and then going through
 * setYaw, which is the call that syncs the derived eye — the same path
 * shoot.mjs uses, so nothing here is a second opinion about where the camera
 * is.
 *
 *   node tools/withlock.mjs carshot -- node tools/carshot.mjs before
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = args[0] && !args[0].startsWith('--') ? args[0] : 'carshot';
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const W = +flag('w', 1920), H = +flag('h', 1080);
const JS = flag('js', '');
/* Shoot a subset. The five close crops are the regression set and are worth
 * having, but re-aiming a new framing costs two runs of the whole list if there
 * is no way to ask for one of them. */
const ONLY = flag('only', '');

/* Each entry is a place a critic named. `I*` are the sunlit hatch on the far
 * kerb at z = -76.3 — the car the final cut turned away from and the one both
 * reviews single out; `C*` is the hero estate at -42.6, the nearest car on the
 * near kerb. Distances are chosen to put the wheel and the mirror at the
 * apparent size the review quotes them at (a wheel about 200 px, a mirror
 * about 120). */
const VIEWS = [
  // The sunlit hatch's front wheel arch, from the carriageway, 4.5 m out.
  { name: 'I-arch', x: -0.30, z: -70.6, yaw: -0.30, pitch: -0.16 },
  // The same car's flank against the lit road: the silhouette edge.
  { name: 'I-flank', x: -1.10, z: -71.8, yaw: -0.34, pitch: -0.10 },
  // Its door mirror, near enough to read as two boxes.
  { name: 'I-mirror', x: -0.10, z: -73.2, yaw: -0.52, pitch: -0.04 },
  // The hero estate's tail: the cluster, and its nearside rear wheel.
  { name: 'C-tail', x: -0.55, z: -39.4, yaw: 3.02, pitch: -0.14 },
  // The hero estate's front wheel and flank, walking past it.
  { name: 'C-arch', x: -0.35, z: -41.2, yaw: 3.32, pitch: -0.17 },
  /* Two whole-car framings, which the close crops above cannot answer: the test
   * for the away-facing lift is whether the car reads as one object under two
   * lights, and that is a question about the whole body in frame with its own
   * sunlit flank beside its own shaded tail. Both are far enough back to hold
   * all 4.6 m of the estate. */
  { name: 'C-3q', x: 1.55, z: -37.15, yaw: 0.5865, pitch: -0.127 },
  { name: 'C-rake', x: 0.30, z: -36.00, yaw: 0.3088, pitch: -0.129 },
];

const outDir = path.join(ROOT, 'shots', tag);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await run({ width: W, height: H }, async ({ page, errs, readShaderErrors }) => {
  if (JS) await page.evaluate((js) => { new Function('s', js)(window.__scene); }, JS);
  for (const v of VIEWS) {
    if (ONLY && !v.name.includes(ONLY)) continue;
    const got = await page.evaluate((v) => {
      const s = window.__scene;
      s.goTo(0.5);
      s.walker.x = v.x; s.walker.z = v.z;
      s.walker.snapGround?.();
      s.setPitch(v.pitch);
      s.setYaw(v.yaw);          // setYaw applies, so it goes last
      s.warp(2.0);
      s.setYaw(v.yaw);
      const p = s.camera.position;
      return [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)];
    }, v);
    await page.waitForTimeout(150);
    await capture(page, path.join(outDir, `${v.name}.png`));
    console.log(`  ${v.name.padEnd(9)} eye ${got.join(', ')}`);
  }
  const shader = await readShaderErrors();
  console.log(`  shader errors: ${JSON.stringify(shader)}`);
  console.log(`  page errors:   ${JSON.stringify(errs)}`);
});
