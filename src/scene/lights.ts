/* System 5: the artificial sources, as data and as GLSL.
 *
 * COLOUR SPACE. Everything in this file is LINEAR SCENE RADIANCE / IRRADIANCE
 * in the same units the sun uses. `artificial()` returns irradiance, which the
 * caller multiplies by BRDF_Lambert(albedo) exactly as three does for its own
 * lights. Nothing here is display-encoded and nothing here is tone-mapped.
 *
 * ── Why almost none of this is a `Light` ──────────────────────────────────
 *
 * The rig this replaces was fourteen unshadowed spotlights with a projected
 * cookie. Measured before removal it changed the shaded frontage by 0.0 per
 * cent and the carriageway at nadir by 0.10 per cent, and it cost a texture
 * unit and NUM_SPOT_LIGHTS in every material program in the street — which is
 * why the three paving materials were running without their baked occlusion.
 *
 * So the budget here is one real Light, the sun, and everything else is
 * evaluated analytically in the materials that actually receive it. That is
 * not the same trade as the old rig made. An analytic source costs four ALU
 * and an early distance reject in five programs; a three.js light costs a
 * uniform block, a loop iteration and a shadow branch in all of them,
 * receiving or not.
 *
 * ── The unit scale, which is what makes the levels derivable ──────────────
 *
 * The sun is a 115 lux DirectionalLight at 4.2 degrees, so the horizontal
 * irradiance it delivers is 115 * sin(4.2) = 8.42. A real sun at 4.2 degrees
 * through that much atmosphere delivers something like 1150 lux horizontal, so
 * this scene runs at about 1/137 of photometric. That factor is what lets a
 * real luminaire be converted rather than guessed:
 *
 *   a 100 W high-pressure sodium lantern peaks at roughly 3300 cd downward
 *   3300 / 137 = 24 cd in this scene's units
 *   E under the lantern = 24 / 6.8^2 = 0.52, which is 6.2% of the sun's 8.42
 *
 * That lands inside the 20-40 cd band the technique brief specifies and it
 * lands there by conversion rather than by taste.
 *
 * ── The one place the scale cannot be honoured, stated plainly ────────────
 *
 * The same conversion applied to the lantern's *bowl* gives a radiance of
 * about 274 (3300 cd over 0.08 m2 of projected bowl, over 137). That clips to
 * white over every pixel of the bowl and would make a lamp that has just
 * struck the brightest object in the frame. The bowl is therefore authored
 * against the measured display response instead — see BOWL below — and comes
 * out about 25x below what the pool implies. This is the same compression
 * env.ts already applies to the solar disc, which it paints at 190 rather than
 * at the 1e5 the real ratio would need, and for the same reason: the frame has
 * one tone curve and the sources have to share it.
 */
import * as THREE from 'three';
import { LAMPS, LAMP_H } from '@/world/dims';
import { atDisplay, forDisplay } from './tone';

/* ── The display response ─────────────────────────────────────────────────
 *
 * Every level in this file is a target 8-bit value pushed backwards through
 * the transform the renderer actually runs — AgX at exposure 0.296, sensor.ts's
 * pedestal, the sRGB encode — by `scene/tone.ts`.
 *
 * It used to be pushed backwards through `display = 0.284 * L^0.4545`, which
 * was a fit to a single point measured through a sheet of glass and is
 * withdrawn. Over the band this scene occupies that fit over-predicts the
 * required radiance by three to six times, so every constant below was several
 * times too hot: the bowl was authored for 214 and arrived at 234, the BAR
 * letters were authored for 225 and arrived at 245, which is white. The
 * targets are unchanged and were never the problem; the inversion was.
 *
 * Re-exported because System 2's lit rooms and television are authored the
 * same way and were carrying the same error.
 */
export { forDisplay };

/** Horizontal irradiance from the sun, for every ratio quoted in this file. */
export const SUN_HORIZ = 115 * Math.sin(4.2 * Math.PI / 180);   // 8.42

/* ── Street lamps ─────────────────────────────────────────────────────────
 *
 * Three states, and the point of having three is colour rather than level.
 * A sodium lamp at strike is a dull red-pink glow off the starting gas and
 * takes five to ten minutes to reach its working orange, so a street at the
 * moment the lamps come on is a street where they disagree with each other.
 * Two of the seven are not lit at all, which is more convincing than any
 * amount of tuning the two that are.
 */
export const LAMP_OFF = 0, LAMP_WARMING = 1, LAMP_WARM = 2;

/** Per lamp in `LAMPS` order: z = 12, -8, -25, -45, -64, -84, -99. */
export const LAMP_STATE: readonly number[] = [
  LAMP_WARM,      //  12   behind the start of the walk, closes the view back
  LAMP_WARMING,   //  -8   the near one, and the one that reads as just struck
  LAMP_OFF,       // -25   dead, outside the lit convenience store
  LAMP_WARM,      // -45   in the sun shaft, so it has daylight to lose against
  LAMP_WARMING,   // -64   at the cross street
  LAMP_WARM,      // -84
  LAMP_OFF,       // -99   the far end of the block
];

/* Bowl radiance.
 *
 *   warm     display 214 in red -> L = (4.73, 2.22, 0.61), arriving at
 *            (213, 182, 146). Chromaticity (1.00, 0.47, 0.13), which is HPS
 *            rather than the monochromatic 589 nm of a low-pressure lamp.
 *   warming  display 132 in red -> L = (0.67, 0.20, 0.24), arriving at
 *            (131, 82, 88) — a dull red-pink, not a dim orange.
 *
 * Both were previously inverted through the withdrawn fit and both arrived
 * high: shot as authored the bowls came off disk at (234, 211, 184) and
 * (220, 180, 185), which is to say the lamp that has just struck was reading
 * as bright as the working one and the whole point of having a warming state
 * was gone. That was diagnosed at the time as the AgX shoulder flattening two
 * different radiances onto adjacent code values, and a 0.325 factor was fitted
 * to one captured point to pull the warming lamp back down.
 *
 * Both halves of that were wrong in the same direction. The shoulder was real
 * but it was not the cause: 10.85 and 3.75 were themselves the outputs of a
 * bad inverse, and the correct radiances for those two targets are 4.73 and
 * 0.67. The 0.325 patch is deleted rather than re-fitted, because with the
 * transform inverted properly there is nothing left for it to correct — the
 * separation the warming state needs, 82 code values, now falls out of the two
 * target numbers directly.
 */
export const BOWL_WARM = atDisplay(214, [1.0, 0.47, 0.13]);
export const BOWL_WARMING = atDisplay(132, [1.0, 0.30, 0.36]);

/* Pool intensity. 24 cd for a working lantern, by the conversion at the top of
 * this file. The warming one is scaled by the ratio of the two bowl radiances,
 * now 0.67 / 4.73 = 0.142, so the thing you look at and the thing it does to
 * the pavement cannot drift apart. Fourteen per cent of working output is also
 * about right for a discharge lamp in the first minute of its run-up, which is
 * a check on the two targets rather than a coincidence. */
export const LAMP_CD_WARM = 24;
export const LAMP_CD_WARMING = LAMP_CD_WARM * (BOWL_WARMING[0] / BOWL_WARM[0]);

/** How far the lantern reaches out from its column, toward the carriageway. */
export const LAMP_OUTREACH = 1.15;

/** World position of lamp `i`'s lantern — the column is at LAMPS[i]. */
export function lampHead(i: number): [number, number, number] {
  const [x, , z] = LAMPS[i];
  return [x - Math.sign(x) * LAMP_OUTREACH, LAMP_H, z];
}

/* ── Neon, as a source rather than as a surface ───────────────────────────
 *
 * A 30 W sign against 8.42 of sun contributes nothing to the street and must
 * not be given a light. What it does do for free is wash the board it is
 * bolted to and the reveal behind it, and that is a metre-scale effect worth
 * one entry in the analytic array each.
 *
 * Intensity is radiance times emitting area, not a chosen number, and it is
 * computed in world/neon.ts from these constants and the geometry it has just
 * built rather than transcribed here — the two drifted once already.
 */
export const NEON_RED = atDisplay(225, [1.0, 0.16, 0.06]);    // -> (224, 153, 126)
export const NEON_GREEN = atDisplay(215, [0.12, 1.0, 0.28]);  // -> (171, 215, 176)
/* The OPEN sign is behind glass and is seen through a pane carrying the
 * reflection of a sunlit wall opposite, so it is authored a stop over the
 * bar's tubes to survive being composited under that. */
export const NEON_OPEN = atDisplay(232, [1.0, 0.19, 0.09]);

/* Traffic signal aspects. These are LEDs behind a lens rather than discharge
 * tubes, and they are the most saturated and the brightest artificial thing in
 * the frame — which is correct: a signal is engineered to be legible against a
 * low sun, and the sun here is at 4.2 degrees. Authored at the top of the
 * display range in their peak channel and left almost monochromatic. */
export const SIG_RED = atDisplay(238, [1.0, 0.055, 0.030]);
export const SIG_AMBER = atDisplay(236, [1.0, 0.440, 0.045]);
export const SIG_GREEN = atDisplay(228, [0.11, 1.0, 0.460]);

/* ── The uniform arrays ───────────────────────────────────────────────────
 *
 * One point-source array for everything with a position, and a separate
 * aperture array for the two lit shopfronts, which are large enough that a
 * point is the wrong model for them at the distance they are seen from.
 *
 * The arrays are module-level and shared by every material that reads them, so
 * there is exactly one copy of the data and a material cannot be looking at a
 * stale one.
 */
export const ART_PT = 14;   // 7 lamps, 4 car sidelights, 3 neon signs
export const ART_AP = 2;    // the convenience store and the bar

const ptP: THREE.Vector4[] = [];   // xyz world position, w intensity (cd)
const ptD: THREE.Vector4[] = [];   // xyz emission axis, w distribution exponent
const ptC: THREE.Vector3[] = [];   // chromaticity, peak channel 1
for (let i = 0; i < ART_PT; i++) {
  ptP.push(new THREE.Vector4(0, -1000, 0, 0));
  ptD.push(new THREE.Vector4(0, -1, 0, 0));
  ptC.push(new THREE.Vector3(1, 1, 1));
}

const apC: THREE.Vector4[] = [];   // xyz aperture centre, w half width
const apN: THREE.Vector4[] = [];   // xyz outward normal, w half height
const apL: THREE.Vector4[] = [];   // rgb aperture-plane radiance, w bay pitch
for (let i = 0; i < ART_AP; i++) {
  apC.push(new THREE.Vector4(0, -1000, 0, 1));
  apN.push(new THREE.Vector4(1, 0, 0, 1));
  apL.push(new THREE.Vector4(0, 0, 0, 1.4));
}

/** Scene clock for the two things in System 5 that move. See freezeTime. */
export const SYS5_TIME = { value: 0 };

/* ── The mirror ───────────────────────────────────────────────────────────
 *
 * Zero in every shipped frame. Set non-zero and every material that receives
 * artificial light stops shading and outputs `artificial()` itself, scaled by
 * this, as its whole radiance.
 *
 * It is here permanently, and one uniform compare in five programs is the
 * price. This project's most expensive and most repeated failure is code that
 * looks correct and is inert — envMapIntensity, the haze installer, a silent
 * GLSL redeclaration — and every one of them cost rounds because the only
 * available test was "tune the number and see whether the picture moves",
 * which cannot distinguish a small effect from no effect. Rendering the probe
 * input raw can: a dead path is black, and a live one is a value that can be
 * inverted through tools/agx.mjs and checked against the arithmetic that
 * authored it. Two of System 5's four P0 defects were settled with it.
 */
export const ART_DBG = { value: 0 };

const UNIFORMS = {
  uArtP: { value: ptP },
  uArtD: { value: ptD },
  uArtC: { value: ptC },
  uArtAC: { value: apC },
  uArtAN: { value: apN },
  uArtAL: { value: apL },
  uArtDbg: ART_DBG,
  uSysTime: SYS5_TIME,
};

/** Every material that receives artificial light merges this into its uniforms. */
export function artificialUniforms(): Record<string, { value: unknown }> {
  return UNIFORMS;
}

function setPoint(
  i: number, pos: readonly number[], axis: readonly number[],
  cd: number, expo: number, colour: readonly number[],
): void {
  const peak = Math.max(colour[0], colour[1], colour[2], 1e-6);
  ptP[i].set(pos[0], pos[1], pos[2], cd);
  ptD[i].set(axis[0], axis[1], axis[2], expo);
  ptC[i].set(colour[0] / peak, colour[1] / peak, colour[2] / peak);
}

/** The seven lanterns. Called once; the installation is static. */
export function installLamps(): void {
  for (let i = 0; i < LAMPS.length; i++) {
    const st = LAMP_STATE[i];
    const cd = st === LAMP_WARM ? LAMP_CD_WARM
      : st === LAMP_WARMING ? LAMP_CD_WARMING : 0;
    const col = st === LAMP_WARM ? BOWL_WARM : BOWL_WARMING;
    /* The distribution, and it is the one part of the removed cookie worth
     * keeping. A cobra head throws down and along the street with a hard
     * cut-off on the house side; the exponent below is a cosine power fitted
     * to a semi-cut-off distribution, tipped 22 degrees toward the
     * carriageway. Everything else the cookie carried — the bowl dirt, the
     * ragged edge, the offset core — is invisible at 6% of the sun and cost
     * the texture unit that forced the AO maps out. */
    const head = lampHead(i);
    const tilt = -Math.sign(head[0]) * 0.37;   // tipped toward x = 0
    setPoint(i, head, [Math.sin(tilt), -Math.cos(tilt), 0], cd, 1.6, col);
  }
}

/** The four sidelight lenses on the one car that has them switched on. */
export function installCarLights(
  lights: readonly { pos: [number, number, number]; dir: [number, number, number];
                     width: number; height: number; colour: [number, number, number] }[],
): void {
  for (let k = 0; k < 4; k++) {
    const i = 7 + k;
    const l = lights[k];
    if (!l) { ptP[i].set(0, -1000, 0, 0); continue; }
    /* Radiance times lens area, and that is the whole derivation. A rear lens
     * is authored at 0.330 in red over 0.24 x 0.26 m, so I = 0.330 * 0.062 =
     * 0.0205 cd; at 0.8 m from the road that is E = 0.032, four parts in a
     * thousand of the sun. It is implemented at that value and not one count
     * above it. The only place it is visible at all is inside the car's own
     * contact shade, which is exactly where a real one is visible. */
    const area = l.width * l.height;
    const cd = Math.max(l.colour[0], l.colour[1], l.colour[2]) * area;
    // The axis is the direction the lens emits in, which is its outward normal.
    setPoint(i, l.pos, l.dir, cd, 0.8, l.colour);
  }
}

/* The neon signs whose wash on their own board is worth stating.
 *
 * ── The exponent, which was zero light rather than a wrong amount ─────────
 *
 * `dis = pow(max(-dot(L, axis), 0), expo)` measures the angle between the
 * emission axis and the direction from the source to the receiver. Every neon
 * source was registered with `axis` = the host wall's outward normal and
 * `expo` = 0.6, and the surface each of them exists to wash is the wall
 * *behind* it — which is at exactly 180 degrees to that axis. So `ax` clamped
 * to zero, `pow(0.0, 0.6)` evaluated to zero, and all three neon sources
 * delivered precisely nothing to the only surfaces they were in the array for.
 * The pharmacy cross was documented as putting 60% of the sun's horizontal
 * irradiance on the render behind it and was putting none.
 *
 * It is not enough to flip the axis, because the sign of the error is not the
 * error. Two different objects are being described by one model:
 *
 *   an exposed tube — the cross, the bar's edge tubes — is a glass cylinder
 *   with nothing behind it, and it radiates over the whole sphere. There is no
 *   axis. `expo = 0` selects the isotropic branch, and the wall behind gets
 *   the back half of the tube, which is what actually lights it.
 *
 *   a tray sign — OPEN — is a box with a black back and a lit face, and it
 *   genuinely does emit into a lobe about its outward normal. Its axis was
 *   never wrong; it has no wall behind it to wash, only the reveal and the
 *   stall riser beside it, and a broad lobe reaches those.
 *
 * So the model comes from the caller, which is the only place that knows which
 * of the two an entry is.
 */
export function installNeon(
  entries: readonly { pos: [number, number, number]; dir: [number, number, number];
                      cd: number; expo: number; colour: readonly number[] }[],
): void {
  for (let k = 0; k < 3; k++) {
    const i = 11 + k;
    const e = entries[k];
    if (!e) { ptP[i].set(0, -1000, 0, 0); continue; }
    setPoint(i, e.pos, e.dir, e.cd, e.expo, e.colour);
  }
}

/* ── The shopfront apertures ──────────────────────────────────────────────
 *
 * `window.__shopLights` publishes the rectangle, its outward normal and the
 * linear RGB the interior is authored at. What it does not publish, and what
 * decides whether the pool reads as a pool or as a decal, is the radiance
 * leaving the *aperture plane* — which is not the ceiling's radiance.
 *
 * Derived from the interior shader rather than guessed:
 *
 *   the store's ceiling emits LIT_STORE * 1.55 * uLitGain = 0.80*1.55*1.35
 *     = 1.674 in red over about 6.1 m2
 *   every other surface in the room is lit rather than emitting, at
 *     lc * 11 * albedo * recv, which works out between 0.03 and 0.08
 *
 * The number this used to carry was 0.47, and it was the wrong quantity. It
 * came from a flux balance: pi * 1.674 * 6.09 = 32.0 leaves the ceiling, about
 * a third of it escapes, M = 10.6 / 7.25 = 1.46, L = M/pi = 0.47. That is the
 * aperture's mean exitance averaged over every direction and over the whole
 * opening. A patch of paving does not receive the mean. It receives the
 * radiance of whatever it can actually SEE through the opening, along the one
 * direction that joins them, and from below a shop window that is the ceiling
 * almost the whole way up.
 *
 * Ray-trace it by hand for the store. Pavement at y = 0.03, glazing from 0.95
 * to 3.33, room 2.1 m deep, ceiling at 3.4. The ray that just grazes the
 * ceiling's back edge climbs 3.37 m over 2.1 m of room; from a receiver 2 m
 * out it crosses the glass at y = 1.67. Everything above that — 70% of the
 * opening — is ceiling at 1.674. Below it is back wall at 0.05. So the
 * radiance arriving is 0.70 * 1.674 + 0.30 * 0.05 = 1.19, not 0.47. Take a
 * quarter off for shelving, stock, blinds and the back-bar clutter that stand
 * in that line of sight and are all darker than the ceiling: 0.90.
 *
 * The geometry term was overstated in the same breath. A 5.14 m2 opening seen
 * from 1.2 m out and 2.11 m below subtends A cos/d2 = 0.43 sr, not the 1.0 sr
 * this file used to claim, and the receiver's cosine is 0.87, not 0.75. Both
 * errors were live: at 0.47 the debug mirror measures E = 0.146 on the paving
 * outside the store, against the 0.35 the old comment asserted. Fixing the
 * radiance and keeping the true geometry puts it at 0.34 for the store and
 * 0.63 outside the bar's much wider glass — 4.0% and 7.5% of the sun's
 * horizontal, which lands on the technique brief's own independent estimate of
 * 12% for a placeholder aperture at 0.8. Two derivations that started from
 * different ends agreeing is the best evidence available without a photometer.
 *
 * Colour is pulled toward neutral, not pushed. LIT_STORE is pre-compensated
 * for the AgX shoulder — authored at a red-to-blue ratio of 2.07 to land at
 * 1.25 on an emissive ceiling — and a pool on paving sits far lower on the
 * curve and keeps much more of its chroma from the same numbers. The brief
 * asks for a delivered R:B of 1.6-1.8, which is (1.00, 0.70, 0.425).
 */
const AP_RADIANCE = 0.90;   // red, as seen from the paving — mostly ceiling
const AP_STORE: [number, number, number] = [1.0, 0.70, 0.425];
/* The bar is tungsten behind a back bar rather than fluorescent over stock, so
 * it keeps more of its warmth; the same neutralising move, two thirds as far.
 * Its ceiling is authored at 0.74 against the store's 0.80, so its aperture
 * scales with it. */
const AP_BAR: [number, number, number] = [1.0, 0.50, 0.22];

export function installShopLights(
  lights: readonly { kind: string; pos: [number, number, number];
                     dir: [number, number, number]; width: number; height: number }[],
): void {
  for (let k = 0; k < ART_AP; k++) {
    const l = lights[k];
    if (!l) { apC[k].set(0, -1000, 0, 1); apL[k].set(0, 0, 0, 1.4); continue; }
    const bar = l.kind === 'bar';
    const chroma = bar ? AP_BAR : AP_STORE;
    const scale = AP_RADIANCE * (bar ? 0.74 / 0.80 : 1.0);
    apC[k].set(l.pos[0], l.pos[1], l.pos[2], l.width * 0.5);
    apN[k].set(l.dir[0], l.dir[1], l.dir[2], l.height * 0.5);
    /* The fourth slot is the mullion pitch. street3 divides a bay into one to
     * three lights, so a 2.5-3 m unit carries a division about every 1.2 m and
     * the pool outside it is banded at that pitch. */
    apL[k].set(chroma[0] * scale, chroma[1] * scale, chroma[2] * scale, 1.2);
  }
}

/* ── GLSL ─────────────────────────────────────────────────────────────────
 *
 * In:  world position, world *geometric* normal.
 * Out: linear irradiance in scene units.
 *
 * The geometric normal is used rather than the shaded one deliberately. At
 * 4.2 degrees a 0.42 normal perturbation swings N.L sevenfold between adjacent
 * pixels, and a source at 6% of the sun modulated by that is a field of
 * speckle rather than a pool. The pools are metre-scale features and want a
 * metre-scale normal.
 */
export const ARTIFICIAL = /* glsl */ `
#define ART_PT ${ART_PT}
#define ART_AP ${ART_AP}
uniform vec4 uArtP[ART_PT];
uniform vec4 uArtD[ART_PT];
uniform vec3 uArtC[ART_PT];
uniform vec4 uArtAC[ART_AP];
uniform vec4 uArtAN[ART_AP];
uniform vec4 uArtAL[ART_AP];
uniform float uArtDbg;

vec3 artificial(vec3 P, vec3 N){
  vec3 E = vec3(0.0);

  for (int i = 0; i < ART_PT; i++){
    vec3 d = uArtP[i].xyz - P;
    /* Floored at 200 mm. An inverse square with no floor is a singularity
     * sitting inside the geometry of every fitting, and the one place it would
     * fire is the lamp column at the foot of its own lantern. */
    float d2 = max(dot(d, d), 0.04);
    /* Cull below a quarter of a per cent of the sun's horizontal irradiance,
     * without a divide. This is what keeps thirteen sources affordable in five
     * programs: on most fragments the loop rejects all but one or two of them
     * on a single compare. */
    if (uArtP[i].w < 0.021 * d2) continue;
    vec3 L = d * inversesqrt(d2);
    float ndl = max(dot(N, L), 0.0);
    if (ndl <= 0.0) continue;
    float ax = max(-dot(L, uArtD[i].xyz), 0.0);
    float dis = uArtD[i].w > 0.0 ? pow(ax, uArtD[i].w) : 1.0;
    E += uArtC[i] * (uArtP[i].w * dis * ndl / d2);
  }

  /* The shopfront apertures.
   *
   * A rectangle rather than a disc, because the pool on the ground outside a
   * shop window is a trapezoid brightest immediately outside the glass and the
   * shape is most of what identifies it. Integrated as a three-by-two
   * quadrature over the aperture rather than by a closed-form solid angle:
   * three sub-sources across the width is what gives the pool its correct
   * lateral spread within a metre of the glass, where a single point source
   * would collapse it to a circle, and it costs six multiply-adds against two
   * transcendentals for the exact form factor. */
  for (int a = 0; a < ART_AP; a++){
    vec3 C = uArtAC[a].xyz;
    vec3 nA = uArtAN[a].xyz;
    vec3 toC = C - P;
    if (dot(toC, toC) > 340.0) continue;      // 18 m
    // Anything behind the glass is inside the shop and is System 3's already.
    if (dot(toC, nA) > 0.0) continue;
    vec3 uA = normalize(cross(vec3(0.0, 1.0, 0.0), nA));
    float hw = uArtAC[a].w, hh = uArtAN[a].w;
    float aSub = (2.0 * hw) * (2.0 * hh) / 6.0;
    float acc = 0.0;
    for (int j = 0; j < 6; j++){
      float su = (float(j - (j / 3) * 3) - 1.0) * 0.6667;
      float sv = float(j / 3) - 0.5;
      vec3 S = C + uA * (su * hw) + vec3(0.0, sv * hh, 0.0);
      vec3 d = S - P;
      float d2 = max(dot(d, d), 0.09);
      vec3 L = d * inversesqrt(d2);
      float ndl = max(dot(N, L), 0.0);
      float cs = max(-dot(L, nA), 0.0);
      acc += aSub * cs * ndl / d2;
    }
    /* Mullion divisions, as a modulation along the aperture's own u axis at
     * the bay pitch. A shopfront is two or three lights with a slim mullion
     * between them, and the pool outside it carries those divisions as soft
     * dark bands — which is the single cheapest thing that stops a spill
     * reading as an airbrushed ellipse. Projected perpendicularly rather than
     * along the light path, which is a small error at the distances this is
     * visible and saves resolving the shadow of a 28 mm stile. */
    float mu = dot(P - C, uA);
    float bands = pow(0.5 + 0.5 * cos(6.28318 * mu / max(uArtAL[a].w, 0.3)), 8.0);
    E += uArtAL[a].rgb * acc * (1.0 - 0.20 * bands);
  }

  return E;
}
`;

/**
 * The receiving end, for a material's `lights_fragment_end`.
 *
 * Diffuse only. A source at a few per cent of the sun has a specular lobe
 * worth a few per cent of a few per cent, and adding one at these grazing
 * angles buys nothing but a chance of a hot streak down the gutter.
 */
export const artificialAdd = (worldNormal: string) => /* glsl */ `
{
  vec3 artE = artificial(vWPos, normalize(${worldNormal}));
  reflectedLight.directDiffuse += artE * BRDF_Lambert(diffuseColor.rgb);
  /* The mirror. See ART_DBG. Uniform-branch, so it is one compare and never a
   * divergent one, and the whole surface leaves as the irradiance that reached
   * it multiplied by a known gain — which is a quantity tools/agx.mjs can
   * invert, rather than a quantity that has been through an albedo, a BRDF, a
   * canyon term and a bounce. */
  if (uArtDbg > 0.0) {
    reflectedLight.directDiffuse = artE * uArtDbg;
    reflectedLight.indirectDiffuse = vec3(0.0);
    reflectedLight.directSpecular = vec3(0.0);
    reflectedLight.indirectSpecular = vec3(0.0);
    totalEmissiveRadiance = vec3(0.0);
  }
}
`;

/* ── The clock ────────────────────────────────────────────────────────────
 *
 * Two things in System 5 move: the traffic signal's aspect and the flicker of
 * the television in the second-floor window. Both are driven from this one
 * uniform so that a capture can pin them — `window.__sys5.freeze(t)` holds the
 * clock at t, which is what makes a differenced pair of frames measure the
 * change under test rather than the difference between two cuts of a
 * television programme.
 */
declare global {
  interface Window {
    __sys5?: {
      freeze(t: number): void; run(): void; readonly time: number;
      /** Render `artificial()` raw at this gain. 0 restores the scene. */
      mirror(gain: number): void;
      /** The registered sources, so a probe can predict what it is measuring. */
      dump(): {
        pt: { pos: number[]; cd: number; axis: number[]; expo: number; col: number[] }[];
        ap: { c: number[]; hw: number; n: number[]; hh: number; L: number[] }[];
      };
    };
  }
}

let frozen: number | null = null;

export function advanceTime(dt: number): void {
  if (frozen === null) SYS5_TIME.value += dt;
}

export function installTimeControl(): () => void {
  window.__sys5 = {
    freeze(t: number) { frozen = t; SYS5_TIME.value = t; },
    run() { frozen = null; },
    get time() { return SYS5_TIME.value; },
    mirror(gain: number) { ART_DBG.value = gain; },
    dump() {
      return {
        pt: ptP.map((p, i) => ({
          pos: [p.x, p.y, p.z], cd: p.w,
          axis: [ptD[i].x, ptD[i].y, ptD[i].z], expo: ptD[i].w,
          col: [ptC[i].x, ptC[i].y, ptC[i].z],
        })),
        ap: apC.map((c, i) => ({
          c: [c.x, c.y, c.z], hw: c.w,
          n: [apN[i].x, apN[i].y, apN[i].z], hh: apN[i].w,
          L: [apL[i].x, apL[i].y, apL[i].z],
        })),
      };
    },
  };
  return () => { delete window.__sys5; };
}
