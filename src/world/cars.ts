/* System 4: parked cars.
 *
 * The brief asks for "convincing dark shapes with reflective windows and tail
 * lights", and the scope limit is real — nothing here is a car model. What is
 * not negotiable is the silhouette, because a car is the most familiar object
 * a viewer of this scene will ever have looked at. A kerb 20 mm too tall reads
 * as a kerb; a greenhouse 100 mm too tall reads as a toy. So every body is a
 * loft through measured stations rather than a box with the corners taken off,
 * and the numbers below are real vehicle dimensions:
 *
 *   supermini  3.95 x 1.70 x 1.47   wheelbase 2.45   15" rim, 300 mm tyre
 *   hatchback  4.20 x 1.75 x 1.46   wheelbase 2.60   16" rim, 318 mm tyre
 *   estate     4.62 x 1.79 x 1.50   wheelbase 2.68   17" rim, 322 mm tyre
 *   saloon     4.70 x 1.80 x 1.45   wheelbase 2.79   17" rim, 328 mm tyre
 *   panel van  5.00 x 1.90 x 2.10   wheelbase 3.10   16" rim, 340 mm tyre
 *
 * with the rocker 150-185 mm off the ground and the arch struck at 1.19 times
 * the tyre radius, which leaves the 60-75 mm crescent of shadow between tyre
 * and arch that a real parked car has and that a floating one does not.
 *
 * ── How the body is built ────────────────────────────────────────────────
 *
 * One closed loft. Each station along the car is a 28-point closed section in
 * (lateral, height), and every dimension of that section — sill width, maximum
 * width at the shoulder, beltline height, roof height and roof width — is a
 * curve in u, the fraction of the length from the nose. The windscreen is not
 * modelled as a panel: it is the part of the surface where the roof curve
 * climbs away from the deck curve, which is what a windscreen physically is,
 * and it means the screen, the A-pillars and the cowl cannot disagree about
 * where they meet. Same for the backlight at the other end.
 *
 * Which cells are glass, lamp, arch liner or paint is then a pure function of
 * (station, section index), so the pillars fall out of the same grid rather
 * than being placed against it. Glass cells are emitted twice: once 5 mm in,
 * as the dark cabin the pane is seen against, and once 10 mm out, into the
 * separate glazing geometry.
 *
 * Normals are computed on the grid from the two surface tangents and shared by
 * every cell that touches a vertex. That is the one thing in this project that
 * cannot use `Emit`: emit.ts computes a flat normal per quad, which is correct
 * for architecture and catastrophic here — a faceted clearcoat under a raking
 * sun is a row of separate highlights, and the single most reliable tell that
 * something is a low-polygon model is a body panel with edges in it.
 *
 * ── Placement ────────────────────────────────────────────────────────────
 *
 * Cars are placed against the capture stops, not hashed from a seed. See
 * PARKED at the bottom of the file for what each one is doing and why it is
 * where it is.
 */
import * as THREE from 'three';
import { roadHeight } from './geometry';
import { DIMS } from './dims';

/* ── Material part codes ────────────────────────────────────────────────── */

/** Branches in the car body shader. */
export const CAR = {
  PAINT: 0,     // the painted skin: two-lobe clearcoat over body colour
  TRIM: 1,      // bumpers, sills, rubbing strips, mirror shells
  ARCH: 2,      // wheel-arch liner: the dark cavity behind the tyre
  UNDER: 3,     // the floor pan, seen only as the dark under the car
  LAMP_R: 4,    // rear cluster: red plastic with a prism structure
  LAMP_F: 5,    // headlamp: clear cover over a dark reflector
  CABIN: 6,     // what a pane is seen against — interior, and daylight through
  PLATE: 7,     // number plate
  GRILLE: 8,    // radiator grille
  /* The nose and tail end panels, which are their own codes because they are
   * the one part of the body that is not a quad strip.
   *
   * Closing the loft with a triangle fan to a centre point makes wedges, and a
   * wedge classified by the height of its outer edge paints a radial pinwheel
   * across the back of the car — bumper wedges reaching up to the middle of
   * the tailgate, paint wedges reaching down to the valance. It rendered as a
   * dark bowtie across the rear of every car in the street and it is the
   * clearest single argument for classifying a surface in the shader from an
   * interpolated coordinate rather than in the builder from a per-face one.
   * These two carry the section's lateral coordinate in uv.x instead of the
   * along-car distance, which is constant on an end panel and useless, and the
   * shader decides bumper, lamp, grille or paint per pixel. */
  CAP_R: 9,
  CAP_F: 10,
  /* The scuttle: the band of matte black between the back of the bonnet and
   * the bottom of the windscreen, with the wiper trough in it.
   *
   * It is fifty millimetres of plastic and it is here because the critic could
   * not find the base of the windscreen on any car in the near field. The step
   * at the cowl — painted metal, then a hard edge, then a much darker and much
   * glossier plane — is the single most recognisable thing about a car seen
   * from the footway, and with the bonnet lofting continuously into the screen
   * there was nothing to mark it but the glass being a different material,
   * which failed the moment the glass was too bright. A dark matte strip
   * between the two states the edge in albedo as well, so it survives whatever
   * the light is doing. */
  SCUTTLE: 11,
  /* The door mirror's own glass. It is its own code because it is the one
   * part of a car that is a first-order mirror of what is *behind* the car,
   * and because 120 mm of aluminised glass at two metres is the difference
   * between a mirror and a beige box with a smaller beige box behind it. */
  MIRROR: 12,
} as const;

/** Branches in the glazing shader. */
export const PANE = { SCREEN: 0, SIDE: 1, REAR: 2 } as const;

/** Branches in the wheel shader. */
export const WHL = { TREAD: 0, WALL: 1, RIM: 2, HUB: 3, PATCH: 4 } as const;

type V3 = [number, number, number];

/* ── A smooth-shaded indexed hull ───────────────────────────────────────── */

/**
 * The same idea as `Emit`, with explicit per-vertex normals.
 *
 * Everything else in this project is planar and takes its normal from the quad
 * it belongs to. A car body is the exception, so vertices carry a normal
 * computed from the loft's own tangents. Attributes work the same way: set
 * once, carried by every vertex until set again.
 */
class Hull {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly uv: number[] = [];
  readonly idx: number[] = [];
  private readonly spec: [string, number][] = [];
  private readonly data: Record<string, number[]> = {};
  private readonly cur: Record<string, number[]> = {};

  constructor(spec: Record<string, number>) {
    for (const [k, size] of Object.entries(spec)) {
      this.spec.push([k, size]);
      this.data[k] = [];
      this.cur[k] = new Array(size).fill(0);
    }
  }

  attr(name: string, ...v: number[]): this {
    this.cur[name] = v;
    return this;
  }

  get vertexCount() { return this.pos.length / 3; }
  get triangleCount() { return this.idx.length / 3; }

  vert(p: V3, n: V3, u: number, v: number): number {
    const i = this.vertexCount;
    this.pos.push(p[0], p[1], p[2]);
    this.nor.push(n[0], n[1], n[2]);
    this.uv.push(u, v);
    for (const [k] of this.spec) this.data[k].push(...this.cur[k]);
    return i;
  }

  /** Four corners counter-clockwise seen from outside, each with its own normal. */
  quad(
    a: V3, na: V3, b: V3, nb: V3, c: V3, nc: V3, d: V3, nd: V3,
    uvs: readonly [number, number][],
  ): void {
    const i = this.vert(a, na, uvs[0][0], uvs[0][1]);
    this.vert(b, nb, uvs[1][0], uvs[1][1]);
    this.vert(c, nc, uvs[2][0], uvs[2][1]);
    this.vert(d, nd, uvs[3][0], uvs[3][1]);
    this.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }

  /** A flat triangle, for caps and for anything that genuinely has an edge. */
  tri(a: V3, b: V3, c: V3, uvs: readonly [number, number][]): void {
    const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2];
    const fx = c[0] - a[0], fy = c[1] - a[1], fz = c[2] - a[2];
    let nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
    const l = Math.hypot(nx, ny, nz) || 1;
    const n: V3 = [nx / l, ny / l, nz / l];
    const i = this.vert(a, n, uvs[0][0], uvs[0][1]);
    this.vert(b, n, uvs[1][0], uvs[1][1]);
    this.vert(c, n, uvs[2][0], uvs[2][1]);
    this.idx.push(i, i + 1, i + 2);
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    for (const [k, size] of this.spec) {
      g.setAttribute(k, new THREE.Float32BufferAttribute(this.data[k], size));
    }
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

/* ── Profile curves ─────────────────────────────────────────────────────── */

type Curve = readonly (readonly [number, number])[];

/* Smoothstep between keys rather than linear.
 *
 * A linear interpolation puts a crease at every keyframe, and on a surface
 * with a mirror finish a crease is a hard line of highlight that no real panel
 * has. Smoothstep costs a slight flat spot at each key instead, which on a car
 * body is what a panel actually does between its feature lines. It also cannot
 * overshoot, which a spline can — an overshoot in the roof curve would put a
 * bulge in the windscreen. */
function at(c: Curve, u: number): number {
  if (u <= c[0][0]) return c[0][1];
  const n = c.length;
  if (u >= c[n - 1][0]) return c[n - 1][1];
  for (let i = 1; i < n; i++) {
    if (u <= c[i][0]) {
      const [u0, v0] = c[i - 1], [u1, v1] = c[i];
      const t = (u - u0) / Math.max(1e-6, u1 - u0);
      return v0 + (v1 - v0) * t * t * (3 - 2 * t);
    }
  }
  return c[n - 1][1];
}

export type CarKind = 'supermini' | 'hatch' | 'estate' | 'saloon' | 'van';

type Shape = {
  len: number; wide: number; high: number;
  frontOh: number; wheelbase: number;
  wheelR: number; rimR: number; tyreW: number; trackHalf: number;
  /** Bottom of the rocker above the ground at its lowest. */
  rocker: number;
  /** Beltline / bonnet / boot deck height. */
  deck: Curve;
  /** Top of the greenhouse; equal to `deck` where there is no cabin. */
  roof: Curve;
  /** Half-width at the shoulder, the widest point of the section. */
  hw: Curve;
  /** Bottom edge of the outer skin, before the arches are cut into it. */
  sill: Curve;
  /** Roof half-width as a fraction of `hw`. */
  roofW: number;
  /** Side glass: the daylight opening, and the pillars that interrupt it. */
  dlo: [number, number];
  pillars: readonly (readonly [number, number])[];   // centre u, width in u
  screen: [number, number];
  rear: [number, number];
  /** Rear lamp cluster: from this u back, between these heights. */
  lampU: number; lampY: [number, number];
  headU: number; headY: [number, number];
  /** Door shut lines, in u. */
  doors: readonly number[];
  /* Every panel gap that runs *across* the car, in u, as a real groove in the
   * surface rather than a dark line drawn on it.
   *
   * Defaults to the two bumper parting lines and the door shuts, which is what
   * a saloon or a hatchback has. A van says so itself, because its rear doors
   * and its sliding door are nowhere near a car's. */
  gaps?: readonly number[];
};

/* Every curve below is in metres against the u fraction of the car's length.
 *
 * The two that decide whether the thing reads as a car are `deck` and `roof`,
 * and specifically the distance between them: the greenhouse is a third of the
 * overall height on a modern hatchback and about 30 per cent on a saloon. Both
 * of these have been drawn against that and not against what filled the
 * viewport. The windscreen rake follows from where the roof curve leaves the
 * deck curve and where it arrives — 1.1 m of run for 0.54 m of rise is 64
 * degrees off vertical, which is a current windscreen; a 1970s one is 45.
 *
 * The deck curves are a second pass. The first ones left the greenhouse at 36
 * per cent of the height with a beltline that ran level from the A-pillar to
 * the tail, and the critic read the result as a 1985 estate: a greenhouse to
 * body ratio of about 1:2 with no waistline kick in it. They now rise 80 to 90
 * millimetres between the cowl and the C-pillar, which puts the greenhouse at
 * 29 to 30 per cent and — the part that actually reads at this sun angle —
 * makes the beltline a line that climbs rather than a level datum. The roof
 * curves are untouched, so the windscreen rake and the roofline are the ones
 * that were signed off; all that has moved is where the glass starts.
 */
const SHAPES: Record<CarKind, Shape> = {
  hatch: {
    len: 4.20, wide: 1.75, high: 1.46,
    frontOh: 0.85, wheelbase: 2.60,
    wheelR: 0.318, rimR: 0.205, tyreW: 0.205, trackHalf: 0.755, rocker: 0.155,
    deck: [[0, 0.700], [0.04, 0.755], [0.12, 0.838], [0.22, 0.878], [0.32, 0.915],
      [0.50, 0.998], [0.70, 1.036], [0.86, 1.056], [0.95, 1.044], [1, 0.985]],
    roof: [[0, 0.700], [0.04, 0.755], [0.12, 0.838], [0.22, 0.878], [0.32, 0.915],
      [0.38, 1.075], [0.46, 1.300], [0.53, 1.415], [0.60, 1.455], [0.80, 1.460],
      [0.86, 1.452], [0.90, 1.400], [0.95, 1.180], [1, 0.950]],
    hw: [[0, 0.520], [0.03, 0.665], [0.09, 0.790], [0.18, 0.858], [0.30, 0.875],
      [0.72, 0.875], [0.86, 0.860], [0.94, 0.805], [0.98, 0.715], [1, 0.580]],
    sill: [[0, 0.360], [0.03, 0.300], [0.08, 0.215], [0.16, 0.166], [0.30, 0.155],
      [0.74, 0.155], [0.87, 0.172], [0.95, 0.238], [1, 0.350]],
    roofW: 0.735,
    dlo: [0.435, 0.855], pillars: [[0.615, 0.055]],
    screen: [0.325, 0.585], rear: [0.875, 0.985],
    lampU: 0.945, lampY: [0.760, 1.020],
    headU: 0.055, headY: [0.610, 0.800],
    doors: [0.400, 0.615, 0.855],
  },
  supermini: {
    len: 3.95, wide: 1.70, high: 1.47,
    frontOh: 0.78, wheelbase: 2.45,
    wheelR: 0.300, rimR: 0.190, tyreW: 0.185, trackHalf: 0.730, rocker: 0.150,
    deck: [[0, 0.700], [0.04, 0.760], [0.12, 0.845], [0.22, 0.888], [0.32, 0.925],
      [0.50, 1.004], [0.70, 1.042], [0.86, 1.060], [0.95, 1.048], [1, 0.990]],
    roof: [[0, 0.700], [0.04, 0.760], [0.12, 0.845], [0.22, 0.888], [0.31, 0.925],
      [0.37, 1.090], [0.45, 1.320], [0.52, 1.435], [0.59, 1.468], [0.79, 1.470],
      [0.85, 1.460], [0.89, 1.405], [0.95, 1.190], [1, 0.960]],
    hw: [[0, 0.505], [0.03, 0.645], [0.09, 0.770], [0.18, 0.833], [0.30, 0.850],
      [0.72, 0.850], [0.86, 0.836], [0.94, 0.782], [0.98, 0.695], [1, 0.565]],
    sill: [[0, 0.355], [0.03, 0.295], [0.08, 0.210], [0.16, 0.161], [0.30, 0.150],
      [0.74, 0.150], [0.87, 0.168], [0.95, 0.232], [1, 0.345]],
    roofW: 0.730,
    dlo: [0.430, 0.845], pillars: [[0.605, 0.055]],
    screen: [0.315, 0.575], rear: [0.865, 0.985],
    lampU: 0.940, lampY: [0.770, 1.030],
    headU: 0.058, headY: [0.615, 0.805],
    doors: [0.395, 0.605, 0.845],
  },
  estate: {
    len: 4.62, wide: 1.79, high: 1.50,
    frontOh: 0.88, wheelbase: 2.68,
    wheelR: 0.322, rimR: 0.210, tyreW: 0.210, trackHalf: 0.770, rocker: 0.155,
    deck: [[0, 0.705], [0.04, 0.762], [0.12, 0.845], [0.22, 0.885], [0.31, 0.922],
      [0.50, 1.002], [0.70, 1.046], [0.86, 1.068], [0.95, 1.060], [1, 1.010]],
    roof: [[0, 0.705], [0.04, 0.762], [0.12, 0.845], [0.22, 0.885], [0.31, 0.922],
      [0.37, 1.090], [0.45, 1.330], [0.52, 1.450], [0.58, 1.492], [0.90, 1.500],
      [0.945, 1.470], [0.975, 1.330], [1, 1.060]],
    hw: [[0, 0.530], [0.03, 0.680], [0.09, 0.805], [0.18, 0.874], [0.30, 0.895],
      [0.75, 0.895], [0.90, 0.884], [0.96, 0.830], [0.99, 0.740], [1, 0.640]],
    sill: [[0, 0.360], [0.03, 0.300], [0.08, 0.216], [0.16, 0.166], [0.30, 0.155],
      [0.76, 0.155], [0.89, 0.174], [0.96, 0.240], [1, 0.355]],
    roofW: 0.745,
    dlo: [0.420, 0.925], pillars: [[0.590, 0.052], [0.745, 0.048]],
    screen: [0.315, 0.575], rear: [0.945, 0.995],
    lampU: 0.955, lampY: [0.800, 1.290],
    headU: 0.055, headY: [0.615, 0.805],
    doors: [0.385, 0.590, 0.745, 0.925],
  },
  saloon: {
    len: 4.70, wide: 1.80, high: 1.45,
    frontOh: 0.92, wheelbase: 2.79,
    wheelR: 0.328, rimR: 0.216, tyreW: 0.215, trackHalf: 0.775, rocker: 0.150,
    deck: [[0, 0.700], [0.04, 0.760], [0.12, 0.848], [0.22, 0.890], [0.32, 0.928],
      [0.50, 1.008], [0.68, 1.046], [0.80, 1.066], [0.88, 1.082], [0.96, 1.082],
      [1, 1.030]],
    roof: [[0, 0.700], [0.04, 0.760], [0.12, 0.848], [0.22, 0.890], [0.31, 0.925],
      [0.37, 1.075], [0.45, 1.305], [0.52, 1.412], [0.585, 1.446], [0.705, 1.450],
      [0.765, 1.400], [0.825, 1.222], [0.875, 1.075], [0.91, 1.050], [1, 0.995]],
    hw: [[0, 0.530], [0.03, 0.678], [0.09, 0.808], [0.18, 0.878], [0.30, 0.900],
      [0.73, 0.900], [0.87, 0.884], [0.95, 0.826], [0.985, 0.735], [1, 0.600]],
    sill: [[0, 0.352], [0.03, 0.292], [0.08, 0.208], [0.16, 0.160], [0.30, 0.150],
      [0.74, 0.150], [0.87, 0.168], [0.95, 0.234], [1, 0.348]],
    roofW: 0.740,
    dlo: [0.410, 0.805], pillars: [[0.575, 0.052]],
    screen: [0.310, 0.570], rear: [0.815, 0.885],
    lampU: 0.950, lampY: [0.790, 1.060],
    headU: 0.055, headY: [0.615, 0.805],
    doors: [0.378, 0.575, 0.805],
  },
  van: {
    /* A short-wheelbase panel van. It is here for the silhouette: nothing else
     * on the street is a 2.1 m slab, and a row of cars all 1.46 m tall reads
     * as a set. It is also the one body whose sides are genuinely flat, which
     * is a different reflection problem and worth having one of. */
    len: 5.00, wide: 1.90, high: 2.10,
    frontOh: 0.90, wheelbase: 3.10,
    wheelR: 0.340, rimR: 0.220, tyreW: 0.205, trackHalf: 0.800, rocker: 0.185,
    deck: [[0, 0.780], [0.04, 0.850], [0.10, 0.960], [0.16, 1.060], [0.24, 1.140],
      [0.40, 1.180], [0.70, 1.200], [0.90, 1.205], [1, 1.150]],
    roof: [[0, 0.780], [0.04, 0.850], [0.09, 0.960], [0.14, 1.075], [0.19, 1.420],
      [0.245, 1.820], [0.30, 2.040], [0.36, 2.098], [0.90, 2.100], [0.955, 2.080],
      [0.985, 1.980], [1, 1.700]],
    hw: [[0, 0.590], [0.03, 0.740], [0.09, 0.878], [0.17, 0.935], [0.28, 0.950],
      [0.80, 0.950], [0.92, 0.940], [0.97, 0.880], [1, 0.760]],
    sill: [[0, 0.400], [0.03, 0.340], [0.08, 0.250], [0.16, 0.196], [0.30, 0.185],
      [0.80, 0.185], [0.92, 0.205], [0.97, 0.280], [1, 0.400]],
    roofW: 0.855,
    /* Cab glass only, and then a blank panel: that is what a panel van is, and
     * the long unbroken flank is most of what identifies it at distance. */
    dlo: [0.300, 0.430], pillars: [],
    screen: [0.155, 0.320], rear: [0.985, 0.999],
    lampU: 0.955, lampY: [0.560, 0.980],
    headU: 0.055, headY: [0.700, 0.940],
    doors: [0.300, 0.430],
    /* A cab door, a sliding side door with a long track over it, and the rear
     * doors. The sliding door is the one that makes a van a van from the side:
     * it is a metre and a half of shut line with nothing else on the panel. */
    gaps: [0.052, 0.300, 0.430, 0.700, 0.955],
  },
};

/* ── Panel gaps ─────────────────────────────────────────────────────────── */

/*
 * A shut line is a groove, and it has to be one.
 *
 * The first version of this system drew the door shuts in the shader — an
 * antialiased dark line four millimetres wide against the along-car
 * coordinate — and the review that produced this pass could not find a single
 * panel break on any car in the street. Two reasons, and both of them are the
 * project's recorded failure mode rather than anything specific to cars. A
 * 4 mm feature is under a pixel past about four metres, so it filtered to
 * nothing at every distance in the set; and where it did survive it was a
 * change in albedo, which is a decal. What identifies sheet metal at a raking
 * sun is not that the gap is dark. It is that the two panels either side of it
 * have their own edges: the light catches the near lip, the groove is in
 * shadow, and the far lip catches it again. That is a normal, not a colour,
 * and no albedo term can produce it.
 *
 * So the gap is cut into the loft. Five stations across nine millimetres, with
 * the middle three pulled in along the section normal, which gives a groove
 * with two real lips and a floor 7.5 mm down. It costs two extra rings per gap
 * — about 1.1k triangles a car — and it is the single largest visual change in
 * this pass.
 *
 * `tools/shutline.mjs` measures whether it worked, by walking the sun across
 * the groove and checking that the near lip and the floor move in opposite
 * directions. A decal cannot do that and a groove cannot help it.
 */
/** Half-width of a groove, in metres of arc along the car. */
const GAP_W = 0.0045;
/** How deep the floor of it sits under the skin either side. */
const GAP_D = 0.0075;

function gapsOf(s: Shape): readonly number[] {
  return s.gaps ?? [0.050, ...s.doors, 0.950];
}

/** How far the skin is pulled in at this station, in metres. */
function gapDepth(s: Shape, u: number): number {
  let d = 0;
  for (const g of gapsOf(s)) {
    const t = ((u - g) * s.len) / GAP_W;
    if (Math.abs(t) < 2.6) d = Math.max(d, GAP_D * Math.exp(-t * t * 1.15));
  }
  return d;
}

/**
 * Pull a closed section in along its own normal.
 *
 * The floor pan is left alone — a shut line does not run across the underside
 * of a car, and pulling the pan in would open a slot along the bottom of the
 * body that the road would show through.
 */
/**
 * Cut a horizontal groove into a section at a given height.
 *
 * Only where the ring is running roughly vertically, which is what keeps this
 * off the floor pan and off the underside of the arch: a "constant height" seam
 * on a surface that is already horizontal is not a seam, it is a dent, and the
 * arch liner and the pan both pass through this height on their way inboard.
 */
function grooveAtHeight(p: [number, number][], y: number, d: number): void {
  const n = p.length;
  for (const side of [1, -1]) {
    let best = -1, bestD = 1e9;
    for (let j = PT(3); j <= PT(9); j++) {
      const k = side > 0 ? j : (n - j) % n;
      if (Math.sign(p[k][0] || side) !== side) continue;
      const dy = Math.abs(p[k][1] - y);
      if (dy < bestD) { bestD = dy; best = k; }
    }
    if (best < 0 || bestD > 0.055) continue;
    for (const [k, w] of [[best, 1], [(best + 1) % n, 0.45], [(best + n - 1) % n, 0.45]] as const) {
      const a = p[(k + n - 1) % n], b = p[(k + 1) % n];
      const tx = b[0] - a[0], ty = b[1] - a[1];
      const l = Math.hypot(tx, ty) || 1;
      // Vertical enough to have a horizontal seam in it at all.
      if (Math.abs(ty / l) < 0.55) continue;
      p[k] = [p[k][0] - (ty / l) * d * w, p[k][1] + (tx / l) * d * w];
    }
  }
}

function insetRing(p: [number, number][], d: number): void {
  const n = p.length;
  const out: [number, number][] = p.map((q) => [q[0], q[1]]);
  for (let j = 0; j < n; j++) {
    if (j < PT(2) || j > PT(26)) continue;
    const a = p[(j + n - 1) % n], b = p[(j + 1) % n];
    const tx = b[0] - a[0], ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1;
    /* The ring is counter-clockwise in (lateral, height), so its outward
     * normal is (ty, -tx) and inward is the negative of that. Getting this
     * backwards raises a 7.5 mm welt where the gap should be, which reads as
     * a rubbing strip and is a surprisingly convincing wrong answer. */
    out[j] = [p[j][0] - (ty / l) * d, p[j][1] + (tx / l) * d];
  }
  for (let j = 0; j < n; j++) p[j] = out[j];
}

/* ── The section ────────────────────────────────────────────────────────── */

/* Fifteen points up one side and the mirror of thirteen of them back down, so
 * a closed section is twenty-eight points. The indices matter, because the
 * cell classifier below is written in terms of them:
 *
 *   0,1      the floor pan
 *   2,3      the arch liner, or a sliver above the rocker where there is none
 *   4        the rocker bottom edge
 *   5,6,7    the flank, through the widest point at 6
 *   8        the beltline, where glass starts
 *   9,10     the side glass, leaning in on the tumblehome
 *   11       the cant rail
 *   12,13,14 the roof, 14 on the centreline
 *
 * Mirror of point j is at index 28 - j. Cell j runs between point j and j+1.
 */
/* The section is authored at 28 points and emitted at 56.
 *
 * The critic found fore-aft banding across every roof and hard facet steps
 * down the C-pillars, in diffuse as well as specular, which I had recorded as
 * faint and specular-only. It is neither, and the cause was not the station
 * count: there are sixty stations along a four-metre car and the banding runs
 * *along* the car, so what is coarse is the ring. Four points carried a roof
 * from cant rail to centreline, and interpolating a normal linearly across
 * 350 mm of crown gives exactly the Mach banding that showed up — the normal
 * is continuous and its derivative is not, and a clearcoat lobe differentiates
 * whatever you give it.
 *
 * So the authored ring is subdivided once with the interpolating four-point
 * scheme before anything sees it. The control points stay where they are, so
 * every proportion that was signed off is untouched; the inserted points carry
 * the curvature the normals need. The cost is one extra triangle per cell,
 * about 30k over the nine cars.
 *
 * Everything below indexes the *emitted* ring, so an authored index a is at
 * 2a and the cell that used to be a is now the pair 2a, 2a+1. The role
 * classifier is written in those doubled ranges, and CELL below names them.
 */
const NSEC = 56;
const HALF = 15;

/** Authored point index to emitted point index. */
const PT = (a: number) => a * 2;
/** Authored cell index to the emitted cell range it became, inclusive. */
const CELL = (a: number, b: number) => [a * 2, b * 2 + 1] as const;

/**
 * One round of interpolating four-point subdivision on a closed ring.
 *
 * -1, 9, 9, -1 over 16. It passes through every input point, which is what
 * keeps the authored section authoritative, and it is C1 with bounded
 * curvature, which is what kills the banding. A midpoint average would also
 * double the count and would not: it leaves the same corners in the same
 * places with twice as many vertices agreeing about them.
 */
function refine(p: readonly [number, number][]): [number, number][] {
  const n = p.length;
  const out: [number, number][] = new Array(n * 2);
  for (let i = 0; i < n; i++) {
    const a = p[(i + n - 1) % n], b = p[i], c = p[(i + 1) % n], d = p[(i + 2) % n];
    out[i * 2] = b;
    out[i * 2 + 1] = [
      (-a[0] + 9 * b[0] + 9 * c[0] - d[0]) / 16,
      (-a[1] + 9 * b[1] + 9 * c[1] - d[1]) / 16,
    ];
  }
  return out;
}

type Station = {
  u: number;                 // fraction of the length
  z: number;                 // metres from the nose, local
  pt: [number, number][];    // NSEC points, (lateral, height)
  gh: number;                // greenhouse height at this station
};

function station(s: Shape, u: number): Station {
  const yD = at(s.deck, u);
  const yR = Math.max(yD, at(s.roof, u));
  const gh = yR - yD;
  const wB = at(s.hw, u);
  const wS = wB * 0.905;
  const wG = wB * 0.955;
  const wR = wB * s.roofW;

  /* Where the arch is cut into the bottom edge.
   *
   * The first version struck a circle of 1.19 tyre radii about the axle and
   * took the max of it and the sill, and that is the square-cut notch the
   * critic found. A circle centred on the axle is at axle height where it ends
   * — 306 mm up — so at each end of the arc the bottom edge of the skin jumped
   * 130 mm vertically in one station. Two hard corners and a segment of arc
   * between them is a notch cut in a sheet, not an arch, and the step also
   * left the apparent opening reading two to three times its real depth.
   *
   * A real arch is a lip that comes down past the axle at both ends and meets
   * the sill, so the opening is more than a semicircle and its ends are steep
   * rather than square. That is one expression: a bump of half-width slightly
   * wider than the tyre, springing from the sill line and rising to a fixed
   * clearance over the top of the tread. The apex sits 70 mm over the tyre,
   * which is what a parked road car shows; the previous 1.19 r worked out at
   * 56 mm and was never the problem.
   */
  /* The opening is bigger than it was, and the reason is a measured one about
   * apparent wheel size rather than a taste for arches.
   *
   * The review says the wheels read as too small and sunk into shallow dents.
   * The wheels are not too small: a 636 mm tyre on a 4.20 m body 1.46 m tall
   * is 43.6 per cent of the height, which is a current hatchback to the
   * millimetre, and the diameters here are real. What was too small was the
   * hole they sit in. A 70 mm crown clearance over a 1.24 r opening leaves an
   * arch that is barely wider than the tyre and barely taller, so the tyre
   * fills it and the eye reads the pair as one dark blob let into the
   * bodyside — which is exactly "sunk into a shallow dent". A parked road car
   * shows 80 to 100 mm of daylight over the tread and the opening runs a good
   * deal wider than the contact patch at the bottom.
   */
  const arch = (axleU: number, sillY: number) => {
    const apex = s.wheelR * 2 - 0.008 + 0.088;
    const w = s.wheelR * 1.33;
    const d = (u - axleU) * s.len;
    if (Math.abs(d) >= w) return -1;
    const t = d / w;
    /* Slightly flatter than a circle over the crown and steeper at the ends,
     * which is the shape of a pressed arch lip and also keeps the apex from
     * being the only station that clears the tyre. */
    const c = Math.pow(Math.max(0, 1 - t * t), 0.62);
    return sillY + (apex - sillY) * c;
  };
  const uF = s.frontOh / s.len;
  const uR = (s.frontOh + s.wheelbase) / s.len;
  const ySill = at(s.sill, u);
  const aY = Math.max(arch(uF, ySill), arch(uR, ySill));
  const yb = Math.max(ySill, aY);
  const inArch = aY > ySill + 0.004;

  const yPan = s.rocker + 0.145;
  const wPan = Math.max(0.12, wS - 0.145);
  const ySh = yb + (yD - yb) * 0.66;

  // Where there is no cabin the top of the section is a crowned deck; where
  // there is, it is a greenhouse. The two layouts are blended, which is what
  // sweeps the surface up into a windscreen over the cowl.
  const g = Math.min(1, Math.max(0, (gh - 0.020) / 0.100));
  const g2 = g * g * (3 - 2 * g);
  const mix = (a: number, b: number) => a + (b - a) * g2;

  const H: [number, number][] = [
    [0, yPan],
    [wPan, yPan],
    [wPan, Math.max(yb - 0.010, yPan + 0.020)],
    /* The mouth of the liner, and it is now 100 mm inboard of the lip rather
     * than 39. That distance is the whole of whether an arch reads as an
     * opening: what says "there is a cavity behind this" is the band of the
     * liner that the lip does not hide, seen at a grazing angle and dark. At
     * 39 mm there was no band, so the tyre appeared to be glued to the outside
     * of the body with a shadow painted round it. */
    [wS * (inArch ? 0.918 : 0.985), yb + (inArch ? 0.010 : 0.004)],
    /* The arch lip. A pressed arch is not a cut edge: the skin turns out by ten
     * or fifteen millimetres before it turns under to the liner, and that lip
     * is a hard little convexity that runs the whole arc and catches a line of
     * light along the top of it at any sun angle. Without it the opening is a
     * hole in a sheet and the tyre reads as pasted behind it.
     *
     * The number moved twice and the second time was the one that mattered.
     *
     * 1.048 of the sill width put the lip at 0.830 m on a hatchback. The tyre's
     * crown is at 0.8595 — track half of 0.755 plus a 205 sidewall — so the lip
     * was thirty millimetres *inboard* of the tyre it was supposed to be
     * overhanging. That is the whole of the review's "sitting low and soft on
     * its wheels" and of "I struggle to see a gap on the front wheel": there was
     * an 80 mm gap of air over the tread, correctly, and it was invisible
     * because the body was set back behind the tyre and you were looking at the
     * outside of the tyre rather than into the opening. No arch can read as an
     * opening while the wheel is the widest thing on the car.
     *
     * 1.094 puts it at 0.99 of the body's widest point, which is 6 mm outboard
     * of the tyre crown. That is where a road car's flare is — flush with the
     * widest point of the bodyside, not proud of it — and it is the most the
     * collider will allow, since `carSolids()` publishes `wide/2` and the
     * shoulder above already touches it. */
    [wS * (inArch ? 1.094 : 1.010), yb + (inArch ? 0.032 : 0.042)],
    [wB * 0.968, yb + (ySh - yb) * 0.55],
    [wB, ySh],
    [wB * 0.988, yD - (yD - ySh) * 0.34],
    [wG, yD],
    [mix(wG * 0.940, wG * 0.990), mix(yD + 0.009, yD + gh * 0.30)],
    [mix(wG * 0.800, wG * 0.30 + wR * 0.70), mix(yD + 0.017, yR - gh * 0.215)],
    [mix(wG * 0.640, wR), mix(yD + 0.022, yR - gh * 0.030)],
    [mix(wG * 0.470, wR * 0.880), mix(yD + 0.026, yR + 0.004)],
    [mix(wG * 0.255, wR * 0.500), mix(yD + 0.029, yR + 0.011)],
    [0, mix(yD + 0.030, yR + 0.014)],
  ];

  const base: [number, number][] = new Array(28);
  for (let j = 0; j < HALF; j++) base[j] = H[j];
  for (let j = 1; j <= 13; j++) base[28 - j] = [-H[j][0], H[j][1]];

  const pt = refine(base);
  /* And the shut lines, cut after the ring is refined rather than before it.
   * Refinement is an interpolating subdivision — it keeps every authored point
   * and inserts a four-point midpoint between them — so a feature authored into
   * the coarse ring survives it. A groove *across* the car does not exist in the
   * ring at all, though, so it has to be cut here. */
  const gd = gapDepth(s, u);
  if (gd > 1e-5) insetRing(pt, gd);

  /* The rocker parting line, which runs the other way and so needs the other
   * treatment.
   *
   * "The sill/rocker parting line is a material band rather than geometry. At a
   * raking sun that line is one of the strongest horizontal cues on a car's
   * flank." It is — a door skin ends and a rocker panel begins, and the two are
   * separate pressings with a seam between them that runs the whole length of
   * the car at a constant height. Unlike a door shut this cannot be done with
   * extra stations, because it is a feature of the *section* and the section's
   * points are at whatever heights the body curves put them.
   *
   * So it is cut by height instead: find the ring point nearest the seam on each
   * side and pull it and its neighbours in. Two points at about 30 mm spacing
   * gives a groove 60 mm wide and 5 mm deep, which is wider than a real seam and
   * is the honest limit of a 56-point section. What it buys is a real change of
   * surface direction at a constant height along the whole flank, which at 12
   * degrees is a hard line — and unlike the painted band it was, it moves with
   * the light rather than staying put.
   */
  grooveAtHeight(pt, at(s.sill, u) + 0.098, 0.0050);

  return { u, z: u * s.len, pt, gh };
}

/** Stations: a base rhythm, refined where the surface actually turns. */
function stations(s: Shape, detail: number): number[] {
  const set = new Set<number>();
  const add = (u: number) => set.add(Math.min(1, Math.max(0, +u.toFixed(4))));
  for (const u of [0, 0.018, 0.045, 0.085, 0.135, 0.26, 0.38, 0.50, 0.68, 0.79,
    0.90, 0.955, 0.982, 1]) add(u);
  // The windscreen and the backlight carry the whole read of the greenhouse.
  for (const [a, b] of [s.screen, s.rear]) {
    const n = Math.max(3, Math.round(5 * detail));
    for (let i = 0; i <= n; i++) add(a + ((b - a) * i) / n);
  }
  // The arches: the bottom edge is a circle here and a straight line either
  // side of it, and a coarse arch is the first thing a critic sees.
  for (const axle of [s.frontOh, s.frontOh + s.wheelbase]) {
    const r = (s.wheelR * 1.24) / s.len;
    const c = axle / s.len;
    const n = Math.max(10, Math.round(14 * detail));
    // Cosine spacing, so the stations bunch where the lip turns hardest.
    for (let i = 0; i <= n; i++) add(c - r * Math.cos((Math.PI * i) / n));
  }
  // The cowl, both edges of it, or the scuttle band smears over the bonnet.
  add(s.screen[0] - COWL / s.len); add(s.screen[0] - 0.004);
  // Pillars, so a B-pillar is not a smeared gradient across two stations.
  for (const [pu, pw] of s.pillars) { add(pu - pw / 2); add(pu + pw / 2); }
  add(s.dlo[0]); add(s.dlo[1]);
  add(s.lampU); add(s.headU);
  /* The shut lines. Five rings each: the two lips, the two shoulders they turn
   * from, and the floor. Anything coarser and the groove has no lip on the
   * near side, which is the half of it that catches the light. */
  for (const g of gapsOf(s)) {
    const w = GAP_W / s.len;
    for (const k of [-2.1, -1, 0, 1, 2.1]) add(g + k * w);
  }
  return [...set].sort((a, b) => a - b);
}

/* ── Cell roles ─────────────────────────────────────────────────────────── */

const R_PAINT = 0, R_TRIM = 1, R_ARCH = 2, R_UNDER = 3, R_LAMP_R = 4,
  R_LAMP_F = 5, R_PLATE = 7, R_GRILLE = 8, R_SCUTTLE = 11,
  R_GLASS_S = 20, R_GLASS_W = 21, R_GLASS_B = 22;

/** How far ahead of the windscreen the scuttle band runs. */
const COWL = 0.050;

function inAny(u: number, ranges: readonly (readonly [number, number])[]): boolean {
  return ranges.some(([a, b]) => u >= a && u <= b);
}

/** What a grid cell is, from the station it spans and the section band it is in. */
function cellRole(s: Shape, u: number, j: number, yMid: number, arched: boolean): number {
  const band = ([a, b]: readonly [number, number]) => j >= a && j <= b;
  const roofBand = band(CELL(12, 16));      // cant rail to cant rail over the top
  const glassBand = band(CELL(8, 9)) || band(CELL(18, 19));

  if (u >= s.screen[0] && u <= s.screen[1] && roofBand) return R_GLASS_W;
  /* The scuttle, wrapping a little wider than the screen itself: on a real car
   * the black band runs out past the A-pillar feet to the top of each wing. */
  if (u >= s.screen[0] - COWL / s.len && u < s.screen[0] && band(CELL(10, 18))) {
    return R_SCUTTLE;
  }
  if (u >= s.rear[0] && u <= s.rear[1] && roofBand) return R_GLASS_B;
  if (glassBand && u >= s.dlo[0] && u <= s.dlo[1]
      && !inAny(u, s.pillars.map(([pu, pw]) => [pu - pw / 2, pu + pw / 2] as const))) {
    return R_GLASS_S;
  }

  if (j <= CELL(0, 1)[1] || j >= CELL(26, 27)[0]) return R_UNDER;
  if (band(CELL(2, 3)) || band(CELL(24, 25))) return arched ? R_ARCH : R_TRIM;

  const flank = band(CELL(4, 7)) || band(CELL(20, 23));
  if (u >= s.lampU && flank && yMid > s.lampY[0] && yMid < s.lampY[1]) return R_LAMP_R;
  if (u <= s.headU && flank && yMid > s.headY[0] && yMid < s.headY[1]) return R_LAMP_F;
  if (u <= 0.030 && flank && yMid > 0.46 && yMid <= s.headY[0]) return R_GRILLE;
  // Bumpers, front and rear, and the rocker under the doors.
  if ((u < 0.055 || u > 0.945) && yMid < 0.60) return R_TRIM;
  if (band(CELL(4, 4)) || band(CELL(24, 24))) return R_TRIM;
  return R_PAINT;
}

/* ── Hashing ────────────────────────────────────────────────────────────── */

const h2 = (a: number, b: number): number => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/* ── One car ────────────────────────────────────────────────────────────── */

export type CarSpec = {
  kind: CarKind;
  /** Centre of the car in world x, and the centre of its length in world z. */
  x: number; z: number;
  /** Heading in radians. 0 points the nose down -Z. */
  yaw: number;
  /** Which colour out of the palette in the shader, 0..1. */
  colour: number;
  /** How filthy: 0 washed this week, 1 has not been washed this year. */
  dirt: number;
  /** How old the paint and trim are: fade, chalking, kerbed alloys. */
  age: number;
  /** Sidelights on, which at dusk one parked car in a street has. */
  sidelights?: boolean;
  seed: number;
  /** Station density; the far end of the street does not need the full grid. */
  detail?: number;
  note: string;
};

type Ctx = {
  B: Hull; G: Hull; W: Hull; S: Hull;
};

/**
 * A car's frame: nose at local z = 0 running to the tail at z = len, x lateral,
 * y up from the road surface under the car's own centre.
 *
 * The road cambers and settles under the car, so the height is sampled at the
 * middle of the wheelbase rather than assumed. A car sitting at world zero on
 * a road that is 85 mm lower at the kerb than at the crown would float on one
 * side and sink on the other, which is a mistake that reads instantly.
 */
function place(spec: CarSpec, s: Shape) {
  const cs = Math.cos(spec.yaw), sn = Math.sin(spec.yaw);
  /* Nose down -Z at yaw 0: the local +z axis (nose to tail) maps to world +Z.
   * Local +x maps to world +X, rotated. */
  const ax: V3 = [cs, 0, -sn];      // local x in world
  const az: V3 = [sn, 0, cs];       // local z in world
  const y0 = roadHeight(spec.x, spec.z);
  /* A parked car sits very slightly nose-down: the front springs carry the
   * engine, and on a 4.2 m car the nose is 10-18 mm lower than the tail. It is
   * a fraction of a degree and it is one of those differences that is only
   * visible when it is missing. */
  const rake = 0.013 / s.len;
  const ox = spec.x - az[0] * s.len * 0.5;
  const oz = spec.z - az[2] * s.len * 0.5;
  return {
    /** Local (lateral, height, along) to world. */
    p(lx: number, ly: number, lz: number): V3 {
      const drop = rake * (lz - s.len * 0.5);
      return [
        ox + ax[0] * lx + az[0] * lz,
        y0 + ly + drop,
        oz + ax[2] * lx + az[2] * lz,
      ];
    },
    /* The same, without the rake. The body leans on its springs; the wheels do
     * not — they stay on the road and the suspension takes up the difference,
     * which is the entire mechanism. Raking the tyres with the body would lift
     * the rear contact patch 7 mm clear of the tarmac, and a floating contact
     * patch is the one thing this system cannot afford to get wrong. */
    pw(lx: number, ly: number, lz: number): V3 {
      return [
        ox + ax[0] * lx + az[0] * lz,
        y0 + ly,
        oz + ax[2] * lx + az[2] * lz,
      ];
    },
    /** Local direction to world. */
    n(nx: number, ny: number, nz: number): V3 {
      const x = ax[0] * nx + az[0] * nz;
      const z = ax[2] * nx + az[2] * nz;
      const l = Math.hypot(x, ny, z) || 1;
      return [x / l, ny / l, z / l];
    },
    y0,
  };
}

function emitBody(c: Ctx, spec: CarSpec, s: Shape): void {
  const det = spec.detail ?? 1;
  const us = stations(s, det);
  const St = us.map((u) => station(s, u));
  const fr = place(spec, s);

  const NS = St.length;
  // Grid of world positions and smooth normals.
  const P: V3[][] = [];
  const N: V3[][] = [];
  for (let i = 0; i < NS; i++) {
    const row: V3[] = [], nrow: V3[] = [];
    for (let j = 0; j < NSEC; j++) {
      const [lx, ly] = St[i].pt[j];
      row.push(fr.p(lx, ly, St[i].z));
      nrow.push([0, 1, 0]);
    }
    P.push(row); N.push(nrow);
  }
  for (let i = 0; i < NS; i++) {
    const ia = Math.max(0, i - 1), ib = Math.min(NS - 1, i + 1);
    for (let j = 0; j < NSEC; j++) {
      const ja = (j + NSEC - 1) % NSEC, jb = (j + 1) % NSEC;
      const dU: V3 = [P[ib][j][0] - P[ia][j][0], P[ib][j][1] - P[ia][j][1], P[ib][j][2] - P[ia][j][2]];
      const dV: V3 = [P[i][jb][0] - P[i][ja][0], P[i][jb][1] - P[i][ja][1], P[i][jb][2] - P[i][ja][2]];
      /* Outward is the section tangent crossed into the length tangent: the
       * section is listed anticlockwise in (lateral, height) and the length
       * runs nose to tail, so on the right flank this is dV = up, dU = tail,
       * and up x tail is outboard. Getting this backwards builds a perfectly
       * correct car that is invisible from outside and casts no shadow. */
      let nx = dV[1] * dU[2] - dV[2] * dU[1];
      let ny = dV[2] * dU[0] - dV[0] * dU[2];
      let nz = dV[0] * dU[1] - dV[1] * dU[0];
      const l = Math.hypot(nx, ny, nz);
      if (l < 1e-9) { N[i][j] = [0, 1, 0]; continue; }
      nx /= l; ny /= l; nz /= l;
      N[i][j] = [nx, ny, nz];
    }
  }

  const seed = spec.seed;
  const dA = s.doors[0] ?? 0.4, dB = s.doors[1] ?? 0.7;
  const lit = spec.sidelights ? 1 : 0;
  const setB = (part: number, u: number, y: number, side: number) => {
    /* The height every analytic feature in the paint shader is a function of
     * is carried in uv.y, in metres above the road under *this* car, so the
     * fourth slot here is free for the colour index rather than a datum. That
     * matters: the carriageway falls 85 mm from crown to gutter, and a road
     * film band measured from world zero would sit at a different place on the
     * body of every car in the street. */
    c.B.attr('aCar', seed, part, spec.dirt, spec.colour);
    /* The lamp band travels with the cell rather than being assumed in the
     * shader, because a van's cluster sits 500 mm higher than a supermini's
     * and a shader constant would put the amber indicator through the middle
     * of one and off the bottom of the other. Which band depends on which end
     * of the car the cell is at. */
    const front = part === CAR.LAMP_F || part === CAR.CAP_F || part === CAR.GRILLE;
    const band = front ? s.headY : s.lampY;
    /* The first slot used to repeat the along-car distance that uv.x already
     * carries, and nothing read it. It now carries the beltline — the deck
     * curve at this station, in metres above the road — because that is the
     * datum the shoulder crease, the waist moulding and the second specular
     * lobe are all measured down from, and it moves 90 mm between the cowl and
     * the C-pillar on every one of these bodies. A crease drawn at a constant
     * height would run out through the door tops at one end of the car and
     * through the middle of the door at the other. */
    /* The fourth slot is the body length everywhere except on the two end
     * panels, where it is the half-width of the section that closes the loft.
     * The cap shader has no other way to know how wide the panel it is
     * shading actually is, and it needs to: a lamp cluster is anchored at the
     * corner of the car, so its inboard edge is measured in from the edge of
     * the panel and not out from the centreline. With a fixed inboard edge the
     * van — whose tail panel is 1.5 m across where a hatchback's is 0.7 —
     * came out with a 400 mm wide cluster on each side. Length is unused on a
     * cap: the along-car coordinate there is 0 or 1 by construction. */
    const cap = part === CAR.CAP_F || part === CAR.CAP_R;
    c.B.attr('aCarB', at(s.deck, u), band[0], band[1],
      cap ? at(s.hw, part === CAR.CAP_F ? 0 : 1) : s.len);
    c.B.attr('aCarC', dA * s.len, dB * s.len, spec.age, lit);
    void y; void side;
  };

  const off = (p: V3, n: V3, d: number): V3 => [p[0] + n[0] * d, p[1] + n[1] * d, p[2] + n[2] * d];

  for (let i = 0; i < NS - 1; i++) {
    const u0 = St[i].u, u1 = St[i + 1].u;
    const uM = (u0 + u1) * 0.5;
    const arched = St[i].pt[PT(2)][1] > St[i].pt[PT(1)][1] + 0.06
                || St[i + 1].pt[PT(2)][1] > St[i + 1].pt[PT(1)][1] + 0.06;
    for (let j = 0; j < NSEC; j++) {
      const jb = (j + 1) % NSEC;
      const yMid = (St[i].pt[j][1] + St[i].pt[jb][1] + St[i + 1].pt[j][1] + St[i + 1].pt[jb][1]) * 0.25;
      const xMid = (St[i].pt[j][0] + St[i].pt[jb][0]) * 0.5;
      const side = xMid >= 0 ? 1 : -1;
      const role = cellRole(s, uM, j, yMid, arched);

      const a = P[i][j], b = P[i][jb], cc = P[i + 1][jb], d = P[i + 1][j];
      const na = N[i][j], nb = N[i][jb], nc = N[i + 1][jb], nd = N[i + 1][j];
      // uv is (metres along the car, metres up), which is what every analytic
      // feature in the shader is a function of.
      const uvs: [number, number][] = [
        [St[i].z, St[i].pt[j][1]], [St[i].z, St[i].pt[jb][1]],
        [St[i + 1].z, St[i + 1].pt[jb][1]], [St[i + 1].z, St[i + 1].pt[j][1]],
      ];

      if (role >= R_GLASS_S) {
        /* A pane is emitted twice. Inboard 5 mm is the surface the glass is
         * seen against — the cabin, which the shader treats as an interior
         * with daylight coming through the far side rather than as a black
         * card. Outboard 10 mm is the pane itself, in its own geometry so it
         * can be blended. */
        /* Inboard 62 mm, not 5.
         *
         * "Right now they look like solid panels ... add slight transparency so
         * you can barely see headrests inside." The interior was always there
         * and it was always five millimetres behind the pane, which is to say
         * it was co-planar with it for every purpose that matters: no
         * parallax, no occlusion of one part of the cabin by another, and the
         * headrests the shader draws could only ever be a pattern on the glass
         * rather than an object behind it. At 62 mm the seat backs move against
         * the aperture as the camera walks past, which is the cue. */
        setB(CAR.CABIN, uM, yMid, side);
        c.B.quad(off(a, na, -0.062), na, off(b, nb, -0.062), nb,
          off(cc, nc, -0.062), nc, off(d, nd, -0.062), nd, uvs);

        const kind = role === R_GLASS_W ? PANE.SCREEN : role === R_GLASS_B ? PANE.REAR : PANE.SIDE;
        const span = kind === PANE.SCREEN ? s.screen : kind === PANE.REAR ? s.rear : s.dlo;
        const px0 = (u0 - span[0]) / Math.max(0.02, span[1] - span[0]);
        const px1 = (u1 - span[0]) / Math.max(0.02, span[1] - span[0]);
        /* Across the pane. For side glass that is beltline to cant rail; for a
         * screen it is left to right, and the previous version folded it about
         * the centreline with an abs(). That fold is the chevron the critic
         * found in every rear window in the set: a screen's coordinate ran
         * 0.5 down one side, through 0 on the centreline and back to 0.5, so
         * the demister lines, the grime band and the curvature bow all met
         * themselves coming back and drew a hard V. The band j runs 12 to 16
         * over the roof with 14 on the centreline, so the signed form needs no
         * folding at all. */
        const py = (k: number) => (kind === PANE.SIDE ? (k === j ? 0 : 1)
          : (k - PT(14)) / (PT(16) - PT(12)) + 0.5);
        c.G.attr('aGl', seed, kind, spec.dirt, kind === PANE.SCREEN ? 0.055 : 0.030);
        c.G.attr('aGlUV', px0, py(j), spec.age, side);
        /* And the pane 18 mm *under* the skin rather than 10 mm over it.
         *
         * "No visible glass inset — the glass is flush with the bodyside, where
         * real glass sits a couple of centimetres proud of or recessed into the
         * aperture." It was worse than flush: it stood proud, so the aperture
         * had a step the wrong way round and the greenhouse read as a decal
         * band wrapped over the body. Recessed, the cant rail above and the
         * belt below are 28 mm of skin standing over the glass, and at 12° the
         * upper one throws a hard line of shadow down the top of every pane —
         * which is the single most recognisable thing about a car's side glass
         * in low sun. */
        const gq: [V3, V3][] = [
          [off(a, na, -0.018), na], [off(b, nb, -0.018), nb],
          [off(cc, nc, -0.018), nc], [off(d, nd, -0.018), nd],
        ];
        // The pane coordinate has to vary across the quad, so it rides in uv
        // rather than in the per-vertex attribute block.
        c.G.quad(gq[0][0], gq[0][1], gq[1][0], gq[1][1], gq[2][0], gq[2][1], gq[3][0], gq[3][1],
          [[px0, py(j)], [px0, py(jb)], [px1, py(jb)], [px1, py(j)]]);
        continue;
      }

      setB(role, uM, yMid, side);
      c.B.quad(a, na, b, nb, cc, nc, d, nd, uvs);
    }
  }

  /* The two caps. A car's nose and tail are not points, so the loft stops at a
   * real section and the end is closed with a fan. Both are nearly flat and
   * both are mostly bumper, which is why they are classified by height. */
  /* Dished, not flat, and that is what makes the lamps possible.
   *
   * A flat fan from the section to a point is a lid, and the review reads it as
   * one: "the taillight is a flat red rectangle". Part of that is the lamp and
   * part of it is the panel it is in — a real tail panel turns in at the
   * corners by fifteen or twenty millimetres before it meets the quarter panel,
   * and the tailgate or the boot lid inside that is a separate pressing again.
   * So the cap is emitted as a rim band turning inboard, then the panel proper
   * set back behind it. That gives the corner a lip to catch the light along,
   * gives the panel a shadow at its edge, and — the reason it is here — leaves
   * eighteen millimetres of depth for a lamp unit to stand proud in without
   * any part of it passing the plane `carSolids()` calls the end of the car.
   */
  for (const end of [0, NS - 1]) {
    const nose = end === 0;
    const st = St[end];
    const dz = nose ? 0.018 : -0.018;
    const xs = 0.86, ys = 0.965;
    const cy = (st.pt[PT(0)][1] + st.pt[PT(HALF - 1)][1]) * 0.5;
    const inX = (j: number) => st.pt[j][0] * xs;
    const inY = (j: number) => cy + (st.pt[j][1] - cy) * ys;
    const nrm = fr.n(0, 0, nose ? -1 : 1);
    const cen: V3 = fr.p(0, cy, st.z + dz * 1.30);
    setB(nose ? CAR.CAP_F : CAR.CAP_R, nose ? 0 : 1, cy, 0);
    for (let j = 0; j < NSEC; j++) {
      const jb = (j + 1) % NSEC;
      const A = fr.p(st.pt[j][0], st.pt[j][1], st.z);
      const Bp = fr.p(st.pt[jb][0], st.pt[jb][1], st.z);
      const Ai = fr.p(inX(j), inY(j), st.z + dz);
      const Bi = fr.p(inX(jb), inY(jb), st.z + dz);
      // (lateral, height), both in metres; see the note on CAP_R.
      const uvA: [number, number] = [st.pt[j][0], st.pt[j][1]];
      const uvB: [number, number] = [st.pt[jb][0], st.pt[jb][1]];
      const uvAi: [number, number] = [inX(j), inY(j)];
      const uvBi: [number, number] = [inX(jb), inY(jb)];
      const uvC: [number, number] = [0, cy];
      if (nose) {
        c.B.quad(A, nrm, Ai, nrm, Bi, nrm, Bp, nrm, [uvA, uvAi, uvBi, uvB]);
        c.B.tri(Ai, cen, Bi, [uvAi, uvC, uvBi]);
      } else {
        c.B.quad(A, nrm, Bp, nrm, Bi, nrm, Ai, nrm, [uvA, uvB, uvBi, uvAi]);
        c.B.tri(Ai, Bi, cen, [uvAi, uvBi, uvC]);
      }
    }
  }

  /* ── Lamp units ─────────────────────────────────────────────────────────
   *
   * "Recessed, not flat squares. Chrome or clear housing around them."
   *
   * The shader has always painted a red band with a prism structure and a
   * bezel across the tail panel, and it is a good band; what it could not do
   * is have a thickness. A cluster is a moulding 60 to 80 mm deep bolted into
   * an aperture, so from three-quarters behind you see the *side* of it, and
   * that sliver of dark housing beside a bright lens is most of what says the
   * lamp is an object. Painted, the same lamp is a rectangle.
   *
   * So: a housing box let into the dished panel, and a lens on the face of it
   * three millimetres proud. Both stay inside the body's own plan extents, so
   * `carSolids()` and `scene/collide.ts` are untouched — which matters, because
   * a lamp is exactly where a shoulder brushes a car when squeezing past one.
   */
  for (const rear of [true, false]) {
    const yb = rear ? s.lampY : s.headY;
    const hwEnd = at(s.hw, rear ? 0.968 : 0.032);
    const xOut = hwEnd * 0.980;
    const xIn = Math.max(0.20, xOut - (rear ? 0.30 : 0.27));
    const zFace = rear ? s.len - 0.007 : 0.007;
    const zRoot = rear ? s.len - 0.078 : 0.078;
    const yMid = (yb[0] + yb[1]) * 0.5;
    for (const sgn of [-1, 1]) {
      setB(CAR.TRIM, rear ? 1 : 0, yMid, sgn);
      box(c.B, fr, sgn * xIn, yb[0], Math.min(zFace, zRoot),
        sgn * xOut, yb[1], Math.max(zFace, zRoot));
      setB(rear ? CAR.LAMP_R : CAR.LAMP_F, rear ? 1 : 0, yMid, sgn);
      /* The lens. uv is (lateral metres, height metres) on it, which is the
       * coordinate the lamp branch in the shader already works in — the prism
       * pitch, the indicator division and the bezel are all functions of it,
       * so the moulding drawn on the face of this box is the same one that was
       * drawn on the flat panel and nothing about it has to be retuned. */
      const zL = rear ? zFace + 0.003 : zFace - 0.003;
      const n = fr.n(0, 0, rear ? 1 : -1);
      const x0 = Math.min(sgn * xIn, sgn * xOut) + 0.006;
      const x1 = Math.max(sgn * xIn, sgn * xOut) - 0.006;
      const y0 = yb[0] + 0.007, y1 = yb[1] - 0.007;
      const q: V3[] = rear
        ? [fr.p(x1, y0, zL), fr.p(x0, y0, zL), fr.p(x0, y1, zL), fr.p(x1, y1, zL)]
        : [fr.p(x0, y0, zL), fr.p(x1, y0, zL), fr.p(x1, y1, zL), fr.p(x0, y1, zL)];
      const uvq: [number, number][] = rear
        ? [[Math.abs(x1), y0], [Math.abs(x0), y0], [Math.abs(x0), y1], [Math.abs(x1), y1]]
        : [[Math.abs(x0), y0], [Math.abs(x1), y0], [Math.abs(x1), y1], [Math.abs(x0), y1]];
      c.B.quad(q[0], n, q[1], n, q[2], n, q[3], n, uvq);
    }
  }

  /* ── Door handles ───────────────────────────────────────────────────────
   *
   * Four boxes, 48 triangles, and worth every one. A handle is 130 mm across
   * at a metre off the road, which puts it at eye level in the near field and
   * makes it the only hard little shape on an otherwise continuous surface —
   * the same argument the number plate wins on. The shader has drawn one since
   * the first pass and the review could not find it, for the same reason it
   * could not find the shut lines: a 20 mm albedo feature is not a handle, it
   * is a smudge. This one has a top face that catches the sun and an underside
   * that does not.
   *
   * The outer face stops at 99.8 per cent of the section's widest point, so
   * nothing here reaches past the collider either.
   */
  for (const du of s.doors.slice(0, 2)) {
    const zH = du * s.len + 0.30;
    const wB = at(s.hw, Math.min(0.95, du + 0.06));
    const yH = at(s.deck, Math.min(0.95, du + 0.06)) - 0.135;
    for (const sgn of [-1, 1]) {
      setB(CAR.TRIM, du, yH, sgn);
      box(c.B, fr, sgn * wB * 0.962, yH - 0.017, zH,
        sgn * wB * 0.998, yH + 0.017, zH + 0.132);
    }
  }

  /* The number plate. Tiny, and worth every one of its two triangles: a light
   * rectangle at a fixed height on a dark tail is one of the strongest "this
   * is a car" signals there is, and it survives to about forty metres. */
  const plateW = 0.26, plateY0 = 0.545, plateY1 = 0.655;
  const zT = s.len - 0.004;
  setB(CAR.PLATE, 1, plateY0, 0);
  {
    const n = fr.n(0, 0, 1);
    const q: V3[] = [
      fr.p(-plateW, plateY0, zT), fr.p(plateW, plateY0, zT),
      fr.p(plateW, plateY1, zT), fr.p(-plateW, plateY1, zT),
    ];
    c.B.quad(q[0], n, q[1], n, q[2], n, q[3], n,
      [[-1, -1], [1, -1], [1, 1], [-1, 1]]);
  }

  /* Door mirrors, at the base of the A-pillar. They matter out of all
   * proportion to their size: a car with no mirrors reads as a soap bar, and
   * the mirror is the only thing that breaks the greenhouse silhouette.
   *
   * They were two axis-aligned cuboids, which at 1.5 m is 120 px of flat
   * untextured box with a smaller flat untextured box behind it, and both
   * reviews named it. The plan extents below are unchanged to the
   * millimetre — `carSolids()` and therefore `scene/collide.ts` derive the
   * walker's clearance from these same three numbers, and a mirror that is
   * shaped differently from the one the collider knows about is a worse
   * defect than a boxy one. What changes is what fills them. */
  const mu = s.screen[0] * s.len + 0.10;
  const my = at(s.deck, s.screen[0]) + 0.055;
  for (const sgn of [-1, 1]) {
    const wOut = at(s.hw, s.screen[0]) * 0.99;
    setB(CAR.TRIM, s.screen[0], my, sgn);
    mirror(c.B, fr, sgn, wOut, my, mu, setB);
  }
}

/* One door mirror: a stalk, a shell, and the glass in it.
 *
 * Three things make a mirror read, and a cuboid has none of them. It tapers —
 * the shell is narrower and lower where it meets the stalk than at the glass,
 * which is what gives it the teardrop plan every mirror has had since they
 * stopped being round. Its edges are radiused, so at four degrees of sun the
 * top catches a line of light and the corners do not each catch their own.
 * And the glass is recessed behind a bezel and faces the car's own tail, so
 * it returns the street behind the car rather than whatever the outside of a
 * box happens to be pointing at.
 *
 * The section is an octagon rather than a rectangle, which is the cheapest
 * radius there is: eight facets over a 100 mm shell is a facet every 12 mm,
 * well under a pixel at any distance this is seen from, and it costs sixteen
 * triangles over the box it replaces.
 */
function mirror(
  H: Hull, fr: ReturnType<typeof place>, sgn: number,
  wOut: number, my: number, mu: number,
  setB: (part: number, u: number, y: number, side: number) => void,
): void {
  /* The same envelope the two boxes occupied, so the collider still agrees:
   * outboard from wOut + 0.055 to wOut + 0.155, my - 0.045 to my + 0.055,
   * and mu - 0.075 to mu + 0.075 along the car. */
  const u0 = 0.055, u1 = 0.155;
  const y0 = my - 0.045, y1 = my + 0.055;
  const zF = mu - 0.075, zR = mu + 0.075;

  /* An octagon in (outboard fraction, height fraction), counter-clockwise as
   * seen looking forward along the car. `k` is the chamfer: 0 is the box this
   * replaces and 0.5 is a lozenge. */
  const k = 0.30;
  const oct: [number, number][] = [
    [0, k], [k, 0], [1 - k, 0], [1, k], [1, 1 - k], [1 - k, 1], [k, 1], [0, 1 - k],
  ];
  /* Mirroring the car's other side negates the lateral axis, which reverses
   * the sense of the loop and would emit the whole shell inside out. This is
   * the same failure the wheels shipped with; it is cheaper to state it once
   * here than to find it in a frame. */
  const ring = sgn < 0 ? [...oct].reverse() : oct;
  const N = ring.length;

  /* Front and rear sections. The front is 82 per cent of the rear about the
   * shell's own axis and sits 8 mm inboard, which is the taper. */
  const pt = (j: number, rear: boolean): V3 => {
    const [a, b] = ring[j];
    const t = rear ? 1.0 : 0.82;
    const ac = 0.5 + (a - 0.5) * t, bc = 0.5 + (b - 0.5) * t;
    return fr.p(sgn * (wOut + u0 + ac * (u1 - u0) - (rear ? 0 : 0.008)),
      y0 + bc * (y1 - y0), rear ? zR : zF);
  };
  /* The glass: the rear section pulled in to 0.74 and back 12 mm, so the
   * bezel between the two is a real lip rather than a painted line. */
  const gl = (j: number): V3 => {
    const [a, b] = ring[j];
    const ac = 0.5 + (a - 0.5) * 0.74, bc = 0.5 + (b - 0.5) * 0.74;
    return fr.p(sgn * (wOut + u0 + ac * (u1 - u0)),
      y0 + bc * (y1 - y0), zR - 0.012);
  };

  /* The shell. Each facet takes the outward normal of its own edge in the
   * section plane, which is what makes the eight of them read as a radius
   * instead of as eight flats. */
  for (let j = 0; j < N; j++) {
    const jb = (j + 1) % N;
    const A = pt(j, false), B = pt(jb, false), C = pt(jb, true), D = pt(j, true);
    /* The edge's outward normal in the section plane. `dx` carries the sign
     * of the side, which with the reversed ring above leaves the section
     * counter-clockwise in the car's own (x, y) on both flanks, so (dy, -dx)
     * points out of the shell on both. */
    const dx = (ring[jb][0] - ring[j][0]) * (u1 - u0) * sgn;
    const dy = (ring[jb][1] - ring[j][1]) * (y1 - y0);
    const nf = fr.n(dy, -dx, 0);
    H.quad(A, nf, B, nf, C, nf, D, nf,
      [[zF, y0], [zF, y1], [zR, y1], [zR, y0]]);
  }
  // The front cap, facing the nose.
  {
    const cen = fr.p(sgn * (wOut + (u0 + u1) * 0.5 - 0.008), (y0 + y1) * 0.5, zF);
    for (let j = 0; j < N; j++) {
      H.tri(cen, pt((j + 1) % N, false), pt(j, false),
        [[zF, my], [zF, y1], [zF, y0]]);
    }
  }
  // The bezel: the rear rim turning in to the recessed glass.
  for (let j = 0; j < N; j++) {
    const jb = (j + 1) % N;
    H.quad(pt(j, true), fr.n(0, 0, 1), pt(jb, true), fr.n(0, 0, 1),
      gl(jb), fr.n(0, 0, 1), gl(j), fr.n(0, 0, 1),
      [[zR, y0], [zR, y1], [zR, y1], [zR, y0]]);
  }
  // The glass itself, and it is the only part of this that is not trim.
  setB(CAR.MIRROR, 0.5, my, sgn);
  {
    const cen = fr.p(sgn * (wOut + (u0 + u1) * 0.5), (y0 + y1) * 0.5, zR - 0.012);
    /* uv on the glass is a normalised disc coordinate about its centre, so
     * the shader can put the dust in the corners and the wiped middle where
     * they belong without knowing how big the mirror is. */
    const uvOf = (i: number): [number, number] =>
      [(ring[i][0] - 0.5) * 2, (ring[i][1] - 0.5) * 2];
    for (let j = 0; j < N; j++) {
      const jb = (j + 1) % N;
      H.tri(cen, gl(j), gl(jb), [[0, 0], uvOf(j), uvOf(jb)]);
    }
  }
  setB(CAR.TRIM, 0.5, my, sgn);

  /* The stalk. Smaller than the shell it carries and set low on it, which is
   * where a stalk goes: the shell hangs off the top of it, not around it. */
  box(H, fr, sgn * (wOut - 0.015), my - 0.030, mu - 0.028,
    sgn * (wOut + 0.078), my + 0.016, mu + 0.028);
}

/** An axis-aligned box in the car's local frame, wound outward. */
function box(
  H: Hull, fr: ReturnType<typeof place>,
  x0: number, y0: number, z0: number, x1: number, y1: number, z1: number,
): void {
  if (x1 < x0) [x0, x1] = [x1, x0];
  const P = (x: number, y: number, z: number) => fr.p(x, y, z);
  const faces: [V3, [number, number, number][]][] = [
    [fr.n(1, 0, 0), [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]]],
    [fr.n(-1, 0, 0), [[x0, y0, z1], [x0, y0, z0], [x0, y1, z0], [x0, y1, z1]]],
    [fr.n(0, 1, 0), [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]]],
    [fr.n(0, -1, 0), [[x0, y0, z1], [x1, y0, z1], [x1, y0, z0], [x0, y0, z0]]],
    [fr.n(0, 0, 1), [[x1, y0, z1], [x0, y0, z1], [x0, y1, z1], [x1, y1, z1]]],
    [fr.n(0, 0, -1), [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0]]],
  ];
  for (const [n, pts] of faces) {
    const q = pts.map(([x, y, z]) => P(x, y, z)) as V3[];
    H.quad(q[0], n, q[1], n, q[2], n, q[3], n,
      [[z0, y0], [z1, y0], [z1, y1], [z0, y1]]);
  }
}

/* ── Wheels ─────────────────────────────────────────────────────────────── */

/**
 * A tyre and a rim.
 *
 * Two things here are the whole of what makes a wheel read. The contact patch
 * is one: a loaded tyre is flat where it meets the road over about 140 mm, and
 * a perfect circle tangent to the ground is the classic sign of a car that has
 * been dropped onto a scene rather than parked in it. The other is that the
 * rim face is set well inboard of the tyre's outer shoulder, so the tyre
 * shoulders a shadow over it — a rim flush with the sidewall reads as a
 * painted disc.
 */
function emitWheel(
  W: Hull, fr: ReturnType<typeof place>, s: Shape, spec: CarSpec,
  lx: number, lz: number, steer: number,
): void {
  const sides = Math.max(14, Math.round(22 * (spec.detail ?? 1)));
  const R = s.wheelR, rim = s.rimR, hw = s.tyreW * 0.5;
  /* 8 mm of deflection and a 4 mm clearance, which together put a 175 mm flat
   * on the bottom of a 636 mm tyre. That is a real contact patch for a 205/60
   * at road pressure; the first pass used 12 and 11 and produced 238 mm, and a
   * quarter-metre of horizontal plate under each corner of the car catches the
   * sky and reads as a pallet the car is standing on. */
  const yc = R - 0.008;
  const flat = 0.004;
  const cst = Math.cos(steer), sst = Math.sin(steer);

  // (radius fraction, lateral fraction, part) around the tyre section.
  const ring: [number, number, number][] = [
    /* The bead, and it is inboard of the sidewall's widest point by 19 mm
     * rather than flush with it. That inset is what lets the tyre shoulder
     * throw a shadow across the rim, and a rim flush with the sidewall reads
     * as a disc painted onto the side of the tyre. */
    [rim / R, 0.80, WHL.RIM],
    [0.905, 0.985, WHL.WALL],
    [0.995, 0.760, WHL.TREAD],
    [1.000, 0.000, WHL.TREAD],
    [0.995, -0.760, WHL.TREAD],
    [0.905, -0.985, WHL.WALL],
    [rim / R, -0.80, WHL.RIM],
  ];

  const at3 = (i: number, k: number): V3 => {
    const a = (i / sides) * Math.PI * 2;
    const [rf, wf] = ring[k];
    let py = yc + Math.sin(a) * R * rf;
    let pr = Math.cos(a) * R * rf;
    // Squash the bottom of the tyre and let the sidewall bulge where it does.
    if (py < flat) { py = flat; }
    const bulge = 1 + 0.055 * Math.max(0, 1 - (py - flat) / 0.10) * (1 - Math.abs(wf));
    const off = hw * wf * bulge;
    // Steering: the front wheels of a kerbed car are never straight.
    const dx = off * cst - pr * sst;
    const dz = off * sst + pr * cst;
    return fr.pw(lx + dx, py, lz + dz);
  };
  /* True where the section point has been squashed onto the road — plus a
   * 55 mm margin, which is not slop. The clamped points carry a downward
   * normal and their neighbours carry a radial one, so the ring of quads
   * *around* the flat interpolates between the two and passes through every
   * angle in between; the ones that come out horizontal reflect the sky, and
   * that ring was the tan wedge, not the flat itself. Blacking the flat alone
   * left it untouched. The margin is the width of the transition, and what it
   * blacks is the last 55 mm of sidewall above the road, which is inside the
   * tyre's own shadow and has no business being lit either way. */
  const down = (i: number, k: number): boolean =>
    yc + Math.sin((i / sides) * Math.PI * 2) * R * ring[k][0] < flat + 0.038;
  const nrm = (i: number, k: number): V3 => {
    const a = (i / sides) * Math.PI * 2;
    const [rf, wf] = ring[k];
    /* The contact patch is a plane, so it gets a plane's normal.
     * Clamping the bottom of the tyre flat while leaving the normals radial
     * left a 230 mm horizontal face whose shading still thought it was the
     * underside of a circle, and because the surface is nearly edge-on to the
     * eye and the reflected ray is nearly grazing, it came back as a pale
     * wedge sticking out fore and aft of each tyre — the brightest thing on
     * the darkest object in the frame. */
    if (yc + Math.sin(a) * R * rf < flat) return [0, -1, 0];
    const radial = rf > 0.97 ? 1 : 0.55;
    const nx = wf * (1 - radial) + (k === 0 || k === 6 ? Math.sign(wf) * 1.2 : 0);
    const ny = Math.sin(a) * radial;
    const nz = Math.cos(a) * radial;
    const x = nx * cst - nz * sst, z = nx * sst + nz * cst;
    return fr.n(x, ny, z);
  };

  /* The road directly under this wheel. Carried because the shader wants
   * height above the road and not height above world zero: the camber drops
   * 85 mm from crown to gutter and the two tracks of one car are on different
   * parts of it, so a fixed datum would put the wet band at the bottom of one
   * tyre and halfway up the other. */
  const baseY = fr.pw(lx, 0, lz)[1];
  W.attr('aWhlB', baseY, R);

  for (let k = 0; k < ring.length - 1; k++) {
    const part = ring[k][2] === WHL.TREAD && ring[k + 1][2] === WHL.TREAD ? WHL.TREAD
      : Math.max(ring[k][2], ring[k + 1][2]) === WHL.RIM ? WHL.WALL : WHL.WALL;
    for (let i = 0; i < sides; i++) {
      const i2 = (i + 1) % sides;
      /* Flagged per quad, not derived in the shader from height above the
       * road. The first attempt tested `vWPos.y - vWhlBase` and never fired,
       * and the cost of finding that out was four capture rounds: the flat is
       * four millimetres thick, the datum it is measured against is carried
       * through two frames of transform, and a test with that little margin
       * is a test that is going to be wrong. The generator knows exactly
       * which quads it squashed. It should say so. */
      const squashed = down(i, k) || down(i, k + 1) || down(i2, k) || down(i2, k + 1);
      W.attr('aWhl', spec.seed, squashed ? WHL.PATCH : part, spec.dirt, spec.age);
      /* Section index outward, angle index around: that order and no other.
       *
       * `quad` takes its four corners counter-clockwise *seen from outside*,
       * and the loop that used to run (i,k) -> (i,k+1) -> (i2,k+1) -> (i2,k)
       * traversed the section before the angle, which is the opposite hand:
       * (b-a)x(c-a) came out pointing at the axle. Under FrontSide culling —
       * which this material needs, for the shadow — every triangle of every
       * tyre in the street was discarded, and the only wheel geometry that
       * survived was the two rim fans below, which are wound explicitly.
       *
       * That is the see-through wheel arch, and it is worth naming the shape
       * of the failure: nothing was missing, nothing errored, the vertex
       * normals were right, and `tools/wheelcheck.mjs` puts it at 85.7 per
       * cent of the wheel mesh facing inward. The four rounds of work above
       * on the contact patch, the tan wedge and the sidewall crescent were
       * all spent on surfaces that were never drawn. */
      W.quad(at3(i, k), nrm(i, k), at3(i2, k), nrm(i2, k),
        at3(i2, k + 1), nrm(i2, k + 1), at3(i, k + 1), nrm(i, k + 1),
        [[i / sides, k], [i2 / sides, k], [i2 / sides, k + 1], [i / sides, k + 1]]);
    }
  }

  /* ── The rim, with the spokes as real geometry ─────────────────────────
   *
   * "Add depth to the rims. Right now they're flat circles with painted
   * spokes." Which is exactly what they were, and the note in the previous
   * version defends it on aliasing grounds: modelled spokes at eight pixels
   * would be a grey disc. That is true of *thin* spokes on a fine wheel and it
   * is not an argument against depth. A road wheel's spokes sit 45 to 60 mm
   * behind the flange and the openings between them look through to the brake
   * and the dark of the arch, so the face of a wheel is two planes and a set of
   * walls between them, not one plane. Those walls are what carry the wheel's
   * shape at low sun: the sunward side of every spoke is lit and the other side
   * is not, which is why a photographed alloy has a bright half and a dark half
   * rather than an even sheen.
   *
   * Built as a ring of segments at four per spoke pitch, each one at the spoke
   * plane or at the recessed plane, with a wall wherever two neighbours
   * disagree. The shader keeps its own polar detail — the brake dust, the
   * kerbing, the hub — and stops drawing the spokes, because they are here now.
   * About 160 triangles a wheel, 5.8k over the street.
   */
  const spokes = 5 + Math.floor(h2(spec.seed, 3.7) * 3) * 2;
  const SEG = 4;
  const segs = spokes * SEG;
  const isSpoke = (i: number) => ((i % SEG) + SEG) % SEG < 2;
  /** A point on the wheel's face: angle index, radius, lateral fraction. */
  const face = (q: number, r: number, wf: number): V3 => {
    const a = (q / segs) * Math.PI * 2;
    let py = yc + Math.sin(a) * r;
    const pr = Math.cos(a) * r;
    if (py < flat) py = flat;
    const off = hw * wf;
    return fr.pw(lx + off * cst - pr * sst, py, lz + off * sst + pr * cst);
  };
  const uvAt = (q: number, r: number): [number, number] => {
    const a = (q / segs) * Math.PI * 2;
    return [(Math.cos(a) * r) / rim, (Math.sin(a) * r) / rim];
  };
  const rFl = rim, rSp = rim * 0.90, rHub = rim * 0.30;
  const wFace = 0.80, wBack = 0.44;
  const nOut = fr.n(cst, 0, sst);
  W.attr('aWhl', spec.seed, WHL.RIM, spec.dirt, spec.age);
  for (let i = 0; i < segs; i++) {
    const i2 = (i + 1) % segs;
    /* The flange: the bright ring at the outer edge, always at the outer
     * plane. It is the part a kerb scrapes and the part that catches a hard
     * line of light all the way round. */
    W.quad(face(i, rFl, wFace), nOut, face(i, rSp, wFace), nOut,
      face(i2, rSp, wFace), nOut, face(i2, rFl, wFace), nOut,
      [uvAt(i, rFl), uvAt(i, rSp), uvAt(i2, rSp), uvAt(i2, rFl)]);

    const wf = isSpoke(i) ? wFace : wBack;
    W.quad(face(i, rSp, wf), nOut, face(i, rHub, wf), nOut,
      face(i2, rHub, wf), nOut, face(i2, rSp, wf), nOut,
      [uvAt(i, rSp), uvAt(i, rHub), uvAt(i2, rHub), uvAt(i2, rSp)]);

    /* The side of a spoke, where the two planes meet. Its normal is
     * tangential, so it takes the sun from a completely different direction
     * from the face beside it — which is the whole point of building this. */
    if (isSpoke(i) !== isSpoke(i2)) {
      const a = (i2 / segs) * Math.PI * 2;
      const sa = Math.sin(a), ca = Math.cos(a);
      /* The tangential direction in the wheel's own plane, taken from the
       * parameterisation in `face` rather than guessed: the in-plane radial
       * axis maps to local (-sin(steer), 0, cos(steer)) and the other axis is
       * up, so d/da of the section is (sa·sst, ca, -sa·cst).
       *
       * Emitted with both windings. The wheels of this project have already
       * shipped once with 85.7 per cent of their triangles facing the axle
       * under FrontSide culling, and the failure is silent: no error, correct
       * normals, and a see-through wheel. Twenty triangles a wheel is a
       * cheaper insurance than another capture round. */
      const uvs: [number, number][] = [
        uvAt(i2, rSp), uvAt(i2, rHub), uvAt(i2, rHub), uvAt(i2, rSp)];
      const lo = isSpoke(i) ? wFace : wBack, hi = isSpoke(i) ? wBack : wFace;
      const p: V3[] = [face(i2, rSp, lo), face(i2, rHub, lo),
        face(i2, rHub, hi), face(i2, rSp, hi)];
      for (const sw of [1, -1]) {
        const nw = fr.n(sa * sst * sw, ca * sw, -sa * cst * sw);
        if (sw > 0) W.quad(p[0], nw, p[1], nw, p[2], nw, p[3], nw, uvs);
        else W.quad(p[3], nw, p[2], nw, p[1], nw, p[0], nw,
          [uvs[3], uvs[2], uvs[1], uvs[0]]);
      }
    }
  }
  // The hub cap, proud of the spoke plane as every wheel's is.
  {
    const cen = fr.pw(lx + hw * 0.84 * cst, yc, lz + hw * 0.84 * sst);
    for (let i = 0; i < segs; i++) {
      const i2 = (i + 1) % segs;
      W.tri(face(i, rHub, 0.84), cen, face(i2, rHub, 0.84),
        [uvAt(i, rHub), [0, 0], uvAt(i2, rHub)]);
    }
  }
  // The inboard face, which is never seen from outside the arch: one fan.
  {
    const wf = -0.80;
    const cen = fr.pw(lx + hw * wf * cst, yc, lz + hw * wf * sst);
    for (let i = 0; i < segs; i++) {
      const i2 = (i + 1) % segs;
      W.tri(face(i, rim, wf), face(i2, rim, wf), cen,
        [uvAt(i, rim), uvAt(i2, rim), [0, 0]]);
    }
  }
}

/* ── Contact shadow ─────────────────────────────────────────────────────── */

/*
 * The dark under the car, which the shadow map cannot deliver.
 *
 * At 12 degrees the sun's own shadow of a car is a 7 m streak thrown sideways
 * across the street, and it is not under the car at all. What is under the car
 * is an absence of *sky*: the largest source in this scene is the dome, and a
 * car occludes essentially all of it from the metre of road beneath it. Nothing
 * in the renderer models that — the environment probe is unoccluded — so the
 * car would sit on road lit as brightly as the road beside it, which is the
 * "sticker" failure the brief names, and which the user reports as the car
 * looking like it is floating.
 *
 * So it is stated: a multiply decal, following the camber. Multiply rather than
 * an alpha-blended black, because this is an occlusion of light already in the
 * frame and not a new dark object.
 *
 * What is *new* in this pass is that the decal is no longer a shape. The first
 * version was a rounded box with a smoothstep from 0.55 to 1.25 of its own
 * metric and a blob under each axle, with the depth of each chosen by eye, and
 * tools/stance.mjs shows that both were wrong and wrong in opposite directions.
 * The cosine-weighted form factor of the underbody — the actual share of sky
 * irradiance a rectangle 155 mm overhead takes away — runs like this for the
 * hatch:
 *
 *   under the centreline   87.9%          the decal said 86%, near enough
 *   300 mm off centre      86.5%          the decal had already started fading
 *   600 mm off centre      79.4%          the decal was down to about half
 *   at the sill, 875 mm    46.3%
 *   1000 mm                24.9%
 *   1200 mm                11.0%
 *   1600 mm                 4.0%
 *
 * So the true occlusion is a *plateau* under the body with a cliff at the sill,
 * halving inside 125 mm of it, and the decal was a dome peaking under the
 * centreline where nothing can see it and half gone by the time it emerged into
 * view. That is precisely a soft grey smudge rather than a car sitting on the
 * road, and no amount of making it darker would have fixed it — the error was
 * in the profile.
 *
 * The fix is to stop drawing a profile and evaluate the form factor itself,
 * which is three arctangents and exact. The rectangles are handed over here:
 * the underbody, and one per wheel at a height of a few millimetres, which is
 * what produces the tight dark crescent where a tyre flattens against the road.
 * See makeCarShadeMaterial.
 */
function emitShade(S: Hull, spec: CarSpec, s: Shape): void {
  const cs = Math.cos(spec.yaw), sn = Math.sin(spec.yaw);
  /* The footprint has to reach out to where the occlusion is genuinely
   * negligible or its own edge becomes the artefact. At `wide/2 + 0.42` it
   * stopped at 1.30 m, where the form factor is still 9 per cent, so the decal
   * ended in a visible step. 0.78 puts the edge at 1.66 m and 3.6 per cent. */
  const hl = s.len * 0.5 + 0.85, hwd = s.wide * 0.5 + 0.78;
  const NX = 8, NZ = 12;
  const axleF = s.frontOh - s.len * 0.5;
  const axleR = s.frontOh + s.wheelbase - s.len * 0.5;
  /* Metres, in the car's own frame, not fractions of the quad. The shader has
   * to do real geometry now, and handing it normalised coordinates would mean
   * multiplying them back up by numbers it would also have to be given. */
  S.attr('aShade', hwd, hl, s.rocker, s.trackHalf);
  S.attr('aShadeB', s.wide * 0.5 * 0.92, s.len * 0.5 - 0.30, axleF, axleR);
  const P = (fx: number, fz: number): V3 => {
    const lx = fx * hwd, lz = fz * hl;
    const x = spec.x + cs * lx + sn * lz;
    const z = spec.z - sn * lx + cs * lz;
    return [x, roadHeight(x, z) + 0.006, z];
  };
  const up: V3 = [0, 1, 0];
  for (let i = 0; i < NZ; i++) {
    for (let j = 0; j < NX; j++) {
      const z0 = -1 + (2 * i) / NZ, z1 = -1 + (2 * (i + 1)) / NZ;
      const x0 = -1 + (2 * j) / NX, x1 = -1 + (2 * (j + 1)) / NX;
      /* Wound so the face points *up*.
       *
       * It did not. The order was (x0,z0) (x1,z0) (x1,z1) (x0,z1), whose
       * geometric normal is X cross Z, which is minus Y — so every one of these
       * quads was back-facing to a camera above the road, and the material sets
       * no `side`, so FrontSide culled all of them. The contact shadow has never
       * drawn a pixel since it was written. The per-vertex normals said `up` and
       * were believed; the winding is what culling reads.
       *
       * This is the whole of "the car looks like it's floating", and no amount
       * of re-deriving the falloff would have shown up in a frame. It was found
       * by pairing the probe with a control: hiding the decal changed the road
       * beside the hero estate by 0.000 at fourteen consecutive samples, which
       * is not a soft term, it is an absent one. */
      S.quad(P(x0, z0), up, P(x0, z1), up, P(x1, z1), up, P(x1, z0), up,
        [[x0, z0], [x0, z1], [x1, z1], [x1, z0]]);
    }
  }
}

/* ── The System 5 interface ─────────────────────────────────────────────── */

/**
 * What System 5 needs to hang light on the one car with its sidelights on.
 *
 * Same contract as SHOP_LIGHTS next door: this system builds the lens and
 * makes it emit, and nothing here illuminates anything else. A parked car
 * showing sidelights at dusk puts a weak red wash on the road behind it, a
 * little of it on the kerb, and a red edge on the car behind — none of which
 * exists yet.
 *
 * The numbers are deliberately small. A sidelight is a 5 W bulb behind a red
 * lens seen an hour before sunset; if the spill System 5 adds is visible from
 * across the street, it is wrong. The emissive lens itself is authored at the
 * linear radiance in `colour`, which is roughly a seventh of the sunlit
 * brickwork in this scene, and the spill should be well under that again.
 */
export type CarLight = {
  kind: 'sidelight-rear' | 'sidelight-front';
  /** Centre of the lens in world metres. */
  pos: [number, number, number];
  /** Outward normal of the lens. */
  dir: [number, number, number];
  width: number; height: number;
  /** Linear RGB the lens is authored at. */
  colour: [number, number, number];
};

declare global {
  interface Window {
    /** Published by Cars.tsx for System 5 and for the capture harness. */
    __carLights?: CarLight[];
  }
}

/** Mirrors LENS_RED_LIT in scene/carMaterials.ts; the two must not drift. */
const LIT_TAIL: [number, number, number] = [0.900, 0.062, 0.028];
const LIT_NOSE: [number, number, number] = [0.620, 0.500, 0.315];

/* ── Where the cars are ─────────────────────────────────────────────────── */

/*
 * Placement is authored against the capture stops, which sit at
 * z = 2, -15.6, -35.2, -54.8, -74.4, -89.1.
 *
 * Three constraints decide every z below and none of them is composition in
 * the abstract.
 *
 * A car six to ten metres in front of a stop is where the eye lands. Closer
 * than about five and it is underneath the photographer — the same mistake the
 * ironwork in System 1 made, where every fixture rendered correctly and none
 * of them appeared in any frame. Further than about fifteen and it is a shape.
 *
 * A car must not be beside a stop. The walk drifts to x = -1.26 by the last
 * third, and a kerb-parked car's inboard flank is at x = -1.02, so a car whose
 * z span contains a stop puts a body panel 200 mm from the lens. That rules
 * the near kerb out between -70 and -92 entirely, and it is why the far half
 * of the street parks on the other side.
 *
 * And a car must not stand in front of a framing that belongs to another
 * system. `lit/86` looks across at the east frontage from z = -80.3 and
 * `shop/store` looks at the west frontage from z = -26.1; both of those are
 * System 3's and both are checked below.
 *
 * Left-hand traffic, so cars against the -X kerb face -Z and show the walker
 * their tails, and cars against the +X kerb face +Z and show their fronts.
 * One is parked the wrong way round, because on a street like this one always
 * is.
 *
 * The colours are a second pass, and the first one failed on the arithmetic
 * rather than on the palette: six of these nine read pale and not one read
 * black, in a street where a real kerbside parc is about a quarter white, a
 * fifth black, a fifth grey, a sixth silver and then blue and red. What it is
 * now, in order: deep blue, black, dark green, light grey metallic, red,
 * white van, graphite, black, silver. Two of them are genuinely low albedo and
 * one of those two — I, on the far kerb at -76.3 — is the only car in the
 * street that stands in direct sun, which makes it the one place this scene
 * can show what raking light does to black paint.
 */

/** Kerb face to the nearest body panel. 300-500 mm is what people manage. */
const kerbX = (side: number, gap: number, wide: number) =>
  side * (DIMS.roadHalf - gap - wide * 0.5);

export const PARKED: readonly CarSpec[] = [
  {
    /* Ten metres in front of the opening stop, on the near kerb: the first
     * frame of the walk has nothing in its middle distance to give the street
     * a scale, and a saloon at 10 m is 150 px of unmistakable reference.
     * Parked facing the traffic, which is the one every street has. */
    kind: 'saloon', x: kerbX(-1, 0.42, 1.80), z: -8.60, yaw: Math.PI - 0.021,
    colour: 0.72, dirt: 0.45, age: 0.5, seed: 11.7,
    note: 'A: near kerb, wrong way round, stop 1',
  },
  {
    /* Far kerb, filling the right of the opening frame and gone by stop two.
     * Black, because a quarter of the cars in any city are and because a black
     * car is the hardest test of whether the glass is carrying the frame. */
    kind: 'saloon', x: kerbX(+1, 0.36, 1.80), z: -13.00, yaw: 0.014,
    colour: 0.55, dirt: 0.30, age: 0.35, seed: 3.1,
    note: 'F: far kerb, stop 1 right',
  },
  {
    /* Eight metres in front of stop two and the sidelight car. It sits in the
     * frontage's own shade, which is where a dull red lens can register at
     * all — in the sun band it would be invisible. */
    kind: 'hatch', x: kerbX(-1, 0.33, 1.75), z: -25.40, yaw: -0.030,
    colour: 0.62, dirt: 0.62, age: 0.7, sidelights: true, seed: 27.3,
    note: 'B: near kerb, sidelights on, stop 2',
  },
  {
    /* Seven metres in front of stop three, and the car the paint and the glass
     * are meant to be judged on. It is the one with a metallic finish, the one
     * with the least dirt on it, and the one the two extra capture stops are
     * aimed at. It also throws its shadow diagonally across the carriageway
     * and onto the base of the sunlit frontage, which is most of what a car
     * contributes to a frame at this hour. */
    kind: 'estate', x: kerbX(-1, 0.38, 1.79), z: -42.60, yaw: 0.017,
    colour: 0.25, dirt: 0.30, age: 0.2, seed: 5.9,
    note: 'C: near kerb, hero, stop 3',
  },
  {
    /* Nose to tail behind the hero with 700 mm between the bumpers, because a
     * row of cars evenly spaced is a car park and a real kerb is packed at one
     * end and empty at the other. Old, filthy, and the one saturated colour. */
    kind: 'supermini', x: kerbX(-1, 0.30, 1.70), z: -47.55, yaw: -0.038,
    colour: 0.44, dirt: 0.58, age: 0.9, seed: 19.1,
    note: 'L: near kerb, tight behind the hero',
  },
  {
    /* Nine metres in front of stop four. A 2.1 m van against 1.46 m of car is
     * the only thing that stops the row reading as one repeated object, and it
     * blocks the view down the near footway, which the frame needs. */
    kind: 'van', x: kerbX(-1, 0.44, 1.90), z: -63.50, yaw: 0.026,
    colour: 0.05, dirt: 0.72, age: 0.75, seed: 41.3, detail: 0.85,
    note: 'D: near kerb, van, stop 4',
  },
  {
    /* Far kerb, between the cross street and the vacant lot, thirteen metres in
     * front of stop four. Behind the split framings, so it cannot intrude on
     * them. */
    kind: 'hatch', x: kerbX(+1, 0.40, 1.75), z: -70.00, yaw: 0.011,
    colour: 0.93, dirt: 0.55, age: 0.6, seed: 8.8, detail: 0.85,
    note: 'J: far kerb, stop 4 middle distance',
  },
  {
    /* Far kerb, three metres in front of stop five and the second car that
     * takes direct sun: the vacant lot lets the light through onto this stretch
     * and the shade line falls across the car itself, about a metre behind the
     * nose. Its tail is 1.9 m up-street of the `lit/86` sightline, which is
     * what keeps it out of System 3's frame. */
    kind: 'hatch', x: kerbX(+1, 0.35, 1.75), z: -76.30, yaw: -0.024,
    colour: 0.55, dirt: 0.38, age: 0.45, seed: 33.7, detail: 0.85,
    note: 'I: far kerb, sunlit, stop 5',
  },
  {
    /* Seven metres in front of the closing stop, past the end of the walk.
     * Deep in the haze, so it is a silhouette and a pair of tail lights and
     * nothing else — which is the point: the last frame needs something with a
     * known size in it to read as a hundred metres of street. */
    kind: 'saloon', x: kerbX(-1, 0.37, 1.80), z: -96.40, yaw: 0.032,
    colour: 0.15, dirt: 0.66, age: 0.8, seed: 61.9, detail: 0.7,
    note: 'M: near kerb, closing stop',
  },
];

/* ── Footprints, for anything that has to avoid a car ───────────────────── */

/**
 * A parked car in plan, as the two shapes a walker can actually walk into.
 *
 * `body` is the painted skin: `wide` across and `len` along, which is exactly
 * the extent the section is emitted at — the `hw` curve peaks at `wide / 2` on
 * every one of the five shapes, and the body runs local z = 0 at the nose to
 * z = `len` at the tail with its centre at `spec.z`. `mirror` is the door
 * mirror, which stands 150 mm proud of the flank at 0.97 m and is therefore
 * the first thing a shoulder meets when squeezing past.
 *
 * This is exported rather than copied because `SHAPES` is the only place the
 * bodies are dimensioned, and a collider carrying its own `hw: 0.875` would
 * agree with the geometry right up until somebody retunes a car and would then
 * be wrong silently — the walker would clip a flank or stop a hand's width off
 * one, and nothing would fail. `tools/obstacles.mjs` already carries such a
 * copy and says so in its header; `scene/collide.ts` derives from here.
 */
export type CarSolid =
  | {
    what: string; kind: 'body';
    /** Centre of the body in plan, and its heading; 0 points the nose down -Z. */
    x: number; z: number; yaw: number;
    /** Half extents across the body and along it. */
    hw: number; hl: number;
  }
  | { what: string; kind: 'mirror'; x: number; z: number; r: number };

export function carSolids(specs: readonly CarSpec[] = PARKED): CarSolid[] {
  const out: CarSolid[] = [];
  for (const spec of specs) {
    const s = SHAPES[spec.kind];
    const tag = `${spec.kind} ${spec.note.slice(0, 1)}`;
    out.push({
      what: tag, kind: 'body',
      x: spec.x, z: spec.z, yaw: spec.yaw,
      hw: s.wide * 0.5, hl: s.len * 0.5,
    });
    /* The same three numbers the mirror boxes above are built from, so the
     * two cannot disagree: the stalk hangs off the A-pillar at screen[0], the
     * shell reaches 155 mm past 99 per cent of the half width there, and it is
     * 150 mm long. Taken as a disc of the shell's plan diagonal. */
    const fr = place(spec, s);
    const mu = s.screen[0] * s.len + 0.10;
    const wOut = at(s.hw, s.screen[0]) * 0.99;
    for (const sgn of [-1, 1]) {
      const p = fr.p(sgn * (wOut + 0.105), 0, mu);
      out.push({ what: `${tag} mirror`, kind: 'mirror', x: p[0], z: p[2], r: 0.087 });
    }
  }
  return out;
}

/* ── Assembly ───────────────────────────────────────────────────────────── */

export type BuiltCars = {
  body: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  wheel: THREE.BufferGeometry;
  shade: THREE.BufferGeometry;
  triangles: number;
  lights: CarLight[];
  dispose(): void;
};

export function buildCars(specs: readonly CarSpec[] = PARKED): BuiltCars {
  const B = new Hull({ aCar: 4, aCarB: 4, aCarC: 4 });
  const G = new Hull({ aGl: 4, aGlUV: 4 });
  const W = new Hull({ aWhl: 4, aWhlB: 2 });
  const S = new Hull({ aShade: 4, aShadeB: 4 });
  const c: Ctx = { B, G, W, S };
  const lights: CarLight[] = [];

  for (const spec of specs) {
    const s = SHAPES[spec.kind];
    emitBody(c, spec, s);

    const fr = place(spec, s);
    const halfT = s.trackHalf;
    for (const [lz, front] of [[s.frontOh, true], [s.frontOh + s.wheelbase, false]] as const) {
      /* Steering. Nobody leaves the wheel straight when they park against a
       * kerb, and a front wheel turned five to twelve degrees is one of the
       * few asymmetries a parked car has. Which way is decided per car. */
      const st = front ? (h2(spec.seed, 3.3) - 0.35) * 0.30 : 0;
      for (const sgn of [-1, 1]) emitWheel(W, fr, s, spec, sgn * halfT, lz, st * sgn * 0 + st);
    }

    emitShade(S, spec, s);

    if (spec.sidelights) {
      const zT = s.len - 0.02, zN = 0.02;
      const yT = (s.lampY[0] + s.lampY[1]) * 0.5;
      const yN = (s.headY[0] + s.headY[1]) * 0.5;
      const wOut = at(s.hw, 0.97) * 0.72;
      for (const sgn of [-1, 1]) {
        const p = fr.p(sgn * wOut, yT, zT);
        lights.push({
          kind: 'sidelight-rear', pos: p, dir: fr.n(0, 0, 1),
          width: 0.24, height: s.lampY[1] - s.lampY[0], colour: LIT_TAIL,
        });
        const q = fr.p(sgn * at(s.hw, 0.03) * 0.74, yN, zN);
        lights.push({
          kind: 'sidelight-front', pos: q, dir: fr.n(0, 0, -1),
          width: 0.22, height: s.headY[1] - s.headY[0], colour: LIT_NOSE,
        });
      }
    }
  }

  const body = B.geometry(), glass = G.geometry();
  const wheel = W.geometry(), shade = S.geometry();
  const triangles = B.triangleCount + G.triangleCount + W.triangleCount + S.triangleCount;

  return {
    body, glass, wheel, shade, triangles, lights,
    dispose() { body.dispose(); glass.dispose(); wheel.dispose(); shade.dispose(); },
  };
}
