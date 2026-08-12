/* Where the twenty-to-sixty-fold gap across the rear corner comes from.
 *
 *   node tools/quarter.mjs
 *
 * The review's question is the right one and it is not answerable from the
 * panel's own value: a surface turning away from the sun genuinely loses its
 * direct term, so part of that ratio is real and must survive. What has to be
 * established separately is whether the *indirect* light reaching the rear
 * quarter — the sky and the canyon bounce — is being delivered at the strength
 * the scene actually offers.
 *
 * So this measures both halves independently.
 *
 *   1. What the panel returns. Read out of the HDR buffer at the panel, before
 *      the tone curve, with the hit raycast for provenance.
 *
 *   2. What the panel *receives*. A camera is put at the panel's own position,
 *      pointed along its normal with a wide field, and the rendered hemisphere
 *      is integrated to a cosine-weighted irradiance. For a pinhole camera a
 *      pixel at image-plane offset (u, v) subtends du·dv·cos^3(theta), and the
 *      irradiance weight adds another cosine, so E = sum L·cos^4(theta)·du·dv.
 *      That is a measurement of the real field including the car's own
 *      self-occlusion, the kerb, the frontages and the slot of sky, and it owes
 *      nothing to any analytic probe.
 *
 * Then the two are divided. albedo_effective = L·pi/E is what the shader is
 * behaving as if the paint were; the palette says what it is. If the first is
 * far below the second the panel is short of light it should be receiving and
 * that is a correctness fix. If they agree, the physics is delivering and the
 * panel is simply dark, which is an aesthetic question and not a bug.
 *
 * The direct sun is absent from the integral — it is a directional light and
 * not in any texture — which is exactly what is wanted, since the whole
 * question is about the indirect budget. Its own contribution is stated
 * separately from the sun constants.
 */
import { readFileSync } from 'node:fs';
import { run, finish } from './harness.mjs';

const SRC = readFileSync(new URL('../src/scene/sun.ts', import.meta.url), 'utf8');
const num = (k) => {
  const m = SRC.match(new RegExp(`${k}\\s*=\\s*(-?[0-9.]+)`));
  return m ? +m[1] : null;
};

/* The hero estate: x -1.875, z -42.60, 4.62 long and 1.79 wide, so its tail is
 * at z -40.29 and its near flank at x -0.980. Every point below is 40 mm off the
 * skin along the outward normal, which keeps the integrating camera outside the
 * body without putting it far enough away to see round it.
 */
/* A vertical line up the middle of the tail, because aiming a single pixel at an
 * estate's rear is guesswork: the lamp cluster runs 0.76 to 1.02, the tailgate
 * aperture and the backlight are above that, and a bumper parting line crosses
 * the lot. Each sample reports what it hit and what the lift did to it, so the
 * paint can be picked out of the evidence rather than assumed. */
/* src/world/cars.ts CAR, restated here for the scan's readout only. */
const PART = ['paint', 'trim', 'arch', 'under', 'lampR', 'lampF', 'cabin',
  'plate', 'grille', 'capR', 'capF'];

const SCAN = { x: -1.60, z: -40.245, from: 0.45, to: 1.45, step: 0.05 };

const SPOTS = [
  {
    name: 'tail centre', at: [-1.60, 1.05, -40.25], n: [0, 0, 1],
    note: 'the tailgate, well inboard of the corner radius — the panel the review calls blue',
  },
  {
    name: 'rear quarter', at: [-1.02, 1.05, -40.45], n: [0.72, 0, 0.69],
    note: 'the corner radius itself, halfway through the turn',
  },
  {
    name: 'flank', at: [-0.94, 1.05, -41.95], n: [1, 0, 0],
    note: 'the control: the same panel, same height, 1.5 m forward, clear of the door shut',
  },
  {
    name: 'roof', at: [-1.80, 1.52, -41.80], n: [0, 1, 0],
    note: 'a second control, facing the one source nobody doubts',
  },
];

const PAGE = (spots) => `
(async () => {
  const s = window.__scene;
  const THREE = window.__THREE;
  const gl = s.renderer;
  const spots = ${JSON.stringify(spots)};

  /* Stand the walker at the three-quarter stop so that everything driven by
   * eye position — the defocus, the per-frame uniforms the liveness guard
   * checks — is in a real state rather than left wherever the page had it. */
  const w = s.walker;
  w.placeAt(0.5); w.x = 0.95; w.z = -38.90; w.snapGround(); w.advanceGait(0);
  const eye = new THREE.Vector3(w.eye.x, w.eye.y, w.eye.z);
  const f = new THREE.Vector3(-1.26, 1.05, -40.62).sub(eye).normalize();
  w.pitch = Math.asin(f.y); w.yaw = Math.atan2(-f.x, -f.z);
  s.setYaw(w.yaw); s.setPitch(w.pitch); s.setPaused(true);
  s.renderOnce();

  const h2f = (h) => {
    const sg = (h >> 15) ? -1 : 1, e = (h >> 10) & 31, fr = h & 1023;
    if (e === 0) return sg * fr * Math.pow(2, -24);
    if (e === 31) return fr ? NaN : sg * Infinity;
    return sg * (1 + fr / 1024) * Math.pow(2, e - 15);
  };
  const mk = (w2, h2) => new THREE.WebGLRenderTarget(w2, h2, {
    type: THREE.HalfFloatType, colorSpace: THREE.NoColorSpace,
    depthBuffer: true, samples: 0,
  });

  // ── 1. What each panel returns, from the walker's own view ──────────────
  const view = mk(gl.domElement.width, gl.domElement.height);
  const px4 = new Uint16Array(4);
  const ray = new THREE.Raycaster(); ray.far = 400;
  const out = [];

  /* Three states of the indirect budget, all in one frame from one camera: as
   * built, with the probe swapped for the sky the frame draws, and with the probe
   * at full strength. Same program and same dither in all three, so the
   * differences are the terms and nothing else. */
  const paint = null;
  const shoot = () => {
    const prev = gl.getRenderTarget();
    gl.setRenderTarget(view);
    gl.render(s.scene, s.camera);
    gl.setRenderTarget(prev);
  };
  const readSpots = () => {
    const got = [];
    for (const sp of spots) {
      const on2 = [sp.at[0] - sp.n[0] * 0.04, sp.at[1] - sp.n[1] * 0.04,
        sp.at[2] - sp.n[2] * 0.04];
      const v2 = new THREE.Vector3(on2[0], on2[1], on2[2]).project(s.camera);
      const W2 = view.width, H2 = view.height;
      const x2 = Math.round((v2.x * 0.5 + 0.5) * W2);
      const y2 = Math.round((0.5 - v2.y * 0.5) * H2);
      if (x2 < 2 || y2 < 2 || x2 > W2 - 3 || y2 > H2 - 3) { got.push(null); continue; }
      /* One pixel, not a 3x3 mean.
       *
       * The mean is what a level probe wants and it is wrong for a *ratio*
       * probe. Averaged over nine pixels the lift came out at 1.52 in red and
       * 1.77 in blue, which no single fragment can do — the box was straddling
       * the tailgate and the cooler surface beside it, the two take different
       * weights of the term, and each channel then averages them in a different
       * proportion because the two surfaces are different colours. */
      gl.readRenderTargetPixels(view, x2, H2 - 1 - y2, 1, 1, px4);
      got.push([h2f(px4[0]), h2f(px4[1]), h2f(px4[2])]);
    }
    return got;
  };
  shoot();
  const withLift = readSpots();
  if (paint) paint.userData.uLift.value = 0.0;
  shoot();
  const noLift = readSpots();
  if (paint) paint.userData.uLift.value = 1.0;
  shoot();

  for (let si = 0; si < spots.length; si++) {
    const sp = spots[si];
    // The skin itself, not the offset point the integrator uses.
    const on = [sp.at[0] - sp.n[0] * 0.04, sp.at[1] - sp.n[1] * 0.04,
      sp.at[2] - sp.n[2] * 0.04];
    const v = new THREE.Vector3(on[0], on[1], on[2]).project(s.camera);
    const W = view.width, H = view.height;
    const cx = Math.round((v.x * 0.5 + 0.5) * W), cy = Math.round((0.5 - v.y * 0.5) * H);
    let L = null, hit = null;
    if (cx > 1 && cy > 1 && cx < W - 1 && cy < H - 1) {
      const acc = [0, 0, 0];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        gl.readRenderTargetPixels(view, cx + dx, H - 1 - (cy + dy), 1, 1, px4);
        acc[0] += h2f(px4[0]); acc[1] += h2f(px4[1]); acc[2] += h2f(px4[2]);
      }
      L = acc.map((q) => q / 9);
      const ndc = new THREE.Vector2((cx / W) * 2 - 1, 1 - (cy / H) * 2);
      ray.setFromCamera(ndc, s.camera);
      const hs = ray.intersectObjects(s.scene.children, true)
        .filter((h) => h.object.visible && h.object.type === 'Mesh');
      if (hs.length) {
        const nv = new THREE.Vector3();
        if (hs[0].face) nv.copy(hs[0].face.normal).transformDirection(hs[0].object.matrixWorld);
        hit = { d: hs[0].distance, p: hs[0].point.toArray(), n: nv.toArray() };
      }
    }
    out.push({ ...sp, L: withLift[si] ?? L, L0: noLift[si], hit, px: [cx, cy] });
  }
  view.dispose();

  // ── 2. What each panel receives ─────────────────────────────────────────
  const cam0 = s.camera.position.clone();
  const N = 192, FOV = 120;
  const cube = mk(N, N);
  const buf = new Uint16Array(N * N * 4);
  const cam = new THREE.PerspectiveCamera(FOV, 1, 0.02, 600);
  const half = Math.tan((FOV / 2) * Math.PI / 180);
  const du = (2 * half) / N;

  for (const rec of out) {
    cam.position.set(rec.at[0], rec.at[1], rec.at[2]);
    /* Looking along the outward normal. The up vector is chosen off-axis so
     * that a normal pointing straight up does not degenerate. */
    const tgt = new THREE.Vector3(...rec.at).add(new THREE.Vector3(...rec.n));
    cam.up.set(Math.abs(rec.n[1]) > 0.9 ? 1 : 0, Math.abs(rec.n[1]) > 0.9 ? 0 : 1, 0);
    cam.lookAt(tgt);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    const integrate = () => {
      const prev = gl.getRenderTarget();
      gl.setRenderTarget(cube);
      gl.render(s.scene, cam);
      gl.setRenderTarget(prev);
      gl.readRenderTargetPixels(cube, 0, 0, N, N, buf);
      const E = [0, 0, 0];
      let cov = 0;
      for (let j = 0; j < N; j++) {
        const v = -half + (j + 0.5) * du;
        for (let i = 0; i < N; i++) {
          const u = -half + (i + 0.5) * du;
          const c2 = 1 / (1 + u * u + v * v);       // cos^2 theta
          const wgt = c2 * c2 * du * du;            // cos^4 theta . du . dv
          const k = (j * N + i) * 4;
          E[0] += h2f(buf[k]) * wgt;
          E[1] += h2f(buf[k + 1]) * wgt;
          E[2] += h2f(buf[k + 2]) * wgt;
          cov += wgt;
        }
      }
      return { E, cov: cov / Math.PI };
    };

    /* And what the street actually holds along this surface's mirror direction,
     * through a 6-degree window — the reference the reflection term has to be
     * judged against. A panel cannot return a colour more saturated than the
     * thing it is reflecting, so if the paint comes back bluer than this, the
     * blue is being manufactured rather than reflected. */
    {
      const P = new THREE.Vector3(...rec.at);
      const V = P.clone().sub(cam0).normalize();
      const Nn = new THREE.Vector3(...rec.n).normalize();
      const R = V.clone().sub(Nn.clone().multiplyScalar(2 * V.dot(Nn))).normalize();
      const nar = new THREE.PerspectiveCamera(6, 1, 0.02, 600);
      nar.position.copy(P);
      nar.up.set(Math.abs(R.y) > 0.9 ? 1 : 0, Math.abs(R.y) > 0.9 ? 0 : 1, 0);
      nar.lookAt(P.clone().add(R));
      nar.updateProjectionMatrix(); nar.updateMatrixWorld();
      const pr2 = gl.getRenderTarget();
      gl.setRenderTarget(cube);
      gl.render(s.scene, nar);
      gl.setRenderTarget(pr2);
      gl.readRenderTargetPixels(cube, 0, 0, N, N, buf);
      const m = [0, 0, 0];
      let cnt = 0;
      for (let j = N * 0.4 | 0; j < N * 0.6; j++) for (let i = N * 0.4 | 0; i < N * 0.6; i++) {
        const k = (j * N + i) * 4;
        m[0] += h2f(buf[k]); m[1] += h2f(buf[k + 1]); m[2] += h2f(buf[k + 2]); cnt++;
      }
      rec.mir = m.map((v) => v / cnt);
      rec.R = R.toArray();
    }

    const full = integrate();
    rec.E = full.E;
    rec.cov = full.cov;

    /* And the same hemisphere with every mesh in the scene hidden, which leaves
     * the dome. That is not a curiosity: it is precisely the quantity the car's
     * diffuse path is given. iblIrradiance comes from scene.environment, which
     * holds a sky and no buildings, so the difference between these two numbers
     * is the frontage and kerb bounce — light that is in the street, that the
     * panel demonstrably sees, and that the diffuse term has no route to.
     */
    const off = [];
    s.scene.traverse((o) => {
      if (o.type === 'Mesh' && o.visible) { off.push(o); o.visible = false; }
    });
    const sky = integrate();
    for (const o of off) o.visible = true;
    rec.Esky = sky.E;
  }
  cube.dispose();
  // ── 3. A vertical line up the tail, test and control in the same frame ──
  const scan = ${JSON.stringify(SCAN)};
  const line = [];
  const envInfo = {
    same: s.scene.environment === s.scene.background,
    env: s.scene.environment ? (s.scene.environment.name || s.scene.environment.uuid.slice(0, 8)) : 'none',
    bg: s.scene.background ? (s.scene.background.name || s.scene.background.uuid.slice(0, 8)) : 'none',
    envMapping: s.scene.environment ? s.scene.environment.mapping : -1,
    bgMapping: s.scene.background ? s.scene.background.mapping : -1,
    intensity: s.scene.environmentIntensity,
  };
  {
    const grab = () => {
      shoot();
      const got = [];
      for (let y = scan.from; y <= scan.to + 1e-9; y += scan.step) {
        const v2 = new THREE.Vector3(scan.x, y, scan.z).project(s.camera);
        const W2 = view.width, H2 = view.height;
        const x2 = Math.round((v2.x * 0.5 + 0.5) * W2);
        const y2 = Math.round((0.5 - v2.y * 0.5) * H2);
        if (x2 < 1 || y2 < 1 || x2 > W2 - 2 || y2 > H2 - 2) { got.push(null); continue; }
        gl.readRenderTargetPixels(view, x2, H2 - 1 - y2, 1, 1, px4);
        got.push({ y, px: [x2, y2], L: [h2f(px4[0]), h2f(px4[1]), h2f(px4[2])] });
      }
      return got;
    };
    const on = grab();
    const off = on;
    /* And the same line again with scene.environment swapped for
     * scene.background. The two were decoupled when the clouds landed, and the
     * diffuse on an away-facing panel is *only* iblIrradiance, so if the probe
     * the diffuse reads is not the sky the frame shows, the back of every car in
     * the street is lit by something nobody is looking at. */
    const envWas = s.scene.environment;
    const swap = [];
    const fulls = [];
    if (envWas !== s.scene.background && s.scene.background) {
      s.scene.environment = s.scene.background;
      const g = grab();
      for (const q of g) swap.push(q);
      s.scene.environment = envWas;
    }
    /* And a third state: the probe at full strength, its own texture unchanged.
     * Street.tsx holds scene.environmentIntensity at 0.50 under a comment that
     * argues at length against holding the sky down at this hour, which is worth
     * a number rather than a reading of the comment. */
    const iWas = s.scene.environmentIntensity;
    s.scene.environmentIntensity = 1.0;
    const full2 = grab();
    s.scene.environmentIntensity = iWas;
    for (let i = 0; i < full2.length; i++) if (full2[i]) fulls.push(full2[i]);
    shoot();
    for (let i = 0; i < on.length; i++) {
      if (!on[i] || !off[i]) { line.push(null); continue; }
      const ndc = new THREE.Vector2((on[i].px[0] / view.width) * 2 - 1,
        1 - (on[i].px[1] / view.height) * 2);
      ray.setFromCamera(ndc, s.camera);
      const hs = ray.intersectObjects(s.scene.children, true)
        .filter((h) => h.object.visible && h.object.type === 'Mesh');
      let n = [0, 0, 0], d = 0, part = -1, mat = '';
      if (hs.length) {
        const nv = new THREE.Vector3();
        if (hs[0].face) nv.copy(hs[0].face.normal).transformDirection(hs[0].object.matrixWorld);
        n = nv.toArray(); d = hs[0].distance;
        /* The part code, read off the geometry at the face the ray actually hit
         * rather than guessed from the height. Which surface a sample is on is
         * the thing the whole gate turns on, and on the rear of an estate at
         * this height the candidates — tailgate, lamp, chrome surround, plate,
         * backlight — are all within 300 mm of each other. */
        const g = hs[0].object.geometry;
        const a = g && g.attributes && g.attributes.aCar;
        if (a && hs[0].face) part = a.getY(hs[0].face.a);
        mat = (hs[0].object.material && hs[0].object.material.name) || '';
      }
      line.push({ y: on[i].y, on: on[i].L, off: off[i].L, n, d, part, mat,
        swap: swap[i] ? swap[i].L : null,
        full: fulls[i] ? fulls[i].L : null });
    }
  }

  // ── 4. Straight across the rear corner, pixel by pixel ─────────────────
  /* The question is whether the finish steps or turns across the corner. A
   * vertical scan cannot answer it and a world-space path around the body needs
   * a guess about the body's shape, so this walks a row of the rendered image
   * instead and reports, for every pixel, where it landed, which way that
   * surface faces, which part code it carries and what it returned. A step in
   * value that coincides with a part-code change is a material boundary; a ramp
   * that tracks the normal turning is a lit curve. */
  const corner = [];
  {
    const W2 = view.width, H2 = view.height;
    shoot();
    for (const hy of [0.50, 0.85, 1.25]) {
    const anchor = new THREE.Vector3(-0.99, hy, -40.30).project(s.camera);
    const row = Math.round((0.5 - anchor.y * 0.5) * H2);
    const c0 = Math.round((anchor.x * 0.5 + 0.5) * W2);
    for (let dx = -120; dx <= 120; dx += 4) {
      const x2 = c0 + dx;
      if (x2 < 1 || x2 > W2 - 2) continue;
      gl.readRenderTargetPixels(view, x2, H2 - 1 - row, 1, 1, px4);
      const L = [h2f(px4[0]), h2f(px4[1]), h2f(px4[2])];
      const ndc = new THREE.Vector2((x2 / W2) * 2 - 1, 1 - (row / H2) * 2);
      ray.setFromCamera(ndc, s.camera);
      const hs = ray.intersectObjects(s.scene.children, true)
        .filter((h) => h.object.visible && h.object.type === 'Mesh');
      if (!hs.length) continue;
      const nv = new THREE.Vector3();
      if (hs[0].face) nv.copy(hs[0].face.normal).transformDirection(hs[0].object.matrixWorld);
      const g = hs[0].object.geometry;
      const a = g && g.attributes && g.attributes.aCar;
      const uv = g && g.attributes && g.attributes.uv;
      corner.push({
        hy, dx, L, p: hs[0].point.toArray(), n: nv.toArray(), d: hs[0].distance,
        part: (a && hs[0].face) ? a.getY(hs[0].face.a) : -1,
        u: (uv && hs[0].face) ? uv.getX(hs[0].face.a) : -1,
        v: (uv && hs[0].face) ? uv.getY(hs[0].face.a) : -1,
      });
    }
    }
  }

  s.renderOnce();
  return { out, line, envInfo, corner };
})()
`;

await run({ width: 1600, height: 900 }, async ({ page }) => {
  const res = await page.evaluate(PAGE(SPOTS));
  const rows = res.out;

  /* The palette entry the hero carries. colour 0.25 indexes light grey, and it
   * is worth writing down that this paint is faintly *cool* — 0.118 in blue
   * against 0.104 in red — because it bears on the hue question the review has
   * now closed. Dirt at 0.30 takes a little off it. */
  const ALB = [0.1040, 0.1084, 0.1180];

  console.log('\n  hero estate, light grey: palette albedo '
    + ALB.map((v) => v.toFixed(4)).join(' '));
  console.log(`  sun elevation ${num('SUN_ELEV')} rad`
    + `, azimuth ${num('SUN_AZIM')}`);

  for (const r of rows) {
    console.log(`\n── ${r.name} ──────────────────────────────────────────`);
    console.log(`   ${r.note}`);
    if (r.hit) {
      console.log(`   aimed at ${r.at.map((v) => v.toFixed(2)).join(', ')}; `
        + `the ray hit ${r.hit.p.map((v) => v.toFixed(2)).join(', ')} at `
        + `${r.hit.d.toFixed(2)} m, normal ${r.hit.n.map((v) => v.toFixed(2)).join(' ')}`);
    } else {
      console.log('   the panel is not in this frame — no value to compare');
    }
    if (!r.L || !r.E) continue;
    const [lr, lg, lb] = r.L;
    const [er, eg, eb] = r.E;
    console.log(`   returns   ${lr.toFixed(4)} ${lg.toFixed(4)} ${lb.toFixed(4)}`
      + `   (R/B ${(lr / Math.max(lb, 1e-9)).toFixed(2)})`);
    if (r.L0) {
      const [ar, ag, ab] = r.L0;
      console.log(`   no lift   ${ar.toFixed(4)} ${ag.toFixed(4)} ${ab.toFixed(4)}`
        + `   (R/B ${(ar / Math.max(ab, 1e-9)).toFixed(2)})   same frame, uLift = 0`);
      console.log('   the lift  '
        + [lr / ar, lg / ag, lb / ab].map((v) => v.toFixed(3) + 'x').join(' ')
        + '   — equal across the channels is the hue staying put');
    }
    console.log(`   receives  ${er.toFixed(4)} ${eg.toFixed(4)} ${eb.toFixed(4)}`
      + `   over ${(r.cov * 100).toFixed(0)}% of the cosine-weighted hemisphere,`);
    console.log('             indirect only — the sun is a light, not a texture');
    if (r.mir) {
      const [mr, mg, mb] = r.mir;
      console.log(`   its mirror direction ${r.R.map((v) => v.toFixed(2)).join(' ')} holds `
        + `${mr.toFixed(4)} ${mg.toFixed(4)} ${mb.toFixed(4)}`
        + `   (B/R ${(mb / Math.max(mr, 1e-9)).toFixed(2)})`);
      console.log(`   the panel returns B/R ${(lb / Math.max(lr, 1e-9)).toFixed(2)}`
        + (lb / Math.max(lr, 1e-9) > 1.4 * (mb / Math.max(mr, 1e-9))
          ? '   <-- bluer than anything it is looking at' : '   <-- within its sources'));
    }
    if (r.Esky) {
      const [sr, sg, sb] = r.Esky;
      console.log(`   dome only ${sr.toFixed(4)} ${sg.toFixed(4)} ${sb.toFixed(4)}`
        + '   every mesh hidden: this is what iblIrradiance is');
      const bounce = r.E.map((v, i) => v / Math.max(r.Esky[i], 1e-9));
      console.log(`   so the street delivers ${bounce.map((v) => v.toFixed(2)).join(' / ')}`
        + ' of the bare dome after occlusion and bounce');
    }
    /* Lambertian: L = albedo . E / pi. Inverted, the effective albedo is what
     * the shader is behaving as if the paint were. */
    const eff = [lr, lg, lb].map((L, i) => (L * Math.PI) / Math.max(r.E[i], 1e-9));
    console.log(`   implied albedo ${eff.map((v) => v.toFixed(3)).join(' ')}`
      + `   against ${ALB.map((v) => v.toFixed(3)).join(' ')} in the palette`);
    const ratio = eff[1] / ALB[1];
    console.log(`   so this panel behaves as ${ratio.toFixed(2)}x its own albedo`
      + (ratio < 0.55 ? '   <-- short of the light it can see'
        : ratio > 1.8 ? '   <-- brighter than Lambertian: specular on top'
          : '   <-- consistent, allowing for the specular lobe on top'));
  }

  console.log('\n── up the middle of the tail, test and control in one frame ────');
  console.log('    y      lift    with lift (r g b)         normal            hit m');
  for (const q of res.line) {
    if (!q) { continue; }
    const k = q.on[1] / Math.max(q.off[1], 1e-9);
    const eq = q.on.map((v, i) => v / Math.max(q.off[i], 1e-9));
    const spread = Math.max(...eq) - Math.min(...eq);
    console.log(`   ${q.y.toFixed(2)}   ${k.toFixed(3)}x   `
      + `${q.on.map((v) => v.toFixed(4)).join(' ')}   `
      + `${q.n.map((v) => v.toFixed(2).padStart(5)).join(' ')}  ${q.d.toFixed(2)}`
      + `  part ${String(q.part).padStart(2)} ${PART[q.part] || '?'}`
      + (q.full ? `
            probe at full strength:         `
        + `${q.full.map((v) => v.toFixed(4)).join(' ')}   B/R `
        + `${(q.full[2] / Math.max(q.full[0], 1e-9)).toFixed(2)}`
        + `   red x${(q.full[0] / Math.max(q.off[0], 1e-9)).toFixed(2)}` : '')
      + (q.swap ? `
            with environment = background: `
        + `${q.swap.map((v) => v.toFixed(4)).join(' ')}   B/R `
        + `${(q.swap[2] / Math.max(q.swap[0], 1e-9)).toFixed(2)}`
        + ` against ${(q.off[2] / Math.max(q.off[0], 1e-9)).toFixed(2)} as built` : '')
      + (spread > 0.01 ? `   channels disagree by ${spread.toFixed(3)}` : ''));
  }

  console.log('\n── straight across the rear corner, one pixel at a time ───────');
  console.log('   px    linear (r g b)          B/R    hit x, z        normal        uv.x  part');
  let prev = null;
  let lastH = null;
  for (const q of res.corner) {
    if (q.d > 6 || q.part < 0) continue;
    if (q.hy !== lastH) {
      console.log(`   -- at y = ${q.hy.toFixed(2)} `
        + (q.hy < 0.60 ? '(under the film line, where the clearcoat is meant to go)'
          : q.hy < 1.05 ? '(the lamp band)' : '(clean paint, above everything)'));
      lastH = q.hy; prev = null;
    }
    const br = q.L[2] / Math.max(q.L[0], 1e-9);
    let flag = '';
    if (prev) {
      const turn = Math.acos(Math.min(1, Math.max(-1,
        prev.n[0] * q.n[0] + prev.n[1] * q.n[1] + prev.n[2] * q.n[2]))) * 180 / Math.PI;
      const mm = Math.hypot(q.p[0] - prev.p[0], q.p[2] - prev.p[2]) * 1000;
      const jump = br / Math.max(prev.br, 1e-9);
      if (q.part !== prev.part) flag += `  part ${prev.part}->${q.part}`;
      if (jump > 1.6 || jump < 0.62) flag += `  B/R x${jump.toFixed(2)} over ${mm.toFixed(0)} mm and ${turn.toFixed(0)} deg`;
    }
    console.log(`  ${String(q.dx).padStart(4)}  ${q.L.map((v) => v.toFixed(4)).join(' ')}`
      + `   ${br.toFixed(2).padStart(5)}  ${q.p[0].toFixed(2).padStart(5)} ${q.p[2].toFixed(2)}`
      + `  ${q.n.map((v) => v.toFixed(2).padStart(5)).join(' ')}  ${q.u.toFixed(2).padStart(5)}`
      + `  ${String(q.part).padStart(2)} ${PART[q.part] || '?'}${flag}`);
    prev = { ...q, br };
  }

  const tail = rows.find((r) => r.name === 'tail centre');
  const flank = rows.find((r) => r.name === 'flank');
  if (tail?.L && flank?.L) {
    const lum = (v) => (v[0] + v[1] + v[2]) / 3;
    console.log('\n── the gap, split ─────────────────────────────────────');
    console.log(`   returned    flank ${lum(flank.L).toFixed(4)} `
      + `against tail ${lum(tail.L).toFixed(4)}  = ${(lum(flank.L) / lum(tail.L)).toFixed(0)}x`);
    console.log(`   received    flank ${lum(flank.E).toFixed(4)} `
      + `against tail ${lum(tail.E).toFixed(4)}  = ${(lum(flank.E) / lum(tail.E)).toFixed(1)}x`
      + '   (indirect only)');
    console.log('   so of the returned ratio, the part the indirect field itself');
    console.log('   accounts for is the second line and the rest is the sun.');
  }
});

await finish();
