/* CPU-only census and siting report for System 6. Not part of the build.
 *
 * Transpile first, exactly as tools/sys5.ts does:
 *
 *   npx tsc -p tsconfig.sys5.json
 *   node -e "const M=require('module'),p=M._resolveFilename;\
 *     M._resolveFilename=function(r,...a){if(r.startsWith('@/'))\
 *     r=require('path').resolve('.sys5/src',r.slice(2));return p.call(this,r,...a)};\
 *     require('./.sys5/tools/sys6.js')"
 *
 * Two jobs. It checks that the lit-air wedge installed by scene/haze.ts lands
 * where block.ts says the sun lands — the wedge is derived from the gap list and
 * block.ts states the answer in prose, so the two can be reconciled without
 * rendering anything — and it derives the camera positions for the new capture
 * stops from the same layout, so that framing a shaft does not cost a discovery
 * batch on a GPU three systems are queuing for.
 */
import { layoutBlock, BUILD_LINE, BLOCK_DEPTH, SUN_RUN } from '../src/world/block';
import { walkHeight } from '../src/world/geometry';
import { SUN_DIR, SUN_ELEV } from '../src/scene/env';
import { DIMS } from '../src/world/dims';

const f = (n: number, p = 2) => n.toFixed(p).padStart(8);

/* The shared horizontal normal of every shadow-boundary plane in this scene.
 * Both planes of a wedge contain SUN_DIR and the world vertical, so they are
 * vertical and the whole test collapses to two dimensions. */
const nl = Math.hypot(SUN_DIR[2], SUN_DIR[0]);
const nx = SUN_DIR[2] / nl, nz = -SUN_DIR[0] / nl;
const dAt = (x: number, z: number) => nx * x + nz * z;
/** The z at which a slab boundary of offset d crosses a given x. */
const zAt = (d: number, x: number) => (d - nx * x) / nz;

console.log('sun', SUN_DIR.map((v) => f(v, 4)).join(''),
  ' elev', (SUN_ELEV * 180 / Math.PI).toFixed(2), 'deg  run', SUN_RUN.toFixed(3));
console.log('wedge normal', f(nx, 6), f(nz, 6),
  '  build line', BUILD_LINE.toFixed(2), ' block depth', BLOCK_DEPTH.toFixed(2));

const { gaps } = layoutBlock((x, z) => walkHeight(x, z));
console.log('\ngaps, and the wedge each sunward one casts');
const wedges: { z0: number; z1: number; d0: number; d1: number }[] = [];
for (const g of gaps) {
  if (g.side <= 0) { console.log(`  shaded side  z ${f(g.z0)} .. ${f(g.z1)}   no sun`); continue; }
  /* Near corner at the frontage plane, far corner at the back of the block.
   * block.ts:249-257 states this asymmetry in prose — "gapMin + 15.3 and
   * gapMax + 8.15" — and this is the same statement as two planes. */
  const a = dAt(BUILD_LINE, g.z1);
  const b = dAt(BUILD_LINE + BLOCK_DEPTH, g.z0);
  const d0 = Math.min(a, b), d1 = Math.max(a, b);
  wedges.push({ z0: g.z0, z1: g.z1, d0, d1 });
  console.log(
    `  gap z ${f(g.z0)} ..${f(g.z1)}   slab d ${f(d0)} ..${f(d1)}` +
    `   width ${f(d1 - d0)} m   road band z ${f(zAt(d1, 0))} ..${f(zAt(d0, 0))}` +
    `   west kerb ${f(zAt(d1, -DIMS.roadHalf))} ..${f(zAt(d0, -DIMS.roadHalf))}`,
  );
}
console.log('  block.ts states -49..-32 and -84..-73 for the first two. They should match.');

/* ── capture stops ────────────────────────────────────────────────────────
 *
 * Every position below is a consequence of the wedge above rather than a place
 * that looked right. yaw is measured the way walker.ts uses it: the view
 * direction is ( -sin yaw, 0, -cos yaw ), so straight down the street is 0 and
 * the sun, which bears +X and -Z, is at a negative yaw.
 */
const yawTo = (dx: number, dz: number) => Math.atan2(-dx, -dz);
const stop = (name: string, cx: number, cz: number, tx: number, tz: number,
              pitch: number, fov: number, why: string) => {
  const y = yawTo(tx - cx, tz - cz);
  const dist = Math.hypot(tx - cx, tz - cz);
  /* How much lit air the centre ray crosses, which is the quantity the frame is
   * being set up to show. Same arithmetic as wedgeOne in haze.ts. */
  const vx = (tx - cx) / dist, vz = (tz - cz) / dist;
  let lit = 0;
  for (const w of wedges) {
    const pn = nx * vx + nz * vz, on = dAt(cx, cz);
    if (Math.abs(pn) < 1e-4) continue;
    const ta = (w.d0 - on) / pn, tb = (w.d1 - on) / pn;
    lit += Math.max(0, Math.min(Math.max(ta, tb), dist) - Math.max(Math.min(ta, tb), 0));
  }
  console.log(
    `  ${name.padEnd(11)} at ${f(cx)} ${f(cz)}  yaw ${f(y, 4)}  pitch ${f(pitch, 3)}` +
    `  fov ${String(fov).padStart(3)}  target ${f(tx)} ${f(tz)}  range ${f(dist)}` +
    `  lit air ${f(lit)} m`);
  console.log(`               ${why}`);
};

console.log('\nnew stops');
const W = wedges[0];
// The near boundary of the main wedge where it crosses the two kerbs. This is
// the only edge in the scene that a shaft can be said to have.
const kW = zAt(W.d0, -DIMS.roadHalf), kE = zAt(W.d0, DIMS.roadHalf);
console.log(`  main wedge near edge runs (${(-DIMS.roadHalf).toFixed(2)}, ${kW.toFixed(2)})` +
  ` to (${DIMS.roadHalf.toFixed(2)}, ${kE.toFixed(2)}) across the carriageway`);

stop('shaft/road', -0.85, -20, 0, (kW + kE) / 2, -0.10, 55,
  'the boundary crossing the carriageway diagonally, from the walk line eight to seventeen metres short of it');
stop('shaft/edge', 2.60, -26, -BUILD_LINE, -38, 0.10, 50,
  'across the wedge at a shaded west frontage, so the lit air stands against a dark wall rather than against the sky');
stop('mote/sun', -1.00, -28,
  -1.00 + SUN_DIR[0] * 40, -28 + SUN_DIR[2] * 40, SUN_ELEV, 40,
  'straight into the sun, which from here leaves the canyon through the cross-street gap; the mote field is between');
stop('air/ladder', -0.85, DIMS.walkStartZ - 0.02 * 98, 0, -160, 0.0, 30,
  'a long lens down the street: kerb, mid block, backdrop and closeout in one frame, to read aerial perspective as a ladder');
stop('air/away', -0.85, -54.8, -0.85 - SUN_DIR[0] * 40, -54.8 - SUN_DIR[2] * 40, 0.05, 45,
  'the anti-sun veil, which the old one-sided lobe left at exactly the base density');
