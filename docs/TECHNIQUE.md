# Technique brief — Systems 5, 6 and 8

Lighting, atmosphere and post-processing. Written before any of the three were
built, from a survey of the reference project, the Three.js skills installed on
this machine, and the skills.sh directory.

## What this document is

The three remaining systems are the ones where established technique matters
most and where this project has so far been inventing rather than drawing on
known-good approaches. This is the distilled, actionable version of what the
survey found: parameter starting points, the reasoning behind them, citations
into the code that already solved each problem, and — the part most likely to
save time — a list of techniques that are commonly recommended and would be
actively wrong here.

Two of its findings overturn things that would otherwise reasonably have been
built. They are flagged at the top of their sections and repeated in the
summary below.

## What has changed since this was written — read before quoting a number

This brief was written before Systems 5, 6 and 8 were built, and the scene has
since moved underneath several of its premises. The reasoning is left intact
because it is still the best account of *why* each choice was made; the
following inputs are simply no longer current, and any arithmetic in this
document that uses them is stale by that factor. Verified against the tree at
`fce0191`.

- **The sun is at 12 degrees, not 4.2.** `scene/sun.ts` is the single
  definition and explains the trade. Every "at 4.2°" in this document — the
  shadow lengths, the grazing-angle arguments, §4.3's god-ray geometry, §5.5's
  defocus reasoning — was reasoned at the old elevation. §3's worked example
  `E_sun,horizontal = 115 · sin(4.2°) = 8.42` is now `115 · sin(12°) = 23.9`.
- **§4.3's conclusion was overturned and a volumetric march ships.**
  "Do not build a volumetric renderer" was right on its own premises and lost
  to two things it did not anticipate: a dozen lamp cones, which are not two
  planes and cannot be made into two, and the fact that the analytic version
  was occluded by the frontage gaps and by nothing else on the street. The
  argument, including what the march deliberately does *not* carry so that it
  cannot produce flat beige, is at the head of `scene/volumetric.ts`.
- **`scene.environmentIntensity` is 1.0, not 0.50**, and the probe is now
  convolved from the same cloudy sky that is drawn rather than from a separate
  cloudless one. Shadow-side surfaces came up 1.2× to 3.3× when that landed, so
  every "shade is lit by the environment at 0.50" comparison here understates
  the ambient by about a factor of four.
- **The sun's shadow map is 8192 × 4096 and its box is rolled along the
  street**, not the 4096² level-oriented box quoted in §3.2 and §6. See
  `scene/sunShadow.ts` for the measured cost of the roll in ground texel
  density, which is the only density worth quoting.
- **The street lamps are at 329 cd.** Any candela figure here predates the
  re-anchoring in `scene/lampFixtures.ts`, which also records why the old
  derivation went stale without looking like a transcribed constant.
- **The bloom veil is nine octaves, not six.** Six stops 6.4 degrees from the
  disc; the far field was measurably inert before the change.

The withdrawal of `display = 0.284 · L^0.4545` below still stands and is the
most important thing in this file.

## What the sources turned out to be worth

**`c:\Code\jungle-trail` has no skill files.** No `.cursor/`, `.claude/`,
`.agents/`, `skills/` or `docs/` directory exists in it. Its entire accumulated
technique lives in two places: `README.md`, and the header comments of
`src/render/grade.js` (1313 lines), `src/render/atmosphere.js` (952) and
`src/render/sky.js` (297). Those comments are not documentation of the code —
they are a record of what was tried, what it measured, and why it was reverted.
They are the only source in this survey operating at the level this project
needs, and roughly 70% of this brief comes from them. **If you read one thing
before starting, read `grade.js` top to bottom.**

**The installed `threejs-*` skills and skills.sh were surveyed and are not
worth further consultation.** The locally installed `threejs-lighting`,
`threejs-postprocessing`, `threejs-shaders` and `threejs-materials` are the
`cloudai-x/threejs-skills` package (the `.claude` entries are symlinks). They
are flat API catalogues with no measurement, no ordering discipline and no
colour-space reasoning; several of their recommendations are actively wrong
here and are listed in §6. `3d-games` and `web-games` contain nothing on render
budget or optimisation — a single table row, "Batching | Combine draw calls".
`threejs-aaa-graphics-builder` is arcade-oriented; two things in it are useful
and both are already observed in this codebase (the `customProgramCacheKey`
rule, and the note that `MeshPhysicalMaterial.transmission` triggers an extra
full scene render per frame), and its budget table is below what this project
already does.

skills.sh was queried through its search API for `three`, `volumetric`,
`godray`, `atmosphere`, `color grading`, `bloom`, `shader`, `lighting` and
`webgl`. The only Three.js rendering skills on the directory are
`cloudai-x/threejs-skills/*` — the identical package already installed locally
— plus `enzed/r3f-skills/r3f-postprocessing`, a wrapper cookbook for
`@react-three/postprocessing` at the same tier. **Nothing there is worth
having. Do not install anything, and do not repeat this survey.**

## The two overturning findings

**1. God rays are wrong for this canyon at this sun elevation.** At 4.2° the
beam runs *along* the street rather than across it, so a shaft is parallel to
the view and has no cross-section in frame — it is a wash, and the forward lobe
already in `haze.ts` is the correct and far cheaper representation of it. This
is not speculation; it is the exact failure jungle-trail hit and needed two
paragraphs of gating to remove. The one legitimate exception is an **analytic
alley-gap wedge**: a cross-street or service alley presents vertical edges
perpendicular to the beam and casts a wedge with a legible boundary. Build one
or two of those as a per-fragment slab test. Do not build a volumetric
renderer. Details in §4.3.

**2. The phone's hyperfocal distance is 3.8 m, so the far-field defocus branch
should be deleted, not tuned.** At f/1.7 on a 5.7 mm lens, everything past
about 2.6 m is inside the depth of field and the far circle of confusion never
reaches a pixel. Jungle-trail's `maxFarPx = 2.6` belongs to a 35 mm prime and
does not transfer. The near field is real but small — `maxNearPx ≈ 5`, not 16.
Details in §5.5.

---

# 1. The display response — read this first

**This has caused four independent errors in one week, in both directions.**
Every one was made by setting a linear radiance against a tone-mapped frame:
three by eye, and one by inverting a formula that turned out to be a fit to a
single contaminated measurement. Every emissive value, every reflection constant
and every light level in Systems 5, 6 and 8 must be set by inverting a target
display value — and the inversion has to be the real transform, not a curve
fitted to it.

## ~~display = 0.284 · L^0.4545~~ — WITHDRAWN, do not use

That formula stood in this section until it was disproved twice on the same
night, and it is wrong by about a factor of two in display across the whole
usable range, worse than that in the shadows and in the highlights. It was the
sRGB gamma with its scale fitted to one point — `streetMaterials.ts:790`,
"feeding the pane a known constant of 1.6 returns display 90" — and that point
was measured *through a sheet of glass*, so what the fit actually captured was
the pane's Fresnel reflectance of about a sixth. If you find the constant 0.284
or the exponent 0.4545 anywhere in the tree, it is a leftover and it is wrong.

The full derivation, the evidence and the two constants still carrying
over-corrected values are in `NOTES.md`, under "The display response — the
authoritative answer". Read that before authoring a level.

## Use the transform

```
node tools/agx.mjs                 the curve and its inversion, tabulated
node tools/agx.mjs 3.4 1.42 0.42   one radiance -> the 8-bit code it arrives at
node tools/tonecheck.mjs           the evidence, re-derived from frames on disk
```

`tools/agx.mjs` ports three's `AgXToneMapping` at `toneMappingExposure = 0.296`
and the sRGB encode term for term out of `node_modules`, and inverts them
numerically. **Add the sensor pedestal** — `--sensor`, or
`display(rgb, { sensor: true })` — for anything the renderer draws, because
`sensor.ts` patches `colorspace_fragment` globally and every fragment in the
scene carries it.

Validated against nine sky pixels across three cameras, where the scene radiance
is known in closed form, to a mean absolute error of **0.0 counts**; and against
a lamp bowl at L ≈ 11 in colour, to within a couple. It is not a fit.

| target 8-bit value | required linear radiance L (neutral) |
| --- | --- |
| 24 | 0.029 |
| 48 | 0.085 |
| 80 | 0.209 |
| 112 | 0.439 |
| 128 | 0.625 |
| **160** | **1.27** |
| 191 (a sunlit fascia, measured) | 2.71 |
| 208 | 4.41 |
| 224 | 7.83 |
| 240 | 19.1 |

**For greys only.** AgX runs per channel through two chroma matrices, so a
saturated colour does not map like a neutral of the same peak magnitude. Pass
the triple to `agx.mjs`.

## The shape of that table is the single most reusable fact in this document

Going from display 128 to 160 costs a **104% increase** in radiance. Going from
208 to 224 costs **77%**, and from 224 to 240 costs **144%** — the shoulder
never stops charging, it just stops showing.

Run it the other way and it is worse, because the *slope* changes tenfold.
Adding 0.015 of radiance — a street lamp at 5.5% of the sun — to a patch of
carriageway is worth **+7 counts** where that patch is in shade at L = 0.038 and
**+1** where it is in a sun band at L = 0.43. Both are measured off the same
material in the same capture set.

Two consequences:

- Near the shoulder a surface can be four times too bright or too dark in linear
  light and look approximately right on screen. Both of the "fourfold errors"
  this section used to warn about were real, and both were then over-corrected
  by about four times in the other direction, and neither round could be settled
  by looking. See `NOTES.md`.
- Nothing in this project can be darker than about **code 15**. The sensor
  pedestal alone encodes to that, so anything authored below L ≈ 0.008 arrives
  at the floor.

Corollary for System 5: making an artificial source *look* brighter than a
sunlit fascia is cheap in radiance terms and therefore easy to overshoot without
noticing. Making a subordinate source read as present at all is expensive, and
how expensive depends entirely on what it is being added to. Invert, don't look.

---

# 2. The standing rule: you cannot judge a linear quantity by looking at a display-space image

Five separate expensive bugs on this project reduce to one sentence. It is
worth stating as a rule because the instinct it violates is a strong one.

| # | Instance | Symptom |
| --- | --- | --- |
| 1 | `envMapIntensity` is inert project-wide — light arrives via `scene.environment` and Three reads `scene.environmentIntensity` alone | Materials tuned by adjusting a value that did nothing; the real control was elsewhere |
| 2 | Haze mixed a linear radiance into a display-encoded buffer (`haze.ts:196–203`) | `hazeSky` returns 3.4 at the sunward horizon, which clamps to 1.0 in red; hard-edged flat orange rectangles that three review rounds read as a UV bug |
| 3 | Albedo detail dies on the AgX shoulder in direct sun | Material work invisible in exactly the region it was being judged in; real shading effects survive where albedo variation does not |
| 4 | Shopfront reflection radiances set fourfold too dim (`streetMaterials.ts:766–781`) | Glazing stayed dark; the Fresnel fraction was correct and what it was a fraction *of* had no content in it |
| 5 | Car cabin and street-probe radiances suspected of and confirmed with the same error (`carMaterials.ts:133–148`) | The same 2.3 for a sunlit wall, arrived at independently |

Two remedies, both cheap, both enforceable in review:

1. **Author by inverting a target display value through the measured curve in
   §1.** Never by eye against a tone-mapped frame. If a number cannot be traced
   back to a target display value, it is a guess.
2. **Declare the input and output colour space in a comment at the top of every
   pass, every shader chunk patch and every fullscreen shader.** Linear
   radiance, tone-mapped linear, or display-encoded — say which, on the way in
   and on the way out. System 8 will add several passes to a pipeline that
   already has non-obvious ordering (`fog_fragment` runs *after*
   `tonemapping_fragment` and `colorspace_fragment`; `sensor.ts` prepends
   itself to `colorspace_fragment`), and this is the one convention that makes
   the ordering auditable.

---

# 3. System 5 — lighting

## 3.1 Start by measuring what the removed rig cost

`src/scene/Street.tsx:347–364` is the template and should be read before
anything is added. Fourteen unshadowed spotlights with a projected cookie were
measured before removal: disabling all of them changed the shaded frontage by
**0.0%** and the carriageway at nadir by **0.10%**. At 200× intensity the
shaded wall moved 4.5%. The rig contributed roughly two hundredths of one per
cent of the frame.

It was removed anyway, and the reason governs this whole system: **fourteen
lights and a cookie sit in every material program in the street, and the
texture-unit budget they forced is why the three paving materials were running
without their baked occlusion maps.**

The cost of a light in a forward renderer at golden hour is not its radiance
contribution. It is `NUM_POINT_LIGHTS` / `NUM_SPOT_LIGHTS` in every one of your
32–40 draw calls, plus a texture unit if it carries a cookie, plus a shadow map
if it casts.

## 3.2 Budget

- **Real `Light` objects: four or fewer, total.** One of them is the sun, which
  already exists.
- **Shadow-casting lights: one, the sun.** `softShadow.ts` runs a 12-tap
  blocker search plus a 20-tap Vogel filter with a receiver-plane depth
  gradient solve, per fragment, against a 4096² map. A second shadowed light
  doubles the depth pass and adds a second PCSS to every material.
- **Everything else is analytic, evaluated in the receiving material from a
  uniform array.** This pattern already exists and works: `world/dims.ts:122–135`
  publishes `LAMPS` as a constant array specifically because "the carriageway
  material needs them: shading an aggregate chip so that it has a genuinely
  dark side requires knowing which way the light is coming from." That is the
  route for many small sources — no draw call, no light slot, no texture unit,
  no shadow map.

## 3.3 Deriving the level of an artificial source

Three.js r155+ is in physical units: `DirectionalLight.intensity` is lux,
`PointLight.intensity` is candela. The sun is at 115 with `SUN_ELEV = 4.2°`, so
the horizontal irradiance on the carriageway is:

```
E_sun,horizontal = 115 · sin(4.2°) = 8.42
```

A point source at `LAMP_H = 6.8` m directly overhead gives `E = I / 6.8² = I / 46.2`.

| lamp pool as a fraction of the sun on the road | required intensity (cd) |
| --- | --- |
| 5% | 19 |
| 10% | 39 |
| 25% | 97 |

**Start at 20–40 cd.** A dusk lamp that lands at 5–10% of the sun's horizontal
contribution is subordinate by construction and needs no tuning to stay that
way. Above about 120 cd the pool starts competing with the sun on the sunlit
footway, which is the failure the brief names.

Note the asymmetry you get for free: the shaded footway receives no direct sun,
only `scene.environment` at intensity 0.50. The same 30 cd lamp is 5% of the
picture on one side of the street and a dominant local source on the other.
That is the correct reading and it costs nothing.

## 3.4 Emissive geometry versus a real light

Three cases, and the codebase already demonstrates all three.

**Emissive only** — when the source is *seen* and its spill lands on nothing
that matters, or on surfaces the same material already owns:

- Upper-window lit rooms: `buildingMaterials.ts:1092–1102`,
  `gLit = vec3(0.0295, 0.0172, 0.0074)` — an order of magnitude under sunlit
  brickwork (~2.3), with a ceiling-to-floor gradient
  `mix(0.30, 1.30, smoothstep(0.05, 0.78, uv.y))` and an occlusion term for
  furniture, because "a lit room is not a light box, and rendering it as one is
  why these read as glowing decals."
- Shop interiors: `streetMaterials.ts:496–541`. Ceiling at `lc * 1.55`,
  everything else at `lc * 11.0 * col * recv` — radiance times *albedo*,
  because "painting radiance directly overwrites the shading, so the floor,
  both side walls, the back wall and the door all came back at the same number
  and the room had no structure in it whatsoever."
- Car sidelights: `carMaterials.ts:497–505`, `vec3(0.330, 0.026, 0.012)` — a
  seventh of sunlit brick, "a 5 W bulb behind a red lens in daylight is a dull
  coal and not a lamp." **Do not raise this.**

**A real light** — when the spill lands on a *different* material and the shape
of the pool carries information. There is exactly one such case in this scene:
the shopfront pool on the footway.

**Analytic in the receiving material** — the default for everything else, and
the option that should absorb most of System 5. A footway material that
evaluates N shop apertures with a rectangular form factor costs no draw call,
no light slot, and gets soft-edged area falloff for free — which is the one
thing `RectAreaLight` is expensive for.

## 3.5 RectAreaLight — no

In order of severity:

1. **It requires `RectAreaLightUniformsLib`, which binds two LTC lookup
   textures in every program using the material.** That is the exact resource
   that already cost this project its baked AO maps. This alone disqualifies it.
2. **It cannot cast a shadow.** It will light straight through the shopfront's
   own mullions, through the stallriser, and through the awning that
   `street3.ts` emits over half these units.
3. The LTC integration runs per fragment for every material in the scene
   whether or not the pixel is near the aperture.
4. It solves a problem you do not have. There are a handful of apertures, all
   rectangles, all with a known outward normal, all facing the footway. The
   analytic form factor of a rectangle onto a point is about twenty lines of
   GLSL and can be distance-gated.

`world/street3.ts:1300–1305` reaches the same conclusion from the other side
and recommends "a spotlight set back `depth` behind it and aimed along `dir`
with a wide cone" as "cheaper and probably better at this scale." Agreed — but
prefer the analytic version to either, and reserve a spotlight for at most one
hero unit the camera walks directly past.

## 3.6 The shopfront spill, concretely

`world/street3.ts:1287–1342` already publishes the interface.
`window.__shopLights` gives `pos`, `dir` (unit outward normal), `width`,
`height`, `depth: 2.1` and `colour`. Use it rather than re-deriving anything.

**Colour.** `LIT_STORE = [0.80, 0.53, 0.25]`, `LIT_BAR = [0.74, 0.30, 0.075]`.
The file carries a warning that must not be missed: **these are pre-compensated
for the AgX shoulder, not photometric values.** The store's ceiling was authored
at a red-to-blue ratio of 2.07 and measured 1.25 on screen. A spill on the
footway sits *lower* on the curve than an emissive ceiling and will keep more of
its chroma from the same numbers. **Pull the spill back toward neutral, do not
push it.** Target a delivered R:B of about 1.6–1.8 on the pavement, which means
feeding roughly `[0.80, 0.56, 0.34]` normalised rather than the ceiling's own
values.

**Level.** For a 3 m × 2 m aperture at radiance 0.8, the solid angle subtended
from a point 1.5 m out on the footway is around 1.5 sr, so
`E ≈ 0.8 × 1.5 × cos θ ≈ 1.0`. Against the sun's horizontal 8.42 that is 12% on
the sunlit footway and the dominant source on the shaded one. That is the right
answer and it falls out of the geometry — do not tune it up.

**Shape.** A rectangular form factor, not a disc. The pool on the ground is a
trapezoid with soft edges, brightest immediately outside the glass, and it must
be cut by the awning where there is one — a half-plane clip on the form factor,
one `smoothstep`. Mullion divisions are a 1D modulation along the aperture's own
u axis at the bay pitch, which `street3.ts` already knows.

**What it sits against.** `streetMaterials.ts:527–535` states explicitly that
the interior gradient exists so System 5's pool has "something consistent behind
it to sit against — an interior at one value would make the spill read as a
decal on the paving." Match the pool's colour and level to the interior's value
*at the aperture plane*, not to its mean. This is the single detail most likely
to decide whether it reads as a pool or as a decal.

## 3.7 Neon, procedurally, three separate mechanisms

**The tube.** `world/emit.ts` and `street3.ts` already build swept tubes
(`f.tube(...)`). A real shopfront tube is 12–15 mm outside diameter. Emissive,
unlit.

The non-obvious part: a gas discharge is a **volumetric** emitter, not a
Lambertian surface. At the silhouette of the tube you are looking down a longer
chord of glowing gas than at the centre, so the tube is brightest at its edges.
A Lambertian emissive cylinder is flat and is the immediate tell that a neon
sign was modelled as geometry. One line:

```glsl
float chord = clamp(1.0 / max(abs(dot(N, V)), 0.35), 1.0, 2.6);
totalEmissiveRadiance += tubeColour * chord;
```

**Level.** A neon tube is a *source*, not a spill, and it is allowed above the
sunlit fascia — `env.ts:163–176` already accepts that the sun's disc clips, "it
is the one place in the picture where clipping is not only allowed but
required." A dusk shop neon should land at display 200–235, i.e. **L between 9
and 14** by the table in §1. Over a few hundred pixels that is correct. Over a
whole fascia it is not.

**Colour.** Neon proper is red-orange (low-pressure Ne, ~640 nm dominant);
argon-mercury in clear glass is blue-violet; everything else is a phosphor
coating and is more desaturated than people expect. Against a warm frame a blue
or green tube is the strongest colour statement available — use one, not five.

**The glow — two layers, and this is where projects usually go wrong.** Do not
build the glow out of bloom alone. Bloom is a property of the lens and moves
with the frame; the near-field glow in the air is attached to the tube and is
occluded by whatever is in front of it.

1. A coaxial shell: a second tube at 3–4× the radius, additive,
   `depthWrite: false`, radiance falling as roughly 1/r² from the core. This is
   scattering within a few centimetres of the glass and it survives with bloom
   switched off.
2. Bloom picks up the rest in System 8.

**The spill.** Photometrically a 30 W sign against 8.42 lux of sun contributes
nothing, so **do not give it a light**. What it should do is two free things:
put a coloured wash on the fascia board and the reveal immediately behind it
(analytic, one distance term inside the shopfront material), and tint the haze
in the immediate vicinity of the tube.

**The letterforms — reuse `signs.ts`.** It already bakes a stroke font to an R8
atlas with a per-row mean-ink handoff at the resolution limit (`signInk`,
`signAspect`, `SIGN_CAP = 26`), and already solves the mirroring problem via
screen-space derivatives (`signMirror`). A neon sign *is* a stroke font — the
ink coverage is exactly a radial distance to the tube centreline. Feeding
`signInk` into the chord profile above gives neon lettering with no second
system, no second atlas, and the word list (`OPEN 24 HRS` is already in
`FASCIA_WORDS`) for free.

**The dark parts.** A neon sign that is all glow reads as a decal. The
standoffs, the transformer conduit, the black-painted return bends and the dead
segment nobody has repaired are what make it a physical object. Same lesson as
`carMaterials.ts:470–490`, where the *unlit* lenses of a rear cluster are what
sell it.

## 3.8 Traffic lights, TV glow, OPEN signs

All emissive-only, no lights, all in the `gLit` family.

**Traffic lights.** The two dark lenses do the work. A dark lens is a deep
saturated moulding *darker* than the housing around it, with a fine internal
prism structure — `carMaterials.ts:460–490` has the whole model already written
for rear clusters (`col = vec3(0.1050, 0.0072, 0.0055)`, cell pattern at 6.5 mm
pitch, gated by pixel footprint so it converges rather than sparkles). Copy it.
The lit lens: L 3–6 (display 130–170). Green at dusk is the most conspicuous
artificial colour in a warm frame precisely because it is complementary — keep
it small and keep it far.

**TV glow.** Same mechanism as `gLit` in `buildingMaterials.ts`, with three
changes: a much cooler colour (~7000 K, blue-cyan — one of the very few cool
sources this scene should have), a luminance flicker that is a **step function
at cut rate** (a new value every 1.5–4 s, not a sine — a sine reads as a
pulsing lamp), and the existing blind / net-curtain modulation applied on top.
Radiance in the `gLit` range, 0.03–0.08.

## 3.9 Night assumptions in the existing lighting code — traps

- **`makeLampCookie()` in `env.ts:203–270` is marked `TEMP: replaced in System
  5` and should be deleted, not ported.** A projected photometric distribution
  is the right technique and the file argues for it well — but at dusk the pool
  is 5–10% of the sun's contribution, so none of the cookie's asymmetry,
  cut-off or bowl dirt is visible, and it costs the texture unit that already
  forced the AO maps out.
- **`LAMPS` positions are fine; the road material's night-calibrated use of
  them is not.** `dims.ts:122–130` feeds them to the carriageway shader for chip
  terminator shading. At 11 PM the lamp was the key light for that term. At 4.2°
  it is not. Re-measure before keeping.
- **"Lamp pools as composition" is a night idea.** At golden hour a street lamp
  reads as a *source* — a warm point with a corona — not as a pool on the
  ground. Spend the budget on the luminaire's own emissive bowl and its bloom.
- **"Just turning on" is a colour statement, not a brightness one.** A sodium
  lamp at strike is dull red-pink and takes five to ten minutes to reach orange.
  Author the warming lamps deep red-pink at low radiance and leave one or two
  not on at all. This is more convincing than any level.
- **`envMapIntensity` is inert.** Any new material needs the
  `lights_fragment_end` gain pattern instead — see
  `buildingMaterials.ts:1241–1245`,
  `reflectedLight.indirectSpecular = spec * gTint * 1.90`.

---

# 4. System 6 — atmosphere

## 4.1 What already exists, and the discipline it enforces

`scene/haze.ts` is further along than the system name suggests. It patches
`fog_pars_fragment` / `fog_fragment` globally (correctly — "every material in
the scene already includes it"), measures **radial path length** rather than
`-mvPosition.z`, evaluates the same closed-form sky dome as `env.ts` minus the
solar disc, applies a forward lobe `pow(max(mu,0), 2.2)` scaling the depth term
by up to 3.4×, and closes the residual transmittance out over
`smoothstep(60, 165, dist)^1.6`. Density is `FogExp2` at 0.0072.

**The rule everything in System 6 must obey** is at `haze.ts:196–203` and is
instance 2 in §2: three includes `fog_fragment` *after* `tonemapping_fragment`
and `colorspace_fragment`, so `gl_FragColor` is no longer scene radiance by the
time the chunk runs.

**A consequence to know before System 8:** `sensor.ts` prepends its terms to
`colorspace_fragment`, so the current per-fragment order is tonemap → sensor
pedestal and noise → sRGB encode → haze mix. The haze therefore dilutes the
sensor noise in proportion to `fogFactor`. Harmless at current amplitudes, and
it will stop being harmless the moment System 8 moves either term.

## 4.2 Warm directional haze — three cheap additions

The directional part is done and correct. What is missing:

**Height falloff.** `FogExp2` is uniform in altitude, so a parapet twelve metres
up is hazed exactly as much as the pavement at the same distance. This is the
largest missing depth cue in a canyon. The closed-form integral of
exponential-height fog along a ray:

```glsl
// k = 1/scaleHeight, ~0.06 for a 16 m scale height
float dy = worldPos.y - cameraPosition.y;
float heightFactor = (abs(k * dy) < 1e-3)
  ? exp(-k * cameraPosition.y)
  : exp(-k * cameraPosition.y) * (1.0 - exp(-k * dy)) / (k * dy);
hazeDist *= heightFactor;
```

Six lines in the existing chunk, zero cost, and it makes the rooflines hold
while the road dissolves.

**A near-field floor.** Fog is currently exactly zero at zero distance. Real air
is not. A constant term of a few tenths of a per cent stops the near field
reading as a vacuum.

**What not to bother with.** Splitting extinction from in-scatter colour (Mie
extinction is grey, Rayleigh in-scatter is blue) is physically right and, at
4.2° with the forward lobe already dominating, will not register.

## 4.3 God rays at 4.2° in a street canyon — OVERTURNING FINDING

Jungle-trail built the full thing: a half-resolution dithered raymarch
(`atmosphere.js` `VOLUME_FRAG`, `high` tier = 0.5 scale, 22 steps). It works
there because a canopy is a *ceiling with holes*. A shaft is a vertical column,
its cross-section is visible, and the `cnpRamp` gate picks out genuinely open
roof.

**A street canyon at 4.2° is the opposite geometry.** The sun is nearly
horizontal and 35° off the street axis, so a shaft runs *along* the canyon,
nearly parallel to the view. A beam parallel to the view has no cross-section in
frame — it is a wash, not a shaft. And a ray lying near the ground spends its
entire length in the densest air there is.

This is not speculation. It is the exact failure jungle-trail hit and needed two
paragraphs to gate out, `atmosphere.js:317–342`: "a ray skimming the ground: the
density profile is exponential in height, so a ray aimed along a bank sits in the
densest air there is for its entire length and integrates a wash bright enough to
erase the litter behind it… which measured 2.4 times the in-scatter of the actual
beams a third of a frame away and turned a dark textured bank into flat beige."

The forward lobe in `haze.ts` is already the correct and much cheaper
representation of that wash. **Do not build a general volumetric renderer for
this scene.**

**The one legitimate exception.** A cross-street or alley gap, whose *vertical*
edges are perpendicular to the beam, casts a hard-edged wedge of lit air across
the canyon. `street3.ts` has the service alley at z ≈ −68.5 to −72.6 and the
cross street near z ≈ −63. That is the only geometry here producing a shaft with
a legible edge, and it should be built **analytically**: the lit region is the
intersection of the view ray with a half-space swept along `SUN_DIR` from the
gap's edge. A per-fragment slab test — no march, no half-resolution buffer, no
depth-aware upsample. It fits inside the existing fog chunk.

One or two of these, no more. `atmosphere.js:299–305` records that ungating the
shafts gave "half a dozen of them at once at similar weights — which reads as
staging, since real crepuscular rays are rare enough that one strong one is an
event."

**If a march is built anyway**, jungle-trail's parameters are the budget and its
four hard-won details are non-negotiable:

- Half resolution, 22 steps; the whole stack including AO and composite runs
  under 2 ms.
- **Interleaved gradient noise, not Bayer.** A 4×4 ordered matrix trades banding
  for an eight-pixel cross-hatch after upsampling, and a hatch is more noticeable
  than the banding it replaced (`atmosphere.js:259–272`).
- **Depth-aware upsample weighted by *relative* depth difference**,
  `exp(-|Δz| / (0.05·z + 0.02))`. An absolute reciprocal weight is what produced
  "bloom-like yellow haloing" around foliage against openings
  (`atmosphere.js:548–579`).
- **Attenuate the source along its own path to the scatter point**,
  `exp(-column)`. Leaving it out produced the "flat plateau" that read as a bank
  of smoke rather than air (`atmosphere.js:344–366`).
- Clamp the volume fetch. A skipped tier leaves the target unwritten, and a
  non-finite texel times a zero weight is still non-finite.

## 4.4 Dust motes

`scene/dust.tsx` is already good and its comments contain most of the answers:
forward scattering `pow(mu, 5.0)`, a lit *band* rather than a volume
(`smoothstep(0.10, 0.9, y) · (1 − smoothstep(2.2, 4.4, y))`), a twinkle, a
below-horizon gate added after reviewers read high motes as leftover stars, and
`gl_PointSize` clamped to **0.8–3.4 px** with the explicit note that "sized
generously they stop being dust and become out-of-focus bokeh, which asserts a
shallow depth of field this scene does not have."

Three upgrades, in order of value:

1. **Gate the motes on the sun shadow map.** The single change that turns motes
   from an overlay into something in the air. Sample the shadow map at the
   mote's world position in the *vertex* shader and multiply `vGlow`; a mote
   crossing a building's shade line then winks out. One `texture2D` on 2200
   vertices is free, and the mote box (26 × 7.5 × 34) fits comfortably inside
   the 44 × 26 shadow frustum, which is already camera-following and
   texel-snapped.
2. **Correlate the drift in patches.** Each mote currently has an independent
   phase. Real motes move together in convection cells — add a low-frequency
   spatial term so neighbours share a direction.
3. **Make the size distribution power-law.** `aSeed.z` is uniform; bias it with
   `aSeed.z * aSeed.z` so the field is mostly sub-pixel with a few conspicuous
   ones.

**Do not increase the count or the size.** 2200 points is one draw call and is
the right density.

## 4.5 Sky glow

`env.ts:154–176` already has a two-lobe aerosol halo
(`exp(-ang·5.6)·0.45 + exp(-ang·19.0)·5.60`, tinted `1.60 / 0.86 / 0.34`) plus a
clipping disc at `exp(-ang·150)·190`, and `haze.ts` reproduces the halo minus the
disc. That is the sky glow. What is missing is glare around the *silhouette* of
whatever building the sun is behind, and that is a lens effect — §5.3.

---

# 5. System 8 — post-processing

## 5.1 The architecture change comes first, and it is the risky part

There is currently no composer, no HDR target and no depth texture.
`NightStreet.tsx` renders straight to the canvas with `antialias: true`. DOF and
bloom both need the finished frame; DOF needs depth; and WebGL will not let you
read the default framebuffer's depth. So the first task is the same hand-off
jungle-trail made (`atmosphere.js:1–29`): render into a **half-float MSAA target
with a `DepthTexture` attached** (`samples: 4` — jungle-trail notes this costs
nothing and moving MSAA off the canvas is a free swap), run the chain, resolve
to canvas.

**The moment that happens, `haze.ts` and `sensor.ts` both become wrong.** This
is the most likely place System 8 ships its second colour-space bug:

- `haze.ts` currently tone-maps and encodes `hazeSky` before mixing, because the
  fog chunk runs after `tonemapping_fragment`. Once the scene pass writes linear
  HDR and tone-mapping moves to the end, that becomes a double tone-map. **The
  minimal correct fix is to delete the tonemap and encode from `haze.ts` and mix
  `hazeLin` directly** — the chunk keeps its radial path length and its
  closed-form dome, and becomes simpler than it is now. Moving the haze to a
  depth-based fullscreen pass is the alternative and is much more work for no
  gain.
- `sensor.ts`'s pedestal, read noise and dither are display-referred by design
  and must move to the end of the chain. The chroma blotch and read noise are
  properties of the sensor's linear signal and should sit before the grade; the
  8-bit dither must be the very last statement in the frame.

Enforce the §2 rule: **every new pass declares in a comment at the top which
space its input and output are in.**

## 5.2 Ordering

The physical order, which is jungle-trail's order (`grade.js:11–23`) with the
shutter removed:

```
1.  defocus                 linear HDR
2.  bloom / veiling glare   linear HDR
3.  linear grade            crosstalk, then ASC slope/offset/power
4.  AgX @ exposure 0.296    the only tone map in the frame
5.  vignette                linear, pre-encode — a real loss of light
6.  sRGB encode
7.  print grade             toe, midtone contrast, split tone
8.  sensor noise            chroma speckle and blotch
9.  ordered dither          last statement
```

Steps 3–9 are all arithmetic inside one full-screen pass that has to exist
anyway, because something has to tone-map. Only 1 and 2 cost anything
measurable.

The rule underneath it: **anything that adds or moves light happens before the
curve, because all of it is radiance; anything that shapes density happens after
the transfer function, because density is logarithmic.** `grade.js:669–681`
records the cost of getting that backwards — a print-side toe lift of 0.014
applied in linear "put the floor at thirty-two code values" instead of four,
"and looked like someone had left a light on behind the camera."

## 5.3 Bloom — take jungle-trail's wholesale

The most complete solved result in the reference project; port it near-verbatim.
`grade.js:453–580` and `1106–1118`:

- **Karis-weighted 4-tap prefilter**, each tap weighted by `1/(1+max(r,g,b))`.
  Not optional here: without it one bright subpixel event carries a whole 4×4
  neighbourhood and flickers as the camera walks. This scene is *full* of
  grazing speculars at 4.2° — wet gutter, aggregate chips, glazing.
- **Threshold on the exposed value, not the scene value.** `uKnee.z =
  exposure/0.6` in jungle-trail; here it is simply `0.296` (AgX has no 0.6
  normalisation). A soft knee at `(0.85, 0.55)` so bright midtones contribute a
  little and white contributes fully. A hard threshold plus a large multiplier
  is precisely the recipe that produced their blown-out waterfall.
- **13-tap Jimenez downsample** — a box filter aliases badly enough at the third
  level that a bright edge turns into a crawling checkerboard.
- **9-tap tent on the way up, added with the blend unit, radius 1.4, per-step
  gain 1.30, 8 levels.** The gain applies at every step of the climb, so the
  widest level ends up 3.5× the narrowest. This is the number that matters: at
  gain 1.0 and six levels, jungle-trail measured the contribution to a region a
  third of a frame away as **zero, to the last code value** — a glow hugging its
  source rather than a lens scattering light.
- **`uBloom = 0.045`.** Four per cent is a clean lens; twenty is a dirty one and
  hazes the frame.
- All of it **before** the tone curve. Added after, it is added to a signal
  already compressed against white and can only push pixels past it.

Measured cost in jungle-trail: **0.12 ms.**

## 5.4 The golden-hour grade, without a LUT

A 3D LUT is a data structure, not a look, and the look is expressible as
arithmetic. Jungle-trail's `GRADE` object is seven numbers and it is the right
*shape*:

```js
slope, offset, power     // ASC SOP, linear
cross                    // highlight crosstalk amount + onset, linear
print                    // toe lift, midtone contrast, its pivot — encoded
shadow, high             // split tone — encoded
vignette
```

**Do not copy their coefficients.** Jungle-trail's grade is written under a
mechanical constraint stated at `grade.js:72–86`: "the blue coefficient is at or
below the green one in each of the three multiplicative terms, and the only
additive term on blue is negative," because their warm-olive palette was "a
couple of per cent of blue gain away from reading cyan." Night-street's palette
is the **opposite** — its entire review history is about keeping the shade
*blue* against a warm sun: `env.ts`'s azimuthal exponent was raised to 4.6
specifically to move the hemisphere integral onto a shaded wall from blue/red
0.79 to 1.64; `sensor.ts` lifts the pedestal toward blue on purpose;
`streetMaterials.ts` uses `shadeWall = vec3(0.30, 0.31, 0.37)`. Applying
jungle-trail's blue-suppressing grade would undo two rounds of work in one
commit.

Starting points, in the same structure:

**Highlight crosstalk** — the most valuable term. A renderer's brightest pixels
are its most saturated ones because saturation is a surface property and
brightness just multiplies it; real film does the opposite. But AgX was chosen
precisely because it "desaturates towards white far more slowly" than ACES
(`NightStreet.tsx:50–57`), so most of this work is already being done. Start at
**0.05–0.07**, well under jungle-trail's 0.13. Keep their fix of measuring the
weight on the *exposed* value rather than the raw radiance
(`grade.js:658–663`) — reading it off scene radiance "made the term fire hardest
on things that were about to be middle grey."

**ASC slope/offset/power** — `NOTES.md` has already written this instruction and
measured it: the road sits at ~3° red with saturation 0.23 where real asphalt is
0.05–0.12; sunlit carriageway reads luminance 0.30 / saturation 0.35 against
targets of 0.18 / 0.15, hue pulled off pure orange toward neutral-warm. It also
records a dead end — tinting the inter-chip cavities toward zenith blue was
tried and made saturation *worse*, because "the chip scatter is sparse and
leaves too few cavities to act on." So this is a grade instruction, not a
material one, and the sign is the reverse of jungle-trail's:

```
slope  ( 0.985,  1.000,  1.020 )
offset (-0.0015, 0.0,   +0.0010)
power  ( 1.006,  1.000,  0.992 )
```

**Print toe** — AgX already has a long toe and jungle-trail's 0.014 was fighting
an ACES corner at zero. Start at **0.006** and measure the first decile before
moving it.

**Midtone contrast** — the term with the most to give, and the project has
already committed to it: `NightStreet.tsx:50–57` says AgX costs "a flatter
midtone that System 8's grade will put back." Two details from
`grade.js:693–723` transfer exactly:

- The weight is a **plateau, not a parabola**:
  `sstep(0.02, 0.16, y) · sstep(0.88, 0.50, y)`. A parabola is still at
  two-thirds of its peak at 0.8, so it lifts the brightest one per cent of the
  frame — here that is the sun's halo and any neon.
- Apply it to **luminance with the channels carried along in proportion**, not
  per channel. Per-channel contrast also raises saturation, uncontrollably, by
  an amount depending on what colour the pixel happened to be. Measured across
  five stops in jungle-trail it was worth five or six points of chroma on top of
  everything the grade was deliberately doing.
- Pivot near this frame's own **median**, measured with `tools/px.mjs`, not at
  0.18 grey.

Start the contrast at **0.18**.

**Split tone** — here the reference project's rule must be **inverted**.
Jungle-trail warms the shadows because a jungle's shade is lit by light that has
been through leaves. A street canyon's shade is lit by sky and nothing else.
Cool shadows, neutral highlights:

```
shadow ( 0.985, 0.995, 1.000 )
high   ( 1.000, 0.998, 0.992 )
```

**Non-negotiable:** AgX stays, exposure stays at 0.296, and the grade must never
touch `toneMappingExposure`. Switch the grade on and off by swapping whole
coefficient sets rather than branching in the shader (`grade.js:1291–1304`) — it
is the only way back to the exact curve the existing screenshot archive was
judged through.

## 5.5 Depth of field for a phone — OVERTURNING FINDING

Jungle-trail used a 35 mm prime at f/2.8 focused at 5.5 m, `maxNearPx = 16`,
`maxFarPx = 2.6`. That is a documentary camera in bad light and it is the wrong
instrument here. Heavy bokeh would be actively wrong, and the arithmetic says so
emphatically.

A phone main camera: actual focal length ≈ 5.7 mm, f/1.7, sensor ≈ 7.0 × 5.3 mm,
acceptable circle of confusion ≈ 0.005 mm. Hyperfocal distance:

```
H = f² / (N · c) + f = 32.5 / 0.0085 ≈ 3823 mm ≈ 3.8 m
```

**Focused at the hyperfocal, everything from 1.9 m to infinity is sharp.**
Focused at 8 m — a plausible street subject — the near limit is about 2.6 m.

Running jungle-trail's own `_lens()` with those numbers, at the canvas's
`fov: 45` and a 900-line frame: `A = 3.35 mm`,
`sensorH = 2 · 5.7 · tan(22.5°) = 4.72 mm`,
`cocScale = A·f·ph / (sensorH · (focus − f)) = 0.455` px per unit of
`|z − zf| / z`:

| distance | circle of confusion |
| --- | --- |
| 0.6 m | 5.6 px |
| 1.0 m | 3.2 px |
| 1.5 m | 2.0 px |
| 2.6 m | 0.9 px |
| ≥ 3 m | negligible |
| ∞ | **0** — the far CoC never reaches a pixel |

Therefore:

- **`maxFarPx = 0`. Delete the far-field branch entirely — do not tune it.**
  Jungle-trail keeps a feeble far field because "a *completely* sharp horizon is
  itself a tell"; that reasoning belongs to a 35 mm lens at f/2.8 and does not
  transfer. A phone's horizon genuinely is sharp.
- **`maxNearPx ≈ 5`, not 16.** Focus at 8 m.
- **Cut the gather from 12 taps to 6.** The radius is a third as large.
- **Keep the algorithm.** `grade.js:321–451` contains two details that are the
  difference between the effect working and being a blurred cut-out, and both
  survive at any scale:
  - The downsample takes the **nearest** of the four depths, not their average.
    "A foreground silhouette that loses half its pixels to a box filter comes
    back as a sharp edge inside the blur, which is the single most recognisable
    depth-of-field artefact there is."
  - The near field is a **gather with coverage alpha**: each pixel asks which
    neighbours have a disc wide enough to reach it, and the gather radius is the
    radius of whatever near object is actually in reach rather than the lens
    maximum. Gathering at the maximum and dividing by the tap count "measured as
    a depth of field that did nothing."
- **No bokeh shape.** The CoC never gets large enough for aperture blades to
  resolve. The golden-angle `SPIRAL` table (`grade.js:126–145`) gives no visible
  spokes at any tap count and should be reused as-is.

Expected cost: under 0.06 ms, against jungle-trail's measured 0.13 ms at 12 taps
and a 16 px radius.

The framing to hand the builders: **a phone's depth of field is not an effect,
it is the reason the bottom inch of the frame is slightly soft.** If a reviewer
can name it, it is too strong.

## 5.6 Grain — the project already has the right model, and it is not film

Two different things, and confusing them is the trap.

`scene/sensor.ts` is **already a sensor-noise model, and a better one than a
grain pass will produce**: a pedestal lifted toward blue
(`+ vec3(0.0040, 0.0046, 0.0070)`), three *independent* channels because "the
characteristic look of a phone night shot is coloured speckle, not film grain,
and a single shared value reads as grain over the top of the image instead of
noise inside it", a fourth-power dark weighting
(`0.00018 + 0.00105 · d2 · d2`), a separate low-frequency chroma blotch on a
7 px grid with the luminance mean removed, and a dither sized by differentiating
the sRGB transfer curve (`0.00392 · 2.2755 · pow(lum, 0.5833)`).

Jungle-trail's grain is a **film emulsion** model: half shared / half
per-channel, a parabola peaking in the midtones, 9 code values of amplitude,
measured luminance sigma 1.60 at peak and 1.24 over a frame. A phone has no
emulsion. Porting it would put grain in the lit road and in the sky — exactly
where a phone at ISO 50–100 in golden hour has none.

**So System 8 should not add a film grain pass.** What it should do:

1. **Move `sensor.ts`'s terms into the final pass** so they land *after* the
   grade rather than before it. As it stands the grade will amplify or crush the
   noise it was calibrated against.
2. **Leave the amplitude alone until it is measured.** `sensor.ts` already notes
   it was pulled down hard for daylight and "deliberately leaves headroom" —
   that headroom should be spent by measurement, not by eye.
3. Keep `sensor.ts`'s sRGB-derivative dither rather than jungle-trail's fixed
   `(dth − 0.5)/255`; it is the more careful of the two. Put it last.

**The measurement protocol is the real deliverable here**, and jungle-trail's
warning is worth repeating verbatim (`grade.js:880–887`): at amplitude 1.15
their grain measured sigma 0.83 against 0.80 for no grain at all — "it was
quantised away before it reached the file." At 5.0 it measured 0.72, "present
but under the threshold at which grain does the one thing it is here for."
Measure by **differenced pairs from one frozen world state with the term
switched between them**. `tools/diffpng.mjs` already exists.

## 5.7 Vignette

`cos⁴` and nothing else, in **linear, before the encode**, because it is the
only one of these operations that is genuinely a loss of light rather than a
shaping of density (`grade.js:832–844`):

```glsl
c *= 1.0 - uVignette.x * pow(clamp(length(uv - 0.5) * 1.42, 0.0, 1.0), 4.0);
```

Strength: jungle-trail used **0.13** with a caution that transfers exactly —
"the frame already has volumetric mist doing large-scale luminance shaping, and
two overlapping falloffs, one keyed to the sun and one keyed to the frame, would
fight, with the sun-side corner reading as a smudge." Night-street's directional
haze does precisely that job. **Start at 0.10.**

Phone caveat: a phone lens vignettes more strongly than 35 mm glass, but every
phone ISP applies lens-shading correction and removes most of it. The residual
is 3–6% at the corner. 0.08–0.12 is defensible optics; 0.20 is a look.

## 5.8 What to deliberately not build

**Motion blur.** Jungle-trail's shutter is the most intricate pass in the
reference project — depth-reconstructed screen velocity, a parallax-based tap
rejection because depth-based rejection left the sky sharp in a pan, an adaptive
tap count keeping taps two pixels apart, a teleport detector
(`grade.js:147–318`). It cost 0.11 ms and it existed because of a waterfall.
Night-street walks at 1.4 m/s and looks with a mouse, and a phone at golden hour
shoots at 1/500 s or faster, not 1/60. The blur is a fraction of a pixel.
Rebuilding that pass would be recreating the hardest thing in the reference
project for a measurable zero.

**Chromatic aberration — keep it, but change its character.** Jungle-trail's
lateral CA (`uAberr = 0.0018`, quadratic, under a pixel at the corner) scored
9/10 from their critic and is the cheapest possible "this went through glass"
signal. Phones correct *lateral* CA aggressively in the ISP but leave residual
**longitudinal** fringing — purple-green on overexposed edges. At 4.2° with a
clipping sun behind a dark building silhouette there is exactly one place in
this scene where that will show, and it will show beautifully. Bias the effect
that way rather than toward a radial shift.

---

# 6. Commonly recommended, actively wrong here

1. **`UnrealBloomPass`** (`threejs-postprocessing/SKILL.md`,
   `enzed/r3f-skills`, the AAA cookbook, all recommending threshold 0.85 /
   strength 0.45). A Gaussian-per-mip glow that hugs its source, and with
   `OutputPass` last it operates on a buffer tone-mapped in the wrong place.
   Jungle-trail measured a six-level pyramid contributing **zero code values** a
   third of a frame from a bright source. Build the pyramid; do not import the
   pass.
2. **`BokehPass`.** Cinema DOF, scatter-as-blur, hard foreground cut-outs. Wrong
   optics for a phone and the wrong algorithm regardless.
3. **`FilmPass`.** Scanlines and a scanline count. No.
4. **A LUT — including a *procedurally generated* one.** Generating the 3D
   texture in code satisfies the zero-asset rule but is slower than the
   arithmetic, quantises the very small moves this grade is made of, and costs a
   texture unit — the resource that already forced the AO maps out of the paving
   materials.
5. **Lens dirt, anamorphic streaks, hexagonal ghost chains.** A phone lens is
   clean. Its characteristic flare is a small ghost chain toward the frame
   centre, not a horizontal streak, and it is a much smaller effect than every
   tutorial implies.
6. **SSAO as a general term.** Jungle-trail needed it because scattered
   instanced plants cannot carry a baked answer between each other.
   Night-street already states contact darkening analytically where it matters —
   `streetMaterials.ts:550–555` puts occlusion at the wall base explicitly
   because "there is no cast shadow available at a wall base at four degrees." A
   screen-space term on top would double-count it, and both
   `atmosphere.js:783–786` and `grade.js` record that turning up an AO term
   which has *started* working is how shadows get crushed.
7. **Adding an `AmbientLight` or `HemisphereLight` to fill the shade.** The
   shade is lit by `scene.environment` at intensity 0.50, and `env.ts`'s
   azimuthal exponent was set to 4.6 by integrating the dome over a shaded
   wall's hemisphere (blue/red 0.79 → 1.64). An ambient light is a constant and
   cannot be measured against that; it will flatten the one relationship the
   scene is built on.
8. **Setting `envMapIntensity` on anything new.** Inert project-wide. Use the
   `lights_fragment_end` gain pattern.
9. **A bloom threshold in scene-referred units.** With exposure at 0.296, a
   scene-referred threshold of 0.85 blooms essentially the whole frame.
   Threshold on `col × exposure` so that "one" means "would have come out
   white."
10. **Skipping Karis averaging.** At 4.2° this frame is full of grazing
    subpixel speculars. Without the weighted prefilter they appear and disappear
    as the camera walks, and that flicker is far more visible than the bloom
    itself.
11. **Any new fullscreen pass that reads a linear radiance into a
    display-encoded buffer.** Already shipped once — `haze.ts:196–203` is the
    post-mortem, and the symptom was hard-edged flat orange rectangles that
    three review rounds read as a UV bug.
12. **Relief on emissive surfaces to make them read.** For an emissive surface
    `N·L` is irrelevant, so the temptation is to add normal detail to a lamp
    bowl or a tube for "form." On the *housing* around it the sun is doing the
    sevenfold `N·L` swing that 0.42 of perturbation buys at this elevation. Keep
    relief off anything near a light fitting.
13. **A second shadow-casting light.** `softShadow.ts` runs 12 blocker taps plus
    20 Vogel filter taps with a receiver-plane gradient solve against a 4096²
    map, per fragment. Doubling that is not affordable, and no artificial source
    at 5–10% of the sun needs a shadow.
14. **A projected cookie per lamp.** Right technique, wrong hour — see §3.9.
15. **Treating "the lamps are turning on" as a brightness problem.** It is a
    colour temperature problem. A striking sodium lamp is dull red-pink.

---

# 7. Profiling — the `glFinish` trap

**Before any System 8 timing is trusted, check how `tools/profile.mjs`
synchronises.**

`glFinish` in a page does not wait for the GPU. Chromium runs WebGL over a
command buffer into a separate process, and `finish` returns once the queue has
been handed over — not once the work is done. Jungle-trail's `README.md:97–113`
records what that did to their numbers: **the post-processing chain appeared to
cost forty microseconds, and the `ultra` tier appeared to render faster than
`medium`.** Their published frame cost went *up* by 1.5 ms when the timer was
fixed, and the frame had not got slower.

**The fix is to synchronise on a one-pixel `readPixels`**, which cannot return
before the frame exists. Everything the reference project publishes — the 9–10
ms frame, the 1.9–2.0 ms post stack, the 0.12 ms bloom and 0.13 ms defocus — is
measured that way, and the per-pass figures are means of three runs differencing
a frozen world state with one term switched.

Two corollaries for System 8:

- A quarter of a millisecond does not show up reliably against a frame that
  varies by one, which is why per-pass timings must be measured in isolation
  rather than as a frame-level difference.
- Pair captures must come from **one** frozen world state. The predecessor of
  jungle-trail's `tools/fx.mjs` set each half of a pair up from scratch, so the
  two frames were two seconds of falling water apart and differencing them
  measured the waterfall rather than the effect.

---

# 8. Where jungle-trail already solved it — direct pointers

| Problem | File and lines |
| --- | --- |
| Bloom pyramid, Karis prefilter, Jimenez downsample, tent-up with gain | `jungle-trail/src/render/grade.js` 453–580, 1106–1118, 1144 |
| Near-field defocus as a gather with coverage alpha; nearest-of-four depth | `grade.js` 321–451 |
| Golden-angle spiral tap table, no visible spokes at any count | `grade.js` 126–145 |
| Grade split across the tone curve; stock vs print reasoning | `grade.js` 609–733 |
| Vignette as cos⁴ in linear pre-encode | `grade.js` 832–844 |
| Grain amplitude by measured differenced pairs, and two wrong answers | `grade.js` 850–918 |
| Linear-HDR handoff; never tone-map twice | `atmosphere.js` 604–620, `grade.js` 1–35 |
| Depth-aware upsample by *relative* depth difference | `atmosphere.js` 548–579 |
| Interleaved gradient noise over Bayer, and why | `atmosphere.js` 259–272 |
| Why a ground-parallel ray integrates to a flat plateau | `atmosphere.js` 317–366 |
| Shaft gating so one strong ray survives and five weak ones do not | `atmosphere.js` 292–307, 676–694 |
| Sky as both background and IBL from one function | `sky.js` 1–14, 199–243 |
| NaN in a PMREM blacking out every PBR surface with no other symptom | `sky.js` 83–94, 159–164 |
| `glFinish` does not wait; synchronise on `readPixels` | `README.md` 97–113 |

Two places where **night-street is already ahead of the reference project** and
must not regress:

- `env.ts` bakes two skies — one with the solar disc for the background, one
  without for the light probe. That is a cleaner decomposition than
  jungle-trail's single dome, and it is documented at `env.ts:304–319` with the
  measurement that adding the disc to the probe "lifted shadow floors by half a
  stop and the frame went flat."
- `softShadow.ts`'s PCSS with a receiver-plane depth gradient is strictly better
  than anything in jungle-trail, which never had to shade a surface nearly
  parallel to its own key light.
