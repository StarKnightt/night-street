/* The sun. One definition, no dependencies, imported by everything that needs
 * to agree with it.
 *
 * ── Why this is a separate file ─────────────────────────────────────────────
 *
 * These constants lived in env.ts, which is the natural home for them and was
 * the wrong one the moment clouds.ts needed them: env.ts imports bakeSkyCube
 * from clouds.ts, so clouds.ts importing SUN_ELEV back from env.ts closes a
 * cycle. ES modules tolerate cycles only for bindings read after both modules
 * have initialised, and `Math.sin(SUN_ELEV)` at clouds.ts's top level is not
 * that: env.ts's import of clouds.ts is hoisted above its own const
 * declarations, so clouds.ts would evaluate first and read SUN_ELEV in its
 * temporal dead zone. A ReferenceError during module init, before any of this
 * project's capture tooling gets a scene to look at.
 *
 * A leaf module with no imports cannot participate in a cycle. env.ts re-exports
 * everything here, so the dozen files that already say `from './env'` are
 * unaffected and nothing had to be touched to make this safe.
 *
 * ── Why one definition matters more than it sounds ──────────────────────────
 *
 * clouds.ts held three separate transcriptions of the sun: the beam colour as
 * (115.0, 37.17, 8.76), the path amplification as sin(4.2 deg), and a
 * transmittance triple per deck. Its own comment claimed "the clouds cannot end
 * up lit by a different sun from the street". Nothing enforced that; it was
 * true because two numbers happened to agree, and raising the street's sun to
 * 12 degrees would have left the sky lighting its clouds from 4.2 while every
 * one of those literals still read correct and still typechecked.
 *
 * That is the third duplicated-constant bug in this project this session, after
 * the collide furniture table and the trade word list, and it is written up in
 * NOTES.md. The rule that came out of it: a constant that is *derived* from
 * another constant must be computed, even when the arithmetic is trivial and
 * especially when it has to reach GLSL, where it is generated into the source
 * rather than typed into it.
 */

/* Elevation, raised from 4.2 degrees.
 *
 * The trade, which is the part worth keeping from the original note in env.ts.
 * Shadow length is height over the tangent of the elevation, so lower is better
 * for the signature effect of this hour: at 12 degrees a 145 mm kerb still
 * throws a 68 cm shadow, a third of a lane. But the carriageway is a horizontal
 * surface and collects sin(elevation) of the beam — a tenth at 4.2 degrees,
 * a fifth at 12 — and below some angle the direct sun on the road falls under
 * the skylight filling it from above, at which point shadows stop being visible
 * at all because there is nothing left for them to subtract. That is why the
 * sun's intensity has to be set against the sky rather than picked in isolation,
 * and it is also why raising the elevation makes the road read better rather
 * than worse.
 *
 * (That note claimed 6 degrees and an azimuth offset of 28 while the constants
 * beneath it read 4.2 and 35. Prose drifts from the value it describes as
 * readily as a transcribed literal does, and for the same reason.)
 *
 * Nothing had drifted — `git log -L` on this value returns one commit, the
 * first in the repository, and the hero shot was taken at 4.2. The street grew
 * around it. The right-hand terrace now shadows the left frontage almost
 * completely at four degrees, so sun reaches it only through the gaps between
 * buildings and the frontage is banded rather than lit.
 *
 * Intensity was measured to be the wrong lever: pushed through AgX offline,
 * 1.6x takes the warm frontage from blue/red 0.67 to 0.73 and 2.0x to 0.75,
 * because the shoulder desaturates what already has warmth while the shadowed
 * stretches merely climb from 39 to 59 counts of grey. Elevation reaches more
 * wall rather than pushing harder on the wall it already reaches.
 *
 * Twelve degrees is the user's compromise: enough to light the frontage, still
 * low and raking, not late afternoon.
 */
export const SUN_ELEV = 12.0 * Math.PI / 180;

/* Azimuth, measured from the far end of the street and offset 35 degrees to the
 * +X side. Unchanged by this pass. Dead down the centreline would throw every
 * shadow straight at the camera where its length is foreshortened into nothing;
 * 35 degrees is enough that shadows cross the road diagonally and one footway is
 * lit while the other is in shade, without the sun leaving the end of the street
 * and the glow ceasing to close the view. */
export const SUN_AZIM = 35.0 * Math.PI / 180;

/* The key light, which is `<directionalLight color="#ff9a4e" intensity={115} />`
 * in Street.tsx. Deep gold: a beam that has crossed this much air has lost most
 * of its short wavelengths, and 2200 K is roughly this.
 *
 * NOTE FOR WHOEVER OWNS Street.tsx: that file still spells the hex and the
 * intensity into JSX. It should import them from here. It is locked to another
 * agent this week, so the duplication is reported rather than removed — and it
 * is exactly the duplication this file exists to stop. */
export const SUN_INTENSITY = 115;
export const SUN_COLOR_HEX = 0xff9a4e;

const srgbToLinear = (c: number) =>
  c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);

/** The key light in linear renderer units: colour, decoded, times intensity. */
export const SUN_BEAM_GROUND: [number, number, number] = [
  srgbToLinear(((SUN_COLOR_HEX >> 16) & 255) / 255) * SUN_INTENSITY,
  srgbToLinear(((SUN_COLOR_HEX >> 8) & 255) / 255) * SUN_INTENSITY,
  srgbToLinear((SUN_COLOR_HEX & 255) / 255) * SUN_INTENSITY,
];

/* ── The disc, which is an image of the light above and was not ─────────────
 *
 * The sun is drawn twice in this project: once as the directional light, which
 * has no image, and once as a painted profile in the sky, which carries no
 * energy into the shading. That is the correct decomposition and it is argued
 * in env.ts. What it does not license is the two halves disagreeing about how
 * bright the sun is, and they disagreed by three orders of magnitude.
 *
 * The painted disc was `exp(-ang * 150.0) * 190.0` — transcribed into env.ts's
 * CPU sky and again into clouds.ts's GLSL, which is the duplicated-constant
 * class this file exists to stop — and it was picked, in that file's own
 * words, as "a couple of hundred times the horizon value". Measured, that puts
 * the brightest pixel of the sun at a luminance of 78 in a frame whose
 * brightest pixel is a clearcoat glint at 7339: the sun was the ninety-fourth
 * brightest thing in a photograph of the sun. See tools/sunglare.mjs.
 *
 * The consistent value is not a matter of taste. A directional light's
 * intensity *is* the irradiance it lands on a surface facing it, and that
 * irradiance is the disc's radiance times the solid angle it subtends:
 *
 *     E = L * omega        omega = pi * r^2,  r = 0.2665 deg
 *
 * so the radiance the sky must paint to be the same sun as the light above is
 * E / omega. For the exponential profile actually used, whose integral over
 * the sphere is 2*pi/k^2, the peak that carries that flux is E * k^2 / (2*pi).
 * Both are computed below rather than written down.
 *
 * ── Why it does not ship at that value ─────────────────────────────────────
 *
 * Two hard limits and one soft one.
 *
 *   - The scene renders into a half-float target. 4.1e5 is inside the range
 *     but leaves two of the sixteen bits of headroom before Inf, and Inf in
 *     the bloom pyramid is NaN across a sixth of the frame.
 *   - The veil in bloom.ts redistributes a fixed *fraction* of the frame's
 *     energy through a point-spread function that is far broader than a real
 *     lens's. At full flux the disc is two orders of magnitude more energy
 *     than the rest of the frame put together, and 4.5 per cent of that,
 *     spread over the pyramid's flat tail, is a white frame rather than a
 *     glare. A real PSF falls as 1/theta^2 and keeps that energy within a few
 *     degrees; this one does not, so the honest thing is to cap the source
 *     rather than to pretend about the kernel.
 *   - AgX clips the disc at anything over about 40 units of luminance anyway,
 *     so every unit above the cap is spent entirely on the veil.
 *
 * SUN_DISC_SHARE is therefore what it says: the fraction of the sun's real
 * flux this sky paints, chosen by measurement in tools/sunglare.mjs against
 * the two things a photograph looking into a low sun actually shows — a
 * lifted black level and a glow of tens of degrees — and reported there with
 * the clipped-pixel count beside it. It is a deficiency of the kernel
 * expressed as a deficiency of the source, and it is written here, once,
 * where both skies read it.
 */
const SUN_ANG_RADIUS = (0.2665 * Math.PI) / 180;
/** Reciprocal e-folding angle of the painted profile, per radian. */
export const SUN_DISC_EFOLD = 150.0;
/** Solid angle of `exp(-k*theta)` over the sphere, and of the real disc. */
const PROFILE_SOLID = (2 * Math.PI) / (SUN_DISC_EFOLD * SUN_DISC_EFOLD);
export const SUN_DISC_SOLID = Math.PI * SUN_ANG_RADIUS * SUN_ANG_RADIUS;
export const SUN_DISC_SHARE = 0.02;
/** Peak radiance of the painted profile, in the same units as the beam. */
export const SUN_DISC_PEAK: [number, number, number] = [
  (SUN_BEAM_GROUND[0] * SUN_DISC_SHARE) / PROFILE_SOLID,
  (SUN_BEAM_GROUND[1] * SUN_DISC_SHARE) / PROFILE_SOLID,
  (SUN_BEAM_GROUND[2] * SUN_DISC_SHARE) / PROFILE_SOLID,
];

/** Unit vector pointing from the scene toward the sun. */
export const SUN_DIR: [number, number, number] = [
  Math.sin(SUN_AZIM) * Math.cos(SUN_ELEV),
  Math.sin(SUN_ELEV),
  -Math.cos(SUN_AZIM) * Math.cos(SUN_ELEV),
];
