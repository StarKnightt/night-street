/* Keep the sun's shadow box under the camera on *every* render, not only on
 * the ones that came from the animation loop.
 *
 * ── The defect, measured ──────────────────────────────────────────────────
 *
 * `Street.tsx` follows the camera with the shadow box from a `useFrame`, and
 * that is correct for the interactive walk and wrong for every still this
 * project has ever produced. `Rig.tsx`'s `renderOnce()` is `apply();
 * gl.render(scene, camera)` — it moves the camera and draws, and it does not
 * run a single `useFrame` subscriber. Every capture tool teleports and renders
 * inside one synchronous `page.evaluate`, so no animation frame runs between
 * the move and the draw and the follower never sees the new camera.
 *
 * Measured with `tools/shafts.mjs` at t = 0.4, before this file existed:
 *
 *     camera        0.05, 1.65, -35.20
 *     shadow target -0.58, 2.00,  -4.00      31 metres up the street
 *     light         33.08, 14.47, -52.08     consistent with that target
 *
 * The box is 44 m across and had been left where the walk starts. Air marched
 * at z = -35 to -110 therefore lands outside the shadow camera's frustum in
 * shadow-UV space, `inside` evaluates to zero for every sample, and
 * `volumetric.ts`'s `shadeSharp` integral is exactly 0.00000 in all ten of
 * `tools/atmo.mjs`'s regions — which is what it measured. The same staleness
 * removes every *cast* shadow from the visible street in a still, because a
 * point outside the frustum is reported lit by three's own shadow lookup too.
 *
 * This is the third instance of one bug in this tree, and `NOTES.md` records
 * the other two: the mote field that "sat 32 m behind the camera in every
 * capture ever reviewed" is the same sentence with a different subject, and
 * `dust.tsx:160-180` fixed it by keying off `cameraPosition` — a value the
 * renderer uploads during the draw — instead of a uniform written in
 * `useFrame`. The lesson generalises: anything positioned per frame must be
 * positioned from the render path, because the render path is the only thing
 * a still runs.
 *
 * ── Why a hook rather than a fix in Street.tsx ────────────────────────────
 *
 * `Street.tsx` is locked to another pass. The follower there is not wrong
 * about *what* it computes — only about when it runs — so this does not
 * replace it and does not need to know any of its constants.
 *
 * ── Why it transcribes nothing ────────────────────────────────────────────
 *
 * `NOTES.md` is emphatic that a hand-copied constant is this project's most
 * expensive recurring failure, and a second follower spelling out
 * `SHADOW_HALF_W`, the 8 m lead, the 2 m lift and the 60 m stand-off would be
 * exactly that: four numbers that would go on reading correct on the day
 * Street.tsx changed one of them.
 *
 * So this hook holds no placement at all. On the first render it *learns* the
 * arrangement: it subtracts the snapped camera position from wherever
 * `Street.tsx` has just put the light and its target, and keeps the two
 * residuals. Every offset in that arrangement — the 8 m lead, the 2 m lift,
 * the 60 m stand-off, the light's height, the sun's bearing — is inside those
 * residuals and none of them is ever named here. Thereafter it re-adds them to
 * the current snapped camera position.
 *
 * Written as an absolute placement rather than as a translation on purpose,
 * and the difference is a real bug rather than a style: on a live frame
 * `Street.tsx`'s `useFrame` has *already* moved the light, so a hook that
 * added its own delta on top would move it twice and the box would run away
 * from the camera at walking pace. Re-deriving the absolute position writes
 * the identical value Street.tsx just wrote, so the live path is unchanged to
 * the last bit and only the still path differs.
 *
 * The one thing it does read is the snap grid, and it reads it off the live
 * shadow camera — `(right - left) / mapSize.x` — rather than restating it.
 * Without the snap the two followers would disagree by up to a texel and the
 * sampling lattice would slide under the geometry, which is the boiling
 * Street.tsx's own comment added the snap to prevent.
 *
 * ── Why `scene.onBeforeRender` specifically ───────────────────────────────
 *
 * `WebGLRenderer.render` runs, in this order: `scene.updateMatrixWorld()`,
 * `camera.updateMatrixWorld()`, `scene.onBeforeRender(...)`, and then
 * `shadowMap.render(...)`, which is where `LightShadow.updateMatrices` reads
 * `light.matrixWorld` and `light.target.matrixWorld` to build the projection
 * and the shadow matrix. So this is the last hook before the depth pass and
 * the only one that can still move the box. An object's `onBeforeRender` —
 * the hook `dust.tsx` uses — is far too late: it runs during the colour pass,
 * after the shadow map has already been rendered from the old position.
 *
 * Because the scene graph has already been updated by the time this runs, the
 * two `updateMatrixWorld` calls below are not optional.
 */
import * as THREE from 'three';
import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';

/* three declares one `onBeforeRender` on Object3D, with the six arguments it
 * passes when the object is a mesh being drawn. For a *scene* it passes four,
 * the last being the current render target, and the declaration does not say
 * so. Only the camera is read here, so the extra parameters are left
 * unnamed rather than re-declared against three's own type. */
type Hook = THREE.Object3D['onBeforeRender'];

/** Published for the instruments, so a tool can say whether the hook ran. */
export type SunFollowState = {
  /** How far this hook had to correct the light on the most recent render. */
  moved: number;
  /** Total renders this hook has serviced. */
  renders: number;
  /** The snapped camera position the current placement corresponds to. */
  anchor: [number, number];
  /** The learned arrangement: light and target, relative to the snapped camera. */
  offsets: { light: [number, number, number]; target: [number, number, number] } | null;
};

export const sunFollowState: SunFollowState = {
  moved: 0, renders: 0, anchor: [0, 0], offsets: null,
};

function brightestSun(scene: THREE.Object3D): THREE.DirectionalLight | null {
  let best: THREE.DirectionalLight | null = null;
  scene.traverse((o) => {
    const d = o as THREE.DirectionalLight;
    if (!d.isDirectionalLight || !d.castShadow) return;
    if (!best || d.intensity > best.intensity) best = d;
  });
  return best;
}

export function installSunFollow(scene: THREE.Scene): () => void {
  const previous = scene.onBeforeRender as Hook;
  let anchored: THREE.DirectionalLight | null = null;
  const offLight = new THREE.Vector3();
  const offTarget = new THREE.Vector3();
  const want = new THREE.Vector3();
  const was = new THREE.Vector3();

  const follow = (camera: THREE.Camera) => {
    const light = brightestSun(scene);
    if (!light || !light.shadow) return;
    const cam = light.shadow.camera as THREE.OrthographicCamera;
    const res = light.shadow.mapSize.x;
    const texel = (cam.right - cam.left) / Math.max(1, res);
    if (!(texel > 0)) return;

    want.set(Math.round(camera.position.x / texel) * texel, 0,
      Math.round(camera.position.z / texel) * texel);

    sunFollowState.renders++;
    sunFollowState.anchor = [want.x, want.z];

    /* Learn the arrangement, once per light object. A light React has only
     * just mounted has not been placed against any camera yet, so residuals
     * taken from it would be wrong by a constant for the rest of the session;
     * re-learning on identity change is what keeps a hot reload honest. */
    if (light !== anchored) {
      anchored = light;
      offLight.copy(light.position).sub(want);
      offTarget.copy(light.target.position).sub(want);
      sunFollowState.offsets = {
        light: [offLight.x, offLight.y, offLight.z],
        target: [offTarget.x, offTarget.y, offTarget.z],
      };
      sunFollowState.moved = 0;
      return;
    }

    was.copy(light.position);
    light.position.copy(want).add(offLight);
    light.target.position.copy(want).add(offTarget);
    sunFollowState.moved = was.distanceTo(light.position);
    if (sunFollowState.moved === 0) return;
    light.updateMatrixWorld(true);
    light.target.updateMatrixWorld(true);
  };

  scene.onBeforeRender = function onBeforeRender(...args) {
    if (previous) previous.apply(this, args);
    follow(args[2]);
  };

  return () => { scene.onBeforeRender = previous; };
}

/** Mount once, anywhere inside the Canvas. */
export function SunFollow() {
  const scene = useThree((s) => s.scene);
  useEffect(() => installSunFollow(scene), [scene]);
  return null;
}
