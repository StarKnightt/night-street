/* The same frame, twice, with only the sky swapped.
 *
 * `tools/shoot.mjs` always loads the dev server's default URL, and the whole
 * point of `?sky=` in env.ts is that the before and the after differ by one
 * query parameter and nothing else. Rather than teach shoot.mjs about query
 * strings — it belongs to everyone this week — this is the two-frame version
 * of it: one page load per mode, identical camera, identical exposure, so the
 * pair can be flipped between and the only thing that moves is the sky.
 *
 *   node tools/skyab.mjs [--modes flat,clouds] [--t 0.4] [--pitch 0.25]
 *                        [--yaw 0] [--out shots/skyab]
 *
 * Frames land in <out>/<mode>.png. Shader errors are checked per mode and are
 * a hard failure, because a sky that fails to compile still produces a picture.
 */
import fs from 'node:fs';
import { run, capture, finish } from './harness.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

const MODES = flag('modes', 'flat,clouds').split(',');
const T = +flag('t', 0.4);
const PITCH = +flag('pitch', 0.25);
const YAW = +flag('yaw', 0);
const OUT = flag('out', 'shots/skyab');
const BASE = process.env.STREET_URL || 'http://127.0.0.1:3000';

fs.mkdirSync(OUT, { recursive: true });
let bad = 0;

for (const mode of MODES) {
  await run({ width: 1600, height: 900, url: `${BASE}/?sky=${mode}` },
    async ({ page, errs, readShaderErrors }) => {
      const info = await page.evaluate(({ T, PITCH, YAW }) => {
        const s = window.__scene;
        s.goTo(T); s.setYaw(YAW); s.setPitch(PITCH); s.warp(1.5);
        return {
          isCube: !!s.scene.background?.isCubeTexture,
          bakeMs: window.__skyBakeMs ?? null,
          fps: +s.fps.toFixed(1),
        };
      }, { T, PITCH, YAW });

      await capture(page, `${OUT}/${mode}.png`);
      const shaderErrors = await readShaderErrors();
      if (shaderErrors.length) bad++;
      const hard = [...new Set(errs)].filter((e) => /pageerror|ERROR:/.test(e));
      if (hard.length) bad++;
      console.log(`  ${mode.padEnd(9)} cube=${info.isCube} ` +
        `bake=${info.bakeMs === null ? 'n/a' : info.bakeMs.toFixed(1) + 'ms'} ` +
        `fps=${info.fps} shaderErrors=${shaderErrors.length} hardErrors=${hard.length}` +
        `  → ${OUT}/${mode}.png`);
    });
}

finish(bad);
