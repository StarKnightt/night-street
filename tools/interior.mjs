/* The shop interior's own arithmetic, on the CPU.
 *
 * SHOP_BODY's lit branch is twenty lines of GLSL whose output nobody can read
 * off a frame directly, because every interior pixel in the capture has a
 * pane's Fresnel reflection composited over it. So the branch is transcribed
 * here and evaluated at named points in the room, and the answer is pushed
 * through the real display transform. That gives a prediction to check the
 * capture against rather than a number to tune towards, which is the whole
 * discipline in NOTES.md §"The display response".
 *
 * If this file and streetMaterials.ts ever disagree, streetMaterials.ts is the
 * one that ships. Keep them in step by hand; it is thirty lines.
 *
 *   node tools/interior.mjs
 */
import { display } from './agx.mjs';

const LIT_STORE = [0.80, 0.53, 0.25];
const LIT_GAIN = 1.35;
const CEIL = 1.55;

const sstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/* Points in a 2.4 m deep, 2.85 m tall room, as (name, up, hh, depth). `up` is
 * clamp(vWN.y): 1 on the floor, 0 on a wall, and the ceiling is handled by its
 * own term. `hh` is height above the unit's base, `depth` is metres behind the
 * aperture plane. */
const PTS = [
  ['ceiling                ', -1, 2.79, 1.20],
  ['back wall, eye height  ', 0, 1.55, 2.40],
  ['back wall, low         ', 0, 0.60, 2.40],
  ['side wall, 1 m in      ', 0, 1.55, 1.00],
  ['side wall, at aperture ', 0, 1.55, 0.20],
  ['floor, mid room        ', 1, 0.05, 1.30],
  ['floor, at the glass    ', 1, 0.05, 0.25],
  ['fitting, mid room      ', 0, 1.20, 1.60],
];

/** The shipped branch, as of the System 3 interior fix. */
function after(up, hh, depth, fitting) {
  // Albedo. A trading unit is decorated; the base tone is the unlit room's.
  const base = 0.0675, tint = up > 0 ? [0.762, 0.643, 0.524] : [1, 1, 1];
  const lift = fitting ? 4.6 : (6.6 - 3.6 * Math.max(up, 0));
  const col = tint.map((t) => base * t * lift);
  const ff = (0.50 + 0.34 * Math.max(up, 0))
    * (0.55 + 0.45 * sstep(0.0, 2.35, hh))
    * (1.0 - 0.22 * sstep(0.15, 2.40, depth));
  const shell = fitting ? 0.55 : 1.0;
  return LIT_STORE.map((c, i) => c * CEIL * ff * col[i] * shell * LIT_GAIN);
}

/** The branch as it stood before, for the before/after column. */
function before(up, hh, depth, fitting) {
  const base = 0.0675, tint = up > 0 ? [0.762, 0.643, 0.524] : [1, 1, 1];
  const col = tint.map((t) => base * t * (fitting ? 1.23 : 1));
  const recv = (0.32 + 0.68 * Math.max(up, 0))
    * (0.20 + 0.80 * sstep(0.0, 2.35, hh))
    * (1.0 - 0.70 * sstep(0.15, 2.40, depth));
  const shell = fitting ? 0.34 : 1.0;
  return LIT_STORE.map((c, i) => c * 11.0 * recv * col[i] * shell * LIT_GAIN);
}

const f3 = (v) => v.map((x) => x.toFixed(4).padStart(7)).join(' ');
const d3 = (v) => display(v, { sensor: true }).map((x) => String(x).padStart(4)).join(' ');

console.log('\n  Shop interior, linear radiance and the code value it arrives at.');
console.log('  Ceiling is unchanged by design: System 5 authored its aperture against it.\n');
console.log('  point                    before  L                 code        after   L                code');
for (const [name, up, hh, depth] of PTS) {
  const fitting = name.startsWith('fitting');
  const b = up < 0
    ? LIT_STORE.map((c) => c * CEIL * LIT_GAIN)
    : before(up, hh, depth, fitting);
  const a = up < 0
    ? LIT_STORE.map((c) => c * CEIL * LIT_GAIN)
    : after(up, hh, depth, fitting);
  console.log(`  ${name}  ${f3(b)}  ${d3(b)}   ${f3(a)}  ${d3(a)}`);
}

/* What the aperture as a whole radiates, which is the number System 5's spill
 * was calibrated against and the one thing here that must not move far. A
 * crude area weighting of the room's visible interior surfaces as seen from
 * outside: the ceiling is a fifth of it, the back wall and floor most of the
 * rest. */
const W = [
  [0.20, [-1, 2.79, 1.20]], [0.26, [0, 1.55, 2.40]], [0.14, [0, 0.60, 2.40]],
  [0.16, [0, 1.55, 1.00]], [0.24, [1, 0.05, 1.30]],
];
for (const [label, fn] of [['before', before], ['after', after]]) {
  const m = [0, 0, 0];
  for (const [w, [up, hh, depth]] of W) {
    const v = up < 0 ? LIT_STORE.map((c) => c * CEIL * LIT_GAIN) : fn(up, hh, depth, false);
    for (let i = 0; i < 3; i++) m[i] += w * v[i];
  }
  console.log(`\n  area-weighted aperture radiance, ${label}: ${f3(m)}   (System 5 authored 0.90)`);
}
console.log('');
