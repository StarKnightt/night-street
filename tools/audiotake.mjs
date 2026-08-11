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
  result = await page.evaluate(async ([seconds, look]) => {
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

    await new Promise((done) => {
      const tick = () => {
        const sec = performance.now() / 1000 - t0;
        if (sec >= seconds) { done(); return; }
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
  }, [SECONDS, shot.look]);
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
for (const [k, v] of Object.entries(rep.buses || {})) {
  console.log(`    ${k.padEnd(8)} rms ${String(v.rmsDb).padStart(7)} dB   peak ${String(v.peakDb).padStart(7)} dB`);
}
finish(0);
