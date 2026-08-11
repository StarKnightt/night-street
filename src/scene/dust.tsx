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
 * So brightness here is the product of four terms rather than a constant.
 * Forward scattering, because a mote is a tiny diffuser and returns far more
 * light toward the viewer when the sun is behind it than when it is in front.
 * Height, because the beam skims low over the street. A slow flicker, since
 * real motes tumble and wink rather than gliding evenly. And — added in System
 * 6, and the one that matters most — whether the sun can actually see the mote.
 *
 * The field is a box that travels with the camera, wrapped modulo its own size,
 * so a few thousand points cover an unbounded walk. Nothing is allocated per
 * frame and the whole thing is one draw call.
 *
 * COLOUR SPACE, per §2 of the technique brief.
 *
 *   out  gl_FragColor  DISPLAY-ENCODED sRGB, added with the blend unit into a
 *        buffer that has already been through AgX, the sensor pedestal and the
 *        sRGB encode.
 *
 * That is a deliberate choice and not the §2 mistake, which was mixing a linear
 * radiance into a display buffer as if the two were the same quantity. There is
 * no way to add a radiance before the curve from a separate additive draw —
 * the curve has already run by the time this geometry is composited — so the
 * quantity here is authored *as* a display increment and measured as one. When
 * System 8 introduces the linear HDR target (§5.1) this becomes a radiance and
 * the constant below has to be re-derived through tools/agx.mjs; that is noted
 * at PEAK, where the number lives.
 */
const COUNT = 2200;

/* The field is a slab, not a cube, and that is a measurement result.
 *
 * It used to be a 26 x 7.5 x 34 box wrapped around the camera in all three
 * axes, and the consequence was arithmetic rather than aesthetic. Wrapping y
 * around a camera at eye height puts the motes in world y -2.1 to 5.4, while
 * the two gates that decide whether a mote is visible are both stated in
 * *world* y: the lit slab ramps in at 0.9, and the above-eye-level gate has
 * closed by about 1.6. So the usable band was 0.7 m out of 7.5, and 91 per
 * cent of the field was permanently invisible — either underground, or in the
 * dark air below the beam, or up where it would have read as a star.
 *
 * Measured before the change: 165 of 2200 motes carried any brightness at all,
 * and at 1600x900 the entire field moved 34 pixels. That is not a dim effect,
 * it is an absent one, and no amount of level would have fixed it because the
 * motes were not in the beam to begin with.
 *
 * So x and z still wrap around the camera — the walk has to be unbounded in
 * the directions it moves — and y does not. Height above a street is a
 * property of the street, not of where the viewer's head is, and the lit slab
 * is world-anchored, so the field should be too. The band below sits the whole
 * population inside the gates instead of scattering it either side of them.
 * The count is unchanged, per the technique brief §4.4. */
const BOX = new THREE.Vector3(26, 0, 34);
const Y_LOW = 0.25;
const Y_SPAN = 2.35;   // 0.25 .. 2.60 m above the carriageway

/* Motes are a display increment, and this is its ceiling in 8-bit counts.
 *
 * Measured rather than chosen: differenced pairs against ?haze=nodust put the
 * brightest mote pixels at the value below over the hazed carriageway, which is
 * where they are seen. Raising it is the obvious temptation and is what turns
 * dust into a snowstorm; §4.4 is explicit that the count and the size must not
 * go up, and level is the third way of making the same mistake. */
const PEAK = 0.165;   // ~42 counts at the centre of a fully lit mote

const VERT = /* glsl */ `
uniform float uTime;
uniform vec3  uBox;
uniform vec2  uYBand;    // (low, span) of the world-anchored dust slab
uniform vec3  uSun;
uniform float uPixel;
uniform mat4  uShadowMat;
uniform sampler2D uShadowMap;
uniform float uShadowOn;      // 0 until the sun's shadow map exists
uniform float uRevDepth;      // 1 if the renderer uses a reversed depth buffer
attribute vec3 aSeed;
varying float vGlow;

void main() {
  /* Drift, in two parts.
   *
   * Slow, mostly lateral, with a little rise — a street at dusk has enough
   * thermal movement to carry dust upward but no real wind.
   *
   * The second part is a convection field, and it is why the field stopped
   * reading as a particle system. Every mote used to carry an independent
   * phase, so the drift averaged to nothing over any patch and the eye read
   * 2200 objects each doing its own thing. Real motes are carried by air, and
   * air moves in cells: neighbours share a direction for a few metres and then
   * the direction changes. This is that, at about a 20 m cell — two low
   * frequencies in xz, evaluated at the mote's *seed* position so it is stable
   * per mote and continuous between neighbours. It costs four sines and it is
   * the difference between snow and air.
   */
  vec3 p = position;
  vec2 cell = position.xz * 0.052;
  float cx = sin(cell.x * 1.7 + uTime * 0.11) * cos(cell.y * 1.3 - uTime * 0.09);
  float cz = cos(cell.x * 1.1 - uTime * 0.08) * sin(cell.y * 1.9 + uTime * 0.13);
  float cy = sin(cell.x * 1.4 + cell.y * 1.6 + uTime * 0.07);

  p.x += sin(uTime * 0.09 + aSeed.x * 6.283) * 0.35 + uTime * 0.075 + cx * 1.15;
  p.y += cos(uTime * 0.07 + aSeed.y * 6.283) * 0.18 + uTime * 0.045 + cy * 0.30;
  p.z += sin(uTime * 0.06 + aSeed.z * 6.283) * 0.28 + cz * 1.15;

  /* Wrap the box around the camera so the field is effectively unbounded.
   *
   * Keyed on three's own cameraPosition, not on a uniform this component
   * pushes from useFrame, and that is a bug fix rather than a tidy-up.
   *
   * A uniform written in useFrame is only correct as of the last animation
   * frame. Every capture in this project teleports and renders inside a single
   * synchronous evaluate — goTo, setYaw, warp, renderOnce — so no rAF runs
   * between the move and the draw, and the box stayed wrapped around wherever
   * the camera had been. Measured: camera at z = -28, uCam still at the walk's
   * start at z = +4, so the entire field sat 32 m behind the viewer and every
   * captured frame contained exactly zero motes. tools/sys6live.mjs reported
   * ?haze=nodust as a 0.0 change in every region at every stop including
   * p99.9 and max, which is what an absent layer looks like and is not what a
   * dim one looks like.
   *
   * cameraPosition is uploaded by the renderer from the camera being drawn
   * with, on every render, so it cannot be stale by construction. The effect
   * would have been correct in the interactive walk and absent in every frame
   * anyone reviewed it from — which is the worst available failure mode, and
   * the reason this is keyed off the renderer's value instead. */
  vec2 rel = p.xz - cameraPosition.xz;
  rel = mod(rel + uBox.xz * 0.5, uBox.xz) - uBox.xz * 0.5;
  /* y wraps inside a world-anchored band instead, which also keeps the slow
   * thermal rise honest: the drift term above lifts a mote indefinitely, and
   * without a wrap the whole field would climb out of the beam within a
   * minute of walking. Here it recirculates, which is what convection does. */
  vec3 world = vec3(cameraPosition.x + rel.x,
                    uYBand.x + mod(p.y - uYBand.x, uYBand.y),
                    cameraPosition.z + rel.y);

  vec4 mv = modelViewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mv;

  /* Forward scattering: bright when looking through the mote toward the sun,
   * nearly nothing when the sun is behind the viewer. */
  vec3 vdir = normalize(world - cameraPosition);
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

  /* Can the sun actually see this mote?
   *
   * Everything above is a statement about geometry and none of it knows where
   * the buildings are, so a mote deep in the shade of the sunward frontage was
   * exactly as bright as one standing in a gap. That is what makes a mote field
   * read as an overlay on the picture rather than as something inside it, and
   * it is the one upgrade §4.4 puts first.
   *
   * One texture fetch, in the vertex shader, on 2200 vertices. The shadow map
   * is the sun's own — read off the scene graph rather than plumbed through
   * Lighting.tsx, which belongs to System 5 — so the shade lines the motes wink
   * out along are the same ones the buildings cast on the road, for free and
   * exactly registered.
   *
   * Three defensive properties, because this samples another system's resource
   * while that system is being worked on:
   *
   *   uShadowOn is 0 until the map exists, and the gate is then 1.0. A missing
   *   or disposed shadow map makes the motes un-gated, never absent.
   *
   *   Outside the shadow frustum the gate is 1.0 as well. The mote slab is
   *   26 x 34 m about the camera and the sun's frustum is 44 x 26, so the
   *   corners of the field do fall outside it; treating outside as unlit would
   *   put a moving rectangular hole in the dust.
   *
   *   The comparison is written for both depth conventions. three 0.185 can run
   *   a reversed depth buffer, in which case near is 1 and the inequality
   *   flips; getting that backwards would light exactly the motes that should
   *   be dark, which is a difference no error message reports.
   *
   * The floor is not zero. A mote in shade is still lit by the sky, and the sky
   * at this hour is a bright blue-violet dome — it is far too dim to see
   * against the haze, but hard-zeroing it makes the shade line a cut rather
   * than an edge. */
  float sun = 1.0;
  if (uShadowOn > 0.5) {
    vec4 sc = uShadowMat * vec4(world, 1.0);
    vec3 sp = sc.xyz / sc.w;
    float inside = step(0.0, sp.x) * step(sp.x, 1.0)
                 * step(0.0, sp.y) * step(sp.y, 1.0)
                 * step(0.0, sp.z) * step(sp.z, 1.0);
    float d = texture2D(uShadowMap, sp.xy).r;
    // 0.5 m of slack over a 149 m ortho depth range: motes hang in open air,
    // far from any occluder, so the bias only has to clear map quantisation.
    float bias = 0.0034;
    float visible = mix(step(sp.z - bias, d), step(d - bias, sp.z), uRevDepth);
    sun = mix(1.0, mix(0.05, 1.0, visible), inside);
  }

  vGlow = scatter * lit * twinkle * belowHorizon * sun * (0.35 + 0.65 * aSeed.y);

  /* Motes are motes: a couple of pixels at most. Sized generously they stop
   * being dust and become out-of-focus bokeh, which asserts a shallow depth of
   * field this scene does not have and reads as lens dirt.
   *
   * The distribution is power-law rather than uniform: aSeed.z squared biases
   * the field toward small motes with a few conspicuous ones, which is what a
   * real size distribution looks like and what stops the field reading as 2200
   * copies of one object.
   *
   * uPixel had to go up for that to mean anything, and this is not a licence to
   * grow the motes. Measured at 7.5, the requested size was 0.80 px at the 5th
   * percentile, 0.80 at the median and 0.87 at the 95th — the entire population
   * was pinned against the bottom of the clamp, so every mote was the same size
   * and the distribution above was computing a number that the clamp then threw
   * away. It was inert in exactly the way this project keeps shipping.
   *
   * The policy is the clamp, and the clamp has not moved: 0.8 px to 3.4 px,
   * with the same reasoning as before — sized generously they stop being dust
   * and become out-of-focus bokeh, which asserts a shallow depth of field this
   * scene does not have. What changes is that the field now occupies that band
   * instead of collapsing onto its floor. */
  float sz = aSeed.z * aSeed.z;
  gl_PointSize = clamp(uPixel * (0.75 + 1.9 * sz) / max(-mv.z, 0.6), 0.8, 3.4);
}
`;

const FRAG = /* glsl */ `
uniform float uPeak;
varying float vGlow;
void main() {
  // Round, soft-edged, and nothing at all outside the disc: a square mote is
  // the fastest way to make a particle system look like a particle system.
  vec2 d = gl_PointCoord - 0.5;
  float r = dot(d, d);
  if (r > 0.25) discard;
  float a = smoothstep(0.25, 0.02, r);
  // Display-encoded, added by the blend unit. See the header.
  gl_FragColor = vec4(vec3(1.0, 0.74, 0.42) * vGlow * a * uPeak, 1.0);
}
`;

/** Matches haze.ts's switch, so one query string configures the whole system. */
function dustFlag(name: string): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  if (typeof window === 'undefined') return false;
  const q = new URLSearchParams(window.location.search).get('haze');
  return !!q && q.split(',').map((s) => s.trim()).includes(name);
}

export function Dust() {
  // The camera and the renderer are deliberately not read here: both are
  // reached through the draw itself, so that nothing this component sets can
  // be a frame out of date. See the vertex shader and bind() below.
  const scene = useThree((s) => s.scene);
  const ref = useRef<THREE.Points>(null);
  const sun = useRef<THREE.DirectionalLight | null>(null);

  const { geometry, material } = useMemo(() => {
    const pos = new Float32Array(COUNT * 3);
    const seed = new Float32Array(COUNT * 3);
    for (let i = 0; i < COUNT; i++) {
      pos[i * 3] = (Math.random() - 0.5) * BOX.x;
      pos[i * 3 + 1] = Y_LOW + Math.random() * Y_SPAN;
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
        uYBand: { value: new THREE.Vector2(Y_LOW, Y_SPAN) },
        uSun: { value: new THREE.Vector3(...SUN_DIR) },
        uPixel: { value: 16.0 },
        uPeak: { value: dustFlag('nodust') ? 0 : PEAK },
        uShadowMat: { value: new THREE.Matrix4() },
        uShadowMap: { value: null },
        uShadowOn: { value: 0 },
        uRevDepth: { value: 0 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    return { geometry: g, material: m };
  }, []);

  /* Only the clock advances per animation frame. Everything the frame's
   * correctness depends on is bound in onBeforeRender below, for the reason
   * given in the vertex shader: a capture teleports and draws inside one
   * synchronous evaluate, so anything written here is a frame out of date at
   * the moment it matters. A stale clock just means a still frame has still
   * motes, which is what a still frame should have. */
  useFrame((_, dt) => { material.uniforms.uTime.value += dt; });

  /* Bound during the draw, by the renderer, from the state being drawn.
   *
   * onBeforeRender runs inside gl.render for this object, so a value set here
   * is correct whether the frame came from the animation loop or from a
   * one-shot renderOnce(). The shadow matrix is held by reference rather than
   * copied, so the shadow pass's own update earlier in the same render is
   * already reflected. */
  const bind = useMemo(() => (r: THREE.WebGLRenderer) => {
    const u = material.uniforms;

    /* Re-find the sun rather than caching it in an effect.
     *
     * System 5 is still moving, and its light is mounted and unmounted by
     * React; a reference captured once goes stale the first time that
     * component reloads and then silently gates against a disposed map. A
     * scene walk over a few dozen objects costs nothing measurable next to the
     * draw it precedes, and cannot go stale. */
    if (!sun.current || !sun.current.parent) {
      let found: THREE.DirectionalLight | null = null;
      scene.traverse((o) => {
        const l = o as THREE.DirectionalLight;
        if (!found && l.isDirectionalLight && l.castShadow) found = l;
      });
      sun.current = found;
    }

    /* depthTexture first, and this is not a defensive fallback — it is the
     * whole answer, and getting it wrong would have been invisible.
     *
     * For every shadow type except VSM, three renders the sun's depth into the
     * render target's *depthTexture* and leaves the colour attachment unused;
     * WebGLLights binds `shadow.map.depthTexture || shadow.map.texture` and
     * softShadow.ts then reads `.r` off it. Reaching for `shadow.map.texture`,
     * which is the obvious property name and the one this file first used,
     * samples that empty colour buffer instead. It throws nothing, links
     * cleanly and returns a constant — so every mote would have been gated
     * identically and it would have read as a level being wrong rather than as
     * a texture being the wrong one. The order below mirrors three's own so it
     * stays correct if System 5 changes shadow type. */
    const s = sun.current;
    const sm = s && s.shadow ? s.shadow.map : null;
    const map = sm ? (sm.depthTexture || sm.texture) : null;
    // ?haze=noshadow ungates the field, so the gate can be differenced against
    // itself rather than only against no dust at all.
    if (map && s && !dustFlag('noshadow')) {
      u.uShadowMap.value = map;
      u.uShadowMat.value = s.shadow.matrix;
      u.uShadowOn.value = 1;
      u.uRevDepth.value = (r as unknown as { reversedDepthBuffer?: boolean })
        .reversedDepthBuffer ? 1 : 0;
    } else {
      u.uShadowOn.value = 0;
    }
  }, [material, scene]);

  return (
    <points
      ref={ref}
      geometry={geometry}
      material={material}
      frustumCulled={false}
      onBeforeRender={bind}
    />
  );
}
