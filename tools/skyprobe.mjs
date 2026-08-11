/* What the sky actually puts on a wall.
 *
 * "Shade reads warm" is a claim about hue, and hue in a rendered frame is the
 * product of three things that are authored in three different files: the sky
 * dome, whatever the shaders add on top of it, and the haze in front of it. The
 * only way to know which one is at fault is to integrate the dome directly,
 * outside the renderer, and look at the number.
 *
 * This reimplements skyRadiance from src/scene/env.ts (it is pure arithmetic on
 * two angles, so there is nothing to mock) and cosine-integrates it over the
 * hemisphere of a given normal. That is exactly what the diffuse IBL term is,
 * so the ratios it prints are the ratios the shaded surfaces in the frame will
 * have — before the shaders touch them.
 *
 *   node tools/skyprobe.mjs
 */
const SUN_ELEV = 4.2 * Math.PI / 180;
const SUN_AZIM = 35.0 * Math.PI / 180;
const SUN_DIR = [
  Math.sin(SUN_AZIM) * Math.cos(SUN_ELEV),
  Math.sin(SUN_ELEV),
  -Math.cos(SUN_AZIM) * Math.cos(SUN_ELEV),
];

const mix3 = (a, b, t, o) => {
  o[0] = a[0] + (b[0] - a[0]) * t;
  o[1] = a[1] + (b[1] - a[1]) * t;
  o[2] = a[2] + (b[2] - a[2]) * t;
};

/* Kept deliberately parameterised so a candidate change can be tried here, in
 * a hundred milliseconds, before it costs a thirty-five second capture. */
/* Resynced to src/scene/env.ts. Every one of these had drifted — the exponent
 * was still 2.2 after env.ts moved to 4.6, the zenith and the anti-sun horizon
 * were the pre-cooling values, and the halo was the wrong width and weight — so
 * the tool was reporting the irradiance of a sky the renderer stopped using
 * several rounds ago. Keep this block and env.ts's skyRadiance in step. */
export const SKY = {
  zenith: [0.0850, 0.1300, 0.3600],
  upperWarm: [0.7400, 0.3900, 0.3450],
  horizonSun: [3.4000, 1.4200, 0.4200],
  horizonAway: [0.2000, 0.2000, 0.3100],
  azPow: 4.6,
  hPow: 5.6,
  mPow: 2.30,
  warmFloor: 0.14,     // how much upperWarm reaches the anti-sun sky
  wideHalo: 0.45,
  wideK: 5.6,
};

export function skyRadiance(theta, phi, out, withDisc = false, S = SKY) {
  const up = Math.cos(theta);
  const sinT = Math.sin(theta);
  const dx = Math.cos(phi) * sinT, dy = up, dz = Math.sin(phi) * sinT;
  const cosSun = dx * SUN_DIR[0] + dy * SUN_DIR[1] + dz * SUN_DIR[2];

  const azW = Math.pow(Math.max(0, 0.5 + 0.5 * (
    (dx * SUN_DIR[0] + dz * SUN_DIR[2]) /
    Math.max(1e-4, Math.hypot(dx, dz) * Math.hypot(SUN_DIR[0], SUN_DIR[2]))
  )), S.azPow);

  const h = Math.pow(Math.max(0, 1 - Math.max(0, up)), S.hPow);
  const m = Math.pow(Math.max(0, 1 - Math.max(0, up)), S.mPow);

  const horizonC = [0, 0, 0];
  mix3(S.horizonAway, S.horizonSun, azW, horizonC);
  const base = [0, 0, 0];
  mix3(S.zenith, S.upperWarm, m * (S.warmFloor + (1 - S.warmFloor) * azW), base);
  const col = [0, 0, 0];
  mix3(base, horizonC, h, col);

  const ang = Math.acos(Math.max(-1, Math.min(1, cosSun)));
  const wide = Math.exp(-ang * S.wideK) * S.wideHalo;
  const tight = Math.exp(-ang * 19.0) * 5.60;
  const halo = wide + tight;
  col[0] += halo * 1.60; col[1] += halo * 0.86; col[2] += halo * 0.34;

  if (withDisc) {
    const disc = Math.exp(-ang * 150.0) * 190.0;
    col[0] += disc * 1.00; col[1] += disc * 0.80; col[2] += disc * 0.52;
  }

  if (up < 0) {
    const d = Math.min(1, -up * 1.15);
    const gnd = [col[0] * 0.52 + 0.030, col[1] * 0.50 + 0.024, col[2] * 0.54 + 0.026];
    mix3(col, gnd, d * 0.85, col);
  }
  out[0] = col[0]; out[1] = col[1]; out[2] = col[2];
}

/** Cosine-weighted irradiance over the hemisphere about n, in the same units. */
export function irradiance(n, S = SKY, N = 220) {
  const c = [0, 0, 0];
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < N; i++) {
    const theta = ((i + 0.5) / N) * Math.PI;
    const sinT = Math.sin(theta), cosT = Math.cos(theta);
    const dw = (Math.PI / N) * (2 * Math.PI / (2 * N)) * sinT;
    for (let j = 0; j < 2 * N; j++) {
      const phi = ((j + 0.5) / (2 * N) - 0.5) * Math.PI * 2;
      const d = [Math.cos(phi) * sinT, cosT, Math.sin(phi) * sinT];
      const nd = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
      if (nd <= 0) continue;
      skyRadiance(theta, phi, c, false, S);
      r += c[0] * nd * dw; g += c[1] * nd * dw; b += c[2] * nd * dw;
    }
  }
  return [r, g, b];
}

const f = (v) => v.toFixed(4).padStart(8);
const report = (label, n, S) => {
  const E = irradiance(n, S);
  const lum = 0.2126 * E[0] + 0.7152 * E[1] + 0.0722 * E[2];
  // Blue-over-red is the number that decides whether shade reads cold.
  console.log(`  ${label.padEnd(26)} E=${f(E[0])}${f(E[1])}${f(E[2])}   lum=${lum.toFixed(4)}  B/R=${(E[2] / E[0]).toFixed(3)}`);
};

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  console.log('\n  Sky irradiance by surface orientation (linear, disc excluded)\n');
  report('shaded wall  N=(-1,0,0)', [-1, 0, 0]);
  report('sunlit wall  N=(+1,0,0)', [1, 0, 0]);
  report('road         N=(0,1,0)', [0, 1, 0]);
  report('down-street  N=(0,0,+1)', [0, 0, 1]);
  console.log('');
  // What a patch of dome looks like on its own, which is what "is the sky
  // blue-violet or warm" actually asks.
  const c = [0, 0, 0];
  const dirs = [
    ['zenith', 0.02, 0], ['45 up, anti-sun', Math.PI * 0.25, Math.atan2(SUN_DIR[2], SUN_DIR[0]) + Math.PI],
    ['45 up, sunward', Math.PI * 0.25, Math.atan2(SUN_DIR[2], SUN_DIR[0])],
    ['70 up, anti-sun', Math.PI * 0.39, Math.atan2(SUN_DIR[2], SUN_DIR[0]) + Math.PI],
    ['horizon, anti-sun', Math.PI * 0.499, Math.atan2(SUN_DIR[2], SUN_DIR[0]) + Math.PI],
    ['horizon, sunward', Math.PI * 0.499, Math.atan2(SUN_DIR[2], SUN_DIR[0])],
  ];
  for (const [label, th, ph] of dirs) {
    skyRadiance(th, ph, c);
    console.log(`  ${label.padEnd(26)} L=${f(c[0])}${f(c[1])}${f(c[2])}   B/R=${(c[2] / c[0]).toFixed(3)}`);
  }
  console.log('');
}
