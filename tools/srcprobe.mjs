/* Is the shader in the browser the shader in the file?
 *
 * Three of this project's most expensive bugs were a change that was correct
 * and never reached a pixel. A URL switch that silently does nothing looks
 * exactly like a hypothesis that was wrong, and the two have to be told apart
 * before anything is concluded from a measurement. This loads the page and
 * greps the *compiled* program sources for a string, which is the only place
 * the question can be answered.
 *
 *   node tools/srcprobe.mjs --q onetap --find "for ( int i = 0; i < 1;"
 */
import { run, finish, DEV_URL } from './harness.mjs';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const Q = flag('q', '');
const FIND = args.reduce((a, v, i) => (v === '--find' ? [...a, args[i + 1]] : a), []);

await run({ width: 640, height: 360, url: DEV_URL + (Q ? `?${Q}` : '') }, async ({ page }) => {
  const out = await page.evaluate((find) => {
    const T = window.__THREE;
    if (!T) return { fatal: 'window.__THREE is not published on this page' };
    const chunk = T.ShaderChunk.shadowmap_pars_fragment || '';
    const res = {
      url: location.href,
      chunkBytes: chunk.length,
      hits: find.map((f) => [f, chunk.includes(f)]),
      // A line of the chunk around the rotation, so the answer is legible
      // rather than a boolean.
      phi: (chunk.match(/float phi = sunIGN\([^;]*;/) || ['<not found>'])[0],
      taps: (chunk.match(/for \( int i = 0; i < \d+; i \+\+ \) \{\s*vec2 o = [^;]*;/g) || []).slice(-1)[0] || '<not found>',
    };
    return res;
  }, FIND);
  if (out.fatal) { console.error(`\n  ✗ ${out.fatal}\n`); finish(1); }
  console.log(`\n  ${out.url}`);
  console.log(`  shadowmap_pars_fragment: ${out.chunkBytes} bytes`);
  console.log(`  phi:  ${out.phi}`);
  console.log(`  filter loop: ${String(out.taps).replace(/\s+/g, ' ')}`);
  for (const [f, hit] of out.hits) console.log(`  ${hit ? 'FOUND   ' : 'MISSING '} ${f}`);
  console.log('');
});
finish(0);
