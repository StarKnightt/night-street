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

const LEVELS = 6;

const DOWN = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uKaris;

/* Weight by 1/(1+luma) before averaging, so one very bright sample cannot
 * dominate the group. This is the whole of the anti-firefly measure. */
vec3 karis( vec3 c ) { return c / ( 1.0 + dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ) ); }
vec3 tap( vec2 uv ) {
  vec3 c = texture2D( tSrc, uv ).rgb;
  return mix( c, karis( c ), uKaris );
}

void main() {
  vec2 t = uTexel;
  /* Jimenez's 13 taps: a centre group of four at half a texel weighted 0.5
   * between them, plus the corners and edges of a 2-texel box. The overlap is
   * the point — it is what makes the chain stable when the camera moves,
   * which a plain box filter is not. */
  vec3 a = tap( vUv + vec2( -1.0,  1.0 ) * t );
  vec3 b = tap( vUv + vec2(  0.0,  1.0 ) * t );
  vec3 c = tap( vUv + vec2(  1.0,  1.0 ) * t );
  vec3 d = tap( vUv + vec2( -1.0,  0.0 ) * t );
  vec3 e = tap( vUv );
  vec3 f = tap( vUv + vec2(  1.0,  0.0 ) * t );
  vec3 g = tap( vUv + vec2( -1.0, -1.0 ) * t );
  vec3 h = tap( vUv + vec2(  0.0, -1.0 ) * t );
  vec3 i = tap( vUv + vec2(  1.0, -1.0 ) * t );
  vec3 j = tap( vUv + vec2( -0.5,  0.5 ) * t );
  vec3 k = tap( vUv + vec2(  0.5,  0.5 ) * t );
  vec3 l = tap( vUv + vec2( -0.5, -0.5 ) * t );
  vec3 m = tap( vUv + vec2(  0.5, -0.5 ) * t );

  vec3 o = e * 0.125;
  o += ( a + c + g + i ) * 0.03125;
  o += ( b + d + f + h ) * 0.0625;
  o += ( j + k + l + m ) * 0.125;
  gl_FragColor = vec4( o, 1.0 );
}
`;

const UP = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tSrc;
uniform vec2 uTexel;

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
  gl_FragColor = vec4( o * ( 1.0 / 16.0 ), 1.0 );
}
`;

export class Bloom {
  private levels: THREE.WebGLRenderTarget[] = [];
  private down: Blit;
  private up: Blit;

  constructor(w: number, h: number) {
    this.down = new Blit(DOWN, {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uKaris: { value: 0 },
    });
    this.up = new Blit(UP, {
      tSrc: { value: null }, uTexel: { value: new THREE.Vector2() },
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
      du.uKaris.value = i === 0 ? 1 : 0;
      this.down.render(gl, this.levels[i]);
      from = this.levels[i].texture;
    }

    const uu = this.up.uniforms;
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
