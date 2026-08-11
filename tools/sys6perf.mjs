/* What System 6 costs, measured the only way this project trusts.
 *
 * §7 of the technique brief: glFinish in a page does not wait. Chromium runs
 * WebGL over a command buffer into another process and finish() returns once
 * the queue has been handed over, not once the work is done — which is how the
 * reference project measured a whole post-processing chain at forty
 * microseconds and an `ultra` tier rendering faster than `medium`. The fix is
 * to synchronise on a one-pixel readPixels, which cannot return before the
 * frame exists.
 *
 * The debug API's `fps` is also not usable for this. It is an exponential
 * moving average sampled straight after a teleport, so it is still carrying the
 * shader compile that the teleport triggered: the same build reports 20 fps at
 * the first stop after a page load and 328 at the fourth. Those are compile
 * times and Playwright scheduling, not render cost.
 *
 * So: one page, one camera, one warm-up, and then differenced medians with a
 * single term switched between them and no reload in between — because a
 * reload rebakes every texture and recompiles every program, and two numbers
 * from two page loads differ by more than the thing being measured.
 *
 *   node tools/sys6perf.mjs
 */
import { run, finish } from './harness.mjs';

const YAW_SUN = -0.6104;

await run({ width: 1600, height: 900 }, async ({ page }) => {
  const out = await page.evaluate(async ({ yaw }) => {
    const s = window.__scene;
    const gl = s.renderer, ctx = gl.getContext();
    s.camera.fov = 45; s.camera.updateProjectionMatrix();
    // The sunward stop: maximum fog factor, maximum phase, the wedge in frame
    // and the mote band across the middle. If anything is expensive, here.
    s.goTo(0.3265); s.setYaw(yaw); s.setPitch(-0.10); s.warp(2.0);
    s.setPaused(true);

    let pts = null;
    s.scene.traverse((o) => { if (o.isPoints) pts = o; });
    const fog = s.scene.fog;
    const px = new Uint8Array(4);

    const frame = () => {
      gl.render(s.scene, s.camera);
      // Cannot return before the frame exists. This is the whole point.
      ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
    };
    const measure = async (warm, n) => {
      for (let i = 0; i < warm; i++) frame();
      const t = [];
      for (let i = 0; i < n; i++) {
        const a = performance.now();
        frame();
        t.push(performance.now() - a);
      }
      t.sort((x, y) => x - y);
      return {
        median: +t[t.length >> 1].toFixed(3),
        p10: +t[Math.floor(t.length * 0.1)].toFixed(3),
        p90: +t[Math.floor(t.length * 0.9)].toFixed(3),
      };
    };

    const res = {};
    // A shader-define change forces a recompile, so anything that touches
    // scene.fog gets a long warm-up; toggling an object's visibility does not.
    res.full = await measure(90, 200);
    if (pts) { pts.visible = false; res.noDust = await measure(30, 200); pts.visible = true; }
    res.fullAgain = await measure(30, 200);
    s.scene.fog = null;
    res.noFog = await measure(200, 200);
    s.scene.fog = fog;
    res.fogBack = await measure(200, 200);

    s.setPaused(false);
    return { res, calls: gl.info.render.calls, tris: gl.info.render.triangles };
  }, { yaw: YAW_SUN });

  const r = out.res;
  console.log('\n===== SYSTEM 6 COST, sunward stop, 1600x900 =====');
  console.log(`  draw calls ${out.calls}   triangles ${(out.tris / 1000).toFixed(0)}k\n`);
  const row = (k) => console.log(`  ${k.padEnd(10)} median ${String(r[k].median).padStart(7)} ms` +
    `   p10 ${String(r[k].p10).padStart(7)}   p90 ${String(r[k].p90).padStart(7)}`);
  for (const k of Object.keys(r)) row(k);
  console.log('');
  const d = (a, b) => +(r[a].median - r[b].median).toFixed(3);
  console.log(`  dust       ${d('full', 'noDust') >= 0 ? '+' : ''}${d('full', 'noDust')} ms   (full - noDust)`);
  console.log(`  haze       ${d('fogBack', 'noFog') >= 0 ? '+' : ''}${d('fogBack', 'noFog')} ms   (fog on - fog off)`);
  console.log(`  repeat     ${d('fullAgain', 'full')} ms drift between two identical measurements`);
  console.log('  The repeat line is the noise floor: any difference smaller than it is not a result.\n');
});

finish(process.exitCode || 0);
