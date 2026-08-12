/* What the scene is lit by, and what it would be lit by if the probe were the
 * sky that is actually drawn.
 *
 *   node tools/withlock.mjs skylift -- node tools/skylift.mjs before
 *
 * Two independent terms are swept, both of them live on a mounted scene, so
 * every number in the table comes out of one build, one boot and one set of
 * compiled programs:
 *
 *   probe   `window.__env.flat` is the PMREM of the cloudless, ozone-free
 *           equirect this project shipped with. `window.__env.clouds` is the
 *           PMREM of a cube baked by the same shader as the background, with
 *           the solar disc off. Both are cubeUV targets, so three's program
 *           cache key does not move and no material recompiles between the two
 *           draws — which is the only condition under which the difference
 *           measured is the sky and not a rebuild.
 *   gain    `scene.environmentIntensity`, which three reads per draw.
 *
 * The instrument is `window.__hdr`, added to grade.tsx by this pass: the scene
 * pass read back in linear radiance, before bloom, before the grade, before
 * AgX. Metering the canvas cannot answer "how much light is landing here"
 * because AgX's shoulder maps two radiances onto one code value and its clamp
 * maps a decade onto none — which is exactly the region a sun in frame lives
 * in. Both are reported: radiance says what changed, code values say what a
 * viewer sees.
 *
 * ── The guard ────────────────────────────────────────────────────────────
 *
 * A term that is not wired up reads as exactly 1.000. Every ratio here is
 * printed to four places for that reason, and a variant whose whole-frame
 * radiance is bit-identical to the baseline is called out as inert rather
 * than quietly reported as "no change".
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, capture, finish, DEV_URL } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const tag = args[0] && !args[0].startsWith('--') ? args[0] : 'skylift';
const flag = (k, d) => { const i = args.indexOf('--' + k); return i < 0 ? d : args[i + 1]; };
const W = +flag('w', 1600), H = +flag('h', 900);
const SHOT = !args.includes('--nopng');

/* The walk, and one frame that is not on it.
 *
 * `lot` is the reproduction of the frame the user sent: standing on the
 * carriageway near the vacant lot, which placement.ts puts behind railings at
 * z -99..-81 on the +X side, looking down the street with the horizon a
 * little below centre. Everything facing the camera there is shadow-side, so
 * it is the frame with the most to gain from the probe and the least to gain
 * from the sun, which is what makes it the test rather than the showcase.
 */
const VIEWS = [
  { name: 'lot', t: 0.78, yaw: 0, pitch: 0.09 },
  { name: 'near', t: 0.20, yaw: 0, pitch: 0.0 },
  { name: 'mid', t: 0.40, yaw: 0, pitch: 0.0 },
  { name: 'far', t: 0.95, yaw: 0, pitch: 0.0 },
  /* Facing the sun's own azimuth rather than down the street. SUN_AZIM is 35
   * degrees to the +X side of the far end, so this is where a walker would
   * have to look to have any chance of seeing the disc. */
  { name: 'sunward', t: 0.55, yaw: 35 * Math.PI / 180, pitch: 0.06 },
  /* And away from it, which is the control: the anti-sun half of the dome is
   * the part the cloud deck changes least. */
  { name: 'antisun', t: 0.55, yaw: Math.PI + 35 * Math.PI / 180, pitch: 0.06 },
];

const VARIANTS = [
  { key: 'A', probe: 'flat', ei: 0.50, label: 'shipped: cloudless probe, gain 0.50' },
  { key: 'B', probe: 'clouds', ei: 0.50, label: 'probe fixed only' },
  { key: 'C', probe: 'flat', ei: 1.00, label: 'gain fixed only' },
  { key: 'D', probe: 'clouds', ei: 1.00, label: 'both' },
];

const OUT = path.join(ROOT, 'shots', tag);
fs.mkdirSync(OUT, { recursive: true });

const url = `${DEV_URL}/?nograde&haze=nodust`;
const report = { tag, when: new Date().toISOString(), url, views: {} };

await run({ width: W, height: H, url }, async ({ page, readShaderErrors }) => {
  const ready = await page.evaluate(() => {
    const e = window.__env;
    return {
      env: !!e, hasFlat: !!(e && e.hasFlat), hdr: !!window.__hdr,
      distinct: !!(e && e.clouds !== e.flat),
    };
  });
  console.log(`  __env published=${ready.env} flat probe built=${ready.hasFlat} ` +
    `distinct objects=${ready.distinct}   __hdr=${ready.hdr}`);
  if (!ready.env || !ready.hasFlat || !ready.hdr || !ready.distinct) {
    console.error('✗ the A/B surface is not there; nothing below would mean anything.');
    process.exitCode = 1;
    return;
  }

  for (const v of VIEWS) {
    await page.evaluate(([t, yaw, pitch]) => {
      const s = window.__scene;
      if (window.__sys5) window.__sys5.freeze(0);
      s.goTo(t);
      s.setYaw(yaw);
      s.setPitch(pitch);
      s.warp(2.0);
      /* Stand still. The bob is scaled by a smoothed speed that does not decay
       * in two frames, and a centimetre of eye height moves every pixel. */
      s.walker.phase = 0;
      s.walker.speed = 0;
      s.walker.update(1 / 240, { forward: 0, strafe: 0, sprint: false });
    }, [v.t, v.yaw, v.pitch]);
    await page.waitForTimeout(180);

    const rows = [];
    for (const q of VARIANTS) {
      const m = await page.evaluate(([probe, ei]) => {
        const s = window.__scene;
        s.setPaused(true);
        s.scene.environment = window.__env[probe];
        s.scene.environmentIntensity = ei;
        s.renderOnce();

        const hdr = window.__hdr;
        const whole = hdr.rect(0, 0, 1, 1, 0);
        /* Twelve tiles, so a change can be located rather than merely
         * totalled. Row 0 is the bottom of the frame in GL's coordinates,
         * which is the road; row 2 is the sky. */
        const tiles = [];
        for (let r = 0; r < 3; r++) {
          for (let c = 0; c < 4; c++) {
            const t = hdr.rect(c / 4, r / 3, (c + 1) / 4, (r + 1) / 3, 0);
            tiles.push({ r, c, mean: t.mean, med: t.lum.median, peak: t.lum.peak });
          }
        }

        // The canvas, i.e. what a viewer sees, after AgX and the post chain.
        const cv = s.renderer.domElement;
        const ctx = s.renderer.getContext();
        const px = new Uint8Array(cv.width * cv.height * 4);
        ctx.readPixels(0, 0, cv.width, cv.height, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
        let cr = 0, cg = 0, cb = 0, blown = 0, black = 0;
        const lum = [];
        for (let i = 0; i < px.length; i += 4) {
          cr += px[i]; cg += px[i + 1]; cb += px[i + 2];
          const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
          lum.push(l);
          /* Clipped, not "bright". A channel at 254 or 255 has lost its
           * gradient; that is the number that decides whether putting the sun
           * in frame has cost the picture anything. */
          if (px[i] >= 254 && px[i + 1] >= 254 && px[i + 2] >= 254) blown++;
          if (l < 5) black++;
        }
        lum.sort((a, b) => a - b);
        const n = px.length / 4;
        const q4 = (p) => lum[Math.min(lum.length - 1, Math.floor(p * lum.length))];
        s.setPaused(false);
        return {
          radiance: { mean: whole.mean, ...whole.lum, n: whole.n, rect: whole.rect },
          tiles,
          display: {
            mean: [cr / n, cg / n, cb / n],
            p10: q4(0.1), median: q4(0.5), p90: q4(0.9), p99: q4(0.99),
            blownPct: (100 * blown) / n, blackPct: (100 * black) / n, blown,
          },
        };
      }, [q.probe, q.ei]);
      rows.push({ ...q, ...m });
    }

    const base = rows[0];
    const lum = (m) => 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];
    console.log(`\n── ${v.name}  t=${v.t} yaw=${(v.yaw * 180 / Math.PI).toFixed(0)}° ` +
      `pitch=${(v.pitch * 180 / Math.PI).toFixed(0)}°   ${base.radiance.rect.join('x')} px read`);
    console.log('   variant                              radiance R,G,B          '
      + 'lum x   med8  p10  p90  blown%  B/R');
    for (const r of rows) {
      const ratio = lum(r.radiance.mean) / Math.max(1e-9, lum(base.radiance.mean));
      const br = r.radiance.mean[2] / Math.max(1e-9, r.radiance.mean[0]);
      const inert = r !== base && ratio === 1;
      console.log(
        `   ${r.key} ${r.label.padEnd(34)} `
        + `${r.radiance.mean.map((x) => x.toFixed(4).padStart(7)).join(' ')}  `
        + `${ratio.toFixed(4).padStart(6)}  `
        + `${r.display.median.toFixed(0).padStart(4)} ${r.display.p10.toFixed(0).padStart(4)} `
        + `${r.display.p90.toFixed(0).padStart(4)}  ${r.display.blownPct.toFixed(3).padStart(6)}  `
        + `${br.toFixed(3)}${inert ? '   ← INERT: bit-identical to A' : ''}`);
    }

    /* The tiles, as ratios against the same tile of A, because the whole-frame
     * mean is dominated by whichever part of the frame is brightest and that
     * is exactly the part the sky does not light. */
    const d = rows[3];
    console.log('   D/A by tile (row 2 = sky, row 0 = road):');
    for (let r = 2; r >= 0; r--) {
      const cells = [];
      for (let c = 0; c < 4; c++) {
        const i = r * 4 + c;
        cells.push((lum(d.tiles[i].mean) / Math.max(1e-9, lum(base.tiles[i].mean)))
          .toFixed(3).padStart(7));
      }
      console.log(`     row ${r}: ${cells.join(' ')}`);
    }

    report.views[v.name] = { view: v, rows };

    if (SHOT) {
      for (const q of [VARIANTS[0], VARIANTS[3]]) {
        await capture(page, path.join(OUT, `${v.name}-${q.key}.png`), {
          before: `s.scene.environment = window.__env['${q.probe}'];`
            + ` s.scene.environmentIntensity = ${q.ei};`,
        });
      }
    }
  }

  /* Leave the scene as the build has it, so nothing downstream in this session
   * inherits a probe this tool chose. */
  await page.evaluate(() => {
    const s = window.__scene;
    s.scene.environment = window.__env.clouds;
  });

  const errs = await readShaderErrors();
  console.log(errs.length ? `\n  SHADER ERRORS: ${errs.length}` : '\n  shader errors: none');
  for (const e of errs) console.log(`    ${String(e).slice(0, 200)}`);

  const perf = await page.evaluate(async () => {
    const s = window.__scene;
    s.setPaused(false);
    await new Promise((r) => setTimeout(r, 2500));
    return { fps: +s.fps.toFixed(1), ...s.info() };
  });
  report.perf = perf;
  console.log(`  steady: ${perf.fps} fps  calls=${perf.calls} tris=${(perf.triangles / 1000).toFixed(0)}k`);

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`  → ${path.relative(ROOT, OUT)}`);
});

finish(process.exitCode || 0);
