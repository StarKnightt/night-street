'use client';

/* System 2: the buildings.
 *
 * Four meshes for an entire block — masonry, glass, joinery and steel — which
 * is four draw calls in the beauty pass and four in the shadow pass. Merging
 * that aggressively is what pays for modelling window reveals, sill noses,
 * fire escape pickets and roof plant as real geometry instead of faking them,
 * and at this sun angle the geometry is the whole point: almost everything
 * that makes a wall look photographed is a shadow cast by something 40 mm
 * proud of it.
 *
 * The trade is that nothing here can be culled or instanced independently. At
 * roughly a hundred thousand triangles across the whole block that is the
 * right side of the deal — the scene was already carrying nearly four hundred
 * thousand in the carriageway alone.
 */
import { useMemo, useEffect } from 'react';
import { useThree } from '@react-three/fiber';

import { buildCity } from '@/world/facade';
import {
  makeWallMaterial, makeGlassMaterial, makeTrimMaterial, makeMetalMaterial,
} from './buildingMaterials';

export function Buildings() {
  const gl = useThree((s) => s.gl);

  const built = useMemo(() => {
    const city = buildCity();
    return {
      city,
      wall: makeWallMaterial(),
      glass: makeGlassMaterial(),
      trim: makeTrimMaterial(),
      metal: makeMetalMaterial(),
    };
  }, []);

  useEffect(() => () => {
    built.city.dispose();
    built.wall.dispose();
    built.glass.dispose();
    built.trim.dispose();
    built.metal.dispose();
  }, [built]);

  void gl;
  const { city } = built;

  return (
    <group>
      <mesh geometry={city.wall} material={built.wall} castShadow receiveShadow />
      <mesh geometry={city.trim} material={built.trim} castShadow receiveShadow />
      <mesh geometry={city.metal} material={built.metal} castShadow receiveShadow />
      {/* Glass receives but does not cast: a pane is transparent, and a window
        * that throws a solid black rectangle into the room behind it is one of
        * the more distracting things a renderer can do. The open sashes are the
        * exception and they are small enough not to be missed. */}
      <mesh geometry={city.glass} material={built.glass} receiveShadow />
    </group>
  );
}
