/* Measure how wide a shadow terminator is, in pixels, on two frames at once.
 *
 * "Does the bigger box coarsen the near shadows" is a question about the width
 * of a transition, and neither a screenshot pair nor a mean luminance can
 * answer it. `profile.mjs` prints the waveform, which is the right shape to
 * look at and the wrong thing to compare two builds with: reading a 10-90
 * width off two columns of hashes by eye is exactly the sort of judgement this
 * project keeps getting wrong.
 *
 * So this collapses a rectangle to a 1-D luminance cut the same way
 * `profile.mjs` does — deliberately the same arithmetic, so the two agree —
 * then fits the 10 and 90 per cent crossings by linear interpolation between
 * samples and prints the distance between them. Sub-pixel, because the whole
 * point is to resolve a difference smaller than a pixel if there is one.
 *
 * Both frames are measured in the same run against the same rectangle, since
 * the only comparison worth making is one where the framing is provably
 * identical.
 *
 *   node tools/edgewidth.mjs shots/sf-old/tilt.png shots/sf-new/tilt.png \
 *        920,300,980,420 --axis y --of 1600
 */
import { readPNG } from './pxfile.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const files = args.filter((a) => a.endsWith('.png'));
const rect = args.find((a) => /^\d+,\d+,\d+,\d+$/.test(a));
const OF = +flag('of', 1600);
const AXIS = flag('axis', 'y');
const LABEL = flag('label', 'edge');

if (!rect || files.length === 0) {
  console.error('usage: edgewidth.mjs a.png [b.png ...] x0,y0,x1,y1 [--axis y] [--of 1600]');
  process.exit(2);
}

/** The cut. Identical in form to `profile.mjs` so the two never disagree. */
function cut(img) {
  const s = img.w / OF;
  const [rx0, ry0, rx1, ry1] = rect.split(',').map(Number);
  const x0 = Math.round(rx0 * s), y0 = Math.round(ry0 * s);
  const x1 = Math.round(rx1 * s), y1 = Math.round(ry1 * s);
  const lum = (i, j) => {
    const k = (j * img.w + i) * img.ch;
    return 0.2126 * img.data[k] + 0.7152 * img.data[k + 1] + 0.0722 * img.data[k + 2];
  };
  const out = [];
  if (AXIS === 'y') {
    for (let j = y0; j < y1; j++) {
      let a = 0; for (let i = x0; i < x1; i++) a += lum(i, j);
      out.push(a / (x1 - x0));
    }
  } else {
    for (let i = x0; i < x1; i++) {
      let a = 0; for (let j = y0; j < y1; j++) a += lum(i, j);
      out.push(a / (y1 - y0));
    }
  }
  return out;
}

/** Where the cut first crosses a level, interpolated between samples. */
function crossing(v, level) {
  for (let i = 1; i < v.length; i++) {
    const a = v[i - 1], b = v[i];
    if ((a - level) * (b - level) <= 0 && a !== b) return i - 1 + (level - a) / (b - a);
  }
  return null;
}

console.log(`\n  ${LABEL}   rect ${rect}  axis ${AXIS}  (coords of ${OF})`);
for (const f of files) {
  const v = cut(readPNG(f));
  const lo = Math.min(...v), hi = Math.max(...v);
  const p10 = crossing(v, lo + 0.1 * (hi - lo));
  const p90 = crossing(v, lo + 0.9 * (hi - lo));
  const w = p10 !== null && p90 !== null ? Math.abs(p90 - p10) : NaN;
  console.log(`  ${f.padEnd(28)} ${lo.toFixed(1).padStart(6)} ..${hi.toFixed(1).padStart(6)}`
    + `   10-90 over ${w.toFixed(2).padStart(6)} px   contrast ${(hi - lo).toFixed(1)}`);
}
console.log('');
