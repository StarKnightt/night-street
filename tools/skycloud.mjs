/* What the sky puts in the frame, and what it would put on the walls.
 *
 * The cloud pass has to satisfy two claims at once and they pull opposite ways:
 * the background must change a great deal, and the light the scene receives
 * must not change at all. Neither can be settled by looking, and the second one
 * especially cannot — NOTES.md's whole register of expensive bugs is claims
 * that were checked against the wrong object.
 *
 * So this reads the shipped background *itself*, off the GPU, in whatever form
 * `scene.background` happens to be in, resamples it to an equirectangular float
 * grid and integrates it. Not a reimplementation of the sky function — the
 * texture the renderer is actually drawing. `tools/skyprobe.mjs` integrates the
 * closed form and is the right tool for a candidate change; this one is the
 * right tool for "is the thing on the GPU the thing I think it is".
 *
 * It also samples the same wall and road rectangles `tools/px.mjs --walls`
 * uses, out of the same page load, because the irradiance integral is a
 * statement about the probe and the wall pixels are the thing the viewer sees.
 *
 *   node tools/skycloud.mjs [--mode clouds|noclouds|flat] [--out tmp/sky.json]
 *
 * Two runs and a diff is the measurement:
 *   node tools/withlock.mjs sky -- node tools/skycloud.mjs --mode flat     --out tmp/sky-flat.json
 *   node tools/withlock.mjs sky -- node tools/skycloud.mjs --mode clouds   --out tmp/sky-clouds.json
 *   node tools/skycloud.mjs --diff tmp/sky-flat.json tmp/sky-clouds.json
 */
import fs from 'node:fs';
import { run, finish } from './harness.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

/* Resolution of the resampled grid. 256x128 is 1.4 degrees a texel, which is
 * far finer than an irradiance integral needs — the cosine kernel is a
 * hemisphere — and coarse enough to come back over the CDP bridge in one go. */
const GW = 256, GH = 128;

const SUN_ELEV = 4.2 * Math.PI / 180;
const SUN_AZIM = 35.0 * Math.PI / 180;
const SUN = [
  Math.sin(SUN_AZIM) * Math.cos(SUN_ELEV),
  Math.sin(SUN_ELEV),
  -Math.cos(SUN_AZIM) * Math.cos(SUN_ELEV),
];

/* The same rectangles px.mjs --walls uses, so the two tools can be compared. */
const WALLS = {
  shadeHiR: [0.82, 0.20, 0.09, 0.13],
  shadeMidR: [0.80, 0.40, 0.09, 0.10],
  shadeLowR: [0.76, 0.56, 0.08, 0.06],
  sunHiL: [0.04, 0.20, 0.09, 0.13],
  sunMidL: [0.07, 0.40, 0.09, 0.10],
  zenith: [0.45, 0.02, 0.10, 0.04],
  skyBand: [0.40, 0.06, 0.20, 0.14],
  roadShade: [0.44, 0.72, 0.12, 0.05],
};

// ── analysis, shared by the capture path and the --diff path ────────────────

function analyse(px, w, h) {
  const dirOf = (i, j) => {
    const u = (i + 0.5) / w, v = (j + 0.5) / h;
    const phi = (u - 0.5) * Math.PI * 2, el = (v - 0.5) * Math.PI;
    return [Math.cos(el) * Math.cos(phi), Math.sin(el), Math.cos(el) * Math.sin(phi)];
  };
  const dwOf = (j) => {
    const v = (j + 0.5) / h;
    return (Math.PI / h) * (2 * Math.PI / w) * Math.cos((v - 0.5) * Math.PI);
  };

  const normals = {
    shadedWall: [-1, 0, 0], sunlitWall: [1, 0, 0],
    road: [0, 1, 0], downStreet: [0, 0, 1],
  };
  const E = {}, Enodisc = {};
  for (const k of Object.keys(normals)) { E[k] = [0, 0, 0]; Enodisc[k] = [0, 0, 0]; }

  // Sky statistics over the visible upper hemisphere only.
  const lum = [];
  let upR = 0, upG = 0, upB = 0, upW = 0;

  for (let j = 0; j < h; j++) {
    const dw = dwOf(j);
    for (let i = 0; i < w; i++) {
      const k = (j * w + i) * 4;
      const c = [px[k], px[k + 1], px[k + 2]];
      const d = dirOf(i, j);
      /* Within two degrees of the sun is the disc, and the disc is carried by
       * the directional light rather than by the probe — env.ts's own
       * decomposition. Integrating it here would compare a sky that has it
       * against a probe that does not. */
      const nearSun = (d[0] * SUN[0] + d[1] * SUN[1] + d[2] * SUN[2]) > Math.cos(0.035);
      for (const [name, n] of Object.entries(normals)) {
        const nd = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
        if (nd <= 0) continue;
        const wgt = nd * dw;
        E[name][0] += c[0] * wgt; E[name][1] += c[1] * wgt; E[name][2] += c[2] * wgt;
        if (!nearSun) {
          Enodisc[name][0] += c[0] * wgt;
          Enodisc[name][1] += c[1] * wgt;
          Enodisc[name][2] += c[2] * wgt;
        }
      }
      if (d[1] > 0) {
        upR += c[0] * dw; upG += c[1] * dw; upB += c[2] * dw; upW += dw;
        if (!nearSun) lum.push(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]);
      }
    }
  }
  lum.sort((a, b) => a - b);
  const q = (p) => lum[Math.min(lum.length - 1, Math.floor(p * lum.length))];
  return {
    E, Enodisc,
    upperMean: [upR / upW, upG / upW, upB / upW],
    skyLum: { p05: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95), p99: q(0.99) },
    // Spread of the sky's luminance is the number "flat gradient" is a claim
    // about: a ramp has almost none once the horizon band is excluded.
    skySpread: q(0.95) / Math.max(q(0.05), 1e-6),
  };
}

const f4 = (v) => v.toFixed(4).padStart(9);
function report(tag, a) {
  console.log(`\n  ── ${tag} ──`);
  console.log('  irradiance from the drawn background, disc excluded (linear):');
  for (const [k, v] of Object.entries(a.Enodisc)) {
    const L = 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
    console.log(`    ${k.padEnd(12)} E=${f4(v[0])}${f4(v[1])}${f4(v[2])}  lum=${L.toFixed(4)}  B/R=${(v[2] / v[0]).toFixed(3)}`);
  }
  const m = a.upperMean;
  console.log(`  upper-hemisphere mean radiance  ${f4(m[0])}${f4(m[1])}${f4(m[2])}`);
  const s = a.skyLum;
  console.log(`  sky luminance   p05=${s.p05.toFixed(4)} p25=${s.p25.toFixed(4)} ` +
    `p50=${s.p50.toFixed(4)} p75=${s.p75.toFixed(4)} p95=${s.p95.toFixed(4)} p99=${s.p99.toFixed(4)}`);
  console.log(`  p95/p05 spread  ${a.skySpread.toFixed(2)}`);
}

// ── --diff, offline ─────────────────────────────────────────────────────────

if (args.includes('--diff')) {
  const [fa, fb] = args.slice(args.indexOf('--diff') + 1);
  const A = JSON.parse(fs.readFileSync(fa, 'utf8'));
  const B = JSON.parse(fs.readFileSync(fb, 'utf8'));
  report(`${A.mode}   ${fa}`, A.sky);
  report(`${B.mode}   ${fb}`, B.sky);
  console.log('\n  ── change in the light the background would deliver ──');
  for (const k of Object.keys(A.sky.Enodisc)) {
    const a = A.sky.Enodisc[k], b = B.sky.Enodisc[k];
    const la = 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
    const lb = 0.2126 * b[0] + 0.7152 * b[1] + 0.0722 * b[2];
    console.log(`    ${k.padEnd(12)} lum ${la.toFixed(4)} -> ${lb.toFixed(4)}  ` +
      `${(100 * (lb / la - 1)).toFixed(1)}%   B/R ${(a[2] / a[0]).toFixed(3)} -> ${(b[2] / b[0]).toFixed(3)}`);
  }
  console.log('\n  ── the pixels the viewer sees, same rectangles as px.mjs --walls ──');
  console.log(`    ${'region'.padEnd(12)} ${'before'.padEnd(22)} ${'after'.padEnd(22)} dLuma(counts)`);
  for (const k of Object.keys(A.regions)) {
    const a = A.regions[k], b = B.regions[k];
    const la = 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
    const lb = 0.2126 * b[0] + 0.7152 * b[1] + 0.0722 * b[2];
    const s = (c) => c.map((x) => (x * 255).toFixed(1).padStart(6)).join(' ');
    console.log(`    ${k.padEnd(12)} ${s(a)}  ${s(b)}  ${((lb - la) * 255).toFixed(2)}`);
  }
  console.log('');
  process.exit(0);
}

// ── capture ─────────────────────────────────────────────────────────────────

const MODE = flag('mode', 'clouds');
const OUT = flag('out', `tmp/sky-${MODE}.json`);
const URL = (process.env.STREET_URL || 'http://127.0.0.1:3000') + `/?sky=${MODE}`;

await run({ width: 1600, height: 900, url: URL }, async ({ page, errs, readShaderErrors }) => {
  const out = await page.evaluate(({ GW, GH, WALLS }) => {
    const s = window.__scene;
    const THREE = window.__THREE;
    const bg = s.scene.background;
    const isCube = !!bg.isCubeTexture;

    /* Resample whatever the background is into an equirect float grid.
     *
     * Deliberately reads `scene.background` rather than anything env.ts
     * returned: the object under test is the one the renderer has, and the two
     * have been different before on this project. */
    const rt = new THREE.WebGLRenderTarget(GW, GH, {
      type: THREE.FloatType, format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      generateMipmaps: false,
    });
    const sampler = isCube
      ? 'uniform samplerCube tSky;'
      : 'uniform sampler2D tSky;';
    const fetch = isCube
      ? 'vec3 c = textureCube(tSky, d).rgb;'
      : 'vec3 c = texture2D(tSky, vec2(atan(d.z, d.x) * 0.1591549 + 0.5, ' +
        'asin(clamp(d.y, -1.0, 1.0)) * 0.3183099 + 0.5)).rgb;';
    const mat = new THREE.ShaderMaterial({
      uniforms: { tSky: { value: bg } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `precision highp float; varying vec2 vUv; ${sampler}
        void main(){
          float phi = (vUv.x - 0.5) * 6.2831853;
          float el  = (vUv.y - 0.5) * 3.1415927;
          vec3 d = vec3(cos(el) * cos(phi), sin(el), cos(el) * sin(phi));
          ${fetch}
          gl_FragColor = vec4(c, 1.0);
        }`,
      depthTest: false, depthWrite: false,
    });
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    quad.frustumCulled = false;
    const sc = new THREE.Scene(); sc.add(quad);
    const cam = new THREE.Camera();
    const prev = s.renderer.getRenderTarget();
    s.renderer.setRenderTarget(rt);
    s.renderer.render(sc, cam);
    const buf = new Float32Array(GW * GH * 4);
    s.renderer.readRenderTargetPixels(rt, 0, 0, GW, GH, buf);
    s.renderer.setRenderTarget(prev);
    rt.dispose(); mat.dispose(); quad.geometry.dispose();

    /* And the frame itself, at the standard wall framing. */
    s.goTo(0.4); s.setYaw(0); s.setPitch(-0.22); s.warp(1.5);
    s.setPaused(true); s.renderOnce();
    const cv = s.renderer.domElement;
    const off = document.createElement('canvas');
    off.width = cv.width; off.height = cv.height;
    const ctx = off.getContext('2d');
    ctx.drawImage(cv, 0, 0);
    const regions = {};
    for (const [name, [fx, fy, fw, fh]] of Object.entries(WALLS)) {
      const d = ctx.getImageData(Math.round(fx * cv.width), Math.round(fy * cv.height),
        Math.max(1, Math.round(fw * cv.width)), Math.max(1, Math.round(fh * cv.height))).data;
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
      regions[name] = [r / n / 255, g / n / 255, b / n / 255];
    }
    s.setPaused(false);

    return {
      isCube,
      texType: bg.type, mapping: bg.mapping,
      px: Array.from(buf),
      regions,
      fps: +s.fps.toFixed(1),
      bakeMs: window.__skyBakeMs ?? null,
    };
  }, { GW, GH, WALLS });

  const sky = analyse(out.px, GW, GH);
  const shaderErrors = await readShaderErrors();
  const rec = {
    mode: MODE, when: new Date().toISOString(),
    isCube: out.isCube, texType: out.texType, mapping: out.mapping,
    sky, regions: out.regions, fps: out.fps, bakeMs: out.bakeMs,
    errors: [...new Set(errs)].filter((e) => !/X3595|X4122|THREE.Clock/.test(e)),
    shaderErrors,
  };
  fs.mkdirSync('tmp', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(rec, null, 2));
  console.log(`\n  mode=${MODE}  isCubeTexture=${out.isCube}  mapping=${out.mapping}  type=${out.texType}`);
  report(MODE, sky);
  console.log(`\n  fps=${out.fps}  bake=${out.bakeMs === null ? 'n/a' : out.bakeMs.toFixed(1) + ' ms'}`);
  console.log(`  shaderErrors=${shaderErrors.length}  otherErrors=${rec.errors.length}`);
  console.log(`  → ${OUT}\n`);
});

finish(process.exitCode || 0);
