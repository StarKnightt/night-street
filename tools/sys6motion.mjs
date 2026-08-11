/* Does the dust read as air, or as grain on the lens?
 *
 * A still cannot answer this and neither can a pixel count. Two hundred and
 * fifty lit pixels scattered over a frame is the *same still* whether they are
 * motes suspended in air or a noise texture, and the difference — the only
 * difference a viewer can actually see — is what they do when the camera
 * moves. Motes are objects at a distance: they persist between frames and slide
 * across the background with a parallax set by how near they are. Grain does
 * not persist; it is redrawn every frame from nothing.
 *
 * So this measures persistence, on the deliverable walk, with a number that
 * separates the two cleanly.
 *
 * Each frame is rendered twice at the same simulation state, once with the mote
 * level at its shipped value and once at zero, and differenced per pixel. That
 * isolates the dust exactly: everything else in the frame — gait bob, shadow
 * crawl, the haze, the cars — is identical between the pair and subtracts out.
 * The result is a mask of the pixels the dust owns.
 *
 * Then, for every dust pixel in frame N, the distance to the nearest dust pixel
 * in frame N-1. The interpretation is not subtle:
 *
 *   a few px   the same motes, displaced by their parallax. Air.
 *   ~38 px     the expected nearest-neighbour distance of that many points
 *              thrown down at random in a 1600x900 frame, i.e. no relationship
 *              between consecutive frames at all. Grain.
 *
 * The 38 comes from 0.5 / sqrt(density) and is printed alongside the measured
 * value so the comparison is on the page rather than in someone's head.
 *
 * It also writes three images: a frame, the dust of that frame at gain, and the
 * maximum of the dust over the whole sequence, which draws each mote's path and
 * is the one that shows at a glance whether the field is a field.
 *
 *   node tools/sys6motion.mjs [--seconds 6] [--flag eyegate]
 */
import fs from 'node:fs';
import path from 'node:path';
import { run, finish } from './harness.mjs';
import { acquire } from './lock.mjs';

const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i < 0 ? d : args[i + 1]; };
const SECONDS = Number(flag('seconds', 6));
const HAZE = flag('flag', '');
const FPS = 30;
const OUT = path.join('shots', 'sys6motion');
fs.mkdirSync(OUT, { recursive: true });

/* The deliverable walk, copied from reel.mjs's `walk` shot rather than
 * invented: same start, same line up the sunward footway, same heading. A dust
 * field judged on a route nobody is going to record is not evidence. */
const SHOT = { t: 0.02, place: [-5.05, Number(flag('z', 2.0))], yaw: 0.0, pitch: -0.05 };

process.env.SHOOT_CAP_MS = process.env.SHOOT_CAP_MS || String(20 * 60_000);

await acquire('sys6-motion');

await run({ width: 1600, height: 900 }, async ({ page }) => {
  const url = HAZE ? `http://127.0.0.1:3000/?haze=${HAZE}` : 'http://127.0.0.1:3000/';
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => !!window.__scene, null, { timeout: 60_000 });
  await page.waitForTimeout(2500);

  await page.evaluate(([shot, frames]) => {
    const s = window.__scene;
    window.__mFrames = frames;
    s.camera.fov = 50; s.camera.updateProjectionMatrix();
    s.goTo(shot.t);
    s.walker.x = shot.place[0]; s.walker.z = shot.place[1];
    s.setYaw(shot.yaw); s.setPitch(shot.pitch);
    s.warp(3.0);
    s.setDriven(true);

    let pts = null;
    s.scene.traverse((o) => { if (o.isPoints) pts = o; });
    window.__m = {
      pts,
      w: s.renderer.domElement.width,
      h: s.renderer.domElement.height,
      prev: null,          // previous frame's dust pixel indices
      trail: null,         // running max of the dust difference
    };
    window.__m.trail = new Uint8Array(window.__m.w * window.__m.h);
  }, [SHOT, Math.round(SECONDS * FPS)]);

  await page.keyboard.down('KeyW');

  const frames = Math.round(SECONDS * FPS);
  const rows = [];
  for (let f = 0; f < frames; f++) {
    const row = await page.evaluate(([dt, frame]) => {
      const s = window.__scene, M = window.__m;
      s.step(dt);

      const gl = s.renderer, ctx = gl.getContext(), w = M.w, h = M.h;
      const u = M.pts.material.uniforms;
      const grab = (buf) => {
        gl.render(s.scene, s.camera);
        ctx.readPixels(0, 0, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, buf);
      };
      const on = new Uint8Array(w * h * 4), off = new Uint8Array(w * h * 4);
      const p0 = u.uPeak.value;
      grab(on);
      u.uPeak.value = 0;
      grab(off);
      u.uPeak.value = p0;

      /* The dust, exactly: same state, same everything, one term switched. */
      const idx = [];
      let mx = 0;
      for (let i = 0, p = 0; i < on.length; i += 4, p++) {
        const d = Math.abs(on[i] - off[i]) + Math.abs(on[i + 1] - off[i + 1])
                + Math.abs(on[i + 2] - off[i + 2]);
        if (d > 2) { idx.push(p); if (d > M.trail[p]) M.trail[p] = Math.min(255, d); }
        if (d > mx) mx = d;
      }

      /* Nearest dust pixel in the previous frame, per dust pixel in this one.
       * Chebyshev distance, searched outward on a hash of the previous set, so
       * the cost is the number of dust pixels and not the number of pixels. */
      let nn = null;
      if (M.prev && M.prev.size && idx.length) {
        const ds = [];
        const LIM = 48;
        for (const p of idx) {
          const px = p % w, py = (p / w) | 0;
          let best = -1;
          for (let r = 0; r <= LIM && best < 0; r++) {
            for (let dy = -r; dy <= r && best < 0; dy++) {
              const yy = py + dy;
              if (yy < 0 || yy >= h) continue;
              const stepx = (Math.abs(dy) === r) ? 1 : 2 * r;
              for (let dx = -r; dx <= r; dx += Math.max(stepx, 1)) {
                const xx = px + dx;
                if (xx < 0 || xx >= w) continue;
                if (M.prev.has(yy * w + xx)) { best = r; break; }
              }
            }
          }
          ds.push(best < 0 ? LIM + 1 : best);
        }
        ds.sort((a, b) => a - b);
        const q = (t) => ds[Math.min(ds.length - 1, Math.floor(t * ds.length))];
        nn = { p25: q(0.25), median: q(0.5), p75: q(0.75), p95: q(0.95),
               lost: +(100 * ds.filter((d) => d > LIM).length / ds.length).toFixed(1) };
      }
      M.prev = new Set(idx);

      // Keep one frame's raw pixels for the contact images, mid-walk.
      if (frame === Math.round(window.__mFrames / 2)) { M.keepOn = on; M.keepOff = off; }

      return { frame, dust: idx.length, max: mx, nn,
               x: +s.walker.x.toFixed(2), z: +s.walker.z.toFixed(2),
               speed: +s.walker.speed.toFixed(2) };
    }, [1 / FPS, f]);
    rows.push(row);
  }
  await page.keyboard.up('KeyW');

  const out = await page.evaluate(() => {
    const M = window.__m, w = M.w, h = M.h;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const c2 = cv.getContext('2d');
    // readPixels is bottom-up; ImageData is top-down.
    const flip = (src, gain) => {
      const im = c2.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        const s0 = (h - 1 - y) * w * 4, d0 = y * w * 4;
        for (let x = 0; x < w * 4; x += 4) {
          im.data[d0 + x] = Math.min(255, src[s0 + x] * gain);
          im.data[d0 + x + 1] = Math.min(255, src[s0 + x + 1] * gain);
          im.data[d0 + x + 2] = Math.min(255, src[s0 + x + 2] * gain);
          im.data[d0 + x + 3] = 255;
        }
      }
      return im;
    };
    const png = (im) => { c2.putImageData(im, 0, 0); return cv.toDataURL('image/png').split(',')[1]; };

    const images = {};
    if (M.keepOn) images.frame = png(flip(M.keepOn, 1));

    /* The dust of one frame, at gain, on black: what a single instant of the
     * field looks like with everything else taken away. */
    if (M.keepOn && M.keepOff) {
      const d = new Uint8Array(w * h * 4);
      for (let i = 0; i < d.length; i += 4) {
        d[i] = Math.abs(M.keepOn[i] - M.keepOff[i]);
        d[i + 1] = Math.abs(M.keepOn[i + 1] - M.keepOff[i + 1]);
        d[i + 2] = Math.abs(M.keepOn[i + 2] - M.keepOff[i + 2]);
      }
      images.dust = png(flip(d, 6));
    }

    /* Every mote's path over the sequence. A field of air draws streaks that
     * fan from the direction of travel; grain fills the frame evenly. */
    const t = new Uint8Array(w * h * 4);
    for (let p = 0; p < M.trail.length; p++) {
      const v = M.trail[p];
      t[p * 4] = v; t[p * 4 + 1] = v * 0.78; t[p * 4 + 2] = v * 0.5;
    }
    images.trail = png(flip(t, 4));

    let painted = 0;
    for (let p = 0; p < M.trail.length; p++) if (M.trail[p] > 2) painted++;
    return { painted, w, h, images };
  });

  const tag = `${HAZE ? `-${HAZE}` : ''}${SHOT.place[1] !== 2 ? `-z${SHOT.place[1]}` : ''}`;
  for (const [name, b64] of Object.entries(out.images)) {
    fs.writeFileSync(path.join(OUT, `${name}${tag}.png`), Buffer.from(b64, 'base64'));
  }

  const num = (a) => a.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  const med = (a) => { const s = num(a); return s.length ? s[s.length >> 1] : NaN; };
  const dust = rows.map((r) => r.dust);
  const nnMed = rows.map((r) => (r.nn ? r.nn.median : NaN));
  const nnLost = rows.map((r) => (r.nn ? r.nn.lost : NaN));
  const density = med(dust) / (out.w * out.h);
  const chance = 0.5 / Math.sqrt(density);

  console.log(`\n===== SYSTEM 6 DUST IN MOTION${HAZE ? `  (?haze=${HAZE})` : ''} =====`);
  console.log(`  ${rows.length} frames at ${FPS} fps on the deliverable walk, ${out.w}x${out.h}`);
  console.log(`  walked ${rows[0].z} -> ${rows[rows.length - 1].z} m at ${med(rows.map((r) => r.speed))} m/s\n`);
  console.log(`  dust pixels per frame   median ${med(dust)}   min ${num(dust)[0]}   max ${num(dust)[dust.length - 1]}`);
  console.log(`  peak difference         ${Math.max(...rows.map((r) => r.max))} counts (summed rgb)`);
  console.log(`  pixels ever painted     ${out.painted} over the sequence\n`);
  console.log(`  nearest dust pixel in the previous frame:`);
  console.log(`    median ${med(nnMed)} px    p95 ${med(rows.map((r) => (r.nn ? r.nn.p95 : NaN)))} px    unmatched ${med(nnLost)}%`);
  console.log(`    if the field were independent noise this would be ~${chance.toFixed(0)} px`);

  /* Where along the route the dust actually lights up. The street is a shaded
   * canyon with gaps in the sunward frontage, so this is expected to be spiky
   * rather than flat, and a flat zero anywhere the walk is in shade is the
   * shadow gate working rather than the field failing. */
  console.log('\n  per second   z (m)   dust px   peak');
  for (let s0 = 0; s0 < rows.length; s0 += FPS) {
    const g = rows.slice(s0, s0 + FPS);
    console.log(`    ${String(s0 / FPS).padStart(4)}s ${String(g[0].z).padStart(9)} ` +
      `${String(med(g.map((r) => r.dust))).padStart(8)} ${String(Math.max(...g.map((r) => r.max))).padStart(6)}`);
  }
  console.log(`\n  → ${OUT}\n`);
  fs.writeFileSync(path.join(OUT, `motion${tag}.json`), JSON.stringify({ rows, painted: out.painted }, null, 1));
});

finish(process.exitCode || 0);
