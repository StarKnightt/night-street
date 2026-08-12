/* Choosing the lantern's distribution and its intensity, offline.
 *
 * This is a DESIGN tool, not a measurement. It replicates the lamp geometry
 * and the point-source term of `artificial()` so that a candidate distribution
 * can be evaluated in a second rather than in a four-minute browser session.
 * Every number it produces is provisional until `tools/sunlamp.mjs` has read
 * the same quantity back off the real renderer through the debug mirror —
 * which is the whole point of that tool existing, and the reason this one does
 * not get to conclude anything.
 *
 *   node tools/lampdesign.mjs [cd] [cap]
 */
const LAMP_H = 6.8, OUTREACH = 1.15;
const LAMPS = [[4.3, 12], [-4.3, -8], [4.3, -25], [-4.3, -45], [4.3, -64], [-4.3, -84], [4.3, -99]];
const HEADS = LAMPS.map(([x, z]) => [x - Math.sign(x) * OUTREACH, LAMP_H, z]);

const CD = Number(process.argv[2] || 24);
const CAP = Number(process.argv[3] || 2.4);

/* The shaded carriageway, from tools/tonecheck.mjs, and the diffuse transfer
 * from irradiance to radiance on it. Both are quoted in NOTES.md. */
const SHADE_L = 0.038, XFER = 0.0322;
const ANCHOR = [[0.001, 15], [0.00562, 15], [0.01, 16], [0.01778, 19], [0.03162, 25],
  [0.05623, 36], [0.1, 52], [0.17783, 73], [0.31623, 97], [0.56234, 123],
  [1, 149], [1.77828, 174], [3.16228, 196], [5.62341, 215], [10, 229]];
const count = (L) => {
  const x = Math.max(L, 1e-6);
  for (let i = 1; i < ANCHOR.length; i++) {
    if (x <= ANCHOR[i][0] || i === ANCHOR.length - 1) {
      const [x0, y0] = ANCHOR[i - 1], [x1, y1] = ANCHOR[i];
      return y0 * Math.pow(x / x0, Math.log(y1 / y0) / Math.log(x1 / x0));
    }
  }
  return 255;
};

// cos^1.6 about the tilted axis — what ships today.
const cosPow = (ax) => Math.pow(Math.max(ax, 0), 1.6);
/* A semi-cut-off street lantern. Uniform illuminance on a flat road wants
 * I proportional to 1/cos^3 of the angle from nadir; a real reflector chases
 * that to somewhere near 65 degrees, caps out, then cuts off hard so the light
 * does not go through bedroom windows. Three lines and it is the difference
 * between a spot under the column and a lit street. */
const batwing = (ax) => {
  if (ax <= 0) return 0;
  const cut = Math.min(1, Math.max(0, (ax - 0.18) / (0.32 - 0.18)));
  return Math.min(Math.pow(ax, -3), CAP) * (cut * cut * (3 - 2 * cut));
};

/* The same lobe, squeezed across the street.
 *
 * A symmetric batwing is not what a street lantern does — it would put as much
 * light on the buildings as along the carriageway, and its flux would be four
 * times a 100 W lantern's. A real reflector throws along the road axis and cuts
 * off across it, which is what buys the overlap without buying the flux. `CROSS`
 * is how many times faster the lobe closes across the street than along it.
 */
const CROSS = Number(process.argv[4] || 2.2);
const batwingAniso = (c, ts, tc) => {
  if (c <= 0) return 0;
  const tcx = tc * CROSS;
  const cs = c / Math.sqrt(c * c + ts * ts + tcx * tcx);
  return batwing(cs);
};

/** Lower-hemisphere flux, so a candidate can be checked against a real lamp. */
function flux(kind) {
  let s = 0;
  const N = 240;
  for (let i = 0; i < N; i++) {
    const th = (i + 0.5) * (Math.PI / 2) / N;
    for (let j = 0; j < 4 * N; j++) {
      const ph = (j + 0.5) * (2 * Math.PI) / (4 * N);
      const c = Math.cos(th), st = Math.sin(th);
      const ts = st * Math.cos(ph), tc = st * Math.sin(ph);
      const d = kind === 'cos' ? cosPow(c) : kind === 'bat' ? batwing(c) : batwingAniso(c, ts, tc);
      s += d * st * (Math.PI / 2 / N) * (2 * Math.PI / (4 * N));
    }
  }
  return s;      // multiply by I0 for lumens
}

function E(x, z, kind) {
  let e = 0;
  for (const h of HEADS) {
    const d = [h[0] - x, h[1] - 0.02, h[2] - z];
    const d2 = Math.max(d[0] * d[0] + d[1] * d[1] + d[2] * d[2], 0.04);
    const inv = 1 / Math.sqrt(d2);
    const L = [d[0] * inv, d[1] * inv, d[2] * inv];
    const ndl = Math.max(L[1], 0);                       // ground normal is +Y
    const tilt = -Math.sign(h[0] || 1) * 0.37;
    const A = [Math.sin(tilt), -Math.cos(tilt), 0];      // the down axis
    const D = [-L[0], -L[1], -L[2]];                     // lamp -> surface
    const c = D[0] * A[0] + D[1] * A[1] + D[2] * A[2];
    const T = [D[0] - c * A[0], D[1] - c * A[1], D[2] - c * A[2]];
    const ts = T[2];                                     // along the street
    const tc = Math.hypot(T[0], T[1]);                   // across it
    const dis = kind === 'cos' ? cosPow(c) : kind === 'bat' ? batwing(c) : batwingAniso(c, ts, tc);
    e += (CD * dis * ndl) / d2;
  }
  return e;
}

console.log(`  flux per candela of nadir intensity:  cos^1.6 ${flux('cos').toFixed(2)}` +
  `   batwing ${flux('bat').toFixed(2)}   batwing x${CROSS} ${flux('aniso').toFixed(2)} sr`);

for (const [name, dist] of [['cos^1.6 (shipped)', 'cos'], [`batwing cap ${CAP}`, 'bat'],
  [`aniso x${CROSS}`, 'aniso']]) {
  for (const [lane, x] of [['centre', 0], ['walkL', -3.15], ['walkR', 3.15]]) {
    const v = [];
    for (let z = 14; z >= -101; z -= 0.5) v.push([z, E(x, z, dist)]);
    const es = v.map((p) => p[1]);
    const mx = Math.max(...es), mn = Math.min(...es);
    const dPeak = count(SHADE_L + mx * XFER) - count(SHADE_L);
    const dMin = count(SHADE_L + mn * XFER) - count(SHADE_L);
    console.log(`${name.padEnd(18)} ${lane.padEnd(7)} cd ${CD}` +
      `  peak E ${mx.toFixed(3)} (+${dPeak.toFixed(1)} counts)` +
      `  floor E ${mn.toFixed(3)} (+${dMin.toFixed(1)})` +
      `  uniformity min/peak ${(mn / mx).toFixed(2)}`);
  }
}
