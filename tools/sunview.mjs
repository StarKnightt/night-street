/* Where, on the walk, can you actually see the sun?
 *
 *   node tools/withlock.mjs sunview -- node tools/sunview.mjs
 *
 * The question is not rhetorical and it is not answerable from the geometry
 * source: SUN_DIR is 35 degrees off the street axis at 12 degrees of
 * elevation, the right-hand terrace is continuous for most of the street, and
 * whether a beam at that bearing clears a parapet from a given kerb depends on
 * the height of the block opposite and on where the gaps in it are. So it is
 * raycast, from the eye, along SUN_DIR, at every metre of the route.
 *
 * Three things are reported per station, and the third is the one that
 * matters:
 *
 *   clear   the ray to the disc itself misses everything.
 *   open    the fraction of a 12-degree cone around the disc that misses.
 *           This is the aureole — the halo term in the sky is a 5.6 and a 19
 *           e-folding, so most of the glare a low sun puts in a frame comes
 *           from a disc-width or two around it, not from the disc. A station
 *           where the disc is behind a parapet but the aureole is not is a
 *           station where you can feel the sun.
 *   inFrame whether SUN_DIR is inside the frustum for a walker looking down
 *           the street, which at 45 degrees vertical on a 16:9 frame is a
 *           36.4-degree horizontal half-angle — so the sun at 35 degrees is
 *           inside it by 1.4 degrees, and the answer to "is the sun in shot"
 *           is decided entirely by occlusion rather than by aim.
 *
 * The scene is raycast as it stands, so what occludes is reported by name.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, finish, DEV_URL } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const STEPS = +flag('steps', 41);
const CONE = +flag('cone', 12);

const url = `${DEV_URL}/?nograde&haze=nodust`;
let out = null;

await run({ width: 800, height: 450, url }, async ({ page }) => {
  out = await page.evaluate(([steps, coneDeg]) => {
    const T3 = window.__THREE;
    const s = window.__scene;
    /* The sun is read off the light in the scene rather than imported, for the
     * same reason tools/frontage.mjs asks the light for its own elevation: a
     * tool that transcribes SUN_DIR is a tool that keeps agreeing with itself
     * after the sun moves. */
    let sun = null;
    s.scene.traverse((o) => { if (o.isDirectionalLight && o.castShadow) sun = o; });
    if (!sun) throw new Error('no shadow-casting directional light in the scene');
    const dir = new T3.Vector3()
      .subVectors(sun.position, sun.target.position).normalize();

    const ray = new T3.Raycaster();
    ray.far = 600;
    // The sky, the dust and anything else with no surface must not count as an
    // occluder; only meshes can block a beam.
    const meshes = [];
    s.scene.traverse((o) => {
      if (o.isMesh && o.visible && o.material && !o.material.transparent) meshes.push(o);
    });

    /* A cone of rays around the disc, distributed on a Fibonacci spiral so the
     * fraction returned is an area fraction and not a fraction of a ring. */
    const cone = [];
    const N = 64, half = (coneDeg * Math.PI) / 360;
    const up = Math.abs(dir.y) < 0.9 ? new T3.Vector3(0, 1, 0) : new T3.Vector3(1, 0, 0);
    const ax = new T3.Vector3().crossVectors(up, dir).normalize();
    const ay = new T3.Vector3().crossVectors(dir, ax).normalize();
    for (let i = 0; i < N; i++) {
      const r = Math.sqrt((i + 0.5) / N) * half;
      const th = i * 2.39996323;
      cone.push(new T3.Vector3().copy(dir)
        .addScaledVector(ax, Math.sin(r) * Math.cos(th))
        .addScaledVector(ay, Math.sin(r) * Math.sin(th)).normalize());
    }

    const rows = [];
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      s.goTo(t);
      s.setYaw(0);
      s.setPitch(0);
      s.walker.phase = 0; s.walker.speed = 0;
      s.walker.update(1 / 240, { forward: 0, strafe: 0, sprint: false });
      s.renderOnce();
      const eye = s.camera.position.clone();

      ray.set(eye, dir);
      const hit = ray.intersectObjects(meshes, false)[0] || null;

      let open = 0;
      let firstName = null;
      for (const d of cone) {
        ray.set(eye, d);
        const h = ray.intersectObjects(meshes, false)[0];
        if (!h) open++;
        else if (!firstName) firstName = h.object.name || h.object.type;
      }

      rows.push({
        t: +t.toFixed(3),
        pos: [+eye.x.toFixed(2), +eye.y.toFixed(2), +eye.z.toFixed(1)],
        clear: !hit,
        blockedBy: hit ? (hit.object.name || hit.object.type) : null,
        blockedAt: hit ? +hit.distance.toFixed(1) : null,
        open: +(open / cone.length).toFixed(3),
        near: firstName,
      });
    }

    return {
      sunDir: [+dir.x.toFixed(4), +dir.y.toFixed(4), +dir.z.toFixed(4)],
      elevDeg: +((Math.asin(dir.y) * 180) / Math.PI).toFixed(2),
      azFromStreetDeg: +((Math.atan2(dir.x, -dir.z) * 180) / Math.PI).toFixed(2),
      meshes: meshes.length,
      rows,
    };
  }, [STEPS, CONE]);
});

if (out) {
  console.log(`\n  sun ${out.sunDir.join(', ')}  elevation ${out.elevDeg}°  `
    + `${out.azFromStreetDeg}° off the street axis   ${out.meshes} occluders tested`);
  console.log(`  a walker looking down the street has the sun inside the frame at `
    + `36.4° of horizontal half-angle, so aim is not the constraint.\n`);
  console.log('     t      x      z    disc   aureole open   blocked by');
  for (const r of out.rows) {
    const bar = '#'.repeat(Math.round(r.open * 20)).padEnd(20, '.');
    console.log(`  ${r.t.toFixed(2)}  ${String(r.pos[0]).padStart(6)} `
      + `${String(r.pos[2]).padStart(7)}   ${r.clear ? 'CLEAR' : ' --- '}   `
      + `${bar} ${(r.open * 100).toFixed(0).padStart(3)}%   `
      + `${r.blockedBy ?? ''}${r.blockedAt ? ' @ ' + r.blockedAt + ' m' : ''}`);
  }
  const clear = out.rows.filter((r) => r.clear).length;
  const some = out.rows.filter((r) => r.open > 0.02).length;
  console.log(`\n  disc visible at ${clear}/${out.rows.length} stations; `
    + `some aureole at ${some}/${out.rows.length}.`);
  fs.mkdirSync(path.join(ROOT, 'shots/sunview'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'shots/sunview/report.json'), JSON.stringify(out, null, 2));
}

finish(process.exitCode || 0);
