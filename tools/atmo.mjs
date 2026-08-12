/* System 6/8 instrument: what each atmospheric term is worth, and what it costs.
 *
 * Two questions this project keeps getting wrong by inspection, answered in
 * one page load so the numbers are comparable:
 *
 *   1. Is the term live, and by how many code values? Every effect here is
 *      switchable through a uniform the grade already owns, so a differenced
 *      pair is a uniform write and a re-render — no reload, no recompile, no
 *      chance that the two frames differ in anything else. NOTES.md's register
 *      of inert code is entirely made of things that were never differenced.
 *
 *   2. What does it cost? Timed with a readPixels between the frames, because
 *      WebGL is asynchronous and a naive performance.now() around a draw call
 *      measures the time to *queue* the work. Every "this pass is free" claim
 *      in a graphics report is this mistake.
 *
 *   node tools/atmo.mjs [--t 0.4] [--yaw 0] [--pitch -0.22] [--n 40]
 */
import { run } from './harness.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

/* Regions chosen for the three things the brief asks about, in fractions of
 * the viewport so they survive a resolution change. */
const REGIONS = {
  sky:       [0.40, 0.06, 0.20, 0.14],
  farBuild:  [0.62, 0.30, 0.10, 0.10],   // the block at ~60 m, sun side
  midBuild:  [0.80, 0.22, 0.10, 0.12],   // shaded frontage, right, ~20 m
  farRoad:   [0.46, 0.53, 0.08, 0.03],
  midRoad:   [0.44, 0.66, 0.12, 0.05],
  nearRoad:  [0.40, 0.86, 0.20, 0.10],
  walkR:     [0.85, 0.72, 0.10, 0.06],   // sunlit footway, right
  walkL:     [0.05, 0.72, 0.10, 0.06],
  carFlank:  [0.20, 0.62, 0.10, 0.08],   // the dark silhouette the brief names
  airHigh:   [0.30, 0.30, 0.08, 0.10],   // open air over the street, no geometry
};

const t = Number(arg('t', 0.4));
const yaw = Number(arg('yaw', 0));
const pitch = Number(arg('pitch', -0.22));
const N = Number(arg('n', 40));

await run({ width: 1600, height: 900 }, async ({ page, readShaderErrors }) => {
  const out = await page.evaluate(
    ({ t, yaw, pitch, REGIONS, N }) => {
      const s = window.__scene;
      const u = window.__grade && window.__grade.uniforms;
      if (!u) return { error: 'window.__grade is not published; is Grade mounted?' };
      const hdr = u.uVol !== undefined;

      s.goTo(t); s.setYaw(yaw); s.setPitch(pitch); s.warp(1.5);
      s.setPaused(true);

      const gl2 = s.renderer.getContext();
      const px = new Uint8Array(4);
      const cv = s.renderer.domElement;
      const off = document.createElement('canvas');
      off.width = cv.width; off.height = cv.height;
      const ctx = off.getContext('2d', { willReadFrequently: true });

      const sample = () => {
        ctx.drawImage(cv, 0, 0);
        const res = {};
        for (const [name, [fx, fy, fw, fh]] of Object.entries(REGIONS)) {
          const d = ctx.getImageData(
            Math.round(fx * cv.width), Math.round(fy * cv.height),
            Math.max(1, Math.round(fw * cv.width)), Math.max(1, Math.round(fh * cv.height)),
          ).data;
          let r = 0, g = 0, b = 0, n = 0;
          for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
          res[name] = [r / n / 255, g / n / 255, b / n / 255];
        }
        return res;
      };

      /* Time N frames with a synchronous read after the last one, so the CPU
       * cannot run ahead of the GPU and the number is wall time for work that
       * has actually finished. */
      const timed = () => {
        s.renderOnce();
        gl2.readPixels(0, 0, 1, 1, gl2.RGBA, gl2.UNSIGNED_BYTE, px);
        const t0 = performance.now();
        for (let i = 0; i < N; i++) s.renderOnce();
        gl2.readPixels(0, 0, 1, 1, gl2.RGBA, gl2.UNSIGNED_BYTE, px);
        return (performance.now() - t0) / N;
      };

      const cfgs = hdr
        ? { all: [1, 1], noVol: [0, 1], noBloom: [1, 0], neither: [0, 0] }
        : { all: [0, 0] };
      const res = {};
      const BLOOM = hdr ? u.uBloom.value : 0;
      const VOL = hdr ? u.uVol.value : 0;
      for (const [name, [v, b]] of Object.entries(cfgs)) {
        if (hdr) { u.uVol.value = v * VOL; u.uBloom.value = b * BLOOM; }
        s.renderOnce();
        res[name] = { px: sample(), ms: Infinity };
      }
      /* Rounds interleaved across configurations, minimum kept, and both of
       * those are the fix for a run that reported bloom costing -2.74 ms.
       *
       * Timing each configuration once in sequence means each one samples a
       * different few hundred milliseconds of the machine, so a clock change or
       * another agent's capture landing mid-run is indistinguishable from the
       * effect being measured. Interleaving puts every configuration in every
       * disturbance. The minimum rather than the mean because this distribution
       * only has a tail upward — nothing makes a frame finish faster than the
       * work in it, so the smallest observation is the least contaminated. */
      for (let round = 0; round < 5; round++) {
        for (const [name, [v, b]] of Object.entries(cfgs)) {
          if (hdr) { u.uVol.value = v * VOL; u.uBloom.value = b * BLOOM; }
          res[name].ms = Math.min(res[name].ms, timed());
        }
      }
      if (hdr) { u.uVol.value = VOL; u.uBloom.value = BLOOM; }

      /* Dust view dependence, which is the whole of the dust effect and the one
       * claim a still frame cannot support. Same stop, same everything, the
       * camera turned to face the sun and then away from it, differenced
       * against the field switched off so the number is the motes and not the
       * sky behind them. */
      const dustAt = (y) => {
        s.setYaw(y); s.setPitch(-0.02);
        /* Below the horizon line, not above it. The first version of this probe
         * sampled y=0.34..0.56, which at this pitch is sky, and the motes live
         * between 0.25 and 2.6 m above the carriageway — so it reported a ratio
         * of -1.3:1 on a region that contains no dust at all. The tool was
         * inert, not the field. */
        const air = { air: [0.22, 0.56, 0.56, 0.26] };
        const grab = () => {
          s.renderOnce();
          ctx.drawImage(cv, 0, 0);
          const [fx, fy, fw, fh] = air.air;
          const d = ctx.getImageData(Math.round(fx * cv.width), Math.round(fy * cv.height),
            Math.round(fw * cv.width), Math.round(fh * cv.height)).data;
          /* The *sum over the brightest percentile*, not the mean. Motes are a
           * few pixels each on a large region, so a mean is dominated by the
           * sky they sit on and moves by hundredths; what a viewer sees is how
           * bright the motes themselves are. */
          const v = [];
          for (let i = 0; i < d.length; i += 4) v.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
          v.sort((a, b) => b - a);
          const n = Math.max(1, Math.round(v.length * 0.002));
          let t = 0; for (let i = 0; i < n; i++) t += v[i];
          return t / n;
        };
        /* Whole-frame pixel count as well as the percentile, because the two
         * fail differently: a field that is drawing nowhere and a field that is
         * drawing outside the sampled box both give a percentile of zero, and
         * only the count separates them. */
        const shot = () => {
          s.renderOnce(); ctx.drawImage(cv, 0, 0);
          return ctx.getImageData(0, 0, cv.width, cv.height).data;
        };
        const on = grab(); const onF = shot();
        const dp = window.__dust && window.__dust.uniforms;
        if (!dp) return { on, off: null, moved: null, peak: null };
        const peak = dp.uPeak.value; dp.uPeak.value = 0;
        const off = grab(); const offF = shot();
        dp.uPeak.value = peak;
        let moved = 0, biggest = 0;
        for (let i = 0; i < onF.length; i += 4) {
          const dd = Math.abs(onF[i] - offF[i]) + Math.abs(onF[i + 1] - offF[i + 1]);
          if (dd >= 2) moved++;
          if (dd > biggest) biggest = dd;
        }
        return { on, off, moved, biggest, peak };
      };
      const dust = { toward: dustAt(-0.61), away: dustAt(-0.61 + Math.PI) };

      /* Shafts must *move*. A wedge that is static as the camera translates is
       * a screen-space artifact wearing a shaft's clothes, and a still cannot
       * tell the two apart. Four stops a metre and a half apart, sampling one
       * fixed strip of open air, with the march on and off. */
      s.setYaw(yaw); s.setPitch(pitch);
      const sweep = [];
      for (const tt of [0.36, 0.375, 0.39, 0.405, 0.42]) {
        s.goTo(tt); s.warp(1.5);
        const strip = [0.42, 0.40, 0.16, 0.10];
        const grab = () => {
          s.renderOnce();
          ctx.drawImage(cv, 0, 0);
          const d = ctx.getImageData(Math.round(strip[0] * cv.width), Math.round(strip[1] * cv.height),
            Math.round(strip[2] * cv.width), Math.round(strip[3] * cv.height)).data;
          let t = 0, n = 0;
          for (let i = 0; i < d.length; i += 4) { t += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; n++; }
          return t / n;
        };
        if (hdr) u.uVol.value = VOL;
        const on = grab();
        if (hdr) u.uVol.value = 0;
        const off = grab();
        if (hdr) u.uVol.value = VOL;
        sweep.push({ t: tt, on, off, d: on - off });
      }

      /* What the sky is made of, which decides whether the march's subtractive
       * sun term is allowed to touch the top of the frame. scene.background
       * goes through three's own pass and is never fogged, so there is no
       * ambient in-scatter there to subtract; a dome mesh is fogged like any
       * other geometry and there is. The two want opposite treatment and the
       * first attempt at the gate assumed the first without checking. */
      const sc = s.scene, cam = s.camera;
      const big = [];
      sc.traverse((o) => {
        if (!o.isMesh) return;
        if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
        const r = o.geometry.boundingSphere.radius * Math.max(o.scale.x, o.scale.y);
        if (r > 80) big.push({ n: o.name || o.material.type, r: +r.toFixed(0), fog: !!o.material.fog });
      });
      const sky = {
        background: sc.background ? (sc.background.isTexture
          ? `${sc.background.type}(${sc.background.isCubeTexture ? 'cube' : '2d'})`
          : sc.background.getHexString ? `Color#${sc.background.getHexString()}` : 'obj') : 'null',
        far: cam.far, big,
      };

      // What the march actually found this frame, straight from the pass.
      s.setYaw(yaw); s.setPitch(pitch); s.goTo(t); s.renderOnce();
      const vol = window.__vol ? {
        cones: window.__vol.cones, shadow: window.__vol.shadow, air: window.__vol.air,
        probes: window.__vol.probe ? Object.fromEntries(Object.entries(REGIONS).map(
          ([k, r]) => [k, window.__vol.probe(r[0] + r[2] / 2, 1 - (r[1] + r[3] / 2))])) : null,
      } : {};
      s.setPaused(false);
      return { res, hdr, vol, dust, sweep, sky, first: window.__firstFrame || null };
    },
    { t, yaw, pitch, REGIONS, N },
  );

  if (out.error) { console.error('  ' + out.error); return; }

  const cv = (x) => (x * 255);
  const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const names = Object.keys(out.res);
  console.log(`\n  t=${t} yaw=${yaw} pitch=${pitch}   hdr=${out.hdr}`);
  console.log(`  march: cones=${out.vol.cones ?? '-'} shadowMap=${out.vol.shadow ?? '-'}\n`);

  console.log('  cost (ms/frame, readPixels-synchronised)');
  for (const n of names) console.log(`    ${n.padEnd(9)} ${out.res[n].ms.toFixed(3)}`);
  if (out.hdr) {
    console.log(`    → volumetric  ${(out.res.all.ms - out.res.noVol.ms).toFixed(3)}`);
    console.log(`    → bloom       ${(out.res.all.ms - out.res.noBloom.ms).toFixed(3)}`);
    console.log(`    → both        ${(out.res.all.ms - out.res.neither.ms).toFixed(3)}`);
  }

  console.log(`\n  region       ${names.map((n) => n.padEnd(9)).join('')}${out.hdr ? ' Δvol   Δbloom' : ''}`);
  for (const k of Object.keys(REGIONS)) {
    const cols = names.map((n) => cv(luma(out.res[n].px[k])).toFixed(1).padStart(6) + '   ').join('');
    let d = '';
    if (out.hdr) {
      d = (cv(luma(out.res.all.px[k]) - luma(out.res.noVol.px[k]))).toFixed(2).padStart(6)
        + (cv(luma(out.res.all.px[k]) - luma(out.res.noBloom.px[k]))).toFixed(2).padStart(8);
    }
    console.log(`  ${k.padEnd(11)}${cols}${d}`);
  }

  if (out.first) {
    const f = out.first;
    console.log(`\n  first frame: hazeInstalled=${f.hazeInstalled} fogChunkPatched=${f.fogChunkPatched}`
      + ` sensorPatched=${f.sensorPatched} hdr=${f.hdr}`);
  }
  if (out.sky) {
    console.log(`  sky: background=${out.sky.background} camera.far=${out.sky.far}`
      + `  large meshes: ${out.sky.big.length ? out.sky.big.map((b) => `${b.n} r=${b.r} fog=${b.fog}`).join(', ') : 'none'}`);
  }
  if (out.vol.air) {
    console.log(`  air albedo, sunward airlight / sun irradiance: `
      + out.vol.air.map((v) => v.toFixed(4)).join(' '));
  }
  if (out.vol.probes) {
    console.log('\n  march output, read back from its own target'
      + ' (rgb = signed in-scatter, vz = metres marched to)');
    for (const [k, p] of Object.entries(out.vol.probes)) {
      console.log(`    ${k.padEnd(9)} vz=${p.vz.toFixed(1).padStart(6)}  `
        + `rgb ${p.r.toFixed(4).padStart(8)} ${p.g.toFixed(4).padStart(8)} ${p.b.toFixed(4).padStart(8)}`);
    }
  }

  const d = out.dust;
  if (d && d.toward.off !== null) {
    const a = d.toward.on - d.toward.off, b = d.away.on - d.away.off;
    console.log(`\n  dust, top 0.2% of an open-air region, counts above the field switched off`);
    console.log(`    toward sun  ${a.toFixed(2)}   away  ${b.toFixed(2)}   ratio ${(a / Math.max(b, 1e-3)).toFixed(1)}:1`);
    /* The pixel count is the headline and the percentile is kept only because
     * it is what the brief asked for. A mote is a few pixels on a large region
     * and the top 0.2% of that region is the sun on the road, not the dust, so
     * the percentile reads 0.00 whatever the field does. How much of the frame
     * the field lights is the quantity that matches what a viewer sees. */
    const tm = d.toward.moved, am = d.away.moved;
    console.log(`    px lit by the field (>=2 counts): toward ${tm}  away ${am}`
      + `   ratio ${(tm / Math.max(am, 1)).toFixed(1)}:1`);
    console.log(`    uPeak=${d.toward.peak === null ? '?' : d.toward.peak.toFixed(3)}`
      + `  brightest mote: toward ${d.toward.biggest}  away ${d.away.biggest} counts`);
  }

  if (out.sweep && out.sweep.length) {
    console.log(`\n  shaft sweep, one fixed strip of open air, luma counts`);
    console.log(`    t        on      off     march`);
    for (const s of out.sweep) {
      console.log(`    ${s.t.toFixed(3)}  ${(s.on * 1).toFixed(2).padStart(6)}  ${(s.off).toFixed(2).padStart(6)}  ${(s.d).toFixed(2).padStart(6)}`);
    }
    const ds = out.sweep.map((s) => s.d);
    console.log(`    march term range over 3 m of walk: ${(Math.max(...ds) - Math.min(...ds)).toFixed(2)} counts`);
  }

  const errs = await readShaderErrors();
  console.log(`\n  shader errors: ${errs.length}`);
  if (errs.length) console.log(errs.slice(0, 3).join('\n'));
  console.log('');
});
