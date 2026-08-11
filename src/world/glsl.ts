/* Shared GLSL noise.
 *
 * Two audiences use this string. The bakers in `bake.ts` render tiling PBR
 * maps with it, and those *must* wrap seamlessly, so every primitive here
 * takes an explicit lattice period and hashes the wrapped cell index rather
 * than the raw one. The road and pavement fragment shaders use the same
 * functions in world space, where wrapping is irrelevant and the period is
 * just set absurdly high.
 *
 * TILING CONTRACT: whenever a caller scales `p`, it must scale the period by
 * exactly the same factor. Get it wrong and the map looks fine on its own and
 * seams the instant it repeats.
 */

/* Canyon sky occlusion.
 *
 * `scene.environment` is one unoccluded probe, so every surface is lit by the
 * whole dome including the part behind the building standing eleven metres
 * opposite. That is not a small error at this hour and not a neutral one: the
 * horizon around the sun's azimuth is eleven times the brightness of the
 * horizon opposite, and a wall in a street can see almost none of it.
 *
 * tools/skyprobe.mjs cosine-integrates the same sky function twice — once over
 * the full hemisphere, once with the opposite parapet blocking everything below
 * the line to it — and the two disagree by a factor of eleven in level and
 * three in hue:
 *
 *   wall, unoccluded          E = 0.650 0.554 1.065   B/R 1.64
 *   wall in canyon, y = 1.5   E = 0.033 0.049 0.188   B/R 5.69
 *   wall in canyon, y = 8     E = 0.080 0.107 0.387   B/R 4.81
 *   wall in canyon, y = 20    E = 0.419 0.393 0.873   B/R 2.08
 *
 * Normalising out the level leaves a pure chromatic shift of
 * (0.585, 1.020, 2.028) at the base relaxing to white by twenty-five metres up.
 * That is a measurement, not a grade: a wall low in a street sees a slot of
 * zenith and the zenith is blue-violet.
 *
 * Shared from here because the walls and the paving they meet have to be filled
 * by the same sky. It previously existed as two byte-identical copies, one in
 * each material file, which is a latent bug: the next person to tune one of
 * them would have produced a visible seam along every wall/pavement junction.
 */
export const CANYON = /* glsl */ `
vec3 canyonSky(vec3 indirect, vec3 n, float y){
  float open = smoothstep(1.0, 26.0, y);
  // A horizontal deck sees the dome; a wall sees the slot.
  float up = max(n.y, 0.0);
  /* From 0.82. The next term below pushes the tint harder to get the blue-violet
   * back onto the facades, and the review is explicit that the paving in shade is
   * already right and must not move. Raising the exponent on the horizontal
   * suppression decouples the two: at 0.96 a level deck retains four per cent of
   * the tint rather than eighteen, so the extra push lands almost entirely on
   * vertical surfaces and the ground planes stay where they are. */
  float k = (1.0 - up * 0.96) * (1.0 - open);
  /* Pulled in from (0.585, 1.020, 2.028), a blue-to-red ratio of 3.47.
   *
   * That figure is the correct residual for a slot of pure sky and nothing
   * else, and it is too blue because "nothing else" is false: a wall low in this
   * canyon also sees the sunlit frontage eleven metres opposite, which at this
   * hour is a large warm secondary source. The masonry shader models that bounce
   * explicitly, but nothing else does, so every pale object in shade that is not
   * brickwork — an air-conditioner casing, painted joinery, galvanised
   * ductwork — came out a saturated primary blue that appears nowhere else in
   * the palette. Folding an approximate bounce into the tint is cheaper and less
   * error-prone than adding the term to four more shaders.
   *
   * Only trimmed, not halved. The first attempt took the ratio to 2.6 and
   * measured shaded brickwork back at 1.0 — neutral — because lifting the shade
   * also pushes it further up the AgX curve, which desaturates as it rolls off,
   * so the two changes compounded. Cool shade is the one thing in this scene
   * that must not regress, so the tint keeps almost all of its blue and the
   * air-conditioner casings stay bluer than ideal.
   *
   * Pushed back out to (0.510, 1.005, 2.320), B/R 4.55, above the measured 3.47.
   * Overshooting a measurement needs justifying. The measurement is of the light
   * arriving; what the review is reading is the pixel after AgX, and that
   * transform is not chroma-preserving — it desaturates progressively as values
   * climb its shoulder, and the exposure is now most of a stop higher than when
   * the 3.47 was set. So the shaded facades came out "muddy purple-grey" and
   * "brown-grey", which is the same "just less orange" failure the tint exists to
   * prevent, while the identical figure still worked on paving that sits lower on
   * the curve. Pre-compensating the input is the standard way to hit a target
   * appearance through a fixed output transform, and with the horizontal
   * suppression raised above it the extra blue cannot reach the ground planes the
   * review wants untouched. */
  vec3 tint = mix(vec3(1.0), vec3(0.510, 1.005, 2.320), k);

  /* The floor was 0.09 — the physical answer — and it is the reason the shaded
   * mass of a whole frontage was arriving as an unreadable near-black
   * silhouette. A camera exposing for shade does not show a 91 per cent loss of
   * fill, because its tone curve lifts the bottom two stops hard and because
   * the wall is also receiving bounce off the sunlit frontage opposite, which
   * this term does not model. 0.26 is what a phone puts there. */
  float lum = mix(1.0, 0.26 + 0.74 * pow(open, 1.15), k * 0.50);

  /* Sky light arrives from overhead, so within one shaded wall the horizontal
   * surfaces are the bright ones: the top of every sill, ledge, string course,
   * cornice and parapet coping reads clearly lighter than the wall beneath it.
   * That vertical structure is most of what stops shade reading as a flat fill,
   * and k alone does not deliver enough of it because a thin ledge is a few
   * pixels tall and needs the contrast to be unmissable. */
  /* From 0.62 to 2.60, and the reason is that the night lamps have gone.
   *
   * Fourteen unshadowed spotlights at 6.8 m were aimed down at the carriageway
   * and the footway, so almost all of what they delivered landed on horizontal
   * surfaces. Measured across their removal: the shaded footway fell from 0.231
   * to 0.075 while the shaded wall beside it moved from 0.111 to 0.110. Two
   * thirds of the light on the shaded ground was coming from a placeholder rig,
   * which is also why the ground in shade has read well for several rounds while
   * the walls in shade have not — the ground was being lit by something the
   * physical model did not contain, and the walls were being asked to survive on
   * the model alone.
   *
   * The fill that should be there is sky, and the sky is overhead, so it belongs
   * on exactly the surfaces the lamps were covering. Putting it here rather than
   * in the base level is what keeps the facades untouched: this term is
   * multiplied by max(n.y, 0), so a wall receives none of it and a paving slab
   * receives all of it. */
  lum *= 1.0 + up * 6.40 * (1.0 - open * 0.5);

  return indirect * tint * lum;
}
`;

export const NOISE = /* glsl */ `
/* Hashes.
 *
 * These replace a two-component hash of the common 'p += dot(p, p.yx + k)'
 * form, and the reason is a measured defect rather than a preference. That
 * construction adds the *same* scalar to both components, so x - y survives
 * the mixing step unchanged and neighbouring cells along a 45 degree diagonal
 * stay correlated. Rendered, it lays a faint woven cross-hatch over every
 * surface that consumes it — which here was every surface — and a reviewer
 * picked it out as a canvas-like undertone with a fixed pitch. Full jitter,
 * per-layer rotation and domain warping had all been tried against it and
 * none of them touched it, because the correlation is in the generator, not
 * in the point distribution.
 *
 * Going through three components with three unrelated multipliers breaks the
 * symmetry: no component of the output shares a linear relationship with the
 * input diagonal. Same cost, no lattice.
 */
float hash21(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
vec2 hash22(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.xx + p3.yz) * p3.zy);
}

float pnoise(vec2 p, vec2 per){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 i0 = mod(i, per);
  vec2 i1 = mod(i + 1.0, per);
  float a = hash21(i0);
  float b = hash21(vec2(i1.x, i0.y));
  float c = hash21(vec2(i0.x, i1.y));
  float d = hash21(i1);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 2.0 - 1.0;
}

float pfbm(vec2 p, vec2 per, int oct){
  float s = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 8; i++){
    if (i >= oct) break;
    s += a * pnoise(p, per);
    n += a;
    p *= 2.0; per *= 2.0; a *= 0.5;
  }
  return s / max(n, 1e-4);
}

/* x = distance to nearest feature point, y = distance to the second nearest.
 * y - x is the cell border, which is what cracks and aggregate edges are. */
vec2 pworley(vec2 p, vec2 per){
  vec2 i = floor(p), f = fract(p);
  float f1 = 9.0, f2 = 9.0;
  for (int y = -1; y <= 1; y++){
    for (int x = -1; x <= 1; x++){
      vec2 g = vec2(float(x), float(y));
      vec2 o = hash22(mod(i + g, per));
      float d = length(g + o - f);
      if (d < f1){ f2 = f1; f1 = d; }
      else if (d < f2){ f2 = d; }
    }
  }
  return vec2(f1, f2);
}

/* Cell id of the nearest feature point — used to give each aggregate stone,
 * each concrete slab and each asphalt patch its own tone. */
float pworleyId(vec2 p, vec2 per){
  vec2 i = floor(p), f = fract(p);
  float f1 = 9.0; vec2 best = vec2(0.0);
  for (int y = -1; y <= 1; y++){
    for (int x = -1; x <= 1; x++){
      vec2 g = vec2(float(x), float(y));
      vec2 c = mod(i + g, per);
      vec2 o = hash22(c);
      float d = length(g + o - f);
      if (d < f1){ f1 = d; best = c; }
    }
  }
  return hash21(best + 3.77);
}

/* Cell borders, with the jitter exposed and the owning cell reported.
 *
 * Two things the plain pworley above cannot express, both needed for cracking:
 *
 * Jitter, because a fully jittered Voronoi produces smoothly curving borders
 * and asphalt does not crack in curves. Fatigue and thermal cracking follows
 * the stiffest path and comes out angular, in straight runs meeting at hard
 * junctions. Dropping the feature-point jitter towards zero straightens the
 * borders without regimenting them into a grid.
 *
 * The owning cell, because the two sides of a real crack are not alike: one
 * has lifted and spalled into a pale chipped lip and the other has not.
 * Knowing which cell a fragment belongs to is what makes that asymmetry
 * expressible — the id flips across the border and nowhere else.
 *
 * Returns f1, f2 and a hash of the nearest cell.
 */
vec3 worleyEdge(vec2 p, vec2 per, float jit){
  vec2 i = floor(p), f = fract(p);
  float f1 = 9.0, f2 = 9.0; vec2 best = vec2(0.0);
  for (int y = -1; y <= 1; y++){
    for (int x = -1; x <= 1; x++){
      vec2 g = vec2(float(x), float(y));
      vec2 c = mod(i + g, per);
      vec2 o = mix(vec2(0.5), hash22(c), jit);
      float d = length(g + o - f);
      if (d < f1){ f2 = f1; f1 = d; best = c; }
      else if (d < f2){ f2 = d; }
    }
  }
  return vec3(f1, f2, hash21(best + 3.77));
}

/* Nearest feature point, reported in full.
 *
 * pworley gives distances and nothing else, which is enough to draw a blob and
 * not enough to shade a stone. To make a chipping read as a solid object you
 * need to know where its centre is relative to the fragment, because that
 * vector is what orients the shoulder: the surface falls away from the middle
 * of the stone towards its rim, so one side of every chip turns towards a
 * grazing lamp and the other turns away. Without it every chip lights
 * identically and you get an even stipple no matter how much size and tone
 * variation you author on top.
 *
 * Returns the nearest distance; reports the second distance, the cell hash and
 * the vector from the fragment to the feature point.
 */
float chipCell(vec2 p, vec2 per, out float f2, out float id, out vec2 rel){
  vec2 i = floor(p), f = fract(p);
  float f1 = 9.0; f2 = 9.0; vec2 best = vec2(0.0); rel = vec2(0.0);
  for (int y = -1; y <= 1; y++){
    for (int x = -1; x <= 1; x++){
      vec2 g = vec2(float(x), float(y));
      vec2 c = mod(i + g, per);
      vec2 d = g + hash22(c) - f;
      float l = length(d);
      if (l < f1){ f2 = f1; f1 = l; best = c; rel = d; }
      else if (l < f2){ f2 = l; }
    }
  }
  id = hash21(best + 3.77);
  return f1;
}

float unit(float x){ return x * 0.5 + 0.5; }
float sstep(float a, float b, float x){ return smoothstep(a, b, x); }
float contrast(float x, float k){
  x = clamp(x, 0.0, 1.0);
  return x <= 0.5 ? 0.5 * pow(2.0 * x, k) : 1.0 - 0.5 * pow(2.0 * (1.0 - x), k);
}

/* World-space convenience wrappers. The period is large enough that nothing
 * on this street ever reaches the wrap. */
#define WPER vec2(4096.0)
float wfbm(vec2 p, int oct){ return pfbm(p, WPER, oct); }
float wnoise(vec2 p){ return pnoise(p, WPER); }
vec2  wworley(vec2 p){ return pworley(p, WPER); }
float wworleyId(vec2 p){ return pworleyId(p, WPER); }
vec3  wedge(vec2 p, float jit){ return worleyEdge(p, WPER, jit); }
float wchip(vec2 p, out float f2, out float id, out vec2 rel){
  return chipCell(p, WPER, f2, id, rel);
}
`;
