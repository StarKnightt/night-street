/* Region sampler.
 *
 * `probe()` gives one histogram for the whole frame, which is the wrong
 * instrument for the question that actually comes up while authoring a
 * material: is the asphalt reading darker than the concrete next to it, and by
 * how much. Whole-frame statistics are dominated by the sky and by how much
 * road happens to be in shot, so two materially different roads can produce
 * near-identical histograms — and eyeballing a downscaled screenshot is not
 * good enough to tell a 30% albedo change from no change at all.
 *
 * This reads the framebuffer back and averages fixed rectangles of it, so
 * "near road" and "near left pavement" become two numbers that can be compared
 * between runs.
 *
 *   node tools/px.mjs [--t 0.4] [--yaw 0] [--pitch -0.22]
 */
import { run } from './harness.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

// Fractions of the viewport, so they survive a resolution change.
const GROUND = {
  sky:        [0.40, 0.06, 0.20, 0.14],
  farRoad:    [0.46, 0.53, 0.08, 0.03],
  midRoad:    [0.44, 0.66, 0.12, 0.05],
  nearRoad:   [0.40, 0.86, 0.20, 0.10],
  gutterL:    [0.13, 0.80, 0.06, 0.05],
  walkL:      [0.05, 0.72, 0.10, 0.06],
  walkR:      [0.85, 0.72, 0.10, 0.06],
};

/* The frontages, at the standard level framing.
 *
 * The whole cool-shade argument is about the hue of one set of pixels, and
 * arguing it from a screenshot is how three rounds went by without it being
 * settled. The sun bears +X, so the frontage on the right of frame faces away
 * from it and is the one that has to read blue; the left is the control.
 */
const WALLS = {
  shadeHiR:   [0.82, 0.20, 0.09, 0.13],
  shadeMidR:  [0.80, 0.40, 0.09, 0.10],
  shadeLowR:  [0.76, 0.56, 0.08, 0.06],
  sunHiL:     [0.04, 0.20, 0.09, 0.13],
  sunMidL:    [0.07, 0.40, 0.09, 0.10],
  zenith:     [0.45, 0.02, 0.10, 0.04],
  skyBand:    [0.40, 0.06, 0.20, 0.14],
  roadShade:  [0.44, 0.72, 0.12, 0.05],
};

const REGIONS = process.argv.includes('--walls') ? WALLS : GROUND;

const t = Number(arg('t', 0.4));
const yaw = Number(arg('yaw', 0));
const pitch = Number(arg('pitch', -0.22));

await run({ width: 1600, height: 900 }, async ({ page }) => {
  const out = await page.evaluate(
    ({ t, yaw, pitch, REGIONS }) => {
      const s = window.__scene;
      s.goTo(t); s.setYaw(yaw); s.setPitch(pitch); s.warp(1.5);
      s.setPaused(true); s.renderOnce();

      const cv = s.renderer.domElement;
      const w = cv.width, h = cv.height;
      const off = document.createElement('canvas');
      off.width = w; off.height = h;
      off.getContext('2d').drawImage(cv, 0, 0);
      const ctx = off.getContext('2d');

      const res = {};
      for (const [name, [fx, fy, fw, fh]] of Object.entries(REGIONS)) {
        const d = ctx.getImageData(
          Math.round(fx * w), Math.round(fy * h),
          Math.max(1, Math.round(fw * w)), Math.max(1, Math.round(fh * h)),
        ).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
        res[name] = [r / n / 255, g / n / 255, b / n / 255];
      }
      s.setPaused(false);
      return res;
    },
    { t, yaw, pitch, REGIONS },
  );

  const f = (x) => x.toFixed(3);
  console.log(`\n  region        sRGB mean          luma    B/R`);
  const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  for (const [k, c] of Object.entries(out)) {
    const L = luma(c);
    // Blue over red in sRGB. Above 1 is a cold surface, below 1 a warm one;
    // it is the one number the golden-hour read lives or dies on.
    console.log(
      `  ${k.padEnd(12)}  ${f(c[0])} ${f(c[1])} ${f(c[2])}   ${f(L)}   ${(c[2] / Math.max(c[0], 1e-4)).toFixed(3)}`,
    );
  }
  console.log('');
});
