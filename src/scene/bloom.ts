/* Veiling glare, which is what "bloom" is when it is a lens and not a filter.
 *
 * ── Why there is no threshold in this file ────────────────────────────────
 *
 * The brief asks for "more bloom on the sun-facing surfaces" and immediately
 * warns that it must be "a physically-motivated lens response rather than a
 * threshold-and-blur that turns every bright pixel into a smear". Those are
 * the same instruction twice, and taking it seriously removes the first thing
 * most implementations do.
 *
 * A lens scatters a fixed *fraction* of everything that enters it — off the
 * element coatings, the iris edge, the sensor cover glass, dust. It does not
 * consult a threshold. The reason threshold-and-blur looks wrong is not that
 * the blur is wrong, it is that thresholding makes the effect a function of
 * where a pixel sits relative to an arbitrary constant, so identical geometry
 * blooms or does not bloom depending on exposure. The physical version has no
 * such constant: every pixel contributes 4.5 per cent of itself to a wide,
 * heavy-tailed kernel and keeps 95.5 per cent.
 *
 * Around a sun-struck parapet that reads as exactly the requested effect,
 * because the neighbourhood average next to a blown highlight is enormous. In
 * a flat shaded frame it does nothing measurable, which is also correct.
 *
 * ── Why it has to be here and not in the grade ────────────────────────────
 *
 * §6.9 and jungle-trail's blown waterfall: glare added after the tone curve
 * can only push pixels towards white, because everything it is adding has
 * already been compressed against white. The lens is in front of the sensor,
 * so the veil is added in radiance and tone-mapped with everything else. That
 * is what the linear target in `pipeline.ts` bought.
 *
 * There is a specific defect this must not worsen and it is recorded: the
 * "OPEN" neon clips to pure white over 4,223 pixels with an inverted chord
 * profile. Adding a veil in radiance *cannot* make that worse in kind — the
 * pixels are already at the top of the curve and 4.5 per cent of a neighbour
 * cannot move them further — and it improves it in appearance, because the
 * clipped core now sits inside a falloff instead of ending at a hard edge,
 * which is the actual visual signature of an over-exposed light source.
 *
 * ── The pyramid ───────────────────────────────────────────────────────────
 *
 * Jimenez's dual filter: a 13-tap downsample that is stable under motion, and
 * a 3x3 tent on the way back up, blended additively so each level contributes
 * its own octave. Six levels from half resolution gives a kernel reaching a
 * third of the frame, which is the heavy tail a real point-spread function
 * has and a single gaussian does not.
 *
 * The Karis average is applied on the first downsample only. Without it a
 * single half-float pixel at L = 400 — and this scene has a sun disc — becomes
 * a crawling firefly the moment the camera moves, because it survives every
 * level of the pyramid and then arrives spread over a hundred pixels. Applying
 * it further down would cost energy for nothing, since by level two there are
 * no single-pixel outliers left.
 */
import * as THREE from 'three';
import { Blit, makeColourTarget } from './pipeline';

/* Nine, not six, and the three that were missing are the whole of the veil.
 *
 * The support of this kernel is not "a third of the frame", which is what the
 * header claimed. Each level is upsampled with a 3x3 tent whose radius is one
 * texel *of that level*, so the furthest a photon can travel is about two
 * texels of the coarsest level: at six levels from half resolution that is
 * 2 x 64 = 128 pixels, which on a 900-line frame at 45 degrees is 6.4 degrees.
 * Past that the veil is exactly, bit-for-bit, the frame without it.
 *
 * That is measurable and was measured. With the sun in frame at t = 0.40, a
 * twenty-fold change in the disc's flux — a quarter of the frame's whole
 * energy budget — moved the frame beyond ten degrees from the sun by 0.00
 * code values at six levels: 130.58 against 130.59, 99.16 against 99.16.
 * Every octave of glare the source was emitting past 6.4 degrees was being
 * dropped on the floor. An absent term reads as exactly 1.000.
 *
 * Nine levels reach 2 x 512 = 1024 pixels, which is 51 degrees and covers the
 * frame from any point in it. They cost three passes over targets of 25x14,
 * 12x7 and 6x3 texels; the measured frame time does not move.
 */
const LEVELS = 9;

/* How much of each octave survives into the one below it, so the point-spread
 * function is geometric with this ratio: 0.42 of the veil in the tightest
 * octave, then 0.25, 0.15, 0.09, 0.054, 0.033 once normalised.
 *
 * Not 1.0, which is what this had, and the difference is the whole reason the
 * frame read flat. Six octaves at unit weight is a PSF that is *flatter than
 * uniform* — more of its energy a third of the way across the frame than within
 * a few pixels of the source — and a veil like that has no visible structure at
 * all. It cannot put glare around a sun-struck parapet because it does not know
 * where the parapet is; it can only raise the whole frame and take the
 * contrast that costs. A real lens is the other way round: strongly peaked,
 * with a tail. Measured at 18 per cent of the micro-contrast of every patch on
 * the frontage, at every distance from 9 m to 26 m, in tools/micro.mjs. */
/* ── What this number is, physically ──────────────────────────────────────
 *
 * Each level of the pyramid is mean-preserving and each is added to the one
 * below it with this weight, so octave k carries GAIN^k of the veil's energy.
 * A point source's energy at octave k is spread over (2^k)^2 pixels, so its
 * surface brightness at a radius of about 2^k pixels is
 *
 *     B(theta)  ~  GAIN^log2(theta) / theta^2
 *
 * At GAIN = 1 that is exactly 1/theta^2 — the classical veiling-glare law,
 * equal energy per octave, which is what a real lens's point-spread function
 * does out to tens of degrees. Every value below 1 steepens it: 0.6 makes the
 * exponent 2.74, which puts the veil within a couple of hundred pixels of its
 * source and leaves the rest of the frame with none of it.
 *
 * 0.6 was chosen at the same time as the normalisation below was fixed, on
 * the reasoning that six unit-weight octaves are "flatter than uniform". They
 * are not: equal energy per octave is 1/theta^2, which is strongly peaked.
 * What is true is that the *unnormalised* sum was six times too bright, and
 * that is what the 18 per cent micro-contrast loss measured at the time was —
 * a fifth of a stop of exposure, not a tail.
 *
 * Measured on this scene with the sun in frame, at the two stations where the
 * disc clears the terrace: at 0.6 a hundred-and-twenty-fold change in the
 * sun's own flux moves the frame beyond ten degrees from it by less than one
 * hundredth of a code value — the far field is bit-identical, which is the
 * signature of a term that is not connected to anything. See
 * tools/sunglare.mjs.
 */
const GAIN = 1.0;

const DOWN = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uKaris;

/* The Karis average, as an average.
 *
 * The first version of this returned c/(1+luma) from every tap and summed those
 * with the filter weights, which is not a weighted average — it is a tone
 * compression. Nothing divided the weights back out, so with scene radiance
 * around 1 to 3 the whole of level 0 came out two to four times too dark while
 * levels 1 to 5 were untouched. The tightest octave of the point-spread
 * function, which is the one that puts glare next to a highlight, was the only
 * one being suppressed, and the flat tail was left at full strength.
 *
 * A weighted mean divides by the weights it used. Then a group of equally
 * bright samples is returned unchanged, which is the property that matters:
 * this must only act on outliers. With uKaris = 0 the weights are 1 and it
 * reduces exactly to the plain 13-tap filter. */
float luma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
vec4 tap( vec2 uv, float k ) {
  vec3 c = texture2D( tSrc, uv ).rgb;
  float w = k * mix( 1.0, 1.0 / ( 1.0 + luma( c ) ), uKaris );
  return vec4( c * w, w );
}

void main() {
  vec2 t = uTexel;
  /* Jimenez's 13 taps: a centre group of four at half a texel weighted 0.5
   * between them, plus the corners and edges of a 2-texel box. The overlap is
   * the point — it is what makes the chain stable when the camera moves,
   * which a plain box filter is not. */
  vec4 o = tap( vUv, 0.125 );
  o += tap( vUv + vec2( -1.0,  1.0 ) * t, 0.03125 );
  o += tap( vUv + vec2(  1.0,  1.0 ) * t, 0.03125 );
  o += tap( vUv + vec2( -1.0, -1.0 ) * t, 0.03125 );
  o += tap( vUv + vec2(  1.0, -1.0 ) * t, 0.03125 );
  o += tap( vUv + vec2(  0.0,  1.0 ) * t, 0.0625 );
  o += tap( vUv + vec2( -1.0,  0.0 ) * t, 0.0625 );
  o += tap( vUv + vec2(  1.0,  0.0 ) * t, 0.0625 );
  o += tap( vUv + vec2(  0.0, -1.0 ) * t, 0.0625 );
  o += tap( vUv + vec2( -0.5,  0.5 ) * t, 0.125 );
  o += tap( vUv + vec2(  0.5,  0.5 ) * t, 0.125 );
  o += tap( vUv + vec2( -0.5, -0.5 ) * t, 0.125 );
  o += tap( vUv + vec2(  0.5, -0.5 ) * t, 0.125 );
  gl_FragColor = vec4( o.rgb / max( o.a, 1e-6 ), 1.0 );
}
`;

const UP = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uGain;

void main() {
  // 3x3 tent, radius one texel of the *smaller* level.
  vec2 t = uTexel;
  vec3 o = texture2D( tSrc, vUv + vec2( -t.x,  t.y ) ).rgb * 1.0
         + texture2D( tSrc, vUv + vec2(  0.0,  t.y ) ).rgb * 2.0
         + texture2D( tSrc, vUv + vec2(  t.x,  t.y ) ).rgb * 1.0
         + texture2D( tSrc, vUv + vec2( -t.x,  0.0 ) ).rgb * 2.0
         + texture2D( tSrc, vUv                      ).rgb * 4.0
         + texture2D( tSrc, vUv + vec2(  t.x,  0.0 ) ).rgb * 2.0
         + texture2D( tSrc, vUv + vec2( -t.x, -t.y ) ).rgb * 1.0
         + texture2D( tSrc, vUv + vec2(  0.0, -t.y ) ).rgb * 2.0
         + texture2D( tSrc, vUv + vec2(  t.x, -t.y ) ).rgb * 1.0;
  gl_FragColor = vec4( o * ( uGain / 16.0 ), 1.0 );
}
`;

export class Bloom {
  private levels: THREE.WebGLRenderTarget[] = [];
  private down: Blit;
  private up: Blit;

  /* The firefly guard, as a knob rather than a constant, because whether it
   * should be on is a question about this scene and not about the technique.
   * 1 is the Karis average as described above; 0 is the plain 13-tap filter,
   * which is what a lens does. See the note above `pyramid`. */
  karis = 1;

  /* The per-octave weight, as a knob for the same reason: whether the veil
   * should follow 1/theta^2 is a question that has to be asked of a frame with
   * the sun in it, and it could not be asked while it was a module constant.
   * `norm` follows it, so the veil stays energy-conserving at every setting. */
  gain = GAIN;

  constructor(w: number, h: number) {
    this.down = new Blit(DOWN, {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uKaris: { value: 0 },
    });
    this.up = new Blit(UP, {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() },
      uGain: { value: GAIN },
    });
    /* Additive on the way up so each octave lands on the one below it rather
     * than replacing it. A pyramid that overwrites is one gaussian with extra
     * steps; the sum is what gives the kernel its tail. */
    this.up.material.blending = THREE.AdditiveBlending;
    this.up.material.transparent = true;
    this.setSize(w, h);
  }

  /** The finest level, i.e. the veil at half resolution. */
  get texture(): THREE.Texture { return this.levels[0].texture; }

  /* What to scale that texture by so it has the same mean as the frame it came
   * from, and therefore so the fraction it is mixed with is the fraction that
   * is actually scattered.
   *
   * Every filter in the pyramid preserves the mean — the 13 taps sum to one and
   * the tent divides by sixteen — so each octave has the scene's mean and the
   * additive chain leaves level 0 holding the geometric series 1 + g + g^2 ...
   * Six unit-weight octaves therefore came out six times too bright, and
   * mix(src, veil, 0.045) against a veil six times the mean is not a 4.5 per
   * cent redistribution of light, it is a 22 per cent exposure lift. That is
   * what was pushing the frame up AgX's shoulder and flattening it, and it is
   * why the measured cost of "4.5 per cent glare" was 6 to 7 code values on
   * every region of the frame including ones with no highlight anywhere near
   * them.
   *
   * Energy is conserved here rather than in uBloom so that uBloom keeps meaning
   * the one thing it should mean. */
  get norm(): number {
    const g = this.gain;
    /* The geometric series has a removable singularity at g = 1, where the
     * six octaves are equally weighted and the sum is simply LEVELS. Writing
     * (1-g)/(1-g^L) there is 0/0, which arrives as NaN in a uniform and takes
     * the whole composite black — and 1.0 is precisely the value this now
     * ships at. */
    return Math.abs(1 - g) < 1e-6 ? 1 / LEVELS : (1 - g) / (1 - g ** LEVELS);
  }

  setSize(w: number, h: number) {
    for (let i = 0; i < LEVELS; i++) {
      const lw = Math.max(1, w >> (i + 1));
      const lh = Math.max(1, h >> (i + 1));
      if (this.levels[i]) this.levels[i].setSize(lw, lh);
      else this.levels[i] = makeColourTarget(lw, lh, `bloom${i}`);
    }
  }

  render(gl: THREE.WebGLRenderer, src: THREE.Texture) {
    /* The upsample blends *into* a level that already holds its own octave, so
     * three's automatic clear has to be off or each level is wiped a
     * microsecond before it is added to and the pyramid collapses to its
     * coarsest level alone. The downsamples do not need a clear either: a
     * fullscreen triangle covers every texel of the target. */
    const autoClear = gl.autoClear;
    gl.autoClear = false;
    try { this.pyramid(gl, src); } finally { gl.autoClear = autoClear; }
  }

  private pyramid(gl: THREE.WebGLRenderer, src: THREE.Texture) {
    const du = this.down.uniforms;
    let from = src;
    for (let i = 0; i < LEVELS; i++) {
      const prev = i === 0 ? null : this.levels[i - 1];
      const pw = prev ? prev.width : this.levels[0].width * 2;
      const ph = prev ? prev.height : this.levels[0].height * 2;
      du.tSrc.value = from;
      (du.uTexel.value as THREE.Vector2).set(1 / pw, 1 / ph);
      du.uKaris.value = i === 0 ? this.karis : 0;
      this.down.render(gl, this.levels[i]);
      from = this.levels[i].texture;
    }

    const uu = this.up.uniforms;
    uu.uGain.value = this.gain;
    for (let i = LEVELS - 1; i > 0; i--) {
      uu.tSrc.value = this.levels[i].texture;
      (uu.uTexel.value as THREE.Vector2).set(1 / this.levels[i].width, 1 / this.levels[i].height);
      this.up.render(gl, this.levels[i - 1]);
    }
  }

  dispose() {
    this.down.dispose();
    this.up.dispose();
    for (const l of this.levels) l.dispose();
  }
}
