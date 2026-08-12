/* What a frame costs, and what the veil costs inside it.
 *
 *   node tools/withlock.mjs framecost -- node tools/framecost.mjs
 *
 * Timed on `renderOnce`, which is the scene pass plus the whole post chain,
 * and synchronised on a one-pixel readback: glFinish in a page does not wait,
 * and this project has already measured a whole post chain at forty
 * microseconds by trusting it (tools/carperf.mjs, §7).
 *
 * The veil is switched at the uniform between two timings of the same station,
 * so the difference is three extra pyramid octaves and not a different scene.
 */
import { run, finish } from './harness.mjs';

const STOPS = [
  { name: 'lot, sun in frame', t: 0.78, yaw: 0, pitch: 0.09 },
  { name: 'gap, disc clear', t: 0.40, yaw: 0, pitch: 0 },
  { name: 'near, walled', t: 0.20, yaw: 0, pitch: 0 },
];

await run({ width: 1600, height: 900 }, async ({ page }) => {
  const out = await page.evaluate(async (stops) => {
    const s = window.__scene;
    const ctx = s.renderer.getContext();
    const px = new Uint8Array(4);
    const sync = () => ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, px);

    const time = (n) => {
      s.renderOnce(); sync();                    // warm
      const t0 = performance.now();
      for (let i = 0; i < n; i++) { s.renderOnce(); sync(); }
      return (performance.now() - t0) / n;
    };

    const rows = [];
    for (const st of stops) {
      s.setPaused(true);
      s.goTo(st.t); s.setYaw(st.yaw); s.setPitch(st.pitch); s.warp(2.0);
      s.walker.phase = 0; s.walker.speed = 0;
      s.walker.update(1 / 240, { forward: 0, strafe: 0, sprint: false });

      window.__grade.uniforms.uBloom.value = 0.045;
      const withVeil = time(40);
      window.__grade.uniforms.uBloom.value = 0;
      const noVeil = time(40);
      window.__grade.uniforms.uBloom.value = 0.045;
      s.setPaused(false);
      rows.push({ ...st, withVeil, noVeil, info: s.info() });
    }
    return rows;
  }, STOPS);

  console.log('\n   station                        ms/frame   veil off   veil costs');
  for (const r of out) {
    console.log(`   ${r.name.padEnd(28)} ${r.withVeil.toFixed(2).padStart(8)} `
      + `${r.noVeil.toFixed(2).padStart(10)} ${(r.withVeil - r.noVeil).toFixed(2).padStart(11)} ms`
      + `   (${(1000 / r.withVeil).toFixed(0)} fps equivalent)`);
  }

  const perf = await page.evaluate(async () => {
    const s = window.__scene;
    s.setPaused(false);
    await new Promise((r) => setTimeout(r, 2500));
    return { fps: +s.fps.toFixed(1), ...s.info() };
  });
  console.log(`\n   free-running: ${perf.fps} fps (vsync-capped), `
    + `calls=${perf.calls} tris=${(perf.triangles / 1000).toFixed(0)}k`);
});

finish(process.exitCode || 0);
