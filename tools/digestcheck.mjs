/* Is the tree that rendered a take still the tree we are shipping?
 *
 *   node tools/digestcheck.mjs shots/heroE/reel.json
 *
 * reel.json records a digest of every .ts/.tsx under src/ taken before and
 * after the capture loop, because an earlier reel here was silently overtaken
 * by a concurrent edit seven minutes after it finished and nobody could tell
 * from the frames. Matching digests is the easy case. When they differ the
 * only question that matters is *which* files moved: a change to the audio
 * graph cannot alter a frame that was already encoded, and a change to a
 * material can. So print the list rather than a verdict.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const reel = JSON.parse(fs.readFileSync(process.argv[2] || 'shots/heroE/reel.json', 'utf8'));

const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(e.name)) {
      const st = fs.statSync(p);
      files.push([path.relative(ROOT, p).replace(/\\/g, '/'), st.size, +st.mtimeMs.toFixed(0)]);
    }
  }
};
walk(path.join(ROOT, 'src'));
files.sort();

const now = createHash('sha1').update(JSON.stringify(files)).digest('hex').slice(0, 12);
const at = Date.parse(reel.build.newest.at);

console.log(`\n  take   ${reel.build.digest}  (${reel.build.stable ? 'held for the whole capture' : 'CHANGED MID-CAPTURE'})`);
console.log(`  now    ${now}\n`);

if (now === reel.build.digest) {
  console.log('  identical — the frames on disk were rendered by the tree you are shipping\n');
  process.exit(0);
}

const moved = files.filter((f) => f[2] > at);
console.log(`  ${moved.length} file(s) touched since the capture's newest source:\n`);
for (const f of moved) console.log(`    ${f[0].padEnd(40)} ${new Date(f[2]).toISOString()}`);
console.log('\n  Judge these by hand. Anything under src/scene, src/world or src/app');
console.log('  renders; anything under src/audio does not.\n');
process.exit(0);
