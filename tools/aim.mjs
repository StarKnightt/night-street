/* Where the lights are, and what yaw and pitch look at one.
 *
 *   node --experimental-transform-types tools/aim.mjs 0.60 -57.7
 *
 * Composing an ending needs a number the route table can hold: `look` in
 * tools/shots.mjs is [second, yaw, pitch] in radians, so "hold on the bar sign"
 * has to become "yaw -0.47, pitch 0.19". Guessing that off a contact sheet
 * costs a capture slot per guess, and there are four hours left. The emitters
 * are placed on the CPU by `world/street3.ts` and `world/neon.ts` from the same
 * layout the page builds, so the angle is arithmetic and free.
 *
 * Yaw matches `Walker`: zero faces -z down the street, positive is left, and
 * pitch is positive up — the numbers go straight into a `look` keyframe.
 *
 * The transform-types flag is needed because `world/street3.ts` declares a
 * const enum and node's strip-only mode cannot erase one.
 */
import { register } from 'node:module';

register('./ts-hooks.mjs', import.meta.url);

const { litUnits } = await import('../src/world/street3.ts');
const { DIMS, LAMPS } = await import('../src/world/dims.ts');

const marks = [];

for (const u of litUnits()) {
  const bar = u.light.kind === 'bar';
  marks.push({
    x: u.light.pos[0], z: u.light.pos[2], y: u.light.pos[1],
    what: bar ? 'bar glazing, warm interior' : 'lit shopfront glazing',
  });

  /* The neon blade, which is not where the glazing is. `world/neon.ts` hangs
   * it at u0 + 0.62 along the frontage and 145 to 1050 mm proud of the facade
   * — it projects across the footway rather than lying on it, because the
   * elevation of a street the camera walks down is edge-on in every frame.
   * Aiming at the glazing centre instead would be about a metre out at both
   * ends of that, which is 5 degrees at ten metres. */
  if (bar) {
    const { ox, oz, ux, uz, nx, nz } = u.frame;
    const uc = u.u0 + 0.62;
    const d = u.d0 + (0.145 + 1.05) * 0.5;
    marks.push({
      x: ox + ux * uc + nx * d,
      z: oz + uz * uc + nz * d,
      y: (u.fasciaY0 + u.fasciaY1) * 0.5,
      what: 'BAR / COLD BEER neon blade',
    });
  }
}

/* world/neon.ts, section 4. Hard-coded there, so hard-coded here. */
marks.push({ x: 4.90, z: -61.6, y: 3.05, what: 'traffic signal head' });

/* The lamp columns, which are in this list for one reason: at the end of the
 * street the column at (4.3, -64) and the bar's blade at (5.16, -65.26) are
 * 1.53 m apart in world space and very nearly *in line* with a camera on the
 * crown of the road, so the column stands in front of the sign and cuts a
 * letter out of it. Nothing about the angles table shows that. Pixels do. */
for (const [lx, ly, lz] of LAMPS) {
  marks.push({ x: lx, z: lz, y: ly, what: 'lamp column head', post: true });
}

marks.sort((a, b) => b.z - a.z);

const [cx, cz] = [parseFloat(process.argv[2]), parseFloat(process.argv[3])];
const from = Number.isFinite(cx) && Number.isFinite(cz);
const eye = DIMS.eyeHeight;

/* --px <yaw> <pitch> [w] [h]: where each of these lands on the frame, in
 * pixels, for a camera actually pointed somewhere. Composition is a question
 * about a rectangle, and a table of bearings cannot answer "is the sign clear
 * of the pole" or "is the horizon a third of the way up". fov 45 vertical is
 * NightStreet.tsx's, and the projection below is the same one three does. */
const pxi = process.argv.indexOf('--px');
const PX = pxi > 0
  ? { yaw: +process.argv[pxi + 1], pitch: +process.argv[pxi + 2],
      w: +(process.argv[pxi + 3] || 1920), h: +(process.argv[pxi + 4] || 1080) }
  : null;

const FOV_Y = 45 * Math.PI / 180;

console.log(from ? `\n  from ${cx.toFixed(2)} / ${cz.toFixed(2)}, eye ${eye.toFixed(3)} m` : '\n');
if (PX) {
  const halfV = FOV_Y / 2;
  const halfH = Math.atan(Math.tan(halfV) * (PX.w / PX.h));
  console.log(`  camera yaw ${PX.yaw} pitch ${PX.pitch}, ${PX.w}x${PX.h}, ` +
    `half-angles ${halfH.toFixed(3)} / ${halfV.toFixed(3)} rad\n`);
}
console.log(`  ${'x'.padEnd(9)}${'z'.padEnd(10)}${'y'.padEnd(8)}` +
  (from ? `${'yaw'.padEnd(9)}${'pitch'.padEnd(9)}${'range'.padEnd(8)}` : '') +
  (PX ? `${'px'.padEnd(7)}${'py'.padEnd(7)}` : '') + 'what');

const shown = [];
for (const m of marks) {
  let ang = '', px = '';
  if (from) {
    const dx = m.x - cx, dz = m.z - cz;
    const range = Math.hypot(dx, dz);
    ang = `${Math.atan2(-dx, -dz).toFixed(3).padEnd(9)}` +
      `${Math.atan2(m.y - eye, range).toFixed(3).padEnd(9)}${range.toFixed(1).padEnd(8)}`;
    if (PX) {
      /* Into camera space: yaw about +y, then pitch about the rotated +x. */
      const c = Math.cos(-PX.yaw), s = Math.sin(-PX.yaw);
      const ex = dx * c - dz * s;
      const ez = dx * s + dz * c;
      const ey = m.y - eye;
      const cp = Math.cos(-PX.pitch), sp = Math.sin(-PX.pitch);
      const fy = ey * cp - (-ez) * sp;
      const fz = -(ey * sp + (-ez) * cp);
      if (fz > 0.05) {
        const tv = Math.tan(FOV_Y / 2);
        const X = (0.5 + 0.5 * (ex / fz) / (tv * (PX.w / PX.h))) * PX.w;
        const Y = (0.5 - 0.5 * (fy / fz) / tv) * PX.h;
        const on = X >= 0 && X <= PX.w && Y >= 0 && Y <= PX.h;
        px = `${X.toFixed(0).padEnd(7)}${Y.toFixed(0).padEnd(7)}`;
        if (on) shown.push({ ...m, X, Y });
      } else px = `${'behind'.padEnd(14)}`;
    }
  }
  console.log(`  ${m.x.toFixed(2).padEnd(9)}${m.z.toFixed(2).padEnd(10)}${m.y.toFixed(2).padEnd(8)}${ang}${px}${m.what}`);
}

/* The one number this was built to produce. */
if (PX) {
  const sign = shown.find((m) => m.what.startsWith('BAR'));
  const posts = shown.filter((m) => m.post);
  if (sign) {
    console.log(`\n  the blade lands at ${sign.X.toFixed(0)} / ${sign.Y.toFixed(0)} ` +
      `(${(100 * sign.X / PX.w).toFixed(0)}% across, ${(100 * sign.Y / PX.h).toFixed(0)}% down)`);
    for (const p of posts) {
      const gap = Math.abs(p.X - sign.X);
      console.log(`  lamp at z ${p.z} is ${gap.toFixed(0)} px ${p.X < sign.X ? 'left' : 'right'} of it` +
        `${gap < 55 ? '   ✗ that is on the sign' : ''}`);
    }
  }
}
console.log();
