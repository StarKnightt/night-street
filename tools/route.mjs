/* Design a walk route against the real collider, for free.
 *
 *   node tools/route.mjs              trace every candidate
 *   node tools/route.mjs hero         one of them
 *   node tools/route.mjs hero --csv   per-frame x/z/clearance
 *
 * `reel.mjs --dry` already walks the real `Walker`, so the *path* it produces
 * is correct. What it reports the path against is not: `tools/obstacles.mjs`
 * is a copy that has drifted from `world/cars.ts` — one car short, the
 * dumpster's extents transposed — so it clears routes that are not clear and
 * flags routes that are. This traces the same route against `scene/collide.ts`,
 * which is the table the page itself collides with, and additionally reports
 * what the route is *looking at* second by second, because a route is a
 * composition before it is a collision test.
 *
 * The landmark table is the reason this file exists rather than a flag on
 * collide.mjs. Choosing where a thirty-second walk starts is choosing which
 * fifteen metres of sunlit road and which neon sign are in it, and that is a
 * question about z positions, not about penetration depth.
 */
import { register } from 'node:module';

register('./ts-hooks.mjs', import.meta.url);

const { Walker } = await import('../src/scene/walker.ts');
const { nearest, BODY_R } = await import('../src/scene/collide.ts');

/* What is where, in z. Every number traced back to the file that owns it.
 *
 * The two sun bands are the whole reason the route moved: `world/block.ts`
 * derives them from the gaps in the sunward frontage and states them outright
 * — "as laid out: -49 to -32 ... and -84 to -73" — and those are the only
 * stretches of carriageway that see the disc at all. Everything between them
 * is in the frontage's own shadow, which at 4.2 degrees is 54 m long. */
const LANDMARKS = [
  { z0: -49.0, z1: -32.0, what: 'SUN BAND 1 — direct sun on the carriageway' },
  { z0: -84.0, z1: -73.0, what: 'SUN BAND 2 — direct sun on the carriageway' },
  { z0: -64.0, z1: -40.0, what: 'cross street open on the east — sky and shaft' },
  { z0: -99.0, z1: -81.0, what: 'vacant lot east, railings' },
  { z0: -72.6, z1: -68.5, what: 'service alley west, dumpster in its mouth' },
  { z: -52.0, what: 'pharmacy cross, green neon' },
  /* Measured, not guessed. This entry said z -56 for most of the night, which
   * is where the *cross street* is; `node tools/aim.mjs` derives the blade from
   * the same layout the page builds and puts it at -65.26, nine metres further
   * down. A landmark table that is wrong about the one sign in the scene will
   * choose the wrong ending, and did. */
  { z: -65.26, what: 'BAR / COLD BEER neon blade, east, 3.95 m up' },
  { z: -67.88, what: 'bar glazing, warm interior, east' },
  { z: -61.6, what: 'traffic signal, facing up the street' },
  { z: -26.11, what: 'lit shopfront west' },
  { z: -42.6, what: 'estate parked, west kerb' },
  { z: -47.55, what: 'supermini parked, west kerb' },
  { z: -63.5, what: 'van parked, west kerb' },
  { z: -70.0, what: 'hatch parked, east kerb' },
  /* world/cars.ts calls this one "far kerb, sunlit, stop 5" and says the shade
   * line falls across it about a metre behind the nose. It is the only parked
   * car in the scene with direct sun on it, and it is inside sun band 2. */
  { z: -76.3, what: 'hatch parked, east kerb — SUNLIT, shade line across it' },
  { z: -96.4, what: 'saloon, deep haze, silhouette and tail lights' },
  { z: -64.0, what: 'lamp column west' },
  { z: -84.0, what: 'lamp column west' },
];

const smooth = (u) => u * u * (3 - 2 * u);
const lookAt = (keys, sec) => {
  if (sec <= keys[0][0]) return [keys[0][1], keys[0][2]];
  for (let i = 1; i < keys.length; i++) {
    if (sec > keys[i][0]) continue;
    const [t0, y0, p0] = keys[i - 1], [t1, y1, p1] = keys[i];
    const u = smooth((sec - t0) / Math.max(1e-6, t1 - t0));
    return [y0 + (y1 - y0) * u, p0 + (p1 - p0) * u];
  }
  const l = keys[keys.length - 1];
  return [l[1], l[2]];
};

/* Candidates. `place`, `seconds`, `keys`, `hold` and `look` are reel.mjs's
 * SHOTS format verbatim, so a route that traces well here is pasted across
 * unchanged. */
export const ROUTES = [
  {
    /* The arc, inverted: lit, shade, lit.
     *
     * heroE and heroF are both compositionally backwards and the measurement
     * that says so is not about dust, it is about exposure. Median luminance
     * on the delivered frames peaks at 125.8 at t 3.5 and decays monotonically
     * to 43.4 by t 29.3; the last second has no highlight anywhere in it —
     * nothing clips, the brightest pixel in two million is 227. A golden-hour
     * clip whose final frame contains no direct light is an underexposed dusk
     * frame, and no amount of holding on it will make it arrive.
     *
     * The cause is geometric and it was in `route.mjs`'s own output all night:
     * 43% of heroE is inside a sun band and every second of it falls between
     * t 8 and t 21. `block.ts` lights z -49..-32 and z -84..-73. heroE runs
     * -22 to -62.7 and therefore stops 10.3 m short of the second band. It
     * opens in shade, brightens, and ends in shade.
     *
     * Starting 21 m further down the street costs nothing and inverts it:
     *
     *   t 0-4     inside sun band 1 already — direct sun on the carriageway in
     *             the first frame, the motes lit rather than shadow-gated off
     *   t 4-21    the shade middle, which is where the neon belongs anyway:
     *             the pharmacy cross at -52, the signal at -61.6, and BAR /
     *             COLD BEER at -65.26 with the bar's warm glazing behind it.
     *             Neon in shade is a different and better shot than neon in
     *             sun, and this route spends its dim third on the only two
     *             emitters in the scene rather than on empty shadowed road
     *   t 21-30   into sun band 2, gaining light for the last nine seconds:
     *             the sunlit hatch at -76.3 with the shade line lying across
     *             its bonnet, the vacant lot opening the east side to the sky,
     *             and the saloon at -96.4 sitting in the haze to give the far
     *             end of the street a known size
     *
     * The opening also drops the worst asset in the take. heroE's first frame
     * had a parked car 1.5 m off the lens with a see-through wheel arch, a
     * stippled silhouette and a two-cuboid wing mirror. Here the estate at
     * -42.6 is *behind* the camera at t 0 and the nearest car is the supermini
     * 4.5 m ahead at -47.55, which is far enough that it reads as a car.
     *
     * It does NOT stop at the end, and that is a finding rather than a choice.
     * heroF was built around releasing KeyW at 26.2 and letting the walker
     * coast to rest on `speed`'s 111 ms decay. `Walker.update` does not work
     * that way: with `input.forward` at zero the direction vector is zeroed
     * before `speed` is ever applied, so translation stops in a single frame
     * while the bob and cadence wind down over the next 0.35 s from the decay.
     * A trace of heroF shows z frozen to four decimal places at t 27.5 with
     * `speed` still reading 0.98 m/s. On screen that is a step from 23 mm of
     * optical flow per frame to zero, followed by a head that keeps moving —
     * a hitch and a third of a second of foot slide, in a project whose gait
     * measures 0.2% slide over 85 footfalls. Fixing it means a real change to
     * walker.ts, which is not a 5 a.m. edit. So the clip ends walking, and
     * what arrives is the light. */
    name: 'heroG',
    /* East of the crown, not west of it.
     *
     * The west kerb from -40.4 to -49.4 is a nose-to-tail row — estate, then
     * supermini with 700 mm between the bumpers — and sun band 1 runs -49..-32,
     * so every start point that is both lit and inside the band is alongside a
     * parked car. That is fine as long as it is alongside at a distance: the
     * defect the critic found in heroE's first frame was a car 1.5 m off the
     * lens with a see-through wheel arch and a stippled silhouette, and the
     * same asset at 3 m in direct sun reads as a car. Starting 0.75 m east of
     * the crown puts the supermini's flank 1.45 m away instead of 0.7 m, and
     * its rear 2.7 m ahead rather than beside. */
    place: [0.80, -40.5],
    seconds: 30,
    keys: ['KeyW'],
    look: [
      [0.0, 0.000, -0.045],
      [3.0, 0.030, -0.045],
      [7.0, 0.050, -0.038],
      [11.0, -0.025, -0.030],
      [14.0, -0.055, -0.022],
      [17.0, 0.045, -0.020],
      [20.0, 0.090, -0.026],
      [23.0, 0.045, -0.030],
      [26.0, 0.010, -0.024],
      [28.5, -0.005, -0.016],
      [30.0, -0.010, -0.010],
    ],
  },
  {
    /* heroE, but it arrives somewhere instead of running out of seconds.
     *
     * heroE's last frame is its weakest, which is the worst place on a social
     * timeline for a weak frame to be: a clip is judged twice, once in the
     * first second and once on whatever is on screen when the viewer decides
     * whether to reply or keep scrolling. It walked 40.7 m and then stopped
     * mid-stride between two parked cars.
     *
     * So: release KeyW at 26.2 and let the walker come to rest on its own.
     * That is not a cut — `walker.update` decays speed with a 111 ms time
     * constant and the bob amplitude is scaled by walkU = smoothstep(pace /
     * 1.4), so the stride shortens, the cadence falls and the head settles to
     * eye height over about four tenths of a second with the vertical velocity
     * going to zero rather than stepping to it. The camera arrives at rest the
     * way a person does. It coasts 155 mm past the release.
     *
     * The head turn starts 300 ms *before* the release, because that is the
     * order the two happen in: you see the thing, and then you stop. Over two
     * seconds it swings 0.41 rad right and lifts 0.16 rad, landing on the BAR
     * / COLD BEER blade — a projecting sign whose lettered jambs face along
     * the street, which `world/neon.ts` chose deliberately so it reads from up
     * the road rather than edge-on.
     *
     * The aim is off the sign rather than on it. `node tools/aim.mjs 0.63
     * -57.63` puts the blade at yaw -0.542, pitch 0.255 and 8.8 m away; the
     * camera holds -0.400 / 0.130, which at fov 45 on 16:9 leaves the sign
     * 22 per cent of a half-width right of centre and a third of a half-height
     * up, with the street axis still 63 per cent of the way to the left edge.
     * The subject of the last frame is the street, and the neon is what the
     * eye lands on inside it. Centring on the sign would throw the road away.
     *
     * The final 2.1 s are two identical keyframes, so the camera is not merely
     * slow but numerically still — platforms lift a poster frame from near the
     * end, and a still camera is also the only invitation this clip makes to
     * look at the paving, the air and the letterforms rather than at motion. */
    name: 'heroF',
    place: [-5.00, -22.0],
    seconds: 30,
    keys: [],
    hold: [['KeyW', 0, 26.2]],
    look: [
      [0.0, 0.020, -0.050],
      [4.0, 0.000, -0.045],
      [6.5, -0.430, -0.045],
      [13.0, -0.430, -0.040],
      [16.0, -0.060, -0.045],
      [20.0, -0.020, -0.035],
      [24.0, 0.020, -0.035],
      [25.9, 0.010, -0.030],
      [27.9, -0.400, 0.130],
      [30.0, -0.400, 0.130],
    ],
  },
  {
    name: 'heroA',
    place: [-0.25, -35.5],
    seconds: 30,
    keys: ['KeyW'],
    look: [
      [0.0, 0.000, -0.045],
      [5.0, -0.050, -0.055],
      [10.0, 0.040, -0.040],
      [15.0, -0.060, -0.050],
      [20.0, 0.030, -0.035],
      [25.0, -0.040, -0.045],
      [30.0, 0.000, -0.020],
    ],
  },
  {
    /* Open on the sunlit footway, step down into the road, end on the neon.
     *
     * heroB's weakness is measurable: whole-frame mean 0.201..0.320 against
     * the old take's 0.168..0.466. The crown of the road never gets the sunlit
     * paving into the near field, and near-field sunlit paving at 4.2 degrees
     * is the single strongest image this scene makes — `shots/v4/walk/00600`,
     * the one frame of the old cut anybody would stop on.
     *
     * So take both. The first third is that image, walked into rather than
     * cut to; the kerb step at t ~10 is a 128 mm drop the collider already
     * measures and it is the one moment of vertical in the whole clip; the
     * last two thirds is heroB's neon corridor. */
    name: 'heroC',
    place: [-5.00, -22.0],
    seconds: 30,
    keys: ['KeyW'],
    look: [
      [0.0, 0.010, -0.055],
      [5.0, -0.020, -0.045],
      [8.0, -0.090, -0.050],
      [12.0, -0.150, -0.040],
      [15.0, 0.060, -0.045],
      [19.0, 0.020, -0.035],
      [23.0, -0.040, -0.040],
      [27.0, 0.020, -0.030],
      [30.0, 0.000, -0.018],
    ],
  },
  {
    /* Open in the densest air on the street, then follow the light across.
     *
     * heroD is measurably short of dust: `node tools/airtime.mjs hero
     * heronodust` counts 83 px/frame at its best, t 4 to t 9, and exactly zero
     * from t 11 to t 25. The atmosphere pass found the field ignites around
     * world z -21..-29, which is also where the old take's whole-frame mean
     * peaked at 0.45 — the same shaft lights the paving and the motes in it,
     * so the brightest ground and the thickest air are the same place, and
     * heroD starts one metre past the end of it.
     *
     * So start inside it, on the west footway where the light lands at that z,
     * and cross to the east side over t 6-14 as the shade line sweeps past —
     * following the light rather than walking away from it. */
    name: 'heroE',
    place: [-5.00, -22.0],
    seconds: 30,
    keys: ['KeyW'],
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
    /* The sunward footway, then down off the kerb and across into the road. */
    name: 'heroD',
    place: [5.00, -30.0],
    seconds: 30,
    keys: ['KeyW'],
    look: [
      [0.0, 0.000, -0.050],
      [3.5, 0.020, -0.050],
      [6.5, 0.210, -0.045],
      [15.0, 0.210, -0.040],
      [18.0, 0.075, -0.045],
      [22.0, 0.085, -0.035],
      [26.0, 0.070, -0.028],
      [30.0, 0.035, -0.015],
    ],
  },
  {
    name: 'heroB',
    place: [-0.20, -36.5],
    seconds: 30,
    keys: ['KeyW'],
    look: [
      [0.0, 0.000, -0.040],
      [4.0, -0.045, -0.050],
      [9.0, 0.035, -0.035],
      [13.0, -0.030, -0.045],
      [17.0, -0.055, -0.030],
      [21.0, 0.040, -0.040],
      [25.0, -0.030, -0.035],
      [30.0, 0.005, -0.012],
    ],
  },
];

const only = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : null;
const CSV = process.argv.includes('--csv');
const FPS = 30;

const near = (z) => LANDMARKS
  .filter((l) => (l.z !== undefined ? Math.abs(l.z - z) < 4.5 : z <= l.z1 && z >= l.z0))
  .map((l) => l.what);

let bad = 0;
for (const shot of ROUTES.filter((r) => !only || r.name === only)) {
  const w = new Walker();
  w.x = shot.place[0]; w.z = shot.place[1];
  w.yaw = shot.look[0][1]; w.pitch = shot.look[0][2];
  w.snapGround();

  const held = new Set(shot.keys);
  const rows = [];
  let worst = { d: 9 };
  const touches = new Map();
  for (let f = 0; f < Math.round(shot.seconds * FPS); f++) {
    const sec = f / FPS;
    for (const [k, from, to] of shot.hold || []) {
      if (sec >= from && sec < to) held.add(k); else held.delete(k);
    }
    const [yw, pw] = lookAt(shot.look, sec);
    w.look((w.yaw - yw) / 0.0022, (w.pitch - pw) / 0.0022);
    w.update(1 / FPS, {
      forward: held.has('KeyW') ? 1 : 0,
      strafe: (held.has('KeyD') ? 1 : 0) - (held.has('KeyA') ? 1 : 0),
      sprint: held.has('ShiftLeft'),
    });
    const c = nearest(w.x, w.z);
    if (c.d < worst.d) worst = { ...c, x: w.x, z: w.z, t: sec };
    if (w.contact) touches.set(w.contact, (touches.get(w.contact) || 0) + 1);
    rows.push({ sec, x: w.x, z: w.z, d: c.d, ey: w.eye.y, v: w.speed, hit: w.contact });
  }

  if (CSV) {
    console.log('sec,x,z,clear,eyeY,speed');
    for (const r of rows) {
      console.log(`${r.sec.toFixed(3)},${r.x.toFixed(4)},${r.z.toFixed(4)},${r.d.toFixed(4)},${r.ey.toFixed(4)},${r.v.toFixed(3)}`);
    }
    continue;
  }

  console.log(`\n  ${shot.name} — ${shot.seconds}s, ${shot.place[0]} / ${shot.place[1]}\n`);
  console.log(`  ${'t'.padEnd(5)}${'x'.padEnd(8)}${'z'.padEnd(9)}${'clear'.padEnd(8)}${'eye'.padEnd(7)}what is around`);
  for (const r of rows) {
    if (Math.abs(r.sec * FPS) % (2 * FPS) > 0.5) continue;
    console.log(
      `  ${r.sec.toFixed(0).padEnd(5)}${r.x.toFixed(2).padEnd(8)}${r.z.toFixed(1).padEnd(9)}` +
      `${r.d.toFixed(3).padEnd(8)}${r.ey.toFixed(2).padEnd(7)}${near(r.z).join('; ')}`,
    );
  }
  const last = rows[rows.length - 1];
  console.log(`\n  travelled ${(shot.place[1] - last.z).toFixed(1)} m, ends z ${last.z.toFixed(1)}, x ${last.x.toFixed(2)}`);
  console.log(`  closest ${worst.d.toFixed(3)} m to ${worst.what} at t ${worst.t.toFixed(1)} — ` +
    (worst.d < BODY_R ? `✗ ${((BODY_R - worst.d) * 1000).toFixed(1)} mm inside` : 'clear of everything'));
  if (worst.d < BODY_R) bad++;
  for (const [k, n] of touches) console.log(`  brushed ${k.padEnd(20)} ${(n / FPS).toFixed(2)} s`);

  /* Time spent where the sun actually reaches the ground. The first third of
   * the delivered take was atmospherically dead because it was spent in a 54 m
   * shadow; this is the number that says whether a candidate has fixed it. */
  const inBand = rows.filter((r) => LANDMARKS
    .filter((l) => l.what.startsWith('SUN BAND'))
    .some((l) => r.z <= l.z1 && r.z >= l.z0)).length;
  console.log(`  ${(100 * inBand / rows.length).toFixed(0)}% of the take is inside a sun band ` +
    `(${(inBand / FPS).toFixed(1)} s of ${shot.seconds})`);
}

console.log(bad ? `\n  ${bad} route(s) hit something\n` : '\n  all routes clear\n');
process.exit(bad ? 1 : 0);
