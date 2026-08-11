/* Capture a walk, frame by frame, off the wall clock.
 *
 *   node tools/reel.mjs [tag] [--w 1280] [--h 720] [--fps 30] [--seconds 30]
 *                       [--shot name] [--q 0.94] [--png] [--noVideo] [--cpu]
 *
 * `shoot.mjs` stops and looks. This one walks, and the difference is the whole
 * point of it: roughly two hundred still frames have been captured on this
 * project and the scene has never once been watched in motion. Foot slide, a
 * head bob out of step with the gait, a kerb the walker steps through, and
 * specular sparkle that appears and disappears between frames are all
 * invisible to a still and all fatal to a thirty-second video.
 *
 * Three things make the output reproducible rather than a recording of how
 * fast the capture machine happened to be:
 *
 *  1. The r3f loop is switched to `frameloop: 'never'` and advanced by hand,
 *     one output frame at a time, through `__scene.step(dt)`. Every `useFrame`
 *     in the scene — the walker, the dust, the shadow follower, the audio
 *     engine — sees exactly 1/fps. `setPaused` was not enough: it only stops
 *     the Rig's own update and leaves the other four running on real time, so
 *     a slow capture would have moved the dust three times as far per frame as
 *     the walk.
 *  2. Travel is the real input path. A `KeyW` keydown goes into the same
 *     window listener the keyboard uses, and steering goes through
 *     `walker.look()` at the same sensitivity as the mouse. Nothing here
 *     teleports the camera or lerps it along a spline, because a dolly would
 *     hide the exact defects this tool exists to find.
 *  3. Frame cost is timed around a one-pixel `readPixels`, not `glFinish`.
 *     `glFinish` returns when Chromium has handed the command buffer over,
 *     not when the GPU has finished — `docs/TECHNIQUE.md` §7 records the
 *     reference project publishing a post chain that appeared to cost forty
 *     microseconds because of it.
 *
 * Alongside the frames it writes `reel.json`: per-frame walker state, frame
 * cost, region means read straight off the framebuffer before any JPEG
 * encoding, and the frame-to-frame difference of those regions. The temporal
 * numbers are the instrument — "does the wet gutter sparkle while walking" is
 * a question about the difference between consecutive frames and there is no
 * way to ask it of a still.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { run, finish, DEV_URL } from './harness.mjs';
import { acquire, release } from './lock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = args[0] && !args[0].startsWith('--') ? args[0] : 'reel';
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

const W = +flag('w', 1280), H = +flag('h', 720);
const FPS = +flag('fps', 30);
const SECONDS = +flag('seconds', 0);
const QUALITY = +flag('q', 0.94);
const PNG = args.includes('--png');
const NO_VIDEO = args.includes('--noVideo');
const ONLY = flag('shot', null);
/* Walk the route on the CPU with the real Walker and report what it hits,
 * without a browser, a GPU or the capture lock. A route that grazes a parked
 * car is a defect in the route and there is no reason to find that out from a
 * ten-minute capture. */
const DRY = args.includes('--dry');

/* Nine hundred frames is a quarter of an hour of headless Chromium at this
 * triangle count, and the harness's default ceiling is five minutes. */
process.env.SHOOT_CAP_MS = process.env.SHOOT_CAP_MS || String(45 * 60_000);

/* The route.
 *
 * Fixed here rather than passed in, for the same reason shoot.mjs's six stops
 * are fixed: a motion defect is a difference between two builds, and two
 * builds can only be differenced if they walked the same way.
 *
 * `look` is a list of [second, yaw, pitch] keyframes in radians, interpolated
 * with a smoothstep and *delivered through walker.look()* as a pixel delta, so
 * the steering exercises the same code the mouse does. `keys` is what is held
 * down for the whole shot; `hold` is [key, fromSec, toSec] for keys pressed
 * and released partway through, which is how the sprint shot gets its
 * acceleration and deceleration ramps into the same take as the steady jog.
 */
const SHOTS = [
  {
    /* Nobody moves.
     *
     * The control, and the only way to separate shimmer from parallax. Every
     * region difference in a moving shot is dominated by the camera having
     * travelled 47 mm since the last frame, so a large number there means
     * nothing on its own. With the camera parked and the simulation still
     * being stepped, whatever is left is the scene moving by itself: dust,
     * traffic, any animated shader, and the sensor grain. A noise model keyed
     * only to gl_FragCoord contributes exactly zero here and a temporally
     * independent one contributes its full amplitude, which makes this shot a
     * direct test of which one is installed. */
    name: 'static',
    t: 0.34,
    seconds: 3,
    keys: [],
    look: [[0.0, 0.05, -0.10]],
  },
  {
    /* The deliverable: 40.7 m in one take. Down the west footway inside the
     * light, off the kerb, diagonally across the carriageway as the shade line
     * sweeps past, and on down the crown of the road to the neon corner.
     *
     * It starts 26 m further down the street than the cut it replaces, and the
     * reason is arithmetic rather than taste. The sun is at 4.2 degrees, so a
     * 4 m frontage throws a 54 m shadow, and `world/block.ts` derives the only
     * two stretches of ground that see the disc at all from the gaps in the
     * sunward row: z -49..-32 and z -84..-73. The old route started at z = +2
     * and spent its first 33 m inside that shadow. Three independent
     * instruments say the same thing about it: the whole-frame mean in
     * `shots/v4/reel.json` is flat at 0.19 until t 14 and only reaches 0.45 at
     * t 20; the near-footway region climbs 40 -> 200 counts over the same
     * seconds; and the atmosphere pass counted under 30 dust pixels per frame
     * until 8 s. A third of the take was dead and the best of it was over by
     * 25 s.
     *
     * What this one does per second, measured off `shots/heroE/reel.json`:
     *
     *   .358 .414 .409 .438 .410 .361 .345 .346 .347 .345 .339 .333 .328 .312
     *   .299 .261 .231 .220 .212 .208 .206 .205 .208 .214 .221 .233 .233 .244
     *   .243 .247
     *
     * against 0.246 falling to 0.205 and back to 0.299 for the best of the
     * alternatives. It opens at nearly twice the old take's brightness, holds
     * above 0.30 for fourteen seconds, and then goes to evening — which is the
     * right shape for a clip somebody scrolls past, and is also just what the
     * hour does.
     *
     *   t 0-6    z -22, west footway. Lit paving in the near field at a
     *            grazing 4.2 degrees, the shade line laid across it, the sun
     *            in the shop glass
     *   t 6-14   off the kerb — a 145 mm drop the collider resolves, the only
     *            vertical move in the clip — and diagonally across the road,
     *            following the light rather than walking out of it. This is
     *            where the wet carriageway and the sun glow between the
     *            buildings are, and it is the best twenty metres in the scene
     *   t 14-18  onto the crown, the cross street open to the east
     *   t 18-26  into the shadow and the evening half: the pharmacy cross,
     *            then BAR / COLD BEER, the signal head at z -61.6 facing back
     *            up the street, OPEN 24 HRS and the van at -63.5 opposite
     *   t 26-30  past the corner with the neon still in frame
     *
     * Where the air is decided the route as much as where the light is, and
     * the two turn out to be the same place: the shaft that lights the paving
     * is the shaft the motes are in. `node tools/airtime.mjs heroE
     * heroEnodust` — two driven captures differing only in `?haze=nodust`,
     * differenced frame for frame — counts 70 dust pixels per frame averaged
     * over the take, peaking at 200, with 53% of the clip carrying 30 or more.
     * The same measurement on the alternative route gives 20, peak 123, 26%.
     * And `tools/air.mjs` puts the persistence at 5.05 px against the 76.5 px
     * that the same number of points thrown down at random would give, so the
     * air is a field of objects and not the grade's grain — which at the same
     * threshold contributes 10 px per frame, an order of magnitude less.
     *
     * The crossing is steered, not strafed. `walker` has no head-body
     * decoupling, so yaw *is* lateral travel: 0.43 rad from t 6.5 to t 13 is
     * the 5 m from the building line to the crown, at a 25 degree turn away
     * from the street axis, which is what somebody crossing a road does with
     * their head. It lands in the 1.81 m corridor between the van's east flank
     * at x = -0.81 and the east-kerb hatches at x = +1.00.
     *
     * Four earlier drafts are in `tools/route.mjs`, which traces a candidate
     * through `scene/collide.ts` in a second and reports what is around it as
     * well as what is near it. heroB went straight down the crown and never
     * got lit paving into the near field. heroC tried to reach the road on too
     * little yaw and was still on the footway at t 30. heroD is the one this
     * beat. And the first draft of heroA drifted 0.82 m left on an unpaired
     * glance and jammed head-on into the back of the van for four and a half
     * seconds. None of that cost a capture slot.
     *
     * `node tools/route.mjs heroE`: 40.7 m travelled, closest approach 0.477 m
     * to the building line at t 4, nothing touched. */
    name: 'walk',
    /* `t` only decides where `goTo` drops the walker before `place` moves it,
     * and it is set to the same stretch of street so the ground type under it
     * does not change between the two. 0.347 is z = -30 on `pathAt`. */
    t: 0.265,
    /* 0.70 m off the shopfronts on the west footway. The kerb-side strip here
     * carries the sign post at (-3.73, -25.5), so the lane between it and the
     * building line is the way through, and the route holds x = -5.05 until it
     * turns off. */
    place: [-5.00, -22.0],
    seconds: 30,
    keys: ['KeyW'],
    /* Small, paired, zero-mean yaw, and the pairing is not a stylistic
     * preference — the walker steers where it looks, with no decoupling of
     * head from body, so every radian of glance is also lateral travel. An
     * unpaired 0.07 rad held for four seconds is 390 mm across a 1.81 m
     * corridor, and the first cut of this route drifted 0.82 m left on exactly
     * that and jammed head-on into the back of the van at z = -61.0 for four
     * and a half seconds. `tools/route.mjs` found it in under a second.
     *
     * Positive yaw is left. The mean is biased very slightly right so the walk
     * opens the sunward side of the street as it goes, and the pitch lifts
     * from -0.04 to -0.012 over the last five seconds, which is what walking
     * back into the light looks like from inside a head. */
    look: [
      [0.0, 0.020, -0.050],
      [4.0, 0.000, -0.045],
      [6.5, -0.430, -0.045],
      [13.0, -0.430, -0.040],
      [16.0, -0.060, -0.045],
      [20.0, -0.020, -0.035],
      [24.0, 0.020, -0.035],
      [27.0, 0.045, -0.028],
      [30.0, 0.030, -0.015],
    ],
  },
  {
    /* The walk the collider makes available: one that leans on things.
     *
     * The shot above is hand-routed around every solid object on the street,
     * because when it was cut that was the only option — there was no
     * collision anywhere in the walker and the route was the only thing
     * keeping the camera out of a parked car. It took three attempts. This one
     * goes the other way and aims to make contact, because a scene that claims
     * to be walkable has to be seen to be walked rather than flown through:
     *
     *   t 3.5   up over the kerb from the carriageway, a 145 mm step
     *   t 6.5   the near side of the fire hydrant at z = -7.0, 300 mm off its
     *           centre, which is 106 mm inside it — the shoulder catches and
     *           the slide puts the walker round it
     *   t 20    squeezing between the kerb and hatch B's door mirror, which
     *           pushes the walker off the kerb and down into the gutter
     *   t 23    out across the carriageway
     *
     * Nothing is aimed dead centre. A head-on contact with a post is an
     * unstable equilibrium — the tangential part of the contact is exactly
     * zero — so the walker stands against it until it is steered, which is
     * what a person walking into a hydrant does and is no use as a shot.
     *
     * **`--dry` flags this shot and is wrong about it.** It reports 0.50 s
     * within a body radius of the hatch at z = -25.4, closest 0.169 m. That is
     * the mirror squeeze, and the mirror is why: `obstacles.mjs` carries the
     * car bodies only, and a door mirror stands 150 mm proud of the flank at
     * 0.97 m. The walker is resting on the mirror at exactly one body radius,
     * which puts it 169 mm off the *flank* — clear of everything that is
     * actually there and inside a table that does not know the mirror exists.
     * `scene/collide.ts` derives both from `carSolids()` and reports no
     * penetration anywhere on this route.
     *
     * Designed against `node tools/collide.mjs route`, which traces this same
     * route through the same `Walker` in a second.
     */
    name: 'brush',
    t: 0,
    place: [-2.50, 2.0],
    seconds: 30,
    keys: ['KeyW'],
    look: [
      [0.0, 0.000, -0.05],
      [1.0, 0.000, -0.05],
      [3.2, 0.330, -0.06],
      [5.0, 0.000, -0.05],
      [8.0, 0.000, -0.06],
      [13.0, -0.030, -0.05],
      [18.0, 0.010, -0.06],
      [23.0, -0.320, -0.07],
      [27.0, -0.050, -0.05],
      [30.0, 0.000, -0.05],
    ],
  },
  {
    /* The same walk, stepped eight times finer than it is played.
     *
     * This is the instrument for "does anything shimmer that a still cannot
     * show". In the ordinary walk the camera travels 47 mm between frames, so
     * every region difference is dominated by parallax and a large number
     * means nothing. Stepping at 1/240 s moves it 5.8 mm instead. Real image
     * content cannot change much over 5.8 mm, so the frame-to-frame difference
     * should fall by roughly the same factor of eight. Anything that does not
     * fall — a specular highlight flicking on and off between samples of a
     * surface finer than a pixel, a shadow edge crawling on the map's own
     * lattice, a moire beat on a window grid — is aliasing rather than motion,
     * and the ratio is the measurement.
     *
     * Framed at the near road and the gutter deliberately: at 4.2 degrees
     * those are the grazing-specular surfaces, and grazing specular on a wet
     * surface is where this class of defect lives. */
    name: 'creep',
    t: 0.30,
    seconds: 4,
    dt: 1 / 240,
    keys: ['KeyW'],
    look: [[0.0, 0.10, -0.30]],
  },
  {
    /* Walk, jog, walk, in one take.
     *
     * The pace change is the stress test: stride length, cadence, bob
     * amplitude and the closing rate on geometry all move together, so a term
     * derived wrongly from any of the others is two millimetres of error at
     * 1.4 m/s and six at 3.1. The two ramps are in shot on purpose — a gait
     * model that is right at both ends and wrong in between shows up nowhere
     * else.
     *
     * Kept out of the deliverable cut. A thirty-second video of a photoreal
     * street is a walk; this is a diagnostic. */
    name: 'sprint',
    t: 0.10,
    /* Biased to the crown of the road. The corridor between the two kerb-side
     * rows of parked cars is only about 1.5 m wide and a jog crosses it in
     * half a second, so the lane matters more here than it does at a walk. */
    place: [0.55, -5.8],
    seconds: 18,
    keys: ['KeyW'],
    hold: [['ShiftLeft', 4.0, 14.0]],
    look: [
      [0.0, 0.00, -0.05],
      [5.0, 0.05, -0.07],
      [11.0, -0.05, -0.04],
      [18.0, 0.00, -0.06],
    ],
  },
  {
    /* Straight through a parked car, and straight through a lamp column.
     *
     * "Are there collision pops near cars and street furniture" cannot be
     * answered by a route that never goes near any: the first cut of this reel
     * passed no closer than 3.42 m to a lamp and its nearest car was across
     * the carriageway. So these two aim at the objects deliberately. The hatch
     * in `world/cars.ts` is centred at x = -1.945, z = -25.40; the lamp column
     * from `world/dims.ts` stands at x = -4.30, z = -45. Both shots start
     * eight metres short of their target on a heading that goes through it.
     *
     * `place` bypasses the walk path, because the path's lateral drift is the
     * one thing that would stop the walker arriving at a specific x. */
    name: 'car',
    t: 0,
    place: [-1.945, -18.0],
    seconds: 8,
    keys: ['KeyW'],
    look: [[0.0, 0.0, -0.12], [8.0, 0.0, -0.16]],
  },
  {
    name: 'lamp',
    t: 0,
    place: [-4.30, -37.0],
    seconds: 8,
    keys: ['KeyW'],
    look: [[0.0, 0.0, -0.10], [8.0, 0.0, -0.14]],
  },
  {
    /* Straight at the kerb, then along it. The walker has no ground-height
     * term and no collider, so this is the shot that shows what the eye does
     * when the surface under it changes by 145 mm. Short, because it is a
     * diagnostic and not part of the cut. */
    name: 'kerb',
    t: 0.30,
    seconds: 8,
    keys: ['KeyW', 'KeyD'],
    look: [
      [0.0, 0.00, -0.16],
      [4.0, 0.55, -0.20],
      [8.0, 0.55, -0.20],
    ],
  },
];

const plan = (ONLY ? SHOTS.filter((s) => s.name === ONLY) : SHOTS)
  .map((s) => (SECONDS ? { ...s, seconds: SECONDS } : s));
if (!plan.length) { console.error(`no shot named ${ONLY}`); process.exit(1); }

/* Regions read off the framebuffer, in viewport fractions.
 *
 * Chosen for what moves rather than for what is bright: the gutter and the
 * near road are where grazing specular sparkle lives at 4.2 degrees, the
 * facades are where a repeating window grid can moire, the roofline is where
 * a shadow that swims shows up against the sky, and the sky itself is the
 * control — nothing in it should change frame to frame except through the
 * camera turning. */
const REGIONS = {
  sky: [0.40, 0.05, 0.20, 0.12],
  facadeL: [0.05, 0.22, 0.12, 0.26],
  facadeR: [0.83, 0.22, 0.12, 0.26],
  roofline: [0.30, 0.14, 0.40, 0.08],
  farRoad: [0.44, 0.52, 0.12, 0.05],
  midRoad: [0.42, 0.64, 0.16, 0.07],
  nearRoad: [0.36, 0.82, 0.28, 0.14],
  gutterL: [0.10, 0.76, 0.10, 0.08],
  walkR: [0.80, 0.70, 0.14, 0.10],
};

const outDir = path.join(ROOT, 'shots', tag);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const smooth = (u) => u * u * (3 - 2 * u);
function lookAt(keys, sec) {
  if (sec <= keys[0][0]) return [keys[0][1], keys[0][2]];
  for (let i = 1; i < keys.length; i++) {
    if (sec > keys[i][0]) continue;
    const [t0, y0, p0] = keys[i - 1], [t1, y1, p1] = keys[i];
    const u = smooth((sec - t0) / Math.max(1e-6, t1 - t0));
    return [y0 + (y1 - y0) * u, p0 + (p1 - p0) * u];
  }
  const last = keys[keys.length - 1];
  return [last[1], last[2]];
}

if (DRY) {
  const { register } = await import('node:module');
  register('./ts-hooks.mjs', import.meta.url);
  const { Walker } = await import('../src/scene/walker.ts');
  const { clearance, BODY_R, KERB_X } = await import('./obstacles.mjs');

  console.log(`\n  dry run — the real Walker, ${FPS} Hz, no browser\n`);
  for (const shot of plan) {
    const w = new Walker();
    w.placeAt(shot.t);
    if (shot.place) { w.x = shot.place[0]; w.z = shot.place[1]; }
    w.yaw = shot.look[0][1];
    w.pitch = shot.look[0][2];
    const held = new Set(shot.keys);
    let worst = null;
    const hits = [];
    const xs = [Infinity, -Infinity];
    for (let f = 0; f < Math.round(shot.seconds * FPS); f++) {
      const sec = f / FPS;
      for (const [k, from, to] of shot.hold || []) {
        if (sec >= from && sec < to) held.add(k); else held.delete(k);
      }
      const [yw, pw] = lookAt(shot.look, sec);
      w.look((w.yaw - yw) / 0.0022, (w.pitch - pw) / 0.0022);
      w.update(shot.dt || 1 / FPS, {
        forward: held.has('KeyW') ? 1 : 0,
        strafe: (held.has('KeyD') ? 1 : 0) - (held.has('KeyA') ? 1 : 0),
        sprint: held.has('ShiftLeft') || held.has('ShiftRight'),
      });
      const c = clearance(w.x, w.z);
      if (!worst || c.d < worst.d) worst = { ...c, f, x: w.x, z: w.z };
      if (c.d < BODY_R) hits.push(f);
      xs[0] = Math.min(xs[0], w.x); xs[1] = Math.max(xs[1], w.x);
    }
    /* The walker's lateral bound is a hard clamp, so a route that reaches it
     * slides along an invisible wall — smooth in the data and unmistakable on
     * screen. Worth knowing before the capture rather than after. */
    const CLAMP = 5.30;
    const pinned = Math.min(Math.abs(xs[0]), Math.abs(xs[1])) < 0 || Math.max(-xs[0], xs[1]) > CLAMP - 0.01;
    const flagged = hits.length
      ? `✗ ${hits.length} frames (${(hits.length / FPS).toFixed(2)} s) inside a body radius`
      : 'clear';
    console.log(
      `  ${shot.name.padEnd(7)} x ${xs[0].toFixed(2)}..${xs[1].toFixed(2)}, ends z ${w.z.toFixed(1)}` +
      `${Math.abs(w.x) > KERB_X ? ' (on the footway)' : ''}` +
      `${pinned ? '  ✗ PINNED ON THE LATERAL CLAMP' : ''}\n` +
      `          closest ${worst.d.toFixed(3)} m to ${worst.what} at frame ${worst.f}   ${flagged}`,
    );
  }
  console.log('');
  process.exit(0);
}

await acquire(`reel:${tag}`);

/* What was on disk when this was shot.
 *
 * Several agents edit this worktree at once and the dev server hot-reloads, so
 * "the walk video" and "the numbers in the report" are only the same build if
 * nothing changed in between. The first cut of this reel was overtaken by an
 * edit to streetMaterials.ts seven minutes after it finished, and the A/B
 * against it silently compared two different roads.
 *
 * Taken twice, before and after, and that is not redundancy — the digest was
 * previously read only at the end, which catches an edit that lands after the
 * capture and misses one that lands during it. A provisional take of this very
 * route was shot straight through a write to grade.tsx ten seconds before the
 * last frame: Turbopack applied it without remounting the Rig, so the virtual
 * clock never jumped, the capture completed cleanly, and the first two thirds
 * of the file were graded differently from the last third. Nothing in the
 * report said so. */
function buildStamp() {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(e.name)) {
        const st = fs.statSync(p);
        files.push([path.relative(ROOT, p).replace(/\\/g, '/'), st.size, +st.mtimeMs.toFixed(0)]);
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  files.sort();
  const h = createHash('sha1').update(JSON.stringify(files)).digest('hex').slice(0, 12);
  const newest = files.reduce((a, b) => (b[2] > a[2] ? b : a));
  return { digest: h, files: files.length, newest: { file: newest[0], at: new Date(newest[2]).toISOString() } };
}
const before = buildStamp();
console.log(`  build ${before.digest}, newest source ${before.newest.file} at ${before.newest.at}`);

const shots = [];
/* Attribution switches, straight through to the page: `--query nospec` drops
 * the road's specular lobes and keeps its albedo, normals and roughness, and
 * `--query haze=noshadow` ungates the dust. Differencing a reel against itself
 * with one term removed is the only way to say which term a defect lives in.
 *
 * This was `--q`, which is also the JPEG quality flag, so raising the encoder
 * quality for the delivery take silently appended `?0.97` to the page URL and
 * every attribution switch also changed the encoder. Neither failure is
 * visible in the output. */
const QUERY = flag('query', null);
await run({
  width: W, height: H,
  url: QUERY ? `${DEV_URL}${QUERY.startsWith('?') ? '' : '?'}${QUERY}` : DEV_URL,
}, async ({ page, errs, gl, readShaderErrors }) => {
  for (const shot of plan) {
    const frames = Math.round(shot.seconds * FPS);
    const dir = path.join(outDir, shot.name);
    fs.mkdirSync(dir, { recursive: true });

    /* Set up, then settle. `warp` runs the gait forward without wall-clock
     * time, so the first captured frame is the one you would get by having
     * walked here rather than by being placed here mid-stride with the bob at
     * zero — which reads as a lurch on frame 1 of the cut. */
    await page.evaluate(([t, yaw0, pitch0, regions, place]) => {
      const s = window.__scene;
      s.goTo(t);
      if (place) { s.walker.x = place[0]; s.walker.z = place[1]; }
      s.setYaw(yaw0);
      s.setPitch(pitch0);
      s.warp(3.0);
      s.setDriven(true);

      window.__reelFrame = 0;
      window.__reelSteps = [];
      const prev = s.walker.onFootstep;
      s.walker.onFootstep = (foot) => {
        window.__reelSteps.push({
          frame: window.__reelFrame,
          foot,
          phase: +s.walker.phase.toFixed(4),
          x: +s.walker.x.toFixed(4),
          z: +s.walker.z.toFixed(4),
          v: +s.walker.speed.toFixed(4),
          ey: +s.walker.eye.y.toFixed(5),
        });
        if (prev) prev(foot);
      };

      window.__reelRegions = regions;
      window.__reelBuf = null;
      window.__reelPrev = null;
    }, [shot.t, shot.look[0][1], shot.look[0][2], REGIONS, shot.place || null]);

    for (const k of shot.keys) await page.keyboard.down(k);

    /* Timed keys go through page.keyboard exactly like the held ones, so a
     * sprint in a capture is the same event path as a finger on Shift. */
    const timed = new Map((shot.hold || []).map(([k]) => [k, false]));

    const rows = [];
    for (let f = 0; f < frames; f++) {
      const sec = f / FPS;
      for (const [k, from, to] of shot.hold || []) {
        const want = sec >= from && sec < to;
        if (want === timed.get(k)) continue;
        await (want ? page.keyboard.down(k) : page.keyboard.up(k));
        timed.set(k, want);
      }
      const [yawWant, pitchWant] = lookAt(shot.look, sec);
      const r = await page.evaluate(([dt, yawWant, pitchWant, q, png, frame]) => {
        const s = window.__scene;
        window.__reelFrame = frame;

        /* Steer through the same call the pointer-lock handler makes, at the
         * same sensitivity, rather than assigning yaw. If look() ever grows a
         * smoothing term or a clamp, the reel inherits it. */
        const SENS = 0.0022;
        const dx = (s.walker.yaw - yawWant) / SENS;
        const dy = (s.walker.pitch - pitchWant) / SENS;
        if (dx || dy) s.walker.look(dx, dy);

        /* Timed region. One pixel back off the default framebuffer is the
         * only cheap thing that cannot return before the frame exists. */
        const ctx = s.renderer.getContext();
        const one = new Uint8Array(4);
        const t0 = performance.now();
        s.step(dt);
        ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, one);
        const cost = performance.now() - t0;

        const cv = s.renderer.domElement;
        const w = cv.width, h = cv.height;
        if (!window.__reelBuf) window.__reelBuf = new Uint8Array(w * h * 4);
        const px = window.__reelBuf;
        ctx.readPixels(0, 0, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, px);

        /* Sampled at every second pixel in both axes. readPixels is bottom-up,
         * so a region's y fraction is measured from the top and flipped here. */
        const STEP = 2;
        const prev = window.__reelPrev;
        const cur = new Float32Array(Math.ceil(w / STEP) * Math.ceil(h / STEP));
        const cw = Math.ceil(w / STEP);
        let sum = 0, n = 0, hot = 0;
        for (let j = 0, jj = 0; j < h; j += STEP, jj++) {
          for (let i = 0, ii = 0; i < w; i += STEP, ii++) {
            const k = (j * w + i) * 4;
            const l = (px[k] * 0.2126 + px[k + 1] * 0.7152 + px[k + 2] * 0.0722) / 255;
            cur[jj * cw + ii] = l;
            sum += l; n++;
            if (l > 0.95) hot++;
          }
        }

        const reg = {};
        for (const [name, [fx, fy, fw, fh]] of Object.entries(window.__reelRegions)) {
          const x0 = Math.round(fx * w), x1 = Math.round((fx + fw) * w);
          // top-down fraction -> bottom-up scanline
          const y0 = Math.round((1 - fy - fh) * h), y1 = Math.round((1 - fy) * h);
          let r = 0, g = 0, b = 0, m = 0, d = 0, dmax = 0, tw = 0;
          for (let j = y0; j < y1; j += STEP) {
            for (let i = x0; i < x1; i += STEP) {
              const k = (j * w + i) * 4;
              r += px[k]; g += px[k + 1]; b += px[k + 2];
              const idx = ((j / STEP) | 0) * cw + ((i / STEP) | 0);
              if (prev) {
                const dd = Math.abs(cur[idx] - prev[idx]);
                d += dd;
                if (dd > dmax) dmax = dd;
                if (dd > 0.05) tw++;    // 13 code values: a visible pop
              }
              m++;
            }
          }
          reg[name] = {
            rgb: [+(r / m / 255).toFixed(4), +(g / m / 255).toFixed(4), +(b / m / 255).toFixed(4)],
            // Mean and peak frame-to-frame change, in 8-bit code values.
            d: prev ? +((d / m) * 255).toFixed(2) : null,
            dmax: prev ? +(dmax * 255).toFixed(1) : null,
            twinkle: prev ? +((100 * tw) / m).toFixed(3) : null,
          };
        }
        window.__reelPrev = cur;

        const wk = s.walker;
        const cam = s.camera.position;
        const out = {
          cost: +cost.toFixed(2),
          mean: +(sum / n).toFixed(4),
          hotPct: +((100 * hot) / n).toFixed(4),
          x: +wk.x.toFixed(4), z: +wk.z.toFixed(4),
          ex: +wk.eye.x.toFixed(4), ey: +wk.eye.y.toFixed(5), ez: +wk.eye.z.toFixed(4),
          cy: +cam.y.toFixed(5),
          phase: +wk.phase.toFixed(4), speed: +wk.speed.toFixed(4),
          yaw: +wk.yaw.toFixed(4), pitch: +wk.pitch.toFixed(4), roll: +wk.roll.toFixed(5),
          calls: s.info().calls, tris: s.info().triangles,
          clock: +s.clock.toFixed(6),
          reg,
        };
        /* One evaluate for render and encode both: the drawing buffer is not
         * preserved and is gone by the next task. */
        out.img = png
          ? cv.toDataURL('image/png')
          : cv.toDataURL('image/jpeg', q);
        return out;
      }, [shot.dt || 1 / FPS, yawWant, pitchWant, QUALITY, PNG, f]);

      const ext = PNG ? 'png' : 'jpg';
      fs.writeFileSync(
        path.join(dir, `${String(f).padStart(5, '0')}.${ext}`),
        Buffer.from(r.img.split(',')[1], 'base64'),
      );
      delete r.img;
      rows.push(r);

      /* The keystroke goes to the page's focused element and bubbles to a
       * window listener, and there is no error if it lands nowhere — the
       * walk would simply stand still for thirty seconds and the frames
       * would all look plausible. Check that it took. */
      /* Two other agents are editing this worktree while this runs, and a
       * Turbopack hot reload remounts the Rig — which rebuilds the Walker at
       * the top of the street, drops the driven frame loop back to the wall
       * clock, and resets the virtual clock. Every frame after that would
       * still be written and would still look like a street. The virtual
       * clock is the cheapest thing that cannot survive it. */
      const wantClock = (f + 1) * (shot.dt || 1 / FPS);
      if (Math.abs(r.clock - wantClock) > 1e-4) {
        throw new Error(
          `the page reloaded mid-capture at frame ${f}: virtual clock ${r.clock}s, expected ${wantClock.toFixed(4)}s. ` +
          'Re-run when the other agents are not editing src/.',
        );
      }

      if (f === 15 && shot.keys.includes('KeyW') && r.speed < 0.5) {
        throw new Error(`input did not reach the walker: speed ${r.speed} after 15 frames of KeyW`);
      }
      for (const [k, from] of shot.hold || []) {
        if (!k.startsWith('Shift') || Math.abs(sec - (from + 2)) > 0.5 / FPS) continue;
        if (r.speed < 2.5) throw new Error(`Shift did not reach the walker: speed ${r.speed} 2s after ${k} down`);
      }

      if (f % 60 === 0 || f === frames - 1) {
        process.stdout.write(
          `\r  ${shot.name.padEnd(6)} ${String(f + 1).padStart(4)}/${frames}  ` +
          `z=${r.z.toFixed(1)}  ${(1000 / Math.max(r.cost, 1e-3)).toFixed(0)} fps   `,
        );
      }
    }
    process.stdout.write('\n');

    for (const k of shot.keys) await page.keyboard.up(k);
    for (const [k, down] of timed) if (down) await page.keyboard.up(k);
    const steps = await page.evaluate(() => {
      const s = window.__scene;
      s.setDriven(false);
      return window.__reelSteps;
    });

    /* A missing or truncated frame is the failure most likely to go unnoticed
     * — the video still plays, one moment of it is just wrong. */
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(PNG ? '.png' : '.jpg')).sort();
    const small = files.filter((f) => fs.statSync(path.join(dir, f)).size < 8000);
    if (files.length !== frames || small.length) {
      console.error(`  ✗ ${shot.name}: ${files.length}/${frames} frames, ${small.length} suspiciously small`);
      process.exitCode = 1;
    }

    /* Frame cost, reported by pace as well as overall. The first two frames
     * are dropped: the step out of `setDriven` uploads the first driven
     * uniform set and is not representative of anything. */
    const fpsOf = (ms) => +(1000 / ms).toFixed(1);
    const stats = (rs) => {
      const c = rs.map((r) => r.cost).sort((a, b) => a - b);
      if (!c.length) return null;
      const pct = (p) => c[Math.min(c.length - 1, Math.floor(p * c.length))];
      const mean = c.reduce((a, b) => a + b, 0) / c.length;
      return {
        frames: c.length,
        meanMs: +mean.toFixed(2), medianMs: +pct(0.5).toFixed(2),
        p95Ms: +pct(0.95).toFixed(2), worstMs: +c[c.length - 1].toFixed(2),
        meanFps: fpsOf(mean), p5Fps: fpsOf(pct(0.95)), worstFps: fpsOf(c[c.length - 1]),
      };
    };
    /* Speed bands rather than "was Shift down", so the acceleration ramps are
     * excluded from both ends and neither pace is measured through a
     * transition. */
    const body = rows.slice(2);
    const perf = {
      all: stats(body),
      walk: stats(body.filter((r) => r.speed > 1.2 && r.speed <= 1.6)),
      run: stats(body.filter((r) => r.speed > 2.8)),
    };

    shots.push({ ...shot, frames, dir: path.relative(ROOT, dir), perf, steps, rows });
    const line = (label, p) => p && console.log(
      `    ${label.padEnd(5)} ${String(p.frames).padStart(4)} fr  ` +
      `${String(p.meanFps).padStart(5)} fps mean / ${String(p.p5Fps).padStart(5)} p5 / ` +
      `${String(p.worstFps).padStart(5)} worst`,
    );
    console.log(
      `  ${shot.name}  ${frames} frames  ${(frames / FPS).toFixed(1)}s  ` +
      `calls=${rows[0].calls} tris=${(rows[0].tris / 1000).toFixed(0)}k  ${steps.length} footfalls`,
    );
    line('all', perf.all); line('walk', perf.walk); line('run', perf.run);
  }

  const after = buildStamp();
  const build = { ...after, before: before.digest, stable: after.digest === before.digest };
  if (!build.stable) {
    console.error(
      `\n  ✗ THE SOURCE TREE CHANGED DURING THIS CAPTURE: ${before.digest} -> ${after.digest}\n` +
      `    newest is now ${after.newest.file} at ${after.newest.at}.\n` +
      '    Part of this take was rendered by a different build. Re-shoot it.',
    );
    process.exitCode = 1;
  } else {
    console.log(`  build ${build.digest} held for the whole capture`);
  }

  const shaderErrors = await readShaderErrors();
  fs.writeFileSync(path.join(outDir, 'reel.json'), JSON.stringify({
    tag, when: new Date().toISOString(), build, query: QUERY, gl, size: [W, H], fps: FPS,
    encode: PNG ? 'png' : `jpeg q${QUALITY}`,
    regions: REGIONS, shots, errors: [...new Set(errs)], shaderErrors,
  }, null, 2));
  console.log(`\n  adapter: ${gl.renderer}`);
});

release();

/* Assembly.
 *
 * ffmpeg if it is on PATH, and a .cmd next to the frames if it is not, rather
 * than pulling in an encoder as a dependency. Constant rate factor 17 and
 * yuv420p: high enough that the codec is not what a reviewer is looking at,
 * and 4:2:0 because anything else will not play in a browser. */
const ff = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg'], { encoding: 'utf8' });
const haveFfmpeg = ff.status === 0;

for (const s of shots) {
  const dir = path.join(ROOT, s.dir);
  const mp4 = path.join(outDir, `${s.name}.mp4`);
  const cmd = ['-y', '-framerate', String(FPS), '-i', path.join(dir, `%05d.${PNG ? 'png' : 'jpg'}`),
    '-c:v', 'libx264', '-crf', '17', '-preset', 'slow', '-pix_fmt', 'yuv420p', mp4];
  if (!haveFfmpeg) {
    fs.writeFileSync(path.join(outDir, `assemble-${s.name}.cmd`), `ffmpeg ${cmd.join(' ')}\n`);
    continue;
  }
  const enc = spawnSync('ffmpeg', cmd, { encoding: 'utf8' });
  if (enc.status !== 0) {
    console.error(`  ✗ ffmpeg failed for ${s.name}:\n${(enc.stderr || '').split('\n').slice(-12).join('\n')}`);
    process.exitCode = 1;
    continue;
  }
  console.log(`  → ${path.relative(ROOT, mp4)}  ${(fs.statSync(mp4).size / 1048576).toFixed(1)} MB`);
}
if (!haveFfmpeg) {
  console.log('\n  ffmpeg is not on PATH. Frame sequences are written; run the');
  console.log(`  assemble-*.cmd scripts in ${path.relative(ROOT, outDir)} to encode them.`);
}
console.log(`  → ${path.relative(ROOT, outDir)}`);

finish(process.exitCode || 0);
