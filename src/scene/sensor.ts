/* The sensor floor.
 *
 * A renderer's idea of black is zero, and zero is the one value a camera can
 * never produce. Below a few percent a phone sensor is reporting mostly its own
 * read noise: the darks come out as a muddy, slightly blue-shifted grey full of
 * coloured speckle, never as flat nothing. Rendering mathematically clean black
 * is instantly recognisable as synthetic even when nothing else in the frame
 * is, and the first capture set of this scene was 20–85% dead pixels depending
 * on the stop.
 *
 * So there is a pedestal and there is noise, and they are applied to every
 * fragment the renderer produces — including the sky, which is why the gradient
 * banding disappears at the same time.
 *
 * This is deliberately NOT a post-processing pass. It carries no buffers and no
 * extra draw, and it is a property of the virtual camera rather than an effect
 * applied to a finished image, which is why it belongs here and not in System
 * 8. The grade, bloom, chromatic aberration and lens dirt are all still System
 * 8 and none of them are here.
 *
 * Patching a ShaderChunk is global and permanent for the page, so it happens
 * once, guarded, at module load. It cannot affect the texture bakes: those are
 * raw ShaderMaterials that include no chunks at all.
 */
import * as THREE from 'three';

const SENSOR = /* glsl */ `
{
  /* Pedestal.
   *
   * Lifted towards blue because that is which way a CMOS sensor's black point
   * actually drifts once the auto white balance has pushed the sodium back
   * towards neutral, and because a warm frame with warm shadows has no colour
   * structure left in it at all. */
  gl_FragColor.rgb = gl_FragColor.rgb * 0.955 + vec3(0.0040, 0.0046, 0.0070);
}
`;

/* Everything below this line used to be in the chunk above and now lives in
 * `scene/grade.tsx`, and both halves of that move were forced.
 *
 * The first half is ordering, and the technique brief calls it out in advance
 * (§5.1, §5.6): read noise, chroma blotch and dither are display-referred, and
 * with a grade in the frame they have to land *after* it. As it stood, the
 * grade's toe and its midtone plateau — both of which act hardest exactly
 * where the noise lives — would amplify or crush the very thing the noise was
 * calibrated against.
 *
 * The second half is the defect the walk harness found, and it is more
 * interesting. Parking the camera and stepping the simulation produced a
 * bit-identical frame: mean change 0.00 across nine regions. The hash was
 * keyed to gl_FragCoord and to nothing else, so the pattern was fixed in
 * screen space *and* fixed in time. Screen space is right — a sensor's read
 * noise belongs to the sensor and not to the world, which is why anchoring it
 * to anything in the scene would have been the wrong fix — but a pattern that
 * is never redrawn is not noise, it is a dirty lens, and that is what it read
 * as over a moving image. In the new home there is a frame counter to seed it
 * with, which there was never going to be here: this chunk is compiled into
 * every material in the scene and there is no uniform that all of them share.
 *
 * The pedestal stays. It is a black point, not noise; it is a property of the
 * signal the sensor hands over rather than of the image made from it, so it
 * belongs before the grade and it has nothing to be redrawn from.
 *
 * One consequence worth stating because it will otherwise be found the hard
 * way: with ?nograde there is now no dither, so the sky will band. That is the
 * correct behaviour for a switch whose entire purpose is to return the exact
 * frame the screenshot archive was judged through, but it does mean ?nograde
 * is not a way to look at the sky.
 */
const MOVED_TO_GRADE = /* glsl */ `
{
  /* Chroma noise, loudest where the signal is weakest.
   *
   * Three independent channels rather than one luminance term: the
   * characteristic look of a phone night shot is coloured speckle, not film
   * grain, and a single shared value reads as grain over the top of the image
   * instead of noise inside it. */
  vec2 fc = gl_FragCoord.xy;
  vec3 rnd = fract(sin(vec3(
      dot(fc, vec2(12.9898, 78.233)),
      dot(fc, vec2(39.3468, 11.135)),
      dot(fc, vec2(63.7264, 21.881)))) * 43758.5453) - 0.5;
  float lum = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));

  /* Noise has to be a function of exposure, and steeply.
   *
   * The previous curve ran from 0.0042 in black to 0.0007 in light, which is
   * the right direction and nowhere near the right shape — flat enough that
   * the grain read as one even dither laid over the whole frame rather than as
   * a sensor struggling. A phone at 11 pm is shot at ISO 3000 or worse, and
   * read noise is roughly constant in absolute terms while the signal is not,
   * so the noise-to-signal ratio explodes in the bottom stop and is nearly
   * invisible in the lamp pools. A square-law ramp gets that.
   *
   * The amplitude is small on purpose. The first attempt at this ramp used
   * three times these numbers and turned the sky into coloured confetti: at
   * these exposure levels almost the entire frame sits in the steep part of
   * the curve, so a value that looks reasonable written down is overwhelming
   * on screen. */
  float dark = 1.0 - smoothstep(0.0, 0.22, lum);
  /* Pulled right down for daylight, and weighted harder toward the shadows.
   *
   * At night this was carrying real character: a dim scene on a small sensor
   * genuinely is noisy, and the grain was most of what stopped the shadow
   * floor looking like flat paint. At golden hour there is several stops more
   * light, the sensor is nowhere near its limit, and the same amplitude reads
   * as an overlay sitting on top of the picture rather than as part of it. The
   * fourth-power weighting keeps what remains almost entirely in the darkest
   * areas, where a little is still true, and takes it to nothing in the lit
   * road and the sky. There is also a film-grain pass to come in System 8, so
   * this deliberately leaves headroom rather than being the finished look. */
  float d2 = dark * dark;
  float amt = 0.00018 + 0.00105 * d2 * d2;
  gl_FragColor.rgb = max(gl_FragColor.rgb + rnd * amt, 0.0);

  /* Output dither, which is a separate job from the sensor noise above and was
   * not being done at all.
   *
   * The sky is a smooth gradient across a thousand pixels and the frame buffer
   * has 256 levels, so it quantises into visible steps — reported as banding in
   * the upper half of the up-looking frames. Noise fixes banding only if it is
   * at least as large as a quantisation step, and the read-noise term is not:
   * it runs at 0.0002 in linear light where one 8-bit step at sky level is
   * 0.003, sixteen times larger. So it is added explicitly, sized to the local
   * step by differentiating the sRGB transfer curve, which is the smallest
   * amount that can possibly work and is invisible as noise. */
  float step8 = 0.00392 * 2.2755 * pow(max(lum, 1e-5), 0.5833);
  vec3 dth = fract(sin(vec3(
      dot(fc + 0.5, vec2(93.9898, 47.233)),
      dot(fc + 0.5, vec2(19.3468, 81.135)),
      dot(fc + 0.5, vec2(53.7264, 29.881)))) * 21358.5453) - 0.5;
  gl_FragColor.rgb = max(gl_FragColor.rgb + dth * step8, 0.0);

  /* Chroma blotching, which is the other half of what a small sensor does in
   * the dark and is not the same thing as luminance speckle. Demosaicing a
   * starved red or blue channel produces coloured mottle several pixels
   * across, so this is deliberately low-frequency: sampling the hash on a
   * coarse grid, then smoothing between grid points, gives soft patches
   * rather than confetti. Weighted the same way, so it lives in the shadows. */
  vec2 cg = fc / 7.0;
  vec2 ci = floor(cg), cfr = fract(cg);
  cfr = cfr * cfr * (3.0 - 2.0 * cfr);
  vec3 b00 = fract(sin(vec3(dot(ci, vec2(21.7, 91.3)),
                            dot(ci, vec2(47.1, 13.9)),
                            dot(ci, vec2(11.3, 67.7)))) * 24634.6345) - 0.5;
  vec3 b10 = fract(sin(vec3(dot(ci + vec2(1.0, 0.0), vec2(21.7, 91.3)),
                            dot(ci + vec2(1.0, 0.0), vec2(47.1, 13.9)),
                            dot(ci + vec2(1.0, 0.0), vec2(11.3, 67.7)))) * 24634.6345) - 0.5;
  vec3 b01 = fract(sin(vec3(dot(ci + vec2(0.0, 1.0), vec2(21.7, 91.3)),
                            dot(ci + vec2(0.0, 1.0), vec2(47.1, 13.9)),
                            dot(ci + vec2(0.0, 1.0), vec2(11.3, 67.7)))) * 24634.6345) - 0.5;
  vec3 b11 = fract(sin(vec3(dot(ci + vec2(1.0), vec2(21.7, 91.3)),
                            dot(ci + vec2(1.0), vec2(47.1, 13.9)),
                            dot(ci + vec2(1.0), vec2(11.3, 67.7)))) * 24634.6345) - 0.5;
  vec3 blot = mix(mix(b00, b10, cfr.x), mix(b01, b11, cfr.x), cfr.y);
  // Chroma only: the luminance mean of the blotch is removed so it tints
  // rather than brightens, which is how demosaic noise actually behaves.
  blot -= dot(blot, vec3(0.3333));
  gl_FragColor.rgb = max(gl_FragColor.rgb + blot * (0.00016 + 0.00060 * d2 * d2), 0.0);
}
`;

void MOVED_TO_GRADE;

let installed = false;

/** Idempotent. Safe to call from a component body or an effect. */
export function installSensorFloor() {
  if (installed) return;
  installed = true;
  THREE.ShaderChunk.colorspace_fragment =
    SENSOR + '\n' + THREE.ShaderChunk.colorspace_fragment;
}
