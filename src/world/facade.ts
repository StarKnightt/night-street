/* Building geometry.
 *
 * Everything here is emitted in the facade's local frame (see emit.ts) and
 * merged into four buffers by material: masonry, glass, painted trim and
 * steel. Four merged meshes is four draw calls and four shadow-pass calls for
 * an entire block, which is what makes it affordable to model the reveals,
 * sills, brackets and railings as real geometry rather than faking them in a
 * normal map — and modelling them is the whole point, because at 4.2 degrees
 * what sells a wall is not its texture but the shadow every 40 mm projection
 * throws across it.
 *
 * Two rules govern the modelling:
 *
 * Anything that could cast a shadow onto something the camera can see is real
 * geometry. Window reveals, sill noses, string courses, railings, the slats of
 * a fire escape landing, the brackets under an air conditioner.
 *
 * Anything that only varies the *surface* is analytic in the shader. Brick
 * bond, mortar, staining, blinds, dirt on glass. Nothing is baked into a tile,
 * because a tile has a period and this project has already been caught out by
 * one — and because at this sun angle a tile's worth of detail is destroyed by
 * mip filtering long before it reaches the near field.
 */
import * as THREE from 'three';
import { Emit, Face, frame, type Frame } from './emit';
import { BLOCK_DEPTH, layoutBlock, type Bldg } from './block';
import { walkHeight } from './geometry';
import { makeRng } from './noise';

/** Surface roles the masonry shader branches on. */
export const ROLE = {
  WALL: 0,     // brick / render / stone, per the building's palette
  REVEAL: 1,   // the inside of a window or door opening — sheltered, dirty
  STONE: 2,    // cast stone: sills, lintels, copings, cornices, string courses
  PLINTH: 3,   // the dark base course every street building has
  SHUTTER: 4,  // ground floor infill, awaiting System 3
  BOARD: 5,    // plywood over a dead window
  ROOF: 6,     // felt and chippings, seen only from above
  PLAIN: 7,    // backs, which nothing ever sees
  FLANK: 8,    // party walls and exposed flanks
  BACKDROP: 9, // the town behind the block, seen only through 60 m of haze
} as const;

export type CityGeometry = {
  wall: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  trim: THREE.BufferGeometry;
  metal: THREE.BufferGeometry;
  triangles: number;
  dispose(): void;
};

const h2 = (a: number, b: number): number => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/** A sloped rectangular prism, for stair stringers, brackets and braces. */
function prism(
  f: Face, u0: number, y0: number, u1: number, y1: number,
  t: number, dA: number, dB: number,
): void {
  // A flight that runs the other way hands these in descending u, which would
  // wind every face inside out — and an inside-out prism is invisible in the
  // shadow pass as well as in the beauty pass.
  if (u1 < u0) { [u0, u1] = [u1, u0]; [y0, y1] = [y1, y0]; }
  const q = (a: [number, number, number], b: [number, number, number],
    c: [number, number, number], d: [number, number, number]) =>
    f.quadFree(a, b, c, d, [[a[0], a[1]], [b[0], b[1]], [c[0], c[1]], [d[0], d[1]]]);
  q([u0, y0 - t, dB], [u0, y0, dB], [u1, y1, dB], [u1, y1 - t, dB]);
  q([u0, y0 - t, dA], [u1, y1 - t, dA], [u1, y1, dA], [u0, y0, dA]);
  q([u0, y0, dA], [u1, y1, dA], [u1, y1, dB], [u0, y0, dB]);
  q([u0, y0 - t, dA], [u0, y0 - t, dB], [u1, y1 - t, dB], [u1, y1 - t, dA]);
  q([u1, y1 - t, dA], [u1, y1 - t, dB], [u1, y1, dB], [u1, y1, dA]);
  q([u0, y0 - t, dA], [u0, y0, dA], [u0, y0, dB], [u0, y0 - t, dB]);
}

/**
 * A member sloping in the (y, d) plane: a bracket stay, an angled coupling,
 * anything that leans out from a wall rather than along it.
 *
 * `Face.bar` wants its section counter-clockwise in (y, d) and turns inside
 * out — invisible in the beauty pass and in the shadow pass both — if it is
 * handed the other order, so the two offsets are derived from the member's
 * own direction rather than written down. u has to ascend for the same reason
 * the stair stringers do.
 */
function stay(
  f: Face, u0: number, u1: number,
  yA: number, dA: number, yB: number, dB: number, t: number,
): void {
  if (u1 < u0) [u0, u1] = [u1, u0];
  const ly = yB - yA, ld = dB - dA;
  const l = Math.hypot(ly, ld) || 1;
  const py = (-ld / l) * t * 0.5, pd = (ly / l) * t * 0.5;
  f.bar(u0, u1, [
    [yA - py, dA - pd], [yB - py, dB - pd], [yB + py, dB + pd], [yA + py, dA + pd],
  ]);
}

/* ── The ground storey, shared with System 3 ────────────────────────────── */

/**
 * The two levels that bound a shopfront: the top of the plinth it stands on
 * and the head of the opening, both in world height.
 *
 * Exported because System 3 has to land its stall risers, glazing and fascias
 * inside exactly the holes System 2 punched. These were inline constants in
 * `emitBuilding` and duplicating them in the shopfront builder would have been
 * a guaranteed future misalignment — a stall riser 40 mm below the plinth it
 * sits on is daylight through the bottom of every shop on the street.
 */
export function groundLevels(b: Bldg): { plinthTop: number; openTop: number } {
  return { plinthTop: b.base + b.plinth, openTop: b.base + b.gh - b.fascia };
}

/** The shopfront openings in a ground storey, in facade u, with their recess. */
export function groundOpenings(b: Bldg): { u0: number; u1: number; rec: number }[] {
  const out: { u0: number; u1: number; rec: number }[] = [];
  for (let i = 0; i < b.bays; i++) {
    const a = 0.25 + i * b.bayW + b.pier * 0.5;
    const z = 0.25 + (i + 1) * b.bayW - b.pier * 0.5;
    if (z - a > 1.15) out.push({ u0: a, u1: z, rec: 0.15 + h2(b.seed * 100, a) * 0.10 });
  }
  return out;
}

/**
 * The centre of every masonry pier in a ground storey, the two ends included.
 *
 * Wall furniture at street level has to stand on one of these. A meter box or
 * a conduit drop placed at a hashed u along the elevation lands in front of a
 * shopfront window about two thirds of the time, which was invisible while the
 * openings were closed by a flat placeholder panel and is a box floating in
 * mid-air over the glass the moment System 3 glazes them.
 */
export function pierCentres(b: Bldg): number[] {
  const holes = groundOpenings(b);
  if (holes.length === 0) return [b.L * 0.5];
  const out = [holes[0].u0 * 0.5];
  for (let i = 1; i < holes.length; i++) out.push((holes[i - 1].u1 + holes[i].u0) * 0.5);
  out.push((holes[holes.length - 1].u1 + b.L) * 0.5);
  return out;
}

/**
 * Every upper-storey window opening on a building, in facade coordinates.
 *
 * Restates the lattice the emitter walks in `emitBuilding` — the same origin,
 * the same bay centres, the same 5.5 per cent chance of a blank bay — so that
 * something outside System 2 can find a *specific* window rather than a
 * plausible one. System 5 needs exactly that: the television has to be in one
 * room and it has to be a room that exists, and a hashed selection in the
 * fragment shader can only deliver "about one", which is zero often enough to
 * matter and two often enough to look wrong.
 *
 * Restating rather than sharing is a drift risk and the alternative was worse:
 * the emitter interleaves the lattice with band emission, reveal geometry and
 * four separate attribute streams, and factoring a generator out of it would
 * be a change to signed-off System 2 code for one caller's benefit.
 */
export function upperWindows(b: Bldg): {
  floor: number; u0: number; u1: number; y0: number; y1: number;
}[] {
  const out: { floor: number; u0: number; u1: number; y0: number; y1: number }[] = [];
  const originY = b.base + b.gh;
  for (let f = 0; f < b.nUp; f++) {
    const fb = originY + f * b.fh;
    const y0 = fb + b.sill;
    const y1 = Math.min(y0 + b.winH, fb + b.fh - 0.42);
    for (let i = 0; i < b.bays; i++) {
      if (h2(b.seed * 61 + f * 5.7, i * 3.3) < 0.055) continue;
      const uc = 0.25 + (i + 0.5) * b.bayW;
      out.push({ floor: f, u0: uc - b.winW * 0.5, u1: uc + b.winW * 0.5, y0, y1 });
    }
  }
  return out;
}

/** Snap a wall-furniture position to the nearest pier centre. */
function onPier(b: Bldg, u: number): number {
  const piers = pierCentres(b);
  let best = piers[0];
  for (const p of piers) if (Math.abs(p - u) < Math.abs(best - u)) best = p;
  return best;
}

/**
 * A horizontal band of wall with rectangular holes punched in it.
 *
 * Every facade is built this way rather than as a plane with alpha-cut
 * windows, because an alpha cut casts a rectangular shadow with no depth and
 * the reveal is most of what makes a window read as a hole in a wall rather
 * than a picture of one.
 */
function band(
  f: Face, y0: number, y1: number, d: number, u0: number, u1: number,
  holes: [number, number][],
): void {
  if (y1 - y0 < 1e-4) return;
  let u = u0;
  for (const [a, b] of holes) {
    if (a > u + 1e-4) f.panel(u, a, y0, y1, d);
    u = Math.max(u, b);
  }
  if (u1 > u + 1e-4) f.panel(u, u1, y0, y1, d);
}

/* ── Windows ────────────────────────────────────────────────────────────── */

type WinCtx = {
  wf: Face; gf: Face; tf: Face; mf: Face;
  W: Emit; G: Emit; T: Emit; M: Emit;
  b: Bldg; d: number;
};

function emitWindow(
  c: WinCtx, u0: number, u1: number, y0: number, y1: number, key: number,
): void {
  const { wf, gf, tf, mf, W, G, T, M, b, d } = c;
  const rev = b.reveal;
  const r1 = h2(key, 1.7), r2 = h2(key, 5.3), r3 = h2(key, 9.1), r4 = h2(key, 13.9);

  /* The reveal, and its depth is the single most valuable number in the
   * system. A window set flush with the wall is a rectangle painted on; set
   * back 150 mm it has a jamb that goes black on one side and catches the sun
   * on the other, and a head that drops a hard band of shadow across the top
   * of the glass. At this sun elevation that band is most of the window. */
  W.attr('aRole', ROLE.REVEAL);
  wf.jamb(u0, d - rev, d, y0, y1, +1);
  wf.jamb(u1, d - rev, d, y0, y1, -1);
  wf.deck(u0, u1, d - rev, d, y1, false);
  wf.deck(u0, u1, d - rev, d, y0, true);

  // Sill: a stone slab with a nose that projects clear of the wall, so the
  // water that runs off it drips away from the face instead of down it — and
  // so it throws a shadow and starts the stain that every sill has under it.
  /* Sill and lintel, and both are sized off what survives at forty metres
   * rather than off what is correct at two.
   *
   * A 105 mm sill is three pixels of frame at the far end of the block and the
   * pale horizontal accent it is there to draw simply is not there. Neither
   * element earns its keep through its shadow — a horizontal ledge under a
   * four-degree sun throws a band 13 mm deep and nothing more — they earn it
   * through *value*: cast stone reflects two and a half times what a stock
   * brick does, so a 150 mm band of it under every opening and a 170 mm one
   * over it is what turns a grid of black holes into a rhythm of light and
   * dark lines. Real Georgian and Victorian sills are 150-175 mm deep in any
   * case; the first pass was the thing that was wrong. */
  W.attr('aRole', ROLE.STONE);
  wf.box(u0 - 0.095, u1 + 0.095, y0 - 0.150, y0, d - rev, d + 0.105 + r1 * 0.03);
  // A throated drip on the underside of the nose, which is where the water
  // actually leaves and where the stain under every sill starts.
  wf.box(u0 - 0.075, u1 + 0.075, y0 - 0.185, y0 - 0.150, d + 0.035, d + 0.085);
  wf.box(u0 - 0.115, u1 + 0.115, y1, y1 + 0.165 + r2 * 0.07, d - 0.02, d + 0.048);

  const boarded = r3 > 0.955;
  if (boarded) {
    W.attr('aRole', ROLE.BOARD);
    wf.panel(u0, u1, y0, y1, d - rev + 0.05);
    return;
  }

  const dg = d - rev + 0.055;          // face of the frame
  const dl = dg - 0.045;               // the glass behind it
  const fw = 0.052;                    // frame section

  T.attr('aTrim', b.seed, 0);
  tf.box(u0, u1, y0, y0 + fw, dl, dg);
  tf.box(u0, u1, y1 - fw, y1, dl, dg);
  tf.box(u0, u0 + fw, y0, y1, dl, dg);
  tf.box(u1 - fw, u1, y0, y1, dl, dg);

  /* Sash division. A two-over-two or one-over-one sash is the commonest thing
   * on a street like this and the transom sits high, not centred: the lower
   * sash is taller than the upper one. Getting that proportion wrong makes a
   * window look like a picture frame. */
  const trans = y0 + (y1 - y0) * (0.52 + r1 * 0.08);
  tf.box(u0, u1, trans - 0.028, trans + 0.028, dl, dg);
  const panes = r2 < 0.42 ? 2 : 1;
  if (panes === 2) {
    const uc = (u0 + u1) * 0.5;
    tf.box(uc - 0.024, uc + 0.024, y0, y1, dl, dg);
  }

  G.attr('aPane', b.seed * 977 + key, panes, r4, r3);
  gf.panel(u0, u1, y0, y1, dl);

  /* An air conditioner jammed in the bottom sash, which is what a third of the
   * windows on a street like this actually have, and which projects far enough
   * to throw a proper shadow and to start a rust run down the wall below. */
  if (r4 > 0.86) {
    M.attr('aMetal', b.seed * 31 + key, 1);
    const uc = (u0 + u1) * 0.5, hw = Math.min(0.36, (u1 - u0) * 0.46);
    mf.box(uc - hw, uc + hw, y0 + 0.02, y0 + 0.44, d - rev - 0.02, d + 0.16);
    mf.box(uc - hw + 0.06, uc - hw + 0.11, y0 - 0.16, y0 + 0.03, d + 0.02, d + 0.07);
    mf.box(uc + hw - 0.11, uc + hw - 0.06, y0 - 0.16, y0 + 0.03, d + 0.02, d + 0.07);
    return;
  }

  /* One window in nine is open, and an open sash is worth more than its
   * geometry: it is a flat pane hung out into the light at an angle nothing
   * else in the frame shares, so it catches the sun when the wall behind it
   * does not. */
  if (r1 > 0.89) {
    const swing = 0.30 + r2 * 0.34;
    const wsp = Math.min(0.9, (u1 - u0) - 0.1);
    const hinge = r3 < 0.5 ? u0 + fw : u1 - fw;
    const dir = r3 < 0.5 ? 1 : -1;
    const ue = hinge + dir * wsp * Math.cos(swing);
    const de = dg + wsp * Math.sin(swing);
    const yA = y0 + fw, yB = trans - 0.03;
    G.attr('aPane', b.seed * 977 + key + 7, 1, 0.2, 0.1);
    gf.quadFree(
      [hinge, yA, dg], [hinge, yB, dg], [ue, yB, de], [ue, yA, de],
      [[0, 0], [0, 1], [1, 1], [1, 0]],
    );
    gf.quadFree(
      [hinge, yA, dg], [ue, yA, de], [ue, yB, de], [hinge, yB, dg],
      [[0, 0], [1, 0], [1, 1], [0, 1]],
    );
  }
}

/* ── Fire escapes ───────────────────────────────────────────────────────── */

/*
 * The single highest-value object in System 2, and the reason is the hour
 * rather than the object. A zigzag of steel stairs bolted to a wall is a shape
 * nothing in nature makes, and when a four-degree sun rakes across it the
 * whole assembly prints itself onto the brickwork behind and onto the footway
 * below as a lacework of thin diagonal bars. No amount of surface detail
 * produces that read; it comes from thin solid geometry with air between it.
 *
 * Which means every part of it has to be a closed prism rather than a plane.
 * A landing modelled as one thin slab casts a solid rectangle and the effect
 * is lost — the slats have to be individual bars with real gaps, because the
 * gaps are the picture.
 */
function emitEscape(c: WinCtx, bay: number): void {
  const { mf, M, b, d } = c;
  const uc = 0.25 + (bay + 0.5) * b.bayW;
  const half = Math.min(2.35, b.bayW * 0.95);
  const uA = Math.max(0.35, uc - half), uB = Math.min(b.L - 0.35, uc + half);
  /* How far the landing stands off the wall, and it is a lighting number as
   * much as a dimension. The shadow of anything on this facade lands 1.43 m
   * further along the wall for every metre it projects, so a 1.16 m landing
   * printed its lacework 1.7 m away and a good deal of it fell on the next
   * building or off the end of the frontage entirely. At 1.4 m — which is a
   * normal landing depth for a fire escape carrying two-way traffic — the
   * whole assembly throws two metres clear of itself and the grating, the
   * pickets and the stair treads all land on wall that is not behind them. */
  const dOut = d + 1.40;
  const originY = b.base + b.gh;

  M.attr('aMetal', b.seed * 17 + bay, 2);

  /* A railing along the landing edge: two rails and a run of pickets. The
   * pickets are the reason for the whole exercise — they are what turns the
   * shadow on the wall behind from a bar into a comb. */
  const railU = (u0: number, u1: number, y: number, dd: number) => {
    mf.box(u0, u1, y + 1.00, y + 1.06, dd - 0.028, dd + 0.028);
    mf.box(u0, u1, y + 0.50, y + 0.545, dd - 0.022, dd + 0.022);
    for (let u = u0 + 0.15; u < u1 - 0.06; u += 0.285) {
      mf.box(u, u + 0.026, y + 0.02, y + 1.02, dd - 0.016, dd + 0.016);
    }
    mf.box(u0, u0 + 0.042, y, y + 1.06, dd - 0.026, dd + 0.026);
    mf.box(u1 - 0.042, u1, y, y + 1.06, dd - 0.026, dd + 0.026);
  };
  /** The same, running out from the wall along the end of a landing. */
  const railD = (u: number, dA: number, dB: number, y: number) => {
    mf.box(u - 0.028, u + 0.028, y + 1.00, y + 1.06, dA, dB);
    mf.box(u - 0.022, u + 0.022, y + 0.50, y + 0.545, dA, dB);
    for (let t = dA + 0.14; t < dB - 0.06; t += 0.285) {
      mf.box(u - 0.016, u + 0.016, y + 0.02, y + 1.02, t, t + 0.026);
    }
  };
  /** A diagonal member in the (y, d) plane — the brace under a landing. */
  const brace = (u0: number, u1: number,
    yA: number, dA: number, yB: number, dB: number, t: number) => {
    const ly = yB - yA, ld = dB - dA;
    const l = Math.hypot(ly, ld) || 1;
    const py = (-ld / l) * t * 0.5, pd = (ly / l) * t * 0.5;
    mf.bar(u0, u1, [
      [yA - py, dA - pd], [yB - py, dB - pd], [yB + py, dB + pd], [yA + py, dA + pd],
    ]);
  };

  for (let f = 0; f < b.nUp; f++) {
    const y = originY + f * b.fh + 0.10;

    // Landing: bearers, then grating slats with air between them.
    mf.box(uA, uB, y - 0.09, y - 0.02, d + 0.02, d + 0.08);
    mf.box(uA, uB, y - 0.09, y - 0.02, dOut - 0.07, dOut - 0.01);
    for (let t = d + 0.09; t < dOut - 0.07; t += 0.108) {
      mf.box(uA, uB, y - 0.022, y + 0.006, t, t + 0.055);
    }

    // Brackets back into the wall. Two per landing, and they are the only
    // thing holding several hundred kilos of steel up, so they are visible.
    for (const u of [uA + 0.35, uB - 0.35]) {
      mf.box(u - 0.028, u + 0.028, y - 0.95, y - 0.06, d + 0.005, d + 0.06);
      mf.box(u - 0.026, u + 0.026, y - 0.10, y - 0.03, d + 0.02, dOut - 0.05);
      brace(u - 0.024, u + 0.024, y - 0.88, d + 0.05, y - 0.11, dOut - 0.14, 0.05);
    }

    railU(uA, uB, y, dOut - 0.03);
    railD(uA, d + 0.08, dOut - 0.03, y);
    railD(uB, d + 0.08, dOut - 0.03, y);

    /* The flight down to the landing below, alternating end for end, which is
     * what makes the assembly a zigzag rather than a ladder — and the zigzag
     * is what the shadow is. */
    if (f === 0) continue;
    const down = (f % 2) === 1;
    const rise = 0.235, going = 0.255;
    const n = Math.max(6, Math.round(b.fh / rise));
    const yTopF = y, yBot = y - b.fh;
    const uStart = down ? uA + 0.30 : uB - 0.30;
    const dir = down ? 1 : -1;
    const dS = d + 0.30, dE = d + 1.00;
    for (let i = 0; i < n; i++) {
      const uu = uStart + dir * (i + 0.5) * going;
      const yy = yTopF - (i + 1) * (b.fh / n);
      mf.box(Math.min(uu, uu + dir * going * 0.86), Math.max(uu, uu + dir * going * 0.86),
        yy, yy + 0.032, dS, dE);
    }
    const uEnd = uStart + dir * n * going;
    for (const dd of [dS - 0.05, dE + 0.02]) {
      prism(mf, uStart, yTopF + 0.02, uEnd, yBot + 0.02, 0.20, dd, dd + 0.035);
      // Hand rail following the flight.
      prism(mf, uStart, yTopF + 1.02, uEnd, yBot + 1.02, 0.05, dd - 0.01, dd + 0.045);
      for (let i = 1; i < n; i += 3) {
        const uu = uStart + dir * i * going;
        const yy = yTopF - i * (b.fh / n);
        mf.box(Math.min(uu, uu + 0.026), Math.max(uu, uu + 0.026),
          yy, yy + 1.02, dd, dd + 0.03);
      }
    }
  }

  /* The drop ladder, hanging short of the footway the way a real one does so
   * that nobody can climb it from the street. It is the detail that tells you
   * the thing is a fire escape and not a balcony. */
  const yL = originY + 0.10;
  const uL = uA + 0.55;
  for (const uu of [uL, uL + 0.44]) {
    mf.box(uu, uu + 0.038, b.base + 2.55, yL, d + 0.66, d + 0.70);
  }
  for (let y = b.base + 2.75; y < yL - 0.2; y += 0.31) {
    mf.box(uL, uL + 0.48, y, y + 0.024, d + 0.655, d + 0.71);
  }
}

/* ── Wall furniture and rooftops ────────────────────────────────────────── */

function emitFurniture(c: WinCtx): void {
  const { wf, mf, W, M, b, d } = c;
  const originY = b.base + b.gh;
  const yTop = b.base + b.H;
  const roofY = yTop - 0.42;
  const s = b.seed;

  /* Downpipes. Every building has them, they run the full height, and they
   * are the reason for the two darkest vertical stripes on any painted
   * facade — the shader draws the stain, this draws the thing making it. */
  M.attr('aMetal', s * 7, 3);
  const runs: number[] = [];
  if (b.pipes === 1 || b.pipes === 3) runs.push(0.24);
  if (b.pipes === 2 || b.pipes === 3) runs.push(b.L - 0.24);
  /* Standoff, and it is the whole point of the detail.
   *
   * A downpipe modelled flush against the wall is a flat black stripe with no
   * cast shadow, which is precisely how the last set of frames read. A real
   * one is held 30-40 mm clear on cast brackets so the wall behind it can dry,
   * and that gap is what turns the pipe into an object: at this sun angle the
   * pipe throws a soft dark line down the render beside itself, each bracket
   * throws a short hard one, and the pair of them is legible at thirty metres
   * where the pipe alone is not. */
  const off = 0.038;
  for (const u of runs) {
    mf.box(u - 0.048, u + 0.048, b.base + 0.30, yTop + b.par - 0.30, d + off, d + off + 0.096);
    mf.box(u - 0.062, u + 0.062, b.base + 0.06, b.base + 0.34, d + off, d + off + 0.115);
    // Hopper head at eaves level, where the gutter drops into it.
    mf.box(u - 0.105, u + 0.105, yTop - 0.42, yTop - 0.06, d + off, d + off + 0.145);
    for (let y = b.base + 1.1; y < yTop - 0.5; y += 1.55) {
      // Ear, strap and spacer: three boxes, and the spacer is what holds the
      // pipe off the wall and casts the short hard shadow beside it.
      mf.box(u - 0.026, u + 0.026, y + 0.01, y + 0.055, d, d + off);
      mf.box(u - 0.086, u + 0.086, y, y + 0.062, d + off - 0.004, d + off + 0.112);
    }
    // The swan neck back to the gutter behind the parapet.
    mf.box(u - 0.05, u + 0.05, yTop + b.par - 0.34, yTop + b.par - 0.26, d, d + 0.20);
  }

  // Wall anchors: the plate ends of the tie rods that stop a brick front
  // pulling away from its floors. One row per floor, and they are tiny, but
  // a raking sun gives every one of them a shadow.
  if (b.pal === 0) {
    M.attr('aMetal', s * 3, 4);
    for (let f = 0; f <= b.nUp; f++) {
      const y = b.base + b.gh + f * b.fh - 0.30;
      if (y > yTop - 0.2) break;
      for (let i = 0; i < b.bays; i++) {
        if (h2(s * 100 + f, i) < 0.45) continue;
        const u = 0.25 + (i + 0.5) * b.bayW;
        mf.box(u - 0.075, u + 0.075, y - 0.075, y + 0.075, d, d + 0.032);
      }
    }
  }

  // Wall-mounted condensers on the piers, with the brackets under them.
  for (let f = 0; f < b.nUp; f++) {
    for (let i = 0; i < b.bays - 1; i++) {
      if (h2(s * 40 + f * 3.1, i * 7.7) < 0.83) continue;
      const u = 0.25 + (i + 1) * b.bayW;
      const y = originY + f * b.fh + 1.15;
      M.attr('aMetal', h2(i, f) * 100, 1);
      mf.box(u - 0.34, u + 0.34, y, y + 0.52, d + 0.03, d + 0.36);
      /* The bracket, and it is an L with a diagonal in it rather than a stub.
       * A condenser hanging on nothing is the tell; the cranked angle under it
       * is three boxes and it prints a recognisable shape on the wall. */
      for (const s2 of [-1, 1]) {
        const uu = u + s2 * 0.29;
        mf.box(uu - 0.028, uu + 0.028, y - 0.26, y + 0.02, d, d + 0.055);
        mf.box(uu - 0.026, uu + 0.026, y - 0.05, y + 0.01, d, d + 0.34);
        mf.box(uu - 0.022, uu + 0.022, y - 0.24, y - 0.16, d + 0.02, d + 0.20);
      }
      // Grille bars across the face. Thin, but they are what stops the unit
      // reading as a grey box, and they break up its shadow as well.
      for (let k = 0; k < 5; k++) {
        const yy = y + 0.09 + k * 0.075;
        mf.box(u - 0.30, u + 0.30, yy, yy + 0.028, d + 0.36, d + 0.385);
      }
    }
  }

  /* A meter box or a stand pipe at street level, and it goes on a pier.
   *
   * These used to be placed at a hashed u anywhere along the elevation, which
   * put them in front of a ground floor opening most of the time. That was
   * invisible while the openings were closed by a flat panel 150 mm back and
   * is a steel box hanging in mid-air over a shop window now that System 3
   * glazes them. A meter cupboard goes on solid wall in any case — there is
   * nothing behind a shopfront to fix one to. */
  if (h2(s, 3.3) > 0.45) {
    M.attr('aMetal', s * 13, 5);
    const u = onPier(b, 0.6 + h2(s, 8.1) * Math.max(0.5, b.L - 1.6)) - 0.21;
    mf.box(u, u + 0.42, b.base + 0.85, b.base + 1.42, d, d + 0.17);
    // The door and its frame: two rebates, and at this sun angle the vertical
    // one on the sunward side is a hard black line the height of the box.
    mf.box(u + 0.03, u + 0.39, b.base + 0.88, b.base + 1.39, d + 0.17, d + 0.195);
    mf.box(u + 0.30, u + 0.345, b.base + 1.08, b.base + 1.16, d + 0.195, d + 0.225);
  }
  if (h2(s, 4.9) > 0.62) {
    M.attr('aMetal', s * 19, 3);
    const u = onPier(b, 0.6 + h2(s, 2.2) * Math.max(0.5, b.L - 1.6));
    mf.box(u - 0.055, u + 0.055, b.base + 0.1, b.base + 1.05, d, d + 0.11);
    mf.box(u - 0.09, u + 0.09, b.base + 1.05, b.base + 1.18, d, d + 0.14);
  }

  /* A conduit run and its drops: the ugly, obviously-added-later layer that
   * every real facade has and no rendered one does.
   *
   * The first version of this was the "long thin bright horizontal line" in
   * the critique, and the diagnosis is worth keeping. It was a 45 mm bar run
   * dead flat against the wall from one end of the building to the other with
   * nothing on it. Flush against the wall it cast no shadow, so there was
   * nothing to say it was an object; unbroken across five bays it read as an
   * edge rather than a thing; and at 25% metalness and 0.55 roughness the
   * dielectric lobe of a raking sun put a blown white specular highlight along
   * its whole length. From thirty metres that is indistinguishable from a
   * z-fighting seam, which is exactly what it was taken for.
   *
   * So: held 45 mm off the wall on saddle clips at 1.4 m centres, stopped
   * short of both ends at a junction box, and given a galvanised roughness in
   * the shader that cannot produce a mirror highlight. */
  if (h2(s, 6.6) > 0.5) {
    M.attr('aMetal', s * 23, 3);
    /* Above the shopfront, not across it.
     *
     * At b.base + 2.55 to 3.35 this run was inside the ground floor opening —
     * the head of one is 2.9 to 4.1 m up — so it crossed the glazing rather
     * than the wall, and its drop then ran down the middle of a shop window to
     * a meter that was itself floating in front of the glass. First floor
     * level is also where surface conduit is actually clipped on a building
     * with shops under it, because that is the lowest solid wall there is. */
    const y = originY + 0.30 + h2(s, 1.1) * 0.85;
    const cOff = 0.045;
    const uA = 0.45 + h2(s, 4.4) * 0.8;
    const uB = b.L - 0.45 - h2(s, 8.8) * 1.4;
    mf.box(uA, uB, y, y + 0.052, d + cOff, d + cOff + 0.052);
    for (let u = uA + 0.2; u < uB - 0.1; u += 1.4) {
      mf.box(u, u + 0.05, y - 0.012, y + 0.064, d, d + cOff + 0.008);
    }
    // Junction box at one end, and a drop out of it to a switch or a meter.
    mf.box(uA - 0.10, uA + 0.02, y - 0.075, y + 0.13, d, d + 0.10);
    // The drop runs down a pier for the same reason the meter box stands on
    // one: below the fascia there is nothing else to clip it to.
    const u = onPier(b, uA + 0.35 + h2(s, 5.5) * Math.max(0.4, uB - uA - 0.9)) - 0.025;
    mf.box(u, u + 0.05, b.base + 0.4, y, d + cOff, d + cOff + 0.052);
    for (let yy = b.base + 0.7; yy < y - 0.2; yy += 1.4) {
      mf.box(u - 0.024, u + 0.074, yy, yy + 0.05, d, d + cOff + 0.008);
    }
  }

  /* ── Roof ─────────────────────────────────────────────────────────────
   *
   * The sky is a large fraction of every frame in this scene, so the line
   * where the buildings meet it is doing as much work as anything at eye
   * level. A flat parapet run against a golden sky is a ruler. What breaks it
   * is the junk: flues, tanks, plant, aerials, a stair hutch — all of it in
   * silhouette, all of it at different heights, none of it aligned.
   */
  /* How far back a roof object can stand and still be seen.
   *
   * From the far footway the eye is 11 m out and 15 m down, so the sightline
   * over the parapet climbs at about 4:3: every metre of setback costs one and
   * a third metres of height before the object appears at all. The first pass
   * put the whole kit two to three metres back, which is where it honestly
   * belongs, and the result was a roofline as straight as a ruler from every
   * stop on the walk. So the kit crowds the parapet instead. It is a lie about
   * where plant gets installed and it is the only way the silhouette exists.
   */
  const kit = h2(s, 21.7);
  const dBack = d - BLOCK_DEPTH;

  if (kit > 0.30) {
    // Chimney stack, in the same brick as the building and capped in stone.
    const u = 0.8 + h2(s, 31.1) * Math.max(0.6, b.L - 2.2);
    const w = 0.62 + h2(s, 12.3) * 0.55;
    const hgt = b.par + 1.95 + h2(s, 44.4) * 2.3;
    const dd = d - 0.35 - h2(s, 3.7) * 0.9;
    W.attr('aRole', ROLE.WALL);
    wf.box(u, u + w, roofY, roofY + hgt, dd - 0.62, dd);
    W.attr('aRole', ROLE.STONE);
    wf.box(u - 0.05, u + w + 0.05, roofY + hgt, roofY + hgt + 0.11, dd - 0.67, dd + 0.05);
    M.attr('aMetal', s * 29, 6);
    const pots = 1 + Math.floor(h2(s, 9.9) * 3);
    for (let i = 0; i < pots; i++) {
      mf.tube(u + w * ((i + 0.5) / pots), dd - 0.31, 0.105,
        roofY + hgt + 0.11, roofY + hgt + 0.44 + h2(s, i) * 0.2, 8);
    }
  }

  if (kit > 0.55 || h2(s, 77.1) > 0.45) {
    // Roof plant: a condenser block on a frame, set back from the parapet.
    M.attr('aMetal', s * 37, 7);
    const u = 0.7 + h2(s, 51.3) * Math.max(0.5, b.L - 2.4);
    const dd = d - 0.45 - h2(s, 61.9) * 0.8;
    mf.box(u, u + 1.35, roofY + b.par + 0.20, roofY + b.par + 1.10, dd - 1.0, dd);
    for (const uu of [u + 0.08, u + 1.19]) {
      mf.box(uu, uu + 0.08, roofY, roofY + b.par + 0.24, dd - 0.14, dd - 0.06);
      mf.box(uu, uu + 0.08, roofY, roofY + b.par + 0.24, dd - 0.94, dd - 0.86);
    }
  }

  if (h2(s, 88.3) > 0.62) {
    // A water tank on a frame. Almost pure silhouette, and unmistakable.
    M.attr('aMetal', s * 41, 8);
    const u = 1.4 + h2(s, 5.2) * Math.max(0.4, b.L - 3.2);
    const dd = d - 1.15 - h2(s, 7.4) * 0.7;
    const r = 0.86, legs = b.par + 1.5;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.78;
      mf.box(u + Math.cos(a) * r * 0.72 - 0.05, u + Math.cos(a) * r * 0.72 + 0.05,
        roofY, roofY + legs, dd + Math.sin(a) * r * 0.72 - 0.05, dd + Math.sin(a) * r * 0.72 + 0.05);
    }
    mf.tube(u, dd, r, roofY + legs, roofY + legs + 2.0, 12);
  }

  if (h2(s, 93.7) > 0.55) {
    // Stair hutch or lift overrun.
    W.attr('aRole', ROLE.PLAIN);
    const u = 0.9 + h2(s, 15.5) * Math.max(0.5, b.L - 3.0);
    const dd = d - 0.9 - h2(s, 17.5) * 1.1;
    wf.box(u, u + 1.9, roofY, roofY + b.par + 1.95, dd - 1.7, dd);
    W.attr('aRole', ROLE.STONE);
    wf.deck(u - 0.06, u + 1.96, dd - 1.76, dd + 0.06, roofY + b.par + 1.95, true);
  }

  /* Vent stacks, and there is always at least one.
   *
   * These are the cheapest silhouette in the file — a six-sided tube 60 mm
   * across — and against a bright sky they are worth more than anything else
   * on the roof, because a soil vent breaking the parapet line is a detail no
   * one models and everyone has seen. Left to a dice roll a third of the block
   * came out with none and the roofline was a ruler again. */
  M.attr('aMetal', s * 53, 6);
  const stacks = 1 + Math.floor(h2(s, 2.9) * 3);
  for (let i = 0; i < stacks; i++) {
    const u = 0.5 + h2(s * 3, i * 4.1) * Math.max(0.4, b.L - 1.2);
    const dd = d - 0.30 - h2(s * 5, i * 2.3) * 1.1;
    mf.tube(u, dd, 0.055 + h2(s, i) * 0.05, roofY,
      roofY + b.par + 0.45 + h2(s, i * 9) * 1.0, 6);
  }

  if (h2(s, 66.6) > 0.45) {
    // Aerial. Two millimetres of geometry, and it reads from fifty metres.
    M.attr('aMetal', s * 59, 4);
    const u = 0.6 + h2(s, 71.1) * Math.max(0.4, b.L - 1.4);
    const dd = d - 0.32 - h2(s, 73.3) * 0.7;
    const top = roofY + b.par + 1.5 + h2(s, 79.9) * 1.6;
    mf.box(u - 0.018, u + 0.018, roofY, top, dd - 0.018, dd + 0.018);
    for (let i = 0; i < 4; i++) {
      const y = top - 0.22 - i * 0.24;
      const w = 0.28 + i * 0.09;
      mf.box(u - w, u + w, y, y + 0.016, dd - 0.008, dd + 0.008);
    }
  }

  if (h2(s, 45.1) > 0.74) {
    // Satellite dish, on the parapet where they always are.
    M.attr('aMetal', s * 61, 9);
    const u = 0.5 + h2(s, 47.3) * Math.max(0.4, b.L - 1.2);
    const y = yTop + b.par * 0.55;
    mf.box(u - 0.03, u + 0.03, y, y + 0.34, d + 0.02, d + 0.30);
    /* The dish, and the last version of it read as a clipping artifact.
     *
     * It was a flat eight-sided fan with no rim and no feed, which at fifty
     * metres is a featureless white oval — and a featureless white oval in a
     * photograph is a hole in the render, not an object. What makes a dish
     * legible at that size is not the paraboloid, it is the silhouette of the
     * things attached to it: the rim standing proud of the face, the arm
     * reaching out to the LNB, and the bracket behind. Those are three boxes
     * and a ring of quads, and they turn a blob into a shape.
     */
    const r = 0.27, cy = y + 0.34, cd = d + 0.30;
    const rim = (a: number, k: number): [number, number, number] =>
      [u + Math.cos(a) * r * k, cy + Math.sin(a) * r * 0.82 * k, cd + Math.sin(a) * r * 0.42 * k];
    const cn: [number, number, number] = [u, cy, cd - 0.05];
    for (let i = 0; i < 10; i++) {
      const a0 = (i / 10) * Math.PI * 2, a1 = ((i + 1) / 10) * Math.PI * 2;
      /* a1 before a0. The fan was listed the other way round and the dished
       * face has been a back face since it was built — only the rim ring
       * rendered, because the rim is emitted in both directions and the face
       * is not, so the dish read as an open hoop and nobody noticed.
       *
       * The trap is that (u, y, d) is left-handed: `frame()` derives the
       * outward normal as up x uDir, and uDir x up is its negative, so a fan
       * listed anti-clockwise as seen from outside — which is the intuitive
       * order and the correct one in a right-handed frame — comes out facing
       * into the building. `emit.ts` states the rule for a quad given corner
       * by corner; a fan built from a centre and a swept radius has to work it
       * out for itself, and this one worked it out backwards. Found by the
       * facade fixtures pass, which hit the same thing on its own dish and
       * wound that one the other way. */
      mf.quadFree(cn, rim(a1, 1), rim(a0, 1), rim(a0, 1), [[0, 0], [1, 0], [1, 1], [1, 1]]);
      // The rim: a 25 mm lip standing off the dished face all the way round.
      mf.quadFree(rim(a0, 1), rim(a0, 0.90), rim(a1, 0.90), rim(a1, 1),
        [[i, 0], [i, 1], [i + 1, 1], [i + 1, 0]]);
      mf.quadFree(rim(a1, 1), rim(a1, 0.90), rim(a0, 0.90), rim(a0, 1),
        [[i, 0], [i, 1], [i + 1, 1], [i + 1, 0]]);
    }
    // Feed arm out to the LNB, which is the part of a dish the eye recognises.
    mf.box(u - 0.018, u + 0.018, cy - 0.20, cy - 0.02, cd + 0.02, cd + 0.30);
    mf.box(u - 0.042, u + 0.042, cy - 0.24, cy - 0.14, cd + 0.24, cd + 0.34);
  }

  void dBack;
}

/* ── The walked rows ────────────────────────────────────────────────────── */

/*
 * Everything above is applied to all fifty-seven buildings in the layout, and
 * fifty of them are seen at twenty metres or more, through a gap, past a
 * parked car. The two rows the camera walks between are seen at three, and at
 * three metres what `emitFurniture` leaves behind is a blank wall: a downpipe
 * at each end, one meter box, one standpipe, one conduit run and some roof
 * clutter is about ten objects spread over twelve metres of frontage and
 * thirteen of height. That reads as an unfinished model rather than as a
 * quiet building, and no amount of brick shader fixes it, because what the
 * eye is counting is *events* — places where something is bolted on, casts a
 * shadow, has been repainted round, and has a pipe leaving it.
 *
 * The rule this function follows, and the one the sparse pass broke, is that
 * real wall furniture comes in systems rather than in props. A split air
 * conditioner is a condenser, two brackets, a lagged pipe pair, a hole in the
 * wall with cement round it, a drip tray and a condensate pipe going
 * somewhere it should not — six objects inside 800 mm, all of them there
 * because of one decision somebody made in 1998. Nothing below is placed on
 * its own and no run of pipe, conduit or cable in it floats: each one starts
 * on a box and finishes on another one.
 *
 * And every part of it is held off the masonry. At 4.2 degrees a fixture
 * flush to a wall has no cast shadow at all and reads as a decal — the long
 * post-mortem in the conduit block above is exactly that failure, diagnosed.
 * So every run here is on clips at 25 to 50 mm, every box is on a backplate
 * or a spacer, and the only things touching the brick are the fixings
 * themselves, which is both what the real detail is and what puts a hard
 * dark line down the render beside each object.
 */
function emitStreetFixtures(c: WinCtx): void {
  const { wf, mf, W, M, b, d } = c;
  const s = b.seed;
  const originY = b.base + b.gh;
  const yTop = b.base + b.H;
  const { plinthTop, openTop } = groundLevels(b);
  const holes = groundOpenings(b);

  /* Every stretch of solid ground-storey wall, with how much of it there is.
   *
   * `pierCentres` gives the middle of each one and that is all the existing
   * furniture needs. A fixture 300 mm across also has to know whether 300 mm
   * is there: a pier between two openings is one `b.pier` wide — 420 to 820
   * mm — the end ones are 250 mm plus half of that, and System 3 takes the
   * outer 155 to 235 mm of whichever piers a shop unit ends on for its
   * pilaster. Which is why the street-level kit below is narrow and centred.
   * A gas meter cupboard is 400 mm wide in the catalogue and 260 here,
   * because the other 140 would be standing on somebody's joinery.
   */
  const piers: { u: number; half: number }[] = [];
  if (holes.length === 0) {
    piers.push({ u: b.L * 0.5, half: Math.min(0.5, b.L * 0.45) });
  } else {
    piers.push({ u: holes[0].u0 * 0.5, half: holes[0].u0 * 0.5 });
    for (let i = 1; i < holes.length; i++) {
      piers.push({
        u: (holes[i - 1].u1 + holes[i].u0) * 0.5,
        half: (holes[i].u0 - holes[i - 1].u1) * 0.5,
      });
    }
    const e = holes[holes.length - 1];
    piers.push({ u: (e.u1 + b.L) * 0.5, half: (b.L - e.u1) * 0.5 });
  }
  /** A stretch of solid wall wide enough to take a fixture `w` across. */
  const pierFor = (w: number, k: number): number => {
    const fit = piers.filter((p) => p.half >= w * 0.5 + 0.04);
    if (fit.length === 0) return -1;
    return fit[Math.floor(h2(s * 83 + k * 3.7, 11.9) * fit.length) % fit.length].u;
  };

  /* The service line: the one column on an elevation that is solid from the
   * plinth to the eaves.
   *
   * A ground floor opening is inset half a pier from the bay boundary and an
   * upper window is centred in its bay, so u = 0.25 + i * bayW misses the
   * glazing below by half a pier and the window reveal above by 390 mm at the
   * tightest bay this layout produces. Anything that has to travel more than
   * one storey — the soil stack, a refrigerant drop, the cable to the first
   * floor — runs on one of these, and so does everything real, because it is
   * the only place a drill goes through into brick rather than into a shop.
   */
  const service: number[] = [];
  for (let i = 1; i < b.bays; i++) service.push(0.25 + i * b.bayW);
  const svc = (k: number): number =>
    service[Math.floor(h2(s * 29 + k * 5.1, 2.7) * service.length) % service.length];

  /* Lanes across a service pier.
   *
   * Four different things below can want the same 420 mm of brickwork, and
   * on a two-bay building there is only one pier for them to want, so each
   * subsystem gets a fixed offset from the centre line instead of a hashed
   * one. The order is the order a real riser diagram ends up in: the soil
   * stack on the centre because it is the fattest and went up first, the
   * electrical drop to one side of it, waste and telecoms to the other,
   * every one of them inside 210 mm of the centre, which is half of the
   * narrowest pier `layoutBlock` produces. Hashing these instead would put
   * a 20 mm condensate pipe through a 100 mm soil stack about a third of
   * the time, and two pipes occupying the same 40 mm of wall is the one
   * modelling error that shows up as flicker rather than as clutter. */
  const LANE = { elec: -0.115, cond: 0.105, cable: 0.165 };

  /* Where a fire escape already occupies the elevation. Hanging a condenser
   * inside the pickets of a landing is not a clash the shadow pass forgives:
   * the whole assembly prints itself on the wall and a box in the middle of
   * it prints as a blot. */
  const escU = b.escape >= 0 ? 0.25 + (b.escape + 0.5) * b.bayW : -99;
  const escHalf = Math.min(2.35, b.bayW * 0.95) + 0.35;
  const clearOfEscape = (u: number) => Math.abs(u - escU) > escHalf;

  /* System 3's sign board, restated the way `upperWindows` restates the
   * window lattice, and for the same reason: something has to cross it.
   *
   * The fascia stands 78 mm off the wall with a 112 mm cornice over it and
   * System 2's own string course another 55 mm, so a 45 mm conduit dropping
   * straight from the first floor to the street is buried in the board for
   * half a metre of its length. A real one is cranked out and back on two
   * bends, because the electrician met the same board and solved it in ten
   * minutes, and the crank is worth having in its own right: two horizontal
   * jogs in a vertical line are three more shadows.
   */
  const fasciaY0 = openTop + 0.01;
  const fasciaY1 = Math.min(originY - 0.14, openTop + 0.62);

  /* How much wider every gate below opens on a single-storey building.
   *
   * Two of the twenty-one walked buildings are one storey — a workshop or a
   * lock-up, which is exactly what `layoutBlock` puts on the sunward row to
   * drag the shade line down into frame — and they have no first floor for
   * any of this to stand on. On the standard odds they came out carrying a
   * downpipe, a meter box and nothing else across eight metres of frontage,
   * which is the blank wall the whole function exists to remove. They get
   * the same *number* of events as their neighbours, crowded into a third
   * of the wall, which is also what a real lock-up looks like: everything
   * anyone ever fitted is within reach of a ladder. */
  const lift = b.nUp === 0 ? 0.22 : 0;

  /** A vertical run from first-floor level to the street, over the board. */
  const riser = (u: number, hw: number, thk: number,
    yA: number, yB: number, off: number): void => {
    const oF = 0.135;
    mf.box(u - hw, u + hw, fasciaY1 + 0.06, yA, d + off, d + off + thk);
    mf.box(u - hw, u + hw, fasciaY1 + 0.02, fasciaY1 + 0.08, d + off, d + oF + thk);
    mf.box(u - hw, u + hw, fasciaY0 - 0.08, fasciaY1 + 0.04, d + oF, d + oF + thk);
    mf.box(u - hw, u + hw, fasciaY0 - 0.08, fasciaY0 - 0.02, d + off, d + oF + thk);
    mf.box(u - hw, u + hw, yB, fasciaY0 - 0.04, d + off, d + off + thk);
  };

  /* ── 1. Split air conditioning ─────────────────────────────────────────
   *
   * The one thing that has been bolted to the first floor of every building
   * on a street like this since about 1995, and the only piece of wall
   * furniture on the elevation with a fan in it.
   *
   * A 3.5 kW wall-hung condenser is 800 x 550 x 285 mm over its brackets;
   * the 5 kW is 950 x 700. The pipe pair is 6 and 12 mm copper inside 19 mm
   * lagging, taped into one bundle about 65 mm across, and it goes through
   * the wall within a metre of the unit because nobody runs refrigerant
   * further than they are paid to. The condensate is the giveaway: a 20 mm
   * pipe clipped down four metres of brick and discharging onto whatever is
   * underneath, which on half of these is the shop's own sign.
   *
   * Placed on the piers rather than at hashed u, two or three per building,
   * and never on a pier `emitFurniture` has already hung its own condenser
   * off — two units on one 900 mm pier is one too many.
   */
  const acAt: { u: number; f: number; r: number }[] = [];
  for (let i = 1; i < b.bays; i++) {
    const u = 0.25 + i * b.bayW;
    if (!clearOfEscape(u)) continue;
    for (let f = 0; f < Math.min(2, b.nUp); f++) {
      if (h2(s * 40 + f * 3.1, (i - 1) * 7.7) >= 0.83) continue;
      acAt.push({ u, f, r: h2(s * 71 + i * 2.3, f * 5.9) });
    }
  }
  acAt.sort((a, z) => a.r - z.r);
  for (const sp of acAt.slice(0, 2 + (h2(s, 26.5) > 0.45 ? 1 : 0))) {
    const r1 = h2(sp.u * 13.7, sp.f * 5.1 + 1.3);
    const r2 = h2(sp.u * 7.9, sp.f * 11.3 + 2.9);
    const r3 = h2(sp.u * 3.1, sp.f * 17.7 + 4.7);
    // Clamped to the pier it is standing on rather than to the catalogue: a
    // 950 mm unit on a 1.0 m pier overhangs the window reveal either side.
    const hw = Math.min(0.35 + r1 * 0.125, (b.bayW - b.winW) * 0.5 - 0.15);
    const hgt = 0.50 + r2 * 0.15;
    const dep = 0.25 + r3 * 0.08;
    const fb = originY + sp.f * b.fh;
    // Under the window on some, alongside it on the rest, and never at the
    // same height twice: the fitter stood on a ladder and put it where the
    // pipe run was shortest.
    const y = fb + 0.58 + r1 * 0.62;
    const off = 0.052 + r2 * 0.014;

    M.attr('aMetal', s * 67 + sp.u, 1);
    mf.box(sp.u - hw, sp.u + hw, y, y + hgt, d + off, d + off + dep);
    // The discharge grille. Three bars, which is what stops the case reading
    // as a grey box and what breaks up the shadow it throws.
    for (let k = 0; k < 3; k++) {
      const yy = y + hgt * (0.24 + k * 0.22);
      mf.box(sp.u - hw + 0.055, sp.u + hw - 0.055, yy, yy + 0.028,
        d + off + dep, d + off + dep + 0.02);
    }
    M.attr('aMetal', s * 67 + sp.u, 5);
    for (const sg of [-1, 1]) {
      const uu = sp.u + sg * (hw - 0.08);
      mf.box(uu - 0.024, uu + 0.024, y - 0.055, y + hgt * 0.4, d, d + off);
      mf.box(uu - 0.022, uu + 0.022, y - 0.035, y + 0.012, d, d + off + dep * 0.8);
      stay(mf, uu - 0.019, uu + 0.019, y - 0.30, d + 0.012, y - 0.02, d + off + dep * 0.66, 0.042);
    }

    /* The pipe pair and the hole it goes into.
     *
     * Lagged, taped, and sagging a little between the two clips because
     * armaflex is not a structural material. It enters the wall 400-700 mm
     * below the unit, and the 300 mm of cement the fitter smeared round the
     * core hole is the part that gives it away at ten metres: a pale patch
     * on a dirty wall is a brighter event than the pipe is.
     */
    const up = sp.u + (r3 < 0.5 ? -1 : 1) * (hw - 0.16);
    const yIn = y - 0.42 - r2 * 0.27;
    M.attr('aMetal', s * 67 + sp.u, 3);
    for (const k of [-1, 1]) {
      const uu = up + k * 0.043;
      /* Leaning out 7 to 12 mm over its length, because lagged copper hung
       * on two clips is not plumb and nothing else on this elevation is off
       * the vertical by anything. A wall of exactly parallel lines is the
       * cheapest tell there is, and a prism costs four triangles more than
       * the box it replaces. */
      stay(mf, uu - 0.031, uu + 0.031, yIn + 0.02, d + 0.059 + r1 * 0.004,
        y + 0.05, d + 0.070 + r2 * 0.006, 0.062);
    }
    M.attr('aMetal', s * 67 + sp.u, 4);
    mf.box(up - 0.088, up + 0.088, (yIn + y) * 0.5, (yIn + y) * 0.5 + 0.035, d, d + 0.10);
    mf.box(up - 0.10, up + 0.10, yIn - 0.06, yIn + 0.03, d, d + 0.034);
    W.attr('aRole', ROLE.STONE);
    /* The patch stops 85 mm short of the sill nose in the worst bay the
     * layout produces, which is why the pipe lane is 160 mm in from the end
     * of the case rather than 115: the make-good is wider than the hole and
     * a cement patch lapping onto a projecting cast stone sill is a junction
     * fault visible from across the road. */
    wf.box(up - 0.13, up + 0.13, yIn - 0.10, yIn + 0.07, d, d + 0.012);

    if (r2 > 0.40) {
      // Drip tray, and then the condensate. Half of them are run properly to
      // the ground and half stop over the fascia, which is why every sign
      // board on a street like this has a green stain down one end of it.
      M.attr('aMetal', s * 67 + sp.u, 1);
      mf.box(sp.u - hw - 0.022, sp.u + hw + 0.022, y - 0.06, y - 0.018,
        d + off, d + off + dep + 0.035);
      M.attr('aMetal', s * 67 + sp.u, 6);
      /* Weathered white plastic has no kind of its own and the galvanised
       * branch is the closest thing to it in the shader: a chalky matt oxide
       * at 0.145 albedo is very nearly what a twenty-year-old overflow pipe
       * returns once the city has had it.
       *
       * The drop is on the pier's waste lane rather than under the end of
       * the tray, because below the fascia this is running down a 420 mm
       * pier and the end of a 950 mm unit is out over the shop window. */
      const uc = sp.u + LANE.cond;
      mf.box(uc - 0.014, sp.u + hw, y - 0.048, y - 0.02, d + off, d + off + 0.03);
      if (r3 > 0.5) {
        riser(uc, 0.014, 0.028, y - 0.05, b.base + 0.42 + r1 * 0.5, 0.03);
      } else {
        mf.box(uc - 0.014, uc + 0.014, fasciaY1 + 0.09, y - 0.05, d + 0.03, d + 0.058);
      }
      for (let yy = fasciaY1 + 0.35; yy < y - 0.25; yy += 1.15) {
        mf.box(uc - 0.026, uc + 0.026, yy, yy + 0.034, d, d + 0.036);
      }
    }
  }

  /* ── 2. The second and third conduit runs ──────────────────────────────
   *
   * One run across a facade is a line. Three at different heights, dropping
   * onto each other and onto things that need feeding, is an installation —
   * and the difference is what the eye uses to date a building.
   *
   * Both of these sit in the band between a floor level and the sill above
   * it, which is 675 mm of uninterrupted wall on the tightest storey in the
   * layout and the only horizontal corridor an elevation like this has.
   * 20 mm galvanised conduit on saddle clips at 1.4 m centres, held 42 mm
   * clear so the wall behind it stays a different value from the conduit.
   */
  if (b.nUp >= 1) {
    const cOff = 0.042;
    const uA = service[0];
    const uB = service.length > 1
      ? service[service.length - 1]
      : Math.min(b.L - 0.5, uA + 1.8 + h2(s, 41.9) * 1.4);
    const runY = originY + 0.16 + h2(s, 33.1) * 0.26;

    M.attr('aMetal', s * 87, 3);
    mf.box(uA, uB, runY, runY + 0.048, d + cOff, d + cOff + 0.048);
    for (let u = uA + 0.35; u < uB - 0.15; u += 1.4) {
      mf.box(u, u + 0.046, runY - 0.012, runY + 0.060, d, d + cOff + 0.008);
    }
    // A box at each end, because conduit does not simply stop.
    M.attr('aMetal', s * 87, 5);
    mf.box(uA - 0.15, uA + 0.06, runY - 0.075, runY + 0.135, d, d + 0.088);
    mf.box(uB - 0.055, uB + 0.085, runY - 0.075, runY + 0.135, d, d + 0.088);

    /* The drop out of the near box, down to a meter at waist height. The
     * pier it runs on is the same one the run starts on, which is the whole
     * point of putting the junction box there. */
    M.attr('aMetal', s * 87, 3);
    const uD = uA + LANE.elec;
    riser(uD, 0.024, 0.048, runY - 0.06, b.base + 1.52, cOff);
    for (let yy = b.base + 0.45; yy < fasciaY0 - 0.3; yy += 1.25) {
      mf.box(uD - 0.045, uD + 0.045, yy, yy + 0.046, d, d + cOff + 0.008);
    }
    M.attr('aMetal', s * 87, 5);
    mf.box(uA - 0.13, uA + 0.13, b.base + 1.10, b.base + 1.52, d, d + 0.135);
    mf.box(uA - 0.10, uA + 0.10, b.base + 1.14, b.base + 1.48, d + 0.135, d + 0.158);

    /* The third run, a storey up and linked to the second by a vertical leg
     * on the same pier, because that is how a rewire actually spreads: one
     * board in the basement, one riser, a spur onto every floor it reaches. */
    if (b.nUp >= 2) {
      const y3 = originY + b.fh + 0.15 + h2(s, 37.3) * 0.28;
      const u3 = service.length > 1 ? service[1 % service.length] : uA;
      const uE = Math.max(uA + 0.9, Math.min(b.L - 0.55, u3 + 1.6 + h2(s, 43.7) * 1.9));
      M.attr('aMetal', s * 87, 3);
      mf.box(uD - 0.024, uD + 0.024, runY + 0.10, y3, d + cOff, d + cOff + 0.048);
      for (let yy = runY + 0.55; yy < y3 - 0.3; yy += 1.4) {
        mf.box(uD - 0.045, uD + 0.045, yy, yy + 0.046, d, d + cOff + 0.008);
      }
      mf.box(Math.min(uD, uE), Math.max(uD, uE), y3, y3 + 0.048, d + cOff, d + cOff + 0.048);
      for (let u = Math.min(uD, uE) + 0.5; u < Math.max(uD, uE) - 0.15; u += 1.4) {
        mf.box(u, u + 0.046, y3 - 0.012, y3 + 0.060, d, d + cOff + 0.008);
      }
      // It ends on an isolator, which is what a spur is for.
      M.attr('aMetal', s * 87, 5);
      mf.box(uD - 0.075, uD + 0.075, y3 - 0.055, y3 + 0.135, d, d + 0.082);
      mf.box(uE - 0.075, uE + 0.075, y3 + 0.048, y3 + 0.235, d, d + 0.098);
      mf.box(uE - 0.055, uE + 0.02, y3 + 0.09, y3 + 0.13, d + 0.098, d + 0.125);
    }

    /* A drop cable slung between the two junction boxes, sagging because
     * nobody clipped it. Three straight segments read as a catenary at any
     * distance this is seen from, and the sag is the only curve anywhere on
     * this elevation. */
    if (uB - uA > 1.6) {
      M.attr('aMetal', s * 87, 3);
      const sag = 0.11 + h2(s, 47.1) * 0.13;
      const yc = runY - 0.06;
      const seg: [number, number][] = [
        [uA, yc], [uA + (uB - uA) * 0.34, yc - sag * 0.86],
        [uA + (uB - uA) * 0.66, yc - sag], [uB, yc - sag * 0.28],
      ];
      for (let i = 0; i < 3; i++) {
        prism(mf, seg[i][0], seg[i][1], seg[i + 1][0], seg[i + 1][1],
          0.017, d + 0.052, d + 0.069);
      }
    }
  }

  /* ── 3. Risers and standpipes at street level ──────────────────────────
   *
   * A cast-iron soil stack is the tallest thing on any back elevation and it
   * turns up on the front of any building that has been converted to flats,
   * which is most of these. It is 100 mm bore in 1.83 m lengths — six feet,
   * which is why the collars are where they are — and every joint is a
   * socket standing 25 mm proud of the barrel with a holderbat behind it. At
   * this sun that is a stack of hard little shadow rings up thirteen metres
   * of wall, and it costs one box each.
   */
  if (h2(s, 12.7) > 0.40 - lift) {
    const u = svc(3);
    /* A one-storey building has no soil stack because it has no bathroom
     * over the shop. What it has is the waste from a sink at the back,
     * brought through the front wall by whoever fitted the kitchen and taken
     * down to the gully at the kerb: the same pipe, a third of the height,
     * and it stops under the fascia rather than crossing it. */
    const full = b.nUp >= 1;
    const top = full ? yTop - 0.55 - h2(s, 14.1) * 0.6 : fasciaY0 - 0.38;
    M.attr('aMetal', s * 97, 3);
    if (full) riser(u, 0.058, 0.112, top, b.base + 0.20, 0.032);
    else mf.box(u - 0.058, u + 0.058, b.base + 0.20, top, d + 0.032, d + 0.144);
    let k = 0;
    for (let yy = b.base + 0.62; yy < top - 0.4; yy += 1.83, k++) {
      if (yy > fasciaY0 - 0.20 && yy < fasciaY1 + 0.20) continue;
      mf.box(u - 0.078, u + 0.078, yy, yy + 0.072, d + 0.024, d + 0.152);
      if (k % 2 === 0) mf.box(u - 0.034, u + 0.034, yy + 0.018, yy + 0.054, d, d + 0.030);
    }
    // The branch that says it is a soil stack and not a rainwater pipe: a
    // boss off the side at the height of a first-floor bathroom.
    const yBoss = full ? originY + 0.55 + h2(s, 16.5) * 0.5 : top - 0.85;
    mf.box(u - 0.062, u + 0.16, yBoss, yBoss + 0.09, d + 0.030, d + 0.128);
    mf.box(u + 0.13, u + 0.19, yBoss - 0.02, yBoss + 0.11, d + 0.024, d + 0.134);
  }

  /* The gas riser. Yellow in life, galvanised here, and its whole reason for
   * existing on the elevation is that the pipe goes into the ground on one
   * side of it and into the wall on the other — a box with nothing entering
   * it is a prop. */
  if (h2(s, 15.3) > 0.46 - lift) {
    const u = pierFor(0.28, 5);
    if (u > 0) {
      M.attr('aMetal', s * 101, 6);
      mf.box(u - 0.13, u + 0.13, b.base + 0.52, b.base + 1.14, d + 0.025, d + 0.16);
      mf.box(u - 0.105, u + 0.105, b.base + 0.56, b.base + 1.10, d + 0.16, d + 0.182);
      M.attr('aMetal', s * 101, 3);
      mf.box(u - 0.032, u + 0.032, plinthTop - 0.05, b.base + 0.55, d + 0.05, d + 0.114);
      mf.box(u + 0.02, u + 0.084, b.base + 1.12, b.base + 1.46, d + 0.05, d + 0.114);
      mf.box(u + 0.008, u + 0.096, b.base + 1.40, b.base + 1.48, d, d + 0.10);
    }
  }

  /* A fire-service inlet, low down where the hose can reach it: a cabinet
   * with two instantaneous couplings in it, angled down so the rain does not
   * sit in them. The couplings are the only 45-degree lines at street level
   * on the whole frontage. */
  if (h2(s, 18.9) > 0.52 - lift) {
    const u = pierFor(0.36, 9);
    if (u > 0) {
      const y = plinthTop + 0.24;
      M.attr('aMetal', s * 103, 6);
      mf.box(u - 0.155, u + 0.155, y, y + 0.30, d + 0.022, d + 0.135);
      M.attr('aMetal', s * 103, 4);
      for (const sg of [-1, 1]) {
        const uu = u + sg * 0.072;
        stay(mf, uu - 0.036, uu + 0.036, y + 0.20, d + 0.135, y + 0.10, d + 0.245, 0.072);
      }
      mf.box(u - 0.175, u + 0.175, y + 0.30, y + 0.335, d + 0.022, d + 0.155);
    }
  }

  /* ── 4. Vents and extract ──────────────────────────────────────────────
   *
   * The cheapest silhouette available on a blank wall and the most
   * informative: a louvred grille says there is a plant room behind it, a
   * cowl three metres up says there is a fryer behind it, and a 100 mm cap
   * says somebody put a tumble dryer in a back room. They cluster, because
   * the kitchen is in one place, so they are all hung off one hashed bay
   * rather than sprinkled along the frontage.
   */
  const kitchen = h2(s, 22.3);
  if (kitchen > 0.38 - lift) {
    const u = svc(7) - 0.14;
    M.attr('aMetal', s * 107, 6);
    // The extract duct, climbing the wall from the back of the shop to a
    // cowl above first-floor window head height, which is where the
    // environmental health officer made them put it.
    if (b.nUp >= 1) {
      /* Above the head of the first-floor window, or as far up as it can go
       * without fouling the cornice — a 300 mm duct standing 290 mm proud
       * and a cornice projecting up to 300 mm occupy the same air, and the
       * clash is at the top of the elevation where the silhouette is. */
      const yC = Math.min(originY + b.sill + b.winH + 0.35, yTop - 0.75);
      mf.box(u - 0.16, u + 0.16, fasciaY1 + 0.08, yC, d + 0.035, d + 0.29);
      // Bands at the duct joints, and a bracket back to the wall.
      for (let yy = fasciaY1 + 0.7; yy < yC - 0.3; yy += 1.25) {
        mf.box(u - 0.185, u + 0.185, yy, yy + 0.05, d + 0.02, d + 0.31);
        mf.box(u - 0.03, u + 0.03, yy + 0.012, yy + 0.04, d, d + 0.04);
      }
      // The cowl: a hood over the mouth, and a lip under it. Both of them
      // are pure silhouette against the wall behind and both of them drop a
      // horizontal shadow the width of the duct.
      mf.box(u - 0.20, u + 0.20, yC, yC + 0.20, d + 0.03, d + 0.34);
      mf.box(u - 0.23, u + 0.23, yC + 0.18, yC + 0.245, d + 0.02, d + 0.40);
      mf.box(u - 0.17, u + 0.17, yC - 0.06, yC + 0.02, d + 0.29, d + 0.38);
    }
    // A louvred grille at high level on the pier below it, and the louvres
    // are individual because four blades with air between them is a grille
    // and one hatched box is a panel.
    const ug = pierFor(0.30, 11);
    if (ug > 0) {
      const yg = openTop - 0.62 - h2(s, 24.7) * 0.5;
      mf.box(ug - 0.145, ug + 0.145, yg, yg + 0.34, d + 0.018, d + 0.048);
      for (let k = 0; k < 4; k++) {
        const yy = yg + 0.045 + k * 0.072;
        mf.box(ug - 0.135, ug + 0.135, yy, yy + 0.026, d + 0.048, d + 0.082);
      }
    }
    /* Two dryer vents, capped. 110 mm, and a square backplate rather than a
     * round one: an eight-sided tube is twenty triangles against a box's
     * twelve for an outline four pixels across at the distance this is ever
     * read from. One goes on the pier beside the duct, the other low down on
     * a ground-storey pier, because a back room has one too. */
    const caps: [number, number][] = [
      [u + 0.39, originY + 0.30 + h2(s, 26.9) * 0.28],
      [pierFor(0.20, 27), b.base + 2.05 + h2(s, 28.1) * 0.45],
    ];
    for (const [uu, yy] of caps) {
      if (uu < 0 || yy > yTop - 0.5) continue;
      mf.box(uu - 0.075, uu + 0.075, yy, yy + 0.15, d + 0.012, d + 0.042);
      mf.box(uu - 0.058, uu + 0.058, yy + 0.02, yy + 0.13, d + 0.042, d + 0.105);
    }
  }

  /* ── 5. Bulkheads ──────────────────────────────────────────────────────
   *
   * Geometry only — there is not a light source anywhere in this file and
   * this does not add one. An unlit bulkhead still earns its place twice
   * over: it is a 240 mm object standing 150 mm off a wall at head height,
   * which at this sun throws a shadow two metres long, and a doorway with
   * nothing over it reads as a hole rather than as an entrance.
   */
  {
    const ul = pierFor(0.26, 13);
    if (ul > 0) {
      const y = openTop - 0.35 - h2(s, 31.7) * 0.45;
      M.attr('aMetal', s * 109, 5);
      mf.box(ul - 0.06, ul + 0.06, y, y + 0.13, d, d + 0.028);
      mf.box(ul - 0.028, ul + 0.028, y + 0.035, y + 0.095, d + 0.028, d + 0.095);
      M.attr('aMetal', s * 109, 6);
      mf.box(ul - 0.115, ul + 0.115, y - 0.02, y + 0.145, d + 0.095, d + 0.235);
      // The visor, which is the part that makes it read as a light fitting
      // rather than as another box.
      mf.box(ul - 0.135, ul + 0.135, y + 0.13, y + 0.175, d + 0.075, d + 0.26);
    }
    /* A second one at first floor, on the end of the run that is looking for
     * something to feed. The 300 mm of conduit between the two is what stops
     * the lamp being a sticker and the run being a line. */
    if (b.nUp >= 1) {
      const uu = Math.min(b.L - 0.4, service[service.length - 1] + 0.25);
      const y = originY + 0.95 + h2(s, 34.9) * 0.5;
      M.attr('aMetal', s * 109, 3);
      mf.box(uu - 0.022, uu + 0.022, originY + 0.42, y, d + 0.042, d + 0.086);
      M.attr('aMetal', s * 109, 6);
      mf.box(uu - 0.10, uu + 0.10, y, y + 0.15, d + 0.03, d + 0.175);
      mf.box(uu - 0.12, uu + 0.12, y + 0.135, y + 0.175, d + 0.02, d + 0.20);
    }
  }

  /* ── 6. Cables ─────────────────────────────────────────────────────────
   *
   * The service head is in the shop and the flat above it was wired off it
   * in about 1970, which means a 25 mm cable stapled up the outside of the
   * building because running it inside would have meant lifting a floor.
   * Every one of these starts on a box and ends on one; a cable that fades
   * out halfway up a wall is worse than no cable, because the eye follows
   * cables and finds the end of them.
   */
  if (b.nUp >= 1) {
    const u = svc(17) + LANE.cable;
    const yEnd = originY + 0.62 + h2(s, 39.5) * 0.55;
    M.attr('aMetal', s * 113, 5);
    mf.box(u - 0.045, u + 0.045, b.base + 1.18, b.base + 1.54, d, d + 0.075);
    mf.box(u - 0.06, u + 0.06, yEnd, yEnd + 0.13, d, d + 0.062);
    M.attr('aMetal', s * 113, 3);
    riser(u, 0.017, 0.032, yEnd + 0.02, b.base + 1.5, 0.026);
    // Staples, at the spacing a man on a ladder actually works to rather
    // than at the spacing the regulations ask for.
    for (let yy = b.base + 1.9; yy < yEnd - 0.3; yy += 0.95 + h2(s, yy) * 0.35) {
      if (yy > fasciaY0 - 0.15 && yy < fasciaY1 + 0.15) continue;
      mf.box(u - 0.03, u + 0.03, yy, yy + 0.03, d, d + 0.03);
    }
  }

  /* ── 7. A dish at first floor ──────────────────────────────────────────
   *
   * The parapet is where the last one went and it is not where most of them
   * are. A dish put up for a first-floor flat is bolted to the wall beside
   * the window of the room the cable has to reach, 400 mm of arm out from
   * the brickwork, and the coaxial downlead runs from it straight into a
   * hole drilled through the frame reveal.
   *
   * Wound to face the street. The roof one was not — its fan was listed
   * anti-clockwise seen from outside, so its dished face was a back face and
   * only the rim ring survived, which at fifty metres is a hoop nobody
   * questions. Nothing here could have afforded that at four metres, which is
   * how the roof one came to be found. Both are now wound the same way and
   * `tools/winding.mjs` checks them.
   */
  /* One dish, and a second on the buildings that were split into two flats,
   * which is why they are never on the same pier and never at the same
   * height: two tenants, two installers, two years apart. */
  const dishes = h2(s, 57.7) > 0.40 ? (h2(s, 58.7) > 0.58 ? 2 : 1) : 0;
  for (let k = 0; k < (b.nUp >= 1 ? dishes : 0); k++) {
    const u = svc(19 + k * 8) + (h2(s, 58.1 + k) - 0.5) * 0.12;
    if (k === 1 && Math.abs(u - svc(19)) < 0.5) continue;
    if (clearOfEscape(u)) {
      const y = originY + 1.35 + h2(s, 59.3 + k * 3.1) * 0.9 + k * 0.42;
      M.attr('aMetal', s * 127, 2);
      mf.box(u - 0.05, u + 0.05, y - 0.16, y + 0.16, d, d + 0.035);
      mf.box(u - 0.026, u + 0.026, y - 0.02, y + 0.02, d + 0.035, d + 0.30);
      stay(mf, u - 0.02, u + 0.02, y - 0.14, d + 0.03, y - 0.01, d + 0.24, 0.036);
      M.attr('aMetal', s * 127, 9);
      /* 550 mm across, squashed in d because it is turned 20-odd degrees off
       * the wall and tipped up: a dish square to the elevation is pointing at
       * the building opposite, which is not where the satellite is. */
      const r = 0.27;
      const cy = y + 0.06, cd = d + 0.30;
      const rim = (a: number, k: number): [number, number, number] => [
        u + Math.cos(a) * r * k * 0.92 + Math.sin(a) * r * k * 0.16,
        cy + Math.sin(a) * r * 0.86 * k,
        cd + Math.cos(a) * r * 0.22 * k,
      ];
      const cn: [number, number, number] = [u + 0.03, cy, cd - 0.075];
      /* The lip, standing 50 mm off the dished face along the axis rather
       * than lying in it. A ring drawn inside the face is a ring whose
       * normal is the face's own, which is to say no edge at all; what makes
       * a dish read as a dish at four metres is the band of shadow the lip
       * drops across its own inside. */
      const lip = (a: number): [number, number, number] => {
        const p = rim(a, 1);
        return [p[0] + 0.018, p[1], p[2] + 0.05];
      };
      for (let i = 0; i < 8; i++) {
        const a0 = (i / 8) * Math.PI * 2, a1 = ((i + 1) / 8) * Math.PI * 2;
        mf.quadFree(cn, rim(a1, 1), rim(a0, 1), rim(a0, 1),
          [[0, 0], [1, 0], [1, 1], [1, 1]]);
        mf.quadFree(rim(a0, 1), lip(a0), lip(a1), rim(a1, 1),
          [[i, 0], [i, 1], [i + 1, 1], [i + 1, 0]]);
      }
      // Feed arm and LNB, which is the part of a dish the eye recognises.
      mf.box(u - 0.016, u + 0.016, cy - 0.19, cy - 0.02, cd + 0.03, cd + 0.26);
      mf.box(u - 0.036, u + 0.036, cy - 0.225, cy - 0.135, cd + 0.21, cd + 0.30);
      // The downlead, dropping off the arm and clipped into the reveal.
      M.attr('aMetal', s * 127, 3);
      mf.box(u + 0.02, u + 0.044, y - 0.35, cy - 0.16, d + 0.05, d + 0.074);
      mf.box(u + 0.02, u + 0.16, y - 0.38, y - 0.35, d + 0.05, d + 0.074);
    }
  }

  /* ── 8. What is left on a wall after forty years ───────────────────────
   *
   * None of this is worth anything on its own and together it is most of
   * what separates a used wall from a new one: the hoop somebody chains a
   * bike to, the bracket a sign came off, a stub of pipe cut back to the
   * wall when the boiler was moved inside, and a gas service capped and left
   * because it was cheaper than digging it out.
   */
  {
    const uh = pierFor(0.34, 23);
    if (uh > 0 && h2(s, 61.1) > 0.35 - lift) {
      // A hoop, out of the same painted ironwork as the lot railings.
      M.attr('aMetal', s * 131, 0);
      const y = plinthTop + 0.18;
      for (const sg of [-1, 1]) {
        mf.box(uh + sg * 0.14 - 0.018, uh + sg * 0.14 + 0.018, y, y + 0.36, d + 0.02, d + 0.056);
      }
      mf.box(uh - 0.158, uh + 0.158, y + 0.34, y + 0.376, d + 0.02, d + 0.056);
      mf.box(uh - 0.055, uh + 0.055, y - 0.03, y + 0.05, d, d + 0.03);
    }
    const ub = pierFor(0.22, 29);
    if (ub > 0 && h2(s, 63.3) > 0.42 - lift) {
      // The bracket a projecting sign hung off, with the sign long gone.
      M.attr('aMetal', s * 131, 2);
      const y = openTop - 0.9 - h2(s, 65.5) * 0.6;
      mf.box(ub - 0.05, ub + 0.05, y, y + 0.20, d, d + 0.03);
      mf.box(ub - 0.022, ub + 0.022, y + 0.14, y + 0.18, d + 0.03, d + 0.30);
      stay(mf, ub - 0.018, ub + 0.018, y + 0.02, d + 0.025, y + 0.145, d + 0.255, 0.032);
    }
    if (b.nUp >= 1 && h2(s, 67.7) > 0.40) {
      // A pipe stub, cut off and capped where something used to hang.
      M.attr('aMetal', s * 131, 3);
      const u = svc(31) + 0.19;
      const y = originY + 0.5 + h2(s, 69.9) * 1.3;
      mf.box(u - 0.028, u + 0.028, y, y + 0.22, d + 0.03, d + 0.086);
      mf.box(u - 0.038, u + 0.038, y + 0.20, y + 0.245, d + 0.024, d + 0.094);
    }
    const uc2 = pierFor(0.20, 37);
    if (uc2 > 0 && h2(s, 71.3) > 0.5 - lift) {
      // A capped gas service, left in the wall because taking it out costs
      // more than leaving it. The cap is a different metal from the pipe.
      M.attr('aMetal', s * 131, 3);
      const y = plinthTop + 0.06;
      // Pulled 9 mm away from the wall at the top, the way a pipe that lost
      // its middle clip thirty years ago is.
      stay(mf, uc2 - 0.034, uc2 + 0.034, y, d + 0.062, y + 0.42, d + 0.071, 0.068);
      M.attr('aMetal', s * 131, 4);
      mf.box(uc2 - 0.046, uc2 + 0.046, y + 0.40, y + 0.455, d + 0.02, d + 0.104);
      W.attr('aRole', ROLE.STONE);
      // The make-good round it, which is the part that reads: a hand-sized
      // patch of cement on brick is a brighter thing than the pipe.
      wf.box(uc2 - 0.115, uc2 + 0.115, y - 0.04, y + 0.16, d, d + 0.014);
    }
  }
}

/* ── One building ───────────────────────────────────────────────────────── */

function emitBuilding(b: Bldg, W: Emit, G: Emit, T: Emit, M: Emit): void {
  const c: WinCtx = {
    wf: new Face(W, b.frame), gf: new Face(G, b.frame),
    tf: new Face(T, b.frame), mf: new Face(M, b.frame),
    W, G, T, M, b, d: b.d0,
  };
  const { wf } = c;
  const d = b.d0;
  const back = d - BLOCK_DEPTH;
  const yb = b.base - 0.55;
  const originY = b.base + b.gh;
  const yTop = b.base + b.H;
  const yPar = yTop + b.par;
  const roofY = yTop - 0.42;

  W.attr('aGrid', b.bayW, b.fh, 0.25, originY);
  W.attr('aWin', b.winW, b.sill, 0, b.L);
  W.attr('aBldg', b.seed, b.pal, b.base, yTop);

  /* ── Ground storey ────────────────────────────────────────────────────
   *
   * Left deliberately unfinished. System 3 puts the shopfronts, the awnings
   * and the signage in, and anything built here that looks like a shop is
   * something that has to be demolished later. What it does need is the
   * *structure*: a plinth to stand on, piers between the openings, a lintel
   * spanning each one and a fascia above it where a sign will go, because
   * that rhythm is what sets the scale of the whole elevation and because
   * without it the ground floor is a blank wall — which is far more wrong
   * than an empty shopfront. */
  const { plinthTop, openTop } = groundLevels(b);

  /* The plinth, and the reason it grew.
   *
   * A building that meets the footway at a clean line has not been built off
   * it, it has been dropped onto it, and that was the loudest single fault in
   * the last set of frames: at street distance the whole frontage read as
   * cardboard standing on a table. Three things fix it and all three are here.
   *
   * The base course stands 90 mm proud of the wall rather than 35, so there is
   * a real step with a top surface to it. That surface gets a weathered stone
   * offset — a splay, which every plinth has, because a flat ledge at the
   * bottom of a wall collects water — and the splay is what gives the junction
   * a line of its own instead of a corner. And the course carries on 550 mm
   * below the paving, so nothing can show daylight underneath it however the
   * footway falls.
   *
   * The rest of the contact is shading rather than geometry: see the occlusion
   * term in the masonry shader and the matching one on the footway, because at
   * four degrees there is no cast shadow available at a wall base on the sunny
   * side and ambient occlusion is the only thing that puts it there. */
  const pOut = 0.09;
  W.attr('aRole', ROLE.PLINTH);
  wf.panel(0, b.L, yb, plinthTop, d + pOut);
  W.attr('aRole', ROLE.STONE);
  // The splay: a chamfered weathering off the top of the base course.
  wf.quadFree(
    [0, plinthTop, d + pOut], [0, plinthTop + 0.075, d],
    [b.L, plinthTop + 0.075, d], [b.L, plinthTop, d + pOut],
    [[0, plinthTop], [0, plinthTop + 0.08], [b.L, plinthTop + 0.08], [b.L, plinthTop]],
  );

  const openings = groundOpenings(b);
  const groundHoles: [number, number][] = openings.map((o) => [o.u0, o.u1]);

  W.attr('aRole', ROLE.WALL);
  band(wf, plinthTop, openTop, d, 0, b.L, groundHoles);

  for (const { u0: a, u1: z, rec } of openings) {
    W.attr('aRole', ROLE.REVEAL);
    wf.jamb(a, d - rec, d, plinthTop, openTop, +1);
    wf.jamb(z, d - rec, d, plinthTop, openTop, -1);
    wf.deck(a, z, d - rec, d, openTop, false);
    wf.deck(a, z, d - rec, d, plinthTop, true);
    /* Closed with a flat recessed panel only where nothing better is coming.
     *
     * On the two rows the camera walks between, System 3 builds a real
     * shopfront into this opening — stall riser, glazing, a room behind it —
     * and it builds the back of that room, so the hole is closed there too.
     * Leaving the panel in as well would put a wall 150 mm in front of every
     * shop window in the street. */
    if (b.street) continue;
    W.attr('aRole', ROLE.SHUTTER);
    wf.panel(a, z, plinthTop, openTop, d - rec);
  }

  // The bressumer over the shopfronts, then the fascia.
  W.attr('aRole', ROLE.STONE);
  wf.box(0, b.L, openTop, openTop + 0.24, d - 0.02, d + 0.045);
  W.attr('aRole', ROLE.WALL);
  wf.panel(0, b.L, openTop + 0.24, originY, d);

  if (b.band) {
    W.attr('aRole', ROLE.STONE);
    wf.box(0, b.L, originY - 0.16, originY - 0.02, d - 0.02, d + 0.055);
  }

  /* ── Upper storeys ──────────────────────────────────────────────────── */
  for (let f = 0; f < b.nUp; f++) {
    const fb = originY + f * b.fh;
    const y0 = fb + b.sill;
    const y1 = Math.min(y0 + b.winH, fb + b.fh - 0.42);
    const holes: [number, number][] = [];
    const keys: number[] = [];
    for (let i = 0; i < b.bays; i++) {
      // A blank bay here and there: a party wall behind, a chimney breast, a
      // window blocked up when the building next door went up.
      if (h2(b.seed * 61 + f * 5.7, i * 3.3) < 0.055) continue;
      const uc = 0.25 + (i + 0.5) * b.bayW;
      holes.push([uc - b.winW * 0.5, uc + b.winW * 0.5]);
      keys.push(f * 37 + i * 5 + 1);
    }
    W.attr('aRole', ROLE.WALL);
    band(wf, fb, y0, d, 0, b.L, []);
    band(wf, y0, y1, d, 0, b.L, holes);
    band(wf, y1, fb + b.fh, d, 0, b.L, []);
    for (let k = 0; k < holes.length; k++) {
      emitWindow(c, holes[k][0], holes[k][1], y0, y1, keys[k]);
      W.attr('aRole', ROLE.WALL);
    }
  }

  /* ── Top ────────────────────────────────────────────────────────────── */
  if (b.cornice > 0) {
    W.attr('aRole', ROLE.STONE);
    wf.box(-0.04, b.L + 0.04, yTop - 0.30, yTop, d - 0.02, d + b.cornice);
  }
  W.attr('aRole', ROLE.WALL);
  wf.panel(0, b.L, yTop, yPar, d);
  W.attr('aRole', ROLE.STONE);
  wf.deck(-0.03, b.L + 0.03, d - 0.36, d + 0.05, yPar, true);
  wf.jamb(-0.03, d - 0.36, d + 0.05, yPar - 0.07, yPar, -1);
  wf.jamb(b.L + 0.03, d - 0.36, d + 0.05, yPar - 0.07, yPar, +1);
  wf.panel(-0.03, b.L + 0.03, yPar - 0.07, yPar, d + 0.05);
  W.attr('aRole', ROLE.PLAIN);
  wf.panelIn(0, b.L, roofY, yPar, d - 0.36);
  W.attr('aRole', ROLE.ROOF);
  wf.deck(0, b.L, back, d - 0.36, roofY, true);

  /* A raised centre to the parapet on about a third of them.
   *
   * Neighbouring buildings already differ in height, but within one frontage
   * the parapet is a single straight line across ten or fifteen metres, and
   * against a bright sky that line is the most mechanical thing in the frame.
   * A gable, a raised name panel or a pedimented centre bay is on a large
   * fraction of real Victorian street buildings and it costs eight quads. */
  if (h2(b.seed, 3.7) > 0.66) {
    const cu = 0.25 + b.bayW * Math.max(0, Math.floor((b.bays - 2) * h2(b.seed, 8.2)));
    const cw = b.bayW * (b.bays > 3 ? 2 : 1);
    const rise = 0.45 + h2(b.seed, 12.9) * 0.8;
    W.attr('aRole', ROLE.WALL);
    wf.panel(cu, cu + cw, yPar, yPar + rise, d);
    wf.jamb(cu, d - 0.36, d, yPar, yPar + rise, -1);
    wf.jamb(cu + cw, d - 0.36, d, yPar, yPar + rise, +1);
    wf.panelIn(cu, cu + cw, yPar, yPar + rise, d - 0.36);
    W.attr('aRole', ROLE.STONE);
    wf.deck(cu - 0.08, cu + cw + 0.08, d - 0.42, d + 0.07, yPar + rise, true);
    wf.panel(cu - 0.08, cu + cw + 0.08, yPar + rise - 0.09, yPar + rise, d + 0.07);
    wf.jamb(cu - 0.08, d - 0.42, d + 0.07, yPar + rise - 0.09, yPar + rise, -1);
    wf.jamb(cu + cw + 0.08, d - 0.42, d + 0.07, yPar + rise - 0.09, yPar + rise, +1);
  }

  /* Flanks and back.
   *
   * The flanks are visible wherever two neighbours differ in height or in how
   * far forward they stand, which after the setback jitter above is
   * everywhere. The back is never visible at all — and it is not optional. A
   * building open at the back is not a solid to the shadow pass: the sun
   * bears +X and -Z, so a ray headed for the street enters through the back
   * face, and with shadowSide FrontSide the facade's own front faces are
   * turned away from the light and get culled. Leave the back off and the
   * building casts nothing. */
  W.attr('aRole', ROLE.FLANK);
  wf.jamb(0, back, d, yb, yPar, -1);
  wf.jamb(b.L, back, d, yb, yPar, +1);
  W.attr('aRole', ROLE.PLAIN);
  wf.panelIn(0, b.L, yb, yPar, back);

  if (b.escape >= 0) emitEscape(c, b.escape);
  emitFurniture(c);
  /* And, on the two rows the camera walks between and nowhere else, the layer
   * of fixtures that only pays for itself inside about eight metres. Applied
   * to all fifty-seven buildings it would be forty thousand triangles spent
   * on backland ranges nothing ever looks at. */
  if (b.street) emitStreetFixtures(c);
}

/* ── The rest of the town ───────────────────────────────────────────────── */

/**
 * Blocks in the middle distance, seen only past the ends of the frontage and
 * through the cross street.
 *
 * The gap that lets the sun in also lets the eye out, and what it found was
 * the hazed edge of the ground plane: a sea horizon, in the middle of a city.
 * Modelled frontages were tried out to seventy metres and it was not enough —
 * the sightline through a twelve-metre opening runs two hundred metres before
 * it clears the last of them, and building real elevations that far out costs
 * a hundred thousand triangles to render four pixels of roof.
 *
 * So past the cross street it is boxes. At a hundred and fifty metres the fog
 * has taken three quarters of the contrast out of anything, and a stepped
 * skyline of flat-topped masses at decreasing contrast is exactly what a long
 * lens actually records. Twenty-two of them, none nearer than sixty metres,
 * all of them outside the shadow camera and so casting nothing.
 */
function emitBackdrop(W: Emit): void {
  const rng = makeRng(88041);
  W.attr('aGrid', 3.0, 3.2, 0.25, 4);
  W.attr('aWin', 1.4, 0.9, 0, 20);
  /* Its own role, where it used to borrow the party-wall one.
   *
   * Borrowing FLANK meant these masses were painted in brick, which sounds
   * generous and is in fact why they came out blank. Brick is a 65 mm feature.
   * Sixty to a hundred and forty metres away it is far below a pixel, so the
   * analytic filtering does exactly what it is supposed to do and converges the
   * whole wall on the average of a brick and a joint — one flat tone, edge to
   * edge, with a hard straight silhouette around it. The material was working
   * correctly and the result was a cream cube.
   *
   * What survives at that range is the storey, not the unit: window heads and
   * cills are metre-scale, and a metre subtends fifteen pixels at a hundred
   * metres in these frames. So the backdrop needs the one feature it did not
   * have — a window rhythm — and does not need any of the ones it did. */
  W.attr('aRole', ROLE.BACKDROP);

  /* A jittered field rather than rings.
   *
   * Rings put every mass at one distance, and one distance is one value once
   * the fog has finished with them, so they came out as a paper cutout. A
   * field two hundred metres deep gives the overlap and the value separation
   * that make the far side of a town read as far away rather than as a wall
   * with a picture on it.
   */
  const CELL = 34;
  for (let ix = -7; ix <= 9; ix++) {
    for (let iz = -13; iz <= 3; iz++) {
      const cx = ix * CELL + (rng() - 0.5) * CELL * 0.55;
      const cz = iz * CELL + (rng() - 0.5) * CELL * 0.55;
      const w = 14 + rng() * 30;
      const dep = 16 + rng() * 26;
      const hgt = 7 + rng() * 22;
      /* Keep out of the street and out of everything modelled properly. The
       * near limit is generous because these have no windows, no reveals and
       * no relief at all: inside about sixty metres that is obvious. */
      /* Two keep-outs, and the second one is the interesting one.
       *
       * The first keeps boxes out of the street and away from the modelled
       * frontages, which have to be the only thing in the near field.
       *
       * The second is a forty-metre standoff from the walk itself, and it is
       * a shadow constraint rather than a visual one. The sun's shadow camera
       * is a thirty-metre box tracking the walker, so a caster further out
       * than that is simply not in the depth map and blocks no light at all —
       * which is the only reason a hundred and fifty boxes can be scattered
       * upsun of a four-degree sun without putting the entire street out.
       * Inside forty metres they would start eating the shafts. */
      if (Math.abs(cx) < 26 && cz > -126) continue;
      const t = Math.max(-98, Math.min(6, cz));
      if (Math.hypot(cx, cz - t) < 40) continue;
      const bseed = rng();
      const f = new Face(W, frame(cx, cz, 0, -1));

      /* The top edge, broken.
       *
       * A single quad from datum to hgt gives a perfectly horizontal parapet
       * and two perfectly vertical corners, and against a bright sky that reads
       * as a rectangle laid over the photograph however well the wall beneath it
       * is textured — the silhouette is the part of a distant building the eye
       * actually judges. Splitting the frontage into two or three bays at
       * different heights costs a handful of quads and buys a stepped skyline,
       * which is what the far side of any real town does where one block was
       * built up and its neighbour was not. */
      const bays = 2 + (rng() < 0.45 ? 1 : 0);
      const tops: number[] = [];
      for (let b = 0; b < bays; b++) tops.push(hgt * (0.72 + 0.28 * rng()));
      for (let b = 0; b < bays; b++) {
        const u0 = (w * b) / bays, u1 = (w * (b + 1)) / bays;
        const top = tops[b];
        /* w carries this bay's own parapet height, not the mass's, because the
         * shader puts a coping band just under it and a band floating across the
         * middle of the neighbouring bay would be worse than no band at all. */
        W.attr('aBldg', bseed, 0, 0, top);
        // Down to -3 rather than to zero. The apron is not dead flat and a box
        // that stops exactly at datum shows daylight under its own base from a
        // low camera, which is what put "floating props" in the critique.
        f.panel(u0, u1, -3, top, 0);
        f.deck(u0, u1, -dep, 0, top, true);
        // The step between one bay and the next has to be closed or the taller
        // one is hollow when seen from the side.
        if (b > 0 && Math.abs(tops[b - 1] - top) > 0.05) {
          f.jamb(u0, -dep, 0, Math.min(tops[b - 1], top), Math.max(tops[b - 1], top),
            top > tops[b - 1] ? -1 : +1);
        }
      }
      W.attr('aBldg', bseed, 0, 0, tops[0]);
      f.jamb(0, -dep, 0, -3, tops[0], -1);
      W.attr('aBldg', bseed, 0, 0, tops[bays - 1]);
      f.jamb(w, -dep, 0, -3, tops[bays - 1], +1);

      /* Roof plant. Two or three blocks of it, and their only job is to put
       * something above the parapet line so the silhouette is not a step
       * function of one variable. Tank, lift overrun, ductwork — at this range
       * it makes no difference which, only that the outline is not flat. */
      const plant = 1 + Math.floor(rng() * 3);
      for (let q = 0; q < plant; q++) {
        const pu = 0.6 + rng() * Math.max(0.6, w - 2.4);
        const pw = 1.1 + rng() * 2.9;
        const ph = 0.9 + rng() * 3.1;
        const pd = -1.2 - rng() * (dep - 3.0 > 1 ? dep - 3.0 : 1);
        const bay = Math.min(bays - 1, Math.floor((pu / w) * bays));
        // No coping band on plant, so its parapet height is put out of reach.
        W.attr('aBldg', bseed, 0, 0, 1e4);
        f.box(pu, Math.min(w, pu + pw), tops[bay], tops[bay] + ph, pd, pd + 1.0 + rng() * 2.2);
      }
    }
  }
}

/* ── The block ──────────────────────────────────────────────────────────── */

/* The boundary to a gap site, and it is here for one reason: it is the only
 * thing in System 2 whose shadow can reach the carriageway.
 *
 * The review asked for parapet coping, chimney stacks and fire-escape pickets
 * printed across the tarmac, and that is not available at this sun. The
 * arithmetic is short. A point h metres up throws its shadow 7.83h metres in
 * -X and 11.15h metres in +Z. The sunward building line is at x = +5.7 and the
 * carriageway ends at x = -3.5, so a caster on that frontage lands on the road
 * only while 7.83h < 9.2 — that is, only while it is under 1.18 m tall.
 * Everything above that clears the road entirely and lands on the wall
 * opposite, which is exactly where the fire-escape lacing already shows up and
 * where the review found it. A parapet at 8 m casts to x = -57. There is no
 * setting of anything that puts it on the road instead.
 *
 * So the shadows a four-degree sun actually draws on a narrow street are the
 * shadows of *short* things — kerbs, steps, bollards, railings — and the way
 * to get a long fractured lacy band across the tarmac is to stand something
 * short and repetitive at the building line. A fenced vacant lot does it
 * honestly: 25 mm pickets at 125 mm centres on a dwarf wall, and each one
 * sweeps a 110 mm stripe nine metres across the road, twelve metres further
 * down the street.
 */
function emitLotFence(f: Face, u0: number, u1: number, base: number): void {
  const L = u1 - u0;
  if (L < 3) return;

  // Dwarf wall, standing where the frontage would have stood.
  f.box(u0, u1, base - 0.35, base + 0.40, -0.34, 0.0);
  f.box(u0 - 0.02, u1 + 0.02, base + 0.40, base + 0.47, -0.37, 0.03);

  // Gate piers, which are what stops the run reading as a fence panel.
  for (const u of [u0 + 0.25, u1 - 0.25]) {
    f.box(u - 0.25, u + 0.25, base - 0.35, base + 1.62, -0.42, 0.08);
    f.box(u - 0.30, u + 0.30, base + 1.62, base + 1.74, -0.47, 0.13);
    f.box(u - 0.16, u + 0.16, base + 1.74, base + 1.90, -0.33, -0.01);
  }
}

/** The steel of the same fence: rails, pickets and their spear heads. */
function emitLotRailing(f: Face, u0: number, u1: number, base: number): void {
  if (u1 - u0 < 3) return;
  const y0 = base + 0.47;
  const yTop = y0 + 0.92;
  const a = u0 + 0.55, b = u1 - 0.55;

  // Two rails. The lower one carries the pickets; the upper one is what makes
  // the shadow read as a fence rather than as a row of separate sticks.
  f.box(a, b, y0 + 0.10, y0 + 0.145, -0.20, -0.16);
  f.box(a, b, yTop - 0.11, yTop - 0.065, -0.20, -0.16);

  const n = Math.max(2, Math.floor((b - a) / 0.125));
  const step = (b - a) / n;
  for (let i = 0; i <= n; i++) {
    const g = h2(i * 1.7, 31.3);
    // Bent, missing and replaced. A hundred and thirty identical pickets throw
    // a hundred and thirty identical stripes, which is a comb rather than a
    // railing; three per cent gone and a millimetre of lean on the rest is
    // what makes the band across the road read as ironwork.
    if (g < 0.032) continue;
    const u = a + i * step + (h2(i * 3.1, 7.9) - 0.5) * 0.012;
    const lean = (h2(i * 5.3, 19.1) - 0.5) * 0.020;
    f.box(u - 0.013, u + 0.013, y0, yTop, -0.196, -0.170);
    if (Math.abs(lean) > 0.007) f.box(u - 0.013 + lean, u + 0.013 + lean, yTop - 0.22, yTop, -0.196, -0.170);
    // Spear head: two tapers would be nicer, two boxes are enough at the size
    // this is ever seen, and the shadow only knows the silhouette anyway.
    f.box(u - 0.024, u + 0.024, yTop, yTop + 0.035, -0.202, -0.164);
    f.box(u - 0.010, u + 0.010, yTop + 0.035, yTop + 0.115, -0.190, -0.176);
  }
}

export function buildCity(): CityGeometry {
  const W = new Emit({ aGrid: 4, aWin: 4, aBldg: 4, aRole: 1 });
  const G = new Emit({ aPane: 4 });
  const T = new Emit({ aTrim: 2 });
  const M = new Emit({ aMetal: 2 });

  const { bldgs, gaps } = layoutBlock((x, z) => walkHeight(x, z));
  for (const b of bldgs) emitBuilding(b, W, G, T, M);

  /* Only the vacant lot, not the cross streets. A cross street is a road and
   * fencing it off would be absurd; a gap site between two party walls is
   * always hoarded or railed, and it is the one that is placed to throw its
   * shadow across the stretch of carriageway the walk actually looks at. */
  const B = 5.7;
  for (const g of gaps) {
    if (g.side < 0 || g.z1 - g.z0 > 20 || g.z1 - g.z0 < 8) continue;
    const fr = frame(B, 22, 0, -1);
    const base = walkHeight(B, (g.z0 + g.z1) * 0.5);
    W.attr('aGrid', 3.0, 3.2, 0.25, base + 6);
    W.attr('aWin', 1.2, 0.9, 0, 20);
    W.attr('aBldg', 0.31, 2, base, base + 2);
    W.attr('aRole', ROLE.STONE);
    emitLotFence(new Face(W, fr), 22 - g.z1, 22 - g.z0, base);
    M.attr('aMetal', 0.61, 0);
    emitLotRailing(new Face(M, fr), 22 - g.z1, 22 - g.z0, base);
  }

  emitBackdrop(W);

  const wall = W.geometry(), glass = G.geometry();
  const trim = T.geometry(), metal = M.geometry();
  const triangles = W.triangleCount + G.triangleCount + T.triangleCount + M.triangleCount;

  return {
    wall, glass, trim, metal, triangles,
    dispose() { wall.dispose(); glass.dispose(); trim.dispose(); metal.dispose(); },
  };
}

export type { Frame };
