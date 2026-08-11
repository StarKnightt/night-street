'use client';

/* System 4: the parked cars.
 *
 * Four meshes for nine cars, split by material rather than by vehicle, on the
 * same reasoning as Systems 2 and 3 next door. Nothing here moves, so there is
 * nothing a per-car object would buy except thirty-six draw calls.
 *
 * The render order is the only thing in this file that is not obvious, and
 * there are three constraints on it. The bodies are opaque and go first. The
 * contact shadows multiply against the road, so they have to run after the
 * road and before anything is drawn on top of them. And the glazing blends
 * over the cabin surfaces inside the bodies, so it runs last of all.
 */
import { useMemo, useEffect } from 'react';

import { buildCars } from '@/world/cars';
import {
  makeCarPaintMaterial, makeCarGlassMaterial,
  makeCarWheelMaterial, makeCarShadeMaterial,
} from './carMaterials';

/** Matches the FogExp2 density set in Street.tsx; the shade decal fades with it. */
const FOG_DENSITY = 0.0072;

export function Cars() {
  const built = useMemo(() => ({
    cars: buildCars(),
    paint: makeCarPaintMaterial(),
    glass: makeCarGlassMaterial(),
    wheel: makeCarWheelMaterial(),
    shade: makeCarShadeMaterial(FOG_DENSITY),
  }), []);

  useEffect(() => {
    /* The handover to System 5, published the same way System 3 publishes its
     * shopfronts. One car in the street has its sidelights on; this system
     * builds the lens and makes it emit, and nothing here illuminates anything
     * else, so the weak red wash that should be on the road behind that car
     * and on the kerb beside it does not exist yet. Each entry carries the
     * lens centre, its outward normal, its size and the exact linear radiance
     * the lens is authored at — matching that last one is what will keep the
     * spill the same colour as the lamp it comes from. */
    window.__carLights = built.cars.lights;
    return () => { delete window.__carLights; };
  }, [built]);

  useEffect(() => () => {
    built.cars.dispose();
    built.paint.dispose();
    built.glass.dispose();
    built.wheel.dispose();
    built.shade.dispose();
  }, [built]);

  const { cars } = built;

  return (
    <group>
      <mesh geometry={cars.body} material={built.paint} castShadow receiveShadow />
      <mesh geometry={cars.wheel} material={built.wheel} castShadow receiveShadow />
      {/* The dark under the car. A multiply decal 6 mm above the road, drawn
        * after the opaque pass so the tarmac it subtracts from is already
        * resolved, and before the glazing so a windscreen seen across the
        * street is not dimmed by the shadow of the car it belongs to. It
        * neither casts nor receives: it is not an object, it is the absence of
        * sky under one. */}
      <mesh geometry={cars.shade} material={built.shade} renderOrder={3} />
      {/* The glazing blends over the cabin surfaces emitted 15 mm inboard of
        * it, so it must run after them; it receives shadow so that a car in
        * the frontage's shade does not carry a sunlit reflection, and casts
        * none, because a transparent pane throwing a solid rectangle into its
        * own interior is worse than no shadow at all. */}
      <mesh geometry={cars.glass} material={built.glass} renderOrder={4} receiveShadow />
    </group>
  );
}
