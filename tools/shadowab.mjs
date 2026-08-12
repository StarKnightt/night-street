/* Toggle the shadow-follower fix on one build, and measure what it is worth.
 *
 *   node tools/withlock.mjs shadowab -- node tools/shadowab.mjs
 *   node tools/withlock.mjs shadowab -- node tools/shadowab.mjs --t 0.02,0.2,0.4,0.6,0.8,0.95
 *
 * ── Why not compare against the archive ───────────────────────────────────
 *
 * Because the archive cannot answer the question. Between the oldest captures
 * in `shots/` and today the tree has grown clouds, an ozone re-grade, a sun
 * raised from 4.2 to 12 degrees, a density pass on the props, a palette fix,
 * an HDR pipeline, a bloom fix and a volumetric shaft term. Two frames from
 * either side of all that differ for eight reasons and the shadow box is one
 * of them; attributing the difference to this bug would be the same mistake
 * `NOTES.md` records four times over, an instrument pointed at the wrong
 * object. The clean experiment is the fix itself as the only variable.
 *
 * ── How the pre-fix frame is reproduced exactly ───────────────────────────
 *
 * `window.__sunFollow.pin(x, z)` anchors the box to a chosen ground point and
 * stops the hook correcting it, which is precisely what the pre-fix build did:
 * `Street.tsx`'s `useFrame` was the only placement, so a render that no
 * animation frame preceded inherited whatever the last one left. The pin is
 * taken at the camera position the page boots at — the walk's origin — which
 * is where `tools/shafts.mjs` found it before the fix existed: camera at
 * (0.05, 1.65, -35.20) with the shadow target still at (-0.58, 2.00, -4.00).
 *
 * The pin, the teleport and the draw all happen inside one `page.evaluate`,
 * because any animation frame in between would let Street.tsx's own follower
 * repair it — the same property that made the bug invisible in the first
 * place. The control is taken from the same page load, seconds apart, so
 * neither half can be a different build from the other.
 *
 * ── Provenance ───────────────────────────────────────────────────────────
 *
 * Every number below is tied to a world position and a distance, taken from
 * the frame itself by an override pass that writes the range to each fragment
 * (16-bit, ~4 mm over 250 m). Difference statistics are then reported binned
 * by that distance and by whether the surface fell inside the *stale* shadow
 * frustum — which is the prediction the bug makes and the thing that has to be
 * checked rather than assumed. A statistic with no provenance is a statistic
 * about an unknown place.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { run, finish } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const STOPS = flag('t', '0.02,0.2,0.4,0.6,0.8,0.95').split(',').map(Number);
const OUT = path.join(ROOT, flag('out', 'tmp/shadowab'));
const W = +flag('w', 1600), H = +flag('h', 900);
const STEP = +flag('step', 8);      // provenance grid stride, in pixels
const RANGE = 250;                  // metres the packed depth covers

fs.mkdirSync(OUT, { recursive: true });

const POS_FRAG = `
precision highp float;
varying vec3 vW;
uniform vec3 uEye;
void main() {
  float d = clamp(length(vW - uEye) / ${RANGE}.0, 0.0, 1.0);
  float hi = floor(d * 255.0);
  float lo = floor((d * 255.0 - hi) * 255.0);
  gl_FragColor = vec4(hi / 255.0, lo / 255.0, 1.0, 1.0);
}`;
const POS_VERT = `
varying vec3 vW;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const report = { when: new Date().toISOString(), stops: [] };

await run({ width: W, height: H }, async ({ page, readShaderErrors }) => {
  await page.waitForFunction(() => !!window.__scene && !!window.__sunFollow, null, { timeout: 120_000 });
  await page.evaluate(([v, f]) => { window.__abVert = v; window.__abFrag = f; }, [POS_VERT, POS_FRAG]);

  /* The stale anchor: where the camera is before anything teleports it. That
   * is the walk's origin and it is the placement every pre-fix still
   * inherited. Overridable, but the default is the historical one. */
  const boot = await page.evaluate(() => {
    const p = window.__scene.camera.position;
    return [+p.x.toFixed(3), +p.y.toFixed(3), +p.z.toFixed(3)];
  });
  const pinTo = flag('stale', null)
    ? flag('stale').split(',').map(Number)
    : [boot[0], boot[2]];
  console.log(`\n  stale anchor: camera as booted at (${boot.join(', ')}) → pinning the box to x ${pinTo[0]}, z ${pinTo[1]}`);
  report.staleAnchor = { boot, pin: pinTo };

  for (const t of STOPS) {
    /* Settle on the animation loop first, so both halves start from a live,
     * correct world state and the only thing that differs between them is
     * where the box is at the moment of the draw. */
    await page.evaluate((t) => {
      const s = window.__scene;
      s.goTo(t); s.setYaw(0); s.setPitch(0); s.warp(2.0);
    }, t);
    await page.waitForTimeout(250);

    const shot = async (mode) => page.evaluate(([mode, pin]) => {
      const s = window.__scene;
      s.setPaused(true);
      if (mode === 'off') window.__sunFollow.pin(pin[0], pin[1]);
      else window.__sunFollow.release();
      s.renderOnce();
      const live = window.__liveness ? window.__liveness(mode) : null;
      let sun = null;
      s.scene.traverse((o) => {
        if (o.isDirectionalLight && o.castShadow && (!sun || o.intensity > sun.intensity)) sun = o;
      });
      const c = s.camera.position;
      const out = {
        data: s.renderer.domElement.toDataURL('image/png'),
        camera: [c.x, c.y, c.z],
        target: sun ? [sun.target.position.x, sun.target.position.y, sun.target.position.z] : null,
        light: sun ? [sun.position.x, sun.position.y, sun.position.z] : null,
        shadowMatrix: sun && sun.shadow ? sun.shadow.matrix.elements.slice() : null,
        live,
      };
      window.__sunFollow.release();
      s.setPaused(false);
      return out;
    }, [mode, pinTo]);

    /* Order matters only in that the stale one must not be left behind: the
     * pin is released inside the same evaluate that used it, so the next
     * animation frame puts the scene back to the shipped behaviour. */
    const on = await shot('on');
    await page.waitForTimeout(120);
    const off = await shot('off');
    await page.waitForTimeout(120);

    /* The provenance pass, from the same camera, after both. */
    const prov = await page.evaluate(([step, range]) => {
      const T = window.__THREE;
      const s = window.__scene;
      s.setPaused(true);
      const cam = s.camera;
      const mat = new T.ShaderMaterial({
        vertexShader: window.__abVert, fragmentShader: window.__abFrag,
        uniforms: { uEye: { value: cam.position.clone() } },
        blending: 0, toneMapped: false,
      });
      const prevOverride = s.scene.overrideMaterial;
      const prevClear = s.renderer.getClearColor(new T.Color()).clone();
      const prevAlpha = s.renderer.getClearAlpha();
      s.scene.overrideMaterial = mat;
      s.renderer.setClearColor(0x000000, 1);
      s.renderer.setRenderTarget(null);
      s.renderer.render(s.scene, cam);

      const gl2 = s.renderer.getContext();
      const w = s.renderer.domElement.width, h = s.renderer.domElement.height;
      const px = new Uint8Array(w * h * 4);
      gl2.readPixels(0, 0, w, h, gl2.RGBA, gl2.UNSIGNED_BYTE, px);

      s.scene.overrideMaterial = prevOverride;
      s.renderer.setClearColor(prevClear, prevAlpha);
      mat.dispose();
      s.setPaused(false);

      const cp = cam.position;
      const rows = [];
      const v = new T.Vector3();
      for (let y = 0; y < h; y += step) {
        for (let x = 0; x < w; x += step) {
          const k = (y * w + x) * 4;          // readPixels is bottom-up
          if (px[k + 2] < 128) { rows.push(null); continue; }   // background
          const d = ((px[k] * 255 + px[k + 1]) / 65025) * range;
          v.set((x / w) * 2 - 1, (y / h) * 2 - 1, 0.5).unproject(cam).sub(cp).normalize();
          rows.push([
            +(cp.x + v.x * d).toFixed(2), +(cp.y + v.y * d).toFixed(2),
            +(cp.z + v.z * d).toFixed(2), +d.toFixed(2),
          ]);
        }
      }
      return { w, h, step, rows };
    }, [STEP, RANGE]);

    const onFile = path.join(OUT, `${Math.round(t * 100)}-on.png`);
    const offFile = path.join(OUT, `${Math.round(t * 100)}-off.png`);
    fs.writeFileSync(onFile, Buffer.from(on.data.split(',')[1], 'base64'));
    fs.writeFileSync(offFile, Buffer.from(off.data.split(',')[1], 'base64'));

    const stat = await analyse(onFile, offFile, prov, off.shadowMatrix, on.shadowMatrix);
    report.stops.push({
      t,
      camera: on.camera.map((v) => +v.toFixed(3)),
      targetOn: on.target && on.target.map((v) => +v.toFixed(3)),
      targetOff: off.target && off.target.map((v) => +v.toFixed(3)),
      boxDisplacement: +Math.hypot(on.target[0] - off.target[0], on.target[2] - off.target[2]).toFixed(2),
      liveOn: on.live && on.live.failures.length,
      liveOff: off.live && off.live.failures.length,
      ...stat,
    });
    print(report.stops[report.stops.length - 1]);
  }

  const se = await readShaderErrors();
  report.shaderErrors = se.length;
  if (se.length) console.error(`\n  SHADER ERRORS: ${se.length}`);
});

fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
console.log(`\n  → ${path.relative(ROOT, OUT)}/report.json`);
summary(report);
finish(process.exitCode || 0);

/* ── analysis ─────────────────────────────────────────────────────────── */

function LUMA(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

async function analyse(onFile, offFile, prov, staleMat, liveMat) {
  const a = await sharp(onFile).raw().toBuffer({ resolveWithObject: true });
  const b = await sharp(offFile).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = a.info;

  /* Whole-frame, every pixel. */
  const diffs = new Float64Array(width * height);
  let n1 = 0, n4 = 0, n16 = 0;
  for (let p = 0; p < width * height; p++) {
    const i = p * channels;
    const d = Math.abs(LUMA(a.data[i], a.data[i + 1], a.data[i + 2])
      - LUMA(b.data[i], b.data[i + 1], b.data[i + 2]));
    diffs[p] = d;
    if (d >= 1) n1++;
    if (d >= 4) n4++;
    if (d >= 16) n16++;
  }
  const sorted = Float64Array.from(diffs).sort();
  const q = (f) => +sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))].toFixed(2);
  const frame = {
    mean: +(sorted.reduce((s, v) => s + v, 0) / sorted.length).toFixed(3),
    p50: q(0.5), p90: q(0.9), p99: q(0.99), max: +sorted[sorted.length - 1].toFixed(1),
    pctOver1: +((100 * n1) / sorted.length).toFixed(1),
    pctOver4: +((100 * n4) / sorted.length).toFixed(1),
    pctOver16: +((100 * n16) / sorted.length).toFixed(2),
  };

  /* Binned, at the provenance samples only, so every bin has a world position
   * behind it. The image and the provenance grid are the same frame, so a
   * sample's pixel is exact rather than nearest. */
  const gw = Math.ceil(prov.w / prov.step);
  const bins = {};
  const bin = (k, d, w) => {
    (bins[k] ||= { n: 0, sum: 0, max: 0, worstAt: null, zs: [] });
    const e = bins[k];
    e.n++; e.sum += d; e.zs.push(d);
    if (d > e.max) { e.max = d; e.worstAt = w; }
  };
  const inside = (m, x, y, z) => {
    if (!m) return null;
    const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
    const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (!cw) return false;
    const u = cx / cw, v = cy / cw, d = cz / cw;
    return u >= 0 && u <= 1 && v >= 0 && v <= 1 && d >= 0 && d <= 1;
  };

  for (let i = 0; i < prov.rows.length; i++) {
    const r = prov.rows[i];
    if (!r) continue;
    const gx = i % gw, gy = Math.floor(i / gw);
    const x = gx * prov.step;
    const y = height - 1 - gy * prov.step;      // provenance grid is bottom-up
    if (y < 0 || y >= height) continue;
    const d = diffs[y * width + x];
    const [wx, wy, wz, dist] = r;
    const where = { world: [wx, wy, wz], dist };
    bin(dist < 10 ? 'range <10 m'
      : dist < 25 ? 'range 10-25 m'
        : dist < 50 ? 'range 25-50 m'
          : dist < 80 ? 'range 50-80 m' : 'range >80 m', d, where);
    const ins = inside(staleMat, wx, wy, wz);
    bin(ins ? 'inside the stale box' : 'outside the stale box', d, where);
    if (inside(liveMat, wx, wy, wz) && !ins) bin('lost from the box by the bug', d, where);
    bin(wy < 0.35 ? 'ground (y<0.35 m)' : wy < 4 ? 'street level (0.35-4 m)' : 'above 4 m', d, where);
  }

  const out = {};
  for (const [k, e] of Object.entries(bins)) {
    e.zs.sort((p, s) => p - s);
    out[k] = {
      samples: e.n,
      mean: +(e.sum / e.n).toFixed(3),
      p50: +e.zs[Math.floor(e.n * 0.5)].toFixed(2),
      p90: +e.zs[Math.floor(e.n * 0.9)].toFixed(2),
      max: +e.max.toFixed(1),
      worstAt: e.worstAt,
    };
  }
  return { frame, bins: out };
}

function print(s) {
  console.log(`\n  ── t=${s.t}  camera ${s.camera.join(', ')}`);
  console.log(`     shadow target  follow-on ${s.targetOn.map((v) => v.toFixed(2)).join(', ')}` +
    `   stale ${s.targetOff.map((v) => v.toFixed(2)).join(', ')}   box moved ${s.boxDisplacement} m`);
  console.log(`     liveness: on=${s.liveOn} failures, off=${s.liveOff} failures`);
  const f = s.frame;
  console.log(`     whole frame |dL|  mean ${f.mean}  p50 ${f.p50}  p90 ${f.p90}  p99 ${f.p99}  max ${f.max}` +
    `   >=1 ${f.pctOver1}%  >=4 ${f.pctOver4}%  >=16 ${f.pctOver16}%`);
  for (const [k, v] of Object.entries(s.bins)) {
    console.log(`       ${k.padEnd(28)} n=${String(v.samples).padStart(5)}  mean ${String(v.mean).padStart(7)}` +
      `  p90 ${String(v.p90).padStart(6)}  max ${String(v.max).padStart(6)}` +
      (v.worstAt ? `   worst at world ${v.worstAt.world.join(',')} at ${v.worstAt.dist} m` : ''));
  }
}

function summary(rep) {
  console.log('\n══ toggle-the-fix summary — mean |ΔL| in 8-bit counts');
  const keys = ['range <10 m', 'range 10-25 m', 'range 25-50 m', 'range 50-80 m', 'range >80 m',
    'inside the stale box', 'outside the stale box'];
  console.log('  t      frame   ' + keys.map((k) => k.replace('range ', '').padStart(9)).join(''));
  for (const s of rep.stops) {
    console.log(`  ${String(s.t).padEnd(6)} ${String(s.frame.mean).padStart(6)}   ` +
      keys.map((k) => String(s.bins[k] ? s.bins[k].mean : '—').padStart(9)).join(''));
  }
}
