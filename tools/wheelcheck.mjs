/* Does the wheel geometry face outward?
 *
 * A closed shell whose triangles are wound the wrong way renders as nothing at
 * all under FrontSide culling, and the symptom is not "a dark wheel" — it is
 * the road behind the car showing through the arch, with the two rim fans
 * (which are wound separately, by hand) left floating in it. That is exactly
 * what the near car shows, so the winding is worth settling by arithmetic
 * rather than by looking at another frame.
 *
 * The test needs no renderer: every vertex already carries the outward normal
 * the loft computed for it, so for each triangle the geometric normal
 * (b-a)x(c-a) either agrees with the mean of its three vertex normals or it
 * does not, and disagreement is a back-facing triangle.
 *
 *   node tools/wheelcheck.mjs
 */
import { register } from 'node:module';
register('./ts-hooks.mjs', import.meta.url);

const { buildCars, PARKED } = await import('../src/world/cars.ts');

const built = buildCars([PARKED[7]]);   // the sunlit hatch on the far kerb

for (const [name, g] of Object.entries({
  body: built.body, glass: built.glass, wheel: built.wheel,
})) {
  const pos = g.getAttribute('position').array;
  const nor = g.getAttribute('normal').array;
  const idx = g.getIndex().array;
  let agree = 0, against = 0, degenerate = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const [ia, ib, ic] = [idx[t], idx[t + 1], idx[t + 2]];
    const A = pos.subarray(ia * 3, ia * 3 + 3);
    const B = pos.subarray(ib * 3, ib * 3 + 3);
    const C = pos.subarray(ic * 3, ic * 3 + 3);
    const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const gn = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    const l = Math.hypot(...gn);
    if (l < 1e-12) { degenerate++; continue; }
    let d = 0;
    for (const i of [ia, ib, ic]) {
      d += (gn[0] * nor[i * 3] + gn[1] * nor[i * 3 + 1] + gn[2] * nor[i * 3 + 2]) / l;
    }
    if (d / 3 > 0.05) agree++;
    else if (d / 3 < -0.05) against++;
  }
  const n = idx.length / 3;
  console.log(`  ${name.padEnd(6)} ${String(n).padStart(6)} tris   `
    + `outward ${((agree / n) * 100).toFixed(1)}%   `
    + `inward ${((against / n) * 100).toFixed(1)}%   `
    + `edge-on/degenerate ${(((n - agree - against) / n) * 100).toFixed(1)}%`);
}
built.dispose();
