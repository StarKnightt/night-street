/* Temporal stability of the ground under a walking camera.
 *
 * The walk-video harness found that the shadowed carriageway differences at
 * 9.5 code values after 5.6 mm of camera travel and only 13.8 after 90 mm,
 * while the facade beside it goes 2.2 -> 13.3 over the same interval. A
 * difference that is already saturated at the smallest step is not parallax,
 * it is aliasing: the shading function under the pixel is above Nyquist, so
 * any sub-pixel move draws an independent sample of it.
 *
 * This reproduces that measurement so a fix can be checked rather than
 * assumed, and adds the two things needed to *attribute* it:
 *
 *   - a grid of patches rather than three hand-placed ones, each reported with
 *     its own mean level, so "shadowed road" and "sunlit road" are picked out
 *     of the frame by measurement instead of by eye;
 *   - a URL query per run, so the same walk can be measured with ?nospec and
 *     ?nochips and the layers separated by subtraction.
 *
 * Method, and the parts of it that matter:
 *
 *   The whole frame loop is taken off the wall clock with setDriven, and the
 *   walk is driven by a real KeyW keydown into the same listener the keyboard
 *   uses, so the dust, the shadow follower and the gait all advance by exactly
 *   the step and a capture that takes four minutes measures the same motion as
 *   one that takes forty seconds.
 *
 *   Frames are read back off the framebuffer with readPixels, which is also
 *   the only synchronisation in a page that can be trusted — glFinish returns
 *   when Chromium has handed the command buffer over, not when the frame
 *   exists. Only the patch rectangles are read, so a 33-frame run moves about
 *   nine megabytes rather than two hundred.
 *
 *   Differences are taken between frames n and n+k for k = 1, 4, 16, which at
 *   1/240 s and 1.4 m/s is 5.8 mm, 23 mm and 93 mm of travel.
 *
 *   node tools/withlock.mjs shimmer -- node tools/shimmer.mjs --q "" --q nospec
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture, finish, DEV_URL } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const all = (k) => args.reduce((a, v, i) => (v === '--' + k ? [...a, args[i + 1] ?? ''] : a), []);

const TAG = flag('tag', 'shimmer');
const T = +flag('t', 0.4);
const YAW = +flag('yaw', 0);
const PITCH = +flag('pitch', -0.25);
const STEPS = +flag('steps', 33);
const HZ = +flag('hz', 240);
const W = +flag('w', 1600), H = +flag('h', 900);
const QUERIES = all('q').length ? all('q') : [''];
const SHOT = args.includes('--shot');
/* Supersampling factor, and it is the one measurement that separates the two
 * explanations of a saturated difference.
 *
 * A difference that is already at full amplitude after a five-millimetre step
 * has two possible causes and they call for opposite remedies. Either the
 * shading function is above the pixel's Nyquist limit, in which case the fix
 * is to prefilter the surface; or the surface is honestly detailed at about
 * the pixel scale and the image is simply moving more than a pixel per frame,
 * in which case there is nothing to filter and the remedy is temporal. Render
 * at 2x and box down to the same output grid: the first collapses, the second
 * does not. */
const SS = +flag('ss', 1);

/* The patch grid, in fractions of the viewport.
 *
 * Six across and three down over the lower half, which is carriageway and
 * footway at this framing, plus two on the frontage as the parallax control.
 * Each is 80 x 45 px at 1600 x 900 — big enough to average the noise down,
 * small enough not to straddle a shadow edge. */
const PATCHES = [];
for (let r = 0; r < 3; r++) {
  for (let c = 0; c < 6; c++) {
    PATCHES.push({
      name: `g${r}${c}`,
      x: 0.10 + c * 0.135, y: 0.56 + r * 0.13, w: 0.05, h: 0.05,
    });
  }
}
PATCHES.push({ name: 'facadeL', x: 0.05, y: 0.22, w: 0.06, h: 0.10 });
PATCHES.push({ name: 'facadeR', x: 0.86, y: 0.22, w: 0.06, h: 0.10 });

const LAGS = [1, 4, 16];
const outDir = path.join(ROOT, 'shots', TAG);
fs.mkdirSync(outDir, { recursive: true });

const runs = [];

for (const q of QUERIES) {
  const url = DEV_URL + (q ? `?${q}` : '');
  console.log(`\n══ ${q || 'stock'} ══  ${url}`);

  await run({ width: W * SS, height: H * SS, url }, async ({ page, errs, readShaderErrors }) => {
    await page.evaluate(([t, yaw, pitch]) => {
      const s = window.__scene;
      s.goTo(t); s.setYaw(yaw); s.setPitch(pitch); s.warp(2.0);
      s.setDriven(true);
    }, [T, YAW, PITCH]);
    await page.waitForTimeout(200);

    const data = await page.evaluate(async ([patches, steps, hz, ss]) => {
      const s = window.__scene;
      const gl = s.renderer.getContext();
      const cv = s.renderer.domElement;
      const rects = patches.map((p) => ({
        name: p.name,
        x: Math.round(p.x * cv.width), w: Math.round(p.w * cv.width),
        // readPixels is bottom-up; the patch table is stated top-down.
        y: Math.round((1 - p.y - p.h) * cv.height), h: Math.round(p.h * cv.height),
      }));

      /* Walk with the real input path rather than by moving the camera, so the
       * gait, the head bob and the collision response are all in the loop. */
      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true }));
      // A few steps before the first frame so the acceleration ramp is over
      // and every measured interval is at the same speed.
      for (let i = 0; i < 24; i++) s.step(1 / hz);

      const frames = [];
      const speeds = [];
      for (let f = 0; f < steps; f++) {
        s.step(1 / hz);
        speeds.push(s.walker.speed ?? 0);
        frames.push(rects.map((r) => {
          const buf = new Uint8Array(r.w * r.h * 4);
          gl.readPixels(r.x, r.y, r.w, r.h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          if (ss === 1) return buf;
          // Box down to the output grid, so the comparison is between two ways
          // of producing the same pixel rather than between two resolutions.
          const ow = Math.floor(r.w / ss), oh = Math.floor(r.h / ss);
          const out = new Uint8Array(ow * oh * 4);
          for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
            for (let c = 0; c < 3; c++) {
              let a = 0;
              for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) {
                a += buf[(((y * ss + j) * r.w) + (x * ss + i)) * 4 + c];
              }
              out[(y * ow + x) * 4 + c] = a / (ss * ss);
            }
          }
          return out;
        }));
      }
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true }));

      const lags = [1, 4, 16];
      const out = rects.map((r, ri) => {
        // Mean level, off the first frame, as luma.
        let lum = 0;
        const b0 = frames[0][ri];
        for (let i = 0; i < b0.length; i += 4) {
          lum += 0.2126 * b0[i] + 0.7152 * b0[i + 1] + 0.0722 * b0[i + 2];
        }
        lum /= b0.length / 4;
        const diff = lags.map((k) => {
          let acc = 0, n = 0;
          for (let f = 0; f + k < frames.length; f++) {
            const a = frames[f][ri], b = frames[f + k][ri];
            let d = 0;
            for (let i = 0; i < a.length; i += 4) {
              d += Math.abs(a[i] - b[i]) * 0.2126 + Math.abs(a[i + 1] - b[i + 1]) * 0.7152
                 + Math.abs(a[i + 2] - b[i + 2]) * 0.0722;
            }
            acc += d / (a.length / 4); n++;
          }
          return acc / n;
        });
        return { name: r.name, lum, diff };
      });
      const sp = speeds.reduce((a, b) => a + b, 0) / speeds.length;
      return { out, speed: sp };
    }, [PATCHES, STEPS, HZ, SS]);

    if (SHOT) await capture(page, path.join(outDir, `${q || 'stock'}.png`));
    const shaderErrors = await readShaderErrors();
    if (shaderErrors.length) {
      console.error(`  ✗ ${shaderErrors.length} shader error(s) in this build`);
      for (const e of shaderErrors) console.error('    ' + String(e.log ?? e).split('\n').slice(0, 3).join(' | '));
    }
    runs.push({ q: q || 'stock', ...data, errs: [...new Set(errs)].filter((e) => !e.includes('X3595')), shaderErrors });
  });
}

/* ── Report ───────────────────────────────────────────────────────────── */
const mm = (k) => ((1.4 / HZ) * k * 1000).toFixed(1);
console.log(`\n  ${STEPS} frames at 1/${HZ} s. Travel per lag: `
  + LAGS.map((k) => `${k}=${mm(k)} mm`).join('  '));

for (const r of runs) {
  console.log(`\n  ── ${r.q} ──   walking at ${r.speed.toFixed(2)} m/s`);
  console.log('  patch      level    ' + LAGS.map((k) => `${mm(k)}mm`.padStart(8)).join('') + '    growth');
  for (const p of r.out) {
    console.log(`  ${p.name.padEnd(9)}  ${p.lum.toFixed(1).padStart(5)}  `
      + p.diff.map((d) => d.toFixed(2).padStart(8)).join('')
      + `    ${(p.diff[2] / Math.max(p.diff[0], 1e-3)).toFixed(2)}x`);
  }
  /* The two aggregates the finding is stated in. Road patches are the grid;
   * dark and bright are split at the median level so the split is a property
   * of the frame rather than of the author. */
  const road = r.out.filter((p) => p.name.startsWith('g'));
  const lv = road.map((p) => p.lum).sort((a, b) => a - b);
  const mid = lv[lv.length >> 1];
  const agg = (sel) => {
    const s = road.filter(sel);
    return LAGS.map((_, i) => s.reduce((a, p) => a + p.diff[i], 0) / Math.max(s.length, 1));
  };
  const dark = agg((p) => p.lum < mid), bright = agg((p) => p.lum >= mid);
  const fac = LAGS.map((_, i) => r.out.filter((p) => p.name.startsWith('facade'))
    .reduce((a, p) => a + p.diff[i], 0) / 2);
  console.log(`  ${'shadowed'.padEnd(9)}  ${'<' + mid.toFixed(0)}   ` + dark.map((d) => d.toFixed(2).padStart(8)).join('') + `    ${(dark[2] / dark[0]).toFixed(2)}x`);
  console.log(`  ${'sunlit'.padEnd(9)}  ${'>' + mid.toFixed(0)}   ` + bright.map((d) => d.toFixed(2).padStart(8)).join('') + `    ${(bright[2] / bright[0]).toFixed(2)}x`);
  console.log(`  ${'facade'.padEnd(9)}  ctrl    ` + fac.map((d) => d.toFixed(2).padStart(8)).join('') + `    ${(fac[2] / fac[0]).toFixed(2)}x`);
}

fs.writeFileSync(path.join(outDir, 'shimmer.json'),
  JSON.stringify({ when: new Date().toISOString(), t: T, yaw: YAW, pitch: PITCH, steps: STEPS, hz: HZ, patches: PATCHES, runs }, null, 2));
console.log(`\n  wrote ${path.relative(ROOT, path.join(outDir, 'shimmer.json'))}\n`);
finish(0);
