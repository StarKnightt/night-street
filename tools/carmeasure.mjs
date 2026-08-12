/* The two car defects that have a number attached to them, measured.
 *
 * Both reviews stated their findings at native resolution, so both are
 * measured here in native pixels of a 1920x1080 frame rather than as viewport
 * fractions — a wheel arch is 120 px across and a fraction of the frame is
 * not a stable way to name it across two builds.
 *
 * `arch`  the box the see-through arch was reported in. What matters is not
 *         the mean, which a dark tyre and a bright road both move, but how
 *         much of the box is *road brightness*: sunlit tarmac in this frame
 *         sits at 95-135 code values and a tyre sits under 40, so the
 *         fraction of the box above 90 is the fraction of the arch you can
 *         see through. A car reads as solid at close to zero.
 *
 * `edge`  the dithered stipple where the dark body meets the lit road. A
 *         dither is a *high-frequency* signal riding on a smooth one, so it
 *         is measured as the mean absolute residual from a 3-tap horizontal
 *         median — a real edge, however hard, has a residual near zero
 *         because a median follows it, and a stipple does not. Reported over
 *         the band of columns that straddle the silhouette.
 *
 *   node tools/carmeasure.mjs shots/cars-before/I-arch.png shots/cars-w1/I-arch.png
 */
import { readPNG } from './pxfile.mjs';

const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : argv[i + 1]; };
const files = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
/* Native-pixel boxes on the I-arch framing, read off the capture. `arch` is
 * the front wheel arch of the sunlit hatch; `edge` straddles the car's lower
 * flank against the lit carriageway behind it. */
const ARCH = (flag('arch', '797,516,900,660')).split(',').map(Number);
const EDGE = (flag('edge', '760,470,1000,700')).split(',').map(Number);

const lum = (d, k) => 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2];

for (const f of files) {
  const img = readPNG(f);
  const L = new Float64Array(img.w * img.h);
  for (let i = 0; i < img.w * img.h; i++) L[i] = lum(img.data, i * img.ch);

  // ── see-through: how much of the arch box is road-bright ──────────────
  {
    const [x0, y0, x1, y1] = ARCH;
    let n = 0, sum = 0, over = 0, mx = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const v = L[y * img.w + x];
        sum += v; n++; if (v > 90) over++; if (v > mx) mx = v;
      }
    }
    console.log(`  ${f}`);
    console.log(`    arch  ${x1 - x0}x${y1 - y0} px   mean ${(sum / n).toFixed(1)}   `
      + `max ${mx.toFixed(0)}   road-bright (>90) ${((over / n) * 100).toFixed(1)}%`);
  }

  // ── stipple: residual from a 3-tap median along the row ───────────────
  {
    const [x0, y0, x1, y1] = EDGE;
    let n = 0, sum = 0, worst = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0 + 1; x < x1 - 1; x++) {
        const i = y * img.w + x;
        const a = L[i - 1], b = L[i], c = L[i + 1];
        const med = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
        const r = Math.abs(b - med);
        sum += r; n++; if (r > worst) worst = r;
      }
    }
    console.log(`    edge  ${x1 - x0}x${y1 - y0} px   mean |residual| `
      + `${(sum / n).toFixed(3)} counts   worst ${worst.toFixed(1)}`);
  }
}
