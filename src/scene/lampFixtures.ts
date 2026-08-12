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
 * The conversion is the one at the top of `scene/lights.ts` and it is unchanged:
 * this scene runs at about 1/137 of photometric, because the sun is a 115 lux
 * directional at 4.2 degrees against a real 1150 lux. What has changed is which
 * lantern is being converted and, much more importantly, its distribution.
 *
 *   nadir intensity          19 cd here = 2600 cd real
 *   peak intensity           19 x 2.4 = 45.6 cd here = 6250 cd real
 *   lower-hemisphere flux    19 x 8.56 sr = 163 here = 22300 lm real
 *
 * which is a 250 W high-pressure sodium lantern — a real and unremarkable
 * fitting for a 6.8 m column on a street this width. The previous value, 24 cd
 * of nadir intensity into a cos^1.6 lobe, was a 100 W lantern by flux (58 x 137
 * = 7900 lm) and that part of it was right. What was wrong was the *shape*, and
 * the shape is what decides whether there is a street lit or seven spots on it.
 *
 * Against the sun: the peak lands at E = 0.54 on the carriageway, which is 6.4%
 * of the sun's horizontal 8.42 and sits inside TECHNIQUE §3.3's 5-10% band. The
 * threshold that section warns about — "above about 120 cd the pool starts
 * competing with the sun on the sunlit footway" — is not approached; peak
 * intensity is 46 cd.
 */
export const LAMP_CD_FULL = 19;

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
 * 132 at strike and 214 at full output are the two targets this project already
 * held and validated: `NOTES.md` records the working bowl measured at 233-242
 * red against a prediction of 234 with the mottle at its mean, which is the
 * second of the two independent checks the display transform is trusted on. The
 * targets are unchanged; only the states between them are new.
 *
 * The interpolation is in *display* counts, not in radiance, and that is the
 * whole point of doing it here rather than in the shader. Radiance between 132
 * and 214 spans a factor of seven and the curve between them is nowhere near
 * straight, so a `mix()` of the two endpoint radiances would put a half-warmed
 * lamp at display 190 instead of 173 — a lamp that is 50% through its run-up
 * would look 80% of the way there. Inverting each target separately costs a
 * bisection at module load and is exact.
 */
export const lampBowlTarget = (w: number): number => 132 + 82 * Math.pow(Math.max(0, Math.min(1, w)), 0.7);

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
