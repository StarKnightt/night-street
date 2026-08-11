/* What the recorded walk actually touched.
 *
 *   node tools/brushcheck.mjs shots/brush/reel.json
 *
 * The reel writes the walker's own x, z and eye height for every frame it
 * captured, so the delivered video can be measured against the collider
 * afterwards rather than trusted. Three questions, and all three are the
 * claim the shot exists to make:
 *
 *   never inside     the least clearance to any solid, over 900 frames. A
 *                    negative number is a frame of video with the camera
 *                    inside a parked car, which is the thing being fixed.
 *   actually near    how long it spent within a hand's width of something.
 *                    A route that clears everything by a metre proves the
 *                    collider is present the way an empty street proves it.
 *   on the ground    the eye against `groundHeight` under it, which is the
 *                    other half: the camera has to ride the kerb and the
 *                    camber, not float at a constant 1.65.
 */
import { register } from 'node:module';
import { readFileSync } from 'node:fs';

register('./ts-hooks.mjs', import.meta.url);
const { nearest, BODY_R, groundHeight } = await import('../src/scene/collide.ts');
const { DIMS } = await import('../src/world/dims.ts');

const file = process.argv[2] ?? 'shots/brush/reel.json';
const reel = JSON.parse(readFileSync(file, 'utf8'));

for (const shot of reel.shots) {
  const rows = shot.rows;
  const fps = rows.length / shot.seconds;
  console.log(`\n  ${shot.name} — ${rows.length} frames, ${shot.seconds}s\n`);

  let worst = { c: 1e9 };
  const near = new Map();
  let brushed = 0;
  let eyeErr = 0, eyeLow = 1e9, eyeHigh = -1e9, settling = 0;
  let prevG = groundHeight(rows[0].x, rows[0].z);
  let gMin = 1e9, gMax = -1e9;

  for (const r of rows) {
    const n = nearest(r.x, r.z);
    const c = n.d - BODY_R;
    if (c < worst.c) worst = { c, what: n.what, z: r.z, x: r.x };
    if (c < 0.10 && n.what !== 'building line') {
      brushed++;
      near.set(n.what, Math.min(near.get(n.what) ?? 1e9, c));
    }
    /* The eye above the surface under it. The bob rides on top of this, so
     * the spread is the bob plus the filter's lag, not an error. */
    const g = groundHeight(r.x, r.z);
    const h = r.ey - g;
    eyeLow = Math.min(eyeLow, h); eyeHigh = Math.max(eyeHigh, h);
    gMin = Math.min(gMin, g); gMax = Math.max(gMax, g);
    /* Away from the kerb faces, and for 450 ms after each one. Over a kerb
     * the surface under the body moves 145 mm inside a single frame, and the
     * whole point of the filter is that the head does not — so the lag there
     * is the feature, and it is the recovery afterwards rather than the jump
     * frame that carries most of it. Measuring either as an error would be
     * measuring the kerb. */
    if (Math.abs(g - prevG) > 0.020) settling = Math.round(0.45 * fps);
    if (settling > 0) settling--;
    else eyeErr = Math.max(eyeErr, Math.abs(h - DIMS.eyeHeight));
    prevG = g;
  }

  console.log(`  closest approach   ${(worst.c * 1000).toFixed(1)} mm of clearance to the ${worst.what}`);
  console.log(`                     at x ${worst.x.toFixed(2)}, z ${worst.z.toFixed(2)}`);
  console.log(`  frames inside      ${rows.filter((r) => nearest(r.x, r.z).d < BODY_R - 1e-4).length}`);
  console.log(`  within 100 mm      ${brushed} frames, ${(brushed / fps).toFixed(2)} s of the shot`);
  for (const [what, c] of [...near].sort((a, b) => a[1] - b[1])) {
    console.log(`     ${what.padEnd(16)} ${(c * 1000).toFixed(0)} mm at the closest`);
  }
  console.log(`  ground under it    ${(gMin * 1000).toFixed(0)} to ${(gMax * 1000).toFixed(0)} mm, a range of ${((gMax - gMin) * 1000).toFixed(0)} mm`);
  console.log(`  eye above it       ${(eyeLow * 1000).toFixed(1)} to ${(eyeHigh * 1000).toFixed(1)} mm about a ${(DIMS.eyeHeight * 1000).toFixed(0)} standing height`);
  console.log(`                     ${(eyeErr * 1000).toFixed(1)} mm off it at worst away from the kerb faces`);
}
