/* The footway prop kit.
 *
 * Twenty small objects, every one of them built from boxes, prisms and
 * tapered tubes in the facade-local (u, y, d) frame that `emit.ts` defines,
 * and every one of them merged into a single buffer. One buffer is one draw
 * call and one shadow-pass call for the whole of the street's clutter, which
 * is what makes it affordable to have a hundred and fifty of them: the
 * alternative — a mesh per bin bag — is a hundred and fifty draws and would
 * cost more than the entire block of buildings does.
 *
 * ── What these are for ────────────────────────────────────────────────────
 *
 * Not decoration. At 4.2 degrees the sun is nearly horizontal, so a 900 mm
 * bollard throws seven metres of shadow across the paving and a pile of sacks
 * throws four. The reason the empty stretches of this street read as empty is
 * not that the paving is bare, it is that the paving is *unmarked* — an
 * uninterrupted sheet of one tone with a single long gradient across it. Every
 * object below is worth its own footprint plus five to ten times that in cast
 * shadow, and the shadow is the part the eye reads.
 *
 * That is also why nothing here is a billboard and nothing is flush. A prop
 * has to have a top, a side turned to the sun and a side turned away, or it
 * contributes a silhouette and nothing else.
 *
 * ── Dimensions ───────────────────────────────────────────────────────────
 *
 * Real, in millimetres, the same rule the rest of the project runs on. A
 * traffic cone is 750 mm to the tip on a 360 mm base. A Euro pallet is
 * 1200 x 800 x 144. A 240 litre wheelie bin is 1075 tall, 580 wide and 740
 * deep over the lid. A parking meter head sits at 1.2 m. These are the
 * numbers that make a street photograph read at the right scale, and they are
 * the one thing that cannot be recovered afterwards by grading.
 */
import * as THREE from 'three';
import { Emit, Face, frame } from './emit';
import { walkHeight } from './geometry';
import { props, type Prop, type PropKind } from './placement';
import { emitSignage } from './signage';
import { PMAT } from './propKinds';

export { PMAT };

const h2 = (a: number, b: number): number => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/* ── Primitives ──────────────────────────────────────────────────────────── */

/**
 * A tapered n-sided tube: cones, bollard shafts, sack bodies, cone bodies.
 *
 * Wound exactly the way `Face.tube` is wound, and that is not a stylistic
 * choice. The local basis is left handed — see the note on `lcross` in
 * street3.ts — so a prism assembled from first principles has an even chance
 * of coming out inside out, and an inside-out prism is invisible in the beauty
 * pass *and* in the shadow pass. This project has shipped that bug twice. The
 * safe move is to copy the winding of something already known to render.
 */
function frustum(
  f: Face, uc: number, dc: number,
  r0: number, r1: number, y0: number, y1: number,
  sides = 8, capTop = true, capBot = false,
): void {
  const pt = (i: number, y: number, r: number): [number, number, number] => {
    const a = (i / sides) * Math.PI * 2;
    return [uc + Math.cos(a) * r, y, dc + Math.sin(a) * r];
  };
  for (let i = 0; i < sides; i++) {
    f.quadFree(
      pt(i, y0, r0), pt(i + 1, y0, r0), pt(i + 1, y1, r1), pt(i, y1, r1),
      [[i, y0], [i + 1, y0], [i + 1, y1], [i, y1]],
    );
  }
  if (capTop && r1 > 1e-4) {
    for (let i = 1; i < sides - 1; i++) {
      f.quadFree(pt(0, y1, r1), pt(i, y1, r1), pt(i + 1, y1, r1), pt(i + 1, y1, r1),
        [[0, 0], [i, 0], [i + 1, 0], [i + 1, 0]]);
    }
  }
  if (capBot && r0 > 1e-4) {
    for (let i = 1; i < sides - 1; i++) {
      f.quadFree(pt(0, y0, r0), pt(i + 1, y0, r0), pt(i, y0, r0), pt(i, y0, r0),
        [[0, 0], [i + 1, 0], [i, 0], [i, 0]]);
    }
  }
}

/* ── The kit ─────────────────────────────────────────────────────────────── */

type Ctx = { F: Emit; f: Face; y: number; s: number; k: number };

/** Set the material branch and the seed every subsequent vertex carries. */
function pm(c: Ctx, mat: number, tone = 0.5): void {
  c.F.attr('aProp', mat, c.s, c.y, tone);
}

/**
 * A cast iron bollard.
 *
 * The tall tapered kind with a collar and a domed cap, 950 mm above the
 * paving. Every one on a real street has been clipped by something and leans
 * a degree or two, which is modelled by tilting the whole frame rather than by
 * shearing the geometry — see `emitProp`, which applies the lean before the
 * object is built.
 */
function bollard(c: Ctx): void {
  const { f, y, k } = c;
  const h = 0.86 + h2(k, 1.1) * 0.16;
  pm(c, PMAT.IRON, 0.30 + h2(k, 2.2) * 0.25);
  frustum(f, 0, 0, 0.105, 0.086, y, y + h * 0.80, 10, false);
  frustum(f, 0, 0, 0.086, 0.098, y + h * 0.80, y + h * 0.86, 10, false);   // collar
  frustum(f, 0, 0, 0.098, 0.088, y + h * 0.86, y + h * 0.94, 10, false);
  frustum(f, 0, 0, 0.088, 0.030, y + h * 0.94, y + h, 10, true);           // dome
  // Base spread, which is what stops it looking pushed into the paving.
  frustum(f, 0, 0, 0.135, 0.105, y - 0.01, y + 0.07, 10, false);
  /* The painted band near the top. On a real bollard it is reflective tape and
   * it is the one part that catches a low sun, so it is 3 mm of geometry
   * rather than a shader stripe — the tape stands proud and its edge shadows. */
  pm(c, PMAT.PAINT, 0.92);
  frustum(f, 0, 0, 0.092, 0.092, y + h * 0.62, y + h * 0.70, 10, false);
}

/** A parking meter: post, cranked head, coin face. */
function meter(c: Ctx): void {
  const { f, y, k } = c;
  const hp = 1.02 + h2(k, 1.7) * 0.10;
  pm(c, PMAT.GALV, 0.5);
  frustum(f, 0, 0, 0.041, 0.036, y, y + hp, 8, false);
  frustum(f, 0, 0, 0.058, 0.046, y, y + 0.06, 8, false);
  pm(c, PMAT.PAINT, 0.22 + h2(k, 5.5) * 0.2);
  // The head is not on the axis of the post: it is cranked out over the kerb
  // so a driver can reach it, and that offset is most of the silhouette.
  f.box(-0.115, 0.115, y + hp, y + hp + 0.34, 0.02, 0.20);
  f.box(-0.098, 0.098, y + hp + 0.34, y + hp + 0.40, 0.03, 0.185);
  pm(c, PMAT.ALLOY, 0.7);
  // Display bezel and the coin slot plate, 12 mm proud so they cast.
  f.box(-0.072, 0.072, y + hp + 0.18, y + hp + 0.30, 0.20, 0.212);
  f.box(-0.030, 0.030, y + hp + 0.09, y + hp + 0.14, 0.20, 0.209);
}

/**
 * A free-sheet vending box.
 *
 * Two legs, a hopper on top, a sloped clear front. They stand in twos and
 * threes because the second one was put beside the first, which the cluster
 * kit in placement.ts arranges; here it is one box.
 */
function newsbox(c: Ctx): void {
  const { f, y, k } = c;
  const w = 0.215, dp = 0.175;
  pm(c, PMAT.PAINT, h2(k, 2.3));
  for (const su of [-1, 1]) {
    f.box(su * w - 0.028, su * w + 0.028, y, y + 0.36, -dp + 0.02, -dp + 0.07);
    f.box(su * w - 0.028, su * w + 0.028, y, y + 0.36, dp - 0.07, dp - 0.02);
  }
  f.box(-w - 0.02, w + 0.02, y + 0.36, y + 0.78, -dp, dp);
  // The sloped reading window, and the lip under it that a hand pulls on.
  pm(c, PMAT.ALLOY, 0.6);
  f.box(-w, w, y + 0.60, y + 0.755, dp, dp + 0.022);
  pm(c, PMAT.PAINT, h2(k, 7.9));
  f.box(-w - 0.03, w + 0.03, y + 0.78, y + 0.815, -dp - 0.02, dp + 0.02);
  f.box(-w * 0.5, w * 0.5, y + 0.815, y + 0.845, -dp + 0.04, dp - 0.04);
}

/** A municipal litter bin: a perforated drum on a single post. */
function binpost(c: Ctx): void {
  const { f, y, k } = c;
  pm(c, PMAT.IRON, 0.28);
  frustum(f, 0, 0, 0.048, 0.044, y, y + 0.52, 8, false);
  frustum(f, 0, 0, 0.072, 0.056, y, y + 0.055, 8, false);
  const r = 0.205 + h2(k, 1.3) * 0.02;
  frustum(f, 0, 0, r * 0.86, r, y + 0.52, y + 1.06, 10, false);
  // Hoop rails top and bottom. A bin without them is a bucket.
  frustum(f, 0, 0, r + 0.014, r + 0.014, y + 0.545, y + 0.585, 10, false);
  frustum(f, 0, 0, r + 0.016, r + 0.016, y + 1.005, y + 1.055, 10, false);
  pm(c, PMAT.GALV, 0.55);
  // The hood, offset back so the opening faces the footway.
  f.box(-r * 0.9, r * 0.9, y + 1.06, y + 1.12, -r, r * 0.35);
  f.box(-r * 0.92, r * 0.92, y + 1.06, y + 1.20, -r - 0.02, -r * 0.55);
}

/** A 240 litre plastic trade wheelie bin. */
function wheelie(c: Ctx): void {
  const { f, y, k } = c;
  const hw = 0.29, hd = 0.245, hgt = 0.94;
  const tone = h2(k, 4.4);
  pm(c, PMAT.PLASTIC, tone);
  // The shell tapers so bins nest; 40 mm over the height, which is readable
  // at three metres and is the difference between a bin and a box.
  frustumBox(f, hw * 0.86, hd * 0.84, hw, hd, y + 0.10, y + hgt);
  // Lid, up a few degrees on the ones that are full.
  const open = h2(k, 8.1) > 0.6 ? 0.22 : 0.02;
  const ly = y + hgt;
  f.quadFree(
    [-hw, ly, -hd], [hw, ly, -hd],
    [hw, ly + Math.sin(open) * (hd * 2), hd], [-hw, ly + Math.sin(open) * (hd * 2), hd],
    [[0, 0], [1, 0], [1, 1], [0, 1]],
  );
  f.box(-hw - 0.012, hw + 0.012, ly, ly + 0.035, -hd - 0.012, -hd + 0.02);
  // Comb bar across the front, which every trade bin has for the lifter.
  f.box(-hw * 0.7, hw * 0.7, y + hgt - 0.14, y + hgt - 0.09, hd, hd + 0.035);
  pm(c, PMAT.RUBBER, 0.3);
  for (const su of [-1, 1]) {
    frustum(f, su * (hw - 0.07), -hd + 0.06, 0.052, 0.052, y, y + 0.104, 7, true);
  }
  pm(c, PMAT.PLASTIC, tone);
  // Axle housing, so the wheels are attached to something.
  f.box(-hw + 0.03, hw - 0.03, y + 0.06, y + 0.13, -hd, -hd + 0.06);
}

/** A rectangular frustum, for tapered mouldings. */
function frustumBox(
  f: Face, hw0: number, hd0: number, hw1: number, hd1: number, y0: number, y1: number,
): void {
  const q = (
    a: [number, number, number], b: [number, number, number],
    cc: [number, number, number], d: [number, number, number],
  ) => f.quadFree(a, b, cc, d, [[a[0], a[1]], [b[0], b[1]], [cc[0], cc[1]], [d[0], d[1]]]);
  // Front (+d), back (-d), then the two ends, wound to match Face.box.
  q([-hw0, y0, hd0], [-hw1, y1, hd1], [hw1, y1, hd1], [hw0, y0, hd0]);
  q([-hw0, y0, -hd0], [hw0, y0, -hd0], [hw1, y1, -hd1], [-hw1, y1, -hd1]);
  q([hw0, y0, -hd0], [hw0, y0, hd0], [hw1, y1, hd1], [hw1, y1, -hd1]);
  q([-hw0, y0, -hd0], [-hw1, y1, -hd1], [-hw1, y1, hd1], [-hw0, y0, hd0]);
  q([-hw1, y1, -hd1], [hw1, y1, -hd1], [hw1, y1, hd1], [-hw1, y1, hd1]);
}

/** A pile of refuse sacks, leaning on each other. */
function bags(c: Ctx): void {
  const { f, y, k } = c;
  const n = 3 + Math.floor(h2(k, 1.9) * 3);
  for (let i = 0; i < n; i++) {
    const s = k * 11.3 + i * 4.7;
    pm(c, PMAT.POLY, 0.35 + h2(s, 9.1) * 0.4);
    const uu = (h2(s, 1.1) - 0.5) * 0.86;
    const dd = (h2(s, 2.2) - 0.5) * 0.50;
    const hgt = 0.42 + h2(s, 3.3) * 0.20;
    const r = 0.175 + h2(s, 4.4) * 0.065;
    // Later sacks sit up on the ones already there; the pile has a shape.
    const rest = y + (i > 1 ? 0.07 * h2(s, 6.6) : 0) - 0.012;
    sackAt(f, uu, dd, r, hgt, rest, s);
  }
}

function sackAt(
  f: Face, uc: number, dc: number, r: number, h: number, y: number, seed: number,
): void {
  const lean = (h2(seed, 3.1) - 0.5) * 0.09;
  frustum(f, uc, dc, r * 0.80, r, y, y + h * 0.34, 7, false, true);
  frustum(f, uc + lean * 0.4, dc + lean * 0.3, r, r * 0.72, y + h * 0.34, y + h * 0.72, 7, false);
  frustum(f, uc + lean, dc + lean * 0.8, r * 0.72, r * 0.16, y + h * 0.72, y + h * 0.96, 7, false);
  frustum(f, uc + lean, dc + lean * 0.8, r * 0.16, r * 0.24, y + h * 0.96, y + h, 6, true);
}

/** Stacked bottle crates. */
function crates(c: Ctx): void {
  const { f, y, k } = c;
  const n = 2 + Math.floor(h2(k, 2.7) * 3);
  const w = 0.20, dp = 0.155, hh = 0.145;
  for (let i = 0; i < n; i++) {
    const s = k * 7.1 + i * 3.3;
    pm(c, i % 2 === 0 ? PMAT.PLASTIC : PMAT.TIMBER, h2(s, 5.1));
    // Each crate is rotated a few degrees off the one under it, which is what
    // a stack that has been carried actually looks like.
    const ju = (h2(s, 1.3) - 0.5) * 0.045;
    const jd = (h2(s, 2.6) - 0.5) * 0.045;
    const yb = y + i * (hh + 0.004);
    // Walls only: the inside of the top crate is visible and a solid block
    // reads as a block of wood.
    f.box(-w + ju, w + ju, yb, yb + hh, dp - 0.016 + jd, dp + jd);
    f.box(-w + ju, w + ju, yb, yb + hh, -dp + jd, -dp + 0.016 + jd);
    f.box(-w + ju, -w + 0.016 + ju, yb, yb + hh, -dp + jd, dp + jd);
    f.box(w - 0.016 + ju, w + ju, yb, yb + hh, -dp + jd, dp + jd);
    f.box(-w + ju, w + ju, yb, yb + 0.014, -dp + jd, dp + jd);
  }
}

/** A pallet, leaning against the wall the way they are always left. */
function pallet(c: Ctx): void {
  const { f, y, k } = c;
  pm(c, PMAT.TIMBER, 0.4 + h2(k, 1.4) * 0.35);
  const W = 0.60, H = 0.80, t = 0.020;
  // Leaning back against the frontage: 14 degrees, so the top is 190 mm in
  // from the foot and the whole thing throws a long triangular shadow.
  const tilt = 0.24;
  const q = (
    u0: number, u1: number, v0: number, v1: number, off: number,
  ) => {
    const d0 = -off, d1 = -off - t;
    f.quadFree(
      [u0, y + v0, d0 - v0 * tilt], [u0, y + v1, d0 - v1 * tilt],
      [u1, y + v1, d0 - v1 * tilt], [u1, y + v0, d0 - v0 * tilt],
      [[u0, v0], [u0, v1], [u1, v1], [u1, v0]],
    );
    f.quadFree(
      [u0, y + v0, d1 - v0 * tilt], [u1, y + v0, d1 - v0 * tilt],
      [u1, y + v1, d1 - v1 * tilt], [u0, y + v1, d1 - v1 * tilt],
      [[u0, v0], [u1, v0], [u1, v1], [u0, v1]],
    );
    // Edges, so the boards have thickness at the silhouette.
    f.quadFree(
      [u0, y + v1, d0 - v1 * tilt], [u0, y + v1, d1 - v1 * tilt],
      [u1, y + v1, d1 - v1 * tilt], [u1, y + v1, d0 - v1 * tilt],
      [[u0, 0], [u0, 1], [u1, 1], [u1, 0]],
    );
  };
  // Deck boards with the gaps between them: the gaps are the whole point,
  // because a low sun prints them on the wall behind as a ladder of light.
  for (let i = 0; i < 5; i++) {
    const v0 = H * (i / 5) + 0.012;
    q(-W * 0.5, W * 0.5, v0, v0 + H * 0.115, 0.05);
  }
  // Bearers, on the face towards the street.
  for (const u of [-W * 0.5 + 0.03, 0, W * 0.5 - 0.03]) {
    q(u - 0.028, u + 0.028, 0.01, H - 0.01, 0.02);
  }
}

/** Flattened cardboard, bundled and put out with the sacks. */
function boxes(c: Ctx): void {
  const { f, y, k } = c;
  pm(c, PMAT.CARD, 0.45 + h2(k, 3.7) * 0.3);
  const n = 2 + Math.floor(h2(k, 1.2) * 3);
  for (let i = 0; i < n; i++) {
    const s = k * 5.9 + i * 2.1;
    /* Cardboard put out in the rain slumps. Each bundle leans a different way
     * and none of them are square to the wall, which is the only thing that
     * stops a stack of boxes reading as a stack of boxes. */
    const lean = (h2(s, 1.1) - 0.5) * 0.30;
    const w = 0.22 + h2(s, 2.2) * 0.16;
    const hgt = 0.30 + h2(s, 3.3) * 0.24;
    const dp = 0.055 + h2(s, 4.4) * 0.04;
    const uu = (h2(s, 5.5) - 0.5) * 0.55;
    const dd = (h2(s, 6.6) - 0.5) * 0.16;
    f.quadFree(
      [uu - w, y, dd + dp], [uu - w + lean, y + hgt, dd + dp],
      [uu + w + lean, y + hgt, dd + dp], [uu + w, y, dd + dp],
      [[0, 0], [0, 1], [1, 1], [1, 0]],
    );
    f.quadFree(
      [uu - w, y, dd - dp], [uu + w, y, dd - dp],
      [uu + w + lean, y + hgt, dd - dp], [uu - w + lean, y + hgt, dd - dp],
      [[0, 0], [1, 0], [1, 1], [0, 1]],
    );
    f.quadFree(
      [uu + w, y, dd - dp], [uu + w, y, dd + dp],
      [uu + w + lean, y + hgt, dd + dp], [uu + w + lean, y + hgt, dd - dp],
      [[0, 0], [0, 1], [1, 1], [1, 0]],
    );
    f.quadFree(
      [uu - w, y, dd - dp], [uu - w + lean, y + hgt, dd - dp],
      [uu - w + lean, y + hgt, dd + dp], [uu - w, y, dd + dp],
      [[0, 0], [0, 1], [1, 1], [1, 0]],
    );
    f.quadFree(
      [uu - w + lean, y + hgt, dd - dp], [uu + w + lean, y + hgt, dd - dp],
      [uu + w + lean, y + hgt, dd + dp], [uu - w + lean, y + hgt, dd + dp],
      [[0, 0], [1, 0], [1, 1], [0, 1]],
    );
  }
}

/**
 * Pavement cellar doors.
 *
 * Two cast leaves in a stone frame, flush with the flags and 20 mm proud of
 * them. Almost nothing in plan and a great deal in the frame: they are one of
 * the very few things that says the footway has a *thickness*, that there is a
 * vault under it, and at this sun angle the 20 mm upstand draws a hard black
 * line along the two sunward edges that is legible from twenty metres.
 */
function cellar(c: Ctx): void {
  const { f, y, k } = c;
  const W = 0.52, D = 0.42;
  pm(c, PMAT.CONCRETE, 0.6);
  // Stone kerb frame around the opening.
  f.box(-W - 0.07, W + 0.07, y - 0.05, y + 0.022, -D - 0.07, D + 0.07);
  pm(c, PMAT.IRON, 0.35 + h2(k, 2.2) * 0.2);
  for (const su of [-1, 1]) {
    const u0 = su > 0 ? 0.008 : -W;
    const u1 = su > 0 ? W : -0.008;
    f.box(u0, u1, y + 0.014, y + 0.040, -D, D);
    // The raised chequer ribs. Four bars a leaf, which is enough to break the
    // specular and to say cast iron rather than steel plate.
    for (let i = 0; i < 4; i++) {
      const dd = -D + D * 2 * ((i + 0.5) / 4);
      f.box(u0 + 0.02, u1 - 0.02, y + 0.040, y + 0.049, dd - 0.022, dd + 0.022);
    }
    // Lifting eye, recessed. Every cellar door has two and they are what the
    // eye recognises.
    f.box(su * (W * 0.55) - 0.035, su * (W * 0.55) + 0.035,
      y + 0.040, y + 0.047, -0.030, 0.030);
  }
}

/** A cast gully grate or a vault light, flush in the flags. */
function grate(c: Ctx): void {
  const { f, y, k } = c;
  const W = 0.22 + h2(k, 1.1) * 0.10, D = 0.16 + h2(k, 2.1) * 0.08;
  pm(c, PMAT.CONCRETE, 0.55);
  f.box(-W - 0.05, W + 0.05, y - 0.04, y + 0.014, -D - 0.05, D + 0.05);
  pm(c, PMAT.IRON, 0.30);
  f.box(-W, W, y + 0.006, y + 0.026, -D, D);
  const n = 5;
  for (let i = 0; i < n; i++) {
    const dd = -D + D * 2 * ((i + 0.5) / n);
    /* The slots are the object. A grate modelled as a flat plate is a stain on
     * the paving; the bars have to stand 8 mm above the frame so that each one
     * puts a shadow in the slot beside it. */
    f.box(-W + 0.018, W - 0.018, y + 0.026, y + 0.034, dd - 0.016, dd + 0.016);
  }
}

/** A fire-service inlet: a galvanised box on the plinth with two couplings. */
function standpipe(c: Ctx): void {
  const { f, y, k } = c;
  pm(c, PMAT.GALV, 0.5);
  const hgt = 0.62 + h2(k, 1.7) * 0.16;
  f.box(-0.21, 0.21, y + 0.30, y + 0.30 + hgt, -0.11, 0.11);
  // Door and its frame, two rebates, which at this sun is a hard vertical line.
  f.box(-0.185, 0.185, y + 0.33, y + 0.27 + hgt, 0.11, 0.128);
  f.box(0.10, 0.145, y + 0.30 + hgt * 0.5, y + 0.30 + hgt * 0.5 + 0.05, 0.128, 0.148);
  pm(c, PMAT.IRON, 0.28);
  // Legs down to the paving, and the pipe stub going into the wall.
  for (const su of [-1, 1]) {
    f.box(su * 0.17 - 0.022, su * 0.17 + 0.022, y, y + 0.32, -0.055, 0.0);
  }
  pm(c, PMAT.ALLOY, 0.62);
  // Two 65 mm instantaneous couplings, angled down, which is the detail that
  // says fire service rather than electricity meter.
  for (const su of [-1, 1]) {
    frustumAlongD(f, su * 0.10, y + 0.30 + hgt * 0.42, 0.055, 0.048, 0.11, 0.20);
    frustumAlongD(f, su * 0.10, y + 0.30 + hgt * 0.42, 0.062, 0.062, 0.20, 0.225);
  }
}

/** A short tube lying along d rather than standing up: nozzles and couplings. */
function frustumAlongD(
  f: Face, uc: number, yc: number, r0: number, r1: number, d0: number, d1: number,
  sides = 7,
): void {
  const pt = (i: number, d: number, r: number): [number, number, number] => {
    const a = (i / sides) * Math.PI * 2;
    return [uc + Math.cos(a) * r, yc + Math.sin(a) * r, d];
  };
  for (let i = 0; i < sides; i++) {
    f.quadFree(pt(i, d0, r0), pt(i, d1, r1), pt(i + 1, d1, r1), pt(i + 1, d0, r0),
      [[i, 0], [i, 1], [i + 1, 1], [i + 1, 0]]);
  }
  for (let i = 1; i < sides - 1; i++) {
    f.quadFree(pt(0, d1, r1), pt(i, d1, r1), pt(i + 1, d1, r1), pt(i + 1, d1, r1),
      [[0, 0], [i, 0], [i + 1, 0], [i + 1, 0]]);
  }
}

/**
 * A pillar hydrant.
 *
 * The same 790 mm to the operating nut that street3.ts's one is built to,
 * because that is what a hydrant is and it is one of the very few objects in a
 * street photograph whose size everybody already knows. Built here as well
 * rather than shared because it belongs to this buffer and this material; the
 * dimensions are the shared thing, not the code.
 */
function hydrant(c: Ctx): void {
  const { f, y, k } = c;
  pm(c, PMAT.IRON, 0.16 + h2(k, 1.9) * 0.5);
  frustum(f, 0, 0, 0.150, 0.148, y, y + 0.055, 10, false);
  frustum(f, 0, 0, 0.098, 0.093, y + 0.055, y + 0.300, 10, false);
  frustum(f, 0, 0, 0.132, 0.132, y + 0.300, y + 0.362, 10, false);
  frustum(f, 0, 0, 0.093, 0.090, y + 0.362, y + 0.600, 10, false);
  frustum(f, 0, 0, 0.121, 0.118, y + 0.600, y + 0.646, 10, false);
  frustum(f, 0, 0, 0.104, 0.088, y + 0.646, y + 0.712, 9, false);
  frustum(f, 0, 0, 0.062, 0.048, y + 0.712, y + 0.758, 9, false);
  frustum(f, 0, 0, 0.030, 0.028, y + 0.758, y + 0.792, 5, true);
  // Steamer outlet at the road, two hose outlets on the flanks. Without them
  // the silhouette is a tapered post and says nothing.
  frustumAlongD(f, 0, y + 0.455, 0.085, 0.085, 0.085, 0.150, 8);
  frustumAlongD(f, 0, y + 0.455, 0.096, 0.090, 0.150, 0.176, 8);
  for (const su of [-1, 1]) {
    f.bar(su * 0.085, su * 0.132, [
      [y + 0.402, -0.060], [y + 0.402, 0.060], [y + 0.522, 0.060], [y + 0.522, -0.060],
    ]);
    f.bar(su * 0.132, su * 0.156, [
      [y + 0.396, -0.068], [y + 0.396, 0.068], [y + 0.528, 0.068], [y + 0.528, -0.068],
    ]);
  }
}

/** A traffic cone, with the grubby rubber base every one of them has. */
function cone(c: Ctx): void {
  const { f, y, k } = c;
  const h = 0.72 + h2(k, 1.5) * 0.06;
  pm(c, PMAT.RUBBER, 0.3);
  f.box(-0.175, 0.175, y, y + 0.032, -0.175, 0.175);
  pm(c, PMAT.PLASTIC, 0.97);
  frustum(f, 0, 0, 0.145, 0.030, y + 0.028, y + h, 8, true);
  // The reflective sleeve, 4 mm proud, which is what catches a raking sun.
  pm(c, PMAT.PAINT, 0.90);
  frustum(f, 0, 0, 0.098, 0.078, y + h * 0.42, y + h * 0.60, 8, false);
}

/** An A-board pavement sign, hinged open and never square to anything. */
function aboard(c: Ctx): void {
  const { f, y, k } = c;
  const W = 0.29, H = 0.74, spread = 0.21;
  pm(c, PMAT.TIMBER, 0.3 + h2(k, 2.4) * 0.3);
  for (const sd of [-1, 1]) {
    const d0 = sd * spread, d1 = sd * 0.02;
    f.quadFree(
      [-W, y, d0], [-W, y + H, d1], [W, y + H, d1], [W, y, d0],
      [[0, 0], [0, 1], [1, 1], [1, 0]],
    );
    f.quadFree(
      [-W, y, d0 + sd * 0.022], [W, y, d0 + sd * 0.022],
      [W, y + H, d1 + sd * 0.022], [-W, y + H, d1 + sd * 0.022],
      [[0, 0], [1, 0], [1, 1], [0, 1]],
    );
    f.quadFree(
      [W, y, d0], [W, y, d0 + sd * 0.022], [W, y + H, d1 + sd * 0.022], [W, y + H, d1],
      [[0, 0], [0, 1], [1, 1], [1, 0]],
    );
    f.quadFree(
      [-W, y, d0], [-W, y + H, d1], [-W, y + H, d1 + sd * 0.022], [-W, y, d0 + sd * 0.022],
      [[0, 0], [0, 1], [1, 1], [1, 0]],
    );
  }
}

/** A precast concrete tub with something dead in it. */
function planter(c: Ctx): void {
  const { f, y, k } = c;
  const r = 0.30 + h2(k, 1.1) * 0.06;
  pm(c, PMAT.CONCRETE, 0.4 + h2(k, 2.2) * 0.3);
  frustum(f, 0, 0, r * 0.82, r, y, y + 0.44, 9, false);
  frustum(f, 0, 0, r + 0.022, r + 0.022, y + 0.40, y + 0.46, 9, false);   // rim
  // The soil, dished, so the tub is not an open pipe.
  pm(c, PMAT.CARD, 0.12);
  frustum(f, 0, 0, r - 0.03, r - 0.03, y + 0.36, y + 0.40, 9, true);
  /* A dead shrub: three bare stems and a couple of forks. Nothing in this
   * project is allowed a leaf texture, and a bare winter stem is both honest
   * and better — it is a scribble of shadow on the paving rather than a blob. */
  pm(c, PMAT.TIMBER, 0.18);
  for (let i = 0; i < 4; i++) {
    const a = h2(k * 3, i) * Math.PI * 2;
    const lean = 0.09 + h2(k * 5, i) * 0.16;
    const top = 0.42 + h2(k * 7, i) * 0.44;
    const u0 = Math.cos(a) * 0.05, d0 = Math.sin(a) * 0.05;
    f.quadFree(
      [u0 - 0.011, y + 0.38, d0], [u0 + Math.cos(a) * lean - 0.008, y + 0.38 + top, d0 + Math.sin(a) * lean],
      [u0 + Math.cos(a) * lean + 0.008, y + 0.38 + top, d0 + Math.sin(a) * lean], [u0 + 0.011, y + 0.38, d0],
      [[0, 0], [0, 1], [1, 1], [1, 0]],
    );
    f.quadFree(
      [u0, y + 0.38, d0 - 0.011], [u0, y + 0.38, d0 + 0.011],
      [u0 + Math.cos(a) * lean, y + 0.38 + top, d0 + Math.sin(a) * lean + 0.008],
      [u0 + Math.cos(a) * lean, y + 0.38 + top, d0 + Math.sin(a) * lean - 0.008],
      [[0, 0], [0, 1], [1, 1], [1, 0]],
    );
  }
}

/** A Sheffield cycle hoop, and sometimes a wheel still locked to it. */
function cycle(c: Ctx): void {
  const { f, y, k } = c;
  pm(c, PMAT.GALV, 0.6);
  const W = 0.36, H = 0.68, r = 0.024;
  for (const su of [-1, 1]) {
    frustum(f, su * W, 0, r, r, y - 0.02, y + H, 6, false);
  }
  // The top bend, as three short segments; a real hoop is a 150 mm radius
  // bend and at any distance this is ever seen three chords are a curve.
  const seg = 4;
  for (let i = 0; i < seg; i++) {
    const a0 = Math.PI * (i / seg), a1 = Math.PI * ((i + 1) / seg);
    const u0 = -Math.cos(a0) * W, u1 = -Math.cos(a1) * W;
    const y0 = y + H - 0.14 + Math.sin(a0) * 0.14, y1 = y + H - 0.14 + Math.sin(a1) * 0.14;
    f.quadFree(
      [u0, y0 - r, -r], [u0, y0 + r, -r], [u1, y1 + r, -r], [u1, y1 - r, -r],
      [[0, 0], [0, 1], [1, 1], [1, 0]],
    );
    f.quadFree(
      [u0, y0 - r, r], [u1, y1 - r, r], [u1, y1 + r, r], [u0, y0 + r, r],
      [[0, 0], [1, 0], [1, 1], [0, 1]],
    );
    f.quadFree(
      [u0, y0 + r, -r], [u0, y0 + r, r], [u1, y1 + r, r], [u1, y1 + r, -r],
      [[0, 0], [0, 1], [1, 1], [1, 0]],
    );
    f.quadFree(
      [u0, y0 - r, -r], [u1, y1 - r, -r], [u1, y1 - r, r], [u0, y0 - r, r],
      [[0, 0], [1, 0], [1, 1], [0, 1]],
    );
  }
  // Ground plates, which are what stops it growing out of the flags.
  pm(c, PMAT.IRON, 0.3);
  for (const su of [-1, 1]) {
    f.box(su * W - 0.055, su * W + 0.055, y - 0.005, y + 0.016, -0.055, 0.055);
  }
}

/** A street utility cabinet, bolted to the wall or standing against it. */
function cabinet(c: Ctx): void {
  const { f, y, k } = c;
  const hw = 0.30, hd = 0.13, hgt = 0.86 + h2(k, 1.6) * 0.34;
  const yb = y + 0.10 + h2(k, 2.6) * 0.55;
  pm(c, PMAT.GALV, 0.45 + h2(k, 3.6) * 0.3);
  f.box(-hw, hw, yb, yb + hgt, -hd, hd);
  // Door, its two hinges and the lock — 15 mm of relief, which is all a flat
  // grey box needs to stop being a flat grey box.
  f.box(-hw + 0.025, hw - 0.025, yb + 0.03, yb + hgt - 0.03, hd, hd + 0.016);
  for (const yy of [yb + hgt * 0.18, yb + hgt * 0.82]) {
    f.box(-hw + 0.01, -hw + 0.055, yy - 0.030, yy + 0.030, hd, hd + 0.028);
  }
  f.box(hw - 0.075, hw - 0.030, yb + hgt * 0.48, yb + hgt * 0.55, hd + 0.016, hd + 0.034);
  // A weather hood, sloped, on about half of them.
  if (h2(k, 4.9) > 0.5) {
    f.quadFree(
      [-hw - 0.03, yb + hgt, -hd], [hw + 0.03, yb + hgt, -hd],
      [hw + 0.03, yb + hgt - 0.05, hd + 0.06], [-hw - 0.03, yb + hgt - 0.05, hd + 0.06],
      [[0, 0], [1, 0], [1, 1], [0, 1]],
    );
  }
  // Legs, if it stands on the paving rather than hanging on the wall.
  if (yb - y < 0.25) {
    pm(c, PMAT.IRON, 0.3);
    for (const su of [-1, 1]) {
      f.box(su * (hw - 0.05) - 0.02, su * (hw - 0.05) + 0.02, y, yb, -hd + 0.02, -hd + 0.06);
    }
  }
}

/** A steel drum, rusted through and used as a bin. */
function drum(c: Ctx): void {
  const { f, y, k } = c;
  const r = 0.285;
  pm(c, PMAT.PAINT, 0.15 + h2(k, 1.8) * 0.55);
  frustum(f, 0, 0, r, r, y, y + 0.86, 10, false);
  // The two rolling hoops, which are the only thing that distinguishes a drum
  // from a cylinder at any distance.
  for (const yy of [y + 0.26, y + 0.58]) {
    frustum(f, 0, 0, r + 0.016, r + 0.016, yy, yy + 0.040, 10, false);
  }
  frustum(f, 0, 0, r + 0.012, r + 0.012, y + 0.845, y + 0.885, 10, h2(k, 3.3) > 0.45);
}

/** A sack truck, left leaning where the delivery ended. */
function sacktruck(c: Ctx): void {
  const { f, y, k } = c;
  pm(c, PMAT.GALV, 0.5);
  const tilt = 0.30;
  const H = 1.18;
  for (const su of [-1, 1]) {
    f.quadFree(
      [su * 0.19 - 0.016, y + 0.10, -0.02], [su * 0.19 - 0.016, y + H, -0.02 - H * tilt],
      [su * 0.19 + 0.016, y + H, -0.02 - H * tilt], [su * 0.19 + 0.016, y + 0.10, -0.02],
      [[0, 0], [0, 1], [1, 1], [1, 0]],
    );
    f.quadFree(
      [su * 0.19 - 0.016, y + 0.10, 0.014], [su * 0.19 + 0.016, y + 0.10, 0.014],
      [su * 0.19 + 0.016, y + H, 0.014 - H * tilt], [su * 0.19 - 0.016, y + H, 0.014 - H * tilt],
      [[0, 0], [1, 0], [1, 1], [0, 1]],
    );
  }
  // Toe plate and the cross braces.
  f.box(-0.20, 0.20, y + 0.10, y + 0.125, 0.0, 0.22);
  for (const yy of [y + 0.45, y + 0.92]) {
    f.box(-0.19, 0.19, yy, yy + 0.024, -0.02 - (yy - y) * tilt, 0.008 - (yy - y) * tilt);
  }
  pm(c, PMAT.RUBBER, 0.25);
  for (const su of [-1, 1]) {
    frustumAlongD(f, su * 0.21, y + 0.115, 0.105, 0.105, -0.012, 0.012, 8);
  }
  void k;
}

/* ── Assembly ────────────────────────────────────────────────────────────── */

const EMITTERS: Record<PropKind, (c: Ctx) => void> = {
  bollard, meter, newsbox, binpost, wheelie, bags, crates, pallet,
  cellar, grate, standpipe, hydrant, cone, aboard, planter, cycle,
  cabinet, drum, sacktruck, boxes,
};

/* Every prop is built in a frame of its own, oriented by its yaw.
 *
 * The convention has to match `scene/collide.ts` exactly or a walker will be
 * stopped by the long side of a bin that is drawn narrow side on. `frame()`
 * takes the u direction and derives the outward normal as up x uDir, so
 * putting u along (sin yaw, cos yaw) puts d along (cos yaw, -sin yaw) — which
 * is precisely the collider's local z and local x. So: u is "along", d is
 * "across", and a box prop's half extents are hl along u and hw along d.
 */
function emitProp(F: Emit, p: Prop): void {
  const fr = frame(p.x, p.z, Math.sin(p.yaw), Math.cos(p.yaw));
  const f = new Face(F, fr);
  /* Sunk 12 mm. The footway carries a 31 mm cross-fall and per-flag
   * settlement on top of it, so an object placed at one sampled height shows
   * daylight under one corner otherwise — which is the "floating props" note
   * this scene has already collected once. */
  const y = walkHeight(p.x, p.z) - 0.012;
  EMITTERS[p.kind]({ F, f, y, s: p.seed, k: p.seed * 97.3 });
}

export type PropGeometry = {
  /** Everything painted by the prop material: the kit and the sign brackets. */
  geometry: THREE.BufferGeometry;
  /** The sign panels, which need the sign atlas and a material of their own. */
  signs: THREE.BufferGeometry;
  triangles: number;
  count: number;
  dispose(): void;
};

export function buildProps(): PropGeometry {
  const F = new Emit({ aProp: 4 });
  const list = props();
  for (const p of list) emitProp(F, p);
  /* The sign brackets go into this buffer rather than into their own.
   * They are street ironwork, they are painted the same way as a bollard is,
   * and there is no reason at all to spend a second draw call on them. */
  const S = emitSignage(F);
  const geometry = F.geometry();
  const signs = S.geometry();
  return {
    geometry, signs,
    triangles: F.triangleCount + S.triangleCount,
    count: list.length,
    dispose() { geometry.dispose(); signs.dispose(); },
  };
}

/* The three primitives the kit is written on top of. Exported because the
 * next thing that needs a tapered post or a slumped sack should take these
 * rather than re-derive the winding, which is the part that is easy to get
 * silently wrong. */
export { frustum, frustumAlongD, sackAt };
