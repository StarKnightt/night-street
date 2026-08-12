/* Does the key light point where the sky says the sun is?
 *
 * The two are separate assertions in this codebase: env.ts derives SUN_DIR from
 * SUN_ELEV and the sky, IBL and every material's uSun follow it, while
 * Street.tsx positions a DirectionalLight and its target by hand. Nothing made
 * them agree. For the whole life of the project the light's Y was lifted 2 m
 * without lifting the target, which tilted it 1.9 degrees above the sky's sun —
 * a discrepancy no typecheck, grep or screenshot would show, because both
 * numbers were individually plausible and the error was in their relationship.
 *
 * This asserts the relationship instead of trusting it.
 *
 *   node tools/sunalign.mjs
 */
import { run, finish } from './harness.mjs';

const TOL_DEG = 0.01;

/* `run()` returns its own ledger — errors, adapter, shader links — and not
 * whatever the body returned, so reading the measurement off it gave
 * `undefined.toFixed` and this check has never once reached its assertion.
 * The body writes into a binding instead. */
let out = null;

await run({ width: 640, height: 360 }, async ({ page }) => {
  out = await page.evaluate(() => {
    const s = window.__scene;
    s.goTo(0.2);
    s.renderOnce();

    let light = null;
    s.scene.traverse((o) => { if (o.isDirectionalLight) light = o; });
    if (!light) return { error: 'no DirectionalLight in the scene' };

    const p = light.position, t = light.target.position;
    const vx = p.x - t.x, vy = p.y - t.y, vz = p.z - t.z;
    const m = Math.hypot(vx, vy, vz);

    return {
      lightElevDeg: (Math.asin(vy / m) * 180) / Math.PI,
      lightDir: [vx / m, vy / m, vz / m],
      skyElevDeg: (window.__skyDeckSun && window.__skyDeckSun.elevDeg) ?? null,
      colorHex: light.color.getHexString(),
      intensity: light.intensity,
      lightPos: [p.x, p.y, p.z],
      targetPos: [t.x, t.y, t.z],
    };
  });
});

if (!out) { console.error('sunalign: the page never reported (see the errors above)'); process.exit(1); }
if (out.error) { console.error(out.error); process.exit(1); }

const expected = 12.0;
const delta = Math.abs(out.lightElevDeg - expected);

console.log(`light elevation   ${out.lightElevDeg.toFixed(4)} deg`);
console.log(`expected          ${expected.toFixed(4)} deg`);
console.log(`delta             ${delta.toFixed(4)} deg`);
console.log(`light dir         ${out.lightDir.map((v) => v.toFixed(6)).join(', ')}`);
console.log(`colour            #${out.colorHex}   intensity ${out.intensity}`);
console.log(`light / target y  ${out.lightPos[1].toFixed(3)} / ${out.targetPos[1].toFixed(3)}`);

/* The verdict before the teardown, not after it. `finish()` is
 * `process.exit`, so neither branch below had ever executed: this tool
 * printed a table and exited zero whatever the delta was. */
if (delta > TOL_DEG) {
  console.error(`\nFAIL: key light is ${delta.toFixed(3)} deg off the sky's sun.`);
  await finish(1);
} else {
  console.log('\nOK: key light and sky agree.');
  await finish(0);
}
