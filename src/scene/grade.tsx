'use client';

/* System 8 — the final grade.
 *
 * ── Colour space, declared, because §2 of the technique brief requires it ──
 *
 *   input   sRGB-encoded, 8 bit, AgX already applied at exposure 0.296
 *   output  sRGB-encoded, 8 bit, to the canvas
 *
 * and internally the pass decodes to *display*-linear for the two operations
 * that are losses or gains of light, then re-encodes for the two that shape
 * density. Which is not the same thing as scene-linear, and the difference is
 * the whole reason this file needs a paragraph rather than a line.
 *
 * ── Why this is not the architecture §5.1 asks for ──
 *
 * §5.1 says to render the scene into a half-float MSAA target with a depth
 * texture, run the chain in scene-linear, and tone-map at the end. That is the
 * right architecture and it is not available to this pass today, for a reason
 * that is about ownership rather than about rendering:
 *
 * The moment the scene renders to a target instead of the canvas, three sets
 * NoToneMapping for the scene pass — which is exactly what an HDR pipeline
 * wants — and at that instant `haze.ts` becomes wrong. It tone-maps and
 * encodes its own sky radiance before mixing, precisely because the fog chunk
 * currently runs after the tone map. The brief states the fix in one sentence
 * and it is a five-line change. `haze.ts` belongs to System 6, which is
 * working in it tonight. Making a change of that kind in another system's file
 * hours before a deadline, where the failure mode is a silently double
 * tone-mapped sky that nobody would attribute to this pass, is a worse trade
 * than the one taken here.
 *
 * So the frame is grabbed off the canvas after it is finished, and this pass
 * does the display-referred two thirds of the chain. What that costs, stated
 * plainly rather than buried:
 *
 *   - No bloom. Veiling glare has to be added in radiance; added to a signal
 *     already compressed against white it can only push pixels past it.
 *   - No general depth of field. There is no depth buffer to read. What is
 *     here instead is analytic and is described at uCoc below — and the
 *     arithmetic in §5.5 says the honest answer for a phone at this framing is
 *     about one pixel, so this is much less of a loss than it sounds.
 *   - The ASC slope/offset/power and the crosstalk run in display-linear
 *     rather than scene-linear. For terms this small — a two per cent slope
 *     and a one-part-in-seven-hundred offset — the difference is well under a
 *     code value, and the road target they exist to hit is *stated* in display
 *     terms in NOTES.md, so this is arguably the more direct place to do it.
 *
 * Everything else in §5.2's list is here and in its stated order.
 *
 * ── Why it renders itself rather than using a composer ──
 *
 * One draw, one copy, no render target, no resize bookkeeping, and — the part
 * that matters — the scene pass is byte-for-byte the pass that produced every
 * screenshot in the archive. The grade can be switched off with ?nograde and
 * what comes back is the exact frame the existing set was judged through,
 * which is the property §5.4 insists on.
 */

import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { AGX_GLSL, makeSceneTarget, pipeFlags, useHdr } from './pipeline';
import { Volumetric } from './volumetric';
import { Bloom } from './bloom';
import { sunFollowState } from './sunFollow';

/* The look, as coefficients, so that switching it off is a swap of the whole
 * set rather than a branch in the shader. */
export interface Grade {
  /** ASC SOP, display-linear. */
  slope: [number, number, number];
  offset: [number, number, number];
  power: [number, number, number];
  /** Highlight crosstalk: amount, onset. */
  cross: [number, number];
  /** Print side, encoded: toe lift, midtone contrast, its pivot. */
  print: [number, number, number];
  /** Split tone, encoded. */
  shadow: [number, number, number];
  high: [number, number, number];
  /** cos^4 vignette strength. */
  vignette: number;
  /** Near-field defocus, in pixels at the closest ground the camera can see. */
  coc: number;
  /** Sensor grain: floor, dark-weighted amount, chroma blotch amount. */
  grain: [number, number, number];
}

export const GRADE: Grade = {
  /* The road instruction from NOTES.md, and it is the only part of this set
   * that is answering a measured target rather than a taste.
   *
   * The sunlit carriageway reads luminance 0.30 at saturation 0.35 and wants
   * 0.18 at 0.15, with the hue off pure orange. A global grade cannot select
   * the road, but it does not have to: what the road is too much of is *warm
   * saturation in the upper midtones*, and there is very little else in a
   * street canyon at this hour that lives there and is not also slightly too
   * orange. The three terms are the three ways of saying it — the slope pair
   * closes the red-blue gap multiplicatively, the offset pair does it
   * additively in the shadows where a multiplicative term has no purchase, and
   * the power pair bends the middle without moving either end.
   *
   * Signs are the reverse of the reference project's, which is stated in the
   * brief and is worth restating here because it is the one thing about this
   * set that would look like a mistake to someone reading it cold: this street
   * is *keeping* its shade blue against a warm sun, where the reference was
   * fighting a warm-olive palette away from cyan. */
  slope: [0.978, 1.0, 1.03],
  offset: [-0.002, 0.0, 0.0014],
  power: [1.008, 1.0, 0.99],
  cross: [0.11, 0.5],
  /* Toe, midtone contrast, pivot.
   *
   * The pivot is the one number here chosen against a measurement rather than
   * from the brief's starting point. The brief says to put it at the frame's
   * median, which `probe` gives as 0.26–0.32 depending on the stop, and at
   * that value the contrast term *lifts* the sunlit carriageway — which sits
   * at 0.45 to 0.51 — when NOTES.md's standing instruction for the road is to
   * bring its value down. Putting the pivot at 0.42 instead holds the lit road
   * almost exactly still and spends the whole of the contrast on deepening
   * everything below it, so the sun-to-shade separation grows without the road
   * getting brighter. Same term, opposite sign, from moving one number. */
  print: [0.006, 0.13, 0.42],
  shadow: [0.985, 0.995, 1.0],
  high: [1.0, 0.998, 0.992],
  vignette: 0.1,
  /* Gather radius at 1.5 m, in pixels, and the number is §5.5's table read at
   * that row rather than a strength.
   *
   * The table gives 5.6 px at 0.6 m, 3.2 at 1.0, 2.0 at 1.5, 0.9 at 2.6 and
   * nothing past three metres, for a 5.7 mm lens at f/1.7 focused at 8 m. It
   * is worth saying which quantity that is, because the two readings differ by
   * a factor of two and the difference is visible: the brief uses these values
   * as the reference project's `maxNearPx`, which is a gather *radius*, so
   * they are used as radii here. Read as diameters they would be half this.
   *
   * The curve below reproduces the rest of the table to about five per cent,
   * so this one number sets the whole of it, and a standing camera at this
   * pitch never sees ground closer than about two metres — where it works out
   * at 1.3 px. */
  coc: 2.0,
  /* Floor, dark-weighted amount, chroma blotch.
   *
   * The first two are sensor.ts's own numbers with the floor raised from
   * 0.00018, and the reason is measurement rather than taste. At the authored
   * floor the frozen-pair test returns a mean change of 0.017 code values over
   * the midtones and 98 per cent of pixels bit-identical between consecutive
   * frames — which is the failure §5.6 warns about in the reference project's
   * own words, grain "quantised away before it reached the file". A term that
   * cannot be measured is not present however carefully it is written. 0.0007
   * puts about a sixth of a code value of movement into the midtones, which is
   * still far below anything visible as texture and is enough that the frame
   * is alive rather than frozen. The dark weighting, which is where a phone's
   * noise actually lives, is untouched. */
  grain: [0.0007, 0.00105, 0.0006],
};

/** The identity, for ?nograde and for differenced measurement. */
export const NO_GRADE: Grade = {
  slope: [1, 1, 1], offset: [0, 0, 0], power: [1, 1, 1],
  cross: [0, 1], print: [0, 0, 0.34],
  shadow: [1, 1, 1], high: [1, 1, 1],
  vignette: 0, coc: 0, grain: [0, 0, 0],
};

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const FRAG = /* glsl */ `
precision highp float;

varying vec2 vUv;
uniform sampler2D tFrame;
uniform vec2  uTexel;
#ifdef HDR
  uniform sampler2D tVol;      // half-res in-scatter, .a = the depth it marched to
  uniform sampler2D tBloom;    // veiling glare, radiance
  uniform sampler2D tDepth;
  uniform vec2  uVolTexel;
  uniform vec2  uDepthRange;
  uniform float uRevDepth;
  uniform float uExposure;
  uniform float uBloom;
  uniform float uBloomNorm;
  uniform float uVol;
#endif
uniform vec3  uSlope, uOffset, uPower, uShadow, uHigh;
uniform vec2  uCross;
uniform vec3  uPrint;
uniform float uVignette;
uniform vec3  uGrain;
uniform float uSeed;
/* Near-field defocus, analytically.
 *
 * x is the circle of confusion in pixels at the nearest ground the camera can
 * see; y and z are the camera height above the ground and the tangent of the
 * pitch, which together turn a screen row into a distance without a depth
 * buffer. See the note in the component. */
uniform vec3  uCoc;

float srgbToLin(float c) {
  return c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4);
}
float linToSrgb(float c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * pow(c, 1.0 / 2.4) - 0.055;
}
vec3 srgbToLin(vec3 c) { return vec3(srgbToLin(c.r), srgbToLin(c.g), srgbToLin(c.b)); }
vec3 linToSrgb(vec3 c) { return vec3(linToSrgb(c.r), linToSrgb(c.g), linToSrgb(c.b)); }

float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float sstep(float a, float b, float x) {
  float t = clamp((x - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
vec3 hash3(vec2 p) {
  return fract(sin(vec3(dot(p, vec2(12.9898, 78.233)),
                        dot(p, vec2(39.3468, 11.135)),
                        dot(p, vec2(63.7264, 21.881)))) * 43758.5453) - 0.5;
}

#ifdef HDR
__AGX__

float viewZ(float d) {
  d = mix(d, 1.0 - d, uRevDepth);
  float n = uDepthRange.x, f = uDepthRange.y;
  return (2.0 * n * f) / (f + n - (d * 2.0 - 1.0) * (f - n));
}

/* Depth-aware upsample of the half-resolution march.
 *
 * A plain bilinear lift of a volumetric buffer bleeds it across every
 * silhouette in the frame — a shaft leaks a two-pixel halo onto the car in
 * front of it, which is the single most recognisable artifact of a half-res
 * volumetric and reads as a compositing error rather than as light. The four
 * contributing texels each carry the depth they were marched to in .a, so a
 * texel that belongs to a different surface can be rejected instead.
 *
 * The bilinear weights are kept and multiplied by the depth agreement rather
 * than replaced by it, so in the overwhelmingly common case where all four
 * agree this is exactly bilinear and costs three extra taps.
 */
vec3 volumeAt(float z) {
  vec2 p = vUv / uVolTexel - 0.5;
  vec2 i = floor(p), fr = fract(p);
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int y = 0; y < 2; y++) {
    for (int x = 0; x < 2; x++) {
      vec2 o = vec2(float(x), float(y));
      vec4 s = texture2D(tVol, (i + o + 0.5) * uVolTexel);
      float wb = mix(1.0 - fr.x, fr.x, o.x) * mix(1.0 - fr.y, fr.y, o.y);
      // Tolerance proportional to range: half a metre at the kerb, five at the
      // end of the street, which is roughly the depth complexity at each.
      float w = wb / (1.0 + abs(s.a - z) / (0.02 * z + 0.4));
      sum += s.rgb * w;
      wsum += w;
    }
  }
  return sum / max(wsum, 1e-4);
}
#endif

void main() {
  /* ── 1. Defocus ─────────────────────────────────────────────────────────
   *
   * A phone's near field, and nothing else. §5.5 works the optics out: a
   * 5.7 mm lens at f/1.7 focused at 8 m has a circle of confusion of 5.6 px at
   * 0.6 m, 0.9 px at 2.6 m and nothing at all beyond three metres — the far
   * field never reaches a pixel, so there is no far branch to write.
   *
   * With no depth buffer the distance has to come from somewhere, and for the
   * only part of the frame where the effect is non-zero it is free: the bottom
   * of a standing frame is ground, and the distance to the ground along a view
   * ray is the camera's height over the tangent of the ray's declination. That
   * is exact for the road and the footway, wrong for anything standing on
   * them — but a bollard at two metres is at two metres whether the ray
   * continued to the paving or not, so the error is the height of the object
   * over the distance to it, and at the only place this term is non-zero the
   * frame is paving.
   *
   * The whole thing is worth about a pixel and a half at the very bottom row
   * and is zero over nine tenths of the frame. That is the correct size: §5.5
   * ends by saying that if a reviewer can name it, it is too strong. */
  float coc = 0.0;
  if (uCoc.x > 0.0) {
    // Declination of this pixel's ray below the horizon, small-angle, in the
    // same units as the pitch tangent the component passes in.
    float dec = uCoc.z + (0.5 - vUv.y) * 0.828;
    float dist = dec > 0.02 ? uCoc.y / dec : 1e4;
    // 5.7 mm at f/1.7 focused at 8 m, normalised so uCoc.x is the radius at
    // the nearest ground a standing camera can see.
    // Reciprocal distance, which is what a defocus is actually linear in, and
    // it reproduces §5.5's table within five per cent from one coefficient.
    coc = uCoc.x * clamp((1.0 / max(dist, 0.35) - 1.0 / 8.0) / (1.0 / 1.5 - 1.0 / 8.0), 0.0, 1.7);
  }

  vec3 src;
  if (coc > 0.15) {
    /* Four taps on a rotated cross at the CoC radius, plus the centre. At a
     * radius of one to two pixels a spiral of six is indistinguishable from
     * this and costs six samples; the golden-angle table §5.5 recommends earns
     * its keep at sixteen pixels, not at two. */
    vec2 r = coc * uTexel;
    src = texture2D(tFrame, vUv).rgb * 0.36
        + texture2D(tFrame, vUv + vec2( r.x,  0.0)).rgb * 0.16
        + texture2D(tFrame, vUv + vec2(-r.x,  0.0)).rgb * 0.16
        + texture2D(tFrame, vUv + vec2( 0.0,  r.y)).rgb * 0.16
        + texture2D(tFrame, vUv + vec2( 0.0, -r.y)).rgb * 0.16;
  } else {
    src = texture2D(tFrame, vUv).rgb;
  }

  /* ── 2. Scene-referred atmosphere and lens, then the one tone map ───────
   *
   * Everything between here and the AgX call is radiance, and everything after
   * it is display-linear. That boundary is the entire reason pipeline.ts
   * exists, and the order across it is the physical order: the air scatters
   * light into the ray, the lens smears a fraction of what reaches it, and
   * only then does a sensor with a finite range have an opinion about any of
   * it.
   *
   * On the ?nohdr path none of this compiles and c is the decoded canvas,
   * which is the pass exactly as the screenshot archive was judged through.
   *
   * The pedestal is sensor.ts's, moved. It is a black point in the signal a
   * sensor hands over — display-referred by construction — and prepending it
   * to colorspace_fragment would add four thousandths of *radiance* to every
   * fragment when the scene renders into a linear target. The coefficients are
   * unchanged and it lands at the same point in the chain it was calibrated
   * for: after the tone curve, before the grade. */
#ifdef HDR
  float z = viewZ(texture2D(tDepth, vUv).r);
  src = max(src + volumeAt(z) * uVol, 0.0);

  /* Veiling glare, energy conserving. A lens redistributes light, it does not
   * manufacture it, so the frame keeps 1 - uBloom of itself and the pyramid
   * supplies the rest. Written as a mix rather than an add for that reason:
   * an additive veil brightens the whole frame by its own mean, which on this
   * scene is a fifth of a stop of exposure nobody asked for.
   *
   * uBloomNorm is what makes that claim true rather than merely stated. The
   * pyramid accumulates six octaves additively, each of which preserves the
   * mean, so without it the veil arrives with several times the frame's mean
   * and the mix is an exposure lift wearing a redistribution's clothes. See
   * Bloom.norm. */
  src = mix(src, texture2D(tBloom, vUv).rgb * uBloomNorm, uBloom);

  vec3 c = agx(src, uExposure) * 0.955 + vec3(0.0040, 0.0046, 0.0070);
#else
  vec3 c = srgbToLin(src);
#endif

  /* ── 3. Linear grade ────────────────────────────────────────────────────
   *
   * Crosstalk first. A renderer's brightest pixels are its most saturated ones
   * because saturation is a surface property and brightness only multiplies
   * it; film does the opposite. AgX already does most of this — it was chosen
   * for holding hue into the clip — so the amount here is half the reference
   * project's, and the weight is read off the *exposed* value rather than the
   * scene value, which is their fix for a term that otherwise fires hardest on
   * things about to become middle grey. */
  float y0 = luma(c);
  float xt = uCross.x * sstep(uCross.y, 1.0, y0);
  c = mix(c, vec3(y0), xt);

  // ASC slope / offset / power. See GRADE for why the signs are the reverse of
  // the reference project's.
  c = max(c * uSlope + uOffset, 0.0);
  c = pow(c, uPower);

  /* ── 5. Vignette ────────────────────────────────────────────────────────
   *
   * cos^4 and nothing else, and in linear because this is the only operation
   * in the pass that is a genuine loss of light rather than a shaping of
   * density. Kept to a tenth: the directional haze already does large-scale
   * luminance shaping keyed to the sun, and a second falloff keyed to the
   * frame would fight it and read as a smudge in the sun-side corner. A phone
   * lens vignettes harder than this and every phone's ISP takes most of it
   * back out again; the residual is three to six per cent. */
  vec2 d = vUv - 0.5;
  c *= 1.0 - uVignette * pow(clamp(length(d) * 1.42, 0.0, 1.0), 4.0);

  // ── 6. Encode. Everything below here is density, not light. ──────────────
  c = linToSrgb(max(c, 0.0));

  /* ── 7. Print grade ─────────────────────────────────────────────────────
   *
   * Toe first: a small lift of the floor, applied encoded. The reference
   * project's note on this is the most expensive lesson in their file — the
   * same lift applied in linear put the floor at thirty-two code values rather
   * than four and "looked like someone had left a light on behind the camera".
   * AgX already has a long toe, so this is a quarter of their number. */
  c = c * (1.0 - uPrint.x) + uPrint.x;

  /* Midtone contrast, which is the term with the most to give here: AgX was
   * accepted with a flatter midtone on the explicit promise that this pass
   * would put it back.
   *
   * Two details are load-bearing. The weight is a plateau rather than a
   * parabola, because a parabola is still at two thirds of its height at 0.8
   * and would lift the sun's halo. And it is applied to luminance with the
   * channels carried along in proportion rather than per channel, because
   * per-channel contrast also raises saturation by an amount that depends on
   * what colour the pixel happened to be — which is the one thing this grade
   * is under instruction to reduce. */
  float y = luma(c);
  /* The plateau, and its lower edge is measured rather than copied.
   *
   * The brief's (0.02, 0.16) opens the term fully by the sixth of the range,
   * which in this frame is the shaded frontage — a surface System 5 authored
   * against a measured radiance. At contrast 0.20 and a pivot of 0.42 that
   * took a shaded wall from 44 code values to 28, which is two thirds of a
   * stop of someone else's work removed by a term that is supposed to be
   * shaping midtones. Raising the edge to (0.08, 0.26) leaves the shadow floor
   * where it was authored and still has the whole of the true midtone.
   *
   * The upper edge is the brief's, unchanged, and for its stated reason: a
   * parabola would still be at two thirds of its height at 0.8 and would lift
   * the sun's halo. */
  float w = sstep(0.08, 0.26, y) * sstep(0.88, 0.50, y);
  float yc = uPrint.z + (y - uPrint.z) * (1.0 + uPrint.y * w);
  c *= yc / max(y, 1e-4);

  /* Split tone. The reference project's rule inverted: a jungle's shade is lit
   * by light that has been through leaves and is warm, a street canyon's shade
   * is lit by sky and nothing else. Cool shadows, neutral highlights. */
  float sw = 1.0 - sstep(0.0, 0.55, y);
  c *= mix(vec3(1.0), uShadow, sw) * mix(vec3(1.0), uHigh, 1.0 - sw);

  /* ── 8. Sensor noise ────────────────────────────────────────────────────
   *
   * Moved here from sensor.ts, which is where it has to be: as it stood the
   * grade would amplify or crush the noise the sensor was calibrated against,
   * and both the toe and the midtone plateau above act hardest exactly where
   * the noise lives.
   *
   * It also gains the one thing it was missing. The walk harness measured a
   * parked camera as bit-identical over nine regions — mean change 0.00 — and
   * the reason is that the hash was keyed to gl_FragCoord with no time in it.
   * A sensor's read noise is fixed to the sensor and redrawn every frame; a
   * pattern fixed to the sensor and never redrawn is dirt on the glass, which
   * is what it read as over a moving image. uSeed is the frame count, so it is
   * still anchored to the sensor rather than to the world — that part was
   * right and is deliberately kept — and it is now a different draw every
   * frame.
   *
   * The model is unchanged otherwise, because §5.6 is emphatic that it is
   * already the right one: three independent channels rather than a shared
   * luminance term, because the signature of a phone is coloured speckle and
   * not emulsion, and a fourth-power dark weighting because read noise is
   * roughly constant in absolute terms while the signal is not. */
  vec2 fc = gl_FragCoord.xy;
  float lum = luma(c);
  float dark = 1.0 - sstep(0.0, 0.22, lum);
  float d2 = dark * dark;
  vec3 rnd = hash3(fc + uSeed);
  c = max(c + rnd * (uGrain.x + uGrain.y * d2 * d2), 0.0);

  /* Chroma blotch: demosaicing a starved red or blue channel gives coloured
   * mottle several pixels across, which is a different thing from speckle and
   * is why this one is sampled on a seven-pixel grid and smoothed. Luminance
   * mean removed so it tints rather than brightens. */
  vec2 cg = fc / 7.0;
  vec2 ci = floor(cg), cf = fract(cg);
  cf = cf * cf * (3.0 - 2.0 * cf);
  vec3 blot = mix(mix(hash3(ci + uSeed * 1.7), hash3(ci + vec2(1.0, 0.0) + uSeed * 1.7), cf.x),
                  mix(hash3(ci + vec2(0.0, 1.0) + uSeed * 1.7), hash3(ci + vec2(1.0) + uSeed * 1.7), cf.x), cf.y);
  blot -= dot(blot, vec3(0.3333));
  c = max(c + blot * uGrain.z * (0.27 + d2 * d2), 0.0);

  /* ── 9. Ordered dither, the last statement in the frame ─────────────────
   *
   * Sized by differentiating the sRGB transfer curve, so it is one half of a
   * code value at the local signal level rather than a fixed fraction — the
   * smallest amount that can remove banding and the largest that stays
   * invisible. Deliberately *not* reseeded per frame: a dither that changes
   * every frame is a second, finer grain, and there is already a grain. */
  float step8 = 0.00392 * 2.2755 * pow(max(lum, 1e-5), 0.5833);
  gl_FragColor = vec4(max(c + hash3(fc + 0.5) * step8, 0.0), 1.0);
}
`;

/* Whether to grade at all, and how hard, from the URL.
 *
 * ?nograde returns the exact frame the screenshot archive was judged through,
 * which is the property the brief insists on: the way back to the signed-off
 * curve must be a swap of the whole coefficient set and never a branch. */
function gradeFromUrl(): Grade {
  if (typeof location === 'undefined') return GRADE;
  const s = location.search;
  if (s.includes('nograde')) return NO_GRADE;
  const g: Grade = { ...GRADE };
  if (s.includes('nograin')) g.grain = [0, 0, 0];
  if (s.includes('nococ')) g.coc = 0;
  if (s.includes('novig')) g.vignette = 0;
  return g;
}

export function Grade() {
  const { gl, scene, camera, size, viewport } = useThree();
  const g = useMemo(gradeFromUrl, []);
  const flags = useMemo(pipeFlags, []);
  const hdr = useMemo(useHdr, []);
  /* Nothing left to do — ?nograde, and the identity set. The pass still owns
   * the frame loop, because handing it back conditionally would mean the two
   * builds differ in more than their coefficients. */
  const inert = g.vignette === 0 && g.coc === 0 && g.grain[1] === 0 && g.print[1] === 0;

  /* A FramebufferTexture rather than a plain one: it is the only Texture three
   * will let copyFramebufferToTexture allocate storage for without an image,
   * and it is sized to the drawing buffer below.
   *
   * NoColorSpace on purpose. The canvas holds sRGB-encoded bytes and this pass
   * decodes them itself, in the shader, where the decode can be placed exactly
   * between the operations that need light and the ones that need density.
   * Letting three insert the decode would put it before everything, which is
   * the wrong side of the print grade. */
  const target = useMemo(() => {
    const t = new THREE.FramebufferTexture(2, 2);
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.colorSpace = THREE.NoColorSpace;
    return t;
  }, []);

  /* The linear pipeline's own resources. Allocated at 2x2 and sized by the
   * same effect that sizes the framebuffer copy, so there is one place that
   * knows the drawing buffer's dimensions. */
  const rig = useMemo(() => {
    if (!hdr) return null;
    return {
      scene: makeSceneTarget(2, 2),
      vol: new Volumetric(2, 2),
      bloom: new Bloom(2, 2),
    };
  }, [hdr]);
  useEffect(() => () => {
    rig?.scene.dispose();
    rig?.scene.depthTexture?.dispose();
    rig?.vol.dispose();
    rig?.bloom.dispose();
  }, [rig]);

  const uniforms = useMemo(() => ({
    tFrame: { value: (rig ? rig.scene.texture : target) as THREE.Texture },
    uTexel: { value: new THREE.Vector2() },
    ...(rig ? {
      tVol: { value: rig.vol.target.texture },
      tBloom: { value: rig.bloom.texture },
      tDepth: { value: rig.scene.depthTexture as THREE.Texture },
      uVolTexel: { value: new THREE.Vector2() },
      uDepthRange: { value: new THREE.Vector2(0.05, 400) },
      uRevDepth: { value: 0 },
      uExposure: { value: 1 },
      uBloom: { value: flags.has('nobloom') ? 0 : BLOOM },
      uBloomNorm: { value: rig ? rig.bloom.norm : 1 },
      uVol: { value: flags.has('novol') ? 0 : 1 },
    } : {}),
    uSlope: { value: new THREE.Vector3(...g.slope) },
    uOffset: { value: new THREE.Vector3(...g.offset) },
    uPower: { value: new THREE.Vector3(...g.power) },
    uCross: { value: new THREE.Vector2(...g.cross) },
    uPrint: { value: new THREE.Vector3(...g.print) },
    uShadow: { value: new THREE.Vector3(...g.shadow) },
    uHigh: { value: new THREE.Vector3(...g.high) },
    uVignette: { value: g.vignette },
    uGrain: { value: new THREE.Vector3(...g.grain) },
    uCoc: { value: new THREE.Vector3(g.coc, 1.65, 0) },
    uSeed: { value: 0 },
  }), [g, target, rig, flags]);

  const quad = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    // One triangle covering the clip cube. Two triangles would put a seam down
    // the diagonal for the derivative-using taps and cost an extra vertex.
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2));
    /* ShaderMaterial rather than RawShaderMaterial, and it matters: a raw
     * material would have to declare the GLSL version and the attributes by
     * hand, and — the part that would be a real bug — nothing in this file
     * includes three's chunks, so `colorspace_fragment` is not run here. That
     * is deliberate. sensor.ts patches that chunk, and if it ran again on the
     * post quad the pedestal and the noise would be applied to the frame a
     * second time. */
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG.replace('__AGX__', AGX_GLSL),
      uniforms,
      defines: hdr ? { HDR: '' } : {},
      depthTest: false,
      depthWrite: false,
      /* Without this three generates its own `toneMapping()` into the program
       * prefix — the quad draws to the canvas, so the renderer's AgX applies —
       * and the frame would be tone-mapped twice. The one in the body is
       * placed deliberately; this one is not wanted. */
      toneMapped: false,
    });
    return new THREE.Mesh(geo, mat);
  }, [uniforms, hdr]);

  const cam = useMemo(() => new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), []);
  const post = useMemo(() => new THREE.Scene(), []);
  useEffect(() => { post.add(quad); return () => { post.remove(quad); }; }, [post, quad]);

  const frames = useRef(0);

  /* Every PNG this project has ever produced comes out of `renderOnce`.
   *
   * `tools/harness.mjs`'s capture() calls `window.__scene.renderOnce()` and
   * then reads the canvas, and renderOnce is `apply(); gl.render(scene,
   * camera)` — the scene pass and nothing else. So a post pass that lives in
   * the frame loop is live on screen, live in anything that steps the clock
   * and reads pixels, and *absent from every screenshot*. That is the precise
   * shape of failure this project has paid for twice: a change that is correct
   * and never reaches the artefact anyone looks at.
   *
   * The obvious fix is three lines in Rig.tsx, and Rig.tsx belongs to the
   * collision pass, which is editing it tonight. So the hook is taken from
   * this side instead: wrap the published function, restore it on unmount, and
   * leave the original reachable as renderScene() for anything that genuinely
   * wants the ungraded pass. Dev only, because the debug API is dev only. */
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    /* Published before the guard below, not after it.
     *
     * These two used to sit at the bottom of this effect, past an early return
     * that fires when `window.__scene` has not been created yet — and whether
     * it has depends on whether Rig's effect happened to run before this one,
     * which is mount order and not something either file controls. The result
     * was a debug surface that existed on most loads and was absent on some,
     * and a tool that reported "is Grade mounted?" about a mounted Grade. */
    (window as unknown as { __grade?: unknown }).__grade = { grade: g, uniforms };
    /* The veil's own controls, switchable on a mounted scene. `uBloom` is a
     * uniform and was already reachable; the firefly guard was a literal
     * inside the pyramid, so whether it was suppressing the one source in this
     * scene that is supposed to produce glare could not be asked. */
    (window as unknown as { __bloom?: unknown }).__bloom = rig ? {
      get karis() { return rig.bloom.karis; },
      set karis(v: number) { rig.bloom.karis = v; },
      get gain() { return rig.bloom.gain; },
      set gain(v: number) { rig.bloom.gain = v; },
      get norm() { return rig.bloom.norm; },
    } : null;
    /* The scene in radiance, which until now nothing outside the volumetric
     * could read.
     *
     * Every instrument in tools/ meters the canvas, which is AgX of the frame
     * — a curve with a hard clamp at both ends and a shoulder that compresses
     * two radiances into one code value. That is the correct thing to measure
     * a *look* with and the wrong thing to measure a *light* with, and it is
     * why the two tools that wanted radiance both ended up re-rendering the
     * scene through a substitute tone map and arguing about the exposure.
     *
     * `rig.scene` already holds exactly what is wanted: the scene pass, in
     * linear sRGB radiance, before bloom, before the grade and before AgX.
     * This reads it back.
     *
     *  - Uint16Array and a manual half decode. Handing three a Float32Array
     *    for a HalfFloatType target returns zeroes with no error, which is
     *    indistinguishable from a pass that drew nothing; the same trap the
     *    volumetric probe records above.
     *  - Coordinates are GL's, so v = 0 is the bottom of the frame. Stated
     *    because a region that is not what its name says has cost this project
     *    three conclusions.
     *  - The target is 4x multisampled; three resolves into the single-sample
     *    framebuffer when the target is unbound, which has happened by the time
     *    anything can call this.
     *  - It reports `n` and the rect it actually read, so a probe that has
     *    been handed a degenerate box says so instead of returning a mean of
     *    one pixel. */
    (window as unknown as { __hdr?: unknown }).__hdr = rig ? {
      get size() { return [rig.scene.width, rig.scene.height] as [number, number]; },
      /** Mean, peak and clip counts of one rect, in scene radiance. uv, v up. */
      rect(u0 = 0, v0 = 0, u1 = 1, v1 = 1, clipAt = 0) {
        const W = rig.scene.width, H = rig.scene.height;
        const x = Math.max(0, Math.min(W - 1, Math.round(u0 * W)));
        const y = Math.max(0, Math.min(H - 1, Math.round(v0 * H)));
        const w = Math.max(1, Math.min(W - x, Math.round((u1 - u0) * W)));
        const h = Math.max(1, Math.min(H - y, Math.round((v1 - v0) * H)));
        const buf = new Uint16Array(w * h * 4);
        gl.readRenderTargetPixels(rig.scene, x, y, w, h, buf);
        const half = (hf: number) => {
          const s = hf >> 15 ? -1 : 1, e = (hf >> 10) & 31, f = hf & 1023;
          if (e === 0) return s * f * 2 ** -24;
          if (e === 31) return f ? NaN : s * Infinity;
          return s * (1 + f / 1024) * 2 ** (e - 15);
        };
        let r = 0, gg = 0, b = 0, peak = 0, over = 0, px = -1, py = -1;
        const lums: number[] = [];
        for (let i = 0; i < w * h; i++) {
          const cr = half(buf[i * 4]), cg = half(buf[i * 4 + 1]), cb = half(buf[i * 4 + 2]);
          r += cr; gg += cg; b += cb;
          const l = 0.2126 * cr + 0.7152 * cg + 0.0722 * cb;
          lums.push(l);
          /* Where the peak is, not just what it is. A brightest-pixel figure
           * with no coordinate cannot distinguish the solar disc from a
           * clearcoat glint, and this project has already spent conclusions on
           * regions that were not what their name said. */
          if (l > peak) { peak = l; px = x + (i % w); py = y + Math.floor(i / w); }
          if (clipAt > 0 && Math.max(cr, cg, cb) >= clipAt) over++;
        }
        lums.sort((a, c) => a - c);
        const q = (p: number) => lums[Math.min(lums.length - 1, Math.floor(p * lums.length))];
        const n = w * h;
        return {
          rect: [x, y, w, h] as [number, number, number, number],
          n,
          mean: [r / n, gg / n, b / n] as [number, number, number],
          lum: { p10: q(0.1), median: q(0.5), p90: q(0.9), p99: q(0.99), peak },
          peakAt: [px, py] as [number, number],
          over,
        };
      },
    } : null;
    (window as unknown as { __vol?: unknown }).__vol = rig
      ? { get cones() { return rig.vol.lastConeCount; },
          get shadow() { return rig.vol.lastShadow; },
          get air() { return rig.vol.lastAir; },
          /* The analytic occluder's planes, so a tool can hold a measured
           * shaft against the gap that is supposed to cast it. */
          get gap() { return rig.vol.lastGap; },
          get follow() { return sunFollowState; },
          /* The subtractive gain, writable, so it can be swept without a
           * reload. It lives on the march's own material rather than on the
           * grade's, and a tool reaching for window.__grade.uniforms.uSunShare
           * gets undefined and sweeps nothing while printing a table that looks
           * like a result. */
          get gain() { return rig.vol.gain; },
          set gain(v: number) { rig.vol.gain = v; },
          set debug(v: number) { rig.vol.debug = v; },
          /* The two halves of the pass, switchable independently. `uVol`
           * drops both, so anything differenced against it measures the
           * shafts and the lamp cones together — which is how the shafts were
           * last reported to sweep under motion when it was the cones. */
          get sunOn() { return rig.vol.sunOn; },
          set sunOn(v: number) { rig.vol.sunOn = v; },
          get coneGain() { return rig.vol.coneGain; },
          set coneGain(v: number) { rig.vol.coneGain = v; },
          /* One texel of the march's own output, in its own units: rgb is the
           * signed in-scatter it wrote and a is the view depth it marched to.
           * Added because a gate on that depth failed silently and reading the
           * canvas cannot distinguish "the gate is wrong" from "the gate is
           * right and the term is small". */
          probe(u: number, v: number) {
            const t = rig.vol.target;
            /* Uint16Array and a manual decode, because the target is
             * HalfFloatType and three matches the readback buffer to the
             * texture type — handing it a Float32Array returned four zeroes for
             * every texel, which is indistinguishable from a march that wrote
             * nothing and cost an hour to tell apart. */
            const buf = new Uint16Array(4);
            gl.readRenderTargetPixels(t, Math.round(u * t.width),
              Math.round(v * t.height), 1, 1, buf);
            const half = (h: number) => {
              const s = h >> 15 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
              if (e === 0) return s * f * 2 ** -24;
              if (e === 31) return f ? NaN : s * Infinity;
              return s * (1 + f / 1024) * 2 ** (e - 15);
            };
            return { r: half(buf[0]), g: half(buf[1]), b: half(buf[2]), vz: half(buf[3]) };
          },
          /* A whole row of the march, so the *gradient* across a shaft boundary
           * can be measured rather than its brightness. A beam is legible
           * because of that edge; a term that is strong and has no edge is fog,
           * and the two are indistinguishable in a screenshot and in every
           * region-mean statistic. */
          probeRow(v: number) {
            const t = rig.vol.target;
            const buf = new Uint16Array(t.width * 4);
            gl.readRenderTargetPixels(t, 0, Math.round(v * t.height), t.width, 1, buf);
            const half = (h: number) => {
              const s = h >> 15 ? -1 : 1, e = (h >> 10) & 31, f = h & 1023;
              if (e === 0) return s * f * 2 ** -24;
              if (e === 31) return f ? NaN : s * Infinity;
              return s * (1 + f / 1024) * 2 ** (e - 15);
            };
            const out = new Array<number>(t.width);
            for (let i = 0; i < t.width; i++) {
              out[i] = 0.2126 * half(buf[i * 4]) + 0.7152 * half(buf[i * 4 + 1])
                + 0.0722 * half(buf[i * 4 + 2]);
            }
            return out;
          } }
      : null;

    const s = (window as unknown as { __scene?: Record<string, unknown> }).__scene;
    if (!s || typeof s.renderOnce !== 'function') return;
    const original = s.renderOnce as () => void;
    s.renderScene = original;
    /* `original` is `apply(); gl.render(scene, camera)` and it renders into
     * whatever target is currently bound, so binding one around it is enough
     * to redirect it — no edit to Rig.tsx, and no second scene render. Letting
     * it draw to the canvas instead would compile a *second* set of programs
     * for every material in the scene, because three's program cache is keyed
     * on tone mapping and the canvas is tone-mapped where the target is not.
     * That is the 15-second cold start defect from docs/COLDSTART.md, in a new
     * hat, and it would only appear when capturing. */
    s.renderOnce = () => {
      if (rig) gl.setRenderTarget(rig.scene);
      original();
      if (rig) gl.setRenderTarget(null);
      draw();
    };
    return () => { s.renderOnce = original; delete s.renderScene; };
  });

  /* Sized to the drawing buffer rather than to CSS pixels: the copy is a
   * texture the same shape as the framebuffer, and getting this wrong is a
   * half-pixel offset that reads as a soft frame nobody can explain. */
  useEffect(() => {
    const buf = new THREE.Vector2();
    gl.getDrawingBufferSize(buf);
    const w = Math.max(2, Math.floor(buf.x)), h = Math.max(2, Math.floor(buf.y));
    target.image.width = w;
    target.image.height = h;
    target.dispose();
    uniforms.uTexel.value.set(1 / w, 1 / h);
    if (rig) {
      rig.scene.setSize(w, h);
      rig.vol.setSize(w, h);
      rig.bloom.setSize(w, h);
      uniforms.uVolTexel!.value.set(1 / rig.vol.target.width, 1 / rig.vol.target.height);
      /* The depth texture is recreated by setSize, so the uniform has to be
       * re-pointed. Holding the old one is a black depth buffer at every
       * resize and a march that stops at the near plane. */
      uniforms.tDepth!.value = rig.scene.depthTexture as THREE.Texture;
      uniforms.tFrame.value = rig.scene.texture;
      uniforms.tBloom!.value = rig.bloom.texture;
      uniforms.uBloomNorm!.value = rig.bloom.norm;
    }
  }, [gl, size, viewport.dpr, target, uniforms, rig]);

  /* The post pass on whatever is currently in the canvas. Separated from the
   * frame callback so that renderOnce can reach it too. */
  const draw = () => {
    if (inert && !hdr) return;

    /* Pitch, for the ground-distance solve in the defocus. Taken off the
     * camera each time rather than assumed, because the eye is no longer at a
     * constant height — it follows the kerb — and it looks where the mouse
     * points. */
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    uniforms.uCoc.value.set(g.coc, Math.max(camera.position.y, 0.2), Math.tan(-e.x));
    uniforms.uSeed.value = (frames.current++ % 1024) * 7.13;

    if (rig) {
      const pc = camera as THREE.PerspectiveCamera;
      uniforms.uExposure!.value = gl.toneMappingExposure;
      uniforms.uDepthRange!.value.set(pc.near, pc.far);
      uniforms.uRevDepth!.value =
        (gl as unknown as { reversedDepthBuffer?: boolean }).reversedDepthBuffer ? 1 : 0;

      if (uniforms.uVol!.value > 0) {
        rig.vol.render(gl, scene as THREE.Scene, pc,
          rig.scene.depthTexture as THREE.Texture, frames.current);
      }
      if (uniforms.uBloom!.value > 0) {
        rig.bloom.render(gl, rig.scene.texture);
        /* Read back from the pyramid every draw rather than only on resize.
         * The normalisation is a function of the per-octave gain, and the gain
         * is now settable — a veil swept without this is a veil whose energy
         * conservation is describing the previous setting. */
        uniforms.uBloomNorm!.value = rig.bloom.norm;
      }
      gl.setRenderTarget(null);
    } else {
      gl.copyFramebufferToTexture(target);
    }
    gl.render(post, cam);
  };

  useFrame(() => {
    /* Draw-call accounting, first, and this is not housekeeping.
     *
     * three resets `renderer.info` at the top of every render, so with several
     * renders per frame the counters a tool reads afterwards describe the last
     * one — this pass's single triangle. Every report in the project that
     * prints `calls=` and `tris=` would silently start saying 1 and 0, which is
     * exactly the kind of instrument failure that gets read as a scene failure
     * at four in the morning. Reset once, here, and let every render
     * accumulate into it. */
    gl.info.autoReset = false;
    gl.info.reset();

    /* First-frame evidence, recorded once and only in development.
     *
     * docs/COLDSTART.md's defect was that installHaze rewrote THREE.ShaderChunk
     * from an effect, which lands *after* r3f has drawn — so the first frame
     * anyone could see carried three's stock fog instead of this scene's
     * atmosphere, and every material compiled twice. Street.tsx's fix moved the
     * call into a useMemo. This is the assertion that it worked, taken at the
     * only moment when the answer is meaningful: the top of the first render,
     * before this line has drawn anything.
     *
     * Reading the guard flag rather than a timestamp, because the question is
     * not when installHaze ran but whether the chunk was patched when the first
     * program was built, and the flag is the thing the patch sets. */
    if (process.env.NODE_ENV === 'development' && frames.current === 0) {
      const chunks = THREE.ShaderChunk as unknown as Record<string, unknown>;
      (window as unknown as { __firstFrame?: unknown }).__firstFrame = {
        hazeInstalled: chunks.__hazeInstalled === true,
        fogChunkPatched: String(chunks.fog_fragment).includes('hazeSky'),
        sensorPatched: String(chunks.colorspace_fragment).includes('0.0070'),
        hdr: !!rig,
      };
    }

    /* The scene pass. Into the linear target by default; straight to the
     * canvas on `?nohdr`, where the renderer tone-maps it and `?nograde` is
     * byte-exact against the archive. */
    if (rig) gl.setRenderTarget(rig.scene);
    gl.render(scene, camera);
    if (rig) gl.setRenderTarget(null);
    draw();
  }, 1);

  return null;
}

/* The fraction of the frame the lens redistributes. §5.3's number.
 *
 * Held loosely on purpose: the lighting agent is restoring the sun to a
 * calibrated hero setting and a veil tuned against the current one would have
 * to be thrown away. Being a *fraction* rather than a threshold, it should
 * largely track a sun change on its own, which is most of the argument for
 * writing it this way. */
const BLOOM = 0.045;
