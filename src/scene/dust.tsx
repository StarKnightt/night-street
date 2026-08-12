import * as THREE from 'three';
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { SUN_DIR } from './env';
import { sunwardAirlight } from './haze';
import { useHdr } from './pipeline';

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
 * COLOUR SPACE, per §2 of the technique brief, and it has changed.
 *
 *   out  gl_FragColor  LINEAR SCENE RADIANCE, added with the blend unit into
 *        the half-float target, before the tone curve. On ?nohdr, display-
 *        encoded sRGB into the canvas, as it was.
 *
 * The old note here said this would happen: "when System 8 introduces the
 * linear HDR target (§5.1) this becomes a radiance and the constant below has
 * to be re-derived through tools/agx.mjs". It has, and it was — the working is
 * at PEAK_L, and it turned out to be more interesting than a unit conversion,
 * because a display increment is not one radiance but four depending on what
 * it lands on.
 *
 * Nothing else about the draw changes. It is still one additive pass of
 * 2200 points with no depth write, and it is still composited by the blend
 * unit; what it composites into is now light rather than density.
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
 * go up, and level is the third way of making the same mistake.
 *
 * Only on ?nohdr. See PEAK_L. */
const PEAK = 0.165;   // ~42 counts at the centre of a fully lit mote

/* Motes are a radiance, and this is what the constant above turns into.
 *
 * The header of this file said this would have to be re-derived through
 * tools/agx.mjs when the linear target arrived, and the reason is worth
 * stating with the numbers, because it is the clearest example in the project
 * of why an authored display increment is not a physical quantity.
 *
 * A fixed 42-count addition on top of a background is not one radiance, it is
 * a different radiance at every background level. Through AgX at 0.296:
 *
 *     over code  90  it is  dL = 0.39
 *     over code 110  it is  dL = 0.60
 *     over code 130  it is  dL = 0.95
 *     over code 150  it is  dL = 1.59
 *
 * So the old constant was quietly making motes over the bright end of the
 * street four times more energetic than motes over the dark end, purely
 * because of where they happened to land. In radiance a mote is a particle
 * scattering the sun and its brightness has nothing to do with what is behind
 * it, which is both correct and the reason the field will now read as being
 * *in* the scene rather than on it.
 *
 * The value is a ratio to the sun rather than an absolute: `sunwardAirlight`
 * is this sun scattered by this air at saturation — the brightest a piece of
 * illuminated atmosphere can be — and a mote's peak pixel is a fifth of that.
 * It lands inside the 0.60-0.95 band the old constant occupied where motes are
 * actually seen.
 *
 * Through haze.ts rather than env.ts's `HORIZON_SUNWARD`, which is the same
 * quantity with the solar aureole still in it and therefore a function of the
 * sun's elevation. Reading the exported constant dimmed every mote by about
 * two fifths when the sun rose from 4.2 degrees to 12 — a change that says
 * nothing about how much dust is in the street. haze.ts's note on that
 * function has the arithmetic.
 */
const MOTE_FRACTION = 0.20;

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

  /* Forward scattering, which is the entire effect.
   *
   * Airborne dust at golden hour is strongly forward-scattering: a mote is
   * dazzling looking into the sun and all but invisible looking away, and a
   * field without that view dependence reads as snow. The lobe here is a
   * Henyey-Greenstein at g = 0.76 normalised to 1 down the beam — the same
   * family haze.ts uses for the medium, at a much higher asymmetry, because a
   * mote is a large particle and the haze's g = 0.42 is a broadened
   * multiple-scattering figure that does not apply to one.
   *
   * It replaces pow(max(mu,0), 5.0), which had almost exactly this shape over
   * the forward hemisphere and two defects behind it: it is identically zero
   * over the whole anti-sun half, so the field switches off with a derivative
   * kink halfway through every pan, and being zero it could not express the
   * thing that is actually true, which is that a mote seen against a dark
   * frontage with the sun behind you still catches a little sky. The tail is
   * 0.25 per cent of the peak. That is not visible on its own and it is the
   * difference between a lobe and a cut. */
  vec3 vdir = normalize(world - cameraPosition);
  float mu = dot(vdir, uSun);
  float hg = 1.5776 - 1.52 * mu;                    // 1 + g^2 - 2g*mu, g = 0.76
  float scatter = 0.0138 * inversesqrt(hg * hg * hg);

  /* Only in the beam. Low sun skims, so the lit slab is a band, not a volume.
   *
   * The lower half of this band is a proxy for something that is now measured
   * properly a few lines down. It was written before the motes were gated on
   * the sun's shadow map, when nothing in this shader knew where the buildings
   * were and the only available way to say "the beam does not reach the
   * bottom of a canyon" was to fade the motes out near the ground. The shadow
   * map answers that question exactly, per mote, so the ramp is now a second
   * opinion on a question that has already been settled — and it is wrong in
   * the one place that matters most, because where the beam *does* reach the
   * road through a gap in the frontage, the brightest and most photographic
   * air in the scene is the half metre directly above the pavement, and this
   * was fading precisely that out. See BAND_TOP below for the measurement. */
  //__BAND__
  float twinkle = 0.45 + 0.55 * sin(uTime * 2.3 + aSeed.x * 40.0 + aSeed.z * 17.0);

  /* Not against the sky, because against the sky a mote is a star.
   *
   * A small bright additive point on the sky is indistinguishable from a star,
   * which is what reviewers found scattered through the upper right of five
   * frames and read, reasonably, as debris left over from the night build.
   * Dust at golden hour is something you see against the ground, against a
   * frontage and against the haze.
   *
   * This used to be stated as a height: nothing above eye level, since a mote
   * higher than the camera always projects above the horizon line. That is a
   * sound test for whether a mote is above the horizon and a poor one for
   * whether it is on the sky, and the difference is most of a street. The
   * canyon here is 11.4 m wide between frontages that are one to four storeys,
   * so nearly every above-horizon direction is filled with building; the gate
   * was discarding the top 0.4 m of the slab outright and attenuating the
   * 0.6 m below it, in every direction, to solve a problem that exists in
   * about a quarter of them.
   *
   * So ask the question directly: continue the view ray past the mote and see
   * what it hits. If it crosses the building line below the eaves there is a
   * facade behind the mote and it is safe at any height. If it clears the
   * roofline, or runs so near the street axis that it never reaches a
   * frontage at all — which is the vanishing point, the brightest sky in the
   * frame, and exactly where the stars were seen — it is on sky and goes.
   *
   * ROOF is the lowest frontage in the row rather than the mean, because this
   * has to be conservative in the one direction that matters: 4.5 m is the
   * single-storey workshop from block.ts's east side, and using the mean would
   * light motes on sky wherever the row steps down. The ramp starts 1.5 m
   * below it so the transition is an edge and not a cut.
   *
   * Costs a divide and a smoothstep. The 1e-3 floor on the denominator is the
   * street-axis case: it sends the crossing height to some hundreds of metres
   * rather than to infinity, which lands in the same place the smoothstep
   * does and avoids the special case. */
  const float WALL_X = 5.7;    // BUILD_LINE, block.ts
  const float ROOF = 4.5;      // lowest frontage in the row
  float dxWall = (vdir.x >= 0.0 ? WALL_X : -WALL_X) - cameraPosition.x;
  float hitY = cameraPosition.y + vdir.y * (abs(dxWall) / max(abs(vdir.x), 1e-3));
  //__GATE__

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

  vGlow = scatter * lit * twinkle * gate * sun * (0.35 + 0.65 * aSeed.y);

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

/* The two gates, substituted into the source rather than selected by a
 * uniform, so the shipped build compiles neither the branch nor the term it
 * does not use and a measured difference cannot be a cost difference.
 * `?haze=eyegate` restores the old one; see the block above for why it went. */
const GATE_SKY = 'float gate = 1.0 - smoothstep(ROOF - 1.5, ROOF, hitY);';
const GATE_EYE = 'float gate = 1.0 - smoothstep(-0.05, 0.55, world.y - cameraPosition.y);';

/* The height band, likewise switchable, because deleting half of it is a claim
 * about the shadow gate that has to be falsifiable: if the ground ramp really
 * is redundant then dropping it must leave the shaded part of the street
 * unchanged, since the shadow map is then the only thing holding those motes
 * down. `?haze=band` puts the old one back. */
const BAND_FULL = 'float lit = smoothstep(0.10, 0.9, world.y) * (1.0 - smoothstep(2.2, 4.4, world.y));';
const BAND_TOP = 'float lit = 1.0 - smoothstep(2.2, 4.4, world.y);';

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
  // Radiance, or a display increment on ?nohdr. Added by the blend unit;
  // see the header. The tint is the sun's own, warmed by the air it crossed.
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
      /* Both placeholders must appear exactly once in the source, and the
       * first version of this failed because the word was also in the comment
       * above the site: String.replace takes the first match, so the comment
       * got the statement and the statement stayed a comment. `lit` was then
       * undeclared, the whole points program failed to link, and every mote in
       * the scene disappeared. The harness called it; the assertion is here so
       * the next edit to those comments does not have to. */
      vertexShader: [['//__GATE__', dustFlag('eyegate') ? GATE_EYE : GATE_SKY],
                     ['//__BAND__', dustFlag('band') ? BAND_FULL : BAND_TOP]]
        .reduce((src, [token, body]) => {
          if (src.split(token).length !== 2) throw new Error(`dust: ${token} is not unique in the shader source`);
          return src.replace(token, body);
        }, VERT),
      fragmentShader: FRAG,
      uniforms: {
        uTime: { value: 0 },
        uBox: { value: BOX.clone() },
        uYBand: { value: new THREE.Vector2(Y_LOW, Y_SPAN) },
        uSun: { value: new THREE.Vector3(...SUN_DIR) },
        uPixel: { value: 16.0 },
        uPeak: { value: dustFlag('nodust') ? 0 : (useHdr() ? sunwardAirlight(SUN_DIR)[0] * MOTE_FRACTION : PEAK) },
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

  /* Published so the field can be switched off between two otherwise identical
   * renders. The view dependence is the entire effect and it is the one claim
   * a still frame cannot support, so it has to be measurable as a differenced
   * pair — and a differenced pair against a *reload* would also difference the
   * hash seeds and the clock. See tools/atmo.mjs. */
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    (window as unknown as { __dust?: unknown }).__dust = { uniforms: material.uniforms };
    return () => { delete (window as unknown as { __dust?: unknown }).__dust; };
  }, [material]);

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
