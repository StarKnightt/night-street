/* Tiling surface definitions.
 *
 * Each export is the body of a `surf()` as described in bake.ts. These carry
 * the *fine* detail only — grain, aggregate, chips, the things that live at a
 * few millimetres. Everything at the scale of the street itself (patch
 * repairs, wheel tracks, damp in the gutter, paint) is world-space and lives
 * in scene/materials.ts, because a 4 m tile cannot hold it without announcing
 * its period.
 *
 * Albedo values here are LINEAR reflectance and they are much darker than
 * instinct suggests. Fresh asphalt measures about 0.04, weathered about 0.12;
 * pavement concrete is 0.15–0.30. Authoring these at the "dark grey" a colour
 * picker suggests (0.25 linear) is the single fastest way to make a night
 * street look like a daytime render with the lights turned down.
 */

/* ── Asphalt ────────────────────────────────────────────────────────────────
 * Hot-mix asphalt is a graded aggregate — stones from about 2 mm to 14 mm —
 * suspended in a bitumen binder. What you see is the binder skin with the
 * larger stones showing through where traffic has polished it off, so the
 * surface reads as dark with a pepper of slightly paler, slightly smoother
 * points. It is never a uniform grey and it is never smooth.
 */
export const ASPHALT = /* glsl */ `
void surf(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao){
  /* Two metres across a 2048 tile: one millimetre a texel.
   *
   * This was four metres, and four metres is why the first pass read as salt
   * and pepper. A 10 mm chipping is five texels at 2 mm and cannot be anything
   * but a dot — there is no room in it for a top face, a rim and a shadowed
   * side, which are the three things that make a stone read as a stone. At one
   * millimetre a texel the same chipping is ten texels across and can actually
   * be a shape. The cost is that the tile repeats every two metres instead of
   * four, which the dual-scale blend and the world-space layers hide. */
  vec2 p = uv * 2.0;              // metres across one tile
  vec2 per = vec2(2.0);

  /* Sand matrix.
   *
   * The dominant read of asphalt close up is not stones, it is a dense,
   * directionless, sub-millimetre grain — the fine fraction and the sand that
   * fills between the coarse aggregate. It has to be high frequency and low
   * amplitude. The first version of this surface made the mistake of putting
   * the energy into the coarse layer instead, and the result was a field of
   * evenly spaced hemispheres that read as a rubber bath mat. */
  float sand = unit(pfbm(p * 46.0, per * 46.0, 3));
  float dust = unit(pfbm(p * 128.0, per * 128.0, 2));

  /* Coarse aggregate.
   *
   * Crushed stone, so the exposed part of a chipping is a FLAT FACET with a
   * hard edge, not a dome — a rounded stone is river gravel and belongs in
   * concrete, not in a wearing course. Hence the near-step falloff: the height
   * is a plateau across the cell interior and drops in a couple of texels at
   * the rim. Each cell gets its own radius so the population is graded, and
   * plenty of cells produce nothing at all. */
  vec2 aBig = pworley(p * 125.0, per * 125.0);     // 16 mm cells
  float idBig = pworleyId(p * 125.0, per * 125.0);
  float rBig = 0.20 + 0.26 * idBig;                // 6–15 mm chippings
  // A hard rim: the transition is a tenth of the cell, so about a millimetre,
  // which at 1 mm a texel is a genuine facet edge and not a gradient.
  float faceBig = sstep(rBig, rBig - 0.09, aBig.x);
  /* The contact shadow, and this is the single thing that decides whether a
   * chipping reads as a stone or as a bump.
   *
   * A chipping is not a hump in the binder, it is a hard object sitting *in*
   * it, and what tells the eye so is the thin dark line where the two meet:
   * the binder wets up the side of the stone, sits a fraction below its
   * shoulder, and never receives a grazing lamp because the stone is in the
   * way. Relief alone cannot supply this — a normal map has no idea what is
   * occluding what, so at a shallow angle every bump lights identically and
   * the surface comes out looking like pebbled rubber, which is exactly what
   * the previous pass produced. Drawn explicitly into the albedo and the
   * occlusion it costs nothing and the aggregate immediately sits down. */
  float bed = sstep(rBig + 0.13, rBig - 0.02, aBig.x) * (1.0 - faceBig);

  vec2 aMid = pworley(p * 260.0, per * 260.0);     // 7.7 mm cells
  float idMid = pworleyId(p * 260.0, per * 260.0);
  float rMid = 0.20 + 0.24 * idMid;
  float faceMid = sstep(rMid, rMid - 0.13, aMid.x);

  /* Where the binder skin has worn off. New asphalt is a black sheet with
   * almost no stone showing; it is traffic that scrubs the bitumen back and
   * exposes the aggregate, so exposure is patchy and correlated with wear
   * rather than uniform. Kept generous, because the previous value hid most of
   * the aggregate and left the fbm grain as the only thing visible. */
  float expose = 0.30 + 0.70 * sstep(0.30, 0.72, unit(pfbm(p * 1.4, per * 1.4, 4)));
  faceBig *= expose;
  faceMid *= 0.45 + 0.55 * expose;

  /* Sockets.
   *
   * When a chipping is plucked out — by a plough, by a stopping tyre, by frost
   * — it leaves a sharp-edged concave hole exactly its own size and shape, and
   * those holes are as characteristic of a worn wearing course as the stones
   * themselves. Reusing the same cells means a socket sits where a stone would
   * have been rather than floating between them. */
  float socket = sstep(rBig, rBig - 0.10, aBig.x) * step(0.895, fract(idBig * 5.31));

  // Air voids. A wearing course is 4–7% voids and they read as hard black
  // pinpricks that no amount of fbm will produce.
  vec2 av = pworley(p * 190.0, per * 190.0);
  float idV = pworleyId(p * 190.0, per * 190.0);
  float voids = sstep(0.075, 0.010, av.x) * step(0.42, idV);

  // Binder tone: broad, slow, and the thing that stops the surface reading flat.
  float mass = unit(pfbm(p * 0.9, per * 0.9, 4));

  /* Shrinkage cracking. Worley borders give a connected network rather than
   * the disconnected scratches an fbm threshold produces, and real thermal
   * cracking in asphalt is exactly a cell network. The width has to vary along
   * the run — a constant-width line is a drawn line, and that is what the
   * first pass looked like. */
  vec2 ck = pworley(p * 1.5, per * 1.5);
  float cw = 0.004 + 0.026 * unit(pfbm(p * 6.0, per * 6.0, 3));
  float crackRaw = 1.0 - sstep(0.0, cw, ck.y - ck.x);
  float crackMask = sstep(0.66, 0.96, unit(pfbm(p * 1.1, per * 1.1, 3)));
  float crack = crackRaw * crackMask;
  /* Spalled shoulder, and it is asymmetric on purpose.
   *
   * An open crack in asphalt does not have two matching edges. One side has
   * lifted and crumbled into a pale chipped lip of freshly broken aggregate,
   * the other is still intact. Making the halo one-sided — keyed off which
   * cell the fragment belongs to — is the difference between a crack and a
   * drawn line, and a drawn line is what the critic saw. */
  float lip = (1.0 - sstep(cw, cw * 3.4, ck.y - ck.x)) * crackMask
            * step(0.5, fract(pworleyId(p * 1.5, per * 1.5) * 7.7));
  float shoulder = (1.0 - sstep(0.0, cw * 3.2, ck.y - ck.x)) * crackMask;
  vec2 ck2 = pworley(p * 8.5, per * 8.5);
  float craze = (1.0 - sstep(0.0, 0.012, ck2.y - ck2.x)) * sstep(0.58, 0.88, mass);

  height =
      0.46
    + sand * 0.048 + dust * 0.018
    + faceBig * 0.230 + faceMid * 0.095
    - socket * 0.300
    + mass * 0.055
    + lip * 0.070
    - bed * 0.075
    - voids * 0.42
    - crack * 0.60 - shoulder * 0.10 - craze * 0.16;

  /* Palette. 'binder' is the oxidised bitumen skin, 'stone' is exposed
   * aggregate — a pale limestone and granite mix, still dark in absolute
   * terms but three or four times the binder — and the warm entry is the
   * fraction of chippings that are not grey at all. */
  /* Warm-black, not neutral. Oxidised bitumen is genuinely brown-black, and
   * putting that warmth in the albedo rather than borrowing it from the sodium
   * is what lets the concrete beside it be cool without the whole frame
   * collapsing onto one hue. */
  vec3 binder = vec3(0.0196, 0.0177, 0.0158);
  vec3 aged   = vec3(0.0438, 0.0408, 0.0378);
  vec3 stone  = vec3(0.1010, 0.0972, 0.0902);
  vec3 warmSt = vec3(0.0940, 0.0778, 0.0620);
  vec3 darkSt = vec3(0.0350, 0.0345, 0.0356);

  albedo = mix(binder, aged, contrast(mass, 1.3));
  albedo *= 0.90 + 0.18 * sand;
  albedo *= 0.96 + 0.08 * dust;
  /* Per-stone value is the point. A quarry product is a mixture — pale
   * limestone next to near-black basalt next to a rusty one — and a stone
   * population that shares one colour reads as pepper on a sheet however good
   * its shape is. */
  vec3 chip = mix(mix(darkSt, stone, sstep(0.15, 0.85, idBig)), warmSt, step(0.80, idBig));
  albedo = mix(albedo, chip * (0.55 + 0.95 * fract(idBig * 7.3)), faceBig * 0.98);
  // The binder banked up against the stone, in its shadow.
  albedo = mix(albedo, vec3(0.0104, 0.0094, 0.0086), bed * 0.80);
  vec3 chipM = mix(darkSt, stone, sstep(0.25, 0.9, idMid));
  albedo = mix(albedo, chipM * (0.70 + 0.55 * fract(idMid * 11.7)), faceMid * 0.62);
  // A socket exposes the unweathered binder the stone was bedded in, and it is
  // in shadow, so it goes darker than anything around it.
  albedo = mix(albedo, vec3(0.0092, 0.0084, 0.0076), socket * 0.88);
  // Freshly broken rock along a crack lip is much paler than a weathered face.
  albedo = mix(albedo, stone * 1.25, lip * 0.55);
  // Voids and cracks are shadow, not a darker grey.
  albedo = mix(albedo, vec3(0.0075, 0.0074, 0.0074), max(voids, crack) * 0.92);
  albedo = mix(albedo, albedo * 0.72, max(craze * 0.6, shoulder * 0.35));

  /* Roughness. Exposed stone is polished by tyres and is markedly smoother
   * than the binder around it; that contrast at the millimetre scale is what
   * gives asphalt its characteristic dull sparkle under a street lamp. The
   * absolute level is set world-space in materials.ts — this only carries the
   * relative structure. */
  rough = mix(0.95, 0.84, sand);
  rough = mix(rough, 0.38, faceBig * 0.92);
  rough = mix(rough, 0.55, faceMid * 0.6);
  rough = mix(rough, 0.99, max(crack, shoulder * 0.7));
  rough = mix(rough, 0.99, socket * 0.9);
  rough = mix(rough, 0.97, lip * 0.8);
  rough = mix(rough, 0.99, bed * 0.7);

  ao = 1.0 - (1.0 - clamp(height, 0.0, 1.0)) * 0.60 - crack * 0.30 - voids * 0.4
     - socket * 0.35 - bed * 0.45;
}
`;

/* ── Pavement concrete ──────────────────────────────────────────────────────
 * A poured sidewalk flag: a float-finished cement skin with sand showing
 * through where it has worn, spalled corners, and the fine map-cracking that
 * every slab develops. The joints and the per-slab tone are world-space and
 * live in materials.ts — this is only the material within one flag.
 */
export const CONCRETE = /* glsl */ `
void surf(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao){
  vec2 p = uv * 1.8;
  vec2 per = vec2(1.8);

  float mass  = unit(pfbm(p * 1.1, per * 1.1, 4));

  /* Concrete is not asphalt in a lighter tint, and that is exactly what it had
   * become. Both surfaces carried the same grain at the same scale, so a
   * reviewer asked to desaturate the frame could only find the kerb by its
   * highlight — two materials distinguished by brightness alone are one
   * material.
   *
   * The separation is in the *finish*, not the tone. A footway flag is a
   * cement-and-sand mortar screed floated flat with a steel trowel: the coarse
   * aggregate is buried and never sees daylight, so the surface is much finer
   * and much tighter than a road, its texture is the swirl the float left and
   * the drag of a broom across it, and what shows through where it has worn is
   * sand at half a millimetre, not chippings at ten. The defects are its own
   * too: entrained air voids that surfaced as small round holes, and popouts
   * where a bad piece of aggregate under the skin has frozen and blown a
   * shallow crater.
   */
  float sand   = unit(pfbm(p * 210.0, per * 210.0, 3));       // 0.5 mm, not 5
  float floatSwirl = unit(pfbm(vec2(p.x * 3.2 + pfbm(p * 2.0, per * 2.0, 2) * 1.4,
                                    p.y * 3.2), vec2(per.x * 3.2, per.y * 3.2), 3));
  /* Broom drag: parallel corduroy at right angles to the direction of walk,
   * a couple of millimetres apart, and the single most recognisable thing
   * about a concrete footway. */
  float broom = unit(pfbm(vec2(p.x * 1.5, p.y * 150.0), vec2(per.x * 1.5, per.y * 150.0), 2));
  float broomAmt = sstep(0.30, 0.70, unit(pfbm(p * 0.7, per * 0.7, 3)));

  // Entrained air: small round holes that surfaced in the float.
  vec2 av = pworley(p * 85.0, per * 85.0);
  float airId = pworleyId(p * 85.0, per * 85.0);
  float air = sstep(0.10, 0.02, av.x) * step(0.55, airId);

  // Exposed sand where the cement skin has polished off.
  vec2 ag = pworley(p * 150.0, per * 150.0);
  float grain = sstep(0.26, 0.06, ag.x) * sstep(0.45, 0.80, mass);

  // Popouts: shallow craters where a bad stone under the skin has blown.
  vec2 pit = pworley(p * 11.0, per * 11.0);
  float pitId = pworleyId(p * 11.0, per * 11.0);
  float pits = sstep(0.13, 0.03, pit.x) * step(0.86, pitId);

  // Map cracking: a fine polygonal network, sparse and clustered.
  vec2 mc = pworley(p * 3.4, per * 3.4);
  float mapCrack = (1.0 - sstep(0.0, 0.022, mc.y - mc.x))
                 * sstep(0.52, 0.80, unit(pfbm(p * 0.8, per * 0.8, 3)));

  height = 0.55 + sand * 0.030 + floatSwirl * 0.05
         + (broom - 0.5) * 0.22 * broomAmt
         + grain * 0.045 - air * 0.55 - pits * 0.40 - mapCrack * 0.5;

  /* Cool and chalky, and this is a deliberate divergence from the asphalt.
   *
   * Portland cement is genuinely blue-grey; it only photographs warm when a
   * sodium lamp is the only thing lighting it. Authoring both the road and the
   * footway warm meant the light had nothing to reveal, and the whole frame
   * collapsed onto a single brown ramp where the only difference between the
   * two materials was how much of it there was. Held cool here, the sodium
   * warms it and the asphalt at different rates and the kerb line separates on
   * hue as well as value — which is what actually reads as two materials. */
  vec3 pale  = vec3(0.1770, 0.1830, 0.1930);
  vec3 mid   = vec3(0.1080, 0.1115, 0.1185);
  vec3 dirty = vec3(0.0530, 0.0534, 0.0560);

  albedo = mix(mid, pale, contrast(mass, 1.25));
  albedo = mix(albedo, dirty, sstep(0.42, 0.86, floatSwirl) * 0.5);
  albedo *= 0.94 + 0.12 * sand;
  albedo *= mix(1.0, 0.90 + 0.20 * broom, broomAmt);
  albedo = mix(albedo, pale * 1.18, grain * 0.35);
  albedo = mix(albedo, vec3(0.0300, 0.0305, 0.0320), max(pits, mapCrack) * 0.85);
  albedo = mix(albedo, vec3(0.0180, 0.0184, 0.0196), air * 0.9);

  /* Near-matte, and much rougher than the road at every point.
   *
   * Concrete is an open, porous, chalky surface: it has essentially no
   * specular lobe to speak of, and the contrast between that and the road's
   * polished, part-damp sheen is the strongest material cue available at
   * night. The previous 0.80–0.93 was low enough that the footway picked up
   * the same highlights as the carriageway. */
  rough = mix(0.985, 0.940, mass);
  rough = mix(rough, 0.998, grain * 0.7);
  rough = mix(rough, 0.995, air * 0.8);
  rough = mix(rough, 0.93, sstep(0.5, 0.9, floatSwirl) * 0.35);

  ao = 1.0 - (1.0 - clamp(height, 0.0, 1.0)) * 0.7 - mapCrack * 0.3;
}
`;

/* ── Granite kerb ───────────────────────────────────────────────────────────
 * Kerbs in older cities are cut granite blocks, not cast concrete: coarsely
 * flame-finished on the face, worn smooth and slightly polished along the top
 * arris where a century of feet and tyres have touched it. The top-edge polish
 * is applied world-space; this is the stone.
 */
export const GRANITE = /* glsl */ `
void surf(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao){
  vec2 p = uv * 2.0;
  vec2 per = vec2(2.0);

  // Feldspar / quartz / mica speckle at three scales.
  vec2 g1 = pworley(p * 30.0, per * 30.0);
  vec2 g2 = pworley(p * 70.0, per * 70.0);
  float id1 = pworleyId(p * 30.0, per * 30.0);
  float c1 = sstep(0.30, 0.04, g1.x);
  float c2 = sstep(0.34, 0.06, g2.x);

  // Flame-finish chatter: shallow parallel scallops from the cutting head.
  float chatter = unit(pfbm(vec2(p.x * 2.0, p.y * 22.0), vec2(per.x * 2.0, per.y * 22.0), 3));
  float mass = unit(pfbm(p * 1.6, per * 1.6, 4));

  height = 0.5 + chatter * 0.22 + c1 * 0.14 + c2 * 0.07 + mass * 0.10;

  vec3 base  = vec3(0.0930, 0.0930, 0.0960);
  vec3 light = vec3(0.1900, 0.1880, 0.1860);
  vec3 dark  = vec3(0.0380, 0.0380, 0.0410);

  albedo = mix(base, light, contrast(mass, 1.3) * 0.7);
  albedo = mix(albedo, light * (0.5 + id1), c1 * 0.6);
  albedo = mix(albedo, dark, c2 * 0.45);
  albedo *= 0.85 + 0.28 * chatter;

  rough = mix(0.86, 0.62, c1 * 0.7);
  rough = mix(rough, 0.90, chatter * 0.3);
  ao = 1.0 - (1.0 - clamp(height, 0.0, 1.0)) * 0.5;
}
`;

/* ── Cast iron ──────────────────────────────────────────────────────────────
 * Manhole covers, grate frames and utility plates. Old cast iron in a street
 * is not black: it is a rusted, oil-soaked, tyre-polished mid-grey that is
 * far shinier than anything around it, which is precisely why these read as
 * metal at night while the road does not.
 */
export const CAST_IRON = /* glsl */ `
void surf(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao){
  vec2 p = uv * 1.0;
  vec2 per = vec2(1.0);

  float pitFbm = unit(pfbm(p * 30.0, per * 30.0, 4));
  vec2 pit = pworley(p * 26.0, per * 26.0);
  float pits = sstep(0.14, 0.0, pit.x);
  float rust = sstep(0.48, 0.85, unit(pfbm(p * 5.0, per * 5.0, 4)));
  float wear = unit(pfbm(p * 2.0, per * 2.0, 3));

  height = 0.6 + pitFbm * 0.16 - pits * 0.5;

  vec3 iron   = vec3(0.1150, 0.1130, 0.1110);
  vec3 polish = vec3(0.3400, 0.3320, 0.3220);
  vec3 rustC  = vec3(0.1450, 0.0760, 0.0400);

  albedo = mix(iron, polish, contrast(wear, 1.5) * 0.85);
  albedo = mix(albedo, rustC, rust * 0.55);
  albedo *= 0.86 + 0.26 * pitFbm;

  // Tyre-polished iron gets genuinely smooth; the rusted parts do not.
  rough = mix(0.44, 0.24, contrast(wear, 1.6));
  rough = mix(rough, 0.86, rust * 0.8);
  rough = mix(rough, 0.80, pits * 0.7);
  ao = 1.0 - (1.0 - clamp(height, 0.0, 1.0)) * 0.6;
}
`;

/* ── Manhole cover face ─────────────────────────────────────────────────────
 * Non-tiling: uv 0..1 is the whole disc. A standard municipal cover is a
 * radial waffle of raised bosses inside a plain rim band, with two pick holes
 * and a rectangular keyway. The bosses are what make it legible at a glance
 * even when it is nearly black — they catch a lamp along one edge each.
 */
export const MANHOLE = /* glsl */ `
void surf(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao){
  vec2 c = uv * 2.0 - 1.0;
  float r = length(c);
  float th = atan(c.y, c.x);

  // Base iron, borrowed from the cast-iron recipe at a tighter scale.
  vec2 p = uv * 1.6, per = vec2(1.6);
  float pitFbm = unit(pfbm(p * 26.0, per * 26.0, 4));
  vec2 pit = pworley(p * 24.0, per * 24.0);
  float pits = sstep(0.16, 0.0, pit.x);
  float rust = sstep(0.52, 0.88, unit(pfbm(p * 4.0, per * 4.0, 4)));
  float wear = unit(pfbm(p * 1.6, per * 1.6, 3));

  /* The waffle. Rings times spokes gives square bosses whose count grows with
   * radius, which is how these are actually cast — a constant spoke count
   * produces wedges that get absurdly wide at the rim. */
  float rings = 9.0;
  float ringPhase = fract(r * rings);
  float spokes = floor(6.0 + r * 26.0);
  float spokePhase = fract(th / (6.28318) * spokes + 0.5);
  float boss = sstep(0.16, 0.30, ringPhase) * sstep(0.84, 0.70, ringPhase)
             * sstep(0.16, 0.30, spokePhase) * sstep(0.84, 0.70, spokePhase);
  boss *= sstep(0.30, 0.34, r) * sstep(0.80, 0.76, r);

  /* Plain rim band, then the frame, then the seat.
   *
   * A cover was reported as reading like a circle drawn on the road: right
   * tone, no thickness, no sense that the carriageway had been cut open and
   * something heavy dropped into the hole. What was missing is the step. A
   * casting is 40-60mm of iron sitting inside a separate frame, and what makes
   * it read as an object at a distance is not the pattern on top but the dark
   * ring of shadow around it where the cover face drops away from the road. */
  float rim   = sstep(0.80, 0.83, r);
  float bevel = sstep(0.88, 0.94, r);                  // cover edge falls away
  float frame = sstep(0.94, 0.955, r) * sstep(1.0, 0.985, r);
  float seat  = sstep(0.885, 0.925, r) * sstep(0.960, 0.935, r);

  // Two pick holes on the centre line, and a small keyway slot.
  float hole = min(length(c - vec2(0.42, 0.0)), length(c + vec2(0.42, 0.0)));
  float picks = sstep(0.075, 0.045, hole);
  float key = sstep(0.055, 0.03, abs(c.y)) * sstep(0.16, 0.13, abs(c.x));

  height = 0.55 + pitFbm * 0.10 + boss * 0.42 - bevel * 0.55
         - picks * 0.9 - key * 0.7 - pits * 0.35;
  height = mix(height, 0.62, rim * (1.0 - bevel) * 0.6);
  height = mix(height, 0.14, seat * 0.9);              // the gap it sits in
  height = mix(height, 0.70, frame * 0.85);            // frame stands proud

  /* Darker and browner than the asphalt it sits in, which is the way round it
   * actually is: a cover was read as a pale ellipse lighter than the road,
   * and cast iron under a century of rust and oil is neither pale nor grey.
   * Only the boss tops are allowed to be bright, because only the boss tops
   * are touched. */
  /* Cast iron in daylight.
   *
   * These values were set against a sodium lamp at night, where the casting
   * only ever caught a fraction of one source. In sunlight the same numbers
   * put the cover at roughly the tone of the asphalt around it, and it read as
   * a pale ring painted on the road — the opposite of what it should be. Cast
   * iron under a century of rust and traffic film is one of the darkest things
   * on a street at any hour, and darker than bitumen. */
  vec3 iron   = vec3(0.0255, 0.0222, 0.0198);
  vec3 polish = vec3(0.1450, 0.1360, 0.1240);
  vec3 rustC  = vec3(0.0620, 0.0318, 0.0166);

  // Tyres only ever touch the tops of the bosses, so that is where the polish
  // is, and that correlation is the whole reason the pattern reads.
  albedo = mix(iron, polish, contrast(wear, 1.4) * (0.35 + 0.65 * boss));
  albedo = mix(albedo, rustC, rust * 0.5 * (1.0 - boss * 0.6));
  albedo = mix(albedo, vec3(0.0020), max(picks, key) * 0.98);
  // Grime packed into every recess between the bosses.
  albedo = mix(albedo, albedo * 0.42, (1.0 - boss) * sstep(0.34, 0.78, r) * 0.65);
  /* The seating gap. Grit, tar and shadow, and it has to be among the darkest
   * values on the road or the casting keeps reading as a decal. */
  albedo = mix(albedo, vec3(0.0035, 0.0032, 0.0030), seat * 0.95);
  albedo = mix(albedo, vec3(0.0330, 0.0286, 0.0250), frame * 0.75);
  albedo *= 0.85 + 0.28 * pitFbm;

  rough = mix(0.62, 0.22, boss * contrast(wear, 1.4));
  rough = mix(rough, 0.88, rust * 0.7);
  rough = mix(rough, 0.95, max(picks, key));
  rough = mix(rough, 0.99, seat * 0.9);
  ao = 1.0 - (1.0 - clamp(height, 0.0, 1.0)) * 0.75;
  ao *= 1.0 - seat * 0.80;
}
`;

/* ── Diamond tread plate ────────────────────────────────────────────────────
 * The steel utility plate. Raised lozenges in alternating pairs — the pattern
 * is instantly recognisable and it gives the plate a directional sparkle that
 * separates it from the matte paving around it.
 */
export const TREAD = /* glsl */ `
void surf(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao){
  vec2 p = uv * 1.0, per = vec2(1.0);
  vec2 cell = p * 7.0;
  vec2 ci = floor(cell), cf = fract(cell) - 0.5;
  // Alternate the lozenge angle row by row.
  float flip = mod(ci.x + ci.y, 2.0) * 2.0 - 1.0;
  float a = 0.55 * flip;
  vec2 rp = vec2(cf.x * cos(a) - cf.y * sin(a), cf.x * sin(a) + cf.y * cos(a));
  float lozenge = sstep(0.30, 0.16, abs(rp.x) * 0.34 + abs(rp.y) * 1.35);

  float grime = sstep(0.38, 0.84, unit(pfbm(p * 5.0, per * 5.0, 4)));
  float scuff = unit(pfbm(vec2(p.x * 20.0, p.y * 2.0), vec2(per.x * 20.0, per.y * 2.0), 3));

  height = 0.35 + lozenge * 0.55 + scuff * 0.06;
  vec3 steel = vec3(0.4200, 0.4230, 0.4300);
  albedo = steel * (0.55 + 0.65 * lozenge) * (0.82 + 0.3 * scuff);
  albedo = mix(albedo, vec3(0.0620, 0.0430, 0.0300), grime * 0.7);
  rough = mix(0.72, 0.30, lozenge);
  rough = mix(rough, 0.88, grime * 0.8);
  ao = 1.0 - (1.0 - clamp(height, 0.0, 1.0)) * 0.65;
}
`;

/* ── Galvanised steel ───────────────────────────────────────────────────────
 * The drain grate bars. Zinc coating, spangled, dulled and blackened by road
 * grime along the bottom where standing water sits.
 */
export const STEEL = /* glsl */ `
void surf(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao){
  vec2 p = uv * 1.0;
  vec2 per = vec2(1.0);
  float spangle = unit(pfbm(p * 18.0, per * 18.0, 3));
  vec2 sp = pworley(p * 9.0, per * 9.0);
  float facets = sstep(0.24, 0.04, sp.y - sp.x);
  float grime = sstep(0.40, 0.82, unit(pfbm(p * 3.0, per * 3.0, 4)));

  height = 0.6 + spangle * 0.14 - facets * 0.10;
  vec3 zinc = vec3(0.4400, 0.4460, 0.4600);
  albedo = zinc * (0.72 + 0.5 * spangle);
  albedo = mix(albedo, vec3(0.0280, 0.0270, 0.0260), grime * 0.75);
  rough = mix(0.36, 0.60, spangle);
  rough = mix(rough, 0.88, grime * 0.85);
  ao = 1.0 - (1.0 - clamp(height, 0.0, 1.0)) * 0.4;
}
`;

/* ── Gully grate ────────────────────────────────────────────────────────────
 * The whole casting on one non-tiling map: frame, bars and the slots between
 * them. The slots used to be modelled as gaps between nine separate box
 * primitives and that is what produced the sawtooth comb in the first capture
 * set — two-pixel triangles at five metres have no mip chain and nothing to
 * filter with. Drawn into a texture instead they anisotropically filter down
 * to a clean dark band like everything else on the ground.
 *
 * The uv covers the 600 x 960 mm top face, v along the street.
 */
export const GULLY = /* glsl */ `
void surf(vec2 uv, out vec3 albedo, out float height, out float rough, out float ao){
  vec2 p = uv * vec2(0.60, 0.96);            // metres
  vec2 per = vec2(0.60, 0.96);

  float pit = unit(pfbm(p * 90.0, per * 90.0, 3));
  float rust = sstep(0.48, 0.86, unit(pfbm(p * 22.0, per * 22.0, 4)));

  // Frame: 55 mm all round, standing above the bars.
  float inU = sstep(0.050, 0.062, min(p.x, 0.60 - p.x));
  float inV = sstep(0.050, 0.062, min(p.y, 0.96 - p.y));
  float inner = inU * inV;

  /* Slots. Nine of them, and the pitch wanders by a millimetre or two because
   * a sand-cast iron grate is not a machined part. */
  float sv = (p.y - 0.055) / (0.96 - 0.110);
  float slotPhase = fract(sv * 9.0);
  float slotWob = pfbm(vec2(p.x * 3.0, 1.0), vec2(per.x * 3.0, 1.0), 2) * 0.05;
  float sd = abs(slotPhase - 0.5 + slotWob);
  float slot = (1.0 - sstep(0.30, 0.40, sd)) * inner;
  // The ends of the slots stop short of the frame.
  float ends = sstep(0.055, 0.075, min(p.x, 0.60 - p.x));
  slot *= ends;

  /* The bar top is *rounded*, and that turns out to matter more than anything
   * else here.
   *
   * The first version of this cut the slots as a near-vertical step in the
   * height field and gave the flat bar tops a hard polish threshold. Seen from
   * eye level down a street the grate is a hundred pixels of almost pure
   * grazing incidence, so every bar presented a full-height wall normal and a
   * flat mirror on top, and the whole casting rendered as a row of bright
   * regular teeth — a comb lying in the gutter rather than an iron grate. The
   * defect was legible from across the frame.
   *
   * A sand-cast gully bar is 20 mm wide with a worn convex crown, so the
   * specular it returns at grazing incidence is a thin soft line down the
   * middle of each bar and not a blazing facet. Rounding the crown, and
   * letting the slot walls fall away over several texels instead of one,
   * removes the aliasing at source rather than blurring it afterwards.
   */
  float crown = 1.0 - smoothstep(0.30, 0.62, sd);   // 1 at bar centre, 0 at edge
  float bar = inner * (1.0 - slot) * ends;
  float wall = sstep(0.40, 0.30, sd) * sstep(0.24, 0.34, sd);   // the flank only

  float polish = bar * crown
               * sstep(0.30, 0.80, unit(pfbm(vec2(p.x * 7.0, p.y * 1.4),
                                             vec2(per.x * 7.0, per.y * 1.4), 3)));

  /* Depth lives in the albedo and the occlusion, not in the normal. The hole
   * genuinely is a hole — the casting is modelled with a sump box behind it —
   * so the normal map has no work to do here and every millimetre of relief it
   * adds is another grazing-angle highlight that should not exist. */
  height = 0.62 + (1.0 - inner) * 0.20 + pit * 0.05
         - slot * 0.30 - wall * 0.06 + crown * bar * 0.05;

  /* Rusty-brown, not neutral grey. A gully frame sits in standing water for
   * its whole life and it is the rustiest object on the street; giving it a
   * genuine hue rather than a value is what will let it separate from the
   * asphalt once there is more than one colour of light in the scene. */
  /* Values pulled well down.
   *
   * The previous set rendered as a small bright gold hatch, brighter than the
   * asphalt around it and brighter than the road markings, which is upside
   * down: wet rusted iron in a gutter is close to the darkest object in a
   * night street, and anything that reads as a glowing sticker in the kerb
   * line destroys the shot. The polished value in particular was doing damage
   * — a gully bar is worn by grit and standing water, not burnished, so its
   * highlight should come from a low roughness catching a lamp, not from a
   * high albedo that glows whether it is lit or not. */
  vec3 iron   = vec3(0.0165, 0.0142, 0.0124);
  vec3 shined = vec3(0.0420, 0.0396, 0.0368);
  vec3 rustC  = vec3(0.0395, 0.0205, 0.0112);

  albedo = iron * (0.82 + 0.32 * pit);
  albedo = mix(albedo, rustC, rust * 0.70 * (1.0 - polish * 0.8));
  albedo = mix(albedo, shined, polish * 0.55);
  /* Down the slot there is nothing. Not a dark grey — a hole into a sump,
   * which returns no light at all, and a grate whose openings are anything
   * other than black reads as a printed ladder lying on the kerb. */
  albedo = mix(albedo, vec3(0.0012, 0.0011, 0.0010), slot * 0.995);

  rough = mix(0.74, 0.62, pit);
  rough = mix(rough, 0.44, polish * 0.80);
  rough = mix(rough, 0.94, rust * 0.7);
  rough = mix(rough, 0.99, slot * 0.9);

  ao = 1.0 - (1.0 - clamp(height, 0.0, 1.0)) * 0.55 - slot * 0.97;
}
`;
