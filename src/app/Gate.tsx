'use client';

/* The front door of the hosted build. Nothing in here is part of the scene —
 * it decides whether to mount it, and covers the gap while it is being made.
 *
 * Two facts about this street drive everything below, and both were measured
 * against the deployed build rather than assumed:
 *
 * 1. There is no first frame for about thirty seconds. Every texture is a GLSL
 *    surface description baked into a render target at load, so the network is
 *    done in well under a second and then the main thread and the GPU are busy
 *    for the rest of it. On an RTX 4060 the first lit frame lands at 32.4 s.
 *    A visitor who is given a black page for that long leaves, so the veil
 *    below is painted before the scene module is even fetched, and it says how
 *    long it will be and why.
 *
 * 2. The controls are a keyboard and a pointer lock. `Rig.tsx` reads WASD off
 *    window keydown and turns on `movementX` from a locked pointer; neither
 *    exists on a phone. A touch visitor who waited out the bake would arrive at
 *    a street they cannot walk down, so they are told that up front instead and
 *    given the choice rather than the black screen.
 *
 * The veil cannot be a spinner driven by JS. The bake blocks the main thread in
 * tasks of six, twenty and twenty-four seconds, so anything animated from a
 * timer or an rAF is frozen for exactly the interval it exists to cover. The
 * bar is a CSS transform animation, which Chromium and Safari run on the
 * compositor and which therefore keeps moving while the thread is blocked.
 */

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useState } from 'react';

const NightStreet = dynamic(() => import('@/scene/NightStreet'), { ssr: false });

/* Set this to the URL of the walkthrough and the touch card will offer it
 * instead of a street nobody on a phone can walk. Empty means no player. */
const VIDEO_URL = '';

const REPO_URL = 'https://github.com/StarKnightt/night-street';

/** A device that can drive this: a real pointer that can be locked, and a
 *  viewport with room for the frame. Feature queries rather than user agents. */
function canDrive(): boolean {
  if (typeof window === 'undefined') return false;
  const fine = window.matchMedia?.('(pointer: fine)').matches ?? true;
  const lockable = 'requestPointerLock' in Element.prototype;
  return fine && lockable && window.innerWidth >= 700;
}

export function Gate() {
  /* `null` until the media queries have been asked, which cannot happen during
   * the server render. Nothing is mounted and nothing is claimed before then. */
  const [drive, setDrive] = useState<boolean | null>(null);
  const [forced, setForced] = useState(false);

  useEffect(() => { setDrive(canDrive()); }, []);

  const start = useCallback(() => { setForced(true); }, []);

  if (drive === null) return <Veil settling={false} />;
  if (drive || forced) return <Scene />;
  return <TouchCard onStart={start} />;
}

/** The scene, plus the veil, until frames are arriving steadily. */
function Scene() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    /* "Ready" is not the canvas existing — it exists long before it has
     * anything in it. It is the frame loop running at a sane interval: eight
     * consecutive animation frames closer together than 120 ms, which cannot
     * happen while a multi-second bake still holds the thread. */
    let run = 0;
    let last = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      run = dt < 120 ? run + 1 : 0;
      if (run >= 8 && document.querySelector('canvas')) { setReady(true); return; }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <>
      <NightStreet />
      {!ready && <Veil settling />}
    </>
  );
}

function Veil({ settling }: { settling: boolean }) {
  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-[#05070b] px-6">
      <div className="w-full max-w-md text-center">
        <p className="text-[11px] font-medium tracking-[0.3em] text-white/40 uppercase">
          Night Street
        </p>
        <p className="mt-6 text-sm leading-relaxed text-white/60">
          Building the street. Every surface, mesh and sound in this scene is
          generated in your browser right now, from code — there is nothing to
          download because there are no assets to download.
        </p>
        <p className="mt-3 text-sm leading-relaxed text-white/35">
          It takes about thirty seconds on a desktop GPU, and the page will not
          respond while it works.
        </p>
        {settling && (
          <div className="mt-8 h-px w-full overflow-hidden bg-white/10">
            <div className="ns-sweep h-px w-1/3 bg-white/50" />
          </div>
        )}
      </div>
    </div>
  );
}

function TouchCard({ onStart }: { onStart: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-[#05070b] px-6 py-10">
      <div className="w-full max-w-md">
        <p className="text-[11px] font-medium tracking-[0.3em] text-white/40 uppercase">
          Night Street
        </p>
        <h1 className="mt-5 text-xl leading-snug font-medium text-white/90">
          This one needs a keyboard and a mouse.
        </h1>
        <p className="mt-4 text-sm leading-relaxed text-white/60">
          The street is walked with WASD and looked around with a locked mouse
          pointer, and there is no touch control scheme. It also spends about
          thirty seconds generating every texture and mesh on the GPU before the
          first frame, which is a long time to ask a phone for.
        </p>
        {VIDEO_URL ? (
          <video
            className="mt-6 w-full rounded-sm"
            src={VIDEO_URL}
            controls
            playsInline
            preload="metadata"
          />
        ) : null}
        <div className="mt-8 flex flex-col gap-3">
          <button
            type="button"
            onClick={onStart}
            className="w-full border border-white/20 px-4 py-3 text-[11px] font-medium tracking-[0.2em] text-white/70 uppercase transition-colors hover:border-white/40 hover:text-white/90"
          >
            Load it anyway
          </button>
          <a
            href={REPO_URL}
            className="w-full border border-transparent px-4 py-3 text-center text-[11px] font-medium tracking-[0.2em] text-white/40 uppercase transition-colors hover:text-white/70"
          >
            Read the source
          </a>
        </div>
      </div>
    </div>
  );
}
