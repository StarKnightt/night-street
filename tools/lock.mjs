/* The capture lock.
 *
 * Several agents share this worktree and one GPU. Two headless Chromiums
 * rendering an 866k-triangle street at the same time do not fail — they just
 * both run at half speed, and the frame rate that gets written into a report
 * is then a measurement of the other agent. One capture has already been held
 * that way, so serialisation is mandatory rather than polite.
 *
 * The protocol is a single file, `.capture.lock`, containing the holder's
 * name and pid. Acquire waits for it to disappear; release deletes it. The
 * release is registered on `process.on('exit')` as well as on the normal path,
 * because harness.mjs's teardown calls `process.exit()` directly and a
 * `finally` block never runs after that.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LOCK = path.join(ROOT, '.capture.lock');

/* Long enough to sit behind a full six-stop shoot, short enough that a lock
 * left behind by a killed process is noticed rather than waited on forever. */
const WAIT_MS = Number(process.env.CAPTURE_LOCK_WAIT_MS || 20 * 60_000);
/* A lock older than this belonged to a process that is gone. Nothing here
 * runs for twenty minutes. */
const STALE_MS = Number(process.env.CAPTURE_LOCK_STALE_MS || 20 * 60_000);

let held = false;

function releaseSync() {
  if (!held) return;
  held = false;
  try {
    // Only delete our own. A crash between the read and the unlink would
    // otherwise take out whoever acquired it next.
    if (fs.readFileSync(LOCK, 'utf8').includes(`pid=${process.pid}`)) fs.rmSync(LOCK, { force: true });
  } catch { /* already gone, which is the desired state */ }
}

export function release() { releaseSync(); }

/** Block until the lock is free, then take it. Returns a release function. */
export async function acquire(name) {
  const started = Date.now();
  let announced = false;
  for (;;) {
    try {
      fs.writeFileSync(LOCK, `${name} pid=${process.pid} at=${new Date().toISOString()}\n`, { flag: 'wx' });
      held = true;
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let body = '', age = 0;
      try {
        body = fs.readFileSync(LOCK, 'utf8').trim();
        age = Date.now() - fs.statSync(LOCK).mtimeMs;
      } catch { continue; }   // vanished between the write and the read
      if (age > STALE_MS) {
        console.log(`[lock] breaking a stale lock (${(age / 60000).toFixed(1)} min): ${body}`);
        fs.rmSync(LOCK, { force: true });
        continue;
      }
      if (!announced) { console.log(`[lock] waiting for ${body}`); announced = true; }
      if (Date.now() - started > WAIT_MS) throw new Error(`capture lock held for ${(WAIT_MS / 60000) | 0} min by ${body}`);
      await new Promise((r) => setTimeout(r, 700));
    }
  }
  if (announced) console.log(`[lock] acquired after ${((Date.now() - started) / 1000).toFixed(1)}s`);
  process.on('exit', releaseSync);
  return release;
}
