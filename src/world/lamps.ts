/* System 5: the luminaires themselves.
 *
 * There was no lamp geometry in the scene at all — the night rig was fourteen
 * bare SpotLights with nothing to hang them on — so this is the first time the
 * street has had anything standing at 6.8 m.
 *
 * The brief for this hour is specific about what a lamp is here. At 11 pm a
 * street lamp is a pool on the ground; at 4.2 degrees of sun the pool is 6 per
 * cent of what is already there and the lamp reads instead as a *source* — a
 * warm point with a corona, on a column, throwing a very long shadow. So the
 * budget goes on the bowl and the column and not on the ground.
 *
 * Real dimensions, as everywhere else in this project. A steel street lighting
 * column is 114 mm at the root swaged to 76 mm at the top, its cable door is
 * 500 mm tall with its sill at about 600, and a semi-cut-off cobra head is
 * roughly 640 x 270 mm on a 1.1-1.2 m outreach. The outreach matters more than
 * it looks: it is what puts the lantern over the kerb line rather than over the
 * footway, which is where every street lamp in the world actually hangs and is
 * the difference between a lamp post and a lamp.
 *
 * No relief anywhere on this. At 4.2 degrees a normal perturbation swings N.L
 * sevenfold between adjacent pixels, and a light fitting is the one object in
 * a frame whose silhouette against a bright sky is doing all of the work.
 */
import * as THREE from 'three';
import { Emit, Face, frame } from './emit';
import { walkHeight } from './geometry';
import { LAMP_H } from './dims';
import { LAMP_OUTREACH, type LampFixture } from '@/scene/lampFixtures';

/** Branches in the lamp shader. */
export const LMP = {
  COLUMN: 0,    // the shaft, the root flange and the swage
  DOOR: 1,      // the cable door and its fixings
  ARM: 2,       // the outreach bracket
  BODY: 3,      // the lantern casting and its canopy
  BOWL: 4,      // the glass, which is the only part that emits
} as const;

const h2 = (a: number, b: number): number => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/**
 * A flat plate of width `w` swept along a polyline in the (y, d) plane.
 *
 * `Face.bar` extrudes a (y, d) section along u, which is exactly the wrong way
 * round for an arm that reaches out from the wall — until you notice that the
 * arm's *side profile* is the section and the sweep is its width. So the swan
 * neck is a single closed polygon traced out along one edge and back along the
 * other, and `bar` does the rest.
 *
 * Winding is the trap `emit.ts` warns about and it is worth stating the rule
 * rather than discovering it: for an edge running (dy, dd) through the section,
 * the outward normal is (dd, -dy), so a section listed counter-clockwise in a
 * plot with y to the right and d upward comes out facing outward. A section
 * listed the other way builds perfectly and is invisible, in the beauty pass
 * and in the shadow pass alike.
 */
function plate(
  f: Face, u0: number, u1: number,
  path: readonly (readonly [number, number])[], t: number,
): void {
  const n = path.length;
  const perp: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(n - 1, i + 1)];
    const dy = b[0] - a[0], dd = b[1] - a[1];
    const l = Math.hypot(dy, dd) || 1;
    perp.push([(dd / l) * t * 0.5, (-dy / l) * t * 0.5]);
  }
  const section: [number, number][] = [];
  for (let i = 0; i < n; i++) section.push([path[i][0] + perp[i][0], path[i][1] + perp[i][1]]);
  for (let i = n - 1; i >= 0; i--) section.push([path[i][0] - perp[i][0], path[i][1] - perp[i][1]]);
  f.bar(u0, u1, section);
}

export type BuiltLamps = {
  geometry: THREE.BufferGeometry;
  triangles: number;
  dispose(): void;
};

/**
 * @param fixtures the lantern table from `scene/lampFixtures.ts`.
 *
 * The bowl's radiance rides on the geometry as a vertex attribute rather than
 * arriving as two uniforms and a state index. There are seven lamps and they
 * are one mesh and one draw call, so a vec3 per vertex is free; what it buys is
 * that each bowl's radiance is inverted through the real transform on the CPU
 * at its own point on the run-up, instead of being a `mix()` of two endpoints
 * in the shader. Between display 132 and 214 the radiance spans a factor of
 * seven along a curve that is nowhere near straight, so the mix would have put
 * a half-warmed lamp most of the way to full — the shipped emissive would then
 * disagree with the candela the same warmth produced, which is the drift these
 * two numbers were tied together to prevent.
 */
export function buildLamps(fixtures: readonly LampFixture[]): BuiltLamps {
  const E = new Emit({ aLamp: 4, aBowl: 3 });

  for (const fx of fixtures) {
    const [x, , z] = fx.column;
    const outreach = LAMP_OUTREACH;
    const seed = h2(x * 3.1 + 11.0, z * 0.77);
    const warm = fx.warmth;
    /* The lantern reaches toward x = 0, so the local outward axis has to point
     * that way: frame() derives its normal as up x uDir, which for uDir along
     * -sign(x) in z gives a normal along -sign(x) in x. */
    const s = Math.sign(x) || 1;
    const f = new Face(E, frame(x, z, 0, -s));
    const y0 = walkHeight(x, z) - 0.02;
    const top = LAMP_H - 0.25;

    E.attr('aBowl', fx.bowl[0], fx.bowl[1], fx.bowl[2]);
    const set = (part: number) => E.attr('aLamp', seed, part, y0, warm);

    set(LMP.COLUMN);
    // Root flange, cast into the footway, with a fillet of mortar round it.
    f.tube(0, 0, 0.135, y0, y0 + 0.055, 12);
    f.tube(0, 0, 0.112, y0 + 0.055, y0 + 0.105, 12);
    /* 114 mm root, swaged to 76 mm above the door. A parallel tube reads as
     * scaffolding; the step is the one thing that says "lighting column". */
    f.tube(0, 0, 0.057, y0 + 0.105, y0 + 3.05, 12);
    f.tube(0, 0, 0.062, y0 + 3.00, y0 + 3.16, 12);
    f.tube(0, 0, 0.040, y0 + 3.16, top + 0.02, 12);

    /* The cable door. It is 60 mm of detail on a six metre post and it is
     * worth it for one reason: it is at eye level, it is the only asymmetry on
     * the column, and it tells the viewer which way round the post is. */
    set(LMP.DOOR);
    f.box(-0.048, 0.048, y0 + 0.60, y0 + 1.10, 0.049, 0.064);
    f.box(-0.014, 0.014, y0 + 0.83, y0 + 0.87, 0.064, 0.076);

    /* The outreach. A swan neck rather than a right angle: the bracket on a
     * column of this generation is a single bent tube, and the curve is what
     * separates it from a gallows. */
    set(LMP.ARM);
    const arm: [number, number][] = [
      [top - 0.06, 0.010], [top + 0.03, 0.075], [top + 0.15, 0.215],
      [top + 0.25, 0.410], [top + 0.31, 0.620], [top + 0.33, 0.800],
    ];
    plate(f, -0.037, 0.037, arm, 0.072);

    /* The lantern. A semi-cut-off cobra head: a shallow aluminium casting with
     * a flat bowl under it, deeper at the spigot end than at the nose. It is
     * 640 mm long, which at the distances this street is photographed from is
     * about the size of a hand held at arm's length — big enough that getting
     * it wrong would be obvious and small enough that nothing inside it needs
     * modelling. */
    const dA = outreach - 0.34, dB = outreach + 0.30;
    set(LMP.BODY);
    // The spigot entry, where the arm goes into the casting.
    f.box(-0.052, 0.052, top + 0.27, top + 0.39, 0.78, dA + 0.06);
    // The body, and a canopy over it that steps in — the join a real one has.
    f.box(-0.135, 0.135, LAMP_H + 0.020, LAMP_H + 0.130, dA, dB);
    f.box(-0.112, 0.112, LAMP_H + 0.130, LAMP_H + 0.175, dA + 0.045, dB - 0.070);
    // The rim the bowl is gasketed into, standing 12 mm proud all round.
    f.box(-0.140, 0.140, LAMP_H - 0.010, LAMP_H + 0.020, dA - 0.010, dB + 0.010);

    /* The bowl. Everything above is a silhouette; this is the source. It is a
     * shallow tray rather than a plane so that it has an edge to be seen from
     * below the horizontal, which is how it is seen from every stop on the
     * walk except the two that look up. */
    set(LMP.BOWL);
    f.box(-0.128, 0.128, LAMP_H - 0.105, LAMP_H - 0.010, dA + 0.010, dB - 0.010);
  }

  const geometry = E.geometry();
  return {
    geometry,
    triangles: E.triangleCount,
    dispose() { geometry.dispose(); },
  };
}
