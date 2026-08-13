/* Frame-to-frame stability with the camera parked.
 *
 * The question this answers is the narrow one and it is worth stating before
 * the method: with the camera completely still, does the frame differ from
 * itself? A frame that is bit-identical to its predecessor rules out an entire
 * class of cause in one measurement; a frame that is not can be characterised,
 * and — the part that matters on this scene — the *deliberate* time-varying
 * terms can be separated from anything unintended.
 *
 * There are three deliberate ones, and they are why a naive "park and diff"
 * would report instability that is a feature:
 *
 *   - the sensor grain in grade.tsx, reseeded from a clock quantised to
 *     GRAIN_HZ (uSeed) — it was the frame counter until this tool found that
 *     out, see the GRAIN_HZ comment;
 *   - the volumetric march's interleaved-gradient jitter and its shadow-map
 *     rotation, both reseeded from the frame counter (volumetric.ts, uFrame),
 *     deliberately and for a documented reason;
 *   - the clock-driven animation: dust, the traffic signal, the cars.
 *
 * One term advances on the frame counter and the other two on the clock, and
 * `s.step(0)` advances the counter without the clock — which gives the
 * decomposition this tool is built around:
 *
 *   dt=0, stock            the march's jitter alone: the grain is on the clock,
 *                          so a stopped clock freezes it
 *   dt=0, nograin          the march's jitter alone, again — and the fact that
 *                          these two rows now *agree* is a positive test that
 *                          the grain really is clock-driven. Before the fix they
 *                          differed by exactly the grain, so a regression to a
 *                          frame-counter seed shows up here as the two rows
 *                          separating, without anyone having to look for it.
 *   dt=0, nograin+novol    NOTHING should vary. This is the control, and if it
 *                          is not bit-identical the finding is real.
 *   dt=1/60, nograin+novol clock-driven animation alone
 *   dt=1/60, stock         what a parked user actually sees
 *
 * Every case is a run in the same browser against the same build, so the
 * comparison is within one build and an absent term reads as exactly zero
 * rather than as a small number that has to be argued about.
 *
 * `change/s` in the summary, rather than a per-pair mean, is the column that
 * catches a term calibrated to a frame rate instead of to time. A per-pair mean
 * cannot see that bug at all: both endpoints are independent draws whether the
 * seed advanced once or four times between them. Dividing by dt makes it a
 * factor of two in plain sight.
 *
 * Frames are read off the default framebuffer with readPixels after `s.step()`,
 * which is the only pixel path that includes the post chain: `renderOnce()` —
 * what harness.capture() uses — is the scene pass alone and does not run the
 * grade at all, so a PNG from the archive could not answer this question.
 *
 *   node tools/withlock.mjs park -- node tools/park.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, finish, DEV_URL } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const all = (k) => args.reduce((a, v, i) => (v === '--' + k ? [...a, args[i + 1] ?? ''] : a), []);

const TAG = flag('tag', 'park');
const T = +flag('t', 0.4);
const YAW = +flag('yaw', 0);
const PITCH = +flag('pitch', -0.25);
const FRAMES = +flag('frames', 21);
const W = +flag('w', 1280), H = +flag('h', 720);

/* Cases as "query|dt" or "query|dt|grainHz".
 *
 * The third field writes `window.__grade.grainHz` before the run, which is what
 * makes the grain's reseed rate testable: `inf` restores the pre-fix behaviour
 * of one reseed per frame, in the same build, so the two can be differenced
 * against each other rather than against a memory of a previous build.
 */
const CASES = all('case').length ? all('case') : [
  '|0',
  'nograin|0',
  'nograin&post=novol|0',
  'nograin&post=novol|0.0166667',
  '|0.0166667',
];

const outDir = path.join(ROOT, 'shots', TAG);
fs.mkdirSync(outDir, { recursive: true });

const results = [];

for (const spec of CASES) {
  const [q, dtStr, hzStr] = spec.split('|');
  const dt = +dtStr;
  const hz = hzStr === undefined ? null : (/inf/i.test(hzStr) ? Infinity : +hzStr);
  const url = DEV_URL + (q ? `?${q}` : '');
  console.log(`\n══ q="${q || 'stock'}"  dt=${dt}${hz === null ? '' : `  grainHz=${hz}`} ══  ${url}`);

  await run({ width: W, height: H, url }, async ({ page, errs, readShaderErrors }) => {
    const set = await page.evaluate(([t, yaw, pitch, hz]) => {
      const s = window.__scene;
      s.goTo(t); s.setYaw(yaw); s.setPitch(pitch); s.warp(2.0);
      s.setDriven(true);
      /* Written and read back. A uniform or a ref set on an object the page does
       * not actually expose reads as undefined and sweeps nothing, while the
       * table above it still prints — so the value that was reached is reported
       * rather than the value that was sent. */
      if (hz !== null && window.__grade) window.__grade.grainHz = hz;
      return window.__grade ? { grainHz: window.__grade.grainHz } : null;
    }, [T, YAW, PITCH, hz]);
    if (hz !== null) {
      const got = set && set.grainHz;
      console.log(`   grainHz requested ${hz}, page reports ${got}`);
      if (got !== hz) { console.error(`  ✗ grainHz did not take — measuring the wrong thing`); process.exitCode = 1; }
    }
    await page.waitForTimeout(300);

    const data = await page.evaluate(async ([frames, dt]) => {
      const s = window.__scene;
      const gl = s.renderer.getContext();
      const cv = s.renderer.domElement;
      const w = cv.width, h = cv.height;

      /* Settle: a few steps before the first measured frame, so any ramp in
       * the walker, the shadow follower or the signal is over and every
       * measured interval is the steady state. */
      for (let i = 0; i < 8; i++) s.step(dt);

      /* The camera the frames were drawn from, read before and after, so a
       * claim that the camera was parked is a measurement and not an
       * assumption about what setDriven does. */
      const camAt = () => {
        const c = s.camera || (s.renderer && s.renderer.__cam);
        return c ? [c.position.x, c.position.y, c.position.z,
                    c.quaternion.x, c.quaternion.y, c.quaternion.z, c.quaternion.w] : null;
      };
      const cam0 = camAt();

      const buf = [];
      for (let f = 0; f < frames; f++) {
        s.step(dt);
        const b = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, b);
        buf.push(b);
      }
      const cam1 = camAt();

      /* Per-consecutive-pair statistics, plus a 16x9 tile map so a difference
       * can be located on screen rather than only quantified. */
      const TX = 16, TY = 9;
      const tileAcc = new Float64Array(TX * TY);
      const series = [];
      let globalMax = 0, globalMaxAt = null;
      let anyIdentical = 0;

      for (let f = 0; f + 1 < frames; f++) {
        const a = buf[f], b = buf[f + 1];
        let sum = 0, changed = 0, mx = 0;
        const hist = new Float64Array(64);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = (y * w + x) * 4;
            const dr = Math.abs(a[i] - b[i]);
            const dg = Math.abs(a[i + 1] - b[i + 1]);
            const db = Math.abs(a[i + 2] - b[i + 2]);
            const d = 0.2126 * dr + 0.7152 * dg + 0.0722 * db;
            const dmax = Math.max(dr, dg, db);
            sum += d;
            if (dmax > 0) changed++;
            if (dmax > mx) mx = dmax;
            if (dmax > globalMax) { globalMax = dmax; globalMaxAt = [x, h - 1 - y]; }
            hist[Math.min(63, dmax)]++;
            tileAcc[Math.min(TY - 1, (y * TY / h) | 0) * TX + Math.min(TX - 1, (x * TX / w) | 0)] += d;
          }
        }
        const n = w * h;
        if (changed === 0) anyIdentical++;
        // p99.9 of the per-pixel max-channel difference.
        let acc = 0, p999 = 0;
        for (let k = 0; k < 64; k++) { acc += hist[k]; if (acc >= n * 0.999) { p999 = k; break; } }
        series.push({ mean: sum / n, max: mx, pct: (100 * changed) / n, p999 });
      }

      const pairs = frames - 1;
      const perTile = w * h / (TX * TY) * pairs;
      const tiles = [];
      for (let ty = 0; ty < TY; ty++) {
        for (let tx = 0; tx < TX; tx++) {
          tiles.push({ tx, ty, mean: tileAcc[ty * TX + tx] / perTile });
        }
      }

      /* Clipped pixels, off the first frame.
       *
       * Reported for every case because the grain and the blotch both end in a
       * `max(x, 0.0)` and the frame ends in a dither: a change that quietly
       * moved the black floor or pushed highlights into the ceiling would show
       * up as a *smaller* frame difference, which reads as an improvement. Any
       * comparison of stability has to carry these two numbers next to it. */
      let black = 0, blown = 0;
      {
        const f = buf[0];
        for (let p = 0; p < w * h; p++) {
          const i = p * 4;
          if (f[i] === 0 && f[i + 1] === 0 && f[i + 2] === 0) black++;
          if (f[i] === 255 || f[i + 1] === 255 || f[i + 2] === 255) blown++;
        }
      }

      /* Drift: frame 0 against the last frame. A term that oscillates and a
       * term that ramps look the same in a consecutive-pair mean. */
      const a = buf[0], b = buf[frames - 1];
      let driftSum = 0, driftMax = 0;
      for (let i = 0; i < a.length; i += 4) {
        const d = 0.2126 * Math.abs(a[i] - b[i]) + 0.7152 * Math.abs(a[i + 1] - b[i + 1])
                + 0.0722 * Math.abs(a[i + 2] - b[i + 2]);
        driftSum += d;
        const dm = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
        if (dm > driftMax) driftMax = dm;
      }

      return {
        w, h, cam0, cam1,
        camMoved: cam0 && cam1 ? Math.max(...cam0.map((v, i) => Math.abs(v - cam1[i]))) : null,
        series, tiles, globalMax, globalMaxAt, identicalPairs: anyIdentical, pairs,
        drift: { mean: driftSum / (a.length / 4), max: driftMax },
        blackPct: (100 * black) / (w * h), blownPct: (100 * blown) / (w * h),
        grainClock: window.__grade ? window.__grade.grainClock : null,
      };
    }, [FRAMES, dt]);

    const shaderErrors = await readShaderErrors();
    if (shaderErrors.length) console.error(`  ✗ ${shaderErrors.length} shader error(s)`);
    results.push({
      /* As a string when it is not finite: JSON.stringify turns Infinity into
       * null, so the report on disk would say "no rate was set" about a run
       * whose whole purpose was to set one. */
      q: q || 'stock', dt, hz: Number.isFinite(hz) ? hz : (hz === null ? null : String(hz)),
      ...data, shaderErrors,
      errs: [...new Set(errs)].filter((e) => !e.includes('X3595')),
    });
  });
}

/* ── Report ───────────────────────────────────────────────────────────── */
console.log(`\n\n  ${FRAMES} frames at ${W}x${H}, camera parked at t=${T} yaw=${YAW} pitch=${PITCH}`);
console.log('  Differences are 8-bit code values on the canvas, after the full post chain.\n');
/* The threshold that separates a redraw from the noise floor, as a percentage
 * of pixels changed in a pair.
 *
 * A grain redraw moves about 17 per cent of the frame; the residual — four or
 * five pixels of driver nondeterminism at one code value, see tmp/determ.mjs —
 * moves 0.0005 per cent. The two are four orders of magnitude apart, so any
 * threshold between them gives the same answer and the choice is not a tuning
 * parameter. Counting "pairs that differ at all" is what does not work: the
 * residual then reads as a redraw and inflates the rate. */
const REDRAW_PCT = 1.0;

console.log('  case                            dt      grainHz     mean    max    %px   redraws/s   change/s   black%  blown%');
for (const r of results) {
  const mean = r.series.reduce((a, s) => a + s.mean, 0) / r.series.length;
  const max = Math.max(...r.series.map((s) => s.max));
  const pct = r.series.reduce((a, s) => a + s.pct, 0) / r.series.length;
  /* Two statements of the same invariance, one thresholded and one not.
   *
   * redraws/s is how often the noise field is actually redrawn, and it is the
   * number the fix is specified in. change/s is the mean difference integrated
   * over a second rather than over a frame, and it needs no threshold at all —
   * which makes it the one to quote, because it cannot be argued with. A term
   * driven by the frame counter scales both with the frame rate; a term driven
   * by the clock leaves both alone. */
  const redraws = r.series.filter((s) => s.pct > REDRAW_PCT).length;
  const rate = r.dt > 0 ? redraws / (r.pairs * r.dt) : null;
  const perSec = r.dt > 0 ? mean / r.dt : null;
  console.log(`  ${r.q.padEnd(28)} ${String(r.dt).padEnd(10)} ${String(r.hz ?? '—').padEnd(8)}`
    + `${mean.toFixed(4).padStart(7)} ${String(max).padStart(6)} ${pct.toFixed(1).padStart(6)} `
    + `${(rate === null ? '—' : rate.toFixed(1)).padStart(11)} `
    + `${(perSec === null ? '—' : perSec.toFixed(2)).padStart(10)} `
    + `${r.blackPct.toFixed(2).padStart(8)} ${r.blownPct.toFixed(2).padStart(7)}`);
  if (r.camMoved !== null && r.camMoved > 0) {
    console.log(`     ⚠ camera moved during the run by ${r.camMoved.toExponential(2)} — not a parked measurement`);
  }
}

for (const r of results) {
  console.log(`\n  ── q="${r.q}" dt=${r.dt} ──`);
  const top = [...r.tiles].sort((a, b) => b.mean - a.mean).slice(0, 6);
  console.log('     hottest tiles (16x9 grid, tx,ty from top-left):  '
    + top.map((t) => `(${t.tx},${t.ty})=${t.mean.toFixed(3)}`).join('  '));
  console.log(`     peak pixel difference ${r.globalMax} cv at ${r.globalMaxAt ? r.globalMaxAt.join(',') : '—'} (GL coords, y up)`);
  console.log('     per-pair mean: ' + r.series.map((s) => s.mean.toFixed(3)).join(' '));
}

fs.writeFileSync(path.join(outDir, 'park.json'),
  JSON.stringify({ when: new Date().toISOString(), t: T, yaw: YAW, pitch: PITCH, w: W, h: H, frames: FRAMES, results }, null, 2));
console.log(`\n  wrote ${path.relative(ROOT, path.join(outDir, 'park.json'))}\n`);
finish(0);
