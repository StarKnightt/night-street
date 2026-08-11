'use client';

/* Camera rig, input, and the debug surface the capture harness drives.
 *
 * `window.__scene` mirrors jungle-trail's `window.__game`: the tool needs to
 * put the camera in exactly the same six places every run, let the simulation
 * settle without waiting for wall-clock time, and read back numbers rather
 * than opinions. It only exists in development, because it is a remote control
 * for the renderer.
 */
import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { Walker } from './walker';
import { DIMS } from '@/world/dims';

const KEYS: Record<string, string> = {
  KeyW: 'f', ArrowUp: 'f',
  KeyS: 'b', ArrowDown: 'b',
  KeyA: 'l', ArrowLeft: 'l',
  KeyD: 'r', ArrowRight: 'r',
};

export type DebugScene = {
  goTo(t: number): void;
  setYaw(rad: number): void;
  setPitch(rad: number): void;
  warp(seconds: number): void;
  setPaused(p: boolean): void;
  renderOnce(): void;
  info(): { calls: number; triangles: number; programs: number; textures: number; geometries: number };
  probe(sampleStep?: number): Record<string, number>;
  readonly fps: number;
  camera: THREE.PerspectiveCamera;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  walker: Walker;
};

declare global {
  interface Window { __scene?: DebugScene }
}

export function Rig({ onFootstep }: { onFootstep?: (foot: number) => void }) {
  const { gl, scene, camera } = useThree();
  const walker = useMemo(() => new Walker(), []);
  const held = useRef(new Set<string>());
  const paused = useRef(false);
  const fps = useRef(0);
  const euler = useMemo(() => new THREE.Euler(0, 0, 0, 'YXZ'), []);

  // System 7 plugs its footstep bank in here. Nothing listens yet.
  useEffect(() => { walker.onFootstep = onFootstep ?? null; }, [walker, onFootstep]);

  useEffect(() => {
    const canvas = gl.domElement;
    const down = (e: KeyboardEvent) => {
      const k = KEYS[e.code];
      if (k) { held.current.add(k); e.preventDefault(); }
    };
    const up = (e: KeyboardEvent) => { const k = KEYS[e.code]; if (k) held.current.delete(k); };
    const blur = () => held.current.clear();
    const click = () => { if (document.pointerLockElement !== canvas) canvas.requestPointerLock(); };
    const move = (e: MouseEvent) => {
      if (document.pointerLockElement !== canvas) return;
      walker.look(e.movementX, e.movementY);
    };

    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    canvas.addEventListener('click', click);
    document.addEventListener('mousemove', move);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      canvas.removeEventListener('click', click);
      document.removeEventListener('mousemove', move);
    };
  }, [gl, walker]);

  const apply = useMemo(() => () => {
    camera.position.set(walker.eye.x, walker.eye.y, walker.eye.z);
    euler.set(walker.pitch, walker.yaw, walker.roll);
    camera.quaternion.setFromEuler(euler);
  }, [camera, euler, walker]);

  useFrame((_, rawDelta) => {
    // A tab that has been backgrounded hands back a delta of several seconds.
    const dt = Math.min(rawDelta, 0.05);
    if (dt > 0) fps.current = fps.current ? fps.current * 0.92 + (1 / dt) * 0.08 : 1 / dt;
    if (paused.current) { apply(); return; }
    const h = held.current;
    walker.update(dt, {
      forward: (h.has('f') ? 1 : 0) - (h.has('b') ? 1 : 0),
      strafe: (h.has('r') ? 1 : 0) - (h.has('l') ? 1 : 0),
    });
    apply();
  });

  useEffect(() => {
    if (process.env.NODE_ENV !== 'development') return;

    const api: DebugScene = {
      goTo(t) { walker.placeAt(THREE.MathUtils.clamp(t, 0, 1)); walker.warp(0.35); apply(); },
      setYaw(rad) { walker.yaw = rad; apply(); },
      setPitch(rad) { walker.pitch = rad; apply(); },
      warp(seconds) { walker.warp(seconds); apply(); },
      setPaused(p) { paused.current = !!p; },
      renderOnce() { apply(); gl.render(scene, camera); },
      info() {
        const i = gl.info;
        return {
          calls: i.render.calls,
          triangles: i.render.triangles,
          programs: i.programs ? i.programs.length : 0,
          textures: i.memory.textures,
          geometries: i.memory.geometries,
        };
      },
      /**
       * Describe the frame numerically.
       *
       * Screenshots lie about exposure — the same PNG is "moody" on one panel
       * and crushed on the next — so the decision about whether a night frame
       * is underexposed or correctly exposed is made from percentiles, not by
       * eye. `blackPct` is the one that matters most here: a night street
       * photograph has deep shadows but it does not have large regions of
       * literal zero, and anything above about 8% means detail has been thrown
       * away rather than darkened.
       */
      probe(sampleStep = 4) {
        const c = gl.domElement;
        const w = c.width, h = c.height;
        const ctx = gl.getContext();
        gl.render(scene, camera);
        const px = new Uint8Array(w * h * 4);
        ctx.readPixels(0, 0, w, h, ctx.RGBA, ctx.UNSIGNED_BYTE, px);

        const lum: number[] = [];
        let black = 0, blown = 0, total = 0, upper = 0, un = 0, lower = 0, ln = 0;
        for (let j = 0; j < h; j += sampleStep) {
          for (let i = 0; i < w; i += sampleStep) {
            const k = (j * w + i) * 4;
            const l = (px[k] * 0.2126 + px[k + 1] * 0.7152 + px[k + 2] * 0.0722) / 255;
            lum.push(l);
            total++;
            if (l < 0.02) black++;
            if (l > 0.98) blown++;
            // readPixels is bottom-up, so high j is the top of the image.
            if (j > h * 0.58) { upper += l; un++; } else { lower += l; ln++; }
          }
        }
        lum.sort((a, b) => a - b);
        const q = (p: number) => +lum[Math.min(lum.length - 1, Math.floor(p * lum.length))].toFixed(3);
        return {
          p01: q(0.01), p10: q(0.1), median: q(0.5), p90: q(0.9), p99: q(0.99),
          mean: +(lum.reduce((a, b) => a + b, 0) / lum.length).toFixed(3),
          contrast: +((q(0.95) - q(0.05)) * 255).toFixed(0),
          blackPct: +((100 * black) / total).toFixed(1),
          blownPct: +((100 * blown) / total).toFixed(1),
          upper: +(upper / Math.max(1, un)).toFixed(3),
          lower: +(lower / Math.max(1, ln)).toFixed(3),
        };
      },
      get fps() { return fps.current; },
      camera: camera as THREE.PerspectiveCamera,
      renderer: gl,
      scene,
      walker,
    };

    window.__scene = api;
    // Three itself, so a diagnostic can build a throwaway material without
    // having to add a code path to the app to test the app.
    (window as unknown as { __THREE?: unknown }).__THREE = THREE;
    return () => { delete window.__scene; };
  }, [gl, scene, camera, walker, apply]);

  useEffect(() => { walker.placeAt(0); apply(); }, [walker, apply]);

  return null;
}

export { DIMS };
