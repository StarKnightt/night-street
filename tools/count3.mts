/* CPU-only geometry census for System 3. Not part of the build. */
import { buildStreetLevel } from '../src/world/street3';

const s = buildStreetLevel();
console.log('total triangles', s.triangles);
for (const k of ['shop', 'glass', 'shutter', 'awning', 'furniture'] as const) {
  const g = s[k];
  console.log(
    k.padEnd(10),
    'verts', String(g.getAttribute('position').count).padStart(7),
    'tris', String((g.index?.count ?? 0) / 3).padStart(7),
  );
}
console.log('lights', JSON.stringify(s.lights, null, 1));
