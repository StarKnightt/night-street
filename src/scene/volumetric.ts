/* The single volumetric pass: sun shafts and lamp cones in one march.
 *
 * ── Why a march, having argued against one ────────────────────────────────
 *
 * `haze.ts` used to carry two analytic ray-slab intersections in place of a
 * march, and the argument for that was good: at 4.2 degrees the beam runs
 * *along* this canyon, a general shaft has no cross-section in frame, and the
 * only thing the wash cannot express is the edge where a gap in the frontage
 * stops letting light through — which is a plane, and can be written down.
 *
 * Two things overturned it.
 *
 * The first is the lamp cones. A dozen luminaires at 6.8 m, each throwing a
 * 70-degree cone into the air, is not two planes and cannot be made into two
 * planes; and a screen-space radial blur — the other cheap option — needs the
 * source *in frame*, which the sun mostly is not on this street and which a
 * lamp behind the camera never is. The marginal cost of adding local lights to
 * a march that is already stepping the air is four multiply-adds a step. The
 * cost of a second system is a second system.
 *
 * The second is that the analytic version was occluded by the two frontage
 * gaps and by nothing else. Not by the van, not by the parapet notch, not by
 * the fire escape, not by the bollards — and at 4.2 degrees a bollard throws a
 * shadow eighteen metres long. The shadow map already contains every one of
 * those and is already being rendered.
 *
 * jungle-trail's warning is still live and is answered rather than ignored:
 * a ray lying near the ground spends its whole length in the densest air there
 * is, which is how a march turns a textured bank into flat beige. The answer
 * is that this march does not carry the ambient term at all. `haze.ts` still
 * owns that, analytically, as a closed-form height-integrated extinction. What
 * this pass integrates is *only the difference* between lit air and shaded air
 * — the in-scattering, gated by visibility — which is zero wherever the
 * visibility is uniform. A ray down an unshadowed street accumulates the same
 * value at every step and produces a wash that the ambient term has already
 * accounted for; so the sun's contribution here is written as a deviation from
 * its own mean along the ray. Flat beige is not reachable from that.
 *
 * ── Cost shape ────────────────────────────────────────────────────────────
 *
 * Half resolution, 24 steps, interleaved-gradient jitter, depth-aware
 * upsample in the final pass. Quarter of the pixels, and the depth-aware
 * upsample is four taps in a shader that is already running.
 *
 * ── What it is anchored to, which is the part that matters ────────────────
 *
 * Nothing in this file contains a position. The sun, its shadow map and its
 * shadow matrix are found by walking the scene graph. The lanterns come from
 * `lampFixtures()`, which is the table System 5 lights the street from. The
 * far-field sun visibility comes from `haze.ts`'s `gapLit`, which is derived
 * from `layoutBlock`. The scattering density comes from `scene.fog`. The
 * medium's albedo comes from `env.ts`'s own horizon.
 *
 * That is deliberate to the point of stubbornness. This project has a recorded
 * history of duplicated placement tables drifting apart, the density agent has
 * just finished consolidating one such mess, and a light shaft that does not
 * line up with the gap that casts it reads as a lens artifact rather than as
 * light. A table of fixture positions in this file would be a third copy.
 *
 * ── Lamp occlusion, which this pass does not have and has to answer for ───
 *
 * The sun is the only shadow caster in the scene. There is no lamp shadow map,
 * adding one would be seven more depth passes, and an unoccluded cone shining
 * through a building would be worse than no cone at all. So:
 *
 *   *Behind* geometry is handled exactly and for free. The march stops at the
 *   scene depth, so no sample is ever taken past the nearest surface along the
 *   ray. A cone can never be drawn over a wall, a van or a parked car — the
 *   most visible class of this error does not arise.
 *
 *   *Through* geometry is the remaining case: air in front of a wall, lit by a lantern
 *   standing behind it. On this street that case is close to empty, and it is
 *   worth saying why rather than asserting it. The canyon is straight and
 *   11.4 m wide; the lanterns stand at x = +-3.15 after their outreach, inside
 *   it; the frontages are at +-5.7. So the segment from any lantern to any air
 *   the camera can see stays inside the corridor unless it passes a gap in the
 *   frontage — and light through a gap is light, not an error. The one real
 *   occluder left is a parked van between a lamp and the air beside it, whose
 *   roof is at 2.4 m against a bowl at 6.8 m: it can shadow the air below
 *   knee height for a couple of metres, and that is a low-contrast error
 *   inside a low-contrast effect.
 *
 *   The optic does the rest. `lanternLobe` cuts off at 79 degrees off nadir,
 *   so no lantern lights the air above its own bowl. That is the error that
 *   would actually be seen — a cone washing up the frontage behind the lamp —
 *   and it is prevented by the fixture's own distribution rather than by a
 *   clamp.
 */
import * as THREE from 'three';
import {
  Blit, IGN_GLSL, RAY_GLSL, makeColourTarget, rayUniforms, setRayUniforms,
} from './pipeline';
import { gapLitGLSL, hazePhaseGLSL, hazeSkyGLSL, sunwardAirlight } from './haze';
import { LAMP_CROSS, LAMP_CUT, LAMP_PEAK, lampFixtures } from './lampFixtures';

/* The most lanterns the march will carry in one frame.
 *
 * Five, and the street has seven at 17-20 m spacing, so this is the nearest
 * three either side of the walker. A lantern's own pool is about eight metres
 * across and its airborne cone is invisible well before the next fixture, so
 * the two that are dropped could not have contributed a code value; the cull
 * is by distance from the camera and it is what stops a longer street costing
 * more than a short one. */
const MAX_CONES = 5;

type Sun = {
  dir: THREE.Vector3;          // unit vector from the scene *towards* the sun
  irradiance: THREE.Color;     // linear, lux on a perpendicular plane
  map: THREE.Texture | null;
  matrix: THREE.Matrix4 | null;
  mapSize: THREE.Vector2;
};

const _sunPos = new THREE.Vector3();

/**
 * The sun, its irradiance, and its shadow map — found, not configured.
 *
 * The brightest shadow-casting DirectionalLight in the scene. Written this way
 * because the lighting agent is about to change the sun's angle, intensity and
 * colour to a calibrated hero-shot setting, and every constant in this file is
 * expressed against `irradiance` so that when they do, the shafts track it
 * without anyone editing this file. That was the explicit instruction and it
 * is also just the right dependency direction.
 *
 * `depthTexture || texture` is not defensive coding, it is the fix for a bug
 * this project has already paid for once. Under BasicShadowMap three renders
 * depth into an actual depth attachment and `shadow.map.texture` is the colour
 * attachment, which is empty; reading it gives a shadow term of zero
 * everywhere, which looks exactly like "the shafts are not working".
 */
function findSun(scene: THREE.Object3D): Sun | null {
  let best: THREE.DirectionalLight | null = null;
  scene.traverse((o) => {
    const d = o as THREE.DirectionalLight;
    if (!d.isDirectionalLight || !d.castShadow) return;
    if (!best || d.intensity > best.intensity) best = d;
  });
  if (!best) return null;
  const light = best as THREE.DirectionalLight;

  light.getWorldPosition(_sunPos);
  const tp = light.target.getWorldPosition(new THREE.Vector3());
  const dir = _sunPos.clone().sub(tp);
  if (dir.lengthSq() < 1e-8) return null;
  dir.normalize();

  const sh = light.shadow;
  const rt = sh?.map as THREE.WebGLRenderTarget | null | undefined;
  const map = rt ? (rt.depthTexture ?? rt.texture) : null;

  return {
    dir,
    /* No convertSRGBToLinear here, and the first version had one.
     *
     * three's ColorManagement is enabled by default and decodes on assignment,
     * so `light.color` is *already* the working-space colour by the time it is
     * read back — Street.tsx writes "#ff9a4e" and what lands in the object is
     * (1.000, 0.325, 0.076), not (1.000, 0.604, 0.306). Decoding it a second
     * time gave (1.000, 0.089, 0.007) and an irradiance of (115, 10.2, 0.78)
     * against a true (115, 37.4, 8.8).
     *
     * It was invisible in the frame because this value is only ever a divisor:
     * the air albedo below came out (0.029, 0.144, 0.541) instead of (0.029,
     * 0.038, 0.048), so the lamp cones were eleven times too blue in a scene
     * whose lamps are sodium and whose cones are faint. Caught by printing the
     * albedo next to its predicted value rather than by looking at a frame,
     * which is the only way this one was ever going to surface. */
    irradiance: light.color.clone().multiplyScalar(light.intensity),
    map: map ?? null,
    matrix: sh ? sh.matrix : null,
    mapSize: sh ? sh.mapSize : new THREE.Vector2(2048, 2048),
  };
}

/* ── the shader ──────────────────────────────────────────────────────────── */

/*
 * ── What this pass adds, stated as an equation, because getting it wrong is
 *    the difference between crepuscular rays and flat beige ────────────────
 *
 * `haze.ts` already delivers, in closed form and over the same air, the
 * in-scattering of a medium whose source radiance is `hazeSky(dir)` — the
 * sky's own radiance along the ray. That is not an approximation of lit air,
 * it *is* lit air: the sky is the infinite column of it. So the ambient term
 * has already asserted that every metre of air in front of every fragment is
 * fully lit.
 *
 * The only thing wrong with that assertion is the word *fully*. So this pass
 * integrates the correction and nothing else:
 *
 *     dL  =  - hazeSky( dir ) * SUN_SHARE * ( 1 - vis(p) ) * sigma(p) * T(p) dp
 *
 * — zero wherever the sun reaches, negative in shadow, and never a wash,
 * because a ray whose visibility is constant contributes a constant, and a
 * constant of zero. Jungle-trail's ground-parallel ray, which spends its whole
 * length in the densest air and came back 2.4x over, is by construction the
 * case this cannot get wrong: an unshadowed one lands on exactly nothing.
 *
 * A shaft is then *contrast*, not added energy, which is also what a shaft
 * physically is. Nothing in this pass can raise a pixel above the fully-lit
 * value the ambient term already computed for it, so it cannot bleach the
 * frame and cannot clip anything.
 *
 * Two consequences worth stating because they are not obvious:
 *
 *   The colour is right for free. Shaded air loses `hazeSky(dir)`, which is
 *   the sunward horizon looking into the beam and the cold mauve looking away,
 *   so a shadow band across warm haze goes *cool* and not merely dark. That is
 *   the single most recognisable thing about real crepuscular rays and it
 *   would have taken a colour constant to get any other way.
 *
 *   It tracks the sun and the sky agent without a constant in this file.
 *   `hazeSky` is generated by `haze.ts` from `env.ts`'s dome, so a re-graded
 *   sky moves the shafts with it; a brighter sun moves the dome and moves them
 *   again. There is no shaft brightness to re-tune.
 *
 * SUN_SHARE was the fraction of the air's glow coming from the direct beam
 * rather than from the rest of the dome — 0.75, with 1.0 the physical ceiling,
 * because shaded air is not black air. It is now a *gain* on that term, above
 * physical on purpose and at the user's instruction, and the ceiling it used to
 * be is enforced explicitly by a min() at the accumulation instead.
 *
 * ── What that costs, and what it does not ─────────────────────────────────
 *
 * The safety property worth having survives untouched, and it is worth being
 * precise about which one that is. There were two:
 *
 *   the term cannot brighten a pixel     — holds at any gain whatsoever,
 *                                          because the sign is fixed negative.
 *                                          Nothing here can bleach the frame
 *                                          or add a count to the OPEN neon's
 *                                          clipped core, at gain 1 or gain 100.
 *   it cannot remove more airlight       — does NOT survive a raw gain, and is
 *   than haze.ts added                     restored by the min() below.
 *
 * Only the first is load-bearing for the defects on record. The second matters
 * because losing it would let a gain drive shadowed air darker than the surface
 * behind it actually is, which is a crushing artifact rather than a blowout —
 * so it is kept, but kept as a clamp that the gain is allowed to reach rather
 * than as a number the gain must stay under.
 *
 * ── MEASURED: THIS GAIN CURRENTLY MULTIPLIES ZERO ─────────────────────────
 *
 * Read this before tuning the number. With uDebug at 1 the pass writes its own
 * integrals, and across all ten of tools/atmo.mjs's regions:
 *
 *     shadeSharp = 0.00000     every region, without exception
 *     shadeSoft  < 0.0003      every region except sky, against an available
 *                              airlight of 0.024 to 0.123
 *
 * So both occlusion sources report that essentially no air in this frame is in
 * shadow, and a sweep of this gain from 1 to 8 moves the term by 0.0001 of
 * radiance, which is the arithmetic of multiplying zero. The shafts that
 * earlier captures appeared to show sweeping under motion were the lamp cones
 * moving; the sun term was not participating.
 *
 * Two independent causes, both located and neither yet fixed:
 *
 *   shadeSharp — the shadow-map branch never runs. uShadowOn is 1 and the map
 *     is bound, so lastShadow reports true and everything downstream looks
 *     wired, but `inside` evaluates to 0 for every sample, meaning no marched
 *     point lands within the shadow camera's frustum in shadow-UV space. The
 *     map is 44 m across and follows the camera, so the leading suspect is that
 *     it is centred somewhere the marched air is not.
 *   shadeSoft — gapLit reports near-field air as lit almost everywhere, so its
 *     slab test believes the beam covers the street rather than two gaps in it.
 *
 * The consequence for anyone picking this up: fixing either one will switch a
 * gain of six on, at full strength, over air that is currently contributing
 * nothing. The min() clamp below bounds what that can do to one frame's worth
 * of airlight, which is why it is safe to leave the gain here rather than
 * reverting it — but expect the frame to change materially, and re-measure the
 * blob described under SUN_SHARE before assuming the number is still right.
 *
 * ── Why a gain was needed at all ──────────────────────────────────────────
 *
 * Because within the old reading the ceiling binds long before a beam is
 * visible, and by a wide margin. Measured at 0.75 the shaft term was 0.24 to
 * 0.56 code values in near air; the whole range left to the physical ceiling
 * was 1.33x, against the 20 to 50x that would be needed. The reason is not the
 * share, it is sigma: the most any shaft can modulate over a path is the
 * airlight accumulated along it, and at this density five metres of air holds
 * 3.5 per cent of its saturation value. Raising sigma is what would fix it
 * physically and is exactly the trade the user declined, because it veils the
 * 30 m mid field. So the gain saturates the available airlight instead, which
 * makes a shaft "all of the haze at this range, removed" — the loudest a shaft
 * can be without either raising sigma or letting it go darker than the surface.
 *
 * The lamp cones are the opposite case and are handled the opposite way.
 * Nothing else in the project accounts for them at all, so they are pure
 * addition, and they are the only place a photometric absolute is needed —
 * which is where `uAir` comes in, below.
 */
const SUN_SHARE = 6.0;

function marchFragment(sunDir: THREE.Vector3): string {
  return /* glsl */ `
precision highp float;
precision highp sampler2D;

varying vec2 vUv;

uniform sampler2D uDepth;
uniform sampler2D uShadow;
uniform mat4  uShadowMat;
uniform vec2  uShadowTexel;
uniform float uShadowOn;
uniform vec3  uAir;            // per-channel albedo of the medium, from env.ts
uniform vec3  uSunDir;         // towards the sun
uniform float uSigma;          // extinction, 1/m, at eye height
uniform float uKHeight;        // 1 / scale height
uniform float uSunShare;
uniform float uDebug;
uniform float uConeGain;
uniform float uFrame;
uniform int   uConeCount;
uniform vec4  uConePos[ ${MAX_CONES} ];   // xyz, w = nadir intensity, candela
uniform vec4  uConeDir[ ${MAX_CONES} ];   // xyz = emission axis, w unused
uniform vec4  uConeCol[ ${MAX_CONES} ];   // rgb = chromaticity, w unused

/* The lantern's distribution, copied verbatim from lanternLobe in lights.ts.
 *
 * Verbatim on purpose, and in preference to the coneAlong/coneAcross pair the
 * fixture table also publishes. Those two half-angles are *derived from* this
 * function — lampFixtures.ts solves them out of LAMP_CUT and LAMP_CROSS rather
 * than tabulating them — so using them would be reconstructing an ellipse from
 * two of its measurements when the shape itself is eight lines long. It would
 * also lose the batwing, which is not a detail: the peak of this lobe is 25 to
 * 45 degrees off the column and 2.4 times nadir, so an elliptical cone would
 * put the brightest air directly under the lamp when the fixture actually puts
 * it out to the sides. That is the difference between a cone and a lantern.
 *
 * The consequence that matters is registration. The visible cone and the pool
 * on the pavement are now the same function of the same fixture, so they share
 * an edge exactly, and there is no value of anything that can make the air
 * disagree with the ground it is lighting.
 */
float lanternLobe( float ax, vec3 D, vec3 A, float k ) {
  vec3 T = D - ax * A;
  float ts = T.z;                       // along the street
  float tc = length( T.xy );            // across it, and up the buildings
  float cs = ax * inversesqrt( ax * ax + ts * ts + k * k * tc * tc + 1e-9 );
  return min( 1.0 / max( cs * cs * cs, 1.0 / ${LAMP_PEAK.toFixed(4)} ), ${LAMP_PEAK.toFixed(4)} )
       * smoothstep( ${LAMP_CUT[0].toFixed(4)}, ${LAMP_CUT[1].toFixed(4)}, cs );
}

${RAY_GLSL}
${IGN_GLSL}
${hazePhaseGLSL()}
${hazeSkyGLSL('uSunDir')}
${gapLitGLSL(sunDir)}

/* Sun visibility, exact where the shadow map reaches and analytic past it.
 *
 * The sun's shadow camera is 44 m across and follows the walker, and the sun
 * bears 35 degrees off the street axis, so a ray straight down the canyon
 * leaves the map sideways at about 38 m. Inside that, this is the real thing —
 * occluded by the van, the bollards, the parapet notch, everything that casts,
 * and a bollard at 4.2 degrees casts eighteen metres of it. Outside it,
 * gapLit answers the same question from the frontage layout, and the two are
 * blended across the last few per cent of the map so the handover is not an
 * edge in the picture.
 *
 * Letting the sampler clamp at the border instead would be the usual shortcut
 * and it fails in the expensive direction: whatever happens to be at the edge
 * of the frustum gets smeared down the entire street.
 */
/* Returns (visibility, confidence).
 *
 * The second component is new and it is what stops a gain from making fog. It
 * is 1 where this sample's answer came from the shadow map and 0 where it came
 * from the analytic slab, and the caller boosts only the first kind.
 *
 * The reason to separate them is that the two have completely different
 * gradients and only one of them is a shaft. The shadow map resolves a gap edge
 * to a texel — sharp, correctly placed, an edge. The analytic term cannot: its
 * height gate ramps from 6.5 m to 13.5 m, because "above the roofline" is
 * genuinely fuzzy across a block whose buildings are not the same height, and a
 * 7 m ramp against a real solar penumbra of 0.35 m at 40 m is twenty times too
 * soft to read as anything. Multiplying that by six does not produce a distant
 * shaft, it produces a brown cloud hanging over the pavement, which is what the
 * first attempt at this gain did.
 *
 * So the near field gets the gain and the far field stays at unity. A shaft is
 * then loud exactly where the geometry is known well enough to give it an edge,
 * and the analytic term keeps doing the job it is good at — sunward air being
 * generally brighter than shadowed air at range — without pretending to a
 * precision it does not have.
 */
vec2 sunVisible( vec3 p ) {
  float analytic = gapLit( p );
  if ( uShadowOn < 0.5 ) return vec2( analytic, 0.0 );

  vec4 sc = uShadowMat * vec4( p, 1.0 );
  vec3 s = sc.xyz / sc.w;
  vec3 e = min( s, 1.0 - s );
  float inside = smoothstep( 0.0, 0.05, min( e.x, e.y ) );
  // Past the far plane of the shadow camera nothing is recorded, and nothing
  // recorded is lit rather than shaded.
  if ( inside <= 0.0 || s.z > 1.0 ) return vec2( analytic, 0.0 );

  /* Four taps on a rotated cross rather than one. A single fetch gives the
   * march a stair-stepped edge at half resolution that survives the upsample;
   * a cross at a texel and a half is about 0.4 m of penumbra at this map
   * density, which is close to the real figure for a gap edge at thirty
   * metres. The rotation is per pixel and per frame, so what is left of the
   * stepping is noise rather than a pattern. */
  float a = 6.2831853 * ign( gl_FragCoord.xy + uFrame );
  vec2 r = vec2( cos( a ), sin( a ) ) * uShadowTexel * 1.5;
  vec2 q = vec2( -r.y, r.x );
  float bias = 0.0016;
  float lit =
      step( s.z - bias, texture2D( uShadow, s.xy + r ).r )
    + step( s.z - bias, texture2D( uShadow, s.xy - r ).r )
    + step( s.z - bias, texture2D( uShadow, s.xy + q ).r )
    + step( s.z - bias, texture2D( uShadow, s.xy - q ).r );
  return vec2( mix( analytic, lit * 0.25, inside ), inside );
}

void main() {
  vec3 ray = camRay( vUv );
  float rayLen = length( ray );
  vec3 dir = ray / rayLen;

  /* Where the march stops.
   *
   * viewDepth is depth along the view *axis*; the ray is unit length at unit
   * depth along that axis, so the distance to the fragment is the depth times
   * the ray's length. Confusing the two shortens the march towards the edges
   * of frame by up to a fifth, which would read as a vignette in the shafts. */
  float vz = viewDepth( texture2D( uDepth, vUv ).r );
  float far = min( vz * rayLen, 140.0 );
  /* Sky pixels come back at the far plane and still march, because a lamp cone
   * crossing a gap at the end of the street is in front of the sky and is real.
   * The *sun* term is switched off on them, which is skyPix below. */
  float skyPix = step( uDepthRange.y * 0.98, vz );
  far = mix( far, 140.0, skyPix );

  vec3 sky = hazeSky( dir );

  /* 48, up from 24, and this is the change that decides whether the result is a
   * shaft or a warm smear.
   *
   * A beam is legible because of the boundary between lit and shadowed air, not
   * because the lit air is bright. At 24 steps over 140 m the step is 5.8 m, so
   * a shadow edge is resolved to plus or minus 5.8 m *along the ray* — and the
   * interleaved-gradient jitter, which is there to stop the banding that
   * coarseness would otherwise cause, converts what is left of the edge into
   * noise. The two together mean the march was reproducing the position of
   * every gap correctly and the *gradient* of none of them: exactly the failure
   * mode where a stronger term yields more fog rather than more shaft.
   *
   * Halving the step to 2.9 m is the direct fix and the budget is not close to
   * tight — the pass was 0.498 ms of an 8.9 ms frame, so doubling the march
   * costs about half a millisecond and buys the entire effect. Measured after,
   * with the boundary gradient read off the march's own target rather than
   * judged by eye. */
  const int STEPS = 48;
  float dt = far / float( STEPS );
  /* Interleaved gradient noise, re-seeded every frame. Without the jitter a
   * 24-step march bands visibly across a shaft edge; without the re-seed the
   * bands merely become a fixed pattern, which is the defect sensor.ts had to
   * fix for its read noise and which reads as a dirty lens rather than as
   * sampling. */
  float jit = ign( gl_FragCoord.xy + uFrame );

  /* Two shade integrals, not one: the part the shadow map resolved sharply and
   * the part the analytic slab could only estimate. Only the first is gained. */
  float shadeSharp = 0.0;
  float shadeSoft = 0.0;
  vec3  cones = vec3( 0.0 );
  float trans = 1.0;

  for ( int i = 0; i < STEPS; i ++ ) {
    float t = ( float( i ) + jit ) * dt;
    vec3 p = uCamPos + dir * t;
    float sig = uSigma * exp( - uKHeight * ( p.y - uCamPos.y ) );
    float seg = sig * dt;
    float w = trans * seg;

    vec2 vis = sunVisible( p );
    float dark = w * ( 1.0 - vis.x );
    shadeSharp += dark * vis.y;
    shadeSoft += dark * ( 1.0 - vis.y );

    /* Lantern in-scattering.
     *
     * The same integral as the sun's, with the same medium and the same phase
     * function, differing only in where the light comes from: E = I/r^2 with
     * the fixture's own distribution instead of a parallel beam. The r^2 floor
     * is lights.ts's 200 mm, for lights.ts's reason — an unfloored inverse
     * square has a singularity inside the geometry of its own fitting.
     *
     * This term is *added* rather than differenced against an ambient, unlike
     * the sun above. Nothing else in the project accounts for lamp light in
     * air, so there is no double count to avoid and it is the whole of its own
     * signal. It is also the only place in this pass that needs a photometric
     * absolute, which is what uAir is for. */
    for ( int c = 0; c < ${MAX_CONES}; c ++ ) {
      if ( c >= uConeCount ) break;
      vec3 toL = uConePos[ c ].xyz - p;
      float d2 = max( dot( toL, toL ), 0.04 );
      vec3 L = toL * inversesqrt( d2 );
      float ax = max( -dot( L, uConeDir[ c ].xyz ), 0.0 );
      float lobe = lanternLobe( ax, -L, uConeDir[ c ].xyz, ${LAMP_CROSS.toFixed(4)} );
      cones += uConeCol[ c ].rgb * ( w * uConePos[ c ].w * lobe / d2 )
             * ( hazePhase( dot( dir, L ) ) / HAZE_PHASE_FWD );
    }

    trans *= exp( - seg );
  }

  /* Negative for the sun, positive for the lamps, and the final pass adds both
   * to the scene radiance and clamps at zero. Half-float carries the sign.
   *
   * ── Why the sun term is gated on not being sky ──────────────────────────
   *
   * This term does not *add* a shaft, it removes the in-scatter that haze.ts
   * already added for air that turns out to be in shadow. That only balances
   * where haze.ts actually added something, and the two cases differ:
   *
   *   geometry — the fog chunk ran, and shade is bounded above by 1 - trans
   *              because it accumulates the same sigma against the same
   *              transmittance, so the subtraction can never exceed the haze it
   *              is subtracting from. Correct by construction, no clamp needed.
   *   sky      — three renders scene.background through its own pass and does
   *              not fog it, so nothing was added and there is nothing to take
   *              away. Subtracting anyway removes light that was never there.
   *
   * Measured: without this gate a near-horizontal ray that ends on open sky at
   * the end of the street marches 140 m of shadowed canyon air and pulled the
   * sky region down by 9.2 counts — a dark band across the top of the frame
   * with no physical cause, which is worse than having no shafts.
   *
   * So shafts here read as structure *within* the aerial perspective rather
   * than as beams drawn over the sky. That is also what they do in the
   * photographs: the haze is the thing that makes the shaft visible, and where
   * there is no haze between you and the subject there is no shaft either.
   *
   * A hard step rather than a ramp, because the only place it switches is a
   * silhouette edge, which is already a discontinuity in every other channel. */
  /* The ceiling, explicit. shade is bounded by 1 - trans, which is the opacity
   * haze.ts applied, so clamping the *scaled* shade to that same bound is what
   * keeps a gain from removing light that was never added. Cheaper and tighter
   * than clamping to 1.0: it is the actual airlight at this pixel's range
   * rather than the airlight at infinity. */
  float sub = min( shadeSharp * uSunShare + shadeSoft, 1.0 - trans );

  vec3 outc = - sky * ( sub * ( 1.0 - skyPix ) )
            + uAir * cones * uConeGain;

  /* Diagnostic channel. With uDebug at 1 the pass writes its own integrals
   * instead of its output, so a tool can read shadeSharp, shadeSoft and the
   * available airlight as three numbers rather than inferring them from a
   * luma. It is a uniform mix rather than a define so that the program is
   * identical either way and nothing can be attributed to a recompile. */
  outc = mix( outc, vec3( shadeSharp, shadeSoft, 1.0 - trans ), uDebug );

  /* .a carries the depth this texel marched to, so the depth-aware upsample in
   * the final pass can reject texels that belong to a different surface rather
   * than bleeding a shaft across a silhouette. */
  gl_FragColor = vec4( outc, vz );
}
`;
}

/* ── the pass ────────────────────────────────────────────────────────────── */

export class Volumetric {
  private blit: Blit | null = null;
  target: THREE.WebGLRenderTarget;
  /** Set false by `?post=novol` / `?haze=nowedge`; the final pass then skips it. */
  enabled = true;
  /** Populated each frame so the report can quote what it actually marched. */
  lastConeCount = 0;
  lastShadow = false;
  lastAir: [number, number, number] = [0, 0, 0];

  /** The subtractive sun gain, exposed so it can be swept from a tool. */
  get gain(): number { return (this.blit?.uniforms.uSunShare.value as number) ?? SUN_SHARE; }
  set gain(v: number) { if (this.blit) this.blit.uniforms.uSunShare.value = v; }

  /** 1 makes the pass write (shadeSharp, shadeSoft, 1 - trans) instead of colour. */
  set debug(v: number) { if (this.blit) this.blit.uniforms.uDebug.value = v; }

  constructor(w: number, h: number) {
    this.target = makeColourTarget(w >> 1, h >> 1, 'volume');
  }

  setSize(w: number, h: number) {
    this.target.setSize(Math.max(1, w >> 1), Math.max(1, h >> 1));
  }

  private build(sunDir: THREE.Vector3) {
    const u: Record<string, THREE.IUniform> = {
      ...rayUniforms(),
      uDepth: { value: null },
      uShadow: { value: null },
      uShadowMat: { value: new THREE.Matrix4() },
      uShadowTexel: { value: new THREE.Vector2(1 / 2048, 1 / 2048) },
      uShadowOn: { value: 0 },
      uAir: { value: new THREE.Vector3(0.03, 0.038, 0.048) },
      uSunDir: { value: new THREE.Vector3() },
      uSigma: { value: 0.0072 },
      uKHeight: { value: 0.05556 },
      uSunShare: { value: SUN_SHARE },
      uDebug: { value: 0 },
      uConeGain: { value: CONE_GAIN },
      uFrame: { value: 0 },
      uConeCount: { value: 0 },
      uConePos: { value: Array.from({ length: MAX_CONES }, () => new THREE.Vector4()) },
      uConeDir: { value: Array.from({ length: MAX_CONES }, () => new THREE.Vector4()) },
      uConeCol: { value: Array.from({ length: MAX_CONES }, () => new THREE.Vector4()) },
    };
    this.blit = new Blit(marchFragment(sunDir), u);
  }

  /** Nearest-first, capped, so a long street does not cost more than a short one. */
  private uploadCones(camPos: THREE.Vector3, u: Record<string, THREE.IUniform>) {
    const near = lampFixtures()
      .filter((f) => f.intensity > 0)
      .map((f) => ({
        f,
        d: (f.position[0] - camPos.x) ** 2 + (f.position[1] - camPos.y) ** 2
          + (f.position[2] - camPos.z) ** 2,
      }))
      .sort((a, b) => a.d - b.d)
      .slice(0, MAX_CONES);

    const P = u.uConePos.value as THREE.Vector4[];
    const D = u.uConeDir.value as THREE.Vector4[];
    const C = u.uConeCol.value as THREE.Vector4[];
    for (let i = 0; i < near.length; i++) {
      const f = near[i].f;
      /* `intensity` is already the run-up-corrected nadir candela and `colour`
       * is already the run-up chromaticity, so the staggered warm-up arrives
       * in the air for free: the lantern at z = -25 is 28 per cent through its
       * strike and its cone comes out dull red-pink at half the level of the
       * one at -45, without this file knowing that sodium exists. */
      P[i].set(f.position[0], f.position[1], f.position[2], f.intensity);
      D[i].set(f.direction[0], f.direction[1], f.direction[2], 0);
      C[i].set(f.colour[0], f.colour[1], f.colour[2], 0);
    }
    u.uConeCount.value = near.length;
    this.lastConeCount = near.length;
  }

  render(gl: THREE.WebGLRenderer, scene: THREE.Scene, cam: THREE.PerspectiveCamera,
         depth: THREE.Texture, frame: number) {
    const sun = findSun(scene);
    if (!sun) { this.enabled = false; return; }
    if (!this.blit) this.build(sun.dir);
    const u = this.blit!.uniforms;

    setRayUniforms(u, cam);
    u.uRevDepth.value = (gl as unknown as { reversedDepthBuffer?: boolean }).reversedDepthBuffer ? 1 : 0;
    u.uDepth.value = depth;
    u.uFrame.value = frame % 1024;

    (u.uSunDir.value as THREE.Vector3).copy(sun.dir);

    /* The medium's albedo, for the lamp cones only, and re-derived every frame
     * from two quantities that are both allowed to change under this file.
     *
     * The sun's own shafts need no absolute — they are a fraction of the sky
     * the ambient haze is already painting — but a lamp is a light this scene
     * has no other model for, so its in-scattering needs a real
     * `L = albedo * E`. The scene's own sky supplies it: the airlight at the
     * horizon on the sun's bearing is by construction this sun scattered by
     * this air at saturation, so dividing it by the sun's irradiance gives
     * what the air does per lux. Blue-weighted, as scattering by small
     * particles should be.
     *
     * Through `sunwardAirlight` rather than env.ts's `HORIZON_SUNWARD`, and
     * the difference is the solar aureole — see the note on that function.
     * Briefly: the exported constant samples the sky 0.7 degrees below the
     * horizon, so how much aureole it catches is a function of the sun's
     * elevation, and reading it here made this albedo halve when the sun rose
     * from 4.2 degrees to 12. An albedo is a property of the dust in the
     * street. It must not move when the sun climbs.
     *
     * The textbook route gives 0.27 here instead, nine times more, and would
     * put lit air nine times brighter than the sky it converges into, which is
     * not possible. Calibrating against the scene's own sky rather than
     * against a handbook is the whole reason the gains below can be sane. */
    const E = sun.irradiance;
    const H = sunwardAirlight([sun.dir.x, sun.dir.y, sun.dir.z]);
    const air = u.uAir.value as THREE.Vector3;
    air.set(H[0] / Math.max(E.r, 1e-4), H[1] / Math.max(E.g, 1e-4), H[2] / Math.max(E.b, 1e-4));
    this.lastAir = [air.x, air.y, air.z];

    const fog = scene.fog as THREE.FogExp2 | null;
    if (fog && (fog as THREE.FogExp2).isFogExp2) u.uSigma.value = fog.density;

    if (sun.map && sun.matrix) {
      u.uShadow.value = sun.map;
      (u.uShadowMat.value as THREE.Matrix4).copy(sun.matrix);
      const ms = sun.mapSize;
      (u.uShadowTexel.value as THREE.Vector2).set(1 / ms.x, 1 / ms.y);
      u.uShadowOn.value = 1;
      this.lastShadow = true;
    } else {
      u.uShadowOn.value = 0;
      this.lastShadow = false;
    }

    this.uploadCones(cam.position, u);

    this.blit!.render(gl, this.target);
  }

  dispose() {
    this.blit?.dispose();
    this.target.dispose();
  }
}

/*
 * The cone term's gain, and this one is not physical. The size of the lie is
 * written down here rather than buried, because it is the only number in this
 * pass that is taste.
 *
 * The physical answer first, from the shipped fixtures. A lantern at 78 cd
 * nadir with its bowl at 6.8 m puts E = 8.7 lux into the air three metres
 * under itself, and a view ray crossing four metres of that at sigma = 0.0072
 * accumulates
 *
 *     0.0072 * 4 * 0.030 * 8.7 * ( phase(0) / phase(1) )  =  0.0024
 *
 * of radiance. Against the shaded carriageway at L = 0.038 that is about one
 * and a half display counts. **A photometrically exact street lamp beam in
 * this air is at the threshold of visibility, and that is the correct answer
 * rather than a bug.** It is also true of the real thing: the visible beam
 * under a lamp in a photograph is humid or dusty air, a long exposure, or
 * both, and at golden hour with 8.42 lux of sun on the road it is none of the
 * three.
 *
 * The user has asked for cones and accepts that this is above physical, so this
 * is a multiplier and it is quoted as one: THIRTY TIMES the single-scattering
 * value. Six was a placeholder chosen before anything had been measured, and
 * measurement said it was not enough — at six the in-scatter came out at 0.007
 * of radiance against a carriageway at 0.5 to 2, which is half a per cent of
 * contrast and is not a cone, it is a rounding error. Thirty puts the brightest
 * air under a fully warmed lantern at six to ten per cent over the surface it
 * hangs above, which is a cone a viewer can point at.
 *
 * The instruction that bounds it from above is that the airborne cone must stay
 * consistent with the pool causing it and never brighter. That still holds and
 * it is the reason this is 30 rather than 100: at this gain the peak cone
 * radiance is roughly a fifth of the surface radiance of the 4.02 lux pool
 * beneath it, so the air reads as lit *by* the lamp rather than as a solid
 * object hanging in front of it.
 *
 * It is applied to the lanterns only, and separately from the sun's gain, which
 * is bounded by a clamp rather than by taste. The two are not
 * interchangeable — the sun term is subtractive and self-limiting, this one is
 * additive and is limited only by this number.
 *
 * Everything else about a lantern's contribution tracks the fixture: level,
 * chromaticity, run-up state, the batwing and the cut-off all come from
 * `lampFixtures()` and none of them are duplicated here. If the lamps are
 * re-levelled this number does not move.
 */
const CONE_GAIN = 30.0;
