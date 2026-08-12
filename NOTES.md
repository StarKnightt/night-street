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

## The transcribed constant — three instances this session, and the rule that came out of it

A variant of the shape above, with a different failure mode: not a copy that
drifted, but a copy that *cannot* drift until the day it does, silently, while
still reading correct and still typechecking.

Three found in one session. `scene/collide.ts` held a furniture table hand-copied
from `world/cars.ts`. `world/signs.ts` held a trade word list copied from the
generator that names the shops. And `scene/clouds.ts` transcribed the sun three
separate times — the key light as `(115.0, 37.17, 8.76)`, the path amplification
as `Math.sin(4.2 * Math.PI / 180)`, and a per-deck transmittance triple worked
out by hand for 4.2 degrees — directly under a comment claiming "the clouds
cannot end up lit by a different sun from the street". Nothing enforced that.
It held because two numbers happened to agree. Raising the street's sun to 12
degrees would have left the sky lighting its clouds from 4.2, and all three
transcriptions would still have looked right in review.

What makes this class expensive is that the duplicate is *derived*, so it looks
like a computed value rather than a copy, and the arithmetic is usually trivial
enough that computing it feels like ceremony. `sin(4.2°) = 0.07324` is correct
arithmetic. It is still a hand-copy of a constant that lives somewhere else.

The rule:

- **A value derived from another constant is computed, however trivial the
  arithmetic.** `Math.sin(SUN_ELEV)`, not `0.07324`. If the derivation is
  physical, write the model — `scene/clouds.ts` now runs Kasten-Young and an
  exponential atmosphere to get its per-deck transmittances, which is more code
  than the table it replaced and is the only version that survives the sun
  moving.
- **A constant that must reach GLSL as a compile-time literal is generated into
  the source, not typed into it.** `${PATH_MUL.toFixed(4)}` inside the template
  string. A number typed into a shader string is invisible to every tool that
  would otherwise catch this, including `tsc` and grep for the symbol.
- **If it cannot be imported, say so where it is duplicated.** `Street.tsx` still
  spells `#ff9a4e` and `115` into JSX; `scene/sun.ts` carries a note naming it,
  because a documented duplicate is findable and an undocumented one is not.
- **Prove the coupling by moving the source.** Changing `SUN_ELEV` and confirming
  the cloud self-shadowing and beam colour move with it is a two-minute check
  that distinguishes a real dependency from a comment claiming one.

## `Walker` stopped translating in one frame when forward input went to zero — fixed

Fixed at 05:25 on delivery day, in the take that ships. The diagnosis below
stands as written; what follows it is the fix and why it was safe to make with
three hours left.

The fix is four lines: remember the unit heading of the last commanded move and
keep applying it while `speed` decays.

```
if (len > 1e-4) { vx /= len; vz /= len; this.headX = vx; this.headZ = vz; }
else            { vx = this.headX; vz = this.headZ; }
```

The reason it could be made this late is that it is *provably inert for
everything already captured*. Every take to date holds `KeyW` for its whole
duration, so `len` is above the epsilon on every frame and the new branch is
never entered. That is not an argument, it is checkable: `node tools/reel.mjs
--dry --shot walkG` before and after the change returns the same x range, the
same end z of -75.3, and the same closest approach of 0.854 m to van F at the
same frame 700. A change that cannot alter the numbers on the existing route is
a change that cannot invalidate the existing take.

Measured afterwards, at 30 Hz: `speed` runs 1.400, 0.480, 0.165, 0.057, 0.019,
0.007, 0.002, 0 over about 0.6 s, the walk coasts 109 mm, and eye height goes
from bobbing to *exactly* still — 0.000 mm of range and 0.00 mm of translation
across the final 1.5 s. Nothing about the stop is animated: the gait is anchored
to pace, so a decaying pace shortens the stride and slows the cadence with the
foot slide unchanged, and the last footfall lands where a last footfall would.

Worth filing next to the `ConvolverNode` note above, because it is the same
shape of bug. Deceleration was fully and carefully modelled — the asymmetric
7-up/9-down smoothing, the bob scaling, the cadence term — and then multiplied
by zero one line later by a direction vector taken straight from the input. As
with the convolver, every part measured correct in isolation; it was the
assembly that discarded the work. The tell is the same too: the symptom appears
only in a state nothing had exercised yet.

### The original diagnosis

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

## Whole-frame luminance is the wrong instrument for "does it end in the light"

The third instrument mistake of the night, and the same shape as the other two:
a measurement that was correct about the thing it measured and was not
measuring the thing being claimed.

`walkH` was accepted on a whole-frame p90 that opened 154 and closed 160, and
that number is real. The camera was nonetheless standing in shade. Only 11% of
the top-decile pixels in its last frame were in the bottom third; the p90 was
carried almost entirely by a sunlit wall in the upper left, while the road under
the camera measured L 25 to 43 — about three counts off the sensor pedestal.
"Ends in the light" is a claim about the ground you are standing on, and a
statistic over the whole frame cannot distinguish that from a lit wall across
the street.

`expose --ground` crops to the bottom third before counting. On the same file it
reads p50 89 at the opening and 65 at the ending, which says plainly what the
p90 hid: the walk finishes on darker ground than it starts on. On `walkJ` it
reads 75 and 74.

The general lesson, and it is now three for three tonight — the convolver that
threw before the graph existed, the deceleration that was modelled and then
multiplied by zero, and this — is that the failures which survive verification
are the ones where the instrument and the claim are subtly different objects.
Numeric checking of the parts does not catch them. What catches them is asking
what physical thing the number is supposed to stand for, and then measuring
that thing directly.

Corollary worth keeping: `sunsweep` in `tools/shots.mjs` walks the far block at
a fixed heading so ground luminance can be read against position. It cost one
70-second capture and turned "somewhere past the shade line" into a five-metre
plateau at z -75..-79 with numbers on it. Sweeping is cheaper than arguing.

## Where an ending can go on this street, and why it is not the BAR sign

Recorded because it is a property of the block rather than of one route, and
the next person to compose an ending will otherwise rediscover it the slow way.

Two things want to be in the last frame: the sun, and something to look at. The
sun bands on the carriageway are z -49..-32 and z -84..-73. The only object on
the street that will hold a two-second look is the BAR / COLD BEER blade at
(5.16, -65.26), and a projecting blade has to be seen from up the road, which
puts a sane camera position around 10 m short of it, near z -55.

z -55 is in the shaded middle, and it is not close to either band. Everywhere
the sign frames well is in shade, and everywhere in the light has already walked
past it — by the time the camera is inside the second band the blade is 9 to
14 m behind its shoulder. There is no rest point that has both. `walkF` chose
the sign and ends dark; `walkH` chooses the light and ends on frontage.

The east kerb compounds it. From z -64 to -78 it is continuously parked —
hatches at -70.0 and -76.3 and the van behind them — so any rest point in the
lit stretch has a car within a couple of metres on the right. The hatch at -76.3
is the one car in the scene with direct sun on it, which sounds like the answer
and is not: the flank facing a camera coming down the street is its *shaded*
side, so at rest it reads as a dark mass across the bottom right rather than as
a sunlit car. Two still seconds pointed at the asset with the see-through wheel
arch and the two-cuboid mirror is the worst use of a held beat available.

The heading is what solves it, not the position. `restlook` in `tools/shots.mjs`
parks the walker on the rest point and holds three headings for six seconds
each; a quarter radian west puts that car's near corner outside the half-width
and fills the frame with sunlit stucco, shopfront glazing and eight metres of
paving. Cost: p99 falls from 194 to 183, because the small very bright disc of
haze at the end of the street leaves frame. Gain: p50 rises 68 to 70, p90 rises
154 to 160, and the frame has near-field detail in it. A held frame should be
judged on what is *in* it, and p99 over a 2-megapixel frame is 20,000 pixels.

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
- ~~**The footway furniture is still copied.**~~ Fixed by the density pass.
  `world/placement.ts` is now the single table: `LEGACY` holds the six original
  positions that used to be literal arguments in `buildStreetLevel` and literal
  records in `scene/collide.ts`, `props()` generates the new kit, and
  `propSolids()` derives the colliders from the same records the geometry is
  built from. Three consumers, one table. Nothing about a prop's position can
  now be changed in one place and not the other.
- **`collide.ts` cannot import anything that reaches `world/street3.ts`.** That
  file declares a `const enum`, which Node's strip-only TypeScript refuses, so
  anything downstream of it is unloadable by every tool in `tools/`. It is the
  reason the placement table is its own module rather than an export from
  System 3, and it is why `world/emit.ts` no longer uses a constructor
  parameter property — that is the other piece of TypeScript syntax with a
  runtime effect, and it was breaking `route.mjs` and `collide.mjs` the moment
  the collider started reading the shared table.
- **`tools/collide.mjs corner` now fails its two shallow wall-slide cases, and
  the failure is the test's premise rather than the solver.** It walks from
  (-5.0, -20) along the building line for ten seconds and asserts the
  tangential speed survives, which was true when the wall lane was thirteen
  clear metres. It is not any more: at z -29.4 there is a service cabinet
  against the frontage and the walker stops on it. `tools/wallslide.mjs` prints
  the rest point and shows that steering 0.9 rad off the wall frees it
  immediately, so the body is stopped and not wedged. Penetration everywhere on
  the street is 0.09 mm, which is the pre-existing dumpster figure. Do not
  "fix" this by thinning the props; either move the test to a clear stretch or
  have it assert recovery rather than uninterrupted speed.
- **A gap between two solids is either shut or walkable, never 300 mm.**
  `placement.ts` refuses any placement that would leave a neighbour gap between
  touching and one body width plus 60 mm. Without it the eight-sweep
  depenetration in `collide.ts` has nothing to converge on — the walker gets
  squeezed into a slot where every position is inside something — and
  `collide.mjs approach` measured 4.22 mm of resting penetration as soon as the
  density went up. The solver is not at fault and adding sweeps does not help.
- **The corridor is booked, not hoped for.** The same file reserves a 780 mm
  walkable lane per side per metre of z before it places anything. The first
  dense run put down 175 props, every one of them individually plausible, and
  `collide.mjs sweep` reported the near footway sealed at z -21.3 with a 0 mm
  lane. Two intermediate versions of the booking were also wrong in ways worth
  knowing: charging a prop against both footway edges instead of the nearer one
  refused every solid prop on the street — the count went to zero and the sweep
  went green, which is this codebase's signature failure wearing a new hat —
  and booking against the packing radius rather than the collider radius left
  the footway sealed at 160 mm, because sacks interleave with each other and a
  body does not interleave with anything.
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

**`scene/lights.ts` no longer does, and the table that stood here is
withdrawn.** It listed six emissives as landing twenty counts high; 442fbe5
re-authored all of them through `atDisplay` and deleted the fitted 0.325 patch
on `BOWL_WARMING`, and `lampFixtures.ts` now inverts each fixture's bowl at its
own point on the run-up. Nothing in that file is a transcribed radiance any
more. The section is kept, with the table gone, because "lights.ts is still
wrong" was quoted twice after it had been fixed.

A sweep of the rest of the tree, looking specifically for constants inverted
through the fit, is in "The curve sweep" below.

## The curve sweep — every remaining constant that could have come through the fit

Three constants had been found and fixed one at a time (`litWall`, the car
body's street probe, and every constant in `streetProbe`), which is enough
instances to stop treating them as incidents. This is the sweep for the rest.
It is mostly a negative result, which is the useful part: the fit's damage is
confined to two commits and one shader block, and the places that look most
like it — the sky, the bounce terms, the dust, the lamps — are clean.

### Confirmed and fixed

**The sunlit footway in the shopfront reflection**, `streetMaterials.ts`. Its
own comment gave the provenance away: "the sunlit flags in these frames measure
display 170 to 186, which is a scene radiance near seven". Seven is the fit
inverted at 183; the real transform puts the middle of that band at 1.95
neutral. The value was `(9.50, 6.80, 4.00)` and is now `(1.93, 1.38, 0.81)`,
the same target re-inverted at the same chromaticity — a factor of 4.9.

It is the same commit and the same paragraph as `litWall`: 5ffb90d ended "and
everything bright in this reflection is set by that inversion from here on".
442fbe5 corrected `litWall` and stopped, so the sentence stayed true of the
other three constants in the block.

What it looked like: the reflected footway band was pinned near white, which in
a pane at 0.17 Fresnel is the one place a reflection can still clip. Measured
on a deterministic pair through `tools/paneab.mjs`, the change is 56 counts
over the band and 0.3 per cent of the frame, all of it inside `y 657..684` on a
2.9 m shot of one store front — a hard white streak becomes a warm grey one.
Nothing else in the frame moves by more than the one-count floor.

### Correct, and worth recording as such

- **`shadeWall` and the shaded carriageway** in the same reflection block, which
  had no stated derivation and could easily have been assumed guilty by
  association. Measured against the surfaces they depict they are within 25 per
  cent, and the fit would have put them four to five times high at those
  levels. They were not inverted through anything; they were simply set, and
  set about right.
- **`scene/lights.ts` and `lampFixtures.ts`**, entirely. Every level is
  `atDisplay(target, chroma)`.
- **`LIT_ROOM` and `TV_COLOUR`** in `buildingMaterials.ts` are built by
  `forDisplay`, so the inversion is right. The *bracket* that chose the target
  is still in the fit's display space — see the note now in that file.
- **`dust.tsx`**'s mote level, which was re-derived through `agx.mjs` when the
  linear target landed and says so.
- **The sky in `env.ts`.** It is not derived from a display value at all; it is
  the thing the transform was validated against.
- **The cross-canyon bounce** `vec3(0.190, 0.104, 0.043)`, shared by
  `MASONRY_END`, `streetEnd` and the prop kit. It came out of `shadesplit.mjs`'s
  radiance decomposition, not out of an inverted display value, and it is an
  irradiance rather than a radiance.

### Reported, not applied

- **`litWall` is still 1.5x above its own stated target.** 442fbe5 scaled the
  old triple by the *neutral* ratio at display 191, 2.50/8.44, rather than
  re-inverting at the wall's chromaticity; the old triple was itself 1.54x above
  what the fit gave for 191, and the rescale preserved that. It arrives at 205
  where the comment says 191. Against the surface it depicts it is worse: the
  sunlit frontage measures L = (0.96, 0.47, 0.30) with the haze off, so the
  reflection is 4x its subject. Left alone because the current look is signed
  off and because the 170-186 and 191 targets were both read off hazed, graded
  frames while the measurement is of the bare surface — the shader adds its own
  aerial perspective further down, so strictly both constants should be the
  bare-surface radiance and both are above it.
- **`winC` (3.60, 2.40, 1.25) and `glassC` (2.60, 1.75, 1.05)**, the lit windows
  and the glazing opposite in the same block. Same commit, same sentence, no
  stated target, so there is nothing to re-invert against — but they arrive at
  202 and 190, which is to say a window across the road is being painted as
  bright as a sunlit stucco wall, and the glazing is nominally a sixth of the
  wall it mirrors. Both want a derivation rather than a correction.
- **`LAMP_CD_FULL = 78` rests on a stale anchor**, and this is a different bug
  class worth naming because the sweep found it. Its derivation is scale-free by
  design — the lantern against the skylight it has to beat — and the skylight
  comes from "shaded carriageway, radiance L = 0.038 (NOTES, measured)". That
  was measured with the sun at 4.2 degrees. Since 0384f31 the sun is at 12 and
  the shaded carriageway measures 0.125, so the skylight irradiance in that
  derivation is 3.3x low and the ratio the lamps were set to hit, 1.5, is being
  delivered at about 0.45. Raising the lamps threefold is not a change to make
  on the strength of a sweep; it is a lighting decision.

### The instrument that had to be fixed first

`tools/shadesplit.mjs` set `NoToneMapping` and then set an exposure "so that
sunlit paving does not clip", and three compiles the exposure out:
`WebGLProgram.js:771` omits `#define TONE_MAPPING` and the tone mapping function
entirely when the mode is None, so `toneMappingExposure` is never read. The knob
is inert. The tool then divided by it, so every absolute radiance it printed was
16.7x high — its "street, sunlit 8.43" is a surface at about 0.51, and those
inflated figures were quoted in `propMaterials.ts`'s header. Its percentages and
ratios are unaffected, which is why nobody noticed and why the conclusions drawn
from it stand.

**Fixed.** It now uses `LinearToneMapping`, removes the pedestal, and proves the
exposure is live by halving it and requiring the same 228k mid-tone pixels to
halve — measured 0.5001. Run it with `--tonemap 0` and the check fails at
1.0000, which is the old configuration and is also where 39 per cent of the
frame turns out to have been clipped to white. A check nobody has watched fail
is not known to be a check.

Nothing was derived from the inflated numbers. Every use of that tool in the tree
is an argument about a ratio — 29ebdbd's diagnosis of the prop kit is made out of
percentages, blue-to-red numbers and pixel counts — and the one constant that
looked like it might have come from the tool, the cross-canyon bounce, predates
it by a day and a commit (`git log -S` puts it in bea2726). The audit's own
verdict on the bounce cited shadesplit and was wrong to: the "everything else"
column is the frame with the sun and the environment both off, which is the
lamps and every emissive surface as well as the bounce, so it cannot isolate the
term. `tools/bounce.mjs` re-derives it from geometry instead — measured sunlit
frontage radiance, street width, shade line and wall top by raycast, against the
infinitely-long-strip form factor — and the coefficient comes out at 0.3 to 0.9
of what the geometry supports, with a hue about twice as blue as the source. Too
small rather than too large, which is the opposite of what the withdrawn display
fit leaves behind. Verdict stands, on different grounds.

`tools/reflsurf.mjs` uses `LinearToneMapping` instead, which is
`saturate(exposure * colour)` and is live, and asserts it by halving the
exposure and requiring the same pixels to halve. It also removes `sensor.ts`'s
pedestal before reporting, which `shadesplit` does not, and which in the
shadows is most of what is there.

## A value that is only ever a divisor, and was eleven times wrong

`volumetric.ts` read the sun's irradiance back off the light with
`light.color.clone().convertSRGBToLinear().multiplyScalar(intensity)`. three's
`ColorManagement` is on by default and decodes on assignment, so `light.color`
is *already* working-space by the time anyone reads it: `Street.tsx` writes
`#ff9a4e` and the object holds `(1.000, 0.325, 0.076)`, not `(1.000, 0.604,
0.306)`. Decoding a second time gave `(1.000, 0.089, 0.007)` and an irradiance
of `(115, 10.2, 0.78)` against a true `(115, 37.4, 8.8)`.

**The frame did not change.** That value is never displayed and never added to
anything — it is only ever a *divisor*, used to turn a measured airlight into an
albedo. So the error left every pixel it touched plausible and moved only a
ratio: the air came out `(0.029, 0.144, 0.541)` instead of `(0.029, 0.038,
0.048)`, eleven times too blue, and the lamp cones it scaled were faint enough
that nobody would have called the hue wrong.

The general shape, because this will happen again: **a quantity that only ever
appears in a denominator cannot be checked by looking at the picture.** Nothing
about a wrong divisor is visible on its own; it shows up as a plausible result
of the wrong magnitude somewhere downstream. The only thing that caught it was
printing the derived value next to the value it was predicted to have —
`tools/atmo.mjs` prints the albedo, and `(0.029, 0.144, 0.541)` against a
predicted `(0.030, 0.038, 0.048)` is not a subtle discrepancy once it is on the
screen next to its own prediction. Derive the expected number by hand once, put
it in the tool, and print both.

A related trap in the same family: `three` will happily hand back a colour in
whichever space it is currently managing, and the API does not say which. If a
colour is being read *out* of a three object rather than written into one,
assume it is already linear and prove otherwise.

## "The march wrote nothing" and "the readback is wrong" look identical

`gl.readRenderTargetPixels` matches the readback buffer to the *texture type*.
The volumetric and bloom targets are `HalfFloatType`, and reading one into a
`Float32Array` returns four zeroes per texel — no exception, no warning, no
GL error. A debug probe built to answer "is this pass producing anything"
answered "no" for every texel of a pass that was working correctly, and it cost
an hour to tell the two apart, because zero is exactly what a broken pass looks
like.

Use a `Uint16Array` for a half-float target and decode manually; there is a
seven-line decoder in `grade.tsx`'s `__vol.probe`. More generally, **the first
thing to verify about a new instrument is that it can report a non-zero**, and
the cheapest way is to point it at something already known to be non-zero
before pointing it at the thing under test.

## Mislabelled sampling regions have now cost three separate conclusions

Same session, three times, all in `tools/atmo.mjs`:

- A region named `sky` was geometry at 79.6 m. Its `-9.4` counts were read as a
  sky artifact and chased as a bug; it was correct aerial perspective.
- A dust probe sampled `y = 0.34..0.56`, which at that pitch is above the
  horizon, while the motes live 0.25 to 2.6 m above the carriageway. It
  reported a view-dependence ratio of `-1.3:1` on a region containing no dust.
- A gain sweep sampled rows in the upper frame, where the term being swept is
  zero by construction, and reported that the gain did nothing — which was true
  of those rows and false of the frame.

The fix that worked is cheap and worth doing by default: **have the probe report
what it is looking at, not just what it measured.** Since `__vol.probe` started
returning the depth the march reached alongside every value, a region that is
not what its name says announces itself immediately. A statistic with no
provenance attached is a statistic about an unknown place.
