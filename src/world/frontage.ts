/* Which business is on which frontage, resolved once for the whole street.
 *
 * `trades.ts` holds the deck and the dealing rule; this holds the ordering the
 * deal is made against, and the ordering is the part that has to be stable.
 * Two consumers read it — `signage.ts`, which letters the blades and the
 * hanging boards, and `placement.ts`, which decides what is stacked on the
 * pavement outside — and if they disagree by so much as one frontage the
 * crates end up outside the tattoo studio.
 *
 * So the order is defined here and nowhere else: the west row from the top of
 * the street to the bottom, then the east row the same way. It is a function
 * of nothing but the block layout, it is memoised on first call, and both
 * consumers get the same Map object.
 *
 * ── Why the key is not the array index ───────────────────────────────────
 *
 * Because the array index is exactly the thing that moves. Add a building,
 * change a spacing, reseed the block, and every frontage after the change
 * takes its neighbour's identity — which would be silent, and would look like
 * the deal had stopped working rather than like the street had changed. The
 * key is the row and the frame origin, to the centimetre, so a building that
 * did not move keeps its trade and only the ones that did are redealt.
 */
import { layoutBlock, type Bldg } from './block';
import { walkHeight } from './geometry';
import { dealTrades, type Trade } from './trades';

export const frontageKey = (b: Bldg): string =>
  `${b.frame.ox > 0 ? 'E' : 'W'}:${b.frame.oz.toFixed(2)}`;

let cached: Map<string, Trade> | null = null;

/** Every street-facing building, in the order the deal is made. */
export function frontages(): Bldg[] {
  const { bldgs } = layoutBlock((x, z) => walkHeight(x, z));
  const street = bldgs.filter((b) => b.street);
  const row = (b: Bldg) => (b.frame.ox > 0 ? 1 : 0);
  return street.sort((p, q) => row(p) - row(q) || q.frame.oz - p.frame.oz);
}

/** The business on a frontage, or null if the building is not one. */
export function tradeOf(b: Bldg): Trade | null {
  if (!cached) {
    const order = frontages();
    cached = dealTrades(order.map(frontageKey));
  }
  return cached.get(frontageKey(b)) ?? null;
}

/** The whole deal, for tools that audit it. */
export function tradeMap(): Map<string, Trade> {
  tradeOf(frontages()[0]);
  return cached!;
}
