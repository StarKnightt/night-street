/* Where everything on the footway stands.
 *
 * One table, read by two consumers that must never disagree: `world/props.ts`
 * builds the geometry from it and `scene/collide.ts` builds the solids from
 * it. NOTES.md records what happens when they are two tables instead of one —
 * `tools/obstacles.mjs` cleared routes that were not clear because it was a
 * hand copy of `world/cars.ts` that had drifted by one car and one transposed
 * dimension, and the five original pieces of footway furniture were copied
 * into the collider as literals because System 3 writes their positions as
 * arguments at a call site. Both of those are the same bug, and the only fix
 * that stays fixed is that there is one place the numbers live.
 *
 * So the contract of this file is narrow and absolute: a prop that is not in
 * `props()` is not drawn, and a prop in `props()` with a footprint is
 * collidable. Adding a prop cannot forget to add its collider, because the
 * collider is derived from the same record by `propSolids()` rather than
 * written next to it.
 *
 * ── How the placement is generated ────────────────────────────────────────
 *
 * Not by scattering, and not by hand either. Both were tried on this street:
 * hand placement got six objects aimed at six capture stops and left every
 * other metre of footway bare, and uniform scatter produced an even sprinkle
 * that reads as a distribution rather than as a street.
 *
 * What real kerbside clutter looks like is *clumped and functional*. Bags go
 * out beside a doorway on the night before a collection, not every nine
 * metres. Newspaper boxes stand in a row of three because the second one was
 * put next to the first. A hydrant is on its own because the law says nothing
 * may stand near it. So there are two mechanisms here and the split matters:
 *
 *   - **Clusters** are anchored to a *reason* — a shop doorway, a service
 *     alley, a lot gate. Each drops two to five related objects within a
 *     couple of metres of each other, with the pile against the wall and the
 *     upright things at the kerb.
 *   - **Lane scatter** fills the rest from a jittered grid whose acceptance
 *     probability is modulated by two octaves of clump noise, so the density
 *     itself varies along the street: busy stretches and thin ones, rather
 *     than a constant rate. This is the technique the jungle uses for
 *     undergrowth, and it is the reason no stretch of that trail reads as
 *     evenly planted.
 *
 * Everything is then filtered against what is already on the footway — the
 * lamp columns, the original six pieces of furniture, the flush ironwork — and
 * against everything already placed, with a per-kind clearance. That filter is
 * why the generation can be greedy: it cannot produce an overlap, so the
 * acceptance rates can be set for the look rather than for safety.
 */
import { DIMS, LAMPS, FIXTURES } from './dims';
import { makeRng } from './noise';
import { layoutBlock } from './block';
import { groundOpenings, pierCentres } from './facade';
import { walkHeight } from './geometry';

/** Kerb-side x on each footway, and the building line. Derived, never typed. */
export const WALK_KERB = DIMS.roadHalf + DIMS.kerbDepth;      // 3.35
export const WALK_WALL = WALK_KERB + DIMS.walkWidth;          // 5.70

export type PropKind =
  | 'bollard'      // cast iron kerb bollard
  | 'meter'        // parking meter on a post
  | 'newsbox'      // free-sheet vending box
  | 'binpost'      // litter bin on a post, the municipal kind
  | 'wheelie'      // a plastic trade wheelie bin against the wall
  | 'bags'         // a pile of refuse sacks
  | 'crates'       // stacked bottle crates
  | 'pallet'       // a pallet leaning on the wall
  | 'cellar'       // pavement cellar doors, flush
  | 'grate'        // a cast gully or vault light, flush
  | 'standpipe'    // fire service inlet / dry riser against the plinth
  | 'hydrant'      // pillar hydrant
  | 'cone'         // traffic cone
  | 'aboard'       // A-board pavement sign
  | 'planter'      // concrete tub with a dead shrub in it
  | 'cycle'        // Sheffield cycle hoop
  | 'cabinet'      // utility cabinet against the wall
  | 'drum'         // steel drum used as a bin
  | 'sacktruck'    // a sack truck left against the wall
  | 'boxes';       // flattened cardboard stacked for collection

/** The plan footprint a kind presents to a walker, and how it collides. */
type Foot =
  | { kind: 'disc'; r: number }
  | { kind: 'box'; hw: number; hl: number }
  | { kind: 'none' };

/* Half-extents are the *widest* part of the object, not its body.
 *
 * A hydrant's widest part is the steamer cap at 176 mm, not the 150 mm base
 * flange; a wheelie bin's is the lid lip, not the shell. Sizing a collider to
 * the body is how a camera ends up with the corner of a bin passing through
 * the frame while the walker reports clear.
 *
 * The flush ironwork is deliberately `none`. A cellar door and a gully grate
 * are in the paving, and a walker that is stopped by a manhole cover is a
 * worse lie than one that walks over it.
 */
const FOOT: Record<PropKind, Foot> = {
  bollard: { kind: 'disc', r: 0.115 },
  meter: { kind: 'disc', r: 0.095 },
  newsbox: { kind: 'box', hw: 0.24, hl: 0.20 },
  binpost: { kind: 'disc', r: 0.230 },
  wheelie: { kind: 'box', hw: 0.35, hl: 0.29 },
  bags: { kind: 'disc', r: 0.52 },
  crates: { kind: 'box', hw: 0.31, hl: 0.24 },
  pallet: { kind: 'box', hw: 0.60, hl: 0.20 },
  cellar: { kind: 'none' },
  grate: { kind: 'none' },
  standpipe: { kind: 'box', hw: 0.24, hl: 0.14 },
  hydrant: { kind: 'disc', r: 0.176 },
  cone: { kind: 'disc', r: 0.185 },
  aboard: { kind: 'box', hw: 0.32, hl: 0.28 },
  planter: { kind: 'disc', r: 0.36 },
  cycle: { kind: 'box', hw: 0.40, hl: 0.06 },
  cabinet: { kind: 'box', hw: 0.34, hl: 0.16 },
  drum: { kind: 'disc', r: 0.30 },
  sacktruck: { kind: 'box', hw: 0.24, hl: 0.17 },
  boxes: { kind: 'box', hw: 0.42, hl: 0.17 },
};

/* How much room a kind demands of its neighbours, which is not its footprint.
 *
 * A pile of sacks and a stack of cardboard put out on the same night are
 * interleaved — the sacks lean on the boxes, that is why the pile stands up —
 * so the exclusion radius used when generating has to be smaller than the
 * collider radius or a cluster rejects its own members and comes out as one
 * object with a lot of clear paving round it. That is exactly what the first
 * run produced: ninety-four props from a hundred and fifty attempts.
 *
 * Hard objects keep their full footprint. A bollard 200 mm from a parking
 * meter is not a street, it is a collision the generator failed to reject.
 */
const PACK: Partial<Record<PropKind, number>> = {
  bags: 0.30, boxes: 0.24, crates: 0.22, pallet: 0.26, drum: 0.24,
  wheelie: 0.30, sacktruck: 0.20, cone: 0.16,
};

export type Prop = {
  kind: PropKind;
  /** World position of the object's own origin, on the paving. */
  x: number; z: number;
  /** Rotation about Y. Nothing on a footway is square to the kerb. */
  yaw: number;
  /** Everything hashed inside the emitter comes off this. */
  seed: number;
  /** Size multiplier, so two of a kind are never the same object. */
  scale: number;
};

/** The solid a prop presents in plan, or null for flush ironwork. */
export type PropSolid =
  | { what: string; kind: 'disc'; x: number; z: number; r: number }
  | { what: string; kind: 'box'; x: number; z: number; yaw: number; hw: number; hl: number };

/* ── Hashing ─────────────────────────────────────────────────────────────── */

const h2 = (a: number, b: number): number => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/* Two octaves of value noise along the street, for density rather than for
 * position. The product of two periods is what gives a heavy tail: most of the
 * street sits near the mean and a few short stretches are two or three times
 * as busy, which is what a real parade does outside a takeaway. */
function clump(z: number, k: number): number {
  const n1 = (p: number) => {
    const i = Math.floor(p), f = p - i;
    const u = f * f * (3 - 2 * f);
    return h2(i, k) * (1 - u) + h2(i + 1, k) * u;
  };
  return n1(z / 17) * (0.35 + 0.65 * n1(z / 5.5 + 11));
}

/* ── What is already standing there ──────────────────────────────────────── */

/* The original six, lifted out of `buildStreetLevel`'s call-site arguments.
 *
 * NOTES.md asks for exactly this: "System 3 writes them as literal arguments
 * at the call site rather than as a table. Whoever next touches
 * `world/street3.ts` should lift them into an exported constant; the collider
 * will import it and the copy can go." They are here rather than in street3.ts
 * because this is the file both the renderer and the collider already read,
 * and street3.ts now takes its arguments from here.
 *
 * The x values are derived off `DIMS` the way street3.ts derived them, so a
 * change to the kerb or the footway width still moves the geometry and the
 * collider together.
 */
export const LEGACY = {
  hydrant: { x: -(WALK_KERB + 0.45), z: -7.0, facing: +1, seed: 0.31, r: 0.176 },
  dumpster: {
    x: -(WALK_WALL - 0.66), z: -70.4, rot: 0.14, seed: 0.57,
    /* 1.83 along its own u axis and 1.22 across, and `frame()` points u down
     * +Z for it — so 1.22 across the street and 1.83 along it, which is the
     * only reading that leaves the 1.1 m of clear footway street3.ts claims. */
    hw: 1.22 * 0.5 + 0.03, hl: 1.83 * 0.5 + 0.03,
  },
  bagsA: { x: -(WALK_WALL - 0.55), z: -68.75, facing: +1, n: 4, seed: 0.83, r: 0.62 },
  bagsB: { x: -(WALK_WALL - 0.42), z: -72.15, facing: +1, n: 2, seed: 0.19, r: 0.48 },
  signCorner: { x: WALK_KERB + 0.42, z: -63.2, facing: -1, h: 2.86, seed: 0.44, r: 0.060 },
  signNoPark: { x: -(WALK_KERB + 0.38), z: -25.5, facing: +1, h: 2.62, seed: 0.71, r: 0.060 },
  signLot: { x: WALK_KERB + 0.40, z: -84.5, facing: -1, h: 2.55, seed: 0.26, r: 0.060 },
} as const;

/** Everything that was on the footway before this pass, as plan discs. */
function preExisting(): { x: number; z: number; r: number; solid?: number }[] {
  const out: { x: number; z: number; r: number; solid?: number }[] = [];
  /* A lamp column is 110 mm across and the clearance around it is not about
   * the column: it is about the door of the inspection cover and about the
   * fact that nothing is ever placed hard against one. */
  /* `r` is a keep-clear radius and `solid` is the object. The two are
   * different numbers and the corridor test needs the second one: nothing may
   * be stacked within 1.30 m of a hydrant, but the hydrant itself is 176 mm
   * across and booking the footway against the keep-clear zone would refuse
   * two and a half metres of street either side of it. */
  for (const [x, , z] of LAMPS) out.push({ x, z, r: 0.55, solid: 0.075 });
  const L = LEGACY;
  out.push({ x: L.hydrant.x, z: L.hydrant.z, r: 1.30, solid: L.hydrant.r });
  out.push({ x: L.dumpster.x, z: L.dumpster.z, r: 1.35, solid: 0.80 });
  out.push({ x: L.bagsA.x, z: L.bagsA.z, r: 0.95, solid: L.bagsA.r });
  out.push({ x: L.bagsB.x, z: L.bagsB.z, r: 0.80, solid: L.bagsB.r });
  for (const s of [L.signCorner, L.signNoPark, L.signLot]) {
    out.push({ x: s.x, z: s.z, r: 0.55, solid: s.r });
  }
  // The flush ironwork. Nothing stands on a manhole: it has to be liftable.
  for (const m of FIXTURES.manholes) out.push({ x: m.x, z: m.z, r: m.r + 0.35 });
  for (const d of FIXTURES.drains) out.push({ x: d.x, z: d.z, r: 0.55 });
  for (const p of FIXTURES.plates) out.push({ x: p.x, z: p.z, r: Math.max(p.w, p.d) * 0.6 + 0.3 });
  return out;
}

/* ── Where there is a wall to stand against ──────────────────────────────── */

type Span = { side: number; z0: number; z1: number; base: number };

/** The z extent of every street-facing frontage, per side. */
function frontages(): Span[] {
  const { bldgs } = layoutBlock((x, z) => walkHeight(x, z));
  const out: Span[] = [];
  for (const b of bldgs) {
    if (!b.street) continue;
    const zA = b.frame.oz;
    const zB = b.frame.oz + b.frame.uz * b.L;
    out.push({
      side: b.frame.ox > 0 ? +1 : -1,
      z0: Math.min(zA, zB), z1: Math.max(zA, zB),
      base: b.base,
    });
  }
  return out;
}

function hasWall(spans: Span[], side: number, z: number, margin = 0.3): boolean {
  return spans.some((s) => s.side === side && z > s.z0 + margin && z < s.z1 - margin);
}

/* ── Doorway clusters ────────────────────────────────────────────────────── */

/* A cluster is anchored on a pier because a pier is where a doorway is.
 *
 * `pierCentres` returns the middle of every stretch of solid wall between the
 * shopfront openings, which is exactly the place a bin is pushed to and the
 * only place a cabinet can be fixed. Placing against the pier rather than at a
 * hashed u along the frontage is the same correction facade.ts already made
 * for meter boxes, and it matters more here: a pile of sacks stacked against a
 * plate glass window is a thing you never see, because the shopkeeper moves
 * it.
 */
const CLUSTER_KITS: { kinds: PropKind[]; weight: number }[] = [
  // Refuse out for collection. The commonest thing on any back street at dusk.
  { kinds: ['bags', 'bags', 'boxes'], weight: 1.0 },
  { kinds: ['wheelie', 'bags', 'crates'], weight: 0.85 },
  // A delivery that has not been taken in yet.
  { kinds: ['crates', 'pallet', 'boxes'], weight: 0.55 },
  { kinds: ['drum', 'bags'], weight: 0.45 },
  // The utilities' own clutter, which clusters because it is all fed from one
  // service entry.
  { kinds: ['cabinet', 'standpipe'], weight: 0.5 },
  { kinds: ['wheelie', 'wheelie'], weight: 0.6 },
  { kinds: ['sacktruck', 'crates', 'bags'], weight: 0.35 },
  { kinds: ['aboard', 'planter'], weight: 0.4 },
];

/* ── The table ───────────────────────────────────────────────────────────── */

let cache: Prop[] | null = null;

export function props(): Prop[] {
  if (cache) return cache;

  const rng = makeRng(517339);
  const out: Prop[] = [];
  const taken = preExisting();
  const spans = frontages();

  /** Reject anything that overlaps something already on the paving. */
  const free = (x: number, z: number, r: number): boolean => {
    for (const t of taken) {
      if (Math.hypot(x - t.x, z - t.z) < r + t.r) return false;
    }
    return true;
  };

  /* The slot nobody can get out of.
   *
   * Two solids parked between 0 and 460 mm apart make a gap the body can enter
   * and cannot fit in. The depenetration solver in `scene/collide.ts` sweeps
   * eight times and converges on nothing, because there is nothing to converge
   * on: every position in the slot is inside one of the two. `collide.mjs
   * approach` measured it as soon as the density went up — 4.22 mm resting
   * inside a wheelie bin and 4.00 mm inside a drum, against 0.09 mm for the
   * whole street before this pass, and the walker had been squeezed there by
   * the *other* prop rather than by the one it ended up inside.
   *
   * The fix is geometric and belongs here rather than in the solver. A gap is
   * allowed to be shut — two footprints overlapping is a pile, and a body
   * cannot enter a pile — or it is allowed to be walkable. It is not allowed
   * to be 300 mm. So the band from touching to a body-width-plus is refused
   * outright, and the effect on the look is nil, because the placements it
   * throws away are the ones that read as two objects awkwardly not-quite
   * touching anyway.
   */
  const GAP = 2 * 0.23 + 0.06;
  const noSlot = (x: number, z: number, full: number): boolean => {
    /* The building line is a solid too — `scene/collide.ts` models it as a box
     * with its surface at 5.53 so the body centre stops at 5.30 — and it is
     * the one every wall-lane prop is placed next to, so it is the likeliest
     * slot on the street. */
    const gWall = (5.30 + 0.23) - (Math.abs(x) + full);
    if (gWall > 0 && gWall < GAP) return false;
    for (const t of taken) {
      if (!t.solid) continue;
      const dist = Math.hypot(x - t.x, z - t.z);
      const sum = full + t.solid;
      if (dist >= sum && dist < sum + GAP) return false;
    }
    return true;
  };
  /* The corridor, and it is a hard constraint rather than a preference.
   *
   * The first dense run placed 175 props and `tools/collide.mjs sweep` came
   * back with "near footway is sealed at z -21.3, narrowest passable lane
   * 0 mm" and 15.8% of the block out of bounds. The arithmetic is not subtle
   * once it is written down: the footway is 2.35 m wide, a wall-lane prop sits
   * 0.40 to 0.68 m off the frontage and a kerb-lane prop 0.38 to 0.62 m off
   * the kerb, and once each has a 0.3 m radius the two of them between them
   * take 1.9 m of the 2.35 and leave 450 mm — a hundred and fifty short of a
   * body. Every one of those props was individually plausible and the street
   * as a whole could not be walked down.
   *
   * So the lane is booked before the props are, per side and per metre of z:
   * each placement declares how far in from its own edge it reaches, the two
   * reaches are added, and anything that would bring the sum above
   * `walkWidth - LANE` is refused. It is the same trick as the exclusion test
   * one axis up, and it is only expressible at all because both the renderer
   * and the collider now read this table — under the old arrangement the
   * renderer had no idea what the collider thought was solid, which is how the
   * hardcoded footprints in `collide.ts` came to exist in the first place.
   *
   * LANE is 0.78 m: a 0.30 m body radius each side plus 180 mm, which is what
   * the sweep needs to report a lane as passable with something left over for
   * the walker's own lateral drift.
   */
  const LANE = 0.78;
  const BIN = 1.0;
  const nBins = 120;
  const binOf = (z: number) => Math.max(0, Math.min(nBins - 1, Math.round((2 - z) / BIN)));
  /** Metres of footway consumed from the kerb edge, and from the wall. */
  const reach: { kerb: Float64Array; wall: Float64Array }[] = [
    { kerb: new Float64Array(nBins), wall: new Float64Array(nBins) },
    { kerb: new Float64Array(nBins), wall: new Float64Array(nBins) },
  ];
  /* The lamp columns, the sign posts and the legacy furniture book their lane
   * before anything else does. They are the reason the tightest point on the
   * street is where it is — a column stands 0.55 m off the kerb and takes a
   * third of the footway on its own — and a corridor test that did not know
   * about them would let a bin be pushed in behind one and close the gap. */
  const bookExisting = (x: number, z: number, r: number): void => {
    const ax = Math.abs(x);
    if (ax <= WALK_KERB - 0.2 || ax >= WALK_WALL + 0.2) return;
    const R = reach[x > 0 ? 1 : 0];
    const lo = binOf(z + r + 0.35), hi = binOf(z - r - 0.35);
    for (let i = lo; i <= hi; i++) {
      /* Booked from whichever edge it is nearer, and only from that one: a
       * column in the middle of the footway leaves a lane on both sides of
       * itself and charging it against both would close a street that is in
       * fact perfectly walkable. */
      if (ax - WALK_KERB < WALK_WALL - ax) R.kerb[i] = Math.max(R.kerb[i], ax - WALK_KERB + r);
      else R.wall[i] = Math.max(R.wall[i], WALK_WALL - ax + r);
    }
  };

  /* Their *collider* radius, not the clearance radius `preExisting` returns.
   * That one is deliberately generous — 1.30 m round a hydrant so nothing is
   * stacked against it — and booking the lane against a keep-clear zone rather
   * than against the object would refuse the whole footway either side of a
   * lamp column. The flush castings carry no `solid` at all and book nothing,
   * which is the whole point of them. */
  for (const t of taken) if (t.solid) bookExisting(t.x, t.z, t.solid);

  const place = (kind: PropKind, x: number, z: number, yaw: number, scale = 1): boolean => {
    const f = FOOT[kind];
    const full = (f.kind === 'disc' ? f.r : f.kind === 'box' ? Math.hypot(f.hw, f.hl) : 0.25) * scale;
    /* Flush ironwork still takes part in the exclusion test even though it has
     * no collider: a grate under a bin is invisible and a waste of the grate. */
    const r = (PACK[kind] ?? full) * (PACK[kind] ? scale : 1);
    if (!free(x, z, r + 0.06)) return false;
    if (f.kind !== 'none' && !noSlot(x, z, full)) return false;

    /* Only things the body can hit book lane. A coal hole is walked over, so
     * charging it for the width it covers would thin the street's densest and
     * cheapest layer to nothing for no gain. */
    const blocks = f.kind !== 'none';
    const ax = Math.abs(x);
    const side = x > 0 ? 1 : 0;
    if (blocks && ax > WALK_KERB - 0.2 && ax < WALK_WALL + 0.2) {
      /* From the near edge only. A prop 400 mm off the frontage is 1.95 m from
       * the kerb, and booking it against both edges — which the first cut of
       * this did — charges it the entire footway and refuses every solid prop
       * on the street. The count went to zero and the sweep went green, which
       * is the shape of bug this project keeps producing: an instrument
       * reporting success because the thing it measures no longer exists. */
      /* `full`, not the packing radius. `PACK` shrinks what a sack pile
       * demands of its neighbours because sacks interleave, and that is right
       * for the exclusion test and wrong here — a body cannot interleave with
       * a sack pile, so the lane has to be booked against the collider that
       * will actually stop it. Using `r` here left the near footway sealed at
       * 160 mm and the sweep found it. */
      const nearKerb = ax - WALK_KERB < WALK_WALL - ax;
      const own = nearKerb ? ax - WALK_KERB + full : WALK_WALL - ax + full;
      const lo = binOf(z + full + 0.35), hi = binOf(z - full - 0.35);
      const R = reach[side];
      const mine = nearKerb ? R.kerb : R.wall, other = nearKerb ? R.wall : R.kerb;
      for (let i = lo; i <= hi; i++) {
        if (Math.max(mine[i], own) + other[i] > WALK_WALL - WALK_KERB - LANE) return false;
      }
      for (let i = lo; i <= hi; i++) mine[i] = Math.max(mine[i], own);
    }
    out.push({ kind, x, z, yaw, seed: rng(), scale });
    taken.push({ x, z, r, solid: blocks ? full : undefined });
    return true;
  };
  /* A hydrant stands on its own, by law and by habit: nothing may be parked or
   * stacked within three metres of one, and there is one every eighty metres
   * or so rather than one every kerb cell. Both of those are enforced here
   * rather than left to the dice, because four hydrants in a hundred metres —
   * which is what the first run produced — is a thing nobody has ever seen. */
  let lastHydrant = 1e9;

  /* ── Clusters, one per doorway that draws one ──────────────────────────── */

  const { bldgs } = layoutBlock((xx, zz) => walkHeight(xx, zz));
  for (const b of bldgs) {
    if (!b.street) continue;
    const east = b.frame.ox > 0;
    const side = east ? +1 : -1;
    const holes = groundOpenings(b);
    if (holes.length === 0) continue;
    const piers = pierCentres(b);

    for (let i = 0; i < piers.length; i++) {
      const u = piers[i];
      // World z of this pier. Both rows run along z, in opposite directions.
      const z = b.frame.oz + b.frame.uz * u;
      if (z > 2 || z < -101) continue;
      /* Not every doorway has something outside it, and the ones that do are
       * decided by the building rather than by the pier, so a busy shopfront
       * is busy at both ends and a quiet one is quiet at both. That is what
       * makes the street read as having tenants rather than as having a
       * scatter applied to it. */
      const busy = 0.32 + 0.55 * clump(z, east ? 3.1 : 8.7);
      if (h2(b.seed * 91 + i * 5.3, side) > busy) continue;

      let acc = 0;
      const r = h2(b.seed * 13 + i, 7.7);
      let pick = CLUSTER_KITS[0];
      const total = CLUSTER_KITS.reduce((s, k) => s + k.weight, 0);
      const target = r * total;
      for (const k of CLUSTER_KITS) { acc += k.weight; if (target <= acc) { pick = k; break; } }

      /* The pile goes against the wall and works outward. 450 mm off the
       * building line for the first object, which is where a sack actually
       * ends up: hard against the plinth splay, not on it. */
      /* Which lane the cluster is in. Refuse is put out at the *kerb* on
       * collection nights as often as it is left against the wall, and the two
       * read completely differently in frame: a kerbside pile is silhouetted
       * against the sunlit road and a wall pile is not. One in three goes to
       * the kerb, so the footway has clutter on both of its edges rather than
       * a swept channel down the middle with a line of rubbish along one side.
       */
      const kerbside = h2(b.seed * 43 + i, 11.3) > 0.66;
      let off = kerbside ? 0.44 : 0.46;
      for (let j = 0; j < pick.kinds.length; j++) {
        const kind = pick.kinds[j];
        const jz = (h2(b.seed * 7 + i * 3.7, j * 2.9) - 0.5) * 1.85;
        const jx = off + h2(b.seed * 11 + i, j * 5.1) * 0.34;
        const x = side * (kerbside ? WALK_KERB + jx : WALK_WALL - jx);
        const yaw = (h2(b.seed * 17 + i, j) - 0.5) * 1.2 + (east ? Math.PI : 0);
        const scale = 0.88 + h2(b.seed * 23 + i, j * 1.3) * 0.28;
        if (place(kind, x, z + jz, yaw, scale)) off += 0.20;
      }
    }
  }

  /* ── Kerb lane ─────────────────────────────────────────────────────────── */

  /* A jittered grid rather than a Poisson disc, and the jitter is deliberately
   * wider than the cell. A Poisson distribution is *too even* — it is defined
   * by a minimum separation and produces a field with no gaps and no knots,
   * which is exactly the sprinkle this is trying not to be. Overlapping the
   * jitter with the neighbouring cell lets two bollards end up 900 mm apart
   * and lets four metres of kerb end up bare, and the rejection test above is
   * what keeps the near case legal.
   */
  const KERB_KINDS: PropKind[] = [
    'bollard', 'bollard', 'meter', 'newsbox', 'binpost', 'cycle',
    'cone', 'planter', 'bollard', 'hydrant',
  ];
  for (const side of [-1, +1]) {
    for (let z = 1.5; z > -101; z -= 3.4) {
      const zz = z + (rng() - 0.5) * 5.4;
      if (zz > 2 || zz < -101) continue;
      /* Denser where there is no frontage behind, which is the opposite of
       * what the clumping alone produces and is the whole point of doing it
       * explicitly.
       *
       * A stretch with no building on it gets no doorway cluster and no wall
       * lane, because both of those are hung off a frontage — so the two
       * places on this street with no frontage, the cross street on the east
       * at z -35..-45 and the vacant lot at -81..-99, came out as the emptiest
       * paving in the scene while also being the only paving the sun reaches.
       * The fourth and fifth capture stops give a third of the frame to it. It
       * is also where the whole footway width is free, so it can take twice
       * the props without touching the corridor. */
      const open = !hasWall(spans, side, zz, 0.8);
      const p = (0.24 + 1.75 * clump(zz, side > 0 ? 21.3 : 4.9)) * (open ? 1.9 : 1.0);
      if (rng() > p) continue;
      let kind = KERB_KINDS[Math.floor(rng() * KERB_KINDS.length)];
      if (kind === 'hydrant') {
        if (Math.abs(zz - lastHydrant) < 46) kind = 'bollard';
        else lastHydrant = zz;
      }
      /* Off the kerb face, not on it. 380-620 mm is where street furniture is
       * actually set: closer and a wing mirror takes it off, further and it is
       * in the middle of the footway. */
      const x = side * (WALK_KERB + 0.38 + rng() * 0.24);
      place(kind, x, zz, (rng() - 0.5) * 0.5 + (side > 0 ? Math.PI : 0),
        0.9 + rng() * 0.24);
    }
  }

  /* ── Wall lane ─────────────────────────────────────────────────────────── */

  const WALL_KINDS: PropKind[] = [
    'cellar', 'grate', 'cabinet', 'standpipe', 'pallet', 'crates',
    'bags', 'boxes', 'wheelie', 'drum', 'aboard', 'sacktruck', 'cellar',
  ];
  for (const side of [-1, +1]) {
    for (let z = 1.0; z > -101; z -= 2.9) {
      const zz = z + (rng() - 0.5) * 4.6;
      if (zz > 2 || zz < -101) continue;
      // Nothing leans on a wall that is not there.
      if (!hasWall(spans, side, zz, 0.8)) continue;
      const p = 0.20 + 1.70 * clump(zz + 40, side > 0 ? 13.7 : 29.1);
      if (rng() > p) continue;
      const kind = WALL_KINDS[Math.floor(rng() * WALL_KINDS.length)];
      /* Flush ironwork sits out in the flag field where a vault actually is —
       * a coal hole is over the cellar, which is under the footway, not under
       * the wall. Everything else is pushed back against the frontage. */
      const flush = kind === 'cellar' || kind === 'grate';
      const x = side * (flush ? WALK_WALL - 0.85 - rng() * 0.55 : WALK_WALL - 0.40 - rng() * 0.28);
      place(kind, x, zz, (rng() - 0.5) * 0.44 + (side > 0 ? Math.PI : 0),
        0.9 + rng() * 0.25);
    }
  }

  /* ── The back lane, where there is no frontage ─────────────────────────── */

  /* The stretches with no building behind them get a second row set back from
   * the kerb, because there is nothing else competing for the width.
   *
   * What actually stands there on a real street is boundary equipment rather
   * than shop clutter: the cabinets and the standpipe that serve the site
   * behind the hoarding, cycle stands set back off the kerb where there is
   * room for them, cones and a drum left over from whoever was last digging
   * it up, and a planter the council put in to stop people parking on it.
   * None of it is refuse, because there is no door for refuse to come out of,
   * and that difference is most of what makes the gap sites read as gap sites
   * rather than as more of the same street.
   */
  const BACK_KINDS: PropKind[] = [
    'cabinet', 'cycle', 'planter', 'drum', 'cone', 'binpost', 'standpipe', 'crates', 'pallet',
  ];
  for (const side of [-1, +1]) {
    for (let z = 0.5; z > -101; z -= 4.1) {
      const zz = z + (rng() - 0.5) * 5.8;
      if (zz > 2 || zz < -101) continue;
      if (hasWall(spans, side, zz, 0.8)) continue;
      if (rng() > 0.62) continue;
      const kind = BACK_KINDS[Math.floor(rng() * BACK_KINDS.length)];
      const x = side * (WALK_WALL - 0.38 - rng() * 0.42);
      place(kind, x, zz, (rng() - 0.5) * 0.7 + (side > 0 ? Math.PI : 0), 0.9 + rng() * 0.3);
    }
  }

  /* ── Flush ironwork ────────────────────────────────────────────────────── */

  /* The cheapest density on the street, and the pass that moves the flat-area
   * metric further than any of the standing props do.
   *
   * A footway is not a plane. Between the wall and the kerb there is a coal
   * hole every frontage, a stopcock box every other one, a vault light where
   * there is a cellar, an inspection cover on the main run and a gully at the
   * low point of every camber — say one casting every three or four metres,
   * which is far denser than anything above. They are invisible in plan and
   * they are not invisible here, because at 4.2 degrees a 12 mm frame proud of
   * a flag throws a 160 mm shadow and a recessed cover is a dark rectangle
   * with a bright lip on its sunward side. On the east footway, which is the
   * one the sun reaches and the one the fourth stop devotes a third of the
   * frame to, that is the difference between paving and a beige triangle.
   *
   * All of it is `none` in the collider, so this costs nothing to walk
   * through — correctly, since walking over a coal hole is what they are for.
   * It runs last so that it fills the gaps the standing props left rather
   * than competing with them for room.
   */
  for (const side of [-1, +1]) {
    for (let z = 2.0; z > -101; z -= 2.2) {
      const zz = z + (rng() - 0.5) * 3.0;
      if (zz > 2 || zz < -101) continue;
      if (rng() > 0.66) continue;
      const cellarHere = hasWall(spans, side, zz, 1.2) && rng() > 0.72;
      const kind: PropKind = cellarHere ? 'cellar' : 'grate';
      /* Position across the footway says which casting it is. A coal hole and
       * a vault light are over the cellar, so they hug the frontage; a gully
       * is at the kerb because that is where the water goes; an inspection
       * cover is anywhere the main happens to run. */
      const lane = rng();
      const across = lane < 0.34 ? 0.55 + rng() * 0.45          // gully, kerbside
        : lane < 0.68 ? 1.05 + rng() * 0.70                     // main run
          : 1.80 + rng() * 0.42;                                 // vault, at the wall
      const x = side * (WALK_KERB + across);
      place(kind, x, zz, (rng() - 0.5) * 0.20 + (side > 0 ? Math.PI : 0),
        cellarHere ? 0.92 + rng() * 0.2 : 0.72 + rng() * 0.55);
    }
  }

  /* ── The vacant lot ────────────────────────────────────────────────────── */

  /* Behind the railing at z -99..-81, which from the fourth and fifth stops is
   * a hundred and eighty degrees of open ground with a fence in front of it —
   * the single largest empty region in any frame on the walk. A gap site is
   * never empty. It is where the neighbourhood's fly-tipping goes.
   *
   * None of this needs a collider: the walker's building line stops it at
   * x = 5.30 and the nearest of these is a metre and a half beyond that. They
   * are placed as props anyway rather than as one-off geometry so that they
   * come out of the same kit, in the same buffer, in the same draw call.
   */
  for (let i = 0; i < 26; i++) {
    const z = -82.5 - rng() * 15.0;
    const x = 6.9 + rng() * 3.6;
    const kind: PropKind = (['pallet', 'crates', 'drum', 'bags', 'boxes', 'cone', 'wheelie'] as PropKind[])[
      Math.floor(rng() * 7)
    ];
    out.push({ kind, x, z, yaw: rng() * Math.PI * 2, seed: rng(), scale: 0.9 + rng() * 0.4 });
  }

  cache = out;
  return out;
}

/**
 * Every prop that a walker can hit, in plan.
 *
 * Derived from the same records the geometry is built from, which is the whole
 * point of the file. `scene/collide.ts` calls this and nothing else; it does
 * not know what a newspaper box is and cannot get its position wrong.
 */
export function propSolids(): PropSolid[] {
  const out: PropSolid[] = [];
  for (const p of props()) {
    const f = FOOT[p.kind];
    if (f.kind === 'none') continue;
    /* Out of reach behind the lot railing. Kept out of the solid list rather
     * than relied on to be unreachable, because a solid the walker can never
     * touch is still a solid the depenetration loop evaluates every substep. */
    if (Math.abs(p.x) > WALK_WALL + 0.5) continue;
    if (f.kind === 'disc') {
      out.push({ what: p.kind, kind: 'disc', x: p.x, z: p.z, r: f.r * p.scale });
    } else {
      out.push({
        what: p.kind, kind: 'box', x: p.x, z: p.z, yaw: p.yaw,
        hw: f.hw * p.scale, hl: f.hl * p.scale,
      });
    }
  }
  return out;
}
