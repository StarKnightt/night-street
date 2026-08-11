/* Street geometry.
 *
 * The carriageway, the kerbs and the footways are built as real surfaces with
 * real heights rather than as flat quads with a texture pretending. That
 * matters more at night than it does in daylight: almost everything the eye
 * uses to read a wet road is a *specular* cue, and a specular highlight only
 * moves if the surface under it actually tilts. A flat plane with a beautiful
 * roughness map still looks like a photograph of a road printed on lino.
 *
 * Everything is driven from one seed. No Math.random.
 */
import * as THREE from 'three';
import { DIMS, FIXTURES, WORLD_SEED } from './dims';
import { Noise2D, clamp, smoothstep } from './noise';

const noise = new Noise2D(WORLD_SEED);
const settleNoise = new Noise2D(WORLD_SEED + 977);

/**
 * Low-frequency settling of the carriageway, in metres, negative for a dip.
 *
 * Kept separate from the camber because the shader needs it on its own: damp
 * patches and standing water key off *this*, not off the total height, so
 * that water collects in the settled hollows rather than uniformly along the
 * kerb where the camber is always lowest.
 */
export function roadSettle(x: number, z: number): number {
  const broad = settleNoise.fbm(x * 0.055, z * 0.031, 4) * 0.040;
  const mid = settleNoise.fbm(x * 0.21 + 11.3, z * 0.14 - 4.1, 3) * 0.014;
  const fine = noise.fbm(x * 0.62, z * 0.48, 2) * 0.005;
  return broad + mid + fine;
}

/* Where the ironwork is, and how big a hole in the road it needs.
 *
 * Kept here rather than read from FIXTURES so that roadHeight has no import
 * cycle with the placement table, and so the radii can be the *dish* radii,
 * which are larger than the castings.
 */
type Dish = { x: number; z: number; r: number };
const DISHES: Dish[] = [
  ...FIXTURES.manholes.map((m): Dish => ({ x: m.x, z: m.z, r: m.r + 0.62 })),
  ...FIXTURES.drains.map((d): Dish => ({
    x: d.x * (DIMS.roadHalf - 0.33), z: d.z, r: 0.86,
  })),
];

/**
 * The depression around a casting.
 *
 * Nothing in a road is flush with it. A cover is set on a frame that was
 * bedded years ago and has been driven over a million times since, so the
 * asphalt around it has consolidated into a shallow saucer twenty or thirty
 * millimetres deep that you feel through a car's suspension before you see it.
 *
 * It is also the only way the ironwork is visible at all. The first version
 * placed each cover 13 mm *below* roadHeight on the reasoning that covers sit
 * low — but the carriageway is a continuous surface with no hole cut in it, so
 * every fixture was rendering perfectly, underneath the road, in all six
 * frames. Dishing the road is what makes the space for them.
 */
export function fixtureDish(x: number, z: number): number {
  let d = 0;
  for (const f of DISHES) {
    const dx = (x - f.x) / f.r, dz = (z - f.z) / f.r;
    const q = dx * dx + dz * dz;
    if (q < 1) {
      const t = 1 - q;
      d -= 0.028 * t * t;
    }
  }
  return d;
}

/** Height of the carriageway surface at a point, centreline crown at y = 0. */
export function roadHeight(x: number, z: number): number {
  const a = Math.abs(x) / DIMS.roadHalf;
  // Parabolic crown, which is what a paver actually lays; a linear cross-fall
  // gives a visible ridge down the middle of the specular highlight.
  const crown = -DIMS.camber * a * a;
  const gutter = -DIMS.gutterDrop *
    smoothstep(DIMS.roadHalf - DIMS.gutterWidth, DIMS.roadHalf, Math.abs(x));
  return crown + gutter + roadSettle(x, z) + fixtureDish(x, z);
}

/** Per-flag settlement of the footway, in metres. */
function slabSettle(x: number, z: number): number {
  const s = DIMS.slab;
  const ix = Math.floor(x / s), iz = Math.floor(z / s);
  // One value per flag, plus a tilt so flags lean rather than step.
  const h = settleNoise.n(ix * 3.7 + 0.5, iz * 2.3 + 0.5);
  const tiltX = settleNoise.n(ix * 3.7 + 41.5, iz * 2.3 + 12.5);
  const tiltZ = settleNoise.n(ix * 3.7 + 77.5, iz * 2.3 + 91.5);
  const fx = x / s - ix - 0.5, fz = z / s - iz - 0.5;
  // Tapered to zero at the joints so adjacent flags meet, then a slight dish
  // in the middle: old flags are worn hollow, not domed.
  const taper = (1 - Math.abs(fx) * 2) * (1 - Math.abs(fz) * 2);
  const t = Math.max(0, taper) ** 0.55;
  /* Amplitudes trimmed by about a third for the low sun.
   *
   * These were set by eye under a lamp almost overhead, where a centimetre of
   * dish across a flag barely shows. With the key at four degrees the same
   * centimetre throws a fifth of a metre of shadow, so every flag picked up a
   * black band a quarter of its width and the footway read as a grid of slots
   * rather than as paving. The relief is still doing the job it was added for
   * — flags that lean and hold water — but at a depth that a well-laid
   * footway would actually have. */
  return (h * 0.0052 + tiltX * fx * 0.0062 + tiltZ * fz * 0.0062) * t - t * 0.0011;
}

/** Per-kerbstone settlement, constant along one block so the joints step. */
function kerbSettle(z: number): number {
  const b = DIMS.kerbBlock;
  const i = Math.floor(z / b);
  const f = z / b - i - 0.5;                     // -0.5 .. 0.5 within one block
  /* Each stone sits at its own height and leans its own way.
   *
   * At the previous amplitude — seven millimetres, constant along a block —
   * the top of the kerb was, for all practical purposes, a straight line, and
   * three separate reviewers have now described the arris the same way: a
   * single unbroken one-pixel highlight running to the vanishing point. That
   * is the classic aliasing candidate, and it is also just wrong. A kerb is
   * individual stones an eighth of a tonne each, bedded by hand on mortar, and
   * after a few winters of frost and a few lorries mounting them they sit at
   * visibly different heights and tip fore and aft. The joint between two of
   * them is a step you can catch a toe on.
   *
   * The tilt is the important half: a per-block offset alone still gives every
   * stone a level top, so the arris becomes a staircase of straight segments.
   * Leaning them puts a kink at every joint, which is what actually breaks the
   * line up. */
  const h = settleNoise.n(i * 5.1 + 0.5, 13.7);
  const tilt = settleNoise.n(i * 5.1 + 91.5, 44.3);
  return h * 0.0165 + tilt * f * 0.0210;
}

/** Height of the footway surface, matching buildWalkGeometry exactly. */
export function walkHeight(x: number, z: number): number {
  const side = Math.sign(x) || 1;
  const inner = DIMS.roadHalf + DIMS.kerbDepth;
  const across = clamp(Math.abs(x) - inner, 0, DIMS.walkWidth);
  const y0 = roadHeight(DIMS.roadHalf * side, z) + DIMS.kerbHeight +
    kerbSettle(z * side + (side < 0 ? 400 : 0));
  return y0 + 0.0022 + DIMS.walkFall * (across / DIMS.walkWidth) + slabSettle(x, z);
}

function addAttrs(
  g: THREE.BufferGeometry,
  pos: number[], uv: number[], idx: number[], extra?: Record<string, number[]>,
) {
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      g.setAttribute(k, new THREE.Float32BufferAttribute(v, 1));
    }
  }
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}

/**
 * The carriageway.
 *
 * `aSettle` rides along as a vertex attribute so the fragment shader can put
 * water where the geometry is actually low without having to reimplement the
 * CPU noise in GLSL and hope the two agree.
 */
export function buildRoadGeometry(): THREE.BufferGeometry {
  const stepZ = 0.30, stepX = 0.19;
  const nz = Math.round((DIMS.zMax - DIMS.zMin) / stepZ);
  const nx = Math.round((DIMS.roadHalf * 2) / stepX);

  const pos: number[] = [], uv: number[] = [], settle: number[] = [], idx: number[] = [];
  for (let j = 0; j <= nz; j++) {
    const z = DIMS.zMax - j * stepZ;
    for (let i = 0; i <= nx; i++) {
      const x = -DIMS.roadHalf + i * stepX;
      pos.push(x, roadHeight(x, z), z);
      // uv in metres; the material scales it down to one tile per patch.
      uv.push(x, z);
      settle.push(roadSettle(x, z));
    }
  }
  /* Winding. `i` runs +X and `j` runs -Z, so (a, b, c) is the order whose
   * cross product points at +Y. Getting this backwards produces a road that
   * renders perfectly and is invisible, because every triangle on it is
   * back-facing. */
  const w = nx + 1;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  return addAttrs(new THREE.BufferGeometry(), pos, uv, idx, { aSettle: settle });
}

type ProfilePoint = { x: number; y: number; u: number };

/** Sweep a cross-section along -Z, mirrored onto both sides of the street. */
function sweep(
  profile: (side: number, z: number) => ProfilePoint[],
  stepZ: number,
): THREE.BufferGeometry {
  const nz = Math.round((DIMS.zMax - DIMS.zMin) / stepZ);
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  let base = 0;

  for (const side of [1, -1]) {
    const first = profile(side, DIMS.zMax);
    const np = first.length;
    for (let j = 0; j <= nz; j++) {
      const z = DIMS.zMax - j * stepZ;
      const pts = profile(side, z);
      for (const p of pts) {
        pos.push(p.x, p.y, z);
        uv.push(p.u, z);
      }
    }
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < np - 1; i++) {
        const a = base + j * np + i, b = a + 1, c = a + np, d = c + 1;
        // The profile runs outward from the centreline, so its direction in
        // world X flips with the side of the street and the winding has to
        // flip with it to keep both footways facing up.
        if (side > 0) idx.push(a, b, c, b, d, c);
        else idx.push(a, c, b, b, c, d);
      }
    }
    base += (nz + 1) * np;
  }
  return addAttrs(new THREE.BufferGeometry(), pos, uv, idx);
}

/**
 * The kerb: face, chamfered arris and the narrow granite top.
 *
 * The chamfer is 34 mm of run and it is not decoration. A square arris on a
 * kerb is the most reliable single giveaway of an untextured CG street,
 * because the real thing always carries a bright line along that bevel from
 * whatever light is on it — it is often the brightest edge in a night frame.
 */
export function buildKerbGeometry(): THREE.BufferGeometry {
  const { roadHalf, kerbHeight, kerbChamfer, kerbDepth } = DIMS;
  return sweep((side, z) => {
    const x0 = roadHalf * side;
    const y0 = roadHeight(roadHalf * side, z);
    const st = kerbSettle(z * side + (side < 0 ? 400 : 0));
    const top = y0 + kerbHeight + st;
    // A tiny outward lean; kerbs are never plumb after fifty years of frost.
    const lean = settleNoise.n(z * 0.18 + (side < 0 ? 60 : 0), 3.3) * 0.006;
    return [
      { x: x0, y: y0 - 0.02, u: 0 },
      { x: x0 + lean * side, y: y0 + kerbHeight * 0.62 + st, u: kerbHeight * 0.62 },
      { x: x0 + lean * side, y: top - kerbChamfer * 0.55, u: kerbHeight - kerbChamfer * 0.55 },
      { x: (x0 + kerbChamfer * side), y: top, u: kerbHeight + 0.02 },
      { x: (x0 + kerbDepth * side), y: top + 0.0022, u: kerbHeight + kerbDepth },
    ];
  }, 0.19);
}

/** The footway: from the back of the kerb to the building line. */
export function buildWalkGeometry(): THREE.BufferGeometry {
  const { roadHalf, kerbHeight, kerbDepth, walkWidth, walkFall } = DIMS;
  const inner = roadHalf + kerbDepth;
  const steps = 14;
  return sweep((side, z) => {
    const y0 = roadHeight(roadHalf * side, z) + kerbHeight + kerbSettle(z * side + (side < 0 ? 400 : 0));
    const pts: ProfilePoint[] = [];
    for (let i = 0; i <= steps; i++) {
      const f = i / steps;
      const across = f * walkWidth;
      const x = (inner + across) * side;
      const y = y0 + 0.0022 + walkFall * f + slabSettle(x, z);
      pts.push({ x, y, u: kerbHeight + kerbDepth + across });
    }
    return pts;
  }, 0.21);
}

/**
 * A manhole cover and its frame, sunk into the carriageway.
 *
 * Covers are never flush. The frame is bedded in a ring of patched asphalt
 * that has settled around it, the cover sits a few millimetres below the
 * frame, and the whole assembly ends up 10–20 mm low. Getting that step right
 * is most of why one reads as ironwork in a road rather than a disc on it.
 */
export function buildManholeGeometry(r: number): THREE.BufferGeometry {
  const seg = 40;
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];

  // Cover top: a disc with uv radial from the centre so the pattern can be
  // drawn in texture space.
  pos.push(0, 0, 0); uv.push(0.5, 0.5);
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    pos.push(Math.cos(a) * r, 0, Math.sin(a) * r);
    uv.push(0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
  }
  for (let i = 0; i < seg; i++) idx.push(0, i + 2, i + 1);

  // Frame ring, 55 mm wide, standing 8 mm above the cover.
  const ringBase = pos.length / 3;
  const r1 = r + 0.006, r2 = r + 0.058;
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    pos.push(c * r1, -0.008, s * r1); uv.push(0.5 + c * 0.5, 0.5 + s * 0.5);
    pos.push(c * r1, 0.008, s * r1); uv.push(0.5 + c * 0.49, 0.5 + s * 0.49);
    pos.push(c * r2, 0.010, s * r2); uv.push(0.5 + c * 0.44, 0.5 + s * 0.44);
  }
  for (let i = 0; i < seg; i++) {
    const a = ringBase + i * 3, b = ringBase + (i + 1) * 3;
    idx.push(a, b, a + 1, b, b + 1, a + 1);             // inner wall, facing in
    idx.push(a + 1, b + 1, a + 2, b + 1, b + 2, a + 2); // frame top, facing up
  }

  return addAttrs(new THREE.BufferGeometry(), pos, uv, idx);
}

/**
 * A gully grate at the gutter line.
 *
 * The first version of this modelled the nine bars as nine separate 26 mm
 * boxes with open air between them. That is how the real casting is shaped and
 * it was completely wrong as geometry: at five metres each bar covers about two
 * pixels, there is no mip chain on a triangle edge, and the whole grate
 * disintegrated into a flickering diagonal comb that was the loudest artifact
 * in the frame. Thin repeated geometry at grazing incidence is a texture
 * problem wearing a mesh costume.
 *
 * So the grate is now one recessed slab and the slots live in the material,
 * where they get mipmapped and anisotropically filtered like everything else.
 * A shallow black sump box sits under it so the slots have something dark to be
 * dark against rather than showing whatever is behind the road.
 */
export function buildDrainGeometry(): THREE.BufferGeometry {
  const W = 0.60, L = 0.96, DROP = 0.014, SUMP = 0.16;
  const parts: THREE.BufferGeometry[] = [];
  const push = (w: number, h: number, d: number, x: number, y: number, z: number) => {
    const g = new THREE.BoxGeometry(w, h, d);
    g.translate(x, y, z);
    parts.push(g);
  };
  // The sump: an open-topped box the grate sits over. Only ever seen as the
  // dark behind the slots, so it is as crude as it can be.
  push(W, SUMP, L, 0, -SUMP / 2 - DROP, 0);
  // The casting itself, one slab, recessed below the surrounding asphalt.
  push(W, 0.030, L, 0, -DROP, 0);
  const merged = mergeBoxes(parts);
  parts.forEach((p) => p.dispose());
  return merged;
}

/**
 * A skirt hanging from the outer edge of the footway.
 *
 * Without it the pavement ends in mid-air and its slab thickness is silhouetted
 * against the sky, which is the most artificial line in the frame — a ground
 * plane that visibly stops. Buildings are System 2 and will replace this, but
 * until they exist something has to close the horizon off, and a dark vertical
 * face at the building line is both the cheapest and the most honest stand-in:
 * it is what is actually there.
 */
export function buildWalkSkirtGeometry(): THREE.BufferGeometry {
  const { roadHalf, kerbDepth, walkWidth } = DIMS;
  const DEPTH = 0.34;
  const stepZ = 0.6;
  const nz = Math.round((DIMS.zMax - DIMS.zMin) / stepZ);
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  let base = 0;
  for (const side of [1, -1]) {
    const x = (roadHalf + kerbDepth + walkWidth) * side;
    for (let j = 0; j <= nz; j++) {
      const z = DIMS.zMax - j * stepZ;
      const top = walkHeight(x, z);
      pos.push(x, top, z); uv.push(z, 0);
      pos.push(x, top - DEPTH, z); uv.push(z, DEPTH);
    }
    for (let j = 0; j < nz; j++) {
      const a = base + j * 2, b = a + 1, c = a + 2, d = a + 3;
      if (side > 0) idx.push(a, c, b, b, c, d);
      else idx.push(a, b, c, b, d, c);
    }
    base += (nz + 1) * 2;
  }
  return addAttrs(new THREE.BufferGeometry(), pos, uv, idx);
}

/** A steel utility plate lying proud of the paving. */
export function buildPlateGeometry(w: number, d: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, 0.014, d);
  g.translate(0, 0.007, 0);
  return g;
}

/**
 * The apron: dark ground either side, out past the fog.
 *
 * Every frame in the first two capture sets ended in a convex brow at the
 * vanishing point that read as a hill crest, and it took a fog-off render to
 * see that nothing was actually rising. A fourteen-metre strip of ground with
 * void on both sides silhouettes as a wedge: the two footway edges converge on
 * the horizon point and the eye reads the apex as a summit. There was no hill.
 * There was no horizon either, which is the actual problem — a horizon is what
 * you get when the ground keeps going.
 *
 * So it keeps going. Three hundred metres of it each way, a quarter of a metre
 * below the footway and dark enough that no lamp finds it, which is what the
 * far side of a city block looks like at night anyway. Buildings are System 2
 * and will stand on this; until they do it is the only thing that turns the
 * brow into a flat, hazed-out horizon line.
 */
export function buildApronGeometry(): THREE.BufferGeometry {
  const { roadHalf, kerbDepth, walkWidth } = DIMS;
  const inner = roadHalf + kerbDepth + walkWidth;
  /* Sized so the plane cannot be seen ending, in any direction, from anywhere on
   * the walk. The fog reaches full extinction by 165 m of path length, so an edge
   * at 320 m was already past it — but the fog was measuring depth along the view
   * axis rather than distance, so the sideways edge was being lit as though it
   * were sixty metres away and stayed visible. That is fixed in haze.ts; this is
   * the second belt. Going to 900 m puts every edge five times past extinction,
   * which costs four vertices. */
  const OUT = 900, y = DIMS.kerbHeight - 0.26;
  const z0 = DIMS.zMax + 240, z1 = DIMS.zMin - 900;

  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  let base = 0;
  for (const side of [1, -1]) {
    const xi = inner * side, xo = (inner + OUT) * side;
    pos.push(xi, y, z0); uv.push(0, 0);
    pos.push(xo, y, z0); uv.push(1, 0);
    pos.push(xi, y, z1); uv.push(0, 1);
    pos.push(xo, y, z1); uv.push(1, 1);
    if (side > 0) idx.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    else idx.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    base += 4;
  }
  return addAttrs(new THREE.BufferGeometry(), pos, uv, idx);
}

function mergeBoxes(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  let vcount = 0, icount = 0;
  for (const p of parts) {
    vcount += p.attributes.position.count;
    icount += p.index ? p.index.count : 0;
  }
  const pos = new Float32Array(vcount * 3);
  const nor = new Float32Array(vcount * 3);
  const uv = new Float32Array(vcount * 2);
  const idx = new Uint32Array(icount);
  let vo = 0, io = 0;
  for (const p of parts) {
    const pa = p.attributes.position.array as ArrayLike<number>;
    const na = p.attributes.normal.array as ArrayLike<number>;
    const ua = p.attributes.uv.array as ArrayLike<number>;
    const n = p.attributes.position.count;
    pos.set(pa, vo * 3); nor.set(na, vo * 3); uv.set(ua, vo * 2);
    const pi = p.index!.array as ArrayLike<number>;
    for (let i = 0; i < pi.length; i++) idx[io + i] = pi[i] + vo;
    vo += n; io += pi.length;
  }
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  out.computeBoundingSphere();
  return out;
}

export { clamp };
