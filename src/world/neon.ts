/* System 5: neon, and the traffic signal.
 *
 * Two geometries come out of here and the split between them is the whole
 * design. `neon` is opaque, depth-writing, and carries the tubes, the
 * letterforms and the signal lenses. `glow` is a set of oversized proxies
 * around the same sources, drawn additively with depth *testing* on and depth
 * writing off, and it is the near-field halo — the light scattered in the
 * glass, in the dust on the glass and in the first few centimetres of air.
 *
 * That halo is not bloom and the distinction is the one thing to get right
 * here, because System 8 owns bloom and this would otherwise be built twice.
 * Bloom is a property of the camera: it is the same kernel everywhere, it is
 * applied after the frame is resolved, and it therefore leaks *through* the
 * objects in front of the source. The near-field glow is a property of the
 * scene: it is occluded by the mullion in front of it, it is a different
 * radius on a 15 mm tube than on a 50 mm lens, and it is there in a photograph
 * taken with a lens that does not bloom at all. Depth testing the proxies is
 * what makes them the second thing rather than a hand-rolled copy of the first.
 *
 * ── The tube ──────────────────────────────────────────────────────────────
 *
 * A coloured neon tube is not a Lambertian cylinder. The colour comes from a
 * phosphor coating a few tens of microns thick on the *inside* of the glass,
 * and what the eye receives from a point on the tube is the emission summed
 * along the chord the view ray cuts through that coating. At the centre of the
 * tube the ray crosses the shell twice at normal incidence and the chord is
 * 2t; at the silhouette it runs along the shell and the chord diverges as
 * t/cos. So a tube is *limb brightened* — two bright rails with a duller core
 * — and that is most of what identifies neon at a glance and what a Lambertian
 * cylinder, which is limb darkened, gets exactly backwards.
 *
 * The fix is one line in the fragment shader, `1.0 / max(g, 0.16)`, where g is
 * the cosine between the outward radial direction and the view direction
 * projected across the axis. Its mean over the projected width of the tube is
 * pi/2, so dividing by that keeps the *flux* at the authored level and moves
 * it around rather than adding any: the core comes out at 0.65x the authored
 * radiance and the rails at 3.2x.
 *
 * ── The letterforms ───────────────────────────────────────────────────────
 *
 * Set from the stroke-font atlas in scene/signs.ts, which System 3 already
 * uses for every painted fascia on the street. Building a second lettering
 * system for neon would mean two atlases, two layout conventions and two
 * places for a word to come out mirrored; instead the atlas grew three rows.
 * The row indices arrive as parameters rather than being imported, so this
 * file keeps world/ from depending on scene/.
 */
import * as THREE from 'three';
import { Emit, Face, frame, type Frame } from './emit';
import { walkHeight } from './geometry';
import { layoutBlock } from './block';
import { groundLevels } from './facade';
import type { LitUnit } from './street3';

/** Branches in the neon shader. */
export const NEO = {
  TUBE: 0,    // glass, limb brightened, emissive
  LETTER: 1,  // a panel whose ink is emissive and whose ground is not
  LENS: 2,    // a traffic signal aspect, switched by the clock
  CASE: 3,    // everything that does not emit: boxes, brackets, backboards
} as const;

/** Branches in the glow shader. */
export const GLO = { TUBE: 0, PANEL: 1 } as const;

type RGB = readonly [number, number, number];
type V3 = [number, number, number];

export type NeonPalette = {
  /** The bar sign. */
  red: RGB;
  /** The OPEN sign, which is a stop hotter because it is behind glass. */
  open: RGB;
  /** The pharmacy cross. */
  green: RGB;
  /** Traffic signal aspects, which are LEDs rather than discharge tubes. */
  sigRed: RGB; sigAmber: RGB; sigGreen: RGB;
};

/** Atlas row indices for the three neon words. */
export type NeonRows = { open: number; bar: number; beer: number };

/** What System 5's analytic array needs in order to wash the board behind. */
export type NeonSource = {
  pos: V3; dir: V3; cd: number; colour: RGB; note: string;
};

export type BuiltNeon = {
  neon: THREE.BufferGeometry;
  glow: THREE.BufferGeometry;
  triangles: number;
  sources: NeonSource[];
  /** What the street says, for the report and for the harness. */
  legend: string[];
  dispose(): void;
};

/* ── Tubes in world space ─────────────────────────────────────────────────
 *
 * Emitted directly rather than through Face, and for a reason worth recording:
 * the local (u, y, d) frame is *left handed* — the outward normal is derived
 * as up x uDir, so u cross y is minus d — and every winding rule in emit.ts is
 * stated in terms of quads listed counter-clockwise from outside rather than
 * in terms of a cross product, precisely so that nothing has to know that. A
 * ring of vertices built from a cross product does have to know it, and a
 * cylinder wound inside out is invisible in the beauty pass and in the shadow
 * pass together. Building the ring in world coordinates keeps the ordinary
 * right-handed rule and removes the trap.
 */
function ring(axis: V3): [V3, V3] {
  const up: V3 = Math.abs(axis[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0];
  let e1: V3 = [
    axis[1] * up[2] - axis[2] * up[1],
    axis[2] * up[0] - axis[0] * up[2],
    axis[0] * up[1] - axis[1] * up[0],
  ];
  const l = Math.hypot(...e1) || 1;
  e1 = [e1[0] / l, e1[1] / l, e1[2] / l];
  const e2: V3 = [
    axis[1] * e1[2] - axis[2] * e1[1],
    axis[2] * e1[0] - axis[0] * e1[2],
    axis[0] * e1[1] - axis[1] * e1[0],
  ];
  return [e1, e2];
}

function sub(a: V3, b: V3): V3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function unit(a: V3): V3 {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
/** Face.p returns a readonly triple; the tube builder needs a mutable one. */
const w3 = (p: readonly number[]): V3 => [p[0], p[1], p[2]];

/** A capped cylinder between two world points. Caller sets the attributes. */
function tubeSeg(E: Emit, a: V3, b: V3, r: number, sides = 8): void {
  const axis = unit(sub(b, a));
  const [e1, e2] = ring(axis);
  const at = (p: V3, i: number): V3 => {
    const t = (i / sides) * Math.PI * 2;
    const c = Math.cos(t) * r, s = Math.sin(t) * r;
    return [p[0] + e1[0] * c + e2[0] * s, p[1] + e1[1] * c + e2[1] * s,
            p[2] + e1[2] * c + e2[2] * s];
  };
  for (let i = 0; i < sides; i++) {
    E.quad(at(a, i), at(a, i + 1), at(b, i + 1), at(b, i),
      [[i, 0], [i + 1, 0], [i + 1, 1], [i, 1]]);
  }
  for (let i = 1; i < sides - 1; i++) {
    E.quad(at(b, 0), at(b, i), at(b, i + 1), at(b, i + 1),
      [[0, 0], [i, 0], [i + 1, 0], [i + 1, 0]]);
    E.quad(at(a, 0), at(a, i + 1), at(a, i), at(a, i),
      [[0, 0], [i + 1, 0], [i, 0], [i, 0]]);
  }
}

/* ── The build ────────────────────────────────────────────────────────────── */

export function buildNeon(
  lit: readonly LitUnit[], rows: NeonRows, pal: NeonPalette,
): BuiltNeon {
  /* aNeon  (part, atlas row or signal aspect, cap height, seed)
   * aNeonC (linear rgb of the emission)
   * aRect  LETTER: (centre in the face's uv.x, baseline y, 0, 0)
   *        TUBE:   (a point on the axis)
   * aAxis  TUBE:   (axis direction, tube radius) */
  const N = new Emit({ aNeon: 4, aNeonC: 3, aRect: 4, aAxis: 4 });
  /* aGlow (rgb of the halo at its peak, core radius)
   * aGA   (axis, half length)          PANEL: (face normal, 0)
   * aGP   (centre, kind)               PANEL: (centre, atlas row in .z)
   * kind is 0 for an always-on tube, 1 for a lettering panel, and 2, 3 or 4
   * for a traffic signal aspect, which has to be switchable by the clock. */
  const G = new Emit({ aGlow: 4, aGA: 4, aGP: 4 });

  const sources: NeonSource[] = [];
  const legend: string[] = [];

  const dark = () => N.attr('aNeon', NEO.CASE, 0, 0, 0)
    .attr('aNeonC', 0, 0, 0).attr('aRect', 0, 0, 0, 0).attr('aAxis', 0, 1, 0, 0);

  /** A tube plus its halo proxy, given two world endpoints. */
  const litTube = (a: V3, b: V3, r: number, c: RGB, glowGain = 0.30): void => {
    const axis = unit(sub(b, a));
    N.attr('aNeon', NEO.TUBE, 0, 0, 0)
      .attr('aNeonC', c[0], c[1], c[2])
      .attr('aRect', a[0], a[1], a[2], 0)
      .attr('aAxis', axis[0], axis[1], axis[2], r);
    tubeSeg(N, a, b, r, 8);

    /* The proxy. Five tube radii, which is where the exponential the shader
     * uses has fallen to two per cent of its peak, and extended half a shell
     * past each end so the halo wraps the tips rather than being sliced off
     * square. Six sides: it is never seen as a silhouette because nothing is
     * drawn at its surface — the shader's falloff is computed from the
     * distance between the view ray and the tube's *axis*, so the proxy is a
     * bounding volume and its own shape is invisible. */
    const R = r * 5.0;
    const mid: V3 = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5];
    const half = Math.hypot(...sub(b, a)) * 0.5;
    const ea: V3 = [mid[0] - axis[0] * (half + R), mid[1] - axis[1] * (half + R),
                    mid[2] - axis[2] * (half + R)];
    const eb: V3 = [mid[0] + axis[0] * (half + R), mid[1] + axis[1] * (half + R),
                    mid[2] + axis[2] * (half + R)];
    G.attr('aGlow', c[0] * glowGain, c[1] * glowGain, c[2] * glowGain, r)
      .attr('aGA', axis[0], axis[1], axis[2], half)
      .attr('aGP', mid[0], mid[1], mid[2], GLO.TUBE);
    tubeSeg(G, ea, eb, R, 6);
  };

  /* ── 1. The OPEN sign, hanging inside the convenience store's glass ────
   *
   * Behind the glass rather than on the fascia, because that is where one is:
   * a transformer-fed OPEN sign is a shop-window object hung on two chains
   * from the transom, seen through the pane with the reflection of the street
   * across it. It is also the only neon in the scene that the shopfront glass
   * material gets to distort, which is worth more than the same sign screwed
   * to the wall would be.
   */
  const store = lit.find((u) => u.light.kind === 'store');
  if (store) {
    const f = new Face(N, store.frame);
    const uc = (store.u0 + store.u1) * 0.5;
    // Just inside the shopfront joinery, which stands at d0 - rec + 0.055.
    const dP = store.d0 - store.rec - 0.085;
    const yc = store.base + 1.98;
    const hw = 0.40, hh = 0.155;

    dark();
    // The backing tray, and its returns, which is what a real one is: a
    // shallow black box with the tubes standing off the front of it.
    f.box(uc - hw, uc + hw, yc - hh, yc + hh, dP - 0.055, dP);
    // Two suspension chains up to the transom.
    f.box(uc - hw + 0.09, uc - hw + 0.115, yc + hh, yc + hh + 0.46, dP - 0.035, dP - 0.012);
    f.box(uc + hw - 0.115, uc + hw - 0.09, yc + hh, yc + hh + 0.46, dP - 0.035, dP - 0.012);

    const cap = 0.170;
    N.attr('aNeon', NEO.LETTER, rows.open, cap, 0.31)
      .attr('aNeonC', pal.open[0], pal.open[1], pal.open[2])
      .attr('aRect', uc, yc - cap * 0.5, 0, 0)
      .attr('aAxis', 0, 1, 0, 0);
    f.panel(uc - hw, uc + hw, yc - hh, yc + hh, dP + 0.028);

    /* The panel halo. A quad 60 mm in front of the letters carrying a blurred
     * copy of the same ink — the letterforms here are painted into a plane
     * rather than modelled as tubes, so they cannot use the cylinder proxy,
     * and without this the sign is the one source in the scene with a hard
     * edge. */
    const gf = new Face(G, store.frame);
    G.attr('aGlow', pal.open[0] * 0.20, pal.open[1] * 0.20, pal.open[2] * 0.20, cap)
      .attr('aGA', store.frame.nx, 0, store.frame.nz, 0)
      .attr('aGP', uc, yc - cap * 0.5, rows.open, GLO.PANEL);
    gf.panel(uc - hw - 0.10, uc + hw + 0.10, yc - hh - 0.10, yc + hh + 0.10, dP + 0.060);

    /* Analytic contribution. Ink coverage for OPEN at this size is about
     * 0.0092 m2 at L = 8.34, so I = 0.077 cd — three parts in ten thousand of
     * the sun at a metre. It is in the array for one reason: it is 400 mm from
     * the stall riser and the reveal beside it, and a source that close washes
     * what it is mounted on whatever its absolute level. */
    sources.push({
      pos: w3(f.p(uc, yc, dP + 0.03)),
      dir: [store.frame.nx, 0, store.frame.nz],
      cd: 0.077, colour: pal.open, note: 'OPEN, store window',
    });
    legend.push('OPEN');
  }

  /* ── 2. The bar's projecting sign ─────────────────────────────────────
   *
   * A double-faced box on the fascia line, reading along the street rather
   * than across it, which is the only orientation that works: a sign flat on
   * the elevation of a street the camera walks *down* is edge-on in every
   * frame. Two vertical tubes down its leading and trailing edges.
   *
   * Mounted within the fascia band rather than above it. The temptation is to
   * put it on the first-floor masonry where there is room, and the reason not
   * to is that System 2 puts a window sill about 900 mm above floor level and
   * the layout is hashed — a sign placed there is fine on this seed and
   * through a window on the next one.
   */
  const bar = lit.find((u) => u.light.kind === 'bar');
  if (bar) {
    const f = new Face(N, bar.frame);
    const uc = bar.u0 + 0.62;
    const yc = (bar.fasciaY0 + bar.fasciaY1) * 0.5;
    const hh = Math.min(0.30, (bar.fasciaY1 - bar.fasciaY0) * 0.5 + 0.05);
    // Clear of the fascia cornice, which projects 112 mm.
    const dA = bar.d0 + 0.145, dB = bar.d0 + 1.05;
    const hu = 0.075;

    dark();
    f.box(uc - hu, uc + hu, yc - hh, yc + hh, dA, dB);
    // The two brackets back to the wall.
    f.box(uc - 0.022, uc + 0.022, yc + hh - 0.05, yc + hh, bar.d0, dA);
    f.box(uc - 0.022, uc + 0.022, yc - hh, yc - hh + 0.05, bar.d0, dA);

    /* Lettering on both jambs. uv on a jamb is (u + d, y), so the layout
     * coordinate runs along the projection and the two faces are handed
     * different centres by exactly their thickness. signMirror recovers which
     * way the text has to run from the screen-space derivatives, so neither
     * face has to be told that it is the far one. */
    const dm = (dA + dB) * 0.5;
    for (const side of [-1, +1] as const) {
      const uf = uc + side * (hu + 0.004);
      const cap = 0.235;
      N.attr('aNeon', NEO.LETTER, rows.bar, cap, 0.77)
        .attr('aNeonC', pal.red[0], pal.red[1], pal.red[2])
        .attr('aRect', uf + dm, yc - 0.015, 0, 0)
        .attr('aAxis', 0, 1, 0, 0);
      f.jamb(uf, dA + 0.02, dB - 0.02, yc - 0.02, yc + hh - 0.02, side);

      const cap2 = 0.092;
      N.attr('aNeon', NEO.LETTER, rows.beer, cap2, 0.19)
        .attr('aNeonC', pal.red[0] * 0.72, pal.red[1] * 0.86, pal.red[2] * 0.95)
        .attr('aRect', uf + dm, yc - 0.185, 0, 0)
        .attr('aAxis', 0, 1, 0, 0);
      f.jamb(uf, dA + 0.02, dB - 0.02, yc - 0.24, yc - 0.02, side);
    }

    // The two edge tubes, standing clear of the box front and back.
    for (const d of [dA - 0.048, dB + 0.048]) {
      litTube(w3(f.p(uc, yc - hh + 0.03, d)), w3(f.p(uc, yc + hh - 0.03, d)),
        0.019, pal.red);
    }

    /* Analytic contribution, and this one earns its slot. Two 540 mm tubes at
     * 19 mm radius present 0.0645 m2 of emitting surface at L = 8.34, so
     * I = 0.54 cd, plus about 0.35 cd of lettering across the two faces. At
     * 0.9 cd and 1.2 m from the fascia board that is E = 0.62 on the board —
     * 7.4% of the sun's horizontal irradiance, on a board the sun never
     * reaches. The wash on the fascia is the whole visible effect of this
     * sign on anything but itself, and it is the reason a neon sign in a
     * photograph looks attached to a building rather than composited onto it.
     */
    sources.push({
      pos: w3(f.p(uc, yc, (dA + dB) * 0.5)),
      dir: [bar.frame.nx, 0, bar.frame.nz],
      cd: 0.89, colour: pal.red, note: 'bar sign, projecting',
    });
    legend.push('BAR', 'COLD BEER');
  }

  /* ── 3. The pharmacy cross ────────────────────────────────────────────
   *
   * On the shaded row, north of the cross street, on a building the lit units
   * do not occupy — a pharmacy next door to a convenience store is a parade
   * that has been generated rather than built. Placed by searching the layout
   * for a facade at a chosen z rather than by hard-coding a plane, so it stays
   * on the wall if the block is ever reseeded.
   *
   * Green, and it is the only cool source in the scene. That is worth having
   * for the same reason the two dead lamps are: a street where every
   * artificial source is the same temperature reads as one lighting rig with
   * a filter on it.
   */
  const { bldgs } = layoutBlock((x, z) => walkHeight(x, z));
  const CROSS_Z = -52.0;
  const host = bldgs.find((b) => {
    if (!b.street || b.frame.ox > 0) return false;
    if (Math.abs(b.frame.uz) < 0.5) return false;
    const u = (CROSS_Z - b.frame.oz) / b.frame.uz;
    return u > 0.9 && u < b.L - 0.9;
  });
  if (host) {
    const f = new Face(N, host.frame);
    const uc = (CROSS_Z - host.frame.oz) / host.frame.uz;
    const { openTop } = groundLevels(host);
    // The same fascia band emitFascia uses, so the cross is centred on the
    // board rather than half on the brick above it.
    const yc = (Math.min(host.base + host.gh - 0.20, openTop + 0.55)
      + openTop + 0.01) * 0.5;
    const dc = host.d0 + 0.60;
    const arm = 0.285, r = 0.026;

    dark();
    // The bracket out to the cross, and the dark plate it stands on.
    f.box(-0.030 + uc, 0.030 + uc, yc - 0.030, yc + 0.030, host.d0, dc - arm + 0.05);
    f.box(uc - 0.052, uc + 0.052, yc - arm - 0.05, yc + arm + 0.05, dc - 0.055, dc - 0.030);
    f.box(uc - 0.052, uc + 0.052, yc - 0.075, yc + 0.075, dc - arm - 0.05, dc + arm + 0.05);

    const P = (y: number, d: number): V3 => w3(f.p(uc, y, d));
    litTube(P(yc - arm, dc), P(yc + arm, dc), r, pal.green, 0.34);
    litTube(P(yc, dc - arm), P(yc, dc + arm), r, pal.green, 0.34);

    /* 1.14 m of 26 mm tube is 0.186 m2 at L = 9.72, so I = 1.81 cd. Sixty
     * centimetres from the wall it puts E = 5.0 on the render immediately
     * behind it, which is 60% of the sun's horizontal irradiance and by a wide
     * margin the strongest thing System 5 does to any surface — because it is
     * the only source in the scene mounted a hand's width from what it lights.
     * The falloff takes it under a per cent of the sun by two metres away. */
    const p = P(yc, dc);
    sources.push({
      pos: p, dir: [host.frame.nx, 0, host.frame.nz],
      cd: 1.81, colour: pal.green, note: 'pharmacy cross',
    });
    legend.push('a green cross');
  }

  /* ── 4. The traffic signal ────────────────────────────────────────────
   *
   * Emissive only, with a halo, and no analytic contribution at all. A signal
   * aspect is a 200 mm lens with a deep hood over it aimed horizontally down
   * the carriageway at 3 m: it is bright to look into and it puts nothing on
   * anything. Giving it an entry in the array would cost thirteen fragments
   * of work in five programs to deliver a quantity below the dither floor.
   *
   * Sited on the near corner of the cross street and turned to face back up
   * the street, so the walk approaches it head-on and the lit aspect is a lens
   * rather than a rim. Set 2.5 m clear of the lamp column at z = -64.
   */
  {
    const sx = 4.90, sz = -61.6;
    /* u runs -x, so the outward normal is +z: the head faces up the street,
     * at the traffic it holds. Read the third and fourth arguments of frame()
     * as the u direction and not as the normal — I read them as the normal
     * once, turned the head into the wall, and lost a capture to it.
     *
     * The consequence at the capture stops is worth stating, because it looks
     * like a fault and is not one. Seen 27 degrees off its own axis the 168 mm
     * visor cuts 44 per cent of the lens away and the aspect reads as a
     * crescent rather than a disc. That is what a real hood does, and why one
     * is fitted; the answer is to photograph a signal from the lane it is
     * addressed to, which the -neon/sig framing does.
     */
    const f = new Face(N, frame(sx, sz, -1, 0));
    const y0 = walkHeight(sx, sz) - 0.02;

    dark();
    f.tube(0, 0, 0.105, y0, y0 + 0.10, 10);
    f.tube(0, 0, 0.075, y0 + 0.10, y0 + 0.19, 10);
    f.tube(0, 0, 0.051, y0 + 0.19, y0 + 3.42, 10);
    // The backboard, which is what makes an aspect readable against a bright
    // sky and is therefore exactly the object a golden-hour street needs.
    f.box(-0.27, 0.27, y0 + 2.20, y0 + 3.40, -0.014, 0.010);
    f.box(-0.158, 0.158, y0 + 2.28, y0 + 3.32, 0.010, 0.235);

    const asp: [number, RGB][] = [
      [y0 + 3.15, pal.sigRed], [y0 + 2.80, pal.sigAmber], [y0 + 2.45, pal.sigGreen],
    ];
    for (let k = 0; k < 3; k++) {
      const [yl, col] = asp[k];
      // The hood: a top plate and two cheeks, open at the bottom, which is
      // what a real one is and what puts a hard shadow across the lens.
      dark();
      f.box(-0.118, 0.118, yl + 0.104, yl + 0.126, 0.232, 0.40);
      f.box(-0.140, -0.118, yl - 0.06, yl + 0.126, 0.232, 0.40);
      f.box(0.118, 0.140, yl - 0.06, yl + 0.126, 0.232, 0.40);

      const c = w3(f.p(0, yl, 0.236));
      const c2 = w3(f.p(0, yl, 0.250));
      N.attr('aNeon', NEO.LENS, k, 0, 0)
        .attr('aNeonC', col[0], col[1], col[2])
        .attr('aRect', c[0], c[1], c[2], 0)
        .attr('aAxis', f.f.nx, 0, f.f.nz, 0.098);
      tubeSeg(N, c, c2, 0.098, 10);
    }
    /* There is deliberately no halo proxy on any of the three.
     *
     * The first pass gave each aspect one, switched by the same clock as the
     * lens, and it was wrong on both counts. The visible fault was that the
     * shell was built at 2.6 core radii while the shader's falloff is written
     * to reach zero at five, so it was still at six per cent of peak where the
     * geometry ran out and the two unlit aspects showed their proxies as flat
     * hexagons hanging in front of the head — the one place in the scene where
     * a bounding volume became its own silhouette.
     *
     * The right fix is not a bigger shell. A halo of that kind is the near
     * field of a thin *exposed* emitter: you see the tube through fifty
     * millimetres of the air it is exciting, and the neon carries it for that
     * reason. A signal aspect is a 200 mm lens at the bottom of a 168 mm
     * visor, and the visor is fitted precisely so that nothing leaves it
     * except along the axis. The aspect has no near field to render. What is
     * left — the flare inside the camera, off the lens itself — is System 8's
     * and will be there when bloom is.
     */
  }

  const neon = N.geometry();
  const glow = G.geometry();
  return {
    neon, glow,
    triangles: N.triangleCount + G.triangleCount,
    sources, legend,
    dispose() { neon.dispose(); glow.dispose(); },
  };
}

/** Re-exported so the component can build a Face over an arbitrary frame. */
export type { Frame };
