/* Is the footway the lamp pools land on actually in shade?
 *
 *   node tools/withlock.mjs poolshade -- node tools/poolshade.mjs
 *
 * `tools/sunlamp.mjs` measures the lamps' irradiance through the debug mirror,
 * which overwrites `directDiffuse` outright — so the sun, and therefore the
 * sun's shadow, is not in that number at all and cannot corrupt it. What the
 * mirror cannot tell you is the thing the lamp *level* was actually chosen
 * against: the claim was "peak irradiance 4.02 on the shaded footway", and
 * `poolreport.mjs` converts every irradiance into counts by adding it to
 * `SHADE_L = 0.038` — the shaded carriageway. If the footway under a lantern
 * is in a sun band, that base is an order of magnitude low and the counts are
 * fiction even though the irradiance is exact.
 *
 * So this asks the question two independent ways at each probe point:
 *
 *   geometrically   a raycast from the ground toward the light's own
 *                   direction, which is immune to the shadow-box bug because
 *                   it never touches a rendered pixel;
 *   photometrically the rendered ground with the sun on and with it at zero,
 *                   which is not immune and is therefore the interesting
 *                   comparison to run under `--nofollow`.
 *
 * Every row reports the world position it sampled and the range from the
 * probe camera to the surface it hit, because a meter aimed into the seam
 * between the carriageway and the footway slabs has already produced one
 * wrong lamp conclusion in this project.
 */
import fs from 'node:fs';
import { run, finish } from './harness.mjs';
import { invert } from './agx.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const OUT = flag('out', 'tmp/poolshade.json');

/* The lanes sunlamp.mjs finds for itself, and the z values poolreport singles
 * out: the peaks it calls the pools, and the minima between them. Passed in
 * rather than rediscovered so the two reports describe the same points. */
const LANES = { walkL: -3.2, centre: 0, walkR: 3.2 };
const ZS = [13, 2, -7, -19, -24, -32, -35, -45, -53, -56, -65, -72, -75, -83, -91, -98];

let out = null;

await run({ width: 640, height: 360 }, async ({ page, readShaderErrors }) => {
  await page.waitForFunction(() => !!window.__scene && !!window.__sys5, null, { timeout: 120_000 });

  out = await page.evaluate(({ LANES, ZS }) => {
    const T = window.__THREE;
    const s = window.__scene;
    s.setDriven(true);
    s.step(0.016);
    window.__sys5.freeze(0);

    let sun = null;
    s.scene.traverse((o) => {
      if (o.isDirectionalLight && o.castShadow && (!sun || o.intensity > sun.intensity)) sun = o;
    });
    const dir = sun.position.clone().sub(sun.target.position).normalize();

    const targets = [];
    s.scene.traverse((o) => { if (o.isMesh && o.visible) targets.push(o); });
    const rc = new T.Raycaster();
    const down = new T.Vector3(0, -1, 0);

    const cam = s.camera;
    const saveP = cam.position.clone(), saveQ = cam.quaternion.clone(), saveFov = cam.fov;
    cam.fov = 8; cam.updateProjectionMatrix();
    const gl2 = s.renderer.getContext();
    const buf = new Uint8Array(4);
    const sunI = sun.intensity;

    const shoot = (x, z) => {
      cam.position.set(x, 2.0, z);
      cam.quaternion.setFromEuler(new T.Euler(-Math.PI / 2, 0, 0, 'YXZ'));
      cam.updateMatrixWorld();
      s.renderer.render(s.scene, cam);
      const w = s.renderer.domElement.width, h = s.renderer.domElement.height;
      gl2.readPixels(w >> 1, h >> 1, 1, 1, gl2.RGBA, gl2.UNSIGNED_BYTE, buf);
      return [buf[0], buf[1], buf[2]];
    };

    const rows = [];
    for (const [lane, x] of Object.entries(LANES)) {
      for (const z of ZS) {
        /* Where the ground actually is, and how far the meter is from it. A
         * probe that misses the ground reads the haze behind it and returns a
         * plausible small number; that is on the record as having cost a lamp
         * conclusion once already. */
        rc.set(new T.Vector3(x, 2.0, z), down);
        rc.far = 6;
        const g = rc.intersectObjects(targets, false);
        if (!g.length) { rows.push({ lane, x, z, ground: null }); continue; }
        const p = g[0].point;

        const orig = p.clone().addScaledVector(dir, 0.05);
        rc.set(orig, dir);
        rc.far = 400;
        const blk = rc.intersectObjects(targets, false);

        const lit = shoot(x, z);
        sun.intensity = 0;
        const dark = shoot(x, z);
        sun.intensity = sunI;

        rows.push({
          lane, x, z,
          ground: [+p.x.toFixed(2), +p.y.toFixed(3), +p.z.toFixed(2)],
          range: +g[0].distance.toFixed(3),
          normalY: +(g[0].face ? g[0].face.normal.y : 0).toFixed(3),
          material: g[0].object.material.name || g[0].object.material.type,
          sunReaches: !blk.length,
          blocker: blk.length
            ? { dist: +blk[0].distance.toFixed(2), at: blk[0].point.toArray().map((v) => +v.toFixed(1)) }
            : null,
          rgbLit: lit, rgbNoSun: dark,
        });
      }
    }

    cam.fov = saveFov; cam.updateProjectionMatrix();
    cam.position.copy(saveP); cam.quaternion.copy(saveQ);
    s.setDriven(false);
    window.__sys5.run();
    return { sunDir: dir.toArray().map((v) => +v.toFixed(4)), rows };
  }, { LANES, ZS });

  out.shaderErrors = (await readShaderErrors()).length;
});

if (!out) { console.error('poolshade: the page never reported'); await finish(1); }

fs.mkdirSync('tmp', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));

const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
console.log(`\n  sun direction ${out.sunDir.join(', ')}`);
console.log('  lane     z    ground world           range  sun?    lit   noSun   sun share   L(lit)');
let reach = 0, tot = 0;
for (const r of out.rows) {
  if (!r.ground) { console.log(`  ${r.lane.padEnd(7)} ${String(r.z).padStart(4)}   NO GROUND UNDER THE METER`); continue; }
  tot++; if (r.sunReaches) reach++;
  const a = lum(r.rgbLit), b = lum(r.rgbNoSun);
  const L = invert(a, { sensor: true });
  console.log(`  ${r.lane.padEnd(7)} ${String(r.z).padStart(4)}   ` +
    `${r.ground.join(',').padEnd(20)} ${String(r.range).padStart(5)}  ` +
    `${r.sunReaches ? 'LIT ' : 'sh  '}  ${a.toFixed(0).padStart(4)}  ${b.toFixed(0).padStart(4)}   ` +
    `${(100 * (a - b) / Math.max(a, 1)).toFixed(0).padStart(4)}%   ${L.toFixed(3)}`);
}
console.log(`\n  the sun reaches ${reach} of ${tot} probe points on the footways and crown.`);
console.log(`  shaderErrors=${out.shaderErrors}  → ${OUT}`);
await finish(0);
