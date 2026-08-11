'use client';

/* System 1: the carriageway, the kerbs, the footways and the flush ironwork.
 *
 * This is the whole of the scene content for this phase. There are no
 * buildings, no lamp posts, no vehicles and no signage — those are Systems
 * 2–4 — so everything visible here is paving, and it has to carry the frame
 * on its own.
 */
import { useMemo, useEffect, useRef } from 'react';
import { useThree, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

import { bakeSurface, type SurfaceSet } from '@/world/bake';
import {
  ASPHALT, CONCRETE, GRANITE, CAST_IRON, GULLY, MANHOLE, TREAD,
} from '@/world/surfaces';
import {
  buildRoadGeometry, buildKerbGeometry, buildWalkGeometry,
  buildManholeGeometry, buildDrainGeometry, buildPlateGeometry,
  buildWalkSkirtGeometry, buildApronGeometry, roadHeight, walkHeight,
} from '@/world/geometry';
import { DIMS, FIXTURES , LAMPS } from '@/world/dims';
import {
  makeRoadMaterial, makeWalkMaterial, makeKerbMaterial,
  makeSimpleMaterial, makeDiscMaterial, makeSkirtMaterial,
  makeApronMaterial,
} from './materials';
import { makeNightEnv, SUN_DIR, SUN_ELEV } from './env';
import { installHaze } from './haze';
import { Dust } from './dust';
import { installSensorFloor } from './sensor';
import { Buildings } from './Buildings';
import { StreetLevel } from './StreetLevel';
import { Cars } from './Cars';

export function Street() {
  installSensorFloor();
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);

  const built = useMemo(() => {
    const sets: SurfaceSet[] = [];
    const keep = <T extends SurfaceSet>(s: T) => { sets.push(s); return s; };

    /* Texel density is the budget that matters here, not map size. The road is
     * seen at a metre away at the bottom of frame, so 4 m across 2048 px —
     * about 2 mm a texel — is the coarsest that still resolves individual
     * aggregate. Concrete gets the same treatment on a 3 m flag. */
    const asphalt = keep(bakeSurface(gl, ASPHALT, { size: 2048, patch: 2, bump: 0.013 }));
    const concrete = keep(bakeSurface(gl, CONCRETE, { size: 2048, patch: 1.8, bump: 0.006 }));
    const granite = keep(bakeSurface(gl, GRANITE, { size: 1024, patch: 2, bump: 0.005 }));
    const iron = keep(bakeSurface(gl, CAST_IRON, { size: 512, patch: 0.6, bump: 0.004 }));
    const manholeTex = keep(bakeSurface(gl, MANHOLE, { size: 1024, patch: 0.7, bump: 0.016 }));
    const tread = keep(bakeSurface(gl, TREAD, { size: 512, patch: 0.42, bump: 0.006 }));
    const gully = keep(bakeSurface(gl, GULLY, { size: 1024, patch: 0.96, bump: 0.055 }));

    const env = makeNightEnv(gl);

    const materials = {
      road: makeRoadMaterial(asphalt),
      walk: makeWalkMaterial(concrete),
      skirt: makeSkirtMaterial(),
      apron: makeApronMaterial(),
      kerb: makeKerbMaterial(granite),
      manhole: makeDiscMaterial(manholeTex, 0.22),
      frame: makeSimpleMaterial(iron, { metalness: 0.7, repeatMetres: 0.6 }),
      grate: makeDiscMaterial(gully, 0.18, 0.45),
      plate: makeSimpleMaterial(tread, { metalness: 0.8, repeatMetres: 0.42, normalScale: 1.3 }),
    };

    const geometries = {
      road: buildRoadGeometry(),
      kerb: buildKerbGeometry(),
      walk: buildWalkGeometry(),
      skirt: buildWalkSkirtGeometry(),
      apron: buildApronGeometry(),
      drain: buildDrainGeometry(),
      manhole: FIXTURES.manholes.map((m) => buildManholeGeometry(m.r)),
      plate: FIXTURES.plates.map((p) => buildPlateGeometry(p.w, p.d)),
    };

    return { sets, env, materials, geometries };
  }, [gl]);

  useEffect(() => {
    const { env } = built;
    scene.background = env.background;
    scene.environment = env.environment;
    scene.backgroundIntensity = 1;
    /* The sky now IS the fill light, and it is meant to be.
     *
     * At night the sky was held down to a quarter strength because an IBL at
     * the brightness the sky appears to have would have flooded a street lit
     * by one dim lamp. That reasoning is inverted at golden hour: everything
     * not in direct sun is lit by the sky and by nothing else, so the ratio
     * between the two is what decides whether shade reads as cool blue shadow
     * or as black. Holding the environment down here is exactly what would
     * produce the dead shadows this scene has to avoid. */
    scene.environmentIntensity = 0.50;
    /* Depth cue. City air at night is never clear — there is exhaust, there is
     * dust, and there is the sodium glow scattering in all of it, so distance
     * lifts towards the horizon colour rather than falling to black. The
     * volumetric version of this is System 6. */
    /* Haze, thinner than the night fog in absolute terms but far more visible,
     * because it is now being lit rather than merely tinted. The directional
     * part of it — milky toward the sun, clear away from it — is in haze.ts. */
    installHaze(new THREE.Vector3(...SUN_DIR), env.fogColor, env.fogSunColor);
    scene.fog = new THREE.FogExp2(env.fogColor.getHex(), 0.0072);
    return () => {
      scene.background = null;
      scene.environment = null;
      scene.fog = null;
    };
  }, [built, scene]);

  useEffect(() => () => {
    const { sets, env, materials, geometries } = built;
    sets.forEach((s) => s.dispose());
    env.dispose();
    Object.values(materials).forEach((m) => m.dispose());
    geometries.road.dispose();
    geometries.kerb.dispose();
    geometries.walk.dispose();
    geometries.skirt.dispose();
    geometries.apron.dispose();
    geometries.drain.dispose();
    geometries.manhole.forEach((g) => g.dispose());
    geometries.plate.forEach((g) => g.dispose());
  }, [built]);

  const { materials: M, geometries: G } = built;

  return (
    <group>
      <mesh geometry={G.road} material={M.road} receiveShadow castShadow />
      <mesh geometry={G.kerb} material={M.kerb} receiveShadow castShadow />
      <mesh geometry={G.walk} material={M.walk} receiveShadow castShadow />
      {/* Both of these were rendering without receiveShadow, which at this sun
        * angle is not a subtlety: the apron is a three-hundred-metre plane
        * running under and behind the whole block, so with the flag off it was
        * lit by unobstructed direct sun everywhere, including the strips
        * between and behind buildings that the buildings are standing on. That
        * is the pale table the frontages appeared to float on. */}
      <mesh geometry={G.skirt} material={M.skirt} receiveShadow />
      <mesh geometry={G.apron} material={M.apron} receiveShadow />

      {FIXTURES.manholes.map((m, i) => (
        <mesh
          key={`mh${i}`}
          geometry={G.manhole[i]}
          material={M.manhole}
          /* Just clear of the dished asphalt, which puts the cover about
           * 25 mm below the surrounding road — the step a real one has. */
          position={[m.x, roadHeight(m.x, m.z) + 0.004, m.z]}
          rotation={[0, m.rot, 0]}
          receiveShadow
        />
      ))}

      {FIXTURES.drains.map((d, i) => {
        // Hard against the kerb face, sitting in the gutter where the water
        // that the camber delivers actually goes.
        const x = d.x * (DIMS.roadHalf - 0.33);
        return (
          <mesh
            key={`dr${i}`}
            geometry={G.drain}
            material={M.grate}
            position={[x, roadHeight(x, d.z) + 0.010, d.z]}
            receiveShadow
            castShadow
          />
        );
      })}

      {FIXTURES.plates.map((p, i) => (
        <mesh
          key={`pl${i}`}
          geometry={G.plate[i]}
          material={M.plate}
          position={[p.x, walkHeight(p.x, p.z), p.z]}
          rotation={[0, p.rot, 0]}
          receiveShadow
          castShadow
        />
      ))}

      <Buildings />
      <StreetLevel />
      <Cars />
      {/* The key light, which used to be rendered from inside the lamp component
        * and so was carried off with it when the lamps went. It is the only light
        * in the scene now, which is what this hour actually has. */}
      <SunLight />
      <Dust />
    </group>
  );
}


/* The key light, and the shadow rig that makes it usable.
 *
 * A four-degree sun is the hardest possible case for shadow mapping and it is
 * worth setting up properly now, because every system after this one inherits
 * it. Three things fight you.
 *
 * The frustum has to be enormous along the light's own axis. A shadow caster
 * throws roughly thirteen times its height at this elevation, so the far plane
 * has to reach well past anything that could cast into view, while the width
 * stays tight enough to keep texel density up. Fitting the box to the walking
 * camera rather than to the whole street is what buys that: the map only ever
 * has to cover the stretch you can actually see.
 *
 * Depth precision collapses at grazing angles, because a texel of the shadow
 * map covers a long, steeply-raked strip of ground and the depth across that
 * strip varies enormously. That is what produces acne on almost-parallel
 * surfaces, and a constant bias large enough to cure it at four degrees is
 * large enough to detach contact shadows everywhere else. normalBias is the
 * right control — it offsets along the surface normal in world units, so it
 * scales with the geometry rather than with the depth range.
 *
 * And the light has to be snapped to whole texels as it follows the camera, or
 * the entire shadow crawls and shimmers as you walk, which is far more
 * distracting than a slightly worse fit.
 */
/* The box is not a cube, and that is the whole of why cast shadows were
 * arriving on the carriageway as featureless smudges.
 *
 * A directional shadow map's resolution in world units is its extent over its
 * pixel count, and those extents were 60 m in both axes. With the light 4.2
 * degrees above the horizon its own vertical axis is very nearly world up, so
 * one texel spanned 14.6 mm of *height* — and a shadow edge that is 14.6 mm
 * tall on a vertical caster lands on ground that is almost parallel to the
 * beam, where it stretches to 14.6 / tan(4.2) = 199 mm. Every shadow on the
 * road was therefore quantised to a fifth of a metre along its length, which
 * is wider than a fire-escape picket, wider than a parapet notch, and wider
 * than most of the detail the critique wanted to see printed on the tarmac.
 *
 * A street is 22 m wide and 16 m tall, not 60 by 60. Fitting the box to that —
 * and letting the ortho depth range, which costs no resolution at all, take
 * the 150 m the low sun needs along its own axis — buys 2.7x vertically and
 * 1.4x across for nothing.
 */
const SHADOW_HALF_W = 22;    // across the light, horizontally
/* Tall enough to hold the highest parapet with room to spare. A caster whose
 * top falls outside the box is clipped out of the depth pass entirely and
 * stops casting, which on a five-storey building means losing exactly the
 * parapet shadow this is being sharpened for. */
const SHADOW_TOP = 22;       // world height covered above the target
const SHADOW_BOTTOM = -4;
const SHADOW_RES = 4096;

function SunLight() {
  const ref = useRef<THREE.DirectionalLight>(null);
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);

  useEffect(() => {
    const l = ref.current;
    if (!l) return;
    scene.add(l.target);
    /* The orthographic extents arrive as props, but nothing downstream
     * recomputes the projection from them: LightShadow.updateMatrices only
     * repositions the shadow camera and updates its world matrix. Without this
     * the map is still being rendered through the default five-metre box. */
    l.shadow.camera.updateProjectionMatrix();
    return () => { scene.remove(l.target); };
  }, [scene]);

  useFrame(() => {
    const l = ref.current;
    if (!l) return;
    /* Follow the camera, snapped to the shadow map's own texel grid. Without
     * the snap the sampling lattice slides continuously under the geometry and
     * every shadow edge boils. */
    const texel = (SHADOW_HALF_W * 2) / SHADOW_RES;
    const cx = Math.round(camera.position.x / texel) * texel;
    const cz = Math.round(camera.position.z / texel) * texel;
    // Aim a little ahead: at this elevation the interesting shadows are the
    // ones being cast toward the camera from further down the street.
    const fz = cz - 8;
    l.target.position.set(cx, 0, fz);
    l.target.updateMatrixWorld();
    l.position.set(cx + SUN_DIR[0] * 60, SUN_DIR[1] * 60 + 2, fz + SUN_DIR[2] * 60);
    l.updateMatrixWorld();

    /* The frustum is set here rather than through props.
     *
     * Declaring shadow-camera-left and friends as props leaves the projection
     * matrix itself stale — nothing in the shadow path recomputes it from those
     * values — and the map goes on being rendered through the default five
     * metre box. With the box following the camera and the light sixty metres
     * out along a grazing axis, that default lands almost entirely off the
     * visible street, which is why nothing appeared to cast at all: the
     * shadows were being rendered, into a volume containing nothing.
     */
    const cam = l.shadow.camera;
    if (cam.right !== SHADOW_HALF_W) {
      cam.left = -SHADOW_HALF_W; cam.right = SHADOW_HALF_W;
      cam.top = SHADOW_TOP; cam.bottom = SHADOW_BOTTOM;
      cam.near = 1; cam.far = 150;
    }
    cam.updateProjectionMatrix();
  });

  return (
    <directionalLight
      ref={ref}
      /* Deep gold. At four degrees the beam has crossed something like thirty
       * air masses and lost most of its short wavelengths; 2200 K is roughly
       * this, and it is a long way from the pale yellow that "sunlight"
       * usually gets authored as. */
      color="#ff9a4e"
      /* Set against the sky rather than picked in isolation.
        *
        * The ground only collects a tenth of this because of the grazing
        * angle, so the number that matters is not the sun's own brightness but
        * what a tenth of it comes to next to the skylight. At the first
        * balance the sky was winning on the road surface and cast shadows were
        * invisible — not missing, just swamped. */
      intensity={115}
      castShadow
      shadow-mapSize-width={SHADOW_RES}
      shadow-mapSize-height={SHADOW_RES}
      shadow-camera-left={-SHADOW_HALF_W}
      shadow-camera-right={SHADOW_HALF_W}
      shadow-camera-top={SHADOW_TOP}
      shadow-camera-bottom={SHADOW_BOTTOM}
      shadow-camera-near={1}
      shadow-camera-far={150}
      /* Both terms have to be small, and normalBias especially so.
        *
        * normalBias offsets the lookup along the surface normal, and on ground
        * plane that offset converts into horizontal shadow displacement by a
        * factor of one over the tangent of the sun elevation. At 6 degrees
        * that factor is nearly ten: the 55 mm which is unremarkable for a
        * midday sun slides the shadow half a metre sideways, which is most of
        * the width of a kerb shadow, and the shadow simply vanishes. It was
        * not missing — it was being pushed out from under its own object. */
      shadow-bias={-0.00022}
      shadow-normalBias={0.006}
    />
  );
}

/* The night lamp rig that used to stand here has been removed; System 5 owns
 * lighting and will build the real one.
 *
 * It was fourteen unshadowed spotlights at 6.8 m with infinite range and a
 * projected dirt cookie, and it was suspected of being what kept the shaded
 * frontage reading muddy rather than blue — something warm added after the cool
 * tint. Measured before removing: disabling every spotlight changed the shaded
 * frontage by 0.0 per cent and the carriageway at nadir by 0.10 per cent. At two
 * hundred times intensity the shaded wall moved 4.5 per cent, which puts the rig
 * at roughly two hundredths of one per cent of that frame. It was not the cause
 * of anything, and the muddy shade has some other explanation.
 *
 * It goes anyway, for the reason it was costing rather than the reason it was
 * suspected: fourteen lights and a cookie sit in every material program in the
 * street, and the texture-unit budget they forced is why the three paving
 * materials have been running without their baked occlusion maps. Nothing is
 * gained by keeping a placeholder that contributes two hundredths of a per cent
 * and blocks a map that contributes visibly. */
