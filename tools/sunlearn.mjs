/* What did `sunFollow` actually learn, and does it still hold after the box moved?
 *
 * `sunFollow.ts` re-asserts the shadow arrangement on every render by learning
 * it off `Street.tsx` rather than transcribing it — it subtracts the snapped
 * camera position from wherever the light and its target have been put, once,
 * and re-adds the residuals thereafter. That only works if the arrangement is
 * a constant translation of the snapped camera. Change the lead, the stand-off
 * or the roll of the box and the question "does it still learn it" has to be
 * answered by measurement, not by reading the subtraction and agreeing with it.
 *
 * So this reads the residuals the hook holds, walks the camera the length of
 * the street, and after each move asks the hook how far the box is from where
 * that camera implies it should be. A learned arrangement that is still an
 * arrangement gives zero at every stop; one that has picked up a dependence on
 * where the camera was when it was learned drifts as the walk proceeds.
 *
 * It also prints the offsets themselves, because "it learned (0, 2, -8)" is
 * the sentence the previous pass could state and this one has to restate with
 * a different number.
 *
 *   node tools/sunlearn.mjs
 *   STREET_URL='http://127.0.0.1:3000/?oldbox' node tools/sunlearn.mjs
 */
import { run, finish } from './harness.mjs';

const STOPS = [0.02, 0.2, 0.4, 0.6, 0.8, 0.95];

await run({ width: 640, height: 360 }, async ({ page, errs, readShaderErrors }) => {
  const first = await page.evaluate(() => {
    const sf = window.__sunFollow;
    if (!sf) return null;
    return { offsets: sf.state.offsets, renders: sf.state.renders, on: sf.on };
  });

  if (!first || !first.offsets) {
    console.error('\n  ✗ the hook holds no arrangement — it never learned one.\n');
    errs.push('[sunlearn] sunFollow learned nothing');
  } else {
    const f = (v) => v.map((n) => n.toFixed(2).padStart(8)).join(', ');
    console.log(`\n  sunFollow, after ${first.renders} renders   enabled=${first.on}`);
    console.log(`    target offset  (${f(first.offsets.target)})`);
    console.log(`    light  offset  (${f(first.offsets.light)})`);
  }

  console.log('\n  residual after teleporting, per stop  (the box against the rendered camera)');
  let worst = 0;
  for (const t of STOPS) {
    const r = await page.evaluate((t) => {
      const s = window.__scene;
      s.goTo(t);
      s.renderOnce();
      const r = window.__sunFollow.residual(s.camera);
      return { r, cam: [s.camera.position.x, s.camera.position.y, s.camera.position.z] };
    }, t);
    if (!r.r) { console.log(`    t=${t}  no residual`); continue; }
    worst = Math.max(worst, r.r.texels);
    console.log(`    t=${String(t).padEnd(5)} camera z=${r.cam[2].toFixed(1).padStart(7)}`
      + `   target ${r.r.target.map((n) => n.toFixed(2).padStart(8)).join(',')}`
      + `   off by ${r.r.metres.toFixed(5)} m = ${r.r.texels.toFixed(3)} texels`
      + `   (texel ${(r.r.texel * 1000).toFixed(2)} mm)`);
  }
  console.log(`\n  worst residual over the walk: ${worst.toFixed(3)} texels`
    + `  ${worst <= 1 ? '— the arrangement still holds.' : '— IT DOES NOT HOLD.'}\n`);
  if (worst > 1) errs.push('[sunlearn] residual exceeds one texel');

  await readShaderErrors();
});

finish();
