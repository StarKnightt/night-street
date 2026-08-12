/* Does the liveness guard actually catch the bug it was written for?
 *
 *   node tools/withlock.mjs livetest -- node tools/livenesstest.mjs
 *
 * A guard that has never been shown to fire is a guard that reads correct,
 * which is the failure mode this whole file is a response to — `NOTES.md`
 * records a footway sweep that "went green" because a booking rule had refused
 * every prop on the street, and calls it "this codebase's signature failure
 * wearing a new hat". So the check gets a check.
 *
 * Three captures, one page load, one camera:
 *
 *   control      nothing touched. Must pass.
 *   stale box    the shadow box pinned to the walk's origin inside the same
 *                task as the draw, which is bit-for-bit what every pre-0a4f58b
 *                still did. Must fail, and must name the shadow box.
 *   stale uCam   a Vector3 uniform called `uCam` planted on a scene material
 *                holding a camera position from 40 m up the street. This is
 *                the *first* instance of the class, from NOTES.md, reproduced
 *                deliberately — the guard has to catch the shape and not just
 *                the one member of it that was fixed last.
 *
 * Exits non-zero unless the control passes and both deliberate instances are
 * caught by the check that is supposed to catch them.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, finish, capture, livenessFailures } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tmp/livenesstest');

/* Pinning through the follower's own published control rather than by writing
 * a position, so this test transcribes none of Street.tsx's arrangement and
 * keeps working if any of it changes. */
const STALE_BOX = 'window.__sunFollow.pin(window.__liveTestOrigin[0], window.__liveTestOrigin[2]);';

const STALE_UCAM = `
  var T = window.__THREE, planted = false;
  s.scene.traverse(function (o) {
    if (planted || !o.isMesh || !o.material || !o.material.uniforms) return;
    o.material.uniforms.uCam = { value: new T.Vector3(0, 1.65, 4) };
    window.__liveTestPlanted = (o.name || o.type) + '/' + (o.material.name || o.material.type);
    planted = true;
  });
`;

const seen = {};

await run({ width: 640, height: 360 }, async ({ page }) => {
  await page.waitForFunction(() => !!window.__scene && !!window.__sunFollow, null, { timeout: 120_000 });

  /* The origin is read, not typed: it is where the camera sits before anything
   * teleports it, which is the placement every pre-fix still inherited. */
  const origin = await page.evaluate(() => {
    const p = window.__scene.camera.position;
    window.__liveTestOrigin = [p.x, p.y, p.z];
    return [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)];
  });

  await page.evaluate(() => { const s = window.__scene; s.goTo(0.4); s.setYaw(0); s.setPitch(0); s.warp(2.0); });
  await page.waitForTimeout(250);
  const cam = await page.evaluate(() => {
    const p = window.__scene.camera.position;
    return [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)];
  });
  console.log(`\n  camera under test  ${cam.join(', ')}`);
  console.log(`  stale anchor       ${origin.join(', ')}   (the walk's origin, read off the page)`);

  for (const [name, before] of [['control', ''], ['stale-box', STALE_BOX], ['stale-ucam', STALE_UCAM]]) {
    const had = livenessFailures.length;
    await capture(page, path.join(OUT, `${name}.png`), { before });
    seen[name] = livenessFailures.slice(had);
    // Put the scene back before the next animation frame can bake anything in.
    await page.evaluate(() => {
      window.__sunFollow.release();
      window.__scene.scene.traverse((o) => {
        if (o.material && o.material.uniforms) delete o.material.uniforms.uCam;
      });
    });
    await page.waitForTimeout(200);
  }
  seen.planted = await page.evaluate(() => window.__liveTestPlanted || null);
});

/* ── verdict ─────────────────────────────────────────────────────────────── */

const named = (rows, check) => rows.some((r) => r.failures.some((f) => f.name === check));
let bad = 0;
const say = (ok, text) => { if (!ok) bad++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${text}`); };

console.log('\n  ── what the guard reported');
for (const name of ['control', 'stale-box', 'stale-ucam']) {
  const rows = seen[name] || [];
  const names = rows.flatMap((r) => r.failures.map((f) => f.name));
  console.log(`    ${name.padEnd(11)} ${rows.length} failing capture(s)` +
    (names.length ? `  [${[...new Set(names)].join('; ')}]` : ''));
  for (const r of rows) {
    for (const f of r.failures) {
      const { name: n, ok, ...rest } = f;
      console.log(`                  ${n}: ${JSON.stringify(rest)}`);
    }
  }
}

console.log(`\n  planted uCam on: ${seen.planted || '(nothing — no ShaderMaterial found)'}`);
console.log('\n  ── verdict');
say((seen.control || []).length === 0, 'the control capture passes');
say(named(seen['stale-box'] || [], 'sun shadow box'),
  'a shadow box pinned 39 m behind the camera is caught, by name');
say(named(seen['stale-box'] || [], 'camera inside shadow frustum'),
  'and the independent frustum test catches it too');
say(named(seen['stale-ucam'] || [], 'camera-position uniforms'),
  'a planted stale uCam uniform is caught — the first instance of the class');

console.log(bad
  ? `\n✗ the guard did not catch ${bad} of the cases it exists for.`
  : '\n✓ the guard fires on every deliberate instance and not on the control.');
await finish(bad ? 1 : 0);
