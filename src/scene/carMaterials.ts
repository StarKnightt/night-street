/* System 4 materials: paint, glazing, wheels and the dark under the car.
 *
 * ── The one structural decision ──────────────────────────────────────────
 *
 * Every reflective surface here substitutes its own resolved reflection for
 * the environment probe, and does it by replacing what three feeds *into* its
 * BRDF rather than by overwriting what comes out of it.
 *
 * The probe is a sky. It does not know there is a building eleven metres
 * opposite, so a car flank left to the probe mirrors a blazing amber horizon
 * and comes back as a featureless bright smear — the same failure the building
 * windows and then the shopfront glazing shipped twice. The fix that project
 * arrived at was to hand-resolve the ray, and the trap it fell into both times
 * was handing that resolved *radiance* to three as a specular colour, where it
 * multiplies the probe instead of replacing it and the pane ends up tracking
 * the sky behind the camera.
 *
 * So nothing below touches `specularColor`, and nothing overwrites
 * `reflectedLight.indirectSpecular`. `<lights_fragment_maps>` is where three
 * computes `radiance` and `clearcoatRadiance` from the probe, one include
 * before it uses them, and that is where they are replaced. Three then applies
 * its own Schlick and its own energy compensation to a radiance that is
 * actually what the ray hit. There is exactly one Fresnel in the chain and it
 * is three's.
 *
 * ── What the reflection contains ─────────────────────────────────────────
 *
 * The most recent note on the shopfront glass is that reflected *energy* is
 * not a reflected *image*: the pane went from near-black to correctly bright
 * and still failed, because what it was bright with was a smooth warm veil.
 * `streetProbe` below returns a horizon line, a road below it, a frontage with
 * storey banding and window bays in it, a bright block where the sunlit wall
 * above the shade line lands, a sky gradient with the aerosol halo in it, and
 * aerial perspective over the length of the reflected path. On a curved body
 * panel that image compresses and bends, and that compression is itself most
 * of what says "this is a car and not a grey shape".
 *
 * ── What is deliberately not here ────────────────────────────────────────
 *
 * No emissive tail lights. The scene is an hour before sunset and a
 * retroreflector returns light towards its source, which at this hour means
 * nothing at all: a rear cluster is deep saturated red plastic with a fine
 * prism structure behind it, and it is *darker* than the paint around it, not
 * brighter. The one exception is the single car with its sidelights on, which
 * is dusk-appropriate and in the brief; even that is authored at a seventh of
 * the level of sunlit brick, because a 5 W bulb behind a red lens in daylight
 * is a dull coal and not a lamp.
 */
import * as THREE from 'three';
import { NOISE, CANYON } from '@/world/glsl';
import { SUN_DIR, HORIZON_SUNWARD, HORIZON_AWAY } from './env';
import { BUILD_LINE } from '@/world/block';
import { FACADE_VARYINGS, FACADE_VERTEX, FACADE_NORMAL } from './buildingMaterials';

/* Where every body below hooks in.
 *
 * The same reasoning as System 3's: <roughnessmap_fragment> is the intuitive
 * place and it is wrong for anything that also writes metalness, because
 * `metalnessFactor` is declared one include later and a write to it from
 * earlier is a link failure. A link failure in this project renders as a flat
 * untextured surface and reads as a lighting bug. */
const HOOK = '#include <metalnessmap_fragment>';

/* The globals every body writes into, shared with the surface tail below. */
const CAR_PARS = /* glsl */ `
${FACADE_VARYINGS}
varying vec2 vFuv;
uniform vec3 uSun;
uniform float uBuildLine;
uniform vec3 uHorizonSun;
uniform vec3 uHorizonAway;
vec2 gSlope = vec2(0.0);
float gAO = 1.0;
vec3 gEmit = vec3(0.0);
/** Substituted for the environment probe; see the note at the top. */
vec3 gRefl = vec3(0.0);
/** The same ray at the clearcoat's own roughness, which is far sharper. */
vec3 gReflC = vec3(0.0);
float gReflBlur = 0.0;
/** Set by the wheel body on the flat the tyre is squashed onto. */
float gPatch = 0.0;
/* A tilt of the shaded normal toward world up, in the same units as a slope.
 *
 * gSlope works in the surface's own tangent frame, which is the right frame
 * for anything drawn against the uv grid and the wrong one for a body crease:
 * a shoulder line runs horizontally around a car whose tangents are following
 * the loft, so the same feature would need a different pair of gSlope
 * components on the door, the wing and the quarter panel. A crease is a tilt
 * about the horizontal wherever it appears, so it is stated as one. */
float gTiltY = 0.0;
/** Sky occlusion on the mirror term, as gAO is on the diffuse one. */
float gSpecAO = 1.0;
/** Extra roughness for the clearcoat lobe alone. */
float gCoatRough = 0.05;
float gCoat = 1.0;
/** The glazing's hand-applied Fresnel weight; see makeCarGlassMaterial. */
float gFres = 1.0;

float aaStep(float edge, float x, float px){
  float e = max(px * 0.7, 1e-4);
  return smoothstep(edge - e, edge + e, x);
}
float aaBand(float a, float b, float x, float px){
  return aaStep(a, x, px) * (1.0 - aaStep(b, x, px));
}
`;

/* ── The street, as something to reflect ────────────────────────────────── */

/*
 * A crude model of the canyon, intersected analytically.
 *
 * This is a second implementation of the same idea as the one in
 * streetMaterials.ts, and duplicating an appearance decision is normally the
 * seam trap that CANYON exists to prevent. It is duplicated deliberately and
 * the reason is not ownership of the file: a shopfront pane is a vertical
 * plane standing at the building line, so its rays only ever go up or across,
 * and the version over there is written for that. A car panel is a curved
 * surface in the middle of the carriageway whose rays go in every direction
 * including straight down at the road it is parked on, and the sun's own
 * aerosol halo — irrelevant on a pane facing the shade — is the single
 * brightest thing a bonnet reflects at this hour. Sharing one function would
 * mean bolting both sets of requirements onto whichever file owns it.
 *
 * If the two are ever reconciled, the constants that must agree are ROOFLINE,
 * the shade line at 6.5 m, the storey pitch of 3.15 m and the extinction
 * exponent, all of which are copied verbatim.
 */
const STREET_PROBE = /* glsl */ `
vec3 streetProbe(vec3 P, vec3 R, float blur){
  const float ROOFLINE = 13.0;
  float dFace = abs(R.x) > 0.02
    ? max((sign(R.x) * uBuildLine - P.x) / R.x, 0.0) : 1e4;
  float dRoof = R.y >  0.002 ? (ROOFLINE - P.y) / R.y : 1e4;
  float dRoad = R.y < -0.002 ? (0.015 - P.y) / R.y    : 1e4;
  float dHit  = min(min(dFace, dRoof), min(dRoad, 70.0));
  float yHit  = P.y + R.y * dHit;
  float zHit  = P.z + R.z * dHit;

  /* The frontage opposite. Only the -X row takes this sun, so a ray heading
   * +X can never find a lit wall however far up it goes. */
  float litLine = R.x < -0.02 ? 6.5 : 1e6;
  float bay = floor(zHit / 2.55);
  /* Measured, not authored.
   *
   * Every constant in this function was originally set by eye against a
   * tonemapped frame, which is the error System 3 found in the shopfront
   * glazing and which applies here word for word: the AgX shoulder compresses
   * the top of the range so hard that a surface can be four times too dark in
   * linear light and look approximately right on screen. The sunlit wall here
   * was 2.30 against a true 6.3 — the same 2.3 the shopfront had, from the
   * same mistake made independently.
   *
   * These are now read off the rendered scene through the calibration
   * display = 0.284 * L^0.4545, inverted: sunlit masonry at mid height, the
   * shaded frontage high and at the ground storey, the road looking sunward
   * and the gutter looking away. The vertical gradient carries the canyon
   * occlusion and the ground-storey darkening with it, so the two hand-tuned
   * multipliers that used to follow are gone — they were a second helping of
   * an occlusion the measurement already includes. */
  /* And these two are the *shaded* frontage, which is what this gradient has
   * always been and never carried.
   *
   * Rendering the pane as an opaque mirror of the raw probe settled it: a side
   * window's ray leaves at forty or fifty degrees, clears the ground storey,
   * and lands ten metres up the terrace opposite, where this function returned
   * 2.99 linear. The same wall measures 0.31 in the same frame. The sunlit
   * term below is separate and correctly large, and it only fires for a ray
   * travelling -X, so every ray heading across the street at a car on the west
   * kerb was being handed sunlit masonry brightness for a frontage that is in
   * its own shadow at this hour.
   *
   * That is the System 3 finding running the other way. Last round every
   * constant here was four times too dim because it had been set against a
   * tonemapped frame; the correction raised them all, and raised the shaded
   * case onto the sunlit one. It is also the whole of the car glass defect: at
   * 3.07 the probe was brighter than anything in the frame except the sun-
   * struck stucco, so a pane reflecting it could only ever be luminous, and
   * flat with it, because a constant is what a wall with no lighting variation
   * across it returns. */
  vec3 wall = mix(vec3(0.335, 0.243, 0.216), vec3(1.05, 0.675, 0.562),
                  smoothstep(1.4, 6.0, yHit));
  wall = mix(wall, vec3(6.27, 2.97, 1.73),
             smoothstep(litLine - 1.0, litLine + 3.0, yHit));
  wall *= 0.78 + 0.44 * hash21(vec2(bay, 5.1));
  float st = fract((yHit - 0.55) / 3.15);
  float winRow = smoothstep(0.14, 0.24, st) * (1.0 - smoothstep(0.58, 0.68, st));
  float winBay = step(0.34, hash21(vec2(bay, 11.7))) * step(2.6, yHit);
  wall = mix(wall, wall * 0.26 + vec3(0.030, 0.031, 0.040), winRow * winBay * 0.85);
  /* Awnings, because the striped one over the hero car is the most graphic
   * object anywhere near it and it was not in the reflection at all. A car
   * parked at a kerb sits directly under the ground-storey projections, so its
   * glass and its roof see them at a steeper angle than they see anything
   * else — a real photograph of this car has the awning bent across the side
   * glass and nothing else in the upper half of the pane. Two and a half
   * metres up, one bay in three, and striped along the run at the 320 mm pitch
   * System 3 builds them with. */
  float awnB = hash21(vec2(floor(zHit / 5.1), 17.3));
  float awn = step(0.62, awnB)
    * smoothstep(2.34, 2.42, yHit) * (1.0 - smoothstep(3.02, 3.10, yHit));
  vec3 awnC = mix(vec3(0.62, 0.20, 0.16), vec3(1.55, 1.44, 1.30),
                  step(0.5, fract(zHit / 0.32)));
  // The soffit is in its own shadow and the top of the valance catches sky.
  awnC *= 0.30 + 0.85 * smoothstep(2.40, 2.92, yHit);
  wall = mix(wall, awnC, awn * 0.90);

  /* The ground storey, which is where a car's reflected rays actually land and
   * which this probe did not model at all.
   *
   * A panel on a car is between 300 mm and 1.4 m off the road and its rays
   * leave nearly horizontally, so they hit the frontage opposite between one
   * and three metres up — under the fascia, in the shopfronts — almost every
   * time. This function was handing all of that the storey-banded masonry
   * gradient, which at that height returns 1.27 of flat warm grey with nothing
   * in it. Measured off the same frames the walls came from, the ground storey
   * opposite is darker than that and, more to the point, it is not flat: a
   * fascia band, then glazing in rectangles between the piers, at 0.52 where
   * it is reflecting the shade and several times that where it is throwing
   * back the terrace in the sun. The shopfront material makes exactly this
   * argument about itself and it is more true here, because a car sits lower
   * and grazes harder.
   *
   * This is most of why the cars read as one continuous cream mass: the
   * brightness was defensible and the content was a constant. */
  float unitU = fract(zHit / 4.35);
  float pier = smoothstep(0.03, 0.11, unitU) * (1.0 - smoothstep(0.86, 0.95, unitU));
  vec3 fasciaC = vec3(0.150, 0.135, 0.132);
  vec3 shopC = vec3(0.520, 0.400, 0.330)
    * (0.35 + 1.30 * hash21(vec2(floor(zHit / 4.35), 47.7)));
  float shopG = pier * smoothstep(0.58, 0.70, yHit)
              * (1.0 - smoothstep(2.62, 2.78, yHit));
  vec3 ground = mix(fasciaC, shopC, shopG);
  // The stallriser and the pavement shadow under it, which is the darkest
  // band in the whole reflection and the one that reads as ground.
  ground = mix(vec3(0.062, 0.056, 0.058), ground, smoothstep(0.10, 0.42, yHit));
  wall = mix(ground, wall, smoothstep(2.92, 3.20, yHit));

  vec2 raz = normalize(vec2(R.x, R.z) + 1e-5);
  float az = dot(raz, normalize(uSun.xz));
  /* The sky, and this was the whole of the glass failure.
   *
   * Last round I measured the walls and the road and left this line reading
   * uHorizonSun, which is the atmosphere model's radiance at the horizon —
   * tens of units. That is a true number for the sky and the wrong number for
   * this probe, because nothing on a car reflects the horizon: a street-level
   * ray leaves at a shallow angle and dies in forty metres of haze long before
   * it gets there, and a ray that goes up leaves at a steep enough angle to be
   * looking at the zenith rather than at the sun. The result was car glass
   * measuring 2.9 in linear light against 0.53 for the shopfront glazing
   * beside it — a pane brighter than every surface it could possibly be
   * reflecting — and paint so washed out that I put a 0.35 fudge in front of
   * it rather than find this.
   *
   * All three are now measured off the rendered scene through the same
   * inversion as the walls: the hazed street end toward the sun, the murk away
   * from it, and the zenith overhead. */
  vec3 skyC = mix(vec3(1.10, 1.05, 1.55), vec3(4.18, 2.50, 2.03),
                  smoothstep(-0.35, 0.95, az));
  skyC = mix(skyC, vec3(1.71, 1.36, 2.22), smoothstep(0.02, 0.55, max(R.y, 0.0)));
  /* The halo, and on a car it is not optional. Aerosol scattering piles light
   * up around the disc over twenty degrees, and a windscreen or a bonnet with
   * a reflected ray anywhere near the sun returns that glare as a soft bloom
   * the size of a dinner plate. The disc itself is left out for the same
   * reason env.ts leaves it out of the probe: the directional light already
   * carries it, with a hard specular lobe, and counting it twice is what turns
   * every panel into a pinpoint. */
  float ang = acos(clamp(dot(normalize(R), uSun), -1.0, 1.0));
  skyC += (exp(-ang * 5.2) * 0.16 + exp(-ang * 17.0) * 0.62) * vec3(1.60, 0.86, 0.34);

  /* The carriageway, between the gutter looking away from the sun and the
   * hazed road looking down it. Both measured; the previous pair was an order
   * of magnitude below either. */
  vec3 road = mix(vec3(0.49, 0.34, 0.53), vec3(2.29, 1.36, 1.27),
                  smoothstep(0.1, 0.95, az));
  /* The road a car actually reflects is the road it is standing on.
   *
   * Rendering the probe's hit classification settled where the flank's value
   * was coming from, and it was not the sky and not the frontage: a panel
   * between the sill and the shoulder faces very slightly downward, so almost
   * every ray leaving it lands on the carriageway within two or three metres
   * of the wheels. This function was handing all of those the open-road
   * radiance — 2.29 looking down the street into the sun — which is why the
   * flanks came back as a continuous cream field at 2.8 in linear light while
   * the diffuse under them measured 0.04.
   *
   * That patch of road is the one place in this system whose brightness has
   * already been measured and praised: it is the contact shadow, at display 22
   * to 26 against 65 to 75 two metres away, because a car occludes essentially
   * the whole sky dome from the metre of tarmac beneath it. A ray that lands
   * there is looking at a tenth of the open road, and the falloff below is the
   * same one emitShade draws. */
  road *= mix(0.11, 1.0, smoothstep(0.55, 3.4, dHit));

  /* Sky against frontage, and the crossing between them is softened rather
   * than switched. A hard select here is what drew the chevrons in the van's
   * backlight: a straight roofline seen in a convex mirror maps to a curve,
   * the geometry can only carry that curve as a polyline, and a hard colour
   * step along it turns every triangle edge into a visible kink. Two degrees
   * of slop across the crossing costs nothing — a real roofline against a
   * bright sky is not a step function either, it is a fringe a few
   * milliradians wide plus whatever the air does to it — and it converts the
   * kinks into a continuous edge that still lands in the right place.
   *
   * The width scales with distance so it stays angular: the same handful of
   * degrees whether the ray dies on the terrace opposite or eighty metres
   * down the street. */
  float dOther = min(dFace, dRoad);
  float soft   = 0.045 * max(dHit, 1.5);
  float kSky   = 1.0 - smoothstep(-soft, soft, dRoof - dOther);
  bool toRoad = dRoad <  min(dFace, dRoof);
  vec3 hit = mix(toRoad ? road : wall, skyC, kSky);

  /* What is standing in the way, which on a street is nearly everything.
   *
   * The model above is an empty canyon: a road, two walls and a strip of sky.
   * That is a fair description of what a shopfront pane two metres up can see
   * and a poor one for a car panel, and rendering the hit classification is
   * what showed why. A flank between the sill and the shoulder faces a degree
   * or two below horizontal, so its rays do not hit the road beside the car —
   * they skim it and land twenty metres down the street, in the sun, and the
   * probe hands back open carriageway at 2.29. Twenty metres of this street at
   * that height contains the rest of the parked row, two kerbs, a bollard and
   * a bin; the one thing it does not contain is an uninterrupted view of
   * sunlit tarmac. That single term was most of the flank's value and all of
   * its flatness, and it is why the last round needed a 0.35 in front of the
   * whole reflection to look like anything.
   *
   * So a long ray that stays below bonnet height is occluded. Short ones are
   * not, because the near road really is visible under and beside a car — and
   * that near road is dark for its own measured reason, see above. */
  float lowY = max(P.y, P.y + R.y * min(dHit, 8.0));
  float graze = (1.0 - smoothstep(0.85, 1.55, lowY)) * smoothstep(3.0, 9.0, dHit);
  hit = mix(hit, hit * 0.15 + vec3(0.030, 0.026, 0.028), graze * 0.88);

  /* Aerial perspective on the reflected path, in the same air as the scene
   * fog. A ray leaving a flank at a grazing angle runs the length of the
   * canyon before it meets anything, and grazing is also where Fresnel is
   * largest, so the two compound — which is why a car photographed along a
   * street at low sun is a mirror and the same car photographed square on is
   * a dark shape. */
  /* Measured too, and this one mattered more than the surfaces.
   *
   * It used to mix toward uHorizonSun, which is the radiance of the sky at the
   * horizon — the top of the atmosphere model, tens of units at this hour. But
   * a horizontal ray leaving a car does not end at the horizon. It ends at the
   * far end of a hazed street, and that is a different and much darker thing:
   * measured through the calibration it is 4.18 linear, not tens. Mixing two
   * thirds of the sky horizon into every grazing reflection is why raising the
   * wall and road constants to their true values turned a dark blue saloon
   * white — the surfaces were three times too dim and the terminal was five
   * times too bright, and the two errors had been cancelling. */
  vec3 hazeC = mix(vec3(0.85, 0.80, 0.95), vec3(4.18, 2.50, 2.03),
                   smoothstep(-0.25, 0.90, az));
  float ext = 1.0 - exp(-pow(dHit * 0.0150, 1.75));
  /* And it is the length of the path the ray *actually* travelled, which is
   * not dHit once the occlusion above has fired.
   *
   * This is where the flank's value was still coming from and the two terms
   * were fighting: a horizontal ray leaving a door skin runs to the end of the
   * canyon, so dHit is seventy metres, so the grazing test occludes it down to
   * a fifteenth — and then this line mixed 88 per cent of the sunward haze
   * back over the top of it and handed back 3.7 linear, which is most of a
   * cream door. A ray that died on the back of the next parked car at five
   * metres has five metres of air in front of it, not seventy. Undoing the
   * extinction in step with the occlusion is what makes the two agree. */
  ext *= 1.0 - graze * 0.92;
  hit = mix(hit, hazeC, clamp(ext, 0.0, 0.88));

  /* Roughness. A matt panel does not return the image, it returns the
   * neighbourhood average — and getting the neighbourhood wrong here was the
   * single largest error in this file.
   *
   * The first version blended toward a mixture that was 28 per cent sky for a
   * ray travelling horizontally, on the reasoning that a rough lobe is wide
   * enough to catch some. It is, but the sky toward the sun in this scene is
   * tens of units of linear radiance — that is what an hour before sunset
   * measures — and a third of a blur toward a quarter of that put roughly two
   * units of flat warm grey on every panel of every car in the street. Colour
   * disappeared: a dark red supermini rendered blue-grey, which is what a
   * saturated albedo of 0.05 looks like with 2.0 of neutral added to it.
   *
   * A ray leaving a car flank horizontally has a neighbourhood of wall and
   * road and no sky in it at all, because there is a building in the way. */
  vec3 avg = mix(mix(road, wall, 0.70), skyC, smoothstep(0.03, 0.75, R.y));
  /* Half weight on the average, and this is the difference between reflected
   * energy and a reflected image.
   *
   * A rough lobe does see a neighbourhood rather than a point, and replacing
   * most of the resolved hit with one average colour is how that gets modelled
   * cheaply — but the average is by construction the flattest thing in the
   * function, and at full weight on a base coat at roughness 0.3 it was
   * putting a uniform pedestal over two thirds of every panel. The hard block
   * where the sunlit frontage lands and the dark band under the fascia both
   * survived into the resolved hit and were then averaged away, the same
   * failure
   * System 3 recorded on the shopfront glazing in the opposite direction: the
   * level was right and there was nothing in it. */
  return mix(hit, avg, clamp(blur, 0.0, 1.0) * 0.55);
}
`;

/* The environment substitution, and the whole reason it is at this include.
 *
 * `<lights_fragment_maps>` is where three turns the probe into `radiance`,
 * `clearcoatRadiance` and `iblIrradiance`, one include before it hands them to
 * the BRDF. Replacing them here means three still applies its own Fresnel,
 * its own multiscatter compensation and its own clearcoat attenuation, to a
 * radiance that is what the ray actually hit rather than to a sky.
 *
 * `iblIrradiance` keeps the standard path and is then put through the canyon
 * term, exactly as every other material in the scene does it, because a single
 * unoccluded probe has no idea there is a building opposite. The gain is
 * applied by hand because envMapIntensity is inert project-wide.
 */
const CAR_MAPS = (gain: number) => /* glsl */ `
#include <lights_fragment_maps>
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
  radiance = gRefl;
  #ifdef USE_CLEARCOAT
    /* The two lobes get two different images and that is the whole point of
     * the split: the base coat under the lacquer is roughness 0.30 and returns
     * the street as a smear, while the clearcoat is 0.03 and returns it as a
     * picture. Feeding both the same blurred probe is what makes a car look
     * like painted clay. */
    clearcoatRadiance = gReflC;
  #endif
#endif
#if defined( RE_IndirectDiffuse )
  /* The canyon term, with its horizontal boost taken back out again.
   *
   * canyonSky multiplies an up-facing surface by as much as 7.4x, and that is
   * correct for what it was written against — a paving slab in the bottom of
   * an eleven-metre slot sees the whole dome and the wall beside it sees a
   * strip. It is not correct for a car roof, and the reason is not the sky but
   * the car: a roof is 1.4 m up in the middle of a canyon whose walls subtend
   * nearly as much from there as they do from the pavement, and the same body
   * carries roof, flank and sill on one continuous curved surface. Left in, it
   * puts a 7.4x step across the shoulder line of every car in the street,
   * which is precisely where the eye reads the shape.
   *
   * Measured: with the full boost and a gain in the range the wall materials
   * use, a silver estate in shade rendered brighter than sunlit brickwork —
   * the tone curve's shoulder then flattened it, and the car came back as a
   * white cutout with no panel structure in it at all. Damping the boost to
   * about 2.4x between sill and roof, and dropping the gain to what the road
   * uses rather than what the walls use, is what puts it back.
   */
  iblIrradiance = canyonSky(iblIrradiance, vWN, vWPos.y)
    * ${gain.toFixed(2)} * gAO / (1.0 + 3.20 * clamp(vWN.y, 0.0, 1.0));
#endif
`;

const CAR_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += gEmit;
`;

/* ── Paint ──────────────────────────────────────────────────────────────── */

/* The palette, in linear reflectance.
 *
 * A real car parc is overwhelmingly white, silver, grey and black, and the
 * saturated colours that do turn up are dark: a red car is 5 per cent
 * reflectance in the red channel and under 1 in the others, which written down
 * looks far too dark and on screen is a red car.
 *
 * White is the one that is deliberately not physical. A white car is 70 to 80
 * per cent reflectance and at this exposure that lands on the AgX shoulder,
 * where the curve's slope is so shallow that no albedo variation survives to
 * screen — the road film, the dust line, the panel gaps and the shoulder
 * highlight all arrive as the same value and the car is a white cutout.
 *
 * The whole pale end is down by about a stop from the first pass, which read
 * as six pale cars in nine and no black one anywhere. Two things were wrong
 * and only one of them was here: these values were high, and the assignment in
 * PARKED then spent them on the wrong cars — a saloon whose own comment says
 * "black, because a quarter of the cars in any city are" was carrying index
 * 0.86, which is champagne. Red is up rather than down, because 0.047 is a
 * maroon in shade and the brief asks for one saturated car; and the blue is
 * down and deepened, because at 0.08 in the blue channel it was reading as
 * powder, which is not a colour cars come in.
 */
/* Diagnostic scale on the resolved reflection, so the question "how much of a
 * flank's value is the probe and how much is the sun" can be answered by
 * measurement rather than by argument. Ships at 1. */
const DBGR = 1.0;
const DBGP = 0;

const PAINT_DECL = /* glsl */ `
vec3 carPaint(float g, out float metalFlake){
  float i = floor(clamp(g, 0.0, 0.999) * 10.0);
  metalFlake = 0.0;
  if (i < 0.5)      { return vec3(0.2700, 0.2670, 0.2590); }   // white
  if (i < 1.5)      { metalFlake = 1.0; return vec3(0.1050, 0.1085, 0.1150); } // silver
  if (i < 2.5)      { metalFlake = 0.7; return vec3(0.0520, 0.0542, 0.0590); } // light grey
  if (i < 3.5)      { metalFlake = 0.8; return vec3(0.0230, 0.0248, 0.0298); } // gunmetal
  if (i < 4.5)      { return vec3(0.1050, 0.0125, 0.0105); }   // red
  if (i < 5.5)      { return vec3(0.0092, 0.0093, 0.0099); }   // black
  if (i < 6.5)      { return vec3(0.0090, 0.0195, 0.0150); }   // dark green
  if (i < 7.5)      { metalFlake = 0.6; return vec3(0.0125, 0.0205, 0.0510); } // deep blue
  if (i < 8.5)      { metalFlake = 0.5; return vec3(0.0940, 0.0810, 0.0625); } // champagne
                      return vec3(0.0195, 0.0200, 0.0215);     // graphite
}
`;

const PAINT_BODY = /* glsl */ `
{
  /* uv is (metres from the nose, metres above the road under the car), which
   * is what every feature below is a function of. Panel gaps run in the first,
   * the road film runs in the second, and neither has to know which way the
   * car is pointing. */
  /* Both of these are per-*vertex* and interpolate, which is the only reason
   * any of the analytic features below can be drawn: the same two numbers also
   * arrive per-cell in vCarB, flat across each quad, and a shut line drawn
   * against the flat copy would be a whole-panel step rather than a line.
   *
   * The height is above the road under *this* car, not above world zero. The
   * carriageway falls 85 mm from crown to gutter, so a fixed datum would put
   * the dust line and the road film tens of millimetres out from one side of
   * the street to the other. */
  float alongM = vFuv.x;
  float hh = vFuv.y;
  float px = fwidth(alongM) + fwidth(hh);
  float seed = vCar.x;
  float part = vCar.y;
  float dirt = vCar.z;
  float bodyLen = max(vCarB.w, 1.0);
  float beltY = vCarB.x;
  float doorA = vCarC.x, doorB = vCarC.y;
  float age = vCarC.z, litOn = vCarC.w;
  float along = clamp(alongM / bodyLen, 0.0, 1.0);
  float lampLo = vCarB.y, lampHi = vCarB.z;

  /* The nose and tail panels resolve their own material here rather than
   * carrying one, because the fan that closes the loft has wedges for faces
   * and a per-face classification paints a pinwheel. See CAR.CAP_R in
   * world/cars.ts. uv.x is the lateral coordinate on these two and the
   * along-car distance everywhere else. */
  /* The coordinate the small features are drawn against — prism cells, the
   * reflector bowl, the grille slats. It follows the along-car axis on the
   * flanks and the lateral axis on the end panels, which is what those
   * features actually run across in both cases. */
  float featX = alongM;
  bool isCap = part > 8.5 && part < 10.5;
  bool isCapR = part > 8.5 && part < 9.5;
  if (isCap){
    float lat = abs(vFuv.x);
    bool rear = part < 9.5;
    hh = vFuv.y;
    featX = lat;
    along = rear ? 1.0 : 0.0;
    alongM = along * bodyLen;
    /* The inboard edge of the cluster, measured in from the corner of the
     * panel rather than out from the centreline. A cluster is a fitted object
     * bolted into the corner of the shell: 220 mm of it at the back, a little
     * less at the front. The floor keeps the hatchbacks as they were — their
     * tail panel is only 700 mm across, the cluster wraps onto the loft
     * outside it, and the cap should stay clear of it entirely — while the
     * van, whose panel is twice as wide, stops painting 400 mm of its rear
     * doors red. */
    float halfW = max(vCarB.w, 0.30);
    float latMin = max(rear ? 0.36 : 0.34, halfW - (rear ? 0.22 : 0.20));
    part = 0.0;
    if (hh > lampLo && hh < lampHi && lat > latMin) part = rear ? 4.0 : 5.0;
    else if (!rear && hh > 0.46 && hh <= lampLo && lat < latMin + 0.12) part = 8.0;
    else if (hh < 0.60) part = 1.0;
  }
  /* World-anchored noise, so two cars parked nose to tail do not share a
   * pattern and nothing swims when the camera moves. */
  vec2 pw = vec2(dot(vWPos.xz, vec2(2.9, 2.9)) + seed * 7.0, vWPos.y * 3.1);
  float up = clamp(vWN.y, 0.0, 1.0);
  float down = clamp(-vWN.y, 0.0, 1.0);

  vec3 col; float rgh = 0.35; float met = 0.0;
  float flake = 0.0;
  float coat = 0.0;              // how much clearcoat this part has
  float grime = 1.0;             // how much road film this part collects

  if (part < 0.5){
    /* ── Painted skin ───────────────────────────────────────────────── */
    col = carPaint(vCar.w, flake);
    coat = 1.0;
    rgh = 0.30;
    /* Metallic flake. Not metalness — a metallic paint is a clearcoat over a
     * pigment layer with aluminium in it, and setting metalness would remove
     * the diffuse term that carries the colour. What flake actually does is
     * scatter a fine glitter that varies with the pixel footprint, so it is
     * carried as a small roughness and albedo break that filters out as the
     * panel falls under a few pixels. */
    float fine = 1.0 - smoothstep(0.4, 1.5, px / 0.0025);
    float sp = unit(wfbm(pw * 240.0, 2));
    col *= 1.0 + flake * (sp - 0.5) * 0.42 * fine;
    rgh += flake * (sp - 0.5) * 0.05 * fine;

    /* Panel gaps. Two door shut lines a side on a hatchback, and they are one
     * of the few hard edges a car body has: 4 mm wide, dark all the way down,
     * running from the sill to the beltline and stopping. A body with no shut
     * lines is a bar of soap.
     *
     * These were built and then found by nobody, and the reason is the width.
     * A 4.5 mm feature drawn with an antialiased step vanishes outright once
     * the pixel footprint exceeds it, which on a car four metres away it
     * already does — the line was being correctly filtered to nothing at every
     * distance in the set. A shut line is one of the few things on a body that
     * stays visible however far away it is, because it is a black slot rather
     * than a shading difference, so the width now has a floor of just under a
     * pixel and the contrast is carried by the mix instead. */
    float flankness = isCap ? 0.0 : 1.0 - up * 1.4 - down * 1.4;
    if (flankness > 0.05){
      float gw = max(0.0045, px * 0.75);
      float gap = 0.0;
      gap = max(gap, 1.0 - aaStep(gw, abs(alongM - doorA), px));
      gap = max(gap, 1.0 - aaStep(gw, abs(alongM - doorB), px));
      gap *= flankness * (1.0 - smoothstep(0.03, 0.14, abs(hh - 0.62) - 0.42));
      col = mix(col, col * 0.16, gap * 0.85);
      rgh = mix(rgh, 0.75, gap * 0.7);
      /* A door handle, and it is worth its four lines: at 1.0 m up and 130 mm
       * across it is exactly at eye level in the near field, and it is the
       * only place on a car body where the eye expects a hard little shape. */
      float hy = 0.72 + 0.16;
      float hxa = doorA + 0.34, hxb = doorB + 0.30;
      float hnd = max(aaBand(hxa, hxa + 0.135, alongM, px),
                      aaBand(hxb, hxb + 0.135, alongM, px))
                * aaBand(hy - 0.020, hy + 0.020, hh, px) * flankness;
      col = mix(col, col * 0.55 + vec3(0.010), hnd * 0.8);
      rgh = mix(rgh, 0.22, hnd * 0.6);

      /* The waistline, and it is the reason a real flank has two specular
       * lobes rather than one.
       *
       * A door skin is not a cylinder. It is pressed with a crease a hundred
       * millimetres or so under the beltline, above which the surface rolls up
       * toward the glass and below which it falls away, and a second softer
       * tuck above the sill where it turns under to the rocker. At four
       * degrees of sun elevation that geometry is the whole read of the side
       * of a car: a long hot streak along the shoulder, a dark band under it
       * where the skin faces away, and a dimmer streak along the sill picking
       * up bounce off the road. The loft as built is one smooth surface from
       * sill to beltline, which is why the critic found one gradient and no
       * creases.
       *
       * Both are stated as a tilt of the normal about the world horizontal
       * rather than as a bend in the loft: an odd bump — t·exp(-t²) — is
       * exactly the normal signature of a crease, positive above and negative
       * below, integrating to no net change in where the surface is. That
       * keeps the silhouette the critic passed and adds the shading it asked
       * for, at the price of four lines and no triangles. Amplitudes are small
       * on purpose; NOTES.md is emphatic that a large normal perturbation at
       * this sun elevation is what blew the pavement out. */
      float ts = (hh - (beltY - 0.115)) / 0.055;
      float tk = (hh - 0.395) / 0.070;
      gTiltY += flankness * (
          clamp(ts, -2.5, 2.5) * exp(-ts * ts) * 0.235
        + clamp(tk, -2.5, 2.5) * exp(-tk * tk) * 0.130);
      // Sharper clearcoat right on the crease, which is where it is polished.
      rgh -= 0.05 * exp(-ts * ts) * flankness;

      /* And the door skin's own curvature, which the two creases above cannot
       * substitute for. They are local: each perturbs the normal over fifty
       * millimetres and leaves the rest of the panel pointing where the loft
       * left it, which is straight out. A flank whose normal is constant puts
       * every pixel on it at the same angle to a four-degree sun, so the whole
       * side of the car satisfies the mirror condition at once and the
       * clearcoat returns one enormous lobe — measured at 4.27 linear across
       * the middle of the hero's door, brighter than the sunlit pavement it is
       * parked on and peaking in the wrong place entirely.
       *
       * A real door skin is convex over its height: the normal points up and
       * out at the shoulder and rolls to down and out at the sill, perhaps
       * thirty-five degrees across the panel. That sweep is what makes the
       * highlight a streak — only the one height whose normal bisects eye and
       * sun is hot, and everything above and below it falls away. It is also
       * the only version of this that produces the dark band the critique
       * asked for, because a band that is dark by construction cannot be
       * drawn with a bump function that integrates to zero.
       *
       * Low frequency by nature: the whole sweep happens over most of a metre,
       * which is the case NOTES.md exempts when it warns about relief at this
       * sun elevation. */
      gTiltY += flankness * clamp((hh - (beltY - 0.20)) * 0.60, -0.30, 0.30);

      /* The waist moulding: a hard dark line along the beltline, under the
       * DLO. On most of these it is the rubber weatherstrip and on some it is
       * a bright trim, but either way it is the edge that separates painted
       * metal from glass and it is never a gradient. */
      float wl = aaBand(beltY - 0.024, beltY - 0.006, hh, px * 0.6) * flankness;
      col = mix(col, col * 0.22 + vec3(0.0035), wl * 0.85);
      rgh = mix(rgh, 0.62, wl * 0.7);
    }

    /* The tailgate shut line, on the back panel. Twin rear doors on a van and
     * a single hatch on everything else, but the split is in the same place on
     * both: a hard vertical slot on the centreline, with a handle beside it.
     * The critic's note is that the van's rear reads as a flat blue rectangle
     * with a lighter inset in it rather than as a door, and this is the two
     * features that make the difference — a car's back panel is otherwise the
     * largest unbroken area of paint on the whole body. */
    if (isCapR){
      float gwR = max(0.005, px * 0.75);
      float split = 1.0 - aaStep(gwR, featX, px);
      col = mix(col, col * 0.15, split * 0.88);
      rgh = mix(rgh, 0.72, split * 0.7);
      float hR = aaBand(0.085, 0.215, featX, px)
               * aaBand(0.905, 0.945, hh, px);
      col = mix(col, col * 0.50 + vec3(0.008), hR * 0.8);
      rgh = mix(rgh, 0.24, hR * 0.6);
    }

    /* Sun bleach and chalking on the horizontal panels. Ten years of it takes
     * the gloss off a roof and a bonnet long before it touches the doors,
     * which is why an old car reads as old from above and new from the side. */
    float bleach = up * age;
    col = mix(col, mix(col, vec3(dot(col, vec3(0.33))), 0.35) * 1.06, bleach * 0.45);
    rgh += bleach * 0.28;
    coat -= bleach * 0.45;
    /* Swirl marks: a decade of the wrong sponge leaves a fine circular haze in
     * the clearcoat that only shows in a specular highlight. Carried as
     * roughness, never as albedo. */
    rgh += age * 0.10 * unit(wfbm(pw * 26.0, 2));

  } else if (part < 1.5){
    /* ── Bumpers, sills, mirror shells, rubbing strips ───────────────── */
    /* Moulded polypropylene, and on most cars it is a slightly different
     * colour from the paint even when it is meant to match: it is a different
     * substrate, it fades faster, and it has no clearcoat on it. Sills and
     * bumper corners are also the parts that get scraped. */
    float flakeB;
    vec3 body = carPaint(vCar.w, flakeB);
    float painted = step(0.35, hash21(vec2(seed * 5.3, 2.9)));
    col = mix(vec3(0.0225, 0.0228, 0.0240), body * 0.86, painted);
    col *= 0.86 + 0.28 * unit(wfbm(pw * 3.0, 3));
    rgh = mix(0.62, 0.42, painted);
    coat = painted * 0.55;
    grime = 1.35;
    // Scuffs on the corners, where every parallel park has left something.
    float scuff = smoothstep(0.62, 0.90, unit(wfbm(pw * 9.0 + 3.0, 3)))
                * smoothstep(0.55, 0.95, max(along, 1.0 - along)) * age;
    col = mix(col, col * 1.8 + vec3(0.010), scuff * 0.55);
    rgh = mix(rgh, 0.80, scuff * 0.6);

  } else if (part < 2.5){
    /* ── Wheel-arch liner ───────────────────────────────────────────────
     *
     * The single most important dark in the whole system. The gap between the
     * top of a tyre and the arch above it is 60-75 mm of near black, and if it
     * is not there the wheel reads as painted onto the body. It is a moulded
     * plastic liner packed with road dirt, it sees almost no sky, and it never
     * catches this sun at all. */
    col = vec3(0.0145, 0.0140, 0.0138);
    col *= 0.7 + 0.7 * unit(wfbm(pw * 5.0, 3));
    rgh = 0.94; coat = 0.0; grime = 1.6;
    gAO *= 0.16;

  } else if (part < 3.5){
    /* ── Floor pan ──────────────────────────────────────────────────── */
    col = vec3(0.0110, 0.0108, 0.0112);
    rgh = 0.95; coat = 0.0;
    gAO *= 0.08;

  } else if (part < 4.5){
    /* ── Rear lamp cluster ──────────────────────────────────────────────
     *
     * Not emissive, and this is the trap the brief names. A rear cluster is
     * retroreflective, and retroreflection returns light towards its source;
     * with no headlights on it and the sun forty degrees off the axis, a
     * reflector at golden hour returns nothing towards the eye. What it is, is
     * a deep saturated red moulding — under two per cent reflectance in green
     * and blue — with a fine internal prism structure that catches the sky at
     * a hundred different angles, and a gloss surface over the top. It is
     * therefore *darker* than the paint beside it and much shinier, and that
     * contrast is the whole read.
     */
    /* The prism structure. Real clusters are a grid of corner-cube or
     * cylindrical elements at 4-8 mm pitch. Modelled as a cell pattern in tone
     * and a small slope, both gated by pixel footprint so that at twenty
     * metres the cluster converges to the right average red instead of
     * sparkling. */
    const float PP = 0.0065;
    vec2 cell = vec2(featX, hh) / PP;
    vec2 fc = fract(cell) - 0.5;
    float vis = 1.0 - smoothstep(0.35, 1.20, px / PP);
    float facet = (unit(wfbm(floor(cell) + 0.5, 2)) - 0.5);
    /* The lens is not a sheet of red plastic on a black backing. There is an
     * aluminised bowl behind it, so daylight goes in through the filter,
     * bounces off a near-mirror and comes back out through the filter again:
     * the red channel makes that round trip nearly intact and the other two do
     * not. That is why a tail lamp is a vivid red object in flat shade while
     * a piece of red paint beside it is nearly black, and 0.105 in red — the
     * value of a bare moulding — was reading as a dark navy panel on the van,
     * which is in shade in every frame it appears in. Two passes through a
     * filter at 0.66 either way over a 0.85 reflector puts the red at about
     * 0.37; green and blue stay where a lens leaks them, under two per cent,
     * so the saturation is untouched and it is still darker in luminance than
     * the paint around it. */
    col = vec3(0.3700, 0.0155, 0.0110);
    col *= 1.0 + facet * 0.85 * vis;
    // Lens divisions: the reversing lamp and the indicator inside the cluster.
    float f = clamp((hh - lampLo) / max(lampHi - lampLo, 0.02), 0.0, 1.0);
    if (f < 0.26){ col = vec3(0.4400, 0.1950, 0.0135); }          // indicator amber
    else if (f > 0.80){ col = vec3(0.4300, 0.4150, 0.3900); }     // reverse, clear
    rgh = 0.09 + 0.10 * dirt; coat = 1.0; met = 0.0;
    gSlope += vec2(fc.x, fc.y) * 0.06 * vis;
    grime = 0.8;

    /* Everything from here down is what makes the cluster findable, and a
     * saturated-red pass over the last set found exactly one of them in
     * twenty-six frames. The physics above is not what was wrong: a lens at
     * one tenth reflectance in red and half a per cent in green really is
     * darker than the paint around it, and the critic explicitly defends the
     * decision not to light it. What was missing is that a lens is also the
     * glossiest thing on a parked car and it is curved, so it is never a flat
     * field — it always carries a hard specular sliver somewhere across it,
     * and it always sits in a bezel.
     *
     * The curvature is stated as a lateral sweep of the normal. A cluster
     * wraps maybe fifteen degrees from its inboard edge to the corner of the
     * car, which is enough for the reflected ray to travel right across the
     * sky and find something bright at some point along it whatever the car is
     * pointing at. That sweep is the sliver. */
    float lensU = clamp((featX - 0.34) / 0.34, 0.0, 1.0);
    gTiltY += (0.5 - f) * 0.34;
    gSlope += vec2(lensU - 0.42, 0.0) * 0.55;

    /* The bezel. Chrome on some, body-coloured plastic on others, black on the
     * cheap ones — but always a hard frame with its own gloss, and always a
     * few millimetres proud of the lens, which is why a cluster reads as a
     * fitted object rather than as a decal. */
    float edge = min(min(f, 1.0 - f) * (lampHi - lampLo), (featX - 0.335));
    float bez = 1.0 - aaStep(0.014, edge, px);
    vec3 chrome = vec3(0.5400, 0.5350, 0.5250);
    col = mix(col, mix(vec3(0.0180, 0.0178, 0.0180), chrome,
                       step(0.45, hash21(vec2(seed, 4.4)))), bez * 0.92);
    rgh = mix(rgh, 0.16, bez);
    met = mix(met, 0.85 * step(0.45, hash21(vec2(seed, 4.4))), bez);
    // And the lens sits down inside it, so the frame occludes the lens edge.
    gAO *= 1.0 - (1.0 - aaStep(0.026, edge, px)) * 0.35;
    /* Sidelights, on exactly one car in the street, and the critic could not
     * find it in any of twenty-six frames at any threshold. 0.33 was set
     * against the sunlit brickwork at 2.3 on the argument that a sidelight is
     * far dimmer than a sunlit wall, which is true and was the wrong
     * comparison: what a tail lamp has to beat is the unlit lens next to it
     * and the shaded bodywork around it, both of which are under 0.05. At 0.90
     * it is four counts of display over its own lens at ten metres, which is
     * what a 5 W bulb behind red acrylic looks like at this hour, and it is
     * still a fifth of the wall behind it. System 5 owns anything this throws
     * onto the road — see CarLight in world/cars.ts. */
    gEmit += vec3(0.900, 0.062, 0.028) * litOn * (0.55 + 0.45 * step(f, 0.80))
           * (1.0 - 0.35 * dirt);

  } else if (part < 5.5){
    /* ── Headlamp ───────────────────────────────────────────────────────
     *
     * A clear polycarbonate cover over a dark reflector, so what it reads as
     * is a hole with a bright rim — the cover catches the sky at its edges
     * where it curves away, and the middle is the inside of the lamp, which is
     * dark. Old ones have gone milky, which is a genuinely common thing to see
     * and reads at three metres. */
    float milk = smoothstep(0.35, 0.95, age);
    col = mix(vec3(0.0300, 0.0300, 0.0320), vec3(0.1350, 0.1250, 0.1080), milk * 0.75);
    // The reflector bowl behind it, in two lobes: dip and main beam.
    float bowl = smoothstep(0.55, 0.18, abs(fract(featX * 3.4 + 0.5) - 0.5) * 2.0);
    col = mix(col, col * 0.42 + vec3(0.0180, 0.0180, 0.0190), bowl * 0.6);
    rgh = mix(0.06, 0.42, milk); coat = 1.0;
    gEmit += vec3(0.620, 0.500, 0.315) * litOn * 0.55;
    grime = 1.2;

  } else if (part < 6.5){
    /* ── The cabin, seen through the glass ──────────────────────────────
     *
     * This is the surface a pane is composited over, and getting it wrong is
     * the difference between a car and a car-shaped object. Two things are
     * happening behind a windscreen at this hour. Most of the area is a very
     * dark interior — a dashboard, seat backs, headrests, a headliner — at
     * one or two per cent reflectance. But a real greenhouse is *transparent*,
     * and the single strongest cue that a distant shape is a car is that you
     * can see daylight through it: sky and the frontage opposite, dimmed by
     * two dirty panes and by whatever is in the way.
     *
     * Modelling that as actual transparency would mean sorting two layers of
     * glass per car and drawing the far side of the interior. Continuing the
     * view ray through the same street model the reflection uses costs one
     * function call and gets the important part right: the open areas of the
     * greenhouse carry a dimmed image of what is behind the car, and the seats
     * and pillars occlude it.
     */
    col = vec3(0.0170, 0.0165, 0.0170);
    rgh = 0.86; coat = 0.0; grime = 0.0;
    /* 0.18 rather than 0.30. This is the inside of a closed box with one small
     * aperture per side, and it was the thing I named as the weakest part of
     * the build: square on to a side window, ninety-two per cent of what
     * reaches the eye is this surface, and at 0.30 it arrived as a pale slab
     * with a seat drawn faintly on it. The reflection recalibration above does
     * not help here — it makes the mirror stronger, not the cabin darker. */
    gAO *= 0.18;
    // The headliner is the one pale thing in a car interior.
    col = mix(col, vec3(0.0430, 0.0415, 0.0395), down * 0.7);

    /* Seats and headrests, drawn against the along-car coordinate. A headrest
     * is 260 mm wide and its top sits about 120 mm above the beltline, which
     * is why it breaks the line of the glass — and that pair of dark humps in
     * the back window is the most recognisable thing about a car seen from
     * behind at fifty metres. */
    /* The beltline, from the section rather than from a constant. It was 0.98
     * for every body, which was near enough on a supermini and 100 mm out on a
     * van, and it is now 40 to 90 mm higher on all of them since the deck
     * curves were redrawn — a headrest measured off the wrong datum sits in
     * the middle of the glass or under the door. */
    float belt = beltY;
    float seatF = smoothstep(0.02, 0.0, abs(along - 0.47) - 0.062);
    float seatR = smoothstep(0.02, 0.0, abs(along - 0.70) - 0.062);
    float head = max(seatF, seatR) * (1.0 - smoothstep(belt + 0.11, belt + 0.21, hh));
    float below = 1.0 - smoothstep(belt - 0.02, belt + 0.05, hh);
    /* The B-pillar, from the inside. It is trimmed in the darkest material in
     * the car and it is the one hard vertical a side window has in it — the
     * thing that says there are two windows here rather than one long slot.
     * doorB is the pillar on every body in SHAPES; the shut line outside and
     * the trim inside are the same station. */
    float pil = smoothstep(0.026, 0.0, abs(alongM - doorB) - 0.028);
    float solid = clamp(max(max(head, below), pil * 0.92), 0.0, 1.0);
    col = mix(col, col * 0.45, pil * 0.8);

    vec3 Vw = normalize(vWPos - cameraPosition);
    /* Daylight through the far side. Two panes at about 0.82 transmission
     * each, tinted glass, a dirty interior and the far door card taking a bite
     * out of the bottom — call it a third of what is behind the car, and cut
     * hard where the seats are. */
    /* 0.055, and the first version at 0.30 is instructive about why. The sky
     * toward the sun in this scene measures in the tens of units of linear
     * radiance — that is what a horizon an hour before sunset is — so a third
     * of it, emitted, made every side window on every car a flat tan panel
     * brighter than the paint around it. Two dirty panes, a tinted interlayer,
     * the far door card and the fact that most of what is on the other side of
     * a car is the shaded ground storey opposite rather than the sky is a lot
     * closer to a twentieth — and then clamped, because the one direction that
     * matters is straight down the street into the sun, where even a twentieth
     * is brighter than the paint around the window.
     *
     * The coefficient is down from 0.022 with the probe recalibration, which
     * multiplied everything this reads by between three and five. 0.008 leaves
     * the transmitted daylight where it was measuring correctly; the clamp is
     * up a little because it is now doing its job against real radiance rather
     * than against a value that was four times too small to need clamping. */
    vec3 through = min(streetProbe(vWPos, Vw, 0.45) * 0.008, vec3(0.42));
    gEmit += through * (1.0 - solid);
    col *= 1.0 + 0.4 * solid;

  } else if (part < 7.5){
    /* ── Number plate ───────────────────────────────────────────────────
     *
     * No retroreflective gain, for the same reason the street blade in System
     * 3 has none: the sheeting only returns light to a source coaxial with the
     * eye and there are no headlights in this scene. In daylight it is a
     * high-albedo painted plate, and here it is the rear one, which in this
     * part of the world is yellow.
     *
     * It is also the one piece of the body whose uv is a normalised rectangle
     * rather than metres, because two triangles carrying 110 mm of height
     * cannot also carry a legible coordinate for the lettering. Its place on
     * the car is restated from the flat per-cell copy so the dirt below still
     * finds it, and a number plate is the filthiest thing on a car. */
    alongM = bodyLen; along = 1.0;
    hh = 0.545 + (vFuv.y * 0.5 + 0.5) * 0.11;
    col = vec3(0.3900, 0.3150, 0.0720);
    col *= 0.88 + 0.20 * unit(wfbm(pw * 8.0, 2));
    // Characters, as a run of blocks. At 520 x 110 mm and read from six
    // metres, what has to be there is the rhythm and the black-on-yellow, not
    // the glyphs; anything more would alias.
    float q = (vFuv.x * 0.5 + 0.5);
    float ink = aaBand(0.10, 0.90, q, px * 0.5)
              * aaBand(0.22, 0.80, vFuv.y * 0.5 + 0.5, px * 0.5)
              * step(0.30, hash21(vec2(floor(q * 12.0), seed)));
    col = mix(col, vec3(0.0170, 0.0170, 0.0175), ink * 0.92);
    rgh = 0.52; coat = 0.15; grime = 1.5;

  } else if (part < 8.5){
    /* ── Grille ─────────────────────────────────────────────────────────
     *
     * A dark recess with slats in it. Nearly black, because it is a hole with
     * a radiator behind it, and the one place on the front of a car where
     * there is genuine occlusion to state. */
    col = vec3(0.0140, 0.0138, 0.0145);
    float slat = aaStep(0.45, fract(hh / 0.028), px / 0.028);
    col *= 0.55 + 0.85 * slat;
    rgh = 0.55; coat = 0.3; met = 0.25;
    gAO *= 0.35;
    grime = 1.4;

  } else {
    /* ── The scuttle ────────────────────────────────────────────────────
     *
     * Fifty millimetres of unpainted black plastic between the bonnet and the
     * windscreen, with the wiper trough in it. The step it makes at the cowl
     * is the whole reason it exists — see CAR.SCUTTLE — so it is stated in
     * albedo and in gloss at once: a tenth of the reflectance of even a black
     * car, matte where the bonnet is a mirror, and shadowed because it sits in
     * a trough under the trailing edge of the bonnet with the screen behind
     * it. The wipers park in the near end of it. */
    col = vec3(0.0125, 0.0124, 0.0128);
    col *= 0.80 + 0.34 * unit(wfbm(pw * 7.0, 2));
    rgh = 0.80; coat = 0.10; met = 0.0; grime = 1.5;
    gAO *= 0.42;
    // The blades: two dark bars lying across it, at the pitch a pair parks at.
    float bl = aaBand(0.16, 0.42, fract(featX * 1.35), px * 1.35)
             + aaBand(0.58, 0.80, fract(featX * 1.35), px * 1.35);
    col *= 1.0 - clamp(bl, 0.0, 1.0) * 0.35;
  }

  /* ── Dirt, which every one of them wears differently ─────────────────
   *
   * Three separate deposits, and they are separate because they come from
   * different places and sit in different bands. Road film is thrown up by the
   * car's own wheels and covers the bottom third, heaviest at the back where
   * the rear wheels put it. Dust settles out of the air onto the horizontal
   * panels and nowhere else. And rain runs down the vertical panels in
   * streaks, taking the film with it in lines and leaving it between them.
   */
  float d = dirt * grime;
  float filmAmt = 0.0;
  {
    /* Road film: the bottom third, and further up the further back you go.
     *
     * This was built and then measured at nothing: the hero's lower flank came
     * back at display 162 against 96 for the mid flank and 139 for the sunlit
     * pavement beside it, which is the value gradient of a car exactly upside
     * down. Two things were wrong. It was scaled by the per-car dirt figure
     * with no floor, so the cleanest cars — which are the ones parked closest
     * to the camera — had almost none of it; and it stopped at 300 mm, which
     * is the rocker rather than the lower third of the body. A car that has
     * been driven on a wet road once has film up the bottom four hundred
     * millimetres of the doors whatever its owner thinks, and it is the single
     * strongest value cue the side of a car has. */
    float top = 0.36 + 0.34 * along;
    float dF = clamp(0.42 + 0.72 * d, 0.0, 1.30);
    float film = (1.0 - smoothstep(top * 0.42, top, hh))
               * (0.55 + 0.55 * unit(wfbm(pw * 1.6, 3)));
    film = clamp(film * dF, 0.0, 1.0);
    col = mix(col, mix(col, vec3(0.0250, 0.0224, 0.0186), 0.86), film * 0.86);
    rgh = mix(rgh, 0.88, film * 0.86);
    coat *= 1.0 - film * 0.90;
    filmAmt = film;

    /* The dust line along the sill. Every car that has been driven on a wet
     * road has a hard-edged pale band where the film thins out at the top of
     * the sill, and it is a line rather than a gradient because it is drawn by
     * the airflow leaving the wheel arch. */
    float line = exp(-pow((hh - 0.235) / 0.045, 2.0));
    col = mix(col, vec3(0.0450, 0.0410, 0.0355), line * d * 0.55);

    // Dust on the horizontals, which no rain has washed since it landed.
    float dust = up * d * (0.45 + 0.55 * unit(wfbm(pw * 2.2 + 11.0, 3)));
    col = mix(col, mix(col, vec3(0.0640, 0.0590, 0.0510), 0.60), dust * 0.55);
    rgh = mix(rgh, 0.72, dust * 0.7);
    coat *= 1.0 - dust * 0.55;

    /* Rain streaking. High frequency across, low frequency down, so it comes
     * out as vertical runs in world space whichever way the panel is facing —
     * which is what rain does. Strongest at the back of the car, where the
     * wake deposits everything the rest of the body has shed. */
    float streak = unit(wfbm(vec2(dot(vWPos.xz, vec2(26.0, 26.0)) + seed * 3.0,
                                  vWPos.y * 0.55), 3));
    float run = smoothstep(0.45, 0.95, streak) * d
              * (1.0 - up) * (0.35 + 0.65 * smoothstep(0.5, 1.0, along));
    col = mix(col, col * 0.72 + vec3(0.0055), run * 0.5);
    rgh = mix(rgh, 0.80, run * 0.55);
  }

  /* Contact occlusion on the car itself. The bottom of a body sees the road
   * and its own shadow and very little else, and at four degrees there is no
   * cast shadow available to do the job on the sunward side. Without it the
   * sills read as brightly as the roof and the car floats.
   *
   * It now runs to 580 mm rather than 420, which is the top of the road film
   * rather than the top of the rocker, and it is applied to the reflection as
   * well as to the irradiance. That second part is what was missing: a panel
   * 200 mm off the ground cannot see half the sky, and leaving the mirror term
   * unoccluded meant the lower flank was returning a clean image of the
   * sunlit frontage while the diffuse beside it was correctly dark. */
  gAO *= mix(0.16, 1.0, smoothstep(-0.02, 0.58, hh));
  /* Sky occlusion on the mirror, over the whole height of the body, and this
   * is the term that replaces last round's 0.35.
   *
   * With the reflection switched off entirely a flank measures 16 counts and
   * with it on it measures 116, so on a car parked in shade the mirror is not
   * part of the value, it is all of it — which means the height gradient the
   * critic asked for has to be stated here or it cannot exist. It is a real
   * occlusion and not a curve fit: what a panel can see of the bright half of
   * the world falls off steeply as it drops, because the kerb, the footway,
   * the row of parked cars and the car's own bodywork all subtend more of the
   * hemisphere the lower you go, and none of them are in the analytic canyon.
   * At the roof it is unity, at the shoulder about two thirds, at the sill
   * under a fifth — roof hot, mid falling away, lower third dark, which is the
   * order a car actually reads in.
   *
   * The film term is the other half. A mirror is a property of the clearcoat,
   * and the bottom of a car does not have a clearcoat any more, it has four
   * hundred millimetres of dried road spray. */
  gSpecAO = mix(0.12, 1.0, smoothstep(0.10, 1.35, hh)) * (1.0 - filmAmt * 0.62);
  // And the underside of every overhang: sills, bumper undercuts, arch lips.
  gAO *= 1.0 - down * 0.55;
  gSpecAO *= 1.0 - down * 0.45;

  diffuseColor.rgb *= col;
  roughnessFactor = clamp(rgh, 0.055, 1.0);
  metalnessFactor = met;
  gCoat = clamp(coat, 0.0, 1.0);
  /* Clearcoat roughness is the tighter of the two lobes and it is the one that
   * draws the long highlight along a shoulder line at this sun angle. Dirt
   * scatters it: a filthy car has no second lobe left at all. */
  gCoatRough = clamp(0.030 + d * 0.16 + age * 0.05, 0.028, 0.42);

  /* Distance-filtered specular, as everywhere else in this project. A car
   * eighty metres down the street is a handful of pixels and a mirror lobe on
   * it is a firefly. */
  float far = smoothstep(30.0, 95.0, length(vWPos - cameraPosition));
  roughnessFactor = max(roughnessFactor, far * 0.80);
  gCoat *= 1.0 - far * 0.75;
  gReflBlur = clamp(roughnessFactor * 1.45 - 0.06, 0.0, 0.95);
}
`;

const CAR_VERT_DECL = /* glsl */ `
${FACADE_VARYINGS}
varying vec2 vFuv;
varying vec4 vCar;
varying vec4 vCarB;
varying vec4 vCarC;
attribute vec4 aCar;
attribute vec4 aCarB;
attribute vec4 aCarC;
`;

const CAR_FRAG_DECL = /* glsl */ `
varying vec4 vCar;
varying vec4 vCarB;
varying vec4 vCarC;
`;

export function makeCarPaintMaterial(): THREE.MeshPhysicalMaterial {
  /* Physical rather than Standard, and the clearcoat is the reason.
   *
   * The brief is specific that car paint is two lobes — a broad diffuse-ish
   * body colour and a tight specular that picks up the sky and the sun — and
   * that at 4.2 degrees the tight one draws a long highlight along the
   * shoulder line and the roof edge. One GGX lobe cannot be both: set its
   * roughness for the highlight and the body goes to plastic, set it for the
   * body and the highlight disappears. `clearcoat` is exactly this model and
   * three implements it in both the direct and the indirect path, so the
   * shadow-attenuated sun reaches the tight lobe without any of it having to
   * be reimplemented here.
   */
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.35, metalness: 0,
    clearcoat: 1.0, clearcoatRoughness: 0.05,
    /* Closed shells, so front faces are the ones that should be depth-tested
     * for shadows. Left at three's default of BackSide the entire system casts
     * nothing — the trap System 1's kerb, System 2's facades and System 3's
     * shopfronts all fell into, and here it would take out the long diagonal
     * car shadows that are most of what this system contributes to a frame. */
    shadowSide: THREE.FrontSide,
    dithering: true,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uSun = { value: new THREE.Vector3(...SUN_DIR) };
    shader.uniforms.uBuildLine = { value: BUILD_LINE };
    shader.uniforms.uHorizonSun = { value: new THREE.Vector3(...HORIZON_SUNWARD) };
    shader.uniforms.uHorizonAway = { value: new THREE.Vector3(...HORIZON_AWAY) };
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `${CAR_VERT_DECL}\nvoid main() {`)
      .replace('#include <begin_vertex>', `${FACADE_VERTEX}
vFuv = uv;
vCar = aCar;
vCarB = aCarB;
vCarC = aCarC;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {',
        `#define DBGR ${DBGR.toFixed(2)}\n${NOISE}\n${CAR_PARS}\n${CAR_FRAG_DECL}\n${CANYON}\n${STREET_PROBE}\n${PAINT_DECL}\nvoid main() {`)
      .replace(HOOK, `${HOOK}\n${PAINT_BODY}`)
      .replace('#include <normal_fragment_maps>', `${FACADE_NORMAL}
normal = normalize(normal + vec3(0.0, gTiltY, 0.0));
/* The reflection is resolved from the shaded normal, not the geometric one, so
 * that the prism structure in a lamp lens and the panel curvature both bend
 * what they return. */
{
  vec3 Vw = normalize(vWPos - cameraPosition);
  vec3 Rw = reflect(Vw, normalize(normal));
  gReflC = streetProbe(vWPos, Rw, gCoatRough * 1.6) * gSpecAO * DBGR;
  gRefl = streetProbe(vWPos, Rw, gReflBlur) * gSpecAO * DBGR;
}`)
      .replace('#include <lights_fragment_maps>', CAR_MAPS(2.00))
      .replace('#include <emissivemap_fragment>', CAR_EMISSIVE)
      /* After <lights_physical_fragment> and not at the clearcoat normal,
       * which is the intuitive place and is one include too early: three
       * assigns the whole `material` struct from the uniforms inside that
       * include, so anything written before it is overwritten before it is
       * read. The 0.0525 floor and the geometryRoughness addition are three's
       * own and are restated here because they are skipped by writing after
       * the include rather than before it. */
      .replace('#include <lights_physical_fragment>', `
#include <lights_physical_fragment>
#ifdef USE_CLEARCOAT
  material.clearcoat = clamp(gCoat, 0.0, 1.0);
  material.clearcoatRoughness = clamp(max(gCoatRough, 0.0525) + geometryRoughness, 0.0, 1.0);
#endif`);
  };
  m.customProgramCacheKey = () => 'sys4-paint';
  return m;
}

/* ── Glazing ────────────────────────────────────────────────────────────── */

/*
 * Car glass, on the same compositing model the shopfront glazing arrived at.
 *
 * The pane is metalness 1 with a white specular colour, which removes the
 * diffuse term and makes three return the un-Fresnel'd mirror; the Fresnel
 * weight is applied by hand *in linear light before tone mapping*, and the
 * alpha is left to do nothing but attenuate what is behind. That last part is
 * the non-obvious one and it cost that system a review round: three tone maps
 * and encodes in the fragment shader, so a blend that applies alpha runs on
 * display values, and in display space a 6 per cent alpha can add at most six
 * per cent of white however bright the reflection is. The reflection was being
 * computed correctly and thrown away by the compositor.
 *
 * What is behind is the cabin surface emitted 15 mm inboard of every pane by
 * world/cars.ts, which is a dark interior with daylight coming through the far
 * side of the car. So the composite is
 *
 *     mirror * F   +   (interior + daylight through) * (1 - F)
 *
 * with F running from about 7 per cent head-on to unity at grazing. Along the
 * street a parked car is a mirror; square on it is a dark cabin with two
 * headrests in it. That angular swing is most of what makes glass read as
 * glass, and on a curved screen it happens *across* the pane, which is better
 * still.
 */
const GLASS_BODY = /* glsl */ `
{
  float kind = vGl.y;
  float dirt = vGl.z;
  float bow  = vGl.w;
  float seed = vGl.x;
  vec2 q = vFuv;
  float px = fwidth(q.x) + fwidth(q.y);

  /* Two coordinates that mean the same thing on all three kinds of pane: how
   * far up it you are, and how far along the run. On side glass the raw uv
   * already says that; on a screen the pane is laid out lengthwise along the
   * car, so up the pane is the along-car axis and it runs the other way on the
   * backlight than on the windscreen. Every feature below is written against
   * these rather than against uv, because a wiper sweep, a grime band and a
   * demister element are all defined relative to the bottom of the glass and
   * the old code had three different opinions about where that was. */
  float up  = kind < 0.5 ? q.x : (kind > 1.5 ? 1.0 - q.x : q.y);
  float acr = kind < 0.5 || kind > 1.5 ? q.y : q.x;

  /* Curvature. The loft carries the real shape, but a windscreen is a doubly
   * curved surface sampled at a dozen stations and the facets it leaves are
   * visible in a mirror. A gentle analytic bow across the pane both smooths
   * that and, more importantly, compresses the reflected image — the squeeze
   * of the street into the middle of a screen is a strong cue on its own, and
   * a flat pane cannot produce it. Low frequency, so this is nowhere near the
   * relief that a four degree sun turns into noise. */
  gSlope += vec2((acr - 0.5) * bow * 2.0, (up - 0.5) * bow * 0.9);

  /* Dirt. A parked car's glass is filthy in a specific pattern: the wiper
   * sweep is clean and everything outside it is not, there is a band of grime
   * along the bottom where the scuttle throws it, and the side glass has the
   * vertical rain runs the paint has. */
  float film = 0.10 + 0.42 * unit(wfbm(vec2(acr * 9.0, up * 2.2) + seed, 3));
  film += 0.45 * (1.0 - smoothstep(0.0, 0.22, up));
  if (kind < 0.5){
    // The wiper arc: two overlapping sweeps, clean inside.
    float arc = min(length(vec2((acr - 0.30) * 1.25, up - 0.05)),
                    length(vec2((acr - 0.72) * 1.25, up - 0.05)));
    film *= mix(1.0, 0.35, smoothstep(0.78, 0.42, arc));
  }
  film = clamp(film * (0.35 + 0.9 * dirt), 0.0, 1.0);

  vec3 Vw = normalize(vWPos - cameraPosition);
  vec3 Nw = normalize(vWN - vWT * gSlope.x - vWB * gSlope.y);
  vec3 R = reflect(Vw, Nw);

  /* Roughness rises with the film, which is what makes a dirty pane return a
   * soft warm smear where a clean one returns the terrace. */
  float rgh = clamp(0.035 + film * 0.13, 0.032, 0.30);
  gRefl = streetProbe(vWPos, R, clamp(rgh * 2.0, 0.0, 0.85));
  /* Film scatters the reflection rather than removing it, so it loses contrast
   * rather than going dark. Multiplying it down is the behaviour of a filter
   * and not of dirt.
   *
   * What it loses contrast *toward* was wrong, and it was worth about a third
   * of this pane's brightness on its own. It mixed toward the sunward haze —
   * 4.18 linear, the far end of the street — on every dirty pane whatever
   * direction it faced, so a filthy side window pointing at a shaded frontage
   * came back carrying a third of the brightest thing in the scene. Dirt
   * scatters into the neighbourhood the pane can actually see, and this
   * function already computes exactly that: it is what the blur parameter
   * returns at full weight. */
  vec3 scat = streetProbe(vWPos, R, 1.0);
  gRefl = mix(gRefl, scat, film * 0.45);
  /* The same occlusion the paint carries, and for the same reason.
   *
   * streetProbe is an empty canyon and a side window is not looking at one: it
   * is a pane 1.2 m off the road with the rest of the parked row, both kerbs,
   * the footway furniture and the car's own pillars between it and everything
   * the model returns. Unoccluded, this pane measured 3.1 in linear light —
   * brighter than the body it sits in at 1.7 and six times the shopfront
   * glazing across the road at 0.52, which is the comparison the critique
   * turns on and the one this scene can settle, because both are in the same
   * frame. A car window is not a better mirror than a shop window; it is a
   * smaller, dirtier, more curved one with more standing in its way. */
  gRefl *= 0.30 * DBGR;
#if DBGP
  /* The pane rendered as an opaque mirror of the raw probe, which is the only
   * way to read what streetProbe actually returns along a given ray instead of
   * inferring it from a composited pixel. */
  gRefl /= max(0.30 * DBGR, 1e-4);
  gFres = 1.0;
  diffuseColor.a = 1.0;
#endif
  /* Drain some of the saturation, exactly as the sash glass and the shopfront
   * glazing do. A pane with city film on it is not a first-surface mirror:
   * most of what leaves it toward the eye has been scattered rather than
   * specularly reflected, and every one of those effects pulls the result
   * toward grey. */
  gRefl = mix(gRefl, vec3(dot(gRefl, vec3(0.2126, 0.7152, 0.0722))), 0.30);

  /* Fresnel, on the shopfront glazing's form rather than on a guess.
   *
   * That material is the best surface in the build and it earns it here: the
   * textbook 0.043 for n = 1.52 at one interface, then 2R/(1+R) because a
   * windscreen is a laminated slab and the light that refracts in meets the
   * second boundary on the way out. 8.2 per cent head-on, unity at grazing.
   * The old 0.075 base was standing in for the film, which is added separately
   * below and was therefore being counted twice. */
  float ndv = clamp(abs(dot(Nw, -Vw)), 0.0, 1.0);
  float Fs = 0.043 + 0.957 * pow(1.0 - ndv, 5.0);
  float F = 2.0 * Fs / (1.0 + Fs);
  F = clamp(F + film * 0.055, 0.0, 1.0);
  /* Privacy tint on the rear side glass and the backlight, which most cars
   * have and which is why the back of a car is darker than the front. It
   * cannot reduce the reflection, only what comes through — so it goes into
   * the alpha, not into F. */
  float tint = kind > 1.5 ? 0.30 : 0.12;

  diffuseColor.rgb = vec3(1.0);
  diffuseColor.a = clamp(F + (1.0 - F) * tint, 0.0, 1.0);
  gFres = F;
  roughnessFactor = rgh;
  metalnessFactor = 1.0;

  /* The demister element on the backlight. Nine horizontal lines at 30 mm
   * pitch, and they are the one detail that identifies a rear window at any
   * distance where the window itself is more than a few pixels. */
  if (kind > 1.5){
    float lines = aaStep(0.80, fract(up * 9.0), px * 9.0);
    gRefl *= 1.0 - lines * 0.07;
    diffuseColor.a = min(1.0, diffuseColor.a + lines * 0.04);
  }
}
`;

export function makeCarGlassMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.05, metalness: 1.0,
    transparent: true,
    /* The pane's own light is premultiplied by its Fresnel weight in the
     * shader tail, so the blend must be src + dst*(1-a) rather than
     * src*a + dst*(1-a). Spelled out with explicit factors rather than the
     * premultipliedAlpha flag, which did not take when System 3 tried it. */
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    /* Off. The pane has to blend over the cabin behind it, and writing depth
     * would make the far side of a greenhouse fail against the near side.
     * depthTest stays on, so a car in front still occludes the glass of the
     * one behind it. */
    depthWrite: false,
    side: THREE.FrontSide,
    dithering: true,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uSun = { value: new THREE.Vector3(...SUN_DIR) };
    shader.uniforms.uBuildLine = { value: BUILD_LINE };
    shader.uniforms.uHorizonSun = { value: new THREE.Vector3(...HORIZON_SUNWARD) };
    shader.uniforms.uHorizonAway = { value: new THREE.Vector3(...HORIZON_AWAY) };
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `
${FACADE_VARYINGS}
varying vec2 vFuv;
varying vec4 vGl;
attribute vec4 aGl;
void main() {`)
      .replace('#include <begin_vertex>', `${FACADE_VERTEX}\nvFuv = uv;\nvGl = aGl;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {',
        `#define DBGR ${DBGR.toFixed(2)}\n#define DBGP ${DBGP}\n${NOISE}\n${CAR_PARS}\nvarying vec4 vGl;\n${CANYON}\n${STREET_PROBE}\nvoid main() {`)
      .replace(HOOK, `${HOOK}\n${GLASS_BODY}`)
      .replace('#include <normal_fragment_maps>', FACADE_NORMAL)
      .replace('#include <lights_fragment_maps>', `
#include <lights_fragment_maps>
#if defined( USE_ENVMAP ) && defined( RE_IndirectSpecular )
  radiance = gRefl;
#endif
#if defined( RE_IndirectDiffuse )
  iblIrradiance = vec3(0.0);
#endif`)
      .replace('#include <lights_fragment_end>', `
#include <lights_fragment_end>
/* The sun's own mirror image stays — it is the un-Fresnel'd lobe that
 * diffuseColor.a is there to weight — but damped, because a pane with a week
 * of film on it scatters a good part of the specular return before it reaches
 * the eye, and without this it is a pinpoint at several hundred times the
 * level of everything around it. */
reflectedLight.directSpecular *= 0.55;

/* Premultiply, in linear light, before tone mapping. See the long note above
 * makeCarGlassMaterial: this is the one place the arithmetic
 * mirror*F + cabin*(1-F) actually means anything, because by the time the
 * blender runs the value has already been through AgX and an sRGB encode. */
reflectedLight.directDiffuse    *= gFres;
reflectedLight.indirectDiffuse  *= gFres;
reflectedLight.directSpecular   *= gFres;
reflectedLight.indirectSpecular *= gFres;
totalEmissiveRadiance           *= gFres;
`);
  };
  m.customProgramCacheKey = () => 'sys4-glass';
  return m;
}

/* ── Wheels ─────────────────────────────────────────────────────────────── */

/*
 * A tyre is the darkest thing in any photograph of a street — carbon-black
 * rubber is one to two per cent reflectance — and the mistake is to render it
 * as grey because it "reads as black otherwise". It does not: what separates a
 * tyre from a hole is that it has a broad soft sheen where the sidewall turns
 * towards the sky, and a matt, almost dust-coloured tread that is a different
 * material again. Both are here and neither is more than four per cent.
 */
const WHEEL_BODY = /* glsl */ `
{
  float seed = vWhl.x;
  float part = vWhl.y;
  float dirt = vWhl.z;
  float age  = vWhl.w;
  vec2 uv = vFuv;
  float px = fwidth(uv.x) + fwidth(uv.y);
  vec3 col; float rgh; float met = 0.0;
  vec2 pw = vec2(dot(vWPos.xz, vec2(11.0, 11.0)) + seed * 5.0, vWPos.y * 9.0);

  if (part > 3.5){
    /* ── The contact patch ────────────────────────────────────────────────
     *
     * The bottom of the tyre is squashed flat onto the road, so it is a
     * 175 mm plate with a downward normal — and a downward normal, seen from
     * a camera above it, reflects into the sky. At this hour the sky is the
     * brightest thing there is, and every wheel in the street was dragging a
     * tan wedge of it across the tarmac fore and aft. It survived four
     * attempts to darken it because the plate is nearly edge-on: Fresnel at
     * that angle is close to one, the diffuse term is a rounding error, and
     * nothing done to the albedo could be seen at all.
     *
     * Nothing under a loaded tyre sees anything. It is the one surface in the
     * scene entitled to be black, and the reflection is switched off outright
     * rather than attenuated. */
    gPatch = 1.0;
    rgh = 1.0;
    /* Suppressing the reflection was the fix and blacking the albedo with it
     * was one step too far: the flat and the 55 mm of sidewall above it went
     * to the same value, so what the critic saw was a tyre curving into a void
     * rather than a tyre standing on a flat. A loaded tyre shows two things at
     * the road — a straight segment about 150 mm long where the tread is in
     * contact, and immediately above it a darker crescent where the sidewall
     * bulges out past the tread and shades itself. So the plane keeps the
     * black, and the wall above it is rubber with an occlusion ramp on it,
     * which is what draws the crescent.
     *
     * The margin quads are the ones that used to interpolate through
     * horizontal and catch the sky; gPatch still holds the mirror off all of
     * them, which is the part that has to stay. */
    float onRoad = 1.0 - smoothstep(0.004, 0.030, vWPos.y - vWhlBase);
    col = mix(vec3(0.0102, 0.0100, 0.0104), vec3(0.0034, 0.0033, 0.0034), onRoad);
    col *= 0.82 + 0.36 * unit(wfbm(pw * 1.4, 3));
    gAO *= mix(0.16, 0.03, onRoad);

  } else if (part < 1.5){
    /* ── Rubber ─────────────────────────────────────────────────────── */
    col = vec3(0.0128, 0.0126, 0.0130);
    col *= 0.80 + 0.42 * unit(wfbm(pw * 1.4, 3));
    rgh = 0.78;
    /* A wheel is a torus in a box. The tread sees the road and the inside of
     * the arch and nothing else; the sidewall sees a slot between the arch lip
     * and the ground. A single unoccluded probe hands it the whole dome, and
     * on the darkest object in the frame that error is the difference between
     * a tyre and a grey ring. */
    gAO *= 0.42;
    if (part < 0.5){
      /* Tread. Blocks at a 40 mm circumferential pitch with three grooves
       * running round, in tone only: at this sun angle a normal on a feature
       * this size is the pixel-to-pixel barcode that blew the pavement out. */
      float blocks = unit(wnoise(vec2(uv.x * 140.0, uv.y * 3.0)));
      float vis = 1.0 - smoothstep(0.4, 1.4, px / 0.006);
      col *= 1.0 + (blocks - 0.5) * 0.55 * vis;
      // A worn tyre is polished on the crown and matt in the grooves.
      rgh = mix(0.86, 0.62, blocks * (1.0 - age * 0.4));
      // Road dust ground into the tread, which is what makes it read as used.
      col = mix(col, vec3(0.0330, 0.0300, 0.0255), dirt * 0.45);
    } else {
      /* Sidewall. Smoother than the tread and the one part of a tyre with a
       * real highlight in it — the sheen along the shoulder where the rubber
       * turns towards the sky is most of what gives a wheel its roundness. */
      rgh = 0.55 + 0.18 * unit(wfbm(pw * 3.0, 2));
      // The moulded lettering ring, as a faint band.
      float ring = exp(-pow((abs(uv.y - 1.0) - 0.0) / 0.7, 2.0));
      col *= 1.0 + 0.22 * ring * unit(wnoise(vec2(uv.x * 90.0, 3.0)));
      // Kerbed and scuffed low down, which every parked car in a city is.
      col = mix(col, vec3(0.0290, 0.0275, 0.0260), dirt * 0.30);
    }
    // Wet-looking at the very bottom, where the road film never dries.
    float low = 1.0 - smoothstep(0.02, 0.14, vWPos.y - vWhlBase);
    rgh = mix(rgh, 0.42, low * 0.5);
    gAO *= mix(0.35, 1.0, smoothstep(-0.01, 0.20, vWPos.y - vWhlBase));

  } else {
    /* ── Rim ────────────────────────────────────────────────────────────
     *
     * uv on the rim face is the disc coordinate, so the spokes are drawn in
     * polar coordinates rather than modelled. At 380 mm across in the near
     * field and eight pixels at forty metres, modelled spokes would be several
     * hundred triangles that alias into a grey disc — and drawn this way they
     * converge to the correct average tone instead. */
    float r = length(uv);
    float a = atan(uv.y, uv.x);
    float spokes = 5.0 + floor(hash21(vec2(seed, 3.7)) * 3.0) * 2.0;
    float sp = abs(fract(a / 6.28318 * spokes + 0.5) - 0.5) * 2.0;
    float web = 1.0 - smoothstep(0.30, 0.62, sp);      // the spoke itself
    float face = smoothstep(0.30, 0.36, r) * (1.0 - smoothstep(0.90, 0.97, r));
    float open = face * (1.0 - web);

    // Painted alloy: not chrome. A modern wheel is a matt silver lacquer.
    col = vec3(0.1250, 0.1270, 0.1300);
    met = 0.55; rgh = 0.36 + 0.20 * age;
    // The rim flange, which is the bright ring at the edge.
    float flange = smoothstep(0.90, 0.965, r) * (1.0 - smoothstep(0.99, 1.0, r));
    col = mix(col, vec3(0.1750, 0.1780, 0.1800), flange * 0.7);
    rgh = mix(rgh, 0.26, flange * 0.6);
    // Behind the spokes: the brake disc and the dark of the arch.
    col = mix(col, vec3(0.0170, 0.0165, 0.0170), open * 0.92);
    rgh = mix(rgh, 0.80, open);
    met = mix(met, 0.2, open);
    gAO *= 1.0 - open * 0.75;
    // The hub cap and the bolt circle.
    float hub = 1.0 - smoothstep(0.24, 0.30, r);
    col = mix(col, vec3(0.0680, 0.0670, 0.0690), hub * 0.7);

    /* Brake dust. The one thing that stops an alloy wheel reading as new: iron
     * dust off the pads bakes onto the face and it is heaviest at the centre
     * and in the corners of the spokes, which is exactly where it is hardest
     * to wash. */
    float dust = (0.35 + 0.65 * (1.0 - smoothstep(0.25, 0.85, r)))
               * (0.4 + 0.6 * (1.0 - sp));
    col = mix(col, vec3(0.0280, 0.0215, 0.0180), clamp(dust * (0.25 + dirt * 0.45), 0.0, 0.70));
    rgh = mix(rgh, 0.88, dust * (0.3 + dirt * 0.6));
    met = mix(met, 0.10, dust * 0.6);
    gAO *= 0.72;
    // Kerbing on the flange, which almost every parked car has.
    float kerb = step(0.55, hash21(vec2(seed, 9.1))) * age
               * smoothstep(0.93, 0.99, r) * smoothstep(0.4, 0.8, unit(wnoise(vec2(a * 3.0, 1.0))));
    col = mix(col, vec3(0.1900, 0.1920, 0.1950), kerb * 0.6);
    rgh = mix(rgh, 0.55, kerb);
  }

  diffuseColor.rgb *= col;
  roughnessFactor = clamp(rgh, 0.20, 1.0);
  metalnessFactor = met;
  gReflBlur = clamp(roughnessFactor * 1.5, 0.0, 0.95);
  roughnessFactor = max(roughnessFactor,
    smoothstep(30.0, 95.0, length(vWPos - cameraPosition)) * 0.85);
}
`;

export function makeCarWheelMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.8, metalness: 0.2,
    shadowSide: THREE.FrontSide,
    /* Off, unlike the body. Dithering exists to break up banding in smooth
     * gradients, and a wheel has none: what it has is a metal face with brake
     * dust ground into it, and the dither turned that into a band of visible
     * speckle in the near field. */
    dithering: false,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uSun = { value: new THREE.Vector3(...SUN_DIR) };
    shader.uniforms.uBuildLine = { value: BUILD_LINE };
    shader.uniforms.uHorizonSun = { value: new THREE.Vector3(...HORIZON_SUNWARD) };
    shader.uniforms.uHorizonAway = { value: new THREE.Vector3(...HORIZON_AWAY) };
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `
${FACADE_VARYINGS}
varying vec2 vFuv;
varying vec4 vWhl;
varying float vWhlBase;
attribute vec4 aWhl;
attribute vec2 aWhlB;
void main() {`)
      .replace('#include <begin_vertex>', `${FACADE_VERTEX}
vFuv = uv;
vWhl = aWhl;
vWhlBase = aWhlB.x;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {',
        `${NOISE}\n${CAR_PARS}\nvarying vec4 vWhl;\nvarying float vWhlBase;\n${CANYON}\n${STREET_PROBE}\nvoid main() {`)
      .replace(HOOK, `${HOOK}\n${WHEEL_BODY}`)
      .replace('#include <normal_fragment_maps>', `${FACADE_NORMAL}
{
  vec3 Vw = normalize(vWPos - cameraPosition);
  gRefl = streetProbe(vWPos, reflect(Vw, normalize(normal)), gReflBlur)
        * (1.0 - gPatch);
}`)
      .replace('#include <lights_fragment_maps>', CAR_MAPS(1.60));
  };
  m.customProgramCacheKey = () => 'sys4-wheel';
  return m;
}

/* ── The dark under the car ─────────────────────────────────────────────── */

/*
 * A multiply decal, and it is not a cheat.
 *
 * The largest light source in this scene is the sky, and a parked car occludes
 * essentially all of it from the square metre of road underneath. Nothing in
 * the renderer knows that: `scene.environment` is a single unoccluded probe,
 * the directional light's shadow at 4.2 degrees is thrown twenty metres
 * sideways and is not under the car at all, and the road material has no idea
 * anything is standing on it. Left alone, a car sits on tarmac lit exactly as
 * brightly as the tarmac beside it, which is the "reads as a sticker" failure
 * the brief names, and it is the same problem System 3 solved by stating the
 * contact occlusion on its own objects.
 *
 * Multiply rather than a black quad with alpha, because this is a subtraction
 * of light already resolved in the frame rather than a new dark object; and
 * untonemapped, because it has to act on the display value the road has
 * already arrived at. It fades with the same exponential the scene fog uses,
 * or a car a hundred metres away would carry a hard black patch through haze
 * that has taken everything else to grey.
 */
export function makeCarShadeMaterial(fogDensity: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uFog: { value: fogDensity } },
    vertexShader: /* glsl */ `
      attribute vec4 aShade;
      varying vec2 vQ;
      varying vec4 vS;
      varying float vD;
      void main(){
        vQ = uv;
        vS = aShade;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vD = -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uFog;
      varying vec2 vQ;
      varying vec4 vS;
      varying float vD;
      void main(){
        /* A rounded box the size of the body, plus a tighter, darker core
         * under each axle where the tyres are: the darkest place under a
         * parked car is the wedge between the tyre and the road, and the
         * ambient occlusion falls off quickly from it. */
        float bx = abs(vQ.x) / 0.72;
        float bz = abs(vQ.y) / 0.80;
        float body = 1.0 - smoothstep(0.55, 1.25, pow(pow(bx, 4.0) + pow(bz, 4.0), 0.25));
        float axles = 0.0;
        for (int i = 0; i < 2; i++){
          float az = i == 0 ? vS.y : vS.z;
          float d = length(vec2((abs(vQ.x) - vS.w) / 0.30, (vQ.y - az) / 0.16));
          axles = max(axles, 1.0 - smoothstep(0.35, 1.45, d));
        }
        float k = 1.0 - clamp(body * 0.62 + axles * 0.40, 0.0, 0.86);
        // Haze takes it away at the same rate it takes everything else.
        float fog = 1.0 - exp(-(uFog * vD) * (uFog * vD));
        k = mix(k, 1.0, clamp(fog, 0.0, 1.0));
        gl_FragColor = vec4(k, k, k, 1.0);
      }`,
    blending: THREE.MultiplyBlending,
    /* Required, and three only says so at runtime. Without it the multiply
     * case in WebGLState logs an error and then falls through without setting
     * a blend function at all, so the decal draws with whatever the previous
     * material left behind — which is to say, as a flat grey quad lying on the
     * road. The flag is inert here beyond that: the shader writes alpha 1 and
     * the colour it writes is a transmission, not a premultiplied radiance. */
    premultipliedAlpha: true,
    transparent: true,
    depthWrite: false,
    /* The road it sits on is 6 mm below, which at a hundred metres and a
     * grazing view is well inside a depth quantum. */
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    toneMapped: false,
    fog: false,
  });
}
