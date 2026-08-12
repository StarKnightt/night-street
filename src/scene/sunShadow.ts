/* The sun's shadow frustum. One definition, imported by everything that has to
 * agree with it.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * The frustum was described in two places. `Street.tsx` held `SHADOW_HALF_W`,
 * `SHADOW_TOP`, `SHADOW_BOTTOM`, near and far and built the ortho camera from
 * them; `softShadow.ts` held `SUN_SHADOW` with the same five numbers typed out
 * again, and *generated them into GLSL as literals* — `SUN_FRUSTUM_W`,
 * `SUN_FRUSTUM_H`, `SUN_DEPTH_RANGE`. The PCSS filter converts its world-unit
 * radii into shadow-map UV by dividing by those, and turns a depth difference
 * back into metres by multiplying by that range, so a disagreement between the
 * two files does not produce a wrong-looking frustum. It produces a penumbra
 * of the wrong width and a blocker separation of the wrong magnitude, silently,
 * in a build that still typechecks and still renders a plausible shadow.
 *
 * That is precisely the failure `NOTES.md` names as this project's most
 * expensive recurring one, in its worst form: a duplicate that reaches GLSL as
 * a compile-time literal, where `tsc` cannot see it and grep for the symbol
 * will not find it. The rule from that note is followed here — the derived
 * values below are computed, however trivial the arithmetic, and the shader
 * interpolates them rather than restating them.
 *
 * ── The geometry problem this shape solves ────────────────────────────────
 *
 * A directional shadow map is a box aligned to the light. Three's default
 * orientation comes from `lookAt` with world up, which puts the box's
 * horizontal axis horizontal — a sensible default and the wrong one for a
 * street canyon lit along its length.
 *
 * At 12 degrees elevation and 35 degrees of azimuth, the two axes of a
 * level-oriented box both pick up street length, so both are spent by walking
 * and the smaller one runs out first. `tools/shadowview.mjs` projects ground
 * points into the live shadow camera and shows exactly where: from a camera at
 * z -49.9, road at z -60 was inside, and z -75, -83, -91 and -98 were all
 * outside — every one of them on the *vertical* axis, at ndc y -1.07, -1.18,
 * -1.28, -1.37. The ground was falling out of the bottom of the box about ten
 * metres ahead of the walker, on a street the haze leaves readable for eighty.
 * Past that, receivers are outside the frustum, three's shadow lookup reports
 * them *lit*, and the far end of the street has no cast shadows at all — in
 * stills and in the live walk equally.
 *
 * Rolling the box so that one axis runs along the street fixes the split
 * rather than paying for it. The cross-section axis comes out as
 * (-0.348, 0.938, 0) — no z component whatsoever — so street length is spent
 * by exactly one axis, and walking straight down the street does not move the
 * lattice on the other one at all. That is visible in the same probe: with the
 * roll, all seven ground points sit at ndc y -0.624, the *same* value, and
 * only x advances. Measured over the corridor a walker can see, the required
 * box goes from 80 x 47 m to 88 x 34 m: 21 per cent less area, and, far more
 * usefully, an aspect ratio a non-square map can pay for cheaply.
 *
 * ── Why not cascades ──────────────────────────────────────────────────────
 *
 * They are the textbook answer and they are not worth it here, but the reason
 * has to be stated in the density that reaches the road rather than the one on
 * the frustum's own axes. Those are 10.99 and 7.81 mm here against a shipped
 * 10.74 and 6.35, which reads like a wash and is not the quantity: the axes
 * are tilted with respect to the ground, and rolling the box tilts them
 * further, so the nominal figure would credit this arrangement with a
 * sharpness it does not deliver. Measured instead — `shadowview.mjs`
 * differentiates the live shadow camera's own projection at road level — one
 * texel covers 328 mm² of road before and 413 after, and the finest axis on
 * the ground goes from 10.7 mm to 18.4 mm.
 *
 * So it is a real coarsening of about a quarter by area, bought for roughly
 * eight times the length of street. It does not reach the picture, because at
 * this elevation the near-field terminator is already wider than either
 * figure: the sun's own half-degree makes a penumbra, and `tools/edgewidth.mjs`
 * puts the 10-90 transition of a bollard's shadow at 15.41 px before and 15.01
 * after on one edge, 11.67 and 11.76 on the other. Both differences are under
 * half a pixel and one of them is the wrong sign for a texel argument, which
 * is what it looks like when the filter, not the lattice, is setting the width.
 *
 * A cascade split therefore buys nothing that is not already bought, and it
 * would cost a second depth pass, a second PCSS evaluation in every material
 * program in the scene (which §3.2 of `docs/TECHNIQUE.md` rules out for a
 * second *light* for the same reason), and a per-fragment cascade selection.
 *
 * There is also a hard structural obstacle worth recording, because it rules
 * out the view-fitted variant as well: `SUN_FRUSTUM_W`, `SUN_FRUSTUM_H` and
 * `SUN_DEPTH_RANGE` are compile-time literals in the PCSS shader. A frustum
 * whose extents change at runtime — which is what fitting to the visible set
 * means — would need them as uniforms, and the shader would then be doing two
 * divisions per tap that are currently constant-folded. A fixed box that is
 * simply the right shape avoids the whole question.
 */
import * as THREE from 'three';

import { SUN_DIR } from './sun';

/* ── The control, and why it has to live here ──────────────────────────────
 *
 * `?oldbox` restores the shipped frustum exactly: 44 x 26 m about a target 8 m
 * ahead, 4096², a 60 m stand-off and a 1..150 depth range, with three's
 * default level orientation. Read once at module load, because
 * `softShadow.ts` bakes these into GLSL as literals when it installs — so a
 * switch consulted any later than this would move the box and leave the
 * filter's idea of it behind, which is the exact failure this file was
 * written to make impossible.
 *
 * It exists because the honest experiment is the change itself as the only
 * variable, and this tree cannot supply that any other way: another pass is
 * live in `world/cars.ts` while this one runs, so two captures taken an hour
 * apart differ by their work as well as by mine — and the first before/after
 * pair taken that way showed the near cars going from shaded to sunlit, which
 * was entirely theirs. `NOTES.md` records the same mistake being made against
 * the screenshot archive; `shadowab.mjs` avoids it the same way, by toggling
 * one term inside one page load.
 */
const OLD = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).has('oldbox');

/* ── The corridor the box is fitted to ──────────────────────────────────────
 *
 * Measured with `tools/shadowview.mjs --fit`, which clips every mesh's world
 * bounding box to this stretch of canyon and accumulates the corners in light
 * space. The extents below are that fit, rounded outward.
 *
 * Ahead: `FogExp2` at 0.0072 leaves a surface at 80 m still about 72 per cent
 * visible and the built street ends near z -105, so 80 m covers everything a
 * walker can read. Behind: 25 m, which is roughly what the shipped box reached
 * behind its own target, so turning round is no worse than it was. Sideways:
 * 12 m, the canyon plus the depth of the frontages — the apron behind the
 * terrace is not visible from the street and is in permanent shade.
 *
 * Casters are not in this fit and do not need to be. A caster lies on the
 * shadow ray through the point it shades, so it has the same u and v as its
 * receiver by construction; it costs depth only, which is what STANDOFF and
 * FAR below are for.
 */
export const SHADOW_CORRIDOR = { halfWidth: 12, ahead: 80, behind: 25, height: 22 } as const;

/** Shadow map resolution. Long axis along the street, short axis across it. */
export const SHADOW_RES_U = OLD ? 4096 : 8192;
export const SHADOW_RES_V = 4096;

/** Half-extent along the street axis, world metres. Fit: ±44.4. */
export const SHADOW_U = OLD ? 22 : 45;
/** Extents across the canyon, world metres, about the target. Fit: -7.1 .. 22.9. */
export const SHADOW_V_BOTTOM = OLD ? -4 : -8;
export const SHADOW_V_TOP = OLD ? 22 : 24;

/* How far down the street the box centre leads the camera.
 *
 * This was 8 m, chosen when the sun was at 4.2 degrees, with the reasoning
 * that "the interesting shadows are the ones being cast toward the camera from
 * further down the street". The reasoning still holds; the number does not,
 * and it never was the quantity that governs. The lead is what centres a box
 * of a given reach on the stretch it has to cover, so it is
 * (ahead − behind) / 2 and nothing else — 27.5 m for this corridor. The fit
 * puts the centre of the required extents 23.6 m ahead of where the 8 m lead
 * left it, and 23 is where the fit sits closest to centred across all three
 * walk stops measured: the required u range comes out -44.8 .. +44.6 against
 * the ±45 below, so nothing is clipped anywhere on the walk.
 *
 * At 8 m with these extents the box would waste 15 m of its reach behind the
 * walker and clip 15 m off the far end, which is the same defect one degree
 * smaller.
 */
export const SHADOW_LEAD = OLD ? 8 : 23;

/* The 2 m lift, unchanged, and it goes on both the light and the target so
 * that the vector between them stays exactly `SUN_DIR`. Lifting only the light
 * raked the shadow map about 1.9 degrees above the sky's own sun. */
export const SHADOW_LIFT = 2;

/* How far back along the beam the light stands, and the depth range.
 *
 * Depth costs no resolution in an orthographic projection, and this is the
 * axis the old configuration was quietly shortest on. The stand-off was 60 m
 * with a near plane at 1, so a caster more than 59 m up-sun of the target was
 * *behind the light* and absent from the depth pass — which at this elevation
 * is anything over 12.3 m tall. `tools/poolshade.mjs` found exactly that: six
 * probes at the far end whose blocker sat 68 to 76 m up-sun, clipped, and the
 * ground under them rendering 66 to 84 per cent sunlit.
 *
 * The tallest thing on the street is about 22 m including the water tanks, and
 * 22 / sin(12°) is 106 m of beam, so the stand-off has to clear the deepest
 * receiver plus that. Both terms are computed rather than typed.
 */
const SIN_ELEV = SUN_DIR[1];
/** Beam length from the tallest caster down to the ground it shades. */
export const SHADOW_CASTER_REACH = SHADOW_CORRIDOR.height / SIN_ELEV;

/* How far up- and down-sun the corridor itself reaches, from its own centre.
 *
 * The eight corners of the corridor box projected onto the beam. Written out
 * because the alternative is to state the answer, and a stand-off that is
 * stated rather than derived is a number that goes on looking right on the
 * day the corridor changes — which is the failure the rest of this file is
 * arranged to prevent, and which this very constant committed in its first
 * draft: `SHADOW_CASTER_REACH` was computed, described in the comment above as
 * one of two terms that "are computed rather than typed", and then not used by
 * the 180 typed underneath it.
 */
const CORRIDOR_BEAM = (() => {
  const c = SHADOW_CORRIDOR;
  // Corner ranges relative to the box target, which sits SHADOW_LEAD ahead.
  const rx = [-c.halfWidth, c.halfWidth];
  const ry = [-3 - SHADOW_LIFT, c.height - SHADOW_LIFT];
  const rz = [-(c.ahead - SHADOW_LEAD), c.behind + SHADOW_LEAD];
  let lo = Infinity, hi = -Infinity;
  for (const x of rx) for (const y of ry) for (const z of rz) {
    const w = x * SUN_DIR[0] + y * SUN_DIR[1] + z * SUN_DIR[2];
    if (w < lo) lo = w;
    if (w > hi) hi = w;
  }
  return { lo, hi };
})();

export const SHADOW_NEAR = 1;
/* Clear of the furthest-up-sun receiver, plus the beam of a caster standing on
 * it, plus the near plane. Rounded up to the metre so the number in a log is
 * readable, which costs nothing on an axis that costs no resolution. */
export const SHADOW_STANDOFF = OLD ? 60
  : Math.ceil(CORRIDOR_BEAM.hi + SHADOW_CASTER_REACH + SHADOW_NEAR);
/** Far enough to reach the deepest receiver in the corridor. */
export const SHADOW_FAR = OLD ? 150
  : Math.ceil(SHADOW_STANDOFF - CORRIDOR_BEAM.lo);

/** The snap grid, and the one both followers must agree on. */
export const SHADOW_TEXEL = (SHADOW_U * 2) / SHADOW_RES_U;

/* Depth bias, expressed as the world offset it is worth rather than as an NDC
 * number, because the NDC number means different things at different depth
 * ranges. The shipped -0.00022 over a 149 m range is 32.8 mm along the beam;
 * that is the value that was tuned, so that is the value that is kept. */
export const SHADOW_BIAS_METRES = 0.0328;
export const SHADOW_BIAS = -SHADOW_BIAS_METRES / (SHADOW_FAR - SHADOW_NEAR);
/* Unchanged: normalBias is already in world units and does not scale with the
 * depth range. It is small on purpose — at this elevation an offset along the
 * surface normal converts into horizontal shadow displacement by one over the
 * tangent of the sun's elevation. */
export const SHADOW_NORMAL_BIAS = 0.006;

/* ── The basis ─────────────────────────────────────────────────────────────
 *
 * `LightShadow.updateMatrices` positions the shadow camera at the light and
 * calls `shadowCamera.lookAt(target)`, and `Object3D.lookAt` builds its basis
 * from `this.up`. So the roll of the whole box is set by one vector on the
 * shadow camera, and nothing else in three has to be persuaded.
 *
 * The street axis is projected into the plane perpendicular to the sun, and
 * the up vector is the remaining perpendicular. `lookAt` then produces a
 * horizontal axis along that projected street axis and a vertical axis across
 * the canyon.
 */
const SUN = new THREE.Vector3(...SUN_DIR);
const STREET_AXIS = new THREE.Vector3(0, 0, -1);

/** The street direction with the sun-parallel component removed. */
export const SHADOW_ALONG = STREET_AXIS.clone()
  .addScaledVector(SUN, -STREET_AXIS.dot(SUN))
  .normalize();

/** What to set `light.shadow.camera.up` to. Perpendicular to the sun by
 *  construction, so `lookAt` can never degenerate on it. */
export const SHADOW_UP = OLD
  ? new THREE.Vector3(0, 1, 0)
  : new THREE.Vector3().crossVectors(SUN, SHADOW_ALONG).normalize();

/** Where the box's target goes, given a snapped ground position. */
export const shadowTarget = (x: number, z: number): [number, number, number] =>
  [x, SHADOW_LIFT, z - SHADOW_LEAD];

/** Where the light goes for that target. */
export const shadowLight = (x: number, z: number): [number, number, number] => {
  const t = shadowTarget(x, z);
  return [
    t[0] + SUN_DIR[0] * SHADOW_STANDOFF,
    t[1] + SUN_DIR[1] * SHADOW_STANDOFF,
    t[2] + SUN_DIR[2] * SHADOW_STANDOFF,
  ];
};

/* There is deliberately no `mmPerTexel` export here. The only density worth
 * quoting is the one a texel has on the ground, and that depends on the roll
 * of the box and the sun's elevation together — it is not box width over map
 * width. `tools/shadowview.mjs` measures it off the live projection. An
 * exported approximation would be quoted in a report within the week. */
