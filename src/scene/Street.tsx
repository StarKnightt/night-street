'use client';

/* System 1: the carriageway, the kerbs, the footways and the flush ironwork.
 *
 * This is the whole of the scene content for this phase. There are no
 * buildings, no lamp posts, no vehicles and no signage — those are Systems
 * 2–4 — so everything visible here is paving, and it has to carry the frame
 * on its own.
 */
import { useMemo, useEffect, useLayoutEffect, useRef } from 'react';
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
import { makeNightEnv, SUN_DIR, SUN_ELEV, SUN_COLOR_HEX, SUN_INTENSITY } from './env';
import {
  SHADOW_U, SHADOW_V_BOTTOM, SHADOW_V_TOP, SHADOW_RES_U, SHADOW_RES_V,
  SHADOW_NEAR, SHADOW_FAR, SHADOW_TEXEL, SHADOW_UP, SHADOW_BIAS,
  SHADOW_NORMAL_BIAS, shadowTarget, shadowLight,
} from './sunShadow';
import { installHaze } from './haze';
import { Dust } from './dust';
import { installSensorFloor } from './sensor';
import { Buildings } from './Buildings';
import { StreetLevel } from './StreetLevel';
import { Cars } from './Cars';
import { Lighting } from './Lighting';

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

    /* The sky, the environment and the fog are attached here, during render,
     * and not in the effect below. This is a load-time fix and a correctness
     * one, and it does not change a pixel of the finished frame.
     *
     * React runs effects after the commit and r3f draws at least one frame
     * before they land. So with these assignments in an effect, the first frame
     * compiled every material in the street with USE_ENVMAP and USE_FOG both
     * absent, and the effect then invalidated the program cache key of every one
     * of them, so the second frame compiled the lot again. Measured in
     * docs/COLDSTART.md: seven of the eight large programs linked before the
     * twenty-second mark had an exact twin later, larger by 17,363 characters
     * and otherwise textually identical, and the discarded set cost 15.1 s of a
     * 32 s cold start.
     *
     * installHaze is the reason this is more than a load-time bug. It rewrites
     * THREE.ShaderChunk in place, globally, so every program built before it
     * runs carries three's stock fog rather than this scene's atmosphere. The
     * first frame a visitor could see was rendered with the wrong sky, and that
     * is invisible today only because the loading veil is still up over it.
     *
     * Only the forward direction moves. The teardown stays in the effect below,
     * because unmount ordering is exactly what an effect cleanup is for. */
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
     * produce the dead shadows this scene has to avoid.
     *
     * All of which was written above a 0.50, which is to say the file argued
     * for the sky and then halved it. It is 1.0 now: the probe is a radiance
     * map of a sky whose levels were authored absolutely — env.ts says so in
     * as many words, and NOTES.md's curve sweep clears it as "the thing the
     * transform was validated against" — so any coefficient other than one is
     * asserting the sky is not the sky.
     *
     * Measured with tools/skylift.mjs, on one build, switching the gain
     * between two draws: the ground half of the frame gains 1.3x to 2.2x
     * depending on how much of it the sun reaches, the whole frame 1.02x to
     * 1.25x — small only because the sky itself fills a third of these frames
     * and does not move. Nothing clips: the blown-pixel count is 0.000 per
     * cent at every one of six viewpoints, before and after. */
    scene.environmentIntensity = 1.0;
    /* Haze, thinner than the night fog in absolute terms but far more visible,
     * because it is now being lit rather than merely tinted. The directional
     * part of it — milky toward the sun, clear away from it — is in haze.ts.
     * Idempotent: it guards on THREE.ShaderChunk.__hazeInstalled, so a double
     * invocation under StrictMode installs once. */
    /* The two probes, published so that the sky the scene is lit by can be
     * switched inside one draw. Both are cubeUV PMREM targets, so three's
     * program cache key does not move and nothing recompiles between the two
     * frames — which is the only way the difference measured is the sky and
     * not a rebuild. Dev only; in production `environmentFlat` is not built. */
    if (process.env.NODE_ENV !== 'production') {
      (window as unknown as { __env?: unknown }).__env = {
        clouds: env.environment,
        flat: env.environmentFlat ?? env.environment,
        hasFlat: !!env.environmentFlat,
      };
    }
    installHaze(new THREE.Vector3(...SUN_DIR), env.fogColor, env.fogSunColor);
    scene.fog = new THREE.FogExp2(env.fogColor.getHex(), 0.0072);

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
  }, [gl, scene]);

  /* Re-assert, and tear down.
   *
   * The assignments that matter for load time are in the useMemo above, because
   * only those run before the first draw. This repeats them, which sounds
   * redundant and is not: React Fast Refresh can preserve a useMemo across an
   * edit while still running an effect cleanup, and the profiler caught exactly
   * that — after a hot reload the scene had been stripped of its environment and
   * fog and every program recompiled without them. That is invisible in
   * production, where there is one mount, and very visible to anyone walking the
   * street on a dev server while somebody edits the tree, which is the situation
   * this project is actually in.
   *
   * Costs nothing when it is already right: three keys the program cache on
   * whether an environment and a fog exist, not on their identity, so assigning
   * the same objects again dirties no material.
   *
   * A layout effect rather than a passive one, so that if it ever is doing real
   * work it happens before the browser paints rather than after. */
  useLayoutEffect(() => {
    const { env } = built;
    scene.background = env.background;
    scene.environment = env.environment;
    scene.backgroundIntensity = 1;
    // The same value as the useMemo above, and it has to be: this re-asserts
    // that block after a Fast Refresh, so a difference here is a scene whose
    // lighting depends on whether anyone has saved a file.
    scene.environmentIntensity = 1.0;
    if (!scene.fog) scene.fog = new THREE.FogExp2(env.fogColor.getHex(), 0.0072);
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
      {/* System 5. Seven luminaires, three neon signs, a traffic signal and
        * the analytic sources they register — and not one additional Light.
        * Mounted after Cars because it picks up window.__carLights. */}
      <Lighting />
      {/* The key light, which used to be rendered from inside the lamp component
        * and so was carried off with it when the lamps went. It is still the
        * only light in the scene, which is what this hour actually has. */}
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
 * That reasoning was right about density and wrong about *shape*, and the
 * shape is what the box was then cut down to: 44 m by 26 m about a target
 * eight metres ahead of the walker. Fitting the box to the street's
 * cross-section only works if the box's axes are the cross-section's axes, and
 * at this elevation they are not — both of them carry street length, so
 * walking spends both. Probed through the live shadow camera from a walker at
 * z -49.9, the road was inside the box at z -60 and off the bottom of it by
 * z -75: about ten metres ahead of the walker, on a street readable for
 * eighty. Everything past that had no cast shadow at all.
 *
 * `sunShadow.ts` now owns the frustum, rolled so that one axis runs along the
 * street, and it is the only statement of it: `softShadow.ts` reads the same
 * extents rather than typing them out a second time into GLSL. Nothing about
 * the box can now be changed here and not there.
 */
function SunLight() {
  const ref = useRef<THREE.DirectionalLight>(null);
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);

  useEffect(() => {
    const l = ref.current;
    if (!l) return;
    scene.add(l.target);
    /* The roll of the box.
     *
     * `LightShadow.updateMatrices` re-aims the shadow camera every frame with
     * `shadowCamera.lookAt(target)`, and `Object3D.lookAt` reads `this.up`, so
     * this one vector sets the orientation of the whole frustum and survives
     * every re-aim without further help. It is perpendicular to the sun by
     * construction, so the basis can never degenerate. */
    l.shadow.camera.up.copy(SHADOW_UP);
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
    /* The snap grid is `sunShadow.ts`'s, and it is the same expression
     * `sunFollow.ts` recovers off the live shadow camera as
     * `(right - left) / mapSize.x`. The two followers have to quantise the
     * camera identically or they disagree by up to a texel and the sampling
     * lattice slides under the geometry — which is the boiling the snap exists
     * to prevent, and which the capture-time liveness assertion measures. */
    const cx = Math.round(camera.position.x / SHADOW_TEXEL) * SHADOW_TEXEL;
    const cz = Math.round(camera.position.z / SHADOW_TEXEL) * SHADOW_TEXEL;
    /* The lead, the 2 m lift and the stand-off all come from `sunShadow.ts`.
     *
     * The lift goes on both ends, not just the light. It used to be added to
     * the light's Y alone, which tilts the vector from target to light away
     * from SUN_DIR: at SUN_ELEV 12 the light sat at 13.855 degrees, and at the
     * original 4.2 it sat at 6.099. The shadow map was therefore raked about
     * 1.9 degrees above the sky's own sun since the first commit. Both ends
     * lifted keeps the frustum clear of the carriageway while leaving the
     * direction exactly SUN_DIR — which is what `tools/sunalign.mjs` measures
     * and reports at 0.0000 degrees.
     *
     * Both placements stay a pure translation of the snapped camera position,
     * which is not incidental: `sunFollow.ts` re-asserts them on renders no
     * animation frame preceded by *learning* the two residuals rather than
     * transcribing anything, and a placement that were not a pure translation
     * would break that model silently. */
    const t = shadowTarget(cx, cz);
    const p = shadowLight(cx, cz);
    l.target.position.set(t[0], t[1], t[2]);
    l.target.updateMatrixWorld();
    l.position.set(p[0], p[1], p[2]);
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
    if (cam.right !== SHADOW_U) {
      cam.left = -SHADOW_U; cam.right = SHADOW_U;
      cam.top = SHADOW_V_TOP; cam.bottom = SHADOW_V_BOTTOM;
      cam.near = SHADOW_NEAR; cam.far = SHADOW_FAR;
      /* Re-asserted here as well as in the effect above, because Fast Refresh
       * can hand back a light object whose shadow camera has been rebuilt. */
      cam.up.copy(SHADOW_UP);
    }
    cam.updateProjectionMatrix();
  });

  return (
    <directionalLight
      ref={ref}
      /* Deep gold, and imported rather than spelled, so the key light and the
       * sky cannot disagree about what colour the sun is. A beam crossing this
       * much air has lost most of its short wavelengths; 2200 K is roughly it,
       * a long way from the pale yellow "sunlight" usually gets authored as. */
      color={SUN_COLOR_HEX}
      /* Set against the sky rather than picked in isolation.
        *
        * The ground only collects a fraction of this because of the grazing
        * angle, so the number that matters is not the sun's own brightness but
        * what that fraction comes to next to the skylight. At the first
        * balance the sky was winning on the road surface and cast shadows were
        * invisible — not missing, just swamped. */
      intensity={SUN_INTENSITY}
      castShadow
      /* Not square, and that is the point of rolling the box.
       *
       * The street axis has to span 90 m and the canyon's cross-section 32 m,
       * so a square map would be paying for 90 m of resolution on an axis that
       * needs 32. Measured on the road rather than on the frustum's own axes,
       * which is the only figure that means anything once the box is rolled:
       * 413 mm² of road per texel against the shipped box's 328, for eight
       * times the length of street and twice the map. `sunShadow.ts` has the
       * reasoning and `tools/edgewidth.mjs` has what it does to an edge. */
      shadow-mapSize-width={SHADOW_RES_U}
      shadow-mapSize-height={SHADOW_RES_V}
      shadow-camera-left={-SHADOW_U}
      shadow-camera-right={SHADOW_U}
      shadow-camera-top={SHADOW_V_TOP}
      shadow-camera-bottom={SHADOW_V_BOTTOM}
      shadow-camera-near={SHADOW_NEAR}
      shadow-camera-far={SHADOW_FAR}
      /* Both terms have to be small, and normalBias especially so.
        *
        * normalBias offsets the lookup along the surface normal, and on ground
        * plane that offset converts into horizontal shadow displacement by a
        * factor of one over the tangent of the sun elevation. At 6 degrees
        * that factor is nearly ten: the 55 mm which is unremarkable for a
        * midday sun slides the shadow half a metre sideways, which is most of
        * the width of a kerb shadow, and the shadow simply vanishes. It was
        * not missing — it was being pushed out from under its own object. */
      /* Both derived rather than typed. `shadow-bias` is in normalised depth,
       * so its world meaning changes with the depth range; `sunShadow.ts`
       * holds the 32.8 mm along the beam that was actually tuned and divides
       * by the range, so raising the far plane cannot silently change it. */
      shadow-bias={SHADOW_BIAS}
      shadow-normalBias={SHADOW_NORMAL_BIAS}
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
