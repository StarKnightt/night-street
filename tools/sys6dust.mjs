/* Why is the mote field contributing nothing?
 *
 * sys6live.mjs reports both ?haze=nodust and ?haze=noshadow as a 0.0 change in
 * every region at every stop, including p99.9 and max over a region the field
 * fills. A sparse additive layer that cannot move the top 0.1% of that region
 * is not dim, it is absent.
 *
 * The first cause was found and fixed: the box was wrapped around a uniform
 * written in useFrame, and every capture teleports and draws inside one
 * synchronous evaluate, so the field sat 32 m behind the camera. That did not
 * fix it, so there is a second one, and guessing has already cost a round.
 *
 * This escalates rather than inspects. It renders the same frozen frame with
 * the mote level and the mote size driven to values that could not possibly be
 * subtle, and counts how many pixels change. That separates the two remaining
 * possibilities with one number:
 *
 *   pixels change  -> the draw reaches the framebuffer and this is a level or
 *                     a size problem, and the sweep below says which.
 *   nothing changes -> the draw is not reaching the framebuffer at all, and
 *                     the uniforms are irrelevant.
 */
import { run, finish } from './harness.mjs';

const YAW_SUN = -0.6104;

await run({ width: 1600, height: 900 }, async ({ page }) => {
  const out = await page.evaluate(({ yaw }) => {
    const s = window.__scene;
    s.camera.fov = 45; s.camera.updateProjectionMatrix();
    s.goTo(0.3265); s.setYaw(yaw); s.setPitch(-0.10); s.warp(2.0);
    s.setPaused(true);

    let pts = null;
    s.scene.traverse((o) => { if (o.isPoints) pts = o; });
    if (!pts) return { found: false };
    const u = pts.material.uniforms;

    const ctx = s.renderer.getContext();
    const w = s.renderer.domElement.width, h = s.renderer.domElement.height;
    const grab = () => {
      s.renderer.render(s.scene, s.camera);
      const px = new Uint8Array(w * h * 4);
      ctx.readPixels(0, 0, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
      return px;
    };
    const diff = (a, b) => {
      let n = 0, sum = 0, mx = 0;
      for (let i = 0; i < a.length; i += 4) {
        const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
        if (d > 2) n++;
        sum += d;
        if (d > mx) mx = d;
      }
      return { changed: n, meanAbs: +(sum / (a.length / 4)).toFixed(3), maxAbs: mx };
    };

    const peak0 = u.uPeak.value, pix0 = u.uPixel.value;

    u.uPeak.value = 0;
    const base = grab();

    const results = {};
    // Level sweep at the shipped size, then a size sweep at a level that
    // cannot be missed. If the size sweep is the one that moves, gl_PointSize
    // is being dropped below the rasteriser's threshold.
    for (const p of [0.165, 1.0, 5.0]) {
      u.uPeak.value = p; u.uPixel.value = pix0;
      results[`peak=${p} size=${pix0}`] = diff(grab(), base);
    }
    for (const sz of [20, 60, 200]) {
      u.uPeak.value = 1.0; u.uPixel.value = sz;
      results[`peak=1.0 size=${sz}`] = diff(grab(), base);
    }

    // What sizes is the vertex shader actually asking for?
    const g = pts.geometry, seed = g.getAttribute('aSeed').array;
    const cam = s.camera.position;
    const pos = g.getAttribute('position').array;
    const sizes = [];
    for (let i = 0; i < seed.length / 3; i++) {
      const dz = Math.max(Math.hypot(pos[i * 3] - cam.x, pos[i * 3 + 1] - cam.y, pos[i * 3 + 2] - cam.z), 0.6);
      const szf = seed[i * 3 + 2] * seed[i * 3 + 2];
      sizes.push(Math.min(3.4, Math.max(0.8, pix0 * (0.75 + 1.9 * szf) / dz)));
    }
    sizes.sort((a, b) => a - b);
    const q = (p) => +sizes[Math.floor(p * sizes.length)].toFixed(2);

    u.uPeak.value = peak0; u.uPixel.value = pix0;
    s.setPaused(false);

    return {
      found: true,
      visible: pts.visible, inScene: !!pts.parent,
      frustumCulled: pts.frustumCulled, renderOrder: pts.renderOrder,
      drawRange: g.drawRange, count: g.getAttribute('position').count,
      depthTest: pts.material.depthTest, depthWrite: pts.material.depthWrite,
      transparent: pts.material.transparent, blending: pts.material.blending,
      uPeak: peak0, uPixel: pix0,
      uShadowOn: u.uShadowOn.value, uRevDepth: u.uRevDepth.value,
      hasMap: !!u.uShadowMap.value,
      pointsDrawn: s.renderer.info.render.points,
      requestedPointSize: { p05: q(0.05), p50: q(0.5), p95: q(0.95), p99: q(0.99) },
      results,
    };
  }, { yaw: YAW_SUN });

  console.log('\n===== DUST DIAGNOSTIC =====');
  console.log(JSON.stringify(out, null, 2));
  console.log('===========================\n');
});

finish(process.exitCode || 0);
