/* Look through the sun's shadow camera.
 *
 *   node tools/withlock.mjs shadowview -- node tools/shadowview.mjs --t 0.4,0.9
 *
 * ── Why this and not more arithmetic ──────────────────────────────────────
 *
 * "Is the caster in the depth pass?" has been answered three ways in this
 * project by reasoning about extents, and `poolshade`'s frustum test — which
 * projects a point into the shadow camera and checks the clip box — answers a
 * *weaker* question than it looks like it answers. It tests the six planes. It
 * does not test frustum culling of the object, does not test whether the mesh
 * carries `castShadow`, and cannot see a caster that is missing for any other
 * reason. A point can be inside the clip box of a depth pass that contains
 * nothing.
 *
 * The depth pass draws the scene through `light.shadow.camera` with the same
 * culling the colour pass uses. So drawing the scene through that same camera,
 * in colour, shows what the depth pass has to work with — including the parts
 * that were culled — and it shows it as a picture rather than as six numbers.
 *
 * It also makes the coverage visible directly: the frame *is* the shadow map's
 * footprint, so how much of the street is in the box is something you look at
 * rather than something you compute.
 *
 * Every extent, the snap grid and the light's placement are read off the live
 * light. Nothing here is transcribed from `Street.tsx`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, finish } from './harness.mjs';
import { checkLive, formatLiveness } from './liveness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const STOPS = flag('t', '0.4,0.9').split(',').map(Number).filter((n) => !Number.isNaN(n));
/* Explicit viewpoints, as `x,y,z` separated by `|`, looking straight down —
 * the arrangement `poolshade` probes from. Its disagreements are the thing
 * being diagnosed and the box has to be inspected from the camera that
 * produced them, not from a walk stop several metres away. */
const ATS = (flag('at', '') || '').split('/').filter(Boolean).map((s) => s.split(',').map(Number));
const OUT = path.join(ROOT, flag('out', 'shots/shadowview'));
const W = +flag('w', 1200), H = +flag('h', 1200);

/* Ground points to locate in the box, so the picture has coordinates on it.
 * The far end of the street, the near end, and the stretch poolshade found
 * disagreeing. */
const PROBES = [[0, 0, -20], [0, 0, -40], [0, 0, -60], [0, 0, -75], [0, 0, -83],
  [0, 0, -91], [0, 0, -98], [5.9, 8, -90], [5.9, 8, -100]];

/* The stretch of canyon the box is asked to cover, as
 * [half-width in x, metres ahead of the camera, height, metres behind].
 *
 * Ahead: the haze closes the street at `FogExp2` 0.0072, which leaves a
 * surface at 80 m still 72 per cent visible and one at 100 m about half. The
 * built street ends at z -105 or so. 80 m ahead therefore covers everything a
 * walker can read.
 *
 * Behind: 25 m, which is what the current box happens to reach behind its
 * target and is enough for turning round; past that the canyon has closed.
 *
 * Sideways: 12 m puts the whole canyon plus the depth of the frontages in,
 * without paying for the apron behind the terrace, which is not visible from
 * the street and is in permanent shade anyway.
 */
const CORRIDOR = (flag('corridor', '12,80,24,25')).split(',').map(Number);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const rows = [];

await run({ width: W, height: H }, async ({ page, readShaderErrors }) => {
  await page.waitForFunction(() => !!window.__scene, null, { timeout: 120_000 });

  const plan = [...STOPS.map((t) => ({ t, at: null })), ...ATS.map((at) => ({ t: null, at }))];

  for (const { t, at } of plan) {
    const shot = await page.evaluate(([t, at, PROBES, CORRIDOR]) => {
      const T = window.__THREE;
      const s = window.__scene;
      s.setPaused(true);
      if (at) {
        s.camera.position.set(at[0], at[1], at[2]);
        s.camera.quaternion.setFromEuler(new T.Euler(-Math.PI / 2, 0, 0, 'YXZ'));
        s.camera.updateMatrixWorld();
      } else {
        s.goTo(t);
      }
      /* The normal frame first, through the walk camera. This is the render
       * that places the box — `sunFollow` runs from `scene.onBeforeRender`, so
       * the arrangement below is the one this frame was drawn with and not one
       * left over from an animation frame. */
      /* `renderOnce()` re-applies the walker's own camera placement, so it
       * would undo an explicit viewpoint. Render straight through in that
       * case; `scene.onBeforeRender` — and therefore `sunFollow` — runs
       * either way, which is the part that matters. */
      if (at) s.renderer.render(s.scene, s.camera); else s.renderOnce();
      const beauty = s.renderer.domElement.toDataURL('image/png');

      let sun = null;
      s.scene.traverse((o) => {
        if (o.isDirectionalLight && o.castShadow && (!sun || o.intensity > sun.intensity)) sun = o;
      });
      const sc = sun.shadow.camera;
      sc.updateMatrixWorld();

      const probes = PROBES.map((p) => {
        const q = new T.Vector3(p[0], p[1], p[2]).project(sc);
        return {
          world: p,
          ndc: [+q.x.toFixed(3), +q.y.toFixed(3), +q.z.toFixed(3)],
          in: Math.abs(q.x) <= 1 && Math.abs(q.y) <= 1 && Math.abs(q.z) <= 1,
        };
      });

      /* ── What the corridor actually demands of the box ──────────────────
       *
       * The extents are a fit to the scene, so they are measured off the
       * scene rather than reasoned about. Every mesh's world bounding box is
       * clipped to the stretch of canyon a walker can see from here, and the
       * corners of what survives are accumulated in light space.
       *
       * Two bases, because the choice between them is the decision:
       *
       *   level    three's default. `lookAt` with world up, so the box's
       *            horizontal axis is horizontal and its vertical axis is
       *            within 12 degrees of world up. Both axes then pick up a
       *            component of street length — 0.574 and 0.170 per metre —
       *            so walking down the street spends both of them.
       *   aligned  rolled so one axis runs along the street and the other
       *            spans the canyon's cross-section. The cross-section axis
       *            comes out with no z component at all, so street length is
       *            spent by one axis only.
       *
       * Casters are not accumulated and do not need to be: a caster lies on
       * the shadow ray through the point it shades, so it has the *same* u
       * and v as its receiver by construction. It costs depth and nothing
       * else, which is why the near plane is reported separately below.
       */
      const fit = (() => {
        const s3 = new T.Vector3().subVectors(sun.position, sun.target.position).normalize();
        const mk = (up) => {
          const x = new T.Vector3().crossVectors(up, s3).normalize();
          return { u: x, v: new T.Vector3().crossVectors(s3, x).normalize() };
        };
        // The street axis, projected into the plane perpendicular to the sun.
        const axis = new T.Vector3(0, 0, -1);
        const along = axis.clone().addScaledVector(s3, -axis.dot(s3)).normalize();
        const bases = {
          level: mk(new T.Vector3(0, 1, 0)),
          aligned: mk(new T.Vector3().crossVectors(s3, along).normalize()),
        };

        const c = s.camera.position;
        const lo = new T.Vector3(-CORRIDOR[0], -3, c.z - CORRIDOR[1]);
        const hi = new T.Vector3(CORRIDOR[0], CORRIDOR[2], c.z + CORRIDOR[3]);
        const clip = new T.Box3(lo, hi);

        const acc = {};
        for (const k of Object.keys(bases)) acc[k] = { u: [1e9, -1e9], v: [1e9, -1e9] };
        const w = [1e9, -1e9];
        let boxes = 0;
        const bb = new T.Box3();
        const p = new T.Vector3();
        s.scene.traverse((o) => {
          if (!o.isMesh || !o.visible || !o.geometry) return;
          if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
          bb.copy(o.geometry.boundingBox).applyMatrix4(o.matrixWorld);
          if (!bb.intersectsBox(clip)) return;
          bb.intersect(clip);
          boxes++;
          for (let i = 0; i < 8; i++) {
            p.set(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z);
            p.sub(sun.target.position);
            for (const k of Object.keys(bases)) {
              const a = acc[k];
              const du = p.dot(bases[k].u), dv = p.dot(bases[k].v);
              if (du < a.u[0]) a.u[0] = du; if (du > a.u[1]) a.u[1] = du;
              if (dv < a.v[0]) a.v[0] = dv; if (dv > a.v[1]) a.v[1] = dv;
            }
            const dw = p.dot(s3);
            if (dw < w[0]) w[0] = dw; if (dw > w[1]) w[1] = dw;
          }
        });
        const round = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'number' ? +v.toFixed(2) : v)));
        return round({ boxes, corridor: CORRIDOR, acc, w });
      })();

      /* ── What one texel is worth on the ground ──────────────────────────
       *
       * The obvious density — box width over map width — is the spacing along
       * the *frustum's own axes*, and it is not what a shadow edge on the
       * road is quantised by. Those axes are tilted with respect to the
       * ground by however the box is rolled and by how low the sun is, so a
       * texel lands on the road as a parallelogram that can be several times
       * its nominal size. Rolling the box changes that projection, which
       * means the two configurations cannot be compared on the nominal
       * figure at all: it would credit the roll with a density it does not
       * deliver.
       *
       * So measure it. Take a point on the road, differentiate the live
       * shadow camera's own projection with respect to world x and z, and
       * invert: the columns of the inverse are the world displacements that
       * move exactly one texel. No basis is reconstructed here and no extent
       * is transcribed — it is the same `project` the depth pass samples
       * through.
       */
      const footprint = (() => {
        const g = new T.Vector3(0, 0, s.camera.position.z - 10);
        const h = 0.05;
        const toTexels = (p) => {
          const q = p.clone().project(sc);
          return [(q.x * sun.shadow.mapSize.x) / 2, (q.y * sun.shadow.mapSize.y) / 2];
        };
        const b0 = toTexels(g);
        const bx = toTexels(g.clone().setX(g.x + h));
        const bz = toTexels(g.clone().setZ(g.z + h));
        // J maps world (dx, dz) -> (du, dv) in texels.
        const J = [[(bx[0] - b0[0]) / h, (bz[0] - b0[0]) / h],
          [(bx[1] - b0[1]) / h, (bz[1] - b0[1]) / h]];
        const det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
        if (!det) return null;
        const inv = [[J[1][1] / det, -J[0][1] / det], [-J[1][0] / det, J[0][0] / det]];
        const len = (c) => Math.hypot(inv[0][c], inv[1][c]) * 1000;
        return {
          at: [g.x, g.y, +g.z.toFixed(2)],
          // Millimetres of road crossed by one step along each map axis.
          uMm: +len(0).toFixed(2),
          vMm: +len(1).toFixed(2),
          // And how much of that is street length, which is the axis a
          // terminator running across the road is actually sampled along.
          uAlongStreetMm: +Math.abs(inv[1][0] * 1000).toFixed(2),
          vAlongStreetMm: +Math.abs(inv[1][1] * 1000).toFixed(2),
          areaMm2: +Math.abs(1e6 / det).toFixed(0),
        };
      })();

      /* Through the shadow camera. Same scene, same culling, same frame.
       *
       * With the follower detached for the duration, and this is not
       * optional: `sunFollow` re-anchors the box to whatever camera is being
       * rendered, so drawing through the shadow camera makes the box chase
       * its own position and the picture is of somewhere else. The first
       * version of this tool did exactly that and reported a box target 65 m
       * from the camera — which is this project's own bug shape, an
       * instrument that changes the thing it measures. */
      const hook = s.scene.onBeforeRender;
      s.scene.onBeforeRender = () => {};
      s.renderer.render(s.scene, sc);
      const box = s.renderer.domElement.toDataURL('image/png');
      s.scene.onBeforeRender = hook;
      s.setPaused(false);

      return {
        t, at,
        camera: s.camera.position.toArray().map((v) => +v.toFixed(2)),
        light: sun.position.toArray().map((v) => +v.toFixed(2)),
        target: sun.target.position.toArray().map((v) => +v.toFixed(2)),
        extents: [sc.left, sc.right, sc.bottom, sc.top, sc.near, sc.far],
        res: [sun.shadow.mapSize.x, sun.shadow.mapSize.y],
        standoff: +sun.position.distanceTo(sun.target.position).toFixed(2),
        probes, fit, footprint, beauty, box,
      };
    }, [t, at, PROBES, CORRIDOR]);

    const tag = at ? `at${at.join('_')}` : String(Math.round(t * 100)).padStart(2, '0');
    for (const [k, name] of [['beauty', `${tag}-beauty.png`], ['box', `${tag}-box.png`]]) {
      fs.writeFileSync(path.join(OUT, name), Buffer.from(shot[k].split(',')[1], 'base64'));
    }
    delete shot.beauty; delete shot.box;
    rows.push(shot);

    console.log(formatLiveness(await checkLive(page, `shadowview ${tag}`)));
  }

  const errs = await readShaderErrors();
  console.log(`  shaderErrors=${errs.length}`);
});

for (const r of rows) {
  const [l, rr, b, tp, n, f] = r.extents;
  console.log(`\n  t=${r.t}  camera ${r.camera.join(', ')}   box target ${r.target.join(', ')}`);
  console.log(`    extents  u ${l}..${rr}  (${rr - l} m)   v ${b}..${tp}  (${tp - b} m)` +
    `   depth ${n}..${f}  (${f - n} m)   at ${r.res.join('x')},  stand-off ${r.standoff} m`);
  console.log(`    texel    ${((1000 * (rr - l)) / r.res[0]).toFixed(3)} mm on the u axis,` +
    ` ${((1000 * (tp - b)) / r.res[1]).toFixed(3)} mm on v`);
  if (r.footprint) {
    const fp = r.footprint;
    console.log(`    on the road at z=${fp.at[2]}, one texel step crosses`
      + ` ${fp.uMm} mm (u) and ${fp.vMm} mm (v);`
      + ` ${fp.uAlongStreetMm} / ${fp.vAlongStreetMm} mm of that is street length.`
      + `  ${fp.areaMm2} mm² per texel.`);
  }
  for (const p of r.probes) {
    console.log(`    ${p.in ? 'in ' : 'OUT'}  ${String(p.world.join(',')).padEnd(12)} ndc ${p.ndc.join(', ')}`);
  }
  const f2 = r.fit;
  console.log(`    fit over ${f2.boxes} meshes clipped to |x|<=${f2.corridor[0]},` +
    ` ${f2.corridor[1]} m ahead / ${f2.corridor[3]} m behind, up to y=${f2.corridor[2]}:`);
  for (const k of Object.keys(f2.acc)) {
    const a = f2.acc[k];
    console.log(`      ${k.padEnd(8)} u ${String(a.u[0]).padStart(7)} .. ${String(a.u[1]).padStart(7)}` +
      `  (${(a.u[1] - a.u[0]).toFixed(1)} m)   v ${String(a.v[0]).padStart(7)} .. ${String(a.v[1]).padStart(7)}` +
      `  (${(a.v[1] - a.v[0]).toFixed(1)} m)   area ${(((a.u[1] - a.u[0]) * (a.v[1] - a.v[0])) / 1000).toFixed(2)}k m²`);
  }
  console.log(`      depth of those surfaces along the light: ${f2.w[0]} .. ${f2.w[1]} m from the target`);
}
console.log(`\n  → ${path.relative(ROOT, OUT)}`);
await finish(0);
