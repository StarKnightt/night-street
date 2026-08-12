/* What the prop pass costs, without a browser.
 *
 *   node tools/propcount.mjs
 *
 * Loads the real modules — `world/props.ts`, `world/placement.ts` and
 * `scene/collide.ts` — rather than a copy of any of them, which is the same
 * defence `tools/route.mjs` uses and the one NOTES.md keeps asking for. It
 * reports the triangle cost of the kit, the number of props placed, how many
 * of them present a collider, and the total solid count the walker's
 * depenetration loop now has to iterate.
 */
import { register } from 'node:module';

register('./ts-hooks.mjs', import.meta.url);

const { buildProps } = await import('../src/world/props.ts');
const { props, propSolids } = await import('../src/world/placement.ts');
const { solids } = await import('../src/scene/collide.ts');
/* `world/street3.ts` is deliberately not loaded here. It declares a
 * `const enum`, which Node's strip-only TypeScript cannot execute, so it is
 * not reachable from any tool — and the collider must therefore never import
 * it, which is one more reason the shared placement table lives in a module of
 * its own rather than in System 3. */
const { buildCity } = await import('../src/world/facade.ts');

const t0 = Date.now();
const kit = buildProps();
const tKit = Date.now() - t0;

const t1 = Date.now();
const city = buildCity();
const tCity = Date.now() - t1;


const list = props();
const byKind = {};
for (const p of list) byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;

const tri = (g) => (g.index ? g.index.count : g.attributes.position.count) / 3;

console.log('props placed        ', list.length);
console.log('  with a collider   ', propSolids().length);
console.log('  by kind           ', Object.entries(byKind)
  .sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}:${n}`).join(' '));
console.log('kit triangles       ', tri(kit.geometry).toLocaleString());
console.log('sign triangles      ', tri(kit.signs).toLocaleString());
console.log('kit total           ', kit.triangles.toLocaleString());
console.log('city triangles      ', city.triangles.toLocaleString());
console.log('solids in collider  ', solids().length);
console.log(`build ms  kit ${tKit}  city ${tCity}`);
