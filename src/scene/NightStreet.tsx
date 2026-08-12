'use client';

import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import { Street } from './Street';
import { Rig } from './Rig';
import { Grade } from './grade';
import { installSoftSunShadows } from './softShadow';
import { SunFollow } from './sunFollow';
import { installShaderErrorWatch } from './shaderWatch';
import { CityAudio, footstep } from '@/audio/CityAudio';

/* Before anything can compile a material. The patch rewrites shader chunks, and
 * a chunk is only consulted while a program is being built, so installing it
 * after the first material had compiled would leave that material with hard
 * shadows and no visible sign of it. */
installSoftSunShadows();

export default function NightStreet() {
  return (
    <div className="fixed inset-0 bg-black">
      <Canvas
        /* No MSAA on the canvas. Every silhouette in this phase is either the
         * kerb line or the horizon, both of which are long and shallow, and
         * the frame is dominated by a specular surface where the aliasing that
         * matters is in the highlight rather than on the geometric edge. FXAA
         * and a real resolve arrive with the composite in System 8. MSAA is on
         * for now because there is budget for it and the kerb arris is a
         * near-horizontal edge running the length of the frame. */
        gl={{
          antialias: true,
          powerPreference: 'high-performance',
          stencil: false,
          depth: true,
          alpha: false,
        }}
        dpr={[1, 1.5]}
        /* BasicShadowMap is not a downgrade here — it is the only type whose
         * uniform is a plain sampler2D rather than a hardware comparison
         * sampler, and reading the stored depth is what makes a blocker search
         * possible. All of the filtering is done by getSunShadow in
         * softShadow.ts, which is strictly softer and better distributed than
         * the PCF kernel this replaces. */
        shadows={{ type: THREE.BasicShadowMap }}
        camera={{ fov: 45, near: 0.05, far: 400 }}
        onCreated={({ gl, camera }) => {
          /* First, before any material in the scene has had a chance to link.
           * A program three has already checked can never be reported. */
          installShaderErrorWatch(gl);
          gl.outputColorSpace = THREE.SRGBColorSpace;
          /* AgX rather than ACES.
           *
           * The whole frame is lit by a narrow-band 2000 K source. ACES turns
           * a saturated orange highlight yellow and then white as it rolls
           * off, which is the "video game fire" look and is the wrong answer
           * for sodium: a real photograph of a sodium lamp keeps its hue right
           * into the clip. AgX desaturates towards white far more slowly and
           * holds the orange, at the cost of a flatter midtone that System 8's
           * grade will put back. */
          gl.toneMapping = THREE.AgXToneMapping;
          /* Opened up by most of a stop.
           *
           * 0.235 was carried over from the night build and it put the last half
           * hour before sunset at the value of civil twilight — every reviewer
           * has read the set as darker than the brief, and a phone pointed down
           * a shaded street at this hour would have auto-exposed for the shade
           * and let the sky clip. Raising the exposure rather than lifting the
           * shade in the shaders is deliberate: it cannot disturb the hue
           * balance that took two rounds to get right, because it scales
           * everything equally before the tone curve. */
          gl.toneMappingExposure = 0.296;
          camera.lookAt(0, 1.65, -30);
        }}
      >
        <Street />
        {/* The sun's shadow box is positioned from a `useFrame` in Street.tsx,
          * and `renderOnce()` runs no `useFrame` at all — so in every still
          * this project has taken, the box sat wherever the walk had last been
          * on the animation loop. This re-derives the same placement from
          * `scene.onBeforeRender`, which is the last hook before the depth
          * pass and runs on every render however the frame was asked for. */}
        <SunFollow />
        <Rig onFootstep={footstep} />
        {/* Last child on purpose. It subscribes to the frame loop at a
          * non-zero priority, which is what tells r3f to stop rendering the
          * scene itself and hand the job over; everything above has to have
          * had its own useFrame run first. ?nograde returns the exact frame
          * the existing screenshot archive was judged through. */}
        <Grade />
        <CityAudio />
      </Canvas>
      <Hud />
    </div>
  );
}

function Hud() {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 p-4 text-center">
      <p className="text-[11px] font-medium tracking-[0.18em] text-white/25 uppercase">
        Click to look &middot; WASD to walk
      </p>
    </div>
  );
}
