/* The street lanterns, as one enumerable table.
 *
 * COLOUR SPACE. `colour` and `bowl` are LINEAR SCENE RADIANCE in the same units
 * the sun uses; `intensity` is candela in those units. Nothing here is
 * display-encoded, and every level in the file is produced by inverting the
 * shipped transform through `scene/tone.ts` rather than by choosing a number
 * that looked right on a tone-mapped frame.
 *
 * ── Why this is its own module ────────────────────────────────────────────
 *
 * Three consumers, and until now two of them each carried their own copy of
 * part of the answer. `scene/lights.ts` knew the candela and the emission axis,
 * `scene/lightMaterials.ts` knew the bowl radiance, `world/lamps.ts` knew where
 * the head physically is, and the correspondence between them was three
 * separate literals that happened to agree. A fourth consumer now exists — the
 * atmosphere pass wants every fixture's position, axis, cone and colour so its
 * raymarch can scatter light from them — and adding a fourth private copy is
 * how `tools/obstacles.mjs` came to clear routes that were not clear.
 *
 * So this file is the table, `lampFixtures()` is the only way to read it, and
 * nothing downstream is allowed to know a lamp's colour or level except from
 * what it returns.
 *
 * ── The sodium run-up, and why every lamp is now on ───────────────────────
 *
 * A high-pressure sodium lamp does not switch on. It strikes an arc in the
 * argon-neon starting gas, which glows a dull red-pink, and then over three to
 * ten minutes the sodium amalgam vaporises, the arc tube pressure climbs and
 * the discharge walks up to its working orange. Two lamps on the same street
 * that were switched by the same photocell are never at the same point on that
 * curve, because their amalgam doses and their arc tubes have aged differently.
 *
 * That is the whole idea behind `WARMTH`: one number per fixture, the fraction
 * of the run-up it has completed, and everything else — the candela, the bowl's
 * target display value and its chromaticity — is derived from it. The lamps
 * disagree with each other in *colour* far more than in level, which is the
 * correct reading of "just clicked on" and is the one thing about a striking
 * street that a photograph shows.
 *
 * ── Frozen rather than animated, and why ──────────────────────────────────
 *
 * `WARMTH` is a constant. It could trivially be driven from `SYS5_TIME` and it
 * deliberately is not, for three reasons in increasing order of weight.
 *
 *   1. The run-up is four to ten minutes. The walk is thirty seconds. Played at
 *      its real rate nothing in the take would visibly change; played fast
 *      enough to see, it is a lie about a physical process the rest of this
 *      file is careful to model honestly.
 *   2. The statement is a still-frame property. What the viewer reads is that
 *      the lamp forty metres away is orange and the one overhead is pink. That
 *      is legible in one frame and animation adds nothing to it.
 *   3. It would poison every differenced-pair measurement on the project.
 *      `SYS5_TIME` exists so that a capture can pin the two things that do move
 *      — the signal aspect and the television — and the pinning works because
 *      both have periods of tens of seconds. A third mover with a ten-minute
 *      period cannot be pinned by the same mechanism in practice: two frames
 *      taken a minute apart in wall clock would differ by the warm-up, and
 *      TECHNIQUE §7 is explicit that a pair has to come from one frozen world
 *      state or it measures the wrong thing.
 *
 * If it is ever wanted as an animation, the honest way is a separate slow clock
 * with its own freeze, not a term added to this one.
 */
import { LAMPS, LAMP_H } from '@/world/dims';
import { atDisplay } from './tone';

/** How far the lantern reaches out from its column, toward the carriageway. */
export const LAMP_OUTREACH = 1.15;

/* Where each fixture is on its run-up, in `LAMPS` order: z = 12, -8, -25, -45,
 * -64, -84, -99. Every one of them is alight.
 *
 * Two were previously off and the street had two unlit stretches nineteen and
 * fifteen metres long with literally zero lamp irradiance in them — measured,
 * `tools/sunlamp.mjs` on the build before this one, E = 0.0001 at z -19 and at
 * z -15, which is the meter's floor and means nothing at all. Turning them on
 * is the brief; the interest has to come from somewhere else, and it comes from
 * here.
 *
 * The one at -45 is at full output on purpose: it stands inside `block.ts`'s
 * first sun band, z -48.7..-31.9, where the road under it is at L 0.43 instead
 * of 0.038 and the same irradiance is worth one display count instead of seven.
 * A lamp that has to compete with a sun band is the wrong lamp to have striking.
 */
export const WARMTH: readonly number[] = [0.90, 0.42, 0.28, 1.00, 0.62, 0.85, 0.35];

/* Nadir intensity at full output, in this scene's units.
 *
 * THIS VALUE KNOWINGLY EXCEEDS TECHNIQUE §3.3's RECOMMENDATION, and the reason
 * is worth writing down because the document is not wrong — it is answering a
 * different question from the one the brief asks.
 *
 * §3.3 says start at 20-40 cd, which puts the pool at 5-10% of the sun's
 * horizontal irradiance on the road, and §3.9 says that at golden hour a lamp
 * "reads as a source, not a pool on the ground". Both are correct descriptions
 * of a photograph. This was built at 19 cd first and then measured, and the
 * measurement agreed with the document exactly: peak irradiance on the shaded
 * carriageway came out at 0.411 against a prediction of 0.54, which through
 * the shipped transform is SIX DISPLAY COUNTS above the unlit road. Six counts
 * is below what a viewer resolves on a textured surface. The pools were, in
 * the plainest sense, not there — and the brief asks for pools that overlap.
 *
 * So the level is set from the one ratio that is scale-free and therefore
 * immune to the unit confusion running through the rest of this derivation:
 * the lantern against the skylight it has to beat.
 *
 *   shaded carriageway, radiance          L = 0.038   (NOTES, measured)
 *   its albedo                            0.106
 *   so the skylight irradiance on it      E = pi L / rho = 1.13
 *   a real 250 W lantern under itself     60-100 lux
 *   real dusk skylight in a canyon        30-80 lux
 *   so the real ratio is                  about 1 to 2
 *
 * At 19 cd this scene's ratio was 0.36 — the lantern was a third of the
 * skylight where life puts it at one and a half times. Setting the ratio to
 * 1.5 gives a peak of 1.7 and needs 78 cd. That is the number below, and it is
 * a correction toward the physical answer rather than away from it.
 *
 * Where that leaves the guard rail §3.3 sets. The pool is now 20% of the sun's
 * horizontal 8.42 rather than 6%, which is the third row of that section's own
 * table and still short of the 120 cd at which it warns the lamp starts
 * competing on the SUNLIT footway. On the sunlit side it remains subordinate,
 * and inside block.ts's sun bands it is worth about one count and invisible,
 * which is correct. On the shaded footway — no direct sun at all — it is now
 * the dominant local source, which is the asymmetry §3.3 says you get for free
 * and which at 19 cd this scene was not actually collecting.
 *
 * Flux, for the record: 78 x 8.56 sr = 668 in scene units, a 250 W HPS lantern
 * on a 6.8 m column. Unremarkable for this street.
 */
export const LAMP_CD_FULL = 78;

/* The distribution, as a cross-street squeeze factor. See ARTIFICIAL in
 * lights.ts, which reads a negative distribution exponent as "this is a street
 * lantern, and this is how much faster its lobe closes across the road than
 * along it." */
export const LAMP_CROSS = 2.2;
/** The batwing's ceiling, as a multiple of nadir intensity. */
export const LAMP_PEAK = 2.4;
/** Where the lobe cuts off, as a cosine of the angle from the lamp's own axis. */
export const LAMP_CUT: readonly [number, number] = [0.18, 0.32];

/* ── The run-up curve ─────────────────────────────────────────────────────
 *
 * Output. A high-pressure sodium lamp reaches roughly half of its working lumens
 * within the first minute and the rest over the following few, so the curve is
 * strongly concave: `w^0.55` puts the lamp at 56% of output when it is 35% of
 * the way through its run-up. That matters here for a practical reason as much
 * as a physical one — it is what stops a lamp that is early in its warm-up from
 * leaving a hole in the run of pools, which is the thing the brief asks for.
 */
export const lampOutput = (w: number): number => Math.pow(Math.max(0, Math.min(1, w)), 0.55);

/* Chromaticity, and this is where the warm-up actually shows.
 *
 * At strike the arc is running in the penning mixture and is a dull red-pink;
 * at full pressure it is the familiar sodium orange with the resonance lines
 * self-reversed and enough continuum to be a real colour rather than a
 * monochromatic one. Both endpoints were already in this project — they are the
 * chromaticities the two old discrete states used — and the run-up interpolates
 * between them slightly ahead of the output curve, because the colour settles
 * before the level does.
 */
const STRIKE: readonly [number, number, number] = [1.0, 0.30, 0.36];
const WORKING: readonly [number, number, number] = [1.0, 0.47, 0.13];
export function lampChroma(w: number): [number, number, number] {
  const t = Math.pow(Math.max(0, Math.min(1, w)), 0.75);
  return [
    STRIKE[0] + (WORKING[0] - STRIKE[0]) * t,
    STRIKE[1] + (WORKING[1] - STRIKE[1]) * t,
    STRIKE[2] + (WORKING[2] - STRIKE[2]) * t,
  ];
}

/* The bowl's target display value, in its peak channel.
 *
 * 120 at strike and 178 at working output, and the ceiling came DOWN from 214
 * for a reason that only a long lens on the fitting showed.
 *
 * At 214 the bowl is not orange. AgX desaturates hard along its shoulder, and
 * the brief here is a colour statement — "warm orange glow from each lamp head"
 * — so the quantity that matters is not how bright the bowl is but how much
 * chroma survives the transform at that brightness. Measured, at the working
 * chromaticity 1 / 0.47 / 0.13:
 *
 *   peak-channel target    display triple      saturation
 *          140             (139, 103,  66)        0.53
 *          160             (160, 122,  83)        0.48
 *          178             (178, 141, 101)        0.43
 *          205             (205, 171, 133)        0.35
 *          214             (214, 182, 146)        0.32
 *
 * At 214 the fitting photographs as a pale pink-white tray. A capture at 12
 * degrees on the lantern at z = -8 is what settled it: shots/bowl/bowl.png on
 * the build before this one, and there is no orange in it. 178 is still nearly
 * twice the 96 counts the shaded carriageway sits at, so the bowl remains
 * unambiguously a lit source, and it keeps a third more chroma.
 *
 * This is a real trade and not a free win. A sodium bowl photographed at dusk
 * genuinely does blow toward white with the colour pushed out into the corona
 * around it — 214 was the more literal answer. The corona is the part this
 * scene does not have: the additive glow proxies exist only for the neon. With
 * one, the bowl could go back up and the warmth would live in the halo, which
 * is both what TECHNIQUE §3.9 recommends and how the eye actually reads a
 * lamp. Until then the chroma has to be in the bowl itself, because it is the
 * only surface there is.
 *
 * The interpolation is in *display* counts, not in radiance. Radiance across
 * that span is a factor of three and the curve is nowhere near straight, so a
 * mix() of the two endpoint radiances would put a half-warmed lamp most of the
 * way to full. Inverting each target separately costs a bisection at module
 * load and is exact.
 */
export const lampBowlTarget = (w: number): number => 120 + 58 * Math.pow(Math.max(0, Math.min(1, w)), 0.7);

export type LampFixture = {
  /** Index into `LAMPS`, and into every per-lamp array in System 5. */
  index: number;
  /** The column's foot, in world space. */
  column: readonly [number, number, number];
  /** The lantern's optical centre — what a scattering integral should use. */
  position: readonly [number, number, number];
  /** Unit vector the lantern emits along. Points down and in toward x = 0. */
  direction: readonly [number, number, number];
  /**
   * Half-angles to the cut-off, in radians. The lobe is not a cone: a street
   * lantern throws along the road and cuts off across it, so `coneAlong` is the
   * half-angle in the plane containing the street axis and `coneAcross` the
   * half-angle perpendicular to it. `coneAngle` is the larger of the two, for a
   * consumer that only wants one number to bound the lobe with.
   */
  coneAlong: number;
  coneAcross: number;
  coneAngle: number;
  /** Nadir intensity, candela in scene units, after the run-up. */
  intensity: number;
  /** Peak intensity anywhere in the lobe — `intensity` times the batwing cap. */
  peakIntensity: number;
  /** Emission chromaticity, peak channel 1. Multiply by `intensity` for cd/ch. */
  colour: readonly [number, number, number];
  /** The bowl's own linear radiance, which is what the camera sees. */
  bowl: readonly [number, number, number];
  /** Fraction of the sodium run-up completed, 0 at strike and 1 at working. */
  warmth: number;
};

/* Derived once. Every consumer gets the same objects, which is deliberate:
 * two callers holding two structurally-equal copies is exactly the state this
 * module exists to prevent. */
let CACHE: LampFixture[] | null = null;

/** Every lantern in the street, in `LAMPS` order. */
export function lampFixtures(): readonly LampFixture[] {
  if (CACHE) return CACHE;

  /* The cut-off, converted from the cosine the shader tests to the two
   * half-angles a consumer outside the shader can use. Along the street the
   * squeeze factor is 1, so the cut-off cosine is the angle directly; across it
   * the transverse component is multiplied by LAMP_CROSS first, which closes
   * the lobe sooner. Solved rather than tabulated so the two cannot drift from
   * the constants above. */
  const c0 = LAMP_CUT[0];
  const coneAlong = Math.acos(c0);
  const coneAcross = Math.atan(Math.sqrt(1 / (c0 * c0) - 1) / LAMP_CROSS);

  CACHE = LAMPS.map((l, i) => {
    const [x, , z] = l;
    const w = WARMTH[i] ?? 0;
    const s = Math.sign(x) || 1;
    const head: [number, number, number] = [x - s * LAMP_OUTREACH, LAMP_H, z];
    /* Tipped toward the carriageway, which is what puts the lobe's long axis
     * over the road rather than over the shopfronts. Unchanged from the value
     * the cookie's replacement was fitted at. */
    const tilt = -s * 0.37;
    const chroma = lampChroma(w);
    const cd = LAMP_CD_FULL * lampOutput(w);
    return {
      index: i,
      column: [x, 0, z] as const,
      position: head,
      direction: [Math.sin(tilt), -Math.cos(tilt), 0] as const,
      coneAlong,
      coneAcross,
      coneAngle: Math.max(coneAlong, coneAcross),
      intensity: cd,
      peakIntensity: cd * LAMP_PEAK,
      colour: chroma,
      bowl: atDisplay(lampBowlTarget(w), chroma),
      warmth: w,
    };
  });
  return CACHE;
}

/* ── The published interface ──────────────────────────────────────────────
 *
 * System 6's raymarch needs the fixtures and must not re-derive them. It is a
 * separate pass with its own module and no reason to import a scene component,
 * so the table is also put on `window` in development, alongside
 * `window.__shopLights` which solves the same problem for the shopfronts.
 *
 * The array is the same objects `lampFixtures()` returns, not a copy.
 */
declare global {
  interface Window {
    /** Every street lantern: position, axis, cone, intensity, colour. */
    __lampFixtures?: readonly LampFixture[];
  }
}

export function publishLampFixtures(): () => void {
  window.__lampFixtures = lampFixtures();
  return () => { delete window.__lampFixtures; };
}
