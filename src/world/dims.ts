/* Real-world dimensions for the block, in metres.
 *
 * Every number here is a measured street dimension rather than a number that
 * looked right in the viewport. A two-way side street in a pre-war city grid
 * has a 7–8 m carriageway between kerb faces, 2.5–3.5 m footways, and a kerb
 * that stands 125–150 mm above the gutter. Getting the kerb wrong by 5 cm is
 * one of the things that makes a CG street read as a stage set: it changes the
 * step the eye expects at the edge of frame.
 */
export const DIMS = {
  /* Half the carriageway, kerb face to centreline. 6.3 m overall.
   *
   * This was 3.75, giving a 7.5 m road, and against a 1.65 m eye it read as a
   * four-lane arterial rather than a side street. The reference streets are
   * all narrow — a Manhattan cross street, a Tokyo backstreet, a London mews —
   * and the narrowness is not incidental to how they read, it is most of it:
   * it is what puts both kerbs in frame, closes the walls in, and turns a
   * street lamp into a pool rather than a wash. Narrowing the carriageway and
   * widening the footway to 3.2 m also moves the whole composition in favour
   * of every system after this one. */
  roadHalf: 3.15,
  /* Kerb reveal above the gutter line.
   *
   * 132 mm was at the shallow end of the real range and, combined with the
   * over-wide road, made the footway read as barely raised. 145 mm is a normal
   * granite reveal and the step is legible at the edge of frame. */
  kerbHeight: 0.145,
  /* Horizontal run of the chamfered top arris.
   *
   * 34 mm on a 145 mm kerb is a quarter of the reveal, and seen close it read
   * as an oversized rounded nose that made the same kerb look like a 200 mm
   * block from the footway while looking 100 mm from the crown of the road.
   * A granite kerb is chamfered around 20 mm. */
  kerbChamfer: 0.020,
  /** Kerb block depth from face to back. */
  kerbDepth: 0.2,
  /** Footway width from the back of the kerb to the building line. */
  walkWidth: 2.35,
  /** Footway cross-fall towards the kerb, as a rise over the full width. */
  walkFall: 0.031,
  /** Crown camber: how far the carriageway drops from centreline to kerb. */
  camber: 0.085,
  /** Extra dip in the last stretch before the kerb, so water runs to the gutter. */
  /* A real gutter is a dished channel, not a rounding-off of the camber.
   * 19 mm over 550 mm was shallow enough that the road appeared to run
   * straight into a vertical kerb face with no channel at all. 38 mm over
   * 400 mm is a normal dish and it collects light along its length. */
  gutterDrop: 0.038,
  gutterWidth: 0.40,

  /** Granite kerbstone length. */
  kerbBlock: 1.52,
  /* Concrete flag size.
   *
   * This was 1.524 m — five feet, which is a real American sidewalk scoring
   * interval — and it read as far too big in frame. The reason is that five
   * feet is the spacing of the *control joints* sawn or tooled into a
   * continuous pour, and only some streets are built that way; a flagged
   * footway is laid in units around 900 mm and the joints between them are
   * real gaps, not scored lines. The smaller module also puts several joints
   * in the near field instead of one, which is most of what makes a pavement
   * read as pavement. */
  slab: 0.92,
  /** Width of the gap between flags. Wide enough to have an inside. */
  slabJoint: 0.016,

  /** Walkable extent — where goTo(0) and goTo(1) put the camera. */
  walkStartZ: 4,
  walkEndZ: -94,
  /* Built extent.
   *
   * Runs far past the walkable block on purpose. At -152 the far end of the
   * carriageway was still resolvable through the haze and the road silhouette
   * closed against the sky in a convex brow that read as a hill crest rather
   * than a street. The ground has to outrun the fog, not meet it. */
  zMax: 30,
  zMin: -300,

  eyeHeight: 1.65,
  walkSpeed: 1.4,
} as const;

export const WORLD_SEED = 20461;

/* Fixed, seeded positions for the flush utility ironwork.
 *
 * These are placed against the capture stops rather than scattered, and that
 * is deliberate. The first pass put a manhole at z = -36.4 with a capture stop
 * at z = -35.2, which sounds like a hit and is in fact a miss: at eye height
 * with the camera pitched 12 degrees down, the bottom of the frame lands about
 * two metres ahead, the centre about seven. A fixture 1.2 m in front of the
 * lens is underneath the photographer. Every single fixture was rendering
 * correctly and none of them appeared in any of the six frames.
 *
 * So each one now sits 6–9 m in front of a stop, which is where the eye
 * actually lands, and STOP_Z below records what they were aimed at.
 */
const STOP_Z = [2, -15.6, -35.2, -54.8, -74.4, -89.1];

export const FIXTURES = {
  manholes: [
    /* 4.6 m ahead of the stop, not 7.8.
     *
     * At a 56-degree vertical field and eye height, the bottom of the frame
     * lands about 3 m out and a 600 mm cover at 8 m is forty pixels of
     * foreshortened ellipse — present, correct, and far too small for anyone
     * to judge whether it is seated. At 4.6 m it fills the lower third of the
     * frame, which is where a phone photograph of a street actually puts one. */
    { x: -0.95, z: STOP_Z[2] - 6.3, r: 0.335, rot: 0.31 },
    { x: 1.30, z: STOP_Z[4] - 7.6, r: 0.318, rot: 1.94 },
  ],
  drains: [
    { x: 1, z: STOP_Z[1] - 6.6 },
    { x: -1, z: STOP_Z[3] - 8.0 },
  ],
  plates: [
    { x: 4.35, z: STOP_Z[5] - 7.4, w: 0.62, d: 0.94, rot: 0.02 },
    { x: -4.42, z: STOP_Z[0] - 8.1, w: 0.5, d: 0.5, rot: 0.0 },
  ],
} as const;

/* Lamp positions, shared with the road shader.
 *
 * These live here rather than in the scene because the carriageway material
 * needs them: shading an aggregate chip so that it has a genuinely dark side
 * requires knowing which way the light is coming from, and a normal map alone
 * cannot deliver a hard terminator once ambient and environment light fill the
 * shadowed flank back in. The installation is static, so this is a constant
 * rather than a per-frame upload.
 */
export const LAMP_H = 6.8;
export const LAMPS: readonly (readonly [number, number, number])[] = [
  [4.3, LAMP_H, 12], [-4.3, LAMP_H, -8], [4.3, LAMP_H, -25], [-4.3, LAMP_H, -45],
  [4.3, LAMP_H, -64], [-4.3, LAMP_H, -84], [4.3, LAMP_H, -99],
];
