/* System 5: materials for the things that emit.
 *
 * Three materials — the lamp luminaire, the neon and signal assembly, and the
 * additive near-field glow — plus the two shader fragments the rest of the
 * street imports to receive analytic light.
 *
 * Everything emissive in here is authored by inverting the display response in
 * scene/lights.ts, which calls `atDisplay` in scene/tone.ts — the renderer's
 * own AgX transform, ported term for term and inverted numerically. Nothing in
 * this file contains a constant that was arrived at by looking at a frame.
 *
 * This paragraph used to name `display = 0.284 * L^0.4545` as that response. It
 * was withdrawn in 442fbe5 and lights.ts moved off it in the same commit; the
 * line here was left behind and is the last thing in the tree outside the car
 * materials that still called the fit authoritative. Nothing depended on it —
 * no constant in this file is derived here — but a stale pointer to a
 * withdrawn curve is how the next author re-derives a level through it.
 */
import * as THREE from 'three';
import { NOISE, CANYON } from '@/world/glsl';
import { signGLSL, signUniforms } from './signs';
import { FACADE_VARYINGS, FACADE_VERTEX } from './buildingMaterials';
import { ARTIFICIAL, artificialAdd, artificialUniforms } from './lights';

/* ── The traffic signal's clock ───────────────────────────────────────────
 *
 * A 41 second cycle, which is a real one for a minor-arm signal: 20 red,
 * 18 green, 3 amber. Shared verbatim by the lens and by its halo, because two
 * copies of a cycle drift the moment one of them is edited and a signal whose
 * glow is amber while its lens is green is the kind of error that survives
 * review.
 *
 * Driven from uSysTime rather than from the frame count so that a capture can
 * pin it. See freezeTime in scene/lights.ts.
 */
export const SIGNAL = /* glsl */ `
uniform float uSysTime;
int signalAspect(){
  float t = mod(uSysTime, 41.0);
  return t < 20.0 ? 0 : t < 38.0 ? 2 : 1;   // 0 red, 1 amber, 2 green
}
`;

/* ── The luminaire ────────────────────────────────────────────────────────
 *
 * A lighting column is galvanised steel that has been painted, and both facts
 * matter to how it reads against a bright sky: the paint is a flat mid grey
 * that goes almost black in silhouette, and where it has failed at the base
 * and around the door the zinc underneath is a much lighter, slightly blue
 * grey that catches the sky. That contrast down the bottom metre is most of
 * what stops a column reading as a black stick.
 *
 * No relief. A 6.8 m column against the sky is a silhouette and the one
 * genuine hazard here is a normal perturbation at 4.2 degrees, which swings
 * N.L sevenfold between adjacent pixels; every variation below is albedo and
 * roughness only.
 */
const LAMP_PARS = /* glsl */ `
${FACADE_VARYINGS}
varying vec4 vLamp;
varying vec3 vBowl;
vec3 gEmit = vec3(0.0);
float gAO = 1.0;
`;

const LAMP_BODY = /* glsl */ `
{
  float seed = vLamp.x;
  float part = vLamp.y;
  float y0 = vLamp.z;
  float warm = vLamp.w;
  float h = vWPos.y - y0;

  vec3 base = vec3(0.0455, 0.0470, 0.0495);   // painted steel, dark neutral grey
  float rgh = 0.62;
  float met = 0.22;

  if (part < 1.5){
    /* Column and door. Weathering runs bottom-up: road spray to about 600 mm,
     * then a band where the paint has gone chalky, then sound paint above. */
    float spray = smoothstep(0.85, 0.05, h);
    float chalk = smoothstep(2.6, 0.4, h);
    float grain = unit(wfbm(vec2(h * 2.6, seed * 61.0), 3));
    base = mix(base, vec3(0.0740, 0.0725, 0.0680), chalk * (0.30 + 0.35 * grain));
    // Zinc showing through where the paint has failed, which on a column is
    // always at the flange and around the door edges.
    float bare = smoothstep(0.62, 0.90, grain) * smoothstep(1.30, 0.10, h);
    base = mix(base, vec3(0.1320, 0.1355, 0.1420), bare * 0.75);
    base = mix(base, vec3(0.0300, 0.0265, 0.0230), spray * (0.35 + 0.30 * grain));
    rgh = mix(0.55, 0.86, chalk);
    met = mix(0.30, 0.06, chalk);
    // The occlusion inside the door rebate, which is 15 mm and would otherwise
    // read as a sticker.
    if (part > 0.5) gAO = 0.72;
  } else if (part < 2.5){
    // The bracket. Same paint, less weather: it is six metres up.
    base *= 0.96;
    rgh = 0.58; met = 0.28;
  } else if (part < 3.5){
    /* The casting. Aluminium, and left much lighter than the column on
     * purpose: a cobra head is a pale grey object and it is the only part of
     * the fitting the sky lights from above, so the top of it is the brightest
     * thing at that height in the frame apart from the bowl. */
    float top = smoothstep(0.0, 0.6, vWN.y);
    base = mix(vec3(0.0900, 0.0910, 0.0930), vec3(0.1180, 0.1190, 0.1215), top);
    base *= 0.90 + 0.20 * unit(wfbm(vWPos.xz * 6.0 + seed * 30.0, 2));
    rgh = 0.44; met = 0.55;
  } else {
    /* The bowl.
     *
     * The one emissive surface on the fitting. Its radiance arrives per lamp
     * on aBowl, inverted through the shipped transform in lampFixtures.ts at
     * that fixture's own point on the sodium run-up. It is not a level and a
     * dimmer setting: what separates a lamp that has just struck from one that
     * has been on for five minutes is mostly *colour*, deep red-pink against
     * orange, and the shader does not need to know that — it is already in the
     * three numbers.
     *
     * The bowl itself is a moulded acrylic tray with sixty years of insect and
     * dust deposit in the bottom of it, so it is neither clean nor uniform;
     * the mottle is worth having because a perfectly even source is the tell
     * that separates a rendered lamp from a photographed one.
     */
    float mott = 0.78 + 0.44 * unit(wfbm(vWPos.xz * 22.0 + seed * 17.0, 3));
    // The rim of the tray is thicker in section than the face, so it carries
    // more of the discharge toward a grazing view. Cheap, and it gives the
    // bowl an edge instead of a cut-out.
    float rim = 1.0 + 0.65 * (1.0 - abs(vWN.y));
    gEmit = warm > 0.0 ? vBowl * mott * rim : vec3(0.0);
    // Unlit, the bowl is a dirty translucent white; lit, its own albedo is
    // irrelevant next to what it is emitting.
    base = vec3(0.1450, 0.1420, 0.1330);
    rgh = 0.30; met = 0.0;
  }

  diffuseColor.rgb *= base;
  roughnessFactor = rgh;
  metalnessFactor = met;
}
`;

const LAMP_END = /* glsl */ `
#include <lights_fragment_end>
reflectedLight.indirectDiffuse =
  canyonSky(reflectedLight.indirectDiffuse, vWN, vWPos.y) * 3.10 * gAO;
${artificialAdd('vWN')}
`;

export function makeLampMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1, metalness: 0,
    shadowSide: THREE.FrontSide, dithering: true,
  });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, artificialUniforms());
    shader.vertexShader = shader.vertexShader
      .replace('void main() {',
        `${FACADE_VARYINGS}\nvarying vec4 vLamp;\nvarying vec3 vBowl;\n` +
        'attribute vec4 aLamp;\nattribute vec3 aBowl;\nvoid main() {')
      .replace('#include <begin_vertex>', `${FACADE_VERTEX}\nvLamp = aLamp;\nvBowl = aBowl;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {',
        `${NOISE}\n${LAMP_PARS}\n${CANYON}\n${ARTIFICIAL}\nvoid main() {`)
      /* Injected after metalnessmap_fragment, not after roughnessmap_fragment.
       * `metalnessFactor` is *declared* by the metalness chunk, so a body that
       * assigns it from the earlier hook does not compile — and until
       * shaderWatch.ts went in, a program that did not compile rendered as a
       * flat surface with no error anywhere. */
      .replace('#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>\n${LAMP_BODY}`)
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += gEmit;')
      .replace('#include <lights_fragment_end>', LAMP_END);
  };
  m.customProgramCacheKey = () => 'sys5-lamp';
  return m;
}

/* ── Neon, letterforms and signal lenses ──────────────────────────────────── */

const NEON_PARS = /* glsl */ `
${FACADE_VARYINGS}
varying vec4 vNeon;
varying vec4 vNeonC4;
varying vec4 vRect;
varying vec4 vAxis;
varying vec2 vNuv;
vec3 gEmit = vec3(0.0);
vec3 gNormal = vec3(0.0);
${SIGNAL}
`;

const NEON_BODY = /* glsl */ `
/* Taken before the branch. signMirror reads screen-space derivatives, and a
 * derivative inside non-uniform control flow is undefined — which on this
 * project has previously meant a word that reads correctly on one row of the
 * street and backwards on the other. */
float gMir = signMirror(vNuv, vWN);
{
  float part = vNeon.x;
  vec3 col = vNeonC4.rgb;

  if (part < 0.5){
    /* THE TUBE, and the limb brightening that identifies it.
     *
     * The phosphor is a thin shell on the inside of the glass, so what leaves
     * a point of the tube toward the eye is the emission integrated along the
     * chord the view ray cuts through that shell: 2t at the centre of the
     * tube, t/cos at an angle, unbounded at the silhouette. g below is that
     * cosine, measured in the plane across the axis.
     *
     * Clamped at 0.16, which caps the rails at 5x, and divided by the mean of
     * the clamped profile so that this *redistributes* the authored radiance
     * rather than adding any. The mean of 1/cos over the projected width is
     * exactly pi/2 — substitute b = R sin(theta) and the integrand collapses
     * to dtheta — and the clamp removes 0.096 of that from the last nine
     * degrees, giving 1.48. Core comes out 0.68x, rails 3.4x, flux unchanged.
     *
     * On screen that means the rails clip. They are meant to: the authored
     * 225 is the tube's *mean* display value, and a neon tube photographed at
     * any exposure that holds the street has white rails with the colour in
     * the falloff either side of them. A tube whose brightest part is its
     * authored colour is a painted rod.
     */
    vec3 A = vAxis.xyz;
    vec3 rp = vWPos - vRect.xyz;
    rp -= A * dot(rp, A);
    vec3 nP = normalize(rp);
    vec3 V = normalize(cameraPosition - vWPos);
    vec3 vP = V - A * dot(V, A);
    float lv = length(vP);
    float g = lv > 1e-4 ? abs(dot(nP, vP / lv)) : 1.0;
    float chord = min(1.0 / max(g, 0.16), 5.0) / 1.48;

    /* The analytic cylinder normal, not the faceted one. The tube is an eight
     * sided prism because that is all the silhouette needs at 19 mm, and
     * shading it as eight flat strips would put a visible ridge down a source
     * whose entire job is to be smooth. */
    gNormal = nP;
    gEmit = col * chord;
    diffuseColor.rgb = vec3(0.0620, 0.0600, 0.0575);
    roughnessFactor = 0.10;
    metalnessFactor = 0.0;

  } else if (part < 1.5){
    /* LETTERFORMS, out of the stroke-font atlas System 3 already uses.
     *
     * ── A letter is a tube, and it was being drawn as a lit panel ─────────
     *
     * What stood here was edge * 1.32 - core * 0.30: a coverage mask filled
     * to one value with a two per cent lift at its own outline. That is a
     * backlit acrylic letter — a face illuminated from behind, uniform across
     * its width — and it is what the sign measured as. Photographed, the BAR
     * letters came off disk as flat slabs at (245, 190, 166), a single tone
     * from one side of a stem to the other, while the bare tube 60 mm to the
     * left of them in the same frame had a white core with red-orange falloff
     * either side and read correctly. Two objects that are the same object
     * were being drawn by two different models, and the wrong one was on the
     * part that carries the word.
     *
     * A neon letter is bent glass of constant bore. It is limb *brightened*
     * for the reason the TUBE branch above gives at length: the phosphor is a
     * shell on the inside of the glass, so the chord a view ray cuts through
     * it diverges toward the silhouette. Across a stroke that means two bright
     * rails and a duller middle. A uniform fill is not a dimmer version of
     * that, it is the opposite of it, and no level fixes it.
     *
     * The obstacle is that the atlas has no distance in it to build a profile
     * from. signAtlas writes clamp(0.5 + (R - d), 0, 1) with R = 1.95
     * texels, so it saturates half a texel inside the stroke: it is a coverage
     * mask with an antialiasing band, and everything more than one texel in is
     * flat 1.0. So the across-stroke coordinate is recovered by blurring —
     * four taps at one stroke half-width, which is the same trick the glow
     * proxy already uses to close the counters of a word, read here as a
     * ramp rather than as a shape. A point on the centreline keeps most of its
     * neighbours; a point on the edge loses half of them.
     */
    int row = int(vNeon.y + 0.5);
    float cap = vNeon.z;
    float wdt = cap * signAspect(row);
    float px = fwidth(vNuv.x) / max(cap, 1e-3);
    vec2 qs = vec2(vRect.x - wdt * 0.5, vRect.y);
    float ink = signInk(row, vec2((vNuv.x - qs.x) / wdt, (vNuv.y - qs.y) / cap), px, gMir);

    /* SGN_R is the bake's stroke half-width in cap heights. Offsetting by
     * exactly that puts a tap on the edge of the stroke when the sample is on
     * its centreline, which is what makes the average separate the two. */
    /* Unrolled. signInk takes an implicit-derivative texture fetch, and D3D
     * rejects a gradient instruction inside a loop it cannot prove has a
     * uniform trip count — "partial derivatives may have undefined value",
     * eight of them per capture. The four taps are a fixed cross; written out
     * they are the same instructions with none of the doubt. */
    const float SGN_R = 0.075;
    vec2 e = vec2(SGN_R * cap, 0.0);
    float wide = 0.2 * (ink
      + signInk(row, vec2((vNuv.x + e.x - qs.x) / wdt, (vNuv.y - qs.y) / cap), px, gMir)
      + signInk(row, vec2((vNuv.x - e.x - qs.x) / wdt, (vNuv.y - qs.y) / cap), px, gMir)
      + signInk(row, vec2((vNuv.x - qs.x) / wdt, (vNuv.y + e.x - qs.y) / cap), px, gMir)
      + signInk(row, vec2((vNuv.x - qs.x) / wdt, (vNuv.y - e.x - qs.y) / cap), px, gMir));

    /* Normalised distance from the centreline, then the same clamped 1/cos
     * chord the TUBE branch uses, divided by the same 1.48 so that this
     * redistributes the authored radiance instead of adding any: core 0.68x,
     * rails 3.4x, flux unchanged. The two models now agree by construction,
     * which is the point — the tube and the letters on the same sign have to
     * be the same glass.
     *
     * Folded out once the stroke is no longer resolvable. Past that every tap
     * returns the row's mean ink, wide stops describing a stroke, and
     * without the gate a sign at forty metres would take the rail value over
     * its whole area and get brighter as it got smaller. */
    float u = clamp(1.0 - (wide - 0.45) / 0.35, 0.0, 1.0);
    float chord = min(1.0 / max(sqrt(max(1.0 - u * u, 0.0)), 0.16), 5.0) / 1.48;
    chord = mix(1.0, chord, 1.0 - smoothstep(0.35, 1.10, px / (2.0 * SGN_R)));

    // The glass stands 25 mm off its tray, so it covers slightly more of the
    // frame than the ink does.
    float cov = smoothstep(0.06, 0.42, ink);
    gEmit = col * chord * cov;
    // The tray behind, which is matt black and stays black.
    diffuseColor.rgb = mix(vec3(0.0125, 0.0120, 0.0130), vec3(0.055), cov);
    roughnessFactor = mix(0.85, 0.22, cov);
    metalnessFactor = 0.0;

  } else if (part < 2.5){
    /* A SIGNAL ASPECT. One of three, switched by the shared cycle.
     *
     * The unlit two are not black. A signal lens in daylight is a deep
     * coloured glass with a fresnel lens moulded into it and a mirror behind:
     * it shows its own colour by reflection at maybe a fiftieth of the lit
     * level, which is what makes a dark aspect read as a lens rather than as a
     * hole. This is also the phantom effect that makes signals hard to read
     * into a low sun, and the sun is at 4.2 degrees behind the camera.
     */
    bool on = int(vNeon.y + 0.5) == signalAspect();
    // Fresnel rings, which are what a lens actually looks like close to.
    vec3 rp = vWPos - vRect.xyz;
    rp -= vAxis.xyz * dot(rp, vAxis.xyz);
    float rr = length(rp) / max(vAxis.w, 1e-3);
    float rings = 0.90 + 0.10 * cos(rr * 44.0);
    gEmit = on ? col * rings * (1.0 - 0.30 * rr * rr) : vec3(0.0);
    diffuseColor.rgb = col * (on ? 0.010 : 0.020);
    roughnessFactor = 0.16;
    metalnessFactor = 0.0;

  } else {
    /* THE CASE. Everything that holds the light up: sign boxes, brackets,
     * backboards, the signal post. Dark grey powder coat with the sun-facing
     * side chalked, which is the one weathering that shows on something this
     * small in frame. */
    float chalk = smoothstep(0.0, 0.8, vWN.y) * 0.55
      + 0.45 * unit(wfbm(vWPos.xz * 5.0 + vWPos.y * 3.0, 2));
    diffuseColor.rgb *= mix(vec3(0.0230, 0.0235, 0.0245),
                            vec3(0.0520, 0.0515, 0.0500), chalk * 0.6);
    roughnessFactor = 0.68;
    metalnessFactor = 0.18;
  }
}
`;

const NEON_END = /* glsl */ `
#include <lights_fragment_end>
reflectedLight.indirectDiffuse =
  canyonSky(reflectedLight.indirectDiffuse, vWN, vWPos.y) * 2.90;
${artificialAdd('vWN')}
`;

export function makeNeonMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1, metalness: 0,
    shadowSide: THREE.FrontSide, dithering: true,
  });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, signUniforms(), artificialUniforms());
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `
${FACADE_VARYINGS}
varying vec4 vNeon;
varying vec4 vNeonC4;
varying vec4 vRect;
varying vec4 vAxis;
varying vec2 vNuv;
attribute vec4 aNeon;
attribute vec3 aNeonC;
attribute vec4 aRect;
attribute vec4 aAxis;
void main() {`)
      .replace('#include <begin_vertex>', `${FACADE_VERTEX}
vNeon = aNeon; vNeonC4 = vec4(aNeonC, 0.0); vRect = aRect; vAxis = aAxis; vNuv = uv;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {',
        `${NOISE}\n${NEON_PARS}\n${signGLSL()}\n${CANYON}\n${ARTIFICIAL}\nvoid main() {`)
      .replace('#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>\n${NEON_BODY}`)
      /* The tube's normal has to be applied here rather than in the body: the
       * body runs before `normal_fragment_begin`, which would overwrite it
       * with the interpolated one. Same hook FACADE_NORMAL uses, same reason. */
      .replace('#include <normal_fragment_maps>',
        '#include <normal_fragment_maps>\n'
        + 'if (dot(gNormal, gNormal) > 0.5) normal = normalize(gNormal);')
      .replace('#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\ntotalEmissiveRadiance += gEmit;')
      .replace('#include <lights_fragment_end>', NEON_END);
  };
  m.customProgramCacheKey = () => 'sys5-neon';
  return m;
}

/* ── The near-field glow ──────────────────────────────────────────────────
 *
 * Additive, depth tested, depth-write off, drawn after everything opaque.
 *
 * This is not bloom and the difference is worth restating where the code is.
 * Bloom is a camera artefact: one kernel for the whole frame, applied to the
 * resolved image, and therefore leaking through whatever stands in front of
 * the source. This is a scene effect: the light scattered by the glass, by the
 * dust on the glass and by the first few centimetres of air around a tube. It
 * has a physical radius that scales with the tube, and it is occluded — the
 * mullion in front of the OPEN sign cuts it, which is the whole tell.
 *
 * The falloff is evaluated from the distance between the *view ray* and the
 * tube's axis segment rather than from anything on the proxy's surface. That
 * makes the proxy a pure bounding volume: its facet count, its radius and its
 * own shading are all invisible, six sides are enough, and the halo is
 * perfectly radially symmetric about the tube in screen space at any angle.
 *
 * MeshBasicMaterial rather than a raw ShaderMaterial so that the result goes
 * through three's tone mapping and output encoding chain. Tone mapping an
 * additive layer separately from its background is not the same as tone
 * mapping their sum, and at AgX's shoulder the difference is real; it is
 * accepted here because the alternative is a second render target, which is
 * System 8's business and not this system's.
 */
const GLOW_PARS = /* glsl */ `
varying vec3 vWPos;
varying vec3 vWN;
varying vec4 vGlow;
varying vec4 vGA;
varying vec4 vGP;
varying vec2 vGuv;
`;

const GLOW_BODY = /* glsl */ `
float gMir = signMirror(vGuv, vWN);
vec3 halo = vec3(0.0);
{
  float kind = vGP.w;
  if (kind > 0.5 && kind < 1.5){
    /* A LETTERING PANEL. The letterforms are ink in a plane rather than
     * modelled tubes, so there is no axis to measure from; the halo is the
     * same atlas read at four offsets of half a cap height and averaged, which
     * is a box blur wide enough to close the counters of the letters and turn
     * a word into the single soft shape a neon word actually makes. */
    int row = int(vGP.z + 0.5);
    float cap = vGlow.w;
    float wdt = cap * signAspect(row);
    float px = fwidth(vGuv.x) / max(cap, 1e-3);
    /* Written out rather than looped. signInk ends in an implicit-derivative
     * texture fetch and D3D will not accept a gradient instruction inside a
     * loop whose trip count it cannot prove uniform; it compiles, but it warns
     * that the derivatives may be undefined, and undefined derivatives here
     * mean the atlas picks its own mip. Five fixed taps cost nothing to spell
     * out and leave no such doubt. */
    float x0 = vGP.x - wdt * 0.5, d = 0.46 * cap;
    float ink = signInk(row, vec2((vGuv.x - x0) / wdt, (vGuv.y - vGP.y) / cap), px, gMir)
      + signInk(row, vec2((vGuv.x + d - x0) / wdt, (vGuv.y - vGP.y) / cap), px, gMir)
      + signInk(row, vec2((vGuv.x - d - x0) / wdt, (vGuv.y - vGP.y) / cap), px, gMir)
      + signInk(row, vec2((vGuv.x - x0) / wdt, (vGuv.y + d - vGP.y) / cap), px, gMir)
      + signInk(row, vec2((vGuv.x - x0) / wdt, (vGuv.y - d - vGP.y) / cap), px, gMir);
    halo = vGlow.rgb * (ink * 0.20);
  } else {
    /* A TUBE OR A LENS. Closest approach between the view ray and the axis
     * segment, clamped to the segment so the halo wraps the ends of the tube
     * instead of running off down its axis to infinity. */
    vec3 O = cameraPosition;
    vec3 D = normalize(vWPos - O);
    vec3 A = vGA.xyz;
    vec3 w0 = O - vGP.xyz;
    float b = dot(D, A);
    float den = 1.0 - b * b;
    float dd = dot(D, w0), e = dot(A, w0);
    float tc = den > 1e-4 ? (e - b * dd) / den : 0.0;
    tc = clamp(tc, -vGA.w, vGA.w);
    vec3 dx = (vGP.xyz + A * tc) - O;
    float dist = length(dx - D * dot(dx, D));

    float R = max(vGlow.w, 1e-3);
    float f = R / (R + dist);
    /* Reaching zero exactly at five core radii, which is where the proxy's
     * own surface is. The two have to agree: a falloff still above the dither
     * floor where the bounding geometry stops turns the proxy into a visible
     * solid, and that is not a subtle failure — it is a flat-shaded prism
     * hanging in front of the sign. */
    halo = vGlow.rgb * f * f * smoothstep(1.0, 0.34, dist / (R * 5.0));
  }
}
diffuseColor.rgb = halo;
diffuseColor.a = 1.0;
`;

export function makeGlowMaterial(): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    side: THREE.FrontSide,
    toneMapped: true,
  });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, signUniforms());
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `
varying vec3 vWPos;
varying vec3 vWN;
varying vec4 vGlow;
varying vec4 vGA;
varying vec4 vGP;
varying vec2 vGuv;
attribute vec4 aGlow;
attribute vec4 aGA;
attribute vec4 aGP;
void main() {`)
      /* `normal` rather than `objectNormal`: MeshBasicMaterial only includes
       * beginnormal_vertex when it has an environment map, so objectNormal
       * does not exist in this program. The attribute itself is always
       * declared by three's vertex prefix. */
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWN = normalize(mat3(modelMatrix) * normal);
vGlow = aGlow; vGA = aGA; vGP = aGP; vGuv = uv;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${GLOW_PARS}\n${signGLSL()}\nvoid main() {`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${GLOW_BODY}`);
  };
  m.customProgramCacheKey = () => 'sys5-glow';
  return m;
}
