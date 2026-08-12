/* Where does a walker leaning on the west building line actually come to rest,
 * and is it stopped or is it trapped?
 *
 * `tools/collide.mjs corner` asserts that a body held against the wall at a
 * shallow yaw keeps its tangential speed for ten seconds. That was true when
 * the wall lane was thirteen clear metres of nothing and it is not true now
 * that there are bins on it — but the assertion cannot tell "walked into a
 * bin", which is what a footway is for, from "wedged and cannot recover",
 * which is a defect. This prints the rest point, what it is resting on, and
 * whether steering away frees it.
 */
import { register } from 'node:module';
register('./ts-hooks.mjs', import.meta.url);

const { Walker } = await import('../src/scene/walker.ts');
const { nearest, BODY_R } = await import('../src/scene/collide.ts');

function run(x, z, yaw, seconds, dt = 1 / 120) {
  const w = new Walker();
  w.x = x; w.z = z; w.yaw = yaw;
  w.snapGround();
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) w.update(dt, { forward: 1, strafe: 0, sprint: false });
  return w;
}

for (const yaw of [0.30, 0.60]) {
  const w = run(-5.0, -20, yaw, 10);
  const c = nearest(w.x, w.z);
  console.log(
    `yaw ${yaw.toFixed(2)}  rests ${w.x.toFixed(3)}, ${w.z.toFixed(3)}` +
    `  on "${w.contact}"  clearance ${(c.d - BODY_R).toFixed(4)} m`,
  );
  for (const turn of [-0.5, -0.9, +0.5]) {
    const w2 = new Walker();
    w2.x = w.x; w2.z = w.z; w2.yaw = yaw + turn;
    w2.snapGround();
    const z0 = w2.z, x0 = w2.x;
    for (let i = 0; i < 240; i++) w2.update(1 / 120, { forward: 1, strafe: 0, sprint: false });
    console.log(`         steer ${turn >= 0 ? '+' : ''}${turn}: moved ${Math.hypot(w2.x - x0, w2.z - z0).toFixed(3)} m in 2 s`);
  }
}
