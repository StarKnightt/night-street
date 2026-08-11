/* The gait model, on the CPU, with no browser and no GPU.
 *
 *   node tools/gait.mjs
 *
 * Everything the walk and the jog are judged on is arithmetic in walker.ts,
 * and arithmetic can be checked without spending a capture slot on it. This
 * imports the real `Walker` — not a copy of the numbers — drives it at a
 * fixed timestep the way the reel does, and prints the quantities a viewer
 * actually reads off a moving frame:
 *
 *   - step length per footfall, measured as the ground distance travelled
 *     between one `onFootstep` and the next. If this drifts from the model's
 *     own step length, the feet are sliding.
 *   - cadence, and its product with step length against ground speed. The
 *     product has to be the speed. Anywhere it is not, the walk is a
 *     conveyor belt.
 *   - the phase of the head-bob minimum relative to the footfall, which is
 *     the "is the bob synchronised with the gait" question stated as a number.
 *   - peak-to-peak vertical and lateral head travel, against the measured
 *     human figures the model is anchored to.
 *
 * This is the cheap half of the walk-video harness. `tools/reel.mjs` is the
 * expensive half and needs the GPU and the capture lock; this needs neither,
 * so it is the thing to run first after touching walker.ts.
 */
import { register } from 'node:module';
register('./ts-hooks.mjs', import.meta.url);

const { Walker, SPRINT_SPEED } = await import('../src/scene/walker.ts');
const { DIMS } = await import('../src/world/dims.ts');

const FPS = Number(process.argv.includes('--fps')
  ? process.argv[process.argv.indexOf('--fps') + 1] : 120);
const DT = 1 / FPS;

/** Run one pace to a steady state, then measure a whole number of steps. */
function measure(sprint, seconds = 14) {
  const w = new Walker();
  const contacts = [];
  w.onFootstep = () => contacts.push({
    t: tNow, x: w.x, z: w.z, phase: w.phase, ey: w.eye.y, v: w.speed,
  });

  let tNow = 0;
  const trace = [];
  for (let i = 0; i < Math.round(seconds * FPS); i++) {
    w.update(DT, { forward: 1, strafe: 0, sprint });
    tNow += DT;
    trace.push({ t: tNow, ey: w.eye.y, ex: w.eye.x, x: w.x, z: w.z, roll: w.roll, phase: w.phase, v: w.speed });
  }

  /* Only the settled half. The first few seconds are the acceleration ramp
   * and its step lengths are legitimately short. */
  const from = tNow * 0.5;
  const settled = contacts.filter((c) => c.t > from);
  const steps = [];
  for (let i = 1; i < settled.length; i++) {
    const a = settled[i - 1], b = settled[i];
    steps.push({
      len: Math.hypot(b.x - a.x, b.z - a.z),
      dur: b.t - a.t,
      v: b.v,
    });
  }
  const st = trace.filter((r) => r.t > from);
  const eys = st.map((r) => r.ey), exs = st.map((r) => r.ex - r.x);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

  /* Vertical head acceleration.
   *
   * A running gait is a series of controlled falls and the head really does
   * see one to two g at contact, so a large number here is not by itself
   * wrong. What would be wrong is a number that keeps growing as the sample
   * rate rises, because that is a corner in the waveform rather than a
   * curvature — a genuine velocity discontinuity, which at 30 fps output is a
   * snap at the bottom of every stride rather than a footfall. Compare the
   * two rates this tool prints. */
  const accs = [];
  for (let i = 2; i < st.length; i++) {
    accs.push(Math.abs(st[i].ey - 2 * st[i - 1].ey + st[i - 2].ey) / (DT * DT));
  }
  accs.sort((a, b) => a - b);

  /* Where the head bottoms out, expressed as a fraction of a step after the
   * footfall event. Found by walking the trace between two contacts and
   * taking the minimum eye height in that interval. */
  const lags = [];
  for (let i = 1; i < settled.length; i++) {
    const a = settled[i - 1], b = settled[i];
    const seg = st.filter((r) => r.t >= a.t && r.t < b.t);
    if (seg.length < 4) continue;
    let lo = seg[0];
    for (const r of seg) if (r.ey < lo.ey) lo = r;
    lags.push((lo.t - a.t) / (b.t - a.t));
  }

  return {
    pace: sprint ? 'jog' : 'walk',
    speed: mean(steps.map((s) => s.v)),
    stepLen: mean(steps.map((s) => s.len)),
    stepLenSd: Math.sqrt(mean(steps.map((s) => (s.len - mean(steps.map((q) => q.len))) ** 2))),
    cadence: 1 / mean(steps.map((s) => s.dur)),
    bobPP: (Math.max(...eys) - Math.min(...eys)) * 1000,
    swayPP: (Math.max(...exs) - Math.min(...exs)) * 1000,
    troughAt: mean(lags),
    accP99: accs[Math.floor(accs.length * 0.99)],
    accPeak: accs[accs.length - 1],
    contacts: settled.length,
  };
}

const rows = [measure(false), measure(true)];

console.log(`\n  gait model, ${FPS} Hz, ${rows[0].contacts} settled footfalls per pace\n`);
console.log('  pace  speed   step    cadence  step*cad  slip     bob pp   sway pp  trough   accel m/s²');
console.log('        m/s     m       /s       m/s       %        mm       mm       of step  p99 / peak');
for (const r of rows) {
  const product = r.stepLen * r.cadence;
  const slip = 100 * (product - r.speed) / r.speed;
  console.log(
    `  ${r.pace.padEnd(5)} ${r.speed.toFixed(3).padStart(5)}   ` +
    `${r.stepLen.toFixed(3)}   ${r.cadence.toFixed(3).padStart(6)}   ` +
    `${product.toFixed(3).padStart(6)}    ${slip.toFixed(3).padStart(6)}   ` +
    `${r.bobPP.toFixed(1).padStart(5)}    ${r.swayPP.toFixed(1).padStart(5)}    ${r.troughAt.toFixed(3)}    ` +
    `${r.accP99.toFixed(1).padStart(5)} / ${r.accPeak.toFixed(1)}`,
  );
}

/* The acceleration ramp is where a gait model that is right at both ends can
 * still be wrong, so it gets its own check: at every speed the walker passes
 * through on the way up, does step length times cadence still equal the
 * ground speed? */
console.log('\n  through the ramp (Shift pressed at t=0):\n');
console.log('  t      speed   step    cadence  slip %');
{
  const w = new Walker();
  let t = 0, last = null;
  const marks = [0.1, 0.2, 0.35, 0.5, 0.75, 1.0, 1.5, 2.5];
  let mi = 0;
  const contacts = [];
  w.onFootstep = () => contacts.push({ t, x: w.x, z: w.z });
  for (let i = 0; i < 3 * FPS && mi < marks.length; i++) {
    w.update(DT, { forward: 1, strafe: 0, sprint: true });
    t += DT;
    if (contacts.length >= 2) {
      const a = contacts[contacts.length - 2], b = contacts[contacts.length - 1];
      last = { len: Math.hypot(b.x - a.x, b.z - a.z), cad: 1 / (b.t - a.t) };
    }
    if (t >= marks[mi]) {
      mi++;
      if (!last) continue;
      const slip = 100 * (last.len * last.cad - w.speed) / w.speed;
      console.log(
        `  ${t.toFixed(2)}   ${w.speed.toFixed(3)}   ${last.len.toFixed(3)}   ` +
        `${last.cad.toFixed(3).padStart(6)}   ${slip.toFixed(2).padStart(6)}`,
      );
    }
  }
}

console.log(`\n  walk ${DIMS.walkSpeed} m/s, jog ${SPRINT_SPEED} m/s`);
console.log('  reference: adult walking step 0.70-0.75 m at 1.9-2.1 /s, 25-30 mm of');
console.log('  vertical head travel; jogging step 1.05-1.25 m at 2.6-2.9 /s, 60-80 mm.');
console.log('  the head bottoms out 0.08-0.15 of a step after contact.\n');
