'use client';

/* The material for the footway prop kit.
 *
 * One `MeshStandardMaterial` for every object in `world/props.ts`, branching
 * on a per-vertex code. Ten branches in one shader rather than ten materials
 * is what keeps the whole of the street's clutter to one draw call and one
 * shadow-pass call; a material per object would be a hundred and fifty of
 * each, which would cost more than the entire block of buildings.
 *
 * Nothing here is sampled from a texture. Every branch is analytic in world
 * position and in height above the object's own ground contact, which the
 * geometry carries in the attribute — that is the same device `street3.ts`
 * uses for its `aRect`, and the reason for it is that a footway falls 31 mm
 * across its width and settles per flag on top of that, so a shader given only
 * `vWPos.y` cannot tell the foot of a bollard from the foot of a bin.
 *
 * ── Levels ────────────────────────────────────────────────────────────────
 *
 * Authored as linear albedo, not as a colour picked against a tonemapped
 * frame. NOTES.md is emphatic about why: the same increment of light is worth
 * seven display counts on the shaded carriageway and one on the sunlit one, so
 * nobody judging by eye against the output can be right about both. The values
 * below are reflectances — 0.04 for weathered black paint, 0.18 for galvanised
 * steel, 0.21 for a chalky painted case, 0.32 for new concrete — and the tone
 * map is left to do what it does with them.
 *
 * ── The blue-shade problem ───────────────────────────────────────────────
 *
 * `canyonSky` is shared from `world/glsl.ts` and is not optional here. A wall
 * low in this canyon sees a slot of blue-violet zenith and nothing else, and
 * every pale object standing against it — a galvanised cabinet, a white
 * wheelie bin — comes back a saturated primary blue without it. The same
 * correction the building metal already applies is applied here, and for the
 * same reason.
 */
import * as THREE from 'three';

import { NOISE, CANYON } from '@/world/glsl';
import { FACADE_VARYINGS, FACADE_VERTEX, skyLift } from './buildingMaterials';
import { signGLSL, signUniforms } from './signs';

const PROP_BODY = /* glsl */ `
float gPropSpec = 1.0;
{
  float mat  = vProp.x;
  float seed = vProp.y;
  float gy   = vProp.z;
  float tone = vProp.w;

  /* Height above this object's own contact with the paving, which is what
   * every kind of wear on a street object is measured from: splash, rust,
   * scuffing, the tide line on a bin. */
  float up = max(vWPos.y - gy, 0.0);

  /* Two noise fields, and they are deliberately in different spaces. The
   * first is world-anchored so that two objects standing next to each other
   * are not the same object with the same mottle; the second is seeded per
   * object so a bin's dents do not line up with the paving joints behind it. */
  vec2 pw = vec2(dot(vWPos.xz, vec2(7.3, 7.3)), vWPos.y * 8.0 + seed * 21.0);
  vec2 ps = vec2(vWPos.y * 11.0 + seed * 53.0, dot(vWPos.xz, vec2(11.0, -11.0)) + seed * 31.0);

  vec3 base; float rgh; float met;

  if (mat < 0.5){
    /* Painted cast iron: bollards, hydrants, bin standards, cellar doors.
     *
     * Municipal ironwork is painted black or a very dark green, repainted over
     * rust every few years, and the repaint never quite covers the last one.
     * The rust is the only chroma in it and at this hour it goes orange, which
     * is what makes old ironwork read instantly. */
    base = mix(vec3(0.0185, 0.0205, 0.0192), vec3(0.0210, 0.0300, 0.0235), tone);
    rgh = 0.80; met = 0.12;
    float rust = smoothstep(0.46, 0.84, unit(wfbm(ps * 1.5, 4)))
               * (0.35 + 0.65 * smoothstep(0.2, 0.9, unit(wfbm(ps * 6.0, 3))));
    /* Rust runs from the bottom up, because that is where the water sits and
     * where the plough and the dogs get it. A uniform rust field over a
     * bollard is the tell that it was authored as a texture. */
    rust *= 0.35 + 0.85 * exp(-up * 2.2);
    base = mix(base, vec3(0.1180, 0.0470, 0.0215), rust * 0.80);
    rgh = clamp(mix(rgh, 0.95, rust), 0.55, 1.0);
    met = mix(met, 0.03, rust);
    // Paint polished off the shoulders where hands and hips catch it.
    float polish = smoothstep(0.85, 1.15, up) * smoothstep(0.3, 0.7, unit(wfbm(ps * 3.0, 2)));
    met = mix(met, 0.45, polish * 0.35);
    rgh = mix(rgh, 0.42, polish * 0.35);
  } else if (mat < 1.5){
    /* Galvanised steel. Chalky matt oxide within two years and then city dirt
     * on top of it — there is no mirror left in a spelter coat, which is the
     * correction the building metal already had to make when its casings came
     * back as saturated blue boxes. */
    base = vec3(0.1620, 0.1650, 0.1670); rgh = 0.74; met = 0.26;
    base *= 0.80 + 0.36 * unit(wfbm(pw * 4.0, 3));
    /* Spangle: the crystal pattern hot-dip zinc freezes in, quite large — 10
     * to 30 mm across — and very low contrast once the coat has dulled. It is
     * the one thing that distinguishes galvanised from grey paint at close
     * range, and a Worley cell boundary is exactly its shape. */
    vec2 spg = wworley(ps * 2.2);
    base *= 0.94 + 0.11 * smoothstep(0.02, 0.16, spg.y - spg.x);
    gPropSpec = 0.45;
  } else if (mat < 2.5){
    /* Black polythene. Almost the darkest thing in the frame and the shiniest:
     * a refuse sack has a broad low-gloss lobe that picks up the sky as a soft
     * band down its shoulder, and that band is the entire reason a pile of
     * sacks reads as sacks rather than as lumps of coal. */
    base = vec3(0.0125, 0.0128, 0.0140);
    rgh = 0.34 + 0.16 * unit(wfbm(ps * 9.0, 3));
    met = 0.0;
    // Creases, in roughness rather than in normal. At 4.2 degrees a normal
    // perturbation of any size swings N.L violently between adjacent pixels —
    // the pavement was blown into white granules that way.
    rgh += 0.22 * smoothstep(0.55, 0.95, unit(wfbm(ps * 26.0, 3)));
    base *= 0.85 + 0.35 * tone;
  } else if (mat < 3.5){
    /* Moulded plastic: wheelie bins, cones, news boxes. Coloured, and the
     * colour is what the tone code selects — a street has a green bin, a blue
     * one, a red news box and an orange cone, and if they are all one hue the
     * kit reads as a kit. */
    vec3 hue =
      tone < 0.25 ? vec3(0.0330, 0.0520, 0.0345) :        // municipal green
      tone < 0.45 ? vec3(0.0300, 0.0390, 0.0620) :        // blue
      tone < 0.62 ? vec3(0.1550, 0.1520, 0.1420) :        // grey
      tone < 0.80 ? vec3(0.1180, 0.0300, 0.0250) :        // red
      tone < 0.92 ? vec3(0.1450, 0.1350, 0.0450) :        // yellow
                    vec3(0.2600, 0.0620, 0.0140);          // traffic orange
    base = hue; rgh = 0.46; met = 0.0;
    // UV chalking, worst on the up-faces, which is where the sun gets it.
    float chalk = (0.35 + 0.65 * max(vWN.y, 0.0)) * smoothstep(0.3, 0.9, unit(wfbm(ps * 2.5, 3)));
    base = mix(base, base * 0.62 + vec3(0.055), chalk * 0.55);
    rgh = mix(rgh, 0.74, chalk);
    base *= 0.88 + 0.24 * unit(wfbm(ps * 7.0, 2));
  } else if (mat < 4.5){
    /* Softwood: pallets and crates. Grey and silvered where it has been out in
     * the weather, still pale where it has been sheltered. The grain runs
     * along the board, which here is world y for a leaning pallet and world xz
     * for a deck board, so it is taken from whichever axis is longer. */
    base = vec3(0.1450, 0.1180, 0.0800);
    float grain = unit(wfbm(vec2(dot(vWPos.xz, vec2(2.0, 2.0)), vWPos.y * 48.0), 3));
    base *= 0.72 + 0.52 * grain;
    float silver = smoothstep(0.25, 0.85, unit(wfbm(pw * 1.1, 3))) * (0.4 + 0.6 * max(vWN.y, 0.0));
    base = mix(base, vec3(0.1250, 0.1210, 0.1120), silver * 0.72);
    // Wet at the foot, where it has stood in the gutter.
    base *= mix(0.55, 1.0, smoothstep(0.0, 0.28, up));
    rgh = 0.88 - 0.10 * silver; met = 0.0;
    base *= 0.85 + 0.30 * tone;
  } else if (mat < 5.5){
    /* Precast concrete: planter tubs, the stone frame round a cellar door.
     * Pale, and the pale things in a shaded street are where the blue-violet
     * fill shows most, so this branch is the one that most needs canyonSky. */
    base = vec3(0.2450, 0.2380, 0.2260); rgh = 0.92; met = 0.0;
    base *= 0.84 + 0.28 * unit(wfbm(pw * 3.2, 4));
    // Aggregate showing through where the face has spalled.
    float spall = smoothstep(0.72, 0.94, unit(wfbm(ps * 10.0, 3)));
    base = mix(base, vec3(0.1750, 0.1650, 0.1520), spall * 0.6);
    // The dirt line every concrete object standing on a pavement carries.
    base *= mix(0.52, 1.0, smoothstep(0.0, 0.22, up));
    base *= 0.9 + 0.2 * tone;
  } else if (mat < 6.5){
    /* Painted sheet steel gone chalky: meter heads, news box bodies, drums.
     * The paint is a colour and the chalk is not, so the two are mixed rather
     * than one being a tint of the other. */
    vec3 hue =
      tone < 0.22 ? vec3(0.0420, 0.0450, 0.0470) :
      tone < 0.42 ? vec3(0.0310, 0.0640, 0.0480) :
      tone < 0.62 ? vec3(0.1050, 0.0330, 0.0290) :
      tone < 0.85 ? vec3(0.1550, 0.1480, 0.1330) :
                    vec3(0.2650, 0.2400, 0.1650);
    base = hue; rgh = 0.66; met = 0.10;
    float chalk = smoothstep(0.28, 0.86, unit(wfbm(ps * 2.2, 4)));
    base = mix(base, base * 0.55 + vec3(0.048), chalk * 0.6);
    rgh = mix(rgh, 0.88, chalk);
    // Rust blooming out of the seams and up from the base.
    float rust = smoothstep(0.62, 0.90, unit(wfbm(ps * 5.0, 4))) * (0.3 + 0.9 * exp(-up * 1.6));
    base = mix(base, vec3(0.1050, 0.0420, 0.0195), rust * 0.7);
    rgh = mix(rgh, 0.95, rust);
  } else if (mat < 7.5){
    /* Corrugated cardboard, out in the weather. Warm mid brown where it is
     * dry and almost black where it has taken water, and the boundary between
     * the two is a wicking line that climbs from the bottom — which is the
     * single most recognisable thing about cardboard left outside. */
    base = vec3(0.1480, 0.1080, 0.0680); rgh = 0.95; met = 0.0;
    float wick = 1.0 - smoothstep(0.02, 0.16 + 0.10 * unit(wfbm(ps * 8.0, 2)), up);
    base = mix(base, vec3(0.0330, 0.0250, 0.0180), wick * 0.85);
    base *= 0.80 + 0.40 * unit(wfbm(ps * 3.5, 3));
    // Flute, along the sheet, very shallow, in albedo only.
    base *= 0.96 + 0.08 * sin(vWPos.y * 260.0 + seed * 17.0);
    base *= 0.85 + 0.3 * tone;
  } else if (mat < 8.5){
    // Rubber: castors, cone bases, the tyre of a sack truck. Nearly black,
    // very rough, and it never has a highlight on it.
    base = vec3(0.0135, 0.0135, 0.0142); rgh = 0.94; met = 0.0;
    base *= 0.86 + 0.26 * unit(wfbm(ps * 6.0, 3));
    gPropSpec = 0.35;
  } else {
    // Dull aluminium and stainless: coupling heads, display bezels, hoods.
    base = vec3(0.2050, 0.2080, 0.2100); rgh = 0.44; met = 0.62;
    base *= 0.88 + 0.22 * unit(wfbm(ps * 5.5, 3));
    gPropSpec = 0.75;
  }

  /* The film every outdoor object in a city carries, and the thing that ties
   * a bollard to the paving it stands on. Without it the kit reads as objects
   * imported into a photograph rather than as objects that have been standing
   * in it. */
  float grime = smoothstep(0.32, 0.86, unit(wfbm(pw * 0.85, 4)));
  base = mix(base, base * vec3(0.56, 0.56, 0.59), grime * 0.45);

  /* Road splash. Everything within about 400 mm of a footway gets a spatter
   * off the carriageway, and it is dirtier and flatter than whatever is under
   * it. Measured off the object's own ground contact, not off world zero. */
  float splash = (1.0 - smoothstep(0.05, 0.42, up)) * (0.45 + 0.55 * unit(wfbm(ps * 14.0, 3)));
  base = mix(base, base * 0.58 + vec3(0.0125, 0.0110, 0.0092), splash * 0.55);
  rgh = mix(rgh, 0.96, splash * 0.5);

  // Water sits on the up-faces and rots them; the undersides stay dry and
  // keep their colour, which is a free extra axis of variation on a box.
  base *= 0.84 + 0.26 * (1.0 - max(vWN.y, 0.0));

  diffuseColor.rgb *= base;
  roughnessFactor = clamp(rgh, 0.16, 1.0);
  metalnessFactor = clamp(met, 0.0, 1.0);
}
`;

export function makePropMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1, metalness: 0,
    /* Every prop in the kit is a closed solid, but a leaning pallet's deck
     * boards and an A-board's leaves are effectively open plates, and
     * front-side shadows are correct for all of them. It is also the only
     * setting under which a pallet's gaps print on the wall behind it, which
     * is most of the reason a pallet is worth building. */
    shadowSide: THREE.FrontSide,
    envMapIntensity: 1.0,
    dithering: true,
  });
  m.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        'void main() {',
        `${FACADE_VARYINGS}\nvarying vec4 vProp;\nattribute vec4 aProp;\nvoid main() {`,
      )
      .replace('#include <begin_vertex>', `${FACADE_VERTEX}\nvProp = aProp;`);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        `${NOISE}\n${FACADE_VARYINGS}\nvarying vec4 vProp;\n${CANYON}\nvoid main() {`,
      )
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${PROP_BODY}`)
      .replace('#include <lights_fragment_end>', `${skyLift(2.6)}
/* The same treatment the building metal gets, and for the same reason: street
 * ironwork is painted, rusted, galvanised and then dirtied, and whatever
 * mirror it left the works with is long gone. Its reflection of the sky
 * arrives scattered and largely achromatic rather than as a clean coloured
 * image of the zenith, and a bollard that mirrors the blue-violet slot
 * overhead is the single loudest CG tell available at this hour. */
{
  vec3 s = reflectedLight.indirectSpecular * gPropSpec;
  reflectedLight.indirectSpecular =
    mix(s, vec3(dot(s, vec3(0.2126, 0.7152, 0.0722))), 0.58);
  reflectedLight.directSpecular *= gPropSpec;
}
`);
  };
  m.customProgramCacheKey = () => 'street-props';
  return m;
}

/* ── Signage ─────────────────────────────────────────────────────────────── */

/* The painted board.
 *
 * Four branches, and the split is by *trade* rather than by shape: a modern
 * blade is a dark ground with cut vinyl on it, a hanging board is gilt on
 * green because it has been there since before vinyl existed, a painted wall
 * sign is a colour that has been in the weather for eighty years, and a plate
 * is enamel. They want different grounds, different inks and — the part that
 * actually decides whether a sign reads — different amounts of wear.
 *
 * The lettering itself comes out of `signs.ts`: a stroke font rasterised by
 * distance into an R8 atlas, one row per word, with the row's mean ink
 * published alongside so a sign converges to the right tone rather than to
 * noise once its letters fall below a pixel. Everything here does is choose a
 * row, lay it out on the board and decide what colour the paint is.
 */
const SIGN_BODY = /* glsl */ `
{
  int   row  = int(vSign.x + 0.5);
  float kind = vSign.y;
  float seed = vSign.z;
  float tone = vSign.w;
  float bAsp = max(vSign2.x, 0.05);

  /* Both of these take derivatives, so they are called before anything
   * branches on the sign kind. A discontinuous derivative across a branch is
   * undefined, and on a board only a few pixels tall it shows up as a row of
   * letters that flickers between set and smeared. */
  float mir = signMirror(vSignUv, vWN);
  float asp = signAspect(row);

  /* A signwriter fills the board he is given: the cap height is whatever fits
   * the width with a margin, up to about half the board's height. Setting type
   * at a fixed size instead is what makes procedural signage read as a font
   * dropped onto a rectangle. */
  float capV  = min(0.50, 0.80 * bAsp / max(asp, 0.001));
  float textW = clamp(capV * asp / bAsp, 0.02, 0.94);
  vec2  q     = vec2((vSignUv.x - (1.0 - textW) * 0.5) / textW,
                     (vSignUv.y - (1.0 - capV) * 0.42 - capV * 0.06) / capV);
  float px    = fwidth(q.y);
  float ink   = signInk(row, q, px, mir);

  vec2 pn = vec2(vSignUv.x * 40.0 + seed * 31.0, vSignUv.y * 40.0 + seed * 17.0);
  vec2 pw = vec2(dot(vWPos.xz, vec2(6.0, 6.0)), vWPos.y * 7.0 + seed * 11.0);

  vec3 ground, letter; float rgh; float wear;

  if (kind < 0.5){
    /* A modern blade: a dark painted or powder-coated ground with the name cut
     * out of light vinyl. Occasionally the other way round, which is a real
     * and common variant and is worth having because a street of identically
     * polarised signs reads as a set. */
    /* Grounds, and they were first authored two to three times darker than
     * this. Every one of them was between 0.017 and 0.062 linear, on the
     * reasoning that signwriter's paint is a deep colour — which it is, as a
     * pigment. What that missed is that nothing here is lit to key: the sun is
     * at 4.2 degrees and a blade hangs perpendicular to the frontage, so its
     * two lettered faces are the two surfaces on the street that the disc
     * never touches. They are lit by sky alone. A 0.02 albedo under sky fill
     * is a black rectangle, and the capture showed exactly that: a parade of
     * dark slabs where the only sign anyone could read was the one that had
     * come up inverted.
     *
     * So the darks are lifted to 0.05-0.09, which is a real dark green or
     * oxblood measured rather than imagined, and two mid grounds are added —
     * cream and ochre, both of which are commoner on a real parade than any
     * of the darks and neither of which was represented at all. */
    vec3 dark =
      tone < 0.22 ? vec3(0.0520, 0.0560, 0.0640) :        // near-black grey
      tone < 0.42 ? vec3(0.0430, 0.0810, 0.0590) :        // dark green
      tone < 0.60 ? vec3(0.1450, 0.0480, 0.0430) :        // oxblood
      tone < 0.74 ? vec3(0.0510, 0.0650, 0.1180) :        // navy
      tone < 0.88 ? vec3(0.3600, 0.3050, 0.1850) :        // ochre
                    vec3(0.4700, 0.4400, 0.3700);         // cream
    vec3 light = vec3(0.5400, 0.5200, 0.4780);
    /* Nearly half, not a quarter. A light ground with dark type is the single
     * commonest shopfront blade there is, and it is also the only polarity
     * that survives being 30 m away in haze — which, on a street the camera
     * walks down, is where most of the signs are most of the time. */
    bool inv = fract(seed * 7.3) > 0.56 && tone < 0.74;
    ground = inv ? light : dark;
    letter = inv ? dark : light;
    rgh = 0.52; wear = 0.20;
  } else if (kind < 1.5){
    /* The painted wall sign. Eighty years of weather: the ground has gone
     * chalky and half of it has washed back to the render underneath, and the
     * lettering survives better than the ground does because lead white was
     * always the most durable pigment on the wall. That asymmetry is the whole
     * look — a ghost sign is legible letters on an illegible field. */
    ground = mix(vec3(0.1150, 0.0620, 0.0430), vec3(0.0900, 0.0850, 0.0700), tone);
    letter = vec3(0.2450, 0.2280, 0.2000);
    rgh = 0.94; wear = 0.78;
  } else if (kind < 2.5){
    // Gilt on dark green. A hanging board is the oldest sign on the street and
    // gold leaf is the one thing on it that has not faded.
    ground = mix(vec3(0.0400, 0.0720, 0.0530), vec3(0.1050, 0.0400, 0.0380), tone);
    letter = vec3(0.4200, 0.3050, 0.1080);
    rgh = 0.40; wear = 0.34;
  } else {
    /* Enamel plate, board edge and window lettering. A negative tone is the
     * edge of a board rather than a face of it: it takes the frame paint and
     * no type at all, because setting a word on a 28 mm strip produces a smear
     * that reads as an artifact. */
    /* The board frame gets a paler grey than the faces do, because it is what
     * is actually seen at the silhouette: the top edge of a blade is the one
     * part of it the low sun can reach, and at 4.2 degrees it is a bright
     * line against a face in shade. Painting the edge the same near-black as
     * the ground throws that away and leaves the sign with no thickness. */
    ground = tone < 0.0
      ? vec3(0.0880, 0.0850, 0.0790)
      : mix(vec3(0.0520, 0.0780, 0.0610), vec3(0.0620, 0.0570, 0.0690), fract(seed * 3.1));
    letter = vec3(0.4000, 0.3300, 0.1600);
    rgh = tone < 0.0 ? 0.70 : 0.34;
    wear = 0.26;
    if (tone < 0.0) ink = 0.0;
  }

  /* Wear, and it is applied to the *ground* and to the *ink* differently.
   *
   * Paint fails by flaking off in patches, so the ground goes back towards
   * what is under it in Worley-shaped islands rather than fading uniformly.
   * Lettering fails by thinning, so the ink loses coverage at its edges first.
   * Fading both by the same scalar is the thing that makes a weathered sign
   * look like a sign with the opacity turned down. */
  vec2 wc = wworley(pn * 0.35);
  float flake = smoothstep(0.34, 0.02, wc.y - wc.x) * (0.35 + 0.65 * unit(wfbm(pn * 0.9, 4)));
  float substrate = 0.30 + 0.55 * unit(wfbm(pw * 1.7, 4));
  ground = mix(ground, vec3(0.1350, 0.1180, 0.0980) * substrate, clamp(flake * wear, 0.0, 0.92));
  ink *= 1.0 - clamp(wear * (0.45 * flake + 0.40 * smoothstep(0.25, 0.85, unit(wfbm(pn * 2.6, 3)))), 0.0, 0.95);

  // Dirt runs down a vertical board, and it collects on the bottom rail.
  float run = unit(wfbm(vec2(vSignUv.x * 14.0 + seed, vSignUv.y * 2.2), 3));
  ground *= 0.80 + 0.30 * run;
  ground *= mix(0.62, 1.0, smoothstep(0.0, 0.16, vSignUv.y));

  vec3 base = mix(ground, letter, clamp(ink, 0.0, 1.0));

  diffuseColor.rgb *= base;
  roughnessFactor = clamp(rgh + 0.22 * flake * wear, 0.18, 1.0);
  metalnessFactor = 0.0;
}
`;

export function makeSignageMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1, metalness: 0,
    /* A blade is a closed box and a painted wall panel is a single quad. Front
     * side is right for both, and it is what puts a blade's seven metres of
     * shadow along the brickwork beside it — which is most of the reason a
     * projecting sign is worth modelling at this hour. */
    shadowSide: THREE.FrontSide,
    envMapIntensity: 1.0,
    dithering: true,
  });
  m.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, signUniforms());
    shader.vertexShader = shader.vertexShader
      .replace(
        'void main() {',
        `${FACADE_VARYINGS}
varying vec4 vSign;
varying vec4 vSign2;
varying vec2 vSignUv;
attribute vec4 aSign;
attribute vec4 aSign2;
void main() {`,
      )
      .replace(
        '#include <begin_vertex>',
        `${FACADE_VERTEX}\nvSign = aSign;\nvSign2 = aSign2;\nvSignUv = uv;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        'void main() {',
        `${NOISE}
${FACADE_VARYINGS}
varying vec4 vSign;
varying vec4 vSign2;
varying vec2 vSignUv;
${signGLSL()}
${CANYON}
void main() {`,
      )
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>\n${SIGN_BODY}`)
      .replace('#include <lights_fragment_end>', skyLift(2.6));
  };
  m.customProgramCacheKey = () => 'street-signage';
  return m;
}
