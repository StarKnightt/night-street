/* The shaft instrument. Answers "where is the marched air, and can the shadow
 * map see it", with a world position attached to every number.
 *
 * ── Why this exists rather than another region-mean table ─────────────────
 *
 * tools/atmo.mjs reports ten named regions and its own output shows that at
 * least four of the names are wrong about what they sample: `farBuild` marches
 * to 16.8 m and `midBuild` to 42.1, so the far one is the near one; `airHigh`
 * stops on geometry at 5.2 m and contains no open air at all; `sky` is a
 * building at 79.6 m, which NOTES.md already records. Three separate wrong
 * conclusions in one session came out of exactly this, so nothing here is
 * named for what it is believed to be. Every row prints the world position and
 * the marched depth of the sample it is describing, and the region names are
 * derived from the depth rather than asserted.
 *
 * ── What it measures ──────────────────────────────────────────────────────
 *
 * The shadow-frustum coverage question is answered on the CPU, from the live
 * scene, by reproducing the march's own arithmetic: the same ray
 * reconstruction as pipeline.ts's setRayUniforms, the same stop distance as
 * the shader, the same `inside` test as sunVisible, against the very
 * `light.shadow.matrix` the pass copies into its uniform. It needs no shader
 * edit and it cannot be fooled by one, which makes it the independent check on
 * the debug channel rather than a second reading of it.
 *
 *   node tools/shafts.mjs [--t 0.4] [--yaw 0] [--pitch -0.22] [--steps 48]
 */
import { run } from './harness.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

/* Several stops per boot. Boot is 35-40 s and a measurement is under a
 * second, so a tool that takes one stop spends 98 per cent of its life
 * starting Chromium, and the temptation is then to draw a conclusion from one
 * viewpoint. `--stops t:yaw:pitch,...` */
const STOPS = String(arg('stops', `${arg('t', 0.4)}:${arg('yaw', 0)}:${arg('pitch', -0.22)}`))
  .split(',').map((s) => {
    const [t, yaw, pitch] = s.split(':').map(Number);
    return { t, yaw: yaw || 0, pitch: pitch === undefined || Number.isNaN(pitch) ? -0.22 : pitch };
  });
const STEPS = Number(arg('steps', 48));

/* Sample points in screen uv, bottom-left origin — the march's own convention
 * and `readRenderTargetPixels`'s, so no flip is applied anywhere in this file.
 * `tools/atmo.mjs` passes `1 - v` because its regions are in canvas
 * (top-left) coordinates; copying that flip here put every GPU reading on the
 * mirrored point, and the only reason it was caught in minutes is that the
 * debug channel reports the world position it sampled. Named for where they
 * are on the screen, not for what is believed to be there. */
const PTS = {
  'lo-left':   [0.20, 0.18],
  'lo-mid':    [0.50, 0.18],
  'lo-right':  [0.80, 0.18],
  'mid-left':  [0.20, 0.42],
  'mid-mid':   [0.50, 0.42],
  'mid-right':  [0.80, 0.42],
  'hi-mid':    [0.50, 0.62],
  'hi-right':  [0.80, 0.62],
  'sunward':   [0.66, 0.50],
  'up':        [0.50, 0.85],
};

await run({ width: 1600, height: 900 }, async ({ page, readShaderErrors }) => {
 for (const stop of STOPS) {
  const { t, yaw, pitch } = stop;
  const out = await page.evaluate(({ t, yaw, pitch, STEPS, PTS }) => {
    const s = window.__scene;
    const T = window.__THREE;
    if (!s || !T) return { error: 'window.__scene / __THREE missing' };
    s.goTo(t); s.setYaw(yaw); s.setPitch(pitch); s.warp(1.5);
    s.setPaused(true);
    s.renderOnce();

    /* The same search volumetric.ts's findSun does, deliberately duplicated
     * as an assertion: if this picks a different light from the pass, the
     * whole report is about the wrong sun and should say so loudly. */
    let sun = null;
    s.scene.traverse((o) => {
      if (!o.isDirectionalLight || !o.castShadow) return;
      if (!sun || o.intensity > sun.intensity) sun = o;
    });
    if (!sun) return { error: 'no shadow-casting directional light in the scene' };

    const lp = sun.getWorldPosition(new T.Vector3());
    const tp = sun.target.getWorldPosition(new T.Vector3());
    const dir = lp.clone().sub(tp).normalize();
    const sc = sun.shadow.camera;
    const rt = sun.shadow.map;

    const cam = s.camera;
    const tan = Math.tan((cam.fov * Math.PI) / 360);
    const halfH = tan, halfW = tan * cam.aspect;
    const e = cam.matrixWorld.elements;
    const rx = new T.Vector3(e[0], e[1], e[2]);
    const ry = new T.Vector3(e[4], e[5], e[6]);
    const rz = new T.Vector3(e[8], e[9], e[10]);
    const r00 = rz.clone().multiplyScalar(-1)
      .addScaledVector(rx, -halfW).addScaledVector(ry, -halfH);
    const dX = rx.clone().multiplyScalar(2 * halfW);
    const dY = ry.clone().multiplyScalar(2 * halfH);

    const M = sun.shadow.matrix;
    const v4 = new T.Vector4();

    /* The march's own census of its samples, read out of the debug channel:
     * mode 2 is (inside, litByMap, gapLit) averaged over the march, mode 3 is
     * the world position of the middle sample. Mode 3 is what makes every row
     * below self-describing — a probe that cannot say where it looked has
     * produced three wrong conclusions in this project already. */
    const modes = {};
    for (const m of [1, 2, 3]) {
      window.__vol.debug = m;
      s.renderOnce();
      modes[m] = Object.fromEntries(Object.entries(PTS).map(
        ([n, [u, v]]) => [n, window.__vol.probe(u, v)]));
    }
    window.__vol.debug = 0;
    s.renderOnce();

    const rows = [];
    for (const [name, [u, v]] of Object.entries(PTS)) {
      const ray = r00.clone().addScaledVector(dX, u).addScaledVector(dY, v);
      const rayLen = ray.length();
      const dirW = ray.clone().divideScalar(rayLen);
      const p = window.__vol && window.__vol.probe ? window.__vol.probe(u, v) : null;
      const vz = p ? p.vz : 0;
      const far = Math.min(vz * rayLen, 140);

      let nIn = 0;
      const samples = [];
      for (let i = 0; i < STEPS; i++) {
        const tt = ((i + 0.5) / STEPS) * far;
        const w = cam.position.clone().addScaledVector(dirW, tt);
        v4.set(w.x, w.y, w.z, 1).applyMatrix4(M);
        const sx = v4.x / v4.w, sy = v4.y / v4.w, sz = v4.z / v4.w;
        const ex = Math.min(sx, 1 - sx), ey = Math.min(sy, 1 - sy);
        const edge = Math.min(ex, ey);
        const inside = edge <= 0 ? 0 : Math.min(1, edge / 0.05);
        if (inside > 0 && sz <= 1) nIn++;
        if (i === 0 || i === (STEPS >> 1) || i === STEPS - 1) {
          samples.push({
            i, t: +tt.toFixed(2),
            w: [+w.x.toFixed(2), +w.y.toFixed(2), +w.z.toFixed(2)],
            s: [+sx.toFixed(4), +sy.toFixed(4), +sz.toFixed(4)],
            inside: +inside.toFixed(3),
          });
        }
      }
      rows.push({
        name, u, v, vz: +vz.toFixed(1), far: +far.toFixed(1),
        frac: nIn / STEPS, samples,
        march: p ? [p.r, p.g, p.b] : null,
        integrals: modes[1][name], census: modes[2][name], mid: modes[3][name],
      });
    }

    /* The eight corners of the shadow ortho box, in world, so the report can
     * say where the map actually is rather than what its width is. */
    const inv = new T.Matrix4().copy(M).invert();
    const corners = [];
    for (const cx of [0, 1]) for (const cy of [0, 1]) for (const cz of [0, 1]) {
      const q = new T.Vector4(cx, cy, cz, 1).applyMatrix4(inv);
      corners.push([+(q.x / q.w).toFixed(1), +(q.y / q.w).toFixed(1), +(q.z / q.w).toFixed(1)]);
    }
    const ext = [0, 1, 2].map((i) => [
      +Math.min(...corners.map((c) => c[i])).toFixed(1),
      +Math.max(...corners.map((c) => c[i])).toFixed(1),
    ]);

    s.setPaused(false);
    return {
      cam: [+cam.position.x.toFixed(2), +cam.position.y.toFixed(2), +cam.position.z.toFixed(2)],
      light: {
        pos: [+lp.x.toFixed(2), +lp.y.toFixed(2), +lp.z.toFixed(2)],
        target: [+tp.x.toFixed(2), +tp.y.toFixed(2), +tp.z.toFixed(2)],
        dir: [+dir.x.toFixed(4), +dir.y.toFixed(4), +dir.z.toFixed(4)],
        intensity: sun.intensity,
        frustum: { l: sc.left, r: sc.right, t: sc.top, b: sc.bottom, n: sc.near, f: sc.far },
        mapSize: [sun.shadow.mapSize.x, sun.shadow.mapSize.y],
        map: rt ? { w: rt.width, h: rt.height, depthTexture: !!rt.depthTexture } : null,
      },
      ext, rows,
      gap: window.__vol && window.__vol.gap ? window.__vol.gap : null,
      shadow: window.__vol ? window.__vol.shadow : null,
      follow: window.__vol && window.__vol.follow ? window.__vol.follow : null,
    };
  }, { t, yaw, pitch, STEPS, PTS });

  if (out.error) { console.error('  ' + out.error); return; }

  console.log('\n' + '─'.repeat(78));
  const L = out.light;
  console.log(`\n  camera ${out.cam.join(', ')}   t=${t} yaw=${yaw} pitch=${pitch}`);
  console.log(`  sun    pos ${L.pos.join(', ')}  target ${L.target.join(', ')}`);
  console.log(`         dir ${L.dir.join(', ')}  intensity ${L.intensity}`);
  console.log(`  shadow camera  l/r ${L.frustum.l}/${L.frustum.r}  t/b ${L.frustum.t}/${L.frustum.b}`
    + `  near/far ${L.frustum.n}/${L.frustum.f}  map ${L.mapSize.join('x')}`
    + `  depthTexture=${L.map ? L.map.depthTexture : '-'}`);
  console.log(`  the frustum's world bounds:  x ${out.ext[0].join(' .. ')}`
    + `   y ${out.ext[1].join(' .. ')}   z ${out.ext[2].join(' .. ')}`);
  if (out.gap) {
    console.log(`  gapLit planes: n=(${out.gap.nx.toFixed(4)}, ${out.gap.nz.toFixed(4)})`
      + `  slabs ${out.gap.slabs.map((s) => `[${s[0].toFixed(2)}, ${s[1].toFixed(2)}]`).join('  ')}`);
  }

  if (out.follow) {
    const f = out.follow;
    console.log(`  sun follower: renders=${f.renders} correction on this frame=${f.moved.toFixed(3)} m`
      + `  anchor=(${f.anchor.map((x) => x.toFixed(2)).join(', ')})`
      + (f.offsets ? `  learned light offset ${f.offsets.light.map((x) => x.toFixed(2)).join(', ')}`
        + ` target ${f.offsets.target.map((x) => x.toFixed(2)).join(', ')}` : '  offsets not learned'));
  }

  /* Two independent readings of the same question side by side, on purpose.
   * `insideCPU` is this tool reproducing the shader's frustum test against the
   * live shadow matrix; `insideGPU` is the march's own census of the same test
   * read out of its debug channel. They are computed by different code from
   * different data paths, so agreement is evidence and disagreement localises
   * the fault to the instrument or to the pass rather than leaving it open. */
  console.log('\n  per screen point. midWorld is the march\'s own middle sample, read out of'
    + ' the pass;\n  every other number on the row is about that ray.');
  console.log('    point       uv         vz    far  insideCPU insideGPU  litMap  gapLit'
    + '   shSharp   shSoft  airlight   midWorld');
  for (const r of out.rows) {
    const c = r.census, i = r.integrals, m = r.mid;
    console.log(`    ${r.name.padEnd(10)} ${r.u.toFixed(2)},${r.v.toFixed(2)}`
      + ` ${String(r.vz).padStart(6)} ${String(r.far).padStart(6)}`
      + ` ${(r.frac * 100).toFixed(0).padStart(8)}% ${(c.r * 100).toFixed(0).padStart(8)}%`
      + ` ${c.g.toFixed(3).padStart(7)} ${c.b.toFixed(3).padStart(7)}`
      + ` ${i.r.toFixed(5).padStart(9)} ${i.g.toFixed(5).padStart(8)} ${i.b.toFixed(5).padStart(9)}`
      + `   ${m.r.toFixed(1)}, ${m.g.toFixed(1)}, ${m.b.toFixed(1)}`);
  }

  if (process.argv.includes('--walk')) {
    console.log('\n  shadow-frustum walk, three samples per ray (world xyz -> shadow uvz)');
    for (const r of out.rows) {
      console.log(`    ${r.name}`);
      for (const sm of r.samples) {
        console.log(`      t=${String(sm.t).padStart(6)}  (${sm.w.map((x) => String(x).padStart(7)).join(',')} )`
          + ` -> (${sm.s.map((x) => x.toFixed(4).padStart(8)).join(',')} )  inside=${sm.inside}`);
      }
    }
  }
 }

  const errs = await readShaderErrors();
  console.log(`\n  shader errors: ${errs.length}`);
  if (errs.length) console.log(errs.slice(0, 3).join('\n'));
  console.log('');
});
