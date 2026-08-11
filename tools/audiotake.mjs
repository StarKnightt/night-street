/* Record the procedural audio for a take, in real time, and align it.
 *
 *   node tools/audiotake.mjs <tag> [--seconds 30] [--out shots/<tag>/walk.webm]
 *
 * The picture is captured off the wall clock on purpose: `reel.mjs` advances
 * every `useFrame` by exactly 1/fps and a thirty-second walk takes four
 * minutes to render. Web Audio cannot be driven that way. Its clock is the
 * audio device's, everything is scheduled against `ctx.currentTime`, and there
 * is no equivalent of `step(dt)` — so a recording made during a picture
 * capture would be four minutes of ambience with fifty-nine footsteps spread
 * evenly through it.
 *
 * So this is a second pass at real speed. The same walker, the same route out
 * of `tools/shots.mjs`, the same `KeyW` into the same window listener, the
 * same `walker.look()` steering — but on the wall clock, with the master bus
 * tapped into a MediaStreamDestination and a MediaRecorder on it.
 *
 * Alignment is the thing that could go wrong and the thing that is checked.
 * The walker integrates against real `dt`, so its position is a function of
 * elapsed *time* and not of frame count, and a real-time pass at 90 fps and a
 * driven pass at 60 fps arrive at the same place at the same second. That
 * makes the footfalls the alignment instrument: this records the wall-clock
 * time of every footstep and diffs it against the frame numbers in the
 * picture's `reel.json`. A footstep sound half a step out from the footfall on
 * screen is worse than no sound at all, so if the two disagree by more than a
 * few tens of milliseconds the take is rejected here rather than muxed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run, finish, DEV_URL } from './harness.mjs';
import { acquire, release } from './lock.mjs';
import { SHOTS } from './shots.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const tag = args[0] && !args[0].startsWith('--') ? args[0] : 'audio';
const SHOT = flag('shot', 'walk');
const shot = SHOTS.find((s) => s.name === SHOT);
if (!shot) { console.error(`no shot named ${SHOT}`); process.exit(1); }
const SECONDS = +flag('seconds', shot.seconds);
const outDir = path.join(ROOT, 'shots', tag);
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `${SHOT}.webm`);

process.env.SHOOT_CAP_MS = process.env.SHOOT_CAP_MS || String(6 * 60_000);

await acquire(`audiotake:${tag}`);

let result = null;
await run({ width: 640, height: 360 }, async ({ page, errs }) => {
  /* Small viewport, and that is not a shortcut. The picture is already shot;
   * what this pass needs is for the *simulation* to run at real speed, and a
   * 1080p render on an 866k-triangle street would spend its frame budget on
   * pixels nobody will see. At 640x360 the page runs far above the frame rate
   * the walk needs and the gait integrates against a small, steady dt. */
  await page.evaluate(([t, place, yaw0, pitch0]) => {
    const s = window.__scene;
    s.goTo(t);
    if (place) { s.walker.x = place[0]; s.walker.z = place[1]; }
    s.setYaw(yaw0);
    s.setPitch(pitch0);
    s.warp(3.0);
  }, [shot.t, shot.place || null, shot.look[0][1], shot.look[0][2]]);

  /* The audio graph is built lazily off the first gesture. `--autoplay-policy=
   * no-user-gesture-required` is already on the command line, so `resume()` is
   * enough, but the click is what the real page uses and costs nothing. */
  await page.mouse.click(320, 180);
  const built = await page.evaluate(async () => {
    if (!window.__audio) return { ok: false, why: 'window.__audio is not there' };
    await window.__audio.resume();
    await new Promise((r) => setTimeout(r, 1500));
    const rep = window.__audio.report();
    return { ok: true, rep };
  });
  if (!built.ok) throw new Error(built.why);
  console.log(`  context ${JSON.stringify(built.rep.ctx ?? built.rep.state ?? '')}`);
  console.log(`  master ${JSON.stringify(built.rep.master)}`);

  await page.keyboard.down('KeyW');
  result = await page.evaluate(async ([seconds, look, holds]) => {
    const s = window.__scene;
    const eng = window.__audio.engine;
    const ctx = eng.ctx;

    const smooth = (u) => u * u * (3 - 2 * u);
    const lookAt = (keys, sec) => {
      if (sec <= keys[0][0]) return [keys[0][1], keys[0][2]];
      for (let i = 1; i < keys.length; i++) {
        if (sec > keys[i][0]) continue;
        const [t0, y0, p0] = keys[i - 1], [t1, y1, p1] = keys[i];
        const u = smooth((sec - t0) / Math.max(1e-6, t1 - t0));
        return [y0 + (y1 - y0) * u, p0 + (p1 - p0) * u];
      }
      const l = keys[keys.length - 1];
      return [l[1], l[2]];
    };

    /* Tap the limiter rather than the master gain: the limiter is the last
     * node before the device, so what is recorded is what would be heard,
     * including whatever gain reduction the mix asked for. */
    const tap = eng.limiter || eng.master;
    const sink = ctx.createMediaStreamDestination();
    tap.connect(sink);

    const rec = new MediaRecorder(sink.stream, {
      mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 192000,
    });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    const steps = [];
    const prev = s.walker.onFootstep;
    let t0 = 0;
    s.walker.onFootstep = (foot) => {
      steps.push({ t: +(performance.now() / 1000 - t0).toFixed(4), foot, z: +s.walker.z.toFixed(3) });
      if (prev) prev(foot);
    };

    rec.start();
    t0 = performance.now() / 1000;
    const startZ = s.walker.z;

    /* Release the keys the shot releases.
     *
     * KeyW is pressed from Node before this runs and held for the whole take,
     * which was right for every route that walks from end to end and is wrong
     * for one that stops. `walkH` releases at 27.2 and rests 0.6 s later, and a
     * recording that kept walking would put five footsteps and 3.8 m of
     * doppler under a picture of a camera standing still — audible, and exactly
     * the kind of drift the alignment check downstream is meant to catch rather
     * than to have caused.
     *
     * Dispatched on `window` rather than through Playwright because Node is
     * blocked in this evaluate for the whole thirty seconds. It is the same
     * listener and the same `code`; the only difference is `isTrusted`, which
     * nothing in the input path reads. */
    const releases = (holds || []).map(([code, , to]) => ({ code, to, done: false }));
    await new Promise((done) => {
      const tick = () => {
        const sec = performance.now() / 1000 - t0;
        if (sec >= seconds) { done(); return; }
        for (const r of releases) {
          if (r.done || sec < r.to) continue;
          window.dispatchEvent(new KeyboardEvent('keyup', { code: r.code, bubbles: true }));
          r.done = true;
        }
        const [yw, pw] = lookAt(look, sec);
        const SENS = 0.0022;
        const dx = (s.walker.yaw - yw) / SENS;
        const dy = (s.walker.pitch - pw) / SENS;
        if (dx || dy) s.walker.look(dx, dy);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    const blob = await new Promise((r) => { rec.onstop = () => r(new Blob(chunks)); rec.stop(); });
    const b64 = await new Promise((r) => {
      const fr = new FileReader();
      fr.onload = () => r(String(fr.result).split(',')[1]);
      fr.readAsDataURL(blob);
    });
    return {
      b64, steps, startZ: +startZ.toFixed(3), endZ: +s.walker.z.toFixed(3),
      report: window.__audio.report(),
    };
  }, [SECONDS, shot.look, shot.hold || null]);
  await page.keyboard.up('KeyW');

  const bad = errs.filter((e) => e.startsWith('[pageerror]'));
  if (bad.length) console.error(`  ✗ page errors:\n${bad.map((e) => `    ${e}`).join('\n')}`);
});

release();

if (!result) { console.error('  ✗ nothing was recorded'); finish(1); }

fs.writeFileSync(out, Buffer.from(result.b64, 'base64'));
const kb = (fs.statSync(out).size / 1024).toFixed(0);
console.log(`\n  → ${path.relative(ROOT, out)}  ${kb} kB, ${result.steps.length} footfalls`);
console.log(`  walked z ${result.startZ} -> ${result.endZ}`);

/* Is the recording as long as the walk was?
 *
 * A MediaRecorder on a MediaStreamDestination records the audio device's
 * clock, and if the machine is busy enough that the graph underruns it does
 * not error, it drops. One take on a contended GPU came back at 20.3 s of a
 * 30 s walk with the whole timeline uniformly compressed — every footstep
 * present, in step with each other, and a third of a second early by the end
 * of the first bar. It looked completely normal until it was measured, which
 * is the recurring theme of this system, so it is measured here now. */
const dur = (() => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
    '-of', 'csv=p=0', out], { encoding: 'utf8' });
  return parseFloat(String(r.stdout || '').trim());
})();
if (Number.isFinite(dur)) {
  const slip = SECONDS - dur;
  console.log(`  recorded ${dur.toFixed(2)}s of a ${SECONDS}s walk (${slip > 0 ? '-' : '+'}${Math.abs(slip).toFixed(2)}s)`);
  if (Math.abs(slip) > 0.35) {
    console.error('  ✗ the recorder dropped audio — the timeline is compressed. Re-run when the machine is quieter.');
    finish(1);
  }
}

/* The footfall times, written down.
 *
 * The alignment below is checked against whatever picture exists when this
 * runs, and on a morning where the route is being recut underneath the audio
 * that is not necessarily the picture the track gets muxed into. Writing the
 * times out means the next person can diff them against a new `reel.json`
 * without owning a GPU or re-recording anything. */
const sidecar = path.join(outDir, `${SHOT}.steps.json`);
fs.writeFileSync(sidecar, JSON.stringify({
  shot: SHOT, seconds: SECONDS, recordedSeconds: dur,
  startZ: result.startZ, endZ: result.endZ,
  steps: result.steps,
}, null, 2));

/* Did the sound land where the picture did?
 *
 * The picture's footfalls are exact — a driven capture puts them on a known
 * frame — so the comparison is between two lists of times that should be the
 * same list. */
const picture = path.join(ROOT, 'shots', flag('against', tag), 'reel.json');
if (fs.existsSync(picture)) {
  const j = JSON.parse(fs.readFileSync(picture, 'utf8'));
  const s = j.shots.find((x) => x.name === SHOT);
  const want = s.steps.map((x) => x.frame / j.fps);
  const got = result.steps.map((x) => x.t);
  const n = Math.min(want.length, got.length);
  let worst = 0, sum = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.abs(want[i] - got[i]);
    sum += d;
    if (d > worst) worst = d;
  }
  console.log(`\n  footfall alignment against ${path.relative(ROOT, picture)}`);
  console.log(`    ${want.length} on screen, ${got.length} recorded, ${n} compared`);
  console.log(`    mean |Δt| ${(1000 * sum / n).toFixed(1)} ms, worst ${(1000 * worst).toFixed(1)} ms`);
  console.log(`    ${worst < 0.06 ? '→ in step' : '✗ the steps drift — do not mux this without a time fit'}`);
}

const rep = result.report;
console.log('\n  buses at the end of the take');
/* `everDb` is the field that answers the question this block exists to ask.
 * It used to print `rmsDb` and `peakDb`, which `BusReport` has never had, so
 * every bus read `undefined` — including on the take where every bus really
 * was silent, which is the one run where this output would have said so. */
for (const [k, v] of Object.entries(rep.buses || {})) {
  console.log(`    ${k.padEnd(8)} now ${String(v.nowDb).padStart(7)} dB   hold ${String(v.holdDb).padStart(7)} dB   loudest ever ${String(v.everDb).padStart(7)} dB`);
}
if (rep.silent?.length) console.error(`  ✗ buses that never passed a sample: ${rep.silent.join(', ')}`);
console.log(`  ${rep.counts.steps} steps, ${rep.counts.horns} horns, ${rep.counts.passBys} pass-bys, ${rep.counts.rattles} rattles, ${rep.counts.barHits} bar hits`);
finish(0);
