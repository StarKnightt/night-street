import * as THREE from 'three';
import { layoutBlock, BUILD_LINE, BLOCK_DEPTH } from '@/world/block';
import { walkHeight } from '@/world/geometry';
import { HORIZON_AWAY, HORIZON_SUNWARD, SUN_DIR } from './env';

/* Direction-dependent haze.
 *
 * Three.js fog is a single colour applied by distance alone, which is correct
 * for an overcast afternoon and wrong for a low sun. At golden hour the air is
 * a forward-scattering medium: looking toward the sun you are looking along
 * the beam and the haze between you and the far end of the street glows, goes
 * milky and eats contrast, while the same air behind you is nearly clear and
 * noticeably cooler. It is one of the strongest depth cues the hour has, and
 * it is free — it only needs the fog colour to depend on view direction rather
 * than being a constant.
 *
 * Patching the fog chunk globally is the right level for this. Every material
 * in the scene already includes it, so there is nothing to remember to wire up
 * per material, and the alternative — an onBeforeCompile on each — would have
 * to be repeated on the road, the footway, the kerb, the castings and the
 * plates and would drift out of step the first time one of them changed.
 *
 * System 6 added four things to it and deliberately did not add a fifth:
 *
 *   a phase function     two-term Henyey-Greenstein in place of a one-sided
 *                        power, so the air behind the camera is a veil rather
 *                        than a discontinuity, and so the width of the forward
 *                        lobe is a number with a meaning.
 *   height falloff       the closed-form exponential-height integral, referred
 *                        to the camera so that it redistributes rather than
 *                        rescales. The largest depth cue this canyon lacked.
 *   a near-field floor   a saturating term that supplies the first stretch,
 *                        because FogExp2 is quadratic and asserts that the
 *                        first ten metres of a city street are a vacuum.
 *   a lit-air wedge      two analytic ray-slab intersections against the
 *                        shadow-boundary planes swept from the sunward gaps in
 *                        the frontage.
 *
 * ── The wedge has been superseded, and the slab test kept ─────────────────
 *
 * `scene/volumetric.ts` now marches the same air with the sun's own shadow
 * map, which is strictly better than two hand-derived planes: it is occluded
 * by *everything* — the van, the fire escape, the parapet notch — rather than
 * by the two frontage gaps the planes were swept from, and the lamp cones the
 * brief added ride in the same march for the cost of the lamps alone.
 *
 * So the composite that used to be at the end of this chunk is gone, and what
 * survives is `gapLitGLSL()` below. The march's shadow map is 44 m across and
 * follows the camera, and a ray down this street leaves it sideways at about
 * thirty-eight metres because the sun bears 35 degrees off the street axis; past
 * that the slab test is what answers "is this air in the beam". Near field
 * exact, far field analytic, both derived from `layoutBlock` and therefore from
 * the same buildings. One occlusion function, two ranges.
 *
 * The screen-space god-ray pass is still not built and §4.3 is still right
 * about why: at 4.2 degrees the beam runs along the canyon, the sun is off
 * frame most of the time, and a radial blur keyed to a point outside the
 * frustum has nothing to be keyed to.
 */
/* Per-term switches, for measuring rather than for shipping.
 *
 * This project's most expensive recurring failure is code that is present,
 * typechecks, reads correctly and is silently inert — a haze installer that
 * wrote uniforms three had already built, an envMapIntensity nothing reads, a
 * pow(0, 0.6) that killed a light path. The only defence that has ever worked
 * is a differenced pair: render the frame twice with one term switched and
 * measure the delta. A term that cannot be switched off cannot be proved to be
 * on.
 *
 * Every switch below substitutes a *constant* into the same GLSL. It does not
 * add a branch, a uniform or a define, so the compiled program is structurally
 * identical whichever way it is set and a measured difference cannot be an
 * artefact of having compiled a different shader. With no query string present
 * the substitutions are the shipped values, so the default build is unchanged.
 *
 *   ?haze=noheight,nofloor    e.g.; comma-separated, dev only
 */
function hazeFlags(): Set<string> {
  if (process.env.NODE_ENV === 'production') return new Set();
  if (typeof window === 'undefined') return new Set();
  const q = new URLSearchParams(window.location.search).get('haze');
  return new Set(q ? q.split(',').map((s) => s.trim()).filter(Boolean) : []);
}

/* The fog vertex chunk, as a value, because one other material needs its own
 * copy of it and a copy is how this breaks.
 *
 * The haze reads world position in the fragment stage, so the vertex chunk
 * publishes a `vHazeWorld` varying that stock three does not have. The apron
 * in materials.ts scales its own fog depth, which means it cannot use the
 * shared chunk and has to replace `#include <fog_vertex>` with a block of its
 * own — and that block therefore has to know to assign a varying belonging to
 * this file. It did, by transcription, and that is a coupling with no
 * compile-time link between the two ends: renaming the varying here, or
 * dropping it from the chunk, fails the apron program with "l-value required
 * (can't modify a const)" at a site that names neither this file nor the
 * varying. Three surfaces it lazily on first draw, so it is a black apron and
 * a console line rather than a build error. It cost a hard failure once.
 *
 * So the apron calls this instead of transcribing it. Both ends now move
 * together, and the invariant that the varying is declared in every path —
 * including the `off` control above, which drops the maths but keeps the
 * declaration — lives in one file.
 *
 * @param depthScale multiplies fog depth for this material only. */
export function hazeFogVertex(depthScale = 1): string {
  const d = depthScale === 1 ? '' : ` * ${depthScale}`;
  return `#ifdef USE_FOG
  vFogDepth = - mvPosition.z${d};
  vHazeWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
#endif
`;
}

/* ── Where the beam gets through the frontage ─────────────────────────────
 *
 * Derived from the same layout the buildings are built from, not measured off
 * a screenshot and not typed in. layoutBlock is pure and already runs three
 * times in this project; another call costs about a millisecond and means the
 * lit band cannot drift away from the frontage that casts it, which is the
 * failure mode of every hand-placed constant this project has had to unpick.
 *
 * The geometry. A gap in the sunward frontage presents two *vertical* edges to
 * a nearly horizontal beam, and the surface that separates lit air from shaded
 * air is the plane swept along SUN_DIR from each of those edges. Both planes
 * contain the sun direction and the world vertical, so both are vertical, so
 * the whole test is two-dimensional in xz: a point is in lit air when its
 * signed distance along the shared horizontal normal falls between the two.
 *
 * Which two edges is not symmetric, and block.ts:249-257 already did this
 * arithmetic for the ground: a ray grazing the *near* corner of the opening
 * clears the frontage plane at x = BUILD_LINE, while one grazing the *far*
 * corner must also clear the back of the block at x = BUILD_LINE + BLOCK_DEPTH
 * or it buries itself in the next building along. Taking the two offsets from
 * those two different planes reproduces block.ts's own stated bands — the
 * carriageway lit between z = -49 and -32, and between -84 and -73 — from the
 * gap list rather than from its comment.
 */
export function gapPlanes(sunDir: THREE.Vector3) {
  const nl = Math.hypot(sunDir.z, sunDir.x);
  const nx = sunDir.z / nl, nz = -sunDir.x / nl;
  const dAt = (x: number, z: number) => nx * x + nz * z;

  const { gaps } = layoutBlock((x, z) => walkHeight(x, z));
  const slabs = gaps
    /* Sunward only — the service alley on the shaded row is a dark slot and
     * block.ts says so — and only the two that fall inside the walk. The far
     * cross street at -118 casts a real wedge, but every fragment of it is past
     * the range at which the closeout has already forced the haze to full, so
     * it would cost two planes' worth of arithmetic to change nothing. That
     * also keeps the count at the two atmosphere.js:299-305 argues for: "half a
     * dozen of them at once at similar weights reads as staging, since real
     * crepuscular rays are rare enough that one strong one is an event." */
    .filter((g) => g.side > 0 && g.z1 > -100)
    .map((g) => {
      const a = dAt(BUILD_LINE, g.z1);
      const b = dAt(BUILD_LINE + BLOCK_DEPTH, g.z0);
      return [Math.min(a, b), Math.max(a, b)] as const;
    })
    .slice(0, 2);
  while (slabs.length < 2) slabs.push([1e9, 1e9] as const);   // never entered
  return { nx, nz, slabs };
}

/**
 * `float gapLit( vec3 p )` — analytic sun visibility for a point of air.
 *
 * 1 where the sun reaches, 0 in the frontage's shadow, soft across the
 * boundary. Above the parapet line the sun clears the roofs and *all* the air
 * is lit, which is why the two terms below are a `max` and not a product: the
 * slab test is a statement about the street, not about the sky over it.
 *
 * The 0.55 m boundary is a real penumbra and not a taste. The sun subtends
 * about half a degree, so a gap edge thirty metres away throws a soft edge
 * roughly 0.26 m wide; the rest is the frontage not being a razor.
 *
 * Used in two places and that is the point of exporting it: the fog chunk has
 * no march and needs it directly, and `volumetric.ts` needs it for the part of
 * the ray that has walked out of the sun's shadow frustum sideways.
 */
export function gapLitGLSL(sunDir: THREE.Vector3): string {
  const { nx, nz, slabs } = gapPlanes(sunDir);
  const N = `vec2(${nx.toFixed(6)}, ${nz.toFixed(6)})`;
  const D = `vec4(${slabs[0][0].toFixed(4)}, ${slabs[0][1].toFixed(4)}, ` +
    `${slabs[1][0].toFixed(4)}, ${slabs[1][1].toFixed(4)})`;
  const WEST = (-BUILD_LINE).toFixed(3);
  return /* glsl */ `
const vec2 uGapN = ${N};
const vec4 uGapD = ${D};

float gapSlab( float d, float d0, float d1 ) {
  return smoothstep( d0 - 0.55, d0 + 0.55, d ) * ( 1.0 - smoothstep( d1 - 0.55, d1 + 0.55, d ) );
}

float gapLit( vec3 p ) {
  // Clear of the frontage: everything above the roofline is in the beam.
  float above = smoothstep( 6.5, 13.5, p.y );
  float d = dot( p.xz, uGapN );
  float band = max( gapSlab( d, uGapD.x, uGapD.y ), gapSlab( d, uGapD.z, uGapD.w ) );
  // The beam dies on the shaded frontage; there is no lit air behind it, and
  // the apron plane runs 320 m out past it.
  band *= smoothstep( ${WEST} - 1.5, ${WEST} + 1.5, p.x );
  // No air below the road.
  band *= smoothstep( -0.9, 0.2, p.y );
  return clamp( max( above, band ), 0.0, 1.0 );
}
`;
}

/**
 * `float hazePhase( float mu )` — the medium's angular response, shared.
 *
 * A real phase function, in place of a one-sided power.
 *
 * pow(max(mu,0), 2.2) was doing the right job and could not do two things.
 * It is exactly zero over the whole anti-sun hemisphere, with a derivative
 * kink at ninety degrees, so the air behind you is not a thin veil — it is
 * the base density and nothing else, and there is a discontinuity in the
 * middle of every pan. And its width was a free parameter, which is another
 * way of saying nobody could say whether it was right.
 *
 * Two-term Henyey-Greenstein instead: a forward lobe at g = 0.42 carrying
 * 0.78 of the weight, plus a backscatter term at g = -0.20. Both numbers are
 * chosen, and the second one is the interesting half.
 *
 * Single-scatter Mie for urban aerosol is g ~ 0.75-0.8, and using it here
 * would be wrong twice over. The apparent lobe in air thick enough to see is
 * broadened by multiple scattering, and — the part specific to this scene —
 * the narrow part of the forward peak is *already in the picture*. hazeSky
 * carries the aureole as exp(-ang*19.0)*5.60, ported from env.ts, so the
 * tight lobe arrives in the haze's colour. If it were also in the density it
 * would be counted twice and the result is the "hard-edged glowing disc that
 * reads as a lens artifact" this file already warns against. So the density
 * term carries the broad asymmetry only, and 0.42 is what is left of 0.78
 * once the aureole is removed from it.
 *
 * The negative-g term is the backscatter enhancement real haze has, and it
 * is why looking away from the sun gives a veil rather than clear air.
 *
 * Normalised so that the two ends land where the tuned version landed: 1.0
 * at the minimum of the phase (which is at mu ~ -0.6, not at -1) and 3.4
 * looking straight down the beam.
 *
 * Exported so the march scatters with the same lobe the fog chunk extincts
 * with. Two copies of a phase function is two answers to the same question.
 */
export function hazePhaseGLSL(gain = PHASE_GAIN): string {
  return /* glsl */ `
#define HAZE_PHASE_FWD 3.4
float hazePhase( float mu ) {
  // 4pi * HG, so an isotropic medium would return 1.0.
  float a = 1.1764 - 0.84 * mu;                 // g1 = 0.42
  float b = 1.0400 + 0.40 * mu;                 // g2 = -0.20
  float p = 0.78 * 0.8236 * inversesqrt( a * a * a )
          + 0.22 * 0.9600 * inversesqrt( b * b * b );
  // 1.0 at the phase minimum, 3.4 down the beam. tools/agx.mjs prints the pair.
  return 1.0 + ${gain.toFixed(6)} * ( p - 0.5901 );
}
`;
}
/** Zero collapses hazePhase to a constant 1.0: isotropic air, no lobe. */
const PHASE_GAIN = 0.8496;

/* The port below is a copy of someone else's function, so it is checked.
 *
 * `hazeSky` is `skyRadiance` from env.ts transcribed into GLSL, minus the
 * solar disc, and env.ts belongs to another agent who is re-grading it toward
 * warmer cloud undersides and a violet-pink zenith while this is being
 * written. A hand-copied dome that quietly stops matching the dome it is
 * copied from is the exact shape of failure NOTES.md catalogues: the haze
 * would keep working, keep being directional, keep looking plausible, and
 * distant geometry would simply stop dissolving into the sky behind it,
 * because the two colours would no longer be the same colour. Nothing would
 * error and the frames would look almost right.
 *
 * env.ts exports the one thing needed to catch that: `HORIZON_SUNWARD` and
 * `HORIZON_AWAY` are its *own* sky function evaluated at the horizon in the
 * two bearings the haze cares most about. Evaluating this port at the same two
 * directions and comparing is four multiplies at install time and turns a
 * silent divergence into a console line.
 *
 * Deliberately not an exception. This is cosmetic drift, not a broken frame,
 * and a scene that refuses to start because the sky moved by four per cent
 * would be the worse failure. Dev only, because in production nobody can act
 * on it.
 */
function skyPort(dir: [number, number, number], sun: [number, number, number], halo = true) {
  const up = dir[1];
  const fl = Math.hypot(dir[0], dir[2]), sl = Math.hypot(sun[0], sun[2]);
  const azW = Math.pow(Math.max(0, 0.5 + 0.5
    * ((dir[0] * sun[0] + dir[2] * sun[2]) / Math.max(1e-4, fl * sl))), 4.6);
  const zen = [0.0850, 0.1300, 0.3600], warm = [0.7400, 0.3900, 0.3450];
  const hSun = [3.4000, 1.4200, 0.4200], hAway = [0.2000, 0.2000, 0.3100];
  const band = Math.pow(Math.max(0, 1 - Math.max(up, 0)), 5.6);
  const mid = Math.pow(Math.max(0, 1 - Math.max(up, 0)), 2.30);
  const ang = Math.acos(Math.max(-1, Math.min(1,
    dir[0] * sun[0] + dir[1] * sun[1] + dir[2] * sun[2])));
  const hal = halo ? Math.exp(-ang * 5.6) * 0.45 + Math.exp(-ang * 19.0) * 5.60 : 0;
  const glow = [1.60, 0.86, 0.34];
  return [0, 1, 2].map((i) => {
    const hc = hAway[i] + (hSun[i] - hAway[i]) * azW;
    const base = zen[i] + (warm[i] - zen[i]) * (mid * (0.14 + 0.86 * azW));
    let c = base + (hc - base) * band + hal * glow[i];
    if (up < 0) {
      const d = Math.min(1, -up * 1.15);
      const gnd = c * [0.52, 0.50, 0.54][i] + [0.030, 0.024, 0.026][i];
      c = c + (gnd - c) * (d * 0.85);
    }
    return c;
  });
}

/* A static import here used to kill the page at boot, and no longer does.
 *
 * env.ts and clouds.ts imported each other, and clouds.ts read env.ts's
 * SUN_ELEV during its own module evaluation. That cycle survived only on the
 * order the existing importers happened to pull the two modules in, so adding
 * one more edge into env.ts from this file reordered it and the page died with
 * SUN_ELEV in its temporal dead zone. The workaround was a dynamic import.
 *
 * The sun now lives in scene/sun.ts, a leaf with no imports, which a cycle
 * cannot form through. The edge is safe and the workaround is gone — recorded
 * because "why is this one import dynamic" is otherwise unanswerable, and
 * because a comment describing a cycle that has been fixed is the same kind of
 * stale transcription this function exists to catch.
 */
/* The radiance a saturated column of this scene's air reaches looking along the
 * sun's bearing, with the solar aureole taken back out.
 *
 * This is the anchor the volumetric march scales its in-scattering by, and the
 * first version of it read `HORIZON_SUNWARD` out of env.ts directly, which was
 * wrong in a way only the sun move made visible. `HORIZON_SUNWARD` is env.ts's
 * sky sampled at the horizon in the sun's azimuth, so it carries the aureole,
 * and the aureole's size depends on the angle between that horizon sample and
 * the sun — which is the elevation. At 4.2 degrees the sample sat 3.5 degrees
 * off the sun and the halo term contributed about 3.3 of a 6.7 red; at 12
 * degrees it sits 12 degrees off and contributes about 0.4. The march's air
 * would have quietly lost close to half its brightness on a change that says
 * nothing whatsoever about how much dust is in the street.
 *
 * The aureole is forward-scattered sunlight from the entire depth of the
 * atmosphere. The march integrates a hundred and forty metres of street. It
 * should not be reproducing it, and taking it out leaves the base airlight,
 * which env.ts writes as a constant and which therefore does not move when the
 * sun does. Physically this says saturated near-field air settles slightly
 * below the sky at the sun's exact bearing, which is correct — the difference
 * between the two is the rest of the sky.
 */
export function sunwardAirlight(sun: [number, number, number]): [number, number, number] {
  const az = Math.atan2(sun[2], sun[0]);
  const y = Math.sin(0.012), r = Math.cos(0.012);
  const v = skyPort([Math.cos(az) * r, -y, Math.sin(az) * r], sun, false);
  return [v[0], v[1], v[2]];
}

let checked = false;
function checkSkyDrift() {
  if (checked || process.env.NODE_ENV !== 'development') return;
  checked = true;
  const s = SUN_DIR as unknown as [number, number, number];
  const az = Math.atan2(s[2], s[0]);
  const y = Math.sin(0.012), r = Math.cos(0.012);    // the horizon env.ts samples
  const pairs: [string, [number, number, number], readonly number[]][] = [
    ['sunward', [Math.cos(az) * r, -y, Math.sin(az) * r], HORIZON_SUNWARD],
    ['away', [-Math.cos(az) * r, -y, -Math.sin(az) * r], HORIZON_AWAY],
  ];
  for (const [name, dir, want] of pairs) {
    const got = skyPort(dir, s);
    const err = Math.max(...[0, 1, 2].map((i) =>
      Math.abs(got[i] - want[i]) / Math.max(want[i], 0.02)));
    if (err > 0.04) {
      console.warn(
        `haze.ts: the sky port has drifted from env.ts at the ${name} horizon by `
        + `${(err * 100).toFixed(0)}%. port=[${got.map((v) => v.toFixed(3))}] `
        + `env=[${want.map((v) => v.toFixed(3))}]. Distant geometry will stop `
        + 'dissolving into the sky; re-transcribe skyRadiance into hazeSkyGLSL.',
      );
    }
  }
}

/**
 * `vec3 hazeSky( vec3 dir )` — the radiance of the air, which has to *be* the
 * sky rather than an approximation of it.
 *
 * This is the root cause of the hard-edged orange rectangles. Aerial
 * perspective works by an object's radiance converging on the radiance of the
 * air in front of it, and the air in front of a distant object is lit by, and
 * eventually indistinguishable from, the sky in that direction. So at full
 * optical depth an object must land on exactly the sky colour along that ray —
 * at which point its silhouette vanishes, which is what "lost in the haze"
 * physically means.
 *
 * The previous version interpolated between two sampled colours, the sunward
 * and anti-sunward horizon. That is a two-point approximation of a dome with a
 * strong vertical gradient and a twenty-degree halo in it, and it is wrong
 * almost everywhere. A distant backdrop block therefore converged not on the
 * sky behind it but on a different colour, so however far away it was its
 * outline stayed visible — and because those blocks are literally rectangular
 * boxes, and because at that distance the fog factor has saturated so their
 * whole face is one flat value, the result is a perfectly straight-edged flat
 * orange rectangle standing against a mauve sky. Nothing about it is
 * screen-space or a UV bound; it is a building that failed to disappear.
 *
 * The sky here is a closed-form function of direction with no texture and no
 * noise in it, so the fix is to evaluate the same function. Ported term for
 * term from skyRadiance in env.ts, minus the solar disc: the disc belongs to
 * the directional light and to what the camera sees directly, and painting it
 * into the fog would put a second sun on the face of any building that
 * happened to stand in front of the real one.
 *
 * It also answers the second half of the complaint. The glow was "a flat
 * plateau of orange rather than a bright core falling off" because a mix of
 * two constants has no angular structure at all. Evaluating the dome gives it
 * the halo, the vertical gradient and the azimuthal wedge for free.
 *
 * The sun direction is passed in by *name* rather than baked, because the two
 * callers hold it differently — the fog chunk as a compiled-in constant, the
 * march as a uniform read off the light — and a second copy of this function
 * is a second answer to "what colour is the air".
 */
export function hazeSkyGLSL(sunDir: string): string {
  checkSkyDrift();
  return /* glsl */ `
vec3 hazeSky( vec3 dir ) {
  float up = dir.y;
  vec2 fz = dir.xz;
  float azW = pow( max( 0.0, 0.5 + 0.5 * (
    dot( fz, ${sunDir}.xz ) /
    max( 1e-4, length( fz ) * length( ${sunDir}.xz ) ) ) ), 4.6 );

  const vec3 zenith      = vec3( 0.0850, 0.1300, 0.3600 );
  const vec3 upperWarm   = vec3( 0.7400, 0.3900, 0.3450 );
  const vec3 horizonSun  = vec3( 3.4000, 1.4200, 0.4200 );
  const vec3 horizonAway = vec3( 0.2000, 0.2000, 0.3100 );

  float band = pow( max( 0.0, 1.0 - max( up, 0.0 ) ), 5.6 );
  float mid  = pow( max( 0.0, 1.0 - max( up, 0.0 ) ), 2.30 );

  vec3 horizonC = mix( horizonAway, horizonSun, azW );
  vec3 base = mix( zenith, upperWarm, mid * ( 0.14 + 0.86 * azW ) );
  vec3 col = mix( base, horizonC, band );

  float ang = acos( clamp( dot( dir, ${sunDir} ), -1.0, 1.0 ) );
  float halo = exp( -ang * 5.6 ) * 0.45 + exp( -ang * 19.0 ) * 5.60;
  col += halo * vec3( 1.60, 0.86, 0.34 );

  if ( up < 0.0 ) {
    float d = min( 1.0, -up * 1.15 );
    vec3 gnd = col * vec3( 0.52, 0.50, 0.54 ) + vec3( 0.030, 0.024, 0.026 );
    col = mix( col, gnd, d * 0.85 );
  }
  return col;
}
`;
}

export function installHaze(sunDir: THREE.Vector3,
                            near: THREE.Color, sunward: THREE.Color) {
  const S = THREE.ShaderChunk;
  if ((S as unknown as Record<string, unknown>).__hazeInstalled) return;
  (S as unknown as Record<string, unknown>).__hazeInstalled = true;

  const F = hazeFlags();
  /* The floor of the comparison: three's stock fog maths — flat FogExp2 in the
   * away colour, no direction, no height, no wedge, mixed in display space the
   * way three does it.
   *
   * It cannot be implemented by returning early and leaving the stock chunks
   * alone, and finding out why turned up a coupling worth reporting.
   * `materials.ts:2794-2800` replaces `#include <fog_vertex>` on the apron with
   * a literal block of its own that scales vFogDepth by 1.5 *and assigns
   * vHazeWorld*. That varying only exists because this file publishes it, so
   * with the stock chunks in place the apron program fails to link with
   * "l-value required (can't modify a const)" — the identifier is not declared,
   * and three surfaces the failure lazily on first draw rather than at compile.
   *
   * So the control declares the varying and drops only the maths. The apron
   * end is now hardened too — it calls hazeFogVertex() below instead of
   * transcribing it — but this path still has to declare the varying, because
   * the apron assigns it whether or not the haze maths are installed. */
  if (F.has('off')) {
    S.fog_pars_vertex = `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vHazeWorld;
#endif
`;
    S.fog_pars_fragment = `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vHazeWorld;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif
`;
    return;
  }
  /* Scale height as 1/k. Zero drives heightFactor down the `abs(kdy) < 1e-3`
   * branch, which returns exactly 1.0 — i.e. uniform-in-altitude FogExp2, the
   * behaviour before System 6. */
  const K_HEIGHT = F.has('noheight') ? 0 : 0.05556;
  const FLOOR = F.has('nofloor') ? 0 : 0.018;
  const phaseGain = F.has('nophase') ? 0 : PHASE_GAIN;

  /* Compiled in as constants rather than supplied as uniforms, and that is a
   * bug fix rather than a micro-optimisation.
   *
   * The previous version declared uHazeSun and uHazeSunColor as uniforms and
   * published them by adding entries to THREE.UniformsLib.fog. That never
   * worked. ShaderLib is built at three's module scope — every entry in it has
   * already merged and cloned UniformsLib.fog by the time anything in this
   * project has had a chance to run — so mutating the library afterwards has no
   * effect on any material that will ever be created. Both uniforms were
   * therefore declared in the shader and never assigned, which in GL means
   * zero: the sun direction was the zero vector, dot(view, sun) was zero, the
   * forward-scattering lobe was zero everywhere, and the haze was the
   * away-from-sun colour in every direction including straight down the beam.
   * The entire directional effect this file exists to produce has been inert
   * for its whole life, which is exactly the "cool grey milk in the sun
   * direction" in the report.
   *
   * The hour is fixed at build time, so neither value needs to be a uniform at
   * all. Baking them removes the failure mode instead of repairing it. */
  const v3 = (c: THREE.Vector3 | THREE.Color, x: 'x' | 'r', y: 'y' | 'g', z: 'z' | 'b') =>
    `vec3(${(c as unknown as Record<string, number>)[x].toFixed(6)}, ` +
    `${(c as unknown as Record<string, number>)[y].toFixed(6)}, ` +
    `${(c as unknown as Record<string, number>)[z].toFixed(6)})`;

  const SUN = v3(sunDir, 'x', 'y', 'z');
  const SUNC = v3(sunward, 'r', 'g', 'b');

  /* The sky function, the phase function and the gap test are all built from
   * the exported generators above, and all three are used again by
   * `volumetric.ts`. One definition each. */
  const SKY = hazeSkyGLSL('uHazeSun');
  const PHASE = hazePhaseGLSL(phaseGain);

  S.fog_pars_fragment = `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vHazeWorld;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  const vec3 uHazeSun = ${SUN};
  const vec3 uHazeSunColor = ${SUNC};
${SKY}
${PHASE}
#endif
`;

  S.fog_fragment = `
#ifdef USE_FOG
  /* COLOUR SPACE, stated at the top of the pass as §2 of the technique brief
   * requires, because this chunk is the one place in the project that has
   * already got it wrong once.
   *
   *   in    gl_FragColor  whatever the pass is writing. Rendering into the
   *                       linear HDR target — the default — that is scene
   *                       radiance, because three forces NoToneMapping and an
   *                       identity output transform for a render target. On
   *                       ?nohdr it is display-encoded sRGB, because this
   *                       chunk is included after tonemapping_fragment and
   *                       colorspace_fragment.
   *   local hazeLin       linear scene radiance, sRGB primaries, always.
   *   out   gl_FragColor  the same space it arrived in.
   *
   * The two lines that convert are at the bottom and they are both inside the
   * conditions that make them no-ops in the linear target, so there is exactly
   * one tone map and one encode on either path and never two. Nothing linear
   * crosses that line in either direction.
   */

  /* Path length along the ray, not depth along the view axis, and this is the
   * cause of every straight terminator left in the set.
   *
   * three's fog chunk measures -mvPosition.z: the distance to the camera *plane*,
   * not to the camera. For anything near the centre of frame the two agree, which
   * is why this has never shown up down the street. They diverge without limit
   * towards the edges, and the apron is exactly the geometry that lives there —
   * a filler plane extending three hundred and twenty metres sideways. A point on
   * it far out to the right but only sixty metres up the street has a planar
   * depth of sixty metres, so it received the fog of something sixty metres away
   * while actually being three hundred metres off. It therefore kept its own dark
   * albedo instead of being extinguished, and where it ran out you saw it run
   * out: a straight horizontal edge with dark void beneath.
   *
   * Confirmed rather than assumed. Hiding the apron removes the dark region
   * entirely; scaling it four times removes the edge and leaves smooth hazed
   * ground. Both diagnostics are in shots/inert.
   *
   * Radial distance is also simply the right quantity — extinction depends on how
   * far the light actually travelled, not on its component along one axis — so
   * this is a correctness fix that happens to remove an artifact. */
  float hazeDist = length( vHazeWorld - cameraPosition );

  /* Height falloff, and it is the largest depth cue this canyon was missing.
   *
   * FogExp2 is uniform in altitude, so a parapet twelve metres up was hazed
   * exactly as much as the pavement at the same distance, and the one thing a
   * street canyon has more of than anything else is vertical. Real aerosol sits
   * in a layer: dust, exhaust and moisture are all densest at the ground and
   * thin out over a scale height of a few tens of metres.
   *
   * The closed-form integral of exponential-height density along a ray, divided
   * through by the density at the camera so that a level ray is left at exactly
   * 1.0. That normalisation is the point: without it every fog value in the
   * project moves by nine per cent the moment this is switched on, and the haze
   * is the one thing in the set that reviewers have consistently credited.
   * Referred to the camera, this is a pure redistribution — the road is
   * unchanged and the rooflines hold.
   *
   * 18 m scale height. A parapet 12 m above the eye then carries 73 per cent of
   * the optical depth of something level with the camera at the same range. */
  float dy = vHazeWorld.y - cameraPosition.y;
  float kdy = ${K_HEIGHT.toFixed(6)} * dy;
  float heightFactor = ( abs( kdy ) < 1e-3 ) ? 1.0 : ( 1.0 - exp( - kdy ) ) / kdy;
  float hazeOptical = hazeDist * heightFactor;

  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * hazeOptical * hazeOptical );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, hazeOptical );
  #endif

  /* A density floor, because fog that is exactly zero at zero distance is a
   * statement that the first ten metres of a city street are a vacuum.
   *
   * FogExp2 is quadratic in distance, not Beer-Lambert, and the difference is
   * entirely in the near field: at three metres this density returns 0.05 per
   * cent where a true exponential extinction at the same coefficient returns
   * 2.1 per cent. The quadratic profile is deliberate and tuned and stays —
   * what is added is a saturating term that supplies the first stretch and then
   * stops, so it cannot touch the long-range behaviour the rectangle fix
   * depends on.
   *
   * THE SIZE OF THIS TERM WAS MIS-STATED AND IS NOW MEASURED. It was described
   * as a near-field floor worth "nine tenths of one code value" at 3 m and "two
   * to four" at 10-40 m. Differenced pairs against ?haze=nofloor say otherwise:
   * 13.3 counts on the mid carriageway and 12.7 on the far carriageway looking
   * into the sun, and 5.8 down the long lens. Three to six times the claim.
   *
   * The arithmetic the estimate missed is on the next line but one. This runs
   * *before* the phase multiply, so its nominal 4.5 per cent is delivered at up
   * to 3.4 times that looking down the beam; and 1/0.04 is a 25 m saturation
   * length, so it is not a near-field term at all — it reaches 60 per cent of
   * its ceiling by 25 m and 91 per cent by 60 m. It is a floor on the *whole*
   * mid field, and the near field, where it really is worth about a count, is
   * the one place it does least.
   *
   * Ordering it before the phase is physically right — a floor is extra
   * aerosol, and extra aerosol scatters forward like the rest of it — and the
   * region it acts on, 10-60 m toward the sun, is where the brief wants warm
   * haze. So the term stays and the ordering stays.
   *
   * IT HAS BEEN CUT FROM 0.045 TO 0.018, AND THAT IS THE HDR MOVE AND NOT A
   * CHANGE OF TASTE. This mix used to happen after the tone curve, and mixing
   * in display space suppresses haze hardest exactly where haze does most: a
   * five per cent veil of L = 2.5 air over a dark car flank at L = 0.05 is
   * worth eight code values mixed after AgX and forty mixed before it. Every
   * constant in this block was therefore tuned against a mix that was
   * understating it by a factor of five in the shadows and by rather less in
   * the highlights, which is why the frame it produced was directional and
   * thin at the same time.
   *
   * With the mix in the right space the same visual weight needs about
   * two-fifths of the density, and the part that comes off is this term rather
   * than the quadratic, for the reason the paragraph above gives: at a 25 m
   * saturation length it was never the near-field floor it was described as,
   * it was a flat lift across the whole mid field, and the mid field is
   * exactly where a radiance-space mix has most to give on its own. What is
   * left still supplies the first ten metres, which is the job it was added
   * for. Measured before and after in tools/atmo.mjs. */
  fogFactor = 1.0 - ( 1.0 - fogFactor ) * ( 1.0 - ${FLOOR.toFixed(6)} * ( 1.0 - exp( - hazeOptical * 0.04 ) ) );

  /* NOT closed with a far-field ramp, and the negative result is worth the
   * paragraph because the obvious fix is wrong twice over.
   *
   * This file's notes record the horizon as "a hard plane". The plausible cause
   * is convergence: the ground apron is a finite disc, past its rim the camera
   * sees scene.background at full sky strength, and if the fog had not quite
   * reached the sky by the rim then the last strip of apron would carry a step
   * in a straight horizontal line. The fix would be
   * max(fogFactor, smoothstep(150.0, 330.0, hazeOptical)).
   *
   * It was written, measured and removed. FogExp2 is *quadratic* in distance —
   * the exponent above is (fogDensity * hazeOptical) squared, not Beer-Lambert
   * — so it converges far faster than the linear intuition says: at the 320 m
   * rim the factor is already 0.9958, and a ramp reaching 1.0 at 330 m is
   * *below* it over its entire range. The line changed nothing, which
   * tools/hardline.mjs confirmed at 0.03 counts across three column strips.
   *
   * And there was nothing to fix. The same tool scanned the horizon band for
   * the largest coherent single-row step, which is what an edge is: the biggest
   * is 17.8 counts and sits at a building silhouette against the sky, where a
   * step belongs. There is no horizontal discontinuity in the open horizon of
   * this build. Whatever the note referred to is either already gone or was
   * always the sunlit haze band being bright rather than being an edge.
   *
   * The handoff to the sky agent's dome is therefore already sound and needs no
   * term: both sides evaluate hazeSky, so the apron converges to the same
   * radiance the background shows, and it holds through a re-grade without
   * coordination. Do not re-add the ramp; measure first. */

  /* Forward scattering. The lobe is deliberately broad: a narrow one puts a
   * hard-edged glowing disc in the haze that reads as a lens artifact rather
   * than as air, and the real effect is a wide wash that covers most of the
   * sun-facing half of the view. */
  vec3 vDir = normalize( vHazeWorld - cameraPosition );
  float mu = clamp( dot( vDir, uHazeSun ), -1.0, 1.0 );
  float forward = hazePhase( mu );              // 1.0 behind, 3.4 down the beam

  /* The air in front of this fragment, lit by the sky it is looking into. Equal
   * to the background along the same ray, so a fully hazed object disappears
   * instead of leaving an outline.
   *
   * Put through the tone curve and the output encode before it is mixed, and
   * this is the actual bug behind the rectangle.
   *
   * three includes fog_fragment *after* tonemapping_fragment and
   * colorspace_fragment, so by the time this code runs gl_FragColor is no longer
   * scene radiance — it has been through AgX and encoded to sRGB, and it lives in
   * nought-to-one display space. Mixing a linear radiance into it is a category
   * error. hazeSky returns 3.4 at the sunward horizon, which as a display value
   * clamps to 1.0 in red, so at full fog factor the fragment was being assigned
   * pure clipped red-orange with no tone curve applied to it at all: measured on
   * the previous frame the slab came back 0.83, 0.42, 0.37 against a sky of 0.55,
   * 0.43, 0.42 — half a unit of red out, in the one channel that had overflowed.
   *
   * Everything the review described follows from that one line. The haze could
   * not match the sky, because the sky is the same function tone-mapped and this
   * was not, so distant geometry kept a hard silhouette however thick the air
   * got. It clamped, so it had no shape — "a flat plateau of orange rather than a
   * bright core falling off" is precisely what a clipped channel looks like. And
   * the objects it happens to land on are untextured backdrop blocks, so the
   * plateau arrives with straight edges and right-angled corners.
   *
   * It also explains the 0.27 scale factor this file used to carry on
   * fogSunColor, and why that number had to be found by eye: it was compensating
   * for a missing tone curve. With the transform applied the scale factor is not
   * needed and the sunward haze is simply the sky.
   */
  vec3 hazeLin = hazeSky( vDir );

  /* Almost all of the haze lives in the sun-ward direction.
   *
   * The base density is now low enough that looking away from the sun the air
   * is essentially clear and the near-field road keeps every bit of its
   * texture — a uniform density high enough to look like golden hour when
   * facing the sun was milky everywhere and flattened the material work into
   * fog. The asymmetry does the job instead: this multiplies the depth term by
   * up to five looking down the beam and by nothing at all looking away.
   *
   * hazePhase now returns the multiplier itself rather than a nought-to-one
   * lobe that had to be scaled here, because the two ends of it are the thing
   * being calibrated and they should be written where they can be read. */
  fogFactor = clamp( fogFactor * forward, 0.0, 1.0 );

  /* Aerial perspective has to actually complete, and this is the other half of
   * the hard-edged rectangle.
   *
   * Making the haze equal the sky is necessary but not sufficient: an object only
   * disappears into the sky if the fog factor reaches one, and an exponential
   * never does. Measured on the frame the review objected to, the backdrop blocks
   * closing the far end sit around eighty metres out, where FogExp2 at this
   * density returns 0.34 and the forward lobe carries it to about 0.89. The
   * missing eleven per cent is the artifact: those blocks are flat untextured
   * slabs presented nearly square to a low sun, so their own colour is bright
   * enough to clip, and one part in nine of a clipping white is still far above
   * the mauve sky at that elevation. Uniform slab, uniform residue, straight
   * edges — a card. That it is worst toward the sun is why raising the exposure
   * and making the directional term live exposed it now.
   *
   * A hundred and sixty metres of urban air with a four-degree sun in it is
   * opaque; there is no honest reading in which it is eleven per cent clear. So
   * the residual transmittance is closed out over the last stretch. It is a
   * statement about long range only — by sixty metres nothing has changed, so the
   * near and middle field, where all the material work lives, is untouched.
   *
   * Keyed on hazeDist and not on the height-corrected hazeOptical, deliberately.
   * The height falloff is a statement about how much aerosol is in the way; this
   * is a statement that at a hundred and sixty metres nothing has a silhouette,
   * and a parapet at a hundred and sixty metres has no more of one than the road
   * under it. Letting the height term reach this line would hand the backdrop
   * blocks back the residue they were losing their straight edges to. */
  fogFactor = mix( fogFactor, 1.0, pow( smoothstep( 60.0, 165.0, hazeDist ), 1.6 ) );

  /* The lit-air wedge that used to be composited here has moved to
   * scene/volumetric.ts, which marches the same air against the sun's own
   * shadow map and adds the lamp cones to the same integral. What is left in
   * this chunk is the ambient term, which is all this chunk was ever able to
   * do honestly: extinction, its colour, and the phase function that shapes
   * both. */

  /* Exactly one tone map and one encode, on the combined radiance, and both of
   * them disappear when the scene is rendering into the linear target.
   *
   * That is three's doing, not a branch of ours, and it is worth being precise
   * because it is the whole reason this chunk did not need rewriting for the
   * HDR pipeline. Drawing into a non-XR render target, the renderer forces
   * NoToneMapping for every material (three.module.js:18345-18354) so
   * TONE_MAPPING is not defined and the tone map below compiles out; and the
   * target's colour space is the working space, so linearToOutputTexel is
   * generated as the identity (18336). gl_FragColor arriving here is then
   * scene radiance and the mix below is a mix of two radiances.
   *
   * Which is the correct operation, and the difference is not small. Aerial
   * perspective is a statement about light, and doing it after the tone curve
   * understates it in exactly the place it matters most: a dark car flank at
   * L=0.05 seen through five per cent of air at L=2.5 is L=0.17 — a lift of
   * more than three times, forty code values — where the same five per cent
   * mixed in display space moved it eight. Every silhouette in this scene is a
   * dark object against bright air, so the old path was suppressing the haze
   * hardest along precisely the edges the brief asks it to soften.
   *
   * On the ?nohdr path both lines are live again and this is display-encoded
   * sRGB in and out, as it was. */
  #if defined( TONE_MAPPING )
    hazeLin = toneMapping( hazeLin );
  #endif
  vec3 haze = linearToOutputTexel( vec4( hazeLin, 1.0 ) ).rgb;

  gl_FragColor.rgb = mix( gl_FragColor.rgb, haze, clamp( fogFactor, 0.0, 1.0 ) );
#endif
`;

  // vHazeWorld is not a standard varying in every material, so the fog
  // vertex chunk publishes one.
  S.fog_pars_vertex = `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vHazeWorld;
#endif
`;
  S.fog_vertex = hazeFogVertex();

  void near;
}
