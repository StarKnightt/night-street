/* What ratio the lanterns are actually delivering against the skylight, and what
 * LAMP_CD_FULL would have to be to deliver the one its derivation asks for.
 *
 *   node tools/withlock.mjs lampanchor -- node tools/lampanchor.mjs
 *
 * `lampFixtures.ts` sets the lamp level from one ratio, on the grounds that it is
 * the only scale-free quantity in the derivation: the lantern's peak irradiance
 * on the shaded carriageway against the skylight irradiance it has to beat. It
 * targets 1.5, which is where life puts a 250 W lantern against dusk skylight in
 * a canyon.
 *
 * Its input is stale. The skylight figure comes from "shaded carriageway,
 * radiance L = 0.038 (NOTES, measured)", measured with the sun at 4.2 degrees;
 * since 0384f31 the sun is at 12 and that surface is several times brighter, so
 * the divisor in the ratio has moved and the delivered ratio is no longer the
 * intended one. This measures both terms in the scene as it stands now.
 *
 * ── Both terms, in one pass, with no albedo and no unit conversion ─────────
 *
 * On a patch of shaded road the radiance leaving it is
 *
 *   L = k * E_lamp + L_ambient           k = the patch's diffuse transfer, rho/PI
 *
 * `__sys5.mirror(g)` makes every receiving material output `artificial()` times
 * g instead of shading itself, so E_lamp is directly readable; with the mirror
 * off the same pixel reads L. Both are metered at every metre along the crown of
 * the road. What is wanted is the ratio
 *
 *   E_peak / E_ambient   where   E_ambient = L_ambient / k
 *
 * so the only missing term is k, and the sun supplies it. The same probe read
 * with the sun on and with it off differs by `k * E_sun * cos`, and a
 * DirectionalLight's irradiance is its colour times its intensity — both read off
 * the light, and `colour` is already working-space, which is the trap
 * `volumetric.ts` fell into. So k comes out of the frame, the albedo it implies
 * is reported as a check against the 0.106 the file's own derivation quotes, and
 * nothing has to be believed about units.
 *
 * THAT ROUTE IS THE WEAKER ONE AND IS KEPT FOR ITS CROSS-CHECK. k measured off
 * the sun is 0.038 to 0.042 and k measured by differencing two candela settings
 * is 0.0191 — a factor of 2.2 on the same probes, and the disagreement is not
 * resolved. `--against <run.json>` sidesteps it entirely: the lantern and the
 * skylight are contributions to the radiance of one pixel, so k cancels out of
 * their ratio, and the lamp's share is separable because it is linear in
 * LAMP_CD_FULL. That reduction is at the bottom of this file and is what
 * `lampFixtures.ts` now quotes.
 *
 * A least-squares fit of L against E_lamp was tried first and is not usable: the
 * lamp is worth about 0.02 of a shaded radiance of 0.12, the lanterns overlap
 * enough that E never falls below 0.5 of its peak anywhere on the crown, and the
 * ambient varies more from shopfront light and canyon position than the lamp
 * signal does. R2 came back at 0.002 with the slope negative. Not enough dynamic
 * range in the independent variable; the sun has plenty.
 *
 * ── Two things this asserts rather than assumes ────────────────────────────
 *
 * THE MIRROR IS ON, PER SAMPLE. The meter's known blind spot is that only the
 * five materials the mirror is injected into can answer it; where a bin or a car
 * is under the camera it reads that object, shaded normally, and returns a
 * plausible small irradiance that is a picture of a dark plastic lid. So every
 * point is metered at gain 1 and again at gain 2, and a sample is only used if it
 * doubles. Nothing but a mirrored fragment does.
 *
 * THE EXPOSURE IS LIVE. LinearToneMapping, not None: None makes three compile the
 * tone mapping call out of the program and `toneMappingExposure` is then a field
 * nobody reads, which is how `shadesplit.mjs` came to report every absolute
 * radiance 16.7x high. Halved, and the frame has to halve.
 *
 * Nothing is transcribed: the lamp table comes from `window.__lampFixtures`, the
 * target ratio and the current candela are parsed out of `lampFixtures.ts`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, finish, DEV_URL } from './harness.mjs';
import { unpedestal } from './agx.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const T = +flag('t', 0.45);
const E_EXP = +flag('eexp', 0.30);     // exposure for the irradiance pass
const L_EXP = +flag('lexp', 1.00);     // exposure for the radiance pass
const W = 480, H = 320;

/* ── What the file says it is trying to do ────────────────────────────────── */

const SRC = fs.readFileSync(path.join(ROOT, 'src/scene/lampFixtures.ts'), 'utf8');
const grab = (re, what) => {
  const m = SRC.match(re);
  if (!m) throw new Error(`could not find ${what} in lampFixtures.ts`);
  return +m[1];
};
const CD_NOW = grab(/export const LAMP_CD_FULL = ([\d.]+)/, 'LAMP_CD_FULL');
const TARGET = grab(/export const LAMP_RATIO_TARGET = ([\d.]+)/, 'LAMP_RATIO_TARGET');

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toLinear = (px) => unpedestal(px.map((v) => srgbToLinear(v / 255)));
const lum = (v) => 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
const fmt = (v) => v.map((c) => c.toFixed(3).padStart(7)).join(' ');

const url = `${DEV_URL}/?nograde&nohdr`;
let out = null;

await run({ width: W, height: H, url }, async ({ page, readShaderErrors }) => {
  out = await page.evaluate(([t, eExp, lExp]) => {
    const T3 = window.__THREE;
    const s = window.__scene;
    s.goTo(t);
    s.setDriven(true);
    s.step(0.016);
    window.__sys5.freeze(0);
    s.renderer.toneMapping = 1;              // LinearToneMapping, and it is live
    s.renderOnce();

    const fixtures = window.__lampFixtures;
    const cam = s.camera;
    const saveP = cam.position.clone(), saveQ = cam.quaternion.clone(), saveFov = cam.fov;
    cam.fov = 8; cam.updateProjectionMatrix();          // a spot meter, not a frame
    const down = new T3.Euler(-Math.PI / 2, 0, 0, 'YXZ');

    const gl = s.renderer.getContext();
    const buf = new Uint8Array(4);
    const readAt = (x, z, exposure) => {
      cam.position.set(x, 2.0, z);
      cam.quaternion.setFromEuler(down);
      cam.updateMatrixWorld();
      s.renderer.toneMappingExposure = exposure;
      s.renderer.render(s.scene, cam);
      const w = s.renderer.domElement.width, h = s.renderer.domElement.height;
      gl.readPixels(w >> 1, h >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return [buf[0], buf[1], buf[2]];
    };

    /* Sun visibility per probe, so the sun bands can be excluded. A patch of
     * carriageway in a band is not the surface this ratio is about — the file
     * says so itself, which is why the lamp standing in one is at full output. */
    let sun = null;
    s.scene.traverse((o) => { if (o.isDirectionalLight && o.castShadow && !sun) sun = o; });
    const toSun = sun
      ? sun.position.clone().sub(sun.target ? sun.target.position : new T3.Vector3()).normalize()
      : null;
    const rc = new T3.Raycaster();
    rc.far = 400;
    const targets = [];
    s.scene.traverse((o) => { if (o.isMesh && o.visible) targets.push(o); });

    const zs = [];
    const z0 = Math.max(...fixtures.map((f) => f.position[2])) + 3;
    const z1 = Math.min(...fixtures.map((f) => f.position[2])) - 3;
    for (let z = z0; z >= z1; z -= 1) zs.push(+z.toFixed(1));

    /* Three lanes: the crown of the road and one on each footway. The footway
     * lanes are found by scanning outward for an x that has upward-facing ground
     * under it at every z in the run, rather than taken from the lamp heads at
     * +-3.15 — a downward ray there falls through the seam between the
     * carriageway and the footway slabs at some z and hits the kerb chamfer at
     * others, which is how a previous probe metered a tenth of the arithmetic
     * directly under a working lantern. Same device as tools/sunlamp.mjs. */
    const down1 = new T3.Vector3(0, -1, 0);
    const solid = (x, z) => {
      rc.set(new T3.Vector3(x, 2.0, z), down1);
      const h = rc.intersectObjects(targets, false)[0];
      return h && h.face && h.face.normal.y > 0.9;
    };
    const findLane = (sign) => {
      for (let d = 3.2; d <= 7.0; d += 0.1) {
        if (zs.every((z) => solid(sign * d, z))) return +(sign * d).toFixed(2);
      }
      return null;
    };
    const lanes = [{ name: 'crown', x: 0 }];
    for (const sign of [-1, 1]) {
      const x = findLane(sign);
      if (x !== null) lanes.push({ name: sign < 0 ? 'walkL' : 'walkR', x });
    }

    const rows = [];
    for (const lane of lanes) for (const z of zs) {
      rc.set(new T3.Vector3(lane.x, 2.0, z), down1);
      const g = rc.intersectObjects(targets, false)[0];
      if (!g || !g.face || g.face.normal.y < 0.9) continue;
      const p = g.point.clone().addScaledVector(new T3.Vector3(0, 1, 0), 0.03);
      rc.set(p, toSun);
      const blocked = toSun ? rc.intersectObjects(targets, false).filter((h) => h.distance > 0.05) : [];
      rows.push({
        lane: lane.name, x: lane.x, z, ground: +g.point.y.toFixed(3),
        sunlit: toSun ? blocked.length === 0 : false,
      });
    }

    /* Four readings per point, all from the same camera, in one pass each so the
     * mirror is switched a handful of times rather than once per sample. */
    window.__sys5.mirror(1);
    for (const r of rows) r.e1 = readAt(r.x, r.z, eExp);
    window.__sys5.mirror(2);
    for (const r of rows) r.e2 = readAt(r.x, r.z, eExp);
    window.__sys5.mirror(0);
    for (const r of rows) r.l = readAt(r.x, r.z, lExp);
    for (const r of rows) r.lHalf = readAt(r.x, r.z, lExp * 0.5);
    /* The sun off, same camera, same points: the difference is `k * E_sun * cos`
     * and it is the only term in this measurement with a known irradiance. */
    const sunI = sun ? sun.intensity : 0;
    if (sun) sun.intensity = 0;
    for (const r of rows) r.lNoSun = readAt(r.x, r.z, lExp);
    if (sun) sun.intensity = sunI;

    cam.fov = saveFov; cam.updateProjectionMatrix();
    cam.position.copy(saveP); cam.quaternion.copy(saveQ);
    s.setDriven(false);
    window.__sys5.run();

    return {
      rows,
      lanes,
      fixtures: fixtures.map((f) => ({
        index: f.index, z: f.position[2], x: f.position[0],
        intensity: f.intensity, warmth: f.warmth,
      })),
      sunElevation: toSun ? +(Math.asin(toSun.y) * 180 / Math.PI).toFixed(2) : null,
      sunUp: toSun ? toSun.y : null,
      /* `color` is read as it stands. three's ColorManagement decodes on
       * assignment, so this is already working-space; decoding it again is the
       * bug that made volumetric.ts's air eleven times too blue. */
      sunIrradiance: sun ? [sun.color.r * sun.intensity, sun.color.g * sun.intensity,
        sun.color.b * sun.intensity] : null,
    };
  }, [T, E_EXP, L_EXP]);

  const errs = await readShaderErrors();
  console.log(errs.length ? `\n  SHADER ERRORS: ${errs.length}` : '  shader errors: none');
  if (errs.length) { for (const e of errs) console.log(`    ${String(e).slice(0, 200)}`); out = null; }
});

if (!out) finish(1);

/* The raw readings, so a framing can be argued about without re-measuring. Four
 * minutes of GPU per run and other agents are sharing it. */
const JSON_OUT = flag('json', 'tmp/lampanchor.json');
fs.mkdirSync(path.dirname(path.join(ROOT, JSON_OUT)), { recursive: true });
fs.writeFileSync(path.join(ROOT, JSON_OUT), JSON.stringify({
  cdNow: CD_NOW, target: TARGET, eExp: E_EXP, lExp: L_EXP, ...out,
}, null, 1));
console.log(`  raw readings -> ${JSON_OUT}`);

/* ── Reduce ──────────────────────────────────────────────────────────────── */

const rows = out.rows.map((r) => {
  const e1 = toLinear(r.e1).map((v) => v / E_EXP);
  const e2 = toLinear(r.e2).map((v) => v / E_EXP);
  const l = toLinear(r.l).map((v) => v / L_EXP);
  const lHalf = toLinear(r.lHalf).map((v) => v / (L_EXP * 0.5));
  const lNoSun = toLinear(r.lNoSun).map((v) => v / L_EXP);
  return { ...r, E: e1, E2: e2, L: l, LHalf: lHalf, LNoSun: lNoSun };
});

/* Exposure liveness, on the radiance pass, over samples clear of the floor. */
{
  const rs = rows
    .filter((r) => r.L[1] * L_EXP > 0.02 && r.L[1] * L_EXP < 0.9)
    .map((r) => r.LHalf[1] / r.L[1]);
  const mean = rs.reduce((a, b) => a + b, 0) / Math.max(rs.length, 1);
  if (rs.length < 8 || Math.abs(mean - 1) > 0.06) {
    console.error(`\n✗ the exposure is not live: halving it moved ${rs.length} samples to`
      + ` ${mean.toFixed(3)}x of themselves once divided back out, not 1.0x`);
    finish(1);
  }
  console.log(`  exposure liveness: ${rs.length} samples agree across a halving`
    + ` (mean ${mean.toFixed(3)}x after dividing out)`);
}

/* Mirror liveness, per sample: gain 2 has to read twice gain 1, or the camera is
 * not looking at a mirrored fragment and the reading is a picture of an object. */
const mirrored = rows.filter((r) => {
  const a = lum(r.E), b = lum(r.E2);
  return a > 0.01 && b / a > 1.7 && b / a < 2.3;
});
console.log(`  mirror liveness: ${mirrored.length} of ${rows.length} probes doubled when the`
  + ` gain doubled and are used; ${rows.length - mirrored.length} dropped\n`);
if (mirrored.length < 20) {
  console.error('✗ too few valid probes to fit anything');
  finish(1);
}

/* The crown carries the skylight side of the derivation, because that is the
 * surface it names: "shaded carriageway, radiance L = 0.038". */
const shaded = mirrored.filter((r) => !r.sunlit && r.lane === 'crown');
console.log(`  lanes: ${out.lanes.map((l) => `${l.name} x ${l.x}`).join(', ')}`);
console.log(`  sun at ${out.sunElevation} deg; ${shaded.length} shaded crown probes carry the`
  + ' skylight term');
console.log('  lamps:', out.fixtures.map((f) => `z ${f.z} cd ${f.intensity.toFixed(1)}`).join(', '), '\n');

/* ── k, from the sun ────────────────────────────────────────────────────────
 *
 * The p90 rather than the mean of the sunlit probes. A probe is classified by a
 * shadow ray through the real geometry, which is a hard yes/no, but the frame is
 * drawn with a filtered shadow map, so a probe a metre from the edge of a
 * building's shadow is partly in penumbra on screen and reads low. The upper
 * decile is a probe in open sun. */
const sunUp = out.sunUp;
const eSunH = lum(out.sunIrradiance) * sunUp;
const litRows = mirrored.filter((r) => r.sunlit && r.lane === 'crown');
const dLs = litRows.map((r) => lum(r.L) - lum(r.LNoSun)).sort((a, b) => a - b);
if (dLs.length < 5) { console.error('✗ too few sunlit probes to measure the transfer'); finish(1); }
const dL = dLs[Math.min(dLs.length - 1, Math.round(0.9 * (dLs.length - 1)))];
const k = dL / eSunH;

console.log(`  the transfer, from the sun: irradiance ${fmt(out.sunIrradiance)}`
  + ` lum ${lum(out.sunIrradiance).toFixed(2)}, x sin(${out.sunElevation}) = ${eSunH.toFixed(3)} horizontal`);
console.log(`    ${litRows.length} sunlit probes, sun-on minus sun-off p90 ${dL.toFixed(4)}`
  + ` (median ${dLs[dLs.length >> 1].toFixed(4)})`);
console.log(`    k = rho/PI = ${k.toFixed(4)}  ->  albedo ${(k * Math.PI).toFixed(3)}`
  + `  (the derivation quotes 0.106 for this surface)\n`);

/* L_ambient: the shaded crown with the lamps' own contribution taken back off,
 * which is now a computable correction rather than an assumption. */
const ambRows = shaded.map((r) => lum(r.L) - k * lum(r.E));
const L0 = ambRows.reduce((a, b) => a + b, 0) / ambRows.length;
const eAmb = L0 / k;
const lShadedRaw = shaded.reduce((a, r) => a + lum(r.L), 0) / shaded.length;
console.log(`  the skylight the lantern has to beat, over ${shaded.length} shaded probes:`);
console.log(`    shaded crown radiance as drawn   ${lShadedRaw.toFixed(4)}`);
console.log(`    minus the lamps' own k * E       ${L0.toFixed(4)}  = L_ambient`);
console.log(`    ambient irradiance E = L / k     ${eAmb.toFixed(3)}`);
console.log(`    (the derivation used L 0.038 -> E 1.13, measured at 4.2 degrees)\n`);

/* ── The lantern side ───────────────────────────────────────────────────────
 *
 * "A real 250 W lantern under itself, 60-100 lux" — under itself, so the pool's
 * own peak, wherever on the ground it falls, which for a batwing distribution is
 * off nadir and out over the footway rather than on the crown. The sun does not
 * enter the mirror's reading, so sunlit probes are usable here even though they
 * are not usable for the skylight term.
 *
 * Reported per lamp and normalised by that lamp's own run-up, because
 * LAMP_CD_FULL is the full-output candela and only one of these seven fixtures is
 * at full output. The normalisation credits a neighbour's contribution to the
 * near lamp, so it reads slightly high for a lamp early in its run-up; the lamp
 * at full output needs no normalising at all and is the one to trust. Both are
 * printed. */
const runup = (w) => Math.pow(Math.max(0, Math.min(1, w)), 0.55);
const LANE = flag('lane', 'crown');
console.log(`  per lamp: the peak of its own pool within 8 m of its column, on the`
  + ` ${LANE === 'any' ? 'whole ground' : LANE}`);
const perLamp = [];
for (const f of out.fixtures) {
  const near = mirrored.filter((r) => Math.abs(r.z - f.z) <= 8 && (LANE === 'any' || r.lane === LANE));
  if (!near.length) { console.log(`    z ${String(f.z).padStart(5)}  no valid probe within 8 m`); continue; }
  const pk = near.reduce((a, r) => (lum(r.E) > lum(a.E) ? r : a));
  const out1 = runup(f.warmth);
  const full = lum(pk.E) / Math.max(out1, 1e-3);
  perLamp.push({ f, pk, full, out1 });
  console.log(`    z ${String(f.z).padStart(5)}  cd ${f.intensity.toFixed(1).padStart(5)}`
    + `  ${(100 * out1).toFixed(0).padStart(3)}% of full`
    + `  peak E ${lum(pk.E).toFixed(3)} on the ${pk.lane} at z ${pk.z}`
    + `  -> at full output ${full.toFixed(3)}`
    + `  = ${(full / eAmb).toFixed(2)} x skylight`);
}

const atFull = perLamp.filter((p) => p.out1 > 0.999);
const chosen = atFull.length
  ? atFull.reduce((a, p) => (p.full > a.full ? p : a))
  : perLamp.reduce((a, p) => (p.full > a.full ? p : a));
const ratioNow = chosen.full / eAmb;
const cdWanted = CD_NOW * (TARGET / ratioNow);

console.log(`\n  anchored on the lamp at z ${chosen.f.z}, ${atFull.length ? 'which is at full output'
  : 'the strongest available, normalised'}`);
console.log(`    peak E ${chosen.full.toFixed(3)} on the ${chosen.pk.lane} at z ${chosen.pk.z},`
  + ` E per channel ${fmt(chosen.pk.E)}`);
console.log(`  RATIO, lantern against skylight: ${ratioNow.toFixed(3)}`);
console.log(`    the derivation targets ${TARGET} and LAMP_CD_FULL is ${CD_NOW}`);
console.log(`    to deliver ${TARGET} it needs ${cdWanted.toFixed(1)} cd`
  + `  (x${(cdWanted / CD_NOW).toFixed(2)})`);
/* The same answer by the other route, as a check: if the lantern side has not
 * changed since the derivation, then the whole correction is the ratio of the two
 * skylight figures and the two numbers below have to agree. */
console.log(`    cross-check: the skylight input moved 1.13 -> ${eAmb.toFixed(3)},`
  + ` x${(eAmb / 1.13).toFixed(2)}, which on its own puts LAMP_CD_FULL at`
  + ` ${(CD_NOW * eAmb / 1.13).toFixed(1)} cd\n`);

/* ── The reduction that needs no transfer at all ────────────────────────────
 *
 *   node tools/lampanchor.mjs --against tmp/anchor-78.json
 *
 * Everything above converts a radiance into an irradiance and back, which needs
 * k, and k is the one quantity in this measurement that two honest routes
 * disagree about by a factor of two. It does not have to be converted. The
 * lantern and the skylight are both contributions to the radiance of the same
 * pixel, so
 *
 *   ratio = E_lamp / E_sky = (k E_lamp) / (k E_sky) = dL_lamp / L_ambient
 *
 * and the lamp's own share of a pixel is separable because it is linear in
 * LAMP_CD_FULL: run this against a run of the same probes at a different
 * candela, and
 *
 *   dL_lamp = (L_hi - L_lo) / (cd_hi/cd_lo - 1)     L_ambient = L_lo - dL_lamp
 *
 * Two radiances and a multiplier. The mirror is used only to locate the peak and
 * to prove the sample is on a mirrored fragment; its level does not enter.
 *
 * The two runs have to be the same frozen world with only the candela between
 * them, which is the same discipline TECHNIQUE §7 asks of any differenced pair,
 * and the exposures are read out of the other run's JSON rather than assumed.
 */
const AGAINST = flag('against', null);
if (AGAINST) {
  const other = JSON.parse(fs.readFileSync(path.resolve(ROOT, AGAINST), 'utf8'));
  const oL = other.lExp ?? 1.0;
  const oE = other.eExp ?? 0.30;
  const hiIsThis = CD_NOW > other.cdNow;
  const scale = hiIsThis ? CD_NOW / other.cdNow : other.cdNow / CD_NOW;
  const cdLo = Math.min(CD_NOW, other.cdNow);
  console.log(`\n  ── differenced against ${AGAINST}: ${other.cdNow} cd vs ${CD_NOW},`
    + ` x${scale.toFixed(3)}`);
  if (Math.abs(scale - 1) < 0.05) {
    console.error('✗ the two runs are at the same candela; there is nothing to difference');
    finish(1);
  }
  const key = (r) => `${r.lane}@${r.z}`;
  const mine = new Map(mirrored.map((r) => [key(r), r]));
  const theirs = new Map();
  for (const r of other.rows) {
    const e1 = toLinear(r.e1).map((v) => v / oE);
    const e2 = toLinear(r.e2).map((v) => v / oE);
    const d = lum(e1) > 0.01 ? lum(e2) / lum(e1) : 0;
    if (d > 1.7 && d < 2.3) theirs.set(key(r), { L: lum(toLinear(r.l).map((v) => v / oL)) });
  }
  const pairs = [];
  for (const [k2, r] of mine) {
    const o = theirs.get(k2);
    if (!o) continue;
    const hi = hiIsThis ? lum(r.L) : o.L;
    const lo = hiIsThis ? o.L : lum(r.L);
    const dLamp = (hi - lo) / (scale - 1);              // the lamp's share at cdLo
    pairs.push({ ...r, dLamp, amb: lo - dLamp, lo });
  }
  if (pairs.length < 20) { console.error(`✗ only ${pairs.length} probes are valid in both runs`); finish(1); }
  const crown = pairs.filter((p) => p.lane === 'crown' && !p.sunlit);
  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const amb = avg(crown.map((p) => p.amb));
  console.log(`    ${pairs.length} probes valid in both; shaded crown ${crown.length}:`
    + ` as drawn ${avg(crown.map((p) => p.lo)).toFixed(4)} at ${cdLo} cd,`
    + ` lamps ${avg(crown.map((p) => p.dLamp)).toFixed(4)}, L_ambient ${amb.toFixed(4)}`);
  if (amb <= 0) { console.error('✗ the ambient came out negative; the two runs are not the same world'); finish(1); }
  const atOne = out.fixtures.filter((f) => runup(f.warmth) > 0.999);
  const wanted = [];
  for (const lane of out.lanes) {
    const near = pairs.filter((p) => p.lane === lane.name
      && atOne.some((f) => Math.abs(f.z - p.z) <= 6));
    if (!near.length) continue;
    const pk = near.reduce((a, p) => (p.dLamp > a.dLamp ? p : a));
    const ratio = pk.dLamp / amb;
    wanted.push({ lane: lane.name, ratio, cd: cdLo * TARGET / ratio, z: pk.z, dLamp: pk.dLamp });
    console.log(`    ${lane.name.padEnd(6)} peak dL ${pk.dLamp.toFixed(4)} at z ${String(pk.z).padStart(4)}`
      + `  ratio ${ratio.toFixed(3)} at ${cdLo} cd, ${(ratio * CD_NOW / cdLo).toFixed(2)} at ${CD_NOW}`
      + `  -> ${TARGET} needs ${(cdLo * TARGET / ratio).toFixed(0)} cd`);
  }
  if (wanted.length) {
    const laneMean = avg(wanted.map((w) => w.ratio));
    console.log(`    the peak averaged over ${wanted.length} lanes: ratio ${laneMean.toFixed(3)}`
      + ` at ${cdLo} cd, ${(laneMean * CD_NOW / cdLo).toFixed(2)} at ${CD_NOW};`
      + ` ${TARGET} needs ${(cdLo * TARGET / laneMean).toFixed(0)} cd`);
    console.log(`    the bracket, lane by lane: ${Math.min(...wanted.map((w) => w.cd)).toFixed(0)}`
      + ` to ${Math.max(...wanted.map((w) => w.cd)).toFixed(0)} cd`);
  }
  /* The guard rail is a comparison between two contributions to one pixel as
   * well, so it is k-free for the same reason and is reported the same way. */
  const sunlit = mirrored.filter((r) => r.sunlit && lum(r.L) - lum(r.LNoSun) > 0.02)
    .map((r) => lum(r.L) - lum(r.LNoSun)).sort((a, b) => a - b);
  if (sunlit.length && wanted.length) {
    const dSun = sunlit[sunlit.length >> 1];
    const pk = Math.max(...wanted.map((w) => w.dLamp)) * CD_NOW / cdLo;
    console.log(`    §3.3: the sun's own share of a sunlit probe is ${dSun.toFixed(3)}`
      + ` (median of ${sunlit.length}); the brightest pool pixel at ${CD_NOW} cd is`
      + ` ${pk.toFixed(3)}, ${(100 * pk / dSun).toFixed(0)}% of it`);
  }
}

console.log('\n  E along each lane (luminance), against the skylight:');
for (const lane of out.lanes) {
  console.log(`    ── ${lane.name} (x ${lane.x})`);
  for (const r of mirrored.filter((q) => q.lane === lane.name)) {
    const bar = '#'.repeat(Math.min(60, Math.round(lum(r.E) / Math.max(eAmb, 1e-3) * 20)));
    console.log(`    z ${String(r.z).padStart(6)}  E ${lum(r.E).toFixed(3)}`
      + `  ${(lum(r.E) / eAmb).toFixed(2)}x  ${r.sunlit ? 'sun' : '   '} ${bar}`);
  }
}

finish(0);
