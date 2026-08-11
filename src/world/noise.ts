/* CPU noise, seeded.
 *
 * The GPU has its own copy of all this in glsl.ts. This one exists because the
 * geometry has to agree with the shader about where the road is low: the
 * camber, the settling waves and the sunken slabs are baked into vertices,
 * and the damp patches that key off them are shaded. Both read the same
 * function, so a puddle sits in a dip rather than next to one.
 *
 * Everything is driven from one integer seed and no `Math.random()` is used
 * anywhere in the project, because the critic compares runs.
 */

/** xorshift32 → deterministic [0,1). */
export function makeRng(seed: number) {
  let s = seed >>> 0 || 1;
  return function rng(): number {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function permTable(seed: number): Uint8Array {
  const rng = makeRng(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const full = new Uint8Array(512);
  for (let i = 0; i < 512; i++) full[i] = p[i & 255];
  return full;
}

const G2 = [1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 0, 1, 0, -1];

export class Noise2D {
  private p: Uint8Array;
  constructor(seed = 20461) { this.p = permTable(seed); }

  /** Perlin, roughly [-1, 1]. */
  n(x: number, y: number): number {
    const p = this.p;
    const X = Math.floor(x) & 255, Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x), yf = y - Math.floor(y);
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10);
    const v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const grad = (hash: number, dx: number, dy: number) => {
      const h = (hash & 7) * 2;
      return G2[h] * dx + G2[h + 1] * dy;
    };
    const aa = p[p[X] + Y], ab = p[p[X] + Y + 1];
    const ba = p[p[X + 1] + Y], bb = p[p[X + 1] + Y + 1];
    const x1 = grad(aa, xf, yf) + u * (grad(ba, xf - 1, yf) - grad(aa, xf, yf));
    const x2 = grad(ab, xf, yf - 1) + u * (grad(bb, xf - 1, yf - 1) - grad(ab, xf, yf - 1));
    return (x1 + v * (x2 - x1)) * 1.4;
  }

  fbm(x: number, y: number, oct = 4, gain = 0.5, lac = 2.0): number {
    let s = 0, a = 0.5, fx = x, fy = y, norm = 0;
    for (let i = 0; i < oct; i++) {
      s += a * this.n(fx, fy);
      norm += a;
      fx *= lac; fy *= lac; a *= gain;
    }
    return s / norm;
  }
}

/** Same integer hash the GLSL side uses for per-block variation. */
export function hash1(n: number): number {
  let x = Math.sin(n * 127.1) * 43758.5453;
  x = x - Math.floor(x);
  return x;
}

export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
