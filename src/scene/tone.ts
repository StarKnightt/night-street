/* The display transform, in the bundle, so a level can be authored by
 * inverting it rather than by inverting a description of it.
 *
 * COLOUR SPACE. In: linear scene radiance, sRGB primaries. Out: the 8-bit code
 * value that radiance arrives at on screen, after AgX at
 * toneMappingExposure = 0.296, after sensor.ts's pedestal, after the sRGB
 * encode. Nothing here is a fit and nothing here has a free parameter.
 *
 * ── Why this file exists rather than a table of constants ─────────────────
 *
 * Because a table of constants is exactly what caused the problem it fixes.
 * `display = 0.284 * L^0.4545` stood in NOTES.md and in three files' comments
 * for most of this project's life; it was the sRGB gamma with its scale fitted
 * to one point that had been measured through a sheet of glass, so what it
 * actually described was the pane's Fresnel reflectance. It over-predicts the
 * radiance needed for a given display value by three times at L = 21, five at
 * L = 55 and six at L = 90-110 — and this scene lives in exactly that band, so
 * every emissive in System 5 was authored several times too hot. See NOTES.md,
 * "The display response".
 *
 * A constant inverted by hand once is a constant nobody can re-derive. Calling
 * the transform means the next person who wants a lamp bowl at display 214
 * writes 214, and the radiance follows whatever the pipeline actually does.
 *
 * ── The relationship to tools/agx.mjs ─────────────────────────────────────
 *
 * `tools/agx.mjs` is authoritative and is the copy that gets checked against
 * measured frames. This is the same port, term for term, out of the same
 * chunks in node_modules. It is a second copy because agx.mjs is a CLI that
 * touches `process.argv` at module scope and cannot be imported into a browser
 * bundle. The two agree to the last code value over 0.001 <= L <= 1000; if
 * they ever stop agreeing, agx.mjs is right and this is stale.
 */

const EXPOSURE = 0.296;

const M = (m: readonly number[], v: readonly number[]): [number, number, number] => [
  m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
  m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
  m[2] * v[0] + m[5] * v[1] + m[8] * v[2],
];

// Column-major, exactly as the mat3 constructors in the chunk are written.
const SRGB_TO_2020 = [0.6274, 0.0691, 0.0164, 0.3293, 0.9195, 0.0880, 0.0433, 0.0113, 0.8956];
const REC2020_TO_SRGB = [1.6605, -0.1246, -0.0182, -0.5876, 1.1329, -0.1006, -0.0728, -0.0083, 1.1187];
const INSET = [
  0.856627153315983, 0.137318972929847, 0.11189821299995,
  0.0951212405381588, 0.761241990602591, 0.0767994186031903,
  0.0482516061458583, 0.101439036467562, 0.811302368396859,
];
const OUTSET = [
  1.1271005818144368, -0.1413297634984383, -0.14132976349843826,
  -0.11060664309660323, 1.157823702216272, -0.11060664309660294,
  -0.016493938717834573, -0.016493938717834257, 1.2519364065950405,
];
const MIN_EV = -12.47393, MAX_EV = 4.026069;

const contrast = (x: number): number => {
  const x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4
    - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
};

const encode = (v: number): number =>
  (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/* sensor.ts's pedestal and gain, which act on the tone-mapped linear value
 * before the encode because sensor.ts prepends itself to colorspace_fragment.
 * Every fragment the renderer draws carries it; leaving it out is right in the
 * midtones and up to fifteen counts low in the shadows. Noise omitted, being
 * zero-mean. */
const pedestal = (c: readonly number[]): [number, number, number] =>
  [c[0] * 0.955 + 0.0040, c[1] * 0.955 + 0.0046, c[2] * 0.955 + 0.0070];

/** Linear scene radiance -> the 8-bit code values it arrives at. */
export function display(rgb: readonly number[]): [number, number, number] {
  let c: readonly number[] = rgb.map((v) => v * EXPOSURE);
  c = M(SRGB_TO_2020, c);
  c = M(INSET, c);
  c = c.map((v) => (Math.log2(Math.max(v, 1e-10)) - MIN_EV) / (MAX_EV - MIN_EV));
  c = c.map((v) => Math.min(1, Math.max(0, v)));
  c = c.map(contrast);
  c = M(OUTSET, c);
  c = c.map((v) => Math.pow(Math.max(0, v), 2.2));
  c = M(REC2020_TO_SRGB, c);
  c = pedestal(c.map((v) => Math.min(1, Math.max(0, v))));
  return c.map((v) => Math.round(encode(v) * 255)) as [number, number, number];
}

/**
 * A colour whose peak channel arrives at `v8`.
 *
 * `chroma` is a direction in linear radiance, not a colour picked on screen —
 * it is scaled, not reinterpreted, so the ratios between the channels going in
 * are preserved exactly and only the level is solved for. What comes *out* on
 * screen is a different set of ratios, because AgX runs each channel through
 * two chroma matrices: a saturated colour does not map like a neutral of the
 * same peak. That is the whole reason this takes a triple rather than a
 * magnitude. Check the delivered colour with `display()`; do not assume it.
 *
 * Bisection rather than an analytic inverse because the forward transform has
 * a clamp in the middle of it, and above the clamp there is no inverse at all
 * — the answer there is "anything, it is white". Sixty iterations over eight
 * decades converges to well under a code value and runs once at module load.
 */
export function atDisplay(
  v8: number, chroma: readonly [number, number, number],
): [number, number, number] {
  const peak = Math.max(chroma[0], chroma[1], chroma[2]);
  const ch = chroma.indexOf(peak);
  let lo = 1e-4, hi = 1e4;
  for (let i = 0; i < 60; i++) {
    const mid = Math.sqrt(lo * hi);
    if (display(chroma.map((c) => (c / peak) * mid))[ch] < v8) lo = mid; else hi = mid;
  }
  const L = Math.sqrt(lo * hi) / peak;
  return [chroma[0] * L, chroma[1] * L, chroma[2] * L];
}

/** The neutral radiance that arrives at `v8`. For reading a grey off a frame. */
export const forDisplay = (v8: number): number => atDisplay(v8, [1, 1, 1])[0];
