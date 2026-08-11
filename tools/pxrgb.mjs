/* Per-channel sampler, with a real three-channel tone inversion.
 *
 * `pxat.mjs` answers "how bright is this patch" — it collapses the box to a
 * luma and inverts that through the neutral curve. That is the right tool for
 * a grey and the wrong one for anything with chroma in it, which is most of
 * what System 8 has to argue about: a shop interior, a sunlit fascia, the
 * carriageway's hue. NOTES.md is explicit that AgX runs each channel through
 * two chroma matrices, so a saturated colour does not invert like a grey of
 * the same peak, and it tells you to pass the triple to agx.mjs. This does
 * that automatically, for a list of points, and prints the answer as a triple.
 *
 * The inversion is a damped multiplicative fixed point in log radiance rather
 * than a per-channel bisection, because the three channels are coupled: the
 * red output depends on the blue input through INSET/OUTSET. Twelve iterations
 * from the neutral inverse as a seed lands every channel within a code value,
 * and the residual is printed so a point that did not converge — anything on
 * the clip, where there is no inverse at all — says so rather than lying.
 *
 * Also prints HSV saturation, which is the quantity NOTES.md states the road
 * target in.
 *
 *   node tools/pxrgb.mjs shots/sys8a/store.png 566,396 591,409 --box 7
 */
import { readPNG } from './pxfile.mjs';
import { display, invert } from './agx.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const BOX = +flag('box', 5);
const pts = args.filter((a) => /^\d+,\d+$/.test(a));
const file = args.find((a) => !a.startsWith('--') && !/^\d+,\d+$/.test(a));

/** The linear scene radiance that arrives at this triple of 8-bit codes. */
export function invertRGB(code) {
  // Seed each channel with the neutral answer, then relax on the real
  // transform. Damped in log space: the shoulder's slope varies tenfold and an
  // undamped step overshoots into the clip and never comes back.
  let L = code.map((c) => Math.max(invert(Math.max(1, Math.min(254, c)), { sensor: true }), 1e-5));
  for (let i = 0; i < 40; i++) {
    const got = display(L, { sensor: true });
    let moved = 0;
    L = L.map((v, k) => {
      // Work on the encoded value's ratio, not the code's: a code difference
      // of one near black is a huge radiance ratio and near white is none.
      const want = Math.max(code[k], 0.5) / 255, has = Math.max(got[k], 0.5) / 255;
      const step = Math.pow(want / has, 2.2 * 0.55);
      moved = Math.max(moved, Math.abs(Math.log(step)));
      return Math.max(v * step, 1e-6);
    });
    if (moved < 1e-6) break;
  }
  return { L, err: display(L, { sensor: true }).map((v, k) => v - code[k]) };
}

const f = (v, n = 3) => v.toFixed(n).padStart(n + 4);

if (pts.length && file) {
  const img = readPNG(file);
  console.log(`\n  ${file}  ${img.w}x${img.h}  ${BOX}x${BOX} boxes\n`);
  console.log('  point         sRGB code        L(linear radiance)         sat   R:B   err');
  for (const p of pts) {
    const [cx, cy] = p.split(',').map(Number);
    const h = BOX >> 1;
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = cy - h; y <= cy + h; y++) {
      for (let x = cx - h; x <= cx + h; x++) {
        if (x < 0 || y < 0 || x >= img.w || y >= img.h) continue;
        // img.ch, not 4: readPNG hands back three bytes per pixel for a colour
        // type 2 file, and a hardcoded stride of four walks off the end of the
        // buffer near the bottom of the frame and reads the wrong pixel
        // everywhere else.
        const i = (y * img.w + x) * img.ch;
        r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; n++;
      }
    }
    const code = [r / n, g / n, b / n];
    const { L, err } = invertRGB(code);
    const mx = Math.max(...code), mn = Math.min(...code);
    const sat = mx <= 0 ? 0 : (mx - mn) / mx;
    console.log(`  ${p.padEnd(12)} ${code.map((c) => c.toFixed(1).padStart(5)).join(' ')}   `
      + `${L.map((v) => f(v, 4)).join(' ')}   ${sat.toFixed(3)} ${(L[0] / Math.max(L[2], 1e-9)).toFixed(2).padStart(5)}   `
      + `${err.map((e) => e.toFixed(1)).join(',')}`);
  }
  console.log('');
}
