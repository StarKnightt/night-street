'use client';

/* System 3: shopfronts, awnings, shutters, and the things standing on the
 * footway.
 *
 * Five meshes for the whole street, split by material rather than by object,
 * on the same reasoning as System 2 next door: a shopfront is thirty little
 * pieces of joinery and a bin is a box with a lid, and drawing either of them
 * as its own object would cost more in draw calls than the entire block of
 * buildings does. Merging by material means a hydrant a hundred metres away
 * is free, and it means the shadow pass is five more draws rather than sixty.
 *
 * What it costs is that nothing here can be culled independently, and that the
 * geometry is fixed at build time — no shutter can roll up, no door can open.
 * Neither matters for a still frame of a street, which is what this is.
 */
import { useMemo, useEffect } from 'react';

import { buildStreetLevel } from '@/world/street3';
import {
  makeShopMaterial, makeShopGlassMaterial, makeShutterMaterial,
  makeAwningMaterial, makeFurnitureMaterial, LIT_GAIN,
} from './streetMaterials';
import { Props } from './Props';

declare global {
  interface Window { __litGain?: { value: number } }
}

export function StreetLevel() {
  const built = useMemo(() => ({
    level: buildStreetLevel(),
    shop: makeShopMaterial(),
    glass: makeShopGlassMaterial(),
    shutter: makeShutterMaterial(),
    awning: makeAwningMaterial(),
    furniture: makeFurnitureMaterial(),
  }), []);

  useEffect(() => {
    /* The handover to System 5, published rather than exported.
     *
     * Every lit unit's aperture — where it is, which way it faces, how big it
     * is, how far back the emissive ceiling sits, and the exact linear colour
     * that ceiling is authored at — is on the scene object for the lighting
     * rig to pick up. It is deliberately data and not a light: the surfaces
     * here glow, but nothing in System 3 illuminates anything else, so the
     * warm patch on the pavement outside the convenience store is still
     * missing and is System 5's to add. Matching `colour` is what will keep
     * the spill the same colour as the room it comes out of. */
    window.__shopLights = built.level.lights;
    /* And the interior's own gain, so a capture can prove the emissive path is
     * live without a recompile. Setting it to zero must black the rooms out
     * and setting it to four must blow them; a value that changes nothing
     * means the branch is not reached, which is the failure mode that has cost
     * this project the most rounds. Development only, like __scene. */
    if (process.env.NODE_ENV === 'development') window.__litGain = LIT_GAIN;
    return () => { delete window.__shopLights; delete window.__litGain; };
  }, [built]);

  useEffect(() => () => {
    built.level.dispose();
    built.shop.dispose();
    built.glass.dispose();
    built.shutter.dispose();
    built.awning.dispose();
    built.furniture.dispose();
  }, [built]);

  const { level } = built;

  return (
    <group>
      <mesh geometry={level.shop} material={built.shop} castShadow receiveShadow />
      <mesh geometry={level.shutter} material={built.shutter} castShadow receiveShadow />
      <mesh geometry={level.awning} material={built.awning} castShadow receiveShadow />
      <mesh geometry={level.furniture} material={built.furniture} castShadow receiveShadow />
      {/* The glass receives but does not cast, for the same reason the sash
        * glass upstairs does not: a transparent pane that throws a solid black
        * rectangle into the room behind it is worse than no shadow at all, and
        * here it would black out the very interiors the pane exists to show.
        * It also renders after the opaque meshes above so the room is already
        * in the buffer to blend over. */}
      <mesh geometry={level.glass} material={built.glass} renderOrder={2} receiveShadow />
      {/* The prop kit and the projecting signage. Part of System 3 rather than
        * a system of its own: it is the same claim — that this is a street
        * somebody uses — made with the things left standing on the paving
        * instead of with the shopfronts behind them. */}
      <Props />
    </group>
  );
}
