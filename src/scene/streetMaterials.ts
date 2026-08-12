/* System 3 materials.
 *
 * Same discipline as the facade materials next door and for the same reasons:
 * everything is analytic in facade coordinates, nothing is sampled from a
 * baked tile, and every edge is antialiased against the pixel footprint from
 * fwidth so that a feature narrower than a pixel converges to its own coverage
 * instead of sparkling.
 *
 * Two constraints specific to this system.
 *
 * Relief stays in albedo. A roller shutter is a 77 mm corrugation and a piece
 * of awning canvas is a 1 mm weave, and both are exactly the frequency that a
 * four degree sun destroys: at that elevation a normal perturbation swings N.L
 * between roughly 0.07 and 0.5 across adjacent pixels, which is what turned
 * the pavement into a bed of white granules. So the corrugation is a tone
 * modulation with a token slope on top of it, and the slope is gated by pixel
 * footprint so it is gone by the time the lath is unresolvable anyway.
 *
 * And nothing here emits except the two lit shopfront interiors, which emit
 * because the brief asks for them and System 5 owns the light that leaves
 * them. See `ShopLight` in world/street3.ts for the handover.
 */
import * as THREE from 'three';
import { NOISE, CANYON } from '@/world/glsl';
import { SUN_DIR, HORIZON_SUNWARD, HORIZON_AWAY } from './env';
import { BUILD_LINE } from '@/world/block';
import { signGLSL, signUniforms } from './signs';
import {
  FACADE_VARYINGS, FACADE_VERTEX, FACADE_NORMAL,
} from './buildingMaterials';
import { ARTIFICIAL, artificialAdd, artificialUniforms } from './lights';

/* ── Shared ─────────────────────────────────────────────────────────────── */

/* The globals every body below writes into, and the same antialiased step the
 * masonry uses. Duplicating aaStep would be the seam trap CANYON warns about,
 * but it is four lines and it is genuinely local to a fragment program rather
 * than a shared appearance decision, so it is restated rather than threaded
 * through another export. */
const STREET_PARS = /* glsl */ `
${FACADE_VARYINGS}
varying vec2 vFuv;
uniform vec3 uSun;
vec2 gSlope = vec2(0.0);
float gAO = 1.0;
vec3 gEmit = vec3(0.0);
float gSpecCut = 1.0;

float aaStep(float edge, float x, float px){
  float e = max(px * 0.7, 1e-4);
  return smoothstep(edge - e, edge + e, x);
}
/** A band, antialiased on both sides. 1 inside [a, b]. */
float aaBand(float a, float b, float x, float px){
  return aaStep(a, x, px) * (1.0 - aaStep(b, x, px));
}
`;

/* The lighting tail every street-level material shares.
 *
 * Same shape as MASONRY_END: the sky gain is applied by hand because
 * envMapIntensity is inert in this scene — light arrives through
 * scene.environment and three reads scene.environmentIntensity alone — and the
 * canyon term is applied because a single unoccluded probe has no idea there
 * is a building eleven metres opposite. The bounce off the sunlit frontage is
 * included for the same reason it is on the masonry: without it every shaded
 * surface at street level crushes to a flat blue-black, and at this hour the
 * whole of the ground storey is shaded.
 */
const streetEnd = (gain: number, bounce: number) => /* glsl */ `
#include <lights_fragment_end>
reflectedLight.indirectSpecular *= gSpecCut;
reflectedLight.directSpecular *= gSpecCut;
reflectedLight.indirectDiffuse =
  canyonSky(reflectedLight.indirectDiffuse, vWN, vWPos.y) * ${gain.toFixed(2)} * gAO;
{
  /* The frontage opposite is on fire above its own shade line and it is
   * throwing that at everything down here. Scaled by how much of it a surface
   * can see — a face turned across the street sees all of it, one turned along
   * the street sees almost none — and tinted by what it bounced off. */
  float across = max(-vWN.x, 0.0) * 0.55 + max(vWN.x, 0.0) * 0.30 + max(vWN.y, 0.0) * 0.35;
  reflectedLight.indirectDiffuse +=
    vec3(0.190, 0.104, 0.043) * across * ${bounce.toFixed(2)} * gAO * diffuseColor.rgb;
}
/* System 5, and this is where most of it lands.
 *
 * The four street-level materials are what the artificial sources are actually
 * mounted on and closest to: the fascia the bar's neon is bolted to, the render
 * behind the pharmacy cross, the pilaster beside the store's window, the
 * shutter under a lamp. Every one of those receives a source at under two
 * metres, which is the range where an inverse square is a strong gradient
 * rather than a wash — and a wash is what a source further away than the sun's
 * own scale delivers.
 *
 * Added after the canyon and bounce terms rather than before, so nothing about
 * the signed-off System 3 appearance moves. vWN rather than the perturbed
 * normal for the reason given in scene/lights.ts. */
${artificialAdd('vWN')}
`;

const STREET_EMISSIVE = /* glsl */ `
#include <emissivemap_fragment>
totalEmissiveRadiance += gEmit;
`;

/* Where every body below hooks in, and it is not the obvious place.
 *
 * The intuitive hook is <roughnessmap_fragment>, which is where the masonry
 * goes, and it is wrong for anything that also wants to set metalness: three
 * declares `metalnessFactor` in <metalnessmap_fragment>, one include later, so
 * writing it from the earlier hook is a reference to an undeclared identifier.
 * That is a link failure, and a link failure in this project is silent — the
 * surface comes back flat and untextured and reads as a lighting bug. Hooking
 * one include further down costs nothing: diffuseColor, roughnessFactor and
 * metalnessFactor are all live there, and <normal_fragment_maps> still runs
 * afterwards, so gSlope is read after every body has written it.
 */
const HOOK = '#include <metalnessmap_fragment>';

/* ── Shopfront joinery, risers, pilasters, fascias and interiors ────────── */

/* The linear radiance a lit interior is authored at.
 *
 * These mirror LIT_STORE and LIT_BAR in world/street3.ts, which is what
 * SHOP_LIGHTS reports to System 5, and the two have to agree or the light
 * System 5 adds will be a different colour from the surface it is supposedly
 * leaving. They are deliberately modest: the sun is still up, and a shop
 * ceiling that out-values sunlit brickwork reads as a lightbox rather than as
 * a lit room. Sunlit brick in this scene comes out around 2.3 in linear
 * radiance, so a ceiling at 0.84 sits a stop and a half under it — visible as
 * warm, nowhere near clipping.
 *
 * This is the single most likely value in System 3 to be wrong, because it is
 * the one that cannot be reasoned to within a factor of two without looking at
 * a frame. It is a uniform rather than a constant so the first capture round
 * can bisect it from the console without a shader recompile.
 *
 * Measured at 1.0 and raised. At the first value the ceiling came back at 121
 * of 255 against sunlit brick at 118 beside it, which is the right level, but
 * a lit shop has to be the brightest thing in a shaded frontage rather than
 * merely equal to the sunlit masonry two metres away, and from across the
 * street it was not reading as lit at all.
 */
export const LIT_GAIN = { value: 1.35 };

const SHOP_DECL_HEAD = /* glsl */ `
/* The interior colours, which are the one pair of constants in this file that
 * something outside it depends on: LIT_STORE and LIT_BAR in world/street3.ts
 * carry the same two values out to System 5 in the ShopLight records, and if
 * the two drift the light System 5 hangs on the aperture will be a different
 * colour from the room it is supposedly leaving. */
const vec3 LIT_STORE = vec3(0.80, 0.53, 0.25);   // fluorescent, slightly warm
const vec3 LIT_BAR   = vec3(0.74, 0.30, 0.075);  // tungsten behind a bar

/* Paint, and the palette is the point.
 *
 * A shopping parade is painted by twenty different people over sixty years and
 * the only thing they have in common is that none of them chose a light
 * colour: shopfront joinery is bottle green, oxblood, near-black, navy or the
 * cream that has gone the colour of tea. Pale joinery is a nineteen-nineties
 * refit and one of them on a street is plenty. Linear reflectance, so these
 * are much darker than the same colours picked on a screen. */
vec3 shopPaint(float g){
  return g < 0.22 ? vec3(0.0155, 0.0300, 0.0205)     // bottle green
       : g < 0.42 ? vec3(0.0390, 0.0125, 0.0110)     // oxblood
       : g < 0.58 ? vec3(0.0135, 0.0148, 0.0175)     // near black, blue lean
       : g < 0.74 ? vec3(0.0128, 0.0185, 0.0330)     // navy
       : g < 0.88 ? vec3(0.1180, 0.1055, 0.0790)     // tea-stained cream
                  : vec3(0.0520, 0.0330, 0.0180);    // varnished hardwood
}

`;

/* Signwriting comes from the atlas in scene/signs.ts, which holds the
 * letterforms and the word list and explains at length why the analytic
 * version that stood here was replaced. The short of it: it read as
 * well-set lettering that spelled nothing, and a fascia that spells nothing
 * is worse than a blank one. */
const SHOP_DECL = SHOP_DECL_HEAD + signGLSL();

const SHOP_BODY = /* glsl */ `
{
  vec2 uv = vFuv;
  float px = fwidth(uv.x) + fwidth(uv.y);
  /* Taken here, above every branch, because it differentiates. */
  float gMir = signMirror(uv, vWN);
  float seed = vShop.x;
  float part = vShop.y;
  /* 0 unlit, 1 the convenience store, 2 the bar. */
  float lit  = vShop.w;
  /* A stable per-unit value in [0,1) for the choices that want to vary by
   * premises rather than by fragment. Derived rather than carried: the four
   * attribute slots are spoken for, and a hash of the seed is exactly as good
   * as a second copy of one. */
  float tone = hash21(vec2(seed * 5.9, 1.3));
  vec3 col; float rgh = 0.7; float met = 0.0;
  /* Height above the footway, taken off where this building meets the paving
   * rather than off world zero. The frontages step and the footway falls, so a
   * fixed datum would put the splash line tens of millimetres out along the
   * block. */
  float hh = vWPos.y - vBase;

  if (part < 0.5){
    /* ── Stall riser ──────────────────────────────────────────────────
     *
     * 460-720 mm of boarding or tiling under the glass, and it is the part of
     * a shopfront that takes every kick, every mop and every wheel. Two
     * treatments, because both are common and they look nothing alike: a
     * painted timber panel with a bead round it, and glazed tiling, which is
     * what half the surviving Victorian fronts have and which is the one thing
     * down here with any specularity in it. */
    float tiled = step(0.55, hash21(vec2(seed * 13.1, 2.7)));
    col = shopPaint(hash21(vec2(seed * 3.7, 1.1)));
    if (tiled > 0.5){
      // 152 mm glazed tile on a 4 mm joint — a real size, and the joint grid
      // is most of what identifies it at any distance.
      const float TS = 0.152;
      vec2 t = uv / TS;
      vec2 ft = fract(t);
      float dj = min(min(ft.x, 1.0 - ft.x), min(ft.y, 1.0 - ft.y)) * TS;
      float joint = 1.0 - aaStep(0.0035, dj, px);
      float id = hash21(floor(t) + seed * 7.0);
      // Each tile fired slightly differently, which is the whole charm of it.
      col = mix(col, col * (0.72 + 0.62 * id), 0.85);
      col = mix(col, vec3(0.0620, 0.0580, 0.0510) * (0.6 + 0.5 * id), joint);
      /* Glazed tile is the one genuinely shiny thing at street level, and a
       * raking sun on it is worth having — but only on the tile faces, not in
       * the joints, and cut hard because a wall of mirrors under a low sun is
       * a wall of clipped highlights. */
      rgh = mix(0.16 + id * 0.10, 0.92, joint);
      gSpecCut = mix(0.55, 0.05, joint);
      // Cracked and missing tiles, in ones and twos.
      float gone = step(0.965, hash21(floor(t) + 41.0));
      col = mix(col, vec3(0.0330, 0.0300, 0.0270), gone * 0.85);
      rgh = mix(rgh, 0.95, gone);
      gSlope += vec2(0.0, -joint * 0.05 * (1.0 - smoothstep(0.4, 1.4, px / 0.004)));
    } else {
      rgh = 0.58 + 0.30 * unit(wfbm(uv * 4.0, 3));
      // Boarding: 140 mm tongue and groove, run vertically, because that is
      // how it sheds the water thrown at it.
      float bw = 0.142;
      float fb = fract(uv.x / bw);
      float seam = 1.0 - aaStep(0.006, min(fb, 1.0 - fb) * bw, px);
      col *= 0.86 + 0.30 * hash21(vec2(floor(uv.x / bw), seed));
      col = mix(col, col * 0.42, seam);
    }
    /* Kicked to knee height and swilled at the bottom. This is the "wear lives
     * where water and hands go" rule at its most literal: the bottom 120 mm of
     * a stall riser is where the mop, the road spray and the boots all land,
     * and it is never the same colour as the rest of the board. */
    float kick = 1.0 - smoothstep(0.02, 0.16, hh);
    col = mix(col, col * vec3(0.42, 0.43, 0.45) + vec3(0.0035), kick * 0.8);
    float scuff = smoothstep(0.55, 0.88, unit(wfbm(vec2(uv.x * 12.0, uv.y * 3.0), 3)))
                * (1.0 - smoothstep(0.25, 0.62, hh));
    col = mix(col, col * 1.9 + vec3(0.006), scuff * 0.35);
    rgh = min(1.0, rgh + kick * 0.2);

  } else if (part < 1.5){
    /* ── Cast stone, terrazzo and thresholds ───────────────────────── */
    col = mix(vec3(0.1720, 0.1640, 0.1480), vec3(0.1250, 0.1230, 0.1180),
              hash21(vec2(seed * 5.1, 8.3)));
    // Fine aggregate, in tone only.
    col *= 0.84 + 0.30 * unit(wfbm(uv * 90.0, 2)) * (1.0 - smoothstep(0.4, 1.4, px / 0.012));
    col *= 0.80 + 0.38 * unit(wfbm(uv * 1.6 + 21.0, 3));
    rgh = 0.72;
    /* Horizontal cast stone is the dirtiest surface on a shopfront: a cill has
     * nothing washing it and everything settling on it, and a clean one is the
     * tell. Same finding as the copings in System 2, which came back as a
     * chain of bright dashes until the up-faces were taken down. */
    float up = clamp(vWN.y, 0.0, 1.0);
    float run = unit(wfbm(vec2(uv.x * 0.55, uv.y * 0.55) + 13.0, 3));
    col *= mix(1.0, 0.30 + 0.46 * run, up * 0.85);
    rgh = mix(rgh, 0.95, up * 0.9);
    gSpecCut = (0.10 + 0.30 * run) * mix(1.0, 0.4, up);
    // A worn hollow down the middle of a threshold, in value not in geometry.
    float worn = smoothstep(0.55, 0.0, abs(fract(uv.x * 0.6) - 0.5) * 2.0);
    col *= mix(1.0, 0.80, worn * up * 0.5);

  } else if (part < 2.5){
    /* ── Painted joinery ───────────────────────────────────────────── */
    col = shopPaint(hash21(vec2(seed * 3.7, 1.1)));
    /* Gloss paint on softwood, twenty years old. It does not fail evenly: it
     * crazes, it lifts along the grain, and it goes back to bare grey timber
     * on the weather edge of every member. */
    float weather = smoothstep(0.42, 0.86, unit(wfbm(uv * 5.5, 4)));
    col = mix(col, vec3(0.0880, 0.0800, 0.0660), weather * 0.55);
    col *= 0.82 + 0.34 * unit(wfbm(uv * 22.0, 3));
    /* A shop door handle is polished by forty years of hands and the rail
     * beside it is not. This is the other half of the wear rule and it is the
     * only place on the ground storey where anything is allowed to be shiny —
     * it is also, at 1.1 m up and 30 mm across, exactly at eye level and in
     * the near field. */
    rgh = clamp(0.34 + weather * 0.52, 0.22, 1.0);
    gSpecCut = 0.35 + 0.35 * (1.0 - weather);
    // Dirt in the angle under every horizontal member.
    col *= 0.80 + 0.28 * smoothstep(-0.4, 0.6, vWN.y);

  } else if (part < 3.5){
    /* ── Pilaster ──────────────────────────────────────────────────── */
    col = mix(shopPaint(hash21(vec2(seed * 8.9, 4.3))),
              vec3(0.0980, 0.0930, 0.0860), 0.45 + 0.4 * tone);
    col *= 0.80 + 0.40 * unit(wfbm(uv * 0.85 + 7.0, 4));
    rgh = 0.80 + 0.14 * unit(wfbm(uv * 3.0, 2));
    /* Fly posting, and it arrives at different times.
     *
     * The first version put one bill in each cell of a fixed lattice, each the
     * same fraction of its cell: four pale rectangles of identical width and
     * height, evenly spaced, on one baseline. That is a printed pattern, not a
     * wall people have pasted things to, and the giveaway is that every edge
     * lines up with every other. Flyposting is layered — a bill goes up over
     * what is left of the last one, on different paper, at a different size,
     * half of it hanging off — and it is precisely the absence of alignment
     * that identifies it.
     *
     * So the lattice now only decides where a bill *starts*. Its size, its
     * placement and its paper are its own, it runs over its neighbours freely,
     * and a two-by-two neighbourhood is walked so that a bill up to about
     * one and a half cells across is caught by every fragment it covers. The
     * older ones are torn back and faded toward the wall, the newer ones go
     * over the top of them intact. */
    vec2 pg = vec2(uv.x * 1.15, (uv.y - vBase) * 0.72);
    vec2 pb = floor(pg - 0.5);
    float edgeF = unit(wfbm(uv * 26.0 + 5.0, 2));
    float tearF = unit(wfbm(uv * 8.0, 3));
    for (int oy = 0; oy < 2; oy++){
      for (int ox = 0; ox < 2; ox++){
        vec2 cid = pb + vec2(float(ox), float(oy));
        float ha = hash21(cid + seed * 17.0);
        if (ha < 0.40) continue;
        vec2 sz = vec2(0.44 + hash21(cid * 1.7 + 3.3) * 1.05,
                       0.40 + hash21(cid * 2.9 + 11.1) * 1.15);
        vec2 lo = cid + vec2(hash21(cid * 3.7 + 21.5),
                             hash21(cid * 5.3 + 31.9)) * 0.85 - 0.12;
        vec2 f = (pg - lo) / sz;
        if (f.x < 0.0 || f.x > 1.0 || f.y < 0.0 || f.y > 1.0) continue;
        vec2 pxf = px * vec2(1.15, 0.72) / sz;

        /* How long it has been up decides everything else about it. */
        float age = hash21(cid * 7.1 + 41.3);
        float d = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
        // The edge erodes inward by a noisy amount, more on the old ones.
        float m = smoothstep(0.0, 0.035, d - mix(0.02, 0.16, age) * edgeF);
        // And the old ones have been torn through in the middle as well.
        m *= max(1.0 - age, smoothstep(0.30 * age, 0.30 * age + 0.14, tearF));
        // One corner lifting, which is the single most recognisable thing.
        m *= 1.0 - step(0.55, ha) * smoothstep(0.42, 0.16, f.x + f.y) * 0.85;
        if (m < 0.004) continue;

        float hp = hash21(cid * 9.7 + 51.1);
        vec3 paper = hp < 0.32 ? vec3(0.1420, 0.1370, 0.1250)   // newsprint
                   : hp < 0.56 ? vec3(0.2100, 0.2010, 0.1830)   // bleached white
                   : hp < 0.74 ? vec3(0.1320, 0.0680, 0.0300)   // orange-tan
                   : hp < 0.89 ? vec3(0.0430, 0.0570, 0.0960)   // blue
                               : vec3(0.1400, 0.1180, 0.0430);  // yellow
        paper = mix(paper, col, age * 0.60);

        /* Type. At three metres a headline on a bill this size is two pixels
         * tall, so what has to be there is a dark mass in the upper half and a
         * few shorter lines under it in the poster's own proportions. Drawing
         * letterforms at that scale would be drawing noise. */
        float ib = hash21(cid * 13.9 + 61.7);
        float ink = 0.0;
        if (ib > 0.20){
          ink = aaBand(0.08, 0.92, f.x, pxf.x)
              * aaBand(0.50 + ib * 0.18, 0.91, f.y, pxf.y);
          for (int L = 0; L < 3; L++){
            float hl = hash21(cid * 17.0 + float(L) * 7.7);
            float yl = 0.42 - float(L) * 0.125;
            ink = max(ink, aaBand(0.10, 0.28 + hl * 0.60, f.x, pxf.x)
                         * aaBand(yl, yl + 0.052, f.y, pxf.y) * 0.7);
          }
        }
        paper = mix(paper, paper * 0.26, ink * (1.0 - age * 0.55));
        col = mix(col, paper, m * (0.50 + 0.42 * (1.0 - age)));
      }
    }
    // The base takes the splash and the scuffing.
    col *= 0.62 + 0.38 * smoothstep(0.05, 1.15, hh);

  } else if (part < 4.5){
    /* ── Fascia board ──────────────────────────────────────────────── */
    /* The one place on the ground storey where a saturated colour belongs. A
     * shop sign is a deliberate, commercial, slightly wrong colour and a whole
     * street of them at different values is a large part of what a shopping
     * parade looks like. Still linear reflectance, so still darker than it
     * reads written down. */
    float g = hash21(vec2(seed * 29.0, 6.7));
    col = g < 0.20 ? vec3(0.0210, 0.0430, 0.0250)
        : g < 0.38 ? vec3(0.0620, 0.0150, 0.0130)
        : g < 0.52 ? vec3(0.0170, 0.0250, 0.0560)
        : g < 0.66 ? vec3(0.1500, 0.1360, 0.1080)
        : g < 0.80 ? vec3(0.0170, 0.0175, 0.0190)
                   : vec3(0.1150, 0.0630, 0.0180);
    rgh = 0.52 + 0.34 * unit(wfbm(uv * 6.0, 3));
    /* Signwriting, set on the unit rather than on the terrace.
     *
     * The board carries its own extent now, so the name is centred on the
     * premises with a proper margin, its cap height is a fraction of the board
     * it sits on, and a long unit gets a long name instead of a slice through
     * whatever the fixed period happened to put there. A shopping street where
     * two thirds of the fascias are blank is not a shopping street, and the
     * blankness was that period, not a decision — so the only units without a
     * name now are the ones that have gone: a vacant board has had its letters
     * taken off it or painted over, which is a different fact about the street
     * and worth keeping. */
    float bot = vShop2.x, top = vShop2.y;
    float u0 = vShop2.z, uw = max(vShop2.w, 0.4);
    float h = max(top - bot, 0.05);
    /* Cap height between a third and a half of the board, which is the range
     * real fascias sit in, and different on every unit. */
    float cap = h * (0.34 + 0.16 * hash21(vec2(seed * 7.3, 2.9)));
    float base = bot + (h - cap) * (0.40 + 0.24 * hash21(vec2(seed, 8.2)));
    // Margin, wider on a wide board because a long name is not set edge to edge.
    float mg = min(uw * 0.5 - 0.15, 0.16 + uw * 0.09);
    float bw = max(uw - mg * 2.0, 0.1);
    float band = 0.0;
    if (lit < 0.5 && hash21(vec2(seed * 3.7, 13.1)) < 0.88){
      int row = SGN_FASCIA0
              + int(hash21(vec2(seed * 3.1, 27.5)) * float(SGN_FASCIAN) * 0.999);
      /* The name is set at whatever size fits the board and centred on it —
       * a long trade on a narrow unit is painted smaller, which is what a
       * signwriter does, rather than being stretched to the margins. */
      float capD = min(cap, bw / signAspect(row));
      float wD = capD * signAspect(row);
      band = signInk(row, vec2((uv.x - u0 - (uw - wD) * 0.5) / wD,
                               (uv.y - base) / capD), px / capD, gMir);
    }
    vec3 ink = hash21(vec2(seed, 19.0)) < 0.6
             ? vec3(0.3200, 0.3050, 0.2720) : vec3(0.1400, 0.1080, 0.0380);
    /* Paint over a signboard is not perfectly opaque and it is never evenly
     * worn — the letters go thin where the weather gets at them. */
    col = mix(col, ink, band * (0.72 + 0.20 * unit(wfbm(uv * 21.0, 2))));
    // Sun bleach on the board, which is what makes an old sign read as old.
    float face = dot(vWN, uSun);
    col = mix(col, mix(col, vec3(dot(col, vec3(0.33))), 0.42) * 1.10,
              smoothstep(0.0, 0.6, face) * 0.6);
    // And a vacant unit's board has faded to nothing at all.
    col = mix(col, mix(col, vec3(dot(col, vec3(0.33))), 0.75) * 0.85, lit);
    col *= 0.86 + 0.26 * unit(wfbm(uv * 1.4 + 31.0, 3));
    gSpecCut = 0.22;

  } else if (part < 5.5){
    /* ── The room behind the glass ─────────────────────────────────── */
    /* Two jobs. Unlit, it has to be a dark but not black volume with enough
     * tonal separation between its floor, walls and ceiling that the parallax
     * behind the pane is legible as depth rather than as a smudge. Lit, it is
     * the source: the ceiling emits, the walls and floor carry the falloff,
     * and System 5 hangs the actual spill on the aperture. */
    col = mix(vec3(0.0450, 0.0430, 0.0410), vec3(0.0900, 0.0860, 0.0800), tone);
    col *= 0.78 + 0.42 * unit(wfbm(uv * 1.9 + 5.0, 3));
    rgh = 0.88;
    float up = clamp(vWN.y, 0.0, 1.0);
    /* A shop floor is darker and shinier than its walls: vinyl or worn tile.
     * Warm, though, and that is the correction. The floor was being darkened
     * neutrally and then picking up the canyon's fill, which low in a street is
     * strongly blue — so under a tungsten ceiling the one surface in the room
     * that should be the warmest thing in it was coming back blue-grey and
     * reading as unrelated to everything above it. Worn vinyl and worn boards
     * are both warm; the neutral was never right for either. */
    col = mix(col, col * vec3(0.72, 0.58, 0.44), up * 0.85);
    rgh = mix(rgh, 0.42, up * 0.7);

  } else {
    /* ── Fittings ──────────────────────────────────────────────────── */
    col = mix(vec3(0.0620, 0.0600, 0.0570), vec3(0.1050, 0.0980, 0.0900), tone);
    rgh = 0.66;
    /* Stock on the shelves, as colour speckle at shelf pitch. It is a cheat
     * and it is the right one: what a shop window actually shows at fifteen
     * metres is a field of small saturated patches at regular heights, and
     * modelling any of it as objects would be thousands of triangles behind a
     * pane that is mostly reflecting the street anyway. */
    vec2 pc = floor(vec2(uv.x * 11.0, uv.y * 14.0));
    float pr = hash21(pc + 3.7);
    vec3 goods = 0.5 + 0.5 * cos(6.28318 * (pr + vec3(0.0, 0.33, 0.67)));
    /* Pulled most of the way to grey, and that is a correction rather than a
     * preference. Packaging is printed, not dyed, and it is being seen through
     * a dirty pane from across a footway: at full saturation this read as a
     * pastel checkerboard laid over the counter, which is what it literally
     * is. Muted and gated by footprint, it converges to a field of slightly
     * different tones, which is what stock actually looks like at ten metres. */
    goods = mix(vec3(dot(goods, vec3(0.3333))), goods, 0.30);
    float fine = 1.0 - smoothstep(0.4, 1.4, px / 0.085);
    col = mix(col, goods * 0.055, step(0.52, pr) * 0.45 * fine);
  }

  /* ── The light inside a room ───────────────────────────────────────
   *
   * Shared by the shell and its fittings, because they are in the same room
   * and the first cut applied it only to the shell. That is what produced the
   * floating shelves: a rack's tops were being lit as though they were paving
   * while its uprights were not, so every unit read as a ladder hanging in a
   * void with a glowing counter beside it. */
  if (part > 4.5){
    /* There is no sky in here, there is a ceiling.
     *
     * canyonSky multiplies up-facing surfaces by as much as 7.4x, and that is
     * right outdoors — a paving slab sees the whole dome and a wall sees a
     * slot of it. Indoors it is simply false, and it was the single largest
     * error in this system: it blew out every horizontal surface behind the
     * glass, turned the shop floors a saturated teal by running them through
     * the canyon's blue tint at seven times strength, and swamped the lit
     * store's warm ceiling with enough blue fill to average it to grey. What
     * light is in an unlit shop comes through the window, horizontally. */
    gAO /= 1.0 + 6.40 * clamp(vWN.y, 0.0, 1.0);
    /* And it falls off going back, because a shop window is a small aperture.
     * Without this the back wall sits at the same value as the reveal and the
     * depth is lost, which is the flat-panel failure the modelled room exists
     * to fix in the first place. */
    gAO *= 0.09 + 0.91 * (1.0 - smoothstep(0.10, 2.10, vDepth));

    if (lit > 0.5){
      vec3 lc = lit > 1.5 ? LIT_BAR : LIT_STORE;
      /* Cut the canyon almost out. A trading shop is lit by its own fittings
       * and by very little else, and leaving the fill in is what made the
       * store read neutral: the canyon term low in a street is strongly blue,
       * and blue fill under a tungsten emissive averages to grey. Raising the
       * emissive against it only produced a brighter grey. */
      gAO *= 0.18;
      /* Tubes at 900 mm centres, on the ceiling only. A real shop ceiling has
       * bright runs with dimmer soffit between them, and a perfectly even one
       * reads as a lightbox. */
      float tubes = 1.0 + 0.35 * sin(uv.x * 6.28318 / 0.9);
      // The ceiling is the fitting, so only the shell has one; a shelf is lit
      // by it rather than being it.
      float ceil = part < 5.5 ? clamp(-vWN.y, 0.0, 1.0) : 0.0;
      gEmit += lc * 1.55 * ceil * tubes * uLitGain;

      /* Everything else in the room re-emits what the ceiling throws at it,
       * and the albedo term is the whole point of writing it this way.
       *
       * The first two passes added a flat warm value to every interior
       * surface, and the result was a slab: painting radiance directly
       * overwrites the shading, so the floor, both side walls, the back wall
       * and the door all came back at the same number and the room had no
       * structure in it whatsoever. The unlit units next door looked far
       * better, which is the tell — they were being shaded rather than
       * painted. Reflected radiance is irradiance times albedo, so a dark
       * vinyl floor under a bright ceiling stays a dark floor.
       *
       * ── Why this was rewritten, which is the System 5 handover finding ──
       *
       * That reasoning was right and the arithmetic under it was not. The
       * ceiling lands at 1.674 in red and the back wall — the surface a
       * street-level camera looking through the window actually sees most of
       * — landed at 0.060, an eighth of a stop above the sensor floor and
       * code 37 on screen. The shopfront threw a correctly measured pool onto
       * the footway while the shop itself read as an unlit hole, which a
       * viewer reads as a bug even though the pool is right.
       *
       * Three factors multiplied to produce it, none of them visible on its
       * own:
       *
       * 1. 'col' here is 0.045-0.09. That is the *unlit* room's appearance
       *    used as an albedo, and 6.7 per cent reflectance is a coal cellar.
       *    A trading unit is decorated, so the lit branch now lifts it to
       *    about 0.45 on the walls — and, being a lift of 'col' rather than a
       *    constant, keeps every bit of the noise structure above it.
       * 2. The depth term fell to 0.30 at the back of the room. That term is
       *    a daylight-aperture idea and it is simply false here: the emissive
       *    ceiling runs the full depth of the room, so the back wall is
       *    directly under the far end of the source and is not further from
       *    the light at all. It survives at 0.22 because the front of the
       *    room does get some sky through the glass; it no longer crushes.
       * 3. The height term bottomed at 0.20 where a 2.8 m room under a
       *    ceiling source is about 0.55.
       *
       * 0.32 x 0.20 x 0.30 is 0.019, which the 11.0 in front was silently
       * compensating for at one point in the room and nowhere else. So the
       * coefficient is now literally the ceiling's own radiance, 1.55, and
       * 'ff' is a form factor that stays inside 0..1: the line reads as
       * reflected = albedo x form factor x source, and can be checked as one.
       * 'tools/interior.mjs' evaluates it on the CPU against the real AgX
       * transform; keep the two in step.
       *
       * The ceiling is deliberately untouched. System 5 authored its aperture
       * radiance against it, and this change moves the area-weighted aperture
       * from 0.40 to 0.50 — toward that 0.90, not away from it. */
      float up = clamp(vWN.y, 0.0, 1.0);
      col *= part < 5.5 ? 6.6 - 3.6 * up : 4.6;
      /* Bright at the ceiling, falling toward the floor and toward the back.
       * The gradient is worth stating deliberately rather than letting it
       * fall out: System 5 puts a pool of warm light on the footway outside
       * these windows, and a pool needs something consistent behind it to sit
       * against — an interior at one value would make the spill read as a
       * decal on the paving. It is a gentler gradient than it was, but it is
       * still a factor of two from the reveal to the back corner. */
      float ff = (0.50 + 0.34 * up)
               * (0.55 + 0.45 * smoothstep(0.0, 2.35, hh))
               * (1.0 - 0.22 * smoothstep(0.15, 2.40, vDepth));
      // Fittings a little over half: a gondola stands in front of the wall the
      // ceiling is washing, and reading as a silhouette against it is what
      // says "shelves" from across the road.
      float shell = part < 5.5 ? 1.0 : 0.55;
      gEmit += lc * 1.55 * col * ff * shell * (1.0 - ceil) * uLitGain;
    }
  }

  /* ── Common street-level weathering ───────────────────────────────── */

  // Traffic film, on everything, with a soft top edge around head height.
  float grime = (1.0 - smoothstep(0.5, 2.9, hh))
              * (0.55 + 0.5 * unit(wfbm(uv * 1.15 + 3.0, 3)));
  col = mix(col, col * vec3(0.55, 0.55, 0.58), grime * 0.42);
  /* And the inside corner where all of this meets the paving. There is no cast
   * shadow available at a wall base at four degrees — on the sunny side the
   * light comes from the open side of the corner and on the shaded side the
   * whole thing is in shadow anyway — so the occlusion has to be stated. */
  gAO *= mix(0.26, 1.0, smoothstep(-0.03, 0.85, hh) * 0.45
                      + smoothstep(-0.01, 0.14, hh) * 0.55);
  float damp = 1.0 - smoothstep(0.04, 0.55, hh);
  col *= 1.0 - damp * 0.34;

  diffuseColor.rgb *= col;
  roughnessFactor = clamp(rgh, 0.22, 1.0);
  metalnessFactor = met;
  // Distance-filtered specular, as everywhere else: a shopfront a hundred
  // metres down the street is at grazing incidence over its whole area.
  roughnessFactor = max(roughnessFactor,
    smoothstep(30.0, 90.0, length(vWPos - cameraPosition)) * 0.82);
}
`;

export function makeShopMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1, metalness: 0,
    /* Every one of these is a closed box or a single-sided panel facing the
     * street, so the shadow pass has to be told to use front faces. Left at
     * three's default of BackSide the whole of System 3 would cast nothing:
     * this is the trap the kerb fell into in System 1 and the facades in
     * System 2, and here it would take out every shopfront shadow and the
     * modelled door recesses with them. */
    shadowSide: THREE.FrontSide,
    dithering: true,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uSun = { value: new THREE.Vector3(...SUN_DIR) };
    shader.uniforms.uLitGain = LIT_GAIN;
    Object.assign(shader.uniforms, signUniforms(), artificialUniforms());
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `
${FACADE_VARYINGS}
varying vec2 vFuv;
varying vec4 vShop;
varying vec4 vShop2;
varying float vBase;
varying float vDepth;
attribute vec4 aShop;
attribute vec4 aShop2;
void main() {`)
      .replace('#include <begin_vertex>', `${FACADE_VERTEX}
vFuv = uv;
vShop = aShop;
vShop2 = aShop2;
vBase = aShop.z;
/* How far behind the aperture plane this fragment sits, which is what the
 * interior's front-to-back light gradient is a function of.
 *
 * Both rows run along z with their normals on x, so the aperture is a plane of
 * constant world x: aShop2.x is where it is and aShop2.y is which side of it
 * the room is on. One subtraction rather than a projection, and it is done
 * here rather than in the fragment shader because it is exactly linear. */
vDepth = (aShop2.x - vWPos.x) * aShop2.y;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${NOISE}\n${STREET_PARS}\nvarying vec4 vShop;\nvarying vec4 vShop2;\nvarying float vBase;\nvarying float vDepth;\nuniform float uLitGain;\n${CANYON}\n${ARTIFICIAL}\n${SHOP_DECL}\nvoid main() {`)
      .replace(HOOK, `${HOOK}\n${SHOP_BODY}`)
      .replace('#include <normal_fragment_maps>', FACADE_NORMAL)
      .replace('#include <emissivemap_fragment>', STREET_EMISSIVE)
      .replace('#include <lights_fragment_end>', streetEnd(3.2, 1.0));
  };
  m.customProgramCacheKey = () => 'street3-shop';
  return m;
}

/* ── Shopfront glazing ──────────────────────────────────────────────────── */

/*
 * A real pane over a real room, rather than a painted-on interior.
 *
 * System 2's window glass is opaque and composites an imaginary room in the
 * shader, which is the right answer for a first floor sash: the room is
 * genuinely invisible and modelling it would be tens of thousands of triangles
 * for nothing. A shopfront is the opposite case. The room behind it is two
 * metres deep, brightly lit in the units that are trading, and — the part that
 * matters — it moves against the mullions as the camera walks past. That
 * parallax is the whole cue, and no shader can fake it.
 *
 * So the interior is modelled and the pane is a Fresnel-weighted blend over
 * it. `metalness` is forced to 1, which removes the diffuse term entirely and
 * makes diffuseColor the specular colour, and `diffuseColor.a` carries the
 * Fresnel reflectance. The composite that comes out of the blender is then
 *
 *     tint * environment * F   +   room * (1 - F)
 *
 * which is exactly the physical model, with F running from about 6 per cent
 * head-on to unity at grazing. Head-on you see the shop; along the street you
 * see the sky. That angular swing is most of what makes plate glass read as
 * plate glass.
 *
 * The usual objection to a transparent surface is sort order, and it does not
 * apply here. Every pane in the street is in one merged geometry, so three
 * sorts nothing within it, and the panes are coplanar with the frontage they
 * belong to and do not overlap each other. Two coplanar non-overlapping
 * rectangles cannot overlap in screen space, and the two frontages face each
 * other across the street rather than stacking. depthTest stays on, so an
 * opaque shutter or an awning in front of a pane still occludes it correctly.
 */
const GLASS_DECL = /* glsl */ `
varying vec4 vGlassP;
uniform float uBuildLine;
uniform vec3 uHorizonSun;
uniform vec3 uHorizonAway;
vec3 gTint = vec3(1.0);
float gClear = 1.0;
`;

/* THE SPACE EVERY CONSTANT IN THE REFLECTED WORLD BELOW IS AUTHORED IN.
 *
 * Read this before changing `litWall`, `shadeWall`, `winC`, `glassC`, `road` or
 * `skyC`. Three rounds of correction on these have stalled on the same
 * ambiguity — the targets were display values read off a finished frame, the
 * measurements were of a bare surface, and nobody had written down which one
 * this shader wants. It is not a matter of taste; the shader answers it.
 *
 * The order of operations, all of it below or downstream of here:
 *
 *   1. these constants resolve into `hit`;
 *   2. `gTint = mix(hit, hazeC, ext)` applies the AERIAL PERSPECTIVE over the
 *      reflected path — 6 per cent at twelve metres, a third at forty;
 *   3. `gTint` is mixed toward its own luminance for the film on the pane;
 *   4. it is substituted for `indirectSpecular` and weighted by the pane's
 *      two-interface FRESNEL, in linear light, in the shader tail;
 *   5. the fragment's own aerial perspective to the camera, then the bloom, the
 *      tone map and the grade, none of which this shader can see.
 *
 * So: A CONSTANT HERE IS THE LINEAR RADIANCE LEAVING THE REFLECTED SURFACE WITH
 * NO AIR IN FRONT OF IT AND NOTHING APPLIED TO IT. It is not a display value,
 * not a display value inverted through a curve, and not "what the pane should
 * look like" — the pane's own appearance is this times a Fresnel of 0.08 to 0.2
 * composited over a lit interior, two haze terms and a tone curve later.
 * Authoring against a graded frame folds every one of those in a second time,
 * which is how the sunlit wall in here came to be four times as bright as the
 * sunlit wall it is a picture of.
 *
 * The measurement, therefore, is of the referent and not of the frame:
 * `tools/reflsurf.mjs` finds each surface by raycast, meters it on
 * `?nograde&nohdr&haze=off`, drops samples standing in a lamp pool, and prints
 * each constant beside the surface it claims to depict. Every value in here is
 * checkable against a thing that is also in the frame. If a correction is ever
 * applied, it belongs in one commit with that tool's output quoted.
 */
const SHOP_GLASS_BODY = /* glsl */ `
{
  vec2 uv = vFuv;
  float px = fwidth(uv.x) + fwidth(uv.y);
  float key = vGlassP.x;
  float wash = vGlassP.z;

  /* Dirt. A shop window is cleaned weekly at the front and never at the top,
   * so the film is a gradient with rain streaks in it and a solid band of grey
   * in the last hundred millimetres above the cill where the water stands. */
  float streak = unit(wfbm(vec2(uv.x * 22.0, uv.y * 0.7), 3));
  float dirt = 0.16 + 0.34 * streak;
  dirt += 0.34 * (1.0 - smoothstep(0.0, 0.14, uv.y - vGlassP.w));
  dirt = clamp(dirt, 0.0, 1.0);

  /* Per-pane tilt. Plate glass in an old frame is not flat — the putty has
   * gone, the frame has racked — and a quarter of a degree is the difference
   * between a row of windows reflecting in lockstep and reflecting like
   * glass. */
  vec2 pj = hash22(vec2(key, 7.3));
  gSlope += (pj - 0.5) * 0.020;

  vec3 Vw = normalize(vWPos - cameraPosition);
  vec3 Nw = normalize(vWN - vWT * gSlope.x - vWB * gSlope.y);
  vec3 R = reflect(Vw, Nw);

  /* What the pane reflects.
   *
   * The environment map is a sky and has no idea there is a building eleven
   * metres opposite, so left to itself every pane at eye level mirrors a
   * blazing amber horizon and comes back as a featureless near-white
   * rectangle. That is why the ray is resolved by hand.
   *
   * The first version resolved it to one of four constants, and the review is
   * right that this was a modelling failure rather than a tuning one. On the
   * sunlit side of the street every ray lands in the same constant — a
   * west-facing pane reflects the east terrace, the east terrace never catches
   * this sun, so the entire row returned a flat 0.34 grey-blue. The Fresnel
   * fraction was correct and moved the composite by five to nine per cent
   * exactly as the arithmetic said it would; what it was a fraction *of* had
   * no content in it at all. A constant is not a reflection, and no amount of
   * Fresnel makes one look like glass.
   *
   * So it is resolved against a crude street: the ray is intersected against
   * the road, the frontage opposite and the parapet over it, the frontage is
   * given storey banding and window bays so there is something in it, and then
   * — the term that actually carries golden hour — the whole thing is fogged
   * by the length of the reflected path. A ray leaving a pane at a grazing
   * angle runs forty metres down the canyon before it meets anything, and
   * forty metres of this air is most of the way to the horizon glow. Grazing
   * is also where Fresnel is largest, so the two compound. That is the whole
   * reason a shopfront photographed along a street at low sun is a mirror and
   * the same shopfront photographed square on is a window, and it now falls
   * out of the model rather than having to be asserted. */
  const float ROOFLINE = 13.5;
  float dFace = abs(R.x) > 0.02
    ? max((sign(R.x) * uBuildLine - vWPos.x) / R.x, 0.0) : 1e4;
  float dRoof = R.y >  0.002 ? (ROOFLINE - vWPos.y) / R.y : 1e4;
  float dRoad = R.y < -0.002 ? (0.02 - vWPos.y) / R.y     : 1e4;
  float dHit  = min(min(dFace, dRoof), min(dRoad, 62.0));
  float yHit  = vWPos.y + R.y * dHit;
  float zHit  = vWPos.z + R.z * dHit;

  /* The frontage opposite, in two bands with a hard line between them.
   *
   * The band structure is the whole content of the reflection and the previous
   * version blurred the one edge that carries it: the sunlit-to-shade
   * transition was smoothed over four metres, which at the scale a pane
   * subtends is a gradient across the entire reflected wall, and a gradient
   * reads as a tinted sheet. At 4.2 degrees the terrace opposite throws a
   * shadow whose upper edge is the parapet — a straight line, sharp to within
   * its own penumbra, which at this range is a few hundred millimetres. So it
   * is drawn as one, antialiased against the footprint of the reflected ray
   * rather than smoothed by hand.
   *
   * Only the west side takes this sun, so a ray heading +X can never find a
   * sunlit wall however far up it goes.
   *
   * The line was at 6.5 m, which was a guess and a badly wrong one. The scene
   * itself is the measurement: every frame shows the west frontage taking the
   * sun straight down to the stallriser, because at this azimuth the beam runs
   * along the canyon rather than across it and is not cut off by the terrace
   * opposite. So a pane on the shaded side of the street is looking at a wall
   * that is lit from the pavement up, and putting the shadow line at first
   * floor level was throwing away the one genuinely bright thing the mirror
   * has to work with. It varies along the run because the projections up-street
   * — awnings, blades, a parapet return — put the bottom of some bays in
   * shadow, and a skyline of bright and dark blocks is more of a reflection
   * than an unbroken bright field would be. */
  float bay = floor(zHit / 2.55);
  float litLine = R.x < -0.02
    ? mix(0.15, 3.4, step(0.68, hash21(vec2(floor(zHit / 8.1), 2.1)))) : 1e6;
  /* Penumbra scaled by the reflected path length: near hits get a hard edge,
   * far ones soften, which is both correct and what keeps the line from
   * aliasing when the pane is at a glancing angle. */
  float pen = 0.25 + dHit * 0.010;
  float sun = smoothstep(litLine - pen, litLine + pen, yHit);
  vec3 shadeWall = vec3(0.30, 0.31, 0.37);
  /* The bottom of an eleven-metre canyon sees barely a third of the sky, so
   * the shaded frontage is much darker at the footway than at the eaves. The
   * sunlit band is exempt: a wall in direct sun is not sky-limited, and
   * applying the occlusion to it was halving the one bright thing in the
   * reflection. */
  shadeWall *= 0.42 + 0.58 * smoothstep(0.0, 7.5, yHit);
  /* Sunlit stucco, at the radiance this scene actually gives a sunlit wall.
   *
   * Getting this number right is the whole of why the glazing stayed dark, and
   * getting it wrong twice is worth recording. Both previous values were set by
   * eye against a tonemapped frame, and a tonemapped frame is exactly the wrong
   * place to judge a radiance from: forcing the reflection through unweighted
   * put it at display 135 where a sunlit fascia measured 187, which looks like
   * a two-thirds shortfall and is nothing of the kind.
   *
   * That paragraph then got it wrong a third time, and this is the correction.
   * The curve it calibrated against, display = 0.284 * L^0.4545, was fitted
   * through a pane of glass and has since been withdrawn; tools/agx.mjs ports
   * the renderer's actual AgX transform and inverts it numerically. The same
   * sunlit fascia at display 191 comes back at a scene radiance of 2.50, not
   * 8.5. The old fit over-predicts by 3.4x here, so the 2.3 this constant used
   * to carry was very nearly right and the raise to 8.5 was the error.
   *
   * The inverted surface matters and it is worth being explicit, because the
   * companion raise in carMaterials.ts may not have the same shape. What was
   * inverted here is an opaque sunlit stucco fascia, seen directly, so its
   * display value is its own radiance and no Fresnel term stands between the
   * two. Dividing one out would be wrong. The pane's throughput — 1.6 in
   * returning display 90, which AgX puts at 0.266, so about 0.17 — is a
   * reflectance, not an error to be cancelled: a shop window at this angle is
   * meant to return a sixth of what it faces, and a reflection reading dimmer
   * than the wall it reflects is the correct result rather than a shortfall to
   * be tuned away. Sanity check on the arithmetic: every sibling radiance in
   * this synthetic environment — the lit windows at 2.4, the glass opposite at
   * 1.75 — sits near 2, and only this one stood at 8. */
  vec3 litWall = vec3(3.85, 2.25, 0.98) * (0.84 + 0.32 * hash21(vec2(bay, 5.1)));
  vec3 wall = mix(shadeWall * (0.78 + 0.44 * hash21(vec2(bay, 5.1))), litWall, sun);
  /* Window bays, dark against the masonry, in a row per storey. Crude to the
   * point of being a joke as architecture, and entirely sufficient as content:
   * what makes a reflection read is that it is broken up, not that it is
   * recognisable.
   *
   * Which way round they go depends on which wall it is, and this is the
   * finding that made the reflection work. A window in a sunlit wall is a hole:
   * darker than the masonry around it, because you are seeing a room. A window
   * in a *shaded* wall opposite a sunlit one is the brightest thing on that
   * elevation, because it is a mirror aimed at the terrace in the sun — which
   * is exactly the relationship the pane doing the reflecting is in. A pane on
   * the sunlit side of this street can never reflect a sunlit wall, because the
   * frontage opposite it is self-shadowed at every hour of this evening; what
   * it can and should reflect is a row of bright rectangles set in a dark one,
   * and that is a hard-edged block of facade luminance in a pane whichever way
   * the geometry falls. */
  float st = fract((yHit - 0.55) / 3.15);
  float winRow = smoothstep(0.14, 0.24, st) * (1.0 - smoothstep(0.58, 0.68, st));
  float winBay = step(0.34, hash21(vec2(bay, 11.7))) * step(2.6, yHit);
  vec3 winC = mix(vec3(3.60, 2.40, 1.25) * (0.55 + 0.75 * hash21(vec2(bay, 23.9))),
                  wall * 0.13 + vec3(0.030, 0.031, 0.040), sun);
  wall = mix(wall, winC, winRow * winBay * 0.90);
  /* The ground storey opposite is a shopfront under a fascia and usually an
   * awning, so it is darker than the wall above whether or not the wall is in
   * the sun — and the line where the fascia cornice cuts it is straight, hard,
   * and at a height a square-on pane reflects square in the middle. Its own
   * glass is doing the same trick as the windows above. */
  vec3 fasciaC = wall * 0.26 + vec3(0.010, 0.010, 0.014);
  /* Shopfront glass, which is where most of these rays actually land and which
   * is the brightest surface in the reflection by a wide margin. The pane
   * opposite is a mirror pointed at the sunlit terrace, so it returns a
   * fraction of a very bright wall — dimmer than that wall, brighter than
   * anything else on a shaded elevation, and cut into rectangles by the piers
   * between units. That is the block the review is asking for, and it is where
   * a shopfront actually finds one: not in the sky, which is forty-five
   * degrees above anything a street-level pane can see in an eleven-metre
   * canyon, but in the glass across the road. */
  float unitU = fract(zHit / 4.35);
  float pier = smoothstep(0.03, 0.11, unitU) * (1.0 - smoothstep(0.86, 0.95, unitU));
  vec3 glassC = vec3(2.60, 1.75, 1.05) * (0.30 + 1.05 * hash21(vec2(floor(zHit / 4.35), 47.7)));
  float shopG = pier
    * smoothstep(0.60, 0.72, yHit) * (1.0 - smoothstep(2.78, 2.92, yHit));
  vec3 ground = mix(fasciaC, glassC, shopG * (1.0 - sun * 0.55));
  wall = mix(ground, wall, smoothstep(3.02, 3.16, yHit));

  /* Sky over the parapet: warm and very bright toward the sun, cool and much
   * dimmer away from it, falling off with elevation from the horizon. */
  vec2 raz = normalize(vec2(R.x, R.z) + 1e-5);
  float az = dot(raz, normalize(uSun.xz));
  vec3 skyC = mix(vec3(0.55, 0.66, 1.05), uHorizonSun,
                  smoothstep(-0.35, 0.95, az));
  skyC = mix(skyC, skyC * 0.42 + vec3(0.10, 0.13, 0.26),
             smoothstep(0.02, 0.60, max(R.y, 0.0)));

  /* The ground the ray lands on when it goes down, which on a square-on pane is
   * the street behind the photographer and is the half of the veil that was
   * missing. Every shopfront photographed head on carries a ghost of the kerb
   * line and the carriageway across its lower part; without it the pane is a
   * uniform film over the room rather than a reflection of anywhere. The kerb
   * is the one edge in it worth drawing, because it is the only straight line
   * on the ground plane and it is what makes the ghost read as a street. */
  float xHit = vWPos.x + R.x * dHit;
  float kerb = abs(abs(xHit) - (uBuildLine - 2.30));
  vec3 road = mix(vec3(0.088, 0.086, 0.101), vec3(0.135, 0.132, 0.150),
                  smoothstep(uBuildLine - 2.30, uBuildLine - 2.05, abs(xHit)));
  /* Sunlit footway where the sun reaches it, which it does in bands. At street
   * level this is the brightest thing a downward reflected ray can find by a
   * long way.
   *
   * The target is unchanged and was never the problem: the sunlit flags in
   * these frames measure display 170 to 186. What produced the old value was
   * the same withdrawn fit that put litWall at 13.0 forty lines above — this
   * paragraph used to end "which is a scene radiance near seven", and seven is
   * display = 0.284 * L^0.4545 inverted at 183. The real transform puts the
   * middle of that band at 1.95 neutral, so at this chromaticity the peak
   * channel is 1.93 and the triple arrives at (178, 162, 143) against the old
   * value's (229, 219, 207), which is a hair off white. Five times, and
   * it is the same error and the same commit as litWall's; only litWall was
   * corrected at the time.
   *
   * Measured against the surface it is supposed to be a picture of, rather than
   * against a display value: tools/reflsurf.mjs finds the sunlit footway at
   * L = (1.04, 0.48, 0.42) with the haze off, which is another factor of two
   * below this. The gap is real and is not corrected here, because the 170-186
   * was read off a hazed and graded frame while the measurement is of the bare
   * surface, and the two are not the same quantity. See NOTES.md. */
  road = mix(road, vec3(1.93, 1.38, 0.81),
             step(uBuildLine - 2.25, abs(xHit))
             * smoothstep(0.42, 0.58, hash21(vec2(floor(zHit / 3.4), 3.7))));
  road = mix(road, road * 0.34, 1.0 - smoothstep(0.0, 0.09 + dHit * 0.004, kerb));

  bool toSky  = dRoof <= min(dFace, dRoad);
  bool toRoad = dRoad <  min(dFace, dRoof);
  vec3 hit = toSky ? skyC : (toRoad ? road : wall);

  /* Aerial perspective on the reflected path, in the same air as the scene
   * fog. This is the term the old model was missing outright, and it is worth
   * naming what it buys: at twelve metres — a pane seen square on — it is six
   * per cent and changes nothing, so the interiors survive intact; at forty
   * it is a third; at sixty it is most of the way, and the pane goes to a warm
   * sheet with the terrace ghosting through it. */
  vec3 hazeC = mix(uHorizonAway, uHorizonSun, smoothstep(-0.25, 0.90, az));
  float ext = 1.0 - exp(-pow(dHit * 0.0168, 1.65));
  gTint = mix(hit, hazeC, clamp(ext, 0.0, 0.88));
  /* Film on the pane scatters the reflection rather than removing it, so it
   * loses contrast toward the haze rather than going dark. Multiplying it down,
   * as this did, is the behaviour of a filter and not of dirt. */
  gTint = mix(gTint, hazeC * 0.42, dirt * 0.30);

  /* Fresnel, and there are two interfaces rather than one.
   *
   * The previous version applied Schlick once, which is the reflectance of a
   * single air-to-glass boundary — but a window is a slab, and the light that
   * refracts in meets the glass-to-air boundary on the way out and reflects a
   * second time. For a sheet thin enough to ignore absorption the two sum to
   * 2R/(1+R), which is a factor of 1.8 at grazing and 1.9 at normal. That is
   * not a fudge to make the pane brighter; it is the reflectance of a pane
   * rather than of a surface, and leaving it out is why the arithmetic kept
   * saying six per cent for something that is visibly a mirror at a shallow
   * enough angle.
   *
   * The base is back to the textbook 0.043 for n = 1.52, because the film that
   * the old 0.06 was standing in for is added separately below and was
   * otherwise being counted twice. */
  float ndv = clamp(abs(dot(Nw, -Vw)), 0.0, 1.0);
  float Fs = 0.043 + 0.957 * pow(1.0 - ndv, 5.0);
  float F = 2.0 * Fs / (1.0 + Fs);
  /* The film itself is not specular and does not go away at normal incidence,
   * so it sets a floor on how much of the room is hidden. Kept small: a head-on
   * pane laying a large neutral veil over the interior lifts the room's blacks
   * and is a large part of why a lit shop can read as a slab rather than as a
   * volume. */
  F = clamp(F + dirt * 0.055, 0.0, 1.0);

  /* White, not gTint, and this is the correction rather than a simplification.
   *
   * At metalness 1 three takes diffuseColor.rgb as the specular colour — as an
   * F0 reflectance — and gTint is nothing of the kind: it is the radiance of
   * whatever the reflected ray landed on, resolved above, with values like 2.6
   * in the sunlit band. Handing a radiance to three as a reflectance made it a
   * multiplier on the environment probe instead of a substitute for it, so
   * every pane's brightness was still being driven by the sky cubemap in the
   * reflection direction — the raw-environment failure this street has had
   * before, in a partial form that was harder to see because the hand-resolved
   * term was modulating it rather than being ignored outright.
   *
   * With F0 white, three returns the un-Fresnel'd mirror, gTint is substituted
   * for the environment in the tail below, and diffuseColor.a applies the one
   * Fresnel the composite needs. src*a + dst*(1-a) is then exactly
   * mirror*F + room*(1-F). */
  diffuseColor.rgb = vec3(1.0);
  diffuseColor.a = F;
  roughnessFactor = clamp(0.045 + dirt * 0.11, 0.04, 0.34);
  metalnessFactor = 1.0;

  if (wash > 0.5){
    /* Whitewashed out. An empty unit has its glass painted over from the
     * inside, in one coat, with a brush, by somebody who did not care — so it
     * is streaky, it is thin at the edges, and it is the palest thing on the
     * whole ground storey. It is also opaque, so it hides the room and the
     * reflection together. */
    vec3 w = vec3(0.2050, 0.2000, 0.1880);
    // Brush marks: long strokes across the pane, and a coarser blotch under
    // them where the coat went on thick in places and thin in others.
    w *= 0.72 + 0.44 * unit(wfbm(vec2(uv.x * 3.2, uv.y * 26.0), 3));
    w *= 0.86 + 0.24 * unit(wfbm(uv * 1.1, 3));
    diffuseColor.rgb = w;
    /* Not quite opaque, and deliberately not. Whitewash is one thin coat and a
     * little of the dark room does come through it, which is the difference
     * between a painted-out window and a sheet of card. */
    diffuseColor.a = 0.93 - 0.10 * unit(wfbm(uv * 6.0, 2));
    roughnessFactor = 0.86;
    /* Back to a dielectric, which also switches the diffuse term back on:
     * three zeroes material.diffuseColor at metalness 1, so the canyon sky
     * term in the tail below does nothing on a clear pane and everything on a
     * painted one. That is the correct behaviour in both cases and it falls
     * out of this one line. */
    metalnessFactor = 0.0;
    gSpecCut = 0.2;
    gClear = 0.0;
  }
}
`;

export function makeShopGlassMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 0.06, metalness: 1.0,
    transparent: true,
    /* The pane's own light is premultiplied by its Fresnel weight in the
     * shader tail — see the long note there — so the blend must be
     * src + dst*(1-a) rather than src*a + dst*(1-a). Spelled out with explicit
     * factors instead of the premultipliedAlpha flag, which did not take. */
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    /* Off, deliberately. The pane has to blend over the room behind it, and
     * writing depth would make a later pane in the same buffer fail against an
     * earlier one that is not actually in front of it. depthTest stays on, so
     * anything opaque between the camera and the glass still occludes it. */
    depthWrite: false,
    side: THREE.FrontSide,
    dithering: true,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uSun = { value: new THREE.Vector3(...SUN_DIR) };
    shader.uniforms.uBuildLine = { value: BUILD_LINE };
    shader.uniforms.uHorizonSun = { value: new THREE.Vector3(...HORIZON_SUNWARD) };
    shader.uniforms.uHorizonAway = { value: new THREE.Vector3(...HORIZON_AWAY) };
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `
${FACADE_VARYINGS}
varying vec2 vFuv;
varying vec4 vGlassP;
attribute vec4 aGlass;
void main() {`)
      .replace('#include <begin_vertex>', `${FACADE_VERTEX}\nvFuv = uv;\nvGlassP = aGlass;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${NOISE}\n${STREET_PARS}\n${GLASS_DECL}\n${CANYON}\nvoid main() {`)
      .replace(HOOK, `${HOOK}\n${SHOP_GLASS_BODY}`)
      .replace('#include <normal_fragment_maps>', FACADE_NORMAL)
      .replace('#include <lights_fragment_end>', `
#include <lights_fragment_end>
/* Drain the saturation out of the reflection, exactly as the sash glass does.
 * A pane with city film on it is not a first-surface mirror: most of what
 * leaves it toward the eye has been scattered rather than specularly
 * reflected, and every one of those effects pulls the result toward grey.
 * Mixing toward luminance is the one operation that reduces saturation without
 * changing level — a per-channel gain cannot do it, and trying produced a row
 * of electric blue rectangles the last time it was attempted. */
if (gClear > 0.5){
  /* Substituted, not scaled. The environment probe is a sky and does not know
   * there is a building eleven metres opposite; gTint is what the ray actually
   * lands on. Letting the probe through as a multiplier meant a row of panes
   * brightened and dimmed with the sky behind the camera rather than with what
   * was in front of them. */
  reflectedLight.indirectSpecular =
    mix(gTint, vec3(dot(gTint, vec3(0.2126, 0.7152, 0.0722))), 0.42);
  reflectedLight.indirectDiffuse = vec3(0.0);
  /* The sun's own mirror image stays, and at F0 white it is the un-Fresnel'd
   * lobe that diffuseColor.a is there to weight. Damped, because a pane with a
   * week of film on it scatters a good part of the specular return before it
   * reaches the eye — without that this is a pinpoint at several hundred times
   * the level of anything around it. */
  reflectedLight.directSpecular *= 0.55;
} else {
  vec3 s = reflectedLight.indirectSpecular * gSpecCut;
  reflectedLight.indirectSpecular =
    mix(s, vec3(dot(s, vec3(0.2126, 0.7152, 0.0722))), 0.60) * 1.55;
  reflectedLight.directSpecular *= gSpecCut;
  reflectedLight.indirectDiffuse =
    canyonSky(reflectedLight.indirectDiffuse, vWN, vWPos.y) * 2.4;
}

/* Premultiply, and this is the whole reason the glazing had no reflectance.
 *
 * The comment above used to claim that "src*a + dst*(1-a) is exactly
 * mirror*F + room*(1-F)". That identity holds in linear light. It does not
 * hold here, because three tone maps and encodes in the fragment shader:
 * gl_FragColor leaves this program already in sRGB, and the blend that
 * applies the Fresnel alpha therefore runs on display values. In display
 * space a 6 per cent alpha can add at most six per cent of white — about
 * fifteen counts — however bright the reflection behind it is. The mirror was
 * being computed correctly and then thrown away by the compositor.
 *
 * The measurement that pinned it: forcing the reflected radiance to 40 and
 * then to 3 changed the pane by the same handful of counts, and forcing the
 * alpha to 1 at the same time took it straight to 199. The reflection was
 * never reaching the frame; that is why the previous round's Fresnel fix
 * moved the composite by five to nine per cent and why the review read the
 * result as a modelling failure rather than a tuning one. It was neither —
 * it was a compositing one.
 *
 * So the Fresnel weight is applied here, in linear light, before tone
 * mapping, and the alpha is left to do nothing but attenuate what is behind.
 * With premultipliedAlpha the blend is src + dst*(1-a), which is the same
 * arithmetic carried out in the only space where it means anything. */
reflectedLight.directDiffuse    *= diffuseColor.a;
reflectedLight.indirectDiffuse  *= diffuseColor.a;
reflectedLight.directSpecular   *= diffuseColor.a;
reflectedLight.indirectSpecular *= diffuseColor.a;
totalEmissiveRadiance           *= diffuseColor.a;
`);
  };
  m.customProgramCacheKey = () => 'street3-glass';
  return m;
}

/* ── Roller shutters ────────────────────────────────────────────────────── */

const SHUT_DECL = /* glsl */ `
varying vec4 vShutP;
`;

const SHUTTER_BODY = /* glsl */ `
{
  vec2 uv = vFuv;
  float px = fwidth(uv.x) + fwidth(uv.y);
  float seed = vShutP.x;
  float kind = vShutP.y;
  vec3 col; float rgh; float met;

  /* Shutters come in four finishes and no others: mill-finish aluminium,
   * galvanised steel, and the two colours somebody painted over them. */
  /* Reflectances, not impressions. Mill-finish aluminium is a light silvery
   * sheet — LRV 41 once it has a few years of street dust on it — and it was
   * authored at 0.129, darker than the concrete flags it stands on. Weathered
   * galvanised is a duller grey at 30, and the two paints are 11.
   *
   * The correction is larger than it looks, because the curtain's own
   * modulation takes roughly a quarter back out again: the lath profile times
   * the grime run averages about 0.73 of base before anything else touches it,
   * so what these numbers set is a ceiling the surface then works down from. */
  float g = hash21(vec2(seed * 7.7, 1.3));
  vec3 base = g < 0.34 ? vec3(0.4000, 0.4120, 0.4240)      // mill aluminium
            : g < 0.58 ? vec3(0.2900, 0.2980, 0.3000)      // galvanised
            : g < 0.80 ? vec3(0.0620, 0.1280, 0.0880)      // painted green
                       : vec3(0.1550, 0.1050, 0.0620);     // painted brown

  if (kind < 0.5){
    /* ── The curtain ────────────────────────────────────────────────
     *
     * A 77 mm single-skin lath, which is a real profile, phased off the bottom
     * rail so the corrugation lines up with where the shutter actually stops
     * rather than with world zero. */
    float ph = (vWPos.y - vShutP.w) / 0.077;
    /* The lath section, and this is the correction the review named.
     *
     * The first version modulated by a sine. A sine is a symmetric fifty-fifty
     * wave — broad light band, broad dark band, one value each — and on the
     * shade side, where there is no sun to break it up, that is not a shutter,
     * it is a venetian blind. The tell that it was shading rather than geometry
     * was that the same laths at the same pitch resolve correctly in direct
     * sun: the profile was carrying the sun's own falloff and nothing of its
     * own.
     *
     * A rolled single-skin lath is nowhere near symmetric. It is a shallow
     * convex face over about six sevenths of the pitch with the crown of the
     * curve high on it, and a rolled seam where it hooks the lath below over
     * the rest. So the signature is a narrow bright crest, a long smooth ramp
     * away from it, and one thin hard dark line per pitch — never half and
     * half. fu runs up the face, tilt is the section's vertical slope
     * through it, skewed so the crown lands at two thirds rather than at the
     * middle.
     *
     * Still carried in tone rather than in slope. At 4.2 degrees a
     * full-amplitude normal on a 77 mm corrugation swings N·L across most of
     * its range between one lath and the next, which is the failure that blew
     * the pavement into white granules; the slope term is left at a token
     * value purely so the surface is not flat to a specular probe. */
    float vis = 1.0 - smoothstep(0.45, 1.30, px / 0.077);
    const float JOINT = 0.155;
    float t   = fract(ph);
    float fu  = clamp((t - JOINT) / (1.0 - JOINT), 0.0, 1.0);
    float jf  = 1.0 - smoothstep(0.0, JOINT * 0.80, t);
    float tilt = cos(pow(fu, 1.7) * 3.14159265);
    /* Ambient response of the face: how much of the sky a few degrees of tilt
     * buys you near the bottom of a canyon, which is a lot. */
    float lath = 0.40 + 0.30 * tilt;
    /* The crest. One line along each lath where the curvature turns the steel
     * square to the sky, and on a shade-side curtain it is the only bright
     * thing on the whole shutter. Narrow is the entire point of it. */
    lath += 0.75 * exp(-pow((fu - 0.70) / 0.095, 2.0));
    // Renormalised so the curtain keeps its mean as the laths fall under a pixel.
    col = base * mix(1.0, lath * 1.52, vis);
    gSlope += vec2(0.0, tilt * 0.055 * vis);
    /* Dirt in the corrugations, which the brief asks for by name and which is
     * the single most identifying thing about an old shutter. Water runs down
     * the face and everything it is carrying settles in the seam, so the
     * hollows are not merely shaded — they are a different, browner, matter
     * colour, and they stay dark when the crowns catch the sun. */
    float trough = jf;
    float run = unit(wfbm(vec2(uv.x * 16.0, vWPos.y * 0.55), 3));
    col = mix(col, vec3(0.0230, 0.0195, 0.0165),
              trough * (0.42 + 0.40 * run) * vis);
    gAO *= 1.0 - trough * 0.34 * vis;
    rgh = 0.68 + trough * 0.18;
    met = 0.14;
    // Long vertical runs of grime down the whole curtain.
    col *= 0.76 + 0.40 * unit(wfbm(vec2(uv.x * 5.5, vWPos.y * 0.30), 4));
    /* The bottom 350 mm, where the mop, the road spray and the boots land, and
     * where a shutter is always a different colour from its own top half. */
    float low = 1.0 - smoothstep(0.02, 0.38, vWPos.y - vShutP.w);
    col = mix(col, col * vec3(0.44, 0.44, 0.46), low * 0.7);
    /* A pasted bill on about a third of them.
     *
     * The first pass was authored at deliberately low contrast to keep it from
     * reading as signage, and overshot: it mixed a third of the way toward
     * 0.10, which is darker than a mill-aluminium curtain and within two per
     * cent of a galvanised one. Three shutters examined at three metres and
     * not one visible bill on any of them. The caution was aimed at the wrong
     * risk anyway — paper is opaque, and what stops a flyposted bill reading
     * as signage is that it is blank, torn and weathered, not that you can see
     * the shutter through it. So it is grimy newsprint now, and it is the
     * tearing and the fade that do the work. */
    /* This was a fract() of a fixed period against a fixed height band, which
     * is to say four sheets of identical width and height, evenly spaced,
     * hung on one baseline. It is the same fault the pilaster had and it has
     * the same fix: the lattice picks where a bill starts and nothing else,
     * so size, placement, paper and age are the cell's own and a sheet is
     * free to run over its neighbours. Walking a two-by-two neighbourhood is
     * what lets it overlap — a fragment has to test the cells around it, not
     * only the one it sits in. */
    float bh = vWPos.y - vShutP.w;
    if (hash21(vec2(seed * 23.0, 5.5)) > 0.42 && bh > 0.24 && bh < 2.35){
      vec2 pg = vec2((uv.x - vShutP.x) * 1.55, (bh - 0.30) * 1.05);
      vec2 pb = floor(pg - 0.5);
      float edgeF = unit(wfbm(uv * 24.0 + 9.0, 2));
      float tearF = unit(wfbm(uv * 7.5 + 2.0, 3));
      for (int oy = 0; oy < 2; oy++){
        for (int ox = 0; ox < 2; ox++){
          vec2 cid = pb + vec2(float(ox), float(oy));
          if (hash21(cid + seed * 31.0) < 0.52) continue;
          vec2 sz = vec2(0.40 + hash21(cid * 1.9 + 5.1) * 0.95,
                         0.38 + hash21(cid * 3.1 + 13.7) * 1.00);
          vec2 lo = cid + vec2(hash21(cid * 4.3 + 23.9),
                               hash21(cid * 6.1 + 37.3)) * 0.80 - 0.10;
          vec2 f = (pg - lo) / sz;
          if (f.x < 0.0 || f.x > 1.0 || f.y < 0.0 || f.y > 1.0) continue;
          float age = hash21(cid * 8.3 + 43.7);
          float d = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
          float m = smoothstep(0.0, 0.04, d - mix(0.02, 0.15, age) * edgeF);
          m *= max(1.0 - age, smoothstep(0.28 * age, 0.28 * age + 0.15, tearF));
          // A corner lifted off the steel, which is the most recognisable
          // thing a bill on a shutter does.
          m *= 1.0 - step(0.60, hash21(cid * 2.7 + 71.3))
                     * smoothstep(0.40, 0.14, f.x + f.y) * 0.85;
          if (m < 0.004) continue;
          float hp = hash21(cid * 11.3 + 53.9);
          /* Paper reflectance, and this had to move with the curtain rather
           * than after it. A bill is pasted on a shutter to be read from
           * across the road, so it is lighter than the steel; at the old
           * levels, against a mill-aluminium curtain now sitting at 0.40, a
           * sheet of newsprint would have read as a dark rectangle and the
           * flyposting would have inverted into soot marks. Grimy newsprint
           * is LRV 35, bleached poster stock 50. */
          vec3 paper = hp < 0.40 ? vec3(0.3600, 0.3480, 0.3180)   // newsprint
                     : hp < 0.62 ? vec3(0.5200, 0.5000, 0.4550)   // bleached
                     : hp < 0.80 ? vec3(0.3300, 0.1700, 0.0780)   // orange-tan
                                 : vec3(0.3600, 0.3000, 0.1100);  // yellow
          paper = mix(paper, col, age * 0.55);
          vec2 pxf = px * vec2(1.55, 1.05) / sz;
          float ib = hash21(cid * 15.1 + 63.3);
          float ink = 0.0;
          if (ib > 0.22){
            ink = aaBand(0.09, 0.91, f.x, pxf.x)
                * aaBand(0.52 + ib * 0.16, 0.90, f.y, pxf.y);
            for (int L = 0; L < 3; L++){
              float hl = hash21(cid * 19.0 + float(L) * 6.3);
              float yl = 0.42 - float(L) * 0.13;
              ink = max(ink, aaBand(0.11, 0.29 + hl * 0.56, f.x, pxf.x)
                           * aaBand(yl, yl + 0.05, f.y, pxf.y) * 0.7);
            }
          }
          paper = mix(paper, paper * 0.28, ink * (1.0 - age * 0.50));
          col = mix(col, paper, m * (0.58 + 0.38 * (1.0 - age)));
          // Paper is matt, and next to a shutter that is half the recognition.
          rgh = mix(rgh, 0.94, m * 0.80);
          met = mix(met, 0.0, m * 0.80);
        }
      }
    }

  } else if (kind < 1.5){
    /* ── Housing, guides and bottom rail ───────────────────────────── */
    col = base * 0.88;
    col *= 0.82 + 0.34 * unit(wfbm(uv * 7.0, 3));
    rgh = 0.66; met = 0.20;
    /* A guide channel is the wettest 60 mm on a shopfront: it collects the
     * water off the whole curtain and holds it, so it rusts from the bottom
     * and streaks the wall beside it. */
    float rust = smoothstep(0.48, 0.86, unit(wfbm(uv * 2.4 + 9.0, 4)))
               * (0.35 + 0.65 * (1.0 - smoothstep(0.05, 1.2, vWPos.y - vBaseS)));
    col = mix(col, vec3(0.0820, 0.0360, 0.0170), rust * 0.7);
    rgh = mix(rgh, 0.94, rust);
    met = mix(met, 0.04, rust);

  } else {
    /* ── Lock box and ground bolts ─────────────────────────────────── */
    /* And this is where the other half of the wear rule goes. Metal is
     * corroded where water sits and polished where hands go, and a shutter
     * lock is touched twice a day by the same hand in the same place: the
     * shroud around the barrel is rubbed back to bright steel while the box it
     * is set in has rusted along its bottom edge. That contrast, at 190 mm
     * across and 1.1 m up, is the closest thing to a jewel this system has. */
    col = vec3(0.0420, 0.0415, 0.0430);
    rgh = 0.58; met = 0.55;
    float rust = smoothstep(0.52, 0.88, unit(wfbm(uv * 9.0 + 17.0, 4)));
    col = mix(col, vec3(0.0760, 0.0330, 0.0160), rust * 0.8);
    rgh = mix(rgh, 0.93, rust);
    met = mix(met, 0.05, rust);
    // Polished where the key and the knuckles go: the outward face only.
    float touch = clamp(dot(vWN, normalize(vWN + vec3(0.0, -0.15, 0.0))), 0.0, 1.0)
                * (1.0 - rust) * smoothstep(0.35, 0.75, unit(wfbm(uv * 26.0, 2)));
    col = mix(col, vec3(0.1750, 0.1780, 0.1820), touch * 0.6);
    rgh = mix(rgh, 0.24, touch * 0.8);
    met = mix(met, 0.85, touch * 0.8);
  }

  // Traffic film over everything, and the wall-base occlusion.
  float hh = vWPos.y - vBaseS;
  col = mix(col, col * vec3(0.56, 0.56, 0.59),
            (1.0 - smoothstep(0.4, 2.6, hh)) * 0.34);
  gAO *= mix(0.30, 1.0, smoothstep(-0.03, 0.80, hh));

  diffuseColor.rgb *= col;
  roughnessFactor = clamp(rgh, 0.20, 1.0);
  metalnessFactor = met;
  /* A shutter is a large flat metal panel and the one thing it must not do is
   * mirror the sunset back at the camera. Real ones are matt: mill aluminium
   * oxidises in a season and paint over steel is chalk within five years. */
  gSpecCut = 0.30;
  roughnessFactor = max(roughnessFactor,
    smoothstep(30.0, 90.0, length(vWPos - cameraPosition)) * 0.82);
}
`;

export function makeShutterMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1, metalness: 0.2,
    shadowSide: THREE.FrontSide, dithering: true,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uSun = { value: new THREE.Vector3(...SUN_DIR) };
    Object.assign(shader.uniforms, artificialUniforms());
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `
${FACADE_VARYINGS}
varying vec2 vFuv;
varying vec4 vShutP;
varying float vBaseS;
attribute vec4 aShut;
void main() {`)
      .replace('#include <begin_vertex>', `${FACADE_VERTEX}
vFuv = uv;
vShutP = aShut;
// Where the opening meets the paving, carried on every part rather than only
// on the curtain: rust climbs a guide rail from the ground in exactly the way
// it climbs the laths, and a part measuring from its own extent instead comes
// out evenly weathered end to end, which reads as paint.
vBaseS = aShut.z;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${NOISE}\n${STREET_PARS}\n${SHUT_DECL}\nvarying float vBaseS;\n${CANYON}\n${ARTIFICIAL}\nvoid main() {`)
      .replace(HOOK, `${HOOK}\n${SHUTTER_BODY}`)
      .replace('#include <normal_fragment_maps>', FACADE_NORMAL)
      .replace('#include <lights_fragment_end>', streetEnd(2.9, 0.85));
  };
  m.customProgramCacheKey = () => 'street3-shutter';
  return m;
}

/* ── Awning fabric ──────────────────────────────────────────────────────── */

const AWN_DECL = /* glsl */ `
varying vec4 vAwnP;

/* Awning cloth, at the reflectance the cloth actually has.
 *
 * The previous palette ran from 0.033 to 0.134 luminance, which is to say that
 * the lightest awning on the street was darker than weathered asphalt and the
 * other four were within half a stop of each other. Two things follow from
 * that and both were visible. Everything below about 0.05 linear lands where
 * the fill dominates whatever the surface does, so five distinct colours
 * arrived as one hue — and because three of the five were cold, that hue was
 * navy. Widening the spread is what separates them; it is not a brightness
 * preference.
 *
 * Levels are acrylic awning canvas measured as LRV and converted: wine 8,
 * forest 8, navy 5, natural 62, gold 22. The cream is the important one. It
 * was 4.5x too dark, it is the most common awning colour on any real high
 * street, and it is the only member of the set bright enough to break up a
 * frontage. Navy is genuinely this blue - a navy awning is navy - so the fix
 * for the blue mass is that there are fewer of them and the ones beside them
 * are no longer dark, rather than a desaturation that would make it something
 * other than navy.
 *
 * Shares drawn to match a high street rather than a colour wheel: natural and
 * gold together are half of them, navy is a tenth.
 */
vec3 awnCloth(float g){
  return g < 0.22 ? vec3(0.1800, 0.0520, 0.0550)    // faded wine
       : g < 0.40 ? vec3(0.0450, 0.0950, 0.0580)    // forest green
       : g < 0.50 ? vec3(0.0300, 0.0420, 0.0980)    // navy
       : g < 0.76 ? vec3(0.6400, 0.6000, 0.5000)    // natural / cream
                  : vec3(0.3300, 0.1950, 0.0700);   // gold ochre
}
`;

const AWNING_BODY = /* glsl */ `
{
  vec2 uv = vFuv;
  float px = fwidth(uv.x) + fwidth(uv.y);
  float seed = vAwnP.x;
  float part = vAwnP.y;
  /* Position down the slope, from the wall rail to the front bar. Everything
   * that happens to a piece of awning canvas is a function of this: the water
   * runs down it, the dirt goes with the water, and the sun has bleached the
   * outer third far harder than the part that spends the day in the shadow of
   * the fascia above it. */
  float t = clamp((vAwnP.z - vWPos.y) / max(vAwnP.z - vAwnP.w, 0.05), 0.0, 1.0);
  vec3 col; float rgh = 0.86;

  if (part < 0.5){
    /* ── Fabric ─────────────────────────────────────────────────────
     *
     * Acrylic canvas, and half of them are striped because half of them are.
     * A 210 mm stripe running down the slope is the traditional width and it
     * is what makes an awning identifiable at forty metres, when nothing else
     * about it is resolvable. */
    float g = hash21(vec2(seed * 5.3, 2.1));
    vec3 a = awnCloth(g);
    /* The cream stripe, at natural canvas reflectance. This is what a stripe
     * is for: it is the light half of the pair, and at the old 0.152 it was
     * within a stop of every ground it was printed on, so a striped awning and
     * a plain one were the same object at forty metres. */
    vec3 b = vec3(0.6800, 0.6450, 0.5600);
    float striped = step(0.42, hash21(vec2(seed * 9.1, 4.7)));
    float sw = 0.185 + hash21(vec2(seed, 8.8)) * 0.055;
    float s = aaStep(0.5, fract(uv.x / sw), px / sw);
    col = mix(a, mix(a, b, s), striped);
    /* Weave, in tone only. It is a 1 mm feature and it is exactly the
     * frequency that a four-degree sun turns into noise if it is put into the
     * normal, so it is gated out by footprint as well. */
    float fine = 1.0 - smoothstep(0.4, 1.4, px / 0.0016);
    col *= 1.0 + (unit(wfbm(uv * 640.0, 2)) - 0.5) * 0.22 * fine;
    /* Sun bleach down the slope. The outer third of an awning has had ten
     * summers on it and the inner third has not, and the boundary is soft and
     * roughly parallel to the front bar. On a striped one the dark stripe
     * fades far more than the cream, which is what makes an old awning look
     * old rather than merely dirty. */
    float bleach = smoothstep(0.25, 0.95, t) * (0.35 + 0.5 * hash21(vec2(seed, 12.1)));
    col = mix(col, mix(col, vec3(dot(col, vec3(0.33))), 0.55) * 1.35, bleach * 0.7);

  } else if (part < 1.5){
    /* ── Valance ────────────────────────────────────────────────────
     *
     * The hanging flap, which is the only part of an awning most of this
     * street sees, because the camera is under them rather than above them.
     * It is the same cloth and it is in worse condition: it hangs free, it
     * flaps, and its hem has been frayed by twenty years of it. */
    /* Same seed, same cloth: the valance is cut from the bolt the canopy came
     * from, so it has to read the palette through the same function rather
     * than carry its own copy. The two lists had already been edited apart
     * once. */
    vec3 a = awnCloth(hash21(vec2(seed * 5.3, 2.1)));
    col = a * (0.90 + 0.28 * unit(wfbm(vec2(uv.x * 3.0, uv.y * 9.0), 3)));
    // Scalloping and fray along the bottom edge, in tone.
    float hem = smoothstep(0.72, 1.0, t);
    col = mix(col, col * 0.62, hem * 0.55);
    col = mix(col, mix(col, vec3(dot(col, vec3(0.33))), 0.6) * 1.25,
              smoothstep(0.3, 1.0, t) * 0.5);
    rgh = 0.90;

  } else {
    /* ── Frame ────────────────────────────────────────────────────────
     *
     * Painted or galvanised steel tube, LRV 22. It was 0.087, which is the
     * reflectance of a dirty brick and not of a powder-coated arm. */
    col = vec3(0.2250, 0.2230, 0.2180);
    col *= 0.80 + 0.36 * unit(wfbm(uv * 8.0, 3));
    rgh = 0.62;
    diffuseColor.rgb *= col;
    roughnessFactor = clamp(rgh, 0.25, 1.0);
    metalnessFactor = 0.30;
    gSpecCut = 0.30;
  }

  if (part < 1.5){
    /* Dirt streaking, which the brief asks for by name.
     *
     * Water leaves an awning at the front bar and it takes everything the
     * canvas has collected with it, so the streaks run down the slope, they
     * are strongest in the outer half, and they concentrate into a solid band
     * of black along the very edge where the drip line is. Between the arms,
     * where the canvas bellies, the water stands instead of running, and those
     * bays are dirtier than the taut ones — which is why the streaking follows
     * the sag rather than being evenly spaced.
     */
    float streak = unit(wfbm(vec2(uv.x * 30.0, t * 1.6), 3));
    float run = smoothstep(0.15, 0.95, t) * (0.30 + 0.85 * streak);
    col = mix(col, vec3(0.0165, 0.0155, 0.0145), run * 0.42);
    /* The drip line. Every awning on earth has a hard dark stripe in the last
     * fifty millimetres of it and it is the single most convincing mark on
     * the whole object. */
    col = mix(col, col * 0.38, smoothstep(0.90, 1.0, t) * 0.8);
    /* The sag valleys, found from the surface's own slope rather than from
     * any extra data: where the canvas bellies it lies flatter, so its normal
     * turns further toward vertical, and that is where the water sits. */
    float pool = smoothstep(0.006, 0.030, vWN.y - (0.60 + 0.30 * (1.0 - t)));
    col = mix(col, col * vec3(0.62, 0.66, 0.60), pool * 0.35);
    /* And the underside is a different surface. It never gets rained on, so
     * it is clean; it never gets sun, so it has not faded; and it is dark
     * because everything it can see is the pavement. */
    float under = clamp(-vWN.y, 0.0, 1.0);
    col = mix(col, col * vec3(1.25, 1.20, 1.14), under * 0.5);
    gAO *= 1.0 - under * 0.35;

    diffuseColor.rgb *= col;
    roughnessFactor = clamp(rgh, 0.55, 1.0);
    metalnessFactor = 0.0;
    gSpecCut = 0.12;
  }
  roughnessFactor = max(roughnessFactor,
    smoothstep(30.0, 90.0, length(vWPos - cameraPosition)) * 0.82);
}
`;

export function makeAwningMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1, metalness: 0,
    /* The fabric is emitted as a closed shell — a top surface, an underside
     * 10 mm below it and closed edges — precisely so that this can be
     * FrontSide and still be right. An open sheet would need DoubleSide
     * shadows to cast at all, and even then only the row whose front faces
     * happen to look at the sun would cast: the awnings on the -X frontage
     * would have thrown nothing onto the footway, which is the whole reason
     * for putting fabric out over a pavement in the first place. */
    shadowSide: THREE.FrontSide,
    dithering: true,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uSun = { value: new THREE.Vector3(...SUN_DIR) };
    Object.assign(shader.uniforms, artificialUniforms());
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `
${FACADE_VARYINGS}
varying vec2 vFuv;
varying vec4 vAwnP;
attribute vec4 aAwn;
void main() {`)
      .replace('#include <begin_vertex>', `${FACADE_VERTEX}\nvFuv = uv;\nvAwnP = aAwn;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${NOISE}\n${STREET_PARS}\n${AWN_DECL}\n${CANYON}\n${ARTIFICIAL}\nvoid main() {`)
      .replace(HOOK, `${HOOK}\n${AWNING_BODY}`)
      .replace('#include <normal_fragment_maps>', FACADE_NORMAL)
      .replace('#include <lights_fragment_end>', streetEnd(3.0, 1.1));
  };
  m.customProgramCacheKey = () => 'street3-awning';
  return m;
}

/* ── Footway furniture ──────────────────────────────────────────────────── */

const FURN_DECL = /* glsl */ `
varying vec2 vKind;
varying vec4 vRect;

/* A hard-edged disc and a bar, for the regulatory plate. Both antialiased
 * against the pixel footprint so a sign forty metres away converges to the
 * right average pink rather than to a ring of fireflies. */
float ring(vec2 q, vec2 c, float r0, float r1, float px){
  float d = length(q - c);
  return aaStep(r0, d, px) * (1.0 - aaStep(r1, d, px));
}
float slash(vec2 q, vec2 c, float r, float w, float px){
  vec2 p = q - c;
  float d = abs(p.x * 0.7071 + p.y * 0.7071);
  return (1.0 - aaStep(w, d, px)) * (1.0 - aaStep(r, length(p), px));
}
`+ signGLSL() + `
`;

const FURN_BODY = /* glsl */ `
{
  vec2 uv = vFuv;
  float px = fwidth(uv.x) + fwidth(uv.y);
  /* Taken here, above every branch, because it differentiates. */
  float gMir = signMirror(uv, vWN);
  float kind = vKind.x;
  float seed = vKind.y;
  /* Height above the paving. aRect is overloaded — on a sign plate it is the
   * plate's own rectangle so the graphic can be drawn in normalised
   * coordinates, everywhere else its first slot is where the object stands —
   * so the plates opt out rather than reading a u coordinate as a height. They
   * are two metres up and nothing measured from the ground applies to them. */
  float hh = kind > 4.5 && kind < 7.5 ? 9.0 : vWPos.y - vRect.x;
  vec2 p = vec2(vWPos.y * 8.0 + seed * 5.0, dot(vWPos.xz, vec2(8.0, 8.0)));
  vec3 col; float rgh; float met;

  if (kind < 0.5){
    /* ── Fire hydrant ───────────────────────────────────────────────
     *
     * Cast iron under thirty years of paint, repainted about eight times, and
     * chalked to a bloom on whichever side gets the afternoon. It is red, and
     * the red is deliberately held down: a saturated primary in a frame whose
     * hue balance took two rounds to settle would take over, and a real
     * hydrant is a dark oxide red rather than a pillar box one. */
    col = vec3(0.0870, 0.0195, 0.0140);
    // Repainted over rust, over paint, over rust. The blotches are whole
    // patches at the scale of a hand, not noise.
    float coat = smoothstep(0.42, 0.72, unit(wfbm(p * 1.4, 4)));
    col = mix(col, vec3(0.0620, 0.0230, 0.0165), coat * 0.7);
    /* Chalking: the pigment has oxidised to a pale powder on the sun side, and
     * this is the one place where the surface knows which way it faces. */
    float sunFace = smoothstep(-0.1, 0.6, dot(vWN, uSun));
    col = mix(col, mix(col, vec3(dot(col, vec3(0.33))), 0.55) * 1.55,
              sunFace * 0.55 * smoothstep(0.35, 0.75, unit(wfbm(p * 2.6, 3))));
    rgh = 0.74 + 0.16 * unit(wfbm(p * 5.0, 3)); met = 0.08;
    /* Rust where the water sits: on the up-faces of the two flanges and in the
     * last hundred millimetres above the paving, which is the wettest part of
     * anything standing on a footway. */
    float wet = clamp(vWN.y, 0.0, 1.0) * 0.7 + (1.0 - smoothstep(0.02, 0.14, hh)) * 0.8;
    float rust = smoothstep(0.40, 0.80, unit(wfbm(p * 3.2 + 11.0, 4))) * clamp(wet, 0.0, 1.0);
    col = mix(col, vec3(0.0680, 0.0290, 0.0130), rust * 0.8);
    rgh = mix(rgh, 0.95, rust);
    /* And the nut and the caps are bare. The operating nut is turned twice a
     * year with a wrench and the hose caps come off at every test, so they are
     * the only bright metal on the object — the top 40 mm and the two side
     * bosses, found by height rather than by a separate branch. */
    float bare = smoothstep(0.745, 0.775, hh) * 0.9;
    col = mix(col, vec3(0.1450, 0.1420, 0.1400), bare);
    rgh = mix(rgh, 0.42, bare); met = mix(met, 0.7, bare);

  } else if (kind < 1.5){
    /* ── Dumpster body ──────────────────────────────────────────────
     *
     * Painted steel, municipal green, and the paint is the least of it. What
     * identifies a commercial bin at fifteen metres is that it is dented, that
     * the rust runs from the bottom edge upward in tidemarks rather than
     * downward, and that the paint has been scraped off every corner the
     * lorry's forks have ever touched. */
    col = vec3(0.0175, 0.0300, 0.0215);
    col *= 0.72 + 0.56 * unit(wfbm(p * 1.1, 4));
    rgh = 0.76; met = 0.15;
    /* Dents. These are the one place in System 3 where relief is allowed into
     * the normal, and they are allowed because they are a 200 mm feature on a
     * flat panel: at that scale a four-degree sun produces a broad soft
     * gradient across the side of the bin rather than the pixel-to-pixel
     * barcode a corrugation would. Amplitude is a third of what the geometry
     * would be, which is still plenty. */
    float dents = wfbm(p * 0.55 + 3.0, 3);
    gSlope += vec2(wfbm(p * 0.55 + 21.0, 2), dents) * 0.055;
    /* Rust rising from the bottom, in tidemarks. A bin stands in whatever the
     * gutter is carrying and it rots from the floor pan upward, which is the
     * opposite direction from everything else on a facade and is exactly why
     * it reads. */
    float tide = (1.0 - smoothstep(0.03, 0.42, hh))
               * smoothstep(0.30, 0.72, unit(wfbm(vec2(p.x * 0.8, p.y * 3.0), 4)));
    float rust = smoothstep(0.44, 0.82, unit(wfbm(p * 2.0 + 7.0, 4)));
    rust = max(rust * 0.55, tide);
    col = mix(col, vec3(0.0720, 0.0300, 0.0135), rust * 0.85);
    rgh = mix(rgh, 0.95, rust); met = mix(met, 0.03, rust);
    // Bare scraped steel on the ribs and the lifting pockets.
    float scrape = smoothstep(0.72, 0.92, unit(wfbm(p * 7.0 + 31.0, 2)))
                 * smoothstep(0.15, 0.55, hh);
    col = mix(col, vec3(0.1050, 0.1030, 0.1010), scrape * 0.4);
    met = mix(met, 0.6, scrape * 0.4);
    rgh = mix(rgh, 0.44, scrape * 0.4);

  } else if (kind < 2.5){
    /* ── Dumpster lid ───────────────────────────────────────────────
     *
     * Moulded HDPE rather than steel on most of them, which matters because
     * it fades rather than rusting: a ten-year-old lid is grey-green and
     * chalky and its colour has nothing to do with the body's any more. */
    col = vec3(0.0250, 0.0320, 0.0270);
    col = mix(col, vec3(0.0400, 0.0420, 0.0400), 0.5);
    col *= 0.78 + 0.40 * unit(wfbm(p * 1.7, 4));
    rgh = 0.84; met = 0.0;
    // Ribbing, in tone, at the moulding pitch.
    col *= 0.92 + 0.14 * sin(dot(vWPos.xz, vec2(9.0, 9.0)) * 3.2);

  } else if (kind < 3.5){
    /* ── Bin bag ────────────────────────────────────────────────────
     *
     * Black polythene, and the whole read is the sheen. A bin bag has a very
     * low albedo — under two per cent — and a smooth, gently crumpled surface,
     * so it is almost black with a hard bright skim of sky along every fold.
     * That contrast between near-black and a specular highlight is the only
     * thing that distinguishes it from a rock, and it is why this is the one
     * material at street level with a roughness under a half. */
    col = vec3(0.0125, 0.0122, 0.0130);
    col *= 0.7 + 0.7 * unit(wfbm(p * 2.2, 3));
    // Crumple, as a mid-scale roughness break rather than as a normal: the
    // highlight has to move across the bag, not shatter.
    float crum = unit(wfbm(p * 4.5 + seed * 9.0, 3));
    rgh = clamp(0.19 + crum * 0.20, 0.14, 0.44);
    met = 0.0;
    // Stretched and shiny where it is full, dull where it is slack.
    rgh = mix(rgh, rgh * 0.7, clamp(vWN.y, 0.0, 1.0) * 0.6);
    // Street dirt on the bottom third, where it has been dragged.
    col = mix(col, col * 2.2 + vec3(0.0035), (1.0 - smoothstep(0.02, 0.16, hh)) * 0.4);
    gSpecCut = 1.0;

  } else if (kind < 4.5){
    /* ── Galvanised post ────────────────────────────────────────────
     *
     * A spelter coat weathers to a chalky matt oxide within two years and then
     * collects city film on top of it. It has no mirror left in it, which is
     * worth stating explicitly: at 0.5 roughness a 60 mm tube under a raking
     * sun returns a blown white line down its whole length, which is precisely
     * the defect the conduit run in System 2 was reported for. */
    col = vec3(0.1180, 0.1200, 0.1230);
    col *= 0.80 + 0.36 * unit(wfbm(p * 4.0, 3));
    rgh = 0.72; met = 0.26;
    float rust = smoothstep(0.58, 0.90, unit(wfbm(p * 2.4 + 5.0, 4)))
               * (1.0 - smoothstep(0.02, 0.35, hh));
    col = mix(col, vec3(0.0700, 0.0320, 0.0150), rust * 0.7);
    rgh = mix(rgh, 0.95, rust);
    // Stickers, which every signpost in every city is covered in to shoulder
    // height. Small, low contrast, and half torn off.
    float stk = step(0.80, hash21(floor(vec2(vWPos.y * 7.0, seed * 30.0))))
              * smoothstep(0.9, 1.1, hh) * (1.0 - smoothstep(1.7, 2.0, hh))
              * smoothstep(0.35, 0.6, unit(wfbm(p * 12.0, 2)));
    col = mix(col, col * 1.7 + vec3(0.008), stk * 0.5);
    gSpecCut = 0.30;

  } else if (kind < 5.5){
    /* ── Street name blade ──────────────────────────────────────────
     *
     * Green ground, white border, white lettering. No retroreflective gain:
     * that is a night constant and this scene is not a night scene — the
     * sheeting only returns light to a source coaxial with the eye, which
     * means headlights, and there are none. In daylight it is simply a
     * high-albedo painted plate. */
    vec2 q = vec2((uv.x - vRect.x) / max(vRect.z, 1e-4),
                  (uv.y - vRect.y) / max(vRect.w, 1e-4));
    float qpx = px / max(vRect.w, 1e-4);
    col = vec3(0.0300, 0.0930, 0.0480);
    // The border, inset the way a real blade's is.
    float inb = aaBand(0.030, 0.970, q.x, px / max(vRect.z, 1e-4))
              * aaBand(0.090, 0.910, q.y, qpx);
    float inb2 = aaBand(0.052, 0.948, q.x, px / max(vRect.z, 1e-4))
               * aaBand(0.150, 0.850, q.y, qpx);
    col = mix(vec3(0.4200, 0.4100, 0.3900), col, max(1.0 - inb + inb2, 0.0));
    /* The name, set to fit between the borders and centred. A blade is made to
     * suit its name, so the name is allowed to set the cap height down as far
     * as it needs and the plate keeps its proportions. */
    int row = SGN_NAME0 + int(hash21(vec2(seed * 5.3, 9.4)) * float(SGN_NAMEN) * 0.999);
    float asp = signAspect(row);
    float capD = min(0.52 * vRect.w, 0.86 * vRect.z / asp);
    float wD = capD * asp;
    float txt = signInk(row, vec2((uv.x - vRect.x - (vRect.z - wD) * 0.5) / wD,
                                  (uv.y - vRect.y - (vRect.w - capD) * 0.5) / capD),
                        px / capD, gMir);
    col = mix(col, vec3(0.4400, 0.4300, 0.4100), txt);
    rgh = 0.42 + 0.22 * unit(wfbm(p * 3.0, 2)); met = 0.0;
    gSpecCut = 0.30;

  } else if (kind < 6.5){
    /* ── Regulatory plate ───────────────────────────────────────────
     *
     * White ground, red annulus with a bar through it, black legend under it.
     * The circle and the bar are two distance functions and they are worth far
     * more than the text: a red ring on white is legible as a prohibition sign
     * at any range where the plate itself is legible at all, and that shape is
     * what the eye actually files. */
    vec2 q = vec2((uv.x - vRect.x) / max(vRect.z, 1e-4),
                  (uv.y - vRect.y) / max(vRect.w, 1e-4));
    float ar = max(vRect.z, 1e-4) / max(vRect.w, 1e-4);
    vec2 qa = vec2(q.x, (q.y - 0.66) / ar + 0.66);       // circle, not an ellipse
    float qpx = px / max(vRect.z, 1e-4);
    col = vec3(0.4600, 0.4500, 0.4350);
    float rim = aaBand(0.045, 0.955, q.x, qpx) * aaBand(0.030, 0.970, q.y, px / max(vRect.w, 1e-4));
    col = mix(vec3(0.1400, 0.1350, 0.1300), col, rim);
    float rr = ring(qa, vec2(0.5, 0.66), 0.235, 0.330, qpx);
    float bar = slash(qa, vec2(0.5, 0.66), 0.330, 0.052, qpx);
    col = mix(col, vec3(0.2600, 0.0230, 0.0180), clamp(rr + bar, 0.0, 1.0));
    /* The legend under the roundel: NO PARKING over the hours it applies. Two
     * lines, taken as a pair from the plate range so that the second line is
     * the qualifier belonging to the first rather than another headline. */
    int pr = SGN_PLATE0 + 2 * int(hash21(vec2(seed * 4.7, 17.9)) * 1.999);
    float t1 = 0.0, t2 = 0.0;
    {
      float capD = min(0.115 * vRect.w, 0.84 * vRect.z / signAspect(pr));
      float wD = capD * signAspect(pr);
      t1 = signInk(pr, vec2((uv.x - vRect.x - (vRect.z - wD) * 0.5) / wD,
                            (q.y - 0.145) * vRect.w / capD), px / capD, gMir);
      float capE = min(0.095 * vRect.w, 0.78 * vRect.z / signAspect(pr + 1));
      float wE = capE * signAspect(pr + 1);
      t2 = signInk(pr + 1, vec2((uv.x - vRect.x - (vRect.z - wE) * 0.5) / wE,
                                (q.y - 0.028) * vRect.w / capE), px / capE, gMir);
    }
    col = mix(col, vec3(0.0180, 0.0175, 0.0170), clamp(t1 + t2, 0.0, 1.0));
    rgh = 0.40 + 0.22 * unit(wfbm(p * 3.0, 2)); met = 0.0;
    gSpecCut = 0.30;

  } else if (kind < 7.5){
    /* ── The back of a plate, and the tow-away tab ──────────────────── */
    col = vec3(0.1350, 0.1360, 0.1370);
    col *= 0.84 + 0.30 * unit(wfbm(p * 5.0, 3));
    rgh = 0.56; met = 0.32;
    gSpecCut = 0.25;

  } else {
    /* ── Rubber ─────────────────────────────────────────────────────── */
    col = vec3(0.0140, 0.0138, 0.0142);
    col *= 0.8 + 0.4 * unit(wfbm(p * 6.0, 3));
    rgh = 0.90; met = 0.0;
  }

  /* Everything standing on a city footway carries the same film, and it is
   * what ties an object to the ground it is on. Heaviest at the base, where
   * the road spray reaches, and present everywhere. */
  float film = smoothstep(0.35, 0.85, unit(wfbm(p * 0.85, 4)));
  col = mix(col, col * vec3(0.55, 0.55, 0.58), film * 0.42);
  col = mix(col, col * vec3(0.46, 0.45, 0.44),
            (1.0 - smoothstep(0.01, 0.20, hh)) * 0.55);
  // Water sits on the up-faces and rots them; the undersides stay dry.
  col *= 0.84 + 0.28 * (1.0 - clamp(vWN.y, 0.0, 1.0));
  /* Contact occlusion. An object standing on paving darkens the last hundred
   * millimetres of itself and the paving under it, and at four degrees there
   * is no cast shadow available to do that job on the sunward side. Without
   * it these read exactly as the critique's "floating props". */
  gAO *= mix(0.28, 1.0, smoothstep(-0.02, 0.30, hh));

  diffuseColor.rgb *= col;
  roughnessFactor = clamp(rgh, 0.12, 1.0);
  metalnessFactor = met;
  roughnessFactor = max(roughnessFactor,
    smoothstep(30.0, 90.0, length(vWPos - cameraPosition)) * 0.82);
}
`;

export function makeFurnitureMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1, metalness: 0.2,
    /* Every object here is a closed solid, so FrontSide is both correct and
     * necessary — and it matters more for these than for anything on the wall,
     * because a hydrant and a bin are short, and at 4.2 degrees the only
     * shadows that reach the carriageway at all are the shadows of short
     * things. A 790 mm hydrant throws six metres of hard shadow across the
     * footway and into the gutter, and that shadow is worth more in the frame
     * than the hydrant is. */
    shadowSide: THREE.FrontSide,
    dithering: true,
  });
  m.onBeforeCompile = (shader) => {
    shader.uniforms.uSun = { value: new THREE.Vector3(...SUN_DIR) };
    Object.assign(shader.uniforms, signUniforms(), artificialUniforms());
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', `
${FACADE_VARYINGS}
varying vec2 vFuv;
varying vec2 vKind;
varying vec4 vRect;
attribute vec2 aKind;
attribute vec4 aRect;
void main() {`)
      .replace('#include <begin_vertex>', `${FACADE_VERTEX}
vFuv = uv;
vKind = aKind;
vRect = aRect;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', `${NOISE}\n${STREET_PARS}\n${FURN_DECL}\n${CANYON}\n${ARTIFICIAL}\nvoid main() {`)
      .replace(HOOK, `${HOOK}\n${FURN_BODY}`)
      .replace('#include <normal_fragment_maps>', FACADE_NORMAL)
      .replace('#include <lights_fragment_end>', streetEnd(2.9, 0.95));
  };
  m.customProgramCacheKey = () => 'street3-furniture';
  return m;
}