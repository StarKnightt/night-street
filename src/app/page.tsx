'use client';

/* Client-only. The canvas touches WebGL, pointer lock and `window` before
 * first paint, and there is nothing meaningful to server render for a
 * full-viewport 3D scene.
 *
 * `Gate` owns the dynamic import now. It decides whether the visitor has the
 * keyboard and pointer this scene is driven with, and covers the thirty-second
 * texture bake with something other than a black page. It adds nothing to the
 * frame once the street is up. */
import { Gate } from './Gate';

export default function Page() {
  return <Gate />;
}
