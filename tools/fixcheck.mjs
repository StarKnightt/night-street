import { run, finish } from './harness.mjs';
await run({ width: 1280, height: 720 }, async ({ page }) => {
  let ok = false;
  for (let i = 0; i < 6 && !ok; i++) {
    try {
      await page.waitForFunction(() => !!window.__scene, null, { timeout: 20_000 });
      ok = true;
    } catch { console.log(`  attempt ${i + 1}: no __scene, reloading`); await page.reload({ waitUntil: 'load' }); }
  }
  if (!ok) throw new Error('scene never mounted');
  await page.waitForTimeout(2500);
  console.log(JSON.stringify(await page.evaluate(() => ({
    globals: Object.keys(window).filter((k) => k.startsWith('__')),
    lamps: window.__lampFixtures ? window.__lampFixtures.length : null,
    first: window.__lampFixtures ? window.__lampFixtures[0] : null,
  })), null, 1));
});
finish(process.exitCode || 0);
