/* Stance, measured off the built buffers.
 *
 *   node tools/stance.mjs
 *
 * The review says the cars "read as sitting low and soft on their wheels" and
 * offers three candidates: the gap between the tyre crown and the arch lip, how
 * much tyre shows below the sill, and whether the arch opening is a circular cut
 * or a shallow scoop. All three are numbers, and all three are numbers about
 * *built vertices* rather than about the constants that were meant to produce
 * them — which is the distinction that matters here, because the section is
 * refined before it is emitted and an authored feature can be smoothed away
 * between the two.
 *
 * So nothing below reads a Shape. Everything is measured from the geometry
 * `buildCars()` actually hands the renderer.
 *
 * The one thing this tool must not do is report a neighbouring car's wheel as
 * this car's, which the first version did — 1.14 m of half-track on a supermini,
 * which is wider than a bus. Selection is by each car's own collider box grown
 * by 150 mm, and the mirror discs are cut out of it, on the same argument
 * tools/carcount.mjs makes.
 */
import { register } from 'node:module';

register('./ts-hooks.mjs', import.meta.url);

const { buildCars, PARKED, carSolids } = await import('../src/world/cars.ts');
const { roadHeight } = await import('../src/world/geometry.ts');

const cars = buildCars();
const solids = carSolids();
const discs = solids.filter((s) => s.kind === 'mirror');
const boxes = solids.filter((s) => s.kind === 'body');

const KINDS = ['supermini', 'hatch', 'estate', 'saloon', 'van'];
const seen = new Set();
const pick = boxes.filter((b) => {
  const k = b.what.split(' ')[0];
  if (seen.has(k)) return false;
  seen.add(k); return true;
}).sort((a, b) => KINDS.indexOf(a.what.split(' ')[0]) - KINDS.indexOf(b.what.split(' ')[0]));

/** Vertices of one buffer that belong to one car, in that car's own frame. */
function gather(buf, b) {
  const cs = Math.cos(b.yaw), sn = Math.sin(b.yaw);
  const y0 = roadHeight(b.x, b.z);
  const out = [];
  for (let i = 0; i < buf.count; i++) {
    const wx = buf.getX(i), wz = buf.getZ(i);
    if (discs.some((d) => Math.hypot(wx - d.x, wz - d.z) < d.r + 0.075)) continue;
    const dx = wx - b.x, dz = wz - b.z;
    const lx = cs * dx - sn * dz, lz = sn * dx + cs * dz;
    if (Math.abs(lx) > b.hw + 0.15 || Math.abs(lz) > b.hl + 0.15) continue;
    out.push([lx, buf.getY(i) - y0, lz]);
  }
  return out;
}

/** Widest |x| in a slice, in 40 mm height bands. */
function bands(pts, lo, hi) {
  const out = [];
  for (let y = lo; y < hi; y += 0.04) {
    const b = pts.filter((p) => p[1] >= y && p[1] < y + 0.04);
    out.push([y + 0.02, b.length ? Math.max(...b.map((p) => Math.abs(p[0]))) : NaN]);
  }
  return out;
}

for (const b of pick) {
  const body = gather(cars.body.attributes.position, b);
  const wheel = gather(cars.wheel.attributes.position, b);

  const contact = Math.min(...wheel.map((p) => p[1]));
  const crown = Math.max(...wheel.map((p) => p[1]));
  const tyreOut = Math.max(...wheel.map((p) => Math.abs(p[0])));
  // The front axle, from the contact patch rather than from the wheelbase.
  const patch = wheel.filter((p) => p[1] < contact + 0.015 && p[2] < 0);
  const axleF = patch.reduce((a, p) => a + p[2], 0) / patch.length;

  console.log(`\n── ${b.what} ────────────────────────────────────────`);
  console.log(`  wheel        ${((crown - contact) * 1000).toFixed(0)} mm diameter, `
    + `crown at ${crown.toFixed(3)} m, tyre outer face at ${tyreOut.toFixed(4)}`);
  console.log(`  collider     hw ${b.hw.toFixed(4)} — the widest the body may be`);

  /* The section at the axle against the section between the arches. This is the
   * measurement the review is really asking for: an arch lip only reads if it
   * stands proud of the door skin above and behind it, and the two columns are
   * the same car 700 mm apart. */
  const at = body.filter((p) => Math.abs(p[2] - axleF) < 0.035);
  const mid = body.filter((p) => p[2] > axleF + 0.55 && p[2] < axleF + 0.95);
  const A = bands(at, 0.10, 0.95), M = bands(mid, 0.10, 0.95);
  console.log('    height   at the axle   between arches   difference');
  for (let i = 0; i < A.length; i++) {
    const a = A[i][1], m = M[i][1];
    if (!isFinite(a) || !isFinite(m)) continue;
    const d = (a - m) * 1000;
    console.log(`    ${A[i][0].toFixed(2)}     ${a.toFixed(4)}        ${m.toFixed(4)}`
      + `         ${d > 0 ? '+' : ''}${d.toFixed(1)} mm`
      + (d > 4 ? '   lip proud' : ''));
  }
  /* The lip against the tyre, and the comparison has to be made at the *crown*
   * rather than against the widest wheel vertex anywhere.
   *
   * The first version of this took max |x| over the whole wheel and reported the
   * tyre as standing 18 to 46 mm outside the arch on three shapes. That number
   * is real but it is not this measurement: a front wheel here is steered by up
   * to 11 degrees, and steering swings the leading and trailing *tread corners*
   * outboard by up to R·sin(theta), which is 60 mm. Those corners sit at tread
   * height, well below the lip, where a real steered wheel also pokes out of its
   * arch. What decides whether an arch overhangs its wheel is the crown, and the
   * crown does not move with steer at all — at the top of the circle the
   * fore-aft radius is zero, so there is nothing for the rotation to swing.
   */
  const crownPts = wheel.filter((p) => p[1] > crown - 0.02);
  const crownOut = Math.max(...crownPts.map((p) => Math.abs(p[0])));
  const lipBands = A.filter(([y, v]) => isFinite(v) && y > 0.20 && y < crown + 0.16);
  const lipMax = Math.max(...lipBands.map(([, v]) => v));
  console.log(`  arch lip     widest body between 0.20 m and the crown: `
    + `${lipMax.toFixed(4)}`);
  console.log(`               tyre at the crown ${crownOut.toFixed(4)}, so the lip is `
    + `${((lipMax - crownOut) * 1000).toFixed(1)} mm `
    + (lipMax < crownOut ? 'INBOARD — the arch cannot overhang the tyre'
      : 'outboard of it'));
  console.log(`               widest wheel vertex anywhere ${tyreOut.toFixed(4)} `
    + `(${((tyreOut - b.hw) * 1000).toFixed(1)} mm vs the collider) — steered tread`);

  // The sill between the arches, and how much tyre is below it.
  const skin = mid.filter((p) => Math.abs(p[0]) > b.hw * 0.75);
  const sillY = Math.min(...skin.map((p) => p[1]));
  console.log(`  sill         door skin bottom ${sillY.toFixed(3)} m; `
    + `${((sillY - contact) * 1000).toFixed(0)} mm of the wheel shows below it`);

  /* The arch opening: how far along the car the skin stays clear of the sill,
   * and how high it goes. A pressed arch is close to a semicircle of about 1.2
   * tyre radii, so width over height above the sill lands near 1.4; much above
   * that and it is a scoop rather than a cut. */
  const outer = body.filter((p) => Math.abs(p[0]) > b.hw * 0.75);
  /* The arch edge over the tread. Restricted to vertices above the tyre's
   * shoulder, because the front bumper's lower wrap is also outer skin and it
   * is 200 mm lower than the arch — taking a plain minimum over the slice
   * reported the arch as 127 mm *below* the tyre crown, which is the bumper. */
  const archY = Math.min(...outer.filter((p) => Math.abs(p[2] - axleF) < 0.04
    && p[1] > crown - 0.06).map((p) => p[1]));
  let half = 0;
  for (let d = 0.02; d < 0.9; d += 0.01) {
    const sl = outer.filter((p) => Math.abs(p[2] - (axleF + d)) < 0.02);
    if (sl.length && Math.min(...sl.map((p) => p[1])) > sillY + 0.015) half = d;
  }
  console.log(`  opening      ${(half * 2000).toFixed(0)} mm along the car by `
    + `${((archY - sillY) * 1000).toFixed(0)} mm above the sill, ratio `
    + `${(half * 2 / (archY - sillY)).toFixed(2)}  (a semicircular cut ≈ 1.40)`);
  console.log(`  clearance    ${((archY - crown) * 1000).toFixed(0)} mm of air `
    + `between the tyre crown and the arch at the axle`);
}

/* ── What the road under a car should lose ───────────────────────────────────
 *
 * The contact question, answered geometrically before anything is drawn.
 *
 * The dominant source in this scene is the sky, and irradiance from it is
 * cosine-weighted, so what matters is not the fraction of the hemisphere a car
 * covers but its *form factor* — the fraction of the cosine-weighted hemisphere
 * it blocks. For a point under a rectangle at height h with half-extents a and
 * b that has a closed form, and it is worth stating rather than guessed at,
 * because it is the number the contact decal is claiming to be.
 */
const F = (a, b, h) =>
  Math.atan((a / h) * (b / h) / Math.sqrt(1 + (a / h) ** 2 + (b / h) ** 2)) / (Math.PI / 2);
console.log('\n── sky the road loses under a car, cosine-weighted ────────────');
console.log('  the hatch underbody: 0.155 m up, 0.875 m each side, 2.10 m each way');
console.log('  offset from centreline   blocked share of sky irradiance');
const h = 0.155, a = 0.875, bb = 2.10;
for (const off of [0, 0.3, 0.6, 0.875, 1.0, 1.2, 1.6, 2.2]) {
  /* Off the centreline the rectangle is no longer co-axial, so it is split at
   * the point's own foot into a near half and a far half and the two form
   * factors added. Outside the footprint the near half is subtracted instead.
   * Standard decomposition, and exact. */
  const f = off <= a
    ? (F(a - off, bb, h) + F(a + off, bb, h)) / 2
    : (F(off + a, bb, h) - F(off - a, bb, h)) / 2;
  console.log(`  ${off.toFixed(2).padStart(5)} m                  `
    + `${(Math.max(0, f) * 100).toFixed(1)}%`
    + (off === 0 ? '   under the centreline' : '')
    + (off === a ? '   directly under the sill' : ''));
}
console.log('\n  the decal in makeCarShadeMaterial states 86% at its core,');
console.log(`  and the underbody demands ${(F(a, bb, h) * 100).toFixed(1)}% there.`);
