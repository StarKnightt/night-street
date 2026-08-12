/* Turn two runs of the irradiance meter into the overlap claim, with the
 * instrument's own blind spot checked rather than assumed.
 *
 *   node tools/poolreport.mjs tmp/before.json tmp/after-pools.json
 *
 * ── The blind spot, found by disbelieving a number ────────────────────────
 *
 * The meter flies to 2 m above a point, looks down and reads the centre pixel
 * with `artificial()` mirrored out raw. That is only a reading of the lamps if
 * the surface under the camera is one of the five materials the mirror is
 * injected into. Where a prop, a bin, a bollard or a car is in the way the
 * camera reads *it* — shaded normally, because its material never heard of the
 * debug path — and the number comes back as a plausible small irradiance that
 * is actually a picture of a dark plastic lid.
 *
 * It showed up as E = 0.077 on the footway directly beneath a working lantern
 * where the arithmetic says 0.72, which is the only reason it was noticed. The
 * check is free: in grey mode a mirrored fragment leaves with r = g = b by
 * construction, and nothing else in the scene does. Any sample with chroma in
 * it is not a reading and is dropped.
 */
import fs from 'node:fs';
import { invert, display } from './agx.mjs';

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'));

/* The shaded carriageway and its diffuse transfer, both from NOTES.md's
 * "display response" section, so an irradiance can be quoted as the thing
 * anyone actually judges: how many code values it is worth. */
const SHADE_L = 0.038, XFER = 0.0322;
const codeOf = (L) => {
  // Bisect the shipped forward transform rather than interpolating a table.
  let lo = 0, hi = 255;
  for (let i = 0; i < 12; i++) {
    const mid = (lo + hi) / 2;
    if (invert(mid, { sensor: true }) < L) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
};
const BASE = codeOf(SHADE_L);

/* Is this pixel a neutral that came out of the grey mirror?
 *
 * The obvious test — all three channels within a count of each other — is
 * wrong, and wrong in a way that quietly threw away seventy per cent of the
 * first run's samples before anyone looked at the count. sensor.ts's pedestal
 * is deliberately not neutral: it adds (0.0040, 0.0046, 0.0070), lifted toward
 * blue on purpose, so a fragment that leaves the shader as a perfect grey
 * arrives on screen with blue several counts above red, and more so the darker
 * it is. Near the floor a true reading fails a chroma test outright.
 *
 * So the test is run the other way round. Solve for the neutral radiance that
 * would produce the observed green, push it back out through the whole shipped
 * transform including the pedestal, and require that all three channels come
 * back. A mirrored fragment passes at any level; a bin lid does not.
 */
function neutralL(c) {
  const L = invert(c[1], { sensor: true });
  const back = display([L, L, L], { sensor: true });
  const off = Math.max(...back.map((v, i) => Math.abs(v - c[i])));
  return off <= 2 ? L : null;
}

for (const f of files) {
  const j = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!j.pools) { console.log(`${f}: no pool data`); continue; }
  console.log(`\n══ ${f}`);
  for (const lane of ['centre', 'walkL', 'walkR']) {
    /* Restricted to the run of columns, z 12 to -99. Beyond the end lamp there
     * is no lantern and never was one; including that tail would let the report
     * claim a dark spot that is simply the end of the street. */
    const all = j.pools.rows.filter((r) => r.z <= 12 && r.z >= -99)
      .map((r) => ({ z: r.z, L: neutralL(r[lane]) }));
    const ok = all.filter((p) => p.L !== null);
    const dropped = all.length - ok.length;
    const v = ok.map((p) => ({ z: p.z, E: p.L }));
    const es = v.map((p) => p.E);
    const mx = Math.max(...es), mn = Math.min(...es);
    const atMin = v.find((p) => p.E === mn);
    const step = (E) => codeOf(SHADE_L + E * XFER) - BASE;
    console.log(`  ${lane.padEnd(7)} n=${ok.length}/${all.length}` +
      (dropped ? `  (${dropped} dropped: camera was over something that does not receive)` : '') +
      `\n            peak  E ${mx.toFixed(3)}  +${step(mx).toFixed(1)} counts on shaded carriageway` +
      `\n            floor E ${mn.toFixed(3)}  +${step(mn).toFixed(1)} counts   at z ${atMin.z}` +
      `\n            uniformity floor/peak ${(mn / mx).toFixed(3)}`);
    // The five worst metres, so a weak spot is named rather than averaged away.
    const worst = [...v].sort((a, b) => a.E - b.E).slice(0, 5);
    console.log(`            weakest metres: ${worst.map((p) => `z${p.z} ${p.E.toFixed(3)}`).join('  ')}`);
  }
}
