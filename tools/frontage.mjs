/* Does the sun actually reach the sun-facing frontage, and where does it not?
 *
 *   node tools/frontage.mjs [--out tmp/frontage.json]
 *
 * Three things, in one load, because the first two answer questions the third
 * cannot be trusted without.
 *
 * 1. WHERE THE LIGHT ACTUALLY IS. The elevation is a compile-time constant read
 *    by a dozen modules and by `SunLight` in a file locked to another agent.
 *    "Changing SUN_ELEV moves the light" is an assumption until the light object
 *    is asked, so this reports the DirectionalLight's own elevation and azimuth,
 *    measured off its world position, next to what SUN_DIR says.
 *
 * 2. SHADOW RAYS, NOT PIXELS. tools/sunexp.mjs samples the rendered frame at the
 *    wall, which is the right instrument for colour and the wrong one for reach:
 *    it depends on framing, on the grade, and on whichever atmosphere build
 *    happens to be checked in that hour. Whether the sun arrives at a point is a
 *    geometric question with an exact answer — cast from the point toward the sun
 *    and see what is in the way — and that answer is stable across builds and is
 *    what "the frontage is banded rather than lit" is a claim about.
 *
 *    It also names the blocker, because "shadowed" and "shadowed by the terrace
 *    opposite" are different findings, and only the second one is fixed by
 *    raising the sun.
 *
 * 3. THE COLOUR, ANCHORED TO THOSE POINTS. Reported for the same ladder so the
 *    warm/cool numbers and the reach numbers describe the same wall.
 */
import fs from 'node:fs';
import { run, finish } from './harness.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const OUT = flag('out', 'tmp/frontage.json');

const ZS = [-14, -28, -40, -52, -66, -80];
const YS = [2.5, 5.0, 8.0, 11.0];

await run({ width: 1280, height: 720 }, async ({ page, readShaderErrors }) => {
  await page.waitForFunction(() => !!window.__scene && !!window.__sys5, null, { timeout: 90_000 });

  const out = await page.evaluate(({ ZS, YS }) => {
    const T = window.__THREE;
    const s = window.__scene;

    /* 1. the light itself */
    let lit = null;
    s.scene.traverse((o) => { if (o.isDirectionalLight && !lit) lit = o; });
    const lp = new T.Vector3(), tp = new T.Vector3();
    lit.getWorldPosition(lp);
    lit.target.getWorldPosition(tp);
    const d = lp.clone().sub(tp).normalize();
    const light = {
      elevDeg: +(Math.asin(d.y) * 180 / Math.PI).toFixed(3),
      azimDeg: +(Math.atan2(d.x, -d.z) * 180 / Math.PI).toFixed(3),
      dir: [d.x, d.y, d.z].map((v) => +v.toFixed(5)),
      intensity: lit.intensity,
      colorLinear: [lit.color.r, lit.color.g, lit.color.b].map((v) => +v.toFixed(4)),
      shadowFar: lit.shadow.camera.far,
      shadowTop: lit.shadow.camera.top,
      castShadow: lit.castShadow,
      /* Is the light inside its own shadow box? A light hoisted above
       * shadow-camera-top stops appearing in the depth pass. */
      heightAboveTarget: +(lp.y - tp.y).toFixed(2),
    };

    const targets = [];
    s.scene.traverse((o) => { if (o.isMesh && o.visible) targets.push(o); });

    /* 2 & 3. the ladder */
    const rc = new T.Raycaster();
    const sun = new T.Raycaster();
    sun.far = 400;
    const rows = [];

    for (const z of ZS) {
      /* Stand back so the wall is in frame for the colour sample. */
      s.setPaused(true);
      const cam = s.camera;
      cam.position.set(0, 1.65, z + 10);
      cam.quaternion.setFromEuler(new T.Euler(0, 0, 0, 'YXZ'));
      cam.updateMatrixWorld();
      s.renderer.render(s.scene, cam);
      const cv = s.renderer.domElement;
      const off = document.createElement('canvas');
      off.width = cv.width; off.height = cv.height;
      const ctx = off.getContext('2d');
      ctx.drawImage(cv, 0, 0);

      for (const y of YS) {
        rc.far = 60;
        rc.set(new T.Vector3(0, y, z), new T.Vector3(-1, 0, 0));
        const h = rc.intersectObjects(targets, false);
        if (!h.length) { rows.push({ z, y, wall: null }); continue; }
        const p = h[0].point;

        /* Step off the surface *along the beam*, far enough to clear the
         * facade's own relief. The first attempt at this offset 5 cm toward -X
         * — into the masonry, because this row faces +X and the sun is on that
         * side — and every ray reported a blocker 2 to 28 cm away, which is a
         * sill or a downpipe or the wall itself. 40 cm clears the deepest
         * moulding on this facade and is nothing against the 22 m street. */
        const orig = p.clone().add(d.clone().multiplyScalar(0.40));
        sun.set(orig, new T.Vector3(...d.toArray()));
        const blk = sun.intersectObjects(targets, false);
        const blocker = blk.length
          ? {
            dist: +blk[0].distance.toFixed(2),
            name: blk[0].object.name || '(unnamed)',
            mat: blk[0].object.material.name || blk[0].object.material.type,
            at: [blk[0].point.x, blk[0].point.y, blk[0].point.z].map((v) => +v.toFixed(1)),
          }
          : null;

        let rgb = null, onScreen = false;
        const v = p.clone().project(cam);
        if (v.z <= 1 && Math.abs(v.x) <= 0.96 && Math.abs(v.y) <= 0.96) {
          onScreen = true;
          const px = Math.round((v.x * 0.5 + 0.5) * cv.width);
          const py = Math.round((-v.y * 0.5 + 0.5) * cv.height);
          const q = ctx.getImageData(px - 4, py - 4, 9, 9).data;
          let r = 0, g = 0, b = 0, n = 0;
          for (let i = 0; i < q.length; i += 4) { r += q[i]; g += q[i + 1]; b += q[i + 2]; n++; }
          rgb = [r / n, g / n, b / n].map((k) => +k.toFixed(1));
        }
        rows.push({
          z, y, x: +p.x.toFixed(2), dist: +h[0].distance.toFixed(2),
          mat: h[0].object.material.name || h[0].object.material.type,
          sunReaches: !blocker, blocker, rgb, onScreen,
        });
      }
      s.setPaused(false);
    }
    return { light, rows };
  }, { ZS, YS });

  out.shaderErrors = (await readShaderErrors()).length;
  fs.mkdirSync(OUT.replace(/[^/\\]+$/, '') || '.', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

  const L = out.light;
  console.log(`  DirectionalLight: elevation ${L.elevDeg} deg, azimuth ${L.azimDeg} deg`);
  console.log(`  intensity ${L.intensity}  colour(linear) ${L.colorLinear.join(', ')}` +
    `  castShadow=${L.castShadow}`);
  console.log(`  light sits ${L.heightAboveTarget} m above its target;` +
    ` shadow box top ${L.shadowTop}, far ${L.shadowFar}`);
  console.log('');
  console.log('  sun-facing frontage — does the beam arrive?');
  const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  let reach = 0, tot = 0;
  for (const z of ZS) {
    const rs = out.rows.filter((r) => r.z === z && r.wall !== null);
    const cells = rs.map((r) => {
      tot++; if (r.sunReaches) reach++;
      return (r.sunReaches ? 'LIT ' : 'sh  ') + (r.rgb ? lum(r.rgb).toFixed(0).padStart(3) : ' --');
    });
    const b = rs.find((r) => r.blocker);
    console.log(`  z ${String(z).padStart(4)}  ` + cells.join(' | ') +
      (b ? `    first blocker: ${b.blocker.mat} at ${b.blocker.dist} m` : ''));
  }
  console.log(`\n  y ladder ${YS.join(' / ')} m.  sun reaches ${reach} of ${tot} points.`);
  console.log(`  shaderErrors=${out.shaderErrors}  → ${OUT}`);
});

finish(0);
