/* Does the mid field lose contrast, or does it lose texture?
 *
 * Those are different faults with different owners and the frame looks the same
 * either way. Aerial perspective is *supposed* to cut contrast with range: a
 * surface seen through transmittance T keeps T of its own modulation and the
 * rest is replaced by airlight, so brick at 40 m through half a veil should
 * read at half the amplitude it has at 8 m. That is correct and must not be
 * "fixed". What would be a bug is the high frequencies going *faster* than the
 * low ones — detail being low-passed rather than merely scaled — because
 * scattering does not blur, it adds a constant.
 *
 * So this measures both, per patch, at a known distance:
 *
 *   mean      the patch's mean luma: the floor, which haze should lift.
 *   hp        RMS of luma minus its own 5x5 mean: the texture, in counts.
 *   hp/mean   texture relative to the level it sits on. If scattering only
 *             lifted the floor, this falls with range even when hp holds.
 *   hp ratio  the same patch with the fog switched off, divided out. This is
 *             the number that matters: it isolates what the haze chain does to
 *             detail from what distance and mip level were already doing.
 *
 * A patch whose hp collapses with distance in *both* configurations is telling
 * you about texture LOD or normal-map mips, which live in files this agent does
 * not own. A patch whose hp collapses only with fog on is this agent's bug.
 *
 * Everything is toggled through uniforms and scene.fog.density on one page
 * load, so no configuration differs in anything but the term under test.
 *
 *   node tools/micro.mjs [--t 0.4] [--yaw 0] [--pitch -0.10]
 */
import { run } from './harness.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

/* Patches up the receding left frontage, which is the surface the brief calls
 * out: lit brick, plenty of native texture, and it runs from about 6 m to about
 * 60 m across the frame so one row of samples covers the whole mid field. */
const PATCHES = {
  'brick 1': [0.030, 0.30, 0.055, 0.10],
  'brick 2': [0.105, 0.30, 0.045, 0.09],
  'brick 3': [0.170, 0.31, 0.038, 0.08],
  'brick 4': [0.225, 0.32, 0.030, 0.07],
  'brick 5': [0.265, 0.33, 0.024, 0.06],
  'brick 6': [0.300, 0.34, 0.020, 0.05],
  'brick 7': [0.330, 0.35, 0.016, 0.04],
};

const t = Number(arg('t', 0.4));
const yaw = Number(arg('yaw', 0));
const pitch = Number(arg('pitch', -0.10));

await run({ width: 1600, height: 900 }, async ({ page, readShaderErrors }) => {
  const out = await page.evaluate(
    ({ t, yaw, pitch, PATCHES }) => {
      const s = window.__scene;
      const u = window.__grade && window.__grade.uniforms;
      if (!u) return { error: 'window.__grade is not published' };
      const cv = s.renderer.domElement;
      const c2 = document.createElement('canvas');
      c2.width = cv.width; c2.height = cv.height;
      const ctx = c2.getContext('2d', { willReadFrequently: true });

      s.setPaused(true); s.goTo(t); s.setYaw(yaw); s.setPitch(pitch);

      const stats = () => {
        s.renderOnce();
        ctx.drawImage(cv, 0, 0);
        const res = {};
        for (const [name, [fx, fy, fw, fh]] of Object.entries(PATCHES)) {
          const x0 = Math.round(fx * cv.width), y0 = Math.round(fy * cv.height);
          const w = Math.round(fw * cv.width), h = Math.round(fh * cv.height);
          const d = ctx.getImageData(x0, y0, w, h).data;
          const L = new Float64Array(w * h);
          for (let i = 0, p = 0; i < d.length; i += 4, p++) {
            L[p] = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
          }
          let sum = 0;
          for (let i = 0; i < L.length; i++) sum += L[i];
          const mean = sum / L.length;
          /* High pass as luma minus its own 5x5 box mean, RMS'd. A 5x5 window at
           * this resolution is about the scale of a brick course at 10 m and of
           * a whole pier at 50 m, which is the point: it asks whether *any*
           * structure survives at the scale the eye is reading, not whether one
           * particular feature does. */
          const R = 2;
          let acc = 0, n = 0;
          for (let y = R; y < h - R; y++) {
            for (let x = R; x < w - R; x++) {
              let b = 0;
              for (let j = -R; j <= R; j++) for (let i = -R; i <= R; i++) b += L[(y + j) * w + x + i];
              const hp = L[y * w + x] - b / ((2 * R + 1) * (2 * R + 1));
              acc += hp * hp; n++;
            }
          }
          res[name] = { mean, hp: n ? Math.sqrt(acc / n) : 0 };
        }
        return res;
      };

      const fog = s.scene.fog;
      const D = fog ? fog.density : 0;
      const BLOOM = u.uBloom.value, VOL = u.uVol.value;

      const cfg = {};
      const set = (d, b, v) => {
        if (fog) fog.density = d * D;
        u.uBloom.value = b * BLOOM; u.uVol.value = v * VOL;
      };
      set(1, 1, 1); cfg.full = stats();
      set(0, 1, 1); cfg.noFog = stats();
      set(1, 0, 1); cfg.noBloom = stats();
      set(1, 1, 0); cfg.noVol = stats();
      set(0, 0, 0); cfg.bare = stats();
      set(1, 1, 1);

      // Distance per patch, from the march's own target, so every row is labelled.
      s.renderOnce();
      const dist = {};
      if (window.__vol && window.__vol.probe) {
        for (const [name, r] of Object.entries(PATCHES)) {
          dist[name] = window.__vol.probe(r[0] + r[2] / 2, 1 - (r[1] + r[3] / 2)).vz;
        }
      }
      s.setPaused(false);
      return { cfg, dist, density: D, bloom: BLOOM };
    },
    { t, yaw, pitch, PATCHES },
  );

  if (out.error) { console.log('  ' + out.error); return; }

  console.log(`\n  t=${t} yaw=${yaw} pitch=${pitch}   fogDensity=${out.density} bloom=${out.bloom}`);
  console.log('\n  patch      dist     mean     hp   hp/mean   |  hp with fog off   ratio');
  for (const name of Object.keys(PATCHES)) {
    const f = out.cfg.full[name], n = out.cfg.noFog[name];
    const d = out.dist[name];
    console.log(`  ${name.padEnd(9)} ${(d ?? 0).toFixed(1).padStart(5)} m `
      + `${f.mean.toFixed(1).padStart(7)} ${f.hp.toFixed(2).padStart(6)} `
      + `${(f.hp / Math.max(f.mean, 1e-3)).toFixed(4).padStart(8)}   |`
      + `${n.hp.toFixed(2).padStart(9)}       ${(f.hp / Math.max(n.hp, 1e-3)).toFixed(3).padStart(6)}`);
  }

  console.log('\n  what each term does to texture (hp, counts)');
  console.log('  patch      full    noFog  noBloom   noVol     bare');
  for (const name of Object.keys(PATCHES)) {
    const g = (k) => out.cfg[k][name].hp.toFixed(2).padStart(7);
    console.log(`  ${name.padEnd(9)}${g('full')} ${g('noFog')} ${g('noBloom')} ${g('noVol')} ${g('bare')}`);
  }

  const errs = await readShaderErrors();
  console.log(`\n  shader errors: ${errs.length}`);
  if (errs.length) console.log(errs.join('\n'));
});
