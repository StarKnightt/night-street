/* The display transform, evaluated on the CPU. Not part of the build.
 *
 *   node tools/agx.mjs            the standing report
 *   node tools/agx.mjs 3.4 1.42 0.42     one radiance
 *
 * Why this exists. Every level in this project is supposed to be authored by
 * inverting a target display value through the response curve, and the project
 * carries two incompatible descriptions of that curve:
 *
 *   streetMaterials.ts:777   display = 0.284 * L^0.4545
 *   NOTES.md                 measured off sys5a, L = 1.22 arriving at 184
 *
 * The fit predicts 79 for that radiance. They cannot both describe the same
 * pipeline, and System 6 has to author a beam radiance and a haze floor against
 * one of them. So rather than pick, this evaluates the actual transform: three's
 * AgXToneMapping at toneMappingExposure = 0.296, followed by the sRGB encode,
 * which is exactly what a fragment leaving colorspace_fragment has had done to
 * it. Ported term for term from
 * node_modules/three/src/renderers/shaders/ShaderChunk/tonemapping_pars_fragment.glsl.js
 * and srgb_encode, so it cannot drift from the shader by having been retyped
 * from a paper.
 *
 * INPUT  linear scene radiance, sRGB primaries.
 * OUTPUT 8-bit display code value, sRGB encoded.
 *
 * The sensor pedestal in sensor.ts is deliberately NOT applied here. It is
 * prepended to colorspace_fragment, so it acts on the tone-mapped linear value
 * before the encode — but haze.ts's own tonemap-and-encode does not go through
 * it, so for anything this file is used to author the answer without it is the
 * right one. `--sensor` adds it for comparison.
 */

const EXPOSURE = 0.296;

const M = (m, v) => [
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

const contrast = (x) => {
  const x2 = x * x, x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4
    - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
};

/** Linear scene radiance -> tone-mapped linear, sRGB primaries, 0..1. */
export function agx(rgb, exposure = EXPOSURE) {
  let c = rgb.map((v) => v * exposure);
  c = M(SRGB_TO_2020, c);
  c = M(INSET, c);
  c = c.map((v) => (Math.log2(Math.max(v, 1e-10)) - MIN_EV) / (MAX_EV - MIN_EV));
  c = c.map((v) => Math.min(1, Math.max(0, v)));
  c = c.map(contrast);
  c = M(OUTSET, c);
  c = c.map((v) => Math.pow(Math.max(0, v), 2.2));
  c = M(REC2020_TO_SRGB, c);
  return c.map((v) => Math.min(1, Math.max(0, v)));
}

const encode = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);

/** The sensor pedestal and gain, which act on tone-mapped linear. Noise omitted. */
const pedestal = (c) => [
  c[0] * 0.955 + 0.0040, c[1] * 0.955 + 0.0046, c[2] * 0.955 + 0.0070,
];

/** Linear scene radiance -> 8-bit code values. */
export function display(rgb, { sensor = false, exposure = EXPOSURE } = {}) {
  let c = agx(rgb, exposure);
  if (sensor) c = pedestal(c);
  return c.map((v) => Math.round(encode(v) * 255));
}

/** 8-bit grey code value -> the neutral linear radiance that produces it. */
export function invert(code, { sensor = false } = {}) {
  let lo = 1e-4, hi = 1e4;
  for (let i = 0; i < 80; i++) {
    const mid = Math.sqrt(lo * hi);
    const d = display([mid, mid, mid], { sensor })[1];
    if (d < code) lo = mid; else hi = mid;
  }
  return Math.sqrt(lo * hi);
}

/* ── the sky, mirrored from env.ts skyRadiance for measurement only ──────────
 *
 * A third copy of this function (env.ts has the authority, haze.ts has the
 * GLSL) and it is a knowing duplication: a tool that imports the scene has to
 * be able to resolve @/ aliases and strip types, which is the machinery
 * tools/sys5.ts needed a four-line node -e incantation for. This one is pure
 * arithmetic with no imports at all. If the sky ever changes, this goes stale
 * and says nothing wrong — it just stops describing the build, so check it.
 */
const SUN_ELEV = 4.2 * Math.PI / 180, SUN_AZIM = 35.0 * Math.PI / 180;
export const SUN_DIR = [
  Math.sin(SUN_AZIM) * Math.cos(SUN_ELEV),
  Math.sin(SUN_ELEV),
  -Math.cos(SUN_AZIM) * Math.cos(SUN_ELEV),
];

export function hazeSky(dir) {
  const up = dir[1];
  const fz = [dir[0], dir[2]];
  const azW = Math.pow(Math.max(0, 0.5 + 0.5 * (
    (fz[0] * SUN_DIR[0] + fz[1] * SUN_DIR[2]) /
    Math.max(1e-4, Math.hypot(fz[0], fz[1]) * Math.hypot(SUN_DIR[0], SUN_DIR[2]))
  )), 4.6);

  const zenith = [0.0850, 0.1300, 0.3600];
  const upperWarm = [0.7400, 0.3900, 0.3450];
  const horizonSun = [3.4000, 1.4200, 0.4200];
  const horizonAway = [0.2000, 0.2000, 0.3100];

  const band = Math.pow(Math.max(0, 1 - Math.max(up, 0)), 5.6);
  const mid = Math.pow(Math.max(0, 1 - Math.max(up, 0)), 2.30);
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

  const horizonC = mix(horizonAway, horizonSun, azW);
  const base = mix(zenith, upperWarm, mid * (0.14 + 0.86 * azW));
  let col = mix(base, horizonC, band);

  const ang = Math.acos(Math.max(-1, Math.min(1,
    dir[0] * SUN_DIR[0] + dir[1] * SUN_DIR[1] + dir[2] * SUN_DIR[2])));
  const halo = Math.exp(-ang * 5.6) * 0.45 + Math.exp(-ang * 19.0) * 5.60;
  col = [col[0] + halo * 1.60, col[1] + halo * 0.86, col[2] + halo * 0.34];

  if (up < 0) {
    const d = Math.min(1, -up * 1.15);
    const gnd = [col[0] * 0.52 + 0.030, col[1] * 0.50 + 0.024, col[2] * 0.54 + 0.026];
    col = mix(col, gnd, d * 0.85);
  }
  return col;
}

/** The two-term Henyey-Greenstein phase, as installed in haze.ts. */
export function phase(mu, g1 = 0.42, w1 = 0.78, g2 = -0.20) {
  const hg = (g) => (1 - g * g) / Math.pow(1 + g * g - 2 * g * mu, 1.5);
  return w1 * hg(g1) + (1 - w1) * hg(g2);
}

/* ── report ──────────────────────────────────────────────────────────────── */

if (import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const sensor = process.argv.includes('--sensor');

  if (args.length === 3) {
    const L = args.map(Number);
    console.log(L.join(' '), '->', display(L, { sensor }).join(' '));
    process.exit(0);
  }

  const f = (n, w = 7, p = 3) => n.toFixed(p).padStart(w);

  console.log('\nThe curve, checked against itself');
  console.log('  L        fit 0.284*L^0.4545     AgX@0.296 (neutral grey)');
  for (const L of [0.05, 0.1, 0.2, 0.5, 1.0, 1.22, 2.03, 3.75, 6.54, 8.44, 10.85, 14.6, 30]) {
    const fit = Math.round(0.284 * Math.pow(L, 0.4545) * 255);
    const d = display([L, L, L], { sensor })[1];
    console.log(`  ${f(L, 6, 2)}   ${String(fit).padStart(6)}                ${String(d).padStart(6)}`);
  }

  console.log('\nInverting a target display value (neutral)');
  for (const c of [16, 24, 40, 60, 80, 100, 128, 150, 170, 191, 210, 230, 245]) {
    console.log(`  ${String(c).padStart(3)}  ->  L = ${invert(c, { sensor }).toFixed(4)}`);
  }

  console.log('\nWhat the haze converges to, by direction');
  const dirs = [
    ['down the beam, level   ', [SUN_DIR[0], 0, SUN_DIR[2]]],
    ['at the sun (4.2 up)    ', SUN_DIR],
    ['25 deg off sun, level  ', rot([SUN_DIR[0], 0, SUN_DIR[2]], 25)],
    ['45 deg off sun, level  ', rot([SUN_DIR[0], 0, SUN_DIR[2]], 45)],
    ['90 deg off sun, level  ', rot([SUN_DIR[0], 0, SUN_DIR[2]], 90)],
    ['anti-sun, level        ', rot([SUN_DIR[0], 0, SUN_DIR[2]], 180)],
    ['down the street (-Z)   ', [0, 0, -1]],
    ['looking down 20 deg, sun', norm([SUN_DIR[0], -0.364, SUN_DIR[2]])],
    ['looking down 45 deg, sun', norm([SUN_DIR[0], -1.0, SUN_DIR[2]])],
    ['looking down 45, antisun', norm([...rot([SUN_DIR[0], 0, SUN_DIR[2]], 180), 0].slice(0, 3).map((v, i) => (i === 1 ? -1.0 : v)))],
  ];
  for (const [name, d] of dirs) {
    const L = hazeSky(d);
    const mu = d[0] * SUN_DIR[0] + d[1] * SUN_DIR[1] + d[2] * SUN_DIR[2];
    console.log(`  ${name}  L ${L.map((v) => f(v, 7, 3)).join('')}   -> ${
      display(L, { sensor }).map((v) => String(v).padStart(4)).join('')}   mu ${f(mu, 6, 2)}`);
  }

  console.log('\nPhase function: two-term HG (0.42 / 0.78, -0.20) against pow(mu, 2.2)');
  const P1 = phase(1.0);
  let pMin = Infinity;
  for (let i = 0; i <= 200; i++) pMin = Math.min(pMin, phase(-1 + i / 100));
  console.log(`  normalised as 1 + 2.4 * (P - ${pMin.toFixed(4)}) / (${P1.toFixed(4)} - ${pMin.toFixed(4)})`);
  console.log('   mu      angle     new      old');
  for (const mu of [1, 0.95, 0.9, 0.8, 0.7, 0.5, 0.25, 0, -0.25, -0.5, -0.75, -1]) {
    const nu = 1 + 2.4 * (phase(mu) - pMin) / (P1 - pMin);
    const old = 1 + 2.4 * Math.pow(Math.max(mu, 0), 2.2);
    console.log(`  ${f(mu, 5, 2)}  ${f(Math.acos(mu) * 180 / Math.PI, 7, 1)}   ${f(nu, 7)}  ${f(old, 7)}`);
  }
}

function norm(v) {
  const l = Math.hypot(...v);
  return v.map((x) => x / l);
}
function rot(v, deg) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return norm([v[0] * c + v[2] * s, v[1], -v[0] * s + v[2] * c]);
}
