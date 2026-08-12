/* What a car surface is actually made of, in linear radiance, at the sun the
 * scene has now.
 *
 * ── Why another probe ─────────────────────────────────────────────────────
 *
 * Every existing car measurement in this tree reads an 8-bit PNG and inverts
 * it. That was the only instrument available before System 8, and it is now
 * the wrong one for authoring a material constant, for two reasons that pull
 * in opposite directions and cannot be separated after the fact:
 *
 *   - The canvas is no longer AgX-of-the-scene. It is AgX of (scene +
 *     volumetric in-scatter + bloom), then an ASC slope/offset/power, a
 *     highlight crosstalk, a vignette, a print toe and a midtone contrast.
 *     Inverting a car pixel through `display()` therefore attributes the
 *     grade and the veiling glare to the paint.
 *   - `pipeline.ts` renders the scene into a half-float target in *linear
 *     radiance* with no pedestal on it (`sensor.ts` does not install on the
 *     HDR path; `grade.tsx` applies the identical coefficients after AgX).
 *     That buffer is the number a material constant is authored in.
 *
 * So this tool renders the scene pass into a target of its own with the same
 * description as `rig.scene`, and reads *that* back. Then it also captures the
 * finished canvas through `capture()` and prints, side by side:
 *
 *     measured linear radiance  |  display() of it  |  the code actually on
 *                                                      screen at that pixel
 *
 * The gap between the last two is the whole of the post chain, printed rather
 * than assumed, per NOTES.md's rule about deriving the expected number by hand
 * and putting both on the screen next to each other. If the two columns ever
 * agree to a count on a surface with no bloom near it, the inversion is sound;
 * where they diverge, the divergence is the grade and not the material.
 *
 * ── Provenance ────────────────────────────────────────────────────────────
 *
 * NOTES.md: mislabelled sampling regions have cost this project at least four
 * conclusions. So a probe here is a *world point*, not a pixel. The tool aims
 * at it, projects it, raycasts back along the same ray, and reports the world
 * position it hit, the view depth, the height above the road under the car,
 * and which material owns the triangle. A probe that says `hit road at 12.4 m`
 * when its name says `heroShoulder` announces itself instead of producing a
 * number about an unknown place.
 *
 * ── The sun ───────────────────────────────────────────────────────────────
 *
 * Imported from `src/scene/sun.ts`. Not transcribed: `tools/agx.mjs` still
 * carries its own `SUN_DIR` at 4.2 degrees (agx.mjs:110) for its sky helpers,
 * and only `display`/`invert` are taken from it here, which do not touch it.
 *
 *   node tools/withlock.mjs carsun -- node tools/carsun.mjs before
 *   node tools/withlock.mjs carsun -- node tools/carsun.mjs after --stops heroFlank
 */
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';

register('./ts-hooks.mjs', import.meta.url);

const { run, capture, finish } = await import('./harness.mjs');
const { readPNG } = await import('./pxfile.mjs');
const { display } = await import('./agx.mjs');
const { SUN_DIR, SUN_ELEV, SUN_AZIM, SUN_BEAM_GROUND, SUN_INTENSITY } =
  await import('../src/scene/sun.ts');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = args[0] && !args[0].startsWith('--') ? args[0] : 'carsun';
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const ONLY = (flag('stops', '') || '').split(',').filter(Boolean);
const BOX = +flag('box', 5);
const QUERY = flag('q', '');

/* ── the cars, restated from world/cars.ts's own arithmetic ───────────────
 *
 * kerbX and the shape lengths are recomputed here rather than typed, for the
 * reason NOTES.md gives about derived constants; `roadHalf` and the widths are
 * the only inputs. They are imported below through the same TS hook the sun
 * is, so nothing in this block can drift from the build.                    */
const { PARKED } = await import('../src/world/cars.ts');

/* A probe is a world point with a name and an expectation about what it is.
 * `want` is the material cache key the hit should report; a mismatch is
 * printed loudly rather than silently averaged in. */
const carAt = (note) => PARKED.find((c) => c.note.startsWith(note + ':'));

const HERO = carAt('C');          // estate, near kerb, z -42.60
const SUNLIT = carAt('I');        // hatch, far kerb, z -76.30
const VAN = carAt('D');           // van, near kerb, z -63.50
const NEAR = carAt('A');          // saloon, near kerb, z -8.60
const RED = carAt('L');           // supermini, near kerb, z -47.55, the one saturated car
const BLACK = carAt('F');         // saloon, far kerb, z -13.00

/* Flank probes are aimed a little outside the skin and the raycast is left to
 * find it, rather than at a half-width typed out of the shape table. That is
 * what keeps this tool correct if the loft is ever redrawn — and `missBy` in
 * the output says how far outside the skin the aim actually was. */

const STOPS = [
  {
    name: 'sunward',
    note: 'mid-carriageway looking down the street into the sun; the frame the '
        + 'brief asks for, and the one where every reflected ray is near the halo',
    eye: [0.10, -20.0], look: [1.20, 1.35, -92.0],
    probes: [
      { name: 'farRoadSun', at: [0.9, 0.02, -60.0], want: null, is: 'carriageway, sunward' },
      { name: 'skyEnd', at: [1.6, 17.0, -140.0], want: null, is: 'sky over the end of the canyon' },
      { name: 'vanTailFar', at: [VAN.x, 1.20, VAN.z + 2.30], want: 'sys4-paint', is: 'van tail, 43 m out' },
      { name: 'hatchJFlank', at: [1.87 - 0.82, 0.75, -70.0], want: 'sys4-paint', is: 'graphite hatch flank' },
    ],
  },
  {
    name: 'heroFlank',
    note: 'across the hero estate\'s sunward flank at 3 m — the shoulder lobe, '
        + 'the waist crease and the road film, with sunlit road behind it',
    eye: [1.15, -38.2], look: [HERO.x + 0.90, 0.80, HERO.z],
    probes: [
      { name: 'flankSill', at: [HERO.x + 0.95, 0.30, HERO.z + 0.2], want: 'sys4-paint', is: 'below the film line' },
      { name: 'flankLow', at: [HERO.x + 0.95, 0.50, HERO.z + 0.2], want: 'sys4-paint', is: 'road film band' },
      { name: 'flankMid', at: [HERO.x + 0.95, 0.68, HERO.z + 0.2], want: 'sys4-paint', is: 'door skin, mid' },
      { name: 'flankShoulder', at: [HERO.x + 0.95, 0.88, HERO.z + 0.2], want: 'sys4-paint', is: 'the shoulder lobe' },
      { name: 'flankBelt', at: [HERO.x + 0.95, 0.94, HERO.z + 0.2], want: 'sys4-paint', is: 'waist moulding / belt' },
      { name: 'sideGlass', at: [HERO.x + 0.90, 1.20, HERO.z + 0.1], want: 'sys4-glass', is: 'front door glass' },
      { name: 'roofEdge', at: [HERO.x - 0.45, 1.36, HERO.z], want: 'sys4-paint', is: 'roof, at the near cant rail' },
      { name: 'roadBeside', at: [0.20, 0.02, HERO.z + 1.5], want: null, is: 'carriageway control, same frame' },
      { name: 'wallWest', at: [-5.65, 4.6, -46.0], want: null, is: 'west frontage control, same frame' },
      { name: 'wallWestLow', at: [-5.65, 1.6, -47.5], want: null, is: 'west frontage, ground storey' },
    ],
    profiles: [{
      name: 'heroFlankUp', is: 'sill to cant rail up the hero estate\'s sunward flank',
      want: 'sys4-paint',
      from: [HERO.x + 0.95, 0.16, HERO.z + 0.2], to: [HERO.x + 0.95, 1.44, HERO.z + 0.2], n: 33,
    }],
  },
  {
    name: 'heroFront',
    note: 'three-quarter front on the hero: bonnet, windscreen and the nose, '
        + 'which are the three panels whose normals moved most with the sun',
    eye: [1.05, -48.6], look: [HERO.x + 0.30, 1.05, HERO.z - 1.9],
    probes: [
      { name: 'bonnet', at: [HERO.x + 0.25, 0.92, HERO.z - 1.70], want: 'sys4-paint', is: 'bonnet, offside' },
      { name: 'bonnetMid', at: [HERO.x - 0.10, 0.94, HERO.z - 1.40], want: 'sys4-paint', is: 'bonnet, centre' },
      { name: 'screen', at: [HERO.x, 1.22, HERO.z - 0.90], want: 'sys4-glass', is: 'windscreen' },
      { name: 'noseCap', at: [HERO.x, 0.72, HERO.z - 2.28], want: 'sys4-paint', is: 'nose panel' },
      { name: 'wingOff', at: [HERO.x + 0.70, 0.86, HERO.z - 1.80], want: 'sys4-paint', is: 'offside front wing' },
      { name: 'roadAhead', at: [0.40, 0.02, HERO.z - 3.0], want: null, is: 'carriageway control' },
    ],
  },
  {
    name: 'sunlitHatch',
    note: 'car I on the far kerb — at 4.2 deg this was the one car with direct '
        + 'sun on it; the question is what 12 deg did to that',
    eye: [-0.55, -69.5], look: [SUNLIT.x - 0.85, 0.95, SUNLIT.z],
    probes: [
      { name: 'shadeFlank', at: [SUNLIT.x - 0.92, 0.70, SUNLIT.z], want: 'sys4-paint', is: 'street-side flank' },
      { name: 'shadeShoulder', at: [SUNLIT.x - 0.92, 0.92, SUNLIT.z], want: 'sys4-paint', is: 'street-side shoulder' },
      { name: 'roof', at: [SUNLIT.x - 0.52, 1.33, SUNLIT.z + 0.1], want: 'sys4-paint', is: 'roof, near cant rail' },
      { name: 'bonnet', at: [SUNLIT.x - 0.30, 0.88, SUNLIT.z - 1.60], want: 'sys4-paint', is: 'bonnet' },
      { name: 'glass', at: [SUNLIT.x - 0.78, 1.15, SUNLIT.z - 0.3], want: 'sys4-glass', is: 'side glass' },
      { name: 'roadHere', at: [0.0, 0.02, SUNLIT.z], want: null, is: 'carriageway control' },
      { name: 'wallEast', at: [5.55, 5.0, -78.0], want: null, is: 'east frontage control' },
    ],
    profiles: [{
      name: 'hatchFlankUp', is: 'sill to cant rail up car I\'s street-side flank',
      want: 'sys4-paint',
      from: [SUNLIT.x - 0.92, 0.16, SUNLIT.z], to: [SUNLIT.x - 0.92, 1.40, SUNLIT.z], n: 32,
    }],
  },
  {
    name: 'vanBroadside',
    note: 'the van — the largest flat flank and the largest glazing in the '
        + 'street, and the white car, which is the albedo test',
    eye: [1.60, -58.6], look: [VAN.x + 0.95, 1.20, VAN.z],
    probes: [
      { name: 'flankLow', at: [VAN.x + 1.00, 0.55, VAN.z], want: 'sys4-paint', is: 'van flank, low' },
      { name: 'flankMid', at: [VAN.x + 1.00, 1.10, VAN.z], want: 'sys4-paint', is: 'van flank, mid' },
      { name: 'flankHigh', at: [VAN.x + 1.00, 1.70, VAN.z], want: 'sys4-paint', is: 'van flank, high' },
      { name: 'flankTop', at: [VAN.x + 0.98, 1.95, VAN.z], want: 'sys4-paint', is: 'van flank, near the cant rail' },
      { name: 'glass', at: [VAN.x + 0.78, 1.55, VAN.z - 1.9], want: 'sys4-glass', is: 'van door glass' },
      { name: 'shopGlass', at: [-5.55, 1.60, -66.0], want: null, is: 'shopfront glazing control' },
      { name: 'roadBeside', at: [0.30, 0.02, VAN.z], want: null, is: 'carriageway control' },
    ],
    profiles: [{
      name: 'vanFlankUp', is: 'sill to cant rail up the white van\'s sunward flank',
      want: 'sys4-paint',
      from: [VAN.x + 1.00, 0.20, VAN.z], to: [VAN.x + 1.00, 2.05, VAN.z], n: 32,
    }],
  },
  {
    name: 'palette',
    note: 'four cars of four nominal colours in one frame, which is the only '
        + 'way to answer "does every car converge to the fill"',
    eye: [0.65, -3.0], look: [-0.60, 0.85, -14.0],
    probes: [
      { name: 'blueA_flank', at: [NEAR.x + 0.95, 0.70, NEAR.z], want: 'sys4-paint', is: 'A: deep blue' },
      { name: 'blueA_shoulder', at: [NEAR.x + 0.95, 0.92, NEAR.z], want: 'sys4-paint', is: 'A: deep blue shoulder' },
      { name: 'blackF_flank', at: [BLACK.x - 0.80, 0.70, BLACK.z], want: 'sys4-paint', is: 'F: black' },
      { name: 'blackF_shoulder', at: [BLACK.x - 0.80, 0.90, BLACK.z], want: 'sys4-paint', is: 'F: black shoulder' },
      { name: 'roadNear', at: [0.0, 0.02, -10.0], want: null, is: 'carriageway control' },
    ],
    profiles: [{
      name: 'blueFlankUp', is: 'sill to cant rail up the deep blue saloon',
      want: 'sys4-paint',
      from: [NEAR.x + 0.95, 0.16, NEAR.z], to: [NEAR.x + 0.95, 1.35, NEAR.z], n: 30,
    }],
  },
  {
    name: 'redCar',
    note: 'the supermini, the one saturated car in the street — the palette '
        + 'test that a hue rather than a level has to pass',
    eye: [1.30, -43.0], look: [RED.x + 0.85, 0.75, RED.z],
    probes: [
      { name: 'redFlank', at: [RED.x + 0.90, 0.68, RED.z], want: 'sys4-paint', is: 'red door skin' },
      { name: 'redShoulder', at: [RED.x + 0.90, 0.88, RED.z], want: 'sys4-paint', is: 'red shoulder' },
      { name: 'redRoof', at: [RED.x - 0.35, 1.24, RED.z], want: 'sys4-paint', is: 'red roof' },
      { name: 'redTail', at: [RED.x + 0.55, 0.80, RED.z + 1.85], want: 'sys4-paint', is: 'red tail / cluster corner' },
      { name: 'roadBeside', at: [0.30, 0.02, RED.z], want: null, is: 'carriageway control' },
      { name: 'wallWest', at: [-5.60, 4.2, -50.0], want: null, is: 'west frontage control' },
    ],
    profiles: [{
      name: 'redFlankUp', is: 'sill to cant rail up the red supermini',
      want: 'sys4-paint',
      from: [RED.x + 0.90, 0.16, RED.z], to: [RED.x + 0.90, 1.30, RED.z], n: 30,
    }],
  },
];

/* ── the environment, as the thing a car actually reflects ────────────────
 *
 * `streetProbe` in carMaterials.ts is a table of named radiances: a shaded
 * frontage low and high, a sunlit wall above the shade line, a ground storey,
 * a fascia, a stallriser, an awning, a sky sunward / away / zenith, a road
 * sunward / away, and a haze terminal at the end of the canyon. Every one of
 * those constants is a claim about a real surface in this scene, and every one
 * of them was set by inverting a measured display value through
 * `display = 0.284 * L^0.4545` — the curve NOTES.md withdrew, which
 * over-predicts the radiance behind a given code by three to six times across
 * exactly this band.
 *
 * So the constants are not checked by argument. Each one is pointed at the
 * surface it claims to describe and the two numbers are printed together. */
STOPS.push(
  {
    name: 'envSunward',
    note: 'mid-carriageway looking down the street into the sun — the sunlit '
        + 'west frontage, the sky, and the haze terminal, all in one frame',
    eye: [0.0, -40.0], look: [0.9, 5.5, -95.0],
    probes: [
      { name: 'skyZenith', at: [0.5, 60.0, -70.0], want: null, is: 'sky, high' },
      { name: 'skyUpper', at: [1.0, 26.0, -95.0], want: null, is: 'sky, upper, sunward' },
      { name: 'skyLowSun', at: [1.6, 15.5, -140.0], want: null, is: 'sky low toward the sun' },
      { name: 'canyonEnd', at: [0.6, 2.4, -132.0], want: null, is: 'the hazed end of the street' },
      { name: 'wallWSunHigh', at: [-5.62, 10.0, -56.0], want: null, is: 'west frontage, above the shade line' },
      { name: 'wallWSunMid', at: [-5.62, 7.4, -56.0], want: null, is: 'west frontage, mid' },
      { name: 'wallWLow', at: [-5.62, 4.2, -56.0], want: null, is: 'west frontage, first floor' },
      { name: 'wallWGround', at: [-5.62, 1.9, -56.0], want: null, is: 'west frontage, ground storey' },
      { name: 'wallWStall', at: [-5.62, 0.45, -56.0], want: null, is: 'west stallriser / pavement shadow' },
      { name: 'wallESun', at: [5.62, 9.5, -56.0], want: null, is: 'east frontage, high' },
      { name: 'wallEMid', at: [5.62, 4.5, -56.0], want: null, is: 'east frontage, mid' },
      { name: 'roadFarSun', at: [0.6, 0.0, -80.0], want: null, is: 'carriageway 40 m sunward' },
      { name: 'roadMidSun', at: [0.4, 0.0, -55.0], want: null, is: 'carriageway 15 m sunward' },
      { name: 'roadNearSun', at: [0.2, 0.0, -45.0], want: null, is: 'carriageway 5 m sunward' },
    ],
    profiles: [
      {
        /* Where the shade line on the west frontage actually is.
         *
         * streetProbe hardcodes it at 6.5 m. That constant was set at 4.2
         * degrees and it is a *geometric* quantity: the east terrace is 13 m
         * to the roofline across an 11.4 m street, and the beam drops
         * SUN_DIR.y / SUN_DIR.x per metre of x, so the line is at
         * 13 - 11.4 * (0.2079 / 0.5610) = 8.8 m now against 13 - 11.4 *
         * (0.0732 / 0.5713) = 11.5 m before. Neither is 6.5, so the constant
         * was never derived from the geometry and cannot be trusted in either
         * direction — hence measuring it rather than recomputing it. */
        name: 'wallWestUp', is: 'west frontage bottom to top, 13 m out — the shade line',
        from: [-5.62, 0.30, -52.0], to: [-5.62, 9.60, -52.0], n: 32,
      },
      {
        name: 'wallEastUp', is: 'east frontage bottom to top, the shaded side',
        from: [5.62, 0.30, -52.0], to: [5.62, 9.60, -52.0], n: 32,
      },
    ],
  },
  {
    name: 'envAway',
    note: 'the same block looking back up the street, away from the sun — the '
        + 'anti-sunward sky and road, which are the other end of every mix '
        + 'in streetProbe',
    eye: [0.0, -40.0], look: [-0.9, 5.5, 15.0],
    probes: [
      { name: 'skyZenith', at: [-0.5, 60.0, -10.0], want: null, is: 'sky, high' },
      { name: 'skyUpperAway', at: [-1.0, 26.0, 15.0], want: null, is: 'sky, upper, away from the sun' },
      { name: 'skyLowAway', at: [-1.6, 14.0, 60.0], want: null, is: 'sky low away from the sun' },
      { name: 'canyonEndAway', at: [-0.6, 2.4, 52.0], want: null, is: 'the hazed street, away' },
      { name: 'wallEAway', at: [5.62, 9.0, -26.0], want: null, is: 'east frontage seen looking away' },
      { name: 'wallWAway', at: [-5.62, 9.0, -26.0], want: null, is: 'west frontage seen looking away' },
      { name: 'roadFarAway', at: [-0.6, 0.0, -8.0], want: null, is: 'carriageway 32 m, away from the sun' },
      { name: 'roadMidAway', at: [-0.4, 0.0, -24.0], want: null, is: 'carriageway 16 m, away' },
      { name: 'gutterAway', at: [-2.9, 0.0, -34.0], want: null, is: 'gutter, away from the sun' },
    ],
  },
);

const stops = ONLY.length ? STOPS.filter((s) => ONLY.includes(s.name)) : STOPS;
if (!stops.length) {
  console.error(`no stop matched --stops ${ONLY.join(',')}; have: ${STOPS.map((s) => s.name).join(', ')}`);
  process.exit(2);
}

const outDir = path.join(ROOT, 'shots', tag);
fs.mkdirSync(outDir, { recursive: true });

/* ── page-side ────────────────────────────────────────────────────────────
 *
 * Installed once as source text and called per stop. It has to be one
 * synchronous block per stop for the same reason `capture()` is: an animation
 * frame between the placement and the draw is exactly the staleness the
 * liveness assertion exists to catch, and this tool must not be the thing that
 * hides it. */
const PAGE = String.raw`
window.__carsun = {
  /* A half-float target described exactly as pipeline.ts describes rig.scene,
   * minus the multisampling.
   *
   * samples: 0 deliberately. readRenderTargetPixels on a multisampled target
   * goes through a blit path, and the first thing to establish about a new
   * instrument is that it can report a non-zero — so the simpler path is
   * taken and the cost is that an edge pixel is aliased. Every probe here
   * sits in the interior of a panel, and the box mean over 5x5 makes the
   * difference smaller than the half-float quantum anyway. */
  rt: null,
  target(s) {
    const T = window.__THREE;
    const sz = new T.Vector2();
    s.renderer.getDrawingBufferSize(sz);
    const w = Math.max(2, Math.floor(sz.x)), h = Math.max(2, Math.floor(sz.y));
    if (this.rt && this.rt.width === w && this.rt.height === h) return this.rt;
    if (this.rt) this.rt.dispose();
    this.rt = new T.WebGLRenderTarget(w, h, {
      type: T.HalfFloatType, format: T.RGBAFormat,
      colorSpace: T.LinearSRGBColorSpace,
      minFilter: T.LinearFilter, magFilter: T.LinearFilter,
      generateMipmaps: false, depthBuffer: true, stencilBuffer: false,
    });
    return this.rt;
  },

  half(h) {
    const s = h >> 15 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
    if (e === 0) return s * f * Math.pow(2, -24);
    if (e === 31) return f ? NaN : s * Infinity;
    return s * (1 + f / 1024) * Math.pow(2, e - 15);
  },

  place(st) {
    const s = window.__scene, w = s.walker;
    w.placeAt(0.5);
    w.x = st.eye[0]; w.z = st.eye[1];
    w.snapGround();
    w.advanceGait(0);
    const T = window.__THREE;
    // Eye position after the ground snap, which is what the look angles must
    // be solved against — the eye is 145 mm higher on a footway than on the
    // carriageway and a yaw solved off the nominal height misses by a metre
    // at forty.
    const eye = new T.Vector3(w.eye.x, w.eye.y, w.eye.z);
    const f = new T.Vector3(st.look[0], st.look[1], st.look[2]).sub(eye).normalize();
    w.pitch = Math.asin(Math.max(-1, Math.min(1, f.y)));
    w.yaw = Math.atan2(-f.x, -f.z);
    s.setYaw(w.yaw); s.setPitch(w.pitch);
    return { eye: [eye.x, eye.y, eye.z], yaw: w.yaw, pitch: w.pitch };
  },

  /* One stop: place, render the scene pass into the private target, read the
   * probe boxes out of it, raycast each probe for provenance, and hand back
   * the liveness result taken between the render and the read.
   *
   * Called from capture()'s "before" hook, so that this and the PNG that
   * follows it are the same frozen camera in the same task. They were two
   * tasks in the first version of this tool, and the animation frames in
   * between were enough to move the eye 20 to 38 mm as the ground filter
   * settled — which is nothing on a door skin at five metres and moves a
   * grazing road pixel near the bottom of the frame by tens of code values.
   * Two of the controls disagreed with their own prediction by 27 counts and
   * the panels beside them agreed to 3, which is the signature of a spatial
   * mismatch and not of a grade. */
  measure(st, box) {
    const s = window.__scene, T = window.__THREE, gl = s.renderer;
    const placed = this.place(st);
    const rt = this.target(s);

    /* A full graded frame first, then the raw scene pass into the private
     * target.
     *
     * Not belt and braces — the liveness assertion caught this tool doing the
     * bug it exists to catch. s.renderScene is the unwrapped
     * "apply(); gl.render(scene, camera)", so it never reaches grade.tsx's
     * draw(), which is where uCoc is written from the camera. Rendering only
     * the scene pass after a teleport therefore left uCoc holding the previous
     * stop's eye height — 21 to 38 mm out on every stop — and the assertion
     * failed all seven. The state is harmless to *this* measurement, because
     * uCoc only drives the defocus in post and the readback is of the scene
     * pass; but "harmless here" is exactly the reasoning that shipped the mote
     * field 32 m behind the camera, so the tool is fixed rather than exempted.
     * One extra render per stop, and every enumerable per-frame term is now
     * current when the buffer under test is written. */
    s.renderOnce();
    gl.setRenderTarget(rt);
    (s.renderScene || s.renderOnce)();
    gl.setRenderTarget(null);
    const live = window.__liveness ? window.__liveness('hdr:' + st.name) : null;

    const cam = s.camera;
    cam.updateMatrixWorld();
    const W = rt.width, H = rt.height;
    const ray = new T.Raycaster();
    ray.far = 400;
    const out = [];

    /* The whole target in one readback.
     *
     * One readRenderTargetPixels per probe pixel was the first version and it
     * is a GL sync each time — 650 of them for a single vertical profile. One
     * 11 MB transfer is faster than thirty of them and it is also the only way
     * a profile is affordable at all. */
    const all = new Uint16Array(W * H * 4);
    gl.readRenderTargetPixels(rt, 0, 0, W, H, all);

    /* Did the instrument report anything? NOTES.md: a half-float target read
     * into the wrong buffer type returns four zeroes per texel with no error,
     * and that is indistinguishable from a pass that wrote nothing. */
    let rowMax = 0, rowNonZero = 0;
    const mid = Math.floor(H / 2) * W * 4;
    for (let i = 0; i < W; i++) {
      const v = this.half(all[mid + i * 4]);
      if (v > rowMax) rowMax = v;
      if (v > 0) rowNonZero++;
    }

    const boxAt = (px, py, b) => {
      let r = 0, g = 0, bl = 0, n = 0, mx = 0;
      for (let y = py - b; y <= py + b; y++) {
        for (let x = px - b; x <= px + b; x++) {
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const k = (y * W + x) * 4;
          const R = this.half(all[k]), G = this.half(all[k + 1]), B = this.half(all[k + 2]);
          if (!isFinite(R) || !isFinite(G) || !isFinite(B)) continue;
          r += R; g += G; bl += B; n++;
          mx = Math.max(mx, R, G, B);
        }
      }
      return n ? { L: [r / n, g / n, bl / n], peak: mx, samples: n } : { L: null, peak: 0, samples: 0 };
    };

    for (const p of st.probes) {
      const target = new T.Vector3(p.at[0], p.at[1], p.at[2]);
      const ndc = target.clone().project(cam);
      const px = Math.round((ndc.x * 0.5 + 0.5) * W);
      const py = Math.round((ndc.y * 0.5 + 0.5) * H);   // GL order, bottom-up
      const onScreen = ndc.x > -1 && ndc.x < 1 && ndc.y > -1 && ndc.y < 1 && ndc.z < 1;

      /* What is actually at that pixel. The ray is built from the same NDC the
       * box is read at, not from the intended point, so the answer describes
       * the pixel and not the intention. */
      ray.setFromCamera(new T.Vector2(ndc.x, ndc.y), cam);
      let hit = null;
      if (onScreen) {
        const hits = ray.intersectObject(s.scene, true)
          .filter((h) => h.object && h.object.visible && h.object.type === 'Mesh');
        hit = hits.length ? hits[0] : null;
      }

      const s5 = boxAt(px, py, Math.max(1, box) >> 1);

      let matKey = null, matName = null;
      if (hit && hit.object.material) {
        const m = hit.object.material;
        matName = m.name || m.type;
        try { matKey = m.customProgramCacheKey ? m.customProgramCacheKey() : null; } catch (e) { matKey = null; }
      }

      out.push({
        name: p.name, is: p.is, want: p.want || null,
        aimedAt: p.at,
        onScreen,
        // Screen pixel in image order (top-down), which is what a PNG reader
        // and every crop in shots/ uses. py is GL order.
        pixel: [px, H - 1 - py],
        L: s5.L,
        peak: s5.peak,
        samples: s5.samples,
        hitWorld: hit ? [hit.point.x, hit.point.y, hit.point.z] : null,
        depth: hit ? hit.distance : null,
        missBy: hit ? Math.hypot(hit.point.x - p.at[0], hit.point.y - p.at[1], hit.point.z - p.at[2]) : null,
        material: matKey || matName,
      });
    }

    /* Vertical profiles.
     *
     * Three points up a flank cannot answer "where is the highlight" — they
     * can only answer "is it at one of these three heights", and the first run
     * of this tool duly reported the shoulder darker than the mid on four cars
     * and brighter on one, which is not a finding, it is a sampling artefact.
     * A specular lobe is a *shape*: it has a peak height, a width and a
     * contrast against the panel around it, and none of the three survives
     * point sampling. So a profile walks a world-space line in n steps and
     * reports radiance against the height it actually hit. */
    const profiles = [];
    for (const pr of (st.profiles || [])) {
      const n = pr.n || 28;
      const pts = [];
      for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0 : i / (n - 1);
        const w = new T.Vector3(
          pr.from[0] + (pr.to[0] - pr.from[0]) * t,
          pr.from[1] + (pr.to[1] - pr.from[1]) * t,
          pr.from[2] + (pr.to[2] - pr.from[2]) * t);
        const nd = w.clone().project(cam);
        const px = Math.round((nd.x * 0.5 + 0.5) * W);
        const py = Math.round((nd.y * 0.5 + 0.5) * H);
        if (nd.x < -1 || nd.x > 1 || nd.y < -1 || nd.y > 1) { pts.push(null); continue; }
        ray.setFromCamera(new T.Vector2(nd.x, nd.y), cam);
        const hits = ray.intersectObject(s.scene, true)
          .filter((h) => h.object && h.object.visible && h.object.type === 'Mesh');
        const hit = hits.length ? hits[0] : null;
        let key = null;
        if (hit && hit.object.material) {
          const m = hit.object.material;
          try { key = m.customProgramCacheKey ? m.customProgramCacheKey() : (m.name || m.type); }
          catch (e) { key = m.name || m.type; }
        }
        const s3 = boxAt(px, py, 1);
        pts.push({
          aimY: +w.y.toFixed(3),
          hitY: hit ? +hit.point.y.toFixed(3) : null,
          hitX: hit ? +hit.point.x.toFixed(3) : null,
          depth: hit ? +hit.distance.toFixed(3) : null,
          pixel: [px, H - 1 - py],
          L: s3.L, material: key,
        });
      }
      profiles.push({ name: pr.name, is: pr.is, want: pr.want || null, points: pts });
    }

    return { placed, live, probes: out, profiles, W, H, rowMax, rowNonZero };
  },
};
`;

const f4 = (v) => (v === null || v === undefined ? '     -' : v.toFixed(4).padStart(8));
const f2 = (v) => (v === null || v === undefined ? '   -' : v.toFixed(2).padStart(6));

const url = 'http://127.0.0.1:3000' + (QUERY ? '?' + QUERY : '');

console.log(`\n  sun: elev ${(SUN_ELEV * 180 / Math.PI).toFixed(3)} deg  azim `
  + `${(SUN_AZIM * 180 / Math.PI).toFixed(1)} deg  dir `
  + `(${SUN_DIR.map((v) => v.toFixed(6)).join(', ')})`);
console.log(`       beam ${SUN_BEAM_GROUND.map((v) => v.toFixed(3)).join(', ')}  `
  + `intensity ${SUN_INTENSITY}  E_horizontal `
  + `${(SUN_INTENSITY * Math.sin(SUN_ELEV)).toFixed(3)}   (imported, not transcribed)`);

await run({ width: 1600, height: 900, url }, async ({ page, errs, readShaderErrors }) => {
  await page.evaluate(PAGE);

  const report = {
    tag, when: new Date().toISOString(), query: QUERY, box: BOX,
    sun: {
      elevDeg: +(SUN_ELEV * 180 / Math.PI).toFixed(4),
      azimDeg: +(SUN_AZIM * 180 / Math.PI).toFixed(4),
      dir: SUN_DIR.map((v) => +v.toFixed(6)),
      beam: SUN_BEAM_GROUND.map((v) => +v.toFixed(4)),
      eHorizontal: +(SUN_INTENSITY * Math.sin(SUN_ELEV)).toFixed(4),
    },
    stops: [],
  };

  for (const st of stops) {
    /* Place once and let the ground filter and the gait settle, then place
     * again inside the capture task. The first placement is what makes the
     * second one a no-op rather than a teleport, and a settled camera is what
     * makes the two halves of the pair comparable. */
    await page.evaluate((s0) => { window.__carsunStop = s0; window.__carsun.place(s0); }, st);
    await page.waitForTimeout(150);

    const file = path.join(outDir, `${st.name}.png`);
    await capture(page, file, {
      before: `window.__carsunLast = window.__carsun.measure(window.__carsunStop, ${BOX});`,
    });
    const m = await page.evaluate(() => window.__carsunLast);

    /* The instrument reports a non-zero before any probe from it is believed.
     * NOTES.md: a half-float target read into the wrong buffer type returns
     * four zeroes per texel with no error, and that is indistinguishable from
     * a pass that wrote nothing. */
    if (!(m.rowMax > 0) || m.rowNonZero < 10) {
      console.error(`  ✗ ${st.name}: the HDR readback is dead — centre row max `
        + `${m.rowMax}, non-zero texels ${m.rowNonZero}/${m.W}. Not reporting numbers from it.`);
      process.exitCode = 1;
      continue;
    }

    // The finished, graded frame, from the same task and the same camera.
    const img = readPNG(file);

    let clipped = 0, clippedAny = 0;
    for (let i = 0; i < img.w * img.h; i++) {
      const k = i * img.ch;
      const hi = (img.data[k] >= 255) + (img.data[k + 1] >= 255) + (img.data[k + 2] >= 255);
      if (hi) clippedAny++;
      if (hi === 3) clipped++;
    }

    const liveOk = m.live && (!m.live.failures || !m.live.failures.length);
    console.log(`\n─── ${st.name} ${'─'.repeat(Math.max(0, 56 - st.name.length))}`);
    console.log(`  ${st.note}`);
    console.log(`  eye ${m.placed.eye.map((v) => v.toFixed(3)).join(', ')}  `
      + `yaw ${m.placed.yaw.toFixed(4)}  pitch ${m.placed.pitch.toFixed(4)}`);
    console.log(`  hdr liveness: ${m.live ? (liveOk ? 'ok' : 'FAIL ' + JSON.stringify(m.live.failures)) : 'not installed'}`);
    console.log(`  clipped px: ${clipped} all-channel, ${clippedAny} any-channel  of ${img.w * img.h}`);
    if (m.live && m.live.failures && m.live.failures.length) process.exitCode = 1;

    console.log('\n  probe            px         depth  hit                       '
      + 'L linear (r g b)                pred   on screen   material');
    const rows = [];
    for (const p of m.probes) {
      /* sensor: true. On the HDR path `sensor.ts` does not patch the scene
       * pass — `grade.tsx` applies the identical pedestal and gain immediately
       * after AgX instead — so the pedestal is still in the delivered frame
       * and leaving it out reads three counts where the frame says twenty-four.
       * Measured on the first run of this tool: `flankSill` predicted 3,2,2
       * without it against 24,23,27 on the canvas. */
      const pred = p.L ? display(p.L, { sensor: true }) : null;
      // The canvas code at the same pixel, from the PNG just written.
      let code = null;
      if (p.onScreen) {
        const b = BOX >> 1;
        let r = 0, g = 0, bl = 0, n = 0;
        for (let y = p.pixel[1] - b; y <= p.pixel[1] + b; y++) {
          for (let x = p.pixel[0] - b; x <= p.pixel[0] + b; x++) {
            if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
            const k = (y * img.w + x) * img.ch;
            r += img.data[k]; g += img.data[k + 1]; bl += img.data[k + 2]; n++;
          }
        }
        if (n) code = [r / n, g / n, bl / n];
      }
      const bad = p.want && p.material !== p.want;
      rows.push({ ...p, pred, code, mismatch: !!bad });
      console.log(`  ${(bad ? '! ' : '  ') + p.name.padEnd(15)}`
        + ` ${String(p.pixel[0]).padStart(4)},${String(p.pixel[1]).padStart(4)}`
        + ` ${f2(p.depth)}m  ${(p.hitWorld ? p.hitWorld.map((v) => v.toFixed(2).padStart(6)).join(' ') : '   -    -    -')}`
        + `  ${p.L ? p.L.map(f4).join(' ') : '        -'}`
        + `  ${pred ? pred.map((v) => String(v).padStart(3)).join(' ') : '  -'}`
        + `  ${code ? code.map((v) => v.toFixed(0).padStart(3)).join(' ') : '  -'}`
        + `   ${p.material || '-'}`);
      if (bad) {
        console.log(`      ^ expected ${p.want}, hit ${p.material} at `
          + `${p.depth ? p.depth.toFixed(2) : '?'} m — this probe is NOT measuring ${p.is}`);
      }
    }

    for (const pr of (m.profiles || [])) {
      console.log(`\n  profile ${pr.name} — ${pr.is}`);
      console.log('    aimY   hitY   hitX   depth   L linear (r,g,b)              lum      pred      material');
      for (const q of pr.points) {
        if (!q) { console.log('      (off screen)'); continue; }
        const lum = q.L ? 0.2126 * q.L[0] + 0.7152 * q.L[1] + 0.0722 * q.L[2] : null;
        const pred = q.L ? display(q.L, { sensor: true }) : null;
        const off = pr.want && q.material !== pr.want;
        console.log(`    ${q.aimY.toFixed(2).padStart(5)} `
          + `${(q.hitY === null ? '  -' : q.hitY.toFixed(3)).padStart(6)} `
          + `${(q.hitX === null ? '  -' : q.hitX.toFixed(2)).padStart(6)} `
          + `${(q.depth === null ? '  -' : q.depth.toFixed(2)).padStart(6)}  `
          + `${q.L ? q.L.map(f4).join(' ') : '       -'}  `
          + `${lum === null ? '   -' : lum.toFixed(4).padStart(7)}  `
          + `${pred ? pred.map((v) => String(v).padStart(3)).join(' ') : '  -'}  `
          + `${off ? '!! ' : '   '}${q.material || '-'}`);
      }
    }

    report.stops.push({
      name: st.name, note: st.note, eye: m.placed.eye,
      yaw: m.placed.yaw, pitch: m.placed.pitch,
      clippedAll: clipped, clippedAny, pixels: img.w * img.h,
      liveness: m.live, probes: rows, profiles: m.profiles || [],
      png: path.relative(ROOT, file),
    });
  }

  report.shaderErrors = await readShaderErrors();
  report.errors = [...new Set(errs)];
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`\n  → ${path.relative(ROOT, outDir)}   shaderErrors=${report.shaderErrors.length}`);
});

finish(process.exitCode || 0);
