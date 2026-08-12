/* Does the sky's sun follow the street's sun, in the running page?
 *
 *   node tools/suncouple.mjs
 *
 * tools/sunderive.mjs checks the arithmetic offline. This checks the thing the
 * arithmetic was supposed to fix: that the values the cloud shader was baked
 * with, the direction the DirectionalLight is actually pointing, and SUN_ELEV
 * all agree — in one page, at once, with no transcription between them.
 *
 * It exists because the claim it verifies was previously made in a comment.
 * clouds.ts said the clouds could not be lit by a different sun from the street
 * while holding three separate hand-copied transcriptions of that sun, and the
 * comment was true only by coincidence. A coincidence is not checkable; this is.
 */
import { run, finish } from './harness.mjs';

let bad = 0;

await run({ width: 1280, height: 720, url: (process.env.STREET_URL || 'http://127.0.0.1:3000') + '/?sky=clouds' },
  async ({ page }) => {
    await page.waitForFunction(
      () => !!window.__scene && !!window.__skyDeckSun, null, { timeout: 90_000 });

    const r = await page.evaluate(() => {
      const T = window.__THREE;
      let lit = null;
      window.__scene.scene.traverse((o) => { if (o.isDirectionalLight && !lit) lit = o; });
      const lp = new T.Vector3(), tp = new T.Vector3();
      lit.getWorldPosition(lp); lit.target.getWorldPosition(tp);
      const d = lp.sub(tp).normalize();
      return {
        sky: window.__skyDeckSun,
        lightElevDeg: (Math.asin(d.y) * 180) / Math.PI,
        lightColorLinear: [lit.color.r, lit.color.g, lit.color.b],
        lightIntensity: lit.intensity,
        isCube: !!window.__scene.scene.background?.isCubeTexture,
      };
    });

    const s = r.sky;
    console.log(`  SUN_ELEV as baked into the sky      ${s.elevDeg.toFixed(3)} deg`);
    console.log(`  DirectionalLight, measured           ${r.lightElevDeg.toFixed(3)} deg`);
    console.log(`  path amplification 1/sin(elev)       ${s.pathMul.toFixed(3)}x` +
      `   air mass ${s.airMass.toFixed(3)}`);
    console.log(`  ground beam, linear                  ` +
      s.beamGround.map((x) => x.toFixed(3)).join(', '));
    console.log(`  light colour x intensity, measured    ` +
      r.lightColorLinear.map((x) => (x * r.lightIntensity).toFixed(3)).join(', '));
    console.log('');
    console.log('  deck        alt   thick    tau    sunKm     beam (linear)          R:B');
    for (const d of s.decks) {
      console.log(`  ${d.name.padEnd(9)}${d.km.toFixed(1).padStart(5)}` +
        `${d.thickKm.toFixed(2).padStart(8)}${d.tau.toFixed(2).padStart(8)}` +
        `${d.sunKm.toFixed(2).padStart(9)}    ` +
        d.beam.map((x) => x.toFixed(1).padStart(7)).join(' ') +
        `   ${(d.beam[0] / d.beam[2]).toFixed(2)}`);
    }

    /* The beam the clouds use at the ground must be the light the street uses.
     * Not "about the same" — the same number, because one is now derived from
     * the other. A tolerance here would hide exactly the bug this checks for. */
    const want = r.lightColorLinear.map((x) => x * r.lightIntensity);
    const beamOff = Math.max(...s.beamGround.map((b, i) => Math.abs(b - want[i])));
    /* SunLight offsets the light 2 m above its target, which tilts the measured
     * direction up by about 1.9 degrees at these angles. That is a defect in
     * Street.tsx and is reported, not tolerated silently — but it means the two
     * elevations agree to within that offset rather than exactly. */
    const elevOff = Math.abs(r.lightElevDeg - s.elevDeg);

    console.log('');
    console.log(`  ground beam vs the light object:  max channel error ${beamOff.toExponential(2)}` +
      `  ${beamOff < 1e-6 ? 'OK' : 'MISMATCH'}`);
    console.log(`  sky elevation vs light elevation: ${elevOff.toFixed(3)} deg apart` +
      `  ${elevOff < 2.5 ? 'OK (Street.tsx +2 m offset, reported)' : 'MISMATCH'}`);
    console.log(`  background is a cube texture: ${r.isCube}`);

    if (beamOff >= 1e-6) bad++;
    if (elevOff >= 2.5) bad++;
  });

finish(bad);
