/* Which triangles face the wrong way.
 *
 *   node tools/winding.mjs [--worst 12]
 *
 * This project's signature failure is geometry that is present, correct in
 * code and invisible, and inverted winding is how it usually happens: car
 * tyres missing for days, a satellite dish that rendered as an open hoop
 * because its dished face was a back face and only the rim was emitted in
 * both directions. None of those are visible in a diff and all of them are
 * trivial in a dot product.
 *
 * The test is the one thing a closed solid guarantees: a front-facing triangle
 * has its geometric normal — the cross product of its own two edges, in world
 * space, taken from the index order the GPU will use — pointing away from the
 * body it encloses. There is no body here to point away from, so the reference
 * is the vertex normal `emit.ts` wrote, which is computed per quad at emission
 * from the corner order the caller gave. Those two agree on every triangle
 * that is wound the way its author thought it was, and disagree on every one
 * that is not, which makes the check a comparison rather than a guess.
 *
 * That check passes trivially and is still worth keeping as a tripwire, but on
 * its own it is nearly useless and it is important to say why: `emit.ts`
 * derives the normal from the same corner order the caller gave, so the two
 * agree by construction. It catches an index buffer that has been reordered
 * after emission and nothing else. It cannot see a whole surface built inside
 * out, because a `quadFree` fan listed the wrong way round has perfectly
 * consistent normals — they just point into the building.
 *
 * So the second pass is the one that found the dish. Every triangle standing
 * in front of one of the two walked frontages is binned by whether its normal
 * points toward the street centreline or away from it, weighted by area. A
 * frontage is a wall with things bolted to it: nearly all of the area that is
 * not the wall itself should face the street, and a surface that has been
 * built inside out shows up as area facing into the masonry, which is area
 * that renders as nothing.
 *
 * Be honest about its sensitivity. The absolute figures mean little on their
 * own — a box has a back, a jamb has two returns, and the metal group sits
 * near half inward at rest for entirely correct reasons — so this is a
 * *differential* instrument: run it either side of a change and look at the
 * movement. It also has a floor. The satellite dish that prompted it is about
 * 0.19 m2 of face on the handful of buildings that draw one, against 235 m2
 * of outward metal, so it does not move this number and was not found by it;
 * it was found by working the handedness out on paper. What this catches is
 * the class one size up: a wall, a run of shutters, a whole prop kit.
 */
import { register } from 'node:module';
register('./ts-hooks.mjs', import.meta.url);

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const WORST = +flag('worst', 12);

const { buildCity } = await import('../src/world/facade.ts');

const city = buildCity();
let bad = 0, total = 0;
const worst = [];

for (const [name, geo] of Object.entries(city)) {
  if (!geo || typeof geo.getAttribute !== 'function') continue;
  const pos = geo.getAttribute('position');
  const nor = geo.getAttribute('normal');
  const idx = geo.getIndex();
  if (!pos || !nor || !idx) continue;

  let groupBad = 0, groupN = 0, degenerate = 0;
  for (let t = 0; t < idx.count; t += 3) {
    const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
    const ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a);
    const ex = pos.getX(b) - ax, ey = pos.getY(b) - ay, ez = pos.getZ(b) - az;
    const fx = pos.getX(c) - ax, fy = pos.getY(c) - ay, fz = pos.getZ(c) - az;
    const gx = ey * fz - ez * fy, gy = ez * fx - ex * fz, gz = ex * fy - ey * fx;
    const gl = Math.hypot(gx, gy, gz);
    /* A zero-area triangle has no normal and no opinion. Fans built as quads
     * with a repeated last corner produce one per wedge by construction, so
     * this is the common case rather than an error. */
    if (gl < 1e-9) { degenerate++; continue; }
    const dot = (gx * nor.getX(a) + gy * nor.getY(a) + gz * nor.getZ(a)) / gl;
    groupN++;
    if (dot < 0) {
      groupBad++;
      worst.push({ name, t: t / 3, dot, at: [ax.toFixed(2), ay.toFixed(2), az.toFixed(2)] });
    }
  }
  total += groupN;
  bad += groupBad;
  const pct = groupN ? (100 * groupBad / groupN).toFixed(2) : '0.00';
  console.log(`  ${name.padEnd(10)} ${String(groupN).padStart(7)} tris`
    + `  ${String(groupBad).padStart(6)} inverted (${pct}%)`
    + `  ${String(degenerate).padStart(6)} degenerate`);
}

if (worst.length) {
  console.log(`\n  worst ${Math.min(WORST, worst.length)}:`);
  worst.sort((p, q) => p.dot - q.dot).slice(0, WORST).forEach((w) => {
    console.log(`    ${w.name} tri ${w.t} at (${w.at.join(', ')}) dot ${w.dot.toFixed(3)}`);
  });
}
console.log(`\n  ${bad} of ${total} triangles disagree with their own emitted normal`);

/* ── Facing the street ───────────────────────────────────────────────────── */

/* The band in front of each walked frontage. The building lines are at
 * x = -5.70 and +5.70; anything between the footway and a metre into the
 * masonry is frontage, and anything beyond that is the depth of the block,
 * which is full of internal faces this test has no opinion about. */
const WALL = 5.70;
const inBand = (x) => (x > WALL - 1.0 && x < WALL + 2.2) || (x < -WALL + 1.0 && x > -WALL - 2.2);

console.log('\n  area on the two walked frontages, by which way it faces\n');
console.log('  group        toward street        into masonry     inward share');
let inward = 0, outward = 0;
for (const [name, geo] of Object.entries(city)) {
  if (!geo || typeof geo.getAttribute !== 'function') continue;
  const pos = geo.getAttribute('position');
  const idx = geo.getIndex();
  if (!pos || !idx) continue;

  let out = 0, into = 0;
  for (let t = 0; t < idx.count; t += 3) {
    const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
    const ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a);
    const cx = (ax + pos.getX(b) + pos.getX(c)) / 3;
    const cz = (az + pos.getZ(b) + pos.getZ(c)) / 3;
    if (!inBand(cx) || cz > 4 || cz < -101) continue;
    const ex = pos.getX(b) - ax, ey = pos.getY(b) - ay, ez = pos.getZ(b) - az;
    const fx = pos.getX(c) - ax, fy = pos.getY(c) - ay, fz = pos.getZ(c) - az;
    const gx = ey * fz - ez * fy, gy = ez * fx - ex * fz, gz = ex * fy - ey * fx;
    const area = Math.hypot(gx, gy, gz) * 0.5;
    if (area < 1e-9) continue;
    /* Toward the street is -x on the east row and +x on the west, so the test
     * is the sign of the normal's x against the sign of where it is standing.
     * Faces turned along the street contribute to neither and are dropped by
     * the deadband, which is most of a reveal and all of a pier return. */
    const facing = -Math.sign(cx) * gx / (2 * area);
    if (facing > 0.25) out += area;
    else if (facing < -0.25) into += area;
  }
  outward += out; inward += into;
  const share = out + into > 0 ? (100 * into / (out + into)).toFixed(1) : '0.0';
  console.log(`  ${name.padEnd(10)} ${out.toFixed(1).padStart(14)} m2`
    + `  ${into.toFixed(1).padStart(14)} m2  ${share.padStart(9)}%`);
}
console.log(`\n  ${(100 * inward / (inward + outward)).toFixed(1)}% of frontage area faces into the masonry`);
console.log(bad ? '  FAILED\n' : '  OK\n');
process.exit(bad ? 1 : 0);
