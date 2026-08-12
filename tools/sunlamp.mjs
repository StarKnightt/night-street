/* The warm/cool separation and the lamp pools, measured rather than asserted.
 *
 * Three instruments in one browser session, because a session costs four
 * minutes and four agents are sharing the GPU.
 *
 *   node tools/sunlamp.mjs [--out tmp/sunlamp.json] [--skip shadow,walls,pools]
 *
 * 1. SHADOW GEOMETRY.  For a ladder of heights on both frontages, a ray is cast
 *    from the wall toward the sun through the real scene graph. This answers
 *    "is the sun-facing frontage actually reached by the sun at 4.2 degrees"
 *    without going anywhere near a pixel, and it sweeps elevation so the answer
 *    is a curve rather than a yes/no. Nothing is hand-copied: the geometry is
 *    the geometry the page is drawing.
 *
 * 2. WALLS.  At each walk stop the camera raycasts left and right to find the
 *    two frontages, the hit point is projected back to the screen and a patch
 *    is averaged. Anchoring on a raycast rather than on a fixed screen
 *    rectangle means the sample is on the wall at every stop instead of on
 *    whatever happens to be at 4% of the frame width.
 *
 * 3. POOLS.  An irradiance meter. `__sys5.mirror(1)` makes every receiving
 *    material output `artificial()` itself, so the camera is flown to 2 m above
 *    each probe point looking straight down and the centre pixel is inverted
 *    through the real transform. Two metres of air carries no measurable haze,
 *    and the reading is the irradiance the lamps actually deliver to that patch
 *    of ground — not a prediction from a transcription of the shader.
 *
 * COLOUR SPACE. Pixels come back display-encoded. `invert()` from agx.mjs takes
 * them back to linear scene radiance per channel; that inversion is exact for
 * greys and approximate for saturated colours, which is why the chroma numbers
 * below are reported as display-space B/R — the ratio the project's review
 * history is written in — alongside the linear estimate.
 */
import fs from 'node:fs';
import { run, finish } from './harness.mjs';
import { invert } from './agx.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const OUT = flag('out', 'tmp/sunlamp.json');
const SKIP = (flag('skip', '') || '').split(',').filter(Boolean);
const doing = (k) => !SKIP.includes(k);

/* Elevations to sweep. 4.2 is the shipped one; the rest bracket the range
 * between "nothing on the frontage" and "midday". */
const ELEVS = [4.2, 6, 8, 10, 12, 15, 18, 22, 26, 30, 35, 42];

/* Probe points for the pools. The centreline and both footways, sampled every
 * metre over the lit block, so a minimum between adjacent pools is found by
 * looking rather than by assuming it is at the midpoint. */
const Z0 = 16, Z1 = -104, DZ = 1.0;

await run({ width: 1280, height: 720 }, async ({ page, readShaderErrors }) => {
  const result = { when: new Date().toISOString(), reloads: 0 };

  /* Four agents are editing this tree while this runs, and every save triggers
   * a Fast Refresh that unmounts Rig and deletes `window.__scene`. A run that
   * happened to straddle one died with "cannot read properties of undefined",
   * which is a measurement lost to somebody else's keystroke rather than to
   * anything about the scene. So each block waits for the debug API to be back
   * before it starts, and the count of waits is reported — a non-zero count
   * means the run spans a recompile and the halves may not be the same build.
   */
  const ready = async () => {
    const had = await page.evaluate(() => !!window.__scene && !!window.__sys5);
    if (!had) result.reloads++;
    await page.waitForFunction(() => !!window.__scene && !!window.__sys5, null, { timeout: 90_000 });
    if (!had) await page.waitForTimeout(1500);      // let the bakes finish
  };

  /* ── the registered sources ─────────────────────────────────────────── */
  await ready();
  result.sources = await page.evaluate(() => window.__sys5?.dump() ?? null);

  /* ── 1. shadow geometry ─────────────────────────────────────────────── */
  if (doing('shadow')) {
    await ready();
    result.shadow = await page.evaluate((ELEVS) => {
      const T = window.__THREE;
      const s = window.__scene;
      const AZ = 35.0 * Math.PI / 180;
      const rc = new T.Raycaster();
      rc.far = 400;

      /* Everything drawable, so a ray is tested against the street the way the
       * shadow pass sees it. Points and the additive glow proxies are excluded
       * — neither casts. */
      const targets = [];
      s.scene.traverse((o) => {
        if (o.isMesh && o.visible && o.material && o.material.type !== 'MeshBasicMaterial') targets.push(o);
      });

      /* Find the frontage by shooting across the street at a given height and
       * z, so the wall's x comes from the geometry rather than from a table. */
      const wallAt = (z, y, sign) => {
        rc.set(new T.Vector3(0, y, z), new T.Vector3(sign, 0, 0));
        const h = rc.intersectObjects(targets, false);
        return h.length ? h[0].point : null;
      };

      const rows = [];
      for (const sign of [-1, 1]) {                  // -1 = left of frame = +X normal
        for (const z of [-14, -28, -40, -52, -66, -80, -92]) {
          for (const y of [2, 4, 6, 8, 10, 12, 14, 16]) {
            const p = wallAt(z, y, sign);
            if (!p) continue;
            const n = new T.Vector3(-sign, 0, 0);    // outward, back toward x=0
            const row = { side: sign < 0 ? 'left' : 'right', z, y, x: +p.x.toFixed(2), clear: {} };
            for (const e of ELEVS) {
              const el = e * Math.PI / 180;
              const dir = new T.Vector3(
                Math.sin(AZ) * Math.cos(el), Math.sin(el), -Math.cos(AZ) * Math.cos(el),
              );
              if (dir.dot(n) <= 0) { row.clear[e] = 'facing-away'; continue; }
              const o = p.clone().addScaledVector(n, 0.06);
              rc.set(o, dir);
              const hit = rc.intersectObjects(targets, false);
              row.clear[e] = hit.length ? +hit[0].distance.toFixed(1) : 'CLEAR';
            }
            rows.push(row);
          }
        }
      }
      return rows;
    }, ELEVS);
  }

  /* ── 2. walls, at each stop ─────────────────────────────────────────── */
  if (doing('walls')) {
    result.walls = [];
    for (const t of [0.02, 0.2, 0.4, 0.6, 0.8, 0.95]) {
      await ready();
      const r = await page.evaluate((t) => {
        const T = window.__THREE;
        const s = window.__scene;
        s.goTo(t); s.setYaw(0); s.setPitch(0); s.warp(2.0);
        s.setPaused(true); s.renderOnce();

        const cam = s.camera;
        const targets = [];
        s.scene.traverse((o) => { if (o.isMesh && o.visible) targets.push(o); });
        const rc = new T.Raycaster();
        rc.far = 120;

        const cv = s.renderer.domElement;
        const off = document.createElement('canvas');
        off.width = cv.width; off.height = cv.height;
        const ctx = off.getContext('2d');
        ctx.drawImage(cv, 0, 0);

        // Average an 11 px patch around a projected world point.
        const sample = (p) => {
          const v = p.clone().project(cam);
          if (v.z > 1 || Math.abs(v.x) > 0.97 || Math.abs(v.y) > 0.97) return null;
          const px = Math.round((v.x * 0.5 + 0.5) * cv.width);
          const py = Math.round((-v.y * 0.5 + 0.5) * cv.height);
          const d = ctx.getImageData(Math.max(0, px - 5), Math.max(0, py - 5), 11, 11).data;
          let r = 0, g = 0, b = 0, n = 0;
          for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
          return { px, py, rgb: [r / n, g / n, b / n] };
        };

        /* Aim a little down the street rather than straight across, so the hit
         * is a wall the camera can actually see rather than one 90 degrees off
         * the view axis and outside a 45-degree frame. */
        const out = { t, pos: [+cam.position.x.toFixed(2), +cam.position.z.toFixed(1)] };
        for (const [name, sx] of [['sunL', -1], ['shadeR', 1]]) {
          for (const y of [3.0, 6.0, 9.0, 12.0]) {
            const o = new T.Vector3(cam.position.x, y, cam.position.z);
            const dir = new T.Vector3(sx * 0.42, 0, -1).normalize();
            rc.set(o, dir);
            const hits = rc.intersectObjects(targets, false).filter((h) => h.distance > 2);
            if (!hits.length) continue;
            const p = hits[0].point;
            const sm = sample(p);
            if (!sm) continue;
            out[`${name}${y}`] = {
              world: [+p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(1)],
              dist: +hits[0].distance.toFixed(1), ...sm,
            };
          }
        }
        s.setPaused(false);
        return out;
      }, t);
      result.walls.push(r);
    }
  }

  /* ── 3. the irradiance meter ────────────────────────────────────────── */
  if (doing('pools')) {
    await ready();
    result.pools = await page.evaluate(({ Z0, Z1, DZ }) => {
      const T = window.__THREE;
      const s = window.__scene;
      s.setDriven(true);
      s.step(0.016);
      window.__sys5.freeze(0);
      // Negative gain: the red channel as a grey, so the inverse is exact.
      window.__sys5.mirror(-1.0);

      const cam = s.camera;
      const saveP = cam.position.clone(), saveQ = cam.quaternion.clone();
      const saveFov = cam.fov;
      cam.fov = 8; cam.updateProjectionMatrix();      // a spot meter, not a frame

      const buf = new Uint8Array(4);
      const ctx = s.renderer.getContext();

      const meter = (x, z) => {
        cam.position.set(x, 2.0, z);
        cam.quaternion.setFromEuler(new T.Euler(-Math.PI / 2, 0, 0, 'YXZ'));
        cam.updateMatrixWorld();
        s.renderer.render(s.scene, cam);
        const w = s.renderer.domElement.width, h = s.renderer.domElement.height;
        ctx.readPixels((w >> 1), (h >> 1), 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, buf);
        return [buf[0], buf[1], buf[2]];
      };

      /* Three lanes: the crown of the road, and one on each footway. The
       * footway x comes from the lamp columns, which is where the fixtures
       * actually are. */
      const lampX = window.__sys5.dump().pt.slice(0, 7).map((p) => p.pos[0]);
      const xL = Math.min(...lampX), xR = Math.max(...lampX);

      const rows = [];
      for (let z = Z0; z >= Z1; z -= DZ) {
        rows.push({
          z: +z.toFixed(1),
          centre: meter(0, z),
          walkL: meter(xL, z),
          walkR: meter(xR, z),
        });
      }

      window.__sys5.mirror(0);
      cam.fov = saveFov; cam.updateProjectionMatrix();
      cam.position.copy(saveP); cam.quaternion.copy(saveQ);
      s.setDriven(false);
      window.__sys5.run();
      return { xL: +xL.toFixed(2), xR: +xR.toFixed(2), rows };
    }, { Z0, Z1, DZ });
  }

  result.shaderErrors = await readShaderErrors();
  fs.mkdirSync('tmp', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
  console.log(`  → ${OUT}`);

  /* ── report ─────────────────────────────────────────────────────────── */
  if (result.shadow) {
    console.log('\n── does the sun reach the frontage? (clear = unobstructed to the sun)');
    for (const side of ['left', 'right']) {
      const rows = result.shadow.filter((r) => r.side === side);
      if (!rows.length) continue;
      // Lowest height that is clear, per elevation, over all z sampled.
      console.log(`  ${side} frontage:`);
      const head = ELEVS.map((e) => String(e).padStart(6)).join('');
      console.log(`    y \\ elev${head}`);
      for (const y of [2, 4, 6, 8, 10, 12, 14, 16]) {
        const at = rows.filter((r) => r.y === y);
        if (!at.length) continue;
        const cells = ELEVS.map((e) => {
          const n = at.filter((r) => r.clear[e] === 'CLEAR').length;
          const away = at.filter((r) => r.clear[e] === 'facing-away').length;
          return (away === at.length ? '—' : `${n}/${at.length}`).padStart(6);
        }).join('');
        console.log(`    ${String(y).padStart(4)}m  ${cells}`);
      }
    }
  }

  if (result.walls) {
    console.log('\n── frontages, display counts and B/R');
    for (const w of result.walls) {
      const parts = [];
      for (const k of Object.keys(w)) {
        if (k === 't' || k === 'pos') continue;
        const c = w[k].rgb;
        parts.push(`${k} (${c.map((v) => v.toFixed(0).padStart(3)).join(',')}) B/R ${(c[2] / Math.max(c[0], 1)).toFixed(2)}`);
      }
      console.log(`  t=${w.t} z=${w.pos[1]}`);
      for (const p of parts) console.log(`      ${p}`);
    }
  }

  if (result.pools) {
    const lin = (c) => invert(c, { sensor: true });
    console.log(`\n── lamp irradiance on the ground (mirror gain 1), lanes x=${result.pools.xL} / 0 / ${result.pools.xR}`);
    const series = {};
    for (const lane of ['centre', 'walkL', 'walkR']) {
      series[lane] = result.pools.rows.map((r) => ({ z: r.z, E: lin(r[lane][0]) }));
    }
    for (const lane of ['centre', 'walkL', 'walkR']) {
      const v = series[lane];
      const mx = Math.max(...v.map((p) => p.E)), mn = Math.min(...v.map((p) => p.E));
      console.log(`  ${lane.padEnd(7)} peak ${mx.toFixed(4)}  floor ${mn.toFixed(4)}  ratio ${(mn / Math.max(mx, 1e-9)).toFixed(3)}`);
    }
    // Local maxima and the minimum between each adjacent pair, per lane.
    for (const lane of ['centre', 'walkL', 'walkR']) {
      const v = series[lane];
      const peaks = [];
      for (let i = 1; i < v.length - 1; i++) {
        if (v[i].E > v[i - 1].E && v[i].E >= v[i + 1].E && v[i].E > 0.005) peaks.push(i);
      }
      console.log(`  ${lane}: ${peaks.length} pools`);
      for (let k = 0; k + 1 < peaks.length; k++) {
        const a = peaks[k], b = peaks[k + 1];
        let lo = a;
        for (let i = a; i <= b; i++) if (v[i].E < v[lo].E) lo = i;
        console.log(`      z ${String(v[a].z).padStart(6)} (E ${v[a].E.toFixed(4)}) →` +
          ` ${String(v[b].z).padStart(6)} (E ${v[b].E.toFixed(4)})   ` +
          `min at z ${String(v[lo].z).padStart(6)} = ${v[lo].E.toFixed(4)}` +
          `   ${(100 * v[lo].E / Math.min(v[a].E, v[b].E)).toFixed(1)}% of the dimmer pool`);
      }
    }
  }
});

finish(process.exitCode || 0);
