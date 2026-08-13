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
 *   - the sensor grain in grade.tsx, reseeded from a frame counter (uSeed);
 *   - the volumetric march's interleaved-gradient jitter and its shadow-map
 *     rotation, both reseeded from the same counter (volumetric.ts, uFrame);
 *   - the clock-driven animation: dust, the traffic signal, the cars.
 *
 * The first two advance on the frame counter and the third on the clock, which
 * gives the decomposition this tool is built around. `s.step(0)` advances the
 * frame counter and not the clock, so:
 *
 *   dt=0, stock            frame-counter terms only  (grain + volumetric)
 *   dt=0, nograin          volumetric jitter alone
 *   dt=0, nograin+novol    NOTHING should vary. This is the control, and if it
 *                          is not bit-identical the finding is real.
 *   dt=1/60, nograin+novol clock-driven animation alone
 *   dt=1/60, stock         what a parked user actually sees
 *
 * Every case is a run in the same browser against the same build, so the
 * comparison is within one build and an absent term reads as exactly zero
 * rather than as a small number that has to be argued about.
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

/* Cases as "query|dt". The default set is the decomposition above. */
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
  const [q, dtStr] = spec.split('|');
  const dt = +dtStr;
  const url = DEV_URL + (q ? `?${q}` : '');
  console.log(`\n══ q="${q || 'stock'}"  dt=${dt} ══  ${url}`);

  await run({ width: W, height: H, url }, async ({ page, errs, readShaderErrors }) => {
    await page.evaluate(([t, yaw, pitch]) => {
      const s = window.__scene;
      s.goTo(t); s.setYaw(yaw); s.setPitch(pitch); s.warp(2.0);
      s.setDriven(true);
    }, [T, YAW, PITCH]);
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
      };
    }, [FRAMES, dt]);

    const shaderErrors = await readShaderErrors();
    if (shaderErrors.length) console.error(`  ✗ ${shaderErrors.length} shader error(s)`);
    results.push({
      q: q || 'stock', dt, ...data, shaderErrors,
      errs: [...new Set(errs)].filter((e) => !e.includes('X3595')),
    });
  });
}

/* ── Report ───────────────────────────────────────────────────────────── */
console.log(`\n\n  ${FRAMES} frames at ${W}x${H}, camera parked at t=${T} yaw=${YAW} pitch=${PITCH}`);
console.log('  Differences are 8-bit code values on the canvas, after the full post chain.\n');
console.log('  case                          dt        mean     p99.9      max    %px    identical  drift(mean/max)');
for (const r of results) {
  const mean = r.series.reduce((a, s) => a + s.mean, 0) / r.series.length;
  const p999 = r.series.reduce((a, s) => a + s.p999, 0) / r.series.length;
  const max = Math.max(...r.series.map((s) => s.max));
  const pct = r.series.reduce((a, s) => a + s.pct, 0) / r.series.length;
  console.log(`  ${r.q.padEnd(26)}  ${String(r.dt).padEnd(9)} ${mean.toFixed(4).padStart(7)} `
    + `${p999.toFixed(2).padStart(8)} ${String(max).padStart(8)} ${pct.toFixed(1).padStart(6)} `
    + `${(r.identicalPairs + '/' + r.pairs).padStart(11)}   ${r.drift.mean.toFixed(4)}/${r.drift.max}`);
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
