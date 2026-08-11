/* Is the shop interior's emissive path live, and where on screen is it?
 *
 * Two questions that a still cannot answer and a difference can. `__litGain`
 * is the uniform every interior emissive term is multiplied by, so setting it
 * to zero and to four and differencing the two frames does three things at
 * once: it proves the branch is reached at all — the failure mode NOTES.md
 * calls out, where code that looks correct is silently inert — it produces an
 * exact mask of which pixels are interior, which is otherwise guesswork behind
 * a reflective pane, and it gives the value at those pixels with everything
 * else in the frame held frozen.
 *
 * One browser, one lock slot, one frozen world state, several gains. The pair
 * discipline in TECHNIQUE.md §7 is the point: two frames set up from scratch
 * are two different worlds and differencing them measures the difference
 * between the worlds.
 *
 *   node tools/withlock.mjs litprobe -- node tools/litprobe.mjs \
 *        --t 0.2 --yaw 0.486 --fov 20 --gains 0,1.35,4
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture, finish } from './harness.mjs';
import { invertRGB } from './pxrgb.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

const TAG = flag('tag', 'lit');
const T = +flag('t', 0.2);
const YAW = +flag('yaw', 0.486);
const PITCH = +flag('pitch', 0);
const FOV = +flag('fov', 20);
const GAINS = flag('gains', '0,1.35,4').split(',').map(Number);
const W = +flag('w', 1600), H = +flag('h', 900);

const outDir = path.join(ROOT, 'shots', TAG);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await run({ width: W, height: H }, async ({ page, errs, readShaderErrors }) => {
  const ok = await page.evaluate(() => !!window.__litGain);
  if (!ok) {
    console.error('✗ window.__litGain is not published. StreetLevel.tsx exposes it in dev only.');
    finish(1);
  }

  await page.evaluate(([t, yaw, pitch, fov]) => {
    const s = window.__scene;
    s.camera.fov = fov; s.camera.updateProjectionMatrix();
    s.goTo(t); s.setYaw(yaw); s.setPitch(pitch); s.warp(2.0);
    // Off the wall clock, so the dust and the shadow follower are in the same
    // place in every frame of the set and the difference is the gain alone.
    s.setDriven(true);
  }, [T, YAW, PITCH, FOV]);
  await page.waitForTimeout(250);

  const frames = [];
  for (const g of GAINS) {
    await page.evaluate((g) => { window.__litGain.value = g; window.__scene.step(0); }, g);
    const file = path.join(outDir, `g${String(g).replace('.', 'p')}.png`);
    await capture(page, file);
    frames.push({ g, file });
    console.log(`  gain ${g}  ->  ${path.relative(ROOT, file)}`);
  }
  // Leave it as we found it, in case another tool shares this page.
  await page.evaluate(() => { window.__litGain.value = 1.35; });

  const shaderErrors = await readShaderErrors();
  fs.writeFileSync(path.join(outDir, 'report.json'),
    JSON.stringify({ tag: TAG, t: T, yaw: YAW, fov: FOV, gains: GAINS, errors: [...new Set(errs)], shaderErrors }, null, 2));
  if (shaderErrors.length) console.error(`\n  ✗ ${shaderErrors.length} shader error(s) — see report.json`);
});

/* ── The difference, off disk ─────────────────────────────────────────── */
const { readPNG } = await import('./pxfile.mjs');
const imgs = GAINS.map((g) => readPNG(path.join(outDir, `g${String(g).replace('.', 'p')}.png`)));
const lo = imgs[0], hi = imgs[imgs.length - 1];

let moved = 0;
const hits = [];
for (let y = 0; y < lo.h; y += 2) {
  for (let x = 0; x < lo.w; x += 2) {
    const i = (y * lo.w + x) * 4;
    const d = Math.abs(hi.data[i] - lo.data[i]) + Math.abs(hi.data[i + 1] - lo.data[i + 1]);
    if (d > 12) { moved++; hits.push([x, y, d]); }
  }
}
console.log(`\n  gain ${GAINS[0]} -> ${GAINS[GAINS.length - 1]}: ${moved} sampled pixels moved by >12 counts`
  + `  (${((100 * moved * 4) / (lo.w * lo.h)).toFixed(2)}% of frame)`);
if (!moved) {
  console.error('  ✗ NOTHING MOVED. The interior emissive path is inert.');
  process.exitCode = 1;
} else {
  // The strongest movers are the interior; report them at every gain so the
  // level can be read against the prediction in tools/interior.mjs.
  hits.sort((a, b) => b[2] - a[2]);
  const picked = [];
  for (const [x, y] of hits) {
    if (picked.every(([px, py]) => Math.abs(px - x) > 40 || Math.abs(py - y) > 40)) picked.push([x, y]);
    if (picked.length === 6) break;
  }
  console.log('\n  the interior, at each gain (5x5 mean, then the linear radiance it inverts to)\n');
  console.log('  point         ' + GAINS.map((g) => `gain ${g}`.padEnd(30)).join(''));
  for (const [x, y] of picked) {
    const row = imgs.map((img) => {
      let r = 0, g2 = 0, b = 0, n = 0;
      for (let yy = y - 2; yy <= y + 2; yy++) for (let xx = x - 2; xx <= x + 2; xx++) {
        if (xx < 0 || yy < 0 || xx >= img.w || yy >= img.h) continue;
        const i = (yy * img.w + xx) * 4;
        r += img.data[i]; g2 += img.data[i + 1]; b += img.data[i + 2]; n++;
      }
      const code = [r / n, g2 / n, b / n];
      const L = invertRGB(code).L;
      return `${code.map((c) => c.toFixed(0).padStart(4)).join('')} L${L[0].toFixed(3).padStart(7)}  `;
    });
    console.log(`  ${String(x + ',' + y).padEnd(12)}  ${row.join('')}`);
  }
  console.log('');
}
finish(process.exitCode || 0);
