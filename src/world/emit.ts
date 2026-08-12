/* Local-frame geometry emission.
 *
 * Every building surface in this project is a flat quad in the frame of the
 * facade it belongs to — a wall panel, a window reveal, a sill top, the side
 * of an air conditioner. Writing those in world coordinates means every
 * builder has to know which way its facade points, and the moment one of them
 * gets it wrong the geometry renders perfectly and is invisible, because all
 * of its triangles are back-facing. That failure has already cost this project
 * once, in buildRoadGeometry.
 *
 * So the whole of System 2 is authored in a right-handed local frame:
 *
 *   u  along the facade, in metres from one end
 *   y  world height, in metres
 *   d  outward from the facade plane, in metres, positive toward the street
 *
 * and the frame is defined by its origin and its u direction alone. The
 * outward normal is *derived*, as up x uDir, so a facade cannot be built
 * facing the wrong way — the only thing a caller can get wrong is which end
 * of the wall u starts at.
 *
 * Winding follows from the same rule. For a quad given as
 * (u0,y0) (u0,y1) (u1,y1) (u1,y0) the cross product of the first two edges is
 * up x uDir times a positive area, which is the outward normal, so a caller
 * that lists corners counter-clockwise as seen from *outside* always gets a
 * front face. Every helper below is written that way and normals are computed
 * per quad rather than averaged, because architecture is flat and a smoothed
 * normal across a corner is a visible seam.
 */
import * as THREE from 'three';

export type Frame = {
  /** World x,z of the local origin, at u = 0, d = 0. */
  ox: number; oz: number;
  /** Unit direction of increasing u, in the ground plane. */
  ux: number; uz: number;
  /** Outward normal, up x uDir. */
  nx: number; nz: number;
};

export function frame(ox: number, oz: number, ux: number, uz: number): Frame {
  const l = Math.hypot(ux, uz) || 1;
  const x = ux / l, z = uz / l;
  return { ox, oz, ux: x, uz: z, nx: z, nz: -x };
}

type V3 = readonly [number, number, number];

/**
 * A growing indexed triangle soup with arbitrary extra float attributes.
 *
 * The extra attributes are set once and then ride along on every vertex until
 * they are set again, which suits the way facades are actually built: a whole
 * building's worth of quads shares one window lattice and one seed, and only
 * the surface role changes from group to group.
 */
export class Emit {
  readonly pos: number[] = [];
  readonly nor: number[] = [];
  readonly uv: number[] = [];
  readonly idx: number[] = [];
  private readonly spec: [string, number][] = [];
  private readonly data: Record<string, number[]> = {};
  private readonly cur: Record<string, number[]> = {};

  constructor(spec: Record<string, number> = {}) {
    for (const [k, size] of Object.entries(spec)) {
      this.spec.push([k, size]);
      this.data[k] = [];
      this.cur[k] = new Array(size).fill(0);
    }
  }

  /** Set the value every subsequent vertex carries for one attribute. */
  attr(name: string, ...v: number[]): this {
    this.cur[name] = v;
    return this;
  }

  get vertexCount() { return this.pos.length / 3; }
  get triangleCount() { return this.idx.length / 3; }

  /** One quad, corners counter-clockwise seen from the front. */
  quad(a: V3, b: V3, c: V3, d: V3, uvs: readonly [number, number][]): void {
    const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2];
    const fx = c[0] - a[0], fy = c[1] - a[1], fz = c[2] - a[2];
    let nx = ey * fz - ez * fy, ny = ez * fx - ex * fz, nz = ex * fy - ey * fx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;

    const base = this.vertexCount;
    const corners = [a, b, c, d];
    for (let i = 0; i < 4; i++) {
      const p = corners[i];
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(nx, ny, nz);
      this.uv.push(uvs[i][0], uvs[i][1]);
      for (const [k] of this.spec) this.data[k].push(...this.cur[k]);
    }
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
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

/**
 * A facade's local frame bound to an emitter.
 *
 * uv is always (u, y) in metres unless a helper has a reason to do otherwise,
 * because every material in System 2 is analytic in facade coordinates: brick
 * courses run in u, staining runs in y, and nothing is sampled from a tile
 * that could repeat.
 */
export class Face {
  readonly e: Emit;
  readonly f: Frame;

  /* Written out rather than as constructor parameter properties, which is the
   * same two fields and one line longer. The reason is tooling: Node runs the
   * TypeScript in this tree directly, in strip-only mode, and a parameter
   * property is the one piece of TypeScript syntax that has a runtime effect
   * and so cannot be stripped. With it here, *any* tool that reaches this file
   * through an import chain dies at load — which as of the prop pass includes
   * `tools/route.mjs` and `tools/collide.mjs`, because the collider now reads
   * the shared placement table and that reaches the facade layout. Being
   * loadable outside a bundler is worth a line. */
  constructor(e: Emit, f: Frame) {
    this.e = e;
    this.f = f;
  }

  /** Local (u, y, d) to world. */
  p(u: number, y: number, d: number): V3 {
    const { ox, oz, ux, uz, nx, nz } = this.f;
    return [ox + ux * u + nx * d, y, oz + uz * u + nz * d];
  }

  /** A vertical panel in the facade plane, facing out. */
  panel(u0: number, u1: number, y0: number, y1: number, d: number): void {
    this.e.quad(
      this.p(u0, y0, d), this.p(u0, y1, d), this.p(u1, y1, d), this.p(u1, y0, d),
      [[u0, y0], [u0, y1], [u1, y1], [u1, y0]],
    );
  }

  /** The same panel facing the other way — a back wall, or the inside of a parapet. */
  panelIn(u0: number, u1: number, y0: number, y1: number, d: number): void {
    this.e.quad(
      this.p(u0, y0, d), this.p(u1, y0, d), this.p(u1, y1, d), this.p(u0, y1, d),
      [[u0, y0], [u1, y0], [u1, y1], [u0, y1]],
    );
  }

  /**
   * A vertical plane at constant u — a window reveal, a party-wall flank.
   * `sign` is +1 for a face whose normal points along +u.
   */
  jamb(u: number, d0: number, d1: number, y0: number, y1: number, sign: number): void {
    const [a, b] = sign > 0 ? [d0, d1] : [d1, d0];
    this.e.quad(
      this.p(u, y0, a), this.p(u, y0, b), this.p(u, y1, b), this.p(u, y1, a),
      [[u + a, y0], [u + b, y0], [u + b, y1], [u + a, y1]],
    );
  }

  /** A horizontal plane — a sill top, a coping, a soffit. `up` false faces down. */
  deck(u0: number, u1: number, d0: number, d1: number, y: number, up = true): void {
    const [a, b] = up ? [d0, d1] : [d1, d0];
    this.e.quad(
      this.p(u0, y, a), this.p(u1, y, a), this.p(u1, y, b), this.p(u0, y, b),
      [[u0, y + a], [u1, y + a], [u1, y + b], [u0, y + b]],
    );
  }

  /** A closed box in local coordinates. Extents are sorted: a box handed its
   *  corners the wrong way round would be wound inside out, and there are
   *  several hundred of them placed from hashed positions. */
  box(u0: number, u1: number, y0: number, y1: number, d0: number, d1: number): void {
    if (u1 < u0) [u0, u1] = [u1, u0];
    if (y1 < y0) [y0, y1] = [y1, y0];
    if (d1 < d0) [d0, d1] = [d1, d0];
    this.panel(u0, u1, y0, y1, d1);
    this.panelIn(u0, u1, y0, y1, d0);
    this.jamb(u1, d0, d1, y0, y1, +1);
    this.jamb(u0, d0, d1, y0, y1, -1);
    this.deck(u0, u1, d0, d1, y1, true);
    this.deck(u0, u1, d0, d1, y0, false);
  }

  /**
   * A box with one axis free to tilt: the four "vertical" edges stay vertical
   * but the front face is pushed out by `lean` at the top. Used for open
   * sashes and for railings that are not quite plumb.
   */
  quadFree(
    a: readonly [number, number, number], b: readonly [number, number, number],
    c: readonly [number, number, number], d: readonly [number, number, number],
    uvs: readonly [number, number][],
  ): void {
    this.e.quad(
      this.p(a[0], a[1], a[2]), this.p(b[0], b[1], b[2]),
      this.p(c[0], c[1], c[2]), this.p(d[0], d[1], d[2]), uvs,
    );
  }

  /**
   * A prism swept along u with an arbitrary cross-section in (y, d).
   *
   * Cheaper than a box per segment for things like a zigzag stair stringer,
   * and it keeps the ends closed so the shadow pass has front faces wherever
   * the sun happens to be.
   */
  bar(
    u0: number, u1: number,
    /* (y, d) pairs, counter-clockwise in that order — i.e. treating y as the
     * first axis and d as the second. Wound the other way the prism turns
     * inside out and disappears, and it disappears from the shadow pass too. */
    section: readonly (readonly [number, number])[],
  ): void {
    const n = section.length;
    for (let i = 0; i < n; i++) {
      const [y0, d0] = section[i];
      const [y1, d1] = section[(i + 1) % n];
      // Side faces: the outward normal follows from the section winding.
      this.e.quad(
        this.p(u0, y0, d0), this.p(u1, y0, d0), this.p(u1, y1, d1), this.p(u0, y1, d1),
        [[u0, y0], [u1, y0], [u1, y1], [u0, y1]],
      );
    }
    // Caps, fanned from the first vertex.
    for (let i = 1; i < n - 1; i++) {
      const a = section[0], b = section[i], c = section[i + 1];
      this.e.quad(
        this.p(u0, a[0], a[1]), this.p(u0, b[0], b[1]), this.p(u0, c[0], c[1]), this.p(u0, c[0], c[1]),
        [[a[0], a[1]], [b[0], b[1]], [c[0], c[1]], [c[0], c[1]]],
      );
      this.e.quad(
        this.p(u1, a[0], a[1]), this.p(u1, c[0], c[1]), this.p(u1, b[0], b[1]), this.p(u1, b[0], b[1]),
        [[a[0], a[1]], [c[0], c[1]], [b[0], b[1]], [b[0], b[1]]],
      );
    }
  }

  /** An n-sided upright cylinder — vent stacks, chimney pots, downpipe shoes. */
  tube(uc: number, dc: number, r: number, y0: number, y1: number, sides = 8, cap = true): void {
    const pt = (i: number, y: number): V3 => {
      const a = (i / sides) * Math.PI * 2;
      return this.p(uc + Math.cos(a) * r, y, dc + Math.sin(a) * r);
    };
    for (let i = 0; i < sides; i++) {
      this.e.quad(pt(i, y0), pt(i + 1, y0), pt(i + 1, y1), pt(i, y1),
        [[i, y0], [i + 1, y0], [i + 1, y1], [i, y1]]);
    }
    if (!cap) return;
    for (let i = 1; i < sides - 1; i++) {
      this.e.quad(pt(0, y1), pt(i, y1), pt(i + 1, y1), pt(i + 1, y1),
        [[0, 0], [i, 0], [i + 1, 0], [i + 1, 0]]);
    }
  }
}
