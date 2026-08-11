/* The solid things on this street, as data.
 *
 * Shared by `reel.mjs --dry`, which uses it to check a route before spending a
 * capture slot on it, and by `motion.mjs`, which uses it to check where the
 * route actually went.
 *
 * These are copies, and that is a compromise rather than a preference. The
 * authoritative numbers live in `world/dims.ts` (`LAMPS`) and in the `SHAPES`
 * table inside `world/cars.ts`, and `SHAPES` is not exported — so a tool can
 * either duplicate the footprints or the file can grow an export, and
 * `world/cars.ts` belongs to System 4 and is being edited. Duplicated, with
 * the derivation written down, until it can be imported:
 *
 *   x = kerbX(side, gap, wide) = side * (roadHalf - gap - wide/2)   cars.ts:1189
 *   roadHalf = 3.15, kerbHeight = 0.145                             dims.ts
 *
 * If a car in `PARKED` moves and this file does not, `motion.mjs` will report
 * a clearance against a car that is no longer there. Re-derive on any System 4
 * change.
 */

/** Lamp columns: [x, z]. `LAMPS` in world/dims.ts, minus the 6.8 m height. */
export const LAMPS = [
  [4.3, 12], [-4.3, -8], [4.3, -25], [-4.3, -45], [4.3, -64], [-4.3, -84], [4.3, -99],
];
/** Column radius. A street lighting column is about 110 mm across the base. */
export const LAMP_R = 0.055;

/** Parked cars: centre and half extents of the body, mirrors excluded. */
export const CARS = [
  { what: 'saloon A', x: -(3.15 - 0.42 - 0.90), z: -8.60, hw: 0.90, hl: 2.35 },
  { what: 'saloon B', x: +(3.15 - 0.36 - 0.90), z: -13.00, hw: 0.90, hl: 2.35 },
  { what: 'hatch C', x: -(3.15 - 0.33 - 0.875), z: -25.40, hw: 0.875, hl: 2.10 },
  { what: 'estate D', x: -(3.15 - 0.38 - 0.895), z: -42.60, hw: 0.895, hl: 2.31 },
  { what: 'supermini E', x: -(3.15 - 0.30 - 0.85), z: -47.55, hw: 0.85, hl: 1.98 },
  { what: 'van F', x: -(3.15 - 0.44 - 0.95), z: -63.50, hw: 0.95, hl: 2.50 },
  { what: 'hatch G', x: +(3.15 - 0.40 - 0.875), z: -70.00, hw: 0.875, hl: 2.10 },
  { what: 'hatch H', x: +(3.15 - 0.35 - 0.875), z: -76.30, hw: 0.875, hl: 2.10 },
];

/* Footway furniture, from `world/street3.ts`.
 *
 * This list is here because leaving it out produced exactly the failure this
 * file is meant to prevent. A route down the left footway at x = -3.75 came
 * back clear from `--dry` and went straight through the fire hydrant at
 * (-3.80, -7.0) and the sign post at (-3.73, -25.5) — a clean bill of health
 * from an incomplete table, which is worse than no table, because the walk
 * video was already shot before anyone looked at a frame.
 *
 * x is `WALK_KERB + offset` with WALK_KERB = 3.35, the back of the kerb.
 */
const WALK_KERB = 3.35, WALK_WALL = 5.70;
export const FURNITURE = [
  { what: 'fire hydrant', x: -(WALK_KERB + 0.45), z: -7.0, r: 0.176 },
  { what: 'sign post', x: -(WALK_KERB + 0.38), z: -25.5, r: 0.06 },
  { what: 'sign post', x: +(WALK_KERB + 0.42), z: -63.2, r: 0.06 },
  { what: 'sign post', x: +(WALK_KERB + 0.40), z: -84.5, r: 0.06 },
  // The dumpster is a box, 1.83 across the street by 1.22 along it.
  { what: 'dumpster', x: -(WALK_WALL - 0.66), z: -70.4, hw: 0.915, hl: 0.61 },
];

/** Kerb face; beyond it the footway is KERB_RISE higher. dims.ts. */
export const KERB_X = 3.15;
export const KERB_RISE = 0.145;

/* Half a shoulder width. The camera is an eye, but the thing that would have
 * hit the car is a body, so a clearance below this is a collision whatever the
 * eye did. */
export const BODY_R = 0.22;

/** Signed clearance from a point to the nearest solid thing, in metres. */
export function clearance(x, z) {
  let best = null;
  const keep = (d, what, at) => { if (!best || d < best.d) best = { d, what, at }; };
  for (const [lx, lz] of LAMPS) keep(Math.hypot(x - lx, z - lz) - LAMP_R, 'lamp column', [lx, lz]);
  for (const c of [...CARS, ...FURNITURE]) {
    if (c.r !== undefined) { keep(Math.hypot(x - c.x, z - c.z) - c.r, c.what, [+c.x.toFixed(2), c.z]); continue; }
    const dx = Math.max(Math.abs(x - c.x) - c.hw, 0);
    const dz = Math.max(Math.abs(z - c.z) - c.hl, 0);
    keep(Math.hypot(dx, dz), c.what, [+c.x.toFixed(2), c.z]);
  }
  return best;
}
