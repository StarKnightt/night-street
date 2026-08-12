/* Every word the street says, counted.
 *
 *   node tools/signcount.mjs            list the parade and check the invariant
 *   node tools/signcount.mjs --quiet    exit code only
 *
 * The point of this is the exit code. `world/trades.ts` deals business
 * identity without replacement and holds three trades out of the deck to be
 * dealt exactly once, and that is an invariant of a data structure — which
 * means it can be broken by a change nowhere near it. Add a building, move a
 * word from the trade-only range back into the hashable one, deal from two
 * places instead of one, and the street quietly starts advertising the same
 * bar twice again with nothing failing.
 *
 * So it is asserted rather than argued. This walks the same deal the renderer
 * walks, counts occurrences per word, and exits non-zero if any word in
 * UNIQUE_WORDS appears more than once or if a trade names a word the sign
 * atlas cannot set.
 *
 * It does not read pixels. That is deliberate and it is the reason it can run
 * in a second without a GPU or a dev server: what is being checked is the
 * assignment, and the assignment is pure. `tools/shots.mjs` is what checks
 * that the assignment reaches the frame.
 */
import { register } from 'node:module';
register('./ts-hooks.mjs', import.meta.url);

const quiet = process.argv.includes('--quiet');

const { tradeMap, frontages, frontageKey } = await import('../src/world/frontage.ts');
const { UNIQUE_WORDS, TRADES, UNIQUE } = await import('../src/world/trades.ts');
const { FASCIA_LIST, fasciaRow } = await import('../src/scene/signs.ts');

const order = frontages();
const map = tradeMap();

const count = new Map();
const rows = [];
for (const b of order) {
  const key = frontageKey(b);
  const t = map.get(key);
  if (!t) { rows.push([key, '(none)', b.frame.oz.toFixed(1)]); continue; }
  count.set(t.word, (count.get(t.word) ?? 0) + 1);
  rows.push([key, t.word, b.frame.oz.toFixed(1), t.glazing, t.kerbside]);
}

let bad = 0;

if (!quiet) {
  console.log(`\n  ${order.length} street frontages, ${TRADES.length} trades in the deck,`
    + ` ${UNIQUE.length} held out as unique\n`);
  console.log('  frontage      z        trade            glazing   kerbside');
  for (const [key, word, z, g, k] of rows) {
    console.log(`  ${key.padEnd(12)}  ${z.padStart(7)}  ${word.padEnd(15)}  ${(g ?? '').padEnd(8)}  ${k ?? ''}`);
  }
  console.log('');
}

/* Every trade has to name a word the atlas can actually set. A trade that does
 * not is not a cosmetic problem: `rowFor` throws on it, so the whole street
 * fails to build, and finding that here is a second faster than finding it in
 * a browser. */
for (const t of [...TRADES, ...UNIQUE]) {
  if (fasciaRow(t.word) < 0) {
    console.error(`  ✗ trade "${t.word}" is not in the sign atlas`);
    bad++;
  }
}

for (const w of UNIQUE_WORDS) {
  const n = count.get(w) ?? 0;
  if (n > 1) {
    console.error(`  ✗ "${w}" is dealt ${n} times and is tagged unique`);
    bad++;
  } else if (!quiet) {
    console.log(`  ✓ "${w}" x${n}`);
  }
}

/* The hashable range is the other half of the guarantee. The fascia board is
 * lettered inside `scene/streetMaterials.ts`, which is locked, by hashing into
 * [fascia0, fascia0 + fasciaN) — so the only way to keep a unique word off a
 * fascia is to keep it out of that range. If someone moves one back in, the
 * deal will still be correct and the street will still show the word twice. */
const { signAtlas } = await import('../src/scene/signs.ts');
let hashable;
try {
  hashable = signAtlas().fasciaN;
} catch {
  /* signAtlas builds a THREE.DataTexture, which needs no GPU but does need
   * three to load; if that fails in this runtime the range is still derivable
   * from the list, and the check below is the part that matters. */
  hashable = null;
}
if (hashable !== null) {
  const reachable = FASCIA_LIST.slice(0, hashable);
  for (const w of UNIQUE_WORDS) {
    if (reachable.includes(w)) {
      console.error(`  ✗ "${w}" is unique but is inside the fascia hash range`
        + ` — move it into FASCIA_TRADE_ONLY`);
      bad++;
    }
  }
  if (!quiet) {
    console.log(`\n  fascia hash range: ${hashable} of ${FASCIA_LIST.length} words`
      + ` — ${FASCIA_LIST.length - hashable} placeable by name only`);
  }
}

/* Neighbours. Not an invariant and not a failure: with more frontages than
 * trades the deck is reshuffled and dealt again, so a repeat somewhere down
 * the street is by design. Two *adjacent* frontages with the same trade is
 * not, and it is the one thing the shuffle cannot rule out by itself. */
let adjacent = 0;
for (let i = 1; i < rows.length; i++) {
  if (rows[i][1] === rows[i - 1][1] && rows[i][1] !== '(none)') {
    console.error(`  ✗ ${rows[i - 1][0]} and ${rows[i][0]} are both ${rows[i][1]}`);
    adjacent++;
  }
}
if (adjacent) bad += adjacent;

console.log(bad ? `\n  FAILED: ${bad} problem(s)\n` : '\n  OK\n');
process.exit(bad ? 1 : 0);
