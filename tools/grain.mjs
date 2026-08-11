/* Is the grain a sensor, or is it dirt on the glass?
 *
 * The walk harness parked the camera, stepped the simulation, and measured a
 * mean change of 0.00 across nine regions. That is the whole complaint in one
 * number: read noise is fixed to the sensor and redrawn every exposure, and a
 * pattern fixed to the sensor and never redrawn is a smear on the lens.
 *
 * So the test is the same test, and it has to distinguish three things rather
 * than two, because "the frame changed" is not enough:
 *
 *   frozen world, camera parked   -> should change, by about the grain
 *   the same, with ?nograin       -> should not change at all
 *   the standard deviation of the difference, against the amplitude
 *
 * The last one is the point of §5.6's warning: the reference project measured
 * their grain at amplitude 1.15 as sigma 0.83 against 0.80 for no grain at
 * all, which is to say it was quantised away before it reached the file. A
 * grain that cannot be measured is not present, however carefully it was
 * written.
 *
 *   node tools/withlock.mjs grain -- node tools/grain.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, finish, DEV_URL } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const T = +flag('t', 0.4);
const PITCH = +flag('pitch', -0.25);

const REGIONS = [
  ['sky', 0.50, 0.08], ['facade shade', 0.19, 0.30], ['facade sun', 0.84, 0.30],
  ['road sun', 0.56, 0.66], ['road shade', 0.31, 0.78], ['footway', 0.90, 0.62],
];

for (const q of ['grain', 'nograin']) {
  await run({ width: 1600, height: 900, url: DEV_URL + (q === 'nograin' ? '?nograin' : '') },
    async ({ page }) => {
      const out = await page.evaluate(async ([t, pitch, regions]) => {
        const s = window.__scene;
        const gl = s.renderer.getContext();
        const cv = s.renderer.domElement;
        s.goTo(t); s.setPitch(pitch); s.warp(2.0); s.setDriven(true);

        // Frozen world: step by zero, so nothing in the scene advances and the
        // only thing that can differ between two frames is the pass itself.
        const grab = () => {
          s.step(0);
          const b = new Uint8Array(cv.width * cv.height * 4);
          gl.readPixels(0, 0, cv.width, cv.height, gl.RGBA, gl.UNSIGNED_BYTE, b);
          return b;
        };
        const a = grab(), b = grab(), c = grab();

        return regions.map(([name, fx, fy]) => {
          const x0 = Math.round(fx * cv.width) - 40, y0 = Math.round((1 - fy) * cv.height) - 22;
          let mean = 0, sq = 0, n = 0, lvl = 0, same = 0;
          for (let y = y0; y < y0 + 45; y++) for (let x = x0; x < x0 + 80; x++) {
            const i = (y * cv.width + x) * 4;
            for (let k = 0; k < 3; k++) {
              const d = b[i + k] - a[i + k];
              mean += Math.abs(d); sq += d * d; lvl += a[i + k]; n++;
              if (b[i + k] === c[i + k]) same++;
            }
          }
          return { name, level: lvl / n, mean: mean / n, sigma: Math.sqrt(sq / n), rep: same / n };
        });
      }, [T, PITCH, REGIONS]);

      console.log(`\n  ── ${q} ──`);
      console.log('  region          level   mean|d|   sigma   frame2==frame3');
      for (const r of out) {
        console.log(`  ${r.name.padEnd(14)} ${r.level.toFixed(1).padStart(6)}  ${r.mean.toFixed(3).padStart(7)}  ${r.sigma.toFixed(3).padStart(6)}   ${(r.rep * 100).toFixed(0)}%`);
      }
    });
}
console.log('');
finish(0);
