/* What the sun does to a frame it is standing in.
 *
 *   node tools/withlock.mjs sunglare -- node tools/sunglare.mjs [tag]
 *
 * tools/sunview.mjs says the disc clears the terrace at five stations on the
 * walk and its aureole reaches twenty-two of forty-one. This measures what
 * arrives at the sensor when it does, at the two stations where the disc
 * itself is clear and at one where it is not, which is the control.
 *
 * Veiling glare is measured the way a lens is measured: as a function of
 * angular distance from the source. A real low sun through a real lens is a
 * large, soft, low-contrast wash — it lifts the black level of the whole
 * frame and it falls off over tens of degrees, and that shape is the
 * difference between glare and a sprite. So the frame is binned into annuli
 * about the sun's own projected position, in degrees, and the black level is
 * read as the first percentile.
 *
 * Bloom is switched at the uniform, on a mounted scene, between two draws of
 * one build. `uBloom` is live and `Bloom.norm` is applied inside the shader,
 * so this measures the veil and not a rebuild. A term that is not wired up
 * reads as exactly 1.000; the ratio column is printed to four places.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture, finish, DEV_URL } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = args[0] && !args[0].startsWith('--') ? args[0] : 'sunglare';
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const W = +flag('w', 1600), H = +flag('h', 900);

/* The stations, from tools/sunview.mjs's raycast rather than from taste.
 * `gap` and `lot` are where the disc is clear of the terrace; `walled` is the
 * control, where it is 10 m of brick away and only the sky is in frame. */
const VIEWS = [
  { name: 'gap', t: 0.40, yaw: 0, pitch: 0.0 },
  { name: 'lot', t: 0.78, yaw: 0, pitch: 0.09 },
  { name: 'walled', t: 0.20, yaw: 0, pitch: 0.0 },
];

/* [uBloom, karis]. The third row is the question this tool was extended to
 * ask: the Karis average was put on the first downsample to stop a single
 * half-float pixel becoming a crawling firefly, and the brightest thing in
 * this scene is not a firefly — it is a two-hundred-pixel solar disc, which is
 * exactly what the veil is supposed to be made of. */
/* [uBloom, karis, gain]. `gain` is the per-octave weight of the pyramid, i.e.
 * the exponent of the point-spread function: 1.0 is 1/theta^2, the veiling
 * glare law, and 0.6 is what shipped. */
const VARIANTS = [[0, 1, 1.0], [0.045, 1, 1.0], [0.045, 0, 1.0], [0.045, 0, 0.6]];

const OUT = path.join(ROOT, 'shots', tag);
fs.mkdirSync(OUT, { recursive: true });
/* `?disc=` scales the painted solar disc and nothing else — see env.ts. It is
 * a reload rather than a knob because the disc is baked into a cube, so a
 * sweep over it is a sweep over loads; the scene is deterministic under
 * nograde and nodust, which is what makes those loads comparable. */
const DISC = flag('disc', null);
const SKY = flag('sky', null);
const url = `${DEV_URL}/?nograde&haze=nodust${DISC === null ? '' : `&disc=${DISC}`}`
  + `${SKY === null ? '' : `&sky=${SKY}`}`;
const report = { tag, when: new Date().toISOString(), url, disc: DISC, views: {} };

await run({ width: W, height: H, url }, async ({ page, readShaderErrors }) => {
  const has = await page.evaluate(() => ({
    grade: !!(window.__grade && window.__grade.uniforms && window.__grade.uniforms.uBloom),
    hdr: !!window.__hdr,
  }));
  console.log(`  uBloom reachable=${has.grade}  __hdr=${has.hdr}`);
  if (!has.grade || !has.hdr) { process.exitCode = 1; return; }

  for (const v of VIEWS) {
    await page.evaluate(([t, yaw, pitch]) => {
      const s = window.__scene;
      if (window.__sys5) window.__sys5.freeze(0);
      s.goTo(t); s.setYaw(yaw); s.setPitch(pitch); s.warp(2.0);
      s.walker.phase = 0; s.walker.speed = 0;
      s.walker.update(1 / 240, { forward: 0, strafe: 0, sprint: false });
    }, [v.t, v.yaw, v.pitch]);
    await page.waitForTimeout(180);

    const rows = [];
    for (const [bloom, karis, gain] of VARIANTS) {
      const m = await page.evaluate(([bl, ka, ga]) => {
        const T3 = window.__THREE;
        const s = window.__scene;
        s.setPaused(true);
        window.__grade.uniforms.uBloom.value = bl;
        window.__bloom.karis = ka;
        window.__bloom.gain = ga;
        s.renderOnce();

        /* Where the sun is on screen, from the light in the scene. Projected
         * from a point a kilometre away along its own direction, so this is
         * the disc's position and not an assumption about the aim. */
        let sun = null;
        s.scene.traverse((o) => { if (o.isDirectionalLight && o.castShadow) sun = o; });
        const dir = new T3.Vector3()
          .subVectors(sun.position, sun.target.position).normalize();
        const far = new T3.Vector3().copy(s.camera.position).addScaledVector(dir, 1000);
        const ndc = far.clone().project(s.camera);
        const behind = new T3.Vector3().copy(dir).dot(
          s.camera.getWorldDirection(new T3.Vector3())) < 0;

        const cv = s.renderer.domElement;
        const ctx = s.renderer.getContext();
        const px = new Uint8Array(cv.width * cv.height * 4);
        ctx.readPixels(0, 0, cv.width, cv.height, ctx.RGBA, ctx.UNSIGNED_BYTE, px);

        /* Degrees per pixel, from the camera's own vertical field of view, so
         * the annuli below are angles and not fractions of a viewport. */
        const degPerPx = s.camera.fov / cv.height;
        const sx = (ndc.x * 0.5 + 0.5) * cv.width;
        const sy = (ndc.y * 0.5 + 0.5) * cv.height;    // GL rows, y up

        const bins = [2, 5, 10, 20, 40, 1e9];
        const sum = bins.map(() => 0), cnt = bins.map(() => 0);
        let blown = 0, hot = 0;
        const lum = [];
        for (let y = 0; y < cv.height; y++) {
          for (let x = 0; x < cv.width; x++) {
            const k = (y * cv.width + x) * 4;
            const l = 0.2126 * px[k] + 0.7152 * px[k + 1] + 0.0722 * px[k + 2];
            lum.push(l);
            if (px[k] >= 254 && px[k + 1] >= 254 && px[k + 2] >= 254) blown++;
            if (l > 250) hot++;
            if (behind) continue;
            const d = Math.hypot(x - sx, y - sy) * degPerPx;
            for (let b = 0; b < bins.length; b++) {
              if (d < bins[b]) { sum[b] += l; cnt[b]++; break; }
            }
          }
        }
        lum.sort((a, b) => a - b);
        const q = (p) => lum[Math.min(lum.length - 1, Math.floor(p * lum.length))];
        const hdr = window.__hdr.rect(0, 0, 1, 1, 0);
        /* The disc's own two degrees, in radiance, kept separate from the
         * frame peak: the brightest pixel in a frame with cars in it is as
         * likely to be a clearcoat glint as the sun, and the two want
         * different fixes. */
        const rad = 2 / degPerPx;
        const disc = window.__hdr.rect(
          (sx - rad) / cv.width, (sy - rad) / cv.height,
          (sx + rad) / cv.width, (sy + rad) / cv.height, 0);
        s.setPaused(false);
        return {
          bloom: bl, karis: ka, gain: ga, norm: window.__bloom.norm,
          sunPx: [+sx.toFixed(0), +sy.toFixed(0)], behind,
          onScreen: !behind && sx > 0 && sx < cv.width && sy > 0 && sy < cv.height,
          annuli: bins.map((b, i) => ({
            deg: b > 1e8 ? 'rest' : b, mean: cnt[i] ? sum[i] / cnt[i] : null, px: cnt[i],
          })),
          p01: q(0.01), p10: q(0.1), median: q(0.5), p99: q(0.99),
          mean: lum.reduce((a, b) => a + b, 0) / lum.length,
          blown, hot, blownPct: (100 * blown) / lum.length,
          radiancePeak: hdr.lum.peak, radianceMean: hdr.mean, peakAt: hdr.peakAt,
          disc: { peak: disc.lum.peak, mean: disc.mean, at: disc.peakAt, rect: disc.rect },
        };
      }, [bloom, karis, gain]);
      rows.push(m);
    }

    const off = rows[0];
    console.log(`\n── ${v.name}  t=${v.t}  sun at pixel ${off.sunPx.join(',')}  `
      + `${off.onScreen ? 'IN FRAME' : off.behind ? 'behind the camera' : 'off the edge'}`);
    console.log(`   scene radiance peak ${off.radiancePeak.toFixed(1)} at pixel `
      + `${off.peakAt.join(',')}  mean ${off.radianceMean.map((x) => x.toFixed(3)).join(',')}`);
    console.log(`   the sun's own 2°: peak ${off.disc.peak.toFixed(1)} at ${off.disc.at.join(',')}`
      + `  mean ${off.disc.mean.map((x) => x.toFixed(2)).join(',')}`);
    const head = rows.map((r) => `b${r.bloom}k${r.karis}g${r.gain}`.padStart(12)).join('');
    console.log(`   annulus  ${head}      px`);
    for (let i = 0; i < off.annuli.length; i++) {
      if (!off.annuli[i].px) continue;
      console.log(`   <${String(off.annuli[i].deg).padStart(4)}°  `
        + rows.map((r) => r.annuli[i].mean.toFixed(2).padStart(12)).join('')
        + `   ${off.annuli[i].px}`);
    }
    const line = (name, get) => console.log(`   ${name.padEnd(8)} `
      + rows.map((r) => get(r).toFixed(2).padStart(12)).join(''));
    line('p01', (r) => r.p01);
    line('p10', (r) => r.p10);
    line('median', (r) => r.median);
    line('clipped', (r) => r.blown);
    line('luma>250', (r) => r.hot);

    report.views[v.name] = { view: v, rows };
    for (const [b, k, g] of VARIANTS) {
      await capture(page, path.join(OUT, `${v.name}-b${b}-g${g}.png`), {
        before: `window.__grade.uniforms.uBloom.value = ${b};`
          + ` window.__bloom.karis = ${k}; window.__bloom.gain = ${g};`,
      });
    }
    await page.evaluate(() => {
      window.__grade.uniforms.uBloom.value = 0.045;
      window.__bloom.karis = 1;
      window.__bloom.gain = 1.0;
    });
  }

  const errs = await readShaderErrors();
  console.log(errs.length ? `\n  SHADER ERRORS: ${errs.length}` : '\n  shader errors: none');
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`  → ${path.relative(ROOT, OUT)}`);
});

finish(process.exitCode || 0);
