/* Ask the running scene a question and get a number back.
 *
 * The capture harness answers "what does it look like", which is the wrong
 * question when a surface is five times too bright and the candidates are
 * albedo, irradiance gain, a resolved reflection and a missing shadow. Each
 * round of shoot.mjs costs a minute and returns a picture to argue with; this
 * costs fifteen seconds and returns the constants themselves.
 *
 *   node tools/carprobe.mjs "return {x: s.camera.position.x}"
 */
import { run } from './harness.mjs';

const js = process.argv.slice(2).join(' ');

await run({ width: 640, height: 360 }, async ({ page }) => {
  const out = await page.evaluate((src) => {
    const s = window.__scene;
    try { return { ok: new Function('s', src)(s) }; }
    catch (e) { return { err: String(e && e.stack || e) }; }
  }, js);
  console.log(JSON.stringify(out, null, 2));
});
