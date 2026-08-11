/* GPU texture baking.
 *
 * Every material in this project is generated at runtime, and generating a
 * 2048² PBR set on the CPU with JavaScript noise costs seconds per surface.
 * The same work as a fragment shader rendered into a render target costs
 * single-digit milliseconds, so all of it happens on the GPU.
 *
 * A surface is described by one GLSL function:
 *
 *   void surf(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao)
 *
 * `uv` covers one tile of the surface; `PATCH` says how many metres that tile
 * is, which is the only thing that ties texel density to the real world. The
 * baker runs it three times into three targets:
 *
 *   map   — linear albedo written into an sRGB8 target, so the GPU encodes on
 *           write and decodes on read. Round trip is identity and the eight
 *           bits are spent where a dark night scene needs them.
 *   normalMap — central differences of `height`, tangent space, green up.
 *   ormMap    — r = occlusion, g = roughness, b = metalness. This is the
 *               packing MeshStandardMaterial already reads (aoMap.r,
 *               roughnessMap.g, metalnessMap.b), so one texture serves three
 *               slots and one sampler serves three lookups.
 */
import * as THREE from 'three';
import { NOISE } from './glsl';

export type SurfaceSet = {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  ormMap: THREE.Texture;
  /** Metres covered by one tile of the maps. */
  patch: number;
  dispose(): void;
};

export type BakeOptions = {
  /** Edge resolution of every map. */
  size?: number;
  /** Metres covered by one tile. Drives texel density and normal strength. */
  patch?: number;
  /** Constant metalness written into the ORM blue channel. */
  metalness?: number;
  /** Vertical exaggeration of the height field when differentiating. */
  bump?: number;
  anisotropy?: number;
};

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

function fragment(body: string, pass: 'albedo' | 'normal' | 'orm'): string {
  const common = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform float uTexel;
uniform float uBump;
uniform float uMetal;
${NOISE}
${body}
`;

  if (pass === 'albedo') {
    return common + /* glsl */ `
void main(){
  vec3 a; float h, r, o;
  surf(vUv, a, h, r, o);
  gl_FragColor = vec4(max(a, 0.0), 1.0);
}
`;
  }
  if (pass === 'orm') {
    return common + /* glsl */ `
void main(){
  vec3 a; float h, r, o;
  surf(vUv, a, h, r, o);
  gl_FragColor = vec4(clamp(o, 0.0, 1.0), clamp(r, 0.02, 1.0), uMetal, 1.0);
}
`;
  }
  return common + /* glsl */ `
float H(vec2 uv){
  vec3 a; float h, r, o;
  surf(uv, a, h, r, o);
  return h;
}
void main(){
  float e = uTexel;
  float hL = H(vUv - vec2(e, 0.0));
  float hR = H(vUv + vec2(e, 0.0));
  float hD = H(vUv - vec2(0.0, e));
  float hU = H(vUv + vec2(0.0, e));
  // Slope per texel, scaled so 'uBump' reads as "height range in metres".
  vec3 n = normalize(vec3(-(hR - hL) * uBump, -(hU - hD) * uBump, 2.0 * e));
  gl_FragColor = vec4(n * 0.5 + 0.5, 1.0);
}
`;
}

const quadGeometry = /* @__PURE__ */ new THREE.PlaneGeometry(2, 2);
const bakeCamera = /* @__PURE__ */ new THREE.Camera();

function makeTarget(size: number, srgb: boolean, aniso: number) {
  const rt = new THREE.WebGLRenderTarget(size, size, {
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
    depthBuffer: false,
    stencilBuffer: false,
    colorSpace: srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace,
    anisotropy: aniso,
  });
  rt.texture.anisotropy = aniso;
  return rt;
}

/**
 * Render one surface description into a full PBR set.
 *
 * Synchronous and self-contained: it saves and restores the renderer's target
 * so it can be called from anywhere during setup.
 */
export function bakeSurface(
  renderer: THREE.WebGLRenderer,
  body: string,
  opts: BakeOptions = {},
): SurfaceSet {
  const size = opts.size ?? 1024;
  const patch = opts.patch ?? 2;
  const aniso = Math.min(opts.anisotropy ?? 16, renderer.capabilities.getMaxAnisotropy());

  const targets = {
    map: makeTarget(size, true, aniso),
    normalMap: makeTarget(size, false, aniso),
    ormMap: makeTarget(size, false, aniso),
  };

  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(quadGeometry, new THREE.ShaderMaterial());
  mesh.frustumCulled = false;
  scene.add(mesh);

  const prevTarget = renderer.getRenderTarget();

  for (const pass of ['albedo', 'normal', 'orm'] as const) {
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: fragment(body, pass),
      uniforms: {
        uTexel: { value: 1 / size },
        // `bump` is a height range in metres; the normal pass needs it in the
        // same units as the uv step, which spans `patch` metres.
        uBump: { value: (opts.bump ?? 0.006) / patch },
        uMetal: { value: opts.metalness ?? 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    mesh.material = mat;
    renderer.setRenderTarget(targets[pass === 'albedo' ? 'map' : pass === 'normal' ? 'normalMap' : 'ormMap']);
    renderer.clear(true, false, false);
    renderer.render(scene, bakeCamera);
    mat.dispose();
  }

  renderer.setRenderTarget(prevTarget);

  return {
    map: targets.map.texture,
    normalMap: targets.normalMap.texture,
    ormMap: targets.ormMap.texture,
    patch,
    dispose() {
      targets.map.dispose();
      targets.normalMap.dispose();
      targets.ormMap.dispose();
    },
  };
}
