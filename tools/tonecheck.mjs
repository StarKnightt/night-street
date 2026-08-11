/* What a radiance actually arrives at on disk. The reconciliation.
 *
 *   node tools/tonecheck.mjs                 the standing report
 *   node tools/tonecheck.mjs --tag sys5b     the same, against a later batch
 *
 * Three descriptions of this project's display response were in circulation and
 * no two agreed:
 *
 *   A  display = 0.284 * L^0.4545          streetMaterials.ts, NOTES.md, and
 *                                          every level authored before tonight
 *   B  tools/agx.mjs                       three's AgXToneMapping at exposure
 *                                          0.296 plus the sRGB encode, ported
 *                                          out of node_modules and inverted
 *                                          numerically. Says A is low by ~2x.
 *   C  five measured pairs off sys5a        says A is wrong at *both* ends,
 *                                          with a tenfold change of slope
 *
 * A and B are predictions. C is a measurement, so C wins any disagreement --
 * but only if C's pairs are pairs of the same two quantities, and this file
 * exists because two of them were not.
 *
 * The instrument is the sky. `scene.background` is a Float32 equirect written
 * straight out of `skyRadiance()` in env.ts with `backgroundIntensity = 1` and
 * `NoColorSpace`, so a sky pixel is the one place in the frame where the scene
 * radiance is known exactly, in closed form, with no albedo, no BRDF, no light
 * and no shadow in the path. Point a camera at it, predict the code value,
 * read the code value. Anything that does not match is in the display chain.
 *
 * Every camera below is read out of the shot's own report.json rather than
 * retyped from set24.sh, and the pixel coordinates are in the 1600x900 frame
 * as shot.
 */
import sharp from 'sharp';
import path from 'node:path';
import { display, hazeSky, SUN_DIR } from './agx.mjs';

const arg = (n, d) => {
  const i = process.argv.indexOf('--' + n);
  return i < 0 ? d : process.argv[i + 1];
};
const TAG = arg('tag', 'sys5a');
const BOX = Number(arg('box', 9));

/* ── the sky, with the disc this time ─────────────────────────────────────
 *
 * hazeSky() in agx.mjs mirrors skyRadiance() minus the solar disc, because the
 * disc belongs to the background copy and not to the light probe. The camera
 * sees the background copy, so the disc goes back in here. Term for term from
 * env.ts:173.
 */
function skyBg(dir) {
  const col = hazeSky(dir);
  const ang = Math.acos(Math.max(-1, Math.min(1,
    dir[0] * SUN_DIR[0] + dir[1] * SUN_DIR[1] + dir[2] * SUN_DIR[2])));
  const disc = Math.exp(-ang * 150.0) * 190.0;
  return [col[0] + disc, col[1] + disc * 0.80, col[2] + disc * 0.52];
}

/* ── the camera ───────────────────────────────────────────────────────────
 *
 * Rig.tsx builds the orientation as a YXZ euler of (pitch, yaw, 0), so the
 * forward axis is R_y(yaw) * R_x(pitch) * -Z and positive pitch looks up.
 * `fov` is three's vertical field of view. Getting this wrong shows up
 * immediately as a systematic error that grows toward the frame edge, which is
 * the check that it is right.
 */
function ray(cam, px, py, W, H) {
  const { yaw, pitch, fov } = cam;
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cy = Math.cos(yaw), sy = Math.sin(yaw);
  const fwd = [-cp * sy, sp, -cp * cy];
  const right = [cy, 0, -sy];
  const up = [sp * sy, cp, sp * cy];
  const tv = Math.tan((fov * Math.PI / 180) / 2);
  const x = ((px + 0.5) / W) * 2 - 1;
  const y = 1 - ((py + 0.5) / H) * 2;
  const d = [0, 1, 2].map((i) => fwd[i] + right[i] * x * tv * (W / H) + up[i] * y * tv);
  const l = Math.hypot(...d);
  return d.map((v) => v / l);
}

/* ── the frame ─────────────────────────────────────────────────────────── */

const cache = new Map();
async function frame(rel) {
  if (cache.has(rel)) return cache.get(rel);
  const file = path.join('shots', rel);
  const img = sharp(file);
  const { width, height } = await img.metadata();
  const raw = await img.raw().toBuffer();
  const chans = raw.length / (width * height);
  const v = { raw, width, height, chans };
  cache.set(rel, v);
  return v;
}

/** Per-channel median of a BOX x BOX square, which rejects the dither. */
function medianAt(f, px, py, box = BOX) {
  const h = (box - 1) / 2;
  const out = [];
  for (let c = 0; c < 3; c++) {
    const s = [];
    for (let dy = -h; dy <= h; dy++) {
      for (let dx = -h; dx <= h; dx++) {
        const x = Math.min(f.width - 1, Math.max(0, px + dx));
        const y = Math.min(f.height - 1, Math.max(0, py + dy));
        s.push(f.raw[(y * f.width + x) * f.chans + c]);
      }
    }
    s.sort((a, b) => a - b);
    out.push(s[(s.length - 1) >> 1]);
  }
  return out;
}

/** The spread across the box, as a warning that the sample straddles an edge. */
function spreadAt(f, px, py, box = BOX) {
  const h = (box - 1) / 2;
  let lo = 255, hi = 0;
  for (let dy = -h; dy <= h; dy++) {
    for (let dx = -h; dx <= h; dx++) {
      const x = Math.min(f.width - 1, Math.max(0, px + dx));
      const y = Math.min(f.height - 1, Math.max(0, py + dy));
      const l = f.raw[(y * f.width + x) * f.chans + 1];
      lo = Math.min(lo, l); hi = Math.max(hi, l);
    }
  }
  return hi - lo;
}

const cams = new Map();
async function cameraOf(stop) {
  if (!cams.has(stop)) {
    const r = JSON.parse(await (await import('node:fs/promises'))
      .readFile(path.join('shots', stop, 'report.json'), 'utf8'));
    cams.set(stop, r);
  }
  return cams.get(stop);
}

/* ── sky sample points ───────────────────────────────────────────────────
 *
 * Chosen by eye off the frames for one property only: nothing but sky within
 * the sample box, checked by the spread column below. They deliberately span
 * from the cool zenith to the warm horizon band, which is a factor of about
 * thirty in radiance and covers the whole range anything in this project is
 * authored in.
 */
const SKY = [
  ['-up', '72.png', 938, 156, 'high, off-sun side'],
  ['-up', '72.png', 1375, 94, 'high, cool corner'],
  ['-up', '72.png', 781, 469, 'mid sky'],
  ['-up', '72.png', 1250, 391, 'mid sky, right'],
  ['-up', '72.png', 938, 688, 'low sky, warming'],
  ['-up', '15.png', 700, 300, 'mid sky'],
  ['-lamp', 'head.png', 1180, 120, 'high right'],
  ['-lamp', 'head.png', 1480, 430, 'mid right'],
  ['-lamp', 'head.png', 1560, 700, 'low right, warm'],
];

/* ── emissives, whose radiance is authored and therefore known ───────────
 *
 * scene/lights.ts sets these by inverting curve A. What they arrive at is the
 * second, independent test of the display chain, and the one that is contested:
 * the three rows in NOTES.md come from here.
 */
const forDisplayA = (v8) => Math.pow(v8 / 255 / 0.284, 2.2);
const atDisplayA = (v8, chroma) => {
  const peak = Math.max(...chroma);
  const L = forDisplayA(v8) / peak;
  return chroma.map((c) => c * L);
};
const EMIT = [
  ['bowl, warm    (state 2)', 214, atDisplayA(214, [1.0, 0.47, 0.13])],
  ['bowl, warming as shipped', 132, atDisplayA(132, [1.0, 0.30, 0.36]).map((v) => v * 0.325)],
  ['bowl, warming as authored', 132, atDisplayA(132, [1.0, 0.30, 0.36])],
  ['neon, BAR letters      ', 225, atDisplayA(225, [1.0, 0.16, 0.06])],
  ['neon, pharmacy cross   ', 215, atDisplayA(215, [0.12, 1.0, 0.28])],
  ['neon, OPEN             ', 232, atDisplayA(232, [1.0, 0.19, 0.09])],
  ['signal, green aspect   ', 228, atDisplayA(228, [0.11, 1.0, 0.46])],
];

/* ── surfaces on the carriageway ─────────────────────────────────────────
 *
 * These are not curve anchors: the road's radiance is not known in closed form,
 * so nothing here tests the transform. They are the other half of the problem.
 * Inverting them gives the absolute scene radiance the analytic loop has to
 * work against, which is what decides whether a lantern at 5.5% of the sun is
 * worth eight counts on the road or one.
 *
 * The pixels are all in the bottom fifth of the frame, which at pitch 0 and a
 * 45 degree lens is carriageway three to five metres in front of the camera.
 * 60.png stands at z = -54.8 and 40.png at -35.2, and block.ts's sun bands run
 * -48.7..-31.9 and -83.7..-72.9, so the near road in 40.png is in the shaft and
 * the near road in 60.png is not. Same material, same viewing geometry, sun and
 * no sun.
 */
const ROAD = [
  ['60', 600, 800, 'shaded carriageway'],
  ['60', 820, 780, 'shaded carriageway'],
  ['60', 900, 830, 'shaded carriageway'],
  ['60', 700, 860, 'shaded carriageway'],
  ['40', 700, 860, 'sunlit carriageway'],
  ['40', 800, 800, 'sunlit carriageway'],
  ['40', 900, 760, 'sunlit carriageway'],
];

/* ── report ─────────────────────────────────────────────────────────────── */

const f = (n, w = 7, p = 3) => Number(n).toFixed(p).padStart(w);
const i3 = (n, w = 4) => String(n).padStart(w);
const enc = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const dec = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };

console.log(`\n${'='.repeat(78)}`);
console.log(`THE SKY, WHOSE RADIANCE IS KNOWN IN CLOSED FORM   (${TAG})`);
console.log('='.repeat(78));
console.log('                                 predicted            measured    err');
console.log('  stop / px            L (rgb)   raw AgX  +pedestal    on disk   G  pedestal');

let n = 0, sumRaw = 0, sumPed = 0;
for (const [stop, file, px, py, note] of SKY) {
  const rel = path.join(TAG + stop, file);
  let fr;
  try { fr = await frame(rel); } catch { console.log(`  ${rel}  MISSING`); continue; }
  const rep = await cameraOf(TAG + stop);
  const shot = rep.results.find((r) => r.file === file) ?? rep.results[0];
  const cam = { ...rep.camera, ...(shot.pitch !== undefined ? { pitch: shot.pitch } : {}) };
  const d = ray(cam, px, py, fr.width, fr.height);
  const L = skyBg(d);
  const pRaw = display(L);
  const pPed = display(L, { sensor: true });
  const m = medianAt(fr, px, py);
  const sp = spreadAt(fr, px, py);
  n++;
  sumRaw += Math.abs(m[1] - pRaw[1]);
  sumPed += Math.abs(m[1] - pPed[1]);
  console.log(`  ${(stop + '/' + file.replace('.png', '')).padEnd(13)}${i3(px)},${i3(py, 3)}`
    + ` ${L.map((v) => f(v, 6, 2)).join('')} `
    + ` ${pRaw.map((v) => i3(v)).join('')}  ${pPed.map((v) => i3(v)).join('')} `
    + ` ${m.map((v) => i3(v)).join('')}  ${i3(m[1] - pRaw[1], 4)} ${i3(m[1] - pPed[1], 4)}`
    + (sp > 12 ? `   [spread ${sp}, not clean sky]` : ''));
}
console.log(`\n  mean |error| in green over ${n} points:`
  + `   raw AgX ${(sumRaw / n).toFixed(1)} counts,   AgX + sensor pedestal ${(sumPed / n).toFixed(1)} counts`);

console.log(`\n${'='.repeat(78)}`);
console.log('THE THREE CANDIDATE CURVES, NEUTRAL GREY');
console.log('='.repeat(78));
console.log('        L      A: 0.284L^.4545   B: AgX raw   AgX+pedestal   B/A');
for (const L of [0.004, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 4, 8, 16, 40]) {
  const a = Math.round(0.284 * Math.pow(L, 0.4545) * 255);
  const b = display([L, L, L])[1];
  const c = display([L, L, L], { sensor: true })[1];
  console.log(`  ${f(L, 7, 3)}   ${i3(a, 12)}   ${i3(b, 10)}   ${i3(c, 12)}   ${f(b / Math.max(a, 1), 6, 2)}`);
}

console.log(`\n${'='.repeat(78)}`);
console.log('THE FIVE MEASURED PAIRS, RE-EXAMINED');
console.log('='.repeat(78));
console.log(`
  Two of the five were not radiance at all. The critic's report quotes the
  shaded carriageway as "0.0107" and the sun's addition to it as "0.0782",
  and those are display-referred: sRGB-decode the code value and you get them
  back. That makes them the same quantity as the pixel, measured one transfer
  function earlier -- not scene radiance, which is what the left-hand column
  of a response curve has to be.
`);
for (const c of [25, 26, 33, 84, 150]) {
  console.log(`    code ${i3(c, 3)}   sRGB-decode ${f(dec(c), 8, 4)}`
    + `    scene radiance by AgX+pedestal ${f(invPed(c), 8, 4)}`);
}
console.log(`
  0.0107 is decode(26) and 0.0889 is decode(84). Pairing either of them with a
  code value measures the sRGB encode and nothing else; pairing one of them
  with a code value and an authored emissive radiance with another, in the same
  table, fits a curve through two different input spaces. That is where the
  "tenfold change of slope" came from. It is an artefact of my table, not a
  property of the pipeline, and it is withdrawn.
`);

console.log(`${'='.repeat(78)}`);
console.log('SECOND VALIDATION: A LAMP BOWL, AT ELEVEN, IN COLOUR');
console.log('='.repeat(78));
console.log(`
  The bowl is the one emissive in the scene whose shading is simple enough to
  predict exactly. lightMaterials.ts:118 sets it to BOWL_WARM * mott * rim,
  where mott runs 0.78..1.22 about a mean of 1 and rim is 1 on a face pointing
  straight down, which is the face -lamp/head sees. So the underside of a
  working lantern is BOWL_WARM scaled by the mottle and nothing else, and its
  measured spread should bracket the prediction at mott = 1.
`);
{
  const fr = await frame(path.join(TAG + '-lamp', 'head.png')).catch(() => null);
  const W3 = atDisplayA(214, [1.0, 0.47, 0.13]);
  for (const mott of [0.78, 1.0, 1.22]) {
    const L = W3.map((v) => v * mott);
    console.log(`  mott ${mott.toFixed(2)}   L ${L.map((v) => f(v, 7, 2)).join('')}`
      + `   -> AgX+pedestal ${display(L, { sensor: true }).map((v) => i3(v)).join('')}`);
  }
  if (fr) {
    // The bowl is the brightest thing in this frame by a wide margin, so it can
    // be found rather than located by hand -- which keeps the sample honest
    // when the frame is re-shot at a different tag.
    let best = null;
    for (let by = 0; by < fr.height - 16; by += 8) {
      for (let bx = 0; bx < fr.width - 16; bx += 8) {
        let s = 0;
        for (let y = by; y < by + 16; y++) {
          for (let x = bx; x < bx + 16; x++) s += fr.raw[(y * fr.width + x) * fr.chans + 1];
        }
        if (!best || s > best.s) best = { s, bx, by };
      }
    }
    const px = best.bx + 8, py = best.by + 8;
    const lo = [], hi = [], md = medianAt(fr, px, py, 11);
    for (let c = 0; c < 3; c++) {
      const a = [];
      for (let y = py - 5; y <= py + 5; y++) {
        for (let x = px - 5; x <= px + 5; x++) a.push(fr.raw[(y * fr.width + x) * fr.chans + c]);
      }
      a.sort((p, q) => p - q); lo.push(a[0]); hi.push(a[a.length - 1]);
    }
    console.log(`\n  measured over 11px about the brightest block, (${px},${py}):`);
    console.log(`    min    ${lo.map((v) => i3(v)).join('')}`);
    console.log(`    median ${md.map((v) => i3(v)).join('')}`);
    console.log(`    max    ${hi.map((v) => i3(v)).join('')}`);
  }
}

console.log(`\n${'='.repeat(78)}`);
console.log('EVERY EMISSIVE THIS SYSTEM SHIPS, AGAINST WHAT IT WAS AUTHORED FOR');
console.log('='.repeat(78));
console.log('                             authored L          arrives at    target  err');
for (const [name, target, L] of EMIT) {
  const d = display(L, { sensor: true });
  const peak = d[L.indexOf(Math.max(...L))];
  console.log(`  ${name}  ${L.map((v) => f(v, 7, 2)).join('')}   `
    + `${d.map((v) => i3(v)).join('')}    ${i3(target, 3)}  ${i3(peak - target, 4)}`);
}
console.log(`
  Every one of these was authored by inverting curve A to a target display
  value in its peak channel, and every one of them lands high, because A
  understates the response by about a factor of two in the range they live in.
  The two warming rows are the same colour before and after the 0.325
  correction I applied last round from a measurement read against A: the
  correction was in the right direction and the wrong size, and it should be
  redone against the curve below rather than kept.
`);

console.log(`${'='.repeat(78)}`);
console.log('THE CARRIAGEWAY, AND WHAT A LANTERN IS ACTUALLY WORTH ON IT');
console.log('='.repeat(78));
console.log('  frame  px        measured        scene radiance (AgX+pedestal)   note');
const road = {};
for (const [file, px, py, note] of ROAD) {
  const fr = await frame(path.join(TAG, file + '.png')).catch(() => null);
  if (!fr) { console.log(`  ${file}  MISSING`); continue; }
  const m = medianAt(fr, px, py, 15);
  const L = m.map((v) => invPed(v));
  const sp = spreadAt(fr, px, py, 15);
  console.log(`  ${file.padEnd(6)} ${i3(px)},${i3(py, 3)}  ${m.map((v) => i3(v)).join('')}`
    + `    ${L.map((v) => f(v, 8, 4)).join('')}   ${note}`
    + (sp > 18 ? `  [spread ${sp}]` : ''));
  road[note] = L;
}
console.log(`
  The shaded carriageway is L = 0.038 in red and it is blue-dominant, which is
  correct and is worth pausing on: the shade in this scene is lit by a
  blue-violet sky and nothing else, so the road under the lanterns is the one
  large cool field in a warm frame. That is what a warm source has to read
  against, and it is why hue carries the lamps further than level does.

  The sun adds about 0.36 in red on top of it, warm, for 8.42 of horizontal
  irradiance. That is a transfer of 0.043 -- albedo/pi with an albedo of 0.13 --
  which is an upper bound on what a lamp gets, because a lamp's contribution is
  diffuse only (lights.ts) and the sun band on damp asphalt carries sheen as
  well. The documented asphalt albedo of about 0.10 gives 0.032 as the lower
  bound. tools/sys5probe.ts uses the lower one.
`);
console.log('  a 5.5%-of-sun addition -- lamp 3 at its pool centre -- by base level:');
console.log('    base L    base code    addition    after   step');
for (const [base, label] of [[0.038, ' shaded carriageway'], [0.10, ''],
  [0.20, ''], [0.43, ' sunlit carriageway'], [0.80, '']]) {
  for (const xfer of [0.0322, 0.043]) {
    const add = 0.4674 * xfer * 0.0555 / 0.0555;
    const b = display([base, base, base], { sensor: true })[1];
    const t = base + add;
    const d = display([t, t, t], { sensor: true })[1];
    console.log(`  ${f(base, 8, 4)}   ${i3(b, 8)}      ${f(add, 8, 4)}   ${i3(d, 6)}  ${i3(d - b, 5)}`
      + (xfer === 0.0322 ? `   xfer 0.032${label}` : '   xfer 0.043'));
  }
}
console.log(`
  Read down the step column. This is the whole reason agents on this project
  have authored in opposite directions: the same light is worth six or eight
  counts on the shaded road and one on the sunlit road, and neither reading is
  wrong. Two consequences for the capture:

    - The working-lantern pool stop has to stand where the carriageway is *in
      shade*. Lamp 3, at z -45, sits inside the -48.7..-31.9 sun band, which was
      chosen deliberately -- lights.ts:89 calls it "in the sun shaft, so it has
      daylight to lose against" -- and it is therefore the worst lantern in the
      street to prove a pool with. Lamp 0 at z +12 and lamp 5 at z -84 are the
      other two working ones, both outside a band.
    - "The pool is invisible" and "the pool is eight counts" can both be true of
      the same build. Any claim either way has to name the patch it was read
      from.
`);

console.log(`${'='.repeat(78)}`);
console.log('WHERE 0.284 CAME FROM, AND WHAT IT COST TWO EARLIER SYSTEMS');
console.log('='.repeat(78));
console.log(`
  streetMaterials.ts:790 records how curve A was calibrated: "feeding the pane
  a known constant of 1.6 returns display 90". Curve A fits that point exactly
  -- 0.284 * 1.6^0.4545 * 255 = ${Math.round(0.284 * Math.pow(1.6, 0.4545) * 255)}. The real transform does not:
`);
console.log(`    L = 1.6 through AgX + pedestal  ->  ${display([1.6, 1.6, 1.6], { sensor: true })[1]}`);
console.log(`    display 90 inverts to           ->  L = ${invPed(90).toFixed(4)}`);
console.log(`    implied attenuation in that path->  ${(invPed(90) / 1.6).toFixed(3)}`);
console.log(`
  A factor of about a sixth, in a measurement taken *through a sheet of glass*.
  That is a Fresnel reflectance, not a display response: the constant was fed to
  a reflection term, multiplied by the pane's reflectance on the way out, and
  the shortfall was then attributed to the tone curve. Curve A is the sRGB
  gamma with its scale fitted to one point measured through a 6x attenuator,
  which is why its exponent looks respectable and its constant does not.

  The two "fourfold errors" §1 of docs/TECHNIQUE.md warns about were corrections
  in the wrong direction. Both raised a constant from about 2.3 to about 8.5 by
  inverting a measured 191 through A. On the real curve:
`);
{
  const lit = [13.0, 7.6, 3.3];
  const old = lit.map((v) => v * (2.3 / 13.0));
  console.log(`    litWall as shipped        L ${lit.map((v) => f(v, 7, 2)).join('')}`
    + `  ->  ${display(lit, { sensor: true }).map((v) => i3(v)).join('')}`);
  console.log(`    litWall as it was before  L ${old.map((v) => f(v, 7, 2)).join('')}`
    + `  ->  ${display(old, { sensor: true }).map((v) => i3(v)).join('')}`);
  console.log(`    a sunlit fascia at code 191 is L = ${invPed(191).toFixed(2)} grey, not 8.44`);
}
console.log(`
  So the pre-correction value was close to right and the correction pushed it
  roughly four times too hot in radiance -- but only about twenty counts too
  bright on screen, because it landed on the shoulder. That is the same shoulder
  that hid the original error, working in the other direction, and it is why
  neither round could be settled by looking. Flagged here rather than fixed:
  those constants belong to Systems 2 and 3 and are not System 5's to move.
`);

console.log(`${'='.repeat(78)}`);
console.log('THE AUTHORING TABLE  (target display code -> scene radiance)');
console.log('='.repeat(78));
console.log('  code    grey L    code    grey L    code    grey L');
const codes = [8, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64, 80, 96, 112,
  128, 144, 160, 176, 192, 200, 208, 216, 224, 232, 240, 246];
for (let k = 0; k < codes.length; k += 3) {
  console.log('  ' + codes.slice(k, k + 3).map((c) => `${i3(c, 3)}  ${f(invPed(c), 8, 4)}`).join('    '));
}
console.log(`
  The zeros are real. sensor.ts adds a pedestal of 0.0040..0.0070 to every
  fragment the renderer produces, which on its own encodes to about 15, so
  nothing in this project can be darker than code 15 whatever radiance it has.
  Anything authored below about 0.008 arrives at the floor and is invisible --
  which is a useful thing to know before spending a shader branch on it.
`);

function invPed(code) {
  let lo = 1e-5, hi = 1e5;
  for (let k = 0; k < 90; k++) {
    const mid = Math.sqrt(lo * hi);
    if (display([mid, mid, mid], { sensor: true })[1] < code) lo = mid; else hi = mid;
  }
  return Math.sqrt(lo * hi);
}
