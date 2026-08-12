/* The linear-HDR hand-off, and the plumbing every post pass shares.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * §5.1 of the technique brief has asked for this since before System 8 was
 * written, and two of the three effects in this pass are impossible without
 * it. A raymarched volumetric needs the scene's *depth* to know where to stop
 * the march, and WebGL will not let you read the default framebuffer's depth
 * at all. Bloom needs the frame in *radiance*, because veiling glare added to
 * a signal that has already been compressed against white can only push pixels
 * past it — §6.9 in the brief, and jungle-trail's blown-out waterfall.
 *
 * So the scene renders into a half-float target with a depth texture attached,
 * the chain runs in scene-linear, and exactly one tone map happens at the end
 * of it. That is the physical order and it is jungle-trail's order.
 *
 * ── What moved, and what deliberately did not ─────────────────────────────
 *
 * Three's own behaviour does most of the work and it is worth writing down
 * where, because it is the difference between a five-line change and a rewrite:
 *
 *   `WebGLRenderer` sets `toneMapping = NoToneMapping` for any material drawn
 *   into a non-XR render target (three.module.js:18345-18354), and the output
 *   colour space becomes the working space, so `linearToOutputTexel` is the
 *   identity (18336). `haze.ts` is already written against both of those —
 *   its tone map is inside `#if defined( TONE_MAPPING )` and its encode is
 *   `linearToOutputTexel` — so the fog chunk becomes correct in linear with no
 *   edit at all. It stops double-tone-mapping the moment the target appears.
 *   That was checked in the source before this was built, not hoped for.
 *
 * What did have to move is `sensor.ts`'s pedestal. It is display-referred by
 * construction — a black point in the signal the sensor hands over — and it
 * was prepended to `colorspace_fragment`, which in a linear target would add
 * 0.004 of *radiance* to every fragment in the scene. `installSensorFloor`
 * now takes a flag and the pedestal is applied once, in the final pass, at the
 * point in the chain it was calibrated for.
 *
 * ── The escape hatch ──────────────────────────────────────────────────────
 *
 * `?nohdr` renders the old way: scene straight to the canvas, tone-mapped by
 * the renderer, graded off a framebuffer copy. Two agents are capturing
 * against this tree while this lands, and the archive was judged through that
 * path, so it stays reachable and is what the equivalence check below is run
 * against. It also means a bug in this file is one query string away from
 * being isolated rather than being a bisect.
 */
import * as THREE from 'three';

/** Dev-only switches, matching the `?haze=` convention already in the tree. */
export function pipeFlags(): Set<string> {
  if (typeof window === 'undefined') return new Set();
  const q = new URLSearchParams(window.location.search);
  const raw = q.get('post');
  const s = new Set(raw ? raw.split(',').map((x) => x.trim()).filter(Boolean) : []);
  // Long-hand aliases, because these get typed by hand a lot.
  for (const k of ['nohdr', 'novol', 'nobloom', 'volonly', 'bloomonly']) {
    if (q.has(k)) s.add(k);
  }
  return s;
}

/** True unless `?nohdr`. Read once; the pipeline cannot change shape midway. */
export const useHdr = (): boolean => !pipeFlags().has('nohdr');

/* One triangle, not two.
 *
 * Two would put a seam down the diagonal for anything reading derivatives and
 * costs a third more vertices for a pass that runs a dozen times a frame. */
export function fullscreenTriangle(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(
    new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
  return g;
}

export const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

/** A fullscreen pass: its own scene, its own camera, one triangle. */
export class Blit {
  readonly material: THREE.ShaderMaterial;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly mesh: THREE.Mesh;

  constructor(fragmentShader: string, uniforms: Record<string, THREE.IUniform>,
              defines: Record<string, string | number> = {}) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: FS_VERT,
      fragmentShader,
      uniforms,
      defines,
      depthTest: false,
      depthWrite: false,
      /* Nothing three injects belongs on a post quad. `toneMapped: false`
       * keeps the renderer from generating its own `toneMapping()` into the
       * program prefix — the final pass calls AgX by name and at a point in
       * the chain it chooses. */
      toneMapped: false,
    });
    this.mesh = new THREE.Mesh(fullscreenTriangle(), this.material);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }

  get uniforms() { return this.material.uniforms; }

  render(gl: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null) {
    gl.setRenderTarget(target);
    gl.render(this.scene, this.camera);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

/**
 * The scene target: half-float colour, 4x MSAA, and a depth texture.
 *
 * `samples: 4` is not a cost. Jungle-trail measured moving MSAA off the canvas
 * and onto the target as a free swap, and the canvas was already running
 * `antialias: true` — so this is the same multisampling in a different place,
 * except that it now resolves in *radiance* rather than in display code
 * values. That is a real difference at a clipping edge and it is the correct
 * direction: averaging four encoded samples of a sun-lit parapet against a
 * dark sky is a perceptual average of two numbers that are not lights.
 *
 * The depth texture is the whole reason the volumetric can exist.
 * `resolveDepthBuffer` makes three blit the multisampled depth into it; without
 * it the texture is allocated, bound, sampled and empty, which is this
 * project's signature failure and would have read as "the march is not
 * working" rather than as "the depth is zero".
 */
export function makeSceneTarget(w: number, h: number): THREE.WebGLRenderTarget {
  const depth = new THREE.DepthTexture(w, h);
  depth.type = THREE.UnsignedIntType;
  depth.format = THREE.DepthFormat;
  depth.minFilter = THREE.NearestFilter;
  depth.magFilter = THREE.NearestFilter;

  const rt = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.LinearSRGBColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: true,
    stencilBuffer: false,
    samples: 4,
    depthTexture: depth,
  });
  rt.texture.name = 'sceneHDR';
  (rt as unknown as { resolveDepthBuffer: boolean }).resolveDepthBuffer = true;
  return rt;
}

/** A plain half-float colour target, for the pyramid and the volume buffer. */
export function makeColourTarget(w: number, h: number, name: string): THREE.WebGLRenderTarget {
  const rt = new THREE.WebGLRenderTarget(Math.max(1, w), Math.max(1, h), {
    type: THREE.HalfFloatType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.LinearSRGBColorSpace,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: false,
    depthBuffer: false,
    stencilBuffer: false,
  });
  rt.texture.name = name;
  rt.texture.wrapS = THREE.ClampToEdgeWrapping;
  rt.texture.wrapT = THREE.ClampToEdgeWrapping;
  return rt;
}

/* ── shared GLSL ─────────────────────────────────────────────────────────── */

/**
 * AgX, ported term for term out of `tonemapping_pars_fragment` in
 * node_modules, with the exposure as an explicit uniform.
 *
 * Not `#include`d, and that is deliberate rather than lazy. Three emits its
 * own `toneMapping()` wrapper into the program *prefix* whenever the material
 * is tone-mapped and the target is the canvas, which is above anything this
 * file's body includes; and `sensor.ts` patches `colorspace_fragment`
 * globally, so pulling in three's chunks on a post quad is how the pedestal
 * gets applied twice. The post passes therefore include none of three's
 * chunks, exactly as `grade.tsx` already argued, and this is the one function
 * they need spelled out.
 *
 * `tools/agx.mjs` is the authority. This must agree with it to the last code
 * value; `node tools/agx.mjs` prints the table to check against.
 */
export const AGX_GLSL = /* glsl */ `
const mat3 AGX_2020 = mat3(
  vec3( 0.6274, 0.0691, 0.0164 ),
  vec3( 0.3293, 0.9195, 0.0880 ),
  vec3( 0.0433, 0.0113, 0.8956 ) );
const mat3 AGX_SRGB = mat3(
  vec3(  1.6605, -0.1246, -0.0182 ),
  vec3( -0.5876,  1.1329, -0.1006 ),
  vec3( -0.0728, -0.0083,  1.1187 ) );
const mat3 AGX_INSET = mat3(
  vec3( 0.856627153315983,  0.137318972929847,  0.11189821299995   ),
  vec3( 0.0951212405381588, 0.761241990602591,  0.0767994186031903 ),
  vec3( 0.0482516061458583, 0.101439036467562,  0.811302368396859  ) );
const mat3 AGX_OUTSET = mat3(
  vec3(  1.1271005818144368, -0.1413297634984383, -0.14132976349843826 ),
  vec3( -0.11060664309660323, 1.157823702216272,  -0.11060664309660294 ),
  vec3( -0.016493938717834573, -0.016493938717834257, 1.2519364065950405 ) );

vec3 agxContrast( vec3 x ) {
  vec3 x2 = x * x;
  vec3 x4 = x2 * x2;
  return + 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4
         - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

/** Linear scene radiance in, tone-mapped display-linear 0..1 out. */
vec3 agx( vec3 color, float exposure ) {
  const float minEv = -12.47393, maxEv = 4.026069;
  color *= exposure;
  color = AGX_2020 * color;
  color = AGX_INSET * color;
  color = max( color, 1e-10 );
  color = log2( color );
  color = ( color - minEv ) / ( maxEv - minEv );
  color = clamp( color, 0.0, 1.0 );
  color = agxContrast( color );
  color = AGX_OUTSET * color;
  color = pow( max( vec3( 0.0 ), color ), vec3( 2.2 ) );
  color = AGX_SRGB * color;
  return clamp( color, 0.0, 1.0 );
}
`;

export const SRGB_GLSL = /* glsl */ `
float srgbToLin( float c ) { return c <= 0.04045 ? c / 12.92 : pow( ( c + 0.055 ) / 1.055, 2.4 ); }
float linToSrgb( float c ) { return c <= 0.0031308 ? c * 12.92 : 1.055 * pow( c, 1.0 / 2.4 ) - 0.055; }
vec3 srgbToLin( vec3 c ) { return vec3( srgbToLin( c.r ), srgbToLin( c.g ), srgbToLin( c.b ) ); }
vec3 linToSrgb( vec3 c ) { return vec3( linToSrgb( c.r ), linToSrgb( c.g ), linToSrgb( c.b ) ); }
`;

/* Interleaved gradient noise, and not a Bayer matrix.
 *
 * atmosphere.js:259-272: a 4x4 ordered matrix trades the march's banding for an
 * eight-pixel cross-hatch after the upsample, and the hatch is more noticeable
 * than the banding it replaced. IGN is one line and has no repeat structure
 * the eye can lock onto. */
export const IGN_GLSL = /* glsl */ `
float ign( vec2 p ) {
  return fract( 52.9829189 * fract( 0.06711056 * p.x + 0.00583715 * p.y ) );
}
`;

/**
 * Camera ray reconstruction, from four corner rays uploaded per frame.
 *
 * Cheaper and less error-prone than an inverse projection matrix, and it makes
 * the ray's *length* meaningful: `uRay*` are unnormalised world vectors from
 * the eye to the near-plane-normalised image plane at unit view depth, so
 * `viewZ * ray` is the world offset of the sample and `length(ray)` converts a
 * view-space depth into a distance along the ray in one multiply.
 */
export const RAY_GLSL = /* glsl */ `
uniform vec3 uRay00, uRayDx, uRayDy;    // ray at uv (0,0), and its uv gradients
uniform vec3 uCamPos;
uniform vec2 uDepthRange;               // (near, far)
uniform float uRevDepth;

/* World-space ray from the eye through uv, at unit view depth. */
vec3 camRay( vec2 uv ) { return uRay00 + uRayDx * uv.x + uRayDy * uv.y; }

/** Depth-buffer sample to positive view-space depth in metres. */
float viewDepth( float d ) {
  // Reversed depth puts the near plane at 1. Getting this backwards would put
  // every scene surface at the far plane and the march would never stop.
  d = mix( d, 1.0 - d, uRevDepth );
  float n = uDepthRange.x, f = uDepthRange.y;
  float ndc = d * 2.0 - 1.0;
  return ( 2.0 * n * f ) / ( f + n - ndc * ( f - n ) );
}
`;

/** Fill `uRay00/uRayDx/uRayDy` from a camera. Call once per frame per pass. */
export function setRayUniforms(
  u: Record<string, THREE.IUniform>, cam: THREE.PerspectiveCamera,
) {
  const tan = Math.tan((cam.fov * Math.PI) / 360);
  const halfH = tan, halfW = tan * cam.aspect;
  const e = cam.matrixWorld.elements;
  const rx = new THREE.Vector3(e[0], e[1], e[2]);
  const ry = new THREE.Vector3(e[4], e[5], e[6]);
  const rz = new THREE.Vector3(e[8], e[9], e[10]);     // camera looks down -Z
  // uv (0,0) is the bottom-left of the frame.
  const r00 = rz.clone().multiplyScalar(-1)
    .addScaledVector(rx, -halfW).addScaledVector(ry, -halfH);
  (u.uRay00.value as THREE.Vector3).copy(r00);
  (u.uRayDx.value as THREE.Vector3).copy(rx).multiplyScalar(2 * halfW);
  (u.uRayDy.value as THREE.Vector3).copy(ry).multiplyScalar(2 * halfH);
  (u.uCamPos.value as THREE.Vector3).copy(cam.position);
  (u.uDepthRange.value as THREE.Vector2).set(cam.near, cam.far);
}

/** The uniform block `RAY_GLSL` declares, so a pass cannot forget one. */
export function rayUniforms(): Record<string, THREE.IUniform> {
  return {
    uRay00: { value: new THREE.Vector3() },
    uRayDx: { value: new THREE.Vector3() },
    uRayDy: { value: new THREE.Vector3() },
    uCamPos: { value: new THREE.Vector3() },
    uDepthRange: { value: new THREE.Vector2(0.05, 400) },
    uRevDepth: { value: 0 },
  };
}
