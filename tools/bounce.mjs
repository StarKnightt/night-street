/* Is the cross-canyon bounce term physically the right size?
 *
 *   node tools/withlock.mjs bounce -- node tools/bounce.mjs
 *
 * Three materials add a hand-written irradiance to `indirectDiffuse` to stand
 * for the frontage opposite, which at this hour is in full sun above its own
 * shade line and is the largest warm source anything at street level can see:
 *
 *   buildingMaterials.ts  MASONRY_END    C * faceAcross * bounceH * gAO * albedo
 *   streetMaterials.ts    streetEnd      C * across * gain * gAO * albedo
 *   propMaterials.ts      STREET_BOUNCE  C * across * gain * albedo
 *
 * with the same C in all three. `reflectedLight.indirectDiffuse` is outgoing
 * radiance, and BRDF_Lambert makes that `E * albedo / PI`, so a term written as
 * `C * k * albedo` is a claim that the bounce delivers `E = PI * C * k`.
 *
 * That claim is checkable without believing anything about the tone curve. The
 * source is a surface in the frame: measure its radiance, measure how much of
 * the receiver's cosine-weighted hemisphere it fills, multiply.
 *
 * WHY THIS EXISTS. The bounce was listed as "correct" in the audit on the
 * grounds that it came out of `tools/shadesplit.mjs`'s radiance decomposition.
 * Both halves of that were wrong. It predates the tool by a day — `git log -S`
 * puts C in bea2726 and shadesplit's table in 29ebdbd — and shadesplit's
 * absolute radiances were 16.7x high at the time, because its exposure was
 * inert. Worse, the column the argument rested on cannot isolate this term:
 * "everything else" is the frame with the sun and the environment both off,
 * which is the lamps, every emissive surface and this bounce added together.
 * So the verdict was re-derived from geometry and a fresh measurement instead.
 *
 * ── The form factor ───────────────────────────────────────────────────────
 *
 * The frontage opposite is long compared to its distance, so it is an
 * infinitely long strip as far as a receiver on the other side is concerned,
 * and for a differential element facing it the form factor is
 * `(sin t2 - sin t1) / 2` with t measured from the element's normal. Both angles
 * come from the geometry: t1 from the shade line, t2 from the top of the wall,
 * both found by raycast, at whatever height the receiver is at.
 *
 * E = PI * F * L. Divide by PI to compare against C * k directly.
 *
 * Nothing is transcribed. C is parsed out of all three shaders and they must
 * agree; the sun direction, the street width, the shade line and the wall top
 * are read out of the running scene; the radiance comes off the frame.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, finish, DEV_URL } from './harness.mjs';
import { unpedestal } from './agx.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const EXPOSURE = +flag('exposure', 0.25);
const T = +flag('t', 0.45);
const W = 1280, H = 720;

/* ── C, from the three shaders that carry it ─────────────────────────────── */

const FILES = {
  'buildingMaterials.ts': 'src/scene/buildingMaterials.ts',
  'streetMaterials.ts': 'src/scene/streetMaterials.ts',
  'propMaterials.ts': 'src/scene/propMaterials.ts',
};
const found = {};
for (const [name, rel] of Object.entries(FILES)) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const m = src.match(/vec3\(([\d.]+), ([\d.]+), ([\d.]+)\)\s*\*\s*(?:faceAcross|across)/);
  if (!m) throw new Error(`no bounce term found in ${name} — the shader moved`);
  found[name] = [+m[1], +m[2], +m[3]];
}
const keys = Object.keys(found);
for (const k of keys.slice(1)) {
  if (found[k].join() !== found[keys[0]].join()) {
    throw new Error(`the three copies of the bounce constant have drifted: ${
      keys.map((n) => `${n} ${found[n].join()}`).join(' vs ')}`);
  }
}
const C = found[keys[0]];

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toRadiance = (px) => unpedestal(px.map(srgbToLinear)).map((v) => v / EXPOSURE);
const lum = (v) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
const fmt = (v) => v.map((c) => c.toFixed(3).padStart(7)).join(' ');

const url = `${DEV_URL}/?nograde&nohdr&haze=off`;
let out = null;

await run({ width: W, height: H, url }, async ({ page, readShaderErrors }) => {
  out = await page.evaluate(([t, exposure]) => {
    const T3 = window.__THREE;
    const s = window.__scene;
    s.goTo(t);
    s.setPaused(true);
    s.renderer.toneMapping = 1;            // LinearToneMapping; live, unlike None
    s.renderer.toneMappingExposure = exposure;
    s.renderOnce();

    const cam = s.camera;
    const rc = new T3.Raycaster();
    rc.far = 400;
    const hit = (o, d, min = 0.3) => {
      rc.set(o, d.clone().normalize());
      return rc.intersectObjects(s.scene.children, true).filter((i) => i.distance > min)[0] || null;
    };

    let sun = null;
    s.scene.traverse((o) => { if (o.isDirectionalLight && o.castShadow && !sun) sun = o; });
    const toSun = sun
      ? sun.position.clone().sub(sun.target ? sun.target.position : new T3.Vector3()).normalize()
      : null;

    const z = cam.position.z - 12;
    /* The two building lines, and the vertical extent of each frontage, by
     * casting across the street at rising heights. A height where the ray stops
     * hitting the frontage is above the roof. */
    const walls = [];
    for (const sign of [-1, 1]) {
      /* The building line is the *nearest* thing across the street, over a run
       * of z, not whatever a single ray happens to meet: the block is broken by
       * side streets and a ray fired down one of them returns a wall twenty
       * metres away and a street twice its real width. */
      /* Median rather than nearest or first. Nearest picks up a parked car or a
       * bin and reports a 6.7 m street; a single ray fired down a side street
       * reports a 26 m one. The median of fifteen is the building line. */
      const xs = [];
      for (let dz = -14; dz <= 14; dz += 2) {
        const b = hit(new T3.Vector3(0, 2.0, z + dz), new T3.Vector3(sign, 0, 0), 0.5);
        /* Under ten metres, because this block has a gap in it — it is what lets
         * the sun onto this stretch of carriageway in the first place — and a ray
         * fired through the gap returns the next thing standing behind it. */
        if (b && Math.abs(b.point.x) < 10) xs.push(b.point.x);
      }
      if (!xs.length) continue;
      xs.sort((a, b) => a - b);
      const lineX = xs[Math.floor(xs.length / 2)];
      /* The rungs are matched against the wall at the sampling z, which is not
       * necessarily the nearest one over the whole run. */
      const base = hit(new T3.Vector3(0, 2.0, z), new T3.Vector3(sign, 0, 0), 0.5);
      if (!base) continue;
      const x = base.point.x;
      const rungs = [];
      for (let y = 0.5; y <= 30; y += 0.25) {
        const h = hit(new T3.Vector3(0, y, z), new T3.Vector3(sign, 0, 0), 0.5);
        // Same wall, not something behind it or a balcony sticking out.
        if (!h || Math.abs(h.point.x - x) > 1.2) continue;
        const p = h.point.clone().addScaledVector(h.face ? h.face.normal.clone()
          .transformDirection(h.object.matrixWorld) : new T3.Vector3(-sign, 0, 0), 0.06);
        const shade = toSun ? hit(p, toSun, 0.05) : null;
        rungs.push({ y, x: p.x, sunlit: !shade, blockedBy: shade ? (shade.object.name || shade.object.type) : null });
      }
      walls.push({ sign, x, lineX, dist: Math.abs(lineX), rungs });
    }

    /* The receiver is on the wall facing whichever frontage is lit, so the lit
     * one is the source and the other one is where the term is being applied. */
    const litCount = (w) => w.rungs.filter((r) => r.sunlit).length;
    walls.sort((a, b) => litCount(b) - litCount(a));
    const src = walls[0];
    if (!src || !litCount(src)) return { fail: 'no sunlit frontage found at this hour', walls };

    /* How much of that strip is actually lit, along the street.
     *
     * The form factor below treats the sunlit band as a strip of uniform
     * radiance, and it is not one: the block is broken by side streets, and
     * projections shade parts of it. Without this the prediction is the bounce
     * from an unbroken wall of sunlit stucco, which is not what is standing
     * there. Sampled with the same shadow ray, at the same heights, over the
     * same run of z the radiance samples come from. */
    let covLit = 0, covAll = 0;
    for (const r of src.rungs) {
      if (!r.sunlit) continue;
      for (let dz = -12; dz <= 12; dz += 2) {
        const p = new T3.Vector3(r.x, r.y, z + dz);
        covAll++;
        if (!hit(p, toSun, 0.05)) covLit++;
      }
    }

    /* Look at it. A 20 m wall six metres away needs the whole lens. */
    s.setYaw(src.sign > 0 ? -Math.PI / 2 : Math.PI / 2);
    s.setPitch(0.62);
    cam.fov = 82;
    cam.updateProjectionMatrix();
    s.renderOnce();

    const cv = s.renderer.domElement;
    const keep = [];
    /* Along the street as well as up the wall. One vertical ladder puts a dozen
     * points in the frame and most of them land on the same pilaster; spreading
     * over z samples the elevation as built — glazing, render, brick, the gaps
     * between them — which is what a receiver eleven metres away integrates. */
    const zs = [];
    for (let dz = -12; dz <= 12; dz += 2) zs.push(z + dz);
    for (const r of src.rungs) for (const zz of zs) {
      if (!r.sunlit) continue;
      const world = new T3.Vector3(r.x, r.y, zz);
      const v = world.clone().project(cam);
      if (v.x < -0.92 || v.x > 0.92 || v.y < -0.92 || v.y > 0.92 || v.z > 1) continue;
      const px = Math.round((v.x * 0.5 + 0.5) * cv.width);
      const py = Math.round((1 - (v.y * 0.5 + 0.5)) * cv.height);
      if (px < 3 || py < 3 || px > cv.width - 4 || py > cv.height - 4) continue;
      rc.setFromCamera(new T3.Vector2(v.x, v.y), cam);
      const h = rc.intersectObjects(s.scene.children, true).filter((i) => i.distance > 0.2)[0];
      if (!h) continue;
      const want = world.distanceTo(cam.position);
      if (Math.abs(h.distance - want) > 0.3) continue;
      keep.push({ y: r.y, z: zz, px, py, dist: want, hitName: h.object.name || h.object.type });
    }

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

    const full = readAll();
    s.renderer.toneMappingExposure = exposure * 0.5;
    const half = readAll();
    s.renderer.toneMappingExposure = exposure;
    const sunI = sun ? sun.intensity : 0;
    if (sun) sun.intensity = 0;
    const noSun = readAll();
    if (sun) sun.intensity = sunI;
    s.renderOnce();

    return {
      camera: [cam.position.x, cam.position.y, cam.position.z].map((v) => +v.toFixed(2)),
      sunElevation: toSun ? +(Math.asin(toSun.y) * 180 / Math.PI).toFixed(2) : null,
      sunIntensity: sunI,
      src: { sign: src.sign, x: +src.x.toFixed(2), lineX: +src.lineX.toFixed(2), dist: +src.dist.toFixed(2) },
      other: walls[1] ? { sign: walls[1].sign, x: +walls[1].x.toFixed(2), lineX: +walls[1].lineX.toFixed(2) } : null,
      rungs: src.rungs.map((r) => ({ y: r.y, sunlit: r.sunlit })),
      z,
      coverage: covAll ? +(covLit / covAll).toFixed(3) : null,
      coverageN: covAll,
      samples: keep.map((k, i) => ({ ...k, full: full[i], half: half[i], noSun: noSun[i] })),
    };
  }, [T, EXPOSURE]);

  const errs = await readShaderErrors();
  console.log(errs.length ? `\n  SHADER ERRORS: ${errs.length}` : '  shader errors: none');
  if (errs.length) { for (const e of errs) console.log(`    ${String(e).slice(0, 200)}`); out = null; }
});

if (!out || out.fail) {
  console.error(`\n✗ ${out ? out.fail : 'no measurement'}`);
  finish(1);
}

/* ── The measurement ─────────────────────────────────────────────────────── */

{
  const rs = out.samples
    .map((s) => [toRadiance(s.full)[1], toRadiance(s.half)[1]])
    .filter(([f]) => f * EXPOSURE > 0.02 && f * EXPOSURE < 0.9)
    .map(([f, h]) => h / f);
  const mean = rs.reduce((a, b) => a + b, 0) / Math.max(rs.length, 1);
  if (rs.length < 4 || Math.abs(mean - 0.5) > 0.06) {
    console.error(`\n✗ exposure is not live: ${rs.length} samples moved ${mean.toFixed(3)}x, not 0.5x`);
    finish(1);
  }
  console.log(`  exposure liveness: ${rs.length} samples halve (mean ${mean.toFixed(3)}x)`);
}

const lit = out.rungs.filter((r) => r.sunlit).map((r) => r.y);
const all = out.rungs.map((r) => r.y);
const shadeLine = Math.min(...lit);
const wallTop = Math.max(...all);
console.log(`  camera at ${out.camera.join(', ')}, sun elevation ${out.sunElevation} deg,`
  + ` intensity ${out.sunIntensity}`);
console.log(`  source frontage at x ${out.src.x} (${out.src.dist.toFixed(2)} m from the centre line),`
  + ` receiving wall at x ${out.other ? out.other.lineX : '?'}`);
console.log(`  frontage exists from y ${Math.min(...all)} to ${wallTop} m;`
  + ` sunlit from y ${shadeLine} m up (${lit.length}/${all.length} rungs)`);
console.log(`  ${out.samples.length} of those survived projection and the occlusion re-cast\n`);

const sunlitSamples = out.samples.map((s) => {
  const f = toRadiance(s.full), n = toRadiance(s.noSun);
  return { ...s, f, direct: f.map((c, k) => c - n[k]) };
}).filter((s) => lum(s.direct) > 0.02);
if (sunlitSamples.length < 3) {
  console.error(`✗ only ${sunlitSamples.length} samples came back sunlit; nothing to average`);
  finish(1);
}
const L = [0, 1, 2].map((k) => sunlitSamples.reduce((a, s) => a + s.f[k], 0) / sunlitSamples.length);
console.log(`  sunlit frontage radiance, ${sunlitSamples.length} samples`
  + ` (y ${Math.min(...sunlitSamples.map((s) => s.y))}-${Math.max(...sunlitSamples.map((s) => s.y))} m,`
  + ` on: ${[...new Set(sunlitSamples.map((s) => s.hitName))].join(', ')})`);
console.log(`    L            ${fmt(L)}   lum ${lum(L).toFixed(3)}\n`);

/* Street width: centre line to each frontage, both measured. */
const width = out.src.dist + (out.other ? Math.abs(out.other.lineX) : out.src.dist);
console.log(`  street width ${width.toFixed(2)} m between the two building lines\n`);
console.log(`  sunlit coverage along the street ${(100 * out.coverage).toFixed(0)}% of`
  + ` ${out.coverageN} (height, z) shadow probes in the band\n`);
console.log('  E / PI = F * coverage * L, against what each shader\'s coefficient claims:\n');
console.log('    receiver y   F      measured E/PI                 shader coefficient       ratio');

/* Signed elevation angles, so a receiver standing level with the middle of the
 * sunlit strip gets credit for the half of it below eye line as well as the half
 * above. Clamping both angles at zero — which the first cut of this did — makes
 * the term collapse for exactly the receivers that see the most of it. */
const F = (y) => {
  const t1 = Math.atan2(shadeLine - y, width);
  const t2 = Math.atan2(wallTop - y, width);
  return (Math.sin(t2) - Math.sin(t1)) / 2;
};
const bounceH = (y) => {
  const t = Math.min(Math.max((y - 1.5) / (12 - 1.5), 0), 1);
  return 0.10 + 0.90 * (t * t * (3 - 2 * t));
};
/* `across` for a face turned straight across the street, which is the case all
 * three shaders are written around: max(-vWN.x, 0) = 1 in MASONRY_END, and the
 * 0.55 leg of streetEnd's and STREET_BOUNCE's weighting. */
const cases = [
  [2, 'streetEnd  C*0.55*1.00', 0.55 * 1.00],
  [2, 'STREET_BOUNCE C*0.55*2.2', 0.55 * 2.2],
  [2, `MASONRY_END C*1*bounceH(${bounceH(2).toFixed(2)})`, bounceH(2)],
  [6, `MASONRY_END C*1*bounceH(${bounceH(6).toFixed(2)})`, bounceH(6)],
  [12, `MASONRY_END C*1*bounceH(${bounceH(12).toFixed(2)})`, bounceH(12)],
];
for (const [y, label, k] of cases) {
  const e = F(y);
  const meas = L.map((c) => c * e * out.coverage);
  const claim = C.map((c) => c * k);
  const ratio = claim.map((c, i) => c / Math.max(meas[i], 1e-5));
  console.log(`    ${String(y).padStart(4)} m   ${e.toFixed(3)}  ${fmt(meas)}   ${label.padEnd(26)}`
    + ` ${fmt(claim)}  ${ratio.map((r) => r.toFixed(2)).join(' ')}`);
}
console.log(`\n  C as authored: ${fmt(C)}   hue B/R ${(C[2] / C[0]).toFixed(3)},`
  + ` measured frontage B/R ${(L[2] / L[0]).toFixed(3)}`);
console.log('  (ratio > 1 means the shader claims more bounce than the geometry and the'
  + ' measured\n   source support; < 1 means less.)');

finish(0);
