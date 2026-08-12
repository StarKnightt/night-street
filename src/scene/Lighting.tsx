'use client';

/* System 5: the assembly.
 *
 * Three meshes go into the scene from here — the seven luminaires, the neon
 * and signal geometry, and the additive halo proxies — and every artificial
 * source in the street is registered into the analytic uniform arrays in
 * scene/lights.ts, which the five receiving materials read.
 *
 * The whole system adds zero `Light` objects. The sun remains the only one,
 * and it remains the only shadow caster. What this component adds to every
 * material program in the street is a uniform block of fourteen point sources
 * and two apertures and a loop with an early reject, which is a very different
 * thing from adding fourteen lights: a rejected analytic source costs one
 * multiply and one compare, whereas a three.js light that contributes nothing
 * still costs its uniform block, its loop body and its shadow branch in every
 * program whether the material can see it or not.
 */
import { useMemo, useEffect, useRef } from 'react';
import { useFrame } from '@react-three/fiber';

import { buildLamps } from '@/world/lamps';
import { buildNeon } from '@/world/neon';
import { litUnits } from '@/world/street3';
import { layoutBlock } from '@/world/block';
import { upperWindows } from '@/world/facade';
import { walkHeight } from '@/world/geometry';
import { signAtlas, NEON } from './signs';
import { TV_AT } from './buildingMaterials';
import { makeLampMaterial, makeNeonMaterial, makeGlowMaterial } from './lightMaterials';
import {
  NEON_RED, NEON_GREEN, NEON_OPEN,
  SIG_RED, SIG_AMBER, SIG_GREEN,
  installLamps, installNeon, installShopLights, installCarLights,
  installTimeControl, advanceTime,
} from './lights';
import { lampFixtures, publishLampFixtures } from './lampFixtures';

declare global {
  interface Window {
    /** What the street says in neon, for the report and for the harness. */
    __neon?: string[];
  }
}

/** World centre of the opening the television is in, if the block has one. */
function findTvWindow(): [number, number, number] | null {
  const { bldgs } = layoutBlock((x, z) => walkHeight(x, z));
  for (const b of bldgs) {
    if (!b.street || b.frame.ox > 0) continue;          // the shaded row
    for (const w of upperWindows(b)) {
      if (w.floor !== 1) continue;                       // the second storey
      const uc = (w.u0 + w.u1) * 0.5;
      const z = b.frame.oz + b.frame.uz * uc;
      if (z > -18 || z < -46) continue;                  // stops two and three
      const { ox, ux, nx, nz, oz, uz } = b.frame;
      return [
        ox + ux * uc + nx * b.d0,
        (w.y0 + w.y1) * 0.5,
        oz + uz * uc + nz * b.d0,
      ];
    }
  }
  return null;
}

export function Lighting() {
  const built = useMemo(() => {
    const atlas = signAtlas();
    const lit = litUnits();

    const lamps = buildLamps(lampFixtures());
    const neon = buildNeon(
      lit,
      {
        open: atlas.neon0 + NEON.OPEN,
        bar: atlas.neon0 + NEON.BAR,
        beer: atlas.neon0 + NEON.BEER,
      },
      {
        red: NEON_RED, open: NEON_OPEN, green: NEON_GREEN,
        sigRed: SIG_RED, sigAmber: SIG_AMBER, sigGreen: SIG_GREEN,
      },
    );

    /* Registration. Everything except the car sidelights is known at build
     * time; those come from a sibling component and are picked up in an effect
     * below. Order does not matter — the arrays are indexed by slot, not
     * appended to — which is the reason they are laid out with fixed ranges
     * rather than packed. */
    installLamps();
    installShopLights(lit.map((u) => u.light));
    installNeon(neon.sources);

    /* The television, placed rather than hashed.
     *
     * Second floor, shaded row, in the near half of the walk. Each of those is
     * a requirement and not a preference: the second floor is the one the
     * camera can see into at 1.65 m eye height without the sill cutting the
     * room off, the shaded row is the only place a source at a tenth of the
     * sun registers at all, and the near half is where a 1.1 m opening is
     * still more than a few pixels wide. The first opening that satisfies all
     * three is taken, so the choice is deterministic in the seed.
     */
    const tv = findTvWindow();
    if (tv) TV_AT.value.set(tv[0], tv[1], tv[2], 1);

    const materials = {
      lamp: makeLampMaterial(),
      neon: makeNeonMaterial(),
      glow: makeGlowMaterial(),
    };

    return { lamps, neon, materials };
  }, []);

  /* The sidelights are published by Cars.tsx, which is a sibling. Effects run
   * child-first and Cars is mounted before this component, so the array is
   * there by the time this runs; the retry on the first frame is insurance
   * against that ordering ever changing, and costs one boolean a frame. */
  const gotCars = useRef(false);
  useEffect(() => {
    const cl = window.__carLights;
    if (cl && cl.length) { installCarLights(cl); gotCars.current = true; }
  }, []);

  useEffect(() => installTimeControl(), []);

  /* System 6's raymarch reads this rather than re-deriving the lanterns. See
   * the note at the top of lampFixtures.ts about why a fourth private copy of
   * the lamp table is not an option. */
  useEffect(() => publishLampFixtures(), []);

  useEffect(() => {
    window.__neon = built.neon.legend;
    return () => { delete window.__neon; };
  }, [built]);

  useEffect(() => () => {
    built.lamps.dispose();
    built.neon.dispose();
    Object.values(built.materials).forEach((m) => m.dispose());
  }, [built]);

  useFrame((_, dt) => {
    if (!gotCars.current) {
      const cl = window.__carLights;
      if (cl && cl.length) { installCarLights(cl); gotCars.current = true; }
    }
    // Clamped: a tab that has been backgrounded returns a delta of several
    // seconds and would jump the signal through a whole aspect in one frame.
    advanceTime(Math.min(dt, 0.1));
  });

  const { lamps, neon, materials: M } = built;

  return (
    <group>
      {/* The columns cast. At 4.2 degrees a 6.8 m column throws a 92 m shadow,
        * so these are the longest shadows in the scene by a factor of four and
        * they stripe the carriageway the entire length of the block. That is
        * the single largest change System 5 makes to the established frames
        * and it is correct: a street with lamp posts at this hour has lamp
        * post shadows across it, and their absence was one of the things that
        * made the road read as empty. */}
      <mesh geometry={lamps.geometry} material={M.lamp} castShadow receiveShadow />
      <mesh geometry={neon.neon} material={M.neon} castShadow receiveShadow />
      {/* Drawn last, additive, writing no depth. renderOrder rather than a
        * transparent-queue sort because these proxies interpenetrate the
        * geometry they surround and a distance sort would flip them. */}
      <mesh geometry={neon.glow} material={M.glow} renderOrder={12} />
    </group>
  );
}