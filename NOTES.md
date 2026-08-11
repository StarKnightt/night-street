# Deferred work

Items that have been diagnosed and deliberately left for a later pass. Nothing
here is a bug report against the current build; each is owned by a pass that has
not run yet.

The technique brief for Systems 5, 6 and 8 — lighting, atmosphere and
post-processing — lives at `docs/TECHNIQUE.md`. Read it before starting any of
the three.

## Post-processing / colour grade pass owns

- **Road hue and saturation.** The matrix sits at about 3 degrees red with a
  saturation of 0.23, where real asphalt measures 0.05–0.12. The sunlit
  carriageway reads at luminance ~0.30 and saturation ~0.35; the targets are
  luminance ~0.18, saturation ~0.15, and the hue pulled off pure orange toward
  neutral-warm. Note for whoever takes this: tinting the inter-chip cavities
  toward zenith blue was tried and made the saturation *worse*, because the chip
  scatter is sparse and leaves too few cavities to act on. That is a dead end —
  do not retry it.
- **Road centreline.** Now worn far enough that it reads as a crack rather than
  as paint; p99 along it is only 149. Over-corrected, pull it back.
- **Shaded ground balance.** Blue leads red by 18 counts. Plausible, but
  slightly cool — verify against reference before accepting.

## Later polish

- Window contrast on the far-distance backdrop blocks in `lit/86` is only 4–8
  luminance units, too ghostly to register as windows.
- The gutter grit band in `80.png` holds the brightest pixel in the lower frame
  at (250, 239, 226) as fuzzy white spray. It reads as noise rather than as
  debris.
- Flat rooflines with no parapet or clutter on the mid-distance dark masses, for
  example `pair/55.png` around x 700–890.
- The street's terminating wall in `tilt.png` is carried entirely by haze and
  has nothing on it if the haze thins.
- Faint 1 px vertical light streaks in the haze at the far end of `tilt.png`,
  probably surviving distant geometry edges.

## Deferred material work

- Chip embedding and the contact meniscus on the asphalt.
- Wheel tramline form.
- Voronoi crack distribution.
- Stucco spall relief.
- Shopfront glazing depth.

## The display response — the authoritative answer

**`display = 0.284 · L^0.4545` is wrong and is withdrawn.** So is the table
that used to stand in this section, which fitted a curve through two different
input spaces and is also withdrawn. Do not use either. If you find the formula
anywhere else in the tree, it is a leftover; `docs/TECHNIQUE.md` §1 now carries
the same correction and nothing else should.

### How to convert a target display value into a radiance

Run the transform. Do not fit anything to it.

```
node tools/agx.mjs                 the forward curve and the inversion, tabulated
node tools/agx.mjs 3.4 1.42 0.42   one radiance -> the 8-bit code it arrives at
node tools/tonecheck.mjs           the evidence for all of this, re-derived
```

`tools/agx.mjs` is three's `AgXToneMapping` at `toneMappingExposure = 0.296`
followed by the sRGB encode, ported term for term out of `node_modules` rather
than fitted to measurements, and inverted numerically. **Pass `--sensor`, or
call `display(rgb, { sensor: true })`, for anything the renderer draws** —
`sensor.ts` patches `colorspace_fragment` globally, so every fragment in the
scene including the sky carries its pedestal. Without the pedestal the answer
is right in the midtones and up to fifteen counts low in the shadows.

Neutral values, with the pedestal, for reading off directly:

| code | L | code | L | code | L |
|---|---|---|---|---|---|
| 16 | 0.008 | 96 | 0.306 | 200 | 3.47 |
| 24 | 0.029 | 112 | 0.439 | 208 | 4.41 |
| 32 | 0.046 | 128 | 0.625 | 216 | 5.76 |
| 48 | 0.085 | 144 | 0.889 | 224 | 7.83 |
| 64 | 0.138 | 160 | 1.273 | 232 | 11.4 |
| 80 | 0.209 | 176 | 1.854 | 240 | 19.1 |

**That table is for greys only.** AgX works per channel through two chroma
matrices, so a saturated colour does not map like a neutral of the same peak
magnitude — the pharmacy cross at L = (1.31, 10.96, 3.07) arrives at
(199, 231, 202), and its red channel lands about forty counts above where a grey
of 1.31 would. For anything with chroma in it, pass the triple to `agx.mjs` and
read the answer. It costs one command and it is exact.

### Why it can be trusted

Nine sky pixels, three cameras, `sys5a`. `scene.background` is a Float32
equirect written straight out of `skyRadiance()` in `env.ts` with
`backgroundIntensity = 1` and `NoColorSpace`, so a sky pixel is the one place in
the frame where the scene radiance is known in closed form with no albedo, no
BRDF, no light and no shadow in the path. Predicted against measured, over
per-channel radiances from 0.11 to 0.48:

**mean absolute error 0.0 counts.** Worst point, 1 count, and that one only
without the pedestal.

Second check, independent and chromatic and an order of magnitude higher: the
underside of a working lantern is `BOWL_WARM · mott` with `mott` spanning
0.78–1.22, and `BOWL_WARM` is (10.84, 5.10, 1.41). Predicted (234, 212, 183) at
the mean of the mottle, (238, 218, 191) at its ceiling; measured 233–242 red,
211–227 green, 182–205 blue over the brightest patch of bowl in `-lamp/head`.

So the curve is settled from L = 0.11 to L = 13 to within a couple of counts,
and it is not a fit — it is the shipped transform. Below 0.11 and above 13 it is
unmeasured but not in doubt, because it is not being extrapolated: it is the
transform itself, evaluated.

### Where 0.284 came from

`streetMaterials.ts:790` records the calibration: "feeding the pane a known
constant of 1.6 returns display 90". The real transform sends 1.6 to 169, and
90 inverts to 0.266 — an attenuation of about a sixth, in a measurement taken
through a sheet of glass. That is the pane's Fresnel reflectance, not a display
response. Curve A is the sRGB gamma with its scale fitted to one point measured
through a 6× attenuator, which is why its exponent looks respectable and its
constant does not.

The two "fourfold errors" the old §1 warned about were therefore corrections in
the wrong direction. Both raised a constant from about 2.3 to about 8.5 by
inverting a measured 191 through curve A; code 191 is actually L = 2.71, so
2.3 was nearly right and 8.5 is about four times too hot. On screen the
difference is only twenty counts, because it lands on the shoulder — the same
shoulder that hid the original error, working the other way. **Not fixed:
`litWall` in `streetMaterials.ts:797` and the car body's street probe in
`carMaterials.ts:144` still carry the over-corrected values.** They belong to
Systems 2 and 3.

### The property that caused all of this

The slope is not constant, and not nearly. Adding 0.0175 of radiance — a street
lamp at 5.5% of the sun, on the carriageway:

| base L | base code | after | step | what that is |
|---|---|---|---|---|
| 0.038 | 28 | 35 | **+7** | shaded carriageway |
| 0.10 | 52 | 57 | +5 | |
| 0.20 | 78 | 81 | +3 | |
| 0.43 | 111 | 112 | **+1** | sunlit carriageway |
| 0.80 | 139 | 140 | +1 | |

The same light is worth seven counts on the shaded carriageway and one on the
sunlit one. Nobody authoring by eye against a tonemapped frame can be right
about both, and which way they err depends only on what they happened to be
looking at when they judged it. Three agents have now made this error
independently; it is a property of the pipeline and not carelessness. Invert,
don't look.

The two levels above are measured, off the near carriageway in `sys5a/60` and
`sys5a/40` — same material, same viewing geometry, one outside a sun band and
one inside it. Shaded asphalt is L = (0.038, 0.041, 0.092), **blue-dominant**,
because the shade in this scene is lit by a blue-violet sky and nothing else.
The sun adds about (0.36, 0.19, 0.11) on top, warm.

Two consequences worth carrying:

- **Nothing can be darker than about code 15.** The sensor pedestal alone
  encodes to that, so anything authored below L ≈ 0.008 arrives at the floor.
  Check before spending a shader branch on it.
- **Any claim of the form "the pool is invisible" has to name the patch it was
  read from**, because on this street the same lantern is worth seven counts or
  one depending on whether the road under it is in a sun band. `block.ts`'s
  bands run −48.7..−31.9 and −83.7..−72.9, and lamp 3 at z −45 sits inside the
  first one deliberately.

### A warning about agreement

The first run of `tools/sys5probe.ts` predicted +8.3 counts for lamp 3's pool
against a critic's independently derived +8 to +9, which looked like strong
confirmation and was quoted as such. It was not. Both of the probe's inputs were
display-referred values used as if they were scene radiance — understating the
irradiance transfer by four times — and the curve they were pushed through was
also wrong, in the opposite direction. The errors cancelled to within a count.

Corrected on both sides the answer is +6.6, and on the base the critic was
almost certainly reading it is +8. So the conclusion survives; the evidence for
it did not. **Agreement with an independently derived number is strong evidence
that the machinery is sound and no evidence at all that the inputs are.**

### What still carries a level authored against the old curve

Every emissive in `scene/lights.ts`, and they all land high:

| source | authored for | arrives at |
|---|---|---|
| bowl, warm | 214 | 234 |
| bowl, warming (as shipped) | 132 | 160 |
| BAR letters | 225 | 245 |
| pharmacy cross | 215 | 231 |
| OPEN | 232 | 244 |
| signal, green aspect | 228 | 233 |

The 0.325 correction on `BOWL_WARMING` was measured, and was in the right
direction, but it was read against curve A and is the wrong size. Redo it
against `agx.mjs` rather than keeping it.
