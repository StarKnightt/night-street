/* The same collider, in the page, on both paths.
 *
 *   node tools/collidelive.mjs
 *
 * `tools/collide.mjs` drives the `Walker` class directly and proves the solver
 * is right. It cannot prove the *scene* uses it, and this project's most
 * expensive class of bug is exactly that gap: a mote field positioned from a
 * uniform that was only ever written from `useFrame` sat 32 m behind the
 * camera in every capture ever reviewed, while the interactive walk looked
 * perfect, because a capture teleports and renders inside one synchronous
 * evaluation and no animation frame runs in between.
 *
 * So this checks the three paths a camera can move along in this scene, and
 * checks them against each other rather than against an opinion:
 *
 *   driven       `setDriven(true)` and `step(dt)`, which is what reel.mjs
 *                uses and what the deliverable video is recorded through.
 *   interactive  the wall-clock r3f loop with a real keydown in it, which is
 *                what the user has.
 *   teleport     `goTo(t)`, which is synchronous and renders immediately,
 *                and which shoot.mjs's six stops go through.
 *
 * The strong test is that the first two come to rest in the same place. A
 * walker pressed into the flank of a car settles at a static equilibrium, and
 * an equilibrium does not depend on the frame rate or on how the frames were
 * produced — so if the two paths disagree by more than the solver's own skin,
 * one of them is not running the collider.
 */
import { run, finish, DEV_URL } from './harness.mjs';
import { acquire, release } from './lock.mjs';
import { register } from 'node:module';

register('./ts-hooks.mjs', import.meta.url);
const { nearest, BODY_R, groundHeight } = await import('../src/scene/collide.ts');
const { DIMS } = await import('../src/world/dims.ts');

const mm = (m) => (m * 1000).toFixed(2);
let bad = 0;
const check = (ok, msg) => { console.log(`    ${ok ? '✓' : '✗'} ${msg}`); if (!ok) bad++; };

await acquire('collidelive');

await run({ width: 640, height: 360, url: DEV_URL }, async ({ page, errs, gl, readShaderErrors }) => {
  console.log(`\n  adapter: ${gl.renderer}\n`);

  /* ── 1. Driven: straight into the flank of the hatch at z = -25.40 ────── */

  const driven = await page.evaluate(async () => {
    const s = window.__scene;
    s.goTo(0);
    s.walker.x = -1.945; s.walker.z = -18.0;
    s.walker.snapGround();
    s.setYaw(0); s.setPitch(-0.12);
    s.warp(1.0);
    s.setDriven(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
    const rows = [];
    for (let f = 0; f < 300; f++) {
      s.step(1 / 30);
      const w = s.walker, c = s.camera.position;
      rows.push({
        x: +w.x.toFixed(6), z: +w.z.toFixed(6),
        ey: +w.eye.y.toFixed(6), cy: +c.y.toFixed(6), cz: +c.z.toFixed(6),
        g: +w.groundY.toFixed(6), v: +w.speed.toFixed(5), hit: w.contact,
      });
    }
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }));
    s.setDriven(false);
    return rows;
  });

  const dEnd = driven[driven.length - 1];
  const dClear = nearest(dEnd.x, dEnd.z).d;
  console.log('  DRIVEN — 10 s of KeyW straight at the hatch, stepped by hand');
  console.log(`    rests at ${dEnd.x.toFixed(4)}, ${dEnd.z.toFixed(4)}, clearance ${mm(dClear)} mm, speed ${dEnd.v}`);
  check(Math.abs(dClear - BODY_R) < 0.001, `stopped one body radius off the car (${mm(dClear - BODY_R)} mm over)`);
  /* The camera against the walker, every frame. This is the stale-value test:
   * if `apply()` ever ran before the walker updated, or from a different
   * frame, it would show here and nowhere else. */
  let camErr = 0;
  for (const r of driven) camErr = Math.max(camErr, Math.abs(r.cy - r.ey));
  check(camErr < 1e-5, `the camera tracks the eye to ${mm(camErr)} mm on every driven frame`);

  /* ── 2. Interactive: the wall-clock loop, with a real key ─────────────── */

  const live = await page.evaluate(async () => {
    const s = window.__scene;
    s.walker.x = -1.945; s.walker.z = -18.0;
    s.walker.yaw = 0; s.walker.speed = 0;
    s.walker.snapGround();
    await new Promise((r) => setTimeout(r, 100));
    return { x: s.walker.x, z: s.walker.z };
  });
  await page.keyboard.down('KeyW');
  await new Promise((r) => setTimeout(r, 11000));
  const liveEnd = await page.evaluate(() => {
    const w = window.__scene.walker, c = window.__scene.camera.position;
    return {
      x: w.x, z: w.z, ey: w.eye.y, cy: c.y, v: w.speed, hit: w.contact,
      fps: window.__scene.fps,
    };
  });
  await page.keyboard.up('KeyW');

  const lClear = nearest(liveEnd.x, liveEnd.z).d;
  console.log(`\n  INTERACTIVE — the same 11 s on the wall clock at ${liveEnd.fps.toFixed(0)} fps`);
  console.log(`    started at ${live.x.toFixed(2)}, ${live.z.toFixed(2)}`);
  console.log(`    rests at ${liveEnd.x.toFixed(4)}, ${liveEnd.z.toFixed(4)}, clearance ${mm(lClear)} mm, speed ${liveEnd.v.toFixed(5)}`);
  check(Math.abs(lClear - BODY_R) < 0.001, `stopped one body radius off the car (${mm(lClear - BODY_R)} mm over)`);
  const agree = Math.hypot(liveEnd.x - dEnd.x, liveEnd.z - dEnd.z);
  console.log(`\n  the two paths come to rest ${mm(agree)} mm apart`);
  check(agree < 0.002, 'driven and interactive resting places agree');
  check(Math.abs(liveEnd.cy - liveEnd.ey) < 1e-5, 'the camera tracks the eye on the live loop too');

  /* ── 3. The kerb, on both paths ───────────────────────────────────────── */

  const kerbDriven = await page.evaluate(async () => {
    const s = window.__scene;
    s.walker.x = 2.2; s.walker.z = -30.0; s.walker.speed = 0;
    s.walker.yaw = -Math.PI / 2 + 1.05;
    s.walker.snapGround();
    s.setDriven(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
    const rows = [];
    for (let f = 0; f < 90; f++) {
      s.step(1 / 30);
      rows.push({ x: s.walker.x, z: s.walker.z, g: s.walker.groundY, cy: s.camera.position.y });
    }
    /* Then stand still for a second. The footway settles per flag and the kerb
     * per stone, so the surface under a walker in motion is itself moving by
     * millimetres and "is the eye on the ground" is not a question with a
     * sharp answer while it is. Stopped, it is. */
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }));
    for (let f = 0; f < 30; f++) {
      s.step(1 / 30);
      rows.push({ x: s.walker.x, z: s.walker.z, g: s.walker.groundY, cy: s.camera.position.y, still: true });
    }
    s.setDriven(false);
    return rows;
  });

  const before = kerbDriven.filter((r) => Math.abs(r.x) < DIMS.roadHalf).pop();
  const after = kerbDriven.filter((r) => !r.still).pop();
  const still = kerbDriven[kerbDriven.length - 1];
  console.log('\n  KERB — the same crossing, driven at 30 Hz');
  console.log(`    road   x ${before.x.toFixed(3)}  ground ${mm(before.g)} mm  camera y ${after.cy.toFixed(4)}`);
  console.log(`    footway x ${after.x.toFixed(3)}  ground ${mm(after.g)} mm`);
  console.log(`    the eye rose ${mm(after.g - before.g)} mm across a kerb the geometry puts at ` +
    `${mm(groundHeight(after.x, after.z) - groundHeight(before.x, before.z))} mm`);
  console.log(`    stopped, the eye sits ${mm(still.g - groundHeight(still.x, still.z))} mm off the surface`);
  check(Math.abs(still.g - groundHeight(still.x, still.z)) < 0.0005,
    'stood still on the footway, the eye is exactly on the ground');
  /* Frame to frame, so the step cannot have been a teleport that happened to
   * land in the right place. */
  let jump = 0, jumpAt = 0;
  for (let i = 1; i < kerbDriven.length; i++) {
    const d = Math.abs(kerbDriven[i].g - kerbDriven[i - 1].g);
    if (d > jump) { jump = d; jumpAt = i; }
  }
  console.log(`    largest single-frame rise ${mm(jump)} mm, at frame ${jumpAt} of 90`);
  check(jump < 0.030, 'no frame teleports the camera up the kerb');
  check(jump > 0.008, 'the kerb is a step rather than a ramp');

  /* ── 4. The synchronous path: goTo, which shoot.mjs uses ──────────────── */

  console.log('\n  TELEPORT — goTo() and read the camera in the same evaluation');
  const stops = await page.evaluate(() => {
    const s = window.__scene;
    const out = [];
    for (const t of [0.02, 0.2, 0.4, 0.6, 0.8, 0.95]) {
      s.goTo(t);
      out.push({ t, x: s.walker.x, z: s.walker.z, cy: s.camera.position.y, g: s.walker.groundY });
    }
    return out;
  });
  let worstStop = 0;
  for (const st of stops) {
    const g = groundHeight(st.x, st.z);
    worstStop = Math.max(worstStop, Math.abs(st.g - g));
    console.log(`    t ${st.t.toFixed(2)}  x ${st.x.toFixed(2)} z ${st.z.toFixed(1)}  camera y ${st.cy.toFixed(4)}  ground ${mm(st.g)} mm`);
  }
  check(worstStop < 1e-4, `every stop lands on the ground in one synchronous call (${mm(worstStop)} mm out)`);

  /* Inside a van, on purpose. A stop in a table has no idea what is parked
   * there, and this is the path that would otherwise photograph an interior. */
  const rescued = await page.evaluate(() => {
    const s = window.__scene;
    s.walker.placeAt(0);
    s.walker.x = -1.75; s.walker.z = -63.10;      // the middle of the van
    const before = { x: s.walker.x, z: s.walker.z };
    s.walker.update(1 / 60, { forward: 0, strafe: 0 });
    return { before, after: { x: s.walker.x, z: s.walker.z } };
  });
  const rClear = nearest(rescued.after.x, rescued.after.z).d;
  console.log(`\n    dropped inside the van at ${rescued.before.x}, ${rescued.before.z} (949 mm inside):`);
  console.log(`      one frame later, at ${rescued.after.x.toFixed(3)}, ${rescued.after.z.toFixed(3)}, clearance ${mm(rClear)} mm`);
  check(rClear >= BODY_R - 0.0005, 'a walker dropped inside a solid is pushed clear of it');

  /* ── 5. What it costs ─────────────────────────────────────────────────── */

  const cost = await page.evaluate(() => {
    const w = window.__scene.walker;
    const inp = { forward: 1, strafe: 0, sprint: false };
    const spot = (x, z, yaw) => {
      w.x = x; w.z = z; w.yaw = yaw; w.speed = 1.4; w.snapGround();
      for (let i = 0; i < 200; i++) w.update(1 / 60, inp);        // warm
      const t0 = performance.now();
      for (let i = 0; i < 20000; i++) { w.x = x; w.z = z; w.update(1 / 60, inp); }
      return (performance.now() - t0) / 20000;
    };
    return {
      open: spot(0.4, -20, 0),
      contact: spot(-1.945, -25.4 + 2.4, Math.PI),
      wedge: spot(-4.6, -69.5, 1.2),
    };
  });
  console.log('\n  COST — one walker.update(), microseconds');
  for (const [k, v] of Object.entries(cost)) {
    console.log(`    ${k.padEnd(9)} ${(v * 1000).toFixed(2)} us   ${(v / (1000 / 135) * 100).toFixed(3)}% of a 135 fps frame`);
  }
  check(cost.wedge < 0.05, 'the solver costs less than a twentieth of a millisecond in the worst place');

  const shaderErrors = await readShaderErrors();
  if (shaderErrors.length) { console.log(`\n  ✗ ${shaderErrors.length} shader errors`); bad += shaderErrors.length; }
  if (errs.length) console.log(`\n  page errors: ${[...new Set(errs)].join(' | ')}`);
});

release();
console.log(bad ? `\n  ${bad} FAILURES\n` : '\n  all clear\n');
finish(bad ? 1 : 0);
