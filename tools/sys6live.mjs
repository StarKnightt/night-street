/* System 6: prove the atmosphere path is live, then measure what each term costs.
 *
 * This exists because "the shader is written and typechecks" has twice now been
 * mistaken for "the shader runs". The register of this project's expensive bugs
 * is mostly silently-inert code: uniforms written after three had already built
 * them, an envMapIntensity nothing reads, a pow(0, 0.6) that zeroed a light
 * path, a directional lobe multiplied by a sun vector that was never assigned.
 * None of those produce an error, a warning or a black frame. The only thing
 * that catches them is a differenced pair.
 *
 * So this tool does two things and reports them separately:
 *
 *   1. SOURCE.  Reads the actual GLSL back out of the linked program with
 *      getAttachedShaders + getShaderSource. Not the string this project
 *      *intended* to install — the text the driver compiled. A marker that is
 *      absent here is absent, whatever the TypeScript says.
 *
 *   2. DELTA.   Renders the same frozen viewpoint with one term switched via
 *      ?haze=..., and differences fixed regions. Each switch substitutes a
 *      constant into identical GLSL, so the program is structurally the same
 *      either way and a difference cannot be an artefact of a recompile.
 *
 * The sky region is the control. scene.background is drawn by the background
 * pass and never enters a fogged material, so every configuration below must
 * return the same sky to within the noise floor. If the sky moves, the harness
 * is measuring something other than the haze and nothing else in the table can
 * be believed.
 *
 *   node tools/sys6live.mjs [--stops sun,away,down] [--out shots/sys6live]
 *
 * Requires a dev server on 3000. Take .capture.lock before running it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, finish } from './harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};

/* Sun bears +X and -Z at 4.2 degrees. walker.ts's view direction is
 * (-sin yaw, 0, -cos yaw), so the sunward heading is negative. */
const YAW_SUN = -0.6104;
const YAW_AWAY = YAW_SUN + Math.PI;

/* The walk line is x = -0.85 and z(t) = 4.0 - 98t, so every t below is a
 * position solved from tools/sys6.ts's census rather than chosen by eye. That
 * census also reports how many metres of lit air each centre ray crosses, which
 * is the only way to pick a stop that can actually falsify the wedge: three of
 * its five suggested framings cross zero metres of it. */
const STOPS = {
  // z = -28, straight into the sun. Forward lobe at its maximum.
  sun:    { t: 0.3265, yaw: YAW_SUN,  pitch: 0.073, fov: 40 },
  // z = -54.8, the anti-sun veil, which the old one-sided lobe left at exactly
  // the base density and which the HG backscatter term exists to supply.
  away:   { t: 0.6000, yaw: YAW_AWAY, pitch: 0.050, fov: 45 },
  // z = -20 looking down the street. The main wedge's near boundary crosses the
  // carriageway from (-3.15, -27.36) to (3.15, -36.36), i.e. 7 to 16 m ahead
  // and diagonally across the lower half of this frame.
  wedge:  { t: 0.2449, yaw: 0.0,      pitch: -0.05, fov: 55 },
  // z = +2.04 on a long lens: kerb, mid block, backdrop and closeout in one
  // frame, and 36.9 m of lit air on the centre ray. The aerial-perspective
  // ladder, and the frame the height falloff has the most to say about.
  ladder: { t: 0.0200, yaw: 0.0,      pitch: 0.000, fov: 30 },
  // Into the sun and tipped down, so the mote band (world y 0.9-1.6, i.e. below
  // eye height and inside the lit slab) fills the middle of the frame against
  // hazed road rather than against sky.
  motes:  { t: 0.3265, yaw: YAW_SUN,  pitch: -0.10, fov: 45 },
};

/* Fractions of the viewport. Chosen so that each one is dominated by geometry
 * at a known range, because the haze is a function of range and an average over
 * mixed ranges cannot be inverted into anything. */
const REGIONS = {
  sky:       [0.42, 0.04, 0.16, 0.10],   // CONTROL: never fogged
  farWall:   [0.44, 0.40, 0.12, 0.09],
  midWall:   [0.20, 0.36, 0.10, 0.14],
  highWall:  [0.20, 0.10, 0.10, 0.14],   // parapet height: the height-falloff probe
  farRoad:   [0.46, 0.53, 0.08, 0.03],
  midRoad:   [0.44, 0.66, 0.12, 0.05],
  nearRoad:  [0.40, 0.86, 0.20, 0.10],
  walkL:     [0.05, 0.72, 0.10, 0.06],
  walkR:     [0.85, 0.72, 0.10, 0.06],
  // Wide, because motes are sparse: a mean over this is a density measure and
  // the peak over it is a level measure, and dust needs both.
  moteBand:  [0.22, 0.50, 0.56, 0.22],
};

const CONFIGS = [
  ['full',     ''],
  ['full2',    ''],            // determinism control: must differ from full by ~0
  ['noheight', 'noheight'],
  ['nofloor',  'nofloor'],
  ['nophase',  'nophase'],
  ['nowedge',  'nowedge'],
  ['nodust',   'nodust'],      // the mote field only
  ['noshadow', 'noshadow'],    // motes present but not gated on the sun
  ['off',      'off'],         // stock three fog maths, haze and wedge removed
];

const wanted = arg('stops', 'sun,away,wedge,ladder,motes').split(',');
const outDir = path.join(ROOT, arg('out', 'shots/sys6live'));
fs.mkdirSync(outDir, { recursive: true });

const MARKERS = ['hazeSky', 'hazePhase', 'wedgeLength', 'heightFactor',
  'hazeOptical', 'linearToOutputTexel', 'uHazeSun'];

const table = {};       // config -> stop -> region -> [r,g,b] 0..255
const peaks = {};       // config -> stop -> region -> {p50,p99,p999,max}
const shaderErrs = {};  // config -> [{program, log}]
let sourceReport = null;

/* One browser, seven navigations, rather than seven browsers.
 *
 * The first version launched a Chromium per configuration, which cost about
 * seventy-five seconds each and — the part that actually broke it — tripped
 * harness.mjs's watchdog, because that timer is armed once per run() and
 * measures wall time from the first one. Seven runs share one 300 s budget and
 * the fourth was killed mid-flight. Navigating the same page is also the
 * stricter experiment: same browser, same GPU context, same compiled texture
 * bakes, so fewer things differ between the two halves of a pair. */
await run({ width: 1600, height: 900 }, async ({ page }) => {
 for (const [name, flags] of CONFIGS) {
  const url = 'http://127.0.0.1:3000/' + (flags ? `?haze=${flags}` : '');
  console.log(`\n─── ${name}  ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__scene, null, { timeout: 60_000 });
  await page.waitForTimeout(1500);

  {
    if (name === 'full') {
      sourceReport = await page.evaluate((MARKERS) => {
        const s = window.__scene;
        s.renderOnce();
        const ctx = s.renderer.getContext();
        const progs = s.renderer.info.programs || [];
        let fogPrograms = 0, withSky = 0, sample = null;
        const seen = {};
        for (const m of MARKERS) seen[m] = 0;
        for (const p of progs) {
          const glp = p.program;
          if (!glp) continue;
          let frag = '';
          for (const sh of ctx.getAttachedShaders(glp) || []) {
            const src = ctx.getShaderSource(sh) || '';
            if (src.includes('gl_FragColor') || src.includes('void main')) {
              if (src.includes('#define USE_FOG') || src.includes('USE_FOG')) frag = frag || src;
              if (src.includes('hazeSky')) frag = src;
            }
          }
          if (!frag) continue;
          if (frag.includes('USE_FOG')) fogPrograms++;
          if (frag.includes('hazeSky')) { withSky++; if (!sample) sample = frag; }
          for (const m of MARKERS) if (frag.includes(m)) seen[m]++;
        }
        // The literal the sun direction was baked as: if this is a zero vector
        // the whole directional effect is inert, which is the exact bug this
        // file's own header describes having shipped once already.
        let sunLiteral = null, wedgeLiteral = null, phaseGain = null;
        if (sample) {
          const m1 = sample.match(/const vec3 uHazeSun = (vec3\([^)]*\))/);
          const m2 = sample.match(/const vec4 uWedgeD = (vec4\([^)]*\))/);
          const m3 = sample.match(/return 1\.0 \+ ([0-9.]+) \* \( p - 0\.5901 \)/);
          sunLiteral = m1 && m1[1];
          wedgeLiteral = m2 && m2[1];
          phaseGain = m3 && m3[1];
        }
        return {
          totalPrograms: progs.length, fogPrograms, withSky, seen,
          sunLiteral, wedgeLiteral, phaseGain,
          fogOnScene: !!s.scene.fog,
          fogType: s.scene.fog ? s.scene.fog.constructor.name : null,
          fogDensity: s.scene.fog ? s.scene.fog.density : null,
        };
      }, MARKERS);
    }

    table[name] = {};
    for (const key of wanted) {
      const st = STOPS[key];
      if (!st) continue;
      const res = await page.evaluate(({ st, REGIONS }) => {
        const s = window.__scene;
        s.camera.fov = st.fov; s.camera.updateProjectionMatrix();
        s.goTo(st.t); s.setYaw(st.yaw); s.setPitch(st.pitch); s.warp(2.0);
        s.setPaused(true); s.renderOnce();

        const cv = s.renderer.domElement;
        const w = cv.width, h = cv.height;
        const off = document.createElement('canvas');
        off.width = w; off.height = h;
        const c2 = off.getContext('2d');
        c2.drawImage(cv, 0, 0);
        const out = {}, peak = {};
        for (const [n, [fx, fy, fw, fh]] of Object.entries(REGIONS)) {
          const d = c2.getImageData(Math.round(fx * w), Math.round(fy * h),
            Math.max(1, Math.round(fw * w)), Math.max(1, Math.round(fh * h))).data;
          let r = 0, g = 0, b = 0, n2 = 0;
          const L = [];
          for (let i = 0; i < d.length; i += 4) {
            r += d[i]; g += d[i + 1]; b += d[i + 2]; n2++;
            L.push(0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]);
          }
          out[n] = [+(r / n2).toFixed(2), +(g / n2).toFixed(2), +(b / n2).toFixed(2)];
          /* A mean cannot see a mote. 2200 sub-pixel points spread over a
           * 900-line frame occupy a fraction of a per cent of it, so switching
           * the whole field off moves a region mean by a tenth of a count while
           * moving individual pixels by forty. The upper percentiles are where
           * a sparse additive layer actually lives, and p99.9 over a region
           * this size is still a few hundred pixels, so it is a statistic and
           * not the single hottest sample. */
          L.sort((a, b2) => a - b2);
          const q = (p) => +L[Math.min(L.length - 1, Math.floor(p * L.length))].toFixed(2);
          peak[n] = { p50: q(0.5), p99: q(0.99), p999: q(0.999), max: +L[L.length - 1].toFixed(2) };
        }
        const png = cv.toDataURL('image/png');
        s.setPaused(false);
        return { out, peak, png, fps: +s.fps.toFixed(1), ...s.info() };
      }, { st, REGIONS });

      table[name][key] = res.out;
      peaks[name] = peaks[name] || {};
      peaks[name][key] = res.peak;
      fs.writeFileSync(path.join(outDir, `${key}-${name}.png`),
        Buffer.from(res.png.split(',')[1], 'base64'));
      console.log(`  ${key.padEnd(6)} calls=${res.calls} tris=${(res.triangles / 1000).toFixed(0)}k fps=${res.fps}`);
    }

    /* Per configuration, not once at the end.
     *
     * window.__shaderErrors is per page, so reading it after the last
     * navigation reports only the last configuration — which is how a link
     * failure belonging to the `off` control was first read as a failure of the
     * shipped path. Every config now carries its own verdict, and only `full`'s
     * is a statement about the build. */
    shaderErrs[name] = await page.evaluate(() => (window.__shaderErrors || [])
      .map((e) => ({ program: e.program, log: String(e.programLog || '').slice(0, 200) })));
    const n = shaderErrs[name].length;
    console.log(`  shaders: ${n ? `✗ ${n} FAILED TO LINK` : 'all linked'}`);
  }
 }
});

/* ── report ─────────────────────────────────────────────────────────────── */
console.log('\n' + '═'.repeat(74));
console.log('1. SOURCE — what the driver actually compiled');
console.log('═'.repeat(74));
if (!sourceReport) console.log('  (not collected)');
else {
  const s = sourceReport;
  console.log(`  scene.fog            ${s.fogOnScene ? `${s.fogType} density=${s.fogDensity}` : 'ABSENT — USE_FOG is not defined anywhere'}`);
  console.log(`  programs             ${s.totalPrograms} total, ${s.withSky} contain hazeSky`);
  for (const m of MARKERS) {
    const n = s.seen[m];
    console.log(`    ${(n ? 'present' : 'ABSENT ').padEnd(8)} ${m.padEnd(22)} in ${n} program(s)`);
  }
  console.log(`  uHazeSun  = ${s.sunLiteral}`);
  console.log(`  uWedgeD   = ${s.wedgeLiteral}`);
  console.log(`  phaseGain = ${s.phaseGain}`);
}

console.log('\n  shader link, per configuration');
for (const [cfg] of CONFIGS) {
  const e = shaderErrs[cfg];
  if (!e) continue;
  console.log(`    ${cfg.padEnd(10)} ${e.length ? `✗ ${e.length} FAILED: ` + e.map((x) => x.program).join(', ') : 'all linked'}`);
}

console.log('\n' + '═'.repeat(74));
console.log('2. DELTA — mean 8-bit luma change vs `full`, per region');
console.log('   sky is the control and must read ~0.0 everywhere.');
console.log('═'.repeat(74));
const luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
for (const key of wanted) {
  if (!table.full || !table.full[key]) continue;
  console.log(`\n  stop ${key}`);
  const names = Object.keys(REGIONS);
  console.log('    config      ' + names.map((n) => n.padStart(9)).join(''));
  for (const [cfg] of CONFIGS) {
    if (cfg === 'full' || !table[cfg] || !table[cfg][key]) continue;
    const row = names.map((n) => {
      const d = luma(table[cfg][key][n]) - luma(table.full[key][n]);
      return (d >= 0 ? '+' : '') + d.toFixed(1);
    });
    console.log(`    ${cfg.padEnd(10)}  ` + row.map((r) => r.padStart(9)).join(''));
  }
}

/* Dust is sparse and additive, so it is invisible to a region mean and obvious
 * in the upper tail. This block is the only place the mote field can be
 * falsified. */
console.log('\n' + '═'.repeat(74));
console.log('3. UPPER TAIL — p99 / p99.9 / max change vs `full`, moteBand region');
console.log('═'.repeat(74));
for (const key of wanted) {
  if (!peaks.full || !peaks.full[key]) continue;
  const base = peaks.full[key].moteBand;
  console.log(`\n  stop ${key}   full: p50=${base.p50} p99=${base.p99} p99.9=${base.p999} max=${base.max}`);
  for (const [cfg] of CONFIGS) {
    if (cfg === 'full' || !peaks[cfg] || !peaks[cfg][key]) continue;
    const p = peaks[cfg][key].moteBand;
    const d = (a, b) => { const x = a - b; return ((x >= 0 ? '+' : '') + x.toFixed(1)).padStart(8); };
    console.log(`    ${cfg.padEnd(10)} p50${d(p.p50, base.p50)}  p99${d(p.p99, base.p99)}` +
      `  p99.9${d(p.p999, base.p999)}  max${d(p.max, base.max)}`);
  }
}

fs.writeFileSync(path.join(outDir, 'sys6live.json'),
  JSON.stringify({ when: new Date().toISOString(), sourceReport, shaderErrs, regions: REGIONS, table, peaks }, null, 2));
console.log(`\n  → ${path.relative(ROOT, outDir)}/sys6live.json\n`);

finish(process.exitCode || 0);
