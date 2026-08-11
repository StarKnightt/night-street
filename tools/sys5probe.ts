/* Is System 5's analytic path alive, and what does it deliver where?
 *
 * Round one shipped emitters and no light, and the four failures could each
 * have been a wrong constant or a dead code path. Those need different fixes
 * and the difference is not visible in a frame, so this answers it on the CPU
 * before a single pixel is rendered:
 *
 *   1. every slot of the uniform arrays, as installed by the same functions the
 *      app calls, so a source registered at zero candela or at y = -1000 is
 *      visible as such;
 *   2. a JS transcription of artificial() evaluated at the exact world points
 *      the critic measured, so the predicted irradiance and the predicted
 *      8-bit step can be compared with what came off disk;
 *   3. the assembled fragment shader of each receiving material, with the
 *      position of the injected block reported against every later write to
 *      reflectedLight — which is the whole class of bug this project keeps
 *      losing rounds to: correct code, downstream of something that overwrites
 *      or zeroes it.
 *
 *   npx tsc -p tools/tsconfig.probe.json
 *   node -e "const M=require('module'),p=M._resolveFilename;\
 *     M._resolveFilename=function(r,...a){if(r.startsWith('@/'))\
 *     r=require('path').resolve('.sys5/src',r.slice(2));return p.call(this,r,...a)};\
 *     require('./.sys5/tools/sys5probe.js')"
 */
import * as THREE from 'three';

import { makeRoadMaterial, makeWalkMaterial, makeKerbMaterial } from '../src/scene/materials';
import {
  makeShopMaterial, makeShutterMaterial, makeAwningMaterial, makeFurnitureMaterial,
} from '../src/scene/streetMaterials';
import { makeWallMaterial } from '../src/scene/buildingMaterials';
import { buildNeon } from '../src/world/neon';
import { litUnits } from '../src/world/street3';
import { walkHeight } from '../src/world/geometry';
import { signAtlas, NEON } from '../src/scene/signs';
import {
  LAMP_STATE, LAMP_OUTREACH, NEON_RED, NEON_GREEN, NEON_OPEN,
  SIG_RED, SIG_AMBER, SIG_GREEN,
  installLamps, installNeon, installShopLights,
  artificialUniforms, lampHead, ART_PT, ART_AP,
} from '../src/scene/lights';

/* ── 1. Registration, exactly as Lighting.tsx does it ─────────────────────── */

const atlas = signAtlas();
const lit = litUnits();
const neon = buildNeon(
  lit,
  { open: atlas.neon0 + NEON.OPEN, bar: atlas.neon0 + NEON.BAR, beer: atlas.neon0 + NEON.BEER },
  {
    red: NEON_RED, open: NEON_OPEN, green: NEON_GREEN,
    sigRed: SIG_RED, sigAmber: SIG_AMBER, sigGreen: SIG_GREEN,
  },
);
installLamps();
installShopLights(lit.map((u) => u.light));
installNeon(neon.sources);

const U = artificialUniforms();
const P = U.uArtP.value as THREE.Vector4[];
const D = U.uArtD.value as THREE.Vector4[];
const C = U.uArtC.value as THREE.Vector3[];
const AC = U.uArtAC.value as THREE.Vector4[];
const AN = U.uArtAN.value as THREE.Vector4[];
const AL = U.uArtAL.value as THREE.Vector4[];

const f = (v: number, n = 3) => v.toFixed(n).padStart(n + 4);
const NAME = (i: number) => (i < 7 ? `lamp ${i}` : i < 11 ? `car  ${i - 7}` : `neon ${i - 11}`);

console.log('── point slots ─────────────────────────────────────────────');
for (let i = 0; i < ART_PT; i++) {
  console.log(`  ${NAME(i)}  P ${f(P[i].x)} ${f(P[i].y)} ${f(P[i].z)}  cd ${f(P[i].w, 4)}` +
    `  axis ${f(D[i].x)} ${f(D[i].y)} ${f(D[i].z)} n ${f(D[i].w, 2)}` +
    `  chroma ${f(C[i].x, 2)} ${f(C[i].y, 2)} ${f(C[i].z, 2)}`);
}
console.log('── aperture slots ──────────────────────────────────────────');
for (let a = 0; a < ART_AP; a++) {
  console.log(`  ap ${a}  C ${f(AC[a].x)} ${f(AC[a].y)} ${f(AC[a].z)} hw ${f(AC[a].w)}` +
    `  N ${f(AN[a].x)} ${f(AN[a].y)} ${f(AN[a].z)} hh ${f(AN[a].w)}` +
    `  L ${f(AL[a].x)} ${f(AL[a].y)} ${f(AL[a].z)} pitch ${f(AL[a].w, 2)}`);
}

/* ── 2. artificial(), transcribed ─────────────────────────────────────────── */

type V3 = [number, number, number];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a: V3): V3 => mul(a, 1 / Math.hypot(...a));

function artificial(p: V3, n: V3): { E: V3; from: string[] } {
  const E: V3 = [0, 0, 0];
  const from: string[] = [];
  for (let i = 0; i < ART_PT; i++) {
    const d = sub([P[i].x, P[i].y, P[i].z], p);
    const d2 = Math.max(dot(d, d), 0.04);
    if (P[i].w < 0.021 * d2) continue;
    const L = mul(d, 1 / Math.sqrt(d2));
    const ndl = Math.max(dot(n, L), 0);
    if (ndl <= 0) continue;
    const ax = Math.max(-dot(L, [D[i].x, D[i].y, D[i].z]), 0);
    const dis = D[i].w > 0 ? Math.pow(ax, D[i].w) : 1;
    const s = (P[i].w * dis * ndl) / d2;
    E[0] += C[i].x * s; E[1] += C[i].y * s; E[2] += C[i].z * s;
    if (s > 1e-4) from.push(`${NAME(i)} ${s.toFixed(4)}`);
  }
  for (let a = 0; a < ART_AP; a++) {
    const Cc: V3 = [AC[a].x, AC[a].y, AC[a].z];
    const nA: V3 = [AN[a].x, AN[a].y, AN[a].z];
    const toC = sub(Cc, p);
    if (dot(toC, toC) > 340) continue;
    if (dot(toC, nA) > 0) continue;
    const uA = norm([1 * nA[2] - 0 * nA[1], 0 * nA[0] - 0 * nA[2], 0 * nA[1] - 1 * nA[0]]);
    const hw = AC[a].w, hh = AN[a].w;
    const aSub = (2 * hw) * (2 * hh) / 6;
    let acc = 0;
    for (let j = 0; j < 6; j++) {
      const su = ((j - Math.floor(j / 3) * 3) - 1) * 0.6667;
      const sv = Math.floor(j / 3) - 0.5;
      const S: V3 = [Cc[0] + uA[0] * su * hw, Cc[1] + sv * hh, Cc[2] + uA[2] * su * hw];
      const d = sub(S, p);
      const d2 = Math.max(dot(d, d), 0.09);
      const L = mul(d, 1 / Math.sqrt(d2));
      const ndl = Math.max(dot(n, L), 0);
      const cs = Math.max(-dot(L, nA), 0);
      acc += (aSub * cs * ndl) / d2;
    }
    const mu = dot(sub(p, Cc), uA);
    const bands = Math.pow(0.5 + 0.5 * Math.cos((6.28318 * mu) / Math.max(AL[a].w, 0.3)), 8);
    const g = acc * (1 - 0.2 * bands);
    E[0] += AL[a].x * g; E[1] += AL[a].y * g; E[2] += AL[a].z * g;
    if (g > 1e-4) from.push(`ap ${a} ${(AL[a].x * g).toFixed(4)}`);
  }
  return { E, from };
}

/* Paving reflectance as it actually renders, and the level it is added to.
 *
 * Both of these were wrong in the first run of this probe, and wrong in a way
 * that cancelled. XFER was taken as 0.0782 / 8.42, from the critic's report;
 * 0.0782 is not a scene radiance, it is an sRGB-decoded display value — decode
 * code 84 and you get it back — so it understated the transfer by about four
 * times. SHADE was 0.0107 for the same reason: it is decode(26), where the
 * shaded carriageway at count 25 is actually L = 0.031.
 *
 * The two errors ran in opposite directions through a curve that was also
 * wrong, and the predicted step came out right anyway. That is worth knowing
 * about: agreement with an independently derived number is strong evidence that
 * the *machinery* is sound and no evidence at all that the inputs are.
 *
 * Both now come from tools/tonecheck.mjs, which reads the near carriageway in
 * 60.png and in 40.png — same material, same viewing geometry, one outside a
 * sun band and one inside it — and inverts through the real transform.
 *
 *   shaded carriageway   L = (0.038, 0.041, 0.092)   code (28, 30, 50)
 *   sunlit carriageway   L = (0.40,  0.23,  0.20 )   code (110, 88, 82)
 *
 * The sun's addition of 0.36 in red for 8.42 of horizontal irradiance is a
 * transfer of 0.043. That is an upper bound: it includes the sheen a damp road
 * returns toward the camera at a sun elevation of 4.2 degrees, and a lamp's
 * contribution here is diffuse only. The documented asphalt albedo near 0.10
 * gives 0.032, and the conservative one is used, so the steps below are the
 * pessimistic end of a 0.032–0.043 range — about a count and a half apart.
 *
 * SHADE is the shaded reading and it is the right base for judging a pool.
 * Override with the SHADE env var to see the sunlit case (0.43), which is what
 * lamp 3 actually stands on.
 */
const XFER = 0.0322;
const SHADE = Number(process.env.SHADE ?? 0.038);

/* The display response: three's AgX at exposure 0.296, the sensor pedestal and
 * the sRGB encode, tabulated at quarter-decade steps and interpolated log-log.
 *
 * tools/agx.mjs has the authority and this is a transcription of its output,
 * not a fit to measurements — the five-pair curve that used to stand here mixed
 * scene radiance with display-referred values in one table and is withdrawn.
 * Regenerate with:
 *
 *   node --input-type=module -e "import {display} from './tools/agx.mjs'; \
 *     for (let e=-3;e<=1.8;e+=0.25){const L=Math.pow(10,e); \
 *     console.log(L, display([L,L,L],{sensor:true})[1]);}"
 *
 * Accurate to well under a count against agx.mjs across the whole range. The
 * floor of 15 is real: the sensor pedestal alone encodes to it.
 */
const ANCHOR: [number, number][] = [
  [0.001, 15], [0.00562, 15], [0.01, 16], [0.01778, 19], [0.03162, 25],
  [0.05623, 36], [0.1, 52], [0.17783, 73], [0.31623, 97], [0.56234, 123],
  [1, 149], [1.77828, 174], [3.16228, 196], [5.62341, 215], [10, 229],
  [17.78279, 239], [31.62278, 245], [56.23413, 250],
];
function count(L: number): number {
  const x = Math.max(L, 1e-6);
  if (x <= ANCHOR[0][0]) return ANCHOR[0][1];
  for (let i = 1; i < ANCHOR.length; i++) {
    if (x <= ANCHOR[i][0] || i === ANCHOR.length - 1) {
      const [x0, y0] = ANCHOR[i - 1], [x1, y1] = ANCHOR[i];
      const s = Math.log(y1 / y0) / Math.log(x1 / x0);
      return Math.min(255, y0 * Math.pow(x / x0, s));
    }
  }
  return 255;
}

console.log('── predicted delivery ──────────────────────────────────────');
const UP: V3 = [0, 1, 0];
const shots: [string, V3, V3][] = [
  ['road under lamp 3 (warm, z-45)', [lampHead(3)[0], 0.02, -45], UP],
  ['road 2 m out from that',         [lampHead(3)[0] + 2, 0.02, -45], UP],
  ['road 10 m up-street of it',      [lampHead(3)[0], 0.02, -35], UP],
  ['road under lamp 4 (warming)',    [lampHead(4)[0], 0.02, -64], UP],
  ['road under lamp 0 (warm, z12)',  [lampHead(0)[0], 0.02, 12], UP],
];
for (const u of lit) {
  const l = u.light;
  const out: V3 = [l.dir[0], 0, l.dir[2]];
  const y = walkHeight(l.pos[0] + out[0] * 1.2, l.pos[2]) + 0.02;
  shots.push([`walk 1.2 m out from ${l.kind}`,
    [l.pos[0] + out[0] * 1.2, y, l.pos[2]], UP]);
  shots.push([`walk 3.0 m out from ${l.kind}`,
    [l.pos[0] + out[0] * 3.0, y, l.pos[2]], UP]);
  shots.push([`walk 6 m along from ${l.kind}`,
    [l.pos[0] + out[0] * 1.2, y, l.pos[2] + 6], UP]);
}
for (const s of neon.sources) {
  const back: V3 = [-s.dir[0], 0, -s.dir[2]];
  shots.push([`wall 0.4 m behind ${s.note}`,
    [s.pos[0] + back[0] * 0.4, s.pos[1], s.pos[2] + back[2] * 0.4],
    [s.dir[0], 0, s.dir[2]] as V3]);
}
for (const [what, p, n] of shots) {
  const { E, from } = artificial(p, n);
  const step = count(SHADE + E[0] * XFER) - count(SHADE);
  console.log(`  ${what.padEnd(34)} E ${f(E[0], 4)} ${f(E[1], 4)} ${f(E[2], 4)}` +
    `  = ${f((E[0] / 8.42) * 100, 2)}% sun   step ${step >= 0 ? '+' : ''}${step.toFixed(1)}` +
    (from.length ? `   [${from.join(', ')}]` : '   [nothing]'));
}

/* ── 3. Where the injected block lands in the assembled shader ────────────── */

function resolve(src: string): string {
  let out = src, guard = 0;
  while (/#include <\w+>/.test(out) && guard++ < 40) {
    out = out.replace(/#include <(\w+)>/g, (m, n) => (THREE.ShaderChunk as Record<string, string>)[n] ?? m);
  }
  return out;
}

function audit(label: string, mat: THREE.Material): void {
  const shader = {
    uniforms: {} as Record<string, { value: unknown }>,
    vertexShader: THREE.ShaderLib.physical.vertexShader,
    fragmentShader: THREE.ShaderLib.physical.fragmentShader,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (mat.onBeforeCompile as any)(shader, null);
  const frag = resolve(shader.fragmentShader);
  const lines = frag.split('\n');
  const decl = lines.findIndex((l) => /vec3 artificial\(/.test(l));
  const call = lines.findIndex((l) => /artificial\(vWPos/.test(l));
  const total = lines.findIndex((l) => /vec3 totalDiffuse\s*=/.test(l));
  const after: string[] = [];
  if (call >= 0) {
    for (let i = call + 1; i < (total < 0 ? lines.length : total); i++) {
      if (/reflectedLight\.(direct|indirect)Diffuse\s*(\*|\/|)=/.test(lines[i])) {
        after.push(`${i}: ${lines[i].trim()}`);
      }
    }
  }
  const un = ['uArtP', 'uArtD', 'uArtC', 'uArtAC', 'uArtAN', 'uArtAL']
    .filter((k) => !(k in shader.uniforms));
  console.log(`  ${label.padEnd(10)} decl ${decl} call ${call} totalDiffuse ${total}` +
    `  uniforms ${un.length ? 'MISSING ' + un.join(',') : 'all bound'}` +
    `  ${call < 0 ? 'NOT CALLED' : after.length ? 'CLOBBERED BY:' : 'clean downstream'}`);
  for (const a of after) console.log(`      ${a}`);
}

console.log('── shader audit ────────────────────────────────────────────');
const stub = (): { map: THREE.Texture; normalMap: THREE.Texture; ormMap: THREE.Texture;
                   patch: number; dispose(): void } => {
  const t = () => new THREE.Texture();
  return { map: t(), normalMap: t(), ormMap: t(), patch: 2, dispose() {} };
};
audit('road', makeRoadMaterial(stub()));
audit('walk', makeWalkMaterial(stub()));
audit('kerb', makeKerbMaterial(stub()));
audit('shop', makeShopMaterial());
audit('shutter', makeShutterMaterial());
audit('awning', makeAwningMaterial());
audit('furniture', makeFurnitureMaterial());
audit('wall', makeWallMaterial());
