/* Three things the pool meter and the wall probe could not answer on their own.
 *
 *   node tools/sunexp.mjs [--out tmp/sunexp.json]
 *
 * 1. WHAT IS UNDER THE METER. The irradiance meter flies to 2 m and reads
 *    straight down, and on one lane it returned a tenth of what the arithmetic
 *    says directly beneath a working lantern. Either the light is not arriving
 *    or the meter is standing on something. This names the object and the
 *    material at each point, which distinguishes the two in one run.
 *
 * 2. THE FRONTAGES, ANCHORED PROPERLY. tools/sunlamp.mjs aims its raycast down
 *    the street at a fixed slope, which at some stops finds a wall eighty
 *    metres away instead of the one beside the camera. This walks the frontage
 *    directly: for a ladder of world points on each row, project and sample,
 *    and report the distance so a reader can see which wall was measured.
 *
 * 3. WHAT ELEVATION WOULD COST. The sun's angle lives in a locked file, so this
 *    moves the DirectionalLight at runtime and measures what the sun-facing
 *    frontage does as a function of elevation.
 *
 *    THE CAVEAT MATTERS AND IS NOT SMALL. SUN_DIR is baked into the sky
 *    texture, into the image-based light derived from it, into the haze's
 *    forward lobe and into a uSun uniform in something like fifteen materials.
 *    Moving the light object moves the direct term and the shadow map and
 *    nothing else. So these numbers are the answer to "how much direct sun
 *    lands on that wall", which is the question, and they are NOT a preview of
 *    the frame — the sky would still have its disc at 4.2 degrees. Read them as
 *    a shadowing measurement, not as a render.
 */
import fs from 'node:fs';
import { run, finish } from './harness.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const OUT = flag('out', 'tmp/sunexp.json');
const ELEVS = [4.2, 6, 8, 10, 12, 15, 20, 26];

await run({ width: 1280, height: 720 }, async ({ page, readShaderErrors }) => {
  const out = { when: new Date().toISOString() };
  const ready = () => page.waitForFunction(
    () => !!window.__scene && !!window.__sys5, null, { timeout: 90_000 });

  /* ── 1. what the meter is standing on ───────────────────────────────── */
  await ready();
  out.under = await page.evaluate(() => {
    const T = window.__THREE;
    const s = window.__scene;
    const rc = new T.Raycaster();
    const targets = [];
    s.scene.traverse((o) => { if (o.isMesh && o.visible) targets.push(o); });
    const rows = [];
    for (const x of [-3.15, 0, 3.15]) {
      for (const z of [16, 13, 11, 8, -17, -31, -45, -64]) {
        rc.set(new T.Vector3(x, 2.0, z), new T.Vector3(0, -1, 0));
        const h = rc.intersectObjects(targets, false);
        rows.push(h.length
          ? {
            x, z, y: +h[0].point.y.toFixed(3), dist: +h[0].distance.toFixed(3),
            mat: h[0].object.material.name || h[0].object.material.type,
            key: h[0].object.material.customProgramCacheKey
              ? h[0].object.material.customProgramCacheKey() : '(default)',
            n: h[0].face ? [h[0].face.normal.x, h[0].face.normal.y, h[0].face.normal.z]
              .map((v) => +v.toFixed(2)) : null,
          }
          : { x, z, y: null, mat: 'NOTHING' });
      }
    }
    return rows;
  });

  /* ── 2. the frontages, walked ───────────────────────────────────────── */
  await ready();
  out.frontage = await page.evaluate(() => {
    const T = window.__THREE;
    const s = window.__scene;
    const rc = new T.Raycaster();
    rc.far = 60;
    const targets = [];
    s.scene.traverse((o) => { if (o.isMesh && o.visible) targets.push(o); });

    /* Find each row's face by shooting across the street, then sample the frame
     * at the hit. The camera stands 10 m back from the sample so the wall is in
     * frame and near enough that the haze has not taken it over. */
    const rows = [];
    for (const z of [-14, -28, -40, -52, -66, -80]) {
      const cz = z + 10;
      s.setPaused(true);
      const cam = s.camera;
      cam.position.set(0, 1.65, cz);
      cam.quaternion.setFromEuler(new T.Euler(0, 0, 0, 'YXZ'));
      cam.updateMatrixWorld();
      s.renderer.render(s.scene, cam);

      const cv = s.renderer.domElement;
      const off = document.createElement('canvas');
      off.width = cv.width; off.height = cv.height;
      const ctx = off.getContext('2d');
      ctx.drawImage(cv, 0, 0);

      for (const side of [-1, 1]) {
        for (const y of [2.5, 5.0, 8.0, 11.0]) {
          rc.set(new T.Vector3(0, y, z), new T.Vector3(side, 0, 0));
          const h = rc.intersectObjects(targets, false);
          if (!h.length) continue;
          const p = h[0].point;
          const v = p.clone().project(cam);
          if (v.z > 1 || Math.abs(v.x) > 0.96 || Math.abs(v.y) > 0.96) continue;
          const px = Math.round((v.x * 0.5 + 0.5) * cv.width);
          const py = Math.round((-v.y * 0.5 + 0.5) * cv.height);
          const d = ctx.getImageData(px - 4, py - 4, 9, 9).data;
          let r = 0, g = 0, b = 0, n = 0;
          for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
          rows.push({
            side: side < 0 ? 'sunL' : 'shadeR', z, y,
            x: +p.x.toFixed(2), rgb: [r / n, g / n, b / n].map((q) => +q.toFixed(1)),
          });
        }
      }
      s.setPaused(false);
    }
    return rows;
  });

  /* ── 3. the elevation sweep ─────────────────────────────────────────── */
  await ready();
  out.sweep = await page.evaluate((ELEVS) => {
    const T = window.__THREE;
    const s = window.__scene;
    const AZ = 35.0 * Math.PI / 180;
    let sun = null;
    s.scene.traverse((o) => { if (o.isDirectionalLight) sun = o; });
    if (!sun) return { error: 'no DirectionalLight in the scene' };

    const targets = [];
    s.scene.traverse((o) => { if (o.isMesh && o.visible) targets.push(o); });
    const rc = new T.Raycaster();
    rc.far = 60;

    /* Sample points on the sun-facing frontage, found once so every elevation
     * is read at the same places. */
    const pts = [];
    for (const z of [-14, -28, -40, -52, -66, -80]) {
      for (const y of [2.5, 5.0, 8.0, 11.0]) {
        rc.set(new T.Vector3(0, y, z), new T.Vector3(-1, 0, 0));
        const h = rc.intersectObjects(targets, false);
        if (h.length) pts.push({ z, y, p: h[0].point.clone() });
      }
    }

    s.setDriven(true);
    const cam = s.camera;
    const rows = [];
    for (const e of ELEVS) {
      const el = e * Math.PI / 180;
      const dir = new T.Vector3(
        Math.sin(AZ) * Math.cos(el), Math.sin(el), -Math.cos(AZ) * Math.cos(el));
      const acc = [];
      for (const q of pts) {
        const cz = q.z + 10;
        // The shadow follower reads the camera, so move it first and let one
        // frame run before the light is repositioned against it.
        cam.position.set(0, 1.65, cz);
        cam.quaternion.setFromEuler(new T.Euler(0, 0, 0, 'YXZ'));
        s.step(0.016);
        sun.target.position.set(0, 0, cz - 8);
        sun.target.updateMatrixWorld();
        sun.position.set(dir.x * 60, dir.y * 60 + 2, cz - 8 + dir.z * 60);
        sun.updateMatrixWorld();
        sun.shadow.needsUpdate = true;
        cam.position.set(0, 1.65, cz);
        cam.quaternion.setFromEuler(new T.Euler(0, 0, 0, 'YXZ'));
        cam.updateMatrixWorld();
        s.renderer.render(s.scene, cam);

        const v = q.p.clone().project(cam);
        if (v.z > 1 || Math.abs(v.x) > 0.96 || Math.abs(v.y) > 0.96) continue;
        const cv = s.renderer.domElement;
        const px = Math.round((v.x * 0.5 + 0.5) * cv.width);
        const py = Math.round((-v.y * 0.5 + 0.5) * cv.height);
        const gl = s.renderer.getContext();
        const buf = new Uint8Array(9 * 9 * 4);
        gl.readPixels(px - 4, cv.height - py - 4, 9, 9, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        let r = 0, g = 0, b = 0;
        for (let i = 0; i < buf.length; i += 4) { r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; }
        const n = buf.length / 4;
        acc.push({ z: q.z, y: q.y, rgb: [r / n, g / n, b / n].map((w) => +w.toFixed(1)) });
      }
      rows.push({ elev: e, pts: acc });
    }
    s.setDriven(false);
    return { rows };
  }, ELEVS);

  out.shaderErrors = await readShaderErrors();
  fs.mkdirSync('tmp', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));

  console.log('\n── what the irradiance meter is standing on');
  for (const r of out.under) {
    console.log(`  x ${String(r.x).padStart(6)} z ${String(r.z).padStart(4)}  ` +
      `y ${r.y === null ? '  —  ' : String(r.y).padStart(6)}  n ${r.n ? r.n.join(',') : '—'}  ${r.mat}  ${r.key || ''}`);
  }

  console.log('\n── the two frontages, display counts and B/R');
  for (const r of out.frontage) {
    console.log(`  ${r.side.padEnd(7)} z ${String(r.z).padStart(4)} y ${String(r.y).padStart(5)} ` +
      `x ${String(r.x).padStart(6)}  (${r.rgb.map((v) => String(Math.round(v)).padStart(3)).join(',')})` +
      `  B/R ${(r.rgb[2] / Math.max(r.rgb[0], 1)).toFixed(2)}`);
  }

  if (out.sweep.rows) {
    console.log('\n── sun-facing frontage against elevation (direct term and shadow only)');
    for (const row of out.sweep.rows) {
      const lum = row.pts.map((p) => 0.2126 * p.rgb[0] + 0.7152 * p.rgb[1] + 0.0722 * p.rgb[2]);
      const br = row.pts.map((p) => p.rgb[2] / Math.max(p.rgb[0], 1));
      const low = row.pts.filter((p) => p.y <= 5);
      const lowLum = low.map((p) => 0.2126 * p.rgb[0] + 0.7152 * p.rgb[1] + 0.0722 * p.rgb[2]);
      const lowBr = low.map((p) => p.rgb[2] / Math.max(p.rgb[0], 1));
      const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(a.length, 1);
      const warm = br.filter((v) => v < 0.95).length;
      console.log(`  ${String(row.elev).padStart(5)}°  all: lum ${mean(lum).toFixed(1).padStart(5)}` +
        ` B/R ${mean(br).toFixed(2)}   below 5 m: lum ${mean(lowLum).toFixed(1).padStart(5)}` +
        ` B/R ${mean(lowBr).toFixed(2)}   warm points ${warm}/${br.length}`);
    }
  } else {
    console.log('\n  sweep failed: ' + out.sweep.error);
  }
  console.log(`\n  → ${OUT}`);
});

finish(process.exitCode || 0);
