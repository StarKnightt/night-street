/* Signage that stands off the wall.
 *
 * System 3 already signwrites the fascia board over every shopfront, which is
 * the flat sign a street has. What it has none of is the *projecting* sign,
 * and on a real parade that is most of the signage by visual weight: the blade
 * hung out over the footway on a cranked bracket, the swinging board under an
 * arm, the enamel plate screwed to a pier, and the painted band on the wall
 * above the fascia that has been there since the building was a dairy.
 *
 * Projecting signs matter here far more than they would at noon, for three
 * reasons that are all about the hour.
 *
 * A blade is perpendicular to the frontage, so from anywhere down the street
 * it is presented flat to the eye while the wall it is fixed to is presented
 * edge on. A row of fascias thirty metres away is a row of thin slivers; a row
 * of blades is a row of rectangles. That is the difference between a frontage
 * that reads at distance and one that dissolves.
 *
 * At 4.2 degrees a board standing 900 mm off a wall throws its shadow seven
 * metres along that wall. One blade marks a whole bay of brickwork.
 *
 * And a blade breaks the skyline of the shopfront. The strongest horizontal in
 * every frame of this street is the fascia line running unbroken to the
 * vanishing point, and the thing that stops it being a ruler is objects
 * crossing it.
 *
 * ── What is not here ─────────────────────────────────────────────────────
 *
 * No neon and no illumination of any kind. The lit signage on this street —
 * the BAR blade, the pharmacy cross, OPEN — belongs to System 5 and to
 * `scene/lights.ts`, and the brief for this pass is explicit that lighting is
 * not to be touched. Everything below is unlit painted board and enamel, which
 * is what the overwhelming majority of real signage is anyway.
 */
import { Emit, Face } from './emit';
import { layoutBlock, type Bldg } from './block';
import { groundLevels, groundOpenings, pierCentres } from './facade';
import { walkHeight } from './geometry';
import { signAtlas } from '@/scene/signs';
import { PMAT } from './propKinds';

/** Branches in the signage material. */
export const SIGN_KIND = {
  /** Painted board on a bracket: dark ground, signwritten in light. */
  BLADE: 0,
  /** A painted sign directly on the wall, decades old and mostly gone. */
  GHOST: 1,
  /** A hanging board under an arm — older, gilt on dark green. */
  HANGING: 2,
  /** A small vitreous enamel plate, or lettering on the glass. */
  PLATE: 3,
} as const;

const h2 = (a: number, b: number): number => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/* ── One board ───────────────────────────────────────────────────────────── */

/**
 * A double-sided board.
 *
 * Both faces carry lettering and the four edges are real, because a sign
 * modelled as a single quad is invisible from behind and — much worse — has no
 * thickness at its silhouette, which at this sun angle is where the eye is
 * looking. A painted board is 18 to 30 mm of ply in a frame; that thickness
 * catches the sun along its top edge and is the brightest line on the sign.
 *
 * `n` is the outward direction of the *front* face in the local frame: +1 for
 * a face looking along +u, which is how a blade hung on a wall is presented to
 * a viewer coming down the street.
 */
function board(
  S: Emit, f: Face,
  u: number, y0: number, y1: number, d0: number, d1: number,
  t: number, row: number, kind: number, seed: number, tone: number,
): void {
  const w = d1 - d0, h = y1 - y0;
  S.attr('aSign', row, kind, seed, tone);
  S.attr('aSign2', w / Math.max(h, 1e-3), 0, 0, 0);
  /* uv runs 0..1 across the set face rather than in metres, because the
   * lettering is laid out as a fraction of the board and not at a fixed size:
   * a signwriter fills the board he is given. Every other material in this
   * project uses metres for uv and this is the deliberate exception. */
  const q = (
    a: [number, number, number], b: [number, number, number],
    c: [number, number, number], e: [number, number, number],
    uv: [number, number][],
  ) => f.quadFree(a, b, c, e, uv);

  // Front, looking along +u.
  q([u + t, y0, d0], [u + t, y1, d0], [u + t, y1, d1], [u + t, y0, d1],
    [[0, 0], [0, 1], [1, 1], [1, 0]]);
  // Back, looking along -u. Mirrored by the shader from the derivatives, so
  // the same row reads correctly from the other side of the street.
  q([u - t, y0, d1], [u - t, y1, d1], [u - t, y1, d0], [u - t, y0, d0],
    [[0, 0], [0, 1], [1, 1], [1, 0]]);
  // Edges. Marked as PLATE so the shader paints them as the board's frame
  // rather than trying to set type on a 24 mm strip.
  S.attr('aSign', row, SIGN_KIND.PLATE, seed, -1);
  q([u - t, y1, d0], [u - t, y1, d1], [u + t, y1, d1], [u + t, y1, d0],
    [[0, 0], [1, 0], [1, 1], [0, 1]]);
  q([u - t, y0, d1], [u - t, y0, d0], [u + t, y0, d0], [u + t, y0, d1],
    [[0, 0], [1, 0], [1, 1], [0, 1]]);
  q([u - t, y0, d1], [u - t, y1, d1], [u + t, y1, d1], [u + t, y0, d1],
    [[0, 0], [0, 1], [1, 1], [1, 0]]);
  q([u + t, y0, d0], [u + t, y1, d0], [u - t, y1, d0], [u - t, y0, d0],
    [[0, 0], [0, 1], [1, 1], [1, 0]]);
}

/**
 * The cranked bracket a blade hangs on.
 *
 * Two horizontal arms and a diagonal strut back to the wall, which is the
 * standard fabrication and, more to the point, the one whose shadow is
 * recognisable: the diagonal is what says bracket rather than shelf. Emitted
 * into the prop buffer so it shares the street's ironwork material and costs
 * no extra draw call.
 */
function bracket(
  P: Emit, pf: Face, u: number, yTop: number, out: number, drop: number, seed: number,
): void {
  P.attr('aProp', PMAT.IRON, seed, yTop - 3.0, 0.25);
  const t = 0.022;
  // Wall plate, with the two bolts that hold it. 8 mm proud, so the plate has
  // an edge shadow of its own against the render.
  for (const dy of [0, -drop]) {
    pf.box(u - 0.055, u + 0.055, yTop + dy - 0.075, yTop + dy + 0.075, 0.0, 0.014);
  }
  // The arms, held 14 mm off the wall on the plate.
  for (const dy of [0, -drop]) {
    pf.box(u - t, u + t, yTop + dy - t, yTop + dy + t, 0.014, 0.014 + out);
  }
  /* The diagonal, as a swept section in the (y, d) plane. `Face.bar` sweeps a
   * cross-section along u, so a parallelogram section is an exact diagonal
   * strut — which is the one shape a box cannot express and the one the eye
   * uses to recognise the assembly. */
  const yA = yTop - drop * 0.06, dA = 0.020;
  const yB = yTop - drop * 0.94, dB = 0.014 + out * 0.92;
  const nx = yB - yA, nd = -(dB - dA);
  const nl = Math.hypot(nx, nd) || 1;
  const ox = (nx / nl) * 0.016, od = (nd / nl) * 0.016;
  pf.bar(u - 0.012, u + 0.012, [
    [yA - ox, dA - od], [yA + ox, dA + od], [yB + ox, dB + od], [yB - ox, dB - od],
  ]);
  // A scroll at the outer end, which every old bracket has and which is two
  // boxes at the size it is ever seen.
  pf.box(u - 0.014, u + 0.014, yTop - 0.10, yTop + 0.02, 0.014 + out - 0.02, 0.014 + out + 0.03);
}

/* ── Placement ───────────────────────────────────────────────────────────── */

type Kit = { S: Emit; P: Emit; sf: Face; pf: Face; b: Bldg; d: number };

/* Word choice by trade rather than by dice.
 *
 * A blade over a barber says BARBERS. Pulling the row at random from the whole
 * fascia list gives a street where the blade and the fascia under it advertise
 * two different businesses, which is a thing the eye notices without being
 * able to say why. Hashing both off the same building seed at least keeps one
 * building consistent with itself.
 */
function rowFor(atlas: ReturnType<typeof signAtlas>, seed: number, salt: number): number {
  return atlas.fascia0 + Math.floor(h2(seed * 41.3, salt) * atlas.fasciaN) % atlas.fasciaN;
}

function signsOn(k: Kit, atlas: ReturnType<typeof signAtlas>): void {
  const { S, P, sf, pf, b, d } = k;
  const { openTop } = groundLevels(b);
  const piers = pierCentres(b);
  const holes = groundOpenings(b);
  const s = b.seed;
  const originY = b.base + b.gh;

  /* ── Blades ────────────────────────────────────────────────────────────
   *
   * One per building on most of them and two on the wide ones, hung on a pier
   * because a bracket has to go into solid masonry — the same constraint that
   * puts facade.ts's meter boxes on piers, and for the same reason: there is
   * nothing behind a shopfront to bolt to.
   *
   * The height is set by the law rather than by composition. A projecting sign
   * has to clear 2.4 m over a public footway, and the fascia head is between
   * 2.9 and 4.1 m up, so a blade sits with its foot just above head height and
   * its top level with or just above the fascia. That band is narrow and it is
   * why every blade on a real street is roughly the same height, which is
   * itself worth having: it gives the frontage a second horizontal to play the
   * roofline against.
   */
  const nBlade = b.L > 11 ? 2 : 1;
  for (let i = 0; i < nBlade; i++) {
    if (h2(s * 31 + i * 7.1, 2.4) < 0.28) continue;
    const u = piers[Math.min(piers.length - 1, 1 + Math.floor(h2(s * 19, i * 3.3) * Math.max(1, piers.length - 1)))];
    const out = 0.86 + h2(s, i * 5.1) * 0.42;
    const h = 0.62 + h2(s, i * 2.7) * 0.52;
    const yTop = openTop + 0.30 + h2(s, i * 9.9) * 0.40;
    if (yTop - h < b.base + 2.35) continue;      // headroom over the footway
    bracket(P, pf, u, yTop, out + 0.10, h + 0.10, s + i);
    board(S, sf, u, yTop - h, yTop, d + 0.16, d + 0.16 + out, 0.014,
      rowFor(atlas, s, i * 1.7), SIGN_KIND.BLADE, h2(s, i * 4.4), h2(s * 3, i));
  }

  /* ── A hanging board ───────────────────────────────────────────────────
   *
   * Older than the blade and hung *under* its arm rather than bolted to it, so
   * it swings — which here means it is a couple of degrees off plumb, because
   * a hanging sign that is exactly vertical is the one thing they never are.
   * Rarer than the blade: about one building in four.
   */
  if (h2(s, 12.7) > 0.72 && piers.length > 1) {
    const u = piers[piers.length - 1];
    const out = 0.62 + h2(s, 3.9) * 0.28;
    const yArm = openTop + 0.52;
    bracket(P, pf, u, yArm, out + 0.08, 0.34, s * 1.7);
    // The two eyes the board hangs from, then the board itself.
    P.attr('aProp', PMAT.IRON, s, b.base, 0.25);
    for (const dd of [d + 0.30, d + 0.16 + out]) {
      pf.box(u - 0.010, u + 0.010, yArm - 0.10, yArm, dd - 0.010, dd + 0.010);
    }
    board(S, sf, u, yArm - 0.72, yArm - 0.11, d + 0.24, d + 0.24 + out * 0.86, 0.016,
      rowFor(atlas, s, 6.6), SIGN_KIND.HANGING, h2(s, 8.8), h2(s * 7, 1.1));
  }

  /* ── The painted band above the fascia ─────────────────────────────────
   *
   * The strip of solid wall between the head of the shopfront and the first
   * floor windows is the one large uninterrupted rectangle on any street
   * building, it is 300 to 900 mm tall and eight metres wide, and on a real
   * parade about a third of them carry a painted name on it that predates the
   * current tenant by fifty years.
   *
   * It is a painted-out panel rather than lettering straight onto the brick,
   * because that is what a signwriter actually did — he blocked the wall out
   * in one colour and set the name in another — and because a decal blended
   * over masonry would have to match a shader it cannot see. 8 mm proud, which
   * is a hundred years of paint build and is enough for the sunward edge to
   * draw a line.
   */
  const bandY0 = openTop + 0.34;
  const bandY1 = originY - (b.band ? 0.22 : 0.06);
  if (bandY1 - bandY0 > 0.34 && h2(s, 21.1) > 0.52) {
    const inset = 0.18 + h2(s, 5.5) * 0.30;
    const hh = Math.min(bandY1 - bandY0, 0.42 + h2(s, 7.7) * 0.55);
    const y0 = bandY0 + (bandY1 - bandY0 - hh) * 0.5;
    S.attr('aSign', rowFor(atlas, s, 13.3), SIGN_KIND.GHOST, h2(s, 17.7), h2(s * 11, 2.2));
    S.attr('aSign2', (b.L - inset * 2) / Math.max(hh, 1e-3), 0, 0, 0);
    sf.quadFree(
      [inset, y0, d + 0.008], [inset, y0 + hh, d + 0.008],
      [b.L - inset, y0 + hh, d + 0.008], [b.L - inset, y0, d + 0.008],
      [[0, 0], [0, 1], [1, 1], [1, 0]],
    );
  }

  /* ── Enamel plates and window lettering ────────────────────────────────
   *
   * The small stuff: a trade plate screwed to a pier, and the signwriting on
   * the glass that every shop has and that no render ever does. Both are one
   * quad. They are worth their quad because they are at eye height, which is
   * where the frame has the most resolution to spend.
   */
  for (let i = 0; i < holes.length; i++) {
    const o = holes[i];
    if (h2(s * 53 + i * 3.1, 6.1) < 0.55) continue;
    const w = Math.min(1.35, (o.u1 - o.u0) * 0.62);
    const uc = (o.u0 + o.u1) * 0.5;
    const y = b.base + 1.62 + h2(s + i, 2.2) * 0.34;
    const hh = 0.13 + h2(s + i, 4.4) * 0.06;
    S.attr('aSign', rowFor(atlas, s, i * 2.9), SIGN_KIND.PLATE, h2(s + i, 1.1), 0.5);
    S.attr('aSign2', w / hh, 0, 0, 0);
    /* 35 mm in front of the glazing plane. The shopfront glass sits at
     * `d0 - rec` and the shutter curtain hangs just in front of it, so this
     * has to clear both — a lettering decal that z-fights with a roller
     * shutter is worse than no lettering at all. */
    const dd = d - o.rec + 0.035;
    sf.quadFree(
      [uc - w * 0.5, y, dd], [uc - w * 0.5, y + hh, dd],
      [uc + w * 0.5, y + hh, dd], [uc + w * 0.5, y, dd],
      [[0, 0], [0, 1], [1, 1], [1, 0]],
    );
  }

  // A trade plate on the last pier, at door height.
  if (h2(s, 27.3) > 0.55) {
    const u = piers[0];
    const y = b.base + 1.48;
    const w = 0.44, hh = 0.16;
    S.attr('aSign', atlas.plate0 + Math.floor(h2(s, 9.1) * 2) * 2, SIGN_KIND.PLATE, h2(s, 3.3), 0.18);
    S.attr('aSign2', w / hh, 0, 0, 0);
    sf.quadFree(
      [u - w * 0.5, y, d + 0.010], [u - w * 0.5, y + hh, d + 0.010],
      [u + w * 0.5, y + hh, d + 0.010], [u + w * 0.5, y, d + 0.010],
      [[0, 0], [0, 1], [1, 1], [1, 0]],
    );
  }
}

/**
 * Every projecting sign on the street.
 *
 * Panels go into their own buffer because they need the sign atlas and a
 * material that can set type; the ironwork holding them up goes into the prop
 * buffer that is passed in, because a bracket is street ironwork and there is
 * no reason to pay a second draw call for it.
 */
export function emitSignage(P: Emit): Emit {
  const S = new Emit({ aSign: 4, aSign2: 4 });
  const atlas = signAtlas();
  const { bldgs } = layoutBlock((x, z) => walkHeight(x, z));
  for (const b of bldgs) {
    if (!b.street) continue;
    const zc = b.frame.oz + b.frame.uz * (b.L * 0.5);
    // Behind the camera at one end, dissolved in haze at the other.
    if (zc > 12 || zc < -108) continue;
    signsOn({
      S, P,
      sf: new Face(S, b.frame), pf: new Face(P, b.frame),
      b, d: b.d0,
    }, atlas);
  }
  return S;
}
