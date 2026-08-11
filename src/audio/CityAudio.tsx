'use client';

/* System 7 — the one component, and the only thing the scene has to know about.
 *
 * Everything else in src/audio is plain TypeScript. This file exists to do the
 * four things that need a React tree: put the listener on the camera, resume a
 * suspended context off the gesture that already exists, drive the engine from
 * the frame loop, and hang a debug surface where the rest of the project's
 * tooling looks for one.
 *
 * Integration, in full:
 *
 *   import { CityAudio, footstep } from '@/audio/CityAudio';
 *   ...
 *   <Rig onFootstep={footstep} />
 *   <CityAudio />
 *
 * `Rig` already accepts `onFootstep` and already calls it from the gait, so
 * nothing in src/scene changes except those two attributes.
 */
import { useEffect, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { CityAudio as Engine, type AudioDebug } from './engine';

declare global {
  interface Window { __audio?: AudioDebug }
}

/* A module singleton rather than a ref.
 *
 * Two reasons, both practical. React's StrictMode mounts every component
 * twice in development, and an AudioContext per mount is two contexts, two
 * traffic beds and a browser warning about how many contexts a page may have.
 * And the footstep callback below has to be a stable function reference that
 * exists before the component mounts, because the scene passes it to Rig as a
 * prop.
 */
let engine: Engine | null = null;

function getEngine(): Engine {
  if (!engine) engine = new Engine();
  return engine;
}

/**
 * The hook the walker calls. Safe to pass to `Rig` before any audio exists —
 * it does nothing until the context is running and the graph is built.
 */
export function footstep(foot: number): void {
  engine?.footstep(foot);
}

export function CityAudio() {
  const { gl, camera } = useThree();
  const started = useRef(false);

  useEffect(() => {
    const e = getEngine();
    camera.add(e.listener);

    /* Autoplay policy.
     *
     * The context is created suspended and stays that way until a gesture.
     * The scene already asks for a click to take pointer lock, so that click
     * is the gesture; keydown is here as well because a player who alt-tabs
     * back and presses W should not find the street silent. Both listeners
     * are passive and both survive until unmount, because a context can be
     * suspended again by the browser at any time and the next gesture has to
     * be able to bring it back.
     */
    const kick = () => {
      void e.resume().then(() => {
        if (e.state !== 'running' || started.current) return;
        started.current = true;
        /* `build` renders the reverb and the first layer of the traffic bed
         * and then leaves the rest of the street queued, one stage per frame,
         * for `update` to drain. Even that first stage is seventy milliseconds
         * of arithmetic on the same click that grabs the pointer, so it goes
         * to an idle callback rather than stalling the frame the player is
         * about to start walking on. */
        const build = () => e.build();
        const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
        if (ric) ric(build, { timeout: 400 }); else setTimeout(build, 0);
      });
    };

    const canvas = gl.domElement;
    canvas.addEventListener('pointerdown', kick);
    window.addEventListener('keydown', kick);
    return () => {
      canvas.removeEventListener('pointerdown', kick);
      window.removeEventListener('keydown', kick);
      camera.remove(e.listener);
    };
  }, [gl, camera]);

  useFrame((_, rawDelta) => {
    engine?.update(Math.min(rawDelta, 0.05), camera);
  });

  /* The debug surface.
   *
   * `window.__audio` is the real home, because Rig owns `window.__scene` and
   * deletes it on unmount; mirroring onto `__scene.audio` when it turns up
   * keeps everything under one handle for anyone driving the scene from a
   * tool. The check is a property read per frame and is not worth caring
   * about.
   *
   * What it is for is the failure mode this system is most likely to have.
   * A Web Audio graph that produces silence produces no error, so every bus
   * carries an `everDb` — the loudest level it has ever passed — and any bus
   * still reading -Infinity after thirty seconds of walking has a
   * disconnected node or a zero gain in it, which is a fact a later agent can
   * establish without listening to anything.
   */
  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;
    const api = getEngine().debug();
    window.__audio = api;
    /* Rig creates `window.__scene` in its own effect and deletes it on
     * unmount, so there is no mount order in which writing to it once here is
     * reliable. A short poll costs nothing and stops after it has landed. */
    let tries = 0;
    const id = setInterval(() => {
      const scene = (window as unknown as { __scene?: { audio?: AudioDebug } }).__scene;
      if (scene) { scene.audio = api; clearInterval(id); }
      if (++tries > 40) clearInterval(id);
    }, 100);
    return () => {
      clearInterval(id);
      delete window.__audio;
    };
  }, []);

  return null;
}
