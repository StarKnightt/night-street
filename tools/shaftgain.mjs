/* Choose the subtractive sun gain by measuring the shaft, not by looking at it.
 *
 * ── What this measures and why ────────────────────────────────────────────
 *
 * The shaft term is a *difference*: the frame with the sun term on, minus the
 * same frozen frame with `__vol.sunOn` at zero. Differenced against
 * `uVol` instead — the only switch that used to exist — it would also contain
 * the lamp cones at gain 30, which are worth up to ninety code values and
 * which move under the camera exactly as a shaft would. That confusion is on
 * the record in `volumetric.ts` and it is the reason `uSunOn` was added.
 * Everything here is computed on the difference image, per gain, from one
 * frozen world state — the trap §7 of the technique brief records is a pair of
 * captures set up separately, which differences the walk rather than the
 * effect.
 *
 * ── The noise floor, and why the statistics are not maxima ────────────────
 *
 * Two things differ between any two renders of the same frozen state: the
 * sensor read noise and dither are re-seeded per draw from `grade.tsx`'s frame
 * counter, and the march's interleaved-gradient jitter is re-seeded from the
 * same counter. So the difference image has a real noise floor of a couple of
 * code values, and a `max` over 1.4 million pixels is a measurement of that
 * floor rather than of the effect — the first version of this tool reported a
 * "steepest edge" of 9 to 14 counts per pixel that barely moved across a
 * twelvefold change of gain, which is the signature of reading noise. The
 * difference is therefore boxed 4x4 before anything is measured, which divides
 * the noise by four and leaves a half-resolution effect untouched, and the
 * darkening is read at the 99.9th percentile rather than at the extreme.
 *
 * Three statistics, because magnitude alone has already misled this project
 * once. A beam reads as a beam because of the *edge* between lit and shadowed
 * air; a term that is strong and smooth is a brown cloud, and a region mean
 * cannot tell the two apart:
 *
 *   depth      the largest darkening anywhere in the frame, in code values.
 *              How loud the effect is at its loudest.
 *   edge       the steepest horizontal gradient of the difference, in code
 *              values per pixel, taken over a 5-pixel baseline so that sensor
 *              noise and the half-resolution upsample do not carry it. This
 *              is the number that decides shaft versus fog.
 *   reach      how many pixels the term moves by 2 counts or more. A term
 *              worth 30 counts over 400 pixels is a smudge; the same 30 over
 *              a fifth of the frame is weather.
 *
 * plus the regression gate the brief names: clipped pixels, counted the same
 * way `tools/atmo.mjs` counts them, on every configuration.
 *
 *   node tools/shaftgain.mjs [--gains 0.5,0.75,1,1.5,2,3] [--stops t:yaw:pitch,...]
 */
import { run } from './harness.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

const GAINS = String(arg('gains', '0,0.5,0.75,1,1.5,2,3,6')).split(',').map(Number);
const STOPS = String(arg('stops', '0.4:0:-0.22,0.4:-0.61:-0.10,0.6:0:-0.22,0.82:-0.61:-0.10'))
  .split(',').map((s) => {
    const [t, yaw, pitch] = s.split(':').map(Number);
    return { t, yaw: yaw || 0, pitch: Number.isNaN(pitch) ? -0.22 : pitch };
  });

await run({ width: 1600, height: 900 }, async ({ page, readShaderErrors }) => {
  const out = await page.evaluate(({ GAINS, STOPS }) => {
    const s = window.__scene;
    const u = window.__grade && window.__grade.uniforms;
    if (!u || u.uVol === undefined) return { error: 'no HDR pipeline; is Grade mounted?' };
    const v = window.__vol;
    if (!v) return { error: 'window.__vol missing' };

    const cv = s.renderer.domElement;
    const off = document.createElement('canvas');
    off.width = cv.width; off.height = cv.height;
    const ctx = off.getContext('2d', { willReadFrequently: true });
    const W = cv.width, H = cv.height;

    const shot = () => {
      s.renderOnce();
      ctx.drawImage(cv, 0, 0);
      return ctx.getImageData(0, 0, W, H).data;
    };
    const luma = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    const clipped = (d) => {
      let white = 0, anyCh = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.min(d[i], d[i + 1], d[i + 2]) >= 254) white++;
        if (Math.max(d[i], d[i + 1], d[i + 2]) >= 254) anyCh++;
      }
      return { white, anyCh };
    };

    s.setPaused(true);
    const VOL = u.uVol.value || 1;
    const g0 = v.gain;
    const res = [];

    for (const st of STOPS) {
      s.goTo(st.t); s.setYaw(st.yaw); s.setPitch(st.pitch); s.warp(1.5);
      /* The base, once per stop: the identical frame with the sun term gated
       * off and the lamp cones left exactly as they are. Every gain below is
       * differenced against this array, so nothing in the comparison can
       * differ except the gain — not the walk, not the cones, not the clock. */
      v.sunOn = 0;
      const base = new Uint8ClampedArray(shot());
      const baseClip = clipped(base);
      v.sunOn = 1;

      const bw = W >> 2, bh = H >> 2;
      const box = (d) => {
        const o = new Float32Array(bw * bh);
        for (let y = 0; y < H; y++) {
          const by = (y >> 2) * bw;
          for (let x = 0; x < W; x++) {
            o[by + (x >> 2)] += luma(d, (y * W + x) * 4) - luma(base, (y * W + x) * 4);
          }
        }
        for (let i = 0; i < o.length; i++) o[i] /= 16;
        return o;
      };

      const cam = s.camera.position;
      const rows = [];
      for (const g of GAINS) {
        v.gain = g;
        const d = shot();
        const b = box(d);
        let lift = 0, reach = 0, edge = 0;
        const dark = [];
        for (let y = 0; y < bh; y++) {
          for (let x = 0; x < bw; x++) {
            const dv = b[y * bw + x];
            if (dv > lift) lift = dv;
            if (Math.abs(dv) >= 2) reach++;
            dark.push(-dv);
            /* Horizontal gradient over one boxed cell, i.e. 4 screen pixels,
             * which is two texels of the half-resolution march. A shorter
             * baseline measures the depth-aware upsample's own filter rather
             * than the boundary the march resolved. */
            if (x > 0) {
              const gr = Math.abs(b[y * bw + x] - b[y * bw + x - 1]) / 4;
              if (gr > edge) edge = gr;
            }
          }
        }
        dark.sort((p, q) => q - p);
        rows.push({
          g, depth: dark[Math.floor(dark.length * 0.001)], lift, edge,
          reachPct: (100 * reach) / (bw * bh), clip: clipped(d),
        });
      }
      res.push({
        stop: st, cam: [+cam.x.toFixed(2), +cam.y.toFixed(2), +cam.z.toFixed(2)],
        baseClip, rows,
      });
    }

    v.gain = g0;
    u.uVol.value = VOL;
    s.setPaused(false);
    return { res, W, H };
  }, { GAINS, STOPS });

  if (out.error) { console.error('  ' + out.error); return; }

  for (const r of out.res) {
    console.log(`\n  t=${r.stop.t} yaw=${r.stop.yaw} pitch=${r.stop.pitch}`
      + `   camera ${r.cam.join(', ')}`);
    console.log(`  base clipped: ${r.baseClip.white} pure white, ${r.baseClip.anyCh} any channel`);
    console.log('    gain  p99.9 dark  brightest   steepest edge   moved >=2ct   clipped(white/any)');
    for (const g of r.rows) {
      console.log(`  ${String(g.g).padStart(6)} ${g.depth.toFixed(1).padStart(9)}`
        + ` ${g.lift.toFixed(1).padStart(10)} ${g.edge.toFixed(2).padStart(15)}`
        + ` ${(g.reachPct.toFixed(2) + '%').padStart(13)}`
        + ` ${String(g.clip.white).padStart(12)} /${String(g.clip.anyCh).padStart(6)}`);
    }
  }

  const errs = await readShaderErrors();
  console.log(`\n  shader errors: ${errs.length}`);
  if (errs.length) console.log(errs.slice(0, 3).join('\n'));
  console.log('');
});
