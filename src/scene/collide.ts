/* What the walker cannot walk through, and what it walks on.
 *
 * Two things live here, and they are together because they are the two halves
 * of the same claim: that this street is walkable. Until this file existed the
 * camera passed through a parked hatchback for 3.30 s and through a lamp
 * column for 0.40 s, and the delivered walk avoided both only because the
 * route was hand-routed around every solid object in the block — which took
 * three attempts and is not available to anybody holding W.
 *
 * ── Shapes rather than meshes ─────────────────────────────────────────────
 *
 * Colliding against the real triangles is not worth it here. The street holds
 * 866k of them and the twenty-one things a pedestrian can actually walk into
 * are all, in plan, either a disc or a rectangle. So each solid carries a
 * signed distance function and an exact gradient, the walker is a disc of
 * shoulder radius, and contact is `sdf(p) < r`. That is a handful of
 * multiplies per obstacle per substep and it has no lattice, no broadphase to
 * get wrong, and no false negatives at a mesh seam.
 *
 * ── Where the numbers come from ───────────────────────────────────────────
 *
 * Nothing below is a dimension typed twice. The cars come out of `carSolids`
 * in world/cars.ts, which reads the same `SHAPES` table the bodies are emitted
 * from; the columns come out of `LAMPS` in world/dims.ts, which is the same
 * array the road shader lights from; the ground comes out of `roadHeight` and
 * `walkHeight` in world/geometry.ts, which are the functions the road and
 * footway meshes are built by. The footway furniture is the one exception and
 * is marked as such where it is declared.
 */
import { DIMS, LAMPS } from '@/world/dims';
import { carSolids } from '@/world/cars';
import { roadHeight, walkHeight } from '@/world/geometry';

/* Half a shoulder, plus a 10 mm skin.
 *
 * The camera is an eye but the thing that would have hit the car is a body, so
 * the collider is sized to the widest part of a person rather than to the
 * lens. 0.22 is the half shoulder width `tools/obstacles.mjs` measures its
 * clearances against, and the extra 10 mm is what keeps a legal walk from
 * reporting as a graze in that tool: at exactly 0.22 the two thresholds would
 * be the same number and every contact would land on the boundary.
 */
export const BODY_R = 0.23;

export type Solid =
  | { what: string; kind: 'disc'; x: number; z: number; r: number }
  | {
    what: string; kind: 'box';
    x: number; z: number; yaw: number;
    /** Half extent across the local x axis, and along the local z axis. */
    hw: number; hl: number;
  };

/* Footway furniture.
 *
 * These five are copied out of `buildStreetLevel` in world/street3.ts, which
 * is the one table in this file that is not imported, because System 3 writes
 * its positions as literal arguments at the call site rather than as a shared
 * constant and that file is not mine to restructure at this hour. The x values
 * are re-derived here the way street3.ts derives them — off `DIMS`, not off
 * the 3.35 it prints in a comment — so a change to the kerb or the footway
 * width still moves both together. The offsets and the radii are the copies.
 *
 *   street3.ts:1485   hydrant   -(WALK_KERB + 0.45), -7.0
 *   street3.ts:1492   dumpster  -(WALK_WALL - 0.66), -70.4, rot 0.14
 *   street3.ts:1493   bags      -(WALK_WALL - 0.55), -68.75
 *   street3.ts:1494   bags      -(WALK_WALL - 0.42), -72.15
 *   street3.ts:1501   sign      +(WALK_KERB + 0.42), -63.2
 *   street3.ts:1508   sign      -(WALK_KERB + 0.38), -25.5
 *   street3.ts:1515   sign      +(WALK_KERB + 0.40), -84.5
 *
 * Radii: the hydrant's widest part is the steamer cap at 176 mm, not the
 * 150 mm base flange. A signpost is a 60 mm tube with 80 mm fixing bands on
 * it. The dumpster is 1.83 along its own u axis and 1.22 across, and `frame()`
 * puts u along +Z for it — so it is 1.22 across the street and 1.83 along it,
 * which is the way round that leaves the 1.1 m of clear footway street3.ts's
 * comment claims. **`tools/obstacles.mjs` has that pair the other way round**
 * and reports the alley as blocked across the wrong axis; it is not mine to
 * edit and the delivered walk never reaches z = -70, but it is wrong.
 */
const WALK_KERB = DIMS.roadHalf + DIMS.kerbDepth;
const WALK_WALL = WALK_KERB + DIMS.walkWidth;

const FURNITURE: Solid[] = [
  { what: 'fire hydrant', kind: 'disc', x: -(WALK_KERB + 0.45), z: -7.0, r: 0.176 },
  { what: 'sign post', kind: 'disc', x: -(WALK_KERB + 0.38), z: -25.5, r: 0.060 },
  { what: 'sign post', kind: 'disc', x: +(WALK_KERB + 0.42), z: -63.2, r: 0.060 },
  { what: 'sign post', kind: 'disc', x: +(WALK_KERB + 0.40), z: -84.5, r: 0.060 },
  {
    what: 'dumpster', kind: 'box',
    x: -(WALK_WALL - 0.66), z: -70.4, yaw: 0.14,
    hw: 1.22 * 0.5 + 0.03, hl: 1.83 * 0.5 + 0.03,
  },
  /* The two bag piles, as the discs that enclose the footprint the bags are
   * hashed into. They are soft and half a metre tall and a shin would go
   * through them, but a camera that glides through a pile of rubbish sacks
   * reads as a camera with no collision at all, which is the thing being
   * fixed. Each leaves 1.2 m of footway clear past it. */
  { what: 'bin bags', kind: 'disc', x: -(WALK_WALL - 0.55), z: -68.75, r: 0.62 },
  { what: 'bin bags', kind: 'disc', x: -(WALK_WALL - 0.42), z: -72.15, r: 0.48 },
];

/** Column radius. A street lighting column is about 110 mm across the base. */
const LAMP_R = 0.055;

/* The building line, as a surface rather than as a clamp.
 *
 * `Walker.update` has always clamped |x| to 5.30 — 400 mm short of the real
 * frontage, which is roughly what a shopfront's plinth, stall riser and
 * recessed doorway occupy. That clamp is kept, but it cannot be the only thing
 * holding the walker off the wall, because a clamp applied after collision
 * resolution is a second solver that does not know about the first: at the
 * mouth of the service alley it was pushing the body 470 mm back into the bag
 * pile every frame, since the pile reaches past the clamp line and the clamp
 * has no opinion about that. As a solid it takes part in the same
 * depenetration pass as everything else and the corner resolves.
 *
 * Placed so the body *centre* still stops at exactly 5.30 and the reachable
 * set is unchanged. Two boxes big enough that no walk can reach an end of one.
 */
const WALL_X = 5.30 + BODY_R;
const WALLS: Solid[] = [-1, 1].map((side) => ({
  what: 'building line', kind: 'box' as const,
  x: side * (WALL_X + 60), z: 0, yaw: 0, hw: 60, hl: 600,
}));

let cache: Solid[] | null = null;

/** Every solid thing on the street, in plan. Built once. */
export function solids(): Solid[] {
  if (cache) return cache;
  const out: Solid[] = [];
  for (const [x, , z] of LAMPS) out.push({ what: 'lamp column', kind: 'disc', x, z, r: LAMP_R });
  for (const c of carSolids()) {
    out.push(c.kind === 'body'
      ? { what: c.what, kind: 'box', x: c.x, z: c.z, yaw: c.yaw, hw: c.hw, hl: c.hl }
      : { what: c.what, kind: 'disc', x: c.x, z: c.z, r: c.r });
  }
  out.push(...FURNITURE, ...WALLS);
  cache = out;
  return out;
}

export type Contact = {
  /** Signed distance from the point to the surface; negative is inside. */
  d: number;
  /** Unit outward normal at the nearest point, pointing away from the solid. */
  nx: number; nz: number;
  what: string;
};

/* One scratch record, reused. The solver runs this a few thousand times a
 * frame and none of the results outlive the call that made them. */
const hit: Contact = { d: 1e9, nx: 0, nz: 0, what: '' };

/**
 * Signed distance from a point to one solid, with its analytic normal.
 *
 * The normal is analytic rather than a finite difference of the distance. A
 * central difference costs four more evaluations and, worse, rounds off the
 * corner of a box over the sample width — which is precisely where a collider
 * either catches or lets go, so it is the one place an approximation shows.
 */
function probe(s: Solid, x: number, z: number): Contact {
  if (s.kind === 'disc') {
    const dx = x - s.x, dz = z - s.z;
    const l = Math.hypot(dx, dz);
    hit.d = l - s.r;
    if (l > 1e-9) { hit.nx = dx / l; hit.nz = dz / l; } else { hit.nx = 1; hit.nz = 0; }
  } else {
    /* Into the box's own frame. The convention is world/cars.ts's: local z
     * runs nose to tail along (sin yaw, cos yaw), local x across it. */
    const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
    const dx = x - s.x, dz = z - s.z;
    const lx = dx * c - dz * sn;
    const lz = dx * sn + dz * c;
    const qx = Math.abs(lx) - s.hw, qz = Math.abs(lz) - s.hl;
    let gx: number, gz: number;
    if (qx > 0 || qz > 0) {
      const ex = Math.max(qx, 0), ez = Math.max(qz, 0);
      const l = Math.hypot(ex, ez);
      hit.d = l + Math.min(Math.max(qx, qz), 0);
      gx = Math.sign(lx) * ex / (l || 1);
      gz = Math.sign(lz) * ez / (l || 1);
    } else {
      // Inside: out through the nearest face, which is the larger q.
      hit.d = Math.max(qx, qz);
      gx = qx > qz ? Math.sign(lx) : 0;
      gz = qx > qz ? 0 : Math.sign(lz);
    }
    hit.nx = gx * c + gz * sn;
    hit.nz = -gx * sn + gz * c;
  }
  hit.what = s.what;
  return hit;
}

/** The nearest solid to a point, its signed distance and its outward normal. */
export function nearest(x: number, z: number): Contact {
  let d = 1e9, nx = 0, nz = 0, what = '';
  for (const s of solids()) {
    const c = probe(s, x, z);
    if (c.d < d) { d = c.d; nx = c.nx; nz = c.nz; what = c.what; }
  }
  return { d, nx, nz, what };
}

/* How far the solver is allowed to move before it looks again.
 *
 * A walk covers 47 mm between frames at 30 Hz and a jog 103 mm, and the frame
 * loop hands out deltas up to 50 ms, so a single unchecked step could be
 * 155 mm — two thirds of the body radius, and more than enough to arrive deep
 * inside a lamp column and be pushed out of the far side of it. Substepping to
 * 8 mm bounds the deepest the solver can ever be inside anything, before it
 * corrects, at 8 mm; in practice it is far less, because the component of the
 * step into the surface is what penetrates and it is projected out first.
 *
 * The cost is a loop of at most twenty iterations over twenty-one shapes.
 */
const SUB = 0.008;
/** Below this the walker counts as touching, and its motion is projected. */
const CONTACT = 0.001;

export type Slide = { x: number; z: number; hit: string | null; blocked: number };

/**
 * Move from (x, z) by (dx, dz), sliding along whatever is in the way.
 *
 * Two mechanisms, and both are needed. Projection is what makes contact feel
 * like a surface: the component of the intended motion pointing into the solid
 * is removed and the rest is kept, so a shoulder that meets a car flank at a
 * shallow angle keeps almost all of its speed and one that meets it square
 * stops. Depenetration is the backstop for everything projection cannot see —
 * a substep that starts clear and ends inside, a corner where the surface the
 * motion was projected along turns underneath it, and a teleport that lands
 * the camera inside a van.
 *
 * A camera that halts dead is worse than one that never collided, which is why
 * there is no "stop on contact" path here at all: the walker either slides or,
 * facing a wall square on, loses its speed to the projection and stands still
 * with the gait wound down to match. The one thing it never does is stop with
 * velocity still on the clock, which is what produces a pop.
 */
export function slide(x: number, z: number, dx: number, dz: number, r = BODY_R): Slide {
  const dist = Math.hypot(dx, dz);
  const n = Math.max(1, Math.ceil(dist / SUB));
  const sx = dx / n, sz = dz / n;
  let hit: string | null = null;
  let blocked = 0;

  const all = solids();

  for (let i = 0; i < n; i++) {
    let mx = sx, mz = sz;

    /* Already touching: take away the motion into every surface being
     * touched, not just the nearest one.
     *
     * Only the nearest is not enough and the failure is specific. Wedged into
     * the corner between the dumpster and a bag pile, the nearest solid
     * alternates between the two from frame to frame, each projection lets the
     * motion into the other one, and the depenetration then pushes back — a
     * limit cycle of about 1.5 mm at 20 Hz, which measures as 2.4 mm of
     * penetration and reads on video as a camera shivering in a corner.
     * Sequential projection over both settles into the corner instead.
     */
    for (const s of all) {
      const c = probe(s, x, z);
      if (c.d - r >= CONTACT) continue;
      const into = mx * c.nx + mz * c.nz;
      if (into >= 0) continue;
      mx -= c.nx * into;
      mz -= c.nz * into;
      hit = c.what;
      blocked += -into;
    }

    x += mx; z += mz;

    /* Whatever the step still walked into, over every solid at once and then
     * again until nothing overlaps. A corner is two surfaces and resolving the
     * nearer one leaves the point inside the other — one pass is how a
     * collider ejects a player sideways out of a corner instead of settling
     * into it.
     *
     * Eight sweeps, and the number is measured rather than chosen: the mouth
     * of the service alley overlaps a bag pile, the dumpster and the building
     * line at once, and sequential resolution over three mutually overlapping
     * constraints converges linearly rather than in one pass. Four sweeps left
     * a static 0.55 mm of shoulder inside the dumpster there. The loop exits
     * the moment nothing overlaps, which is every frame that is not in
     * contact, so the extra sweeps cost nothing anywhere else. */
    for (let k = 0; k < 8; k++) {
      let any = false;
      for (const s of all) {
        const c = probe(s, x, z);
        const pen = r - c.d;
        if (pen <= 0) continue;
        x += c.nx * (pen + 1e-5);
        z += c.nz * (pen + 1e-5);
        hit = c.what;
        blocked += pen;
        any = true;
      }
      if (!any) break;
    }
  }
  return { x, z, hit, blocked };
}

/**
 * Height of the walking surface under a point.
 *
 * Both halves are the functions the meshes themselves are built from, so this
 * cannot drift away from what is drawn: `roadHeight` carries the camber, the
 * gutter dish, the settlement and the saucer around each casting, and
 * `walkHeight` carries the kerb reveal, the per-stone kerb settlement, the
 * cross-fall and the per-flag settlement.
 *
 * The join is the kerb face at |x| = roadHalf, and it is a genuine
 * discontinuity of about 150 mm — `walkHeight` clamps its cross-fall term at
 * the back of the kerb, so anywhere over the kerb block itself returns the top
 * of the stone. Smoothing it here would be the wrong place: the step is real
 * and the walker's own filter is what decides how a body climbs it.
 */
export function groundHeight(x: number, z: number): number {
  return Math.abs(x) < DIMS.roadHalf ? roadHeight(x, z) : walkHeight(x, z);
}
