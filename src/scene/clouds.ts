/* Procedural cloud decks, and the sky they are composited into.
 *
 * ── COLOUR SPACE, declared at the top of the pass as §2 of the technique
 *    brief requires ──────────────────────────────────────────────────────────
 *
 *   in    nothing. Every value in this file is generated.
 *   local linear scene radiance, sRGB primaries, in exactly the units
 *         `skyRadiance()` in env.ts works in — a horizon-sunward sky pixel is
 *         3.4 in red, a zenith pixel is 0.085.
 *   out   the same. The cube render target is HalfFloat / NoColorSpace, and it
 *         is drawn by three's own `backgroundCube` shader, which applies the
 *         tone map, the sensor pedestal and the sRGB encode at draw time
 *         exactly as it does for the texture this replaces. Nothing in here is
 *         display-referred and nothing in here is tone-mapped.
 *
 * ── What this file is for, and the bug it had to fix first ──────────────────
 *
 * The visible sky was a flat vertical ramp with nothing in it. Two separate
 * causes, and the second one had to be found before the first was worth
 * fixing.
 *
 * 1. There were no clouds. That is the brief.
 *
 * 2. **`scene.background` was not being direction-mapped at all.** env.ts
 *    builds a 512x256 equirectangular DataTexture and tags it
 *    `EquirectangularReflectionMapping`, which reads as a sky dome and is not
 *    one. three's `WebGLBackground.addToRenderList` dispatches on
 *    `background.isCubeTexture || background.mapping === CubeUVReflectionMapping`
 *    and on nothing else; an equirect `Texture` fails both tests and falls into
 *    the `background.isTexture` branch, which draws `ShaderLib.background` — a
 *    full-screen `PlaneGeometry(2,2)` sampling `t2D` at *the plane's own uv*.
 *    There is no view direction anywhere in that shader.
 *
 *    So the whole 360x180 panorama was being stretched flat across the
 *    viewport: 4x too tall vertically, 6.4x too wide horizontally, and
 *    completely nailed to the screen — turning your head did not change one
 *    pixel of it. That is why the sky was a smooth ramp with no structure. It
 *    is also why it survived review: at pitch 0 the equirect's own horizon row
 *    lands at v = 0.5, which is screen centre, which is where a level camera
 *    puts the real horizon, so the one thing anybody would have checked was
 *    accidentally right.
 *
 *    It is the shape NOTES.md catalogues under "verifying the parts and
 *    shipping the assembly": `skyRadiance` was correct, `tools/skyprobe.mjs`
 *    integrates it correctly, the tone-curve validation that read nine sky
 *    pixels off it was correct — and the wiring between the texture and the
 *    screen threw the direction away.
 *
 *    The fix is to hand three something it will direction-map, which means a
 *    cube texture. `bakeSkyCube` below renders the sky into a
 *    `WebGLCubeRenderTarget` through three's own `CubeCamera`, so the face
 *    convention is three's rather than one this file had to get right.
 *
 *    How much this was worth on its own, measured rather than argued: the same
 *    frame with `?sky=flat` against `?sky=noclouds` differs over 0.14% of its
 *    pixels, peak 42 counts (tools/skyab.mjs, then tools/diffpng.mjs). Almost
 *    nothing. A vertical ramp stretched across the viewport and the same ramp
 *    mapped by direction look nearly identical from a level camera in a street
 *    canyon, which is the whole reason nobody caught it. The projection had to
 *    be fixed because clouds are meaningless without it — a cloud nailed to the
 *    screen is a smudge on the lens — but it bought no beauty by itself, and
 *    saying otherwise would be the same overclaim NOTES.md keeps warning about.
 *
 * ── The clear sky is not touched, deliberately ──────────────────────────────
 *
 * `skyBase()` is a term-for-term port of `skyRadiance()` in env.ts, and it has
 * to stay one. Two things depend on it:
 *
 *   - `haze.ts` carries its own port of the same function, and distant geometry
 *     converges onto it. If the background sky and the haze sky disagree, every
 *     distant silhouette gets an outline — that is the hard-edged-orange-
 *     rectangle failure `haze.ts` spends forty lines on.
 *   - The null test. With `?sky=noclouds` the cube is `skyBase` and nothing
 *     else, and it can be differenced against the CPU texture it replaces.
 *
 * So every new colour in this file belongs to the clouds. The clear sky
 * arithmetic is copied, not edited.
 *
 * ── The cloud model, and why it is not a raymarch ───────────────────────────
 *
 * Three horizontal decks, each intersected analytically against a sphere of the
 * earth's radius, each shaded from a horizontal Beer's-law column through its
 * own 2D density field toward the sun. No march through a 3D field.
 *
 * The sun is at 4.2 degrees. That single fact makes the flat-deck model the
 * *right* one here rather than a cheap one: a beam entering the top of a 600 m
 * deck at 4.2 degrees travels 8.2 km horizontally before it reaches the base,
 * so the illumination of a cloud is overwhelmingly a function of what is in the
 * way of it *sideways*, which is precisely what a 2D field can answer exactly
 * and what a 32-step vertical march answers badly. It also delivers the two
 * cues the brief asks for at no cost:
 *
 *   perspective        the deck is a plane, so cells compress toward the
 *                      horizon on their own, at 1/sin(elevation), and the
 *                      sphere intersection stops that at a finite distance
 *                      instead of a singularity.
 *   directional light  a horizontal column integral through the density field
 *                      puts a long shadow behind every cell and leaves its
 *                      sunward face bright. That *is* the silver lining, and it
 *                      falls out rather than being painted.
 */
import * as THREE from 'three';
import { SUN_ELEV, SUN_BEAM_GROUND, SUN_DISC_EFOLD, SUN_DISC_PEAK } from './sun';

/* ── The atmosphere the numbers come from ────────────────────────────────────
 *
 * Nothing below is picked by eye. The colour of a cloud at golden hour is the
 * colour of the beam that reaches it, and that is set by how much air the beam
 * crossed — which depends on the cloud's altitude and on nothing else the scene
 * can argue about.
 *
 * Rayleigh optical depth at sea level, vertical, at the three primaries'
 * effective wavelengths (about 610 / 550 / 465 nm):  0.0303 / 0.0521 / 0.1177.
 * Aerosol: 0.10 at 550 nm with an Angstrom exponent of 1.3, giving
 * 0.0879 / 0.1000 / 0.1246. Scale heights 8.0 km and 1.2 km.
 *
 * That table is the whole colour design. The user asked for "warm orange on the
 * bottom, cooler purple-pink on top" and it is not a preference — it is what
 * Rayleigh does to a beam skimming the planet. Low cloud sees the reddest
 * possible sun; cirrus at 8 km is above two thirds of the scattering and sees a
 * beam that is still much closer to white.
 *
 * The absolute level is anchored to the light the scene already has, so the
 * clouds cannot end up lit by a different sun from the street: each deck's beam
 * is the key light's own linear colour, divided by the transmittance to the
 * ground and multiplied by the transmittance to that deck.
 *
 * ── Every number below is derived, and that is the point ────────────────────
 *
 * This file used to transcribe the sun three separate times — (115.0, 37.17,
 * 8.76) for the beam, sin(4.2 deg) for the path amplification, and a hand-typed
 * transmittance triple per deck — while the comment above claimed the clouds
 * could not be lit by a different sun from the street. Nothing enforced that.
 * It was true only because both numbers happened to say 4.2, and it stopped
 * being true the moment the sun moved: the street went to 12 degrees and the
 * sky would have stayed at 4.2, silently, with all three transcriptions still
 * reading correct and still typechecking.
 *
 * So SUN_ELEV is now the only input. Air mass comes from Kasten-Young, the
 * transmittances from the same exponential atmosphere the GLSL below uses, and
 * the beam from env.ts's SUN_BEAM_GROUND. The derivation reproduces the table
 * that used to be typed here to within a percent at 4.2 degrees, which is how
 * it was checked before the elevation was changed.
 */
const SIN_ELEV = Math.sin(SUN_ELEV);
const ELEV_DEG = SUN_ELEV * 180 / Math.PI;

/** Volume extinction coefficients per km at sea level, per channel. */
const SIGMA_R: [number, number, number] = [0.0303 / 8.0, 0.0521 / 8.0, 0.1177 / 8.0];
const SIGMA_A: [number, number, number] = [0.0879 / 1.2, 0.1000 / 1.2, 0.1246 / 1.2];
const H_RAY_KM = 8.0;
const H_AER_KM = 1.2;

/* Kasten-Young relative air mass. Plain 1/sin diverges at the horizon and is
 * already 8% wrong at four degrees, which at these optical depths is a visible
 * amount of red. */
const AIR_MASS = 1 / (SIN_ELEV + 0.50572 * Math.pow(ELEV_DEG + 6.07995, -1.6364));

/** Transmittance of the whole slant path from altitude `km` out to space. */
function sunTransmittance(km: number): [number, number, number] {
  const colR = H_RAY_KM * Math.exp(-km / H_RAY_KM) * AIR_MASS;
  const colA = H_AER_KM * Math.exp(-km / H_AER_KM) * AIR_MASS;
  return [0, 1, 2].map((i) =>
    Math.exp(-(SIGMA_R[i] * colR + SIGMA_A[i] * colA))) as [number, number, number];
}

const T_GROUND = sunTransmittance(0);
const beamAt = (km: number): [number, number, number] => {
  const T = sunTransmittance(km);
  return [
    SUN_BEAM_GROUND[0] * T[0] / T_GROUND[0],
    SUN_BEAM_GROUND[1] * T[1] / T_GROUND[1],
    SUN_BEAM_GROUND[2] * T[2] / T_GROUND[2],
  ];
};

const v3 = (c: readonly number[]) =>
  `vec3(${c[0].toFixed(6)}, ${c[1].toFixed(6)}, ${c[2].toFixed(6)})`;

/* ── The three decks ─────────────────────────────────────────────────────────
 *
 * Altitude, geometric thickness and peak vertical optical depth. The optical
 * depths are the textbook ones: cirrus is nearly transparent, altocumulus is a
 * few, a cumulus turret is tens.
 *
 * `sunKm` is the horizontal distance the beam covers inside the deck: the
 * thickness divided by sin(elevation). It is the length of the column integral
 * and it is why the three decks look so different from each other — and it is
 * also the single number that suffered most from raising the sun.
 *
 * At 4.2 degrees the amplification was 13.65x, so a 600 m altocumulus sheet
 * shadowed itself over 8.2 km — against 2.1 km cells, so the beam crossed four
 * of them and the sunward flank of each was lit while its far side was not.
 * That cross-cell shadowing is the entire reason the decks read as volumes and
 * not as a stencil. At 12 degrees the amplification is 4.81x, 2.8 times
 * shorter: the beam now crosses roughly one cell and the flanks flatten out.
 *
 * The compensation is depth, and it is the honest lever rather than a fudge.
 * These thicknesses were never measured off anything — 300 / 600 / 800 m are
 * plausible numbers I picked — and the higher sun is a reason to pick different
 * plausible numbers. Deepening a deck lengthens the beam's path through it,
 * which is the quantity that actually got shorter, and 850 m of cirrus, a 1.6 km
 * altocumulus castellanus and a 2.2 km cumulus congestus are all ordinary. The
 * new paths are 4.09 / 7.70 / 10.58 km against the old 4.10 / 8.19 / 10.92, so
 * the shadowing structure comes back almost exactly.
 *
 * The optical depths go up with them, but by less than the depth does. Holding
 * density fixed would have doubled tau, and tau also sets how opaque the deck
 * is on screen: alto at tau 9 has almost no gaps left, and the gaps are what
 * make it read as cloud in front of sky rather than as an overcast lid. So the
 * depths take back some of the lost self-shadowing magnitude and deliberately
 * not all of it — the structure matters more than the contrast, and the decks
 * are less dense per metre at 12 degrees than they were at 4.2, which is a
 * thing clouds are allowed to be.
 */
type Deck = {
  name: string;
  km: number;        // altitude
  thickKm: number;   // geometric thickness
  tau: number;       // peak vertical optical depth
  sunKm: number;     // horizontal light path inside the deck
  beam: [number, number, number];
};

/** Horizontal distance per unit of vertical depth, along the beam. */
const PATH_MUL = 1 / SIN_ELEV;

const deck = (name: string, km: number, thickKm: number, tau: number): Deck => ({
  name, km, thickKm, tau, sunKm: thickKm * PATH_MUL, beam: beamAt(km),
});

const DECKS: Deck[] = [
  //             altitude  thickness  tau     (was 0.30 / 0.60 / 0.80 at 4.2 deg)
  deck('cirrus', 8.0, 0.85, 0.55),
  deck('alto', 4.2, 1.60, 6.0),
  deck('cumulus', 1.5, 2.20, 13.0),
];

/* Ambient — what lights the parts of a cloud the sun cannot reach.
 *
 * Two hemispheres, and they are not alike at this hour.
 *
 * Looking up, a cloud top sees the sky dome. `tools/skyprobe.mjs` integrates
 * exactly that: the cosine-weighted irradiance on an upward-facing surface is
 * E = (0.5045, 0.5087, 1.1332), and for a conservative scatterer the outgoing
 * radiance is E/pi = (0.161, 0.162, 0.361). Blue-violet, and measured rather
 * than chosen — then carried through the same Chappuis factor the dome is,
 * (1.34, 0.56, 1.13), giving (0.216, 0.091, 0.408). The probe it came from has
 * no ozone in it, so leaving it unfiltered would light cloud tops with a sky
 * that is no longer above them.
 *
 * Looking down, a cloud base sees the ground and the lower atmosphere. Ground
 * albedo 0.15 against the sun's horizontal irradiance of 115 x sin(4.2) = 8.42
 * gives 0.15 x 8.42 / pi = 0.402 in the sun's own colour ratio, i.e.
 * (0.402, 0.130, 0.031); the lower atmosphere adds about half the anti-sun
 * horizon radiance, (0.100, 0.100, 0.155). Warm, dim, and the reason a
 * shadowed cloud base at sunset is brown-mauve rather than grey.
 *
 * Held at 0.47x that figure, and the reduction is the correction of a real
 * error rather than a taste adjustment. Albedo 0.15 over the whole lower
 * hemisphere is a bright desert; the ground under this deck is wet asphalt,
 * brick and a great deal of shadow, and it fills perhaps half the hemisphere
 * that is not already sky. It matters because the term is a constant: at the
 * full figure it was larger than the direct light reaching a self-shadowed
 * altocumulus core, so every cloud in the frame came out at the same brightness
 * and the same colour, and a diagnostic that varied deck thickness by a factor
 * of five changed the image by nothing that could be seen. Ambient is supposed
 * to be the floor, not the picture.
 */
const AMB_TOP: [number, number, number] = [0.216, 0.091, 0.408];
const AMB_BASE: [number, number, number] = [0.235, 0.108, 0.087];
/* Plus a share of the sky immediately behind the cloud, which is the term that
 * keeps a cloud sitting *in* the sky rather than on top of it. */
const AMB_SKY = 0.16;

/* ── Multiple scattering ─────────────────────────────────────────────────────
 *
 * Single scattering through a cloud with a horizontal optical depth of forty is
 * exactly zero, and a sky made of single scattering at this sun elevation is a
 * row of black silhouettes with white edges. Real cloud is a conservative
 * scatterer: the light is not absorbed, it is redistributed, and an optically
 * thick cumulus lit from the side still glows several optical depths in.
 *
 * The standard cheap model for that (Wrenninge et al.) is to sum a few
 * "octaves" of scattering, each with less energy, a flatter phase function and
 * a smaller effective extinction:
 *
 *   L = sum_n  a^n . beam . P(mu, g.b^n) . exp( -c^n . tau_sun )
 *
 * a = 0.36, b = 0.58, c = 0.28, four octaves. c is the one that matters: at
 * n = 3 the effective optical depth is 2.2% of the true one, so a column that
 * blocks single scattering by e^-40 still passes e^-0.9 of the fourth octave at
 * 7% weight. That is the glow.
 */
const MS_OCTAVES = 4;
const MS_A = 0.36, MS_B = 0.58, MS_C = 0.28;
const HG_G = 0.76;

const NOISE_GLSL = /* glsl */ `
/* Value noise. The hash is the three-component one from world/glsl.ts, copied
 * rather than imported because glsl.ts belongs to another pass this week; the
 * reason it is that shape rather than the usual two-component form is recorded
 * there — the two-component version leaves neighbouring cells correlated along
 * the 45 degree diagonal and lays a woven cross-hatch over everything that uses
 * it, which on a cloud field would read as a fabric texture in the sky. */
float chash(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float cnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = chash(i);
  float b = chash(i + vec2(1.0, 0.0));
  float c = chash(i + vec2(0.0, 1.0));
  float d = chash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/* Rotation per octave, because an axis-aligned lattice summed straight up
 * leaves visible north-south and east-west grain in a field this smooth. */
const mat2 CROT = mat2(0.8, 0.6, -0.6, 0.8);

float cfbm(vec2 p, int oct){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 7; i++){
    if (i >= oct) break;
    s += a * cnoise(p);
    n += a;
    p = CROT * p * 2.02 + 17.3;
    a *= 0.5;
  }
  return s / max(n, 1e-4);
}

/* Billow: |2n-1| inverted. Rounded lumps with creases between them, which is
 * what a cumuliform cell looks like and what plain fbm cannot produce. */
float cbillow(vec2 p, int oct){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 7; i++){
    if (i >= oct) break;
    s += a * (1.0 - abs(2.0 * cnoise(p) - 1.0));
    n += a;
    p = CROT * p * 2.03 + 9.1;
    a *= 0.5;
  }
  return s / max(n, 1e-4);
}
`;

/** The clear sky, term for term from `skyRadiance()` in env.ts. */
const SKY_GLSL = /* glsl */ `
/* The solar disc, kept separate from the rest of the dome.
 *
 * env.ts already bakes two skies for the same reason — the disc belongs in what
 * the camera sees and must stay out of the light probe — and the clouds need
 * the same split for a third reason: a cloud crossing the sun is lit by the
 * beam through its own body, not by two hundred units of disc radiance added to
 * its ambient term. Feeding the disc into the cloud's fill light puts a
 * two-hundred-unit smear on any cell that happens to be in front of it. */
vec3 sunDisc(vec3 dir){
  float ang = acos(clamp(dot(dir, uSun), -1.0, 1.0));
  return exp(-ang * uDiscEfold) * uDiscPeak;
}

vec3 skyRaw(vec3 dir, float withDisc){
  float up = dir.y;
  vec2 fz = dir.xz;
  float azW = pow(max(0.0, 0.5 + 0.5 * (
    dot(fz, uSun.xz) / max(1e-4, length(fz) * length(uSun.xz)))), 4.6);

  const vec3 zenith      = vec3(0.0850, 0.1300, 0.3600);
  const vec3 upperWarm   = vec3(0.7400, 0.3900, 0.3450);
  const vec3 horizonSun  = vec3(3.4000, 1.4200, 0.4200);
  const vec3 horizonAway = vec3(0.2000, 0.2000, 0.3100);

  float band = pow(max(0.0, 1.0 - max(up, 0.0)), 5.6);
  float mid  = pow(max(0.0, 1.0 - max(up, 0.0)), 2.30);

  vec3 horizonC = mix(horizonAway, horizonSun, azW);
  vec3 base = mix(zenith, upperWarm, mid * (0.14 + 0.86 * azW));
  vec3 col = mix(base, horizonC, band);

  float ang = acos(clamp(dot(dir, uSun), -1.0, 1.0));
  float halo = exp(-ang * 5.6) * 0.45 + exp(-ang * 19.0) * 5.60;
  col += halo * vec3(1.60, 0.86, 0.34);

  col += withDisc * exp(-ang * uDiscEfold) * uDiscPeak;

  if (up < 0.0){
    float d = min(1.0, -up * 1.15);
    vec3 gnd = col * vec3(0.52, 0.50, 0.54) + vec3(0.030, 0.024, 0.026);
    col = mix(col, gnd, d * 0.85);
  }
  return col;
}

/* ── Ozone, the Chappuis band ────────────────────────────────────────────────
 *
 * The clear-sky model above is an empirical gradient with no absorber in it,
 * and the measurement says exactly what that costs: tools/skyband.mjs put the
 * zenith at hue 219 and the 46-60 degree band at 17% saturation — blue-grey,
 * and grey is the word. It is the standard signature of a sky built out of
 * Rayleigh and aerosol alone at low sun, and the missing term is ozone.
 *
 * Ozone's Chappuis band is a broad, weak absorption centred near 600 nm. It
 * therefore eats the middle of the spectrum and leaves both ends: the vertical
 * optical depth is only a few hundredths, but the light illuminating the upper
 * air at four degrees of sun elevation arrives along a nearly tangential path
 * of fifteen-odd air masses, so the middle gets a real bite taken out of it.
 * What survives at the zenith is red — from a beam that has already lost its
 * blue over that same path — plus blue, which Rayleigh's lambda^-4 preference
 * keeps putting back. Red and blue with the green pulled out of the middle is
 * violet, and that is why a clear zenith at this hour is not grey.
 *
 * Two gates, and both of them are about not lying:
 *
 *   - Elevation. The tint ramps in between about 3.4 and 37 degrees and is
 *     exactly 1.0 below that. Near the horizon the radiance is dominated by
 *     short-path aerosol forward scattering, which is warm and barely ozoned,
 *     so the physics wants identity there anyway — and so does haze.ts, which
 *     carries its own port of the untinted function and meets this sky exactly
 *     where distant geometry fades into it. The handoff stays bit-exact.
 *   - Distance from the sun. The aureole is single-scattered light that has
 *     travelled the shortest path in the hemisphere. Tinting it would turn the
 *     warm band the user explicitly asked for into magenta.
 *
 * The strength is authored, not derived: (1.34, 0.56, 1.13) is where
 * tools/agx.mjs says the displayed 46-60 degree band reaches the pink the brief
 * asks for without going candied. It darkens by about 22% in luminance, which
 * is the right direction — ozone is an absorber, and the upper sky at golden
 * hour is darker than the model had it.
 */
vec3 chappuis(vec3 col, vec3 dir){
  float ang = acos(clamp(dot(dir, uSun), -1.0, 1.0));
  float w = smoothstep(0.06, 0.60, dir.y) * smoothstep(0.30, 0.90, ang);
  return col * mix(vec3(1.0), vec3(1.34, 0.56, 1.13), w);
}

/* The sky as it is drawn. skyRaw() is the port and stays the port; everything
 * downstream — the clouds' fill light, their aerial perspective, the gaps
 * between them — reads this one, so there is exactly one sky in the frame. */
vec3 skyBase(vec3 dir, float withDisc){
  return chappuis(skyRaw(dir, withDisc), dir);
}
`;

function cloudGlsl(): string {
  return /* glsl */ `
const float EARTH_R = 6371.0;          // km
const vec3  SIGMA_R = ${v3(SIGMA_R)};  // per km at sea level
const vec3  SIGMA_A = ${v3(SIGMA_A)};
const float H_RAY = 8.0;               // km
const float H_AER = 1.2;               // km

/* Distance along 'dir' from an observer at sea level to a shell at altitude h.
 *
 * Flat-plane clouds are the right parameterisation and a flat *earth* is not:
 * h/dir.y goes to infinity at the horizon, which puts an unbounded amount of
 * noise lattice into the last row of pixels and aliases into a hard band. The
 * sphere gives the deck a real edge — 226 km for a 4.2 km deck — and costs one
 * sqrt. */
float shellDist(vec3 dir, float h){
  float b = EARTH_R * dir.y;
  return -b + sqrt(b * b + 2.0 * EARTH_R * h + h * h);
}

/* Transmittance of the air between the observer and altitude h along 'dir'.
 *
 * The column of an exponential-density atmosphere along a slanted ray, using
 * the sphere's own path length so it saturates at the horizon rather than
 * diverging. This is what makes clouds fade into the horizon glow instead of
 * standing in front of it — and it is the term that keeps the cloud deck from
 * disagreeing with haze.ts, because at full extinction the deck converges on
 * exactly the same skyBase() that the haze converges on. */
vec3 airTransmittance(float dist, float h){
  float perKm = dist / max(h, 1e-3);
  float colR = H_RAY * (1.0 - exp(-h / H_RAY)) * perKm;
  float colA = H_AER * (1.0 - exp(-h / H_AER)) * perKm;
  return exp(-(SIGMA_R * colR + SIGMA_A * colA));
}

/* Henyey-Greenstein, normalised so an isotropic scatterer returns 1.0. */
float hg(float mu, float g){
  float d = 1.0 + g * g - 2.0 * g * mu;
  return (1.0 - g * g) / max(d * sqrt(d), 1e-4);
}

/* ── Coverage fields ─────────────────────────────────────────────────────────
 *
 * One function per deck, in kilometres, taking the point where the view ray
 * crosses the deck. Each is a large-scale mask deciding *where there is any
 * cloud at all* times a small-scale field giving the cells inside it. The mask
 * is what stops a single fbm layer reading as "noise" — real sky has clear gaps
 * of tens of kilometres, and a threshold on one octave sum does not produce
 * them.
 */
/* Fringe erosion.
 *
 * A threshold on a smooth field gives a smooth boundary, and a smooth boundary
 * is the single loudest tell that a sky was drawn rather than photographed:
 * the cloud read as paper cut-outs in the third bake even once the radiance was
 * right, because every edge in the frame was a clean smoothstep ramp. Real
 * cloud edges are torn at every scale, because the cell is evaporating into the
 * air around it and does so unevenly.
 *
 * So subtract a high-frequency field weighted by 4c(1-c) — a bump that is zero
 * in the clear sky and zero in the solid core and peaks exactly on the fringe.
 * The core keeps its shape, the clear gaps stay clear, and only the boundary
 * gets chewed. The cost is one three-octave fbm per coverage evaluation, and
 * coverage is evaluated thirteen times per deck per texel — which is free,
 * because all of it happens once into a cube at startup and never again.
 *
 * Declared here, above its callers, and not because of style: ESSL has no
 * implicit declarations, and putting it below cov* cost a whole capture cycle
 * to "'erode': no matching overloaded function found" — a sky that compiled to
 * nothing, shipped a black background, and would have been invisible to anyone
 * reading the diff.
 */
float erode(float c, vec2 p, float scale, float amount){
  float band = 4.0 * c * (1.0 - c);
  return clamp(c - amount * band * cfbm(p * scale + 55.7, 3), 0.0, 1.0);
}

float covCirrus(vec2 p){
  /* Sheared and stretched 4:1 along the wind, and the shear is the whole
   * character of cirrus: it is ice falling out of a shear layer, so it comes in
   * long fibrous streaks rather than in cells. */
  vec2 q = CROT * p;
  vec2 s = vec2(q.x / 18.0, q.y / 6.0);
  float body = cfbm(s, 5);
  // Ridged, for the fibres. 1 - |2n-1| concentrates value along crest lines.
  float fibre = 1.0 - abs(2.0 * cfbm(s * vec2(2.1, 3.4) + 31.7, 4) - 1.0);
  return erode(smoothstep(0.56, 0.80, body * 0.55 + fibre * 0.45), q, 0.55, 0.85);
}

float covAlto(vec2 p){
  /* Altocumulus: a broad sheet broken into individual cells at a 2 km pitch.
   * The mask and the cells are deliberately at very different scales — a
   * fifteen-kilometre patch of sky either has the sheet in it or does not, and
   * where it does, the sheet is granular. */
  float mask = smoothstep(0.48, 0.72, cfbm(p / 15.0 + 4.2, 4));
  float cells = cbillow(p / 2.1 + 61.0, 5);
  return erode(mask * smoothstep(0.34, 0.72, cells), p, 1.10, 0.80);
}

float covCumulus(vec2 p){
  /* Low scattered cumulus. Sparse — a high mask threshold leaves most of the
   * deck empty — and small, so that perspective piles them into a band near
   * the horizon, which is where low cloud actually appears from the ground. */
  float mask = smoothstep(0.54, 0.76, cfbm(p / 22.0 + 88.0, 4));
  float puff = cbillow(p / 2.7 + 12.0, 5);
  return erode(mask * smoothstep(0.38, 0.74, puff), p, 0.85, 0.75);
}

float coverage(int deck, vec2 p){
  if (deck == 0) return covCirrus(p);
  if (deck == 1) return covAlto(p);
  return covCumulus(p);
}

/* Deck geometry, unrolled rather than tabulated.
 *
 * ESSL 1.00 — which is what a ShaderMaterial without an explicit 'glslVersion'
 * compiles as, on WebGL2 as much as on WebGL1 — has no array constructors and
 * no const arrays, so a 'for (i = 0..2)' over a table of altitudes does not
 * compile. Three calls with literal arguments is the same code and one fewer
 * thing to be wrong about. */

/* ── One deck, shaded ────────────────────────────────────────────────────────
 *
 * Returns the deck's own outgoing radiance and its opacity along the view ray.
 */
vec3 shadeDeck(int deck, vec2 p, float cov, float tauMax, float sunKm,
               vec3 beam, vec3 sky, float mu, float viewStretch,
               out float alpha){
  float tauView = tauMax * cov * viewStretch;
  alpha = 1.0 - exp(-tauView);
  if (alpha < 0.002) return vec3(0.0);

  /* The light path, horizontally, through the deck's own density field.
   *
   * Twelve taps over sunKm, trapezoid-weighted — twelve rather than four
   * because the cells are 2.1 km against an 8.2 km path, so four taps alias the
   * gaps that are the whole reason any of this deck is lit. The mean coverage
   * times tauMax times (sunKm / thickness) is the optical depth the beam sees;
   * since sunKm is *defined* as thickness / sin(elevation), that factor is just
   * 1 / sin(elevation), and it is written as sunKm/thickness nowhere because
   * thickness never has to appear. It is generated from SUN_ELEV rather than
   * typed: it read 13.66 as a literal in this string, and a literal here is a
   * sky that goes on shadowing itself at four degrees after the street has
   * moved to twelve. */
  vec2 step = uSunFlat * (sunKm / 12.0);
  float acc = 0.0;
  for (int i = 1; i <= 12; i++){
    acc += coverage(deck, p + step * float(i));
  }
  float meanCov = (cov * 0.5 + acc) / 12.5;
  float tauSun = tauMax * meanCov * ${PATH_MUL.toFixed(4)};

  /* Multiple scattering, four octaves — gated on the cloud actually being thick
   * enough to scatter more than once.
   *
   * This gate is the whole difference between the first version of this file and
   * this one, and it was a measured failure rather than a theoretical one: the
   * first bake put a sheet of flat white paper across the top of the frame. The
   * octave sum is Wrenninge's, and it is derived for optically thick media; the
   * n-th term stands for light that has scattered n times. Applied unconditionally
   * it hands a cirrus veil of vertical optical depth 0.3 the same fourth-order
   * glow as a cumulus turret of fourteen, which multiplied the veil's radiance by
   * eight and a half over its single-scattering value and blew it to white.
   *
   * Light cannot scatter n times in a medium it passes straight through, so each
   * octave is weighted by the probability that it interacted at all, raised to
   * the order: p = 1 - exp(-tauCloud), p^n. Vertical tau rather than the view's,
   * so that a grazing ray does not manufacture scattering orders out of its own
   * path length. For the cumulus deck p is 0.9998 and this changes nothing; for
   * cirrus it is 0.4 and the fourth octave loses 97% of its weight, which is what
   * turns the sheet of paper back into a translucent pink veil. */
  float pMS = 1.0 - exp(-tauMax * cov);
  vec3 direct = vec3(0.0);
  float a = 1.0, b = 1.0, c = 1.0;
  for (int n = 0; n < ${MS_OCTAVES}; n++){
    direct += beam * (a * hg(mu, ${HG_G.toFixed(3)} * b) * exp(-c * tauSun));
    a *= ${MS_A.toFixed(3)} * pMS; b *= ${MS_B.toFixed(3)}; c *= ${MS_C.toFixed(3)};
  }
  direct *= 0.0795774715;                       // 1 / 4pi

  /* Ambient. Thin cloud is lit through from above and reads cool; thick cloud
   * only shows its base. 'cov' is the switch between the two, and it is the
   * reason the edges of a cell go cool-pink while its middle stays brown. */
  vec3 amb = mix(${v3(AMB_TOP)}, ${v3(AMB_BASE)}, smoothstep(0.05, 0.55, cov))
           + sky * ${AMB_SKY.toFixed(3)};

  return direct + amb;
}

/* ── The sky, with the decks in it ───────────────────────────────────────────
 *
 * Composited far to near — cirrus, then altocumulus, then cumulus — because
 * that is the order they occlude each other in, and each deck's radiance is
 * aerial-perspectived onto the clear sky before it is composited so that a deck
 * approaching the horizon converges on the sky rather than on a grey band.
 */
/** Composite one deck over whatever is already behind it. */
vec3 overDeck(vec3 col, int deck, vec3 dir, vec3 sky, float mu,
              float h, float tauMax, float sunKm, vec3 beam){
  float dist = shellDist(dir, h);
  vec2 p = dir.xz * dist;                  // where the ray crosses the deck, km

  /* Path length through the deck relative to its thickness. Clamped: a ray
   * within a degree of the horizon would otherwise be handed a stretch of
   * eight hundred, and a 2D field has no honest answer for a ray that long —
   * the air in front of it has already extinguished it anyway. */
  float stretch = min(1.0 / max(dir.y, 1e-3), 7.0);

  /* Thickness, modulated on a scale much larger than the cells.
   *
   * Coverage saturates: over the core of any cell it is 1.0, so tauMax x cov is
   * the same number over every core in the deck and every core came out at the
   * same brightness. A real deck is not of uniform depth — one part of the sheet
   * is two hundred metres of it and glows straight through, another is a
   * kilometre and is a dark bruise with a lit rim, and the alternation between
   * the two happens over ten kilometres rather than over one cell. Three octaves
   * at 9 km, spanning 0.35x to 1.65x, and it is the cheapest tonal variety in
   * the file. */
  float thick = 0.35 + 1.30 * cfbm(p / 9.0 + 130.0, 3);
  tauMax *= thick;

  float cov = coverage(deck, p);
  float alpha;
  vec3 L = shadeDeck(deck, p, cov, tauMax, sunKm, beam, sky, mu, stretch, alpha);

  vec3 T = airTransmittance(dist, h);
  vec3 seen = L * T + sky * (1.0 - T);
  return mix(col, seen, alpha);
}

vec3 skyWithClouds(vec3 dir, float withDisc){
  /* Two skies again, for the third time in this project and the same reason
   * each time. 'sky' is the dome without the disc: it is what fills the
   * clouds, what the air between the camera and each deck scatters, and what a
   * deck converges on at the horizon. The disc is added underneath everything
   * so that a cloud in front of the sun occludes it.
   *
   * withDisc is 0 when this bake is going to be convolved into the light
   * probe rather than looked at. The decomposition is env.ts's and is argued
   * there: the directional light already carries the disc, with hard shadows,
   * so putting it in the probe as well counts it twice and fills every shadow
   * in the scene. The clouds themselves stay, because they are the dome — a
   * deck over the sun is genuinely what a shadow-side wall is being lit by. */
  vec3 sky = skyBase(dir, 0.0);
  vec3 col = sky + withDisc * sunDisc(dir);
  if (dir.y <= 0.0) return col;

  float mu = clamp(dot(dir, uSun), -1.0, 1.0);
${DECKS.map((d, i) => `  col = overDeck(col, ${i}, dir, sky, mu, ${d.km.toFixed(3)}, ` +
    `${d.tau.toFixed(3)}, ${d.sunKm.toFixed(3)}, ${v3(d.beam)});`).join('\n')}
  return col;
}
`;
}

const VERTEX = /* glsl */ `
varying vec3 vWorldDirection;
void main(){
  vWorldDirection = normalize((modelMatrix * vec4(position, 0.0)).xyz);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

function fragment(
  sun: readonly number[], withClouds: boolean, withDisc: boolean, discScale: number,
): string {
  const flat = Math.hypot(sun[0], sun[2]);
  return /* glsl */ `
precision highp float;
varying vec3 vWorldDirection;

const vec3 uSun = ${v3(sun)};
/* The sun's direction projected onto the deck plane and renormalised. This is
 * the direction a shadow runs in, and at 4.2 degrees of elevation it is very
 * nearly the sun direction itself. */
const vec2 uSunFlat = vec2(${(sun[0] / flat).toFixed(6)}, ${(sun[2] / flat).toFixed(6)});

/* The disc, generated from sun.ts rather than typed. It was two literals in
 * two files, one of which was this one, and the peak is now derived from the
 * key light's own irradiance — so a change to SUN_INTENSITY moves the painted
 * sun with it instead of leaving it correct-looking and wrong. */
const float uDiscEfold = ${SUN_DISC_EFOLD.toFixed(1)};
const vec3 uDiscPeak = ${v3(SUN_DISC_PEAK.map((c) => c * discScale))};

${NOISE_GLSL}
${SKY_GLSL}
${cloudGlsl()}

void main(){
  vec3 dir = normalize(vWorldDirection);
  /* ?sky=noclouds draws skyRaw, not skyBase, and deliberately: it is the null
   * test for the projection change and has to stay comparable with ?sky=flat,
   * which is the CPU equirect and has no ozone in it either. Differencing the
   * two still isolates the cube, and nothing else. */
  vec3 col = ${withClouds
    ? `skyWithClouds(dir, ${withDisc ? '1.0' : '0.0'})`
    : `skyRaw(dir, ${withDisc ? '1.0' : '0.0'})`};
  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;
}

export type SkyCube = {
  texture: THREE.CubeTexture;
  dispose(): void;
};

/**
 * Render the sky, with or without clouds, into a cube render target.
 *
 * A cube rather than an equirect because three only direction-maps a cube — see
 * the header. Rendered through three's own `CubeCamera` for the same reason:
 * the face convention is not something this file should be re-deriving.
 *
 * @param size edge of one cube face. 1024 is 11.4 texels per degree, against
 *   the 20 pixels per degree a 900-line frame at fov 45 delivers. Clouds have
 *   no hard edges so a 1.75x magnification of a smooth field is invisible; the
 *   solar disc, whose e-folding angle is 0.38 degrees, lands on four texels and
 *   is properly resolved for the first time.
 */
export function bakeSkyCube(
  renderer: THREE.WebGLRenderer,
  sun: readonly number[],
  opts: { size?: number; clouds?: boolean; disc?: boolean; discScale?: number } = {},
): SkyCube | null {
  const size = opts.size ?? 1024;
  const clouds = opts.clouds ?? true;
  /* Default true, because the caller that draws this is the one that existed
   * first. `disc: false` is the light probe's bake; see skyWithClouds. */
  const disc = opts.disc ?? true;
  /* A dev-only sweep multiplier, owned by env.ts because that is where the
   * URL is read. 1 in production, by construction. */
  const discScale = opts.discScale ?? 1;

  /* Nothing below this line may throw out of this function.
   *
   * This is not defensive programming for its own sake, it is a bill that has
   * already been paid. An earlier revision timed the bake by reading one texel
   * back, and `readRenderTargetPixels` against a cube target without a face
   * index binds an invalid framebuffer and throws. `makeNightEnv` is called
   * from `Street`'s `useMemo`, which runs during render, so the throw came out
   * through React and took the whole app down — on the shared dev server, which
   * every agent and the user is looking at. One agent lost a session to it and
   * had to stand up a second server on another port.
   *
   * The specific bug is gone. The shape of it is not: four people are editing
   * this tree at once and Fast Refresh will re-enter this function at moments
   * nobody chose — mid-teardown, with a lost context, with a renderer whose
   * target stack is not where this code left it. So the contract is that a bake
   * which cannot be completed returns null and env.ts falls back to the
   * equirect. A sky that is flat for one reload is a cosmetic problem. A sky
   * that throws is everybody's problem.
   */
  const gl = renderer.getContext();
  if (gl.isContextLost()) return null;

  let rt: THREE.WebGLCubeRenderTarget | null = null;
  let material: THREE.ShaderMaterial | null = null;
  let mesh: THREE.Mesh | null = null;
  try {
  rt = new THREE.WebGLCubeRenderTarget(size, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.NoColorSpace,
    generateMipmaps: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  });
  rt.texture.type = THREE.HalfFloatType;
  rt.texture.colorSpace = THREE.NoColorSpace;
  rt.texture.minFilter = THREE.LinearFilter;
  rt.texture.magFilter = THREE.LinearFilter;
  rt.texture.generateMipmaps = false;

  material = new THREE.ShaderMaterial({
    name: 'ProceduralSkyCube',
    vertexShader: VERTEX,
    fragmentShader: fragment(sun, clouds, disc, discScale),
    side: THREE.BackSide,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NoBlending,
    /* No tone mapping and no output encode: this shader includes neither
     * chunk, so what lands in the half-float target is scene radiance. The
     * transform is applied once, later, by three's backgroundCube shader. */
    toneMapped: false,
    fog: false,
  });

  mesh = new THREE.Mesh(new THREE.BoxGeometry(5, 5, 5), material);
  const camera = new THREE.CubeCamera(1, 10, rt);
  const prev = renderer.getRenderTarget();
  const t0 = performance.now();
  camera.update(renderer, mesh as unknown as THREE.Scene);
  renderer.setRenderTarget(prev);
  /* Drain the queue before reading the clock. The six face draws are submitted,
   * not finished, when update() returns, and timing a command buffer being
   * filled is worse than not timing at all. Skipped rather than risked if the
   * context went away underneath the draws. */
  if (!gl.isContextLost()) gl.finish();
  /* Left on a global rather than logged, so that tools/skycloud.mjs can report
   * it beside the fps it measures. The harness collects page errors and
   * warnings; an info line would not have reached it, which is how the first
   * version of this measurement came back empty. */
  (globalThis as { __skyBakeMs?: number }).__skyBakeMs = performance.now() - t0;

  /* The derived sun, published so the coupling can be *read* rather than
   * believed. Everything here was a hand-typed literal until the sun moved, and
   * the way a reader checks that it is no longer a literal is to change SUN_ELEV
   * and watch these numbers follow. tools/frontage.mjs asks the light for its
   * own elevation for the same reason. Three numbers, once per bake. */
  (globalThis as { __skyDeckSun?: unknown }).__skyDeckSun = {
    elevDeg: (SUN_ELEV * 180) / Math.PI,
    pathMul: PATH_MUL,
    airMass: AIR_MASS,
    beamGround: SUN_BEAM_GROUND,
    decks: DECKS.map((d) => ({
      name: d.name, km: d.km, thickKm: d.thickKm, tau: d.tau,
      sunKm: d.sunKm, beam: d.beam,
    })),
  };

  mesh.geometry.dispose();
  material.dispose();
  mesh = null;
  material = null;

  const target = rt;
  let disposed = false;
  return {
    texture: target.texture,
    /* Idempotent, because COLDSTART.md §4.1 records this project losing its
     * environment to exactly the opposite ordering: Fast Refresh preserved a
     * `useMemo` while still running the effect cleanup, so teardown ran against
     * a value the next render then reused. A second dispose() must be a no-op
     * rather than a second `rt.dispose()` on a target three has already
     * forgotten. */
    dispose() {
      if (disposed) return;
      disposed = true;
      target.dispose();
    },
  };
  } catch (err) {
    /* Warn rather than swallow. A silent fallback is how this codebase loses a
     * week to a term that is present and inert; the sky going flat with no
     * explanation in the console would be precisely that. */
    console.warn('[sky] cube bake failed, falling back to the equirect:', err);
    try { mesh?.geometry.dispose(); } catch { /* teardown must not throw */ }
    try { material?.dispose(); } catch { /* teardown must not throw */ }
    try { rt?.dispose(); } catch { /* teardown must not throw */ }
    return null;
  }
}

/** For tools: the deck table, so a report does not have to transcribe it. */
export const CLOUD_DECKS = DECKS;
