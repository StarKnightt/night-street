/* The massing of the block.
 *
 * This file decides only *where the boxes are* — how wide each building is,
 * how many storeys, how tall each storey, how far its face stands from the
 * building line, what it is built of and what is bolted to it. Nothing here
 * emits a triangle; facade.ts does that.
 *
 * Two things drive almost every number below, and neither is taste.
 *
 * The first is that the canyon is narrow. Kerb to kerb is 6.3 m and the
 * footways are 2.35 m, so the two building lines are 11.4 m apart and a
 * four-storey wall is taller than the street is wide. That ratio is the whole
 * reason a side street reads as a side street, and it means the eye sees the
 * lower two storeys of the far building and nothing else unless it looks up.
 *
 * The second is the hour. At 4.2 degrees a building throws its own height
 * times thirteen, so *everything* at street level is in shadow unless there is
 * a hole in the frontage for the sun to come through. That is not a defect to
 * be tuned around, it is what the reference photographs look like: a dim blue
 * canyon with the tops of one side burning and a couple of blazing shafts
 * where a cross street lets the light in. So the gaps in the sunward frontage
 * are load-bearing lighting design, and their width is derived rather than
 * chosen — see SUN_RUN below.
 */
import { DIMS } from './dims';
import { makeRng } from './noise';
import { frame, type Frame } from './emit';
import { SUN_DIR } from '@/scene/env';

/** Where a facade stands: the back edge of the footway. */
export const BUILD_LINE = DIMS.roadHalf + DIMS.kerbDepth + DIMS.walkWidth;   // 5.7 m

/** How deep the built volume is behind its facade. Never seen; it only has to
 *  be thick enough to stop the sun coming through the back of the block. */
export const BLOCK_DEPTH = 5.0;

/* Metres of travel along the street for every metre travelled across it, on a
 * ray headed for the sun. A gap in the frontage narrower than this times the
 * block depth is not a gap at all: the ray leaves the opening and buries
 * itself in the next building along before it ever clears the block. Every
 * cross street below is sized off this, which is why they are 11-18 m rather
 * than the 4-6 m that would look adequate in plan. */
export const SUN_RUN = Math.abs(SUN_DIR[2]) / Math.abs(SUN_DIR[0]);          // ~1.43

export type Palette = 0 | 1 | 2;      // 0 brick, 1 painted render, 2 stone

export type Bldg = {
  frame: Frame;
  /** Length along u. */
  L: number;
  /** Footway level at the facade. */
  base: number;
  /** Ground storey height, then upper storey height, then how many uppers. */
  gh: number; fh: number; nUp: number;
  /** Top of the main wall, relative to base. */
  H: number;
  /** Parapet above the wall top. */
  par: number;
  /** Cornice projection at the wall top, 0 for none. */
  cornice: number;
  /** String course at first floor level. */
  band: boolean;
  /** Facade plane offset from the building line, positive toward the street. */
  d0: number;
  /** Window lattice. */
  bays: number; bayW: number; winW: number; winH: number; sill: number; reveal: number;
  /** Ground floor opening rhythm — piers between, System 3 fills the rest. */
  pier: number; fascia: number; plinth: number;
  pal: Palette;
  seed: number;
  /** -1 for none, otherwise the bay the fire escape is centred on. */
  escape: number;
  /** Which end the downpipe runs down: 0 none, 1 low u, 2 high u, 3 both. */
  pipes: number;
};

export type Layout = {
  bldgs: Bldg[];
  /** Cross streets and vacant lots, in world z, for anything that needs them. */
  gaps: { side: number; z0: number; z1: number }[];
};

/* Palette by position rather than by dice alone.
 *
 * A real block is not a random shuffle. Brick dominates, painted render turns
 * up where somebody has refronted a building, and stone is rare and usually on
 * the corner or the one building that was built for a bank. Three consecutive
 * buildings in the same render colour is the tell, so the chooser also refuses
 * to repeat itself. */
function pickPalette(rng: () => number, prev: Palette): Palette {
  const r = rng();
  let p: Palette = r < 0.56 ? 0 : r < 0.88 ? 1 : 2;
  if (p === prev && rng() < 0.6) p = p === 0 ? 1 : 0;
  return p;
}

type RowStyle = {
  /** Storeys, inclusive. Total storeys is one more than nUp. */
  floors: [number, number];
  width: [number, number];
  seed: number;
};

function row(
  origin: Frame,
  span: number,
  gapsU: [number, number][],
  style: RowStyle,
  baseAt: (u: number) => number,
): Bldg[] {
  const rng = makeRng(style.seed);
  const out: Bldg[] = [];
  let u = 0;
  let prevPal: Palette = 2;

  const clear = (a: number, b: number) => !gapsU.some(([g0, g1]) => a < g1 && b > g0);
  const nextClear = (a: number) => {
    const hit = gapsU.find(([g0, g1]) => a >= g0 - 1e-6 && a < g1);
    return hit ? hit[1] : a;
  };

  let guard = 0;
  while (u < span - 4 && guard++ < 200) {
    u = nextClear(u);
    if (u >= span - 4) break;

    let L = style.width[0] + rng() * (style.width[1] - style.width[0]);
    // Do not straddle a cross street: stop short of it, and if the remainder
    // is too narrow to be a building, give the whole strip to the gap.
    const nextGap = gapsU.find(([g0]) => g0 >= u)?.[0] ?? span;
    if (u + L > nextGap) L = nextGap - u;
    if (u + L > span) L = span - u;
    if (L < 5.2) { u += L; continue; }
    if (!clear(u, u + L)) { u += 0.5; continue; }

    const nUp = style.floors[0] - 1 +
      Math.floor(rng() * (style.floors[1] - style.floors[0] + 1));
    /* Ground floors are taller than the storeys above them, always, and by a
     * lot — a shop needs headroom for a mezzanine and a sign. Equal storey
     * heights up a facade is one of the loudest CG-building tells there is. */
    const gh = 3.85 + rng() * 0.85;
    const fh = 2.98 + rng() * 0.62;
    const H = gh + nUp * fh;

    const pal = pickPalette(rng, prevPal);
    prevPal = pal;

    /* Bay rhythm. A bay is one window plus its pier, and on a nineteenth
     * century street it is remarkably consistent — 2.6 to 3.4 m — because it
     * is set by the span of the floor joists, not by taste. What varies is how
     * many of them a building got, which is why the widths above matter more
     * than the bay does. */
    const bayTarget = 2.62 + rng() * 0.74;
    const bays = Math.max(2, Math.round((L - 0.5) / bayTarget));
    const bayW = (L - 0.5) / bays;
    const winW = Math.min(1.62, bayW * (0.46 + rng() * 0.12));
    const winH = Math.min(fh - 1.25, 1.42 + rng() * 0.52);

    const base = baseAt(u + L * 0.5);

    out.push({
      /* Each building gets its own origin, slid along the row. Facades are
       * authored in a local frame whose u starts at zero, so the offset has to
       * live in the frame — a row of buildings all sharing the row's frame is
       * a row of buildings all standing in the same place. */
      frame: frame(origin.ox + origin.ux * u, origin.oz + origin.uz * u, origin.ux, origin.uz),
      L, base, gh, fh, nUp, H,
      par: 0.42 + rng() * 0.95,
      cornice: rng() < 0.62 ? 0.10 + rng() * 0.20 : 0,
      band: rng() < 0.74,
      /* Setback. Neighbouring facades are never quite coplanar: the building
       * line has been rebuilt piecemeal over a century and there is usually a
       * 50-200 mm step between one frontage and the next. Those steps are
       * where the party wall shows, and at four degrees each one throws a hard
       * vertical shadow the full height of the building. */
      d0: -(rng() * 0.34),
      bays, bayW, winW, winH,
      sill: 0.86 + rng() * 0.22,
      /* Reveal depth, and it was the number that decided whether the windows
       * survived past twenty metres.
       *
       * Half a brick — 112 mm — is what a solid nineteenth century wall
       * actually gives you, and at 130-240 mm the first pass was already
       * generous. It still was not enough: at forty metres a 150 mm reveal
       * subtends under a pixel and the jamb shadow inside it disappears
       * entirely, which is why the far end of the block read as black
       * rectangles painted on a wall. A box-sash frame set behind a lined
       * opening in a cavity wall genuinely sits 200-300 mm back, so this is
       * the deep end of honest rather than a fiction, and it is the single
       * change that keeps a window reading as a hole at street distance. */
      reveal: 0.20 + rng() * 0.12,
      pier: 0.42 + rng() * 0.40,
      fascia: 0.62 + rng() * 0.34,
      plinth: 0.34 + rng() * 0.30,
      pal, seed: rng(),
      escape: -1,
      pipes: rng() < 0.72 ? (rng() < 0.5 ? 1 : 2) : 0,
    });

    u += L;
  }
  return out;
}

/**
 * The whole block.
 *
 * `baseAt` is the footway height at the building line, passed in rather than
 * imported so this file stays free of the paving geometry.
 */
export function layoutBlock(baseAt: (x: number, z: number) => number): Layout {
  const B = BUILD_LINE;
  const zHead = 22, zTail = -118;

  /* Cross streets, and the sizes are derived rather than chosen.
   *
   * A ray to the sun crosses the block at SUN_RUN metres of z per metre of x,
   * so clearing BLOCK_DEPTH of building needs SUN_RUN * BLOCK_DEPTH ~ 7.2 m of
   * opening before the ray re-enters the frontage further down. Anything
   * narrower is a slot that looks like a cross street in plan and delivers no
   * light at all. Both sunward gaps are comfortably over that; the one on the
   * shaded side is decorative and can be as narrow as it likes.
   */
  const gaps = [
    /* 18 m rather than the 8 m it looks like it needs. Two separate
     * requirements set this: the ray has to clear 5 m of block, which costs
     * 7.2 m of opening on its own, and the *disc* has to be visible from the
     * middle capture stop, which means the opening must still be there where
     * the sightline from that stop crosses the frontage — at z = -44.6. Both
     * together give an opening from -44 to -62, and the payoff is an eleven
     * metre band of direct sun laid across the carriageway between seven and
     * twelve metres in front of the camera. */
    { side: +1, z0: -64.0, z1: -40.0 },     // cross street — the main shaft
    { side: +1, z0: -99.0, z1: -81.0 },     // vacant lot
    { side: -1, z0: -72.6, z1: -68.5 },     // service alley: a dark slot, no sun
    /* Wide enough to matter, and sized off the stops rather than off the plan.
     *
     * A gap lights the carriageway between gapMin + 15.3 and gapMax + 8.15 —
     * the first number is where a ray that has just cleared the far corner
     * lands, the second where one grazing the near corner does. Everything
     * outside that eleven-to-seventeen metre band is in the frontage's own
     * shadow. Those two bands and the far cross street are the only direct sun
     * that reaches street level anywhere on the walk, so which stops can see
     * one is decided here and nowhere else. As laid out: -49 to -32, which
     * stops two and three look straight down, and -84 to -73, which stops four
     * and five do. */
    { side: +1, z0: -118.0, z1: -102.0 },   // the far cross street
  ];

  const toU = (side: number, z0: number, z1: number): [number, number] =>
    side > 0 ? [zHead - z1, zHead - z0] : [z0 - zTail, z1 - zTail];

  const span = zHead - zTail;

  /* The sunward side is deliberately the low one, and the first pass did not
   * take that anywhere near far enough.
   *
   * Which frontage is which is not arbitrary: the sun bears +X and -Z, so the
   * +X row is what shadows everything, and how tall it is decides how much of
   * the opposite wall is still lit. The arithmetic is exact and it is worth
   * writing down, because it is what the whole hour depends on.
   *
   * A ray grazing the parapet of an east building of height h lands on the
   * west wall 11.4 m away at h - 11.4 * 0.128 = h - 1.46, and it lands 16.3 m
   * further down the street, because at this azimuth the shadow runs 1.43 m
   * along z for every metre across x. So the shade line on the west wall at
   * any point is set by whatever stands opposite and sixteen metres behind.
   *
   * With both rows at three and four storeys that line came out at 11-14 m —
   * above the top of the frame. A camera at 1.65 m with a 45-degree lens sees
   * the opposite wall only up to about 6.4 m without tilting up, so every
   * eye-level frame showed shaded wall on both sides and nothing else, which
   * is exactly what the critique reported: the sun reading as a light down the
   * barrel of the street rather than as a raking light.
   *
   * Two, three and four storeys on the east side puts the shade line anywhere
   * between 5.4 m and 14 m depending on which building is opposite — a ragged,
   * stepped boundary that is in frame for much of the walk, and which is what
   * a low sun on a real street of unequal buildings actually draws.
   */
  const east = row(
    frame(B, zHead, 0, -1), span,
    gaps.filter((g) => g.side > 0).map((g) => toU(+1, g.z0, g.z1)).sort((a, b) => a[0] - b[0]),
    /* One to four storeys, and the range matters more than the mean.
     *
     * Two and three put the shade line on the wall opposite at 6.0 and 9.4 m,
     * and both of those are above the top of a level 45-degree frame until the
     * wall is fifteen metres away — which is why the last round produced a
     * near frontage lit from parapet to pavement with no boundary crossing it
     * anywhere. What draws a boundary *through* the visible part of a wall is
     * a low building opposite: a single-storey workshop or garage at 4.5 m
     * puts the line at 3.3 m, right across the middle of the elevation.
     *
     * Mixing all four heights along the row is what makes the boundary ragged
     * rather than straight. It steps at every party wall, because the height
     * of the line at any point is set by whatever happens to be standing
     * opposite and sixteen metres back, and that changes every ten metres. */
    /* Narrower than the shaded row, and narrower than last round.
     *
     * The number of steps in the shade line across a frame is just the number
     * of party walls the sun passes over, so it is set by the plot width on this
     * row alone. At 7.5-15.5 m a frame showing twenty-five metres of opposite
     * frontage got two boundaries if it was lucky, which is why the result read
     * as one long edge with a kink rather than as a staircase. Five to eleven
     * metres is still a plausible city plot and roughly doubles the count. */
    { floors: [1, 4], width: [5.2, 11.0], seed: 91117 },
    (u) => baseAt(B, zHead - u),
  );

  /* Rear ranges behind the sunward frontage.
   *
   * Dropping that frontage to two and three storeys is what puts the shade
   * line on the opposite wall back inside the frame, and it costs something:
   * from the near footway the eye now goes straight over it, and what it found
   * was the hazed ground plane between the back of the block and the next
   * street — a pale band of sky-coloured nothing sitting under the buildings,
   * which is the "floating props" read all over again.
   *
   * What is actually behind a shallow city block is more building: back
   * additions, workshops, a yard wall. One and two storeys of it at 12.6 m
   * fills the band without touching the skyline.
   *
   * Where the holes in it go is not free. A ray that lands on the visible
   * carriageway is 1.43 m further down the street for every metre it is out,
   * so the corridor at 12.6 m is the frontage gap shifted by 1.43 times the
   * 6.9 m between them — very nearly ten metres. Line the openings up with the
   * frontage instead and the rear range walls off every shaft in the scene.
   */
  const shift = SUN_RUN * (12.6 - B);
  const backland = row(
    frame(12.6, zHead, 0, -1), span,
    gaps.filter((g) => g.side > 0)
      .map((g) => toU(+1, g.z0 - shift - 2, g.z1 - shift + 2))
      .sort((a, b) => a[0] - b[0]),
    { floors: [1, 2], width: [6.5, 15.0], seed: 66071 },
    (u) => baseAt(B, zHead - u),
  ).map((b) => ({ ...b, escape: -1, pipes: 0 }));

  const west = row(
    frame(-B, zTail, 0, +1), span,
    gaps.filter((g) => g.side < 0).map((g) => toU(-1, g.z0, g.z1)).sort((a, b) => a[0] - b[0]),
    { floors: [4, 5], width: [8.0, 16.0], seed: 40639 },
    (u) => baseAt(-B, zTail + u),
  );

  /* Fire escapes go on the shaded row, and that is the point of them.
   *
   * A fire escape is only worth building if its shadow lands somewhere. On the
   * sunward row the whole street elevation faces away from the sun and the
   * ironwork would sit in flat shade contributing nothing but silhouette. On
   * the shaded row the upper two storeys are in direct sun, so the stairs
   * throw their lacy shadow across brickwork that is lit — which is the single
   * most recognisable thing in a low-sun photograph of a city street. */
  const escapeOn = [1, 3, 5, 6, 8];
  west.forEach((b, i) => {
    if (escapeOn.includes(i) && b.nUp >= 3 && b.L > 8.5) {
      b.escape = Math.max(1, Math.floor(b.bays / 2) - 1);
    }
  });
  // One on the near row too, seen almost edge-on, for the silhouette.
  if (east[2] && east[2].nUp >= 2) east[2].escape = Math.max(1, Math.floor(east[2].bays / 2));

  /* The far side of the main cross street.
   *
   * Visible only through the 12 m opening, and its whole job is to stop that
   * opening reading as a hole punched through to nothing. It faces -X so it is
   * in full sun, which is exactly what a real cross street does at this hour:
   * the slot in the frontage is filled with a burning orange wall twenty
   * metres back. It sits well clear of the sun corridor — a ray leaving the
   * road through the gap is past z = -75 by the time it reaches this x. */
  /* The far side of the cross street, and the reason it is in three pieces.
   *
   * Looking sideways through a twelve-metre hole in the frontage, the eye goes
   * a long way, and with nothing out there it went all the way to the hazed
   * edge of the ground plane — a bare horizon line in the middle of a city
   * block, which is worse than the hole was. So the cross street gets a far
   * frontage like any other street.
   *
   * Where it can stand is not a choice. The sun corridor is the wedge of rays
   * that reach the visible road through the gap, and it can be written down: a
   * ray landing at z on the carriageway is at z - 1.43x when it is x metres
   * out, so the corridor crosses x = 20 between z = -64 and -83 and crosses
   * x = 36 between z = -87 and -105. Every block below stops short of its own
   * crossing. Get this wrong by five metres and the shaft — which is the only
   * direct sun anywhere near the camera — goes out.
   */
  const across = [
    ...row(frame(20.0, -14, 0, -1), 45, [],
      { floors: [3, 4], width: [9, 16], seed: 7723 }, () => 0.05),
    /* Behind the vacant lot, and it is doing the lot's own job. An eighteen
     * metre hole in the frontage with nothing behind it is not a vacant lot,
     * it is a missing wall — at the fifth stop it removed the entire right
     * hand side of the picture and left the horizon showing through. What
     * makes a gap site read as a gap site is seeing the back of the next
     * street through it. */
    ...row(frame(20.0, -78, 0, -1), 24, [],
      { floors: [3, 4], width: [9, 14], seed: 8831 }, () => 0.05),
    /* Deliberately low. This one sits square in the path of the light that
     * grazes the tops of the near frontage, so it has to duck under it: two
     * and three storeys, where the ray is already sixteen metres up. */
    ...row(frame(36.0, -21, 0, -1), 60, [],
      { floors: [2, 3], width: [10, 18], seed: 9137 }, () => 0.05),
  ].map((b) => ({ ...b, escape: -1 }));

  /* Depth behind the cross street.
   *
   * Two more frontages further out, purely so that what shows through the gap
   * is a city rather than one wall with the horizon behind it. They are far
   * enough away to be half-dissolved in haze, which is the point: a receding
   * stack of roofs at decreasing contrast is most of what says "this street is
   * in a town" in a photograph.
   *
   * They cost nothing in light. The shadow camera is a thirty-metre box that
   * follows the walker, so anything past about thirty-five metres out is
   * outside the map and casts nothing at all — which for once is the behaviour
   * we want, because at four degrees a five-storey building a hundred metres
   * upsun would otherwise put the entire scene in shade.
   */
  const behind = [
    ...row(frame(52.0, -8, 0, -1), 96, [],
      { floors: [3, 5], width: [10, 20], seed: 13309 }, () => 0.05),
    ...row(frame(72.0, -26, 0, -1), 110, [],
      { floors: [3, 5], width: [12, 22], seed: 24799 }, () => 0.05),
  ].map((b) => ({ ...b, escape: -1, pipes: 0 }));

  /* The end of the street, in two overlapping faces rather than one.
   *
   * Without something here the carriageway runs to a mathematical vanishing
   * point and the whole scene reads as a desert highway, which is currently
   * its single biggest defect. One flat wall across the end would fix that and
   * would also wall off the last cross street: at this sun angle the ray that
   * lights the far end of the road crosses z = -118 at about x = 18, so a
   * continuous face would take the light out of the last twenty-five metres of
   * street. Two faces, one at -118 reaching from the left to x = 8 and one set
   * back to -132 covering x = 4 to 24, overlap enough to close the view
   * completely from anywhere on the walk while leaving the corridor at x > 8
   * open. It also composes better than a flat backdrop: the offset between
   * them reads as the street running on into a junction rather than stopping.
   */
  const term = [
    ...row(frame(8, -118, -1, 0), 38, [],
      { floors: [4, 5], width: [11, 19], seed: 55291 }, () => 0.05),
    ...row(frame(24, -132, -1, 0), 20, [],
      { floors: [3, 5], width: [9, 14], seed: 30977 }, () => 0.05),
  ].map((b) => ({ ...b, escape: -1 }));

  return { bldgs: [...east, ...west, ...backland, ...across, ...behind, ...term], gaps };
}
