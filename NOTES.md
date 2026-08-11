# Deferred work

Items that have been diagnosed and deliberately left for a later pass. Nothing
here is a bug report against the current build; each is owned by a pass that has
not run yet.

The technique brief for Systems 5, 6 and 8 — lighting, atmosphere and
post-processing — lives at `docs/TECHNIQUE.md`. Read it before starting any of
the three.

## Verifying the parts and shipping the assembly — the class of bug that cost us most

Three separate failures here have the same shape, and it is worth naming the
shape because the instinct that produces it is a good one. Each time, a system
was verified by measuring the things it *makes*, and each time the thing that
was broken was the way those things were *wired together* — which the
measurement could not see, and which was reporting itself loudly somewhere
nobody was reading.

**System 7 was silent on every machine, in every capture, since the day it was
written.** `tools/audio.mjs` checks the generators, and every one of them was
producing correct samples: the tyre noise, the pink bed, the footstep
transients, the impulse response. What it could not check was `build()`.
`ConvolverNode` is the one node in a Web Audio graph that refuses to resample —
it throws `NotSupportedError` outright if the buffer's rate differs from the
context's — and the IR was rendered at `SR.ir` = 24 kHz into a context that
comes up at 48. The throw happened before the bed, the spot sources and the
footsteps were constructed, so nothing downstream of that line ever existed.
The fix is one expression, `ctx.sampleRate`. The error was in the page console
the whole time, and the reel captures it into `reel.json` under `errors`, where
it sat through several reviews.

**A mote field sat 32 m behind the camera in every capture ever reviewed** while
the interactive walk looked correct, because it was positioned from a uniform
written in `useFrame` and a capture teleports and renders inside one
synchronous evaluation. Same shape: the particle generator was right, the
integration was not, and the instrument was pointed at the generator.

**`tools/obstacles.mjs` cleared routes that were not clear**, because it is a
hand-copy of `world/cars.ts` that drifted — one car short, the dumpster's
half-extents transposed. The routine was correct; the data it ran against was
not the data the page uses.

The common defence is cheap: **make the check load the real assembly**. That is
why `tools/route.mjs` imports `scene/collide.ts` instead of a copy, why
`tools/aim.mjs` derives sign positions from `world/street3.ts` rather than from
a table typed out of it, and why `tools/audiotake.mjs` records the master bus
through a `MediaStreamDestination` instead of summing the generators itself. The
second defence is to read what the assembly says about itself: a non-empty
`errors` array in `reel.json` is a finding, not noise.

## `Walker` stops translating in one frame when forward input goes to zero

Not a bug in anything that has shipped — nothing has ever released `KeyW` mid
take — but it is a trap for the next person who composes an ending.

`update()` builds the direction vector from `input.forward` *before* applying
`speed`:

```
let vx = (-sin * input.forward + cos * input.strafe);
...
if (len > 1e-4) { vx /= len; vz /= len; } else { vx = 0; vz = 0; }
const moved = slide(this.x, this.z, vx * this.speed * dt, vz * this.speed * dt);
```

With `forward` at 0 the vector is zeroed, so no translation occurs however much
`speed` is left. The 111 ms decay on `speed` then feeds only the gait, so for
about 0.35 s the bob amplitude and cadence wind down over a body that is already
stationary. `node tools/route.mjs heroF --csv` shows `z` frozen to four decimal
places with `speed` still reading 0.98 m/s.

Two consequences. The camera's optical flow steps from 23 mm per frame to zero
in one frame, which is a visible hitch; and the feet finish a fraction of a step
without covering ground, which is foot slide in a walk that otherwise measures
0.2% over 85 footfalls. A held final frame — a good idea, and the reason this
was found — needs the walker to coast. The fix is to remember the last non-zero
heading and keep applying it while `speed` decays, which would also make
releasing W in the interactive walk feel like stopping rather than like a pause
button. Left undone deliberately: it changes the motion of every future capture
and was found at 4:50 a.m. on delivery day.

## The shadowed-ground shimmer — closed, and the premise did not survive

The walk harness reported that the shadowed carriageway differences at 9.5 code
values after 5.6 mm of camera travel and only 13.8 after 90 mm, and reasoned
that a difference already saturated at the smallest step must be aliasing. The
first half reproduces exactly. The second is the part to correct, because it
sent two rounds of work at the wrong causes and someone will otherwise send a
third.

`tools/shimmer.mjs` reruns the measurement independently. Each candidate was
removed and the same walk remeasured; on the nearest carriageway, at 5.8 mm of
travel:

| what was removed | change |
| --- | --- |
| supersample 2× — four samples per pixel, boxed to the same output grid | −8% |
| variance-aware normal filtering at 6× coefficient and 9× cap (`?saa=`) | 0% |
| PCSS tap rotation anchored to the world instead of the screen | 0% |
| the shadow filter reduced to a single tap (`?onetap`) | 0% |
| the analytic chip layer entirely (`?nochips`) | −9% |
| the road's specular lobes (`?nospec`) | −39% |

**The supersample row is the one that settles it.** Four samples per pixel halve
the amplitude of anything above Nyquist, and they remove almost nothing — so the
content under the pixel is resolved and this is not aliasing. Normal-map
aliasing, mip selection, LOD bias and shadow-map swimming are each excluded by a
row of their own.

What it actually is: the near carriageway crosses the screen at about 1.4 pixels
per frame at 1/240 s and 1 m/s, where the facade beside it moves 0.07. A
difference saturates once the image has moved past the correlation length of its
own detail, so the test as posed separates *fast-moving* image content from
slow-moving, not aliased from resolved. The facade's 6.1× growth and the near
road's 1.1× are the same surface behaviour at two very different screen speeds.
The distance trend says the same thing in the other direction: per pixel of
image motion the far field is the *least* stable, which is the opposite of what
a near-field aliasing story predicts.

The only honest filter for resolved detail moving that fast is the camera's own,
and §5.5's arithmetic had already specified it: a 5.7 mm lens at f/1.7 focused at
8 m carries about 1.3 px of circle of confusion at the nearest ground a standing
eye can see, and none past three metres. Measured on the same walk, near
carriageway at 5.8 mm: **19.2 → 13.1 counts**, with the facade control at 0.53 →
0.51 and the growth ratio rising 1.13 → 1.26 — the instantaneous part goes and
the parallax stays, which is the signature that had to be checked rather than
assumed.

What is left is real detail moving 1.4 px per frame. Taking more of it means
either blurring resolvable surface or accumulating temporally, and both are
larger decisions than a shimmer fix.

Anyone re-measuring this: `node tools/withlock.mjs shim -- node tools/shimmer.mjs
--q nograde --q g=1`, and add `--ss 2` for the supersample control. Do not
conclude "aliasing" from saturation alone again without it.

## Post-processing / colour grade pass owns

- **Road hue and saturation.** Partly done, and the remainder is now known not
  to be the grade's. The pass takes the sunlit carriageway from saturation 0.263
  to 0.227 and R:B from 2.27 to 2.00 with its value held at 130 counts, and the
  shaded road from 0.237 to 0.201. Closing the rest of the way to 0.15 globally
  would have to desaturate the sunlight itself, which is the look. The residual
  is in the road's albedo. The original note follows, unchanged:
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

## Against the collider — reported, not fixed

The walker collides and follows the ground as of `scene/collide.ts`. Three
things it found in files that are not the collision pass's to edit.

- **`tools/obstacles.mjs` is missing a car and has one dimension swapped.**
  It lists eight cars; `PARKED` has nine — saloon M at z = -96.4 is not in it,
  so `--dry` reports the last seven metres of the street as clear when it is
  not. Its supermini half length is 1.98 against the shape table's 1.975. And
  its dumpster is 1.83 across the street by 1.22 along it, which is the wrong
  way round: `emitDumpster` puts the 1.83 dimension along the frame's u axis
  and `frame()` points u down +Z for it, which is also the only reading that
  leaves the 1.1 m of clear footway street3.ts's own comment claims. The
  header of that file says it is a copy pending an export; the export now
  exists as `carSolids()` in `world/cars.ts`, and `node tools/collide.mjs
  drift` reports the disagreements.
- **The footway furniture is still copied.** `scene/collide.ts` carries the
  five positions from `buildStreetLevel`, because System 3 writes them as
  literal arguments at the call site rather than as a table. Whoever next
  touches `world/street3.ts` should lift them into an exported constant; the
  collider will import it and the copy can go.
- **The eye is no longer at a constant height.** It follows `roadHeight` and
  `walkHeight`, so it sits about 1.64 m above the datum on the carriageway and
  about 1.79 m on the footway. Anything that assumed 1.65 — the shadow
  follower's centre, a haze height falloff, the audio engine's ground
  reflection delay in `audio/design.ts` — is now looking at a camera that
  moves 145 mm vertically when it steps up a kerb.

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
