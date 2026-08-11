/* One-shot scene inspection.
 *
 * When a frame comes back wrong the useful question is almost never "what
 * does it look like" but "where is everything and what is it made of". This
 * dumps the graph, the world bounds of every mesh and the camera, which is
 * enough to tell a shading problem from a geometry problem in one run.
 *
 *   node tools/diag.mjs [--js "..."]
 */
import { run, finish } from './harness.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const JS = flag('js', '');

await run({ width: 800, height: 450 }, async ({ page }) => {
  const out = await page.evaluate((js) => {
    const s = window.__scene;
    s.goTo(0.02);
    if (js) new Function('s', js)(s);
    s.renderOnce();

    const THREE = s.renderer.constructor;
    const rows = [];
    s.scene.traverse((o) => {
      const row = { type: o.type, name: o.name, visible: o.visible };
      if (o.isMesh) {
        o.geometry.computeBoundingBox();
        const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
        row.tris = (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
        row.min = [bb.min.x, bb.min.y, bb.min.z].map((v) => +v.toFixed(2));
        row.max = [bb.max.x, bb.max.y, bb.max.z].map((v) => +v.toFixed(2));
        row.mat = o.material.type;
        row.rough = o.material.roughness;
        row.metal = o.material.metalness;
        row.hasMap = !!o.material.map;
        row.frustumCulled = o.frustumCulled;
      }
      if (o.isLight) {
        row.intensity = o.intensity;
        row.pos = [o.position.x, o.position.y, o.position.z];
      }
      rows.push(row);
    });

    const c = s.camera;
    const dir = new (Object.getPrototypeOf(c.position).constructor)();
    c.getWorldDirection(dir);
    return {
      camera: {
        pos: [+c.position.x.toFixed(2), +c.position.y.toFixed(2), +c.position.z.toFixed(2)],
        dir: [+dir.x.toFixed(3), +dir.y.toFixed(3), +dir.z.toFixed(3)],
        fov: c.fov, near: c.near, far: c.far,
      },
      fog: s.scene.fog ? { type: s.scene.fog.type ?? 'fog', density: s.scene.fog.density, color: s.scene.fog.color.getHexString() } : null,
      background: s.scene.background ? s.scene.background.type || 'texture' : null,
      envIntensity: s.scene.environmentIntensity,
      toneMapping: s.renderer.toneMapping,
      exposure: s.renderer.toneMappingExposure,
      rows,
      probe: s.probe(8),
      THREE: typeof THREE,
    };
  }, JS);
  console.log(JSON.stringify(out, null, 2));
});

finish(process.exitCode || 0);
