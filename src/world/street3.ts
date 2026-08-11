/* System 3: street level.
 *
 * Everything between the plinth and the fascia on the two rows the camera
 * walks between, plus the things standing on the footway in front of them:
 * shopfronts, roller shutters, awnings, a dumpster and its bags, a fire
 * hydrant and the signage.
 *
 * Three rules govern the whole file and they are the same three that got
 * System 2 through review.
 *
 * Real dimensions, always. A stall riser is 460-700 mm because that is what a
 * stall riser is; a fascia is 400-550 mm deep; a hydrant stands 790 mm to the
 * top of its operating nut; a four-yard commercial bin is 1.83 x 1.22 x 1.30 m.
 * Absolute scale is most of what makes a street read as photographed, and it
 * is the one thing that cannot be recovered later by grading.
 *
 * Irregularity is the subject, not a garnish. A row of identical shopfronts is
 * the fastest possible way to look like a render, and the reason real ones are
 * never identical is that they were fitted out in different decades by
 * different people who each only cared about their own twenty feet of
 * frontage. So unit widths, riser heights, transom heights, fascia depths,
 * paint, shutter state, awning sag and dirt are all independent draws, and the
 * shop *type* changes every unit or two.
 *
 * And relief stays out of the normals. At 4.2 degrees a normal perturbation of
 * any size swings N.L violently between adjacent pixels — the pavement was
 * blown into a bed of white granules that way — so shutter corrugation, tiling
 * and fabric weave are carried in albedo, with only a token slope gated by
 * pixel footprint. Anything that genuinely has to catch a shadow is modelled.
 *
 * The lit shopfronts are geometry, material and emissive surfaces only. The
 * light source that spills their glow onto the footway is System 5's, and the
 * interface it picks up is SHOP_LIGHTS at the bottom of this file.
 */
import * as THREE from 'three';
import { Emit, Face, frame, type Frame } from './emit';
import { layoutBlock, type Bldg } from './block';
import { groundLevels, groundOpenings } from './facade';
import { walkHeight } from './geometry';
import { DIMS } from './dims';

/* ── Material part codes ────────────────────────────────────────────────── */

/** Branches in the shopfront joinery shader. */
export const SHOP = {
  RISER: 0,     // the stall riser under the glazing: painted board or tile
  STONE: 1,     // cills, thresholds, pilaster bases — pale cast stone
  JOINERY: 2,   // frames, stiles, mullions, transom bars, door leaves
  PILASTER: 3,  // the rendered shaft framing a unit
  FASCIA: 4,    // the sign board
  INTERIOR: 5,  // the walls, floor and ceiling of the room behind the glass
  FITTING: 6,   // shelving and counters inside it
} as const;

/** Branches in the roller shutter shader. */
export const SHUT = {
  CURTAIN: 0,   // the corrugated lath curtain
  CASE: 1,      // housing, guides, bottom rail
  LOCK: 2,      // lock box and ground bolts
} as const;

/** Branches in the awning shader. */
export const AWN = {
  FABRIC: 0,
  VALANCE: 1,
  FRAME: 2,
} as const;

/** Branches in the footway furniture shader. */
export const FURN = {
  HYDRANT: 0,
  BIN: 1,
  BIN_LID: 2,
  BAG: 3,
  POST: 4,
  SIGN_STREET: 5,
  SIGN_REG: 6,
  SIGN_BACK: 7,
  RUBBER: 8,
} as const;

/* ── Hashing ────────────────────────────────────────────────────────────── */

const h2 = (a: number, b: number): number => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
/** h2 mapped onto [lo, hi). */
const hr = (a: number, b: number, lo: number, hi: number) => lo + h2(a, b) * (hi - lo);
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

/* ── Safe winding ───────────────────────────────────────────────────────── */

/** A point in a facade's local frame: (u along the wall, y world, d outward). */
type L3 = [number, number, number];

/**
 * Cross product expressed in the local (u, y, d) basis.
 *
 * That basis is LEFT handed. emit.ts derives the outward normal as
 * `up x uDir`, which makes the cyclic order (y, u, d) rather than (u, y, d),
 * so the componentwise cross product of two local vectors comes out negated
 * relative to the world vector it stands for. Getting this wrong does not
 * produce a visible error: it produces geometry that is built perfectly and is
 * invisible, in the beauty pass and in the shadow pass alike, which has
 * already cost this project twice — once in buildRoadGeometry and once in a
 * stair stringer. Every free-form face below goes through `facet` so that it
 * cannot happen a third time.
 */
function lcross(e: L3, f: L3): L3 {
  return [e[2] * f[1] - e[1] * f[2], e[0] * f[2] - e[2] * f[0], e[1] * f[0] - e[0] * f[1]];
}

/** A quad wound so that its normal points along `out`, whichever order it came in. */
function facet(fa: Face, a: L3, b: L3, c: L3, d: L3, out: L3): void {
  const e: L3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const g: L3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = lcross(e, g);
  const uv = (p: L3): [number, number] => [p[0], p[1]];
  if (n[0] * out[0] + n[1] * out[1] + n[2] * out[2] >= 0) {
    fa.quadFree(a, b, c, d, [uv(a), uv(b), uv(c), uv(d)]);
  } else {
    fa.quadFree(a, d, c, b, [uv(a), uv(d), uv(c), uv(b)]);
  }
}

/**
 * An n-sided prism swept along d rather than along u.
 *
 * `Face.bar` sweeps a (y, d) section along u, which covers anything lying
 * along the wall. A hydrant's steamer nozzle points at the street, so it needs
 * the other one.
 */
function nozzle(
  fa: Face, uc: number, yc: number, d0: number, d1: number, r: number, sides = 8,
): void {
  const pt = (i: number, d: number): L3 => {
    const a = (i / sides) * Math.PI * 2;
    return [uc + Math.cos(a) * r, yc + Math.sin(a) * r, d];
  };
  for (let i = 0; i < sides; i++) {
    const a = (i + 0.5) / sides * Math.PI * 2;
    facet(fa, pt(i, d0), pt(i + 1, d0), pt(i + 1, d1), pt(i, d1),
      [Math.cos(a), Math.sin(a), 0]);
  }
  for (let i = 1; i < sides - 1; i++) {
    facet(fa, pt(0, d1), pt(i, d1), pt(i + 1, d1), pt(i + 1, d1), [0, 0, 1]);
  }
}

/**
 * A sagging closed lump: a bin bag.
 *
 * A filled polythene sack is the one object here with no straight edge on it,
 * and that is exactly why it is worth the triangles — a pile of them beside a
 * skip is unmistakable, and nothing else in the scene has that silhouette. It
 * is a squashed ellipsoid with the poles cut off and a per-vertex radial
 * wobble, so no two are alike and none of them is symmetrical.
 */
function bag(
  fa: Face, uc: number, yBase: number, dc: number,
  rU: number, hgt: number, rD: number, seed: number,
  rings = 5, segs = 9,
): void {
  const T0 = 0.20, T1 = 0.94;             // poles trimmed, so no degenerate quads
  const yc = yBase + hgt * 0.5;
  const wob = (i: number, j: number) => {
    const t = i / rings;
    // Heavier low down: a full sack spreads where it meets the ground.
    return 0.82 + 0.34 * h2(seed * 7.3 + i * 3.1, (j % segs) * 5.7)
         + 0.20 * t * t;
  };
  const pt = (i: number, j: number): L3 => {
    const th = Math.PI * (T0 + (T1 - T0) * (i / rings));
    const ph = (j / segs) * Math.PI * 2;
    const k = wob(i, j);
    const st = Math.sin(th);
    return [
      uc + rU * k * st * Math.cos(ph),
      yc + hgt * 0.5 * Math.cos(th) * (k * 0.35 + 0.65),
      dc + rD * k * st * Math.sin(ph),
    ];
  };
  const out = (p: L3): L3 => [p[0] - uc, (p[1] - yc) * 0.6, p[2] - dc];
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segs; j++) {
      const a = pt(i, j), b = pt(i, j + 1), c = pt(i + 1, j + 1), d = pt(i + 1, j);
      facet(fa, a, b, c, d, out([
        (a[0] + c[0]) * 0.5, (a[1] + c[1]) * 0.5, (a[2] + c[2]) * 0.5,
      ]));
    }
  }
  // Caps, fanned. The top one is where the neck is gathered and tied.
  const top: L3 = [uc, yc + hgt * 0.52, dc];
  const bot: L3 = [uc, yBase + 0.005, dc];
  for (let j = 0; j < segs; j++) {
    const a = pt(0, j), b = pt(0, j + 1);
    facet(fa, top, a, b, b, [0, 1, 0]);
    const c = pt(rings, j), e = pt(rings, j + 1);
    facet(fa, bot, c, e, e, [0, -1, 0]);
  }
  // The knot: 70 mm of gathered neck, which is what identifies it as a sack
  // rather than as a boulder.
  fa.tube(uc, dc, 0.035, yc + hgt * 0.50, yc + hgt * 0.50 + 0.075, 6);
}

/**
 * A flat sign plate, face and back emitted separately.
 *
 * Split rather than boxed because the face carries a graphic that has to be
 * addressed in its own normalised coordinates, and `Face.box` gives the jambs
 * and decks a uv of (u + d, y) which would put the lettering on the edges.
 * The 12 mm rim is emitted too: two opposite quads with an open gap between
 * them show daylight through the sign the moment it is seen edge on.
 */
function plate(
  fa: Face, E: Emit, u0: number, u1: number, y0: number, y1: number,
  d0: number, d1: number, kind: number, seed: number,
): void {
  E.attr('aRect', u0, y0, u1 - u0, y1 - y0);
  E.attr('aKind', kind, seed);
  fa.panel(u0, u1, y0, y1, d1);
  E.attr('aKind', FURN.SIGN_BACK, seed);
  fa.panelIn(u0, u1, y0, y1, d0);
  fa.jamb(u1, d0, d1, y0, y1, +1);
  fa.jamb(u0, d0, d1, y0, y1, -1);
  fa.deck(u0, u1, d0, d1, y1, true);
  fa.deck(u0, u1, d0, d1, y0, false);
}

/* ── Shop units ─────────────────────────────────────────────────────────── */

/* What is behind the glass, and it is the single most useful axis of variation
 * on the whole street.
 *
 * A parade of shops is never a parade of shops. It is two or three trading, a
 * couple shuttered because it is the wrong hour or the wrong decade, one that
 * has been empty long enough for the agent's board to fade, and a door with
 * eight bells on it that goes to the flats above. Reading the shutters against
 * the lit ones is most of what tells you what time it is. */
export const enum UnitType {
  /** Trading, unlit: dark plate glass over a dim interior. */
  GLAZED = 0,
  /** A convenience store or a bar with the lights on. System 5's spill. */
  LIT = 1,
  /** Roller shutter fully down. */
  SHUTTERED = 2,
  /** Roller shutter part raised — the state that says somebody is here. */
  PART = 3,
  /** Empty: whitewashed glass, no sign, nothing inside. */
  VACANT = 4,
  /** Not a shop at all: the entrance to the flats above. */
  ENTRANCE = 5,
}

type Opening = { u0: number; u1: number; rec: number };

type Unit = {
  b: Bldg;
  bays: Opening[];
  /** Unit extent along the facade, piers included. */
  u0: number; u1: number;
  type: UnitType;
  seed: number;
  /** World position of the unit centre, for placement decisions. */
  x: number; z: number;
  /** True on the row whose elevation faces -X. */
  east: boolean;
  awning: boolean;
};

/**
 * Deliberate placements, snapped to whichever unit is nearest.
 *
 * Hashing the type off the unit seed alone gives a plausible distribution and
 * no control at all over what is in shot, and what is in shot is the only part
 * that exists. dims.ts already learned this the expensive way with the
 * ironwork: every fixture was rendering correctly and none of them appeared in
 * any of the six frames, because they had been scattered rather than aimed.
 *
 * The capture stops are at z = 2, -15.6, -35.2, -54.8, -74.4 and -89.1. A
 * 45-degree lens on a camera that walks at x = -0.85 puts an object on the far
 * footway in frame from about seven metres ahead and at a useful size out to
 * twenty, so each entry below sits 9-16 m in front of a stop.
 */
const FORCED: { east: boolean; z: number; type: UnitType }[] = [
  /* The lit convenience store, ten metres in front of stop two on the near
   * footway. It goes on the west row and it goes here for a lighting reason
   * rather than a compositional one: the sunward gap in the east frontage runs
   * from -64 to -40 and throws its shaft across the road between -49 and -32,
   * so anything at -26 is in the frontage's own shadow all the way up. A lit
   * window in direct sun is not lit, it is a window. */
  { east: false, z: -26.0, type: UnitType.LIT },
  /* The bar, on the far row and fifteen metres in front of stop four, so that
   * the two lit units are never both in the same frame at the same size. */
  { east: true, z: -70.0, type: UnitType.LIT },
  /* Shutters where they will be read against something lit. */
  { east: false, z: -12.5, type: UnitType.SHUTTERED },
  { east: false, z: -47.0, type: UnitType.SHUTTERED },
  { east: true, z: -30.0, type: UnitType.PART },
  { east: false, z: -85.0, type: UnitType.SHUTTERED },
  /* One empty unit, at the end of the walk where the block is thinning out
   * anyway. */
  { east: false, z: -95.0, type: UnitType.VACANT },
];

/** Awnings, placed the same way and for the same reason. */
const AWNING_AT: { east: boolean; z: number }[] = [
  { east: false, z: -11.0 },
  /* In the shaft. The sun band on the carriageway runs -49 to -32 and the west
   * elevation catches the low end of it, so this one is the only piece of
   * fabric in the scene with direct light on it: it will throw a hard shadow
   * across the footway and glow through where it is thin. It is nine metres in
   * front of stop three, which is also the tilted frame. */
  { east: false, z: -44.0 },
  { east: true, z: -66.0 },
  { east: false, z: -78.5 },
];

/** Split a building's openings into trading units of one to three bays. */
function unitsOf(b: Bldg, east: boolean): Unit[] {
  const holes = groundOpenings(b);
  const out: Unit[] = [];
  let i = 0;
  let k = 0;
  while (i < holes.length) {
    const r = h2(b.seed * 311 + i * 7.3, 4.1);
    /* One bay is a newsagent, three is a bank. Two is the commonest thing on a
     * street like this and a run of three single-bay units in a row is what
     * makes a frontage read as a shelf of boxes, so the draw leans on two. */
    let n = r < 0.34 ? 1 : r < 0.80 ? 2 : 3;
    n = Math.min(n, holes.length - i);
    const bays = holes.slice(i, i + n);
    const u0 = i === 0 ? 0 : (holes[i - 1].u1 + bays[0].u0) * 0.5;
    const u1 = i + n >= holes.length ? b.L : (bays[n - 1].u1 + holes[i + n].u0) * 0.5;
    const uc = (bays[0].u0 + bays[n - 1].u1) * 0.5;
    const { ox, oz, ux, uz } = b.frame;
    out.push({
      b, bays, u0, u1,
      type: UnitType.GLAZED,
      seed: h2(b.seed * 97 + k * 13.7, 2.9),
      x: ox + ux * uc, z: oz + uz * uc,
      east, awning: false,
    });
    i += n;
    k++;
  }
  return out;
}

/**
 * Type every unit: the deliberate ones first, then the rest by hash.
 *
 * The general distribution is roughly a third shuttered, which sounds high and
 * is what an ordinary secondary shopping street looks like at any hour outside
 * ten to five. The far end of the block is shuttered harder than the near end,
 * because the far end is where the eye reads pattern rather than detail and a
 * long run of corrugation is the cheapest legible thing there is at forty
 * metres.
 */
function assignTypes(units: Unit[]): void {
  const claimed = new Set<Unit>();
  const nearest = (east: boolean, z: number): Unit | null => {
    let best: Unit | null = null, bd = 1e9;
    for (const u of units) {
      if (u.east !== east || claimed.has(u)) continue;
      const d = Math.abs(u.z - z);
      if (d < bd) { bd = d; best = u; }
    }
    return bd < 9 ? best : null;
  };

  for (const f of FORCED) {
    const u = nearest(f.east, f.z);
    if (u) { u.type = f.type; claimed.add(u); }
  }
  for (const a of AWNING_AT) {
    const u = nearest(a.east, a.z);
    if (!u) continue;
    u.awning = true;
    /* An awning over a shuttered unit is possible and it is also a waste: the
     * point of putting fabric out is that it catches light and drops a shadow
     * onto something worth seeing, and a closed shutter is neither. */
    if (u.type === UnitType.SHUTTERED || u.type === UnitType.VACANT) u.type = UnitType.GLAZED;
    claimed.add(u);
  }

  for (const u of units) {
    if (claimed.has(u)) continue;
    const r = h2(u.seed * 53.1, u.z * 0.37);
    const far = Math.max(0, Math.min(1, (-u.z - 45) / 55));
    const shutterOdds = 0.26 + far * 0.26;
    u.type = r < shutterOdds ? UnitType.SHUTTERED
      : r < shutterOdds + 0.06 ? UnitType.PART
      : r < shutterOdds + 0.13 ? UnitType.VACANT
      : r < shutterOdds + 0.24 ? UnitType.ENTRANCE
      : UnitType.GLAZED;
    /* Awnings on a minority of the units that are open, and never two in a
     * row: a continuous run of fabric is a covered market, not a street. */
    if (u.type === UnitType.GLAZED && h2(u.seed * 17.7, 9.3) > 0.84) u.awning = true;
  }
  for (let i = 1; i < units.length; i++) {
    if (units[i].awning && units[i - 1].awning && units[i].b === units[i - 1].b) {
      units[i].awning = false;
    }
  }
}

/* ── Emission context ───────────────────────────────────────────────────── */

type Ctx = {
  S: Emit; G: Emit; R: Emit; A: Emit;
  sf: Face; gf: Face; rf: Face; af: Face;
  /** Where this building meets the footway, and which way it faces. */
  baseY: number; nx: number;
};

/**
 * Set both shopfront attributes at once.
 *
 * `Emit.attr` is sticky — a value rides along on every vertex until it is set
 * again — which suits facade work and is a trap for a second attribute that
 * only some parts use: forget it once and a fascia inherits the previous
 * unit's interior depth. Setting the pair together is the only way to be sure.
 *
 * aux0 and aux1 are overloaded by part, and deliberately so rather than
 * spending two more float attributes on the whole buffer:
 *   FASCIA    the bottom and top of the board, for the signwritten band
 *   INTERIOR  the world x of the aperture and the row's outward normal x,
 *             which together give the fragment its depth into the room
 *   others    unused
 */
function sa(
  c: Ctx, un: Unit, part: number, lit = 0,
  aux0 = 0, aux1 = 0, aux2 = 0, aux3 = 0,
): void {
  c.S.attr('aShop', un.seed, part, c.baseY, lit);
  c.S.attr('aShop2', aux0, aux1, aux2, aux3);
}

/* ── The room behind the glass ──────────────────────────────────────────── */

/*
 * NOTES.md has carried "shopfront glazing depth" as deferred material work
 * since System 1, and this is the answer to it. A shop window with a flat
 * panel behind it is a mirror with a dark card in it, and no amount of
 * reflection tuning fixes that, because what the eye is actually reading is
 * parallax: the back wall of a shop is two metres behind the pane and it moves
 * relative to the mullions as you walk past. That motion is the whole cue.
 *
 * So the room is real: floor, ceiling, back wall, two returns, and enough
 * fitting-out in the near half of the street to have something for the
 * parallax to act on. It is cheap because it is five quads, and it is what
 * lets the lit units be lit by putting an emissive surface at a real depth
 * instead of painting a glow onto the glass.
 */
function emitRoom(c: Ctx, un: Unit, o: Opening, lit: number): void {
  const { sf } = c;
  const b = un.b;
  const { plinthTop, openTop } = groundLevels(b);
  const d = b.d0;
  const dI = d - o.rec;
  const depth = 1.95 + h2(un.seed * 31.1, o.u0) * 0.85;
  const dBack = dI - depth;
  const floorY = b.base + 0.03;
  const ceilY = openTop - 0.06;
  /* Both rows run along z with their normals on x, so the aperture is a plane
   * of constant world x and the fragment's depth into the room is one
   * subtraction and a sign. */
  const apX = b.frame.ox + b.frame.nx * dI;

  sa(c, un, SHOP.INTERIOR, lit, apX, c.nx);
  sf.deck(o.u0, o.u1, dBack, dI, floorY, true);
  sf.deck(o.u0, o.u1, dBack, dI, ceilY, false);
  sf.panel(o.u0, o.u1, floorY, ceilY, dBack);
  sf.jamb(o.u0, dBack, dI, floorY, ceilY, +1);
  sf.jamb(o.u1, dBack, dI, floorY, ceilY, -1);
  // The inside of the plinth, below the stall riser. One quad, and without it
  // the room is open to daylight along its whole front edge from a low camera.
  sf.panelIn(o.u0, o.u1, floorY, plinthTop, dI);

  /* Fitting out, in the near half of the walk only.
   *
   * Beyond about sixty metres a gondola end is four pixels behind a reflective
   * pane and contributes nothing but triangles and a chance of aliasing, which
   * is the same trade the backdrop masses lost in System 2. */
  if (un.z < -62) return;

  const w = o.u1 - o.u0;
  sa(c, un, SHOP.FITTING, lit, apX, c.nx);
  const racks = w > 2.3 ? 2 : 1;
  for (let i = 0; i < racks; i++) {
    const cu = o.u0 + w * ((i + 0.5) / racks);
    const rw = Math.min(1.05, w / racks - 0.35) * 0.5;
    const rh = 1.55 + h2(un.seed * 3.3, i) * 0.42;
    const dr = dBack + 0.06;
    /* Uprights, and they are wider than the 25 mm a real gondola end has.
     *
     * At 50 mm they were being drawn and were invisible, because the shelves
     * beside them were up-facing and the uprights were not, and the canyon
     * fill was worth seven times as much to a horizontal surface as to a
     * vertical one. That is fixed in the shader now, but the section was still
     * too slight to carry a silhouette through a pane at ten metres, and the
     * rack has to read as a piece of furniture rather than as four lines. */
    sf.box(cu - rw, cu - rw + 0.09, floorY, floorY + rh, dr, dr + 0.38);
    sf.box(cu + rw - 0.09, cu + rw, floorY, floorY + rh, dr, dr + 0.38);
    // The back board they are screwed to, which closes the silhouette.
    sf.box(cu - rw, cu + rw, floorY, floorY + rh, dr, dr + 0.055);
    /* The shelves themselves, and they are the part that matters: four
     * horizontal lines at 400 mm centres behind a pane is a shop, and one dark
     * box is a cupboard. */
    for (let k = 0; k < 4; k++) {
      const y = floorY + 0.28 + k * (rh - 0.34) / 3.4;
      sf.box(cu - rw, cu + rw, y, y + 0.035, dr, dr + 0.36);
    }
  }
  // The counter, set to one side and turned a little off square.
  const cu2 = o.u0 + w * (h2(un.seed, 7.1) < 0.5 ? 0.26 : 0.74);
  sf.box(cu2 - 0.52, cu2 + 0.52, floorY, floorY + 0.94, dI - 0.95, dI - 0.35);
}

/* ── The shopfront proper ───────────────────────────────────────────────── */

function emitShopfront(c: Ctx, un: Unit): void {
  const { S, G, sf, gf } = c;
  const b = un.b;
  const { plinthTop, openTop } = groundLevels(b);
  const d = b.d0;
  /* 0 unlit, 1 the convenience store, 2 the bar. The two lit units want
   * different interiors — fluorescent white against a wall of stacked stock,
   * versus tungsten and a back bar — and the distinction has to travel with
   * the geometry rather than sit in a uniform, since one material draws both. */
  const lit = un.type === UnitType.LIT ? (un.east ? 2 : 1) : 0;
  const shuttered = un.type === UnitType.SHUTTERED || un.type === UnitType.PART;

  /* The stall riser, and its height is the first thing a shopfitter chose.
   *
   * 460 mm on a Victorian frontage, 700 on a nineteen-thirties one, and the
   * two look completely different because it is the line the eye reads across
   * the whole frontage. Varying it unit by unit is the cheapest irregularity
   * in the file. */
  const riserH = hr(un.seed * 41.3, 2.7, 0.46, 0.72);
  const riserTop = Math.max(plinthTop + 0.06, b.base + riserH);
  /* The transom. Head height on a shopfront is remarkably consistent — around
   * 2.1 to 2.5 m, because it is set by the door under it — while the head of
   * the masonry opening above it is anything from 2.9 to 4.1 m. The gap
   * between the two is the transom light, and its varying depth is most of
   * what stops the fascia line reading as a ruler. */
  const headY = openTop - (shuttered ? 0.34 : 0.05);
  const transomY = clamp(b.base + hr(un.seed * 7.7, 5.5, 2.12, 2.52),
    riserTop + 0.9, headY - 0.22);

  // Which bay of the unit has the door in it, and whether it is recessed.
  const doorBay = Math.floor(h2(un.seed * 19.1, 3.7) * un.bays.length);
  const recessed = h2(un.seed * 23.3, 8.8) > 0.42;

  for (let i = 0; i < un.bays.length; i++) {
    const o = un.bays[i];
    const dI = d - o.rec;
    const dS = dI + 0.055;          // the face of the shopfront joinery
    const w = o.u1 - o.u0;
    const st = 0.075;               // stile section

    emitRoom(c, un, o, lit);

    /* Stall riser and its cill. The cill is cast stone with a nose on it,
     * because the whole reason a shopfront has one is to throw the water off
     * the riser rather than let it run down and rot the boarding. */
    sa(c, un, SHOP.RISER);
    sf.box(o.u0, o.u1, plinthTop, riserTop, dI, dS);
    sa(c, un, SHOP.STONE);
    sf.box(o.u0 - 0.015, o.u1 + 0.015, riserTop, riserTop + 0.048, dI, dS + 0.036);

    const glassY0 = riserTop + 0.048;
    const isDoor = i === doorBay && un.type !== UnitType.VACANT;

    sa(c, un, SHOP.JOINERY);
    // Stiles either side and the head rail under the transom.
    sf.box(o.u0, o.u0 + st, glassY0, headY, dI, dS);
    sf.box(o.u1 - st, o.u1, glassY0, headY, dI, dS);
    sf.box(o.u0, o.u1, transomY, transomY + 0.075, dI, dS + 0.012);
    sf.box(o.u0, o.u1, headY - 0.06, headY, dI, dS);

    if (isDoor && un.type === UnitType.ENTRANCE) {
      emitEntranceDoor(c, un, o, dI, dS, glassY0, transomY);
    } else if (isDoor) {
      emitShopDoor(c, un, o, dI, dS, riserTop, transomY, recessed, lit);
    } else {
      /* Plate glass, divided by mullions. A single sheet three metres wide is
       * a nineteen-eighties refit and it does happen, but two or three lights
       * with a slim mullion between them is what most of a street like this
       * has, and the mullions are what give the reflection something to break
       * against. */
      const lights = w > 2.6 ? 3 : w > 1.8 ? 2 : 1;
      const inner0 = o.u0 + st, inner1 = o.u1 - st;
      for (let k = 1; k < lights; k++) {
        const mu = inner0 + (inner1 - inner0) * (k / lights);
        sa(c, un, SHOP.JOINERY);
        sf.box(mu - 0.028, mu + 0.028, glassY0, transomY, dI, dS);
      }
      for (let k = 0; k < lights; k++) {
        const a = inner0 + (inner1 - inner0) * (k / lights) + (k ? 0.028 : 0);
        const z = inner0 + (inner1 - inner0) * ((k + 1) / lights) - (k < lights - 1 ? 0.028 : 0);
        emitPane(c, un, a, z, glassY0, transomY, dI + 0.030, k * 3.1, lit);
      }
    }

    /* The transom light over everything, which is where the shop's name used
     * to be painted and where the extract grille is now. */
    if (headY - transomY > 0.26) {
      const ty0 = transomY + 0.075, ty1 = headY - 0.06;
      const bars = Math.max(1, Math.round(w / 0.62));
      sa(c, un, SHOP.JOINERY);
      for (let k = 1; k < bars; k++) {
        const mu = o.u0 + st + (w - st * 2) * (k / bars);
        sf.box(mu - 0.018, mu + 0.018, ty0, ty1, dI, dS);
      }
      emitPane(c, un, o.u0 + st, o.u1 - st, ty0, ty1, dI + 0.030, 17.3, lit);
    }

    if (shuttered) emitShutter(c, un, o, dI, plinthTop, openTop, i);
  }

  emitPilasters(c, un, riserTop);
  emitFascia(c, un);
  if (un.awning) emitAwning(c, un, openTop);
  void G; void gf; void S;
}

/** One sheet of glass. */
function emitPane(
  c: Ctx, un: Unit, u0: number, u1: number, y0: number, y1: number,
  dp: number, key: number, lit: number,
): void {
  const { G, gf } = c;
  /* A whitewashed window is the signature of an empty unit and it is a
   * different surface entirely: opaque, matt and pale, with the brush marks
   * showing. It is passed through as a fourth channel rather than skipped,
   * because the pane is still there — it is the paint that is new. */
  const wash = un.type === UnitType.VACANT ? 1 : 0;
  /* The fourth slot is the pane's own bottom edge in world height, not its
   * size: every grime effect on glass is measured up from where the water
   * stops, and a pane does not know how tall it is once it is a fragment. */
  G.attr('aGlass', un.seed * 97 + key, lit, wash, y0);
  gf.panel(u0, u1, y0, y1, dp);
}

/** A shop door, optionally in a recessed lobby. */
function emitShopDoor(
  c: Ctx, un: Unit, o: Opening, dI: number, dS: number,
  riserTop: number, transomY: number, recessed: boolean, lit: number,
): void {
  const { sf } = c;
  const b = un.b;
  const uc = (o.u0 + o.u1) * 0.5;
  /* 860 mm clear, which is a real shop door, and the leaf is 2.05 m tall. Both
   * matter more than they look: the door is the only object on the elevation
   * whose size the viewer knows without being told, so it is what every other
   * dimension in the frame is silently measured against. */
  const hw = 0.43;
  const doorTop = Math.min(transomY - 0.06, b.base + 2.09);
  const floorY = b.base + 0.03;
  /* The recess is 380 mm, not the 600-900 a department store has. On a
   * two-bay unit anything deeper eats the whole shop window, and at this sun
   * angle what the recess is for is the wedge of hard shadow down one side of
   * it, which 380 mm delivers in full. */
  const rd = recessed ? 0.38 : 0.0;
  const dDoor = dI - rd;

  if (recessed) {
    // The returns into the lobby, glazed on one side and panelled on the other
    // the way almost all of them are.
    sa(c, un, SHOP.JOINERY);
    sf.jamb(uc - hw - 0.06, dDoor, dI, riserTop, transomY, +1);
    sf.jamb(uc + hw + 0.06, dDoor, dI, riserTop, transomY, -1);
    sf.deck(uc - hw - 0.06, uc + hw + 0.06, dDoor, dI, transomY, false);
    sa(c, un, SHOP.STONE);
    // The lobby floor: a tiled or terrazzo threshold, worn hollow in the
    // middle by a century of feet. Geometry cannot show the hollow; the
    // material does.
    sf.deck(uc - hw - 0.06, uc + hw + 0.06, dDoor, dI, floorY + 0.012, true);
    // Side panels between the riser and the ground, closing the lobby sides.
    sa(c, un, SHOP.RISER);
    sf.jamb(uc - hw - 0.06, dDoor, dI, floorY, riserTop, +1);
    sf.jamb(uc + hw + 0.06, dDoor, dI, floorY, riserTop, -1);
    // And the stall riser returns forward to meet the pavement either side.
    sf.box(o.u0, uc - hw - 0.06, floorY, riserTop, dDoor, dI);
    sf.box(uc + hw + 0.06, o.u1, floorY, riserTop, dDoor, dI);
  }

  sa(c, un, SHOP.JOINERY);
  // Frame, leaf rails and stiles.
  sf.box(uc - hw - 0.055, uc - hw, floorY, doorTop + 0.055, dDoor, dDoor + 0.05);
  sf.box(uc + hw, uc + hw + 0.055, floorY, doorTop + 0.055, dDoor, dDoor + 0.05);
  sf.box(uc - hw - 0.055, uc + hw + 0.055, doorTop, doorTop + 0.055, dDoor, dDoor + 0.05);
  const dD = dDoor + 0.018;
  sf.box(uc - hw, uc + hw, floorY, floorY + 0.30, dD, dD + 0.042);      // bottom rail
  sf.box(uc - hw, uc + hw, doorTop - 0.11, doorTop, dD, dD + 0.042);    // top rail
  sf.box(uc - hw, uc - hw + 0.075, floorY, doorTop, dD, dD + 0.042);
  sf.box(uc + hw - 0.075, uc + hw, floorY, doorTop, dD, dD + 0.042);
  // Mid rail at push-bar height, which is where every shop door has one.
  sf.box(uc - hw, uc + hw, floorY + 0.94, floorY + 1.03, dD, dD + 0.042);
  // The pull handle: a vertical bar on standoffs, and it is the one thing at
  // eye level with a hard highlight on it.
  const hu = uc + hw - 0.20;
  sf.box(hu - 0.016, hu + 0.016, floorY + 0.86, floorY + 1.42, dD + 0.076, dD + 0.108);
  sf.box(hu - 0.014, hu + 0.014, floorY + 0.88, floorY + 0.94, dD + 0.042, dD + 0.080);
  sf.box(hu - 0.014, hu + 0.014, floorY + 1.34, floorY + 1.40, dD + 0.042, dD + 0.080);
  // Kick plate.
  sa(c, un, SHOP.STONE);
  sf.box(uc - hw + 0.075, uc + hw - 0.075, floorY + 0.02, floorY + 0.29, dD + 0.042, dD + 0.048);

  // The two glazed panels of the leaf.
  emitPane(c, un, uc - hw + 0.075, uc + hw - 0.075, floorY + 0.30, floorY + 0.94, dD + 0.020, 41.7, lit);
  emitPane(c, un, uc - hw + 0.075, uc + hw - 0.075, floorY + 1.03, doorTop - 0.11, dD + 0.020, 43.9, lit);
  // Glazing beside the door, filling the rest of the bay.
  if (uc - hw - 0.055 - o.u0 > 0.30) {
    emitPane(c, un, o.u0 + 0.075, uc - hw - 0.055, riserTop + 0.048, transomY, dI + 0.030, 47.1, lit);
  }
  if (o.u1 - (uc + hw + 0.055) > 0.30) {
    emitPane(c, un, uc + hw + 0.055, o.u1 - 0.075, riserTop + 0.048, transomY, dI + 0.030, 53.3, lit);
  }
}

/** The door to the flats above: solid, with a fanlight and a bank of bells. */
function emitEntranceDoor(
  c: Ctx, un: Unit, o: Opening, dI: number, dS: number,
  glassY0: number, transomY: number,
): void {
  const { sf } = c;
  const b = un.b;
  const uc = (o.u0 + o.u1) * 0.5;
  const hw = 0.44;
  const floorY = b.base + 0.03;
  const doorTop = Math.min(transomY - 0.10, b.base + 2.05);

  /* Everything either side is solid, not glazed. A communal entrance in a
   * shopping parade is a 900 mm slot of joinery between two shops and it reads
   * because it is the one bay with no glass in it. */
  sa(c, un, SHOP.RISER);
  sf.box(o.u0, uc - hw - 0.06, floorY, transomY, dI, dS);
  sf.box(uc + hw + 0.06, o.u1, floorY, transomY, dI, dS);

  sa(c, un, SHOP.JOINERY);
  sf.box(uc - hw - 0.06, uc - hw, floorY, doorTop + 0.06, dI, dS);
  sf.box(uc + hw, uc + hw + 0.06, floorY, doorTop + 0.06, dI, dS);
  sf.box(uc - hw - 0.06, uc + hw + 0.06, doorTop, doorTop + 0.06, dI, dS);
  // A four-panel door, expressed as the muntins rather than the panels: two
  // rails and a muntin is three boxes and it casts the right shadow.
  const dD = dI + 0.016;
  sf.box(uc - hw, uc + hw, floorY, doorTop, dD, dD + 0.040);
  sa(c, un, SHOP.STONE);
  for (const y of [floorY + 0.82, floorY + 1.02, doorTop - 0.62]) {
    sf.box(uc - hw + 0.09, uc + hw - 0.09, y, y + 0.055, dD + 0.040, dD + 0.056);
  }
  sf.box(uc - 0.028, uc + 0.028, floorY + 0.09, doorTop - 0.09, dD + 0.040, dD + 0.056);
  // The fanlight over it, and the bell panel beside it.
  sa(c, un, SHOP.JOINERY);
  if (transomY - doorTop > 0.22) {
    emitPane(c, un, uc - hw, uc + hw, doorTop + 0.06, transomY - 0.02, dD, 61.7, 0);
  }
  const bu = uc + hw + 0.14;
  if (bu + 0.10 < o.u1) {
    sf.box(bu, bu + 0.10, floorY + 1.28, floorY + 1.62, dS, dS + 0.026);
  }
  void glassY0;
}

/* ── Pilasters and fascia ───────────────────────────────────────────────── */

/**
 * The pilasters framing a unit.
 *
 * These are the reason a shopping parade reads as a set of separate premises
 * rather than as one long glazed slot with piers in it. They stand proud of
 * the facade plane by 60-90 mm, which at 4.2 degrees is worth roughly a metre
 * of hard vertical shadow thrown along the wall beside each one — and vertical
 * shadow is the only kind this sun draws generously, because the beam travels
 * 1.4 m along a street elevation for every metre it goes into it and barely
 * 0.13 m up.
 */
function emitPilasters(c: Ctx, un: Unit, riserTop: number): void {
  const { sf } = c;
  const b = un.b;
  const { plinthTop, openTop } = groundLevels(b);
  const d = b.d0;
  const w = hr(un.seed * 13.9, 6.1, 0.155, 0.235);
  const proj = hr(un.seed * 29.3, 4.4, 0.058, 0.092);
  const top = openTop + 0.05;

  for (const [uc, side] of [[un.bays[0].u0, -1], [un.bays[un.bays.length - 1].u1, +1]] as const) {
    const a = side < 0 ? uc - w : uc;
    const z = side < 0 ? uc : uc + w;
    // Keep inside the building: a pilaster hanging off the end of a frontage
    // is worse than no pilaster.
    if (a < -0.02 || z > b.L + 0.02) continue;
    sa(c, un, SHOP.PILASTER);
    sf.box(a, z, plinthTop, top, d, d + proj);
    // Base block, taller than it looks necessary because it is what the
    // splash and the scuffing collect on.
    sa(c, un, SHOP.STONE);
    sf.box(a - 0.022, z + 0.022, plinthTop, riserTop + 0.10, d, d + proj + 0.026);
    /* The console at the top, which is the detail that says this is a
     * shopfront and not a strip of render. A moulded bracket is four boxes
     * stepping out under the fascia and it prints a recognisable stepped
     * shadow on the pilaster beneath it. */
    sf.box(a - 0.030, z + 0.030, top - 0.085, top, d, d + proj + 0.052);
    sf.box(a - 0.018, z + 0.018, top - 0.155, top - 0.085, d, d + proj + 0.030);
  }
}

/**
 * The fascia board.
 *
 * 400-550 mm deep, which is the real range, and derived from the masonry
 * opening above rather than chosen: System 2 already decided how much wall it
 * left between the head of the shopfront and the first floor, and a board that
 * does not fill it leaves a strip of brick that reads as a mistake.
 *
 * There is no sign lettering geometry and there is no neon. The board carries
 * a painted signwritten band in its material — a value, not text, because at
 * the ten to forty metres these are ever seen from a letter is two pixels —
 * and System 5 owns anything that emits.
 */
function emitFascia(c: Ctx, un: Unit): void {
  const { sf } = c;
  const b = un.b;
  const { openTop } = groundLevels(b);
  const d = b.d0;
  const originY = b.base + b.gh;

  const u0 = Math.max(0, un.u0 - 0.02);
  const u1 = Math.min(b.L, un.u1 + 0.02);
  if (u1 - u0 < 0.6) return;
  /* Stop clear of the first-floor string course. System 2 puts one at
   * originY - 0.16 on three quarters of the buildings and projects it 55 mm,
   * so a fascia running up to the floor level would pass straight through it. */
  const top = Math.min(originY - 0.20, openTop + 0.55);
  const y0 = openTop + 0.01;
  if (top - y0 < 0.30) return;

  /* A vacant unit keeps its board — the sign of the shop that failed is the
   * last thing anyone takes down, and a sun-bleached one over a whitewashed
   * window says more about the street than bare brick would. The lit slot
   * carries that fade for this part rather than a light state. */
  /* The board also carries its own extent along the frontage, because the
   * signwriting has to be set on the unit rather than on the building. A name
   * laid out on a fixed period along the whole terrace lands wherever it
   * lands, so a board gets the middle of one word, its neighbour gets the gap
   * after it, and the street reads as a run of tick marks with most fascias
   * apparently blank — which is exactly what the review measured. */
  sa(c, un, SHOP.FASCIA, un.type === UnitType.VACANT ? 1 : 0,
     y0, top, u0, u1 - u0);
  sf.box(u0, u1, y0, top, d, d + 0.078);
  /* A cornice over the board, throwing the one horizontal shadow line the
   * ground storey gets. It is only 30 mm of extra projection but the fascia is
   * the top of everything below it, so the line runs the length of the unit. */
  sa(c, un, SHOP.STONE);
  sf.box(u0 - 0.018, u1 + 0.018, top, top + 0.062, d, d + 0.112);
}

/* ── Roller shutters ────────────────────────────────────────────────────── */

/*
 * Corrugated, with a lock box and dirt in the corrugations, per the brief.
 *
 * The corrugation is a 77 mm lath, which is a real single-skin roller shutter
 * profile, and it is carried in albedo with only a token normal slope gated by
 * pixel footprint. That is not a shortcut: a corrugation is exactly the kind
 * of high-frequency relief that a four-degree sun turns into alternating bands
 * of blown white and black, and the pavement has already been destroyed once
 * that way.
 *
 * The curtain is a closed 18 mm box rather than a plane. A plane would need
 * shadowSide FrontSide to cast at all and would still be missing from the
 * shadow pass on the row facing away from the sun; a box is right from every
 * direction and costs six quads.
 */
function emitShutter(
  c: Ctx, un: Unit, o: Opening, dI: number,
  plinthTop: number, openTop: number, bayIndex: number,
): void {
  const { R, rf } = c;
  const b = un.b;
  const d = b.d0;
  const seed = h2(un.seed * 71.3, bayIndex * 4.7);
  const caseH = 0.30;
  const caseTop = openTop - 0.02;
  const caseBot = caseTop - caseH;
  const dCase = Math.min(dI + 0.28, d - 0.012);

  /* The third slot is the paving datum on every part, not just the curtain.
   * Rust climbs a guide rail from the ground in exactly the way it climbs the
   * laths, and a part that reports its own height instead gets a uniform
   * value and comes out evenly rusted end to end, which reads as painted. */
  R.attr('aShut', seed, SHUT.CASE, plinthTop, caseBot);
  // Housing at the head, and the guides down each jamb.
  rf.box(o.u0 + 0.012, o.u1 - 0.012, caseBot, caseTop, dI + 0.01, dCase);
  for (const gu of [o.u0 + 0.014, o.u1 - 0.070]) {
    rf.box(gu, gu + 0.056, plinthTop, caseBot, dI + 0.012, dI + 0.086);
  }

  /* How far down it is. A shutter is not a boolean: half the interest in a
   * parade at this hour is the one that is three quarters up with a light on
   * behind it, and the one that has been down so long the graffiti has faded
   * on it. */
  const drop = un.type === UnitType.PART
    ? hr(seed * 3.1, 9.7, 0.32, 0.68)
    : 1.0;
  const yBot = caseBot - (caseBot - plinthTop) * drop;
  if (caseBot - yBot < 0.10) return;

  R.attr('aShut', seed, SHUT.CURTAIN, plinthTop, yBot);
  rf.box(o.u0 + 0.038, o.u1 - 0.038, yBot + 0.072, caseBot, dI + 0.030, dI + 0.048);
  // The bottom rail is a flat extrusion, not a lath, and it is the one part of
  // a shutter that is always a different value from the rest of it.
  R.attr('aShut', seed, SHUT.CASE, plinthTop, yBot);
  rf.box(o.u0 + 0.030, o.u1 - 0.030, yBot, yBot + 0.072, dI + 0.022, dI + 0.056);

  if (drop < 0.999) return;
  /* Lock box and ground bolts, which only exist when the thing is shut.
   *
   * This is the detail the brief asks for by name and it earns its place: a
   * shutter without one is a corrugated rectangle, and the box, its hasp and
   * the two floor sockets are what make it read as a closed door with somebody
   * responsible for it. */
  const uc = (o.u0 + o.u1) * 0.5;
  R.attr('aShut', seed, SHUT.LOCK, plinthTop, yBot);
  rf.box(uc - 0.095, uc + 0.095, yBot + 0.10, yBot + 0.235, dI + 0.056, dI + 0.098);
  rf.box(uc - 0.030, uc + 0.030, yBot + 0.235, yBot + 0.285, dI + 0.062, dI + 0.090);
  for (const s of [-1, 1]) {
    const bu = uc + s * (o.u1 - o.u0) * 0.30;
    rf.box(bu - 0.035, bu + 0.035, yBot - 0.004, yBot + 0.030, dI + 0.020, dI + 0.062);
  }
}

/* ── Awnings ────────────────────────────────────────────────────────────── */

/*
 * Fabric with a slight sag and dirt streaking, per the brief.
 *
 * The sag is the whole thing. A shop awning modelled as a flat inclined plane
 * is a wedge of card, and what identifies real ones instantly is that the
 * canvas is only held at the arms: it bellies down between them, by 25-45 mm
 * over a 1.3 m bay, and the shadow it drops on the pavement has the same
 * scallop in its edge. That scallop is worth more than any amount of fabric
 * shading, because it is the part that survives at thirty metres.
 *
 * The fabric is a closed shell — a top surface, an underside 10 mm below it,
 * and closed edges — rather than a single-sided sheet. An open sheet has to be
 * given shadowSide FrontSide to cast anything at all, and even then it casts
 * only from whichever row happens to have its front faces turned to the sun:
 * the awnings on the row facing -X would have thrown no shadow whatever. A
 * closed shell is correct from every direction and doubles a very small
 * number of triangles.
 */
function emitAwning(c: Ctx, un: Unit, openTop: number): void {
  const { A, af } = c;
  const b = un.b;
  const d = b.d0;
  const seed = un.seed;

  const u0 = un.bays[0].u0 - 0.05;
  const u1 = un.bays[un.bays.length - 1].u1 + 0.05;
  const span = u1 - u0;
  if (span < 1.2) return;

  /* Projection and drop. 1.15-1.45 m out is a normal shop awning and it has to
   * stay well inside the 2.35 m footway — one that overhangs the kerb is a
   * market stall. The drop is set by headroom at the front bar: 2.1 m clear
   * under the valance is the number every highways department uses, and it is
   * also what stops the awning cutting the shopfront in half in a frame taken
   * from across the road. */
  const proj = hr(seed * 3.7, 1.9, 1.15, 1.45);
  const yWall = openTop - 0.04;
  const yFront = Math.max(b.base + 2.34, yWall - hr(seed * 8.3, 5.1, 0.58, 0.86));
  if (yWall - yFront < 0.30) return;

  const arms = Math.max(2, Math.round(span / 1.30) + 1);
  const nu = Math.max(4, arms * 3);
  const nv = 4;
  const sagA = hr(seed * 11.7, 3.3, 0.022, 0.048);
  const th = 0.010;

  /* Sag between the arms, zero at each one. The arms divide the span into
   * equal bays and the canvas is only stretched over them, so the belly is a
   * half sine within each bay and the front and back edges are pulled tight by
   * the wall rail and the front bar. */
  const sag = (su: number, t: number) => {
    const g = (su - u0) / span * (arms - 1);
    return sagA * Math.sin(Math.PI * (g - Math.floor(g))) * Math.sin(Math.PI * t);
  };
  const P = (iu: number, iv: number, off: number): L3 => {
    const su = u0 + span * (iu / nu);
    const t = iv / nv;
    /* Buried 10 mm into the masonry at the rear rather than standing 20 mm
     * clear of it. The rail an awning hangs on is bolted to the wall and the
     * canvas is dressed over it, so there is no slot there to see through —
     * and at a four-degree sun a 20 mm slot along the whole span was a lit
     * line of daylight above the shopfront, which is a junction fault rather
     * than a cosmetic one. */
    return [su, yWall - (yWall - yFront) * t - sag(su, t) + off, d - 0.01 + (proj + 0.01) * t];
  };

  /* The shader needs the chord parameter, not the plan dimensions: where the
   * dirt goes on a piece of fabric is entirely a function of how far down the
   * slope the water has got, and the two heights are the cheapest way to hand
   * that over — vWPos.y between them is the parameter directly. */
  A.attr('aAwn', seed, AWN.FABRIC, yWall, yFront);
  for (let iu = 0; iu < nu; iu++) {
    for (let iv = 0; iv < nv; iv++) {
      // Top surface, then the underside, wound the other way.
      facet(af, P(iu, iv, 0), P(iu + 1, iv, 0), P(iu + 1, iv + 1, 0), P(iu, iv + 1, 0),
        [0, 1, 0.3]);
      facet(af, P(iu, iv, -th), P(iu + 1, iv, -th), P(iu + 1, iv + 1, -th), P(iu, iv + 1, -th),
        [0, -1, -0.3]);
    }
    // Front edge, closing the shell.
    facet(af, P(iu, nv, 0), P(iu + 1, nv, 0), P(iu + 1, nv, -th), P(iu, nv, -th), [0, 0, 1]);
  }
  for (let iv = 0; iv < nv; iv++) {
    facet(af, P(0, iv, 0), P(0, iv + 1, 0), P(0, iv + 1, -th), P(0, iv, -th), [-1, 0, 0]);
    facet(af, P(nu, iv, 0), P(nu, iv + 1, 0), P(nu, iv + 1, -th), P(nu, iv, -th), [1, 0, 0]);
  }
  // Close the rear edge too. The wall hides it now, but an open edge is still a
  // hole to the shadow pass and this shell is meant to be watertight.
  for (let iu = 0; iu < nu; iu++) {
    facet(af, P(iu, 0, -th), P(iu + 1, 0, -th), P(iu + 1, 0, 0), P(iu, 0, 0), [0, 0, -1]);
  }

  /* The valance: the flap hanging off the front bar. It is where the shop's
   * name goes, it is the part that is always frayed and faded, and it is the
   * only part of an awning visible from directly underneath — which is the
   * angle most of this street sees them from. */
  const vD = hr(seed * 4.9, 7.7, 0.19, 0.27);
  A.attr('aAwn', seed, AWN.VALANCE, yFront, yFront - vD);
  const vt = 0.006;
  const V = (iu: number, low: boolean, off: number): L3 => {
    const su = u0 + span * (iu / nu);
    // A hem that has lost its stiffener wanders by a centimetre or two.
    const wave = low ? Math.sin(su * 5.1 + seed * 11.0) * 0.014 : 0;
    return [su, (low ? yFront - vD + wave : yFront) + off, d + 0.02 + (proj - 0.02)];
  };
  for (let iu = 0; iu < nu; iu++) {
    facet(af, V(iu, false, 0), V(iu, true, 0), V(iu + 1, true, 0), V(iu + 1, false, 0), [0, 0, 1]);
    const back = (i: number, low: boolean): L3 => {
      const p = V(i, low, 0); return [p[0], p[1], p[2] - vt];
    };
    facet(af, back(iu, false), back(iu, true), back(iu + 1, true), back(iu + 1, false), [0, 0, -1]);
    facet(af, V(iu, true, 0), back(iu, true), back(iu + 1, true), V(iu + 1, true, 0), [0, -1, 0]);
  }

  /* Frame: the wall rail, the front bar and the folding arms. The arms are the
   * only part with any depth to it and they are what the underside reads as. */
  A.attr('aAwn', seed, AWN.FRAME, yWall, yFront);
  af.box(u0, u1, yWall - 0.045, yWall + 0.045, d + 0.005, d + 0.075);
  af.bar(u0, u1, [
    [yFront + 0.026, d + proj - 0.026], [yFront + 0.026, d + proj + 0.026],
    [yFront - 0.026, d + proj + 0.026], [yFront - 0.026, d + proj - 0.026],
  ]);
  for (let k = 0; k < arms; k++) {
    const au = u0 + span * (k / (arms - 1));
    const uu = clamp(au, u0 + 0.02, u1 - 0.06);
    const yA = yWall - 0.05, dA = d + 0.06;
    const yB = yFront + 0.01, dB = d + proj - 0.04;
    const ly = yB - yA, ld = dB - dA;
    const l = Math.hypot(ly, ld) || 1;
    const t = 0.042;
    const py = (-ld / l) * t * 0.5, pd = (ly / l) * t * 0.5;
    af.bar(uu, uu + 0.038, [
      [yA - py, dA - pd], [yB - py, dB - pd], [yB + py, dB + pd], [yA + py, dA + pd],
    ]);
  }
}

/* ── Footway furniture ──────────────────────────────────────────────────── */

/*
 * Where these stand is decided against the capture stops, not scattered, and
 * dims.ts records why: the first pass at the flush ironwork put every fixture
 * a metre or two in front of a stop, which sounds like a hit and is a miss —
 * a fixture 1.2 m in front of the lens is underneath the photographer. Every
 * one of them rendered correctly and none appeared in any of the six frames.
 *
 * The geometry here is worse off than the ironwork was, because it is not flush
 * with the ground: an object on the far footway is also outside a 73-degree
 * horizontal frame until it is about seven metres ahead. So everything below
 * sits 8-16 m in front of a stop, on the side of the street that stop is not
 * hugging.
 */

/** Kerb-side x on each footway, and the building line. */
const WALK_KERB = DIMS.roadHalf + DIMS.kerbDepth;      // 3.35
const WALK_WALL = WALK_KERB + DIMS.walkWidth;          // 5.70

/**
 * A cast iron pillar hydrant.
 *
 * 790 mm to the top of the operating nut, a 185 mm barrel, a 115 mm steamer
 * outlet facing the road and two 65 mm hose outlets on the sides. Those are
 * the real numbers and they matter here more than anywhere else in the file,
 * because a hydrant is one of the very few objects in a street photograph
 * whose size everybody already knows.
 */
function emitHydrant(F: Emit, x: number, z: number, facing: number, seed: number): void {
  const fr = frame(x, z, 0, facing);
  const f = new Face(F, fr);
  const y = walkHeight(x, z) - 0.02;
  F.attr('aKind', FURN.HYDRANT, seed);
  /* Off the plates, aRect carries where the object meets the paving. Rust,
   * splash and the scuffing that a kerbside object collects are all measured
   * from the ground up, and a shader given only vWPos.y has no idea whether it
   * is looking at the foot of a hydrant or the foot of a signpost on a footway
   * that falls 31 mm across its width and settles per flag on top of that. */
  F.attr('aRect', y, 0, 0, 0);

  f.tube(0, 0, 0.150, y, y + 0.055, 12);            // base flange
  f.tube(0, 0, 0.098, y + 0.055, y + 0.300, 12);    // lower barrel
  f.tube(0, 0, 0.132, y + 0.300, y + 0.362, 12);    // breakaway flange
  f.tube(0, 0, 0.093, y + 0.362, y + 0.600, 12);    // upper barrel
  f.tube(0, 0, 0.121, y + 0.600, y + 0.646, 12);    // bonnet flange
  f.tube(0, 0, 0.104, y + 0.646, y + 0.712, 10);    // bonnet
  f.tube(0, 0, 0.062, y + 0.712, y + 0.758, 10);    // dome
  f.tube(0, 0, 0.030, y + 0.758, y + 0.792, 5);     // operating nut, pentagon

  /* The steamer outlet, pointing at the road, and the two hose outlets on the
   * sides. Between them they are what turns a bollard into a hydrant: the
   * silhouette of a plain tapered post says nothing at all. */
  nozzle(f, 0, y + 0.455, 0.085, 0.150, 0.085, 8);
  nozzle(f, 0, y + 0.455, 0.150, 0.176, 0.096, 8);  // the cap, proud of the boss
  for (const s of [-1, 1]) {
    f.bar(s * 0.085, s * 0.132, [
      [y + 0.402, -0.060], [y + 0.402, 0.060], [y + 0.522, 0.060], [y + 0.522, -0.060],
    ]);
    f.bar(s * 0.132, s * 0.156, [
      [y + 0.396, -0.068], [y + 0.396, 0.068], [y + 0.528, 0.068], [y + 0.528, -0.068],
    ]);
  }
}

/**
 * A four-yard commercial bin: 1.83 x 1.22 x 1.30 m over the castors.
 *
 * Straight sided rather than tapered, which is a simplification and a
 * deliberate one — the taper is 40 mm over the height and is not readable at
 * the ten to sixteen metres this is ever seen from, whereas the oversailing
 * top rail and the lifting pockets are, and both of those are modelled.
 */
function emitDumpster(F: Emit, x: number, z: number, rot: number, seed: number): void {
  const fr = frame(x, z, Math.sin(rot), Math.cos(rot));
  const f = new Face(F, fr);
  // Sunk 15 mm. The footway has a 31 mm cross-fall and per-flag settlement on
  // top of it, so a 1.2 m footprint placed at one sampled height shows
  // daylight under one corner otherwise — which is the "floating props" note
  // the critique has already made once about this scene.
  const y = walkHeight(x, z) - 0.015;
  const L = 1.83, W = 1.22, bodyH = 1.05, cast = 0.19;
  const hu = L * 0.5, hd = W * 0.5;
  const y0 = y + cast, y1 = y0 + bodyH;

  F.attr('aRect', y, 0, 0, 0);
  F.attr('aKind', FURN.BIN, seed);
  f.box(-hu, hu, y0, y1, -hd, hd);
  // Top rail, oversailing 30 mm all round, which is the edge every dent and
  // every run of rust starts from.
  f.box(-hu - 0.030, hu + 0.030, y1, y1 + 0.070, -hd - 0.030, hd + 0.030);
  // Vertical stiffening ribs down both long sides.
  for (let i = 0; i < 5; i++) {
    const u = -hu + L * ((i + 0.5) / 5);
    f.box(u - 0.032, u + 0.032, y0 + 0.05, y1, hd, hd + 0.022);
    f.box(u - 0.032, u + 0.032, y0 + 0.05, y1, -hd - 0.022, -hd);
  }
  // Lifting pockets: the pair of forks a front-loader picks it up by.
  for (const s of [-1, 1]) {
    f.box(s * 0.34 - 0.14, s * 0.34 + 0.14, y0 + 0.36, y0 + 0.54, hd, hd + 0.115);
    f.box(s * 0.34 - 0.14, s * 0.34 + 0.14, y0 + 0.36, y0 + 0.54, -hd - 0.115, -hd);
  }
  // Castors.
  F.attr('aKind', FURN.RUBBER, seed);
  for (const su of [-1, 1]) {
    for (const sd of [-1, 1]) {
      f.tube(su * (hu - 0.20), sd * (hd - 0.16), 0.092, y + 0.005, y + cast, 8);
    }
  }

  /* Two hinged lid halves, and one of them is up.
   *
   * A closed bin is a box. An open one has a black rectangle of shadow in the
   * top of it and a lid standing vertically against the wall behind, and both
   * of those are silhouette rather than surface, which is what survives at this
   * distance and in this light. The angle is deliberately not 90 degrees —
   * a lid resting back against a wall leans. */
  F.attr('aKind', FURN.BIN_LID, seed);
  const lt = 0.045;
  // Closed half, sloped slightly so water runs off it.
  f.box(-hu - 0.02, -0.01, y1 + 0.070, y1 + 0.070 + lt, -hd - 0.02, hd + 0.02);
  // Open half, hinged along the back edge and leaning back past vertical.
  const lean = 0.28;
  const hy = y1 + 0.070;
  const q = (a: L3, b: L3, cc: L3, dd: L3, out: L3) => facet(f, a, b, cc, dd, out);
  const bh = -hd;                       // hinge line, at the back
  const tipD = bh - Math.sin(lean) * (W + 0.04);
  const tipY = hy + Math.cos(lean) * (W + 0.04);
  const uA = 0.01, uB = hu + 0.02;
  q([uA, hy, bh], [uB, hy, bh], [uB, tipY, tipD], [uA, tipY, tipD], [0, 0.3, 1]);
  q([uA, hy - lt, bh], [uB, hy - lt, bh], [uB, tipY - lt, tipD], [uA, tipY - lt, tipD],
    [0, -0.3, -1]);
  q([uA, hy, bh], [uA, tipY, tipD], [uA, tipY - lt, tipD], [uA, hy - lt, bh], [-1, 0, 0]);
  q([uB, hy, bh], [uB, tipY, tipD], [uB, tipY - lt, tipD], [uB, hy - lt, bh], [1, 0, 0]);
  q([uA, tipY, tipD], [uB, tipY, tipD], [uB, tipY - lt, tipD], [uA, tipY - lt, tipD],
    [0, 1, -0.3]);
}

/**
 * Bin bags, piled where they were dropped rather than arranged.
 *
 * Real ones lean on each other and on whatever is behind them, and the pile
 * always has one that has split. Positions are hashed within a footprint so
 * that no two are the same size or sit square to anything.
 */
function emitBags(
  F: Emit, x: number, z: number, facing: number, n: number, seed: number,
): void {
  const fr = frame(x, z, 0, facing);
  const f = new Face(F, fr);
  const y = walkHeight(x, z);
  for (let i = 0; i < n; i++) {
    const s = seed * 13.1 + i * 7.7;
    const uu = (h2(s, 1.1) - 0.5) * 1.30;
    const dd = (h2(s, 2.2) - 0.5) * 0.62;
    /* A tied sack of household waste is 480-620 mm tall and about 400 across.
     * Anything much bigger reads as a boulder and anything smaller as litter,
     * and the pile only works if the sizes disagree with each other. */
    const hgt = 0.44 + h2(s, 3.3) * 0.19;
    const rad = 0.19 + h2(s, 4.4) * 0.075;
    // The pile leans into itself: later bags sit up on the ones already there.
    const rest = y + (i > 1 ? 0.055 * h2(s, 6.6) : 0) - 0.01;
    F.attr('aKind', FURN.BAG, s);
    F.attr('aRect', rest, 0, 0, 0);
    bag(f, uu, rest, dd, rad, hgt, rad * (0.85 + h2(s, 5.5) * 0.3), s);
  }
}

/**
 * A signpost, with whatever plates are on it.
 *
 * There is no text geometry anywhere in this. A 150 mm street name blade seen
 * from ten metres is thirteen pixels tall and its lettering is six, so what
 * has to be right is the plate's proportion, its border and the fact that it
 * carries a light band on a dark ground. The material draws that band as
 * analytic pseudo-glyphs, which converge to the correct average as they fall
 * below a pixel instead of turning to noise the way sampled text would.
 */
function emitSignPost(
  F: Emit, x: number, z: number, facing: number, height: number,
  plates: { kind: number; w: number; h: number; y: number; cross?: boolean }[],
  seed: number,
): void {
  const y = walkHeight(x, z) - 0.02;
  const fr = frame(x, z, 0, facing);
  const f = new Face(F, fr);
  // Across the street as well as along it, for the blades that face both ways.
  const frX = frame(x, z, facing, 0);
  const fX = new Face(F, frX);

  F.attr('aRect', y, 0, 0, 0);
  F.attr('aKind', FURN.POST, seed);
  // 60 mm galvanised tube, and a base collar so it does not grow out of the
  // paving like a plant.
  f.tube(0, 0, 0.030, y, y + height, 8);
  f.tube(0, 0, 0.048, y, y + 0.055, 8);

  for (const p of plates) {
    const face = p.cross ? fX : f;
    // Held clear of the post so the plate can throw its own shadow onto it.
    plate(face, F, -p.w * 0.5, p.w * 0.5, y + p.y, y + p.y + p.h, 0.031, 0.043,
      p.kind, seed + p.y);
    F.attr('aKind', FURN.POST, seed);
    F.attr('aRect', y, 0, 0, 0);
    // Fixing bands.
    for (const by of [y + p.y + p.h * 0.22, y + p.y + p.h * 0.78]) {
      face.box(-0.040, 0.040, by - 0.014, by + 0.014, 0.026, 0.034);
    }
  }
}

/* ── The System 5 interface ─────────────────────────────────────────────── */

/**
 * Everything System 5 needs to hang a real light on a lit shopfront.
 *
 * System 3 builds the room, the glazing and the emissive surfaces inside it,
 * which is enough for the unit to read as lit from across the street. What it
 * cannot do is put the warm pool on the footway in front of it, because that
 * needs a light source and lights are System 5's. So each lit unit reports the
 * aperture its light leaves through: a rectangle in world space, its outward
 * normal, and the linear radiance of the emissive surfaces behind it so that
 * whatever is added matches what is already there rather than fighting it.
 *
 * The obvious implementation on the other side is a RectAreaLight on this
 * rectangle, or — cheaper and probably better at this scale — a spotlight set
 * back `depth` behind it and aimed along `dir` with a wide cone. Either way
 * the colour and the level should be taken from `colour` scaled by area, and
 * the shopfront's own emissive should be left exactly as it is: it is the
 * source, not a stand-in for one.
 */
export type ShopLight = {
  kind: 'store' | 'bar';
  /** Centre of the glazed aperture, in world metres. */
  pos: [number, number, number];
  /** Unit outward normal of the shopfront: the direction the spill travels. */
  dir: [number, number, number];
  /** Aperture width along the frontage and its height. */
  width: number; height: number;
  /** How far the emissive ceiling sits behind the aperture. */
  depth: number;
  /** Linear RGB of the interior's emissive surfaces. */
  colour: [number, number, number];
};

declare global {
  interface Window {
    /** Published by StreetLevel.tsx for System 5 and for the capture harness. */
    __shopLights?: ShopLight[];
  }
}

/* The linear radiance the lit interiors are authored at, shared with the
 * shader so the two cannot drift. Warm, and well under what a real fluorescent
 * shop ceiling would be, because the sun is still up: at this hour a lit shop
 * is a warm patch inside a cool one, not a lantern.
 *
 * Both are pre-compensated for AgX rather than being the colour a photometer
 * would read, and System 5 needs to know that before it copies them onto a
 * light. The tone map desaturates progressively up its shoulder: the store's
 * ceiling was authored at a red-to-blue ratio of 2.07 and measured 1.25 on
 * screen, so the input is pushed well past the target to land on it. A light
 * shining on the footway will sit lower on the curve than an emissive ceiling
 * does and will therefore keep more of its chroma from the same numbers —
 * expect to have to pull the spill back toward neutral rather than push it. */
const LIT_STORE: [number, number, number] = [0.80, 0.53, 0.25];
const LIT_BAR: [number, number, number] = [0.74, 0.30, 0.075];

/* ── Assembly ───────────────────────────────────────────────────────────── */

export type StreetLevel = {
  shop: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  shutter: THREE.BufferGeometry;
  awning: THREE.BufferGeometry;
  furniture: THREE.BufferGeometry;
  triangles: number;
  lights: ShopLight[];
  dispose(): void;
};

export function buildStreetLevel(): StreetLevel {
  const S = new Emit({ aShop: 4, aShop2: 4 });
  const G = new Emit({ aGlass: 4 });
  const R = new Emit({ aShut: 4 });
  const A = new Emit({ aAwn: 4 });
  const F = new Emit({ aKind: 2, aRect: 4 });

  /* The layout is recomputed rather than handed over.
   *
   * `layoutBlock` is a pure function of two fixed seeds and `walkHeight`, so
   * calling it a second time returns the same block down to the last
   * millimetre, and every dimension System 3 needs from a building comes out
   * of `groundLevels` and `groundOpenings`, which System 2 now uses as well.
   * Threading the layout through the component tree instead would couple this
   * file to Buildings.tsx for no benefit; sharing the two accessors is what
   * actually prevents drift. */
  const { bldgs } = layoutBlock((x, z) => walkHeight(x, z));

  const units: Unit[] = [];
  for (const b of bldgs) {
    if (!b.street) continue;
    // Everything past the ends of the walk is behind the camera at one end and
    // dissolved in haze at the other.
    const zc = b.frame.oz + b.frame.uz * (b.L * 0.5);
    if (zc > 14 || zc < -112) continue;
    units.push(...unitsOf(b, b.frame.ox > 0));
  }
  units.sort((a, z) => z.z - a.z);
  assignTypes(units);

  const lights: ShopLight[] = [];
  for (const un of units) {
    const c: Ctx = {
      S, G, R, A,
      sf: new Face(S, un.b.frame), gf: new Face(G, un.b.frame),
      rf: new Face(R, un.b.frame), af: new Face(A, un.b.frame),
      baseY: un.b.base, nx: un.b.frame.nx,
    };
    emitShopfront(c, un);

    if (un.type !== UnitType.LIT) continue;
    const b = un.b;
    const { plinthTop, openTop } = groundLevels(b);
    const uA = un.bays[0].u0, uB = un.bays[un.bays.length - 1].u1;
    const uc = (uA + uB) * 0.5;
    const { ox, oz, ux, uz, nx, nz } = b.frame;
    const dI = b.d0 - un.bays[0].rec;
    const y0 = plinthTop + 0.5, y1 = openTop - 0.15;
    const bar = un.east;
    lights.push({
      kind: bar ? 'bar' : 'store',
      pos: [ox + ux * uc + nx * dI, (y0 + y1) * 0.5, oz + uz * uc + nz * dI],
      dir: [nx, 0, nz],
      width: uB - uA, height: Math.max(0.6, y1 - y0),
      depth: 2.1,
      colour: bar ? LIT_BAR : LIT_STORE,
    });
  }

  /* ── Things standing on the paving ────────────────────────────────────
   *
   * Six objects, each aimed at a stop. The z values are 8-16 m in front of one
   * and the x values keep everything at least 350 mm clear of the kerb face,
   * because an object overhanging the gutter reads as badly placed and the
   * kerb line is the strongest edge in the lower half of every frame.
   */

  /* The hydrant, nine metres in front of the opening stop and 650 mm off the
   * kerb face, which is where one actually stands. At that distance it is
   * ninety-odd pixels tall in a 900 line frame — the largest single object at
   * street level in the first composition. */
  emitHydrant(F, -(WALK_KERB + 0.45), -7.0, +1, 0.31);

  /* The dumpster, in the mouth of the service alley at z = -68.5 to -72.6,
   * pushed back against the building line with a metre of footway still clear
   * past it. Fifteen metres in front of stop four. An alley with a bin in it
   * is also the only thing that stops that gap reading as a hole in the
   * frontage, which System 2 left it as. */
  emitDumpster(F, -(WALK_WALL - 0.66), -70.4, 0.14, 0.57);
  emitBags(F, -(WALK_WALL - 0.55), -68.75, +1, 4, 0.83);
  emitBags(F, -(WALK_WALL - 0.42), -72.15, +1, 2, 0.19);

  /* The street name blades, at the far corner of the cross street where a
   * corner sign belongs — nine metres in front of stop four, on the opposite
   * footway to the bin so the two are never stacked in one frame. Two blades
   * at right angles, because that is what a corner has and because the one
   * across the street is the one that is legible from the road. */
  emitSignPost(F, WALK_KERB + 0.42, -63.2, -1, 2.86, [
    { kind: FURN.SIGN_STREET, w: 0.78, h: 0.155, y: 2.52 },
    { kind: FURN.SIGN_STREET, w: 0.70, h: 0.155, y: 2.33, cross: true },
  ], 0.44);

  /* No parking, ten metres in front of stop two on the near footway, with the
   * tow-away plate under it that every one of them carries. */
  emitSignPost(F, -(WALK_KERB + 0.38), -25.5, +1, 2.62, [
    { kind: FURN.SIGN_REG, w: 0.30, h: 0.46, y: 2.02 },
    { kind: FURN.SIGN_BACK, w: 0.30, h: 0.21, y: 1.74 },
  ], 0.71);

  /* And one against the vacant lot, ten metres in front of stop five, so the
   * last third of the walk has something upright on the far footway. */
  emitSignPost(F, WALK_KERB + 0.40, -84.5, -1, 2.55, [
    { kind: FURN.SIGN_REG, w: 0.30, h: 0.46, y: 1.94 },
  ], 0.26);

  const shop = S.geometry(), glass = G.geometry();
  const shutter = R.geometry(), awning = A.geometry(), furniture = F.geometry();
  const triangles = S.triangleCount + G.triangleCount + R.triangleCount
    + A.triangleCount + F.triangleCount;

  return {
    shop, glass, shutter, awning, furniture, triangles, lights,
    dispose() {
      shop.dispose(); glass.dispose(); shutter.dispose();
      awning.dispose(); furniture.dispose();
    },
  };
}

export type { Frame };
