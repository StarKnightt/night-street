/* Provenance test: was a constant authored by inverting the withdrawn fit?
 *
 *   node tools/oldcurve.mjs
 *
 * For each candidate this prints, side by side:
 *
 *   what the value arrives at on screen now, through the real transform
 *     (tools/agx.mjs, imported — nothing is retyped here);
 *   what the withdrawn fit `display = 0.284 * L^0.4545` would have returned
 *     for the same radiance, which is the number whoever authored it believed
 *     they were setting;
 *   the radiance the real transform needs for that believed target, at the
 *     same chromaticity;
 *   and the ratio between the two.
 *
 * A candidate is only interesting when the fit's prediction lands on the
 * target its comment names AND the ratio comes out near the 3-6x the fit
 * over-predicts by in this band. Either one alone is a coincidence.
 *
 * The chromaticity is carried through unchanged, because AgX runs each channel
 * through two chroma matrices and a saturated colour does not map like a
 * neutral of the same peak. See scene/tone.ts.
 */
import { display } from './agx.mjs';

const SENSOR = { sensor: true };

/** The withdrawn fit, forward, per channel. Here only to date a constant. */
const fitFwd = (L) => Math.round(0.284 * Math.pow(Math.max(L, 0), 0.4545) * 255);
/** The withdrawn fit, inverted — the operation that produced the bad values. */
const fitInv = (v8) => Math.pow(v8 / 255 / 0.284, 2.2);

/** A colour at this chromaticity whose peak channel arrives at v8. Bisection,
 *  the same shape as tone.ts's atDisplay, since the forward transform clamps. */
function atDisplay(v8, chroma) {
  const peak = Math.max(...chroma);
  const ch = chroma.indexOf(peak);
  let lo = 1e-4, hi = 1e4;
  for (let i = 0; i < 60; i++) {
    const mid = Math.sqrt(lo * hi);
    if (display(chroma.map((c) => (c / peak) * mid), SENSOR)[ch] < v8) lo = mid;
    else hi = mid;
  }
  const L = Math.sqrt(lo * hi) / peak;
  return chroma.map((c) => c * L);
}

const f = (n, p = 3) => n.toFixed(p);
const trip = (v) => `(${v.map((x) => f(x, 2)).join(', ')})`;

/* Each entry: what it is, where it lives, its value now, and the display value
 * its own comment says it was authored for. `target: null` means the comment
 * names no target, which is itself the finding. */
const CANDIDATES = [
  { name: 'litWall, sunlit stucco in a shopfront reflection',
    where: 'streetMaterials.ts:849', L: [3.85, 2.25, 0.98], target: 191,
    note: 'corrected in 442fbe5 from (13.0, 7.60, 3.30)' },
  { name: 'sunlit footway in a shopfront reflection',
    where: 'streetMaterials.ts:920', L: [9.50, 6.80, 4.00], target: 178,
    note: 'comment: "display 170 to 186 ... a scene radiance near seven"' },
  { name: 'winC, lit window in a shopfront reflection',
    where: 'streetMaterials.ts:870', L: [3.60, 2.40, 1.25], target: null },
  { name: 'glassC, glazing opposite in a shopfront reflection',
    where: 'streetMaterials.ts:890', L: [2.60, 1.75, 1.05], target: null },
  { name: 'shadeWall, shaded frontage in a shopfront reflection',
    where: 'streetMaterials.ts:813', L: [0.30, 0.31, 0.37], target: null },
  { name: 'warm, sunlit frontage in an upper-window reflection',
    where: 'buildingMaterials.ts:1274', L: [2.60, 1.48, 0.62], target: null },
  { name: 'LIT_ROOM, first-floor room behind a sash',
    where: 'buildingMaterials.ts:1072', L: null, target: 58,
    chroma: [1.0, 0.583, 0.251],
    note: 'built by forDisplay(58); the bracketing argument is what is in doubt' },
  { name: "LIT_STORE, the shop interior's emissive ceiling x 1.55 x 1.35",
    where: 'street3.ts:1398', L: [1.674, 1.109, 0.523], target: null,
    note: 'buildingMaterials.ts:1055 asserts this "lands at 92"' },
];

console.log('\nradiance now                    -> arrives at      the fit said');
for (const c of CANDIDATES) {
  const L = c.L ?? atDisplay(c.target, c.chroma);
  const now = display(L, SENSOR);
  const believed = L.map(fitFwd);
  console.log(`\n${c.name}\n  ${c.where}`);
  if (c.note) console.log(`  ${c.note}`);
  console.log(`  L ${trip(L)}  -> ${trip(now)}   fit would have called it ${trip(believed)}`);
  if (c.target != null) {
    const want = atDisplay(c.target, L);
    console.log(`  for display ${c.target} the real transform wants ${trip(want)}`
      + `   ratio ${f(L[0] / want[0], 2)}x`);
    console.log(`  the fit, inverted for ${c.target} at this chroma, gives `
      + `${trip(L.map((v) => v / Math.max(...L) * fitInv(c.target)))}`);
  }
}

console.log('\n\nThe fit against the transform, neutral, over the band this scene uses');
console.log('  target   fit inverse   real inverse   over-prediction');
for (const v of [44, 58, 92, 132, 170, 178, 186, 191, 214, 232]) {
  const real = atDisplay(v, [1, 1, 1])[0];
  console.log(`  ${String(v).padStart(5)}   ${f(fitInv(v)).padStart(11)}`
    + `   ${f(real).padStart(12)}   ${f(fitInv(v) / real, 2).padStart(6)}x`);
}
console.log();
