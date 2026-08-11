/* World-space material layers.
 *
 * The baked sets in world/surfaces.ts carry millimetre detail on a 3–4 m tile.
 * Everything larger than a tile has to be applied here, in world coordinates,
 * for two reasons. The obvious one is that a 4 m tile repeats eleven times
 * across a frame and the eye finds the period instantly unless something
 * non-repeating is laid over it. The less obvious one is that the large-scale
 * structure of a real road is *located*: the wheel tracks are where the wheels
 * go, the oil is where cars park, the water is in the gutter and in the
 * hollows, the paint is on the centreline. None of that is expressible as a
 * tile, and faking it with more noise is what makes procedural roads look
 * like carpet.
 *
 * The single most important thing in this file is the roughness. At night
 * almost nothing about a road is read from its albedo — it is nearly black
 * either way. What tells you it is asphalt, that it is damp, where the crown
 * is and how far away the lamp is, is the shape of the specular response, and
 * that is spatially varying roughness on a surface that actually tilts.
 */
import * as THREE from 'three';
import { NOISE, CANYON } from '@/world/glsl';
import type { SurfaceSet } from '@/world/bake';
import { SUN_DIR } from './env';
import { hazeFogVertex } from './haze';
import { DIMS } from '@/world/dims';
import { ARTIFICIAL, artificialAdd, artificialUniforms } from './lights';

/* System 5 arrives on the paving here.
 *
 * The three ground materials are the principal receivers of everything
 * artificial in the street — the lamp pools, the two shopfront spills, the
 * car's sidelights — and they receive it as an analytic term rather than from
 * a `Light`, for the reason set out at the top of scene/lights.ts. Appended
 * after each material's own lighting hook so that none of the signed-off
 * behaviour above moves: the sun, the sky and the bounce terms all resolve
 * exactly as they did, and this adds to the result.
 *
 * The geometric normal is used rather than the shaded one. At 4.2 degrees the
 * aggregate and screed normals swing N.L sevenfold between adjacent pixels,
 * and a source at a few per cent of the sun modulated by that reads as
 * speckle; the pools are metre-scale features and want a metre-scale normal.
 */
const ARTIFICIAL_ADD = artificialAdd('vWNormal');

function tile(set: SurfaceSet, metresPerTile = set.patch) {
  const r = 1 / metresPerTile;
  for (const t of [set.map, set.normalMap, set.ormMap]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(r, r);
    t.needsUpdate = true;
  }
}

/* Attach the baked maps in the ORM packing.
 *
 * `metalness` and `ao` are deliberately NOT bound for the paving. Three
 * allocates a texture unit per uniform rather than per texture, so binding the
 * same ORM map into three slots costs three of the sixteen units the fragment
 * stage has — and with six projected lamp cookies and four shadow maps in the
 * scene, that overflow is not theoretical: it took the whole street out with a
 * MAX_TEXTURE_IMAGE_UNITS link failure. Neither map earns its slot here. The
 * paving is entirely dielectric, so metalness is a constant zero, and the
 * baked occlusion is millimetre-scale detail already carried by the normal map
 * under lighting this soft.
 */
/* The lamps are gone, so the budget that forced this is gone with them. The
 * occlusion map is bound again; metalness still is not, because the reasoning
 * about that one was never about units — paving is dielectric and the constant
 * zero is correct. Restoring aoMap also removes a duplication: gChipAO exists to
 * recompute in the shader an occlusion the bake already had. */
/* Coefficient and ceiling for the road's specular antialiasing.
 *
 * A uniform rather than a literal so that the walk-difference harness can
 * measure several strengths in one browser session. Widening a specular lobe
 * is the one correction in this material that trades a real thing for a real
 * thing — sparkle for glitter — so the setting has to be chosen against
 * numbers from both sides of that trade rather than by eye. */
export function specAAFromUrl(): THREE.Vector2 {
  const d = new THREE.Vector2(2.2, 0.28);
  if (typeof location === 'undefined') return d;
  const m = /[?&]saa=([\d.]+),([\d.]+)/.exec(location.search);
  return m ? new THREE.Vector2(+m[1], +m[2]) : d;
}

function applySet(m: THREE.MeshStandardMaterial, set: SurfaceSet) {
  m.map = set.map;
  m.normalMap = set.normalMap;
  m.roughnessMap = set.ormMap;
  m.aoMap = set.ormMap;
}

const WORLD_VARYINGS = /* glsl */ `
varying vec3 vWPos;
varying vec3 vWNormal;
`;

const VERTEX_HOOK = /* glsl */ `
#include <begin_vertex>
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWNormal = normalize(mat3(modelMatrix) * objectNormal);
`;

/* ── Road ───────────────────────────────────────────────────────────────── */

const ROAD_FRAG_HEAD = /* glsl */ `
${WORLD_VARYINGS}
varying float vSettle;
uniform float uRoadHalf;

/* Carried between the two injection points.
 *
 * The roughness hook runs before the normal hook in the standard fragment
 * shader, and each is injected as its own braced block, so anything the normal
 * hook needs from the surface evaluation has to survive at file scope. The
 * alternative is evaluating the damp field twice, which is four octaves of fbm
 * for nothing. */
float gDamp = 0.0;
float gPool = 0.0;
float gPatchH = 0.0;
vec2  gChipN = vec2(0.0);
/* Variance of the shading normal inside one pixel that no derivative can
 * measure, accumulated by the surface evaluation that creates it and spent by
 * the normal hook. dFdx of the normal recovers the variation *between*
 * neighbouring samples, which is the right estimator for a feature a few
 * pixels wide and worthless for one that is a fifth of a pixel wide — there it
 * returns a random draw whose expectation is the variance but whose value, per
 * pixel, per frame, is noise. The chip loop knows the amplitude and the width
 * of the feature it is declining to draw, so it can state the answer instead
 * of having it estimated. */
float gNVar = 0.0;
uniform vec2 uSunXZ;
float gPaint = 0.0;
/* Strength and ceiling of the derivative-based lobe widening, as a uniform so
 * that a walk can be measured at several settings in one browser session
 * rather than one per rebuild. The shipped value is the pair that was signed
 * off; ?saa=c,k overrides it. */
uniform vec2 uSpecAA;
/* Sky occlusion between the chippings.
 *
 * The other half of the aggregate report was that the shaded carriageway has no
 * visible aggregate at all — a smooth dark plane — while the sunlit foreground
 * had too much. Both are the same omission. Everything that made a chip read
 * was direct-light shading: the tilted facet, the hard terminator on the flank
 * away from the sun. In shade there is no direct light for any of that to
 * modulate, so the entire field collapses and only the albedo spread survives,
 * which at a tenth of a stop above black is below the eye's threshold.
 *
 * What actually reveals aggregate in shade is that the bitumen down between two
 * stones can only see a sliver of sky, while the proud faces see all of it. That
 * is occlusion of the indirect term, it is completely independent of where the
 * sun is, and it was simply not being computed. */
float gChipAO = 1.0;

/* Occlusion of the *sun* between the chippings, which is the other half and the
 * one that sets the colour.
 *
 * gChipAO above is occlusion of the sky and it fixed the shaded carriageway. The
 * sunlit carriageway needed the mirror of it and never got one, so the flank of
 * each chip and the crevice beside it were being darkened by pulling their
 * albedo down instead. Albedo is achromatic here, and it scales the sun and the
 * sky by the same factor — so a pit between two stones came out as a darker
 * version of the same orange as the stone top. That is the "cavities are brown"
 * report, and it is why the surface reads as dry riverbed: in a real one, the
 * pits cannot see the sun at all and are filled purely by sky, so they go cool
 * blue-violet against warm tops. The chromatic split between lit and unlit is
 * most of what identifies a material as rock under a low sun, and darkening the
 * albedo can never produce it no matter how far it is taken.
 *
 * It is the same correction already made for the vertical faces of the buildings,
 * which was never applied to the ground micro-surface. */
float gChipSun = 1.0;

/* How much silt is lying on this fragment. Set where the channel is written,
 * consumed where the roughness is built, which is a long way further down. */
float gSilt = 0.0;

/* Wheel paths.
 *
 * Two lanes, two tracks each, at the track width of an ordinary car — about
 * 1.6 m between tyre centres, with the lane centred at half the carriageway.
 * The paths wander, because drivers do; a perfectly straight polished band is
 * the tell. Traffic polishes the aggregate flat, presses rubber into the
 * binder and leaves the surface both darker and much smoother than the strip
 * between the wheels, which keeps its texture and its dust. */
float wheelTracks(vec2 p, out float centreStrip){
  float wander = wfbm(vec2(p.y * 0.021, 3.1), 3) * 0.34
               + wfbm(vec2(p.y * 0.09, 8.4), 2) * 0.10;
  float lane = uRoadHalf * 0.5;
  float m = 0.0;
  for (int s = 0; s < 2; s++){
    float sg = s == 0 ? 1.0 : -1.0;
    float c = lane * sg;
    m = max(m, sstep(0.42, 0.0, abs(p.x - (c - 0.80 * sg) - wander * sg)));
    m = max(m, sstep(0.42, 0.0, abs(p.x - (c + 0.80 * sg) - wander * sg)));
  }
  centreStrip = 0.0;
  for (int s = 0; s < 2; s++){
    float sg = s == 0 ? 1.0 : -1.0;
    centreStrip = max(centreStrip, sstep(0.34, 0.0, abs(p.x - lane * sg - wander * sg)));
  }
  return m;
}

/* Crack sealing.
 *
 * Every maintained street is covered in these — black bitumen snakes poured
 * over cracks, 30–60 mm wide, standing slightly proud, and far shinier than
 * the road because they are pure binder with no aggregate in them. At night
 * under a lamp they are the brightest thing on the carriageway. Leaving them
 * out is one of the loudest omissions a CG road can have. */
/* The construction joint between paving lanes.
 *
 * A carriageway is laid one machine width at a time and the cold joint between
 * the passes is always the first thing to open, so there is a near-straight
 * line running the length of every street at the lane edge. Returned on its
 * own because it is also a *barrier*: cracking propagates up to a joint and
 * stops there, because the joint has already relieved the stress that would
 * have driven it further.
 */
/* The joint between paving mats.
 *
 * Two of these were rendering as dead straight dark lines running the entire
 * length of the street at a fixed offset from the centreline and converging on
 * the vanishing point, with the same weight over their whole length. A
 * reviewer read them as UV or geometry seams rather than as paving, which is
 * the right instinct: nothing laid by a machine on a real street is that
 * consistent. The wander was there but at 130 mm over tens of metres it is far
 * below what the eye needs to see a line as hand-made.
 *
 * The second joint sat at 3.55 m, which is now outside a 3.15 m half-width and
 * so never rendered at all — that is why there were exactly two lines rather
 * than four. It has been brought inside and given its own wander so the two
 * are not mirror images of each other.
 */
float laneJoint(vec2 p){
  float w1 = wfbm(vec2(p.y * 0.05, 4.0), 3) * 0.34 + wfbm(vec2(p.y * 0.29, 9.0), 2) * 0.09;
  float w2 = wfbm(vec2(p.y * 0.043, 61.0), 3) * 0.30 + wfbm(vec2(p.y * 0.33, 27.0), 2) * 0.08;
  float lane = min(abs(abs(p.x) - 1.88 - w1), abs(abs(p.x) - 2.86 - w2));
  /* Width varies along the run and the joint dies out entirely for stretches:
   * a mat joint is tight where it was rolled well and open where it was not. */
  float breadth = 0.020 + 0.030 * unit(wfbm(vec2(p.y * 0.22, 15.0), 3));
  float alive = sstep(0.34, 0.66, unit(wfbm(vec2(p.y * 0.09, 2.0), 3)));
  return sstep(breadth + 0.020, breadth, lane) * alive;
}

/* Localized fatigue damage.
 *
 * The version this replaces divided the whole carriageway into a Voronoi
 * tessellation, and two reviewers who had never spoken to each other both
 * called it what it was: a cell diagram. Straightening it, masking it and
 * softening it were all attempts to disguise a model that was wrong at the
 * root, because a road-wide network asserts that the entire surface failed at
 * once and evenly, and roads do not fail that way.
 *
 * Cracking is a fatigue response and it is local. It appears where the load
 * and the restraint are, and the great majority of a carriageway has none of
 * it at all. So there is no global network here any more. There are four named
 * mechanisms, each with its own geometry and its own place, and everything
 * between them is left intact:
 *
 *   Alligator patches, where wheels have loaded the same square metre for
 *   years and the surface has failed into a dense mat of small interlocking
 *   cells. Rare — one or two per block, in the wheel paths.
 *
 *   Longitudinal cracks, running with the direction of travel: single, long,
 *   wandering slightly, shedding short branches, dying out along their length.
 *
 *   Radial cracking around ironwork, where a rigid casting is surrounded by a
 *   flexible mat and the mat breaks in spokes at the rim.
 *
 *   Edge cracking against the gutter, where the mat is unsupported.
 *
 * Everything tapers, because width is multiplied by the same field that
 * decides whether the crack is there at all, so runs thin out and die rather
 * than stopping mid-stroke. The lip stays one-sided.
 *
 * Returns open crack in x, the chipped lip in y, and poured sealant in z.
 */
const int N_IRON = 4;
vec2 IRON[N_IRON];
void initIron(){
  IRON[0] = vec2(-0.9500, -41.5000);
  IRON[1] = vec2(1.3000, -82.0000);
  IRON[2] = vec2(2.8200, -22.2000);
  IRON[3] = vec2(-2.8200, -62.8000);
}


/* Dense interlocking cells, but only inside a patch that is itself rare. */
float alligator(vec2 p, out float aLip){
  aLip = 0.0;
  float best = 0.0;
  for (int k = 0; k < 2; k++){
    float bz = floor(p.y / 17.0);
    float h = hash21(vec2(bz, 3.0 + float(k) * 11.0));
    if (h < 0.58) continue;                       // most blocks have none
    float cz = bz * 17.0 + fract(h * 13.0) * 14.0 + float(k) * 6.0;
    float cx = (fract(h * 7.0) > 0.5 ? 1.0 : -1.0) * (0.70 + fract(h * 29.0) * 0.80);
    vec2 rad = vec2(0.30 + fract(h * 5.0) * 0.32, 0.80 + fract(h * 11.0) * 1.40);
    vec2 dd = (p - vec2(cx, cz)) / rad;
    // Ragged outline: a fatigue patch has no clean boundary.
    float rr = length(dd) + wfbm(p * 2.2 + h * 30.0, 3) * 0.22;
    float inside = 1.0 - sstep(0.55, 1.0, rr);
    if (inside < 0.004) continue;

    // Cells get smaller towards the middle, where the damage is worst.
    float cs = mix(0.16, 0.075, inside);
    vec3 ec = wedge(p / cs, 0.62);
    float w = (0.05 + 0.05 * unit(wfbm(p * 9.0, 2))) * inside;
    float net = 1.0 - sstep(w * 0.35, w, ec.y - ec.x);
    best = max(best, net * inside);
    aLip = max(aLip, (1.0 - sstep(w, w * 3.0, ec.y - ec.x)) * step(0.5, ec.z) * inside);
  }
  return best;
}

/* One or two long cracks running with the street, with tapering children. */
float longCrack(vec2 p, float roadHalf, out float lLip){
  lLip = 0.0;
  float best = 0.0;
  for (int i = 0; i < 2; i++){
    float fi = float(i);
    float h = hash21(vec2(fi, 91.0));
    float x0 = (h - 0.5) * 1.7 * roadHalf * 0.62;
    float wob = wfbm(vec2(p.y * 0.13, fi * 17.0), 3) * 0.20
              + wfbm(vec2(p.y * 0.62, fi * 5.0), 2) * 0.035;
    // Alive over only part of its run, so it starts somewhere and stops.
    float alive = sstep(0.42, 0.72, unit(wfbm(vec2(p.y * 0.055, fi * 3.0), 3)));
    if (alive < 0.004) continue;
    float xc = x0 + wob;
    float dx = abs(p.x - xc);
    float w = (0.007 + 0.013 * unit(wfbm(vec2(p.y * 1.9, fi), 2))) * alive;
    float parent = (1.0 - sstep(w * 0.35, w, dx)) * alive;

    /* Children. A primary crack sheds short branches at an angle which taper
     * and die within a few hundred millimetres, and that hierarchy is most of
     * what separates fatigue damage from a drawn line. */
    float bz = floor(p.y / 0.85 + fi * 7.0);
    float bh = hash21(vec2(bz, 41.0 + fi));
    float bAlive = step(0.55, bh) * alive;
    float bDir = bh > 0.775 ? 1.0 : -1.0;
    float by = (bz + fract(bh * 17.0)) * 0.85;
    float len = 0.16 + fract(bh * 31.0) * 0.34;
    float t = clamp((p.x - xc) * bDir / len, 0.0, 1.0);
    float off = abs((p.y - by) - t * len * (0.5 + fract(bh * 9.0)) * bDir);
    float bw = w * 0.75 * (1.0 - t);                 // tapers away to nothing
    float child = (1.0 - sstep(bw * 0.35, bw, off))
                * step(0.0, (p.x - xc) * bDir) * step(t, 0.999) * bAlive;

    best = max(best, max(parent, child * 0.9));
    lLip = max(lLip, (1.0 - sstep(w, w * 3.2, dx)) * step(0.0, xc) * alive);
  }
  return best;
}

/* Spokes around a casting, plus the annular break at the frame edge. */
/* Fracture radiating from a casting.
 *
 * The previous form took the angle to the fixture, scaled it by a spoke count
 * and thresholded the fractional part. That draws N cracks of identical width,
 * exactly evenly spaced, all reaching the same radius and none stopping — a
 * sunburst gradient, and a reviewer singled it out as the most obviously
 * synthetic object in the set. Even spacing is the tell: a real casting sheds
 * fracture where the ring beam happens to be weakest, so the cracks are few,
 * bunched on one side, of quite different lengths, and most of the rim has
 * none at all.
 *
 * Each spoke is therefore drawn individually with its own angle, reach and
 * taper, and roughly a third of them are simply absent.
 */
float radialCrack(vec2 p, out float rLip){
  rLip = 0.0;
  float best = 0.0;
  for (int i = 0; i < N_IRON; i++){
    vec2 c = IRON[i];
    vec2 v = p - c;
    float dd = length(v);
    if (dd > 1.35 || dd < 0.26) continue;
    float th = atan(v.y, v.x);
    float hc = hash21(c);

    for (int k = 0; k < 6; k++){
      float kk = float(k);
      float h1 = hash21(c + vec2(kk * 13.7, 4.1));
      if (h1 > 0.64) continue;                     // this sector never cracked
      float h2 = hash21(c + vec2(kk * 7.3, 91.2));
      float h3 = hash21(c + vec2(kk * 3.9, 27.5));

      // Unevenly spaced: a rough sector plus a large random offset inside it.
      float ang = (kk / 6.0 + hc + h2 * 0.28) * 6.28318;
      float da = abs(mod(th - ang + 9.42478, 6.28318) - 3.14159);

      // Its own reach, and it dies out rather than stopping at a radius.
      float reach = 0.40 + h3 * 0.80;
      float run = sstep(0.26, 0.34, dd) * sstep(reach, reach * 0.55, dd);
      if (run < 0.004) continue;

      /* Width tapers to nothing along the length, so the crack is widest at
       * the frame it started from and closes to a hairline. */
      float wob = wfbm(p * 6.5 + kk * 5.0, 2) * 0.10;
      float w = (0.055 + 0.045 * h2) * run + 0.004;
      float arm = (1.0 - sstep(w * 0.35, w, abs(da + wob * (dd - 0.26)))) * run;

      // One spoke in three shortly sheds a branch of its own.
      if (h1 < 0.22){
        float bAng = ang + (h3 - 0.5) * 0.55;
        float bd = abs(mod(th - bAng + 9.42478, 6.28318) - 3.14159);
        float bRun = sstep(reach * 0.55, reach * 0.70, dd) * sstep(reach, reach * 0.72, dd);
        arm = max(arm, (1.0 - sstep(w * 0.20, w * 0.55, abs(bd + wob))) * bRun);
      }

      best = max(best, arm);
      rLip = max(rLip, arm * 0.6);
    }

    // The ring where the mat has pulled away from the frame, broken not continuous.
    float ring = (1.0 - sstep(0.010, 0.030, abs(dd - 0.40 - wfbm(p * 6.0, 2) * 0.02)))
               * sstep(0.42, 0.68, unit(wfbm(p * 3.0, 3)));
    best = max(best, ring);
  }
  return best;
}

vec3 crackNet(vec2 p, float track, float roadHalf){
  initIron();
  float aLip = 0.0, lLip = 0.0, rLip = 0.0;
  float allig = alligator(p, aLip) * (0.35 + 0.65 * track);
  float lng   = longCrack(p, roadHalf, lLip);
  float rad   = radialCrack(p, rLip);

  /* Edge cracking: short transverse breaks in the unsupported metre nearest
   * the gutter, and only along part of its length. */
  float edgeZone = sstep(roadHalf - 1.15, roadHalf - 0.30, abs(p.x))
                 * sstep(0.55, 0.82, unit(wfbm(vec2(p.y * 0.10, 6.0), 3)));
  float ew = 0.16 + 0.16 * unit(wfbm(p * 4.0, 2));
  float eLine = 1.0 - sstep(ew * 0.5, ew,
                  abs(fract(p.y * 1.6 + wfbm(vec2(p.x * 2.0, 1.0), 2) * 0.4) - 0.5));
  float edge = eLine * edgeZone;

  float open = clamp(max(max(allig, lng), max(rad, edge)), 0.0, 1.0);
  float lip = clamp(max(max(aLip, lLip), rLip) * 0.75, 0.0, 1.0);

  /* Sealant, over the longitudinal cracks only. That is what a crew with a
   * wand actually treats: a single long crack is worth chasing, and an
   * alligator patch is past saving and waits for a planing machine. */
  float sealMask = sstep(0.40, 0.70, unit(wfbm(vec2(p.y * 0.045, 12.0), 3)));
  float sealed = lng * sealMask;

  // Where it has been sealed there is no open crack left to see.
  open *= 1.0 - sealed * 0.90;

  return vec3(open, lip * (1.0 - sealed), clamp(max(sealed, laneJoint(p)), 0.0, 1.0));
}

/* Patch repairs and utility trench cuts. Returns cell tone in x and the cut
 * edge in y — the edge is where the joint sealant and the settlement are. */
vec2 patches(vec2 p){
  vec2 q = p * 0.17;
  q += vec2(wfbm(q * 2.0, 2), wfbm(q * 2.0 + 9.3, 2)) * 0.3;
  vec2 w = wworley(q);
  float id = wworleyId(q);
  float isPatch = step(0.62, id);
  float edge = (1.0 - sstep(0.0, 0.05, w.y - w.x)) * isPatch;
  // Tone: some repairs are newer and blacker, some are older and paler.
  float tone = isPatch * (id > 0.84 ? 1.0 : -1.0) * (0.35 + 0.65 * fract(id * 17.0));

  /* Utility trench reinstatements.
   *
   * The most recognisable thing on any city side street and the previous
   * version barely showed them: one soft band across the road with a smooth
   * edge. A real reinstatement is a rectangle sawn or *broken* out of the
   * carriageway, filled with a different mix on a different day, and it gives
   * itself away three ways at once — a different tone, a step of ten or twenty
   * millimetres where the fill has consolidated below the old surface, and an
   * edge that is ragged at the centimetre scale because it was cut with a
   * breaker rather than a saw. The ragged edge is doing most of the work: a
   * clean straight boundary reads as a decal however good the tone is.
   */
  float band = floor(p.y / 11.3 + wfbm(vec2(p.y * 0.02, 2.0), 2));
  float bid = hash21(vec2(band, 5.0));
  float cy = band * 11.3 + bid * 6.0;
  float halfW = 0.5 + bid * 0.9;
  // Hand-cut: the edge wanders by up to 60 mm along its length.
  float ragged = wfbm(vec2(p.x * 2.6, band * 17.0), 3) * 0.045
               + wfbm(vec2(p.x * 9.0, band * 31.0), 2) * 0.018;
  float dCut = abs(p.y - cy) + ragged;
  float cut = sstep(halfW, halfW - 0.05, dCut) * step(0.55, bid);
  float cutEdge = sstep(0.09, 0.0, abs(dCut - halfW)) * step(0.55, bid);

  /* A second family running *along* the street rather than across it — the
   * long narrow trench a cable or a main gets laid in, usually in the
   * parking lane. Having both directions is what makes it read as a quilt
   * rather than as stripes. */
  float lbandF = floor(p.x / 2.35 + 0.5);
  float lid = hash21(vec2(lbandF, 23.0));
  float lx = lbandF * 2.35 + (lid - 0.5) * 0.5;
  float lRag = wfbm(vec2(p.y * 1.9, lbandF * 13.0), 3) * 0.040;
  float dL = abs(p.x - lx) + lRag;
  float lHalf = 0.28 + lid * 0.34;
  float runSpan = sstep(0.35, 0.55, unit(wfbm(vec2(p.y * 0.035, lbandF * 5.0), 2)));
  float lcut = sstep(lHalf, lHalf - 0.05, dL) * step(0.68, lid) * runSpan;
  float lEdge = sstep(0.08, 0.0, abs(dL - lHalf)) * step(0.68, lid) * runSpan;

  float allCut = max(cut, lcut);
  float allEdge = max(cutEdge, lEdge);
  float cutTone = cut * (bid - 0.6) * 2.0 + lcut * (lid - 0.72) * 2.4;
  return vec2(clamp(tone + cutTone, -1.0, 1.0), clamp(max(edge, allEdge) + allCut * 0.0, 0.0, 1.0));
}

/* Oil. Dropped where cars sit still, which on this street is the parking lane
 * next to the kerb, so it clusters there rather than spreading evenly. */
float oilStain(vec2 p){
  vec2 q = p * vec2(0.36, 0.22);
  vec2 w = wworley(q);
  float id = wworleyId(q);
  float blob = sstep(0.34 + 0.22 * fract(id * 13.0), 0.02, w.x) * step(0.55, id);
  blob *= 0.55 + 0.45 * unit(wfbm(p * 2.2, 3));
  // Parking lane: strongest about 2.6 m out from the centreline.
  float lane = sstep(1.5, 2.6, abs(p.x)) * sstep(3.7, 3.1, abs(p.x));
  return clamp(blob * lane, 0.0, 1.0);
}

/* Road paint. Returns coverage in x and how thickly it survives in y.
 *
 * The yellow centreline that used to be here is gone. A yellow centre stripe
 * means a two-way road wide enough to need one and is a North American
 * highway convention; the narrow city side street this is meant to be either
 * has nothing down the middle or has an old white lane line nobody has
 * repainted. The white one stays because worn paint is worth showing and
 * because it gives the wheel tracks something to cross.
 *
 * The second return is thickness rather than colour, and every consumer of it
 * modulates rather than switches: paint has no edge in the real world. It has
 * a zone a few centimetres wide where the film thins, the aggregate starts
 * showing through it, and the dirt that collects against the ridge makes the
 * outside darker than the road. A hard-edged quad of uniform white is the
 * single most recognisable CG road tell there is.
 */
vec2 roadPaint(vec2 p){
  // Broken white lane line: 3 m of paint, 9 m of gap. Laid by a truck, so it
  // drifts a few centimetres over a block rather than being ruled.
  float drift = wfbm(vec2(p.y * 0.014, 17.0), 2) * 0.16;
  float cl = sstep(0.088, 0.048, abs(p.x - drift));
  float dashPhase = p.y / 12.0;
  float dash = sstep(0.0, 0.14, sin(dashPhase * 6.28318) - 0.49);
  /* Dash-by-dash survival. Some were relaid last year, some are ghosts. A
   * repeating stripe of constant brightness is a texture; a run of dashes
   * with a different history each is a road. */
  float dashId = hash21(vec2(floor(dashPhase), 3.0));
  float centre = cl * dash * (0.18 + 0.82 * dashId);

  // Stop bar at the junction, worn thin in the two wheel paths that cross it.
  float bar = sstep(0.34, 0.26, abs(p.y + 85.4))
            * sstep(3.52, 3.30, abs(p.x)) * step(0.06, abs(p.x));

  /* Crosswalk.
   *
   * The bars are individually aged. A real one is never a comb: some bars are
   * down to an outline, one or two have been relaid and are much brighter than
   * their neighbours, and all of them are scrubbed hollow where the traffic
   * crosses. Uniform bars at uniform spacing were the loudest thing wrong with
   * the previous version of this. */
  float cwBand = sstep(1.62, 1.50, abs(p.y + 89.6));
  float barPitch = p.x / 1.15;
  float barIdx = floor(barPitch);
  float barId = hash21(vec2(barIdx, 11.0));
  float barW = 0.30 + 0.09 * barId;
  float within = abs(fract(barPitch) - 0.5);
  float bars = sstep(barW + 0.045, barW - 0.02, within);
  // Some bars survive only as their outline: the middle has gone entirely.
  float outlineOnly = step(0.62, barId);
  float outline = sstep(barW - 0.10, barW - 0.16, within);
  bars *= mix(1.0, 1.0 - outline * 0.85, outlineOnly);
  float crosswalk = cwBand * bars * sstep(3.55, 3.35, abs(p.x)) * (0.30 + 0.70 * barId);

  // A near crosswalk behind the start of the walk, almost entirely gone.
  float nearCw = sstep(1.42, 1.30, abs(p.y - 9.4))
               * sstep(0.34, 0.26, abs(fract(p.x / 1.15) - 0.5))
               * sstep(3.5, 3.3, abs(p.x)) * 0.34;

  float cover = max(max(centre, bar), max(crosswalk, nearCw));
  return vec2(cover, cover);
}

/* Damp.
 *
 * The thing that makes a night road look like a night photograph is not that
 * it is wet, it is that it is *unevenly* wet. Even hours after rain, and on
 * plenty of nights with no rain at all, a street is a patchwork metres across:
 * the crown has dried, the wheel paths have been wiped dry by tyres, and the
 * hollows and the gutter are still holding a film that turns them into
 * mirrors. Uniform gloss and uniform matte are equally wrong and equally
 * synthetic; the patchwork is the whole effect.
 *
 * Returns wetness in x, and standing water in y.
 */
vec2 dampField(vec2 p, float settle, float gutter, float track){
  // Deliberately only two octaves. The boundary of a drying patch is soft over
  // most of a metre, and any high-frequency content here reads as noise
  // sprinkled on the road rather than as water lying on it.
  float f = unit(wfbm(p * 0.052, 2)) * 0.70 + unit(wfbm(p * 0.155, 2)) * 0.30;

  /* Where the road is low. Biasing the threshold rather than adding a
   * separate term keeps the blob outlines organic — adding it would print the
   * settle field's own shape onto the road, which looks like a heightmap. */
  f += sstep(-0.004, -0.030, settle) * 0.26;
  f += gutter * 0.30;
  // The crown sheds first and dries first.
  f -= sstep(1.7, 0.15, abs(p.x)) * 0.14;
  // Tyres wipe their own path dry, and this is most of why wheel tracks read.
  f -= track * 0.22;

  /* Thresholds up hard, from 0.56 and 0.78.
   *
   * This field is the "large soft grey circular blob and long tapering streaks
   * with no visible caster" in the review, and the misattribution is
   * understandable — the marks are the right value and softness for a
   * badly-filtered shadow. They are not shadows. Capturing frame 40 with the
   * sun's shadow map switched off leaves every one of them exactly in place,
   * which is what identified them.
   *
   * They are damp patches, and they are a leftover from the night build this
   * street started as. At the old thresholds roughly half the carriageway was
   * classified wet, darkened by up to 58 per cent, with a boundary softened over
   * a metre and a characteristic size of nineteen metres. Seen from a camera a
   * metre and a half up, a nineteen-metre soft blob on the ground is not read as
   * a blob at all: perspective stretches it into precisely the long tapering
   * streak that was reported, and the near end of one becomes the circular
   * smudge. Every part of the description follows from the scale.
   *
   * The hour settles it. This is a dry evening in the last half hour of sun,
   * hours of it on the surface; a street-wide patchwork of standing water is a
   * night-after-rain condition and does not belong. So wetness is confined to
   * where water actually persists on a dry day — the channel, and the low spots
   * the settle field digs — and the road-wide patchwork goes. That is also worth
   * a little more than it costs here: the same field drives the roughness, so the
   * long specular smears down the carriageway go with it. */
  float wet = sstep(0.80, 0.99, f);
  float pool = sstep(0.94, 1.10, f);
  return vec2(wet, pool);
}

/* Macro relief, in metres.
 *
 * Sampled four extra times for its gradient, so it carries only the features
 * big enough to justify that: the poured sealant bead, which stands proud a
 * centimetre and catches a lamp along its length, the reinstatement step, and
 * the slow dishing of a tired carriageway. The crack network proper is a
 * millimetre deep and belongs in the normal map.
 */
float macroH(vec2 p){
  float lLip;
  float lng = longCrack(p, uRoadHalf, lLip);
  float sealMask = sstep(0.40, 0.70, unit(wfbm(vec2(p.y * 0.045, 12.0), 3)));
  float bead = lng * sealMask;
  float open = lng * (1.0 - sealMask);
  float dish = wfbm(p * 0.13, 3) * 0.012;
  float chuck = -sstep(0.55, 0.92, unit(wfbm(p * 0.55 + 40.0, 3))) * 0.010;
  return bead * 0.0125 - open * 0.0110 + dish + chuck + gPatchH;
}
`;

const ROAD_FRAG_BODY = /* glsl */ `
{
  vec2 p = vWPos.xz;

  /* Detail-scale blending. The same tile sampled again at 2.4x and offset,
   * mixed by a slow mask, so the period of either scale never lines up with
   * the period of the average. */
  float mixMask = sstep(0.30, 0.70, unit(wfbm(p * 0.075, 3)));
  /* Tile break, held down to a quarter.
   *
   * Blending in a second, differently-scaled copy of the map hides the two
   * metre repeat, but it is an average of two decorrelated samples and an
   * average of two textures has less contrast than either. At 0.45 it was
   * taking roughly a third of the variance out of the aggregate, which is a
   * poor trade: the repeat is invisible at night anyway and the chip contrast
   * is the whole point of the near field. */
  vec4 sB = texture2D(map, vMapUv * 0.413 + vec2(0.317, 0.611));
  diffuseColor.rgb = mix(diffuseColor.rgb, sB.rgb, mixMask * 0.26);

  float cavity = texture2D(roughnessMap, vRoughnessMapUv).r;

  float centreStrip;
  float track = wheelTracks(p, centreStrip);
  vec2  pat = patches(p);
  gPatchH = pat.x * 0.010 - pat.y * 0.016;
  vec3  crk = crackNet(p, track, uRoadHalf);
  float seam = crk.z;          // poured sealant and the lane joint
  float crack = crk.x;         // open, unsealed
  float clip = crk.y;          // the chipped lip on one side of it
  float oil = oilStain(p);
  vec2  paint = roadPaint(p);

  /* Water. See dampField: the point is the patchwork, not the gloss.
   *
   * The gutter term is deliberately narrow now. It used to be a 1.3 m band at
   * full strength, which produced a wide, perfectly even dark stripe down each
   * side of the road that read as an ambient-occlusion artifact rather than as
   * a channel with water in it. */
  float gutter = sstep(uRoadHalf - 1.05, uRoadHalf - 0.12, abs(p.x));
  vec2  wetv = dampField(p, vSettle, gutter, track);
  float damp = wetv.x;
  float pool = wetv.y;
  gDamp = damp; gPool = pool;

  /* Silt.
   *
   * Everything the road sheds ends up in a pale, dry, dusty line along the
   * very base of the kerb, immediately outside the wet part of the channel.
   * It is the one light-valued thing at the edge of a night road and its
   * absence is why the previous kerb line read as a black band. */
  float silt = sstep(uRoadHalf - 0.30, uRoadHalf - 0.06, abs(p.x))
             * (0.35 + 0.65 * unit(wfbm(vec2(p.y * 0.9, 5.0), 3)))
             * (1.0 - pool * 0.7);

  /* Anisotropy. A road is laid by a machine that drags in one direction and
   * then driven on in that same direction, so its micro-structure is
   * elongated along the street and its reflections smear lengthways. Real
   * anisotropic BRDF is System 8 territory; a roughness field stretched 14:1
   * along Z produces most of the same read for none of the cost. */
  float smear = unit(wfbm(vec2(p.x * 2.6, p.y * 0.19), 3));
  float smearFine = unit(wfbm(vec2(p.x * 9.0, p.y * 0.65), 2));

  /* Near-field aggregate, computed rather than sampled.
   *
   * The baked map carries the chippings at a millimetre a texel, which is
   * ample, and it still could not deliver them. The reason is mip filtering:
   * at two metres and this camera angle a ten millimetre chipping is about
   * five pixels wide and three tall, so the sampler is already a level or two
   * down the chain and every stone has been averaged into the binder around
   * it before the shader ever sees it. The road came back as an even pebbled
   * grain with no value spread — the 'pebbled rubber' read — and no amount of
   * authoring in the surface can fix it, because the information is destroyed
   * downstream of the surface.
   *
   * So the chip population is evaluated analytically here instead, where
   * nothing prefilters it. The cost of doing that is aliasing: an unfiltered
   * 16 mm feature is lethal at thirty metres. Hence the gate. fwidth gives the
   * world-space size of a pixel, and the whole band is faded out as soon as a
   * chipping stops covering enough pixels to be resolved, so it exists only in
   * the two or three metres where the eye is actually looking for it and is
   * simply absent everywhere else.
   */
  /* ---- aggregate ----------------------------------------------------------
   *
   * Two independent reviewers looked at this road and both said the same
   * thing: no aggregate, just an even sandpaper stipple with a faint diagonal
   * weave. They were right, and the previous attempt at a fix — moving the
   * chip evaluation out of the baked map and into the shader to dodge mip
   * filtering — addressed the wrong cause. Escaping the filter got the dots
   * back but they were still dots, because the model underneath was a single
   * Worley layer at one cell size producing one blob per cell, tinted.
   *
   * A chipping is a solid object and needs to be shaded as one. Four things
   * were missing and all four are here now:
   *
   *   Shape from the feature vector. Knowing where the stone's centre is lets
   *   the surface fall away towards its rim, so each chip presents a lit
   *   facet on the lamp side and a dark one away from it. This is what makes
   *   a stone rather than a bump, and no amount of tone variation substitutes
   *   for it — with every chip lit identically the field can only ever read as
   *   texture.
   *
   *   A real size distribution. One cell size gives one grain size. Three
   *   layers at 22, 11 and 5.5 mm, each with a squared random radius so the
   *   population is heavy-tailed, gives the 4–16 mm jumble that actually comes
   *   out of a quarry. Coarse layers are composited over fine so big stones
   *   visibly cover small ones.
   *
   *   Clustering. Exposure is driven by a low-frequency field, so coarse
   *   stone-rich patches alternate with smoother binder-rich ones instead of
   *   the uniform coverage that made the old field look woven.
   *
   *   Sockets. A minority of cells are holes where a chipping has been plucked
   *   out — concave, black, sharp-rimmed, the same size and shape the stone
   *   was.
   *
   * The weave came from the grid: a partially-jittered lattice at a single
   * frequency leaves visible rows. Each layer is now fully jittered, rotated
   * by an unrelated angle and domain-warped, which leaves no axis for rows to
   * line up along.
   */
  float px = fwidth(p.x) + fwidth(p.y);
  float agT = 0.0, agS = 0.0, agSock = 0.0;
  vec2  agN = vec2(0.0);
  {
    /* Density varies at two scales, not one. A metre-scale field alone gave
     * coverage that was uniform corner to corner at any distance the eye
     * actually inspects; the hand-span scale is the one that reads as a road
     * that has been worn unevenly. */
    /* Exposed aggregate is a minority of the surface, and it is a *symptom*.
     *
     * Successive rounds asked for the chippings to be more readable as stones
     * and each one raised the coverage floor, ending at 0.68 with three layers
     * composited over one another and a dark crevice term filling whatever was
     * left. The result has no binder in it anywhere: every pixel of the
     * carriageway is a chip face, a chip flank or the gap between two chips, so
     * the surface is not asphalt with stone in it, it is a bed of stone. That is
     * the "decomposed granite driveway" in the review and it is a modelling
     * error, not a tuning one — the matrix that defines the material had been
     * squeezed out of the picture entirely.
     *
     * A bituminous surface course is about 95 per cent covered by binder when it
     * is laid, and it stays that way except where something has taken the binder
     * off the top of the stone. So coverage starts near zero and is *earned*:
     *
     *   the crown, which no tyre polishes and where the mix has oxidised and
     *   fretted, is where a real street shows its aggregate;
     *   the gutter, which is wet half the year and where grit scours;
     *   the ragged margins of old patch repairs;
     *
     * and it is suppressed in the two wheel paths, where the stone has been
     * polished flat and rubber and fines have been pressed into the voids. That
     * is also the answer to "no wear structure at metre scale": the aggregate
     * field now *is* the wear structure rather than a uniform noise laid over
     * the top of it, so the wheel paths, the crown and the channel differ in
     * texture and not merely in tone. */
    /* The gutter's sign is inverted, from +0.75 to −0.85, and it was the source
     * of the brightest wrong thing in the set.
     *
     * The reasoning that put it positive was that the channel is scoured by
     * running water, so its stone should be clean and proud. That is true of the
     * stone and false of what a viewer sees, because the channel is also where
     * everything the road sheds ends up: it scours in a downpour and then spends
     * the other three hundred and sixty days silting up. The result on the frames
     * was clusters of near-white chippings piled along the kerb line, sitting on
     * the surface with no contact shadow — described as the most scree-like thing
     * in the set, and made worse, not better, by correcting the road around them
     * to grey, because they had been half-hidden in a brown field before.
     *
     * So the channel now suppresses exposed aggregate as hard as the wheel paths
     * do, and gets its own covering instead, further down. */
    float worn = clamp(centreStrip * 0.80 - gutter * 0.85 + pat.y * 0.55
                     + oil * 0.20 - track * 1.05, 0.0, 1.0);
    /* Patchy even within a worn zone — fretting starts at a point and spreads,
     * so exposure comes in islands a fist to a stride across rather than as an
     * even wash over the whole strip. */
    float fret = sstep(0.42, 0.84, unit(wfbm(p * 1.05, 3)))
               * (0.35 + 0.65 * sstep(0.34, 0.74, unit(wfbm(p * 4.6, 3))));
    float expose = fret * (0.10 + 0.90 * worn);
    vec2 warp = vec2(wfbm(p * 3.1, 2), wfbm(p * 3.1 + 51.0, 2)) * 0.06;

    for (int L = 0; L < 3; L++){
      float cs = L == 0 ? 0.034 : (L == 1 ? 0.0155 : 0.0068);
      float fwL = px / cs;
      float vis = 1.0 - sstep(0.35, 1.15, fwL);   // resolvable at all?
      if (vis < 0.004) continue;

      // Unrelated rotation per layer, so no two lattices share an axis.
      float a = 0.7 + float(L) * 1.3;
      vec2 q = vec2(p.x * cos(a) - p.y * sin(a), p.x * sin(a) + p.y * cos(a));
      float f2, id; vec2 rel;
      float d = wchip((q + warp) / cs, f2, id, rel);

      float g1 = fract(id * 7.31), g2 = fract(id * 17.7), g3 = fract(id * 3.13);
      // Tone is drawn independently of size: in a quarry mixture a big stone is
      // no more likely to be a pale one, and tying the two together made every
      // bright chip the smallest one on the road.
      float g4 = fract(id * 11.93);

      /* Chips are polygons, not discs, and this is the change that matters.
       *
       * Thresholding the distance to the feature point draws a circle, and a
       * circle shaded from a height field has a soft gradient falling away on
       * every side — which is precisely what three reviewers described: soft
       * rounded blobs that look painted on rather than lumps of rock lying in
       * bitumen. Crushed aggregate has no round faces at all. It is a
       * fractured polyhedron: straight edges, sharp corners, a flat top and an
       * abrupt drop at the rim.
       *
       * The Voronoi cell is already a polygon, so the chip is that cell inset
       * from its own boundary. f2 - f1 is twice the distance to the border, so
       * insetting by a per-cell amount gives a straight-edged, sharp-cornered
       * stone whose size is controlled independently of the cell — which is
       * also how the size range gets wide enough, since a small inset leaves
       * nearly the whole cell and a large one leaves a chip a quarter the
       * size.
       */
      float border = (f2 - d) * 0.5;
      float inset = mix(0.055, 0.300, g1 * g1);
      /* From mix(0.68, 1.0). The floor is what mattered: at 0.68 two thirds of
       * every cell in every layer drew a stone no matter what the wear field
       * said, so the exposure term could only ever modulate between "all stone"
       * and "slightly more stone". At 0.04 a polished wheel path is essentially
       * bare binder with the occasional proud chip in it, which is what one
       * looks like, and the ceiling of 0.66 leaves visible matrix even in the
       * most fretted part of the crown. */
      float cov = mix(0.04, 0.66, expose) * (L == 0 ? 1.0 : 0.86);
      if (g2 > cov) continue;

      /* The edge is exactly as wide as a pixel and no wider. Any fixed
       * softening term here is a gradient the eye reads as an airbrushed
       * spot; at two metres this resolves to a hard step. */
      float e = max(0.35 * fwL, 0.004);
      float face = sstep(inset - e, inset + e, border);
      if (face < 0.004) continue;
      float sock = step(0.90, g3);                // one chip in ten is gone

      /* The flank. Flat across the top, then turning over inside a band one
       * or two millimetres wide, so the transition from lit facet to dark
       * side happens across a pixel rather than across the stone. */
      float rim = 1.0 - sstep(inset, inset + 0.10, border);
      vec2 dir = rel / max(d, 1e-4);              // points at the stone centre
      // Each stone is bedded at its own angle, which is most of why a real
      // aggregate field twinkles unevenly instead of glinting all at once.
      vec2 tilt = (vec2(fract(id * 23.1), fract(id * 41.7)) - 0.5) * 1.05;

      /* The rim is a sub-pixel feature and has to be told so.
       *
       * This band is the sharpest and by far the largest normal feature in the
       * material — a turnover of 2.10 in tangent space, about sixty-five
       * degrees — and it is 0.10 of a cell wide, which is 3.4 mm on the coarse
       * layer and 0.7 mm on the fine one. A pixel of carriageway at the bottom
       * of a standing frame is four to six millimetres across. So over almost
       * the whole frame the renderer is point-sampling a sixty-five degree
       * turnover inside a band narrower than the pixel, and which side of it
       * the sample lands on is a coin toss that is re-tossed the moment the
       * camera moves. That is the shimmer the walk harness measured: saturated
       * at the smallest step, because the samples either side of a step are
       * independent rather than nearby.
       *
       * 'vis' above does not catch it. 'vis' asks whether the *cell* is
       * resolvable, and a 34 mm cell is perfectly resolvable at the same
       * distance where its 3.4 mm rim is not — the two differ by the factor of
       * ten between a stone and its edge. So the rim gets its own gate against
       * its own width.
       *
       * What is removed here is not thrown away, it is moved. Below is the
       * variance it represents, handed to the roughness in the normal hook: a
       * pixel that contains a fraction of a steeply turned rim genuinely has a
       * wider distribution of normals in it than one that does not, and
       * widening the lobe by that amount is the correct rendering of the same
       * surface rather than a blur of it. Appearance at rest is preserved
       * where the feature is resolved, which for the coarse layer is about a
       * metre and a half — closer than that the rim comes back and is drawn. */
      float rv = 1.0 - sstep(0.35, 1.10, fwL / 0.10);
      vec2 n = (tilt - dir * rim * 2.10 * rv) * (sock > 0.5 ? -0.85 : 1.0);

      /* The hard terminator, and it has to be shading rather than a normal.
       *
       * Every previous round gave each chip a lit facet and a dark flank by
       * turning the normal over at the rim, and every reviewer since has said
       * the same thing: not one particle has a crisp dark side. The normal was
       * doing its job — it was being filled straight back in. A shadowed flank
       * lit by a large bright sky returns plenty of light, so the shading term
       * darkens by perhaps a third and then stops, which reads as a soft
       * gradient on a bright smudge instead of as the side of a rock.
       *
       * What makes a stone read as a solid is that its far side is *occluded*,
       * not merely angled away, and occlusion at this scale is below anything
       * the renderer can resolve. So it is stated directly: the half of each
       * chip facing away from the sun loses most of its light, keyed to the
       * real sun azimuth so it stays consistent with every shadow in frame and
       * swings correctly if the hour is ever changed again.
       *
       * dir points from the fragment toward the chip's centre, so a fragment
       * on the sun-facing flank has dir opposing the sun. */
      float facing = -dot(dir, uSunXZ);
      float flank = sstep(0.10, -0.42, facing) * sstep(inset + 0.16, inset, border);

      /* Coarse layers carry more contrast than fine ones, which is both true
       * and necessary. Weighting all three equally meant the finest layer —
       * the only one that switches on in the last two metres — took over the
       * near field, so the road appeared to get *finer* grained as it
       * approached the camera. Measured on the previous build, the
       * characteristic feature width at the bottom of frame was smaller than
       * at mid depth, which is backwards and is what flattened the
       * perspective into a poster. */
      float lw = L == 0 ? 1.0 : (L == 1 ? 0.82 : 0.64);
      float w = face * vis * lw;
      agN = mix(agN, n, w);

      /* The variance the rim carries, which is what the roughness is owed.
       *
       * Two-state distribution inside the pixel: a fraction f of it is rim,
       * turned over by the part of the amplitude the normal is no longer
       * carrying, and the rest is flat. The variance of that is f(1-f)a², and
       * it correctly goes to zero at both ends — a pixel entirely on the rim
       * has no variation in it either. Stated as a deviation of the *unit*
       * normal rather than of the tangent-space offset, because that is the
       * currency the derivative-based term downstream is already in and the
       * two have to be addable. */
      float rf = clamp(0.10 / max(fwL, 1e-4), 0.0, 1.0);
      /* Deliberately not multiplied by rim. Whether *this* sample landed on
       * the rim is the very coin toss being filtered out; if the widening were
       * keyed to it the roughness would alias in place of the normal. Once a
       * pixel is a fair fraction of a cell every pixel straddles a rim, and rf
       * already says how much of it. */
      float ra = 2.10 * (1.0 - rv);
      float ru = ra * inversesqrt(1.0 + ra * ra);
      gNVar = mix(gNVar, rf * (1.0 - rf) * ru * ru, w);
      /* Tone spread, pulled in from 4.2. Under one sodium lamp a wide spread
       * read as a road; under direct sun at grazing incidence the near field
       * became a bed of bright pebbles — the "over-scaled gravel scatter" in
       * the report. The chips are the right size, at 34 mm; it was the
       * contrast between them that made a surface course look like scree. */
      float tone = sock > 0.5 ? -0.90 : (g4 * g4 * 3.1 - 0.62);
      /* The flank no longer darkens the albedo. A stone's shadow side is the same
       * rock as its top; what makes it dark is that the sun cannot reach it, and
       * that is now stated where it belongs, in gChipSun below. */
      agT = mix(agT, tone, w);
      agS = mix(agS, sock > 0.5 ? 0.0 : 1.0, w);
      agSock = mix(agSock, sock, w);

      /* The gap between stones, and it has to go properly dark. Bitumen down
       * between two chippings receives almost nothing: it is shadowed by the
       * stones on both sides and it is the blackest thing on a road surface.
       * Rendering it as a slightly darker grey is what leaves an aggregate
       * field looking like a tinted stipple with no depth in it. */
      /* Narrowed from a band starting at 0.35 of the inset to one starting at
       * 0.74. When a stone was guaranteed to have five neighbours the crevice
       * filled the space between them and was the correct read. With coverage
       * back down to what asphalt actually has, most chips are isolated, and a
       * wide crevice term became a dark halo painted around each one on open
       * binder — every chip ringed like a printed dot. The contact shadow is
       * real but it is a couple of millimetres wide, not a third of the cell. */
      float gap = (1.0 - sstep(inset * 0.74, inset, border)) * (1.0 - face) * vis;
      agT = mix(agT, -0.72, gap * 0.80);
      agN = mix(agN, dir * 0.6, gap * 0.5);

      /* A proud face sees the whole dome; the crevice beside it sees a slot
       * between two stones a couple of centimetres apart. The flank is
       * intermediate — angled away from the sky but not enclosed. */
      gChipAO = min(gChipAO, 1.0 - gap * 0.62 - flank * face * vis * 0.22);

      /* And the sun. A flank turned away from a source four degrees above the
       * horizon is in full shadow, not partial — at that incidence the terminator
       * on a lump of rock is close to a step — and the crevice between two stones
       * is shadowed by whichever of them the light hits first. Taken almost to
       * zero for that reason; what is left is the small amount of warm light
       * bouncing off the stone opposite. */
      gChipSun = min(gChipSun, 1.0 - flank * vis * 0.94 - gap * vis * 0.88);
    }
  }
  gChipN = agN;
  gChipAO = clamp(gChipAO, 0.24, 1.0);
  gChipSun = clamp(gChipSun, 0.05, 1.0);

  /* Attribution switches for "which layer actually draws the near-field road".
   *
   * Added because a structural change to this loop — dropping the coverage floor
   * from 0.68 to 0.04, which is the difference between two thirds of every cell
   * carrying a stone and one cell in twenty-five — moved the measured saturation
   * of the near-road crop from 0.380 to 0.368. A change of that size cannot
   * produce a change of that size. Either the loop is not drawing what it looks
   * like it is drawing, or something downstream is drawing over it, and no
   * amount of further tuning here is worth anything until that is settled. */
#ifdef DEBUG_ROAD_NO_CHIPS
  agT = 0.0; agS = 0.0; agSock = 0.0; gChipN = vec2(0.0); gChipAO = 1.0; gChipSun = 1.0;
  gNVar = 0.0;
#endif

  /* ---- albedo ---- */
  vec3 c = diffuseColor.rgb;

  /* Bound asphalt is a dark, near-neutral grey, and the warmth belongs to the
   * stones rather than to the plane.
   *
   * The baked base was authored warm and mid-valued, which under a sodium lamp
   * was indistinguishable from correct. Under a low sun it puts the whole
   * carriageway at the value and hue of dry earth, so the road reads as soil
   * or coffee grounds rather than as bitumen — and because the footway is warm
   * too, concrete and asphalt end up separated only by brightness, which is
   * most of why the frame looks sepia rather than golden.
   *
   * So the binder is stripped back toward neutral, pulled down in value, and
   * given a faint blue cast, which is what bitumen actually does: it is one of
   * the few things outdoors that stays cool when everything around it goes
   * warm. The warmth is then handed to the chips alone, keyed to the same
   * per-chip tone that lights their facets, so a lit stone face is gold and
   * the matrix it sits in is not. */
  float binderLum = dot(c, vec3(0.2126, 0.7152, 0.0722));
  /* From 0.28. Measured over the whole near-road crop, desaturating the chips
   * alone moved the frame's saturation from 0.380 to 0.375 — nothing — because
   * the chips are now a minority of the surface by design and what the review is
   * reading as brown is the matrix under a very orange sun. The baked map is
   * authored warm, and retaining 28 per cent of its chroma is enough to push the
   * result to a saturation of 0.38, which is dry earth. Bitumen has effectively
   * no hue of its own, so almost none is kept. */
  /* From 0.10 to 0.03. Effectively none: the surface is asked to be a neutral
   * grey and take all of its hue from what falls on it, which is what the review
   * means by letting the orange light do the warming. Whatever chroma survives
   * now is illumination, so the warm/cool split between chip tops and chip pits
   * can actually be seen instead of being ridden over by a brown base. */
  c = mix(vec3(binderLum), c, 0.03);
  /* 0.44 put the binder near 0.025 reflectance, which is fresh-laid bitumen
   * seen at night. It cannot be right for a worn side street in daylight: the
   * binder weathers off the top of the aggregate within a season and an old
   * carriageway measures nearer 0.10. The low value only survived this long
   * because an eleven-times environment reflection was standing in for the
   * diffuse the surface should have had, and with that gone the road rendered
   * as a black hole. */
  /* Cooled further, from (0.90, 0.94, 1.08). Bitumen is one of the few things
   * outdoors that stays cool while everything round it goes warm, and giving the
   * road a genuinely blue-leaning albedo is how the orange light gets to do the
   * warming — which is what the review asked for — instead of the warmth being
   * baked in and then multiplied by the sun. The luminance weight of the new
   * triple is 0.919 against 0.941, so the 1.23 holds the value where it was; the
   * review has locked the exposure and this must not move it. */
  c *= vec3(0.84, 0.92, 1.14) * 1.23;

  /* Chip contrast has to come down as the binder comes up.
   *
   * These amplitudes were set against a binder at 0.025, where a chip three
   * times the binder is still a dark grey stone. Against a binder at 0.10 the
   * same multiplier makes every chip a pale pebble, and the surface stops
   * reading as asphalt with stone in it and starts reading as loose gravel —
   * which is what it did as soon as the albedo was corrected. */
  /* Amplitude down from 0.84, and the ceiling down from 2.3.
   *
   * A chipping in a surface course is *embedded*: the binder wraps its lower
   * two thirds and a film of it stays on the exposed face for years, so the
   * value step from matrix to stone is modest — well under two to one on a worn
   * road. At 0.84 with a 2.3 ceiling a lit chip was more than three times the
   * binder, which is the appearance of clean stone tipped out of a bag rather
   * than stone rolled into tar, and it is the other half of why the surface read
   * as loose gravel. */
  c *= clamp(1.0 + agT * 0.46, 0.30, 1.62);

  /* The stone is grey. Nothing about it is brown.
   *
   * The review is precise about the symptom: the shadow sides of the chips are
   * brown, so the surface looks like gravel lit from within rather than grey
   * rock under an orange sun. Two things were doing that and both are here.
   *
   * The first is this warm cast, which was (1.24, 1.06, 0.84) — a blue-to-red
   * ratio of 0.68, baked into the albedo of every lit chip face. Albedo is not
   * illumination: tinting it warm makes the stone warm in shade as well as in
   * sun, which is exactly the complaint. Granite and basalt roadstone are
   * near-neutral, so the cast is cut to a hint of iron staining and the sun is
   * left to do the warming, which it does correctly and only where it lands.
   *
   * The second is that the chip term multiplies a base that still carries the
   * baked map's chroma, so a bright chip is a *brighter version of brown earth*.
   * Pulling the chroma out in proportion to how proud the chip is makes the
   * stone neutral without touching the binder or the staining laid on later. */
  c *= mix(vec3(1.0), vec3(1.055, 1.010, 0.965), clamp(agT, 0.0, 1.0) * 0.55);
  float chipGrey = clamp(abs(agT), 0.0, 1.0) * 0.62;
  c = mix(c, vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), chipGrey);
  // A socket is a hole, and a hole is not a darker grey.
  c = mix(c, c * 0.12, agSock * 0.90);
  /* Patch repairs.
   *
   * A side street is a quilt, not a surface. Every utility that has ever been
   * down there has cut a trench and backfilled it with whatever mix the crew
   * had that day, so the carriageway is a collection of rectangles and
   * hand-cut blobs of visibly different age, tone and aggregate, with the
   * newest reading nearly black and the oldest greyer than the road. */
  c *= 1.0 + pat.x * 0.62;
  c = mix(c, c * 0.30, pat.y * 0.88);

  /* The wheel paths are the *light* bands, and they were the dark ones.
   *
   * The previous version reasoned from rubber deposition and darkened them by a
   * quarter. That is what a skid mark does, not what a running lane does. A lane
   * that has carried traffic for a decade has had the mortar-fine dust polished
   * off it and the stone burnished to a flat grey sheen, while the strip between
   * the wheels and the crown keeps its dust, its oxidised binder and its open
   * voids — and open voids are light traps. Every aerial photograph of a
   * two-lane street shows the same thing: two pale ribbons on a darker mat. It
   * matters more than it sounds, because those two ribbons plus the darker crown
   * between them are most of the metre-scale structure a viewer uses to read a
   * carriageway as a carriageway rather than as a textured plane, and the sign
   * error meant the structure was there but inverted and therefore illegible. */
  c = mix(c, c * 1.30, track * 0.80);
  c = mix(c, c * 0.80, centreStrip * 0.55 * (1.0 - track));

  /* Mat-scale variation in the binder itself.
   *
   * Even with the wear structure legible, the surface between its features was
   * one flat value, because every term above this point is either chip-sized or
   * a named feature. A real mat is laid in passes by a machine whose screed
   * temperature and material feed both drift, so its tone wanders over metres
   * and there are faint longitudinal streaks where the augers ran. Low
   * amplitude on purpose — this is the difference between a surface and a plane,
   * not a feature anyone should be able to point at. */
  float mat = unit(wfbm(vec2(p.x * 0.42, p.y * 0.19), 3)) - 0.5;
  float screed = unit(wfbm(vec2(p.x * 2.1, p.y * 0.055), 2)) - 0.5;
  c *= 1.0 + mat * 0.20 + screed * 0.09;
  /* Open cracking: a dark void with a freshly-broken pale lip along one side.
   * The lip is what stops it reading as a drawn line — a line has no section
   * and this has one. */
  c = mix(c, c * 0.16, crack * 0.90);
  c = mix(c, c * 1.72, clip * 0.42);
  // Sealant is almost pure black bitumen.
  /* Sealant, and it must not go to black.
   *
   * A poured bitumen bead is dark, but it is a *shiny* dark standing a few
   * millimetres proud, and under a lamp it is one of the brightest things on
   * the carriageway — the specular wins over the albedo completely. Authored
   * at near-zero albedo with a mirror roughness it just rendered as a black
   * hairline, which is exactly the drawn-on look this was meant to avoid. */
  c = mix(c, vec3(0.0182, 0.0163, 0.0146), seam * 0.85);
  // Oil kills the albedo outright.
  c = mix(c, c * 0.30, oil * 0.9);
  // The channel carries a season of grit, leaf tannin and exhaust.
  c = mix(c, c * vec3(0.60, 0.575, 0.545), gutter * 0.55);

  /* What is actually lying in the channel.
   *
   * Suppressing the exposed aggregate above takes the bright stone piles out;
   * this puts the right thing in their place. Gutter debris is silt, road fines,
   * brake dust, leaf litter and cigarette ends, and every one of those is darker
   * than the asphalt, not lighter — the pile the review objected to was inverted
   * on that axis before anything else was wrong with it.
   *
   * It is also *fine*. The grain here should be well below the size of a chipping
   * and read as matting rather than as scattered objects, so it is built from
   * high-frequency noise with almost no tonal spread instead of from the chip
   * lattice. And it banks against the kerb rather than filling the channel
   * evenly: deepest in the last two hundred millimetres, thinning to nothing
   * about half a metre out, with a ragged tide line where it stops. */
  float chanD = 1.0 - clamp((uRoadHalf - abs(p.x)) / 0.52, 0.0, 1.0);
  float tide  = unit(wfbm(vec2(p.y * 1.35, p.x * 0.7), 3));
  // Ragged, and broken along its length — a channel is swept clear where cars
  // clip the kerb and heaped where they never go.
  float debris = sstep(0.30, 0.86, chanD * (0.55 + 0.75 * tide))
               * sstep(0.34, 0.62, unit(wfbm(vec2(p.y * 0.24, p.x * 0.2) + 12.0, 3)));
  float fines = unit(wfbm(p * 26.0, 3));
  vec3 debrisC = mix(vec3(0.0248, 0.0231, 0.0206), vec3(0.0316, 0.0288, 0.0242), fines);
  // Leaf litter and butts: a sparse scatter of slightly warmer, slightly lighter
  // flecks, the only thing in here allowed to be brighter than the road.
  float leaf = sstep(0.86, 0.97, unit(wfbm(p * 7.4 + 88.0, 2))) * debris;
  debrisC = mix(debrisC, vec3(0.0470, 0.0362, 0.0224), leaf * 0.7);
  c = mix(c, debrisC, debris * 0.88);
  // Matted, so it does not pick up the sheen the asphalt around it does. The
  // roughness is not built until further down, so it is carried rather than set.
  gSilt = debris;
  /* Contact occlusion where it meets the kerb. A wedge of silt in a right angle
   * cannot see much sky, and the missing shadow at that junction was half of why
   * the old piles looked stuck on rather than lying there. */
  gChipAO *= 1.0 - chanD * 0.42 - debris * 0.20;
  gChipSun *= 1.0 - debris * 0.16;
  // Water darkens what is under it — this is most of why a wet road is dark.
  /* Water darkens hard.
   *
   * A wet patch reflects more and *absorbs* more: the film fills the surface
   * voids so light that used to scatter back out of them gets trapped, and
   * measured wet asphalt is roughly half the reflectance of dry. Under-doing
   * this was why the damp regions came out as a pale beige wash — they had the
   * gloss of water without the darkness of it, which is the visual signature
   * of a varnished surface rather than a wet one. */
  /* Pulled in with the coverage. What is left is a genuinely damp channel rather
   * than a wet road, and a damp channel that swings 58 per cent dark is a stain;
   * the darkening a thin film actually produces is nearer a third. */
  c *= 1.0 - damp * 0.34 - pool * 0.30;
  /* This used to brighten the kerb line by a factor of 2.35, and it is where the
   * bright stone piles were coming from — not from the aggregate model at all.
   *
   * It is a leftover from the night brief, and the comment it carried said so
   * plainly: "the one light-valued thing at the edge of a night road", written
   * when the problem to solve was a kerb line reading as a black band under
   * lamplight. Under a low sun the entire road is already bright and the thing
   * that needed lifting does not need lifting, so all this did was put a pale
   * dusty streak exactly where the review kept finding scree. It survived four
   * rounds of aggregate tuning because it is nowhere near the aggregate code.
   *
   * A trace is kept, because a dry crust does form at the very back of the
   * channel above the silt, and at a twentieth of the old strength it registers
   * as a change of material rather than as a light source. */
  c = mix(c, c * vec3(1.10, 1.08, 1.04), silt * 0.30 * (1.0 - debris));

  /* Paint.
   *
   * Worn into the surface rather than laid on top: coverage is multiplied by
   * the baked cavity map, so what survives is the paint down in the hollows
   * between the aggregate while the proud stones have been scrubbed back to
   * bare rock. That single term is the difference between "worn paint" and
   * "a decal with noise on it". */
  float wear = sstep(0.14, 0.72, unit(wfbm(p * 1.15, 4)));
  float chip = sstep(0.30, 0.70, unit(wfbm(p * 6.5, 3)));
  float fray = sstep(0.35, 0.65, unit(wfbm(p * 22.0, 2)));   // ragged at the edge
  float pk = paint.x * mix(0.42, 1.0, wear) * mix(0.60, 1.0, chip);
  // The aggregate shows through: coverage survives only in the hollows between
  // the stones, and the proud faces have been scrubbed back to bare rock.
  pk *= mix(0.18, 1.0, sstep(0.20, 0.82, cavity));
  pk *= 1.0 - track * 0.62;           // scrubbed hardest where wheels cross it
  pk *= 1.0 - seam * 0.8;
  pk *= 1.0 - crack * 0.7;
  // Erode the boundary itself so there is no clean edge anywhere on it.
  pk = clamp(pk - (1.0 - paint.x) * 0.0 - fray * 0.22 * sstep(0.9, 0.35, paint.x), 0.0, 1.0);

  /* Dirty ochre-grey, not white.
   *
   * Road marking paint is thermoplastic with glass beads in it, and after one
   * winter it is the colour of the dust that has been ground into it. Anything
   * approaching a clean white on a night street is a decal. */
  /* Markings, brought back from invisible.
   *
   * The first critique said the paint was a clean decal sitting on top of the
   * road, so it was worn into the surface, dirtied and desaturated — and the
   * second critique found essentially nothing left in any frame, which is the
   * same mistake with the sign flipped. Both are wrong about the same thing:
   * how bright road paint is at night.
   *
   * Thermoplastic marking is loaded with glass beads and is retroreflective,
   * so it returns light towards whatever lit it far more efficiently than the
   * asphalt around it. Even filthy and half worn away it is reliably the
   * brightest thing on a night carriageway — brighter than the lit road
   * surface, not a shade of it. An albedo of 0.16 could never do that against
   * a road at 0.03; it needs to be several times the road, and then dirtied
   * from there rather than dimmed towards it. */
  /* All of which is true at night and none of it here.
   *
   * Retroreflection returns light towards the source. At night the source is a
   * headlamp sitting next to the eye, so the beads throw it straight back and the
   * marking is the brightest thing on the road. At six in the evening the source
   * is the sun, and the light the beads send back goes to the sun. To this camera
   * a bead is just a slightly glossy lump of glass, so daylight paint reads at its
   * plain diffuse albedo: bright against asphalt, but nothing like fourteen times
   * it. 0.42 was sized for the night case and is why the dashes come back as crisp
   * uniform white with no wear visible in them — everything below this line is
   * modulating a value so far above its surroundings that the modulation cannot
   * be seen. Worn thermoplastic measures around 0.20–0.25 dry. */
  vec3 paintC = vec3(0.2260, 0.2170, 0.1960);
  paintC *= 0.60 + 0.40 * wear;
  paintC = mix(paintC, paintC * vec3(1.10, 1.02, 0.86), sstep(0.5, 1.0, wear) * 0.5);
  // Grimed down where tyres cross it, which is most of what makes it look old.
  paintC *= 1.0 - track * 0.62;
  /* Tyre scuffing: rubber laid across the film in short streaks along the
   * direction of travel, which is the mark that says a vehicle has been over it
   * rather than that time has passed. Only where the wheels actually run. */
  float scuff = sstep(0.48, 0.92, unit(wfbm(vec2(p.x * 15.0, p.y * 1.5) + 61.0, 3))) * track;
  paintC *= 1.0 - scuff * 0.55;
  c = mix(c, paintC, pk);
  /* Published as the *worn* coverage, not the raw mask. Nothing downstream reads
   * it any more now the gain is gone, but leaving a variable called gPaint
   * holding the unworn value is how this bug happened once already. */
  gPaint = pk;
  // Dirt banks up against the ridge of the film, so the paint is surrounded by
  // a darker halo rather than meeting the road at a line.
  float halo = sstep(0.05, 0.55, paint.x) * (1.0 - sstep(0.55, 0.95, paint.x));
  c *= 1.0 - halo * 0.22;

  diffuseColor.rgb = c;
  /* A flat mid grey, overriding every albedo term in this file. If the near-road
   * crop still shows a field of stones with this on, then nothing drawn in this
   * shader body is responsible for them and the search moves elsewhere. */
#ifdef DEBUG_ROAD_FLAT_ALBEDO
  diffuseColor.rgb = vec3(0.18);
#endif

  /* ---- roughness ---- */
  float rmap = texture2D(roughnessMap, vRoughnessMapUv).g;
  /* Base level.
   *
   * A dry road in daylight is 0.85–0.95 and that number is what instinct
   * reaches for, but a city street after dark is never dry in that sense.
   * There is condensation, there is the film of oil and rubber that every
   * surface in a street carries, and the aggregate has been polished flat by
   * traffic. The result is a surface that is genuinely semi-glossy, and it is
   * the *only* reason a night road shows you where the lamps are. Authoring
   * this at the dry value is the single change that turns a night street back
   * into a grey carpet. */
  /* The dry road is genuinely rough — much rougher than the previous pass
   * allowed. Authoring the whole carriageway semi-glossy to get a sheen was
   * backwards: it removed the contrast the sheen is supposed to have against
   * something, and left one uniformly satin surface. The gloss has to be
   * *located*, and everything not in a damp patch or a wheel path should look
   * like the coarse stone it is. */
  float rgh = mix(0.86, 0.72, smearFine) * mix(0.92, 1.08, rmap);
  // Silt is dust lying loose. Nothing about it is glossy, and letting the
  // channel keep the road's sheen would put a highlight along the kerb line —
  // the same emissive-strip read the review objected to on the kerb nose.
  rgh = mix(rgh, 0.98, gSilt * 0.9);
  /* Tyre polish, but nowhere near a gloss.
   *
   * The wheel paths at 0.30 against a centre strip at 0.90 is a roughness step
   * of three to one, laid out as bands running the length of the street. Under
   * a lamp that is the effect; under a low sun it is a set of long specular
   * rails converging on the vanishing point, and it was carrying most of the
   * visible streaking once the environment gain was accounted for. Polished
   * asphalt is still asphalt. */
  rgh = mix(rgh, 0.56, track * 0.80);               // polished by tyres
  rgh = mix(rgh, 0.88, centreStrip * 0.45 * (1.0 - track));
  rgh = mix(rgh, 0.165, seam * 0.90);
  rgh = mix(rgh, 0.98, crack * 0.85);   // a raw fracture face scatters
  rgh = mix(rgh, 0.95, clip * 0.7);                // bare bitumen is glassy
  rgh = mix(rgh, 0.13, oil * 0.92);
  rgh = mix(rgh, 0.94, silt * 0.75);                // dry dust kills it dead
  // Water. This is the only place in the file allowed to go really low, and
  // the jump from the dry value has to be large or there is no patchwork.
  rgh = mix(rgh, 0.075, damp * 0.94);
  rgh = mix(rgh, 0.022, pool * 0.96);
  rgh = mix(rgh, 0.78, pk * 0.70);                  // chalky paint
  rgh = mix(rgh, 0.20, pk * pool * 0.9);
  // The lengthways smear, applied last so it modulates everything.
  /* Chip sparkle.
   *
   * The baked roughness mips away by about eight metres, and a road that goes
   * perfectly smooth in the mid-field is the thing that reads as a shader.
   * This is evaluated per fragment rather than sampled, so it survives to any
   * distance and gives the polished aggregate the low dull twinkle it has
   * under a lamp. Kept coarse enough (25 mm) not to shimmer. */
  rgh *= 0.86 + 0.28 * unit(wfbm(p * 40.0, 2));
  // Polished stone faces are smoother than the binder they sit in.
  rgh = mix(rgh, rgh * 0.42, agS * 0.80);   // tyre-polished stone faces
  rgh = mix(rgh, 0.99, agSock * 0.85);      // raw fracture inside a socket
  // Halved, for the same reason the wheel paths were: this term varies almost
  // entirely along the street, so its contrast becomes down-street banding.
  rgh *= mix(0.91, 1.08, smear);
  /* Roughness floor, raised hard for daylight.
   *
   * 0.035 was authored so that a damp patch under a sodium lamp would return a
   * long specular streak, and against one dim source at night that was the
   * right call. Under a low sun it is a disaster: the key is orders of
   * magnitude stronger, so a near-mirror floor turns the whole carriageway
   * into polished glass and every square metre of the material work underneath
   * disappears behind a sheet of reflected sky. Damp asphalt in daylight is
   * still rough; it is the *contrast* between damp and dry that reads, not an
   * absolute gloss. */
  roughnessFactor = clamp(rgh, 0.40, 1.0);

  /* The grazing sheen used to be applied by pulling roughness down with the
   * view angle, and that was the bug behind the streaking.
   *
   * The code that stood here read, in effect,
   *
   *     roughnessFactor *= mix(1.0, 0.55, f(viewAngle));
   *
   * which makes a *surface property* a function of where the camera is. Under
   * one dim lamp at night nobody could see it. Under a four-degree sun it is
   * ruinous, and in exactly the way the critique described: every patch of
   * road within about forty metres is near grazing, so the whole mid-field had
   * its roughness cut by nearly half, the sun's specular lobe narrowed to
   * something like alpha 0.02, and the low sun's glitter path — which for an
   * eye at 1.65 m and an elevation of 4.2 degrees is centred twenty-two metres
   * ahead, right where the frame is widest — turned into long hard smears. The
   * anisotropic normal flattening then stretched each one down the street, so
   * they radiated from the vanishing point; and because the term that produced
   * them was a function of the view, they swam with the camera instead of
   * staying stuck to the tarmac. Every symptom in the report follows from that
   * one line.
   *
   * A grazing surface genuinely does get brighter, but the mechanism is
   * Fresnel on the *reflection*, not a change in the roughness of the stone.
   * So the road keeps its roughness, and the sheen is applied where it
   * belongs, to indirect specular alone, in ROAD_SHEEN below. A reflection is
   * allowed to depend on the view. A surface is not.
   */
  float dist = length(vWPos - cameraPosition);
  // Distance-dependent floor stays: at long range one pixel integrates square
  // metres of road, so its effective roughness really is higher than the value
  // authored for a square centimetre. This is prefiltering, not a look.
  roughnessFactor = clamp(roughnessFactor, mix(0.44, 0.62, sstep(14.0, 55.0, dist)), 1.0);
}
`;

const ROAD_NORMAL_HOOK = /* glsl */ `
#ifdef USE_NORMALMAP_TANGENTSPACE
  vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
  vec3 mapB = texture2D( normalMap, vNormalMapUv * 0.413 + vec2(0.317, 0.611) ).xyz * 2.0 - 1.0;
  float nMix = sstep(0.30, 0.70, unit(wfbm(vWPos.xz * 0.075, 3)));
  mapN = normalize(mix(mapN, mapB, nMix * 0.45));
  mapN.xy *= normalScale;
  // Macro relief, differenced in world space. uv on this mesh is world XZ in
  // metres, so the tangent frame lines up with X and Z and the gradient can be
  // dropped straight into the tangent-space normal.
  vec2 wp = vWPos.xz;
  float e = 0.055;
  float gx = (macroH(wp + vec2(e, 0.0)) - macroH(wp - vec2(e, 0.0))) / (2.0 * e);
  float gz = (macroH(wp + vec2(0.0, e)) - macroH(wp - vec2(0.0, e))) / (2.0 * e);
  mapN.xy -= vec2(gx, gz) * 3.1;
  // Per-chip shading, computed in the body where nothing prefilters it.
  mapN.xy += gChipN;

  /* Anisotropy, which is the whole reason a wet road reads as wet.
   *
   * A reflection in standing water is not a round highlight, it is a smear
   * several times taller than it is wide, running away from the viewer towards
   * the source. That happens because the surface is smooth along the direction
   * of view and disturbed across it — think of the water as a cylinder lying
   * down the street. So under water the normal keeps its variation across the
   * carriageway and loses almost all of it along the street, and the highlight
   * stretches lengthways on its own.
   *
   * A real anisotropic BRDF is System 8; this reproduces the read for the cost
   * of two multiplies, because the tangent frame here is already aligned with
   * world X and Z. */
  float aniso = max(gDamp, gPool);
  /* 0.16 was too far. Removing almost all the down-street normal variation
   * turns every specular event into a streak that runs the whole length of the
   * wet patch and beyond, which under a lamp was the point and under a low sun
   * is half the reason the carriageway smeared. */
  mapN.y *= mix(1.0, 0.45, aniso);
  mapN.x *= mix(1.0, 0.80, aniso);

  /* Ripple. Without it the smear is a clean airbrushed streak, which is what
   * the first attempt looked like. Real water is never still on a street —
   * there is wind and there is traffic — and the smear breaks up into a
   * horizontal ladder. Varying almost entirely in X keeps the breaks across
   * the streak instead of along it. */
  float rip = wfbm(vec2(wp.x * 5.5, wp.y * 0.30), 3)
            + wfbm(vec2(wp.x * 17.0, wp.y * 0.85), 2) * 0.4;
  mapN.x += rip * 0.42 * aniso;

  normal = normalize( tbn * normalize(mapN) );

  /* Specular antialiasing, and this is the other half of the streaking fix.
   *
   * At a grazing view a single pixel of mid-field carriageway covers square
   * metres of a normal field that varies at the scale of an aggregate chip.
   * Evaluating a narrow GGX lobe against one point sample of that field is
   * undefined in the only sense that matters — the answer swings wildly for a
   * sub-pixel change of camera position, which is precisely the "will look far
   * worse in motion" the review predicted.
   *
   * Widening the lobe by the screen-space variance of the shading normal is
   * the standard remedy and it is a filtering correction rather than a taste
   * one: the roughness a pixel should use is the roughness of the *distribution
   * of normals inside it*, not of the one at its centre. Costs two derivatives.
   */
  vec3 dnx = dFdx(normal), dny = dFdy(normal);
  float nvar = 0.5 * (dot(dnx, dnx) + dot(dny, dny));
  /* Two terms, and they are kept separate because they measure two different
   * things and neither can do the other's job.
   *
   * The derivative term sees features that span a few pixels: the baked normal
   * map between mip levels, the macro relief, the ripple on standing water.
   * The analytic term is the variance the chip loop declined to draw because
   * it was below the footprint — see gNVar. Adding them is correct because
   * both are variances of the same distribution, and capping them separately
   * is deliberate: the first cap is signed-off behaviour from the streaking
   * round and moving it would move the sunlit glitter path with it, while the
   * second bounds only the new term and can be reasoned about on its own. */
  float alpha = roughnessFactor * roughnessFactor
              + min(nvar * uSpecAA.x, uSpecAA.y)
              + min(gNVar * 2.2, 0.30);
  roughnessFactor = clamp(sqrt(alpha), 0.0, 1.0);
#endif
`;

const ROAD_RETRO = /* glsl */ `
/* Retroreflection.
 *
 * Marking brightness had been tuned twice by moving albedo and had landed in
 * the wrong place both times — once reading as a clean decal, once invisible —
 * because albedo is the wrong control for this material. Thermoplastic is
 * seeded with glass beads that send light back along the path it arrived on,
 * so what a viewer sees is not a fixed reflectance but a strong function of
 * how much light is falling on that patch of paint. Under a lamp it is by a
 * long way the brightest thing on the carriageway; ten metres outside the pool
 * it is barely lighter than the road, and no albedo value can express both.
 *
 * Taking the diffuse irradiance that has already been accumulated for this
 * fragment and returning a multiple of it where paint is present gives that
 * behaviour directly: the gain applies to light that is actually arriving, so
 * lit paint blazes and unlit paint stays dirty and grey on its own.
 */
#include <lights_fragment_end>

/* This block was never installed.
 *
 * ROAD_RETRO was written, reasoned about at length, and then not passed to any
 * replace() call — the road material patched roughnessmap_fragment and
 * normal_fragment_maps and stopped there. So every word above described
 * behaviour the renderer never had, and the markings have been rendering as
 * plain dull paint for the whole project. Found while tracing where the road's
 * specular actually comes from.
 */
/* The retroreflective gain, removed, and this is the half that was doing the
 * damage.
 *
 * The albedo half of this premise went last round: 0.42 sized so a headlamp
 * would bounce back off the glass beads. The premise was implemented twice, and
 * the second copy — a 3.4× gain on direct diffuse, so paint received about four
 * and a half times the light of the road beside it — was still live. The physics
 * is the same and is still wrong for this scene: beads return light toward the
 * source, the source is the sun, and what reaches this camera is plain diffuse.
 *
 * The worse defect was the term it was keyed to. gPaint was the raw coverage
 * from roadPaint(), sampled at :640, before any of the wear existed. The worn
 * value pk — carrying the fret, the chip, the fray, the cavity showthrough, the
 * tyre scuff and the track scrubbing — was computed a hundred and fifty lines
 * later and used only to blend albedo, which this gain then rode straight over.
 * So two rounds of adding wear to the markings were adding it to a value that
 * was subsequently overwritten by a hard-edged binary mask. That is the whole
 * explanation for "crisp, uniform, unbroken" surviving every attempt to break it
 * up: the wear was real, authored, and then discarded downstream. */

/* The grazing sheen, cut to a trim rather than a multiplier.
 *
 * The previous version applied 1 + 2.6 * pow(grazing, 5), which at the
 * grazing angles that fill a street-level frame is a factor of three and a
 * quarter on top of an already overdriven environment gain. It was also
 * double-counting: the split-sum approximation in the standard material
 * already applies a Fresnel term to indirect specular, so the physical
 * brightening at grazing incidence was being added a second time by hand.
 *
 * What is left is a small correction for the fact that the approximation
 * undershoots at the extreme end of the range, and nothing more.
 */
float grz = 1.0 - abs(dot(normalize(cameraPosition - vWPos), vec3(0.0, 1.0, 0.0)));
reflectedLight.indirectSpecular *= 1.0 + 0.45 * pow(clamp(grz, 0.0, 1.0), 6.0);

/* Sky fill on the carriageway.
 *
 * With the reflection back at a physical level the road has to earn its value
 * from diffuse, and diffuse in a canyon at this hour is the slot of sky
 * overhead. Asphalt is a poor reflector but it is not a black hole, and shaded
 * tarmac in a real golden-hour photograph is a legible cool grey with the
 * shadow shapes crisp on it. */
reflectedLight.indirectDiffuse =
  canyonSky(reflectedLight.indirectDiffuse, vWNormal, vWPos.y) * 1.85 * gChipAO;

/* A crevice sees the zenith, not the dome, and that is where the colour comes
 * from.
 *
 * Occluding the sun from the pits was necessary but on its own it only made them
 * darker, because the sky filling them is the scene probe — the whole dome,
 * including the sunward horizon which at this hour is eleven times everything
 * else and is warm. So the pits came out dark orange and the surface still read
 * as dry riverbed. But a gap two centimetres wide between two stones cannot see
 * the horizon at all: its entire view of the sky is a narrow cone straight up,
 * and that cone is the blue-violet zenith. The ratio used here is the one
 * tools/skyprobe.mjs measures for a slot of pure zenith, the same figure the
 * canyon term uses on the walls.
 *
 * canyonSky deliberately leaves horizontal surfaces almost untinted — a level
 * deck really does see the dome, and the paving in shade was praised and must not
 * move — so this cannot be folded into it. It is keyed to enclosure instead of to
 * orientation, which is what distinguishes the two cases: the road plane is open
 * and stays neutral, the micro-cavities in it are not and go cool. */
float enclosed = 1.0 - gChipAO;
reflectedLight.indirectDiffuse *= mix(vec3(1.0), vec3(0.52, 1.00, 2.30),
                                      clamp(enclosed * 1.15, 0.0, 1.0));

/* Desaturation of the sun's contribution to the carriageway, and this one is a
 * grade rather than a correction. It is labelled as such because the difference
 * matters to whoever reads this next.
 *
 * Everything above is physics and none of it brought the road's saturation down:
 * neutralising the albedo to within three per cent of grey moved the measured
 * crop by twelve thousandths, because at this hour a horizontal plane is lit by a
 * four-degree sun and by a dome whose brightest region by an order of magnitude
 * is the warm horizon around that sun. A road under that light genuinely is warm,
 * and there is no honest surface parameter left that makes it otherwise — the
 * remaining levers are the sun colour and the exposure, and both are fixed by
 * other requirements and have been praised where they show.
 *
 * So the request to halve the road's saturation is met where it actually lives,
 * by pulling the sun's own contribution toward its luminance. Applied to the
 * direct channels only, so the sky term keeps its full chroma and the cool fill
 * in the shadowed parts gains on the warm fill in the lit parts, which is the
 * direction the review wants. Physically this stands in for spectral effects the
 * renderer does not model — three RGB primaries badly overstate the saturation of
 * a broad-spectrum source at low elevation — but that is a rationalisation after
 * the fact and should not be dressed up as the reason. */
float dsun = dot(reflectedLight.directDiffuse, vec3(0.2126, 0.7152, 0.0722));
reflectedLight.directDiffuse = mix(vec3(dsun), reflectedLight.directDiffuse, 0.50);
float ssun = dot(reflectedLight.directSpecular, vec3(0.2126, 0.7152, 0.0722));
reflectedLight.directSpecular = mix(vec3(ssun), reflectedLight.directSpecular, 0.50);
reflectedLight.indirectSpecular *= gChipAO;

/* Inter-facet shadowing on the aggregate, applied to the sun's own lobe.
 *
 * Splitting the two specular channels settled where the road's brightness comes
 * from, and it is not where the paragraph on envMapIntensity above assumed.
 * Measured on the near-road crop:
 *
 *   as rendered                     0.418 0.312 0.265
 *   direct specular zeroed          0.259 0.183 0.178
 *   indirect specular zeroed        0.417 0.310 0.262
 *
 * The reflection of the sky is worth four parts in a thousand. Thirty-eight per
 * cent of the sunlit carriageway is the sun's own specular lobe at four degrees
 * of elevation, which is the silver sheen every road has looking into a low sun
 * and is not something to remove.
 *
 * It is however overstated, and for a reason specific to this surface. The
 * standard model is single-scattering GGX: it accounts for facets shadowing each
 * other within the statistical distribution, but the distribution it uses is a
 * smooth lobe fitted to a roughness value, and it knows nothing about the actual
 * five-to-ten millimetre relief of a chipping surface. At an incidence of four
 * degrees a large share of the facets the BRDF counts as both visible and lit
 * are in fact standing behind a neighbouring stone. The geometry needed to say
 * so is already computed here — gChipAO is precisely how much of the sky a point
 * between the stones can see — and it was being applied to both indirect
 * channels and to neither direct one, which is backwards: the effect is
 * strongest for the channel with the most grazing incidence.
 *
 * Left at a little over three quarters after occlusion, so the sheen still
 * carries the wheel paths and the crown, but no longer sits on top of the
 * aggregate as an even wash. That wash is most of "glows like gravel lit from
 * within": a warm veil at constant strength over the whole surface, unmodulated
 * by any of the shading that distinguishes a stone's lit face from its dark one,
 * which is exactly the report that the chips' shadow sides are brown. */
reflectedLight.directSpecular *= gChipSun * 0.78;

/* The sun, occluded by the aggregate that is standing in its way.
 *
 * This is the term that gives the surface its chromatic split. Everything below a
 * chip's horizon now receives sky and nothing else, and the sky in this canyon is
 * blue-violet, so the pits go cool while the tops stay orange. */
reflectedLight.directDiffuse *= gChipSun;
#ifdef DEBUG_NO_ROAD_SPEC
reflectedLight.directSpecular = vec3(0.0);
reflectedLight.indirectSpecular = vec3(0.0);
#endif
/* Split, because "the specular is forty per cent" is not actionable until you
 * know which lobe. Damping the indirect by nearly half moved the measured crop
 * by one part in three hundred, which says the share is not where it was
 * assumed to be. */
#ifdef DEBUG_NO_ROAD_DIRSPEC
reflectedLight.directSpecular = vec3(0.0);
#endif
#ifdef DEBUG_NO_ROAD_INDSPEC
reflectedLight.indirectSpecular = vec3(0.0);
#endif
`;

export function makeRoadMaterial(set: SurfaceSet): THREE.MeshStandardMaterial {
  tile(set, set.patch);
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    /* The carriageway casts as well as receives.
     *
     * At four degrees the sun rakes so hard that the road's own relief — the
     * crown, the settlement waves, the dish around each casting, the lip of a
     * trench reinstatement — throws shadows a metre or more long across the
     * surface. That is the only source of genuinely diagonal long shadows in
     * frame until buildings exist, and it is free: the geometry is already
     * there. Like the kerb this is an open surface, so it needs its front
     * faces in the shadow pass to write anything at all. */
    shadowSide: THREE.FrontSide,

    /* From 1.62. The baked map carries a grain at roughly a millimetre a texel
     * over the whole carriageway, and at 1.62 it was being shaded hard enough to
     * cover every square centimetre of the surface in relief. That is the last
     * place the "no binder anywhere" read was still coming from: the analytic
     * chips are now correctly sparse, but the matrix they were meant to sit in
     * was itself a continuous field of grit, so the eye still had nowhere to see
     * bitumen. Bitumen between the stones is close to smooth at this distance —
     * it is a poured binder, not a sand finish — so the map is turned down to
     * where it reads as fine surface tooth rather than as aggregate in its own
     * right, and the stones are left to be the only things with real relief.
     *
     * Tried at 0.92 and reverted. Turning the grain down does not reveal binder,
     * it reveals the bake's own diagonal weave — the lattice artifact this map
     * has always had and which the strong shading was masking. A woven surface is
     * a worse failure than a granular one, so the map stays where it is and the
     * binder is left to be established by the chip coverage and the wear
     * structure instead. Fixing the weave means rebaking the source noise, which
     * is a bigger change than this round has room for.
     *
     * That was wrong, and the experiment that shows it is in shots/inert. Forcing
     * every albedo term in this shader to a flat grey leaves the near-road crop
     * essentially unchanged — still a wall-to-wall field of stones. Disabling this
     * map instead leaves a smooth binder plane with a scattered minority of
     * chippings on it, which is what the analytic loop was rewritten to produce
     * and what was reported last round as done. So the aggregate a viewer sees in
     * the near field has never been the analytic layer at all: it is this baked
     * map, shading a uniform grain across a hundred per cent of the carriageway,
     * and it is why dropping the analytic coverage floor from 0.68 to 0.04 moved
     * the measured saturation by twelve thousandths. Four rounds of tuning the
     * chip model were tuning something that was almost invisible underneath this.
     *
     * At 0.30 the map contributes fine surface tooth and nothing that reads as a
     * stone, the analytic chips become the only aggregate in the picture, and two
     * further things follow for free: the grain now compresses with distance and
     * dissolves by fifteen metres, because the analytic layers fade out on pixel
     * footprint whereas a tiled map never does; and the bake's diagonal weave —
     * which appeared when this was tried at 0.92 — is far enough down to be
     * invisible rather than being the dominant feature. */
    normalScale: new THREE.Vector2(0.30, 0.30),
    /* Back to unity, and this is the streaking fix.
     *
     * 3.4 was chosen when the environment was a nearly black night sky and the
     * road's reflection of it needed forcing to be visible at all. The golden
     * hour sky is one to two orders of magnitude brighter, and the same
     * multiplier against it made the carriageway a mirror returning several
     * times the energy that fell on it.
     *
     * That is what produced the streaks, and the measurement is unambiguous:
     * with both specular lobes zeroed the road goes featureless near-black and
     * every smear disappears, so all of its brightness was reflection. Because
     * the roughness field is deliberately stretched down the street, that
     * reflection printed as bright and dark bands running with the street axis
     * — which in perspective converge on the vanishing point — and because a
     * grazing reflection direction swings hugely for a small camera move, they
     * swam with the camera exactly as reported.
     *
     * It also explains the shadows. Indirect specular is not attenuated by the
     * shadow map, so when nearly all of a surface's brightness arrives through
     * that channel a shadow can only remove the few percent that came direct,
     * and every cast shadow on the carriageway degenerates into a faint smudge
     * no matter how sharp the shadow map is. Putting the road's brightness back
     * into diffuse is what lets shadows read at all. */
    /* 1.15 to 0.70, and the note above predicted this measurement without
     * anyone taking it.
     *
     * Capturing the near-road crop twice, once normally and once with
     * DEBUG_NO_ROAD_SPEC, puts the specular lobes at about forty per cent of the
     * sunlit carriageway: mean 0.420 against 0.255 with them gone. For a
     * dielectric with an F0 of 0.04 at a roughness of 0.86 that is far too large
     * a share, and it is the reason three separate symptoms would not respond to
     * anything done to the surface.
     *
     * It is why the road stayed brown when its albedo was made decisively blue —
     * two fifths of the pixel never consults the albedo at all, so the change was
     * diluted to almost nothing and the measured saturation moved from 0.380 to
     * 0.375. It is why the aggregate and the wear structure read as flat: a
     * uniform reflected wash sits on top of every bit of contrast the surface
     * has. And it is the shadow complaint, exactly as the paragraph above this
     * one anticipated — the shadow map attenuates only the direct term, so where
     * forty per cent of the light arrives through an unshadowed channel a cast
     * shadow can never be more than a weak grey wash, which is what "shadows have
     * lost their identity as shadows" describes.
     *
     * The excess is real rather than a matter of taste. scene.environment is a
     * single unoccluded probe, so the split-sum lobe integrates over the whole
     * dome including the sunward horizon that the building opposite is standing
     * in front of, and at this hour that horizon is eleven times the brightness
     * of the rest of the sky. The diffuse channel has been corrected for that
     * since the canyon term was written; the specular channel never was.
     *
     * That last paragraph turned out to be a wrong guess and is kept because the
     * measurement that disproved it is worth recording: zeroing indirect
     * specular alone changes the sunlit road by four parts in a thousand. The
     * reflection of the sky is not the issue; the sun's own lobe is. See the note
     * on inter-facet shadowing in ROAD_RETRO.
     *
     * The correction is applied in ROAD_RETRO, not here. This field is inert:
     * the image-based light arrives from scene.environment rather than from a
     * per-material envMap, and in that case three takes the strength from
     * scene.environmentIntensity alone, so every envMapIntensity in the project
     * is decorative. Setting this to 0.70 changed the measured crop by three
     * thousandths, which is how the fact got rediscovered. */
    envMapIntensity: 1.15,
    dithering: true,
  });
  applySet(m, set);

  /* Attribution switch for the specular streaking investigation. With
   * ?nospec on the URL the road keeps its albedo, normals and roughness and
   * loses only its specular lobes, which is the one measurement that says
   * whether a suspect feature lives in the reflection or in the surface. */
  if (typeof location !== 'undefined' && location.search.includes('nospec')) {
    m.defines = { ...(m.defines ?? {}), DEBUG_NO_ROAD_SPEC: '' };
  }
  /* The companion switch, for the temporal-stability investigation.
   *
   * DEBUG_ROAD_NO_CHIPS has existed in the shader since the attribution round
   * on saturation but was never reachable from outside a recompile. The
   * shimmer measurement needs exactly this pairing — the same walk with the
   * analytic chip layer in and out — because the chip loop is the one part of
   * the road evaluated per fragment with nothing prefiltering it, and it is
   * the difference between the two runs that says whether it is the cause. */
  if (typeof location !== 'undefined' && location.search.includes('nochips')) {
    m.defines = { ...(m.defines ?? {}), DEBUG_ROAD_NO_CHIPS: '' };
  }

  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, artificialUniforms());
    shader.uniforms.uRoadHalf = { value: DIMS.roadHalf };
    // Sun azimuth on the ground plane, so each chip knows which of its own
    // flanks is facing the light.
    shader.uniforms.uSunXZ = {
      value: new THREE.Vector2(SUN_DIR[0], SUN_DIR[2]).normalize(),
    };
    shader.uniforms.uSpecAA = { value: specAAFromUrl() };
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `${WORLD_VARYINGS}\nvarying float vSettle;\nattribute float aSettle;\nvoid main() {`)
      .replace('#include <begin_vertex>', `${VERTEX_HOOK}\nvSettle = aSettle;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${NOISE}\n${ROAD_FRAG_HEAD}\n${CANYON}\n${ARTIFICIAL}\nvoid main() {`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${ROAD_FRAG_BODY}`)
      .replace('#include <normal_fragment_maps>', ROAD_NORMAL_HOOK)
      .replace('#include <lights_fragment_end>', ROAD_RETRO + ARTIFICIAL_ADD);
  };
  m.customProgramCacheKey = () => 'night-street-road';
  return m;
}

/* ── Footway ────────────────────────────────────────────────────────────── */

const WALK_SCREED = /* glsl */ `
/* Analytic near-field concrete.
 *
 * The footway had been carrying its surface entirely in a baked map, and a
 * baked map has a fixed texel density: by two metres from the camera one texel
 * covers several pixels and every trace of grain has been filtered away. Three
 * separate reviews called the result untextured plastic and said the flags
 * could only be told from the road by brightness, which is exactly the symptom
 * — the material was legible in the bake and absent on screen.
 *
 * So it is evaluated per fragment in world space instead, the same way the
 * aggregate is, with each component fading out only once it drops below the
 * pixel footprint. Four things are actually visible on a float-finished
 * pavement at arm's length, and all four are here: the sand grain of the
 * matrix, the curved swirl the float leaves, the parallel drag of the broom
 * that follows it, and the small round air voids the mix could not release,
 * plus the occasional popout where one has spalled into a crater.
 */
struct Screed { float t; vec2 n; float r; };

uniform float uSlab;
uniform float uJoint;

Screed screed(vec2 p, float px){
  Screed o; o.t = 0.0; o.n = vec2(0.0); o.r = 0.0;

  // Sand grain, 0.6mm. Below the footprint for most of the frame; it is what
  // makes the last two metres read as concrete rather than as paper.
  float gv = 1.0 - sstep(0.35, 1.1, px / 0.0006);
  if (gv > 0.004){
    float g = unit(wfbm(p * 1650.0, 2));
    o.t += (g - 0.5) * 1.05 * gv;
    // Relief pared right back everywhere in this function; see the note on the
    // sand block below. What used to be slope is now tone.
    o.n += (vec2(g, unit(wfbm(p * 1650.0 + 37.0, 2))) - 0.5) * 0.34 * gv;
  }

  /* Float swirl: the broad arcs a power float leaves behind.
   *
   * Kept deliberately slack. A first attempt took a sine of a heavily warped
   * field, which is a contour plot of that field: the flags came out covered
   * in dense closed loops that read as wood grain or a fingerprint, a far
   * worse artifact than the flatness it was meant to cure. The warp has to
   * stay well under the wavelength for the result to be arcs rather than
   * contours, so the frequency is low and the displacement is small. */
  vec2 sw = vec2(wfbm(p * 1.1, 3), wfbm(p * 1.1 + 19.0, 3));
  /* The float arcs have to differ flag to flag.
   *
   * A power float is swung by hand in overlapping arcs, and the sweep a
   * finisher makes on one bay has nothing to do with the next. Driving the
   * swirl from world position alone gave every flag the same fan at the same
   * angle in the same corner, which at a grazing raking light is the single
   * most obvious repeat on the footway — the eye locks onto it immediately and
   * the whole surface collapses into wallpaper. Each flag now gets its own
   * centre, its own sweep direction and its own arc spacing. */
  vec2 fid = floor(p / uSlab);
  vec2 fc = vec2(hash21(fid + 3.1), hash21(fid + 88.9));
  float fa = fc.x * 6.2831;
  vec2 fdir = vec2(cos(fa), sin(fa));
  vec2 fperp = vec2(-fdir.y, fdir.x);
  vec2 q = p + sw * 0.22 + fc * 13.0;
  float pitchF = 3.4 + fc.y * 2.4;
  float swirl = sin(dot(q, fdir) * pitchF + dot(q, fperp) * (1.1 + fc.x * 1.6));
  /* The float arcs are a hint, not a motif.
   *
   * At the strength these were authored they are the dominant feature of every
   * flag — a clean fan of light arcs sweeping from one corner, which together
   * with the scratch strokes reads as brushed varnish on timber rather than as
   * concrete. On a real float finish the arcs are barely there: you see them
   * when the light rakes and not otherwise, and what you actually read the
   * surface by is the sand. */
  o.t += swirl * 0.020;
  o.n += fperp * swirl * 0.012;

  /* Sand grain, air voids and popouts — the things that make it chalky.
   *
   * Concrete is a sand mortar with holes in it. Screeding brings fines to the
   * top, but underneath there is always coarse sand catching the light, voids
   * left by air that did not escape the mix, and craters where a piece of
   * near-surface aggregate has frozen, spalled or simply been kicked out. None
   * of this was present, which is why the surface reads as a fired glaze — it
   * had a colour and a sheen but no material. */
  /* This block is what makes the sunlit footway read as crushed white stone, and
   * the fault is that it is the one part of this function with no footprint gate.
   *
   * Every other component here fades on px — the 0.6 mm grain through gv, the
   * broom drag through bv — because that is the whole design of an analytic
   * surface: a feature is drawn while it is larger than a pixel and withdrawn
   * once it is not. The sand, the voids and the popouts were never given one, so
   * they ran at full amplitude from the lens to the vanishing point. That single
   * omission produces all three reported symptoms at once. The grain does not
   * compress with distance, because nothing was ever asking it to. The speckle
   * terminates abruptly at a distance rather than dissolving, because the terms
   * that *do* have gates withdraw around there and leave this one running alone.
   * And it blows out under raking light, because a 0.42 normal perturbation
   * against a sun four degrees up swings N·L between roughly 0.07 and 0.5 — a
   * sevenfold change in direct light across two adjacent pixels of what is meant
   * to be a smooth flag.
   *
   * Worth naming the diagnostic error too: the baked normal map was suspected
   * first, by analogy with the road. Zeroing normalScale on every material in the
   * scene changed this region by nothing at all, because these terms are added
   * after that multiply and are not scaled by it. */
  /* Tone, not slope, and that division is the whole of the remedy.
   *
   * o.t multiplies albedo and o.n tilts the normal, and against a
   * four-degree key those two are not comparable currencies. A tone term of
   * ten per cent is ten per cent of the pixel wherever the sun is; a slope term
   * of the same nominal size moves N·L between 0.07 and 0.5 and is therefore a
   * sevenfold swing between neighbouring pixels. That is what turned this
   * surface into a bed of white granules, and no roughness value damps it.
   * So every relief amplitude in this function is now a fraction of what it
   * was, and the detail those terms used to carry has been moved into o.t. */
  float sv = 1.0 - sstep(0.35, 1.1, px / 0.0048);
  float sand = unit(wfbm(p * 210.0, 2));
  o.t += (sand - 0.5) * 0.175 * sv;
  o.n += (vec2(unit(wfbm(p * 210.0 + 17.0, 2)), unit(wfbm(p * 210.0 + 71.0, 2))) - 0.5)
       * 0.035 * sv;

  float vv = 1.0 - sstep(0.35, 1.1, px / 0.022);
  float voidF = unit(wfbm(p * 46.0 + 5.0, 2));
  float voids = sstep(0.80, 0.93, voidF);
  o.t -= voids * 0.30 * vv;
  float pv = 1.0 - sstep(0.35, 1.1, px / 0.067);
  float pop = sstep(0.955, 0.985, unit(wfbm(p * 15.0 + 61.0, 3)));
  o.t -= pop * 0.42 * pv;
  o.n += normalize(vec2(0.6, -0.8)) * pop * 0.10 * pv;

  /* Broom drag: parallel striations across the footway, 12mm pitch, wandering
   * slightly and breaking up where the bristles skipped. Across the walk, not
   * along it — a broom is drawn kerb to wall. */
  float bv = 1.0 - sstep(0.35, 1.1, px / 0.012);
  if (bv > 0.004){
    float wander = wfbm(p * 5.5, 2) * 0.006;
    float b = sin((p.y + wander) * 523.6);
    float skip = sstep(0.30, 0.62, unit(wfbm(vec2(p.x * 3.0, p.y * 0.7), 2)));
    o.t += b * 0.105 * bv * skip;
    o.n += vec2(0.0, b) * 0.26 * bv * skip;
    o.r += b * 0.02 * bv * skip;
  }

  /* Entrained air voids, 1.5-3mm, and rarer popout craters an order larger.
   * Both are holes, so both go dark and neither gets a highlight. */
  float av = 1.0 - sstep(0.35, 1.1, px / 0.0022);
  if (av > 0.004){
    float f2, id; vec2 rel;
    float d = wchip(p / 0.011, f2, id, rel);
    if (fract(id * 5.77) > 0.86){
      float hole = 1.0 - sstep(0.10, 0.26, d);
      o.t -= hole * 0.85 * av;
      o.n -= (rel / max(d, 1e-4)) * hole * 0.32 * av;
      o.r += hole * 0.01 * av;
    }
  }
  /* Named cv, not pv.
   *
   * This declaration collided with the popout gate added above it, and a
   * redeclaration in the same scope is a compile error. The program failed
   * silently — no console error, just a walk material that fell back to a flat
   * untextured plane, which reads as a lighting fault rather than a broken
   * shader. Every measurement of "the footway has no texture at all" was
   * measuring this. */
  float cv = 1.0 - sstep(0.35, 1.1, px / 0.010);
  if (cv > 0.004){
    float f2, id; vec2 rel;
    float d = wchip(p / 0.085 + 11.3, f2, id, rel);
    if (fract(id * 3.19) > 0.955){
      float cr = 1.0 - sstep(0.13, 0.30, d);
      float rim = sstep(0.13, 0.20, d) * (1.0 - sstep(0.20, 0.30, d));
      o.t -= cr * 0.70 * cv;
      o.t += rim * 0.55 * cv;          // raw broken edge, paler than the face
      o.n -= (rel / max(d, 1e-4)) * cr * 0.40 * cv;
    }
  }
  return o;
}
`;

const WALK_FRAG_HEAD = /* glsl */ `
vec2 gScreedN = vec2(0.0);
float gGraze = 0.0;
uniform float uBuildLine;
uniform float uKerbEdge;
uniform vec2 uSunXZ;
${WORLD_VARYINGS}

/* Joint layout.
 *
 * Two different things are cut into a sidewalk and they do not look alike. A
 * control joint is tooled into the wet concrete: a shallow rounded groove,
 * same material either side. An expansion joint is a real gap filled with
 * black bitumen felt, and it goes across the full width every few flags. Both
 * collect grit and neither is a black line. */
vec3 walkJoints(vec2 p, out vec2 slabId){
  /* One square module in both directions.
   *
   * The previous version used a 1.52 m grid and put expansion joints across
   * the footway every fourth flag but never along it, so the joints that
   * actually showed were four times further apart in one axis than the other
   * and the flags read as planks. Flags are square, the joints are the same
   * joint in both directions, and the module is small enough that several of
   * them are in the near field at once. */
  vec2 g = p / uSlab;
  vec2 cell = floor(g);
  vec2 f = abs(fract(g) - 0.5) * 2.0;      // 0 at flag centre, 1 at the joint
  slabId = cell;

  /* A joint with an inside.
   *
   * A hairline of darker colour is a scored line in a poured slab. A laid flag
   * has a real gap between it and the next one, 12–18 mm of it, with a dark
   * interior, a lip that has rounded off, and half a decade of grit in the
   * bottom. The two edges of the gap are what catch the light and they are the
   * only reason a pavement reads as separate stones at night. */
  float half_ = 1.0 - (uJoint / uSlab);
  float wobble = wfbm(p * 1.4, 2) * 0.010;
  float d = max(f.x, f.y);
  float joint = sstep(half_ - 0.02, half_ + 0.012, d + wobble);
  // The lip: a narrow band just inside the gap, worn round and slightly proud.
  float lip = sstep(half_ - 0.075, half_ - 0.012, d + wobble) * (1.0 - joint);

  return vec3(joint, lip, d);
}

/* Corner chips. Flags lose their corners first — every one of them, on a busy
 * street — and the break exposes pale unweathered aggregate. Keyed to the
 * corner rather than scattered, because a chip in the middle of a flag is a
 * stain and reads as one. */
float slabChips(vec2 p, vec2 cell){
  vec2 g = fract(p / uSlab);
  vec2 toCorner = abs(g - 0.5) * 2.0;
  float corner = toCorner.x * toCorner.y;
  float id = hash21(cell + 7.13);
  float size = 0.55 + 0.35 * id;
  float ragged = unit(wfbm(p * 26.0, 3)) * 0.22;
  return sstep(size, size + 0.30, corner + ragged) * step(0.42, id);
}

/* Chewing gum. Flattened, near-black, glossy discs, in clusters near where
 * people stand. Absurd as a modelling priority, and instantly recognisable —
 * a city pavement without them looks swept, and a swept pavement looks CG. */
float gumSpots(vec2 p){
  vec2 q = p * 1.15;
  vec2 w = wworley(q);
  float id = wworleyId(q);
  float density = sstep(0.35, 0.75, unit(wfbm(p * 0.22, 3)));
  float keep = step(0.80 - density * 0.16, id);
  return sstep(0.10 + 0.06 * fract(id * 29.0), 0.02, w.x) * keep;
}
`;

const WALK_FRAG_BODY = /* glsl */ `
{
  vec2 p = vWPos.xz;
  vec2 slabId;
  vec3 j = walkJoints(p, slabId);
  float joint = j.x, lip = j.y, edge = j.z;
  float chip = slabChips(p, slabId);

  float mixMask = sstep(0.30, 0.70, unit(wfbm(p * 0.09, 3)));
  vec4 sB = texture2D(map, vMapUv * 0.437 + vec2(0.713, 0.219));
  diffuseColor.rgb = mix(diffuseColor.rgb, sB.rgb, mixMask * 0.45);

  /* Per-flag tone. Poured on different days from different trucks, patched at
   * different times; a run of identical flags is the giveaway. A few are
   * obvious recent replacements and read distinctly paler. */
  float id = hash21(slabId + 0.5);
  float id2 = hash21(slabId + 31.7);
  float id3 = hash21(slabId + 113.1);
  /* Wider per-flag spread than before, and a cool/warm drift as well as a
   * value one. Flags come from different batches years apart; some are grey,
   * some are almost buff, and a run of them at one tone is the giveaway. */
  /* Flags are not one batch.
   *
   * A run of footway is patched over decades: an original flag next to one
   * relaid last year next to one lifted for a service and put back dirty. The
   * spread here was narrow enough that every flag sat within a few percent of
   * its neighbours, so the run read as a single moulded sheet with grooves
   * scored into it. Widening it, and letting a minority of flags read as
   * clearly newer and paler, is most of what makes a pavement look laid rather
   * than printed. */
  /* Sized against the frame rather than against the idea.
   *
   * The authored spread ran the per-flag multiplier from 0.32 to 1.05 — a
   * three-to-one step between neighbours — which on screen is not a pavement
   * laid over decades but a chequerboard. What differential staining actually
   * measures on a sunlit footway is a handful of luminance units between one
   * flag and the next, so the spread is now about twelve per cent either side
   * of the mean, and the mean is held where it was so the overall level of the
   * footway does not move. The paler minority stays, at a size that reads as a
   * replaced flag rather than as a light box. */
  float fresh = sstep(0.82, 0.94, id2);
  diffuseColor.rgb *= 0.60 + 0.17 * id;
  diffuseColor.rgb *= mix(1.0, 1.17, fresh);
  diffuseColor.rgb *= mix(vec3(0.94, 0.975, 1.055), vec3(1.025, 1.00, 0.975), id3 * 0.75);
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.13, 1.12, 1.10), step(0.90, id2) * 0.7);

  /* Traffic film. Everything in a city is dirtiest where it is walked on and
   * where road spray reaches it, which is the kerb edge. */
  float kerbSide = sstep(4.6, 3.95, abs(p.x));
  float footfall = sstep(0.25, 0.85, unit(wfbm(vec2(p.x * 0.55, p.y * 0.12), 3)));
  diffuseColor.rgb *= 1.0 - kerbSide * 0.30 - footfall * 0.14;
  /* Joints hold grit and moss, not void. Rendered as a uniform-width black
   * groove they read as a decal grid printed over the top of the surface. */
  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.55 + vec3(0.012, 0.013, 0.011), j.x * 0.85);

  // Spalling: the concrete breaks away along the joints, so the erosion mask
  // keys off proximity to one.
  float spall = sstep(0.55, 0.9, unit(wfbm(p * 3.2 + vec2(hash21(slabId + 7.7), hash21(slabId + 53.3)) * 21.0, 3))) * sstep(0.86, 1.0, edge);

  float gum = gumSpots(p);
  /* Stains, as distinct from gum. Irregular, soft-edged, several sizes, and
   * not round: the previous pass produced identical dark dots that read as
   * placed geometry. */
  /* Every mark is sampled at an offset unique to its own flag.
   *
   * Sampling stains and scratches at world position alone means the field is
   * shared between flags, and because the flags sit on a regular grid the same
   * patch of that field lands on flags a fixed distance apart — so an
   * identical smudge reappears every second or third slab, in the same corner,
   * at the same angle. Displacing the lookup by a per-flag vector decorrelates
   * them completely while leaving the marks themselves unchanged. */
  /* Marks come in two kinds and they need different treatment.
   *
   * Wear belongs to the flag — one slab is scuffed and the next is not — so it
   * is sampled at a per-flag offset to stop the same scuff appearing every
   * third slab. Dirt does not: a spill, a rust run from a downpipe, the dark
   * tail where water sheets off the kerb, all cross joints as if the joints
   * were not there. Keying everything to the flag was making the grid the
   * organising feature of the whole surface, which is the tell. */
  vec2 flagOff = vec2(hash21(slabId + 7.7), hash21(slabId + 53.3)) * 37.0;
  vec2 ps = p + flagOff;

  float grime = unit(wfbm(p * 0.62 + 3.0, 4));
  grime = sstep(0.42, 0.86, grime);
  diffuseColor.rgb *= 1.0 - grime * 0.34;
  float stainF = unit(wfbm(ps * 2.6, 4));
  float stain = sstep(0.62, 0.88, stainF) * (0.4 + 0.6 * unit(wfbm(ps * 9.0, 3)));

  float wpx = fwidth(p.x) + fwidth(p.y);
  Screed sc = screed(p, wpx);
  gScreedN = sc.n;

  /* Grazing self-shadow, and it is the missing half of this surface.
   *
   * Directly sunlit flags were coming out as a flat cream field with no
   * joints, no grain and no grime, while flags forty pixels away in shade
   * carried the lot. Measured, the sunlit patch has a standard deviation of
   * 4.3 counts on a mean of 180 and the shaded patch 3.6 on a mean of 30 —
   * the same absolute texture, one twelfth of the relative contrast. So the
   * detail was never removed. It is all still there in albedo, and albedo is a
   * multiplicative term, which means it delivers a constant *ratio* of
   * variation into the tone curve; AgX's shoulder then flattens that ratio
   * about five times harder up at the sunlit level than it does down in the
   * shade. The closing pass that moved paving relief into albedo to kill the
   * white-granule blowout did fix the blowout, and this is its bill.
   *
   * Raising the albedo amplitude would be the wrong remedy twice over: it
   * would have to be enormous to survive the shoulder, and it would move the
   * shaded side, which is signed off. What is actually absent from the model
   * is a real effect, and one that exists only in the condition that is
   * broken. A sun four degrees up casts a two-millimetre shadow off a
   * half-millimetre grain — four grain diameters — so raking light does not
   * illuminate concrete evenly, it shadows most of it and skims the rest, in
   * streaks running along the sun's azimuth. That is a bounded multiplier on
   * the *direct* term alone, so it cannot touch a shaded pixel: a shaded pixel
   * has no direct term to multiply. It also cannot blow anything out, because
   * it only ever subtracts. */
  {
    vec2 sd = normalize(uSunXZ);
    /* Sampled in a frame stretched seven to one along the sun, because a
     * shadow twenty times longer than the grain that casts it does not read as
     * speckle, it reads as streaks. */
    vec2 q = vec2(dot(p, sd) * 0.14, dot(p, vec2(-sd.y, sd.x)));
    float gv2 = 1.0 - sstep(0.25, 1.2, wpx / 0.0055);
    float shade = sstep(0.30, 0.86, unit(wfbm(q * 195.0, 3))) * gv2 * 0.94;
    /* Exposed aggregate: the three-to-eight-millimetre stones that a worn
     * paving face stands proud of, each throwing forty to a hundred
     * millimetres downsun. This is the band that carries speckle at four to
     * ten metres, which is the range the review's frame is at — the grain
     * above it is correctly averaged away by then, so without this there is
     * genuinely no aggregate in a sunlit flag at the distance it is judged. */
    float av = 1.0 - sstep(0.25, 1.2, wpx / 0.012);
    shade = max(shade, sstep(0.48, 0.88, unit(wfbm(q * 88.0 + 4.0, 3))) * av * 0.96);
    // The voids and popouts throw shadows an order of magnitude longer.
    float hv = 1.0 - sstep(0.30, 1.2, wpx / 0.030);
    shade = max(shade, sstep(0.62, 0.94, unit(wfbm(q * 33.0 + 9.0, 2))) * hv * 0.95);
    /* Broad wear, and this is the component that survives to forty metres.
     *
     * The two above are grain and voids, and both are correctly withdrawn once
     * they fall under a pixel — but the review's frame is a sunlit footway at
     * that distance, so withdrawing them leaves nothing at all. Paving does not
     * wear flat: it dishes, it settles, it lifts at one corner of a flag, all at
     * the scale of a slab, and against a four-degree key a three-millimetre
     * dish across three hundred is a shadow you can see from the far end of the
     * street. Metre-scale, so it is still above the footprint where the fine
     * work has gone. */
    float wv = 1.0 - sstep(0.35, 1.1, wpx / 0.14);
    vec2 qw = vec2(dot(p, sd) * 0.55, dot(p, vec2(-sd.y, sd.x)));
    shade = max(shade, sstep(0.44, 0.90, unit(wfbm(qw * 6.5 + 27.0, 3))) * wv * 0.62);
    /* And the joints, which is the feature the review actually named.
     *
     * A joint is a five-millimetre recess, and at 4.2 degrees five millimetres
     * of depth throws sixty-eight of shadow — thirteen times the width of the
     * groove. So a slab joint in raking light is not a thin dark albedo line,
     * it is a bold band lying downsun of itself, and that is why the flags read
     * in shade, where the groove is doing the work honestly, and vanish in sun,
     * where the groove is all there is and the tone curve has flattened it. The
     * second sample is taken up-sun of this fragment: it asks not "am I in a
     * joint" but "was the light that should have reached me blocked by one".
     * Three of them, at increasing distance and decreasing weight, because one
     * lands the shadow as a dotted line — the groove is well under a pixel at
     * this range and a single point sample of it drops in and out along its
     * own length. Three samples across the penumbra fill it in and also make
     * it the width it should be, which is thirteen grooves. */
    vec2 sID2;
    float js = joint;
    js = max(js, walkJoints(p - sd * 0.022, sID2).x * 0.97);
    js = max(js, walkJoints(p - sd * 0.046, sID2).x * 0.90);
    js = max(js, walkJoints(p - sd * 0.070, sID2).x * 0.76);
    js = max(js, walkJoints(p - sd * 0.098, sID2).x * 0.58);
    shade = max(shade, js);
    /* And the broken edges, which are recesses like the joints and were being
     * treated as albedo alone: a spall is a piece missing, so in raking light
     * it is a hole with a shadow in it and not a grey patch. */
    shade = max(shade, spall * 0.80);
    gGraze = clamp(shade, 0.0, 1.0);
  }

  vec3 c = diffuseColor.rgb;
  c *= clamp(1.0 + sc.t * 0.90, 0.10, 2.1);
  // Down in the joint: dark, but not black — there is grit in there catching
  // a little light, and a pure black line is a drawn line.
  /* The joint holds dirt, and the dirt is not the same dirt all the way along.
   *
   * A gap between two flags fills with grit, moss and the grey silt that washes
   * off the face, and it fills unevenly — packed and pale in one stretch, open
   * and near-black in the next. A groove of one constant colour is a line
   * drawn on a surface; a groove whose fill changes along its run is a gap
   * between two stones. */
  float jointFill = unit(wfbm(vec2(p.x * 3.1, p.y * 3.1) + 43.0, 3));
  vec3 jointC = mix(vec3(0.0125, 0.0127, 0.0132), vec3(0.0335, 0.0318, 0.0282),
                    sstep(0.42, 0.86, jointFill));
  c = mix(c, jointC, joint * 0.93);
  c = mix(c, c * 1.24, lip * 0.55);          // the rounded, light-catching lip
  c = mix(c, c * 0.62, spall * 0.5);
  // A fresh break shows the aggregate, which is paler than the weathered face.
  c = mix(c, c * 1.5, chip * 0.6);
  c = mix(c, c * 0.72, stain * 0.55);
  c = mix(c, vec3(0.0230, 0.0225, 0.0215), gum * 0.9);

  /* The leading arris.
   *
   * The front edge of the flag course, where it stands over the back of the
   * kerb, is the one line on a footway that never holds dirt: it is walked
   * over, scuffed by feet coming off the road and washed by everything that
   * runs to the gutter, so it has lost its weathering film and shows pale
   * concrete. In a photograph of paving in low sun it is the feature that
   * states where the footway ends — without it the flags and the kerb top run
   * together into one grey field.
   *
   * Albedo only, and faded out with range. A one-pixel bright line held to the
   * vanishing point is an aliasing generator, and this scene has already paid
   * for two of those. */
  float arrD = length(vWPos - cameraPosition);
  float arrisW = max(wpx * 1.6, 0.011);
  float arris = (1.0 - sstep(0.0, arrisW, abs(abs(p.x) - uKerbEdge - 0.012)))
              * (0.45 + 0.55 * unit(wfbm(vec2(p.y * 0.85, 3.0), 3)))
              * (1.0 - sstep(9.0, 26.0, arrD));
  c = mix(c, c * 1.34, arris * 0.80);

  // Damp seeping from the kerb joint and out of the flag joints. Concrete is
  // porous, so it takes water in and goes dark rather than glossy.
  float damp = kerbSide * sstep(0.35, 0.8, unit(wfbm(p * 0.5, 3)));
  c *= 1.0 - damp * 0.30;
  diffuseColor.rgb = c;

  /* Roughness: near-matte everywhere, and this is the point.
   *
   * The critic could not find the kerb without the luminance, which means the
   * two materials were behaving identically under light. Concrete has almost
   * no specular lobe. The road beside it is between 0.03 and 0.30 in the wet
   * parts; nothing here goes below 0.62 except the gum, and the gap is what
   * makes the boundary legible. */
  float rmap = texture2D(roughnessMap, vRoughnessMapUv).g;
  /* Concrete has essentially no specular lobe, and under a strong key that
   * matters far more than it did at night. Any sheen at all reads as glazed
   * ceramic, which is exactly what reviewers keep calling this surface — a
   * tiled lobby floor rather than a footway. Nothing here goes below chalky. */
  float rgh = mix(0.995, 0.955, rmap) + sc.r;
  rgh = mix(rgh, 0.99, joint * 0.6);
  rgh = mix(rgh, 0.94, lip * 0.5);           // worn smoother than the face
  rgh = mix(rgh, 0.30, gum * 0.85);          // gum stays glossy for years
  rgh = mix(rgh, 0.90, damp * 0.75);
  rgh = mix(rgh, 0.93, footfall * 0.4);      // polished by feet
  rgh = mix(rgh, 0.995, chip * 0.7);         // a fresh break is raw
  /* No sheen at all. A broad specular across the flag tops is what makes this
   * read as polished timber; concrete this old has none to give. */
  roughnessFactor = clamp(rgh, 0.88, 1.0);
  /* Distance-filtered specular.
   *
   * Same fix as on the carriageway, and it is the actual source of the hard
   * bright band across the vanishing point: at forty-odd metres both footways
   * are seen at two degrees off grazing, their specular lobe saturates, and
   * the two pale strips merge left-to-right into one continuous bright line
   * that reads as a seam between ground and sky. A pixel at that range covers
   * square metres of pavement, so its effective roughness is nothing like the
   * value authored for a square centimetre; raising the floor with distance
   * puts that back and the seam goes. */
  float wdist = length(vWPos - cameraPosition);
  roughnessFactor = max(roughnessFactor, sstep(14.0, 55.0, wdist) * 0.55);

  /* The strip against the building line, which is System 2's problem showing
   * up on System 1's surface.
   *
   * With buildings standing on the footway the back 400 mm of it is a place
   * nobody walks, no brush reaches and no rain washes: it collects grit, leaf
   * mould and the grey silt that runs off the wall, and it is visibly darker
   * and rougher than the rest of the flag. It is also the strip that reads the
   * junction — without it a wall meets paving at a razor line and the building
   * looks placed rather than built. */
  float toWall = max(uBuildLine - abs(vWPos.x), 0.0);
  float against = 1.0 - sstep(0.05, 0.55, toWall);
  diffuseColor.rgb *= 1.0 - against * 0.42 * (0.55 + 0.6 * unit(wfbm(p * 3.1 + 71.0, 3)));
  roughnessFactor = min(1.0, roughnessFactor + against * 0.03);
}
`;

/* Ambient occlusion at the wall foot.
 *
 * Applied to indirect only, because that is the term an inside corner actually
 * loses. A point on the paving 50 mm from a five-storey wall can see well
 * under half the sky; a metre out it can see most of it. The matching term is
 * on the masonry, and between them they are what stops the frontages reading
 * as cut-outs standing on a table — at a four-degree sun there is no cast
 * shadow available to do that job, because on the sunlit side the light
 * arrives from the open side of the corner.
 */
const WALK_WALL_AO = /* glsl */ `
#include <lights_fragment_end>
float aoGap = max(uBuildLine - abs(vWPos.x), 0.0);
reflectedLight.indirectDiffuse =
  canyonSky(reflectedLight.indirectDiffuse, vWNormal, vWPos.y)
  * mix(0.26, 1.0, sstep(0.0, 0.95, aoGap)) * 1.20;
/* Direct only. See the long note where gGraze is built: the shaded half of
 * this surface is signed off and must not move, and applying the term here is
 * what guarantees it cannot — there is no direct light in shadow to attenuate.
 * It is also the reason this is a shadowing term and not a brighter albedo.
 *
 * The depths are up from 0.55 and 0.70. At those the surface measured right —
 * a sunlit flag went from 4.3 counts of standard deviation to 11.9 — and still
 * did not read: joints came through as three or four ghost lines with no
 * shadow in them, over a broad specular wash. The specular is the harsher of
 * the two, and deliberately: at 4.2 degrees the lobe on a footway is enormous
 * and it is the term that fills the joints back in after the diffuse has
 * emptied them. */
reflectedLight.directDiffuse *= 1.0 - gGraze * 0.80;
reflectedLight.directSpecular *= 1.0 - gGraze * 0.94;
`;

const WALK_NORMAL_HOOK = /* glsl */ `
#ifdef USE_NORMALMAP_TANGENTSPACE
  vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;

  /* The paving grain, cut hard and then faded with depth.
   *
   * This is the road's normalScale fault a second time, in the one ground
   * material that never got the remedy. The map was running at 1.15 while the
   * road runs at 0.30, and the consequence under this sun is worse on paving
   * than it was on tarmac because the failure here is *diffuse*, not specular.
   * The key is four degrees up. A flat slab returns N·L of about 0.07; a grain
   * tilted a few degrees toward the sun returns nearer 0.5. So every bump in the
   * baked map is a seven-fold local swing in direct light, and a smooth
   * Yorkstone flag renders as a bed of blown-out white granules — peak pixel
   * (234, 200, 170) against a local mean of (61, 50, 54) on the sunlit footway.
   * No roughness value can damp that, which is why the 0.88 floor did not.
   *
   * Also the answer to the gutter piles that were measured as bit-identical and
   * honestly retracted two rounds ago: the bright clusters were never stones in
   * the channel, they were this surface blowing out. The coordinates were right
   * and the object was wrong. */
  float wgd = length(vWPos - cameraPosition);
  /* Faded out by fifteen metres. A tiled map holds its amplitude to the horizon
   * while its features fall below a pixel, so it stops being texture and becomes
   * noise — and where the LOD did cut, it cut abruptly enough to show as a
   * boundary across the footway. A continuous ramp cannot produce an edge. */
  mapN.xy *= normalScale * (1.0 - sstep(2.0, 15.0, wgd) * 0.92);

  vec2 pj = vWPos.xz;
  vec2 gj = pj / uSlab;
  vec2 fj = fract(gj) - 0.5;
  float wob = wfbm(pj * 1.4, 2) * 0.010;
  float hj = 0.5 - (uJoint / uSlab) * 0.5;
  /* The gap has two walls and a rounded lip, so the normal turns twice across
   * it: outward as the flag rolls over into the joint, then hard back at the
   * wall. One step, which is what was here before, is a scored line. */
  float ax = abs(fj.x) + wob, az = abs(fj.y) + wob;
  float sx = (sstep(hj - 0.055, hj, ax) - sstep(hj, hj + 0.02, ax) * 1.6) * sign(fj.x);
  float sz = (sstep(hj - 0.055, hj, az) - sstep(hj, hj + 0.02, az) * 1.6) * sign(fj.y);
  /* The joint relief is allowed to stay, because a joint is a sparse linear
   * feature and not a full-field perturbation: there is one of them every
   * 920 mm, so it cannot produce the field of blown granules that a per-pixel
   * grain does. It does get the footprint gate that every other feature in
   * this material already had, so it withdraws with range instead of holding
   * its amplitude to the vanishing point. */
  float jpx = fwidth(pj.x) + fwidth(pj.y);
  float jv = 1.0 - sstep(0.35, 1.1, jpx / (uJoint * 2.2));
  mapN.xy += vec2(sx, sz) * 0.55 * jv;
  mapN.xy += gScreedN * 0.55;
  normal = normalize( tbn * normalize(mapN) );

  /* The same normal-variance roughness widening the road already has. The
   * footway fills as much of a grazing frame as the carriageway does and had no
   * prefiltering at all, so what survived the amplitude cut would still have
   * crawled in motion. */
  vec3 wdnx = dFdx(normal), wdny = dFdy(normal);
  float wnvar = 0.5 * (dot(wdnx, wdnx) + dot(wdny, wdny));
  float walpha = roughnessFactor * roughnessFactor + min(wnvar * 2.2, 0.28);
  roughnessFactor = clamp(sqrt(walpha), 0.0, 1.0);
#endif
`;

export function makeWalkMaterial(set: SurfaceSet): THREE.MeshStandardMaterial {
  tile(set, set.patch);
  const m = new THREE.MeshStandardMaterial({
    roughness: 1, metalness: 0,
    // From 1.15. The critic's estimate was "roughly an order of magnitude lower"
    // and that is close to where the measurement lands; the road sits at 0.30 and
    // this surface is smoother than the road, not rougher.
    normalScale: new THREE.Vector2(0.13, 0.13),
    shadowSide: THREE.FrontSide,
    /* A chalky surface returns almost nothing specular, so it gets a fraction
     * of the environment the road gets. Matching them was a large part of why
     * the two materials looked like one material at two exposures. */
    envMapIntensity: 0.22,
    dithering: true,
  });
  applySet(m, set);
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, artificialUniforms());
    shader.uniforms.uSlab = { value: DIMS.slab };
    shader.uniforms.uJoint = { value: DIMS.slabJoint };
    shader.uniforms.uBuildLine = {
      value: DIMS.roadHalf + DIMS.kerbDepth + DIMS.walkWidth,
    };
    // The front edge of the flag course, over the back of the kerb.
    shader.uniforms.uKerbEdge = { value: DIMS.roadHalf + DIMS.kerbDepth };
    shader.uniforms.uSunXZ = {
      value: new THREE.Vector2(SUN_DIR[0], SUN_DIR[2]).normalize(),
    };
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `${WORLD_VARYINGS}\nvoid main() {`)
      .replace('#include <begin_vertex>', VERTEX_HOOK);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${NOISE}\n${WALK_SCREED}\n${WALK_FRAG_HEAD}\n${CANYON}\n${ARTIFICIAL}\nvoid main() {`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${WALK_FRAG_BODY}`)
      .replace('#include <normal_fragment_maps>', WALK_NORMAL_HOOK)
      .replace('#include <lights_fragment_end>', WALK_WALL_AO + ARTIFICIAL_ADD);
  };
  m.customProgramCacheKey = () => 'night-street-walk';
  return m;
}

/* ── Kerb ───────────────────────────────────────────────────────────────── */

const KERB_FRAG_HEAD = /* glsl */ `
${WORLD_VARYINGS}
${CANYON}
varying float vProf;
uniform float uKerbBlock;
uniform float uKerbH;
uniform float uCham;
/* How much of the road's bounce this fragment sees. Written where the profile is
 * resolved, spent after the lights, so it has to live outside both blocks. */
float gKerbBounce = 0.0;
`;

const KERB_FRAG_BODY = /* glsl */ `
{
  vec2 p = vWPos.xz;
  float up = clamp(vWNormal.y, 0.0, 1.0);

  // Kerbstone joints: an 8 mm mortar gap every block, dark and full of grit.
  float bg = p.y / uKerbBlock;
  float joint = sstep(0.972, 0.999, abs(fract(bg) - 0.5) * 2.0);
  float blockId = hash21(vec2(floor(bg), sign(p.x)));
  diffuseColor.rgb *= 0.80 + 0.42 * blockId;

  /* The arris.
   *
   * The top front edge of a kerb is touched by everything — feet, tyres,
   * shovels, the corner of every delivery trolley in the city — and it ends up
   * genuinely polished and slightly rounded. It is usually the single
   * brightest line in a night street photograph, because it is the one
   * near-specular surface angled to catch a lamp. */
  /* The chamfer is one quad 34 mm wide and at any distance it is a fraction of
   * a pixel tall, so keying the polish off the world normal alone gave a band
   * that was never wide enough to survive rasterisation — which is why no
   * frame had a chamfer highlight in it. Height above the gutter is a far more
   * robust selector: it does not care how many pixels the facet covers, and it
   * lets the polish wrap slightly onto the top and the face the way a worn
   * edge actually does. */
  /* Per-block seating. A kerb is not an extrusion, it is a row of granite
   * blocks a metre and a half long, each bedded by hand, and no two of them
   * end up at quite the same height or quite the same line. Offsetting the
   * arris by a few millimetres per block is what turns one prism running to
   * the horizon into a row of separate stones.
   *
   * It also fixes an aliasing defect. The polished arris is the brightest
   * thing in the frame and it was a mathematically straight line one pixel
   * tall, which is the worst case there is for a walking camera — it stair-
   * steps and it crawls. Broken into segments at slightly different heights,
   * and widened with distance so it can never be thinner than the pixel that
   * has to hold it, there is no continuous edge left to crawl. */
  float seat = (hash21(vec2(floor(bg), 77.0)) - 0.5) * 0.009;
  float dCam = length(vWPos - cameraPosition);
  float grow = 1.0 + sstep(6.0, 40.0, dCam) * 2.2;
  float kh = uKerbH + seat;
  float band = sstep(kh - uCham * 1.05 * grow, kh - uCham * 0.35, vProf)
             * sstep(kh + uCham * 1.30 * grow, kh + uCham * 0.35, vProf);
  float arris = clamp(band * (0.35 + 0.65 * sstep(0.05, 0.75, up)), 0.0, 1.0);
  // Not evenly polished: it is worn where people step off and dull elsewhere.
  arris *= 0.45 + 0.55 * sstep(0.25, 0.75, unit(wfbm(vec2(p.y * 0.6, 9.0), 3)));
  // Per block, because one stone is newer than its neighbour.
  arris *= 0.35 + 0.85 * blockId;
  /* Chipped ends. Granite kerbs lose their top corners to wheels, and the
   * arris dies at the break rather than running through it. */
  float endD = abs(fract(bg) - 0.5) * 2.0;
  float chipEnd = sstep(0.80, 0.985, endD)
                * sstep(0.45, 0.80, unit(wfbm(vec2(p.y * 3.0, floor(bg)), 2)));
  arris *= 1.0 - chipEnd * 0.85;

  /* Road spray. The bottom 60 mm of a kerb face is permanently wet and black
   * with what the gutter carries, and it stops in a ragged tide line rather
   * than a gradient. */
  float base = sstep(-0.020, -0.078, vWPos.y) * (1.0 - up);
  float wetline = base * (0.55 + 0.45 * unit(wfbm(vec2(p.y * 1.4, 2.0), 3)));

  /* Bounce onto the vertical face.
   *
   * With a single placeholder lamp overhead the kerb face receives almost no
   * direct light and falls to the shadow floor, and at that point the footway
   * stops touching the road: reviewers described it as a separate slab
   * hovering with a black wedge underneath, and the upstand read as 60-80mm
   * rather than 145mm because only the top edge was ever visible. The face is
   * not actually dark in life. It sits a few centimetres from a large, pale,
   * lit road surface and picks up a substantial bounce off it, strongest at
   * the bottom where the road is nearest and falling away towards the top.
   *
   * Until a lighting system exists to carry that properly it is an explicit
   * term, keyed to how vertical the fragment is and how low on the face it
   * sits, which is where the reflected light would actually be coming from.
   * Warm, because it has come off a sodium-lit carriageway.
   */
  float faceness = 1.0 - sstep(0.05, 0.55, up);
  float lowOnFace = 1.0 - sstep(0.0, uKerbH, vWPos.y);
  float bounce = faceness * (0.28 + 0.72 * lowOnFace);

  vec3 c = diffuseColor.rgb;
  c = mix(c, vec3(0.0180, 0.0175, 0.0170), joint * 0.9);
  // Fresh granite where a corner has broken away: paler and unweathered.
  c = mix(c, c * 1.55, chipEnd * 0.55);
  /* The arris, from ×2.30 down to ×1.16, and this is the third copy of the same
   * night premise found in this file.
   *
   * The rationale above it is explicit that the chamfer is "the single brightest
   * line in a night street photograph, because it is the one near-specular
   * surface angled to catch a lamp". True, and it is an argument about a lamp:
   * the arris wins at night because it is the only facet oriented towards a
   * source that is directly above it and close. The sun is four degrees up and
   * behind, so at this hour the arris has no privileged orientation at all — and
   * multiplying the albedo of a 20 mm chamfer by 2.3 while the road beside it is
   * being asked to stay grey put a continuous hard bright line down the length of
   * every kerb in every frame. That is the "reads as an emissive strip" note,
   * which has now been raised against this edge three rounds running.
   *
   * What is left is the small genuine effect: an arris is chamfered off the
   * weathered top and is younger, cleaner stone than the faces either side, so it
   * is modestly paler as a material regardless of where the light is. And it is
   * broken along its length, so the line is no longer continuous — real kerbs are
   * knocked, patched and replaced in runs. */
  float arrisAge = 0.55 + 0.45 * unit(wfbm(vec2(p.y * 0.42, 7.0), 3));
  c = mix(c, c * 1.16, arris * 0.80 * arrisAge);

  /* wetline, cut from ×0.42 to ×0.86 and narrowed.
   *
   * Same family as the damp patches that were pulled back on the road: it
   * asserts that the bottom 60 mm of every kerb face is "permanently wet and
   * black", which is a night-street premise and is not true of a dry street at
   * the end of a sunny day. At full strength it drew a continuous dark glossy
   * band along the one line in the frame the eye tracks hardest — the junction
   * that tells you where the footway meets the road — and at roughness 0.17 it
   * was three times smoother than the road it met, so it caught a sheen the
   * asphalt beside it could not. What is left reads as staining. */
  c = mix(c, c * vec3(0.86, 0.85, 0.84), wetline * 0.70);
  /* Staining. Rust from a sign fixing, a run of something down the face —
   * a hundred-year-old kerb is not one clean tone. */
  float stain = sstep(0.66, 0.90, unit(wfbm(vec2(p.y * 0.55, vWPos.y * 6.0), 4)));
  c = mix(c, c * vec3(0.72, 0.58, 0.46), stain * 0.55);
  /* The hand-authored bounce, removed from albedo.
   *
   * Two things were wrong with it and the second is the one that mattered. It
   * was added to albedo, so it survived into direct sunlight — a term whose whole
   * justification is "the face receives almost no direct light" was brightening
   * the face hardest exactly when that premise was false. And its colour was
   * fixed warm, described in its own comment as bounce "off a sodium-lit
   * carriageway", so the kerbs on the shaded side of the street — where the real
   * bounce is cool sky off a road in shadow — were being warmed by a lamp that
   * is not on.
   *
   * The effect it stands in for is real: a kerb face does sit centimetres from a
   * large bright road and picks up a lot of light off it, and without something
   * the footway detaches into a hovering slab. So it is kept, moved to indirect
   * where bounce belongs, and given the colour of whatever the road nearby
   * actually is — warm where the road is sunlit, cool where it is not. That is
   * carried in gKerbBounce and applied after the lights. */
  gKerbBounce = bounce;
  diffuseColor.rgb = c;

  float rmap = texture2D(roughnessMap, vRoughnessMapUv).g;
  float rgh = mix(0.88, 0.74, rmap);
  // The chamfer is cut stone, not polished stone. 0.115 was a mirror, chosen so
  // it would flare under a lamp; there is no lamp.
  rgh = mix(rgh, 0.62, arris * 0.92);
  rgh = mix(rgh, 0.55, up * 0.4);
  rgh = mix(rgh, 0.66, wetline * 0.85);
  rgh = mix(rgh, 0.92, joint * 0.6);
  rgh = mix(rgh, 0.96, chipEnd * 0.8);   // a fresh fracture is not polished
  /* Floor raised from 0.08 to 0.42. The kerb was the one ground material with no
   * daylight roughness floor at all — the road is clamped at 0.40 and the footway
   * at 0.88 — which is why it was the only paving that could throw a specular
   * flare, and it did so along a continuous straight line pointed at the key. */
  roughnessFactor = clamp(rgh, 0.42, 1.0);
  // Distance-filtered, as on the road and the footway.
  roughnessFactor = max(roughnessFactor,
    sstep(14.0, 55.0, length(vWPos - cameraPosition)) * 0.55);
}
`;

/* Bounce off the carriageway onto the kerb face, as light rather than as paint.
 *
 * Replaces a fixed warm constant added to albedo. Two things change. It is added
 * to indirect diffuse, so it behaves like the reflected light it represents and
 * does not go on brightening the face when the sun is already on it. And its
 * colour is taken from the light this fragment is actually standing in — the
 * canyon term already knows whether this point is deep in the slot or open to
 * the sky — so a kerb on the sunlit frontage gets a warm lift off a bright road
 * and one on the shaded frontage gets the cool sky bounce it should have had all
 * along, instead of sodium off a lamp that is not switched on. */
const KERB_RETRO = /* glsl */ `
{
  vec3 road = canyonSky(reflectedLight.indirectDiffuse, vec3(0.0, 1.0, 0.0), vWPos.y);
  reflectedLight.indirectDiffuse += road * gKerbBounce * 0.62;
}
`;

export function makeKerbMaterial(set: SurfaceSet): THREE.MeshStandardMaterial {
  tile(set, set.patch);
  const m = new THREE.MeshStandardMaterial({
    roughness: 1, metalness: 0,
    normalScale: new THREE.Vector2(0.85, 0.85),
    /* Shadows are cast from this surface's front faces.
     *
     * Three.js renders the shadow pass with shadowSide defaulting to BackSide
     * for a FrontSide material, which is right for closed solids — it pushes
     * the depth to the far wall and avoids self-shadowing acne. The kerb is
     * not a closed solid. It is an open profile strip: face, chamfer and top,
     * with no back and no underside. There are no back faces pointing at the
     * sun, so the shadow pass drew nothing at all and the kerb cast no shadow
     * despite being flagged as a caster. A test box in the same scene threw a
     * perfectly good one, which is what isolated it to the geometry rather
     * than to the light or the frustum. */
    shadowSide: THREE.FrontSide,

    envMapIntensity: 1.0,
    dithering: true,
  });
  applySet(m, set);
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, artificialUniforms());
    shader.uniforms.uKerbBlock = { value: DIMS.kerbBlock };
    shader.uniforms.uKerbH = { value: DIMS.kerbHeight };
    shader.uniforms.uCham = { value: DIMS.kerbChamfer };
    shader.vertexShader = shader.vertexShader
      /* uv.x on the kerb is arc length up the cross-section in metres, which
       * is a far more reliable way to find the chamfer than the interpolated
       * normal is — the facet is 34 mm wide and disappears into a pixel long
       * before the geometry does. */
      .replace('void main() {', `${WORLD_VARYINGS}\nvarying float vProf;\nvoid main() {`)
      .replace('#include <begin_vertex>', `${VERTEX_HOOK}\nvProf = uv.x;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${NOISE}\n${KERB_FRAG_HEAD}\n${ARTIFICIAL}\nvoid main() {`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>\n${KERB_FRAG_BODY}`)
      .replace('#include <lights_fragment_end>',
        `#include <lights_fragment_end>\n${KERB_RETRO}${ARTIFICIAL_ADD}`);
  };
  m.customProgramCacheKey = () => 'night-street-kerb';
  return m;
}

/* ── Plain baked materials for the ironwork ─────────────────────────────── */

export function makeSimpleMaterial(
  set: SurfaceSet,
  opts: { metalness?: number; repeatMetres?: number; normalScale?: number } = {},
): THREE.MeshStandardMaterial {
  if (opts.repeatMetres) tile(set, opts.repeatMetres);
  const m = new THREE.MeshStandardMaterial({
    roughness: 1,
    metalness: opts.metalness ?? 1,
    normalScale: new THREE.Vector2(opts.normalScale ?? 1, opts.normalScale ?? 1),
    envMapIntensity: 1.0,
    dithering: true,
  });
  applySet(m, set);
  m.aoMap = set.ormMap;
  return m;
}

/**
 * The skirt below the footway edge.
 *
 * A flat near-black that catches almost nothing. It is a stand-in for the
 * building line and its only job is to stop the ground plane ending in mid-air
 * against the sky. Deliberately not lit interestingly: anything with structure
 * on it would be System 2 arriving early.
 */
/* The distant apron.
 *
 * Deliberately Lambert rather than Standard, and that is the fix for the hard
 * bright line across the vanishing point.
 *
 * The apron is a filler plane three hundred metres square whose only jobs are
 * to stop the street ending in mid-air and to give the horizon something to
 * dissolve into. Because it is flat and enormous, the band of it around forty
 * to sixty metres out is seen at one or two degrees off grazing and spans the
 * entire width of frame — and at that incidence the Fresnel term of even a
 * 0.95-roughness dielectric goes to one, so a Standard material lit it up into
 * a continuous bright streak pinned across the horizon in every single frame.
 * Bounding roughness by distance fixed the same defect on the road, the
 * footway and the kerb but left this one untouched, because the pixels in the
 * band belong to none of those three.
 *
 * Lambert has no specular lobe at all, so the failure mode does not exist. The
 * plane still takes light from the lamps and still takes fog, which is the
 * whole of what it is for.
 */
export function makeApronMaterial(): THREE.MeshLambertMaterial {
  /* The ground beyond the footways.
   *
   * This was authored at 0.018 — effectively black — because at night nothing
   * reached it and anything brighter read as an unexplained glow. In daylight
   * that same value draws a heavy dark band right under the horizon across the
   * full width of frame, which looks like a wall closing off the street and is
   * the first thing the eye goes to. It is ground: dusty, mid-toned, and at
   * this distance mostly haze anyway.
   *
   * Lifted too far on the first attempt, it became worse than the black band
   * it replaced: a bright orange plane running to the horizon on both sides,
   * reading as desert rather than as the back of a city block. It is filler
   * standing in for buildings that do not exist yet, so the brief for it is to
   * recede and attract no attention at all — dark, flat, slightly cool, and
   * swallowed by haze before it gets anywhere near the horizon.
   *
   * Lambert rather than standard is kept from the night build for a reason
   * that still applies — it is a very large flat plane seen at a grazing angle,
   * and a specular lobe on it saturates into a bright seam at the vanishing
   * point. */
  /* Revalued down again, and this time the reason is the buildings.
   *
   * At 0.0125 with no shadows on it this plane was the brightest large area in
   * several frames — a pale field visible between and behind the frontages,
   * which is what made them read as cut-outs standing on a table. Turning
   * receiveShadow on is most of the fix, but the parts of it that are still in
   * direct sun are behind everything the eye is meant to be looking at, and a
   * filler plane has no business being lighter than the pavement in front of
   * it. Ground behind a city block is yard, service road and rubble, and it is
   * dark. */
  const m = new THREE.MeshLambertMaterial({
    color: new THREE.Color(0.0072, 0.0071, 0.0080),
    dithering: true,
  });

  /* This surface is swallowed by haze many times faster than anything else.
   *
   * Dropping its albedo stopped it glowing like a desert, but it then did the
   * opposite and terminated in a dead-flat near-black band the full width of
   * every frame, capped by a hard bright seam where it met the sky — a wall
   * across the end of the street, and by common consent worse than nothing at
   * all. Neither value works, because the problem is not the value: it is that
   * a flat plane running unobstructed to the horizon is not something a street
   * ever shows you, and until buildings exist there is nothing to interrupt it.
   *
   * Rather than pick a third albedo, this multiplies only this material's fog
   * depth, so the filler dissolves into the haze within about twenty metres
   * and the far end of the street becomes sky. The scene's actual fog density
   * stays where it belongs for the road and the footway, which must keep their
   * texture. It is a cheat, and it is the same cheat as painting a backdrop:
   * it buys a soft horizon now and costs nothing to delete once there are
   * buildings to occlude it properly. */
  m.onBeforeCompile = (shader) => {
    // onBeforeCompile sees the shader before #include directives are expanded,
    // so the chunk has to be replaced rather than the line inside it.
    /* The multiplier was 7.5, and deleting most of it is the single largest
     * correction in this pass.
     *
     * It was a night-time cheat with an explicit expiry date on it: dissolve
     * the filler plane into haze within twenty metres so the street does not
     * end in a visible edge, and take it out once there are buildings to close
     * the view properly. Left in at golden hour it does something much worse
     * than it ever did at night. Fog lifts toward the horizon colour, and the
     * horizon at this hour is the brightest thing in the frame — so every
     * pixel of apron past about fifteen metres was being painted pale amber
     * sky. That is the "pale table" the frontages appeared to be standing on,
     * it is the daylight visible under the far buildings, and it is why a
     * frontage base could not be told from a gap between two of them.
     *
     * There are buildings now, and a rear range behind the low frontage, so
     * the plane has to do far less. At 1.5 it is ground: dark, receding, and
     * gone under the block long before it reaches the horizon. */
    /* The body comes from haze.ts (System 6) rather than being written here.
     * This material is the only one that cannot use the shared fog_vertex
     * chunk, so it used to carry a transcribed copy — including an assignment
     * to vHazeWorld, a varying that only exists because haze.ts declares it.
     * Renaming or dropping that varying there broke this program with a link
     * error naming neither file. Keep it a call. */
    shader.vertexShader = shader.vertexShader.replace(
      '#include <fog_vertex>',
      hazeFogVertex(1.5),
    );
  };
  m.customProgramCacheKey = () => 'apron-haze';
  return m;
}

export function makeSkirtMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.0075, 0.0072, 0.0080),
    roughness: 0.95,
    metalness: 0,
    envMapIntensity: 0.12,
    dithering: true,
  });
}

/** Non-tiling variant for the manhole face, whose uv is the whole disc. */
/**
 * Non-tiling variant for the castings, whose uv is the whole part.
 *
 * `metalness` defaults low and that is not an oversight. A manhole cover is
 * cast iron, but the surface a street sees is rust, road grime and a century
 * of tyre polish, and none of that is a conductor. Authored at metalness 1 the
 * cover has no diffuse response at all, so under a single dim sodium lamp it
 * returned almost nothing and rendered as a black hole in the road — which is
 * part of why the ironwork could not be found in the first capture set even
 * after it was no longer buried.
 */
export function makeDiscMaterial(set: SurfaceSet, metalness = 0.25, nrm = 1.4): THREE.MeshStandardMaterial {
  for (const t of [set.map, set.normalMap, set.ormMap]) {
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.repeat.set(1, 1);
    t.needsUpdate = true;
  }
  const m = new THREE.MeshStandardMaterial({
    roughness: 1, metalness,
    normalScale: new THREE.Vector2(nrm, nrm),
    envMapIntensity: 1.0,
    dithering: true,
  });
  applySet(m, set);
  m.aoMap = set.ormMap;
  return m;
}
