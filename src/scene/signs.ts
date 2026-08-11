/* Signwriting: a stroke font, a word list, and an atlas baked from the two.
 *
 * Why this exists rather than the analytic version it replaces.
 *
 * The previous signwriting assembled each letter from a random choice among
 * eight stroke combinations — two stems and bars at cap, middle and baseline.
 * That fixed the fault it was written for: the advances varied, the counters
 * closed, the word gaps were real and a fascia stopped reading as a fence. It
 * introduced a worse one. Half of those combinations are not Latin letters:
 * a left stem with a cap bar and a middle bar is an F, but the mirror of that
 * combination is equally likely and is not a letter in any alphabet a London
 * street uses. The output read as confident, well-set lettering that spells
 * nothing — and a fascia carrying nothing reads as a unit between tenants,
 * which is a real thing you see, while a fascia carrying HПHꟼHT reads as a
 * rendering error. Wrongness is more expensive than absence, which is the
 * whole lesson of this system.
 *
 * The fix is not a better random glyph. It is content: canonical letterforms
 * that can only be themselves, and real words. Twenty-odd trade words and a
 * few name patterns carry an entire street, because what makes a parade read
 * as trading is that the fascias name trades — a minicab office, a barber, a
 * launderette, TO LET — not that any one of them is legible from where the
 * camera stands.
 *
 * Everything here is generated in code: the letterforms are polylines authored
 * below and rasterised by distance to the stroke, so no system font is
 * consulted and the result is identical on every machine. That matters both
 * for the project's no-external-assets rule and because a system font would
 * make the street's signage depend on which machine rendered it.
 */
import * as THREE from 'three';

/* ── The letterforms ─────────────────────────────────────────────────────────
 *
 * Each character is an advance width plus a list of polylines, in a box whose
 * height is one cap height: y = 0 is the baseline, y = 1 is the cap line, and
 * x runs from 0 to the character's own width. A single-weight stroke font
 * rather than filled outlines, because at the size a fascia is actually read —
 * a cap height between two and twenty pixels — the stroke is the letter, and
 * an outline font would spend its extra fidelity below the resolution of the
 * frame.
 *
 * Curves are chamfered into three or four segments. At cap heights under
 * twenty pixels the chamfer is invisible, and above that it reads as a signpainter's
 * hand rather than as a typeface, which is the correct impression for a
 * hand-painted fascia.
 */
type Glyph = { w: number; s: number[][] };

const F: Record<string, Glyph> = {
  ' ': { w: 0.34, s: [] },
  A: { w: 0.68, s: [[0, 0, 0.34, 1, 0.68, 0], [0.13, 0.34, 0.55, 0.34]] },
  B: {
    w: 0.64,
    s: [[0, 0, 0, 1], [0, 1, 0.40, 1, 0.60, 0.82, 0.40, 0.55, 0, 0.55],
      [0, 0.55, 0.44, 0.55, 0.64, 0.32, 0.44, 0, 0, 0]],
  },
  C: { w: 0.66, s: [[0.66, 0.80, 0.46, 1, 0.19, 1, 0, 0.78, 0, 0.22, 0.19, 0, 0.46, 0, 0.66, 0.20]] },
  D: { w: 0.66, s: [[0, 0, 0, 1, 0.38, 1, 0.66, 0.72, 0.66, 0.28, 0.38, 0, 0, 0]] },
  E: { w: 0.58, s: [[0.58, 1, 0, 1, 0, 0, 0.58, 0], [0, 0.52, 0.50, 0.52]] },
  G: {
    w: 0.70,
    s: [[0.70, 0.80, 0.48, 1, 0.19, 1, 0, 0.78, 0, 0.22, 0.19, 0, 0.48, 0, 0.70, 0.20, 0.70, 0.44],
      [0.44, 0.44, 0.70, 0.44]],
  },
  H: { w: 0.66, s: [[0, 0, 0, 1], [0.66, 0, 0.66, 1], [0, 0.52, 0.66, 0.52]] },
  I: { w: 0.14, s: [[0.07, 0, 0.07, 1]] },
  J: { w: 0.52, s: [[0.52, 1, 0.52, 0.24, 0.36, 0, 0.16, 0, 0, 0.20]] },
  K: { w: 0.64, s: [[0, 0, 0, 1], [0.62, 1, 0, 0.42], [0.20, 0.60, 0.64, 0]] },
  L: { w: 0.52, s: [[0, 1, 0, 0, 0.52, 0]] },
  M: { w: 0.84, s: [[0, 0, 0, 1, 0.42, 0.40, 0.84, 1, 0.84, 0]] },
  N: { w: 0.68, s: [[0, 0, 0, 1, 0.68, 0, 0.68, 1]] },
  O: { w: 0.72, s: [[0.20, 1, 0.52, 1, 0.72, 0.78, 0.72, 0.22, 0.52, 0, 0.20, 0, 0, 0.22, 0, 0.78, 0.20, 1]] },
  P: { w: 0.60, s: [[0, 0, 0, 1], [0, 1, 0.40, 1, 0.60, 0.80, 0.40, 0.56, 0, 0.56]] },
  Q: {
    w: 0.72,
    s: [[0.20, 1, 0.52, 1, 0.72, 0.78, 0.72, 0.22, 0.52, 0, 0.20, 0, 0, 0.22, 0, 0.78, 0.20, 1],
      [0.46, 0.22, 0.74, -0.04]],
  },
  R: { w: 0.64, s: [[0, 0, 0, 1], [0, 1, 0.40, 1, 0.60, 0.80, 0.40, 0.56, 0, 0.56], [0.34, 0.56, 0.64, 0]] },
  S: {
    w: 0.62,
    s: [[0.62, 0.82, 0.44, 1, 0.18, 1, 0, 0.80, 0.18, 0.58, 0.44, 0.52, 0.62, 0.30, 0.44, 0, 0.18, 0, 0, 0.18]],
  },
  T: { w: 0.62, s: [[0, 1, 0.62, 1], [0.31, 1, 0.31, 0]] },
  U: { w: 0.66, s: [[0, 1, 0, 0.22, 0.18, 0, 0.48, 0, 0.66, 0.22, 0.66, 1]] },
  V: { w: 0.68, s: [[0, 1, 0.34, 0, 0.68, 1]] },
  W: { w: 0.96, s: [[0, 1, 0.23, 0, 0.48, 0.70, 0.73, 0, 0.96, 1]] },
  X: { w: 0.66, s: [[0, 1, 0.66, 0], [0, 0, 0.66, 1]] },
  Y: { w: 0.66, s: [[0, 1, 0.33, 0.46, 0.66, 1], [0.33, 0.46, 0.33, 0]] },
  Z: { w: 0.62, s: [[0, 1, 0.62, 1, 0, 0, 0.62, 0]] },
  /* F has to be spelled out rather than derived from E, and that is the point
   * of this table: there is no operation here that can produce a mirror. */
  F: { w: 0.56, s: [[0.56, 1, 0, 1, 0, 0], [0, 0.52, 0.48, 0.52]] },
  '0': { w: 0.64, s: [[0.18, 1, 0.46, 1, 0.64, 0.78, 0.64, 0.22, 0.46, 0, 0.18, 0, 0, 0.22, 0, 0.78, 0.18, 1]] },
  '1': { w: 0.36, s: [[0.04, 0.78, 0.28, 1, 0.28, 0]] },
  '2': { w: 0.60, s: [[0, 0.80, 0.18, 1, 0.44, 1, 0.60, 0.78, 0.50, 0.54, 0, 0, 0.60, 0]] },
  '3': { w: 0.60, s: [[0.02, 0.86, 0.20, 1, 0.44, 1, 0.58, 0.80, 0.36, 0.56], [0.36, 0.56, 0.58, 0.32, 0.42, 0, 0.16, 0, 0, 0.14]] },
  '4': { w: 0.64, s: [[0.46, 0, 0.46, 1, 0, 0.30, 0.64, 0.30]] },
  '5': { w: 0.60, s: [[0.60, 1, 0.12, 1, 0.06, 0.58, 0.34, 0.60, 0.58, 0.42, 0.44, 0.06, 0.14, 0, 0, 0.14]] },
  '6': { w: 0.62, s: [[0.56, 0.94, 0.32, 1, 0.08, 0.76, 0, 0.30, 0.16, 0, 0.44, 0, 0.62, 0.22, 0.46, 0.46, 0.16, 0.46, 0.02, 0.32]] },
  '7': { w: 0.58, s: [[0, 1, 0.58, 1, 0.20, 0]] },
  '8': {
    w: 0.64,
    s: [[0.20, 0.54, 0.06, 0.74, 0.16, 0.98, 0.46, 0.98, 0.58, 0.74, 0.44, 0.54, 0.20, 0.54],
      [0.44, 0.54, 0.64, 0.28, 0.46, 0, 0.18, 0, 0, 0.28, 0.20, 0.54]],
  },
  '9': { w: 0.62, s: [[0.06, 0.06, 0.30, 0, 0.54, 0.24, 0.62, 0.70, 0.46, 1, 0.18, 1, 0, 0.78, 0.16, 0.54, 0.46, 0.54, 0.60, 0.70]] },
  '-': { w: 0.42, s: [[0.04, 0.46, 0.38, 0.46]] },
  '.': { w: 0.24, s: [[0.10, 0.02, 0.13, 0.02]] },
  "'": { w: 0.22, s: [[0.11, 1.0, 0.07, 0.72]] },
  '&': {
    w: 0.74,
    s: [[0.74, 0, 0.18, 0.62, 0.18, 0.84, 0.34, 1.0, 0.50, 0.84, 0.46, 0.62, 0, 0.28, 0.14, 0.02, 0.42, 0.06, 0.64, 0.32]],
  },
};

/* ── What the street says ────────────────────────────────────────────────────
 *
 * A back street, not a high street: the trades that take the cheap end of a
 * parade, plus a couple of proprietors' names, plus the two things that are
 * written on a shopfront rather than being its name at all — TO LET and the
 * opening hours. No real marks; these are the generic trade words that a
 * hundred streets carry.
 */
const FASCIA_WORDS = [
  'MINICABS', 'BARBERS', 'LAUNDERETTE', 'NEWSAGENT', 'TO LET',
  'OPEN 24 HRS', 'OFF LICENCE', 'FISH BAR', 'KEBAB HOUSE', 'DRY CLEANERS',
  'HARDWARE', 'CAFE', 'PHONE REPAIR', 'NAILS', 'TAKEAWAY',
  'FRIED CHICKEN', 'GROCERS', 'PHARMACY', 'BOOKMAKER', 'TATTOO',
  'CARPETS', 'SANDWICH BAR', 'KEYS CUT', 'DISCOUNT STORE',
  "AL'S GRILL", 'PARK CAFE', 'STAR KEBAB', 'ROSE & SON',
  'UNIT 4', 'NO 27',
];

/** Street name blades. */
const STREET_NAMES = ['PARK ROAD', 'MILL LANE', 'HIGH STREET', 'QUEEN ST'];

/** Regulatory plates, as the two lines they are actually set in. */
const PLATE_LINES = [
  'NO PARKING', 'AT ANY TIME',
  'LOADING ONLY', 'MON - SAT',
];

/* ── The bake ────────────────────────────────────────────────────────────────
 *
 * One row of an R8 atlas per string, left aligned, at a fixed cap height.
 * Signs are rasterised by distance to the stroke rather than by filling a
 * bitmap, so the edges arrive antialiased and the letterform is smooth at the
 * close range where a shopfront is inspected.
 *
 * The row pitch is generous relative to the cap height because the shader
 * reads this through the hardware's mip chain: at the level where a texel
 * spans several pixels, a tight pitch would bleed one sign into the next.
 */
export const SIGN_CAP = 26;         // cap height in atlas pixels
export const SIGN_ROW = 42;         // row pitch
export const SIGN_BASE = 8;         // baseline above the bottom of its row
export const SIGN_ATLAS_W = 320;
/** Letter spacing, in cap heights, added to every advance. */
const TRACK = 0.15;

export type SignAtlas = {
  texture: THREE.DataTexture;
  /** Per row: x is the used width as a fraction of the atlas, y is mean ink. */
  meta: THREE.Vector2[];
  height: number;
  /** Row ranges. */
  fascia0: number; fasciaN: number;
  name0: number; nameN: number;
  plate0: number; plateN: number;
};

function measure(text: string): number {
  let w = 0;
  for (const ch of text) w += (F[ch]?.w ?? F[' ']!.w) + TRACK;
  return Math.max(w - TRACK, 0.1);
}

/** Distance from a point to a polyline, in the same units as the polyline. */
function distToPolyline(px: number, py: number, p: number[]): number {
  let best = 1e9;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i], ay = p[i + 1], bx = p[i + 2], by = p[i + 3];
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + dx * t - px, cy = ay + dy * t - py;
    const d = Math.sqrt(cx * cx + cy * cy);
    if (d < best) best = d;
  }
  /* A one-point "polyline" is a full stop, and it still has to make a mark. */
  if (p.length === 2) {
    const cx = p[0] - px, cy = p[1] - py;
    best = Math.min(best, Math.sqrt(cx * cx + cy * cy));
  }
  return best;
}

let cached: SignAtlas | null = null;

export function signAtlas(): SignAtlas {
  if (cached) return cached;

  const rows = [...FASCIA_WORDS, ...STREET_NAMES, ...PLATE_LINES];
  const H = rows.length * SIGN_ROW;
  const W = SIGN_ATLAS_W;
  const data = new Uint8Array(W * H);

  /* Half the stroke weight, in pixels. 0.075 of the cap height gives a stem
   * about a seventh of the cap, which is a signwriter's brush rather than a
   * hairline: a fascia is read at distance and a light weight would vanish
   * into the board before the frame did. */
  const R = 0.075 * SIGN_CAP;
  const meta: THREE.Vector2[] = [];

  for (let r = 0; r < rows.length; r++) {
    const text = rows[r];
    const rowTop = r * SIGN_ROW;
    const baseIY = rowTop + SIGN_ROW - SIGN_BASE;
    let pen = 0;                      // in cap heights
    let ink = 0;

    for (const ch of text) {
      const g = F[ch] ?? F[' ']!;
      const x0 = pen * SIGN_CAP;
      for (const poly of g.s) {
        /* Only the neighbourhood of the stroke is visited: rasterising the
         * whole row against every segment of every glyph would be forty times
         * the work for the same image. */
        let mnx = 1e9, mny = 1e9, mxx = -1e9, mxy = -1e9;
        for (let i = 0; i < poly.length; i += 2) {
          mnx = Math.min(mnx, poly[i]); mxx = Math.max(mxx, poly[i]);
          mny = Math.min(mny, poly[i + 1]); mxy = Math.max(mxy, poly[i + 1]);
        }
        const pad = (R + 2) / SIGN_CAP;
        const ix0 = Math.max(0, Math.floor(x0 + (mnx - pad) * SIGN_CAP));
        const ix1 = Math.min(W - 1, Math.ceil(x0 + (mxx + pad) * SIGN_CAP));
        const iy0 = Math.max(rowTop, Math.floor(baseIY - (mxy + pad) * SIGN_CAP));
        const iy1 = Math.min(rowTop + SIGN_ROW - 1, Math.ceil(baseIY - (mny - pad) * SIGN_CAP));
        for (let iy = iy0; iy <= iy1; iy++) {
          const gy = (baseIY - (iy + 0.5)) / SIGN_CAP;
          for (let ix = ix0; ix <= ix1; ix++) {
            const gx = (ix + 0.5 - x0) / SIGN_CAP;
            const d = distToPolyline(gx, gy, poly) * SIGN_CAP;
            const a = Math.max(0, Math.min(1, 0.5 + (R - d)));
            if (a <= 0) continue;
            const k = iy * W + ix;
            const v = Math.round(a * 255);
            if (v > data[k]) data[k] = v;
          }
        }
      }
      pen += g.w + TRACK;
    }

    const wCap = Math.max(pen - TRACK, 0.1);
    const wPx = Math.min(W, wCap * SIGN_CAP);
    /* Mean ink over the rectangle the shader maps the text into. This is what
     * a fascia converges to once a letter falls under a pixel, and getting it
     * from the bake rather than guessing it is what keeps a distant sign the
     * same tone as a near one. */
    for (let iy = baseIY - SIGN_CAP; iy < baseIY; iy++) {
      for (let ix = 0; ix < wPx; ix++) ink += data[iy * W + ix];
    }
    meta.push(new THREE.Vector2(wPx / W, ink / (255 * Math.max(1, wPx * SIGN_CAP))));
  }

  const texture = new THREE.DataTexture(data, W, H, THREE.RedFormat);
  texture.flipY = false;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;

  cached = {
    texture, meta, height: H,
    fascia0: 0, fasciaN: FASCIA_WORDS.length,
    name0: FASCIA_WORDS.length, nameN: STREET_NAMES.length,
    plate0: FASCIA_WORDS.length + STREET_NAMES.length, plateN: PLATE_LINES.length,
  };
  return cached;
}

/* The GLSL side: the atlas lookup, plus the constants the layout needs. Shared
 * verbatim by the shopfront material, which sets the fascias, and the street
 * furniture material, which sets the name blades and the regulatory plates. */
export function signGLSL(): string {
  const a = signAtlas();
  return /* glsl */ `
uniform sampler2D uSignTex;
uniform vec2 uSignMeta[${a.meta.length}];
const float SGN_CAP = ${SIGN_CAP.toFixed(1)};
const float SGN_ROW = ${SIGN_ROW.toFixed(1)};
const float SGN_BASE = ${SIGN_BASE.toFixed(1)};
const float SGN_W = ${SIGN_ATLAS_W.toFixed(1)};
const float SGN_H = ${a.height.toFixed(1)};
const int SGN_FASCIA0 = ${a.fascia0};
const int SGN_FASCIAN = ${a.fasciaN};
const int SGN_NAME0 = ${a.name0};
const int SGN_NAMEN = ${a.nameN};
const int SGN_PLATE0 = ${a.plate0};

/* The aspect of a row: its set width divided by its cap height. The caller
 * needs this before it can lay the sign out, because a name is set at the size
 * that fits the board rather than being stretched to it — which is the second
 * half of what made the old signwriting read as a barcode. */
float signAspect(int row){
  return uSignMeta[row].x * SGN_W / SGN_CAP;
}

/* Which way round the lettering has to run.
 *
 * A board's u axis is whatever its geometry emitted, and both terraces are
 * emitted along the same world axis while their normals point opposite ways —
 * so text that reads left to right on one side of the street comes out
 * mirrored on the other. The pseudo-lettering this replaces hid that
 * completely, because a mirrored meaningless mark is another meaningless mark;
 * real words made it visible in the first frame.
 *
 * Rather than tabulate which parts need flipping, the u axis is recovered from
 * the screen-space derivatives the way a tangent frame is, and compared with
 * the direction that lies to the right of a viewer standing outside the
 * surface. That is orientation-independent, so a plate hung at any angle on
 * any face is right without being told which face it is on.
 *
 * Call it from unbranched code: it takes derivatives. */
float signMirror(vec2 uv, vec3 n){
  vec3 dp1 = dFdx(vWPos), dp2 = dFdy(vWPos);
  vec2 du1 = dFdx(uv), du2 = dFdy(uv);
  float det = du1.x * du2.y - du2.x * du1.y;
  vec3 uT = (dp1 * du2.y - dp2 * du1.y) * (det < 0.0 ? -1.0 : 1.0);
  return dot(uT, cross(vec3(0.0, 1.0, 0.0), n)) < 0.0 ? -1.0 : 1.0;
}

/* Ink coverage at a point in a sign's own frame: q.x runs 0 to 1 across the
 * set width, q.y is in cap heights above the baseline, px is the pixel
 * footprint in cap heights.
 *
 * Past a couple of atlas texels of footprint the letterforms are no longer
 * resolvable by the frame and the honest value is the row's mean ink. Handing
 * that over explicitly, rather than letting the mip chain run to the top,
 * keeps a fascia at forty metres the same tone as the same fascia at ten and
 * keeps neighbouring rows of the atlas from bleeding into each other. */
float signInk(int row, vec2 q, float px, float mir){
  if (q.x < 0.0 || q.x > 1.0 || q.y < -0.10 || q.y > 1.12) return 0.0;
  vec2 m = uSignMeta[row];
  float u = (mir < 0.0 ? 1.0 - q.x : q.x) * m.x;
  float v = (float(row) * SGN_ROW + (SGN_ROW - SGN_BASE) - q.y * SGN_CAP) / SGN_H;
  float ink = texture2D(uSignTex, vec2(u, v)).r;
  /* The handover to mean ink is late enough that the mip chain carries the
   * word gaps and the rhythm of the ascenders down to the range where a sign
   * is a smear, and early enough that neighbouring rows of the atlas never
   * bleed into one another. */
  return mix(ink, m.y, smoothstep(2.4, 8.5, px * SGN_CAP));
}
`;
}

/** The uniforms the GLSL above expects, for a material's onBeforeCompile. */
export function signUniforms(): Record<string, { value: unknown }> {
  const a = signAtlas();
  return {
    uSignTex: { value: a.texture },
    uSignMeta: { value: a.meta },
  };
}
