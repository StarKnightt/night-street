/* Does the sky's sun follow the street's sun?
 *
 * clouds.ts used to transcribe the sun three times and claim it could not
 * disagree with the street. This evaluates the derivation that replaced those
 * transcriptions, at any elevation, so the claim can be checked rather than
 * asserted — and so that the values which used to be typed into the file can be
 * compared against the values that are now computed, at the elevation they were
 * typed for.
 *
 *   node tools/sunderive.mjs [deg ...]        default 4.2 12
 *
 * The 4.2 column is the regression: those numbers appear in the deleted comment
 * table in clouds.ts, and if the derivation does not reproduce them the refactor
 * changed the picture while claiming not to.
 */
const SIGMA_R = [0.0303 / 8.0, 0.0521 / 8.0, 0.1177 / 8.0];
const SIGMA_A = [0.0879 / 1.2, 0.1000 / 1.2, 0.1246 / 1.2];
const H_RAY = 8.0, H_AER = 1.2;

/* The key light, decoded exactly as src/scene/sun.ts decodes it. */
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const HEX = 0xff9a4e, INTENSITY = 115;
const BEAM_GROUND = [
  srgbToLinear(((HEX >> 16) & 255) / 255) * INTENSITY,
  srgbToLinear(((HEX >> 8) & 255) / 255) * INTENSITY,
  srgbToLinear((HEX & 255) / 255) * INTENSITY,
];

/* What the old file had typed into it at 4.2 degrees, for the regression. */
const TYPED = {
  0: [0.246, 0.165, 0.0567],
  1.5: [0.459, 0.344, 0.154],
  4.2: [0.705, 0.591, 0.356],
  8.0: [0.883, 0.808, 0.617],
};
const DECKS = [
  { name: 'cirrus', km: 8.0, thick: 0.30 },
  { name: 'alto', km: 4.2, thick: 0.60 },
  { name: 'cumulus', km: 1.5, thick: 0.80 },
];

function model(deg) {
  const el = (deg * Math.PI) / 180;
  const sin = Math.sin(el);
  const m = 1 / (sin + 0.50572 * Math.pow(deg + 6.07995, -1.6364));
  const T = (km) => {
    const cR = H_RAY * Math.exp(-km / H_RAY) * m;
    const cA = H_AER * Math.exp(-km / H_AER) * m;
    return [0, 1, 2].map((i) => Math.exp(-(SIGMA_R[i] * cR + SIGMA_A[i] * cA)));
  };
  const g = T(0);
  const beam = (km) => T(km).map((t, i) => (BEAM_GROUND[i] * t) / g[i]);
  return { deg, sin, m, T, beam, pathMul: 1 / sin };
}

const f = (x, n = 4) => x.toFixed(n).padStart(9);
const degs = process.argv.slice(2).map(Number);
const list = degs.length ? degs : [4.2, 12];

console.log(`\n  key light, linear: ${BEAM_GROUND.map((x) => x.toFixed(3)).join(', ')}`);
console.log('  (the value clouds.ts used to have typed as 115.0, 37.17, 8.76)\n');

for (const deg of list) {
  const M = model(deg);
  console.log(`  ── sun at ${deg} degrees ──`);
  console.log(`  air mass ${M.m.toFixed(3)}   sin ${M.sin.toFixed(5)}   ` +
    `path amplification ${M.pathMul.toFixed(2)}x`);
  console.log('  altitude   T(red)    T(green)   T(blue)' +
    (TYPED && Math.abs(deg - 4.2) < 1e-9 ? '     vs the table that was typed' : ''));
  for (const km of [0, 1.5, 4.2, 8.0]) {
    const t = M.T(km);
    let cmp = '';
    if (Math.abs(deg - 4.2) < 1e-9) {
      const w = TYPED[km];
      const err = Math.max(...t.map((v, i) => Math.abs(v / w[i] - 1)));
      cmp = `     ${w.map((x) => x.toFixed(3)).join(' / ')}   worst ${(err * 100).toFixed(2)}%`;
    }
    console.log(`  ${String(km).padStart(5)} km ${f(t[0])}${f(t[1])}${f(t[2])}${cmp}`);
  }
  console.log('  deck beams (linear), and how red each is:');
  for (const d of DECKS) {
    const b = M.beam(d.km);
    console.log(`    ${d.name.padEnd(8)} ${b.map((x) => x.toFixed(1).padStart(7)).join(' ')}` +
      `   R:G:B = ${(b[0] / b[2]).toFixed(2)} : ${(b[1] / b[2]).toFixed(2)} : 1` +
      `   sunKm ${(d.thick * M.pathMul).toFixed(2)}`);
  }
  console.log('');
}
