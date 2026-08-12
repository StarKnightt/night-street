/* Where the cold start goes, measured from outside the application.
 *
 * This tool exists in this shape for two reasons.
 *
 * The first is ownership. Almost every file that would have to carry an
 * in-app profiler is being rewritten by other passes right now, so an
 * instrument that lives in `src/` would be in the way and would rot within the
 * day. Everything below is installed by `addInitScript`, which runs before any
 * of the page's own script, so the application does not know it is being
 * measured and does not have to.
 *
 * The second is that the interesting cost turned out not to be where the app
 * could see it anyway. On Windows, Chrome runs WebGL through ANGLE, which
 * translates every GLSL program into HLSL and hands it to the D3D compiler in
 * the *GPU process*. That work does not appear in a JS profile, is not moved
 * by CPU throttling of the renderer process, and is only paid at the moment
 * something asks whether the program linked. Timing `linkProgram` alone
 * reports nothing; the bill lands at `getProgramParameter(LINK_STATUS)`.
 *
 * What is hooked, and why:
 *
 *   shaderSource/attachShader   so a program can be *named* — a bake program
 *                               contains the surface body it is baking, and
 *                               those bodies are read out of the real
 *                               `world/surfaces.ts` rather than a copy.
 *   compileShader, linkProgram  the calls that queue the work.
 *   getProgramParameter         the call that waits for it. This is the one
 *                               that carries the seconds.
 *   drawElements/drawArrays     with an optional `finish()` after each, which
 *                               is the only way to attribute GPU execution to
 *                               a draw. The bound framebuffer and viewport
 *                               identify a bake pass and its resolution.
 *   PerformanceObserver         long tasks, buffered, installed before the
 *                               first one can happen.
 *
 *   node tools/withlock.mjs cold -- node tools/coldstart.mjs
 *   node tools/withlock.mjs cold -- node tools/coldstart.mjs --sync
 *   node tools/withlock.mjs cold -- node tools/coldstart.mjs --url https://night-street.vercel.app
 *
 * `--sync` inserts the per-draw `finish()`. It makes the per-bake numbers
 * attributable and makes the total slightly pessimistic, because a driver that
 * would have overlapped two bakes is stopped from doing so. Run it both ways:
 * without `--sync` for the honest wall clock, with it for the breakdown.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const URL_ = arg('--url', process.env.STREET_URL || 'http://127.0.0.1:3000');
const SYNC = argv.includes('--sync');
const WAIT = Number(arg('--wait', 120_000));
const OUT = arg('--json', '');
const LABEL = arg('--label', SYNC ? 'sync' : 'wall');

/* Surface names, read out of the file that defines them.
 *
 * NOTES.md's opening section is about instruments that measured a copy of the
 * thing instead of the thing. A table of surface names typed out of
 * `surfaces.ts` would drift the first time somebody adds a surface, and the
 * report would then quietly attribute its cost to "unknown". Parsing the real
 * file costs nothing and cannot drift.
 */
function surfaceProbes() {
  const src = fs.readFileSync(path.join(ROOT, 'src/world/surfaces.ts'), 'utf8');
  const out = [];
  const re = /export const ([A-Z0-9_]+)\s*=\s*\/\* glsl \*\/\s*`([\s\S]*?)`;/g;
  let m;
  while ((m = re.exec(src))) {
    const [, name, body] = m;
    /* A probe has to be long enough to be unique and short enough to survive
     * the shader being assembled with other text around it. The first
     * substantial line of the body is both. */
    out.push({ name: name.toLowerCase(), body });
  }
  /* A probe has to appear in exactly one surface. The first cut of this took
   * the first substantial line of each body and every surface matched every
   * other, because they share their opening boilerplate — the report came back
   * naming every bake "asphalt". Requiring uniqueness against the other bodies
   * is the whole difference between a breakdown and a wrong breakdown. */
  const bodies = out.map((o) => o.body);
  out.forEach((s, i) => {
    const others = bodies.filter((_, j) => j !== i);
    s.probe = bodies[i].split('\n').map((x) => x.trim())
      .filter((x) => x.length > 20 && !x.startsWith('/*') && !x.startsWith('*') && !x.startsWith('//'))
      .find((x) => !others.some((o) => o.includes(x))) || null;
    delete s.body;
  });
  const named = out.filter((s) => s.probe);
  if (named.length !== out.length) {
    console.error(`  ! ${out.length - named.length} surface(s) have no unique probe and will be unnamed`);
  }
  return named;
}

const PROBES = surfaceProbes();

const INIT = `(() => {
  const R = (window.__cs = {
    t0: performance.now(),
    shaders: new WeakMap(),
    programs: new WeakMap(),
    nextProgram: 1,
    /* Total wall time spent inside each WebGL entry point, by name. This is
     * the instrument that actually located the cost: a phase that is
     * "GPU-bound" has to be inside *some* GL call, and there are only a
     * handful of candidates. */
    calls: {},
    linkWait: [],     // { id, ms, at, kind, name, chars }
    draws: [],        // { at, ms, w, h, fbo, kind, name, quad }
    long: [],
    frames: [],       // rAF timestamps
    firstSceneDraw: null,
    syncing: ${SYNC},
    px: new Uint8Array(4),
    dump: ${argv.includes('--dump')},
    parallelCompile: null,
    live: [],
  });

  /* The largest programs, kept so they can be written out and identified
   * against the files that build them. Naming a program from inside the page
   * would mean a table of markers copied out of the material files, which is
   * the copy-drifts-from-the-original trap; writing the source out and
   * grepping the real tree cannot drift. */
  R.dumpSources = () => R.live
    .map((rec) => ({ id: rec.id, chars: rec.sources.join('').length, src: rec.sources.join('\\n//----\\n') }))
    .sort((a, b) => b.chars - a.chars).slice(0, 8);

  /* The ablation.
   *
   * three's WebGLProgram.onFirstUse fetches the program and both shader info
   * logs *before* it looks at LINK_STATUS, and only when
   * renderer.debug.checkShaderErrors is true — which scene/shaderWatch.ts sets
   * unconditionally. Returning an empty log without calling through leaves
   * everything else about the load identical and answers the only question
   * that matters: is the time genuinely in producing those diagnostics, or
   * does it simply move to the next call that forces the compile?
   */
  const NO_INFO_LOG = ${argv.includes('--noinfolog')};

  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) R.long.push({ start: e.startTime, ms: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) { /* not supported; the table will say so */ }

  const rawRaf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => rawRaf((t) => { R.frames.push(t); return cb(t); });

  const PROBES = ${JSON.stringify(PROBES)};

  function bucket(name, ms) {
    const b = R.calls[name] || (R.calls[name] = { n: 0, ms: 0 });
    b.n += 1; b.ms += ms;
  }

  function nameOf(program) {
    const rec = program && R.programs.get(program);
    if (!rec) return { kind: 'unknown', name: 'unknown' };
    if (rec.named) return rec.named;
    const src = (rec.sources || []).join('\\n');
    let out;
    /* A bake program is identified structurally first — it is the only thing
     * in this application that declares \`void surf(\` — and only then named by
     * matching the surface bodies read out of world/surfaces.ts. Doing it the
     * other way round misfires, because the street materials inline some of
     * the same GLSL and will match a surface probe while being scene shaders.
     */
    if (/void surf\\s*\\(/.test(src)) {
      const hits = PROBES.filter((p) => src.includes(p.probe));
      out = { kind: 'bake', name: hits.length === 1 ? hits[0].name : (hits.length ? 'ambiguous:' + hits.map(h => h.name).join('/') : 'unnamed-surface') };
    } else if (/cubeUV|PMREM|CubemapFromEquirect|EquirectangularToCubeUV/i.test(src)) {
      out = { kind: 'pmrem', name: (src.match(/#define SHADER_NAME ([^\\s]+)/) || [, 'pmrem'])[1] };
    } else {
      const m = src.match(/#define SHADER_NAME ([^\\s]+)/);
      out = { kind: 'scene', name: (m ? m[1] : 'scene') + ':' + Math.round(src.length / 1000) + 'k' };
    }
    rec.named = out;
    return out;
  }

  function patch(proto) {
    if (!proto || proto.__csPatched) return;
    proto.__csPatched = true;

    /* GL state is shadowed in JS rather than queried.
     *
     * The first version of this tool called getParameter three times per draw
     * to learn the bound framebuffer, the viewport and the current program.
     * Every one of those is a synchronous round trip to the GPU process, and
     * on a page that issues tens of thousands of draws during load it added
     * about eighteen seconds to the very number it was measuring — a
     * measurement that changes its subject. Shadowing costs three assignments.
     */
    const rawBindFb = proto.bindFramebuffer;
    proto.bindFramebuffer = function (target, fb) { this.__fb = fb; return rawBindFb.call(this, target, fb); };
    const rawViewport = proto.viewport;
    proto.viewport = function (x, y, w, h) { this.__vw = w; this.__vh = h; return rawViewport.call(this, x, y, w, h); };
    const rawUse = proto.useProgram;
    proto.useProgram = function (p) { this.__prog = p; return rawUse.call(this, p); };

    const rawShaderSource = proto.shaderSource;
    proto.shaderSource = function (shader, source) {
      R.shaders.set(shader, source);
      return rawShaderSource.call(this, shader, source);
    };

    const rawAttach = proto.attachShader;
    proto.attachShader = function (program, shader) {
      let rec = R.programs.get(program);
      if (!rec) {
        rec = { id: R.nextProgram++, sources: [] };
        R.programs.set(program, rec);
        if (R.dump) R.live.push(rec);
      }
      const s = R.shaders.get(shader);
      if (s) rec.sources.push(s);
      return rawAttach.call(this, program, shader);
    };


    /* Everything that could plausibly hold seconds. If a phase is slow and is
     * not in this list, the time is in JavaScript and a CPU profile will show
     * it — which is exactly the discrimination this whole exercise needs. */
    const TIMED = ['compileShader', 'linkProgram', 'getShaderParameter', 'getShaderInfoLog',
      'getProgramInfoLog', 'getUniformLocation', 'getActiveUniform', 'getActiveAttrib',
      'getAttribLocation', 'texImage2D', 'texSubImage2D', 'texStorage2D', 'compressedTexImage2D',
      'generateMipmap', 'readPixels', 'finish', 'flush', 'bufferData', 'renderbufferStorage',
      'renderbufferStorageMultisample', 'blitFramebuffer', 'checkFramebufferStatus',
      'framebufferTexture2D', 'clear', 'getError'];
    for (const fn of TIMED) {
      const raw = proto[fn];
      if (!raw) continue;
      const skip = NO_INFO_LOG && (fn === 'getProgramInfoLog' || fn === 'getShaderInfoLog');
      proto[fn] = function (...a) {
        const t = performance.now();
        const out = skip ? '' : raw.apply(this, a);
        bucket(fn, performance.now() - t);
        return out;
      };
    }

    const rawGetProgram = proto.getProgramParameter;
    proto.getProgramParameter = function (program, pname) {
      const t = performance.now();
      const out = rawGetProgram.call(this, program, pname);
      const ms = performance.now() - t;
      bucket('getProgramParameter', ms);
      if (pname === this.LINK_STATUS) {
        const rec = R.programs.get(program);
        const n = nameOf(program);
        R.linkWait.push({ id: rec ? rec.id : 0, ms, at: t - R.t0, kind: n.kind, name: n.name,
                          chars: rec ? (rec.sources || []).join('').length : 0 });
      }
      return out;
    };

    for (const fn of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
      const raw = proto[fn];
      if (!raw) continue;
      proto[fn] = function (...a) {
        const n = nameOf(this.__prog);
        /* A bake pass is the only thing that draws the six indices of a 2x2
         * quad into a square off-screen target. That is a structural test and
         * does not depend on getting the shader naming right. */
        const quad = (fn === 'drawElements' && a[1] === 6);
        const isBake = !!this.__fb && quad && this.__vw === this.__vh && n.kind === 'bake';
        const t = performance.now();
        const out = raw.apply(this, a);
        /* Read one pixel back, and only off a bake target.
         *
         * finish() was tried first and reports nothing: over 3764 calls it
         * accumulated twelve milliseconds while the bakes it was supposed to
         * be waiting for demonstrably took seconds. Chrome forwards WebGL
         * commands to the GPU process and its finish does not reliably block
         * the caller. readPixels has to return a value, so it does.
         */
        if (R.syncing && isBake) this.readPixels(0, 0, 1, 1, this.RGBA, this.UNSIGNED_BYTE, R.px);
        const ms = performance.now() - t;
        bucket(fn, ms);
        R.draws.push({ at: t - R.t0, ms, w: this.__vw, h: this.__vh, fbo: !!this.__fb,
                       kind: isBake ? 'bake' : n.kind, name: n.name, quad });
        if (!this.__fb && R.firstSceneDraw === null) R.firstSceneDraw = t - R.t0;
        return out;
      };
    }
  }

  patch(window.WebGLRenderingContext && WebGLRenderingContext.prototype);
  patch(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype);

  /* Whether the driver can compile programs off the calling thread decides
   * whether three's compileAsync is worth anything here, so it is recorded off
   * the real context the page creates rather than a throwaway one. */
  const rawGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (...a) {
    const ctx = rawGetContext.apply(this, a);
    if (ctx && R.parallelCompile === null && typeof ctx.getExtension === 'function') {
      try { R.parallelCompile = !!ctx.getExtension('KHR_parallel_shader_compile'); } catch (e) { /* not a gl context */ }
    }
    return ctx;
  };
})();`;

const ms = (v) => `${v.toFixed(1).padStart(10)} ms`;

const browser = await chromium.launch({
  headless: true,
  args: ['--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
    '--disable-features=CalculateNativeWinOcclusion,site-per-process',
    '--disable-background-timer-throttling', '--renderer-process-limit=1',
    '--use-angle=d3d11', '--enable-gpu-rasterization', '--ignore-gpu-blocklist',
    '--enable-zero-copy'],
});

let rec;
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });

  await page.addInitScript(INIT);
  console.log(`→ ${URL_}   sync=${SYNC}`);
  const nav = Date.now();
  await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  rec = await page.evaluate(async (wait) => {
    const R = window.__cs;
    const t0 = performance.now();
    /* "Loaded" is the frame loop having settled, not the canvas existing. Six
     * consecutive default-framebuffer draws inside 120 ms of each other cannot
     * happen while a multi-second compile still holds the pipeline. */
    let quiet = 0, lastCount = 0, lastAt = performance.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 100));
      const n = R.frames.length;
      const now = performance.now();
      if (n > lastCount && now - lastAt < 400) quiet += 1; else quiet = 0;
      if (n > lastCount) { lastCount = n; lastAt = now; }
      if (quiet >= 12) break;
      if (performance.now() - t0 > wait) break;
    }
    // Stop the per-draw stall before measuring steady-state frame rate, or
    // the number reported is the instrument's and not the page's.
    R.syncing = false;
    const before = R.frames.length;
    const fpsT0 = performance.now();
    await new Promise((r) => setTimeout(r, 2000));
    const fps = (R.frames.length - before) / ((performance.now() - fpsT0) / 1000);

    return {
      t0: R.t0,
      calls: R.calls,
      linkWait: R.linkWait,
      draws: R.draws,
      long: R.long,
      firstSceneDraw: R.firstSceneDraw,
      fps,
      shaderErrors: (window.__shaderErrors || []).length,
      parallelCompile: R.parallelCompile,
      sources: R.dump ? R.dumpSources() : [],
    };
  }, WAIT);

  rec.navMs = Date.now() - nav;
  rec.errs = [...new Set(errs)];
} finally {
  await browser.close().catch(() => {});
}

const bake = rec.draws.filter((d) => d.fbo && d.kind === 'bake');
const bySurface = new Map();
for (const d of bake) {
  const key = `${d.name}@${d.w}`;
  const e = bySurface.get(key) || { name: d.name, size: d.w, passes: 0, ms: 0, first: d.at };
  e.passes += 1; e.ms += d.ms;
  bySurface.set(key, e);
}
const bakeTotal = bake.reduce((a, d) => a + d.ms, 0);

const byProgram = new Map();
for (const w of rec.linkWait) {
  const e = byProgram.get(w.name) || { name: w.name, kind: w.kind, n: 0, ms: 0, chars: w.chars };
  e.n += 1; e.ms += w.ms; e.chars = Math.max(e.chars, w.chars);
  byProgram.set(w.name, e);
}
const linkWaitTotal = rec.linkWait.reduce((a, w) => a + w.ms, 0);
const sceneWait = rec.linkWait.filter((w) => w.kind === 'scene').reduce((a, w) => a + w.ms, 0);
const bakeWait = rec.linkWait.filter((w) => w.kind === 'bake').reduce((a, w) => a + w.ms, 0);

console.log(`\n  url              ${URL_}`);
console.log(`  per-draw finish  ${SYNC ? 'on' : 'off'}`);
console.log(`  shader errors    ${rec.shaderErrors}`);
if (rec.errs.length) { console.log('  page errors:'); rec.errs.slice(0, 6).forEach((e) => console.log('    ' + e)); }

console.log('\n─── surface bakes ───');
console.log('  surface                size   passes        gpu ms      share');
for (const e of [...bySurface.values()].sort((a, b) => b.ms - a.ms)) {
  console.log(`  ${e.name.padEnd(22)} ${String(e.size).padStart(5)} ${String(e.passes).padStart(8)}` +
    ` ${e.ms.toFixed(1).padStart(13)} ${((e.ms / bakeTotal) * 100).toFixed(1).padStart(9)}%`);
}
console.log(`  ${'TOTAL'.padEnd(22)} ${''.padStart(5)} ${String(bake.length).padStart(8)} ${bakeTotal.toFixed(1).padStart(13)}`);

console.log('\n─── shader programs: wait at LINK_STATUS ───');
console.log('  kind    program                                    n         ms      chars');
for (const e of [...byProgram.values()].sort((a, b) => b.ms - a.ms).slice(0, 30)) {
  console.log(`  ${e.kind.padEnd(7)} ${e.name.slice(0, 40).padEnd(40)} ${String(e.n).padStart(3)}` +
    ` ${e.ms.toFixed(1).padStart(10)} ${String(e.chars).padStart(10)}`);
}
console.log(`\n  LINK_STATUS     ${ms(linkWaitTotal)}  over ${rec.linkWait.length} programs`);
console.log(`    of which scene materials  ${ms(sceneWait)}`);
console.log(`    of which bake programs    ${ms(bakeWait)}`);

console.log('\n─── time inside WebGL entry points ───');
const calls = Object.entries(rec.calls).sort((a, b) => b[1].ms - a[1].ms);
const glTotal = calls.reduce((a, [, v]) => a + v.ms, 0);
for (const [name, v] of calls) {
  if (v.ms < 1) continue;
  console.log(`  ${ms(v.ms)}  ${name.padEnd(30)} ${String(v.n).padStart(8)} calls`);
}
console.log(`  ${ms(glTotal)}  ${'TOTAL inside GL'.padEnd(30)}`);

const blocked = rec.long.reduce((a, t) => a + t.ms, 0);
console.log('\n─── main-thread long tasks ───');
if (!rec.long.length) console.log('  none recorded');
else {
  console.log(`  ${rec.long.length} tasks, ${(blocked / 1000).toFixed(2)} s blocked in total`);
  /* The long-task timeline and the GL timeline share `performance.now()`'s
   * origin, but `R.t0` is when the init script ran, so draw times are
   * relative to that. Both are converted to navigation-relative before they
   * are compared — getting this wrong is how a breakdown ends up attributing
   * a task to work that happened after it. */
  for (const t of [...rec.long].sort((a, b) => b.ms - a.ms).slice(0, 6)) {
    const a0 = t.start - rec.t0, a1 = a0 + t.ms;
    const within = (arr) => arr.filter((x) => x.at >= a0 && x.at < a1);
    const sum = (arr) => arr.reduce((a, x) => a + x.ms, 0);
    const bakeMs = sum(within(rec.draws).filter((d) => d.kind === 'bake'));
    const sceneMs = sum(within(rec.draws).filter((d) => d.kind !== 'bake'));
    const linkMs = sum(within(rec.linkWait));
    console.log(`  ${ms(t.ms)} at ${(t.start / 1000).toFixed(2)} s` +
      `   link ${linkMs.toFixed(0)} ms   bake ${bakeMs.toFixed(0)} ms   other draws ${sceneMs.toFixed(0)} ms` +
      `   unattributed ${(t.ms - linkMs - bakeMs - sceneMs).toFixed(0)} ms`);
  }
}

const firstScene = rec.draws.find((d) => !d.fbo && d.kind === 'scene');
console.log('\n─── headline ───');
console.log(`  first bake draw        ${(bake.length ? bake[0].at / 1000 : 0).toFixed(2)} s`);
console.log(`  first scene draw       ${firstScene ? (firstScene.at / 1000).toFixed(2) + ' s' : 'never'}`);
console.log(`  steady state           ${rec.fps.toFixed(1)} fps`);
console.log(`  longest task           ${rec.long.length ? Math.max(...rec.long.map((t) => t.ms)).toFixed(0) : 0} ms`);

console.log(`  KHR_parallel_shader_compile  ${rec.parallelCompile === null ? 'unknown' : rec.parallelCompile}`);

if (rec.sources && rec.sources.length) {
  const dir = path.join(ROOT, 'tmp/prof/shaders');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const s of rec.sources) fs.writeFileSync(path.join(dir, `p${s.id}-${s.chars}.glsl`), s.src);
  console.log(`  wrote ${rec.sources.length} largest shader sources to tmp/prof/shaders`);
}

if (OUT) {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({ url: URL_, label: LABEL, sync: SYNC, ...rec }, null, 2));
  console.log(`\n  wrote ${OUT}`);
}
