/* What the car pass costs, without a browser.
 *
 *   node tools/carcount.mjs
 *
 * Loads `world/cars.ts` and `scene/collide.ts` for real rather than a copy of
 * either, on the same argument tools/propcount.mjs makes: the numbers below are
 * only worth having if they came out of the module the renderer builds from.
 *
 * The budget this pass set itself, up front, before any of it was written:
 *
 *   bodies + glass + wheels + shade   under 320k triangles over the nine cars
 *   draw calls                        4, unchanged (one merged buffer each)
 *   frame                             under 8.0 ms, from 7.1 with headroom
 *
 * 320k is about four times what the cars cost before. That sounds a lot for a
 * detail pass and it is the correct order for this one: shut lines, arch lips,
 * lamp housings, handles and spoked rims are all *silhouette* features, and a
 * silhouette feature cannot be bought with a texture. The reason it is
 * affordable is that the cars are four draw calls whatever is in them, they
 * occupy a small part of the frame, and this renderer's cost is overwhelmingly
 * in the post chain and the shadow filter rather than in vertex work.
 */
import { register } from 'node:module';

register('./ts-hooks.mjs', import.meta.url);

const { buildCars, PARKED, carSolids } = await import('../src/world/cars.ts');

const t0 = Date.now();
const cars = buildCars();
const ms = Date.now() - t0;

const tri = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;
const vtx = (g) => g.attributes.position.count;

const parts = [
  ['body', cars.body], ['glass', cars.glass],
  ['wheel', cars.wheel], ['shade', cars.shade],
];

console.log(`cars            ${PARKED.length}`);
for (const [name, g] of parts) {
  console.log(`  ${name.padEnd(12)} ${String(tri(g)).padStart(8)} tri  `
    + `${String(vtx(g)).padStart(8)} vtx`);
}
console.log(`  ${'total'.padEnd(12)} ${String(cars.triangles).padStart(8)} tri`);
console.log(`  per car      ${Math.round(cars.triangles / PARKED.length)} tri`);
console.log(`draw calls      ${parts.length}  (one merged buffer per material)`);
console.log(`build ms        ${ms}`);
console.log(`car lights      ${cars.lights.length}`);

/* The colliders, and specifically whether they still bound the geometry.
 *
 * This pass added an arch lip, four lamp housings, four door handles and a
 * dished end panel to every body, and every one of those is a lump added to
 * the outside of a surface whose plan extents `carSolids()` reports as
 * `wide/2` by `len/2`. If any of them reaches past that, the walker's
 * depenetration lets a shoulder into it and nothing fails — so the extents are
 * measured off the built vertex buffer rather than trusted.
 */
const solids = carSolids();
const bodies = solids.filter((s) => s.kind === 'body');
const pos = cars.body.attributes.position;
const glassPos = cars.glass.attributes.position;

/* Broken down by part code, because two of them are *meant* to stand outside
 * the body box: the door mirror has a collider of its own — a disc, because a
 * mirror is what a shoulder meets first — and the shade decal is a flat quad on
 * the road that nothing can walk into. Everything else has to be inside. */
const NAME = ['paint', 'trim', 'arch', 'under', 'lampR', 'lampF', 'cabin',
  'plate', 'grille', 'capR', 'capF', 'scuttle', 'mirror'];
const part = cars.body.attributes.aCar;
/* The mirror's envelope, taken from the collider itself rather than
 * reconstructed: `carSolids()` publishes a disc per mirror, and a vertex inside
 * one is a vertex the walker is already kept out of. Note that most of a mirror
 * is CAR.TRIM — only its glass is CAR.MIRROR — so exempting by part code
 * exempts the bumpers and the door handles with it, which are exactly the two
 * things this check exists to catch. */
const discs = solids.filter((s) => s.kind === 'mirror');
const inMirror = (x, z) =>
  discs.some((d) => Math.hypot(x - d.x, z - d.z) < d.r + 0.075);

for (const b of bodies) {
  const cs = Math.cos(b.yaw), sn = Math.sin(b.yaw);
  const seen = new Map();
  const take = (lx, lz, code) => {
    const k = NAME[code] ?? `part${code}`;
    const r = seen.get(k) ?? { mx: 0, mz: 0 };
    r.mx = Math.max(r.mx, Math.abs(lx));
    r.mz = Math.max(r.mz, Math.abs(lz));
    seen.set(k, r);
  };
  for (const [p, codeOf] of [[pos, (i) => part.getY(i)], [glassPos, () => 13]]) {
    for (let i = 0; i < p.count; i++) {
      const dx = p.getX(i) - b.x, dz = p.getZ(i) - b.z;
      /* Into the car's own frame. `place()` maps local x to (cos, -sin) and
       * local z to (sin, cos), so the inverse is the transpose. */
      const lx = cs * dx - sn * dz;
      const lz = sn * dx + cs * dz;
      if (inMirror(p.getX(i), p.getZ(i))) continue;
      /* Which car a vertex belongs to. The nine bodies are in one buffer and
       * the closest pair is 665 mm apart at the bumpers, so a vertex is this
       * car's if it is inside its box grown by 250 mm in *both* axes at once.
       * Testing the two independently — which the first version of this did —
       * lets the car in front through on x and reports its nose as this car's
       * flank, and the answer it gave was a confident 500 mm overhang that does
       * not exist. */
      if (Math.abs(lx) > b.hw + 0.25 || Math.abs(lz) > b.hl + 0.25) continue;
      take(lx, lz, codeOf(i));
    }
  }
  const rows = [...seen.entries()]
    .map(([k, r]) => ({ k, ...r, ow: r.mx - b.hw, ol: r.mz - b.hl }))
    .sort((a, b2) => Math.max(b2.ow, b2.ol) - Math.max(a.ow, a.ol));
  /* 0.05 mm, because the body is *designed* to touch the box: `hw` is the
   * widest section point and `hl` is the end cap, so the paint and the caps
   * come out exactly on the plane and land a few parts in 10^10 either side of
   * it. The tolerance is half the 0.09 mm penetration the walker is held to,
   * so anything this passes cannot move that gate. */
  const TOL = 5e-5;
  const bad = rows.filter((r) => r.ow > TOL || r.ol > TOL);
  const w = rows[0];
  console.log(`\n  ${b.what.padEnd(14)} hw ${b.hw.toFixed(3)}  hl ${b.hl.toFixed(3)}`);
  console.log(`    widest part  ${w.k} at ${w.mx.toFixed(4)} `
    + `(${(w.ow * 1000).toFixed(2)} mm over), longest ${w.mz.toFixed(4)} `
    + `(${(w.ol * 1000).toFixed(2)} mm over)`);
  console.log(`    verdict      ${bad.length === 0 ? 'inside the collider'
    : `OUTSIDE: ${bad.map((r) => r.k).join(' ')}`}`);
}
console.log('\n  mirror is exempt: carSolids() gives it a disc of its own.');
