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
  },
};

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
  const arch = (axleU: number, sillY: number) => {
    const apex = s.wheelR * 2 - 0.008 + 0.070;
    const w = s.wheelR * 1.24;
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
    [wS * (inArch ? 0.972 : 0.985), yb + 0.004],
    /* The arch lip. A pressed arch is not a cut edge: the skin turns out by ten
     * or fifteen millimetres before it turns under to the liner, and that lip
     * is a hard little convexity that runs the whole arc and catches a line of
     * light along the top of it at any sun angle. Without it the opening is a
     * hole in a sheet and the tyre reads as pasted behind it. */
    [wS * (inArch ? 1.022 : 1.000), yb + (inArch ? 0.024 : 0.030)],
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

  return { u, z: u * s.len, pt: refine(base), gh };
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
        setB(CAR.CABIN, uM, yMid, side);
        c.B.quad(off(a, na, -0.005), na, off(b, nb, -0.005), nb,
          off(cc, nc, -0.005), nc, off(d, nd, -0.005), nd, uvs);

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
        const gq: [V3, V3][] = [
          [off(a, na, 0.010), na], [off(b, nb, 0.010), nb],
          [off(cc, nc, 0.010), nc], [off(d, nd, 0.010), nd],
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
  for (const end of [0, NS - 1]) {
    const nose = end === 0;
    const st = St[end];
    const cy = (st.pt[PT(0)][1] + st.pt[PT(HALF - 1)][1]) * 0.5;
    const cen: V3 = fr.p(0, cy, st.z);
    setB(nose ? CAR.CAP_F : CAR.CAP_R, nose ? 0 : 1, cy, 0);
    for (let j = 0; j < NSEC; j++) {
      const jb = (j + 1) % NSEC;
      const A = fr.p(st.pt[j][0], st.pt[j][1], st.z);
      const Bp = fr.p(st.pt[jb][0], st.pt[jb][1], st.z);
      // (lateral, height), both in metres; see the note on CAP_R.
      const uvA: [number, number] = [st.pt[j][0], st.pt[j][1]];
      const uvB: [number, number] = [st.pt[jb][0], st.pt[jb][1]];
      const uvC: [number, number] = [0, cy];
      if (nose) c.B.tri(A, cen, Bp, [uvA, uvC, uvB]);
      else c.B.tri(A, Bp, cen, [uvA, uvB, uvC]);
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

  /* Door mirrors. Two boxes on a stalk, at the base of the A-pillar, and they
   * matter out of all proportion to their size: a car with no mirrors reads as
   * a soap bar, and the mirror is the only thing that breaks the greenhouse
   * silhouette. */
  const mu = s.screen[0] * s.len + 0.10;
  const my = at(s.deck, s.screen[0]) + 0.055;
  for (const sgn of [-1, 1]) {
    const wOut = at(s.hw, s.screen[0]) * 0.99;
    setB(CAR.TRIM, s.screen[0], my, sgn);
    box(c.B, fr, sgn * (wOut + 0.055), my - 0.045, mu - 0.075,
      sgn * (wOut + 0.155), my + 0.055, mu + 0.075);
    box(c.B, fr, sgn * (wOut - 0.02), my - 0.020, mu - 0.030,
      sgn * (wOut + 0.070), my + 0.030, mu + 0.030);
  }
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
      W.quad(at3(i, k), nrm(i, k), at3(i, k + 1), nrm(i, k + 1),
        at3(i2, k + 1), nrm(i2, k + 1), at3(i2, k), nrm(i2, k),
        [[i / sides, k], [i / sides, k + 1], [i2 / sides, k + 1], [i2 / sides, k]]);
    }
  }

  // The rim face, fanned. The spokes are drawn in the shader: at 150 mm across
  // in the near field and eight pixels at forty metres, modelled spokes would
  // be several hundred triangles that alias into a grey disc.
  for (const outer of [1, -1]) {
    W.attr('aWhl', spec.seed, WHL.RIM, spec.dirt, spec.age);
    const wf = outer * 0.80;
    const n = fr.n(outer * cst, 0, outer * sst);
    const cen = fr.pw(lx + hw * wf * cst, yc, lz + hw * wf * sst);
    for (let i = 0; i < sides; i++) {
      const i2 = (i + 1) % sides;
      const p = (q: number): V3 => {
        const a = (q / sides) * Math.PI * 2;
        let py = yc + Math.sin(a) * rim;
        const pr = Math.cos(a) * rim;
        if (py < flat) py = flat;
        return fr.pw(lx + hw * wf * cst - pr * sst, py, lz + hw * wf * sst + pr * cst);
      };
      const uvA: [number, number] = [Math.cos((i / sides) * Math.PI * 2), Math.sin((i / sides) * Math.PI * 2)];
      const uvB: [number, number] = [Math.cos((i2 / sides) * Math.PI * 2), Math.sin((i2 / sides) * Math.PI * 2)];
      if (outer > 0) W.tri(p(i), cen, p(i2), [uvA, [0, 0], uvB]);
      else W.tri(p(i), p(i2), cen, [uvA, uvB, [0, 0]]);
    }
  }
}

/* ── Contact shadow ─────────────────────────────────────────────────────── */

/*
 * The dark under the car, which the shadow map cannot deliver.
 *
 * At 4.2 degrees the sun's own shadow of a car is a 20 m streak thrown sideways
 * across the street, and it is not under the car at all. What is under the car
 * is an absence of *sky*: the largest source in this scene is the dome, and a
 * car occludes essentially all of it from the metre of road beneath it. Nothing
 * in the renderer models that — the environment probe is unoccluded — so the
 * car would sit on road lit as brightly as the road beside it, which is the
 * "sticker" failure the brief names.
 *
 * So it is stated: a multiply decal, following the camber, darkest under the
 * body centreline and tightening under each tyre. Multiply rather than an
 * alpha-blended black, because this is an occlusion of light already in the
 * frame and not a new dark object; and unlit and untonemapped, because it has
 * to act on the display value the road has already resolved to.
 */
function emitShade(S: Hull, spec: CarSpec, s: Shape): void {
  const cs = Math.cos(spec.yaw), sn = Math.sin(spec.yaw);
  const hl = s.len * 0.5 + 0.55, hwd = s.wide * 0.5 + 0.42;
  const NX = 6, NZ = 10;
  const axleF = (s.frontOh - s.len * 0.5) / hl;
  const axleR = (s.frontOh + s.wheelbase - s.len * 0.5) / hl;
  S.attr('aShade', spec.seed, axleF, axleR, (s.trackHalf + s.tyreW * 0.5) / hwd);
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
      S.quad(P(x0, z0), up, P(x1, z0), up, P(x1, z1), up, P(x0, z1), up,
        [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]);
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
  const S = new Hull({ aShade: 4 });
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
