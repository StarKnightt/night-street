/* TEMP: replaced in System 5.
 *
 * Placeholder night environment. There is no sky system and no lamp geometry
 * yet — this exists only so the road can be judged honestly, and it does the
 * two jobs that a night road needs from its surroundings:
 *
 *   1. Something for the wet parts to reflect. A roughness map is invisible
 *      without an environment: with a black surround, a smooth patch and a
 *      rough patch both render black and every bit of the material work in
 *      materials.ts disappears. The gradient below is what makes the damp in
 *      the gutter read as damp.
 *   2. A background that is not pure black. Real 11 pm city sky is a dirty
 *      orange-brown near the rooftops from sodium bouncing off the
 *      atmosphere, fading to a desaturated navy overhead. Pure black behind a
 *      street is a studio backdrop.
 *
 * Both are generated as a small equirectangular float texture. No assets.
 */
import * as THREE from 'three';
import { bakeSkyCube } from './clouds';

/* Resolution.
 *
 * The night sky was a smooth four-colour gradient and 192 x 96 carried it
 * without banding. A golden hour sky has a sun halo with a tight angular
 * falloff in it, and at 192 wide one texel spans nearly two degrees, which
 * quantises the halo into visible steps in both the background and the
 * reflections taken off it. This is still a trivial texture.
 */
const W = 512, H = 256;

/* The sun.
 *
 * Elevation trades two things against each other and 6 degrees is where they
 * balance. Shadow length is height over the tangent of the elevation, so lower
 * is better for the signature effect: at 6 degrees a 145 mm kerb throws a
 * 1.4 m shadow clear across a lane.
 *
 * But the ground is a horizontal surface, and a horizontal surface facing a
 * 6 degree sun receives sin(6) — about a tenth — of the beam. Go much below
 * this and direct sun on the carriageway falls under the skylight filling it
 * from above, at which point shadows stop being visible at all: there is
 * nothing for them to subtract. That is a real constraint rather than a
 * preference, and it is why the sun's intensity has to be set against the sky
 * rather than picked in isolation.
 *
 * Azimuth is measured from the far end of the street and offset 28 degrees to
 * the +X side. Dead down the centreline would throw every shadow straight at
 * the camera, where it is foreshortened into nothing and the length is
 * invisible; 28 degrees is enough that shadows cross the road diagonally and
 * that one footway is lit while the other sits in shade, but not so much that
 * the sun leaves the end of the street and the glow stops closing the view.
 */
export const SUN_ELEV = 4.2 * Math.PI / 180;
export const SUN_AZIM = 35.0 * Math.PI / 180;

/** Unit vector pointing from the scene toward the sun. */
export const SUN_DIR: [number, number, number] = [
  Math.sin(SUN_AZIM) * Math.cos(SUN_ELEV),
  Math.sin(SUN_ELEV),
  -Math.cos(SUN_AZIM) * Math.cos(SUN_ELEV),
];

export type NightEnv = {
  background: THREE.Texture;
  environment: THREE.Texture;
  fogColor: THREE.Color;
  fogSunColor: THREE.Color;
  dispose(): void;
};

function mix3(a: readonly number[], b: readonly number[], t: number,
              out: [number, number, number]) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
}

/* Golden hour sky.
 *
 * Three things make this read as the half hour before sunset rather than as an
 * orange gradient, and all three are about *asymmetry*:
 *
 *   1. The warmth belongs where the sun is. A sky that is uniformly gold all
 *      the way round the horizon is a studio dome. Real low sun puts a
 *      concentrated gold-orange wedge around its own azimuth, and the horizon
 *      opposite is already dusk — cooler, duskier and a good deal darker.
 *   2. The vertical gradient is not linear. Gold is confined to a shallow band
 *      a few degrees deep, running quickly through peach and pink and reaching
 *      blue-purple well before the zenith.
 *   3. There is a halo. Aerosol scattering piles light up around the disc over
 *      perhaps twenty degrees, and it is the single strongest source of the
 *      milky glare that a phone camera produces looking into a low sun.
 *
 * Levels are absolute rather than picked by eye, because this texture is also
 * the image-based light for the whole scene: the shadow side of every surface
 * is lit by it and nothing else, so its ratio against the sun is what sets how
 * deep the shade goes.
 */
function skyRadiance(theta: number, phi: number, out: [number, number, number], withDisc = true) {
  const up = Math.cos(theta);                 // +1 zenith, -1 nadir
  const sinT = Math.sin(theta);

  // Angle between this direction and the sun.
  const dx = Math.cos(phi) * sinT, dy = up, dz = Math.sin(phi) * sinT;
  const cosSun = dx * SUN_DIR[0] + dy * SUN_DIR[1] + dz * SUN_DIR[2];

  /* Azimuthal weight: 1 straight at the sun, 0 directly behind. Raised to a
   * power so the warm wedge is a wedge and not half the sky.
   *
   * The exponent was 2.2 and that was measurably wrong, in a way that was
   * invisible in the background and fatal in the lighting. Integrate this dome
   * over the hemisphere of a wall facing away from the sun — which is what the
   * diffuse IBL term is, and what tools/skyprobe.mjs does — and at 2.2 the
   * answer comes back blue-over-red 0.79. The shaded side of the street was
   * being filled by a *warm* source, which is precisely the "shade is just
   * less orange" that three rounds of review kept reporting and which no
   * amount of tuning the gain could have fixed.
   *
   * The cause is that the sun is only 35 degrees off the street axis, so a
   * wall facing -X still has most of the sun-side horizon inside its own
   * hemisphere at grazing azimuths, and that horizon is eleven times the
   * brightness of the one opposite. At 4.6 the wedge falls to a twentieth by
   * 90 degrees off-sun while still covering the view down the street, and the
   * same integral returns 1.64. */
  const azW = Math.pow(Math.max(0, 0.5 + 0.5 * (
    (dx * SUN_DIR[0] + dz * SUN_DIR[2]) /
    Math.max(1e-4, Math.hypot(dx, dz) * Math.hypot(SUN_DIR[0], SUN_DIR[2]))
  )), 4.6);

  /* Cooled from (0.068, 0.118, 0.390) but deliberately not as far as the first
   * attempt at (0.055, 0.105, 0.440). Blue over red of eight is more saturated
   * than any real sky and it showed up where the sky is reflected rather than
   * seen — a window whose ray clears the parapet returned an electric blue
   * rectangle in an otherwise warm frame. At 4.2 it is still unmistakably
   * blue-violet, and the hemisphere integral onto a shaded wall only drops
   * from 1.64 to 1.41, which the canyon term more than makes up. */
  const zenith: [number, number, number] = [0.0850, 0.1300, 0.3600];
  const upperWarm: [number, number, number] = [0.7400, 0.3900, 0.3450];
  const horizonSun: [number, number, number] = [3.4000, 1.4200, 0.4200];
  const horizonAway: [number, number, number] = [0.2000, 0.2000, 0.3100];

  // Height blend: gold hugs the horizon, purple takes over quickly.
  const h = Math.pow(Math.max(0, 1 - Math.max(0, up)), 5.6);   // horizon band
  const m = Math.pow(Math.max(0, 1 - Math.max(0, up)), 2.30);  // mid transition

  const horizonC: [number, number, number] = [0, 0, 0];
  mix3(horizonAway, horizonSun, azW, horizonC);

  const base: [number, number, number] = [0, 0, 0];
  mix3(zenith, upperWarm, m * (0.14 + 0.86 * azW), base);
  const col: [number, number, number] = [0, 0, 0];
  mix3(base, horizonC, h, col);

  /* The halo. A wide aerosol lobe plus a tight one near the disc; the disc
   * itself is left to the directional light and the tone mapper rather than
   * being painted in, so that it blows out the way a real one does. */
  const ang = Math.acos(Math.max(-1, Math.min(1, cosSun)));
  const wide = Math.exp(-ang * 5.6) * 0.45;
  const tight = Math.exp(-ang * 19.0) * 5.60;
  const halo = wide + tight;
  col[0] += halo * 1.60; col[1] += halo * 0.86; col[2] += halo * 0.34;

  /* The disc itself, and it is meant to clip.
   *
   * This was previously left entirely to the directional light on the grounds
   * that a light has no image — but a directional light is at infinity and
   * draws nothing at all, so looking straight down the street at a four degree
   * sun there was simply nothing there. The brightest thing in the frame was
   * the road. Half a degree of core at a couple of hundred times the horizon
   * value is roughly the right order for a sun this low through this much
   * atmosphere, and it is the one place in the picture where clipping is not
   * only allowed but required. */
  if (withDisc) {
    const disc = Math.exp(-ang * 150.0) * 190.0;
    col[0] += disc * 1.00; col[1] += disc * 0.80; col[2] += disc * 0.52;
  }

  /* Below the horizon.
   *
   * This hemisphere is doing two jobs at once and they pull in opposite
   * directions. It is the ground term of the image-based light, where a dark
   * warm value is right — light coming back up off asphalt is dim. But it is
   * also what the camera *sees* below the horizon line wherever the street
   * geometry runs out, and there are no buildings yet to hide that. Authored
   * dark, it drew a heavy brown band across the bottom of the sky that read as
   * a wall closing off the end of the street.
   *
   * With haze this thick, distant ground is nearly all scattered light anyway,
   * so it should sit just under the horizon value rather than collapsing to a
   * separate dark colour. The falloff is slow for the same reason: a hard
   * transition at the horizon is the band.
   */
  if (up < 0) {
    const d = Math.min(1, -up * 1.15);
    const gnd: [number, number, number] = [
      col[0] * 0.52 + 0.030, col[1] * 0.50 + 0.024, col[2] * 0.54 + 0.026,
    ];
    mix3(col, gnd, d * 0.85, col);
  }
  out[0] = col[0]; out[1] = col[1]; out[2] = col[2];
}

/* makeLampCookie() stood here and is deleted rather than ported.
 *
 * It was a 128 x 256 projected photometric distribution for the fourteen
 * stand-in SpotLights: an elongated pool with a reflector cut-off on the house
 * side, a core offset forward of the pole, and sixty years of dirt on the
 * bowl. The reasoning behind it was sound and the technique is the right one —
 * projecting a measured distribution is how luminaire photometry is actually
 * handled — and it is still the wrong thing to keep, for a reason that has
 * nothing to do with its quality.
 *
 * The lights it fed were measured contributing 0.0 per cent to the shaded
 * frontage and 0.10 per cent to the carriageway, and the texture unit this
 * cost in every material program in the street is why three paving materials
 * were running without their baked occlusion maps. System 5 keeps the one part
 * of it that was doing visible work — the asymmetric cut-off — as a cosine
 * power in the analytic loop in scene/lights.ts, for one pow and no texture.
 */

/* Which sky to draw, for measuring rather than for shipping.
 *
 * Every one of this project's expensive failures has been a term that was
 * present, typechecked, read correctly and did nothing, and the only defence
 * that has ever worked is a differenced pair off one build. So the two things
 * the cloud pass changed can each be switched back:
 *
 *   ?sky=flat       the 512x256 equirect DataTexture, drawn the way three
 *                   actually draws one — the exact background every frame in
 *                   the archive was shot through, screen-space blit and all.
 *   ?sky=noclouds   the cube, direction-mapped, carrying skyBase() and nothing
 *                   else. Differencing this against `flat` isolates the
 *                   projection fix; differencing it against the default
 *                   isolates the clouds.
 *
 * Dev only, and absent from a production build, so the shipped path is one
 * branch with a constant condition.
 */
function skyMode(): 'clouds' | 'noclouds' | 'flat' {
  if (process.env.NODE_ENV === 'production') return 'clouds';
  if (typeof window === 'undefined') return 'clouds';
  const q = new URLSearchParams(window.location.search).get('sky');
  return q === 'flat' ? 'flat' : q === 'noclouds' ? 'noclouds' : 'clouds';
}

export function makeNightEnv(renderer: THREE.WebGLRenderer): NightEnv {
  const data = new Float32Array(W * H * 4);   // light probe, no disc
  const bg = new Float32Array(W * H * 4);     // what the camera sees
  const c: [number, number, number] = [0, 0, 0];
  for (let y = 0; y < H; y++) {
    const theta = ((y + 0.5) / H) * Math.PI;
    for (let x = 0; x < W; x++) {
      /* Half a turn of offset, and it was rotating the entire sky.
       *
       * Three.js samples an equirectangular map with
       *   u = atan2( dir.z, dir.x ) / 2pi + 0.5
       * so the texel at u = 0.5 — the middle column — is the +X direction, and
       * u = 0 is -X. This loop was writing the direction whose azimuth is phi
       * at u = phi / 2pi, dropping that +0.5 entirely, so every direction in
       * the sky was stored one hundred and eighty degrees away from where it
       * would be read back.
       *
       * The result is subtle enough to survive several rounds of review: the
       * gradient still looked like a sky, still had a warm side and a cool
       * side, and still had a halo. It was simply pointing the wrong way. The
       * ground was lit correctly the whole time, because the directional light
       * takes SUN_DIR directly and never goes through this texture — so the
       * lit kerb faces and the specular rim sat on one side of frame while the
       * only warm patch of sky sat on the other, and the vanishing point,
       * where the sun actually is, was the dullest part of the picture.
       *
       * This also had the environment light illuminating the shade from the
       * anti-sun side, which is why no amount of tuning the fill would make
       * the warm/cool opposition read. */
      const phi = ((x + 0.5) / W - 0.5) * Math.PI * 2;
      const k = (y * W + x) * 4;

      /* Two skies: one to look at, one to light by.
       *
       * They differ only in the sun's disc, and the disc has to be in one and
       * not the other. In the background it is the whole point — a sun this
       * low ought to be the brightest thing in frame by orders of magnitude
       * and ought to clip. In the light probe it is a disaster: convolving a
       * couple of hundred units of radiance over the hemisphere lifts the
       * ambient term enough to fill every shadow in the scene, which is
       * exactly what happened — shadow floors rose by half a stop and the
       * frame went flat the moment the disc was added.
       *
       * Physically the disc's contribution is not missing from the lighting,
       * it is simply accounted for once rather than twice: the directional
       * light already carries it, and carries it with hard shadows, which is
       * what a source of half a degree actually produces. Leaving it out of
       * the probe is the correct decomposition, not a cheat. */
      skyRadiance(theta, phi, c, true);
      bg[k] = c[0]; bg[k + 1] = c[1]; bg[k + 2] = c[2]; bg[k + 3] = 1;

      skyRadiance(theta, phi, c, false);
      data[k] = c[0]; data[k + 1] = c[1]; data[k + 2] = c[2]; data[k + 3] = 1;
    }
  }

  const equirect = new THREE.DataTexture(bg, W, H, THREE.RGBAFormat, THREE.FloatType);
  equirect.mapping = THREE.EquirectangularReflectionMapping;
  equirect.colorSpace = THREE.NoColorSpace;
  // Row 0 of the buffer is the zenith. A DataTexture does not flip, and the
  // equirect mapping expects v = 0 at the bottom, so without this the sky is
  // upside down and the sodium glow ends up under your feet.
  equirect.flipY = true;
  equirect.minFilter = THREE.LinearFilter;
  equirect.magFilter = THREE.LinearFilter;
  equirect.wrapS = THREE.RepeatWrapping;
  equirect.needsUpdate = true;

  /* The probe is convolved from the disc-free copy. */
  const probeSrc = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.FloatType);
  probeSrc.mapping = THREE.EquirectangularReflectionMapping;
  probeSrc.colorSpace = THREE.NoColorSpace;
  probeSrc.flipY = true;
  probeSrc.minFilter = THREE.LinearFilter;
  probeSrc.magFilter = THREE.LinearFilter;
  probeSrc.wrapS = THREE.RepeatWrapping;
  probeSrc.needsUpdate = true;

  /* What the camera sees, and why it is a cube.
   *
   * The equirect above is kept — it is still what `?sky=flat` draws, and
   * disposing of it costs nothing to hold — but it is not what ships, for a
   * reason that is a bug rather than a preference and is written up at the top
   * of clouds.ts: three does not direction-map an equirectangular `Texture`
   * assigned to `scene.background`. `WebGLBackground.addToRenderList`
   * dispatches on `isCubeTexture || CubeUVReflectionMapping`, and an equirect
   * fails both, so it is drawn by `ShaderLib.background` — a screen-space quad
   * sampling the texture at the quad's own uv, with no view direction in the
   * shader at all. The panorama was being stretched flat across the viewport
   * and nailed to the screen.
   *
   * A cube render target is `isCubeTexture`, so it takes the boxMesh path and
   * is sampled by world direction. That is the whole of the fix, and the clouds
   * are what it was worth fixing for.
   *
   * NOTE FOR THE LIGHTING: nothing below this line touches the probe. The
   * environment map is still convolved from `data`, which is still written by
   * the same `skyRadiance(..., false)` over the same 512x256 grid, so the
   * irradiance the scene receives is not merely close to what it was — it is
   * the same Float32Array, produced by the same code path, and cannot have
   * moved. See tools/skycloud.mjs for the measurement that says so anyway.
   */
  const mode = skyMode();
  const cube = mode === 'flat'
    ? null
    : bakeSkyCube(renderer, SUN_DIR, { size: 1536, clouds: mode === 'clouds' });

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const target = pmrem.fromEquirectangular(probeSrc);
  probeSrc.dispose();
  pmrem.dispose();

  /* Haze, in two colours rather than one, and both taken from the sky.
   *
   * Atmospheric haze is not isotropic and at this hour that is the whole
   * point. Dust and moisture scatter strongly forward, so looking toward a low
   * sun you are looking down the beam and the air itself glows; turn around
   * and the same air is nearly clear and distinctly cooler.
   *
   * Which colours to use is not a free choice. Haze is the sky seen up close,
   * so distant ground saturates toward whatever the sky is doing in that same
   * direction — and if it saturates toward anything else, the two meet at a
   * visible step and the horizon becomes a hard line drawn across the frame.
   * An azimuth-averaged value was doing exactly that: too bright for the dusk
   * side, too dim for the sun side, and matching the sky in no direction at
   * all, which lit the filler ground like a desert and drew a bright seam
   * where it ended.
   *
   * So these are sampled at the horizon in the two directions the shader
   * blends between, and the blend exponent is matched to the sky's own
   * azimuthal falloff so the two track each other all the way round. Both sit
   * slightly under the sky, because ground haze is looking through a little
   * more of the atmosphere than the sky above it is.
   */
  const sunAz = Math.atan2(SUN_DIR[2], SUN_DIR[0]);
  const away: [number, number, number] = [0, 0, 0];
  const sunward: [number, number, number] = [0, 0, 0];
  skyRadiance(Math.PI * 0.5 - 0.012, sunAz + Math.PI, away);
  skyRadiance(Math.PI * 0.5 - 0.012, sunAz, sunward);

  const fogColor = new THREE.Color(away[0] * 0.88, away[1] * 0.90, away[2] * 0.96);
  /* Recalibrated, because until now it was multiplying a term that was always
   * zero and so its magnitude had never actually been tested. At 0.80 of the
   * sunward horizon radiance the haze is brighter than the sky it is supposedly
   * scattering, and the moment the directional lobe started working it clipped
   * the entire sun-facing half of every frame to white. What in-scattered air
   * returns is a fraction of the beam, not the beam. */
  const fogSunColor = new THREE.Color(
    Math.min(sunward[0] * 0.27, 1.4),
    Math.min(sunward[1] * 0.27, 0.9),
    Math.min(sunward[2] * 0.34, 0.5),
  );
  void c;

  return {
    background: cube ? cube.texture : equirect,
    environment: target.texture,
    fogColor,
    fogSunColor,
    dispose() { equirect.dispose(); target.dispose(); cube?.dispose(); },
  };
}

/* Horizon radiance in the two directions the haze blends between.
 *
 * Exported because the shopfront glazing resolves its own reflected ray
 * against a hand-built model of the street, and a reflected ray has to be
 * fogged by the same air everything else is fogged by. A ray running down the
 * canyon travels forty metres before it meets anything, which is most of the
 * way to the horizon glow, and that is the term that decides whether a
 * shopfront at low sun reads as a mirror or as a hole. Sampling the sky twice
 * more at module load costs microseconds and means the reflection cannot
 * drift away from the street it is reflecting.
 */
function horizonRadiance(phi: number): [number, number, number] {
  const o: [number, number, number] = [0, 0, 0];
  skyRadiance(Math.PI * 0.5 - 0.012, phi, o, false);
  return o;
}
const SUN_AZ_XZ = Math.atan2(SUN_DIR[2], SUN_DIR[0]);
export const HORIZON_SUNWARD = horizonRadiance(SUN_AZ_XZ);
export const HORIZON_AWAY = horizonRadiance(SUN_AZ_XZ + Math.PI);
