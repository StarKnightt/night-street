/* Run a measurement twice — with the shadow follower and without — under one
 * lock, and refuse the pair if the tree moved between the halves.
 *
 *   node tools/pairrun.mjs frontage -- node tools/frontage.mjs --out tmp/frontage
 *
 * The second half is given `--nofollow --auditlive`, which restores the
 * pre-0a4f58b behaviour and lets the liveness assertion report rather than
 * fail. `--out`-style arguments are the caller's problem; this only appends.
 *
 * ── Why the fingerprint ───────────────────────────────────────────────────
 *
 * Four agents are editing this tree while this runs and `tools/sunlamp.mjs`
 * already carries the scar: a run that straddles somebody else's save is two
 * builds wearing one filename, and a half-saved file landing between two runs
 * has produced a wrong conclusion in this project today. A single browser
 * session would be better still, and the A/B in `tools/shadowab.mjs` is one —
 * but a tool that owns its own `run()` cannot be halved from outside, so the
 * next best thing is to hash every source the page could compile, before and
 * after both halves, and say so loudly if it changed.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquire, release } from './lock.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep < 1) {
  console.error('usage: node tools/pairrun.mjs <name> -- <command...>');
  process.exit(2);
}
const name = argv.slice(0, sep).join(' ');
const [cmd, ...base] = argv.slice(sep + 1);

/** Everything the dev server could compile into the page. */
function fingerprint() {
  const h = createHash('sha1');
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|mjs|json)$/.test(e.name)) {
        h.update(e.name);
        h.update(fs.readFileSync(p));
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  return h.digest('hex').slice(0, 12);
}

const run = (args) => new Promise((r) => {
  console.log(`\n╔══ ${name}: ${[cmd, ...args].join(' ')}`);
  const c = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  c.on('close', (code) => r(code ?? 0));
});

await acquire(name);
let code = 0;
try {
  const before = fingerprint();
  console.log(`  src fingerprint ${before}`);
  code = await run(base);
  const mid = fingerprint();
  code = (await run([...base, '--nofollow', '--auditlive'])) || code;
  const after = fingerprint();

  console.log(`\n  src fingerprint  before ${before}  between ${mid}  after ${after}`);
  if (before !== after) {
    console.error('\n✗ THE TREE CHANGED DURING THE PAIR. The two halves are different builds');
    console.error('  and the difference between them is not the follower. Re-run.');
    code = 1;
  } else {
    console.log('  the two halves are the same build; the follower is the only variable');
  }
} finally {
  release();
}
process.exit(code);
