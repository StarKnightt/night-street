/* Does the collider hold, and does the kerb feel like a kerb.
 *
 *   node tools/collide.mjs            everything
 *   node tools/collide.mjs approach   penetration over approach angles
 *   node tools/collide.mjs corner     corners, glances and wedges
 *   node tools/collide.mjs rate       is the response a curve or a corner
 *   node tools/collide.mjs kerb       the vertical profile of a 145 mm step
 *   node tools/collide.mjs drift      the tool tables against the real ones
 *   node tools/collide.mjs sweep      the whole street, on a grid
 *
 * No browser, no GPU and no capture lock: this drives the same `Walker` the
 * page does, which is the only reason it can be trusted. A collider validated
 * by one capture is a collider validated at one approach angle and one frame
 * rate, and both of those are exactly where this class of defect hides.
 *
 * Two things it measures that eyes cannot.
 *
 * Penetration is signed and reported in millimetres. "It looks fine" is not
 * available at 4 mm, and 4 mm of a shoulder inside a car door is 4 mm of the
 * lens travelling on the wrong side of a surface it will later be occluded by.
 *
 * Peak acceleration is reported at four sample rates. A velocity that turns a
 * corner has no second derivative, so its measured peak acceleration is
 * whatever the sample rate happens to be — the gait's own contact cusp read
 * 35, 138 and 540 m/s² at 30, 120 and 480 Hz before it was rounded. A response
 * that is genuinely smooth converges instead, and the ratio between rates is
 * the measurement rather than the number at any one of them.
 */
import { register } from 'node:module';

register('./ts-hooks.mjs', import.meta.url);

const { Walker } = await import('../src/scene/walker.ts');
const { nearest, solids, BODY_R, groundHeight } = await import('../src/scene/collide.ts');
const { carSolids } = await import('../src/world/cars.ts');
const { DIMS } = await import('../src/world/dims.ts');
const obstacles = await import('./obstacles.mjs');

const only = process.argv[2] || null;
const want = (name) => !only || only === name;
let bad = 0;
const fail = (msg) => { bad++; console.log(`    ✗ ${msg}`); };

const mm = (m) => (m * 1000).toFixed(2);
const pad = (s, n) => String(s).padEnd(n);

/**
 * Walk a heading for a while and report what the body did.
 *
 * Everything goes through `walker.update` with a held forward key, which is
 * the same call the keyboard and the capture harness both make. Nothing here
 * sets x or z after the start.
 */
function run({ x, z, yaw, seconds, dt, sprint = false, strafe = 0 }) {
  const w = new Walker();
  w.x = x; w.z = z; w.yaw = yaw;
  w.snapGround();
  const p = [];
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    w.update(dt, { forward: 1, strafe, sprint });
    p.push({
      t: (i + 1) * dt,
      x: w.x, z: w.z,
      ex: w.eye.x, ey: w.eye.y, ez: w.eye.z,
      g: w.groundY, v: w.speed, hit: w.contact,
      clear: nearest(w.x, w.z).d,
    });
  }
  return p;
}

/** Peak magnitude of the second difference of a series, per second squared. */
function peakAccel(p, key, dt) {
  let peak = 0;
  for (let i = 2; i < p.length; i++) {
    const a = (p[i][key] - 2 * p[i - 1][key] + p[i - 2][key]) / (dt * dt);
    if (Math.abs(a) > peak) peak = Math.abs(a);
  }
  return peak;
}

/** Peak planar acceleration of the body, which is where a pop would show. */
function peakPlanar(p, dt) {
  let peak = 0, at = 0;
  for (let i = 2; i < p.length; i++) {
    const ax = (p[i].x - 2 * p[i - 1].x + p[i - 2].x) / (dt * dt);
    const az = (p[i].z - 2 * p[i - 1].z + p[i - 2].z) / (dt * dt);
    const a = Math.hypot(ax, az);
    if (a > peak) { peak = a; at = p[i].t; }
  }
  return { peak, at };
}

const worstClear = (p) => p.reduce((a, b) => (b.clear < a.clear ? b : a), p[0]);

/* ── 1. Straight at everything, from every side ─────────────────────────── */

if (want('approach')) {
  console.log('\n  APPROACH — every solid, sixteen headings, walk and jog\n');
  console.log(`  body radius ${BODY_R} m; penetration is (radius - clearance), positive is inside\n`);

  const targets = solids().filter((s) => s.what !== 'building line');
  let worst = { pen: -1e9 };
  let worstRun = { pen: -1e9 };
  const perKind = new Map();

  for (const s of targets) {
    const reach = (s.kind === 'disc' ? s.r : Math.hypot(s.hw, s.hl)) + BODY_R;
    for (let k = 0; k < 16; k++) {
      /* Aimed at the centre from 3 m out, so the contact is head-on at eight
       * of the sixteen and oblique on a box at the rest. The offsets in the
       * corner section below are what make a glance. */
      const a = (k / 16) * Math.PI * 2;
      const d = reach + 3.0;
      const from = { x: s.x + Math.cos(a) * d, z: s.z + Math.sin(a) * d };
      /* A start inside another solid, or behind a frontage, is not an approach
       * — it is a teleport into a wall, which `placeAt` handles separately. */
      if (nearest(from.x, from.z).d < BODY_R) continue;
      // Heading: yaw 0 walks toward -Z, and yaw increases toward -X.
      const yaw = Math.atan2(-(s.x - from.x), -(s.z - from.z));
      for (const [sprint, secs] of [[false, 5], [true, 3]]) {
        const p = run({ ...from, yaw, seconds: secs, dt: 1 / 60, sprint });
        const w = worstClear(p);
        const pen = BODY_R - w.clear;
        const rec = { pen, what: s.what, a: (a * 180 / Math.PI).toFixed(0), sprint };
        if (sprint) { if (pen > worstRun.pen) worstRun = rec; } else if (pen > worst.pen) worst = rec;
        const key = s.kind === 'disc' ? (s.what.includes('mirror') ? 'car mirror' : s.what) : 'car body/box';
        const cur = perKind.get(key);
        if (!cur || pen > cur.pen) perKind.set(key, rec);
      }
    }
  }

  for (const [k, v] of [...perKind].sort((a, b) => b[1].pen - a[1].pen)) {
    console.log(`  ${pad(k, 16)} worst penetration ${pad(mm(v.pen), 8)} mm  at ${v.a}°${v.sprint ? ' jogging' : ''}`);
  }
  console.log(`\n  walk  worst ${mm(worst.pen)} mm into ${worst.what} at ${worst.a}°`);
  console.log(`  jog   worst ${mm(worstRun.pen)} mm into ${worstRun.what} at ${worstRun.a}°`);
  if (worst.pen > 0.0005 || worstRun.pen > 0.0005) fail('a body ended a frame inside a solid');
  else console.log('    ✓ nothing ever ends a frame inside anything');
}

/* ── 2. Glances, corners and wedges ─────────────────────────────────────── */

if (want('corner')) {
  console.log('\n  CORNER — glancing contacts, box corners and the wedges\n');

  /* A glance is the hard case for a projected slide: the contact normal turns
   * under the walker while it is touching, so a solver that projects once and
   * commits either loses the whole step or throws it sideways. Offsets are
   * swept through the exact tangent, which is the singular point. */
  const car = solids().find((s) => s.kind === 'box' && s.what.startsWith('hatch'));
  let worstPen = -1e9, worstAcc = 0, worstAt = '';
  for (const off of [-0.40, -0.28, -0.24, -0.231, -0.23, -0.229, -0.20, -0.10, 0, 0.10, 0.20, 0.229, 0.23, 0.231, 0.28, 0.40]) {
    for (const along of [0, 1]) {
      // Along the flank, and along the end, each offset laterally by `off`
      // past the corner so the sweep crosses the exact tangent.
      const dir = along ? 0 : Math.PI / 2;
      const perp = dir + Math.PI / 2;
      const edge = along ? car.hw : car.hl;
      const start = {
        x: car.x - Math.sin(dir) * (car.hl + car.hw + 4) + Math.cos(perp) * 0 + Math.cos(dir) * 0,
        z: car.z - Math.cos(dir) * (car.hl + car.hw + 4),
      };
      const from = {
        x: car.x + Math.sin(dir) * 0 + (along ? (edge + BODY_R + off) : 0) - (along ? 0 : 0),
        z: start.z,
      };
      if (!along) from.x = car.x + (car.hw + BODY_R + off);
      const p = run({ x: from.x, z: from.z, yaw: 0, seconds: 7, dt: 1 / 120 });
      const w = worstClear(p);
      const pen = BODY_R - w.clear;
      const acc = peakPlanar(p, 1 / 120);
      if (pen > worstPen) worstPen = pen;
      if (acc.peak > worstAcc) { worstAcc = acc.peak; worstAt = `offset ${off} m`; }
      const label = `offset ${off >= 0 ? '+' : ''}${off.toFixed(3)}`;
      if (Math.abs(off) < 0.25) {
        console.log(`  ${pad(label, 16)} pen ${pad(mm(pen), 8)} mm   peak |a| ${pad(acc.peak.toFixed(2), 7)} m/s²   ends z ${p[p.length - 1].z.toFixed(2)}`);
      }
    }
  }
  console.log(`\n  worst penetration ${mm(worstPen)} mm, worst planar acceleration ${worstAcc.toFixed(2)} m/s² (${worstAt})`);
  if (worstPen > 0.0005) fail('a glancing contact penetrated');

  /* The wedge: the mouth of the service alley, where the dumpster, the bag
   * piles and the building line meet, and the tightest corner on the street.
   * A solver that resolves one surface per frame vibrates here. */
  console.log('\n  the alley wedge, walked into from four headings:');
  for (const yaw of [0.4, 0.9, 1.4, 2.2]) {
    const p = run({ x: -4.2, z: -66.5, yaw, seconds: 8, dt: 1 / 120 });
    const w = worstClear(p);
    const acc = peakPlanar(p, 1 / 120);
    const end = p[p.length - 1];
    console.log(`  yaw ${pad(yaw.toFixed(2), 6)} pen ${pad(mm(BODY_R - w.clear), 8)} mm  peak |a| ${pad(acc.peak.toFixed(2), 7)} m/s²  rests at ${end.x.toFixed(2)}, ${end.z.toFixed(2)} on ${end.hit || 'nothing'}`);
    if (BODY_R - w.clear > 0.0005) fail(`the wedge penetrated at yaw ${yaw}`);
  }

  /* Jitter: pressed into a corner and held there, does the body sit still?
   * A depenetration that fights a projection oscillates by a millimetre or two
   * a frame, which is invisible in a still and reads as a shiver on video. */
  const held = run({ x: -1.945, z: -20, yaw: 0, seconds: 12, dt: 1 / 120 });
  const tail = held.slice(-240);
  let jitter = 0;
  for (let i = 1; i < tail.length; i++) {
    jitter = Math.max(jitter, Math.hypot(tail[i].x - tail[i - 1].x, tail[i].z - tail[i - 1].z));
  }
  console.log(`\n  held against a car flank for 2 s: largest frame-to-frame move ${mm(jitter)} mm, speed ${tail[tail.length - 1].v.toFixed(4)} m/s`);
  if (jitter > 1e-4) fail('the body jitters while held against a surface');
}

/* ── 3. Is the response a curve or a corner ─────────────────────────────── */

if (want('rate')) {
  console.log('\n  RATE — the largest velocity change in one frame, in m/s\n');
  /* Acceleration is the wrong unit for a contact and the numbers say so: a
   * walker that stops dead against a car flank in one frame reads 42 m/s² at
   * 30 Hz and 168 at 120, and neither is a defect — it is one walking pace
   * divided by one frame, which is what stopping is.
   *
   * The rate-independent quantity is the velocity change itself. Removing the
   * component of the motion that points into a surface can take away at most
   * the speed the walker had, so any step of |dv| above the pace is the solver
   * putting energy in rather than taking it out, and that is a pop. Printed
   * against the pace, and the pace is 1.4 m/s walking and 3.1 jogging.
   */
  console.log('  A stop can cost at most one pace. Anything above it is the solver.\n');
  console.log(`  ${pad('case', 22)} ${pad('30 Hz', 10)} ${pad('120 Hz', 10)} ${pad('480 Hz', 10)} ${pad('1920 Hz', 10)} verdict`);

  const cases = [
    { name: 'free walk', x: 0.4, z: -20, yaw: 0, seconds: 6, key: 'planar' },
    { name: 'square into a car', x: -1.945, z: -18, yaw: 0, seconds: 8, key: 'planar' },
    { name: 'glancing a car', x: -1.10, z: -18, yaw: 0, seconds: 8, key: 'planar' },
    { name: 'into a lamp column', x: -4.30, z: -37, yaw: 0, seconds: 8, key: 'planar' },
    { name: 'jog into a car', x: -1.945, z: -18, yaw: 0, seconds: 6, sprint: true, key: 'planar' },
    { name: 'kerb, vertical', x: 2.0, z: -30, yaw: -Math.PI / 2, seconds: 4, key: 'ey' },
    { name: 'kerb, ground only', x: 2.0, z: -30, yaw: -Math.PI / 2, seconds: 4, key: 'g' },
  ];

  for (const c of cases) {
    const row = [];
    for (const hz of [30, 120, 480, 1920]) {
      const dt = 1 / hz;
      const p = run({ ...c, dt });
      row.push((c.key === 'planar' ? peakPlanar(p, dt).peak : peakAccel(p, c.key, dt)) * dt);
    }
    const pace = c.sprint ? 3.1 : DIMS.walkSpeed;
    const over = Math.max(...row) > pace * 1.02;
    // The vertical cases are the ground filter, which is a curve: it has to
    // converge rather than merely stay under a pace.
    const vertical = c.key !== 'planar';
    const growth = row[3] / Math.max(row[1], 1e-9);
    const verdict = vertical
      ? (growth > 2.0 ? '✗ scales with the rate' : 'converges')
      : (over ? '✗ gains speed on contact' : `at most one pace (${pace})`);
    if (over || (vertical && growth > 2.0)) bad++;
    console.log(`  ${pad(c.name, 22)} ${row.map((v) => pad(v.toFixed(4), 10)).join('')}${verdict}`);
  }
}

/* ── 4. The kerb ────────────────────────────────────────────────────────── */

if (want('kerb')) {
  console.log('\n  KERB — the vertical profile of a 145 mm step\n');

  /* Crossed at 60 degrees to the kerb rather than square on.
   *
   * Square on there is not enough footway left to watch the tail of the
   * response: a jog crosses the 2.35 m from the kerb to the building line in
   * 0.76 s and the wall then truncates the very thing being measured. At 60
   * degrees the lateral rate is halved, the step in the ground under the feet
   * is exactly the same 145 mm, and there is three seconds of footway.
   */
  for (const [label, sprint, x0, secs] of [['walking', false, 2.2, 2.6], ['jogging', true, 1.4, 2.2]]) {
    const dt = 1 / 960;
    const p = run({ x: x0, z: -30.0, yaw: -Math.PI / 2 + 1.05, seconds: secs, dt, sprint });

    // The crossing itself: the frame where the ground under the feet steps.
    let cross = -1;
    for (let i = 1; i < p.length; i++) {
      if (Math.abs(p[i].x) >= DIMS.roadHalf && Math.abs(p[i - 1].x) < DIMS.roadHalf) { cross = i; break; }
    }
    if (cross < 0) { fail(`${label}: never reached the kerb`); continue; }

    /* Against the ground under the feet at the moment of the step, not against
     * where the walker finishes: the footway also falls 31 mm across its width
     * and settles per flag, so a baseline taken at the end of the run mixes
     * 145 mm of kerb with 20 mm of cross-fall and stretches the rise time by a
     * factor of four. */
    const y0 = p[cross - 1].g;
    const top = groundHeight(p[cross].x, p[cross].z);
    const rise = top - y0;
    const at = (frac) => {
      const target = y0 + rise * frac;
      for (let i = cross; i < p.length; i++) if (p[i].g >= target) return p[i].t;
      return NaN;
    };
    const t10 = at(0.10), t90 = at(0.90);
    let vmax = 0, amax = 0, over = 0, lag = 0;
    for (let i = cross; i < p.length; i++) {
      const v = (p[i].g - p[i - 1].g) / dt;
      if (Math.abs(v) > vmax) vmax = Math.abs(v);
      if (i > cross + 1) {
        const a = (p[i].g - 2 * p[i - 1].g + p[i - 2].g) / (dt * dt);
        if (Math.abs(a) > amax) amax = Math.abs(a);
      }
      const raw = groundHeight(p[i].x, p[i].z);
      over = Math.max(over, p[i].g - raw);
      lag = Math.max(lag, raw - p[i].g);
    }
    /* How long until the eye is within 2 mm of the ground and stays there.
     * Not 1 mm: the footway keeps rising under the walker at 9 mm/s of
     * cross-fall after the kerb, and a filter tracking a ramp trails it by a
     * constant 1.4 mm for ever, which is a lag and not a settling time. */
    let settle = NaN;
    for (let i = p.length - 1; i > cross; i--) {
      if (Math.abs(p[i].g - groundHeight(p[i].x, p[i].z)) > 0.002) { settle = p[i].t - p[cross].t; break; }
    }
    // What the eye did, bob and all, over the crossing and the half second
    // after it, against the same walker on level ground at the same pace.
    const win = p.slice(cross - 2, cross + Math.round(0.5 / dt));
    const eyeA = peakAccel(win, 'ey', dt);
    const freeEyeA = peakAccel(run({ x: 0.4, z: -20, yaw: 0, seconds: 4, dt, sprint }).slice(-win.length), 'ey', dt);

    console.log(`  ${label}, crossing at ${(p[cross].v).toFixed(2)} m/s`);
    console.log(`    step               ${mm(rise)} mm   (kerb reveal ${mm(DIMS.kerbHeight)} mm plus stone settlement)`);
    console.log(`    10-90% rise        ${((t90 - t10) * 1000).toFixed(0)} ms`);
    console.log(`    peak vertical      ${vmax.toFixed(3)} m/s`);
    console.log(`    peak acceleration  ${amax.toFixed(1)} m/s²  (ground term alone)`);
    console.log(`    eye, with the bob  ${eyeA.toFixed(1)} m/s²  against ${freeEyeA.toFixed(1)} on the level`);
    console.log(`    deepest lag        ${mm(lag)} mm below the surface, mid-climb`);
    console.log(`    overshoot          ${mm(over)} mm`);
    console.log(`    settled to 1 mm    ${(settle * 1000).toFixed(0)} ms`);
    if (over > 0.0005) fail(`${label}: the kerb overshoots, which reads as a stumble`);
    if ((t90 - t10) > 0.35) fail(`${label}: the kerb rises too slowly to read as a step`);
    if ((t90 - t10) < 0.06) fail(`${label}: the kerb rises fast enough to read as a teleport`);
  }

  /* Down is the same filter and should behave the same way, and the camber and
   * the gutter dish are the low-frequency case it must not lag on. */
  const dt = 1 / 960;
  const down = run({ x: 4.0, z: -30.0, yaw: Math.PI / 2, seconds: 3.0, dt });
  let dmax = 0;
  for (let i = 1; i < down.length; i++) dmax = Math.min(dmax, (down[i].g - down[i - 1].g) / dt);
  console.log(`\n  stepping down off the kerb: peak vertical ${dmax.toFixed(3)} m/s`);

  const level = run({ x: 0.2, z: -10, yaw: 0, seconds: 20, dt: 1 / 120 });
  let lag = 0;
  for (const s of level) lag = Math.max(lag, Math.abs(s.g - groundHeight(s.x, s.z)));
  console.log(`  walking the camber and the castings: the filter trails the surface by at most ${mm(lag)} mm`);
  if (lag > 0.004) fail('the ground filter lags the road itself, not just the kerb');
}

/* ── 5. Do the tool tables still describe the street ────────────────────── */

if (want('drift')) {
  console.log('\n  DRIFT — tools/obstacles.mjs against the exported tables\n');
  const real = carSolids().filter((c) => c.kind === 'body');
  if (real.length !== obstacles.CARS.length) {
    console.log(`  ! obstacles.mjs lists ${obstacles.CARS.length} cars, world/cars.ts has ${real.length}`);
  }
  let drift = 0;
  for (const c of obstacles.CARS) {
    const m = real.find((r) => Math.abs(r.z - c.z) < 0.01);
    if (!m) { console.log(`  ! ${c.what} at z ${c.z} is not in world/cars.ts any more`); drift++; continue; }
    for (const [k, a, b] of [['x', c.x, m.x], ['hw', c.hw, m.hw], ['hl', c.hl, m.hl]]) {
      if (Math.abs(a - b) > 0.001) { console.log(`  ! ${c.what} ${k}: obstacles.mjs ${a}, cars.ts ${b}`); drift++; }
    }
  }
  const missing = real.filter((r) => !obstacles.CARS.some((c) => Math.abs(c.z - r.z) < 0.01));
  for (const m of missing) console.log(`  ! ${m.what} at z ${m.z} is in cars.ts and not in obstacles.mjs`);
  console.log(drift || missing.length
    ? `  ${drift + missing.length} disagreements`
    : '    ✓ the car footprints agree');
  console.log('  (the dumpster is a known disagreement: obstacles.mjs has its two');
  console.log('   half extents the other way round. See scene/collide.ts.)');
}

/* ── 6. The whole street, on a grid ─────────────────────────────────────── */

if (want('sweep')) {
  console.log('\n  SWEEP — is the street still walkable end to end\n');
  /* Not a walk: the free set, sampled across the whole block. A collider that
   * seals a footway is a worse defect than one that leaks, and it is one that
   * no route test can find, because a route that was drawn before the collider
   * existed goes round everything anyway.
   *
   * For every metre of the street, the widest continuous lane a 230 mm body
   * can stand in, on each footway and on the carriageway. The minimum of that
   * over the whole block is the answer.
   */
  const lanes = (x0, x1, z) => {
    let best = 0, run = 0, at = x0;
    for (let x = x0; x <= x1; x += 0.01) {
      if (nearest(x, z).d >= BODY_R) { run += 0.01; if (run > best) { best = run; at = x; } } else run = 0;
    }
    return { best, at };
  };
  for (const [name, x0, x1] of [
    ['near footway', -5.30, -(DIMS.roadHalf + DIMS.kerbDepth)],
    ['far footway', DIMS.roadHalf + DIMS.kerbDepth, 5.30],
    ['carriageway', -DIMS.roadHalf, DIMS.roadHalf],
  ]) {
    let worst = { best: 1e9 };
    for (let z = 4; z >= -100; z -= 0.25) {
      const l = lanes(x0, x1, z);
      if (l.best < worst.best) worst = { ...l, z };
    }
    const ok = worst.best > 0.30;
    console.log(
      `  ${pad(name, 14)} narrowest passable lane ${(worst.best * 1000).toFixed(0)} mm, at z ${worst.z.toFixed(1)}` +
      `${ok ? '' : '  ← too narrow to walk'}`,
    );
    if (!ok) fail(`${name} is sealed at z ${worst.z.toFixed(1)}`);
  }

  /* And what the collider actually removes, as a fraction of the block: a
   * plausibility check on the tables rather than on the solver. Nine cars, two
   * bag piles and a bin across a 10.6 by 104 m block is a few per cent. */
  const lim = 5.30;
  let inside = 0, count = 0;
  for (let x = -lim; x <= lim; x += 0.05) {
    for (let z = 4; z >= -100; z -= 0.05) { count++; if (nearest(x, z).d < BODY_R) inside++; }
  }
  console.log(`  ${(100 * inside / count).toFixed(1)}% of the block is now out of bounds (${solids().length - 2} solids)`);
}

console.log(bad ? `\n  ${bad} FAILURES\n` : '\n  all clear\n');
process.exit(bad ? 1 : 0);
