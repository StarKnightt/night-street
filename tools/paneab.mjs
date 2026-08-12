/* A shopfront pane, framed the same way twice, so a change to what the glass
 * reflects can be shown to have moved pixels.
 *
 *   node tools/withlock.mjs paneab -- node tools/paneab.mjs before
 *   ...edit...
 *   node tools/withlock.mjs paneab -- node tools/paneab.mjs after
 *   node tools/diffpng.mjs shots/pane/before.png shots/pane/after.png
 *
 * The camera is not typed in. `window.__shopLights` publishes each lit unit's
 * aperture — centre, outward normal, width, height — and the viewpoint is
 * derived from it: stand on the footway a fixed distance out along the normal,
 * at eye height, looking back at the centre of the glass. So the framing
 * follows the geometry rather than a coordinate that was true on the day it was
 * written, and the tool reports which unit it found and where it stood.
 *
 * The number it reports is the mean display value of the lower half of the
 * aperture, because that is where SHOP_GLASS_BODY's downward reflected rays
 * land — a ray leaving the lower part of a pane toward a camera above it came
 * from the footway and the carriageway, which is the branch under test. The
 * upper half is carried in the same run as the control: it is the same
 * material, the same pane and the same frame, and nothing being changed here
 * touches the rays that go up.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture, finish, DEV_URL } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = args[0] && !args[0].startsWith('--') ? args[0] : 'pane';
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const UNIT = +flag('unit', 0);
const STANDOFF = +flag('standoff', 3.0);
const W = +flag('w', 1200), H = +flag('h', 800);

const OUT = path.join(ROOT, 'shots/pane');
fs.mkdirSync(OUT, { recursive: true });

let report = null;

/* Two loads have to be comparable, and by default they are not. The grade adds
 * sensor grain, which is seeded per run and puts a mean delta of eight counts
 * over a tenth of the frame between two captures of an unchanged build — more
 * than anything measured here. `nograde` removes the grain, the vignette and
 * the defocus; `haze=nodust` removes the mote field, whose positions are drawn
 * per load; and freezing the System 5 clock stops the television and the
 * traffic signal, which are the other two things in frame that move. What is
 * left is deterministic, which is the only condition under which a difference
 * between two runs is a difference in the build. */
const url = `${DEV_URL}/?nograde&haze=nodust`;

await run({ width: W, height: H, url }, async ({ page, readShaderErrors }) => {
  const where = await page.evaluate(([unit, standoff]) => {
    const s = window.__scene;
    if (window.__sys5) window.__sys5.freeze(0);
    const lights = window.__shopLights || [];
    if (!lights.length) throw new Error('window.__shopLights is empty — no lit units published');
    const l = lights[Math.min(unit, lights.length - 1)];
    const w = s.walker;
    /* Stand still, at the bottom of the step. The head bob is scaled by a
     * smoothed speed that does not decay to zero in the two frames this tool
     * steps, so whatever the boot walk had reached when the harness attached
     * set the eye height — a centimetre either way, which tilts the camera by
     * a fraction of a degree and moves every pixel in the frame. Two captures
     * that differ everywhere cannot show that one term changed. */
    w.phase = 0;
    w.speed = 0;
    w.x = l.pos[0] + l.dir[0] * standoff;
    w.z = l.pos[2] + l.dir[2] * standoff;
    if (w.snapGround) w.snapGround();
    /* Yaw is measured the way walker measures it, from the same vector the
     * camera is built from, so this cannot disagree with where the camera
     * actually points: face back along the aperture normal. */
    w.yaw = Math.atan2(-l.dir[0], -l.dir[2]);
    w.update(1 / 240, { forward: 0, strafe: 0, sprint: false });
    /* Rig.apply is what actually moves the camera, and it runs inside
     * renderOnce. Reading camera.position before a draw reports where the
     * camera was for the *previous* frame — which here is wherever the walk
     * happened to have got to during boot, so the pitch derived from it was
     * different on every load and the two frames of an A/B were of two
     * different cameras. Draw first, then read, then aim, then draw again. */
    s.renderOnce();
    const eye = s.camera.position.y;
    w.pitch = Math.atan2(l.pos[1] - eye, standoff);
    w.update(1 / 240, { forward: 0, strafe: 0, sprint: false });
    s.renderOnce();
    return {
      kind: l.kind, aperture: l.pos, normal: l.dir, size: [l.width, l.height],
      units: lights.length,
      cam: [s.camera.position.x, s.camera.position.y, s.camera.position.z]
        .map((v) => +v.toFixed(2)),
    };
  }, [UNIT, STANDOFF]);

  await capture(page, path.join(OUT, `${tag}.png`), {});

  report = await page.evaluate(([unit]) => {
    const T3 = window.__THREE;
    const s = window.__scene;
    const l = (window.__shopLights || [])[unit];
    s.setPaused(true);
    s.renderOnce();
    const cv = s.renderer.domElement;
    const off = document.createElement('canvas');
    off.width = cv.width; off.height = cv.height;
    const ctx = off.getContext('2d');
    ctx.drawImage(cv, 0, 0);

    /* The aperture, projected, so the bands measured are the glass and not a
     * fraction of the viewport that happens to be over it today. */
    const cam = s.camera;
    const u = new T3.Vector3(0, 1, 0).cross(new T3.Vector3(...l.dir)).normalize();
    const corner = (su, sv) => {
      const p = new T3.Vector3(...l.pos)
        .addScaledVector(u, su * l.width * 0.5)
        .add(new T3.Vector3(0, sv * l.height * 0.5, 0));
      p.project(cam);
      return [(p.x * 0.5 + 0.5) * cv.width, (1 - (p.y * 0.5 + 0.5)) * cv.height];
    };
    const cs = [corner(-1, -1), corner(1, -1), corner(-1, 1), corner(1, 1)];
    const xs = cs.map((c) => c[0]), ys = cs.map((c) => c[1]);
    const x0 = Math.max(0, Math.round(Math.min(...xs))), x1 = Math.min(cv.width, Math.round(Math.max(...xs)));
    const y0 = Math.max(0, Math.round(Math.min(...ys))), y1 = Math.min(cv.height, Math.round(Math.max(...ys)));
    const band = (a, b) => {
      const yA = Math.round(y0 + (y1 - y0) * a), yB = Math.round(y0 + (y1 - y0) * b);
      const d = ctx.getImageData(x0, yA, Math.max(1, x1 - x0), Math.max(1, yB - yA)).data;
      let r = 0, g = 0, bl = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; bl += d[i + 2]; n++; }
      return { rgb: [r / n, g / n, bl / n].map((v) => +v.toFixed(2)), px: n };
    };
    s.setPaused(false);
    return {
      box: [x0, y0, x1, y1],
      /* A pane is vertical, so reflection preserves the vertical component of
       * the view ray: the part of the glass below the camera's own eye height
       * is the part showing the ground, and that is the branch under test. Eye
       * height is 1.64 and the aperture runs 0.95 to 3.33, which puts the
       * crossing at 0.71 of the way down the box. The band stops short of the
       * bottom because the published aperture rectangle runs past the glass
       * into the stall riser and the footway. */
      lower: band(0.71, 0.92),
      /* The control: glass in the same pane, same material, same frame, above
       * eye height, where every reflected ray goes up into the frontage
       * opposite and nothing under test can reach it. */
      upper: band(0.15, 0.45),
    };
  }, [UNIT]);

  const errs = await readShaderErrors();
  console.log(errs.length ? `\n  SHADER ERRORS: ${errs.length}` : '  shader errors: none');
  for (const e of errs) console.log(`    ${String(e).slice(0, 200)}`);

  console.log(`\n  unit ${UNIT} of ${where.units}, kind "${where.kind}"`);
  console.log(`  aperture at ${where.aperture.map((v) => v.toFixed(2)).join(', ')}`
    + `  ${where.size.map((v) => v.toFixed(2)).join(' x ')} m`);
  console.log(`  camera at ${where.cam.join(', ')}`);
  console.log(`  pane box on screen ${report.box.join(', ')}`);
  console.log(`  lower half (under test)  ${report.lower.rgb.join(' ')}   ${report.lower.px} px`);
  console.log(`  upper half (control)     ${report.upper.rgb.join(' ')}   ${report.upper.px} px`);
  console.log(`  written: shots/pane/${tag}.png\n`);
});

finish(0);
