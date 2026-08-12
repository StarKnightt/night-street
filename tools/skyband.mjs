/* The colour of the sky, band by band, as the eye will actually receive it.
 *
 * "Warm orange low, cooler purple-pink high" is a claim about hue and
 * saturation against elevation, and neither a screenshot nor a mean RGB triple
 * can be argued with. Linear radiance cannot be argued with either, because
 * AgX desaturates hard as it approaches the shoulder: two skies with the same
 * linear chroma can display at very different saturations, and the one that
 * matters is the displayed one. So every number here is pushed through
 * tools/agx.mjs — three's AgXToneMapping at the project's exposure, then the
 * sRGB encode — before its hue and saturation are taken.
 *
 * Bands are elevation. Each is also split by azimuth into the sun's third of
 * the compass, the opposite third, and the sides, because at four degrees of
 * sun elevation those are three different skies and averaging them produces a
 * number that describes none of them.
 *
 *   node tools/skyband.mjs [--mode clouds|noclouds|flat] [--out tmp/band.json]
 *   node tools/skyband.mjs --diff tmp/band-a.json tmp/band-b.json
 */
import fs from 'node:fs';
import { run, finish } from './harness.mjs';
import { display } from './agx.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

/* 512x256 rather than skycloud's 256x128: this is a chroma measurement and the
 * bands near the zenith are thin in solid angle, so they need the samples. */
const GW = 512, GH = 256;

const SUN_ELEV = 4.2 * Math.PI / 180;
const SUN_AZIM = 35.0 * Math.PI / 180;
const SUN = [
  Math.sin(SUN_AZIM) * Math.cos(SUN_ELEV),
  Math.sin(SUN_ELEV),
  -Math.cos(SUN_AZIM) * Math.cos(SUN_ELEV),
];

/* Elevation edges in degrees. Fine near the horizon, where the interesting
 * things happen within a few degrees of it, and coarse up top. */
const EDGES = [0, 3, 6, 10, 16, 24, 34, 46, 60, 90];
const SECTORS = ['sunward', 'side', 'antisun'];

function hsv(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-9) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s: mx <= 0 ? 0 : d / mx, v: mx };
}

function analyse(px, w, h) {
  const bins = [];
  for (let b = 0; b < EDGES.length - 1; b++) {
    bins.push(SECTORS.map(() => ({ r: 0, g: 0, b: 0, n: 0 })));
  }
  for (let j = 0; j < h; j++) {
    const el = (((j + 0.5) / h) - 0.5) * 180;
    if (el <= 0) continue;
    let bi = -1;
    for (let b = 0; b < EDGES.length - 1; b++) {
      if (el >= EDGES[b] && el < EDGES[b + 1]) { bi = b; break; }
    }
    if (bi < 0) continue;
    const elr = el * Math.PI / 180;
    for (let i = 0; i < w; i++) {
      const phi = (((i + 0.5) / w) - 0.5) * Math.PI * 2;
      const d = [Math.cos(elr) * Math.cos(phi), Math.sin(elr), Math.cos(elr) * Math.sin(phi)];
      /* Azimuth away from the sun, ignoring elevation: the sector is a
       * compass question, and including the sun's four degrees of height in it
       * would put the whole zenith in the "sunward" third. */
      const fl = Math.hypot(d[0], d[2]), sl = Math.hypot(SUN[0], SUN[2]);
      const ca = (d[0] * SUN[0] + d[2] * SUN[2]) / Math.max(1e-6, fl * sl);
      const si = ca > 0.5 ? 0 : ca < -0.5 ? 2 : 1;
      const k = (j * w + i) * 4;
      const t = bins[bi][si];
      t.r += px[k]; t.g += px[k + 1]; t.b += px[k + 2]; t.n++;
    }
  }
  const out = [];
  for (let b = 0; b < bins.length; b++) {
    const row = { lo: EDGES[b], hi: EDGES[b + 1], sect: {} };
    for (let s = 0; s < SECTORS.length; s++) {
      const t = bins[b][s];
      if (!t.n) continue;
      const lin = [t.r / t.n, t.g / t.n, t.b / t.n];
      const code = display(lin);
      const c = hsv(code[0] / 255, code[1] / 255, code[2] / 255);
      row.sect[SECTORS[s]] = { lin, code, hue: c.h, sat: c.s, val: c.v };
    }
    out.push(row);
  }
  return out;
}

const f = (x, n = 1) => x.toFixed(n).padStart(5);
function report(tag, rows) {
  console.log(`\n  ── ${tag} ──`);
  console.log('  elev      sunward  hue  sat  |   side     hue  sat  |  antisun  hue  sat');
  for (const r of rows) {
    const cell = (s) => {
      const v = r.sect[s];
      if (!v) return ' '.repeat(24);
      const rgb = v.code.map((x) => Math.round(x).toString().padStart(3)).join(',');
      return `${rgb} ${f(v.hue)} ${f(v.sat * 100)}%`;
    };
    console.log(`  ${String(r.lo).padStart(2)}-${String(r.hi).padStart(2)}   ` +
      `${cell('sunward')} | ${cell('side')} | ${cell('antisun')}`);
  }
}

if (args.includes('--diff')) {
  const [fa, fb] = args.slice(args.indexOf('--diff') + 1);
  const A = JSON.parse(fs.readFileSync(fa, 'utf8'));
  const B = JSON.parse(fs.readFileSync(fb, 'utf8'));
  report(`${A.mode}  ${fa}`, A.bands);
  report(`${B.mode}  ${fb}`, B.bands);
  console.log('\n  ── hue and saturation, before -> after ──');
  console.log('  elev     sector     hue            sat');
  for (let i = 0; i < A.bands.length; i++) {
    for (const s of SECTORS) {
      const a = A.bands[i].sect[s], b = B.bands[i].sect[s];
      if (!a || !b) continue;
      console.log(`  ${String(A.bands[i].lo).padStart(2)}-${String(A.bands[i].hi).padStart(2)}    ` +
        `${s.padEnd(8)} ${f(a.hue)} -> ${f(b.hue)}   ` +
        `${f(a.sat * 100)}% -> ${f(b.sat * 100)}%`);
    }
  }
  console.log('');
  process.exit(0);
}

const MODE = flag('mode', 'clouds');
const OUT = flag('out', `tmp/band-${MODE}.json`);
const URL = (process.env.STREET_URL || 'http://127.0.0.1:3000') + `/?sky=${MODE}`;

await run({ width: 1600, height: 900, url: URL }, async ({ page, errs, readShaderErrors }) => {
  const out = await page.evaluate(({ GW, GH }) => {
    const s = window.__scene;
    const THREE = window.__THREE;
    const bg = s.scene.background;
    const isCube = !!bg.isCubeTexture;
    const rt = new THREE.WebGLRenderTarget(GW, GH, {
      type: THREE.FloatType, format: THREE.RGBAFormat,
      colorSpace: THREE.NoColorSpace, depthBuffer: false, stencilBuffer: false,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
      generateMipmaps: false,
    });
    const mat = new THREE.ShaderMaterial({
      uniforms: { tSky: { value: bg } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `precision highp float; varying vec2 vUv;
        ${isCube ? 'uniform samplerCube tSky;' : 'uniform sampler2D tSky;'}
        void main(){
          float phi = (vUv.x - 0.5) * 6.2831853;
          float el  = (vUv.y - 0.5) * 3.1415927;
          vec3 d = vec3(cos(el) * cos(phi), sin(el), cos(el) * sin(phi));
          ${isCube ? 'vec3 c = textureCube(tSky, d).rgb;'
        : 'vec3 c = texture2D(tSky, vec2(atan(d.z, d.x) * 0.1591549 + 0.5, asin(clamp(d.y, -1.0, 1.0)) * 0.3183099 + 0.5)).rgb;'}
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
    return { isCube, px: Array.from(buf) };
  }, { GW, GH });

  const bands = analyse(out.px, GW, GH);
  const shaderErrors = await readShaderErrors();
  fs.mkdirSync('tmp', { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    mode: MODE, when: new Date().toISOString(), isCube: out.isCube, bands,
    errors: [...new Set(errs)].filter((e) => !/X3595|X4122|THREE.Clock/.test(e)),
    shaderErrors,
  }, null, 2));
  report(MODE, bands);
  console.log(`\n  shaderErrors=${shaderErrors.length}\n  → ${OUT}\n`);
});

finish(process.exitCode || 0);
