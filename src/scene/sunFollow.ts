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
  /**
   * What the pre-fix build would have drawn, per render, for the whole
   * session.
   *
   * This is the general instrument the fix makes possible and the reason it
   * is worth more than the fix. The hook sees every render and knows, before
   * it corrects anything, how far the box had drifted from the camera about
   * to be drawn — which is *exactly* the error the pre-fix build shipped on
   * that frame. So any tool, running normally with the fix on, can report
   * whether its own render idiom was ever affected, without a second run,
   * without disabling anything, and without a per-tool edit.
   *
   * It answers the question that actually matters and that reasoning gets
   * wrong: `shoot.mjs` waits 200 ms after `goTo` before it captures, an
   * animation frame runs in that gap, and `Street.tsx`'s own follower places
   * the box correctly — so the screenshot archive was never affected at all.
   * `frontage.mjs` teleports and renders inside one evaluate and was affected
   * on every sample. Nothing about either is visible in the source without
   * tracing where the animation frames fall.
   */
  ledger: {
    renders: number;
    /** Renders whose box was more than a texel from where the camera wanted it. */
    stale: number;
    /** The worst drift seen, in metres, and where. */
    worst: { metres: number; camera: [number, number, number]; target: [number, number, number] } | null;
    /** Metres of drift, bucketed, so a distribution is available and not just a peak. */
    buckets: Record<string, number>;
  };
};

export const sunFollowState: SunFollowState = {
  moved: 0, renders: 0, anchor: [0, 0], offsets: null,
  ledger: { renders: 0, stale: 0, worst: null, buckets: {} },
};

/* The fix, switchable, so its effect can be measured rather than argued.
 *
 * Everything this hook invalidates has to be quantified against captures taken
 * with the bug present, and the only clean experiment is to toggle the fix
 * itself on one build: comparing today's frames against the archive would
 * attribute the clouds, the ozone re-grade, the sun at 12 degrees and four
 * other passes to this bug. `?nosunfollow` — or `window.__sunFollowOff = true`
 * set from an init script before the page loads — makes the hook inert, which
 * restores the pre-0a4f58b behaviour exactly: `Street.tsx`'s `useFrame` is
 * still the only thing placing the box, so a render that no animation frame
 * preceded gets whatever placement the last one left.
 *
 * Read per render rather than once, so a tool can switch it between two
 * renders of one frozen world state and difference them.
 */
function disabled(): boolean {
  if (process.env.NODE_ENV === 'production') return false;
  if (typeof window === 'undefined') return false;
  const w = window as unknown as { __sunFollowOff?: boolean };
  if (w.__sunFollowOff) return true;
  return new URLSearchParams(window.location.search).has('nosunfollow');
}

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

  /** The snap grid, read off the live shadow camera. Null if there is no sun. */
  const grid = (): { light: THREE.DirectionalLight; texel: number } | null => {
    const light = brightestSun(scene);
    if (!light || !light.shadow) return null;
    const cam = light.shadow.camera as THREE.OrthographicCamera;
    const texel = (cam.right - cam.left) / Math.max(1, light.shadow.mapSize.x);
    return texel > 0 ? { light, texel } : null;
  };

  /** Re-assert the learned arrangement about a snapped ground position. */
  const place = (light: THREE.DirectionalLight) => {
    was.copy(light.position);
    light.position.copy(want).add(offLight);
    light.target.position.copy(want).add(offTarget);
    sunFollowState.moved = was.distanceTo(light.position);
    if (sunFollowState.moved === 0) return;
    light.updateMatrixWorld(true);
    light.target.updateMatrixWorld(true);
  };

  const follow = (camera: THREE.Camera) => {
    const g = grid();
    if (!g) return;
    const { light, texel } = g;

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

    /* Read the drift *before* correcting it — that value is the pre-fix
     * build's error on this exact frame, and it is only observable here. */
    const l = sunFollowState.ledger;
    const t = light.target.position;
    const drift = Math.hypot(t.x - (want.x + offTarget.x), t.z - (want.z + offTarget.z));
    l.renders++;
    if (drift > texel) {
      l.stale++;
      if (!l.worst || drift > l.worst.metres) {
        l.worst = {
          metres: drift,
          camera: [camera.position.x, camera.position.y, camera.position.z],
          target: [t.x, t.y, t.z],
        };
      }
    }
    const b = drift <= texel ? 'exact'
      : drift < 0.1 ? '<0.1 m'
        : drift < 1 ? '0.1-1 m'
          : drift < 10 ? '1-10 m'
            : drift < 50 ? '10-50 m' : '>50 m';
    l.buckets[b] = (l.buckets[b] || 0) + 1;

    if (disabled()) { sunFollowState.moved = 0; return; }
    place(light);
  };

  scene.onBeforeRender = function onBeforeRender(...args) {
    if (previous) previous.apply(this, args);
    follow(args[2]);
  };

  /* ── The instrument surface ──────────────────────────────────────────────
   *
   * Published rather than reconstructed in a tool, because the residuals this
   * hook learns are the only statement of the arrangement that is not a
   * hand-copy of `Street.tsx`'s four constants. `NOTES.md` is emphatic about
   * what a transcribed constant costs here, and a guard that transcribes the
   * thing it is guarding is worth nothing.
   */
  if (process.env.NODE_ENV === 'development' && typeof window !== 'undefined') {
    (window as unknown as { __sunFollow?: unknown }).__sunFollow = {
      state: sunFollowState,
      get on() { return !disabled(); },
      /** Anchor the box to an arbitrary ground point and stop correcting it.
       *
       * This is how the pre-fix frame is reproduced exactly on the current
       * build: pin to where the walk had last been on the animation loop,
       * teleport, render — all inside one evaluate, since any animation frame
       * in between would let `Street.tsx`'s own follower fix it. */
      pin(x: number, z: number) {
        const g = grid();
        if (!g || !anchored) return null;
        want.set(Math.round(x / g.texel) * g.texel, 0, Math.round(z / g.texel) * g.texel);
        place(g.light);
        (window as unknown as { __sunFollowOff?: boolean }).__sunFollowOff = true;
        return [want.x, want.z];
      },
      release() {
        delete (window as unknown as { __sunFollowOff?: boolean }).__sunFollowOff;
      },
      /** Scope the audit to one phase of a tool rather than to the session. */
      resetLedger() {
        sunFollowState.ledger = { renders: 0, stale: 0, worst: null, buckets: {} };
      },
      /**
       * How far the shadow box is from where the given camera implies it
       * should be, in texels of the shadow map. Zero on a correct frame by
       * construction, and it names the units the snap is quantised in so a
       * caller does not have to know the grid.
       */
      residual(camera: THREE.Camera) {
        const g = grid();
        if (!g || !sunFollowState.offsets) return null;
        const o = sunFollowState.offsets.target;
        const wantX = Math.round(camera.position.x / g.texel) * g.texel + o[0];
        const wantZ = Math.round(camera.position.z / g.texel) * g.texel + o[2];
        const t = g.light.target.position;
        const dx = t.x - wantX, dz = t.z - wantZ;
        return {
          metres: Math.hypot(dx, dz),
          texels: Math.hypot(dx, dz) / g.texel,
          texel: g.texel,
          target: [t.x, t.y, t.z],
          expected: [wantX, o[1], wantZ],
          camera: [camera.position.x, camera.position.y, camera.position.z],
        };
      },
    };
  }

  return () => {
    scene.onBeforeRender = previous;
    if (typeof window !== 'undefined') {
      delete (window as unknown as { __sunFollow?: unknown }).__sunFollow;
    }
  };
}

/** Mount once, anywhere inside the Canvas. */
export function SunFollow() {
  const scene = useThree((s) => s.scene);
  useEffect(() => installSunFollow(scene), [scene]);
  return null;
}
