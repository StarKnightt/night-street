/* Facade materials.
 *
 * Everything here is evaluated per fragment in facade coordinates — u along
 * the wall, y in world height — and nothing is sampled from a baked tile. That
 * is a deliberate departure from the paving, which uses bake.ts, and there are
 * two reasons for it.
 *
 * The first is the lesson the road learned the hard way: a baked map has a
 * fixed texel density and mip filtering destroys its detail long before the
 * near field. A brick is 215 mm long and the camera passes within two metres
 * of several thousand of them.
 *
 * The second is that a wall is *big*. A 2 m tile across a 15 m facade repeats
 * seven times vertically and sixty times along the block, and no amount of
 * dual-scale blending hides a brick bond repeating at a fixed pitch — the bond
 * itself is a lattice, so any repeat in it beats against the real one and
 * produces exactly the plaid this project has already been caught by once.
 * Hashing the brick index has no period at all.
 *
 * The cost of going analytic is aliasing, and it is paid the same way the road
 * pays it: every edge is antialiased against the pixel footprint from fwidth,
 * so a joint that is narrower than a pixel converges to its own coverage
 * fraction instead of flickering, and the whole brick modulation fades out
 * once a course is no longer resolvable.
 */
import * as THREE from 'three';
import { NOISE, CANYON } from '@/world/glsl';
import { SUN_DIR } from './env';
import { BUILD_LINE } from '@/world/block';
import {
  ARTIFICIAL, artificialAdd, artificialUniforms, SYS5_TIME, forDisplay,
} from './lights';

/* ── Shared plumbing ────────────────────────────────────────────────────── */

/* Exported so System 3's street-level materials share them rather than copy
 * them. CANYON already carries the note about what two byte-identical copies
 * of a shared shader fragment cost: the next person to tune one produces a
 * visible seam along every junction between the two surfaces, and a shopfront
 * meets the wall it is set into along its entire perimeter. */
export const FACADE_VARYINGS = /* glsl */ `
varying vec3 vWPos;
varying vec3 vWN;
varying vec3 vWT;
varying vec3 vWB;
`;

/* The tangent frame is derived rather than supplied.
 *
 * Every facade surface is planar and axis-aligned in its own frame, so a
 * tangent attribute would be three floats a vertex spent restating what the
 * normal already implies. Picking the reference axis by which way the face
 * points keeps it stable on horizontal surfaces — copings, sills and roof
 * decks — where cross(N, up) collapses to zero and an undefined tangent turns
 * every analytic normal into a NaN. */
export const FACADE_VERTEX = /* glsl */ `
#include <begin_vertex>
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWN = normalize(mat3(modelMatrix) * objectNormal);
vec3 refAxis = abs(vWN.y) > 0.7 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
vWT = normalize(cross(vWN, refAxis));
vWB = cross(vWT, vWN);
`;

/* Skylight gain, applied by hand.
 *
 * `material.envMapIntensity` is inert in this scene and it took a bisection to
 * find that out: with the image-based light arriving from `scene.environment`
 * rather than from a per-material `envMap`, three takes the strength from
 * `scene.environmentIntensity` alone. Setting a material's own value to eight
 * or to zero changes the frame by not one count. Every envMapIntensity in the
 * project is therefore decorative, System 1's included.
 *
 * That matters here more than anywhere else, because at this hour the whole
 * shaded side of the street is lit by the sky and by nothing else, and the one
 * scene-wide dial is already set where the road needs it. So the gain is
 * applied to indirect diffuse in the fragment shader, per material.
 *
 * Above unity is also physically defensible. Two walls eleven metres apart
 * bounce a great deal of light into each other, and a single environment probe
 * baked from an empty sky cannot know that. What it produces without help is a
 * canyon whose shaded side is black — which is the one thing golden hour never
 * looks like.
 */

/* The canyon, which the probe does not know about, and which is the whole of
 * the cool-shade problem.
 *
 * `scene.environment` is one unoccluded probe. Every surface in the scene is
 * lit by the entire dome, including the part of it that is behind the building
 * standing eleven metres opposite. That is not a small error at this hour and
 * it is not a neutral one, because the dome is wildly non-uniform: the horizon
 * around the sun's azimuth is eleven times the brightness of the horizon
 * opposite, and a wall in a street can see almost none of it.
 *
 * Integrating the real thing settles it. tools/skyprobe.mjs cosine-integrates
 * the same sky function twice — once over the full hemisphere, once with the
 * opposite parapet blocking everything below the line to it — and the two
 * disagree by a factor of eleven in level and by a factor of three in hue:
 *
 *   wall, unoccluded          E = 0.650 0.554 1.065   B/R 1.64
 *   wall in canyon, y = 1.5   E = 0.033 0.049 0.188   B/R 5.69
 *   wall in canyon, y = 8     E = 0.080 0.107 0.387   B/R 4.81
 *   wall in canyon, y = 20    E = 0.419 0.393 0.873   B/R 2.08
 *
 * Divide the second by the first and normalise out the level, and the residual
 * is a pure chromatic shift of (0.585, 1.020, 2.028) at the base of the wall
 * relaxing to white by about twenty-five metres up. That is the number below.
 * It is a measurement, not a grade: a wall low in a street sees a slot of
 * zenith and nothing else, and the zenith is blue-violet.
 *
 * The level is *not* applied in full. Physically the base of the wall should
 * lose 91 per cent of its fill, and a photograph does not show that because
 * the camera is exposing for the shade and its tone curve lifts the bottom
 * two stops hard. Applying a little over half of it, against a raised gain,
 * lands the wall where a phone would put it while keeping the vertical
 * gradient — dark and cold at the pavement, warmer and brighter at the
 * parapet — which is the single most recognisable thing about a street canyon
 * at this hour and was entirely missing before.
 */
export const skyLift = (gain: number) => /* glsl */ `
#include <lights_fragment_end>
reflectedLight.indirectDiffuse =
  canyonSky(reflectedLight.indirectDiffuse, vWN, vWPos.y) * ${gain.toFixed(2)};
`;

/* Masonry gets the same gain, plus two terms a single sky probe cannot know.
 *
 * gAO is the occlusion computed in the body — wall bases, window reveals, the
 * soffits of projections. It multiplies the indirect term only, because that
 * is what an inside corner actually loses: sky. Direct sun is unaffected, which
 * is correct and is also what keeps a sunlit reveal from going muddy.
 *
 * The bounce term is the interreflection across the canyon, and at this hour
 * it is not a refinement. The frontage on the -X side is in full sun over its
 * upper storeys and it is throwing that light straight at the frontage
 * opposite, eleven metres away — a diffuse source subtending a large part of
 * that wall's hemisphere. The environment probe is an empty sky and has no
 * idea it is there, so without this the shaded frontage is lit by cold zenith
 * light alone and crushes to a flat blue-black with no material left in it,
 * which is exactly what the critique found. Adding it back is the difference
 * between a shaded wall and a dead one.
 *
 * Scaled by height because the wall opposite is only lit above its own shade
 * line, and tinted warm because the light has bounced off sunlit brick.
 */
const MASONRY_END = /* glsl */ `
#include <lights_fragment_end>
reflectedLight.directDiffuse *= gSun;
reflectedLight.directSpecular *= gSun;
reflectedLight.indirectSpecular *= gSpecCut;
reflectedLight.directSpecular *= gSpecCut;
reflectedLight.indirectDiffuse =
  canyonSky(reflectedLight.indirectDiffuse, vWN, vWPos.y) * 3.40 * gAO;
float faceAcross = max(-vWN.x, 0.0);
float bounceH = 0.10 + 0.90 * smoothstep(1.5, 12.0, vWPos.y);
reflectedLight.indirectDiffuse +=
  vec3(0.190, 0.104, 0.043) * faceAcross * bounceH * gAO * diffuseColor.rgb;
/* System 5. The masonry receives it for one source in particular: the
 * pharmacy cross stands 600 mm off this wall and is the only thing in the
 * scene mounted a hand's width from what it lights. Everything else in the
 * array is far enough away to be culled on most of this surface. */
${artificialAdd('vWN')}
`;

/** Perturb the shading normal by an analytic height gradient, in metres. */
export const FACADE_NORMAL = /* glsl */ `
normal = normalize(vWN - vWT * gSlope.x - vWB * gSlope.y);
`;

/* ── Masonry ────────────────────────────────────────────────────────────── */

const MASONRY_PARS = /* glsl */ `
${FACADE_VARYINGS}
varying vec2 vFuv;
varying vec4 vGrid;   // bay width, storey height, first bay origin, first floor level
varying vec4 vWinP;   // window width, sill height above floor, wall u0, wall u1
varying vec4 vBldgP;  // seed, palette, footway level, wall top
varying float vRoleF;
uniform vec3 uSun;
vec2 gSlope = vec2(0.0);
float gAO = 1.0;
/** Scales the image-based specular. Cut on horizontal cast stone; see below. */
float gSpecCut = 1.0;
/* Direct-light occlusion at a scale the shadow map cannot reach.
 *
 * A shadow map texel on this scene covers six millimetres of wall at best, and
 * the relief that decides whether masonry reads as masonry is finer than that:
 * a joint is ten millimetres deep and five wide. So the sub-texel shadowing is
 * stated analytically and multiplied into the direct term. */
float gSun = 1.0;

/* How far the shadow of an arris reaches into the recess behind it, per metre
 * of depth, expressed in the facade's own u/y axes.
 *
 * This is the number that makes a low sun look like a low sun on a wall. At
 * 4.2 degrees elevation and 35 degrees off the street axis, the beam strikes a
 * street elevation at about 55 degrees from its normal but almost entirely
 * *sideways*: it travels 1.4 m along the wall for every metre it goes into it,
 * and only 0.13 m upward. So vertical joints, jambs and reveals throw long
 * hard shadows across the face while horizontal ones throw almost none — which
 * is exactly backwards from the midday case everyone's intuition is trained
 * on, and is why the perpends have to be nearly black while the bed joints
 * stay open. */
vec2 sunReach(){
  float ln = max(dot(uSun, vWN), 0.03);
  return vec2(dot(uSun, vWT), dot(uSun, vWB)) / ln;
}

/* Antialiased step against the pixel footprint.
 *
 * Every edge in this file goes through here. A mortar joint is 10 mm and at
 * twenty metres it is a twentieth of a pixel, so a fixed-width smoothstep
 * either shimmers or vanishes; widening the transition to the pixel size makes
 * the result converge to the fraction of the pixel the joint covers, which is
 * what a correctly filtered texture would have given. */
float aaStep(float edge, float x, float px){
  float e = max(px * 0.7, 1e-4);
  return smoothstep(edge - e, edge + e, x);
}

/* Derivative of smoothstep, for turning an antialiased profile into a normal
 * without sampling the height field four more times. */
float dstep(float a, float b, float x){
  float t = clamp((x - a) / max(b - a, 1e-5), 0.0, 1.0);
  return 6.0 * t * (1.0 - t) / max(b - a, 1e-5);
}

/* ---- brick -------------------------------------------------------------
 *
 * Stretcher bond at real dimensions: a 215 x 65 mm brick on a 10 mm bed, so
 * the course is 75 mm and the horizontal module 225 mm, with every other
 * course offset by half a brick. Three things then have to happen or it reads
 * as graph paper:
 *
 *   Every brick is its own colour. A run of bricks from one kiln varies by a
 *   long way — reds, purples, the odd almost-black overburnt header, the odd
 *   pale underburnt one — and it is that scatter, not the bond, that says
 *   brick from thirty metres.
 *
 *   The bond is not ruled. It was laid by hand to a line, so courses wander by
 *   a millimetre or two and perpends drift, and the joint width varies along
 *   its run.
 *
 *   The joints are recessed, and the recess is where the light is. At four
 *   degrees a 6 mm raked joint puts a hard shadow along the top of every brick
 *   and a lit line along the bottom, which is most of the relief the eye reads
 *   on a brick wall.
 */
void brick(vec2 uv, float seed, float px, out vec3 col, out float rgh){
  const float CH = 0.0755;      // course: brick plus bed joint
  const float BL = 0.2285;      // brick plus perpend

  float row = floor(uv.y / CH);
  float rowJ = (hash21(vec2(row * 0.731, seed * 37.0)) - 0.5) * 0.0035;
  float off  = mod(row, 2.0) * 0.5 + (hash21(vec2(row * 1.13, 7.7)) - 0.5) * 0.06;
  float cu   = uv.x / BL + off;
  float ci   = floor(cu);
  vec2  id   = vec2(ci, row);

  float fu = fract(cu);
  float fv = fract((uv.y + rowJ) / CH);
  float du = min(fu, 1.0 - fu) * BL;
  float dv = min(fv, 1.0 - fv) * CH;

  // Joint width varies brick to brick — a bricklayer works to a line, not a
  // gauge, and the perpends are the ones that give it away.
  float jw = 0.0052 + hash21(id + 3.3) * 0.0026;
  float jh = 0.0048 + hash21(id + 8.1) * 0.0018;
  float mu = 1.0 - aaStep(jw, du, px);
  float mv = 1.0 - aaStep(jh, dv, px);
  float mortar = max(mu, mv);

  float g1 = hash21(id + 0.17), g2 = hash21(id + 11.9), g3 = hash21(id + 41.3);

  /* Palette per building, from a family of real stocks: a warm red, a browner
   * multi, a purple-grey and a yellow-buff. Linear reflectance, and much
   * darker than a colour picker suggests — a red facing brick measures about
   * 0.11 and sunlight at this hour is doing the rest. */
  vec3 pA = mix(vec3(0.1180, 0.0508, 0.0362), vec3(0.0940, 0.0530, 0.0400), fract(seed * 5.3));
  vec3 pB = mix(vec3(0.1420, 0.0930, 0.0640), vec3(0.0680, 0.0430, 0.0430), fract(seed * 9.7));
  vec3 body = mix(pA, pB, g1);
  /* The scatter, and it needs to be wider than looks reasonable written down.
   * A stock brick wall photographed at this hour has a two-stop spread from
   * the palest brick to the darkest, and the first pass at half this range
   * produced a wall that read as brick-effect wallpaper: the bond was right,
   * the colour was right, and every brick was the same value as its
   * neighbour. The scatter is the texture. */
  body *= 0.40 + 1.35 * g2 * g2;
  // Banding: bricks came off the kiln cart in batches and a wall is laid up
  // out of them a few courses at a time, so the scatter is not white noise.
  body *= 0.80 + 0.40 * hash21(vec2(floor(row / (2.0 + floor(g1 * 5.0))), seed * 3.1));
  body = mix(body, body * vec3(0.42, 0.46, 0.58), step(0.915, g3));       // overburnt
  body = mix(body, body * vec3(1.85, 1.72, 1.50), step(0.972, fract(g3 * 7.1)));

  /* Sand face and frogging, and the eroded arris every soft brick gets. Faded
   * out by pixel footprint, because at ten metres this is below the sampler
   * and all it can do is sparkle. */
  float fine = 1.0 - smoothstep(0.35, 1.3, px / 0.006);
  if (fine > 0.004){
    float grain = unit(wfbm(uv * 320.0 + id * 13.0, 2));
    body *= 1.0 + (grain - 0.5) * 0.30 * fine;
    /* Sand face and eroded arris, as relief rather than as tone. Close to, a
     * soft stock brick is not a flat rectangle: the face is pitted, the
     * corners are knocked off and the whole thing catches a raking light
     * unevenly across its own 215 mm. Without this the near field was a
     * correctly-coloured wall of flat tiles. */
    gSlope += (vec2(grain, unit(wfbm(uv * 320.0 + id * 13.0 + 51.0, 2))) - 0.5)
            * 0.13 * fine;
    float arris = (1.0 - smoothstep(0.0, 0.016, du)) + (1.0 - smoothstep(0.0, 0.011, dv));
    gSlope += vec2(sign(0.5 - fu) * (1.0 - smoothstep(0.0, 0.016, du)),
                   sign(0.5 - fv) * (1.0 - smoothstep(0.0, 0.011, dv)))
            * 0.10 * fine * hash21(id + 91.7);
    body *= 1.0 - min(arris, 1.0) * 0.10 * fine;
  }
  // Frost-spalled faces: the outer skin has flaked off and the paler, rougher
  // body of the brick is showing. Whole bricks at a time, in clusters.
  float spall = step(0.86, hash21(id + 63.7)) *
                smoothstep(0.42, 0.78, unit(wfbm(uv * 0.55, 3)));
  body = mix(body, body * vec3(1.45, 1.30, 1.12), spall * 0.7);

  /* Mortar. Not white — a lime mortar weathers to a dirty buff and the joints
   * in a city wall are darker than the bricks as often as they are lighter,
   * because they are recessed and hold the soot. Some are raked out to
   * nothing, which is where the pointing has failed. */
  float lost = smoothstep(0.55, 0.88, unit(wfbm(uv * 1.9, 3)));
  vec3 mortC = vec3(0.1620, 0.1510, 0.1330) * (0.72 + 0.5 * hash21(id + 21.1));
  mortC = mix(mortC, vec3(0.0300, 0.0286, 0.0270), lost * 0.85);

  col = mix(body, mortC, mortar);
  rgh = mix(0.90 + 0.06 * g1, 0.965, mortar);
  rgh = mix(rgh, 0.985, spall * 0.8);

  /* Cavity occlusion, and on the shaded side of the street it is the only
   * thing that makes the bond visible at all.
   *
   * A wall lit only by sky reads its relief through occlusion, not through
   * shading: the normal perturbation of a raked joint changes the direction it
   * samples the sky in by a couple of degrees and a sky gradient returns
   * almost the same value, so a brick wall in shade came out as flat coloured
   * noise. What a 10 mm groove actually does is halve the amount of sky its
   * floor can see. That is a multiplier on the indirect term and nothing else,
   * and it is what puts the bond back into the shaded frontage. */
  gAO *= mix(1.0, 0.48, mortar);

  /* Relief. The joint is a groove and the derivative of its own profile is the
   * gradient, which costs one extra smoothstep derivative rather than four
   * more evaluations of the whole bond. Each brick also gets a constant tilt,
   * which is what makes a wall twinkle unevenly under a raking sun instead of
   * lighting as one plane. */
  /* Joint recess, and it is deeper than the drawing says on purpose.
   *
   * A weather-struck joint is flush at the top and 4-6 mm back at the bottom;
   * a raked one on a hundred-year-old wall where the pointing has gone is 10
   * to 20. The first pass used 6 mm flat and at two metres the critique read
   * the mortar as depthless — which it was, because 6 mm of normal
   * perturbation on a wall lit by a sun four degrees above the horizon moves
   * the shading by almost nothing on the *bed* joints, the ones that run
   * across the light. Taking it to 11 mm, and further where the pointing has
   * failed, is both closer to the truth and the only thing that makes the bond
   * self-shadow at arm's length. */
  float depth = 0.0110 + lost * 0.009;
  float e = max(px * 0.7, 3e-4);
  float su = dstep(jw - e, jw + e, du) * depth * sign(0.5 - fu);
  float sv = dstep(jh - e, jh + e, dv) * depth * sign(0.5 - fv);
  float vis = 1.0 - smoothstep(0.4, 1.25, px / CH);
  gSlope += vec2(-su, -sv) * vis;
  gSlope += (vec2(hash21(id + 5.5), hash21(id + 77.3)) - 0.5) * 0.055 * vis * (1.0 - mortar);

  /* And the joint casts. This is the part that was missing, and it is the
   * whole difference between a bond that is drawn and a bond that is built.
   *
   * Normal perturbation alone cannot produce the dark line under an arris: it
   * tilts the surface by a few degrees, the cosine term moves by a few per
   * cent, and the result is the "mortar joints are drawn lines with no recess
   * and no self-shadow" the review reported at two metres. What actually
   * happens is occlusion — the brick beside the joint stands between the joint
   * and the sun — and at this elevation the reach is 1.4 times the depth, so
   * an 11 mm joint is shadowed across 15 mm, which is wider than the joint
   * itself. Every perpend on a sunlit wall goes to near black and the bricks
   * between them come forward. */
  vec2 reach = sunReach() * depth;
  float shd = mu * clamp(abs(reach.x) / max(2.0 * jw, 1e-4), 0.0, 1.0)
            + mv * clamp(abs(reach.y) / max(2.0 * jh, 1e-4), 0.0, 1.0);
  /* A brick sitting a couple of millimetres proud of its neighbour throws its
   * own edge across the one beside it — the reason a hand-laid wall breaks up
   * under raking light instead of shading as one plane. */
  float proud = (hash21(id + 133.1) - 0.45) * 0.0032;
  shd += (1.0 - mortar) * max(0.0, proud) * abs(reach.x) * 90.0
       * (1.0 - aaStep(jw + abs(reach.x) * 0.6, du, px));
  gSun *= 1.0 - min(shd, 1.0) * 0.90 * vis;
}

/* ---- painted render ---------------------------------------------------- */
void renderCoat(vec2 uv, float seed, float px, out vec3 col, out float rgh){
  /* Paint colours off a real street: two creams, a sage, a dusty pink, a
   * blue-grey. Repainted at some point in the last thirty years and faded
   * unevenly ever since. */
  /* Cut by roughly a quarter. These are the values a paint chart gives and
   * they are right for the day the scaffold came down; twenty years of city
   * air later a cream render measures nearer 0.22 than 0.34, and at this hour
   * the difference is the difference between a wall and a white shape. */
  float pick = fract(seed * 13.7);
  vec3 c =
      pick < 0.30 ? vec3(0.2550, 0.2310, 0.1920)
    : pick < 0.52 ? vec3(0.2010, 0.2040, 0.1785)
    : pick < 0.72 ? vec3(0.2175, 0.1540, 0.1365)
    : pick < 0.88 ? vec3(0.1560, 0.1700, 0.1890)
                  : vec3(0.2660, 0.2475, 0.2175);

  // Fading, at two scales. Paint goes patchy long before it peels.
  float fade = unit(wfbm(uv * 0.34 + seed * 21.0, 4));
  c *= 0.74 + 0.44 * fade;
  c *= 0.93 + 0.14 * unit(wfbm(uv * 1.7, 3));

  /* Rain streaking, and on render it has to be much stronger than on brick.
   *
   * Brick hides its dirt in a bond pattern; a painted wall has nothing to hide
   * it in, so all of it shows, and a light-coloured render that has stood on a
   * city street for twenty years is *striped* — long vertical runs of grey
   * from every ledge, sill and crack, dark at the top where they start and
   * fading out below. Without them the wall came out looking like painted card
   * at any distance, which is the one thing this material is likely to be
   * caught on. The two frequencies are decorrelated so the fine runs sit
   * inside the broad ones instead of beating against them. */
  float run  = unit(wfbm(vec2(uv.x * 15.0, uv.y * 0.30), 4));
  float run2 = unit(wfbm(vec2(uv.x * 3.7, uv.y * 0.11) + 12.0, 3));
  c *= 1.0 - 0.34 * smoothstep(0.46, 0.96, run) * (0.35 + 0.65 * run2);
  c = mix(c, c * vec3(0.86, 0.88, 0.94), smoothstep(0.5, 0.9, run2) * 0.5);

  // The float finish under the paint: a fine sand texture that survives every
  // repaint and is the only thing stopping render reading as painted card.
  /* Two scales of relief, because render has two.
   *
   * The float finish is a fine sand texture at half a millimetre, and it is
   * what stops the coat reading as painted card. But a hand-floated wall also
   * carries the *trowel* — sweeping arcs a hand's breadth across where the
   * plasterer worked the surface, standing a millimetre or two proud of each
   * other, plus the ripple where one day's work met the next. At two metres
   * that is the difference between a wall and a plane, and the last pass had
   * only the fine scale, which is exactly what "a smooth painted plane" means.
   */
  float trowel = unit(wfbm(vec2(uv.x * 5.5 + uv.y * 1.3, uv.y * 2.6), 3));
  float trow2 = unit(wfbm(vec2(uv.x * 1.2, uv.y * 9.5) + 44.0, 2));
  gSlope += vec2(trowel - 0.5, (trow2 - 0.5) * 0.7) * 0.085;
  c *= 0.95 + 0.10 * trowel;
  float fine = 1.0 - smoothstep(0.35, 1.3, px / 0.004);
  if (fine > 0.004){
    float g = unit(wfbm(uv * 520.0, 2));
    // Aggregate: a rendered coat is sand and cement, and the sand shows.
    float agg = unit(wfbm(uv * 155.0 + 7.0, 2));
    c *= 1.0 + (g - 0.5) * 0.20 * fine + (agg - 0.5) * 0.16 * fine;
    gSlope += (vec2(g, unit(wfbm(uv * 520.0 + 31.0, 2))) - 0.5) * 0.10 * fine;
    gSlope += (vec2(agg, unit(wfbm(uv * 155.0 + 63.0, 2))) - 0.5) * 0.12 * fine;
    /* And the grains occlude. This is the term that was missing and it is why
     * the near-field render kept coming back as "a matte plane with decals":
     * on a wall lit by the sky, a tilted normal returns almost exactly the
     * same radiance as an untilted one, so all that relief was invisible
     * wherever the sun was not on the wall — which on the shaded frontage is
     * everywhere. What a sanded surface actually does is shade itself between
     * the grains. */
    gAO *= 1.0 - (0.16 * (1.0 - agg) + 0.10 * (1.0 - g)) * fine;
    /* Under a raking sun the same grains throw. 0.4 mm of relief at 1.4 times
     * reach is half a millimetre of shadow beside every one of them, which is
     * what makes a rendered wall sparkle along the light and go flat across
     * it. */
    float lpx = clamp(abs(sunReach().x) * 0.5, 0.0, 1.2);
    gSun *= 1.0 - smoothstep(0.62, 0.98, 1.0 - agg) * 0.35 * fine * lpx;
  }
  // The trowel arcs occlude at their own scale, and this one survives to any
  // distance because it is a hand's breadth across rather than a grain.
  gAO *= 0.80 + 0.26 * trowel;

  /* Blown render: where damp has got behind it the coat comes off in plates,
   * and what is underneath is the brick. Reusing the brick function for the
   * exposed patches costs one more evaluation on a small fraction of the wall
   * and is worth every cycle — a repair like this is the most characteristic
   * thing on a rendered building and impossible to fake with noise. */
  /* Two lattices at unrelated scales and unrelated rotations.
   *
   * With one lattice every plate came out the same size and the same shape,
   * because a cellular pattern sampled at a single frequency has exactly one
   * characteristic cell — so the elevation read as one blob stamped eight times,
   * which is precisely what the review counted. Overlaying a second lattice at
   * 0.43 of the frequency and turned 37 degrees gives plates in two size classes
   * that overlap into a third, and no two alike in the same elevation. */
  float ca = cos(0.65), sa = sin(0.65);
  vec2 uvB = vec2(uv.x * ca - uv.y * sa, uv.x * sa + uv.y * ca);
  vec3 ec = wedge(uv * 3.4 + seed * 9.0, 0.85);
  vec3 ecB = wedge(uvB * 1.46 + seed * 4.1 + 23.0, 0.80);

  /* Rare, small, and *located*.
   *
   * Render fails where water gets behind it, and water gets behind it at the
   * bottom of the wall where it splashes up off the pavement, and around
   * openings where the reveal has cracked. It does not fail evenly over an
   * elevation, and scattering it evenly is half of why the patches read as
   * decals: a decal has no reason to be where it is. */
  float lowDamp = 1.0 - smoothstep(0.4, 3.2, uv.y - vBldgP.z);
  float where = smoothstep(0.56, 0.86, unit(wfbm(uv * 0.40 + 5.0, 3)))
              * (0.34 + 0.90 * lowDamp);
  float blown = max(step(0.855, ec.z), step(0.880, ecB.z) * 0.92) * where;
  float edge = blown * (1.0 - smoothstep(0.0, 0.055, ec.y - ec.x));
  if (blown > 0.004){
    vec3 bc; float br;
    brick(uv, seed + 0.31, px, bc, br);
    col = mix(c, mix(bc * 1.6, c * 0.55, 0.35), blown);
    rgh = mix(0.68, 0.95, blown);
  } else {
    col = c;
    rgh = 0.68;
  }
  // The lip of the plate, which is where the light catches.
  col = mix(col, col * 1.5, edge * 0.5);
  /* And the plate is 8 mm thick, so it has a step round it that occludes and,
   * under a raking sun, throws. Without these the failed render read as a
   * decal printed on a smooth wall — which is exactly what the review said. */
  gAO *= 1.0 - blown * 0.26 - edge * 0.20;
  gSun *= 1.0 - blown * clamp(abs(sunReach().x) * 0.06, 0.0, 0.55);
  gSlope += vec2(0.0, edge * 0.05);

  /* Hairline cracking, and it is not random: render cracks in a map network
   * over the field and in diagonals out of the corners of every opening,
   * because that is where the stress concentrates. */
  vec3 net = wedge(uv * 3.1 + 17.0, 0.75);
  float crack = (1.0 - smoothstep(0.0, max(px * 1.2, 0.004), net.y - net.x)) *
                smoothstep(0.55, 0.85, unit(wfbm(uv * 0.7, 3)));
  col = mix(col, col * 0.34, crack * 0.7);
  rgh = mix(rgh, 0.95, crack * 0.6);
  // Same argument as the brick joints: in shade the only thing that shows
  // relief is lost sky, so the cracks and the failed plates occlude.
  gAO *= mix(1.0, 0.55, crack) * mix(1.0, 0.72, blown) * (0.94 + 0.10 * trowel);
}

/* ---- ashlar stone ------------------------------------------------------ */
void ashlar(vec2 uv, float seed, float px, out vec3 col, out float rgh){
  const float CH = 0.415;
  float row = floor(uv.y / CH);
  float off = fract(hash21(vec2(row, seed * 3.0)) * 3.7);
  float bw = 1.05 + hash21(vec2(row, 9.1)) * 0.5;
  float cu = uv.x / bw + off;
  vec2 id = vec2(floor(cu), row);
  float du = min(fract(cu), 1.0 - fract(cu)) * bw;
  float fv = fract(uv.y / CH);
  float dv = min(fv, 1.0 - fv) * CH;

  float j = 0.0035;
  float mortar = max(1.0 - aaStep(j, du, px), 1.0 - aaStep(j, dv, px));

  /* Values cut by a third from the first pass, and per-block scatter widened.
   *
   * A sunlit vertical wall at this hour receives roughly 65 lux-equivalents to
   * the carriageway's 8, so a 0.28 albedo ashlar renders at five times display
   * white and clips to a flat cream sheet with no material in it — which is
   * what the sunlit frontages were doing. Clean Portland is that bright; a
   * city elevation that has stood a century in coal smoke is 0.14 to 0.19, and
   * dropping to it buys back the whole top of the tone curve. */
  float g = hash21(id + 2.7);
  vec3 base = mix(vec3(0.1360, 0.1290, 0.1130), vec3(0.1940, 0.1845, 0.1615), g);
  base *= 0.80 + 0.42 * hash21(id + 17.3);
  // Bedding planes and shell fragments: limestone is never one tone across a
  // block, and the variation runs with the bed, not across it.
  base *= 0.88 + 0.26 * unit(wfbm(vec2(uv.x * 2.2, uv.y * 11.0) + id * 7.0, 3));
  /* Soiling, and on stone it is the whole story: rain washes the exposed faces
   * white and leaves the sheltered ones black, so an ashlar elevation is a
   * two-tone map of where the water goes. Without it stone is the one material
   * here that reads as new. */
  float soil = smoothstep(0.40, 0.86, unit(wfbm(vec2(uv.x * 1.1, uv.y * 0.5) + 23.0, 4)));
  base = mix(base, base * vec3(0.40, 0.40, 0.42), soil * 0.75);
  // Tooling: a hand-punched face carries fine parallel chisel marks.
  float tool = 1.0 - smoothstep(0.35, 1.3, px / 0.010);
  if (tool > 0.004){
    float t = unit(wfbm(vec2(uv.x * 3.0, uv.y * 190.0), 2));
    base *= 1.0 + (t - 0.5) * 0.22 * tool;
    gSlope += vec2(0.0, (t - 0.5) * 0.10 * tool);
  }
  col = mix(base, vec3(0.1180, 0.1125, 0.1000), mortar);
  rgh = mix(0.84, 0.93, mortar);
  gAO *= mix(1.0, 0.55, mortar);
  float e = max(px * 0.7, 3e-4);
  gSlope += vec2(
    -dstep(j - e, j + e, du) * 0.004 * sign(0.5 - fract(cu)),
    -dstep(j - e, j + e, dv) * 0.004 * sign(0.5 - fv));
}

/* ---- cast stone: sills, lintels, copings, cornices ---------------------- */
void castStone(vec2 uv, float seed, float px, out vec3 col, out float rgh){
  /* Same correction as the ashlar: a sill or a coping is cast stone, and cast
   * stone on a city street is grey, not cream. It still has to sit well clear
   * of the brick around it — that contrast is the entire reason for putting
   * stone bands on an elevation — but at the old value every sill in the block
   * clipped to white the moment the sun touched it. */
  float m = unit(wfbm(uv * 3.4 + seed * 11.0, 4));
  col = mix(vec3(0.1830, 0.1780, 0.1630), vec3(0.1080, 0.1040, 0.0955), m);
  float fine = 1.0 - smoothstep(0.35, 1.3, px / 0.005);
  if (fine > 0.004){
    float g = unit(wfbm(uv * 380.0, 2));
    col *= 1.0 + (g - 0.5) * 0.22 * fine;
    gSlope += (vec2(g, unit(wfbm(uv * 380.0 + 9.0, 2))) - 0.5) * 0.05 * fine;
  }
  // Spalled arrises and rust-jacked cracks where the reinforcement has gone.
  vec3 cw = wedge(uv * 6.0, 0.7);
  float crack = 1.0 - smoothstep(0.0, max(px * 1.2, 0.004), cw.y - cw.x);
  col = mix(col, col * 0.5, crack * smoothstep(0.6, 0.9, m) * 0.6);
  rgh = 0.88;
}

/* ---- the corrugated shutter that stands in for System 3 ---------------- */
void shutter(vec2 uv, float seed, float px, out vec3 col, out float rgh){
  float bayId = floor(uv.x / 2.9 + seed * 7.0);
  float g = hash21(vec2(bayId, 5.1));
  /* Deliberately among the darkest values in the scene.
   *
   * This is a placeholder for System 3's shopfronts and it has one job: hold
   * the opening as a void so the structure above it reads, and stay out of the
   * way. At the first values it was the brightest thing on the ground floor —
   * a three-metre panel of pale slats under every building, which looked like
   * frosted glass and pulled the eye straight off the brickwork. */
  /* Halved again. At a four-degree sun a vertical surface collects eight times
   * what the carriageway does, and the scene's exposure is set by the road, so
   * anything upright and lit lands in the top of the curve whatever its
   * albedo. These panels are three metres tall and there is one under every
   * bay of the block; at the last value they were reading as large tan planes
   * and taking the eye off everything above them. */
  vec3 paint =
      g < 0.28 ? vec3(0.0086, 0.0099, 0.0094)
    : g < 0.52 ? vec3(0.0132, 0.0116, 0.0100)
    : g < 0.74 ? vec3(0.0078, 0.0095, 0.0128)
                : vec3(0.0145, 0.0089, 0.0075);
  // Roller slats: 78 mm, and the profile is what catches a low sun. Deeper
  // modulation than before — a shutter is a corrugation, and the alternation
  // of lit crown and shaded trough is the only thing that identifies it.
  float ph = uv.y / 0.078;
  float rib = sin(ph * 6.28318);
  float vis = 1.0 - smoothstep(0.4, 1.25, px / 0.078);
  col = paint * (0.72 + 0.50 * unit(wfbm(uv * 2.4, 3))) * (1.0 + rib * 0.42 * vis);
  gAO *= 0.62 - 0.14 * rib * vis;
  // Everything at street level is filthy at the bottom and scuffed to shoulder.
  col *= 0.55 + 0.45 * smoothstep(0.0, 1.3, uv.y - vBldgP.z);
  col *= 0.86 + 0.28 * unit(wfbm(uv * 14.0, 2));
  gSlope += vec2(0.0, cos(ph * 6.28318) * 0.16 * vis);
  rgh = 0.62 + 0.2 * unit(wfbm(uv * 6.0, 2));
}

void boardUp(vec2 uv, float px, out vec3 col, out float rgh){
  float bd = uv.y / 0.31;
  float seam = 1.0 - aaStep(0.010, min(fract(bd), 1.0 - fract(bd)) * 0.31, px);
  float g = hash21(vec2(floor(bd), 3.0));
  col = mix(vec3(0.1050, 0.0850, 0.0620), vec3(0.0640, 0.0530, 0.0420), g);
  col *= 0.85 + 0.3 * unit(wfbm(vec2(uv.x * 22.0, uv.y * 3.0), 3));
  col = mix(col, vec3(0.0180, 0.0160, 0.0140), seam);
  gSlope += vec2(0.0, -seam * 0.05);
  rgh = 0.94;
}
`;

const MASONRY_BODY = /* glsl */ `
{
  vec2 uv = vFuv;
  float px = fwidth(uv.x) + fwidth(uv.y);
  float seed = vBldgP.x;
  float pal = vBldgP.y;
  float role = vRoleF;
  float baseY = vBldgP.z;
  float hh = vWPos.y - baseY;

  vec3 col; float rgh;
  /* The daylight roughness floor, per role. Raised on horizontal cast stone;
   * see the coping note below. */
  float rghFloor = 0.28;
  if (role < 1.5){
    if (pal < 0.5)       brick(uv, seed, px, col, rgh);
    else if (pal < 1.5)  renderCoat(uv, seed, px, col, rgh);
    else                 ashlar(uv, seed, px, col, rgh);
    /* A reveal is not the same material as the wall it is cut into even when
     * it is made of the same brick: it is sheltered from the rain that washes
     * the face, so it holds a century of soot and never gets cleaned. */
    if (role > 0.5){
      /* Darkened, but by less than it was. A reveal wants to be dirty, not
       * black: the whole reason for cutting a 250 mm opening is that one jamb
       * catches the sun and the other goes dark, and multiplying the albedo
       * down far enough that both jambs read the same throws that away. The
       * occlusion below does the darkening that a recess actually has, which
       * is a loss of *sky*, not a loss of albedo. */
      col *= 0.80;
      col = mix(col, col * vec3(0.85, 0.86, 0.92), 0.5);
      rgh = min(1.0, rgh + 0.04);
      gAO *= 0.42;
    }
  } else if (role < 3.5){
    castStone(uv, seed, px, col, rgh);
    /* Copings, sills, lintel tops, cornices and string courses — every cast
     * stone band in the block, because they are all one material and the same
     * defect has now been found on two of them.
     *
     * The coping of the lot wall was rendering as a regular chain of bright
     * dashes along its whole run: peak/mean 5.17 over the measured box, beating
     * at the 7-8 px pitch of the pickets standing on it, which chop the run into
     * dashes. It is the kerb-cap defect again, on a surface nobody had checked.
     *
     * What it is not, and this took a bisection to establish, is specular.
     * Forcing the whole role to a roughness of 1.0 moved the peak by three per
     * cent, and cutting the image-based specular to nothing moved it by none.
     * The chain is diffuse: a narrow band of clean, pale, high-albedo cast stone
     * turned into a low sun, sitting against a wall face that is in shade. It is
     * bright because it is clean, and it is a chain because nothing along its
     * length distinguishes one metre of it from the next.
     *
     * So the remedy is the one the kerb got, translated into the term that is
     * actually carrying it. The roughness goes up and the daylight floor with
     * it, which is right for weathered stone even though it is not what was
     * doing the damage. The run is broken along its length by two slow fields,
     * so that it becomes a sequence of differently dirty stretches instead of
     * one continuous line. And the general level comes down, hardest on the
     * up-faces, because a coping is the dirtiest surface on an elevation — it is
     * horizontal, nothing washes it, and it collects a century of grit and moss.
     * A clean one is the tell.
     *
     * The vertical faces get the same treatment at about half strength. That is
     * deliberate: the fascia of a coping and the nose of a sill are the parts
     * that catch this light, they are the same stone with the same exposure, and
     * halving it keeps the stone bands on the frontages reading as the pale
     * accents they are meant to be.
     */
    float upS = clamp(vWN.y, 0.0, 1.0);
    float runA = unit(wfbm(vec2(uv.x * 0.40, uv.y * 0.40) + 27.0, 3));
    float runB = unit(wfbm(vec2(uv.x * 1.85, uv.y * 1.85) + 5.0, 2));
    {
      float filth = 0.24 + 0.54 * runA + 0.22 * runB;
      /* And a boundary wall gets it far worse than a second-floor sill.
       *
       * A coping at knee height on a street frontage is splashed by every
       * vehicle that passes, sat on, leaned against and never once cleaned; the
       * same stone four storeys up is washed by the rain and only collects what
       * the air puts on it. Keeping the heavy weathering low is what lets this
       * kill the chain on the lot wall without taking the pale stone bands off
       * the elevations, which are doing a job up there. */
      float lowS = smoothstep(1.60, 0.85, hh);
      filth *= mix(1.0, 0.22 + 0.26 * runA, lowS);
      col *= mix(mix(1.0, filth, 0.85), filth, upS);
      // What settles on a ledge is grey-green, not the colour of the stone.
      col = mix(col, col * vec3(0.88, 0.92, 0.86),
                mix(0.35, 1.0, upS) * smoothstep(0.30, 0.75, runB) * 0.45);
      rgh = mix(rgh, 0.97, upS * 0.92);
      rghFloor = mix(rghFloor, 0.58, upS);
      /* The image-based specular goes too. It is not what was carrying the
       * chain, but at grazing incidence the split-sum Fresnel term runs to one
       * whatever the roughness is, so a stone band seen nearly edge-on mirrors
       * the brightest part of a sunset sky straight back at the camera. Porous
       * weathered stone does not do that, and leaving it in place is how the
       * next narrow ledge in this scene acquires the same defect. */
      gSpecCut = (0.075 + 0.26 * runA * runB) * mix(1.0, 0.45, upS);
    }
    if (role > 2.5){
      /* The plinth. Every street building has a dark base course, because the
       * bottom metre takes the road spray and gets painted dark so it does not
       * show. Without it a facade looks like it has been dropped onto the
       * footway rather than built off it. */
      col *= 0.30;
      col = mix(col, vec3(0.0260, 0.0250, 0.0255), 0.55);
      rgh = 0.86;
    }
  } else if (role < 4.5){
    shutter(uv, seed, px, col, rgh);
  } else if (role < 5.5){
    boardUp(uv, px, col, rgh);
  } else if (role < 6.5){
    col = vec3(0.0330, 0.0322, 0.0300) * (0.8 + 0.5 * unit(wfbm(uv * 9.0, 3)));
    rgh = 0.94;
  } else if (role < 7.5){
    // The back of the block. It exists to be opaque to the shadow pass and is
    // never in frame, so it gets the cheapest branch in the file.
    col = vec3(0.0400, 0.0380, 0.0350);
    rgh = 0.95;
  } else if (role < 8.5){
    /* Party walls and flanks.
     *
     * These were a flat filler tone to begin with and they were the worst
     * thing in the frame: wherever the frontage steps back the flank is a
     * five-metre-wide featureless slab standing against the sky, and at this
     * hour it is in shade, so it read as a hole cut out of the picture. A
     * flank is the same wall as the front — it is just the cheap side of it,
     * never pointed, never washed by rain on the sheltered half, and carrying
     * the ghost of the roof that used to abut it. So it gets the building's
     * own masonry and then a century of neglect on top. */
    /* Always brick, whatever the front is faced with. Nobody has ever paid to
     * render a wall that only the next building sees, and the blown-plaster
     * patching that makes the front elevations interesting turns a blank
     * five-metre flank into camouflage. */
    brick(uv, seed + 0.77, px, col, rgh);
    /* The ghost: a pitched line with cleaner, paler wall under it where a
     * lower neighbour protected the brick, and the scar of its flashing. */
    float pitch = vBldgP.w - 3.4 - 2.4 * fract(seed * 8.3);
    float gable = pitch + (0.30 + 0.34 * fract(seed * 2.9)) * uv.x;
    float under = smoothstep(0.10, -0.10, vWPos.y - gable);
    col = mix(col, col * vec3(1.34, 1.28, 1.18), under * 0.55);
    col = mix(col, col * 0.55, (1.0 - smoothstep(0.0, 0.08, abs(vWPos.y - gable))) * 0.8);
    col *= 0.80 + 0.34 * unit(wfbm(uv * 0.42 + 31.0, 4));
    rgh = min(1.0, rgh + 0.03);
  } else {
    /* The backdrop town.
     *
     * Everything here is chosen to survive sixty to a hundred and forty metres
     * of haze and nothing is chosen to look right up close, because nothing is
     * ever within sixty metres of the camera. That inverts the usual priorities:
     * fine grain is worthless — it filters to a flat mean, which is precisely
     * how these ended up as blank cubes — and only metre-scale structure counts.
     *
     * So there is no masonry at all, just a wall tone and a window rhythm. */
    float bseed = fract(vBldgP.x * 91.7 + 0.31);
    float storey = 3.15 + 0.95 * fract(bseed * 13.1);
    float bay    = 2.70 + 1.60 * fract(bseed * 7.7);

    col = mix(vec3(0.1180, 0.1055, 0.0930), vec3(0.0760, 0.0735, 0.0715),
              fract(bseed * 4.3));
    // Large, slow patchiness so two neighbouring blocks never share a value and
    // one block is not uniform across its own frontage.
    col *= 0.74 + 0.46 * unit(wfbm(uv * 0.085 + bseed * 40.0, 3));
    rgh = 0.88;

    /* The window rhythm. Rows first, because a horizontal band is what stays
     * legible longest as contrast drops: even when individual openings have
     * merged, the storey banding still says "building". */
    float fy = fract((vWPos.y - 1.30) / storey);
    float fx = fract((uv.x + bseed * 5.0) / bay);
    // Analytic width, so the pattern greys out honestly at range instead of
    // sparkling, but it is never allowed to vanish — see the floor below.
    float wy = max(fwidth(fy), 0.001), wx = max(fwidth(fx), 0.001);
    float rowM = smoothstep(0.22 - wy, 0.22 + wy, fy)
               * (1.0 - smoothstep(0.68 - wy, 0.68 + wy, fy));
    float colM = smoothstep(0.20 - wx, 0.20 + wx, fx)
               * (1.0 - smoothstep(0.72 - wx, 0.72 + wx, fx));
    /* Always punched openings. The strip-glazing variant is gone, and it was
     * actively harmful: with no vertical breaks it drew a set of perfectly
     * regular horizontal bands across a smooth gradient, which is indistinguishable
     * from posterisation — and it was duly reported as posterised banding, a
     * sawtooth of level steps recurring every thirty-odd pixels, on the one face
     * that was using it. Variety between masses has to come from the spacing and
     * the lighting, not from removing the feature that identifies the pattern as
     * windows in the first place. */
    float win = rowM * colM;
    /* Openings are holes: dark, and much less rough than the wall, so the ones
     * turned toward the sun throw back a glint and the rest stay flat. That
     * glint is most of what identifies these as windows rather than as stripes. */
    /* Contrast raised from 0.62, and the reason is that haze is multiplicative.
     * Anything authored here is scaled down by the fog before it is seen, so a
     * feature sized to look right on the material is a feature that has already
     * been erased by the time it reaches the frame — "not washed, untextured" is
     * what that looks like from outside. Authored high so that what survives
     * sixty to a hundred and forty metres of air is still a legible rhythm. */
    col *= 1.0 - win * 0.82;
    /* Piers and spandrels. A window grid alone still leaves the wall between the
     * openings perfectly flat; real structure puts a vertical pier between bays
     * and a horizontal band at each floor, and those two are what carry the read
     * once the openings themselves are down to a couple of pixels. */
    col *= 1.0 - (1.0 - colM) * 0.16 * rowM;
    col *= 1.0 + (1.0 - rowM) * 0.13;
    rgh = mix(rgh, 0.30, win * 0.85);
    // A few lit, at a fraction of the near-field rate — most of the town has not
    // switched on yet at this hour, and a dense grid of lit squares would read as
    // a texture. Deliberately weak: System 5 owns light and this must not compete.
    float lamp = step(0.955, fract(sin(floor((vWPos.y - 1.30) / storey) * 31.7
                    + floor((uv.x + bseed * 5.0) / bay) * 17.3 + bseed * 60.0) * 4371.0));
    col += win * lamp * vec3(0.0290, 0.0182, 0.0086);
    /* A coping band at the parapet. One pale line along the top edge does a
     * disproportionate amount to make a mass read as a building rather than as
     * an extruded rectangle, because it separates the silhouette from the sky. */
    col *= 1.0 + smoothstep(1.10, 0.30, vBldgP.w - vWPos.y) * 0.30;
  }

  /* ── A hundred years of weather ───────────────────────────────────────
   *
   * This is the part that decides whether the wall reads as a photograph. A
   * clean, evenly toned elevation is the single loudest CG tell there is, and
   * the marks are not random: every one of them is water, soot or sun, and
   * each has a place it goes.
   */

  // Rain wash and the stain under every sill. Water runs off the nose of a
  // sill, picks up the dirt on the face below it and carries it down in two
  // dark tails from the ends, fading out over a metre or so.
  float fh = max(vGrid.y, 0.5);
  float t = (vWPos.y - vGrid.w - vWinP.y) / fh;
  float dBelow = (ceil(t) - t) * fh;
  float bu = fract((uv.x - vGrid.z) / max(vGrid.x, 0.5)) - 0.5;
  float halfW = 0.5 * (vWinP.x + 0.17) / max(vGrid.x, 0.5);
  float across = abs(bu) / max(halfW, 0.02);
  float streakN = unit(wfbm(vec2(uv.x * 26.0, uv.y * 0.9), 3));
  float underSill = smoothstep(1.24, 0.86, across) * exp(-dBelow * 0.82)
                  * step(vGrid.w - 0.2, vWPos.y) * step(t, 9.0);
  // Heaviest right at the ends of the sill, where the water actually leaves.
  underSill *= 0.45 + 0.9 * smoothstep(0.35, 0.95, across);
  underSill *= 0.35 + 0.9 * streakN;
  col *= 1.0 - underSill * 0.58;
  rgh = min(1.0, rgh + underSill * 0.05);
  gAO *= 1.0 - underSill * 0.22;

  /* Traffic film and soot. The bottom three metres of every wall on a street
   * is darker than the rest of it — diesel, brake dust and road spray — and it
   * has a soft top edge somewhere around head height rather than a line. */
  float grime = (1.0 - smoothstep(0.4, 3.4, hh)) * (0.6 + 0.5 * unit(wfbm(uv * 1.1, 3)));
  col = mix(col, col * vec3(0.52, 0.52, 0.55), grime * 0.55);

  /* ── The bottom half metre, which is where the buildings were floating ──
   *
   * The critique's first item was that the frontages meet the paving in a
   * razor-sharp shadowless line and read as cut-outs on a table, and it was
   * right. What is missing is not geometry, it is occlusion: the inside corner
   * where a wall meets a footway can see barely a third of the sky, so it is
   * darker than either surface even in flat light — and at four degrees there
   * is no cast shadow available to stand in for that, because on the sunny
   * side the light is coming *from* the open side of the corner and on the
   * shaded side the whole wall is in shadow anyway.
   *
   * So the last 900 mm of every wall loses most of its skylight, on a curve
   * that is steep in the last 150 mm, and the last 400 mm also gets the road
   * spray: a dark tide of rising damp, the splash-back the traffic throws up
   * off the paving, and the efflorescence — the white salt bloom — that sits
   * just above where it dries out.
   */
  gAO *= mix(0.22, 1.0, smoothstep(-0.05, 0.90, hh) * 0.45
                      + smoothstep(-0.02, 0.16, hh) * 0.55);
  float damp = 1.0 - smoothstep(0.05, 0.75, hh);
  col *= 1.0 - damp * 0.42;
  // Splash-back: individual dirt fans thrown up off the paving, strongest in
  // the first 250 mm and gone by 600.
  float splash = (1.0 - smoothstep(0.02, 0.62, hh))
               * smoothstep(0.30, 0.80, unit(wfbm(vec2(uv.x * 9.0, uv.y * 2.2), 3)));
  col = mix(col, col * vec3(0.44, 0.43, 0.42), splash * 0.7);
  float bloom = smoothstep(0.45, 1.05, hh) * (1.0 - smoothstep(1.05, 1.9, hh))
              * smoothstep(0.52, 0.86, unit(wfbm(uv * 1.8 + 3.0, 3)));
  col = mix(col, col * 2.4 + vec3(0.035), bloom * 0.5);

  /* General vertical washing, everywhere. A wall that has stood in the rain
   * for a century is striped: clean where the water runs, dirty where it does
   * not, at a scale of a hand's breadth. */
  float wash = unit(wfbm(vec2(uv.x * 7.0, uv.y * 0.42), 4));
  col *= 0.86 + 0.28 * wash;

  /* And the same thing again three octaves lower.
   *
   * Every mark above is at the scale of a hand or a storey, and with only
   * those the wall came out evenly toned when seen whole: correct up close,
   * papered from across the street. Real elevations are blotchy at the scale
   * of several metres — one bay was repointed, one end faces the prevailing
   * weather, a gutter overflowed for a decade. The pitch is deliberately
   * unrelated to anything else here so the two do not beat. */
  col *= 0.72 + 0.52 * unit(wfbm(vec2(uv.x * 0.19, uv.y * 0.115) + 61.0, 4));

  // Downpipe runs. The corners of a building are where the pipes go and where
  // the two dirtiest stripes on any facade are.
  float toEnd = min(uv.x - vWinP.z, vWinP.w - uv.x);
  float pipe = (1.0 - smoothstep(0.10, 0.52, abs(toEnd - 0.26)))
             * smoothstep(0.2, 1.2, hh) * (0.5 + 0.6 * streakN);
  col *= 1.0 - pipe * 0.34;

  /* Soot under the cornice, and the wash below the string course.
   *
   * The two horizontal lines on a facade that never get rained on are the
   * soffit of the cornice and the underside of the first-floor band, and both
   * of them are black on any city building that has stood through a century of
   * coal and then diesel. Below each one the wall is streaked instead: the
   * water that the projection sheds has to go somewhere and it goes straight
   * down the face in long tails. Together they are the two strongest
   * horizontal accents on an elevation and their absence is most of why the
   * last pass read as new-built. */
  float belowTop = vBldgP.w - vWPos.y;
  float soot = exp(-max(belowTop, 0.0) * 1.25) * step(0.0, belowTop) * step(0.6, hh);
  col *= 1.0 - soot * 0.42 * (0.45 + 0.8 * wash);
  gAO *= 1.0 - soot * 0.20;
  float belowBand = vGrid.w - vWPos.y;
  float bandRun = exp(-max(belowBand, 0.0) * 0.55) * step(0.0, belowBand) * step(0.3, hh);
  col *= 1.0 - bandRun * 0.26 * smoothstep(0.35, 0.95, streakN);

  /* Sun bleaching. The elevation that faces the afternoon sun has had its
   * paint chalked off it and its brick faded, and the one that does not has
   * moss in the joints and a green-black cast. This is the cheapest possible
   * way to make the two sides of the street differ in *material* as well as in
   * illumination, which is what stops the shaded side looking like the sunny
   * side with the lights off. */
  float face = dot(vWN, uSun);
  float bleach = smoothstep(0.05, 0.62, face);
  col = mix(col, mix(col, vec3(dot(col, vec3(0.33))), 0.32) * 1.14, bleach * 0.55);
  float algae = smoothstep(0.0, -0.5, face)
              * smoothstep(0.55, 0.85, unit(wfbm(uv * 1.35 + 40.0, 3)));
  col = mix(col, col * vec3(0.72, 0.86, 0.70), algae * 0.35);

  diffuseColor.rgb *= col;
  roughnessFactor = clamp(rgh, rghFloor, 1.0);

  /* Distance-filtered specular, as on the paving. A facade seen from a hundred
   * metres down the street is at grazing incidence over its whole height and
   * without this the far end of the block turns into a sheet of reflected sky.
   */
  float dist = length(vWPos - cameraPosition);
  roughnessFactor = max(roughnessFactor, smoothstep(30.0, 90.0, dist) * 0.82);
}
`;

export function makeWallMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1, metalness: 0,
    /* Every facade surface is a single-sided quad, so the shadow pass has to
     * be told to use front faces. Left at the default of BackSide it renders
     * the *inside* of each building — of which there is almost none, since
     * only the back wall and the flanks have inward faces — and the block
     * casts essentially nothing. This is the same trap the kerb fell into in
     * System 1, and here it would have taken out every shadow in the scene. */
    shadowSide: THREE.FrontSide,
    dithering: true,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uSun = { value: new THREE.Vector3(...SUN_DIR) };
    Object.assign(shader.uniforms, artificialUniforms());
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `
${FACADE_VARYINGS}
varying vec2 vFuv;
varying vec4 vGrid;
varying vec4 vWinP;
varying vec4 vBldgP;
varying float vRoleF;
attribute vec4 aGrid;
attribute vec4 aWin;
attribute vec4 aBldg;
attribute float aRole;
void main() {`)
      .replace('#include <begin_vertex>', `${FACADE_VERTEX}
vFuv = uv;
vGrid = aGrid; vWinP = aWin; vBldgP = aBldg; vRoleF = aRole;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${NOISE}\n${MASONRY_PARS}\n${CANYON}\n${ARTIFICIAL}\nvoid main() {`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${MASONRY_BODY}`)
      .replace('#include <normal_fragment_maps>', FACADE_NORMAL)
      .replace('#include <lights_fragment_end>', MASONRY_END);
  };
  m.customProgramCacheKey = () => 'street-masonry';
  return m;
}

/* ── Glass ──────────────────────────────────────────────────────────────── */

/* System 5 owns what is behind the glass, and both levels below are inverted
 * through the measured display response rather than picked.
 *
 * A LIT ROOM. The value this replaces was 0.0295 in red, which through
 * display = 0.284*L^0.4545 lands at 15 counts — a lit window that was
 * invisible in every frame, and correctly so at the time: System 2's note says
 * in as many words that it exists only to stop the block reading as derelict
 * and that System 5 owns the real thing.
 *
 * The real thing is bracketed by two things already in the scene rather than
 * by taste. A first-floor room behind a dirty net-curtained sash must sit under
 * a lit shop interior, which is a fluorescent ceiling seen directly through
 * plate glass, and well under a sunlit wall. 58 counts is where that puts it,
 * and `forDisplay` turns 58 into L = 0.118 — four times the old placeholder.
 *
 * THE BRACKET ITSELF IS STILL IN THE WITHDRAWN CURVE'S DISPLAY SPACE, and this
 * is a caveat rather than a correction. The paragraph that chose 58 read "a
 * sunlit brick wall measures about 195, which inverts to L = 8.8; the shop
 * ceiling at LIT_STORE * 1.55 * 1.35 = 1.674 lands at 92; 58 is 63 per cent of
 * the shop and 30 per cent of the wall". Every one of those three numbers is
 * `display = 0.284 * L^0.4545`: the real transform sends 195 to L = 3.0, not
 * 8.8, and sends the shop's 1.674 to 172, not 92. So the shop is not at 92 and
 * 58 is not 63 per cent of it — it is a third of it. The *target* may still be
 * the right target, since a room behind a net curtain at dusk is meant to be
 * modest, and the inversion under it is now the real one either way; but the
 * argument that picked 58 does not survive, and if this room is ever revisited
 * it should be re-bracketed rather than nudged. See NOTES.md.
 *
 * Chromaticity is unchanged from System 2's (1.00, 0.583, 0.251) — tungsten,
 * and warm enough that it lands on screen at (58, 43, 27).
 *
 * THE TELEVISION. Authored at 62 in blue rather than in red, which is the
 * whole point of it: it is the only cool artificial source in the scene apart
 * from the pharmacy cross, and a street where every window is the same
 * temperature reads as one rig with a gel on it. Slightly over the tungsten
 * rooms because a screen-lit ceiling has a higher peak than a shaded bulb
 * does, and heavily modulated below that by the shot cycle.
 */
const LIT_ROOM: [number, number, number] = (() => {
  const L = forDisplay(58);
  return [L, L * 0.583, L * 0.251];
})();

const TV_COLOUR: [number, number, number] = (() => {
  const L = forDisplay(62);
  return [L * 0.72, L * 0.86, L];
})();

/**
 * Where the television is, set by System 5 once the layout is known.
 *
 * A shared uniform object rather than a constructor argument, so that
 * Buildings.tsx does not have to know System 5 exists and so that there is
 * exactly one copy of the value. w is zero until it is placed, which switches
 * the branch off entirely rather than putting a set at the origin.
 */
export const TV_AT = { value: new THREE.Vector4(0, -1000, 0, 0) };

const GLASS_PARS = /* glsl */ `
${FACADE_VARYINGS}
varying vec4 vPaneP;   // key, pane columns, blind seed, lit seed
varying vec2 vGuv;
uniform vec3 uSun;
uniform float uBuildLine;
uniform vec3 uLitRoom;
uniform vec4 uTv;
uniform vec3 uTvC;
uniform float uSysTime;
vec2 gSlope = vec2(0.0);
vec3 gLit = vec3(0.0);
float gRefl = 1.0;
vec3 gTint = vec3(1.0);
`;

const GLASS_BODY = /* glsl */ `
{
  vec2 uv = vGuv;
  float key = vPaneP.x;
  float cols = max(vPaneP.y, 1.0);
  // Which pane of the sash this fragment belongs to. Panes matter because
  // every one of them is a separately glazed sheet sitting at its own angle in
  // its own putty, and a window whose panes all reflect identically is the
  // most obvious piece of CG glass there is.
  float trans = 0.52;
  vec2 pane = vec2(floor(uv.x * cols), step(trans, uv.y));
  float p1 = hash21(pane + key * 3.1);
  float p2 = hash21(pane + key * 7.9 + 11.0);

  /* Per-pane tilt. Old glass is never flat: the sash has dropped, the putty
   * has shrunk, the pane itself is drawn rather than float. A quarter of a
   * degree is enough to break a row of windows out of lockstep, and it is the
   * difference between a reflection that reads as glass and one that reads as
   * a mirrored decal. */
  gSlope += (vec2(p1, p2) - 0.5) * 0.035;

  /* What is behind the glass. Mostly nothing: an unlit room at dusk is close
   * to black and the window reads almost entirely as reflection. Some have a
   * blind or a net down to a different height in every one, which is the
   * single strongest signal that a building is occupied. */
  /* A blind hangs from the head of the window, which is worth saying because
   * the first version had it rising from the cill: uv.y is zero at the bottom
   * of the opening, so stepping below a threshold filled the *lower* part of
   * every pane with pale fabric. Combined with the reflection fault below it
   * produced the pale rectangles the critique read as a missing texture. */
  float blindH = fract(vPaneP.z * 5.7);
  float blind = step(0.97 - blindH * 0.78, uv.y);
  vec3 room = vec3(0.0090, 0.0086, 0.0092);
  // Halved. Net and holland blind are pale *fabric*, but they are behind a
  // dirty pane in an unlit room, and at the old value a closed blind was the
  // brightest diffuse surface on the entire building.
  vec3 blindC = mix(vec3(0.0700, 0.0665, 0.0590), vec3(0.0340, 0.0350, 0.0380), fract(key * 3.3));
  // Slats, or the folds of a net curtain.
  float slat = 0.86 + 0.22 * sin(uv.y * (60.0 + fract(key * 17.0) * 90.0));
  vec3 inside = mix(room, blindC * slat, blind * (0.35 + 0.6 * step(0.35, fract(vPaneP.z * 13.0))));
  inside *= 0.5 + 0.8 * hash21(pane + key);

  /* A minority lit from inside, and kept firmly subordinate: the sun is still
   * up and a tungsten bulb behind net curtains at this hour is a hint, not a
   * lamp. The full window-lighting rig is System 5; this only stops the block
   * reading as derelict. */
  float lit = step(0.88, fract(vPaneP.w * 9.7)) * step(0.35, fract(key * 2.7));
  gLit = uLitRoom * lit * (0.5 + 0.9 * fract(key * 5.1));
  // Behind a blind, most of it is blocked; through bare glass you see the room.
  gLit *= mix(1.0, 0.35, blind);
  /* A lit room is not a light box, and rendering it as one is why these read
   * as glowing decals. What a window actually shows is a bright patch of
   * ceiling near the head, falling away to a dark floor, with the furniture
   * and whoever lives there blocking a good deal of it. Two multiplies. */
  gLit *= mix(0.30, 1.30, smoothstep(0.05, 0.78, uv.y));
  gLit *= 1.0 - 0.60 * smoothstep(0.55, 0.95,
            unit(wfbm(uv * vec2(3.4, 2.2) + key * 4.0, 2)));

  /* ── The television ──────────────────────────────────────────────────
   *
   * One room, and it is a *specific* room: uTv carries the world centre of an
   * opening found on the CPU from the same lattice the emitter walks, so it is
   * a window that certainly exists rather than one a hash hoped for. The test
   * is a world-space box because it has to match a single sash and nothing
   * near it.
   *
   * What a television does to a room, seen from a street, is not a flickering
   * rectangle. The screen faces away from the window in almost every room ever
   * built, so what reaches the glass is the *ceiling and the far wall* lit by
   * it — a soft cold field with no edges, an order of magnitude below the
   * screen itself, filling the top of the window and falling away downward,
   * which is the same falloff a room light has and for the same reason.
   *
   * The modulation is two-rate and both rates are real. Broadcast material
   * cuts every two to six seconds and mean picture level jumps at every cut;
   * within a shot it drifts with motion. There is no 50 Hz flicker here on
   * purpose: at any plausible shutter speed that is either invisible or a
   * rolling band, and a per-frame random is the tell that separates a rendered
   * television from a filmed one.
   */
  if (uTv.w > 0.5
      && abs(vWPos.x - uTv.x) < 0.90
      && abs(vWPos.y - uTv.y) < 1.05
      && abs(vWPos.z - uTv.z) < 0.90){
    float shot = floor(uSysTime * 0.29);
    float level = 0.40 + 0.60 * hash21(vec2(shot, 3.1));
    // Within the shot: camera movement and the picture changing under it.
    level *= 0.84 + 0.16 * sin(uSysTime * 6.7 + shot * 2.3);
    // And the occasional cut to something much brighter, which is what makes
    // the pattern read as a screen rather than as a fault.
    level += 0.55 * step(0.93, hash21(vec2(shot, 8.7)));
    vec3 tv = uTvC * level;
    // The same room falloff as a lit window, plus more of it: a television is
    // a low source and it throws most of what it has at the ceiling.
    tv *= mix(0.18, 1.35, smoothstep(0.02, 0.72, uv.y));
    gLit = tv * mix(1.0, 0.42, blind);
  }

  /* Dirt. Nobody has cleaned these since the eighties. Rain streaks running
   * down from the top rail, a dusty band along the bottom of each pane where
   * the water sits, and the corners packed with the grey film that makes an
   * old window read grey rather than black. */
  vec2 wp = vec2(vWPos.y * 6.0, dot(vWPos.xz, vec2(6.0, 6.0)));
  float streak = unit(wfbm(vec2(wp.y * 3.0, vWPos.y * 0.6), 3));
  float dirt = 0.30 + 0.45 * streak;
  dirt += 0.35 * (1.0 - smoothstep(0.0, 0.16, uv.y));
  dirt += 0.30 * (1.0 - smoothstep(0.0, 0.10, min(fract(uv.x * cols), 1.0 - fract(uv.x * cols))));
  dirt = clamp(dirt, 0.0, 1.0);

  diffuseColor.rgb = mix(inside, vec3(0.0480, 0.0470, 0.0450), dirt * 0.55);
  roughnessFactor = clamp(0.045 + dirt * 0.14 + p1 * 0.02, 0.04, 0.4);

  /* What the glass reflects, and this is most of what a window *is*.
   *
   * The environment map is a sky and nothing else — it has no idea there is a
   * building on the other side of the street — so left to itself every window
   * below roof level mirrors either open sky or the flat fake ground under the
   * horizon, and the whole block lights up like a row of holes. What a real
   * window at eye level actually shows is the opposite elevation, and at this
   * hour that is worth having: the top of it is on fire and the bottom of it
   * is deep blue shade, so the reflection carries the same vertical gradient
   * the street does, upside down.
   *
   * So the reflected ray is intersected with the opposite building line — one
   * divide — and the environment term is retinted by what it would have hit.
   * It is not a reflection of the actual geometry and it does not need to be:
   * at this scale what the eye checks is whether the value and the hue are
   * plausible and whether they change down the height of the pane.
   */
  vec3 Vw = normalize(vWPos - cameraPosition);
  vec3 Nw = normalize(vWN - vWT * gSlope.x - vWB * gSlope.y);
  vec3 R = reflect(Vw, Nw);

  /* The bug this replaces is worth recording, because it produced the single
   * worst artifact in the last set of frames.
   *
   * The old version only retinted the reflection when the reflected ray
   * actually crossed the street and struck the building line within sixty
   * metres. Any ray that did not — and at the grazing angles you get looking
   * *down* a street almost every ray does not, because it runs along the
   * canyon rather than across it — fell through to the raw environment map,
   * which is a sky with a blazing amber horizon in it, multiplied by 2.4. At
   * grazing incidence Fresnel is one, so specular is the entire pane. The
   * result was a flat, featureless, near-white rectangle on window after
   * window, and it was read — correctly — as a missing texture.
   *
   * A window low in a street canyon can hardly ever see the sky. What it sees
   * is more street. So the ray is now resolved in every case: across to the
   * far frontage if it goes that way, and otherwise along the canyon to
   * whatever is standing thirty metres down it. Only a ray that clears the
   * roofline gets the sky, which is the correct and much rarer answer.
   */
  const float ROOFLINE = 13.5;
  float yHit; float dHit;
  if (abs(R.x) > 0.035){
    dHit = (sign(R.x) * uBuildLine - vWPos.x) / R.x;
    dHit = clamp(dHit, 0.0, 45.0);
  } else {
    dHit = 32.0;
  }
  yHit = vWPos.y + R.y * dHit;

  /* Which frontage, and how much of it is alight. The row at -X faces the sun
   * and burns above its own shade line; the row at +X faces away and is cool
   * all the way up. A ray running along the street splits the difference. */
  float litLine = R.x < -0.02 ? 6.5 : (R.x > 0.02 ? 1e6 : 9.0);
  vec3 warm  = vec3(2.60, 1.48, 0.62);
  /* Desaturated from (0.30, 0.38, 0.62). What a window low in the street
   * reflects is a shaded brick wall lit by the sky, not the sky itself, so it
   * is a cool grey with a blue lean — the previous value was reading as a
   * saturated blue patch against an otherwise warm frame and was called out as
   * a cubemap artefact. */
  vec3 shade = vec3(0.36, 0.38, 0.44);
  vec3 road  = vec3(0.13, 0.13, 0.16);
  vec3 tint = yHit < 0.2 ? road
            : mix(shade, warm, smoothstep(litLine - 1.0, litLine + 3.0, yHit));
  // Above the parapet it really is sky, and the environment map is right.
  float sky = smoothstep(ROOFLINE - 1.0, ROOFLINE + 2.5, yHit);
  /* Not vec3(1.0). Passing the environment through untouched means a pane
   * whose ray clears the parapet returns the raw zenith, and the zenith of a
   * golden-hour sky is a deep and very saturated blue-violet — against a frame
   * that is otherwise warm it came back as a handful of electric blue
   * rectangles and was read, fairly, as a cubemap artefact. What a window
   * actually returns is the sky through a dirty pane at a few per cent
   * reflectance, which is dimmer and much less saturated than the sky itself. */
  /* Note the direction of the correction. The obvious tint for "less
   * saturated blue" is something like vec3(0.60, 0.68, 0.88), and that is
   * exactly backwards: scaling red by 0.60 while scaling blue by 0.88 raises
   * the blue-to-red ratio rather than lowering it, so the panes came out more
   * electric than the sky they were reflecting. Saturation cannot be reduced
   * by a per-channel gain that is itself blue. It is drained in GLASS_END
   * instead, by mixing the reflected radiance toward its own luminance, and
   * what stays here is only a level and a faint warm bias. */
  gTint = mix(tint, vec3(0.88, 0.85, 0.82), sky);

  /* And then break it pane by pane. A sheet of drawn glass in a dropped sash
   * is never coplanar with the one above it, so a wall of windows reflects the
   * same street at a dozen slightly different values — which is what makes a
   * facade of glass read as glass rather than as a grid of identical holes.
   * A handful go dead: shutters behind, a rag over the inside, a pane replaced
   * with something opaque. */
  gTint *= 0.55 + 1.05 * p2 * p2;
  gRefl = mix(1.0, 0.12, step(0.93, hash21(pane + key * 1.7 + 3.0)));
  gTint *= gRefl;
  /* Dirty glass does not mirror. Half the reason a city window reads as glass
   * rather than as a mirror is that the film on it scatters the reflection
   * away, and without this the grimiest panes were the brightest ones. */
  gTint *= 1.0 - dirt * 0.45;
}
`;

/* The gain here is the same envMapIntensity workaround as everywhere else in
 * this file, and glass needs it most: the whole reason a window reads as glass
 * rather than as a dark hole is the sky in it, and the sky arrives entirely
 * through indirect specular. */
const GLASS_END = /* glsl */ `
#include <lights_fragment_end>
/* 1.15 was leaving every pane dead.
 *
 * A window is glass over a dark room, so essentially all of what it shows is
 * the reflection, and the reflection arrives entirely through this term at
 * whatever strength scene.environmentIntensity happens to be set to for the
 * road's benefit. At 1.15 the panes came out as the "flat black rectangles
 * punched in a wall" the review found at every distance past ten metres — not
 * because the reflection was wrong but because there was not enough of it to
 * see. The tint carries the variation; this carries the level. */
/* Drain the saturation out of the reflection.
 *
 * A pane in a hundred-year-old sash is not a first-surface mirror. It has a
 * film of city dirt on it, it is slightly green in section, and most of what
 * leaves it towards the eye has been scattered by that film rather than
 * specularly reflected. All three effects pull the reflection towards grey,
 * and none of them can be expressed as a coloured gain. Mixing toward
 * luminance is the one operation that reduces saturation without changing
 * level, which is why it belongs here rather than in the tint. */
vec3 spec = reflectedLight.indirectSpecular;
spec = mix(spec, vec3(dot(spec, vec3(0.2126, 0.7152, 0.0722))), 0.66);
reflectedLight.indirectSpecular = spec * gTint * 1.90;
reflectedLight.indirectDiffuse =
  canyonSky(reflectedLight.indirectDiffuse, vWN, vWPos.y) * 2.7;
`;

/* The lit rooms are emissive rather than bright diffuse, because what makes a
 * lit window read as lit is that it does not respond to the sun: it is the
 * same value on the shaded side of the street as on the sunlit one. Kept an
 * order of magnitude under the sunlit brickwork — at this hour a bulb behind a
 * net curtain is a hint, and System 5 owns the real thing. */
const GLASS_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += gLit;
`;

export function makeGlassMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.08, metalness: 0.0,
    /* Double sided because a few sashes are hung open and are seen from
     * behind, and because a single-sided pane in a reveal shows a hole in the
     * building the moment the camera gets past its plane. */
    side: THREE.DoubleSide,
    shadowSide: THREE.FrontSide,
    envMapIntensity: 2.2,
    dithering: true,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uSun = { value: new THREE.Vector3(...SUN_DIR) };
    shader.uniforms.uBuildLine = { value: BUILD_LINE };
    shader.uniforms.uLitRoom = { value: new THREE.Vector3(...LIT_ROOM) };
    shader.uniforms.uTvC = { value: new THREE.Vector3(...TV_COLOUR) };
    shader.uniforms.uTv = TV_AT;
    shader.uniforms.uSysTime = SYS5_TIME;
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `
${FACADE_VARYINGS}
varying vec4 vPaneP;
varying vec2 vGuv;
attribute vec4 aPane;
void main() {`)
      .replace('#include <begin_vertex>', `${FACADE_VERTEX}\nvPaneP = aPane; vGuv = uv;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${NOISE}\n${GLASS_PARS}\n${CANYON}\nvoid main() {`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${GLASS_BODY}`)
      .replace('#include <normal_fragment_maps>', FACADE_NORMAL)
      .replace('#include <emissivemap_fragment>', GLASS_EMISSIVE)
      .replace('#include <lights_fragment_end>', GLASS_END);
  };
  m.customProgramCacheKey = () => 'street-glass';
  return m;
}

/* ── Painted joinery ────────────────────────────────────────────────────── */

const TRIM_BODY = /* glsl */ `
{
  float seed = vTrimP.x;
  vec3 paint =
      fract(seed * 7.3) < 0.42 ? vec3(0.3200, 0.3080, 0.2820)
    : fract(seed * 7.3) < 0.62 ? vec3(0.0420, 0.0560, 0.0480)
    : fract(seed * 7.3) < 0.80 ? vec3(0.0700, 0.0330, 0.0300)
                               : vec3(0.1000, 0.1030, 0.1080);
  vec2 p = vec2(vWPos.y * 7.0, dot(vWPos.xz, vec2(7.0, 7.0)));
  // Paint on an eighty-year-old sash does not fail evenly: it crazes, lifts
  // along the grain and goes back to bare grey timber on the weather side.
  float weather = smoothstep(0.45, 0.85, unit(wfbm(p * 0.7, 4)));
  paint = mix(paint, vec3(0.0980, 0.0880, 0.0720), weather * 0.6);
  paint *= 0.82 + 0.34 * unit(wfbm(p * 3.0, 3));
  // Dirt collects along the bottom of every glazing bar.
  paint *= 0.80 + 0.30 * smoothstep(0.0, 0.6, vWN.y + 0.4);
  diffuseColor.rgb *= paint;
  roughnessFactor = clamp(0.42 + weather * 0.45, 0.3, 1.0);
}
`;

export function makeTrimMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1, metalness: 0,
    shadowSide: THREE.FrontSide, envMapIntensity: 1.5, dithering: true,
  });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `${FACADE_VARYINGS}\nvarying vec2 vTrimP;\nattribute vec2 aTrim;\nvoid main() {`)
      .replace('#include <begin_vertex>', `${FACADE_VERTEX}\nvTrimP = aTrim;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${NOISE}\n${FACADE_VARYINGS}\nvarying vec2 vTrimP;\n${CANYON}\nvoid main() {`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${TRIM_BODY}`)
      .replace('#include <lights_fragment_end>', skyLift(3.0));
  };
  m.customProgramCacheKey = () => 'street-trim';
  return m;
}

/* ── Steel ──────────────────────────────────────────────────────────────── */

const METAL_BODY = /* glsl */ `
/* Declared in main, before the block below, so the lighting hook further down
 * can read it. */
float gMetalSpec = 1.0;
{
  float seed = vMetalP.x;
  float kind = vMetalP.y;
  vec2 p = vec2(vWPos.y * 9.0 + seed * 3.0, dot(vWPos.xz, vec2(9.0, 9.0)));

  vec3 base; float rgh; float met;
  if (kind < 0.5){
    /* The lot railing, split out of the painted-casework branch it was sharing
     * with the window air conditioners.
     *
     * It was running at their albedo — 0.21, the value of a white-painted sheet
     * steel box — and the top rail and the picket shoulders are narrow facets
     * turned into a four-degree sun, so the run came back as a chain of clipped
     * dashes beating at the picket pitch beside the coping. A spear-topped
     * railing is not painted white. It is painted black or dark green, it has
     * been repainted over rust a dozen times, and its surface is matt.
     *
     * The rest is the kerb-cap remedy: the roughness goes up, the daylight floor
     * with it, and a slow field along the run breaks the highlight so that it is
     * a broken glint on old ironwork rather than one continuous line of dashes.
     */
    base = vec3(0.0225, 0.0242, 0.0228); rgh = 0.88; met = 0.10;
    float rustR = smoothstep(0.50, 0.86, unit(wfbm(p * 1.3, 4)));
    base = mix(base, vec3(0.0890, 0.0410, 0.0205), rustR * 0.75);
    float runR = unit(wfbm(vec2(vWPos.z * 0.22 + seed, vWPos.y * 0.55), 3));
    base *= 0.62 + 0.62 * runR;
    rgh = clamp(mix(rgh, 0.97, rustR) + (runR - 0.5) * 0.10, 0.72, 1.0);
    met = mix(met, 0.03, rustR);
    /* The top rail is a 45 mm horizontal bar seen nearly edge-on, and that is
     * the geometry that produces a specular chain: at grazing incidence the
     * split-sum Fresnel term runs to one however rough the surface is, so the
     * bar mirrors the brightest part of the sky along its entire length and the
     * pickets chop the result into dashes. Roughness cannot reach it. The
     * reflection is cut instead, hardest on the up-faces and unevenly along the
     * run, which is what old painted ironwork actually returns. */
    gMetalSpec = mix(0.30, 0.07, clamp(vWN.y, 0.0, 1.0)) * (0.45 + 1.10 * runR);
  } else if (kind < 1.5){
    // A window air conditioner: painted steel case, gone chalky and streaked.
    base = vec3(0.2100, 0.2060, 0.1960); rgh = 0.62; met = 0.10;
    base *= 0.78 + 0.36 * unit(wfbm(p * 2.0, 3));
  } else if (kind < 2.5){
    /* Fire escape steel. Painted black once, decades ago, and now more rust
     * than paint — which matters because rust is the only part of this
     * assembly with any colour in it, and at golden hour it goes orange in a
     * way that reads instantly as old ironwork. */
    base = vec3(0.0230, 0.0225, 0.0230); rgh = 0.68; met = 0.28;
    float rust = smoothstep(0.42, 0.80, unit(wfbm(p * 1.6, 4)))
               * (0.4 + 0.6 * smoothstep(0.3, 0.8, unit(wfbm(p * 7.0, 3))));
    base = mix(base, vec3(0.1350, 0.0530, 0.0230), rust * 0.85);
    rgh = mix(rgh, 0.93, rust);
    met = mix(met, 0.04, rust);
  } else if (kind < 3.5){
    /* Pipework and conduit. Roughness was 0.55 at 25% metal, and on a 45 mm
     * bar under a raking sun the dielectric lobe of that went to a blown white
     * highlight along its whole length — the "bright horizontal line" in the
     * critique. Cast iron rainwater goods and galvanised conduit are matt: a
     * century of paint over rust on the one and a dull spelter coat on the
     * other. Neither can mirror anything. */
    base = vec3(0.0480, 0.0470, 0.0455); rgh = 0.84; met = 0.08;     // pipework
    base *= 0.8 + 0.4 * unit(wfbm(p * 3.0, 3));
  } else if (kind < 5.5){
    base = vec3(0.0350, 0.0340, 0.0340); rgh = 0.60; met = 0.35;     // fixings
  } else if (kind < 6.5){
    /* Galvanised, and dulled hard.
     *
     * At 0.48 roughness and 55% metal an air-conditioner casing returns very
     * nearly the raw environment, and the raw environment directly overhead at
     * this hour is a deep blue-violet zenith. So every casing on the shaded
     * side came out as a saturated blue box on an otherwise warm wall — the
     * same complaint that was made about the window reflections, arriving
     * through a different material. A spelter coat weathers to a chalky matt
     * oxide within a year or two and then collects city dirt on top of that;
     * it has no mirror left in it. */
    base = vec3(0.1450, 0.1470, 0.1490); rgh = 0.76; met = 0.24;     // galvanised
    base *= 0.82 + 0.34 * unit(wfbm(p * 5.0, 3));
  } else if (kind < 7.5){
    base = vec3(0.1250, 0.1270, 0.1300); rgh = 0.52; met = 0.40;     // roof plant
  } else if (kind < 8.5){
    base = vec3(0.1420, 0.1400, 0.1340); rgh = 0.66; met = 0.30;     // tank
    base *= 0.80 + 0.4 * unit(wfbm(vec2(p.x * 0.4, p.y * 4.0), 3));
  } else {
    // Dish. Was the brightest thing on any roof and read as a white hole; a
    // twenty-year-old dish is grey plastic gone chalky, well under the value
    // of the stone coping it stands on.
    base = vec3(0.1520, 0.1500, 0.1450); rgh = 0.74; met = 0.02;
    base *= 0.86 + 0.26 * unit(wfbm(p * 2.2, 3));
  }

  // Everything outdoors in a city carries the same film, and it is what ties
  // the metal to the wall behind it.
  float grime = smoothstep(0.35, 0.85, unit(wfbm(p * 0.9, 4)));
  base = mix(base, base * vec3(0.55, 0.55, 0.58), grime * 0.5);
  // Water sits on the up-faces and rots them; the undersides stay dry.
  base *= 0.82 + 0.30 * (1.0 - max(vWN.y, 0.0));

  diffuseColor.rgb *= base;
  roughnessFactor = clamp(rgh, 0.2, 1.0);
  metalnessFactor = met;
}
`;

export function makeMetalMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1, metalness: 1,
    /* Railings, gratings and brackets are thin closed prisms, but the sloped
     * plates that make up a stair stringer and the dish are effectively open.
     * Front-side shadows are correct for all of them and are the only setting
     * under which the lacework a fire escape is built for actually appears on
     * the wall behind it. */
    shadowSide: THREE.FrontSide,
    envMapIntensity: 1.1,
    dithering: true,
  });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `${FACADE_VARYINGS}\nvarying vec2 vMetalP;\nattribute vec2 aMetal;\nvoid main() {`)
      .replace('#include <begin_vertex>', `${FACADE_VERTEX}\nvMetalP = aMetal;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${NOISE}\n${FACADE_VARYINGS}\nvarying vec2 vMetalP;\n${CANYON}\nvoid main() {`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${METAL_BODY}`)
      .replace('#include <lights_fragment_end>', `${skyLift(2.6)}
/* Same argument as the glass, and the same operation. Street ironwork is
 * painted, rusted, galvanised and then dirtied; whatever mirror it left the
 * works with is long gone, and its reflection of the sky arrives scattered and
 * largely achromatic rather than as a clean coloured image of the zenith. */
{
  vec3 s = reflectedLight.indirectSpecular * gMetalSpec;
  reflectedLight.indirectSpecular =
    mix(s, vec3(dot(s, vec3(0.2126, 0.7152, 0.0722))), 0.55);
  reflectedLight.directSpecular *= gMetalSpec;
}
`);
  };
  m.customProgramCacheKey = () => 'street-metal';
  return m;
}
