/* Capture the walk.
 *
 * The same six viewpoints every run, so two builds can be put side by side
 * and actually compared, and so a critic looking only at pictures is looking
 * at the same pictures each time.
 *
 *   node tools/shoot.mjs [tag] [--t 0.02,0.2,...] [--w 1600] [--h 900]
 *                        [--yaw 0] [--pitch 0] [--fov 0] [--js "..."] [--cpu]
 *
 * Requires a dev server already running on port 3000. It will not start one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture, finish } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = args[0] && !args[0].startsWith('--') ? args[0] : 'run';
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };

const STOPS = flag('t', '0.02,0.2,0.4,0.6,0.8,0.95').split(',').map(Number);
const W = +flag('w', 1600), H = +flag('h', 900);
const YAW = +flag('yaw', 0);
const PITCH = +flag('pitch', 0);
/* A seventh stop, framing the near road.
 *
 * The main set is shot dead level, which at a 45-degree vertical frame puts the
 * closest visible ground about four metres out and leaves the aggregate too
 * small to judge in any of the six. That is not how anyone photographs a
 * street: a phone held at chest height tips down a little and the bottom third
 * of the frame is road at two or three metres. This stop reproduces that, so
 * the surface is assessed at the size it is actually seen at rather than only
 * in a separate long-lens diagnostic. */
const TILT_AT = +flag('tiltAt', 0.4);
const TILT = +flag('tilt', -0.25);
const NO_TILT = args.includes('--noTilt');
/* A long lens on the same viewpoint. Nothing about the scene changes; it is
 * purely a way to inspect material at the size the eye gives it when someone
 * stops and looks down at the road, which a 56-degree frame cannot show.
 * Detail that only exists below this magnification is detail nobody sees. */
const FOV = +flag('fov', 0);
/* Arbitrary setup run once against the debug API before the first stop, for
 * isolating a suspect layer without editing the scene and having to remember
 * to edit it back. */
const JS = flag('js', '');
/* An explicit filename, because the default one is derived from the walk
 * parameter and that has now cost a review round.
 *
 * A diagnostic shot at --t 0.86 lands in <tag>/86.png. Reported as "the
 * near-field sunlit facade", alongside siblings called face/40.png and
 * near/40.png, a reader looks for lit/40.png, does not find it, and concludes
 * the capture produced nothing. Nothing had gone wrong at all — the file was
 * written, checked and named after a number nobody had been told. */
const NAME = flag('name', null);

const outDir = path.join(ROOT, 'shots', tag);
// --keep, for adding a second framing to a folder that already has one. The
// default is still to wipe, because a stale frame left beside a fresh one is
// how a folder ends up half describing a build that no longer exists.
if (!args.includes('--keep')) fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

await run({ width: W, height: H }, async ({ page, errs, gl }) => {
  await page.evaluate(([fov, js]) => {
    const s = window.__scene;
    if (fov) { s.camera.fov = fov; s.camera.updateProjectionMatrix(); }
    if (js) new Function('s', js)(s);
  }, [FOV, JS]);

  const results = [];
  const plan = STOPS.map((t) => ({ t, pitch: PITCH, name: null }));
  if (!NO_TILT) plan.push({ t: TILT_AT, pitch: TILT, name: 'tilt' });

  for (const { t, pitch: sp, name } of plan) {
    await page.evaluate(([t, yaw, pitch]) => {
      const s = window.__scene;
      s.goTo(t);
      s.setYaw(yaw);
      s.setPitch(pitch);
      // Settle the gait and anything else that springs, so the frame is the
      // one you would get by actually walking here rather than teleporting.
      s.warp(2.0);
    }, [t, YAW, sp]);
    await page.waitForTimeout(200);

    const st = await page.evaluate(() => {
      const s = window.__scene;
      const p = s.camera.position;
      return {
        fps: +s.fps.toFixed(1),
        pos: [+p.x.toFixed(2), +p.y.toFixed(3), +p.z.toFixed(1)],
        ...s.info(),
        hist: s.probe(),
      };
    });

    const stem = name ?? NAME ?? String(Math.round(t * 100)).padStart(2, '0');
    const file = path.join(outDir, `${stem}.png`);
    await capture(page, file);
    results.push({ t, pitch: sp, file: path.basename(file), ...st });

    const hi = st.hist;
    console.log(`  t=${t.toFixed(2)}  pos=${st.pos.join(',')}  ` +
      `calls=${String(st.calls).padStart(3)} tris=${(st.triangles / 1000).toFixed(0)}k ` +
      `prog=${st.programs} tex=${st.textures}`);
    console.log(`        lum med=${hi.median} p10=${hi.p10} p90=${hi.p90} mean=${hi.mean} ` +
      `contrast=${hi.contrast} black=${hi.blackPct}% blown=${hi.blownPct}% ` +
      `up=${hi.upper} low=${hi.lower}`);
  }

  /* Steady-state frame rate, measured after everything is warm: every shader
   * compiled, every texture baked, every mip generated. The number taken in
   * the first second is a measurement of the compiler, not the renderer. */
  const perf = await page.evaluate(async () => {
    const s = window.__scene;
    s.setPaused(false);
    await new Promise((r) => setTimeout(r, 2500));
    return { fps: +s.fps.toFixed(1), ...s.info() };
  });
  console.log(`\n  steady: ${perf.fps} fps   calls=${perf.calls} tris=${(perf.triangles / 1000).toFixed(0)}k`);
  console.log(`  adapter: ${gl.renderer}`);

  fs.writeFileSync(
    path.join(outDir, 'report.json'),
    JSON.stringify({
      tag, when: new Date().toISOString(), viewport: [W, H],
      gl, camera: { yaw: YAW, pitch: PITCH, fov: FOV || 45 },
      perf, results, errors: [...new Set(errs)],
    }, null, 2),
  );
  /* Say what was written, and fail if it was not.
   *
   * The other half of the same lesson: a capture that reports success without
   * ever checking the filesystem is trusting the one thing most likely to have
   * gone wrong. Every planned frame is now stat'd, its size printed, and a
   * missing or suspiciously small file is an error rather than a silence. */
  const manifest = [];
  let bad = 0;
  for (const r of results) {
    const p = path.join(outDir, r.file);
    const size = fs.existsSync(p) ? fs.statSync(p).size : 0;
    manifest.push({ file: r.file, bytes: size });
    if (size < 20000) { bad++; console.log(`  MISSING/EMPTY  ${path.relative(ROOT, p)}`); }
    else console.log(`  wrote ${path.relative(ROOT, p)}  ${(size / 1024).toFixed(0)} kB`);
  }
  if (bad) {
    console.error(`\n  ${bad} capture(s) did not reach disk`);
    process.exitCode = 1;
  }

  /* The manifest describes the folder, not the run.
   *
   * With --keep a second invocation adds a frame to a folder that already has
   * some, and writing only its own results here replaced a complete manifest
   * with a one-line one. Anyone auditing the folder afterwards would have been
   * told that the frames from the earlier invocation did not exist — the same
   * silent-reporting failure this block was added to prevent, one level up.
   * So the manifest is built by listing the directory. */
  const rp = path.join(outDir, 'report.json');
  const rep = JSON.parse(fs.readFileSync(rp, 'utf8'));
  rep.manifest = fs.readdirSync(outDir)
    .filter((f) => f.endsWith('.png'))
    .sort()
    .map((f) => ({ file: f, bytes: fs.statSync(path.join(outDir, f)).size }));
  fs.writeFileSync(rp, JSON.stringify(rep, null, 2));

  console.log(`\n  → ${path.relative(ROOT, outDir)}`);
});

finish(process.exitCode || 0);
