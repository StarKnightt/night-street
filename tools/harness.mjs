/* Headless capture plumbing.
 *
 * Adapted from jungle-trail/tools/harness.mjs, with two differences that
 * matter. There is no static file server here: Next's dev server is the only
 * thing that can build the page, so the harness attaches to an already-running
 * one rather than starting anything. And it will not start a second browser
 * or a second server under any circumstances — the machine this runs on is
 * usually being used for something else at the time.
 *
 * Two backends:
 *
 *   gpu (default)  headless Chromium on the real adapter through ANGLE/D3D11.
 *                  A frame costs the GPU a millisecond and the CPU almost
 *                  nothing.
 *   cpu (--cpu)    SwiftShader. Correct everywhere, but it is a software
 *                  rasteriser and it will take every thread it can reach.
 *                  Only for when the GPU path cannot initialise.
 *
 * Node and every Chromium child are pinned to a subset of cores at low
 * priority, and teardown is installed before anything starts.
 */
import { chromium } from 'playwright';
import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

export const DEV_URL = process.env.STREET_URL || 'http://127.0.0.1:3000';

const AFFINITY = '0xF00';   // top four of twelve logical cores
const ps = (c) => exec('powershell -NoProfile -Command "' + c + '"', () => {});

ps(`$p=Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue; ` +
   `if($p){ $p.PriorityClass='BelowNormal'; $p.ProcessorAffinity=${AFFINITY} }`);

const tameChildren = () => ps(
  'Get-Process chrome-headless-shell,headless_shell -ErrorAction SilentlyContinue | ForEach-Object ' +
  `{ try { $_.PriorityClass = 'Idle'; $_.ProcessorAffinity = ${AFFINITY} } catch {} }`);
setTimeout(tameChildren, 1500).unref();
const tamer = setInterval(tameChildren, 4000);
tamer.unref();

/* Guaranteed teardown. A headless browser left behind is the worst outcome
 * here, so this is not optional politeness. */
const closeables = [];
let closing = false;
async function teardown(code, why) {
  if (closing) return;
  closing = true;
  if (why) console.error('\n[teardown] ' + why);
  for (const t of closeables) { try { await t.close(); } catch { /* going down anyway */ } }
  clearInterval(tamer);
  process.exit(code);
}
export const finish = (code = 0) => teardown(code);
process.on('SIGINT', () => teardown(130, 'interrupted'));
process.on('SIGTERM', () => teardown(143, 'terminated'));
process.on('uncaughtException', (e) => teardown(1, (e && e.stack) || e));
process.on('unhandledRejection', (e) => teardown(1, (e && e.stack) || e));

const COMMON = [
  '--autoplay-policy=no-user-gesture-required',
  '--disable-dev-shm-usage',
  '--disable-features=CalculateNativeWinOcclusion,site-per-process',
  '--disable-background-timer-throttling',
  '--renderer-process-limit=1',
];

// Headless Chromium defaults to SwiftShader even with a GPU present; each of
// these is needed to get it onto the real adapter.
const GPU_ARGS = [...COMMON, '--use-angle=d3d11', '--enable-gpu-rasterization',
  '--ignore-gpu-blocklist', '--enable-zero-copy'];
const CPU_ARGS = [...COMMON, '--use-gl=angle', '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl',
  '--disable-lcd-text', '--js-flags=--single-threaded-gc'];

/** Is the dev server already up? The harness never starts one. */
export function reachable(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/**
 * Capture one frame deterministically.
 *
 * `page.screenshot()` waits for the compositor and races the render loop for
 * the GL context. Pausing the loop, rendering once and reading the canvas back
 * is both faster and reproducible — and it has to happen inside a single
 * evaluate, because the drawing buffer is not preserved and is gone by the
 * next task.
 */
export async function capture(page, file) {
  const url = await page.evaluate(() => {
    const s = window.__scene;
    s.setPaused(true);
    s.renderOnce();
    const data = s.renderer.domElement.toDataURL('image/png');
    s.setPaused(false);
    return data;
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
  return file;
}

/**
 * Boot exactly one browser against the running dev server, run `body`, and
 * guarantee teardown.
 *
 * @param {{width?:number,height?:number,cpu?:boolean,timeout?:number,url?:string}} opts
 * @param {(ctx:{page:any,url:string,errs:string[],gl:object,
 *            readShaderErrors:() => Promise<object[]>}) => Promise<void>} body
 * @returns {Promise<{errs:string[],gl:object,shaderErrors:object[]}>}
 */
export async function run(opts, body) {
  const {
    width = 1600, height = 900,
    cpu = process.argv.includes('--cpu'),
    timeout = 180_000,
    url = DEV_URL,
  } = opts || {};

  /* A hard ceiling on the whole run.
   *
   * This harness once sat for forty-three minutes and produced nothing. Every
   * individual await in here has a timeout, so the hang was not in any one of
   * them — it was the run as a whole failing to terminate, which no per-call
   * timeout can catch. A watchdog is the only thing that does.
   *
   * It is unref'd so it never keeps a healthy run alive, and it exits hard
   * rather than throwing, because by definition we are already in a state
   * where something is not returning and a rejected promise might not be
   * observed either. Seven more systems get built against this harness; it
   * needs to fail loudly in minutes, not silently in hours. */
  const HARD_CAP = Number(process.env.SHOOT_CAP_MS || 300_000);
  const watchdog = setTimeout(() => {
    console.error(`
✗ WATCHDOG: capture exceeded ${(HARD_CAP / 1000) | 0}s and was killed.`);
    console.error('  Nothing below this line ran. Likely causes, in order:');
    console.error('   - dev server wedged mid-compile (check it is still printing to its terminal)');
    console.error('   - a shader compile loop, so the page never reaches a steady frame rate');
    console.error('   - a headless Chromium left over from an earlier run holding the GPU');
    console.error('  Raise the ceiling with SHOOT_CAP_MS if a run is legitimately this long.');
    process.exit(2);
  }, HARD_CAP);
  watchdog.unref();

  if (!(await reachable(url))) {
      clearTimeout(watchdog);
    console.error(`✗ nothing is serving ${url}.`);
    console.error('  Start the dev server first, in its own terminal:  npm run dev');
    console.error('  (One dev server, port 3000. The harness will not start a second one.)');
    process.exitCode = 1;
    return { errs: ['dev server not reachable'], gl: null, shaderErrors: [] };
  }

  const browser = await chromium.launch({ headless: true, args: cpu ? CPU_ARGS : GPU_ARGS });
  closeables.push(browser);

  const errs = [];
  let code = 0, gl = null, shaderErrors = [];
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    // No page operation may block indefinitely, whatever the caller asked for.
    page.setDefaultTimeout(Math.min(timeout, 90_000));
    page.setDefaultNavigationTimeout(Math.min(timeout, 90_000));
    page.on('pageerror', (e) => errs.push('[pageerror] ' + (e.stack || e.message || e)));
    page.on('console', (m) => {
      const t = m.type();
      if (t === 'error') errs.push('[console] ' + m.text());
      else if (t === 'warning' && /React|Warning|three/i.test(m.text())) errs.push('[warn] ' + m.text());
    });
    page.on('requestfailed', (r) => errs.push('[netfail] ' + r.url().slice(0, 140)));
    page.on('crash', () => errs.push('[crash] renderer process died'));

    console.log(`→ ${url}  ${width}x${height}  backend=${cpu ? 'swiftshader' : 'gpu'}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

    /* A module that throws on load never defines __scene, so a plain wait
     * burns the whole timeout to report an error the page already knew about.
     * Race the wait against the error list instead — the throw usually
     * happened during goto(), before any fresh listener could have caught it. */
    // Short, because the only slow part of boot is the first Turbopack
    // compile and that is already done by the time anyone runs this twice.
    const boot = 60_000;
    await Promise.race([
      page.waitForFunction(() => !!window.__scene, null, { timeout: boot }),
      (async () => {
        for (let i = 0; i < boot / 250; i++) {
          await new Promise((r) => setTimeout(r, 250));
          const fatal = errs.find((e) => e.startsWith('[pageerror]') || e.startsWith('[crash]'));
          if (fatal) throw new Error('page threw during boot: ' + fatal.slice(0, 400));
        }
      })(),
    ]);

    gl = await page.evaluate(() => {
      const c = document.createElement('canvas');
      const g = c.getContext('webgl2');
      const dbg = g && g.getExtension('WEBGL_debug_renderer_info');
      return {
        renderer: dbg ? g.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown',
        vendor: dbg ? g.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : 'unknown',
      };
    });
    const soft = /swiftshader|software|llvmpipe/i.test(gl.renderer);
    console.log(`   adapter: ${gl.renderer}${soft ? '  (SOFTWARE — CPU bound)' : ''}`);

    // Let the first-frame shader compiles and the texture bakes finish before
    // anything is measured.
    await page.waitForTimeout(1200);
    /* Handed to the body so a tool that writes a report of its own can put the
     * ledger in it. The authoritative read is the one below, after the body. */
    const readShaderErrors = () => page.evaluate(() => window.__shaderErrors || []);
    await body({ page, url, errs, gl, readShaderErrors });

    /* Read the shader-error ledger last, so it covers every program linked by
     * every viewpoint the body visited. Three checks a program lazily on its
     * first draw, so a material that only appears at one stop of the walk does
     * not report until that stop has actually been rendered. */
    shaderErrors = await page.evaluate(() => window.__shaderErrors || []);
  } catch (err) {
    console.error('\n✗ capture failed:', (err && err.message) || err);
    code = 1;
  } finally {
    await browser.close().catch(() => {});
  }

  if (errs.length) {
    console.log('\n─── page errors ───');
    [...new Set(errs)].slice(0, 15).forEach((e) => console.log(' ', e));
  }

  /* A failed GLSL link is a hard failure of the run.
   *
   * This is deliberately not folded into the console-error list. A program
   * that fails to link renders as a flat untextured fallback and reads as a
   * lighting bug, and the round check has historically been "zero console
   * errors" — which a link failure can pass, because three reports it lazily
   * from the first draw that uses the program and only if nothing has taken
   * over its reporting hook. That is exactly how a dead pavement program
   * survived two review rounds. So it gets its own banner and its own
   * non-zero exit, and no caller has to remember to look. */
  if (shaderErrors.length) {
    code = 1;
    console.error('\n' + '═'.repeat(72));
    console.error(`✗✗✗  ${shaderErrors.length} SHADER PROGRAM(S) FAILED TO LINK`);
    console.error('     Affected surfaces are drawing an untextured fallback.');
    console.error('     Do NOT review this build; the pixels are not the build.');
    console.error('═'.repeat(72));
    for (const e of shaderErrors) {
      console.error(`\n  ── program: ${e.program}`);
      if (e.programLog) console.error(`     link: ${e.programLog}`);
      for (const [stage, text] of [['vertex', e.vertex], ['fragment', e.fragment]]) {
        if (!text) continue;
        console.error(`     ${stage}:`);
        for (const line of String(text).split('\n')) console.error('       ' + line);
      }
    }
    console.error('\n' + '═'.repeat(72) + '\n');
  } else {
    console.log('  shader programs: all linked');
  }

  /* Never clear a failure the body already recorded. `process.exitCode = code`
   * used to overwrite it, so a run whose captures did not reach disk said so
   * on stdout and then exited zero. */
  process.exitCode = code || process.exitCode || 0;
  return { errs: [...new Set(errs)], gl, shaderErrors };
}
