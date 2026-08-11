/* Read a reel and say what moved wrongly.
 *
 *   node tools/motion.mjs [tag]
 *
 * `reel.json` carries per-frame walker state, per-frame frame cost, and
 * region means read straight off the framebuffer before any encoding. This
 * turns that into the five questions a still cannot answer, each as a number:
 *
 *  1. FOOT SLIDE. Ground distance between consecutive footfalls, against the
 *     step length the gait model believes it is using. A mismatch is the feet
 *     scuffing the road, and it is the defect that shipped in the predecessor
 *     project.
 *  2. BOB / GAIT REGISTRATION. Where the eye-height minimum falls between one
 *     footfall and the next, as a fraction of a step. Human centre of mass
 *     bottoms out 0.08-0.15 of a step after contact. Anything before contact
 *     is a bob on its own clock, and the fact that it is periodic at the right
 *     rate is exactly why it survives review — it looks synchronised until it
 *     is measured.
 *  3. TRANSLATION CONTINUITY. Second difference of the eye position. A kerb
 *     the walker steps through, a collider popping, or a clamp engaging shows
 *     up here as a spike and nowhere else, because the position itself stays
 *     smooth to the eye at any single frame.
 *  4. TEMPORAL STABILITY. Frame-to-frame change per region. Low mean with a
 *     high peak is sparse sparkle — specular aliasing on a wet surface, or a
 *     shadow edge crawling. High mean everywhere is just the camera moving,
 *     and the sky region is the control that separates the two.
 *  5. FRAME COST, by pace, from a timer synchronised on readPixels rather
 *     than glFinish.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tag = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'v1';
const reel = JSON.parse(fs.readFileSync(path.join(ROOT, 'shots', tag, 'reel.json'), 'utf8'));

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const f3 = (x) => x.toFixed(3);

/* The model in walker.ts, restated so a measurement can be checked against it
 * without importing the scene. If these two ever disagree the tool is wrong,
 * not the walk — keep them in step. */
const STEP_WALK = 0.70, V_WALK = 1.4, STEP_RUN = 1.13, V_RUN = 3.1;
const SLOPE = (STEP_RUN - STEP_WALK) / (V_RUN - V_WALK);
const BASE = STEP_WALK - SLOPE * V_WALK;
const modelStep = (v) => Math.max(0.30, BASE + SLOPE * v);

const paceOf = (v) => (v > 2.8 ? 'jog' : v > 1.2 && v <= 1.6 ? 'walk' : 'ramp');

import { clearance, KERB_X, KERB_RISE, BODY_R } from './obstacles.mjs';

console.log(`\n═══ ${reel.tag}  ${reel.size[0]}x${reel.size[1]} @ ${reel.fps} fps  ${reel.encode}`);
console.log(`    ${reel.gl.renderer}`);
console.log(`    shot ${reel.when}${reel.query ? `  ?${reel.query}` : ''}` +
  (reel.build ? `  build ${reel.build.digest} (newest ${reel.build.newest.file})` : ''));
if (reel.shaderErrors.length) console.log(`    ✗✗ ${reel.shaderErrors.length} SHADER LINK FAILURES`);

for (const shot of reel.shots) {
  const rows = shot.rows;
  /* A shot may be stepped finer than it is played back — `creep` is — so every
   * rate below has to come off the simulated interval, not the output one. */
  const dt = shot.dt || 1 / reel.fps;
  console.log(`\n─── ${shot.name}   ${shot.frames} frames, ${(shot.frames / reel.fps).toFixed(1)} s of video` +
    (shot.dt ? `, ${(shot.frames * dt).toFixed(3)} s of world at ${(1 / dt).toFixed(0)} Hz` : ''));

  /* 1. Foot slide. */
  console.log('\n  footfall to footfall');
  console.log('    pace   n    measured step   model step   slip      cadence');
  const bands = { walk: [], jog: [], ramp: [] };
  for (let i = 1; i < shot.steps.length; i++) {
    const a = shot.steps[i - 1], b = shot.steps[i];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const dur = (b.frame - a.frame) * dt;
    if (dur <= 0) continue;
    bands[paceOf(b.v)].push({ len, dur, model: modelStep(b.v), v: b.v });
  }
  for (const [name, list] of Object.entries(bands)) {
    if (!list.length) continue;
    const m = mean(list.map((s) => s.len));
    const mm = mean(list.map((s) => s.model));
    console.log(
      `    ${name.padEnd(5)} ${String(list.length).padStart(3)}  ` +
      `${f3(m)} m ±${f3(sd(list.map((s) => s.len)))}   ${f3(mm)} m    ` +
      `${(100 * (m - mm) / mm).toFixed(2).padStart(6)}%   ${(1 / mean(list.map((s) => s.dur))).toFixed(3)}/s`,
    );
  }

  /* 2. Bob against gait. */
  console.log('\n  head bob against footfall');
  const lags = { walk: [], jog: [], ramp: [] };
  const amps = { walk: [], jog: [], ramp: [] };
  for (let i = 1; i < shot.steps.length; i++) {
    const a = shot.steps[i - 1], b = shot.steps[i];
    const seg = rows.slice(a.frame, b.frame);
    if (seg.length < 4) continue;
    let lo = 0, hi = 0;
    for (let k = 1; k < seg.length; k++) {
      if (seg[k].ey < seg[lo].ey) lo = k;
      if (seg[k].ey > seg[hi].ey) hi = k;
    }
    lags[paceOf(b.v)].push(lo / seg.length);
    amps[paceOf(b.v)].push((seg[hi].ey - seg[lo].ey) * 1000);
  }
  console.log('    pace   trough after contact   vertical travel   samples/step');
  for (const [name, list] of Object.entries(lags)) {
    if (!list.length) continue;
    const spd = name === 'jog' ? V_RUN : name === 'walk' ? V_WALK : 0;
    const perStep = spd ? (modelStep(spd) / spd) * reel.fps : 0;
    const flag = name === 'ramp' ? '' : (mean(list) >= 0.05 && mean(list) <= 0.22 ? '  ok' : '  ← OUT OF RANGE');
    console.log(
      `    ${name.padEnd(5)}  ${f3(mean(list))} of a step      ` +
      `${mean(amps[name]).toFixed(1).padStart(5)} mm         ${perStep.toFixed(1)}${flag}`,
    );
  }

  /* 3. Translation continuity. */
  console.log('\n  translation continuity (eye position, second difference)');
  const acc = [];
  for (let i = 2; i < rows.length; i++) {
    const d1 = Math.hypot(rows[i].ex - rows[i - 1].ex, rows[i].ez - rows[i - 1].ez);
    const d0 = Math.hypot(rows[i - 1].ex - rows[i - 2].ex, rows[i - 1].ez - rows[i - 2].ez);
    acc.push({ f: i, a: Math.abs(d1 - d0) / (dt * dt), dy: Math.abs(rows[i].ey - 2 * rows[i - 1].ey + rows[i - 2].ey) / (dt * dt) });
  }
  const aList = acc.map((r) => r.a);
  const worst = [...acc].sort((p, q) => q.a - p.a).slice(0, 3);
  console.log(`    horizontal  median ${pct(aList, 0.5).toFixed(2)} m/s²   p99 ${pct(aList, 0.99).toFixed(2)}   ` +
    `worst ${worst[0].a.toFixed(2)} at frame ${worst[0].f}`);
  console.log(`    vertical    median ${pct(acc.map((r) => r.dy), 0.5).toFixed(2)} m/s²   p99 ${pct(acc.map((r) => r.dy), 0.99).toFixed(2)}`);
  /* Anything above a few g is not a person. Flag runs of frames rather than
   * single ones, because one frame is a rounding artefact and three is a pop. */
  const pops = acc.filter((r) => r.a > 40);
  if (pops.length) {
    console.log(`    ✗ ${pops.length} frame(s) above 40 m/s² horizontal: ` +
      pops.slice(0, 12).map((r) => `${r.f}(${r.a.toFixed(0)})`).join(' '));
  } else console.log('    no discontinuity above 40 m/s²');

  /* 3b. What the walker walked into, and what the ground did about it. */
  let nearest = null;
  const inside = [];
  for (let i = 0; i < rows.length; i++) {
    const c = clearance(rows[i].x, rows[i].z);
    if (!nearest || c.d < nearest.d) nearest = { ...c, i };
    if (c.d < BODY_R) inside.push({ i, what: c.what, d: c.d });
  }
  console.log('\n  obstacles');
  console.log(`    closest approach  ${nearest.d.toFixed(3)} m to the ${nearest.what} ` +
    `at (${nearest.at[0]}, ${nearest.at[1]}), frame ${nearest.i}`);
  if (inside.length) {
    const runs = [];
    for (const p of inside) {
      const last = runs[runs.length - 1];
      if (last && p.i === last.to + 1 && p.what === last.what) last.to = p.i;
      else runs.push({ from: p.i, to: p.i, what: p.what });
    }
    for (const r of runs) {
      console.log(`    ✗ INSIDE the ${r.what} for frames ${r.from}-${r.to} ` +
        `(${((r.to - r.from + 1) / reel.fps).toFixed(2)} s) — walked straight through it`);
    }
  } else {
    console.log('    never came within a shoulder of anything solid on this route');
  }

  /* Eye height against the ground under it. The footway is a step up and the
   * eye should go up with it; if the two columns below are the same number
   * either side of the kerb, nothing is following the ground. */
  const onRoad = rows.filter((r) => Math.abs(r.x) < KERB_X - 0.1);
  const onWalk = rows.filter((r) => Math.abs(r.x) > KERB_X + 0.1);
  if (onRoad.length && onWalk.length) {
    const a = mean(onRoad.map((r) => r.ey)), b = mean(onWalk.map((r) => r.ey));
    console.log(`    eye height  road ${a.toFixed(4)} m   footway ${b.toFixed(4)} m   ` +
      `step ${((b - a) * 1000).toFixed(1)} mm, ground rises ${(KERB_RISE * 1000).toFixed(0)} mm` +
      (Math.abs(b - a) < 0.02 ? '   ✗ no ground following' : ''));
  }

  /* 4. Temporal stability. */
  const travel = mean(rows.slice(1).map((r, i) => Math.hypot(r.ex - rows[i].ex, r.ez - rows[i].ez)));
  console.log(`\n  temporal stability, by region  (8-bit code values, frame to frame)`);
  console.log(`    camera travels ${(travel * 1000).toFixed(1)} mm between frames`);
  console.log('    region      mean Δ   p99 Δ   peak Δ   pixels >13 Δ   mean level');
  const names = Object.keys(reel.regions);
  for (const n of names) {
    const ds = rows.slice(1).map((r) => r.reg[n].d).filter((x) => x != null);
    const dm = rows.slice(1).map((r) => r.reg[n].dmax).filter((x) => x != null);
    const tw = rows.slice(1).map((r) => r.reg[n].twinkle).filter((x) => x != null);
    const lvl = mean(rows.map((r) => 255 * (0.2126 * r.reg[n].rgb[0] + 0.7152 * r.reg[n].rgb[1] + 0.0722 * r.reg[n].rgb[2])));
    console.log(
      `    ${n.padEnd(10)} ${mean(ds).toFixed(2).padStart(6)}  ${pct(ds, 0.99).toFixed(2).padStart(6)}  ` +
      `${Math.max(...dm).toFixed(1).padStart(6)}   ${mean(tw).toFixed(3).padStart(7)}%      ${lvl.toFixed(1).padStart(5)}`,
    );
  }
  const hot = rows.map((r) => r.hotPct);
  console.log(`    clipped pixels: mean ${mean(hot).toFixed(3)}%  peak ${Math.max(...hot).toFixed(3)}%  ` +
    `frame-to-frame sd ${sd(hot).toFixed(4)}%`);

  /* 5. Cost. */
  console.log('\n  frame cost');
  for (const [name, p] of Object.entries(shot.perf)) {
    if (!p) continue;
    console.log(`    ${name.padEnd(5)} ${String(p.frames).padStart(4)} fr   ` +
      `${p.meanMs} ms mean  ${p.p95Ms} p95  ${p.worstMs} worst   →  ` +
      `${p.meanFps} / ${p.p5Fps} / ${p.worstFps} fps`);
  }
}
console.log('');
