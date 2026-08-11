import * as THREE from 'three';
import { useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { SUN_DIR } from './env';

/* Dust and pollen in the air.
 *
 * The thing that sells a low sun in a photograph, after the shadows, is that
 * the air stops being empty. Motes drift through the beam and light up as they
 * cross it, and they are visible *only* where the sun catches them — the same
 * particle a metre into the shade is invisible. That selectivity is the whole
 * effect: a uniform snow of white specks across the frame reads as sensor dirt
 * or as a particle system, never as air.
 *
 * So brightness here is the product of three terms rather than a constant.
 * Forward scattering, because a mote is a tiny diffuser and returns far more
 * light toward the viewer when the sun is behind it than when it is in front.
 * Height, because the beam skims low over the street. And a slow flicker, since
 * real motes tumble and wink rather than gliding evenly.
 *
 * The field is a box that travels with the camera, wrapped modulo its own size,
 * so a few thousand points cover an unbounded walk. Nothing is allocated per
 * frame and the whole thing is one draw call.
 */
const COUNT = 2200;
const BOX = new THREE.Vector3(26, 7.5, 34);

const VERT = /* glsl */ `
uniform float uTime;
uniform vec3  uBox;
uniform vec3  uCam;
uniform vec3  uSun;
uniform float uPixel;
attribute vec3 aSeed;
varying float vGlow;

void main() {
  /* Drift. Slow, mostly lateral, with a little rise — a street at dusk has
   * enough thermal movement to carry dust upward but no real wind. */
  vec3 p = position;
  p.x += sin(uTime * 0.09 + aSeed.x * 6.283) * 0.9 + uTime * 0.075;
  p.y += cos(uTime * 0.07 + aSeed.y * 6.283) * 0.45 + uTime * 0.045;
  p.z += sin(uTime * 0.06 + aSeed.z * 6.283) * 0.7;

  // Wrap the box around the camera so the field is effectively unbounded.
  vec3 rel = p - uCam;
  rel = mod(rel + uBox * 0.5, uBox) - uBox * 0.5;
  vec3 world = uCam + rel;

  vec4 mv = modelViewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mv;

  /* Forward scattering: bright when looking through the mote toward the sun,
   * nearly nothing when the sun is behind the viewer. */
  vec3 vdir = normalize(world - uCam);
  float mu = max(dot(vdir, uSun), 0.0);
  float scatter = pow(mu, 5.0);

  // Only in the beam. Low sun skims, so the lit slab is a band, not a volume.
  float lit = smoothstep(0.10, 0.9, world.y) * (1.0 - smoothstep(2.2, 4.4, world.y));
  float twinkle = 0.45 + 0.55 * sin(uTime * 2.3 + aSeed.x * 40.0 + aSeed.z * 17.0);

  /* Nothing above eye level, because up there it is a star.
   *
   * A mote higher than the camera always projects above the horizon line, and
   * against the sky a small bright additive point is indistinguishable from a
   * star — which is exactly what reviewers found scattered through the upper
   * right of five frames and read, reasonably, as debris left over from the
   * night build. Dust at golden hour is something you see against the ground
   * and against the haze, not against the sky. */
  float belowHorizon = 1.0 - smoothstep(-0.05, 0.55, world.y - cameraPosition.y);

  vGlow = scatter * lit * twinkle * belowHorizon * (0.35 + 0.65 * aSeed.y) * 0.55;
  /* Motes are motes: a couple of pixels at most. Sized generously they stop
   * being dust and become out-of-focus bokeh, which asserts a shallow depth of
   * field this scene does not have and reads as lens dirt. */
  gl_PointSize = clamp(uPixel * (0.9 + 1.7 * aSeed.z) / max(-mv.z, 0.6), 0.8, 3.4);
}
`;

const FRAG = /* glsl */ `
varying float vGlow;
void main() {
  // Round, soft-edged, and nothing at all outside the disc: a square mote is
  // the fastest way to make a particle system look like a particle system.
  vec2 d = gl_PointCoord - 0.5;
  float r = dot(d, d);
  if (r > 0.25) discard;
  float a = smoothstep(0.25, 0.02, r);
  gl_FragColor = vec4(vec3(1.0, 0.74, 0.42) * vGlow * a, 1.0);
}
`;

export function Dust() {
  const camera = useThree((s) => s.camera);
  const ref = useRef<THREE.Points>(null);

  const { geometry, material } = useMemo(() => {
    const pos = new Float32Array(COUNT * 3);
    const seed = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      pos[i * 3] = (Math.random() - 0.5) * BOX.x;
      pos[i * 3 + 1] = Math.random() * BOX.y;
      pos[i * 3 + 2] = (Math.random() - 0.5) * BOX.z;
      seed[i * 3] = Math.random();
      seed[i * 3 + 1] = Math.random();
      seed[i * 3 + 2] = Math.random();
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
    // The field moves with the camera, so a static bounding sphere would cull
    // it the moment the walk leaves the origin.
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const m = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uBox: { value: BOX.clone() },
        uCam: { value: new THREE.Vector3() },
        uSun: { value: new THREE.Vector3(...SUN_DIR) },
        uPixel: { value: 7.5 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    return { geometry: g, material: m };
  }, []);

  useFrame((_, dt) => {
    const u = material.uniforms;
    u.uTime.value += dt;
    u.uCam.value.copy(camera.position);
    if (ref.current) ref.current.position.set(0, 0, 0);
  });

  return <points ref={ref} geometry={geometry} material={material} frustumCulled={false} />;
}
