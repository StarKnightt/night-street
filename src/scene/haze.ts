import * as THREE from 'three';
import { layoutBlock, BUILD_LINE, BLOCK_DEPTH } from '@/world/block';
import { walkHeight } from '@/world/geometry';

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
 *                        the frontage. This is the whole of the volumetric
 *                        budget and the argument for it is at WEDGE below.
 *
 * The fifth would be a screen-space god-ray pass, and §4.3 of the technique
 * brief is right that it is wrong for this geometry. That reasoning is recorded
 * at WEDGE rather than here, so that it sits beside what was built instead.
 */
export function installHaze(sunDir: THREE.Vector3,
                            near: THREE.Color, sunward: THREE.Color) {
  const S = THREE.ShaderChunk;
  if ((S as unknown as Record<string, unknown>).__hazeInstalled) return;
  (S as unknown as Record<string, unknown>).__hazeInstalled = true;

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

  /* ── System 6: where the lit air is ──────────────────────────────────────
   *
   * Derived from the same layout the buildings are built from, not measured off
   * a screenshot and not typed in. layoutBlock is pure and already runs twice in
   * this project (Buildings.tsx and tools/sys5.ts); a third call at install time
   * costs about a millisecond and means the wedge cannot drift away from the
   * frontage that casts it, which is the failure mode of every hand-placed
   * constant this project has had to unpick.
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
  const nl = Math.hypot(sunDir.z, sunDir.x);
  const nx = sunDir.z / nl, nz = -sunDir.x / nl;
  const dAt = (x: number, z: number) => nx * x + nz * z;

  const { gaps } = layoutBlock((x, z) => walkHeight(x, z));
  const SHAFTS = gaps
    /* Sunward only — the service alley on the shaded row is a dark slot and
     * block.ts says so — and only the two that fall inside the walk. The far
     * cross street at -118 casts a real wedge, but every fragment of it is past
     * the range at which the closeout below has already forced the haze to
     * full, so it would cost two planes' worth of arithmetic to change nothing.
     * That also keeps the count at the two atmosphere.js:299-305 argues for:
     * "half a dozen of them at once at similar weights reads as staging, since
     * real crepuscular rays are rare enough that one strong one is an event." */
    .filter((g) => g.side > 0 && g.z1 > -100)
    .map((g) => {
      const a = dAt(BUILD_LINE, g.z1);
      const b = dAt(BUILD_LINE + BLOCK_DEPTH, g.z0);
      return [Math.min(a, b), Math.max(a, b)] as const;
    })
    .slice(0, 2);
  while (SHAFTS.length < 2) SHAFTS.push([1e9, 1e9] as const);   // never entered

  const WEDGE_N = `vec2(${nx.toFixed(6)}, ${nz.toFixed(6)})`;
  const WEDGE_D = `vec4(${SHAFTS[0][0].toFixed(4)}, ${SHAFTS[0][1].toFixed(4)}, ` +
    `${SHAFTS[1][0].toFixed(4)}, ${SHAFTS[1][1].toFixed(4)})`;
  const WEST_LINE = (-BUILD_LINE).toFixed(3);

  /* The haze colour has to *be* the sky, not an approximation of it.
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
   */
  const SKY = /* glsl */ `
vec3 hazeSky( vec3 dir ) {
  float up = dir.y;
  vec2 fz = dir.xz;
  float azW = pow( max( 0.0, 0.5 + 0.5 * (
    dot( fz, uHazeSun.xz ) /
    max( 1e-4, length( fz ) * length( uHazeSun.xz ) ) ) ), 4.6 );

  const vec3 zenith      = vec3( 0.0850, 0.1300, 0.3600 );
  const vec3 upperWarm   = vec3( 0.7400, 0.3900, 0.3450 );
  const vec3 horizonSun  = vec3( 3.4000, 1.4200, 0.4200 );
  const vec3 horizonAway = vec3( 0.2000, 0.2000, 0.3100 );

  float band = pow( max( 0.0, 1.0 - max( up, 0.0 ) ), 5.6 );
  float mid  = pow( max( 0.0, 1.0 - max( up, 0.0 ) ), 2.30 );

  vec3 horizonC = mix( horizonAway, horizonSun, azW );
  vec3 base = mix( zenith, upperWarm, mid * ( 0.14 + 0.86 * azW ) );
  vec3 col = mix( base, horizonC, band );

  float ang = acos( clamp( dot( dir, uHazeSun ), -1.0, 1.0 ) );
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

  /* A real phase function, in place of a one-sided power.
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
   * above carries the aureole as exp(-ang*19.0)*5.60, ported from env.ts, so
   * the tight lobe arrives in the haze's colour. If it were also in the density
   * it would be counted twice and the result is the "hard-edged glowing disc
   * that reads as a lens artifact" this file already warns against. So the
   * density term carries the broad asymmetry only, and 0.42 is what is left of
   * 0.78 once the aureole is removed from it.
   *
   * The negative-g term is the backscatter enhancement real haze has, and it
   * is why looking away from the sun gives a veil rather than clear air.
   *
   * Normalised so that the two ends land where the tuned version landed: 1.0
   * at the minimum of the phase (which is at mu ~ -0.6, not at -1) and 3.4
   * looking straight down the beam. Measured against the old curve with
   * tools/agx.mjs the two agree within 13% everywhere except the 20-45 degree
   * band, where this one is narrower by about a tenth — which is the aureole
   * no longer being paid for twice.
   */
  const PHASE = /* glsl */ `
float hazePhase( float mu ) {
  // 4pi * HG, so an isotropic medium would return 1.0.
  float a = 1.1764 - 0.84 * mu;                 // g1 = 0.42
  float b = 1.0400 + 0.40 * mu;                 // g2 = -0.20
  float p = 0.78 * 0.8236 * inversesqrt( a * a * a )
          + 0.22 * 0.9600 * inversesqrt( b * b * b );
  // 1.0 at the phase minimum, 3.4 down the beam. tools/agx.mjs prints the pair.
  return 1.0 + 0.8496 * ( p - 0.5901 );
}
`;

  /* Lit air, analytically, and the case against building a volumetric renderer
   * to get it.
   *
   * At 4.2 degrees the beam runs *along* this canyon rather than across it, so
   * a general shaft is parallel to the view, has no cross-section in frame, and
   * integrates to a wash — and a ray lying near the ground spends its whole
   * length in the densest air there is, which is how jungle-trail's raymarch
   * turned a dark textured bank into flat beige at 2.4 times the in-scatter of
   * the real beams. The forward lobe above is already the correct and far
   * cheaper representation of that wash. What a march would add here is the one
   * thing the wash cannot express, and it is a much smaller thing than it looks:
   * the *edge* where a gap in the frontage stops letting light through.
   *
   * That edge is a plane, and it can be written down. So this is the whole of
   * the volumetric budget: two ray-slab intersections, no march, no
   * half-resolution buffer, no depth-aware upsample, no interleaved noise, and
   * no second render target. It is also exact rather than sampled — the segment
   * of the view ray that lies in lit air is solved, not stepped, so it cannot
   * band and cannot alias, and it is automatically occluded because the segment
   * is clipped at the distance of the fragment that is running the shader.
   *
   * Three gates, each earning its place:
   *
   *   height   above the shade line the sun clears the parapet and *all* the
   *            air is lit, so there is no edge and nothing to draw; below the
   *            road there is no air. Evaluated at the midpoint of the lit
   *            segment, which is a real approximation and shows up as a soft
   *            vertical gradient rather than as a wrong edge.
   *   west     the shaft dies on the shaded frontage. There is no lit air
   *            behind it, and the apron plane runs 320 m out past it.
   *   length   clamped. A view direction lying in the slab's own plane has an
   *            unbounded intersection with it, which is jungle-trail's
   *            ground-parallel ray by another route.
   */
  const WEDGE = /* glsl */ `
const vec2 uWedgeN = ${WEDGE_N};
const vec4 uWedgeD = ${WEDGE_D};

/* Entry and exit parameter of the view ray through one boundary slab. */
vec2 wedgeSpan( vec2 o, vec2 v, float d0, float d1, float tMax ) {
  float pn = dot( v, uWedgeN );
  float on = dot( o, uWedgeN );
  if ( abs( pn ) < 1e-4 ) {
    return ( on > d0 && on < d1 ) ? vec2( 0.0, tMax ) : vec2( 0.0 );
  }
  float ta = ( d0 - on ) / pn;
  float tb = ( d1 - on ) / pn;
  return vec2( max( min( ta, tb ), 0.0 ), min( max( ta, tb ), tMax ) );
}

float wedgeOne( vec3 o, vec3 v, float d0, float d1, float tMax ) {
  vec2 s = wedgeSpan( o.xz, v.xz, d0, d1, tMax );
  float len = min( s.y - s.x, 25.0 );
  if ( len <= 0.0 ) return 0.0;
  vec3 m = o + v * ( 0.5 * ( s.x + s.y ) );
  float gy = ( 1.0 - smoothstep( 6.5, 13.5, m.y ) ) * smoothstep( -0.8, 0.3, m.y );
  float gx = smoothstep( ${WEST_LINE} - 1.5, ${WEST_LINE} + 1.5, m.x );
  return len * gy * gx;
}

/** Metres of the view ray, out to tMax, that lie in air the sun still reaches. */
float wedgeLength( vec3 o, vec3 v, float tMax ) {
  return wedgeOne( o, v, uWedgeD.x, uWedgeD.y, tMax )
       + wedgeOne( o, v, uWedgeD.z, uWedgeD.w, tMax );
}
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
  const vec3 uHazeSun = ${SUN};
  const vec3 uHazeSunColor = ${SUNC};
${SKY}
${PHASE}
${WEDGE}
#endif
`;

  S.fog_fragment = `
#ifdef USE_FOG
  /* COLOUR SPACE, stated at the top of the pass as §2 of the technique brief
   * requires, because this chunk is the one place in the project that has
   * already got it wrong once.
   *
   *   in    gl_FragColor  display-encoded sRGB, 0..1. three includes this chunk
   *                       after tonemapping_fragment and colorspace_fragment,
   *                       and sensor.ts prepends itself to the latter, so the
   *                       value arriving here has been through AgX, the sensor
   *                       pedestal and the sRGB encode already.
   *   local hazeLin, beamLin, mixLin   linear scene radiance, sRGB primaries.
   *   out   gl_FragColor  display-encoded sRGB.
   *
   * Exactly one tone map and one encode happen in this chunk, on the combined
   * radiance, immediately before the mix. Nothing linear crosses that line.
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
  float kdy = 0.05556 * dy;
  float heightFactor = ( abs( kdy ) < 1e-3 ) ? 1.0 : ( 1.0 - exp( - kdy ) ) / kdy;
  float hazeOptical = hazeDist * heightFactor;

  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * hazeOptical * hazeOptical );
    float hazeSigma = fogDensity;
  #else
    float fogFactor = smoothstep( fogNear, fogFar, hazeOptical );
    float hazeSigma = 1.0 / max( fogFar - fogNear, 1.0 );
  #endif

  /* A near-field floor, because fog that is exactly zero at zero distance is a
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
   * Sized rather than picked. Measured through tools/agx.mjs, at 3 m this puts
   * 0.5 per cent of a haze that reads 191 over a near road that reads 17, which
   * is nine tenths of one code value. That is the honest size of the effect and
   * it is worth saying plainly: air at three metres does almost nothing, and the
   * crushed near field in the crop is veiling glare in the lens, which is
   * System 8's, not air, which is this file's. Where it does register is 10-40 m
   * — the opposite footway, the far kerb, the parked car three cars down — and
   * there it is worth two to four code values of separation that were not there. */
  fogFactor = 1.0 - ( 1.0 - fogFactor ) * ( 1.0 - 0.045 * ( 1.0 - exp( - hazeOptical * 0.04 ) ) );

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

  /* ── the lit-air wedge, composited as a second species of air ─────────────
   *
   * There are now two kinds of air in front of this fragment: the ambient haze
   * above, lit by the sky, and the stretch of it that is standing in the beam
   * coming through a gap in the sunward frontage. They have different colours
   * and different amounts, and the one thing that must not happen is for the
   * second one to be added to a display-encoded buffer — that is instance 2 in
   * the register of this project's expensive bugs and the reason the block above
   * exists at all.
   *
   * So they are combined as radiances, before anything is tone-mapped: two
   * absorbing species over one background, an in-scatter weighted mean of the
   * two colours, and exactly one trip through the tone curve and the encode for
   * the result. With no wedge in the ray this reduces algebraically to the line
   * that was here before.
   *
   * fBeam is genuine extinction over the lit segment — 1 - exp(-sigma * length)
   * at the same density the rest of the file uses — so a ten-metre crossing is
   * seven per cent of the pixel and a grazing one is more. The beam's own colour
   * is not invented either: horizonSun in env.ts, (3.4, 1.42, 0.42), *is* this
   * sun's light scattered by this air at saturation, so sunlit air converges on
   * it by construction and the wedge cannot end up a different colour from the
   * sky it is a piece of.
   *
   * The phase function scales the colour and not the amount, because that is
   * where it belongs: the beam deposits the same energy in the same air however
   * you look at it, and what changes with angle is how much of it comes back
   * toward the lens.
   *
   * The last gate is the one jungle-trail paid two paragraphs for. Looking down
   * the beam the wedge has no cross-section, the intersection lengthens without
   * limit, and the honest representation of that geometry is the forward lobe
   * above — which is already doing it. So the wedge fades out over the last ten
   * degrees and hands the job over rather than double-counting it. */
  float beamLen = wedgeLength( cameraPosition, vDir, hazeDist );
  float viewGate = 1.0 - smoothstep( 0.80, 0.985, abs( mu ) );
  float fBeam = ( 1.0 - exp( - hazeSigma * beamLen ) ) * viewGate;
  vec3  beamLin = vec3( 3.4000, 1.4200, 0.4200 ) * ( forward * 0.2941 );

  float fTotal = 1.0 - ( 1.0 - fogFactor ) * ( 1.0 - fBeam );
  vec3  mixLin = ( hazeLin * fogFactor + beamLin * fBeam ) / max( fTotal, 1e-4 );

  /* Tone-mapped and encoded here and only here. Everything above this line is
   * linear scene radiance; everything below it is display-encoded sRGB, which is
   * what gl_FragColor already holds. */
  #if defined( TONE_MAPPING )
    mixLin = toneMapping( mixLin );
  #endif
  vec3 haze = linearToOutputTexel( vec4( mixLin, 1.0 ) ).rgb;

  gl_FragColor.rgb = mix( gl_FragColor.rgb, haze, clamp( fTotal, 0.0, 1.0 ) );
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
  S.fog_vertex = `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vHazeWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
#endif
`;

  void near;
}
