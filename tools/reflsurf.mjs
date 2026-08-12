/* What the street's surfaces are actually worth, in radiance, against what the
 * shopfront reflection says they are worth.
 *
 *   node tools/withlock.mjs reflsurf -- node tools/reflsurf.mjs
 *
 * SHOP_GLASS_BODY in `scene/streetMaterials.ts` paints the reflected world
 * analytically: a sunlit stucco band, a shaded band under it, sunlit footway
 * where a downward ray lands, glazing opposite. Every one of those constants is
 * a claim about a surface that is *also in the frame*, so the claim is
 * checkable — and three of them were authored by inverting the withdrawn
 * `display = 0.284 * L^0.4545` fit, which over-predicts radiance three to six
 * times over the band this scene occupies.
 *
 * ── THE SPACE THESE CONSTANTS ARE AUTHORED IN ─────────────────────────────
 *
 * Every previous round of this argument stalled on the same ambiguity: the
 * targets were display values read off a finished frame, the measurements are of
 * a bare surface, and nobody had written down which one the shader wants. The
 * shader answers it, and the answer is not a matter of taste.
 *
 *   1. `hit` is resolved from these constants.
 *   2. `gTint = mix(hit, hazeC, ext)` — the reflected path's aerial perspective,
 *      six per cent at twelve metres and a third at forty, applied HERE.
 *   3. `gTint` is mixed toward its own luminance, 0.42, for the film.
 *   4. It is substituted for `indirectSpecular` and multiplied by the pane's
 *      two-interface Fresnel, `diffuseColor.a`.
 *   5. The fragment's own aerial perspective to the camera, then the bloom, the
 *      tone map and the grade, none of which this shader can see.
 *
 * So a constant here is THE LINEAR RADIANCE LEAVING THE REFLECTED SURFACE WITH
 * NO AIR IN FRONT OF IT. Everything between that surface and the eye is applied
 * downstream, and a value derived from a graded frame has all of it baked in
 * already — which is how a wall got authored at four times the wall it depicts.
 * The rule, for the next one of these: measure the referent in the frame with
 * `haze=off` and no grade, which is what this tool does, and never invert a
 * screen value that has been through air, bloom, AgX and a grade.
 *
 * ── How a sample gets taken, and why not by frame fraction ────────────────
 *
 * A rectangle of the viewport written down before the frame exists is a guess,
 * and NOTES.md records three separate conclusions that a mislabelled region
 * produced. So nothing here is typed in screen space. The wall is *found* by
 * casting a ray across the street, the footway is found by casting one down,
 * and the world point that comes back is projected through the camera to get
 * its pixel. Every sample is then re-cast from the camera and kept only if the
 * first thing the ray meets is the surface the sample claims to be on, so an
 * occluded point cannot quietly contribute. Each group reports how many samples
 * survived and what they hit.
 *
 * Sunlit and shaded are separated by the sun itself rather than by position:
 * the frame is rendered twice, once with the DirectionalLight at zero, and a
 * sample is sunlit if killing the sun costs it more than SUNLIT of radiance.
 * That is the pairing rule — the test and its control are the same pixels of
 * the same frame, seconds apart, rather than two runs.
 *
 * Radiance rather than display: `?nograde&nohdr` so the renderer's own tone
 * mapping is what reaches the canvas, then LinearToneMapping at a low exposure
 * so that sunlit paving does not clip, and the exposure divided back out.
 *
 * LINEAR, NOT NONE, AND THE DIFFERENCE IS NOT COSMETIC. `tools/shadesplit.mjs`
 * sets `NoToneMapping` and then sets an exposure, and three compiles the
 * exposure out: `WebGLProgram.js:771` omits `#define TONE_MAPPING` and the
 * whole tonemapping function when toneMapping is None, so `tonemapping_fragment`
 * expands to nothing and `toneMappingExposure` is never read. The knob is inert.
 * Dividing by it afterwards multiplies every radiance that tool reports by
 * 1/0.06 — sunlit street comes back as 8.43 where the surface is at 0.51.
 * Ratios and percentages survive it; absolute radiances do not. This tool uses
 * LinearToneMapping, which is `saturate(exposure * colour)` and is live, and
 * asserts below that it is live rather than assuming it.
 *
 * The constants are parsed out of streetMaterials.ts rather than retyped. Four
 * bugs this session came from a duplicated constant; a measurement tool that
 * carries its own copy of the thing under test is the same bug with a longer
 * fuse.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, finish, DEV_URL } from './harness.mjs';
import { display, unpedestal } from './agx.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

const EXPOSURE = +flag('exposure', 0.06);
const T = +flag('t', 0.45);
const SUNLIT = 0.02;          // radiance the sun has to be worth to count
const W = 1280, H = 720;

/* ── The constants under test, read out of the shader ─────────────────────── */

const SRC = fs.readFileSync(path.join(ROOT, 'src/scene/streetMaterials.ts'), 'utf8');
const grab = (re, what) => {
  const m = SRC.match(re);
  if (!m) throw new Error(`could not find ${what} in streetMaterials.ts — the shader moved`);
  return [+m[1], +m[2], +m[3]];
};
const CLAIM = {
  'frontage, sunlit': grab(/vec3 litWall = vec3\(([\d.]+), ([\d.]+), ([\d.]+)\)/, 'litWall'),
  'frontage, shaded': grab(/vec3 shadeWall = vec3\(([\d.]+), ([\d.]+), ([\d.]+)\)/, 'shadeWall'),
  'footway, sunlit': grab(/road = mix\(road, vec3\(([\d.]+), ([\d.]+), ([\d.]+)\)/, 'the sunlit footway'),
  'carriageway, shaded': grab(/vec3 road = mix\(vec3\(([\d.]+), ([\d.]+), ([\d.]+)\)/, 'the shaded road'),
  /* The two glazing terms, which are pictures of surfaces that are also in the
   * frame and were until now the only ones in this shader nobody had metered.
   * Both carry a per-bay hash multiplier as well, so the constant is the top of
   * a range rather than the value: winC spans 0.55 to 1.30 of its triple and
   * glassC 0.30 to 1.35. The mid-point of each range is what gets compared,
   * since that is what a bay averages to. */
  'glazing, upper': grab(/vec3 winC = mix\(vec3\(([\d.]+), ([\d.]+), ([\d.]+)\)/, 'winC')
    .map((c) => c * (0.55 + 0.75 / 2)),
  'glazing, shopfront': grab(/vec3 glassC = vec3\(([\d.]+), ([\d.]+), ([\d.]+)\)/, 'glassC')
    .map((c) => c * (0.30 + 1.05 / 2)),
};

/* ── Sampling ─────────────────────────────────────────────────────────────── */

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/* A pixel, back to the scene radiance that produced it. Decode, take off
 * sensor.ts's pedestal and gain — which every fragment the renderer draws
 * carries, and which in the shadows is most of what is there — then undo the
 * exposure. The pedestal comes from agx.mjs rather than being retyped. */
const toRadiance = (px) =>
  unpedestal(px.map(srgbToLinear)).map((v) => v / EXPOSURE);
const lum = (v) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
const fmt = (v) => v.map((c) => c.toFixed(3).padStart(7)).join(' ');

/* `haze=off` drops the fog maths and nothing else — same program, same
 * uniforms, one constant substituted, so a difference cannot be an artefact of
 * having compiled something else. It is not optional here. The reflection
 * applies its own aerial perspective further down SHOP_GLASS_BODY, so the
 * constants under test are the radiance of a surface *before* the air gets to
 * it. Measured with the haze in, a shaded frontage at 38 m came back at 4.9 and
 * shaded footway at 7.8 — brighter than sunlit stucco — which is a measurement
 * of the airlight, not of the wall. */
const url = `${DEV_URL}/?nograde&nohdr&haze=off`;
let out = null;

await run({ width: W, height: H, url }, async ({ page, readShaderErrors }) => {
  out = await page.evaluate(([t, exposure, sunlitCut]) => {
    const T3 = window.__THREE;
    const s = window.__scene;
    s.goTo(t);
    s.setPitch(-0.20);
    s.setYaw(0);
    s.setPaused(true);
    // LinearToneMapping is 1 in three's enum; spelled numerically so the probe
    // does not have to import three into the page.
    s.renderer.toneMapping = 1;
    s.renderer.toneMappingExposure = exposure;
    s.renderOnce();

    const cam = s.camera;
    const rc = new T3.Raycaster();
    rc.far = 200;

    /* Find the two building lines by casting across the street rather than by
     * importing a dimension. If the geometry moves, this moves with it. */
    const acrossAll = (z, sign, y = 2.0) => {
      rc.set(new T3.Vector3(0, y, z), new T3.Vector3(sign, 0, 0));
      return rc.intersectObjects(s.scene.children, true).filter((i) => i.distance > 0.5);
    };
    const across = (z, sign, y = 2.0) => {
      const h = acrossAll(z, sign, y);
      return h.length ? h[0] : null;
    };
    /* Which of these meshes is glazing, asked of the material rather than of a
     * position or a name. The two glass materials in this street identify
     * themselves to three through `customProgramCacheKey`, so the classification
     * comes from the same string the renderer uses to tell the programs apart and
     * cannot drift from it. Reported per group so it is checkable. */
    const progKey = (o) => {
      const m = o && o.material;
      if (!m || typeof m.customProgramCacheKey !== 'function') return '';
      try { return m.customProgramCacheKey() || ''; } catch { return ''; }
    };
    const down = (x, z) => {
      rc.set(new T3.Vector3(x, 6.0, z), new T3.Vector3(0, -1, 0));
      const h = rc.intersectObjects(s.scene.children, true).filter((i) => i.distance > 0.5);
      return h.length ? h[0] : null;
    };

    const camZ = cam.position.z;
    const pts = [];
    /* What programs the ray actually meets at each height, so a group coming back
     * empty can be told apart from a group whose referent is drawn by a material
     * this tool does not recognise. The upper storey came back with no samples at
     * all and this is how the reason was found. */
    const seen = {};
    for (let k = 0; k < 60; k++) {
      const z = camZ - 3 - k * 1.0;
      for (const sign of [-1, 1]) {
        for (const y of [1.55, 4.60, 6.90]) {
          for (const h of acrossAll(z, sign, y).slice(0, 4)) {
            const key = `y${y} ${progKey(h.object) || h.object.type}`;
            seen[key] = (seen[key] || 0) + 1;
          }
        }
      }
    }
    for (let k = 0; k < 60; k++) {
      const z = camZ - 3 - k * 1.0;
      for (const sign of [-1, 1]) {
        const w = across(z, sign);
        if (!w) continue;
        const wallX = w.point.x;
        // The frontage, up one elevation.
        for (const y of [1.8, 2.6, 3.6, 5.0, 6.4, 8.0]) {
          pts.push({ group: 'frontage', x: wallX - sign * 0.04, y, z, side: sign });
        }
        /* The glazing, at a shopfront height and at an upper-storey one, kept
         * only where the ray actually lands on a glass program. Offset back
         * along the ray so the sample sits just in front of the pane rather
         * than on it, which is the same 4 cm the frontage samples use. */
        for (const [y, group] of [[1.25, 'glazing, shopfront'], [1.55, 'glazing, shopfront'],
          [1.95, 'glazing, shopfront'], [2.40, 'glazing, shopfront'],
          [3.90, 'glazing, upper'], [4.60, 'glazing, upper'],
          [5.30, 'glazing, upper'], [6.90, 'glazing, upper']]) {
          /* The first glass along the ray, not the first thing along it: at these
           * heights the ray usually meets a pier, a stallriser or a fascia first,
           * and taking hit[0] was why the upper storey came back with no samples
           * at all. Bounded to 20 m so a pane four blocks up the street cannot
           * stand in for the elevation opposite. */
          const g = acrossAll(z, sign, y).find((h) => h.distance < 20 && /glass/i.test(progKey(h.object)));
          if (!g) continue;
          pts.push({ group, x: g.point.x - sign * 0.04, y, z, side: sign, prog: progKey(g.object) });
        }
        // The footway, a metre in from the building line, and the carriageway.
        for (const [dx, group] of [[1.0, 'footway'], [1.9, 'footway'], [3.6, 'carriageway'],
          [5.2, 'carriageway']]) {
          const g = down(wallX - sign * dx, z);
          if (!g) continue;
          pts.push({ group, x: g.point.x, y: g.point.y + 0.02, z: g.point.z, side: sign });
        }
      }
    }

    /* Project, then verify. A point is only sampled if a ray from the camera
     * through its own pixel arrives at the same place — otherwise the sample is
     * of whatever is standing in front of it, which is precisely the failure
     * that gave this project a "sky" region at 79.6 m. */
    const cv = s.renderer.domElement;
    const keep = [];
    for (const p of pts) {
      const v = new T3.Vector3(p.x, p.y, p.z);
      const world = v.clone();
      v.project(cam);
      if (v.x < -0.95 || v.x > 0.95 || v.y < -0.95 || v.y > 0.95 || v.z > 1) continue;
      const px = Math.round((v.x * 0.5 + 0.5) * cv.width);
      const py = Math.round((1 - (v.y * 0.5 + 0.5)) * cv.height);
      if (px < 3 || py < 3 || px > cv.width - 4 || py > cv.height - 4) continue;
      rc.setFromCamera(new T3.Vector2(v.x, v.y), cam);
      const hit = rc.intersectObjects(s.scene.children, true).filter((i) => i.distance > 0.2)[0];
      if (!hit) continue;
      const want = world.distanceTo(cam.position);
      if (Math.abs(hit.distance - want) > 0.25) continue;   // something is in front
      keep.push({ ...p, px, py, dist: want, hitName: hit.object.name || hit.object.type });
    }

    /* Two renders, one camera, one task each. The sun toggle is the control and
     * it is the same pixels. */
    const readAll = () => {
      s.renderOnce();
      const off = document.createElement('canvas');
      off.width = cv.width; off.height = cv.height;
      const ctx = off.getContext('2d');
      ctx.drawImage(cv, 0, 0);
      return keep.map((k) => {
        const d = ctx.getImageData(k.px - 1, k.py - 1, 3, 3).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
        return [r / n / 255, g / n / 255, b / n / 255];
      });
    };

    let sun = null;
    s.scene.traverse((o) => { if (o.isDirectionalLight && o.castShadow && !sun) sun = o; });
    const sunI = sun ? sun.intensity : 0;
    const full = readAll();

    /* What the lanterns are worth at each sample, so that a surface standing in
     * a lamp pool can be thrown out rather than averaged in.
     *
     * This is not fussiness. LAMP_CD_FULL was re-anchored from 78 to 329 cd, and
     * the run that caught it shows what that does to a tool that ignores the
     * lamps: shaded footway measured 1.82 under 20 m against 0.68 beyond it,
     * which with the haze off cannot be distance and is the pools. Every
     * constant in this shader depicts a surface as the DAYLIGHT leaves it — the
     * reflected world in SHOP_GLASS_BODY has no lanterns in it at all — so a
     * lamp-lit sample is a measurement of the wrong thing.
     *
     * Read the same way `lampanchor.mjs` reads it: the mirror at gain 1 and
     * again at gain 2, and a reading is only believed where it doubles, because
     * only the materials the mirror is injected into can answer and everything
     * else returns a picture of itself. */
    window.__sys5.mirror(1);
    const art1 = readAll();
    window.__sys5.mirror(2);
    const art2 = readAll();
    window.__sys5.mirror(0);

    /* Is the exposure actually doing anything? Halve it and the same pixels
     * have to halve in linear light. This is here because the instrument this
     * one is adapted from divides by an exposure the renderer compiled out, and
     * the symptom — every absolute radiance sixteen times too high — looks
     * exactly like a scene that is sixteen times too bright. */
    s.renderer.toneMappingExposure = exposure * 0.5;
    const half = readAll();
    s.renderer.toneMappingExposure = exposure;

    if (sun) sun.intensity = 0;
    const noSun = readAll();
    if (sun) sun.intensity = sunI;
    s.renderOnce();

    return {
      sunIntensity: sunI,
      camera: [cam.position.x, cam.position.y, cam.position.z].map((v) => +v.toFixed(2)),
      seen,
      samples: keep.map((k, i) => ({
        ...k, full: full[i], noSun: noSun[i], half: half[i], art1: art1[i], art2: art2[i],
      })),
      cut: sunlitCut,
    };
  }, [T, EXPOSURE, SUNLIT]);

  const errs = await readShaderErrors();
  console.log(errs.length ? `\n  SHADER ERRORS: ${errs.length}` : '  shader errors: none');
  if (errs.length) for (const e of errs) console.log(`    ${String(e).slice(0, 200)}`);
});

if (!out) finish(1);

/* ── Report ───────────────────────────────────────────────────────────────── */

/* Which elevation is the one in the sun, asked of the frame. The glazing terms
 * are pictures of a pane on the SHADED elevation — winC's and glassC's bright
 * branches are the ones that survive at `sun = 0` — so the two sides have to be
 * told apart, and doing it by x sign means importing an azimuth. The frontage
 * samples already know: whichever side loses more when the sun is switched off
 * is the side the sun is on. */
const sideLift = new Map();
for (const s of out.samples) {
  if (s.group !== 'frontage') continue;
  const d = lum(toRadiance(s.full).map((c, k) => c - toRadiance(s.noSun)[k]));
  sideLift.set(s.side, (sideLift.get(s.side) || 0) + d);
}
const litSide = [...sideLift.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
const elevation = (side) => (side === litSide ? 'sunlit elevation' : 'shaded elevation');

/* The lamp rejection. `KMAX` is an upper bound on the diffuse transfer rather
 * than a measurement of it: the two routes to it in this scene give 0.019 and
 * 0.042 and disagree (see `scene/lampFixtures.ts`), so the larger one is used,
 * which over-states the lamp's share and therefore throws away marginal samples
 * rather than keeping them. A sample is dropped if the lanterns could account
 * for more than SHARE of its radiance. */
const KMAX = 0.042, SHARE = 0.08;
let dropped = 0, unreadable = 0;
const lampShare = (s) => {
  const e1 = toRadiance(s.art1), e2 = toRadiance(s.art2);
  const d = lum(e1) > 0.02 ? lum(e2) / lum(e1) : 0;
  if (!(d > 1.7 && d < 2.3)) { unreadable++; return null; }   // not a mirrored fragment
  return KMAX * lum(e1) / Math.max(lum(toRadiance(s.full)), 1e-4);
};

const bins = new Map();
for (const s of out.samples) {
  const share = lampShare(s);
  if (share !== null && share > SHARE) { dropped++; continue; }
  const f = toRadiance(s.full);
  const n = toRadiance(s.noSun);
  const direct = f.map((c, k) => c - n[k]);
  /* A pane is not classified by whether the sun is on it. Switching the sun off
   * takes most of the radiance out of a mirror aimed at a sunlit wall as well,
   * so the sun-difference test — which is the right test for an opaque
   * surface — would call a shaded pane sunlit. Glazing is binned by elevation
   * instead. */
  const key = s.group.startsWith('glazing')
    ? `${s.group}, ${elevation(s.side)}`
    : `${s.group}, ${lum(direct) > SUNLIT ? 'sunlit' : 'shaded'}`;
  if (!bins.has(key)) bins.set(key, []);
  bins.get(key).push({ f, direct, hit: s.hitName, dist: s.dist, y: s.y, side: s.side, prog: s.prog });
}

/* The exposure liveness assertion, before anything is reported. */
{
  const ratios = out.samples
    .map((s) => [toRadiance(s.full)[1], toRadiance(s.half)[1]])
    // Unclipped at the full exposure, and clear of the pedestal at the half.
    .filter(([f]) => f * EXPOSURE > 0.05 && f * EXPOSURE < 0.9)
    .map(([f, h]) => h / f);
  const mean = ratios.reduce((a, b) => a + b, 0) / Math.max(ratios.length, 1);
  if (ratios.length < 4 || Math.abs(mean - 0.5) > 0.06) {
    console.error(`\n✗ the exposure control is not live: halving it changed ${ratios.length}`
      + ` unclipped samples by ${mean.toFixed(3)}x, not 0.5x.`);
    console.error('  Every radiance below would be wrong by whatever the exposure is.');
    finish(1);
  }
  console.log(`\n  exposure liveness: halving it halves ${ratios.length} unclipped samples`
    + ` (mean ${mean.toFixed(3)}x)`);
}

console.log(`  camera at ${out.camera.join(', ')}, sun intensity ${out.sunIntensity}`);
console.log(`  ${out.samples.length} samples survived projection and the occlusion re-cast`);
console.log('  programs the cross-street ray meets, by height:');
for (const [k, n] of Object.entries(out.seen || {}).sort()) console.log(`    ${k.padEnd(28)} ${n}`);
console.log(`  lamp rejection: ${dropped} dropped for standing in a pool`
  + ` (the lanterns worth over ${(100 * SHARE).toFixed(0)}% of the sample at k <= ${KMAX});`
  + ` ${unreadable} could not be metered and are kept`);
console.log(`  exposure ${EXPOSURE} divided back out; "sunlit" means the sun is worth`
  + ` more than ${SUNLIT} radiance at that point\n`);

const order = ['frontage, sunlit', 'frontage, shaded', 'footway, sunlit', 'footway, shaded',
  'carriageway, sunlit', 'carriageway, shaded',
  'glazing, shopfront, shaded elevation', 'glazing, shopfront, sunlit elevation',
  'glazing, upper, shaded elevation', 'glazing, upper, sunlit elevation'];
for (const key of order) {
  const rows = bins.get(key);
  if (!rows || rows.length < 3) {
    console.log(`  ${key.padEnd(21)} — ${rows ? rows.length : 0} samples, not reported\n`);
    continue;
  }
  const mean = (sel) => {
    const a = [0, 0, 0];
    for (const r of rows) for (let k = 0; k < 3; k++) a[k] += sel(r)[k];
    return a.map((c) => c / rows.length);
  };
  const f = mean((r) => r.f);
  const hits = [...new Set(rows.map((r) => r.hit))].join(', ');
  const ds = rows.map((r) => r.dist).sort((a, b) => a - b);
  console.log(`  ${key}   ${rows.length} samples, ${ds[0].toFixed(0)}`
    + `-${ds[ds.length - 1].toFixed(0)} m, on: ${hits}`);
  /* Near against far, in the same bin. With the haze off these have to agree;
   * if they do not, something distance-dependent is still in the path and the
   * mean below is a mean of two different things. */
  const near = rows.filter((r) => r.dist < 20), far = rows.filter((r) => r.dist >= 20);
  if (near.length >= 2 && far.length >= 2) {
    const m = (rs) => {
      const a = [0, 0, 0];
      for (const r of rs) for (let k = 0; k < 3; k++) a[k] += r.f[k];
      return a.map((c) => c / rs.length);
    };
    console.log(`    under 20 m  ${fmt(m(near))}   (${near.length})`);
    console.log(`    over  20 m  ${fmt(m(far))}   (${far.length})`);
  }
  console.log(`    measured    ${fmt(f)}   -> display ${display(f, { sensor: true }).join(' ')}`);
  const progs = [...new Set(rows.map((r) => r.prog).filter(Boolean))];
  if (progs.length) console.log(`    programs    ${progs.join(', ')}`);
  /* The glazing claim belongs to the shaded elevation; the sunlit side is
   * printed as the control and is not what the constant is a picture of. */
  const claim = CLAIM[key] || (key.endsWith('shaded elevation')
    ? CLAIM[key.replace(', shaded elevation', '')] : null);
  if (claim) {
    console.log(`    reflection  ${fmt(claim)}   -> display ${display(claim, { sensor: true }).join(' ')}`);
    console.log(`    ratio       ${fmt(claim.map((c, k) => c / Math.max(f[k], 1e-4)))}`);
  }
  console.log('');
}

finish(0);
