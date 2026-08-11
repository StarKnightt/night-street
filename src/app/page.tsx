'use client';

import dynamic from 'next/dynamic';

/* Client-only. The canvas touches WebGL, pointer lock and `window` before
 * first paint, and there is nothing meaningful to server render for a
 * full-viewport 3D scene. */
const NightStreet = dynamic(() => import('@/scene/NightStreet'), { ssr: false });

export default function Page() {
  return <NightStreet />;
}
