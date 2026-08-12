'use client';

/* The footway prop kit and the projecting signage.
 *
 * Two meshes for everything: one for the objects and the ironwork that holds
 * the signs up, one for the sign panels. Two draw calls in the beauty pass and
 * two in the shadow pass, for a hundred and fifty objects and forty signs.
 *
 * The split is by material and not by object, on the same reasoning as
 * Buildings.tsx and StreetLevel.tsx next door. Merging is what pays for
 * modelling a bollard's collar, a pallet's deck gaps and a bracket's diagonal
 * as real geometry rather than faking any of it — and at 4.2 degrees the
 * geometry is the whole point, because what puts an object in a photograph is
 * the shadow it throws and not the pixels it covers.
 *
 * What it costs is that nothing here can be culled independently. At around
 * fifty thousand triangles against the street's eight hundred and sixty
 * thousand, that is not a trade worth thinking about.
 *
 * Rendered from inside StreetLevel rather than as its own entry in the scene
 * tree, because it is the same system: things standing on the paving.
 */
import { useMemo, useEffect } from 'react';

import { buildProps } from '@/world/props';
import { makePropMaterial, makeSignageMaterial } from './propMaterials';

export function Props() {
  const built = useMemo(() => ({
    kit: buildProps(),
    prop: makePropMaterial(),
    sign: makeSignageMaterial(),
  }), []);

  useEffect(() => () => {
    built.kit.dispose();
    built.prop.dispose();
    built.sign.dispose();
  }, [built]);

  return (
    /* Named, so a capture can switch it off from the command line.
     *
     * The density metric this pass is judged on is a before-and-after, and the
     * before was captured on a build that has since had a cloud layer added to
     * it by a different piece of work. Differencing those two folders measures
     * both changes at once and credits this one with the sky. With the group
     * named, `shoot.mjs --js` can hide exactly these two meshes and nothing
     * else, so the A and the B differ in the props alone. */
    <group name="props">
      <mesh geometry={built.kit.geometry} material={built.prop} castShadow receiveShadow />
      <mesh geometry={built.kit.signs} material={built.sign} castShadow receiveShadow />
    </group>
  );
}
