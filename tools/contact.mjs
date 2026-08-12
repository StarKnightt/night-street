/* Two questions the geometry cannot answer on its own.
 *
 *   node tools/contact.mjs [name]
 *
 * ONE — ground contact. tools/stance.mjs computes what share of the sky the
 * underbody takes away, which is what the decal should be; this measures what
 * the road actually renders at, in a line running in from open tarmac to the
 * sill, so the two can be compared. A form factor is a prediction and a probe
 * is a measurement, and this project's whole history is about not confusing
 * them.
 *
 * TWO — the rear quarter reads blue while the flank reads cream-gold, and the
 * question is whether that is the two lights it is built to be or something
 * over-weighting the sky. So the transition is walked across in world space with
 * the surface normal reported at every step: a hue that turns as the normal
 * turns is a car under two lights, and a hue that steps while the normal does
 * not is a bug. The numbers reported are the red-to-blue ratio, which is what
 * the eye is reading as "warm" or "cool", and the world normal that produced it.
 *
 * Radiance is read out of the HDR target before the tone curve, and every probe
 * reports the world position, the depth and the material it actually hit — the
 * probe that was supposed to be on a stallriser and turned out to be on a car
 * window 12 m short is the reason that is not optional.
 */
import { readFileSync } from 'node:fs';
import { run, capture, finish } from './harness.mjs';

const name = process.argv[2] ?? 'contact';

const SRC = readFileSync(new URL('../src/scene/sun.ts', import.meta.url), 'utf8');
const num = (k) => {
  const m = SRC.match(new RegExp(`${k}\\s*=\\s*(-?[0-9.]+)`));
  if (!m) throw new Error(`sun.ts has no ${k}`);
  return +m[1];
};
const SUN_ELEV = num('SUN_ELEV'), SUN_AZIM = num('SUN_AZIM');

/* The hero estate, the car the reviews keep pointing at, at z = -42.60 on the
 * near kerb. Both stops look at the same car so the two answers are about one
 * object rather than about two.
 */
const STOPS = [
  {
    name: 'contact',
    note: 'across the hero estate at 3 m, low, so the road runs in under the sill',
    eye: [1.20, -42.20], look: [-0.95, 0.00, -42.35],
    /* A line on the road running inboard from open tarmac to the sill. The car
     * is at x = -1.02 with a half width of 0.895, so its sill is at x = -0.125
     * and its centreline is 1.02 m further in. Sampled in world x at a fixed z
     * between the axles, which is where the underbody plateau is widest. */
    /* The hero estate is at x = -1.875 with a half width of 0.895, so its sill
     * is at -0.980 and its centreline is a further 0.895 in. The first version
     * of this ran from +1.30 to -0.05 on the assumption that the car was at
     * -1.02, which put every sample between 0.9 and 1.8 m *outside* the sill and
     * outside the decal's footprint entirely — and the control duly reported the
     * decal as doing nothing, to four decimal places, at all nine of them. That
     * is the control earning its place: without it the reading would have gone
     * into the report as evidence that the contact term was inert. */
    road: { z: -42.35, from: 0.30, to: -0.96, step: 0.09, y: -0.015 },
  },
  {
    name: 'quarter',
    note: 'three-quarter rear on the hero: the flank, the corner radius and the rear quarter in one frame',
    eye: [0.95, -38.90], look: [-1.26, 1.05, -40.62],
    /* Round the rear corner in *plan*, which is what the first version of this
     * got wrong: it swept an arc in a vertical plane and so ran up and down the
     * flank instead of round the corner, and reported sixteen samples whose
     * normals all pointed the same way. The corner of the hero estate is at
     * x = -0.125, z = -40.29; the circle is inset from it so that every sample
     * lands on the body, and it runs from well forward on the flank round to
     * square across the tail. */
    /* 1.08 m, not 0.92. At 0.92 the arc crossed the tail straight through the
     * lamp cluster — lampY runs 0.76 to 1.02 — and reported the rear of the car
     * as a dark magenta, which is a lens, not paint. The question is about
     * paint, so the arc is lifted to the tailgate above the cluster and the
     * beltline on the flank, which is the same panel either side of the corner. */
    arc: { cx: -1.26, cz: -40.62, r: 0.34, y: 1.08, from: -50, to: 130, step: 9 },
  },
];

const PAGE = (stops, elev, azim) => `
(async () => {
  const s = window.__scene;
  const THREE = window.__THREE;
  const gl = s.renderer;
  const stops = ${JSON.stringify(stops)};
  const out = [];

  const rt = new THREE.WebGLRenderTarget(gl.domElement.width, gl.domElement.height, {
    type: THREE.HalfFloatType, colorSpace: THREE.NoColorSpace,
    depthBuffer: true, samples: 0,
  });
  const half = new Uint16Array(4);
  const h2f = (h) => {
    const e = (h >> 10) & 0x1f, f = h & 0x3ff, sg = (h >> 15) ? -1 : 1;
    if (e === 0) return sg * f * Math.pow(2, -24);
    if (e === 31) return f ? NaN : sg * Infinity;
    return sg * (1 + f / 1024) * Math.pow(2, e - 15);
  };

  /* The contact decal, found by its attribute rather than by name. Measuring a
   * road profile beside a car without a control measures the tarmac's own
   * cracks, patches and lane markings as well as the occlusion, and the first
   * run of this tool produced a profile that fell to 27 per cent with a 7 per
   * cent bump in the middle of it — which is a road surface, not a form factor.
   */
  let shade = null;
  s.scene.traverse((o) => { if (o.geometry?.attributes?.aShade) shade = o; });

  const ray = new THREE.Raycaster();
  ray.far = 400;
  const nv = new THREE.Vector3();

  for (const st of stops) {
    /* Place the camera the way the page does. renderOnce syncs the per-frame
     * uniforms — the defocus circle of confusion is derived from the eye height
     * and is stale otherwise, which is the liveness failure the harness now
     * asserts on. */
    const w = s.walker;
    w.placeAt(0.5);
    w.x = st.eye[0]; w.z = st.eye[1];
    w.snapGround();
    w.advanceGait(0);
    const eye = new THREE.Vector3(w.eye.x, w.eye.y, w.eye.z);
    const f = new THREE.Vector3(st.look[0], st.look[1], st.look[2]).sub(eye).normalize();
    w.pitch = Math.asin(Math.max(-1, Math.min(1, f.y)));
    w.yaw = Math.atan2(-f.x, -f.z);
    s.setYaw(w.yaw); s.setPitch(w.pitch);
    s.setPaused(true);
    s.renderOnce();
    st.eyeWorld = [eye.x, eye.y, eye.z];

    // The scene into a private half-float target: linear radiance, no post.
    const prev = gl.getRenderTarget();
    gl.setRenderTarget(rt);
    gl.render(s.scene, s.camera);
    gl.setRenderTarget(prev);
    s.renderOnce();

    const W = rt.width, H = rt.height;
    const proj = (p) => {
      const v = new THREE.Vector3(p[0], p[1], p[2]).project(s.camera);
      return [Math.round((v.x * 0.5 + 0.5) * W), Math.round((0.5 - v.y * 0.5) * H)];
    };
    const readAt = (px, py) => {
      if (px < 1 || py < 1 || px >= W - 1 || py >= H - 1) return null;
      const rgb = [0, 0, 0];
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        gl.readRenderTargetPixels(rt, px + dx, H - 1 - (py + dy), 1, 1, half);
        rgb[0] += h2f(half[0]); rgb[1] += h2f(half[1]); rgb[2] += h2f(half[2]);
        n++;
      }
      return rgb.map((v) => v / n);
    };
    /* What is at that pixel, from the scene rather than from the intent: the
     * camera ray is cast and the first hit reported with its distance, its
     * material and its own surface normal. */
    const hitAt = (px, py) => {
      const ndc = new THREE.Vector2((px / W) * 2 - 1, 1 - (py / H) * 2);
      ray.setFromCamera(ndc, s.camera);
      const hs = ray.intersectObjects(s.scene.children, true)
        .filter((h) => h.object.visible && h.object.type === 'Mesh');
      if (!hs.length) return null;
      const h = hs[0];
      let nrm = [0, 0, 0];
      if (h.face) {
        nv.copy(h.face.normal).transformDirection(h.object.matrixWorld);
        nrm = [nv.x, nv.y, nv.z];
      }
      return {
        d: h.distance, mat: h.object.material?.name || h.object.name || '?',
        p: [h.point.x, h.point.y, h.point.z], n: nrm,
      };
    };

    const pts = [];
    if (st.road) {
      for (let x = st.road.from; x >= st.road.to - 1e-6; x -= st.road.step) {
        pts.push({ tag: x.toFixed(2), at: [x, st.road.y, st.road.z] });
      }
    }
    if (st.arc) {
      for (let a = st.arc.from; a <= st.arc.to + 1e-6; a += st.arc.step) {
        const r = (a * Math.PI) / 180;
        pts.push({
          tag: a.toFixed(0) + 'deg',
          at: [st.arc.cx + Math.cos(r) * st.arc.r, st.arc.y,
            st.arc.cz + Math.sin(r) * st.arc.r],
        });
      }
    }
    const shot = () => {
      const prev2 = gl.getRenderTarget();
      gl.setRenderTarget(rt);
      gl.render(s.scene, s.camera);
      gl.setRenderTarget(prev2);
      const o = [];
      for (const q of pts) {
        const [px, py] = proj(q.at);
        o.push({ tag: q.tag, aim: q.at, px: [px, py], L: readAt(px, py), hit: hitAt(px, py) });
      }
      return o;
    };
    const rows = shot();
    /* And the same line again with the decal hidden. Its own visibility is
     * re-asserted rather than set once, because the page's animation loop owns
     * that flag and puts it back between calls. */
    let ctrl = null;
    if (st.road && shade) {
      shade.visible = false;
      ctrl = shot();
      shade.visible = true;
      gl.render(s.scene, s.camera);
    }
    for (let i = 0; i < rows.length; i++) if (ctrl) rows[i].ctrl = ctrl[i].L;

    // Clipping, on the graded frame rather than on the linear one.
    out.push({ name: st.name, note: st.note, eye: st.eyeWorld, rows });
  }
  rt.dispose();
  return { out, sun: { elev: ${elev}, azim: ${azim} } };
})()
`;

await run({ width: 1600, height: 900 }, async ({ page }) => {
  const res = await page.evaluate(PAGE(STOPS, SUN_ELEV, SUN_AZIM));
  for (const st of res.out) {
    console.log(`\n─── ${st.name} ───────────────────────────────────────`);
    console.log(`  ${st.note}`);
    console.log(`  eye ${st.eye.map((v) => v.toFixed(2)).join(', ')}`);
    const isArc = st.name === 'quarter';
    console.log(isArc
      ? '\n    where    depth  normal (x,y,z)          L linear (r g b)         R/B   material'
      : '\n    world x  depth  hit y     L linear (r g b)          rel   material');
    let ref = null;
    for (const r of st.rows) {
      if (!r.L || !r.hit) { console.log(`    ${r.tag.padStart(7)}  — off frame`); continue; }
      const [lr, lg, lb] = r.L;
      if (isArc) {
        console.log(`    ${r.tag.padStart(7)} ${r.hit.d.toFixed(2).padStart(6)}  `
          + `${r.hit.p.map((v) => v.toFixed(2).padStart(6)).join(' ')}  `
          + `${r.hit.n.map((v) => v.toFixed(2).padStart(5)).join(' ')}  `
          + `${lr.toFixed(4)} ${lg.toFixed(4)} ${lb.toFixed(4)}  `
          + `${(lr / Math.max(lb, 1e-6)).toFixed(2).padStart(6)}`);
      } else {
        const lum = (lr + lg + lb) / 3;
        const c = r.ctrl ? (r.ctrl[0] + r.ctrl[1] + r.ctrl[2]) / 3 : NaN;
        /* What the decal is doing, isolated: the ratio of the two renders at
         * the same pixel. The road's own albedo cancels exactly. */
        const got = lum / c;
        /* And what it should be doing. The estate's underbody is 0.823 m each
         * side of x = -1.02 at 0.155 m up and 2.01 m each way, and the sky is
         * 78 per cent of what lights shaded tarmac; see makeCarShadeMaterial. */
        const off = Math.abs(+r.tag - (-1.875));
        const ff = (a, b, h) => Math.atan(a * b / (h * Math.sqrt(a * a + b * b + h * h)))
          / (2 * Math.PI);
        const A = 0.823, B = 2.01, H = 0.150, dz = -42.35 - (-42.60);
        let occ = 0;
        for (const X of [A - off, A + off]) {
          for (const Z of [B - Math.abs(dz), B + Math.abs(dz)]) {
            occ += Math.sign(X) * Math.sign(Z) * ff(Math.abs(X), Math.abs(Z), H);
          }
        }
        occ = Math.max(0, Math.min(1, occ));
        console.log(`    ${r.tag.padStart(7)} ${r.hit.d.toFixed(2).padStart(6)}   `
          + `${lum.toFixed(4)}      ${c.toFixed(4)}     ${got.toFixed(3)}    `
          + `${(1 - occ * 0.78).toFixed(3)}`);
      }
    }
  }
  await capture(page, `shots/${name}/frame.png`, {});
});

await finish();
