/* The whole round, before against after, on one build each.
 *
 *   node tools/withlock.mjs sunfinal -- node tools/sunfinal.mjs --mode before
 *   node tools/withlock.mjs sunfinal -- node tools/sunfinal.mjs --mode after
 *   node tools/sunfinal.mjs --diff
 *
 * Everything this round changed is reachable from a running page, so `before`
 * is not another checkout — it is this build with all four changes put back
 * where they were, which is the only comparison that cannot be a difference in
 * something else. Three of the four are live:
 *
 *   probe    scene.environment  <- window.__env.flat, the PMREM of the
 *            cloudless equirect that shipped.
 *   gain     scene.environmentIntensity <- 0.50.
 *   veil     Bloom.gain <- 0.6, the per-octave weight that shipped.
 *
 * The fourth, the painted disc, is baked into a cube at boot and cannot be
 * switched, so it is a URL: `?disc=` scales SUN_DISC_PEAK, and the scale that
 * reproduces the shipped `exp(-ang*150)*190` is computed below from sun.ts
 * rather than typed. That is why this runs twice.
 *
 * LEVELS is the one thing that cannot be put back — the pyramid is allocated
 * at construction. It does not need to be: at gain 0.6 the three added octaves
 * carry 0.6^6 + 0.6^7 + 0.6^8 = 0.081 of one level's weight against a series
 * summing to 2.49, so under three per cent of the veil, and the veil is 4.5
 * per cent of the frame. The `before` column is within a thousandth of a code
 * value of the six-level build and the disc sweep in tools/sunglare.mjs
 * measured that directly.
 *
 * Unlike skylift and sunglare this loads the page with no flags at all: the
 * grade is on, the dust is on, the tone curve is on. These are the frames a
 * walker sees, and the clipped-pixel count is only meaningful through the
 * transform that would clip them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath } from 'node:url';
import { run, capture, finish, DEV_URL } from './harness.mjs';

register('./ts-hooks.mjs', import.meta.url);
const { SUN_DISC_PEAK, SUN_DISC_EFOLD } = await import('../src/scene/sun.ts');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const W = +flag('w', 1600), H = +flag('h', 900);
const MODE = flag('mode', 'after');
const DIFF = args.includes('--diff');

/* What the sky used to paint, from the deleted literals, expressed as a
 * fraction of what it paints now. The old disc was
 * `exp(-ang * 150.0) * 190.0 * vec3(1.00, 0.80, 0.52)`; the e-folding is
 * unchanged, so the whole of the difference is in the peak, and the red
 * channel carries it because the old tint was red-anchored. */
const SHIPPED_PEAK_RED = 190.0;
const BEFORE_DISC = SHIPPED_PEAK_RED / SUN_DISC_PEAK[0];

/* Six stations.
 *
 * `lot` is the reproduction of the frame the user sent — standing on the
 * carriageway by the vacant lot, sun behind the right-hand block, everything
 * facing the camera shadow-side, which makes it the test of the probe and not
 * of the sun. `gap` and `walled` are the disc clear and the disc buried, from
 * tools/sunview.mjs's raycast rather than from taste.
 *
 * The last three all stand at t = 0.40, which is the middle of the only
 * stretch of the walk where the disc is unoccluded, and differ only in where
 * the head is pointed. `sunward` centres it. `roadinto` and `roadaway` are the
 * same carriageway from the same eye looked at along the sun and against it,
 * which is the only way to ask whether the road does anything directional.
 *
 * The yaw is negative. Looking down the street the disc projects to x = 1561
 * of 1600, i.e. off to the right, so turning to face it is a right turn, and
 * three's yaw increases to the left. This tool had the sign wrong on its first
 * run and photographed the sunlit frontage opposite instead of the sun, which
 * is worth leaving a note about: the frame looked plausible. */
const SUNWARD = -35 * Math.PI / 180;
const VIEWS = [
  { name: 'lot', t: 0.78, yaw: 0, pitch: 0.09 },
  { name: 'gap', t: 0.40, yaw: 0, pitch: 0.0 },
  { name: 'walled', t: 0.20, yaw: 0, pitch: 0.0 },
  { name: 'sunward', t: 0.40, yaw: SUNWARD, pitch: 0.06 },
  { name: 'roadinto', t: 0.40, yaw: SUNWARD, pitch: -0.22 },
  { name: 'roadaway', t: 0.40, yaw: Math.PI + SUNWARD, pitch: -0.22 },
];

/* Anything else on the query string, for attribution runs against the same
 * six stations. `--extra nospec` is materials.ts's road switch: albedo,
 * normals and roughness unchanged, both specular lobes zeroed, which is what
 * turns "the road looks brighter into the sun" into a number for the sheen
 * rather than for the geometry. */
const EXTRA = flag('extra', null);
const VEIL = args.includes('--veil');
const q = [
  MODE === 'before' ? `disc=${BEFORE_DISC.toPrecision(8)}` : null,
  EXTRA,
].filter(Boolean).join('&');
const url = `${DEV_URL}/${q ? '?' + q : ''}`;

const OUT = path.join(ROOT, 'shots', `sunfinal-${MODE}${EXTRA ? '-' + EXTRA : ''}`);

if (DIFF) {
  const load = (m) => JSON.parse(
    fs.readFileSync(path.join(ROOT, 'shots', `sunfinal-${m}`, 'report.json'), 'utf8'));
  const a = load('before'), b = load('after');
  console.log(`\n  before ${a.when}   ${a.url}`);
  console.log(`  after  ${b.when}   ${b.url}\n`);
  console.log('   station     radiance lum     x      median8   p10   p90   clipped  luma>250');
  for (const v of VIEWS) {
    const A = a.views[v.name], B = b.views[v.name];
    if (!A || !B) continue;
    const r = B.radLum / Math.max(1e-9, A.radLum);
    const f = (x, w = 6, d = 1) => x.toFixed(d).padStart(w);
    console.log(`   ${v.name.padEnd(9)} before ${f(A.radLum, 9, 3)}          `
      + `${f(A.median, 6)} ${f(A.p10, 5)} ${f(A.p90, 5)} ${f(A.blown, 9, 0)} ${f(A.hot, 9, 0)}`);
    console.log(`   ${' '.repeat(9)} after  ${f(B.radLum, 9, 3)}  ${f(r, 5, 3)}x  `
      + `${f(B.median, 6)} ${f(B.p10, 5)} ${f(B.p90, 5)} ${f(B.blown, 9, 0)} ${f(B.hot, 9, 0)}`
      + `${r === 1 ? '   <- INERT' : ''}`);
    console.log(`   ${' '.repeat(9)} shadow-side tiles (row 0 road, row 1 frontage), after/before:`);
    for (let row = 0; row < 3; row++) {
      const cells = [];
      for (let c = 0; c < 4; c++) {
        const i = row * 4 + c;
        cells.push((B.tiles[i] / Math.max(1e-9, A.tiles[i])).toFixed(3).padStart(8));
      }
      console.log(`             row ${row}:${cells.join('')}`);
    }
  }
  finish(0);
}

fs.mkdirSync(OUT, { recursive: true });
const report = { mode: MODE, when: new Date().toISOString(), url, beforeDisc: BEFORE_DISC, views: {} };

console.log(`  mode=${MODE}`);
console.log(`  painted disc peak now  ${SUN_DISC_PEAK.map((x) => x.toFixed(1)).join(', ')}`
  + `  e-fold ${SUN_DISC_EFOLD}`);
console.log(`  shipped peak was ${SHIPPED_PEAK_RED} in red, i.e. ?disc=${BEFORE_DISC.toPrecision(4)}`);

await run({ width: W, height: H, url }, async ({ page, readShaderErrors }) => {
  const ready = await page.evaluate(() => ({
    env: !!(window.__env && window.__env.hasFlat), hdr: !!window.__hdr,
    bloom: !!window.__bloom,
  }));
  console.log(`  __env.flat=${ready.env}  __hdr=${ready.hdr}  __bloom=${ready.bloom}`);
  if (!ready.env || !ready.hdr || !ready.bloom) {
    console.error('✗ the A/B surface is not there.');
    process.exitCode = 1;
    return;
  }

  /* Put the scene into the state this mode is measuring, once, before any
   * view is visited. environmentIntensity and environment are read per draw,
   * so this holds for every capture below. */
  const state = MODE === 'before'
    ? { probe: 'flat', ei: 0.50, gain: 0.6 }
    : { probe: 'clouds', ei: 1.00, gain: 1.0 };
  await page.evaluate(([probe, ei, gain]) => {
    const s = window.__scene;
    s.scene.environment = window.__env[probe];
    s.scene.environmentIntensity = ei;
    window.__bloom.gain = gain;
  }, [state.probe, state.ei, state.gain]);
  console.log(`  probe=${state.probe}  environmentIntensity=${state.ei}  bloom.gain=${state.gain}`);

  for (const v of VIEWS) {
    await page.evaluate(([t, yaw, pitch]) => {
      const s = window.__scene;
      if (window.__sys5) window.__sys5.freeze(0);
      s.goTo(t); s.setYaw(yaw); s.setPitch(pitch); s.warp(2.0);
      s.walker.phase = 0; s.walker.speed = 0;
      s.walker.update(1 / 240, { forward: 0, strafe: 0, sprint: false });
    }, [v.t, v.yaw, v.pitch]);
    await page.waitForTimeout(180);

    const m = await page.evaluate(() => {
      const T3 = window.__THREE;
      const s = window.__scene;
      s.setPaused(true);
      s.renderOnce();

      const hdr = window.__hdr;
      const whole = hdr.rect(0, 0, 1, 1, 0);
      const tiles = [];
      for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 4; c++) {
          const t = hdr.rect(c / 4, r / 3, (c + 1) / 4, (r + 1) / 3, 0);
          tiles.push(0.2126 * t.mean[0] + 0.7152 * t.mean[1] + 0.0722 * t.mean[2]);
        }
      }

      const cv = s.renderer.domElement;

      /* Where the disc is on screen, projected from the directional light's
       * own direction rather than assumed, so the two degrees read below are
       * the sun and not whatever else is bright. */
      let sun = null;
      s.scene.traverse((o) => { if (o.isDirectionalLight && o.castShadow) sun = o; });
      const dir = new T3.Vector3().subVectors(sun.position, sun.target.position).normalize();
      const ndc = new T3.Vector3().copy(s.camera.position).addScaledVector(dir, 1000)
        .project(s.camera);
      const behind = dir.dot(s.camera.getWorldDirection(new T3.Vector3())) < 0;
      const sx = (ndc.x * 0.5 + 0.5) * cv.width, sy = (ndc.y * 0.5 + 0.5) * cv.height;
      const rad = 2 * cv.height / s.camera.fov;   // two degrees, in pixels
      const discBox = hdr.rect((sx - rad) / cv.width, (sy - rad) / cv.height,
        (sx + rad) / cv.width, (sy + rad) / cv.height, 0);

      const ctx = s.renderer.getContext();
      const px = new Uint8Array(cv.width * cv.height * 4);
      ctx.readPixels(0, 0, cv.width, cv.height, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
      let blown = 0, hot = 0, cr = 0, cg = 0, cb = 0;
      const lum = [];
      for (let i = 0; i < px.length; i += 4) {
        cr += px[i]; cg += px[i + 1]; cb += px[i + 2];
        const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
        lum.push(l);
        if (px[i] >= 254 && px[i + 1] >= 254 && px[i + 2] >= 254) blown++;
        if (l > 250) hot++;
      }
      lum.sort((a, b) => a - b);
      const n = lum.length;
      const q = (p) => lum[Math.min(n - 1, Math.floor(p * n))];
      s.setPaused(false);
      return {
        radMean: whole.mean,
        radLum: 0.2126 * whole.mean[0] + 0.7152 * whole.mean[1] + 0.0722 * whole.mean[2],
        radPeak: whole.lum.peak, peakAt: whole.peakAt,
        tiles,
        sunPx: [+sx.toFixed(0), +sy.toFixed(0)],
        sunInFrame: !behind && sx > 0 && sx < cv.width && sy > 0 && sy < cv.height,
        disc: { peak: discBox.lum.peak, mean: discBox.mean },
        /* Saturation as the display sees it, because AgX's shoulder
         * desaturates what it compresses and "warmer" is the claim being
         * made. Chroma of the frame mean, as a fraction of its luma. */
        displayMean: [cr / n, cg / n, cb / n],
        warmth: (cr / n - cb / n) / Math.max(1e-9, (cr + cg + cb) / (3 * n)),
        p01: q(0.01), p10: q(0.1), median: q(0.5), p90: q(0.9), p99: q(0.99),
        blown, hot,
      };
    });

    console.log(`\n── ${v.name}  t=${v.t} yaw=${(v.yaw * 180 / Math.PI).toFixed(0)}°`
      + ` pitch=${(v.pitch * 180 / Math.PI).toFixed(0)}°`);
    console.log(`   radiance mean ${m.radMean.map((x) => x.toFixed(4)).join(' ')}`
      + `  lum ${m.radLum.toFixed(4)}  peak ${m.radPeak.toFixed(1)} at ${m.peakAt.join(',')}`);
    console.log(`   display  p01 ${m.p01.toFixed(1)}  p10 ${m.p10.toFixed(1)}`
      + `  med ${m.median.toFixed(1)}  p90 ${m.p90.toFixed(1)}  p99 ${m.p99.toFixed(1)}`
      + `  warmth ${m.warmth.toFixed(4)}`);
    console.log(`   clipped ${m.blown}  luma>250 ${m.hot}`);
    console.log(`   sun at ${m.sunPx.join(',')} ${m.sunInFrame ? 'IN FRAME' : 'off frame'}`
      + `  its own 2°: peak ${m.disc.peak.toFixed(1)}`
      + `  mean ${m.disc.mean.map((x) => x.toFixed(2)).join(',')}`);

    /* The veil, switched at the uniform between two draws of this same frame.
     * `uBloom` is live and `Bloom.norm` is applied inside the composite, so
     * this is the glare and not a rebuild; an absent veil reads as exactly
     * 1.000 and the annuli below are printed to two places for that reason.
     * Binned by angular distance from the disc, because a veil is a function
     * of that angle and a sprite is not. */
    if (VEIL) {
      const veil = await page.evaluate(([sx, sy]) => {
        const s = window.__scene;
        const out = [];
        for (const b of [0, 0.045]) {
          s.setPaused(true);
          window.__grade.uniforms.uBloom.value = b;
          s.renderOnce();
          const cv = s.renderer.domElement;
          const ctx = s.renderer.getContext();
          const px = new Uint8Array(cv.width * cv.height * 4);
          ctx.readPixels(0, 0, cv.width, cv.height, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
          const degPerPx = s.camera.fov / cv.height;
          const bins = [2, 5, 10, 20, 40, 1e9];
          const sum = bins.map(() => 0), cnt = bins.map(() => 0);
          const lum = [];
          let blown = 0;
          for (let y = 0; y < cv.height; y++) {
            for (let x = 0; x < cv.width; x++) {
              const k = (y * cv.width + x) * 4;
              const l = 0.2126 * px[k] + 0.7152 * px[k + 1] + 0.0722 * px[k + 2];
              lum.push(l);
              if (px[k] >= 254 && px[k + 1] >= 254 && px[k + 2] >= 254) blown++;
              const d = Math.hypot(x - sx, y - sy) * degPerPx;
              for (let i = 0; i < bins.length; i++) {
                if (d < bins[i]) { sum[i] += l; cnt[i]++; break; }
              }
            }
          }
          lum.sort((a, c) => a - c);
          const q = (p) => lum[Math.min(lum.length - 1, Math.floor(p * lum.length))];
          out.push({
            bloom: b, blown,
            p01: q(0.01), p10: q(0.1), median: q(0.5),
            annuli: bins.map((bb, i) => ({
              deg: bb > 1e8 ? 'rest' : bb, px: cnt[i], mean: cnt[i] ? sum[i] / cnt[i] : null,
            })),
          });
          window.__grade.uniforms.uBloom.value = 0.045;
          s.setPaused(false);
        }
        return out;
      }, m.sunPx);
      const [off, on] = veil;
      console.log('   veil    off      on     on/off');
      for (let i = 0; i < off.annuli.length; i++) {
        if (!off.annuli[i].px) continue;
        const r = on.annuli[i].mean / Math.max(1e-9, off.annuli[i].mean);
        console.log(`   <${String(off.annuli[i].deg).padStart(4)}° `
          + `${off.annuli[i].mean.toFixed(2).padStart(7)} ${on.annuli[i].mean.toFixed(2).padStart(7)}`
          + `  ${r.toFixed(4)}${r === 1 ? '  <- INERT' : ''}   ${off.annuli[i].px} px`);
      }
      console.log(`   p01 ${off.p01.toFixed(2)} -> ${on.p01.toFixed(2)}`
        + `   median ${off.median.toFixed(2)} -> ${on.median.toFixed(2)}`
        + `   clipped ${off.blown} -> ${on.blown}`);
      report.views[v.name] = { veil };
    }

    report.views[v.name] = { view: v, ...m, ...(report.views[v.name] || {}) };
    await capture(page, path.join(OUT, `${v.name}.png`));
  }

  const errs = await readShaderErrors();
  console.log(errs.length ? `\n  SHADER ERRORS: ${errs.length}` : '\n  shader errors: none');

  const perf = await page.evaluate(async () => {
    const s = window.__scene;
    s.setPaused(false);
    await new Promise((r) => setTimeout(r, 2500));
    return { fps: +s.fps.toFixed(1), ...s.info() };
  });
  report.perf = perf;
  console.log(`  steady: ${perf.fps} fps  calls=${perf.calls} tris=${(perf.triangles / 1000).toFixed(0)}k`);

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`  → ${path.relative(ROOT, OUT)}`);
});

finish(process.exitCode || 0);
