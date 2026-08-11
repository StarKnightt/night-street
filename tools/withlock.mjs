/* Run any command under the capture lock.
 *
 * `tools/lock.mjs` states the protocol and `reel.mjs` takes it, but
 * `harness.mjs` — which every one of shoot / px / diag / profile goes through
 * — does not, so those five tools will happily start a second headless
 * Chromium alongside a reel that is mid-capture. Rather than edit the shared
 * harness while two other agents are writing against it, this wraps the whole
 * child process: acquire, spawn, wait, release, including on a signal.
 *
 *   node tools/withlock.mjs sys8 -- node tools/shoot.mjs sys8a --t 0.4
 */
import { spawn } from 'node:child_process';
import { acquire, release } from './lock.mjs';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep < 1) {
  console.error('usage: node tools/withlock.mjs <name> -- <command...>');
  process.exit(2);
}
const name = argv.slice(0, sep).join(' ');
const [cmd, ...args] = argv.slice(sep + 1);

await acquire(name);

const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });

// The lock must go even if we are killed; lock.mjs registers its own exit
// hook, but a signal does not run `exit` handlers unless we ask for it.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { try { child.kill(); } catch { /* already gone */ } release(); process.exit(1); });
}

const code = await new Promise((r) => child.on('close', r));
release();
process.exit(code ?? 0);
