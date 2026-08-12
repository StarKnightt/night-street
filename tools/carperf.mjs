/* What the cars cost, per frame, with a control.
 *
 *   node tools/carperf.mjs
 *
 * Two stops: one three-quarter view with most of the row in frame, and one
 * raking flank at a metre and a half where a single car fills a third of the
 * screen and its clearcoat lobe is at its widest. At each, the frame is timed
 * with the cars present and again with the four car meshes hidden, which is the
 * control — a car cost quoted without one is a measurement of this machine's
 * mood rather than of the cars.
 *
 * §7 of the technique brief applies here and is the reason for the readPixels:
 * glFinish in a page does not wait, and this project has already measured a
 * whole post chain at forty microseconds by trusting it. Every number below is
 * synchronised on a one-pixel read, which cannot return before the frame exists.
 */
import { run, finish } from './harness.mjs';

const STOPS = [
  { name: 'three-quarter, five cars in frame', t: 0.545, yaw: 2.5721, pitch: -0.1182 },
  { name: 'raking flank at 1.5 m', t: 0.610, yaw: 0.4499, pitch: -0.1701 },
  { name: 'down-street into the sun', t: 0.760, yaw: -0.0153, pitch: -0.0043 },
];

await run({ width: 1600, height: 900 }, async ({ page }) => {
  const out = await page.evaluate(async (stops) => {
    const s = window.__scene;
    const gl = s.renderer, ctx = gl.getContext();
    const px = new Uint8Array(4);
    /* `renderOnce` and not `gl.render`, which is the difference between the
     * frame the user waits for and a fraction of it. The scene is drawn to a
     * half-float target and then put through the whole post chain — bloom,
     * defocus, grade, grain — and on this project that chain is the majority of
     * the frame. A car cost quoted against a bare scene render is quoted
     * against a denominator that does not exist. */
    /* The car meshes, found by walking the graph rather than by name, because a
     * name is a thing that gets renamed. Anything whose geometry carries an
     * `aCar`, `aGl` or `aWhl` attribute is part of this system and nothing else
     * in the scene has one. */
    const cars = [];
    s.scene.traverse((o) => {
      const a = o.geometry?.attributes;
      if (a && (a.aCar || a.aGl || a.aWhl || a.aShd)) cars.push(o);
    });
    /* And their siblings, because the contact shade quad carries none of those
     * attributes and would otherwise stay drawn through the control — a control
     * that leaves one of the four meshes in is not a control. */
    for (const c of [...cars]) {
      for (const sib of c.parent?.children ?? []) {
        if (sib.isMesh && !cars.includes(sib)) cars.push(sib);
      }
    }

    /* Re-asserted every frame, because something else in the app owns this flag.
     * Setting `visible = false` once and then timing looked like it worked and
     * did not: the yields inside the timing loop let the page's own animation
     * frame run, and it puts the cars back. The tell was a control that
     * reported the cars as costing minus ten milliseconds and minus twenty-four
     * triangles at two of the three stops. */
    let hide = false;
    const frame = () => {
      if (hide) for (const c of cars) c.visible = false;
      s.renderOnce();
      ctx.readPixels(0, 0, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
    };
    /* The yield every eight frames is not politeness, it is the difference
     * between a measurement and a crashed renderer. Ninety synchronous
     * render-plus-readPixels pairs in one evaluate hold the compositor thread
     * for long enough that Chromium's GPU watchdog kills the tab, and what
     * comes back is "Target crashed" with no numbers in it. Yielding lets the
     * watchdog see a responsive process without letting anything else draw. */
    const time = async (warm, n) => {
      for (let i = 0; i < warm; i++) frame();
      const t = [];
      for (let i = 0; i < n; i++) {
        const a = performance.now();
        frame();
        t.push(performance.now() - a);
        if ((i & 7) === 7) await new Promise((r) => setTimeout(r, 0));
      }
      t.sort((x, y) => x - y);
      return { median: +t[t.length >> 1].toFixed(3), p90: +t[Math.floor(n * 0.9)].toFixed(3) };
    };

    const rows = [];
    let tri = 0, calls = 0;
    for (const st of stops) {
      s.goTo(st.t); s.setYaw(st.yaw); s.setPitch(st.pitch);
      s.setPaused(true);
      /* Read straight after a frame and before any await. The first version of
       * this read `gl.info` after the timing loop, which contains yields, so
       * the app's own animation loop got a frame in first and the numbers
       * returned were that frame's rather than this one's — reported as the
       * cars *removing* 814k triangles, which is a good example of a plausible
       * number with nothing behind it. */
      frame();
      const info = { tri: gl.info.render.triangles, calls: gl.info.render.calls };
      const on = await time(12, 48);
      hide = true;
      frame();
      const offInfo = { tri: gl.info.render.triangles, calls: gl.info.render.calls };
      const off = await time(12, 48);
      hide = false;
      for (const c of cars) c.visible = true;
      rows.push({ name: st.name, on, off, info, offInfo });
      tri = info.tri; calls = info.calls;
    }
    return { rows, meshes: cars.length, tri, calls };
  }, STOPS);

  console.log(`\n  car meshes in the graph: ${out.meshes}\n`);
  for (const r of out.rows) {
    const d = r.on.median - r.off.median;
    console.log(`  ${r.name}`);
    console.log(`    with cars     ${r.on.median.toFixed(2)} ms  (p90 ${r.on.p90.toFixed(2)})`
      + `   ${r.info.tri.toLocaleString()} tri  ${r.info.calls} draw calls`);
    console.log(`    hidden        ${r.off.median.toFixed(2)} ms  (p90 ${r.off.p90.toFixed(2)})`
      + `   ${r.offInfo.tri.toLocaleString()} tri  ${r.offInfo.calls} draw calls`);
    console.log(`    the cars      ${d >= 0 ? '+' : ''}${d.toFixed(2)} ms`
      + `   ${(r.info.tri - r.offInfo.tri).toLocaleString()} tri`
      + `   ${r.info.calls - r.offInfo.calls} draw calls`
      + `   ${(1000 / r.on.median).toFixed(0)} fps\n`);
  }
});

await finish();
