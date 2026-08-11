/* CPU-only census and siting report for System 5. Not part of the build.
 *
 *   node --experimental-strip-types --import ./tools/ts-hooks-reg.mjs tools/sys5.mts
 *
 * Everything System 5 places is a pure function of the two world seeds, so the
 * positions the capture stops have to be aimed at can be derived here rather
 * than found by shooting the street and looking. That matters because the dev
 * server only runs for capture batches: a stop that has to be discovered from
 * a frame costs a whole extra batch.
 */
import { buildLamps } from '../src/world/lamps';
import { buildNeon } from '../src/world/neon';
import { litUnits, buildStreetLevel } from '../src/world/street3';
import { layoutBlock } from '../src/world/block';
import { upperWindows } from '../src/world/facade';
import { walkHeight } from '../src/world/geometry';
import { LAMPS, LAMP_H } from '../src/world/dims';

const LAMP_STATE = [2, 1, 0, 2, 1, 2, 0];
const OUTREACH = 1.15;
const rgb = [1, 0.2, 0.1] as const;

const lit = litUnits();
console.log('lit units');
for (const u of lit) {
  const l = u.light;
  console.log(
    ' ', l.kind.padEnd(6),
    'centre', l.pos.map((v) => v.toFixed(2)).join(' '),
    'w', l.width.toFixed(2), 'h', l.height.toFixed(2),
    'fascia', u.fasciaY0.toFixed(2), '-', u.fasciaY1.toFixed(2),
    'u', u.u0.toFixed(2), '-', u.u1.toFixed(2),
    u.awning ? 'AWNING' : '',
  );
}

const lamps = buildLamps(LAMP_STATE, OUTREACH);
console.log('lamp triangles', lamps.triangles);
for (let i = 0; i < LAMPS.length; i++) {
  const [x, , z] = LAMPS[i];
  console.log(
    '  lamp', i, 'state', LAMP_STATE[i],
    'column', x, z, 'lantern', (x - Math.sign(x) * OUTREACH).toFixed(2), LAMP_H, z,
    'foot', walkHeight(x, z).toFixed(3),
  );
}

const neon = buildNeon(lit, { open: 0, bar: 1, beer: 2 }, {
  red: rgb, open: rgb, green: rgb, sigRed: rgb, sigAmber: rgb, sigGreen: rgb,
});
console.log('neon triangles', neon.triangles, 'legend', neon.legend.join(' / '));
for (const s of neon.sources) {
  console.log('  ', s.note.padEnd(24), s.pos.map((v) => v.toFixed(2)).join(' '),
    'dir', s.dir.map((v) => v.toFixed(2)).join(' '), 'cd', s.cd);
}

/* Where the fabric is. Neither lit unit carries an awning — assignTypes claims
 * the awning units before it draws any other type — but the *neighbouring*
 * unit might, and a projecting sign at fascia level 3.7 m from a 1.4 m awning
 * is close enough to want checking rather than assuming. */
{
  const s = buildStreetLevel();
  const p = s.awning.getAttribute('position');
  const spans: [number, number][] = [];
  for (let i = 0; i < p.count; i++) {
    if (p.getX(i) < 0) continue;
    const z = p.getZ(i);
    const hit = spans.find((r) => z > r[0] - 1.6 && z < r[1] + 1.6);
    if (hit) { hit[0] = Math.min(hit[0], z); hit[1] = Math.max(hit[1], z); }
    else spans.push([z, z]);
  }
  console.log('east awnings, z spans',
    spans.map((r) => `${r[0].toFixed(1)}..${r[1].toFixed(1)}`).join(', '));
  s.dispose();
}

const { bldgs } = layoutBlock((x, z) => walkHeight(x, z));
outer:
for (const b of bldgs) {
  if (!b.street || b.frame.ox > 0) continue;
  for (const w of upperWindows(b)) {
    if (w.floor !== 1) continue;
    const uc = (w.u0 + w.u1) * 0.5;
    const z = b.frame.oz + b.frame.uz * uc;
    if (z > -18 || z < -46) continue;
    console.log('television at',
      (b.frame.ox + b.frame.ux * uc + b.frame.nx * b.d0).toFixed(2),
      ((w.y0 + w.y1) * 0.5).toFixed(2), z.toFixed(2),
      'opening', (w.u1 - w.u0).toFixed(2), 'x', (w.y1 - w.y0).toFixed(2));
    break outer;
  }
}
