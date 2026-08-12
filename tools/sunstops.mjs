/* Several stops down the street, one page load, for the elevation A/B.
 *
 * The sun's elevation is a compile-time constant, so a before and an after are
 * two builds and cannot be captured in one browser. What can be held constant
 * is everything else: the same route positions, the same yaws, the same
 * exposure, the same warp, in the same order, from a single load per build.
 * skyab.mjs takes one stop and shoot.mjs owns its own route table this week, so
 * this is the elevation-specific walk.
 *
 *   node tools/sunstops.mjs --tag before --out shots/sun
 *
 * Frames land in <out>/<tag>-<stop>.png. It also reports the mean and the
 * blue/red of a strip across the sun-facing frontage in each frame, because the
 * point of raising the sun was that frontage and a picture on its own does not
 * say by how much.
 */
import fs from 'node:fs';
import { run, capture, finish } from './harness.mjs';
import { readPNG, meanRect, WALLS } from './pxfile.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

const TAG = flag('tag', 'x');
const OUT = flag('out', 'shots/sun');
const BASE = process.env.STREET_URL || 'http://127.0.0.1:3000';

/* Chosen to cover the three things the elevation change is supposed to move:
 * the frontage that was banded, the shadows on the road, and the sky. */
const STOPS = [
  { name: 'down',  t: 0.10, yaw: 0.00, pitch: 0.02 },   // down the street, shadows
  { name: 'front', t: 0.34, yaw: 0.62, pitch: 0.06 },   // at the sun-facing frontage
  { name: 'mid',   t: 0.40, yaw: 0.00, pitch: 0.02 },   // the hero stop
  { name: 'sky',   t: 0.40, yaw: 0.00, pitch: 0.30 },   // sky half the frame
  { name: 'far',   t: 0.72, yaw: 0.00, pitch: 0.05 },   // deep, into the glow
];

fs.mkdirSync(OUT, { recursive: true });
let bad = 0;
const rows = [];

await run({ width: 1600, height: 900, url: `${BASE}/?sky=clouds` },
  async ({ page, errs, readShaderErrors }) => {
    await page.waitForFunction(() => !!window.__scene, null, { timeout: 90_000 });

    for (const s of STOPS) {
      const info = await page.evaluate((S) => {
        const sc = window.__scene;
        sc.goTo(S.t); sc.setYaw(S.yaw); sc.setPitch(S.pitch); sc.warp(1.5);
        return { fps: +sc.fps.toFixed(1), bakeMs: window.__skyBakeMs ?? null };
      }, s);

      const file = `${OUT}/${TAG}-${s.name}.png`;
      await capture(page, file);

      /* Measured off the PNG rather than off the live canvas. The canvas is not
       * preserveDrawingBuffer, so drawImage after a presented frame reads black,
       * and re-rendering by hand to work around that bypasses the grade — which
       * is exactly the part of the pipeline the sun's colour has to survive.
       * The rectangles are px.mjs's, so these are comparable with every other
       * wall measurement in the project. */
      const img = readPNG(file);
      const cells = {};
      for (const [k, rect] of Object.entries(WALLS)) {
        const [r, g, b] = meanRect(img, rect);
        cells[k] = { rgb: [r, g, b].map((q) => +(q * 255).toFixed(1)), br: +(b / Math.max(1e-6, r)).toFixed(3) };
      }
      rows.push({ stop: s.name, ...info, cells });
      const show = (k) => `${k} ${String(cells[k].rgb[0]).padStart(5)} b/r ${cells[k].br.toFixed(2)}`;
      console.log(`  ${s.name.padEnd(6)} ${show('sunMidL')}  ${show('shadeMidR')}` +
        `  ${show('roadShade')}  fps ${info.fps}`);
    }

    const shaderErrors = await readShaderErrors();
    if (shaderErrors.length) { bad++; console.log('  SHADER ERRORS', shaderErrors.length); }
    const hard = [...new Set(errs)].filter((e) => /pageerror|ERROR:/.test(e));
    if (hard.length) { bad++; console.log('  HARD ERRORS', hard.join('\n')); }
    console.log(`  bake ${rows[0].bakeMs === null ? 'n/a' : rows[0].bakeMs.toFixed(1) + 'ms'}`);
  });

fs.writeFileSync(`${OUT}/${TAG}.json`, JSON.stringify(rows, null, 2));
finish(bad);
