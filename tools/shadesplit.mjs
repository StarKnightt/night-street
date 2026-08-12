/* What is actually lighting a surface: sun, sky, or neither.
 *
 *   node tools/shadesplit.mjs [--out tmp/shade]
 *
 * The question this exists to answer is the one that cannot be settled from a
 * screenshot: an object can be the wrong colour because its albedo is wrong,
 * or because one of the three terms lighting it is missing, and those two
 * look identical in a still. A bollard lit by sky alone and a bollard painted
 * blue are the same pixels.
 *
 * So the frame is rendered four times from one camera with the rig switched
 * about, and the same 5x5 boxes are read out of each:
 *
 *   full     everything
 *   noSun    the directional light at zero
 *   noEnv    scene.environment detached, ambient and hemisphere at zero
 *   neither  both
 *
 * direct sun  = full - noSun
 * sky / IBL   = full - noEnv
 * everything else (bounce, emissive, the shop interiors) = neither
 *
 * Those subtractions are only physical if the numbers being subtracted are
 * radiance, so the probe puts the renderer into NoToneMapping at a fixed
 * exposure and loads the page with `?nograde`. AgX and the ASC grade are both
 * strongly non-linear in exactly the range this is measuring, and differencing
 * display values through them gives a number that is not the sun's
 * contribution to anything. The exposure is dropped well below the shipped one
 * so that sunlit paving does not clip, since a clipped sample subtracts to
 * zero and would read as a missing light.
 *
 * Nothing here is committed to the running scene: every mutation is made
 * against `window.__scene` inside the page and dies with the tab. The shipped
 * tonemapping, exposure and grade are untouched on disk.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { run, finish, DEV_URL } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const OUT = path.join(ROOT, flag('out', 'tmp/shade'));
const EXPOSURE = +flag('exposure', 0.06);
fs.mkdirSync(OUT, { recursive: true });

/* The subject: the bollard on the east footway at (3.968, -37.53), which
 * `tmp/sunlit.mjs` picks out as standing inside sun band 1 — the stretch of
 * carriageway from z -49 to -32 that `world/block.ts` leaves open to the disc.
 * The camera is 3.8 m from it on a 20 degree lens so that it fills the middle
 * of the frame, and the paving sample is taken from the same flag it is
 * standing on, a little to the side of its own shadow. */
const EYE = [1.6, -34.6];
const YAW = -0.6797;
const PITCH = -0.2965;
/* Wide enough that the frame holds sunlit paving, shaded paving and several
 * props at once, because the comparison the critique asks for is between
 * surfaces in the same light and the only way to guarantee that is to have
 * them in the same frame. */
const FOV = +flag('fov', 34);
const W = 900, H = 600;

/* Regions are found rather than typed in.
 *
 * The first cut of this probe hand-picked four boxes as frame fractions, and
 * every one of them missed: the camera was not where the placement code said
 * it would be, all four samples landed on shaded paving, and the probe
 * reported that the sun contributes nothing to anything — including to
 * surfaces nobody has ever doubted. A pixel coordinate written before the
 * frame exists is a guess, and a guess that lands wrong produces a number
 * with the shape of a finding.
 *
 * So a fifth render is taken with the prop group hidden. Pixels that change
 * between it and `full` are prop pixels, by construction. Everything else in
 * the lower half of the frame is street. Both sets are then split by whether
 * the sun reaches them at all, which the sun toggle already answers per pixel,
 * and the four aggregates are what get reported: sunlit props against sunlit
 * street, shaded props against shaded street, in the same frame.
 */
const PROP_DELTA = 0.004;   // linear radiance change that counts as "a prop is here"
const SUNLIT = 0.02;        // direct-sun radiance above which a pixel is in the beam

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** The whole frame as scene radiance, one Float32Array of RGB per pixel. */
async function radiance(file) {
  const img = sharp(file);
  const { width, height } = await img.metadata();
  const data = await img.raw().toBuffer();
  const ch = data.length / (width * height);
  const out = new Float32Array(width * height * 3);
  for (let p = 0; p < width * height; p++) {
    for (let c = 0; c < 3; c++) {
      out[p * 3 + c] = srgbToLinear(data[p * ch + c] / 255) / EXPOSURE;
    }
  }
  return { width, height, px: out };
}

const fmt = (v) => v.map((c) => c.toFixed(3).padStart(7)).join(' ');
const lum = (v) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];

const url = `${DEV_URL}/?nograde`;
const shots = {};

await run({ width: W, height: H, url }, async ({ page, readShaderErrors }) => {
  const where = await page.evaluate(([eye, yaw, pitch, fov, exposure]) => {
    const s = window.__scene;
    const w = s.walker;
    w.x = eye[0]; w.z = eye[1];
    if (w.snapGround) w.snapGround();
    w.yaw = yaw; w.pitch = pitch;
    /* One zero-input update before pausing.
     *
     * `Rig.apply` positions the camera from `walker.eye`, and `eye` is only
     * recomputed inside `walker.update`. Setting x and z and pausing leaves
     * the camera wherever it was, which is how the first run of this probe
     * came back with four samples of shaded paving and a confident report
     * that the sun reaches nothing. */
    w.update(1 / 240, { forward: 0, strafe: 0, sprint: false });
    s.setPaused(true);
    s.camera.fov = fov;
    s.camera.updateProjectionMatrix();
    // NoToneMapping is 0 in three's enum; spelled numerically so the probe does
    // not have to import three into the page.
    s.renderer.toneMapping = 0;
    s.renderer.toneMappingExposure = exposure;
    /* Find the rig once and stash it, so the four variants below are switching
     * the same objects rather than re-searching a scene whose contents the
     * toggles have changed. */
    const rig = { sun: null, ambient: [], env: s.scene.environment };
    s.scene.traverse((o) => {
      if (o.isDirectionalLight && o.castShadow && !rig.sun) rig.sun = o;
      if (o.isAmbientLight || o.isHemisphereLight) rig.ambient.push(o);
    });
    rig.sunI = rig.sun ? rig.sun.intensity : 0;
    rig.ambI = rig.ambient.map((l) => l.intensity);
    rig.props = [];
    s.scene.traverse((o) => { if (o.name === 'props') rig.props.push(o); });
    window.__rig = rig;
    s.renderOnce();
    const c = s.camera.position;
    return {
      sun: rig.sun ? rig.sun.intensity : null,
      ambient: rig.ambI,
      env: !!rig.env,
      groups: rig.props.length,
      cam: [c.x.toFixed(2), c.y.toFixed(2), c.z.toFixed(2)],
    };
  }, [EYE, YAW, PITCH, FOV, EXPOSURE]);
  console.log(`\n  rig: sun ${where.sun}, ambient/hemi [${where.ambient}], environment ${where.env}`);
  console.log(`  camera at ${where.cam.join(', ')}, prop groups found ${where.groups}\n`);
  if (!where.groups) throw new Error('no group named "props" in the scene');

  for (const variant of ['full', 'noSun', 'noEnv', 'neither', 'propsOff']) {
    /* Toggle, render and read the buffer inside one evaluate. The context is
     * not created with preserveDrawingBuffer, so anything that yields between
     * the draw and the read gets a cleared canvas — which is how a probe like
     * this reports every surface as black and concludes the sun is missing
     * from all of them. `harness.capture` does the same thing for the same
     * reason. */
    const data = await page.evaluate((v) => {
      const s = window.__scene, rig = window.__rig;
      const sun = v !== 'noSun' && v !== 'neither';
      const env = v !== 'noEnv' && v !== 'neither';
      if (rig.sun) rig.sun.intensity = sun ? rig.sunI : 0;
      rig.ambient.forEach((l, i) => { l.intensity = env ? rig.ambI[i] : 0; });
      s.scene.environment = env ? rig.env : null;
      rig.props.forEach((g) => { g.visible = v !== 'propsOff'; });
      s.renderOnce();
      return s.renderer.domElement.toDataURL('image/png');
    }, variant);
    const file = path.join(OUT, `${variant}.png`);
    fs.writeFileSync(file, Buffer.from(data.split(',')[1], 'base64'));
    shots[variant] = await radiance(file);
  }

  const errs = await readShaderErrors();
  if (errs.length) {
    console.log(`\n  SHADER ERRORS: ${errs.length}`);
    for (const e of errs) console.log(`    ${String(e).slice(0, 200)}`);
  } else {
    console.log('  shader errors: none');
  }
});

/* ── Aggregate ───────────────────────────────────────────────────────────── */

const { width, height } = shots.full;
const bins = {
  'props, sunlit': [], 'props, shaded': [],
  'street, sunlit': [], 'street, shaded': [],
};
for (let p = 0; p < width * height; p++) {
  const i = p * 3;
  const f = [shots.full.px[i], shots.full.px[i + 1], shots.full.px[i + 2]];
  const ns = [shots.noSun.px[i], shots.noSun.px[i + 1], shots.noSun.px[i + 2]];
  const ne = [shots.noEnv.px[i], shots.noEnv.px[i + 1], shots.noEnv.px[i + 2]];
  const n0 = [shots.neither.px[i], shots.neither.px[i + 1], shots.neither.px[i + 2]];
  const po = [shots.propsOff.px[i], shots.propsOff.px[i + 1], shots.propsOff.px[i + 2]];

  const direct = f.map((c, k) => c - ns[k]);
  const sky = f.map((c, k) => c - ne[k]);
  const isProp = Math.abs(f[0] - po[0]) + Math.abs(f[1] - po[1]) + Math.abs(f[2] - po[2]) > PROP_DELTA;
  const lit = lum(direct) > SUNLIT;
  const key = `${isProp ? 'props' : 'street'}, ${lit ? 'sunlit' : 'shaded'}`;
  bins[key].push([f, direct, sky, n0]);
}

console.log(`  SHADING DECOMPOSITION — scene radiance, exposure ${EXPOSURE} backed out`);
console.log(`  ${width * height} px; a pixel is "props" if hiding the group changes it,`);
console.log(`  "sunlit" if killing the sun changes it by more than ${SUNLIT} radiance\n`);
for (const [name, rows] of Object.entries(bins)) {
  if (rows.length < 40) { console.log(`  ${name.padEnd(15)} — only ${rows.length} px, not reported\n`); continue; }
  const mean = (sel) => {
    const acc = [0, 0, 0];
    for (const r of rows) for (let k = 0; k < 3; k++) acc[k] += sel(r)[k];
    return acc.map((c) => c / rows.length);
  };
  const f = mean((r) => r[0]), d = mean((r) => r[1]), s = mean((r) => r[2]), o = mean((r) => r[3]);
  const pct = (v) => `${(100 * lum(v) / Math.max(lum(f), 1e-6)).toFixed(0)}%`.padStart(5);
  console.log(`  ${name}   (${rows.length} px, ${(100 * rows.length / (width * height)).toFixed(1)}% of frame)`);
  console.log(`    full         ${fmt(f)}   L ${lum(f).toFixed(3)}`);
  console.log(`    direct sun   ${fmt(d)}   L ${lum(d).toFixed(3)}  ${pct(d)} of full`);
  console.log(`    sky / IBL    ${fmt(s)}   L ${lum(s).toFixed(3)}  ${pct(s)} of full`);
  console.log(`    other        ${fmt(o)}   L ${lum(o).toFixed(3)}  ${pct(o)} of full`);
  console.log(`    blue / red   ${(f[2] / Math.max(f[0], 1e-6)).toFixed(2)}`);
  console.log('');
}

finish(0);
