/* What each frontage on the street actually sells.
 *
 * Before this, a shopfront's identity was three independent hashes: the fascia
 * board drew a word by hashing the unit seed into the whole word list, the
 * blade over it drew another by hashing the *building* seed into the same
 * list, and the enamel plates beside the door drew a third. Nothing tied them
 * together and nothing stopped two of them landing on the same word, which on
 * thirty words and sixty draws is not unlikely — it is close to certain. The
 * critique is the visible half of that: a parade where the same trade appears
 * several times and no frontage reads as a particular business.
 *
 * ── Why a draw without replacement, and not a better hash ─────────────────
 *
 * A hash can be tuned until a particular seed produces no visible duplicate,
 * and that is exactly what this project's notes warn about: it is fixed by
 * luck and it regresses silently. Change the building count, move a capture
 * stop, reseed the block, add a word to the list, and the collision comes
 * back with nothing in the tree that says it should not.
 *
 * So identity is dealt rather than hashed. The frontages are put in a fixed
 * order, the trade list is shuffled by a seeded Fisher-Yates, and the two are
 * zipped. A trade cannot appear twice until the deck is exhausted, and when it
 * is exhausted the deck is reshuffled and dealt again — so the failure mode of
 * having more frontages than trades is "the far end of the street repeats a
 * trade from the near end", which is what a real town is like, rather than
 * "two neighbours are the same shop".
 *
 * The trades that must be unique are held out of that entirely. They are dealt
 * first, once, from the front, and never returned to the deck. `assertUnique`
 * in `tools/signcount.mjs` fails the build if any of them is emitted twice, so
 * the invariant is checked rather than argued.
 *
 * ── What a trade is ───────────────────────────────────────────────────────
 *
 * Not a word. The brief is explicit and it is right: a street where every
 * frontage differs only in its lettering reads as one shop with different
 * labels. So a trade also carries how it is glazed, whether it keeps its
 * shutter down, whether it puts fabric out, and what is standing on the
 * pavement outside it — and `placement.ts` reads that last field, so the
 * crates end up outside the deli and the sack pile outside the takeaway.
 */

/** What sits on the footway outside a business. Read by `placement.ts`. */
export type Kerbside =
  | 'crates'      // stacked produce boxes: deli, grocer, florist
  | 'sacks'       // refuse sacks: takeaway, chicken shop, kebab house
  | 'aboard'      // an A-board on the pavement: cafe, barber, minicabs
  | 'bins'        // wheelie bins: laundry, dry cleaner, pub
  | 'cycle'       // a bike against the wall: phone repair, tattoo
  | 'none';

/** How the shopfront glass is treated. */
export type Glazing =
  | 'clear'       // ordinary plate glass
  | 'grille'      // barred or grilled: off licence, pawnbroker, bookmaker
  | 'steam'       // fogged from inside: launderette, dry cleaner
  | 'dark'        // blinds or blacked out: tattoo, bookmaker
  | 'papered';    // whitewash or fly-posters: vacant

export type Trade = {
  /** Must be a member of `FASCIA_LIST`; `fasciaRow` resolves it. */
  word: string;
  /** Dealt once and held out of the deck. */
  unique?: boolean;
  glazing: Glazing;
  /** Fabric out over the footway, if the layout allows it. */
  awning: boolean;
  kerbside: Kerbside;
  /** Interior light, in the shop-window units System 5 already uses. 0 is dark. */
  interior: number;
};

/* The deck.
 *
 * Ordered loosely by how common the trade is on a street like this, which does
 * not matter to the draw — it is shuffled — but does make the list readable.
 * The four the user named are all here: LAUNDERETTE, DELI, OFF LICENCE, TATTOO.
 */
export const TRADES: readonly Trade[] = [
  { word: 'LAUNDERETTE', glazing: 'steam', awning: false, kerbside: 'bins', interior: 0.9 },
  { word: 'DELI', glazing: 'clear', awning: true, kerbside: 'crates', interior: 0.6 },
  { word: 'OFF LICENCE', glazing: 'grille', awning: false, kerbside: 'crates', interior: 0.5 },
  { word: 'TATTOO', glazing: 'dark', awning: false, kerbside: 'cycle', interior: 0.25 },
  { word: 'BARBERS', glazing: 'clear', awning: false, kerbside: 'aboard', interior: 0.5 },
  { word: 'CAFE', glazing: 'clear', awning: true, kerbside: 'aboard', interior: 0.55 },
  { word: 'TAKEAWAY', glazing: 'clear', awning: false, kerbside: 'sacks', interior: 0.8 },
  { word: 'FRIED CHICKEN', glazing: 'clear', awning: false, kerbside: 'sacks', interior: 0.85 },
  { word: 'KEBAB HOUSE', glazing: 'clear', awning: true, kerbside: 'sacks', interior: 0.75 },
  { word: 'NEWSAGENT', glazing: 'clear', awning: true, kerbside: 'aboard', interior: 0.45 },
  { word: 'DRY CLEANERS', glazing: 'steam', awning: false, kerbside: 'bins', interior: 0.4 },
  { word: 'PHONE REPAIR', glazing: 'clear', awning: false, kerbside: 'cycle', interior: 0.4 },
  { word: 'MINICABS', glazing: 'dark', awning: false, kerbside: 'aboard', interior: 0.3 },
  { word: 'BOOKMAKER', glazing: 'dark', awning: false, kerbside: 'none', interior: 0.35 },
  { word: 'PAWNBROKER', glazing: 'grille', awning: false, kerbside: 'none', interior: 0.3 },
  { word: 'NAILS', glazing: 'clear', awning: false, kerbside: 'none', interior: 0.5 },
  { word: 'HARDWARE', glazing: 'clear', awning: true, kerbside: 'crates', interior: 0.3 },
  { word: 'GROCERS', glazing: 'clear', awning: true, kerbside: 'crates', interior: 0.4 },
  { word: 'BUTCHERS', glazing: 'clear', awning: true, kerbside: 'crates', interior: 0.5 },
  { word: 'BAKERY', glazing: 'clear', awning: true, kerbside: 'aboard', interior: 0.55 },
  { word: 'FLORIST', glazing: 'clear', awning: true, kerbside: 'crates', interior: 0.35 },
  { word: 'CARPETS', glazing: 'clear', awning: false, kerbside: 'none', interior: 0.2 },
  { word: 'KEYS CUT', glazing: 'clear', awning: false, kerbside: 'none', interior: 0.3 },
  { word: 'DISCOUNT STORE', glazing: 'clear', awning: true, kerbside: 'crates', interior: 0.45 },
  { word: 'SANDWICH BAR', glazing: 'clear', awning: true, kerbside: 'aboard', interior: 0.5 },
  { word: 'FISH BAR', glazing: 'clear', awning: false, kerbside: 'sacks', interior: 0.7 },
  { word: 'CAR WASH', glazing: 'clear', awning: false, kerbside: 'none', interior: 0.2 },
  { word: 'PHARMACY', glazing: 'clear', awning: false, kerbside: 'none', interior: 0.5 },
  { word: "AL'S GRILL", glazing: 'clear', awning: false, kerbside: 'sacks', interior: 0.7 },
  { word: 'PARK CAFE', glazing: 'clear', awning: true, kerbside: 'aboard', interior: 0.5 },
  { word: 'STAR KEBAB', glazing: 'clear', awning: false, kerbside: 'sacks', interior: 0.75 },
  { word: 'ROSE & SON', glazing: 'clear', awning: false, kerbside: 'none', interior: 0.25 },
];

/* Held out of the deck and dealt once each, in this order, to the first
 * frontages in the walk order.
 *
 * The bar is here because it is what the critique is about. `world/neon.ts`
 * already hangs exactly one BAR / COLD BEER projecting sign, on the single
 * unit it finds with `light.kind === 'bar'` — that part was never duplicated.
 * What was duplicated is the *trade*: the fascia hash and the blade hash could
 * both land on FISH BAR or SANDWICH BAR anywhere on the street, so the street
 * carried several bars and the eye reads the neon as having been repeated.
 * Making the drinking trades unique-by-construction is the fix, and it is the
 * fix at the level the user described the problem.
 */
export const UNIQUE: readonly Trade[] = [
  { word: 'FISH BAR', unique: true, glazing: 'clear', awning: false, kerbside: 'sacks', interior: 0.7 },
  { word: 'OPEN 24 HRS', unique: true, glazing: 'clear', awning: false, kerbside: 'bins', interior: 1.0 },
  { word: 'TO LET', unique: true, glazing: 'papered', awning: false, kerbside: 'none', interior: 0 },
];

/** The words that must appear at most once anywhere on the street. */
export const UNIQUE_WORDS: readonly string[] = UNIQUE.map((t) => t.word);

/* A seeded shuffle.
 *
 * Not `h2` from glsl.ts, and not Math.random. This needs a generator that can
 * be stepped a known number of times and produce the same sequence in the
 * browser, in `node --experimental-strip-types`, and in the audit tool, so it
 * is written out: xorshift32, one line, no dependencies, deterministic
 * everywhere. A shuffle driven by a spatial hash instead would reintroduce
 * exactly the property being removed, which is that moving a building changes
 * who its neighbours are.
 */
function rng32(seed: number): () => number {
  let s = (seed | 0) || 0x2f6e2b1;
  return () => {
    s ^= s << 13; s |= 0;
    s ^= s >>> 17;
    s ^= s << 5; s |= 0;
    return ((s >>> 0) % 0x1000000) / 0x1000000;
  };
}

function shuffled<T>(src: readonly T[], next: () => number): T[] {
  const a = src.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Deal one trade to each frontage.
 *
 * `keys` is the frontages in walk order; the caller decides that order and must
 * make it stable, because it is the whole of the mechanism. The uniques go out
 * first, spaced across the street rather than to the first three frontages in
 * a row, then the deck is dealt and reshuffled as often as it runs out.
 *
 * @param keys stable identifiers, one per frontage, in a deterministic order
 * @param seed the block seed, so a reseeded street redeals rather than
 *   re-deriving the same parade
 */
export function dealTrades(keys: readonly string[], seed = 20260812): Map<string, Trade> {
  const next = rng32(seed);
  const out = new Map<string, Trade>();
  const n = keys.length;

  /* The uniques land at fixed fractions along the street rather than
   * consecutively, because three one-off businesses next door to each other is
   * its own kind of tell. The positions are rounded onto distinct slots and
   * the loop below simply skips anything already dealt, so a short street with
   * fewer frontages than uniques degrades to "some uniques do not appear",
   * which is correct — better an absent trade than a duplicated one. */
  const slots = new Set<number>();
  UNIQUE.forEach((t, i) => {
    let at = Math.round(((i + 0.5) / UNIQUE.length) * (n - 1));
    while (at < n && slots.has(at)) at++;
    if (at >= n) return;
    slots.add(at);
    out.set(keys[at], t);
  });

  let deck = shuffled(TRADES, next);
  let d = 0;
  for (let i = 0; i < n; i++) {
    if (out.has(keys[i])) continue;
    if (d >= deck.length) { deck = shuffled(TRADES, next); d = 0; }
    out.set(keys[i], deck[d++]);
  }
  return out;
}
