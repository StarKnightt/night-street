# night-street

A first-person walkable city street at golden hour, in a browser.

![Looking down the street from the gap station: parked cars, fire escapes, the
sun behind the far end of the block](media/01-street.webp)

*Straight out of the running build at one of the six fixed capture stations,
via `npm run shoot`. Nothing in it is composited, nothing is retouched, and
every pixel of it — the brick, the asphalt, the sky, the cloud — was computed
in the GPU a few seconds before the shutter.*

**[Walk it here](https://night-street.vercel.app)** — desktop, keyboard and
mouse.

**Read the prompts it was built from: [PROMPTS.md](PROMPTS.md).** Five of them,
verbatim and unedited, including the one at hour five that changed the time of
day and therefore most of the project.

**It takes between thirty and forty seconds to start, and the page will not
respond while it works.** That is not a download and it is not broken. The
entire page is about half a megabyte of JavaScript and the network is finished
in well under a second; everything after that is the street being manufactured
in your GPU, and almost all of it is the driver compiling shader programs. A
card explaining this is painted before the scene module is even fetched, so it
is up essentially straight away, and its progress bar keeps moving because it is
a CSS animation running on the compositor rather than anything driven by the
blocked main thread. Two measurements against the
deployed build today, on an RTX 4060, put the first frame at 34.9 s and 39.4 s.
There is a full accounting further down, including the part of it that is still
unresolved.

Every texture, every mesh, every light and every sound in this scene is
generated in code. There are no image files in this repository, no models, no
HDRIs, no audio files, and nothing is fetched at runtime. The asphalt is a GLSL
surface description baked into a PBR texture set in your GPU while you wait. The
buildings are emitted as indexed triangle soup from a massing solver. The sky is
an analytic dome with three procedural cloud decks, baked once into a cube that
serves as both the background and the image based lighting. The traffic, the
tyre noise on the wet gutter and the reverberation of the canyon are a Web Audio
graph rendered offline. Nothing was authored in Blender, Substance or Photoshop,
because nothing was authored anywhere except in a text editor.

## Why that constraint is interesting

Procedural generation is normally sold on file size, and that is the least
interesting thing about it. What the zero-asset rule actually does is make the
project *answerable*. A downloaded asphalt texture is a fact you cannot argue
with: it looks how it looks, and if the road reads wrong you can only replace it.
A procedural one has parameters, and every parameter has to be justified against
something — a real measurement, a photometric target, a number inverted through
the tone curve. You cannot hide a decision inside a file.

The consequence is that this repository is much less a pile of art than a pile
of arguments, and most of them are written down where the code makes them. The
comment blocks are not documentation of what the code does. They are records of
what was tried, what it measured, and why it was reverted.

## Running it locally

```bash
npm install
npm run dev
```

Then open http://localhost:3000 and click the canvas to capture the pointer.

| control | does |
| --- | --- |
| `W` `A` `S` `D` | walk, at 1.4 m/s |
| mouse | look, once the pointer is locked by a click |
| `Shift` | sprint, at 3.1 m/s |
| `Esc` | release the pointer |

There is no jump. The pace is deliberate, because the scene is meant to be
looked at — and the sprint exists mainly as a test instrument. Stride length,
cadence and head-bob amplitude all scale together with speed, so a gait term
derived wrongly from the others is obvious at 3.1 m/s and nearly invisible at
1.4.

For a production build, `npm run build` then `npm start`.

![Shopfronts down the sunlit side: florist, TO LET, the awnings and the
fire escapes](media/02-shopfronts.webp)

## The thirty to forty seconds

This is the one place where the project's central claim charges the visitor
directly, so it is worth being precise about.

The two measurements of the deployed site taken today are 34.9 s and 39.4 s to
the first frame, on an RTX 4060 through ANGLE on D3D11, with a cold browser
profile and therefore a cold shader cache. Both come from `tmp/prodverify2.mjs`,
which drives the real hosted page the way a visitor does and watches for the
veil text to disappear; it polls twice a second and requires four consecutive
clear polls, so the figure it reports overshoots the true first frame by up to
about two seconds. A reload is much faster, because Chrome's on-disk shader
cache is then warm — but the visitor this matters for is arriving from a link,
and for them it is always the cold case.

The work is not the bakes. All seven procedural surfaces together — asphalt,
concrete, granite, gully, manhole, tread, cast iron, three passes each — cost
244 ms of GPU time, measured by blocking on a one-pixel readback after each
draw. Every `drawElements` the page issues during the entire load, including
those bakes and the first several frames, adds up to about a quarter of a
second. Halving every bake resolution would save roughly 120 ms of a load that
is thirty-five seconds long. The cloud cube is 3.4 ms for six 1536-pixel faces.
The geometry — every building, every prop, every car, emitted and merged on the
CPU — is about half a second.

What is left is the driver turning this scene's shaders into D3D bytecode, and
it is over 95 per cent of the load. The scene's largest material programs are
five to eight times the size of a stock `MeshStandardMaterial`, and the road
alone has historically accounted for around 40 per cent of the compile budget.
Throttling the CPU four times over does not move the load, which was originally
read as the work being GPU execution; it is not, it is that ANGLE's HLSL
translation happens in Chrome's GPU process, which the throttle does not touch.

**One thing here is genuinely unsettled and is not presented as settled.**
[`docs/COLDSTART.md`](docs/COLDSTART.md) contains two independent measurements
of where the compile time lands that cannot both be right, and its author
flagged the contradiction rather than tidying it away. One attributes the cost
to 47 scene material programs; the other counts 69 of 76 programs as surface
bakes and PMREM helpers, which would point optimisation at almost exactly the
wrong place. Both were honest observations, and the likeliest reconciliation —
that with `KHR_parallel_shader_compile` present the cost surfaces at whichever
call first forces a synchronisation, so no single call site is "the cause" — is
consistent with the ablation in that document but does not explain the
disagreement about the program mix, which is a straight counting question. It
has not been counted. Read the document for the analysis; do not quote its
attribution table as fact.

One large win predicted there has been applied and measured: the environment map
and the fog used to be attached in a React effect, one frame after r3f had
already drawn, so every material in the street was compiled once without them
and again with them. Moving the assignment ahead of the first render took the
program count from 99 to 76 and recovered 11 to 13 seconds, with the frame
byte-identical to within the animated dust. The next two candidates —
`compileAsync` off the blocking path, and staged mounting so the first
interactive frame needs a handful of programs instead of forty-seven — are
written up and have not been done.

## What is measured

Numbers here are measurements, and the tool that produced each one is named so
it can be re-run. Where a figure could not be reproduced today it says so.

**Performance.** Free-running, the frame is vsync-capped at 60 fps. Timed
against a one-pixel readback at three stations, 1600 × 900 on an RTX 4060, the
frame costs 12.9 to 13.6 ms; the same tool recorded 10.4 to 11.3 ms at the same
commit earlier in the evening, and the difference is very likely other work
sharing this machine rather than the scene. Take the honest reading to be
somewhere in ten to fourteen milliseconds, with two to three milliseconds of
run-to-run spread on a contended box. `tools/framecost.mjs`.

**Scene cost.** 69 draw calls and 1,034,000 triangles, identical across both
runs. The draw call count is the number that matters: the buildings are a
handful of merged meshes, the street level another, all nine cars are four
merged buffers between them, and all 2,200 dust motes are one call.

**The cars.** 114,466 triangles over nine vehicles, 12,718 each, in four draw
calls — body, glass, wheels and the ground-contact decal. `tools/carcount.mjs`
loads `world/cars.ts` and `scene/collide.ts` for real rather than a copy of
either, and checks that no part of any car pokes out of the box the walker
collides with. It does not.

**The street furniture.** 139 props placed, 56 of them presenting a collider,
16,626 triangles for the whole kit; 99 solids in the collision table.
`tools/propcount.mjs`. Twenty-one shopfronts are dealt a trade each from a deck
of thirty-two, with three held out to appear exactly once, and
`tools/signcount.mjs` exits non-zero if the street ever advertises the same bar
twice.

**Collision.** Worst-case penetration of 0.09 mm, into the dumpster, across
every solid on the street approached from sixteen headings at both paces. Every
other solid on the street ends its worst frame outside the body by a hundredth
of a millimetre. `scene/collide.ts` is the table the page itself collides with,
and `tools/route.mjs` traces candidate walks against that same table rather than
against a copy of it.

**Kerbs.** The 145 mm kerb reveal arrives at the eye as a 127.8 mm step at
walking pace and 99.9 mm at a sprint — the ground filter trails the surface
mid-climb and catches up — rising over 222 ms, overshooting by 0.1 mm and
settled to within a millimetre in 307 ms. Walking the camber and the castings,
the filter trails the surface by at most 1.79 mm. `node tools/collide.mjs`.

**Gait.** Zero measurable foot slide at either pace: 0.700 m of stride measured
against 0.700 m modelled, over 58 footfalls. `tools/gait.mjs` runs the gait model
on the CPU with no browser and no GPU; `tools/motion.mjs` checks the delivered
capture against it. The speeds read 1.40 m/s walking and 3.10 m/s sprinting off
the walker's own position over three-second intervals. These figures are from an
earlier pass and were not re-run for this document.

**Dust.** The motes are real objects with parallax rather than a noise overlay,
which is a claim worth testing because the cheap version looks similar in a
still. Frame-to-frame persistence of a mote is 5.05 px, against 76.5 px for a
randomised control. Also from an earlier pass, not re-run.

**Audio.** Synthesised from oscillators, filtered noise and a generated impulse
response, and recorded by a second real-time pass over the same route rather than
during the capture, because the capture advances the clock by hand and Web Audio
cannot be. Both passes integrate against real `dt`, so they agree:
`tools/audiotake.mjs` checks its own footfalls against the picture's and refuses
the take if they drift past 60 ms.

![The lot station, looking down the shaded side toward the sun](media/03-lot.webp)

## What is not good enough yet

An honest list, because the alternative is that you find these yourself and
wonder what else is being oversold.

**The cold start is the worst thing about the hosted version**, and it is the
direct cost of generating everything at load. It could be improved — handing
every program to the driver at once instead of compiling them one at a time as
the renderer trips over them, staging the scene so the first walkable frame
needs a fraction of the programs, caching into IndexedDB after a first visit —
and none of that has been done.

**There are no touch controls at all.** Movement is read off keyboard events and
looking requires a locked pointer, so the scene is not drivable on a phone in any
sense. The hosted build detects this and says so rather than handing over a
street you cannot walk down, but that is a sign on a locked door, not a fix.

**The road's hue and saturation are still off.** The carriageway sits at about
three degrees red with a saturation of 0.23 where real asphalt measures 0.05 to
0.12. The colour grade takes the sunlit carriageway from 0.263 to 0.227, and that
is as far as a grade can go without desaturating the sunlight itself, which is
the look. The residual is in the albedo. One dead end is recorded so that it is
not retried: tinting the inter-chip cavities toward zenith blue made the
saturation *worse*, because the chip scatter is sparse and leaves too few
cavities to act on.

**The road centreline is over-worn** and reads as a crack rather than as paint.

**The street is now dense enough to be tight in places.** With 139 props on the
footways, `collide.mjs`'s sweep reports the narrowest passable lane on the near
footway at 320 mm, at z −19.8, and 13.4 per cent of the block out of bounds. The
placement table books a walkable lane per side before it places anything, and
the sweep says the delivered lane is narrower than the booking in at least one
place; that is a discrepancy nobody has chased. Two of `collide.mjs`'s
wall-slide cases fail for a related reason, and the failure is the test's
premise rather than the solver: it walks the building line asserting the
tangential speed survives, and there is now a service cabinet in the way.
`tools/wallslide.mjs` shows the body is stopped rather than wedged and that
steering off the wall frees it immediately.

**Distance does not hold up as well as the near field.** Window contrast on the
far backdrop blocks is only four to eight luminance units, too ghostly to read as
windows; several mid-distance rooflines are flat, with no parapet or clutter; and
the wall that terminates the street is carried entirely by haze, so it has
nothing on it if the haze ever thins.

**Some comments in the tree still describe a 4.2 degree sun.** The sun was
raised to 12 degrees and the constants all moved with it, but prose does not
typecheck: `scene/clouds.ts` and `world/signage.ts` each still open with a
paragraph reasoning from the old elevation. The numbers those files use are
computed from `scene/sun.ts` and are correct.

**One tool is known to be wrong and has not been fixed.**
`tools/obstacles.mjs` is a hand-copy of `world/cars.ts` that drifted — it is one
car short and has the dumpster's half-extents transposed — so the fast route
check clears walks that are not clear. `tools/route.mjs` exists because of it and
traces against `scene/collide.ts` directly; `node tools/collide.mjs` reports the
disagreements every time it runs, and currently reports two.

**Three constants in the shopfront reflection are two to three times the
surfaces they depict**, measured, and are deliberately not corrected: one of the
set is not visible from any camera that can measure it, correcting a subset is
worse than correcting none, and the whole change dims the reflected world
threefold, which is a look decision rather than a bug fix.

## The class of bug that cost this project most

This is the part worth reading if you read nothing else, and it is written up at
greater length at the top of [`NOTES.md`](NOTES.md). There are three distinct
shapes, and every one of them has now recurred at least three times.

### Verifying the parts and shipping the assembly

A system is verified by measuring the things it *makes*, and the thing that is
broken is the way those things are *wired together* — which the measurement
cannot see, and which is usually reporting itself loudly somewhere nobody is
reading.

**The entire audio system was silent on every machine, in every capture, from
the day it was written.** `tools/audio.mjs` checks the generators, and every one
of them was producing correct samples. What it could not check was `build()`.
`ConvolverNode` is the one node in a Web Audio graph that refuses to resample —
it throws outright if the buffer's rate differs from the context's — and the
impulse response was rendered at 24 kHz into a context that comes up at 48. The
throw happened before the bed, the spot sources and the footsteps were
constructed, so nothing downstream of that line ever existed. The fix is one
expression, `ctx.sampleRate`. The error was in the page console the whole time,
and the capture harness writes it into `reel.json` under `errors`, where it sat
through several reviews.

**A field of dust motes sat 32 m behind the camera in every capture ever
reviewed**, while the interactive walk looked correct, because the field was
positioned from a uniform written in `useFrame` and a capture teleports and
renders inside one synchronous evaluation.

**The sun's shadow box had the same bug and it was found this week.**
`Street.tsx` moves the box from a `useFrame` too, so in a still capture it stays
wherever the last animation frame left it — measured 31 m up the street from the
camera. Anything outside a shadow frustum is reported *lit*, so those stills had
no cast shadows on the visible street at all and the volumetric sun-shaft term
integrated to exactly zero. `scene/sunFollow.ts` fixes it from
`scene.onBeforeRender`, which is the last hook before the depth pass and the
only one late enough to still move the box. It is worth reading for what it does
beyond the fix: it *learns* the arrangement by subtracting the camera position
from wherever `Street.tsx` just put the light, so it transcribes none of the
four constants involved, and it records the drift it is about to correct, which
is exactly the error the pre-fix build shipped on that frame. Any tool running
normally can now report whether its own render idiom was ever affected. It turns
out the screenshot archive never was, because `shoot.mjs` waits 200 ms and an
animation frame lands in the gap — and no amount of reading the source would
have told you that.

The defence is cheap and it is now a rule here: **make the check load the real
assembly.** That is why `tools/route.mjs` imports `scene/collide.ts` instead of a
copy, why `tools/propcount.mjs` loads `world/placement.ts` and `world/props.ts`
rather than a table typed out of them, and why `tools/audiotake.mjs` records the
master bus through a `MediaStreamDestination` instead of summing the generators
itself. The second rule is to read what the assembly says about itself: a
non-empty `errors` array is a finding, not noise.

### The transcribed constant

A variant with a different failure mode: not a copy that drifted, but a copy
that *cannot* drift until the day it does, silently, while still reading correct
and still typechecking.

`scene/clouds.ts` held the sun three separate times — the beam colour as a
literal triple, the path amplification as `Math.sin(4.2 * Math.PI / 180)`, and a
per-deck transmittance table worked out by hand for 4.2 degrees — directly under
a comment claiming that the clouds could not end up lit by a different sun from
the street. Nothing enforced that. It held because two numbers happened to agree,
and raising the sun to 12 degrees would have left the sky lighting its clouds
from the old elevation with every one of those literals still reading correct.
The same week, the shadow frustum was described in two files and *generated into
GLSL as compile-time literals* by one of them, where `tsc` cannot see it and
grep for the symbol will not find it; a disagreement there does not produce a
wrong-looking frustum, it produces a penumbra of the wrong width in a build that
still renders a plausible shadow.

What makes this class expensive is that the duplicate is *derived*, so it looks
like a computed value rather than a copy, and the arithmetic is trivial enough
that computing it feels like ceremony. `sin(4.2°) = 0.07324` is correct
arithmetic and is still a hand-copy of a constant that lives somewhere else. The
rules that came out of it: a value derived from another constant is computed,
however trivial; a constant that must reach GLSL as a literal is generated into
the source rather than typed into it; if it genuinely cannot be imported, the
duplication is documented where it occurs, because a documented duplicate is
findable; and the coupling is proved by moving the source and watching the
dependent move with it. `scene/sun.ts` and `scene/sunShadow.ts` are the result,
and both are worth reading — the first also explains why it has to be a leaf
module with no imports at all, which is a module-cycle argument rather than an
aesthetic one.

### An absent term reads as exactly 1.000, and that is the tell

Code that looks correct and never runs. Four failures in one day had this shape,
and it is the cheapest bug in the codebase to find once you are looking for it
and one of the most expensive to find by reading.

**Run the control in the same session and divide.** A term that is working
returns a ratio like 1.4 or 0.6. A term that is not there returns 1.000, to as
many decimal places as the buffer holds, and the exactness is the signal. That is
what found the cars' contact-shadow decal: its geometry was built, its
attributes were right, its material compiled, and the road under the cars was
bit-identical with it enabled and disabled, because the quads were wound the
wrong way and were being back-face culled. No amount of reading the shader would
have found it, because the shader was correct. The same method found a
volumetric sun-shaft term integrating to zero and an exposure knob that three
compiles out entirely when tone mapping is set to `None` — a tool had been
dividing by that inert knob and reporting every absolute radiance 16.7 times
high.

Toggle at runtime rather than by editing a constant and rebuilding, because two
runs differ by more than the term — this project dithers. Never take a ratio
from an averaged sample. And note that *where* a scale is applied decides what
it scales: on `iblIrradiance` it misses the probe, on `reflectedLight` it misses
clearcoat, and only at `opaque_fragment` is there a single number that is the
whole of what the pixel will be.

### You cannot judge a linear quantity by looking at a display-space image

Five separate expensive bugs reduce to that one sentence, and it has its own
write-up in [`docs/TECHNIQUE.md`](docs/TECHNIQUE.md). The clearest illustration
is that the same street lamp is worth seven display counts on the shaded
carriageway and one on the sunlit carriageway, because AgX's slope is nowhere
near constant. Nobody authoring by eye against a tonemapped frame can be right
about both, and which way they err depends only on what they happened to be
looking at. Three agents made this error independently.

The remedy is to author every radiance by inverting a target display value
through the measured tone curve, which `tools/agx.mjs` does by porting AgX and
the sRGB encode out of `node_modules` and inverting them numerically. It agrees
with nine sky pixels, where the scene radiance is known in closed form, to a
mean absolute error of 0.0 counts.

There is a sting in the tail worth carrying. An earlier fitted approximation of
that curve, `display = 0.284 · L^0.4545`, has been **withdrawn** — it was fitted
through a single point measured through a sheet of glass, so what it actually
encoded was the pane's Fresnel reflectance. Constants that had been carefully
inverted through it were therefore wrong by a factor of four or five, in the
confident direction. Finding them all took a deliberate sweep of the tree, which
is written up in `NOTES.md`; the useful part of that sweep is mostly the
negative result, that the damage was confined to two commits and one shader
block. Two of the constants it identified are still not corrected, for reasons
given above.

And one more, because it is the cleanest lesson in the file: an earlier
prediction agreed with an independently derived number to within a count, and
was quoted as confirmation. Both of its inputs were wrong, in opposite
directions, and cancelled. **Agreement with an independently derived number is
strong evidence that the machinery is sound and no evidence at all that the
inputs are.**

![Facing the sun down the block, with the haze carrying the far
end](media/04-sunward.webp)

## How it is built

### The rendering

Next.js App Router with React Three Fiber, one client-side route, no server
component doing anything interesting. Three.js renders forward into a half-float
target, through an HDR post chain — volumetric, veiling-glare bloom, defocus,
grade, grain — with AgX tone mapping at an exposure of 0.296 rather than ACES:
the frame is lit by a narrow-band source near the horizon, and ACES turns a
saturated orange highlight yellow and then white as it rolls off, which is the
wrong answer for sodium. AgX holds the hue into the clip.

Shadows use `BasicShadowMap`, which is not a downgrade. It is the only type whose
uniform is a plain `sampler2D` rather than a hardware comparison sampler, and
reading the stored depth is what makes a blocker search possible. All of the
filtering is done in `scene/softShadow.ts`, which runs a 12-tap blocker search
and a 20-tap Vogel filter with a receiver-plane depth gradient solve. The
gradient solve exists because this scene has to shade surfaces nearly parallel
to their own key light.

### The sun

Twelve degrees of elevation, thirty-five degrees of azimuth off the street's
centreline, and both live in `scene/sun.ts` — a leaf module with no imports,
which is what makes it safe for every other file to agree with it. That file is
the best short read in the repository: it argues the elevation trade properly.
Shadow length is height over the tangent of elevation, so lower is better for
the signature effect of this hour, and at 12 degrees a 145 mm kerb still throws
a 68 cm shadow. But a horizontal surface collects `sin(elevation)` of the beam —
a tenth at 4.2 degrees, a fifth at 12 — and below some angle the direct sun on
the road falls under the skylight filling it from above, at which point shadows
stop being visible because there is nothing left for them to subtract. Raising
the sun reaches more wall rather than pushing harder on the wall it already
reaches, which was measured: pushing intensity instead only desaturates what is
already warm.

The sun was originally at 4.2 degrees and the street's massing was solved
against that, in `world/block.ts`, which decides how tall every building is in
order to leave two stretches of carriageway in direct sun. The gap widths in that
solver are derived from the sun's bearing and so followed it automatically; the
band extents quoted in its comments were derived at the old elevation and have
not been re-measured since the sun moved. Treat those particular z ranges as
historical.

The sun is drawn twice — once as a directional light, which has no image, and
once as a painted profile in the sky, which carries no energy into the shading.
That decomposition is correct, but for a long time the two halves disagreed about
how bright the sun is by three orders of magnitude: the painted disc had been
picked as "a couple of hundred times the horizon value", which made it the
ninety-fourth brightest thing in a photograph of the sun. Its peak is now derived
in `sun.ts` from the directional light's own irradiance and a stated fraction of
it, read by both skies. It ships capped at two per cent of the real flux, and the
reason is written down next to the derivation rather than left as taste: the full
value overflows toward `Inf` in a half-float bloom pyramid, AgX clips the disc
above about forty units anyway, and this bloom's point-spread function is much
flatter than a real lens's, so at full flux a fixed fraction of the frame's
energy spread through it is a white frame rather than a glare. It is a
deficiency of the kernel expressed honestly as a deficiency of the source.

### The shadow box is rolled along the street

A directional shadow map is a box aligned to the light, and three orients it
with world up, which puts its horizontal axis horizontal. That is a sensible
default and the wrong one for a street canyon lit along its length: at this
elevation and azimuth both axes of a level box pick up street length, both are
spent by walking, and the smaller one runs out first. `tools/shadowview.mjs`
projects ground points into the live shadow camera and found exactly that — from
a camera at z −49.9 the road ten metres ahead was still inside and everything
past it fell out of the *bottom* of the box, on a street the haze leaves
readable for eighty metres. Outside the frustum, three reports receivers as lit,
so the far half of the street had no cast shadows at all.

`scene/sunShadow.ts` rolls the box so one axis runs along the street. The
cross-section axis then has no z component whatsoever, so walking straight down
the street does not move the sampling lattice on that axis at all — in the same
probe, all seven ground points sit at the identical projected coordinate and only
one of them advances. The trade is stated in the quantity that matters, which is
texel density *on the ground* rather than on the frustum's own axes: one texel
covers 328 mm² of road before and 413 mm² after, and the finest axis on the
ground goes from 10.7 mm to 18.4 mm. That is about a quarter coarser by area,
bought for roughly eight times the length of street, and it does not reach the
picture — the sun's own half-degree already makes a penumbra wider than either
figure, and a bollard's shadow edge measures 15.41 px before against 15.01 after
on one side and 11.67 against 11.76 on the other. Both differences are under half
a pixel and one is the wrong sign for a texel argument, which is what it looks
like when the filter rather than the lattice is setting the width.

The map is 8192 × 4096, long axis along the street. Cascades are the textbook
answer and the file explains why they are not worth it here, including a hard
structural obstacle: the PCSS filter receives the frustum's extents as
compile-time literals, so a frustum that changes at runtime would put two
divisions per tap back into the shader.

### The sky the scene is actually lit by

The lighting probe and the visible background used to be baked separately, so
that the cloud pass could prove it had not moved the lighting. It had not, and
that was the defect: every surface in the scene was being lit by a cloudless,
ozone-free dome while a cloudy one was drawn behind it, and its intensity was
being held at half beneath a comment arguing at length against doing exactly
that. Shadow-side surfaces were on a quarter of their sky.

The probe is now convolved from a cube baked by the same shader as the
background, differing in one term — the solar disc is off, because the
directional light already carries it with hard shadows. Measured over six
stations, the carriageway and the shaded frontage came up by 1.2× to 3.3× by
tile, and the median code value of the frame went from 75 to 93 with nothing
clipping anywhere.

The clouds themselves are three horizontal decks — cirrus at 8 km, altocumulus
at 4.2 km, cumulus at 1.5 km — each a 2D coverage field read where the view ray
crosses its shell, so the perspective compression toward the horizon comes out of
the geometry rather than out of a gradient. Each is lit by a twelve-tap march
along the sun's horizontal direction through its own density, with multiple
scattering octaves weighted by the probability that light scattered at all;
ungated, those octaves gave a thin cirrus veil a cumulus turret's glow. The whole
thing costs 3.4 ms once at startup for six 1536-pixel faces and nothing per
frame.

### Veiling glare

The bloom's veil was reaching 6.4 degrees from the disc and stopping, because six
octaves of a tent filter have a support of two texels of the coarsest level. A
twenty-fold change in the sun's flux moved the frame beyond ten degrees by 0.00
code values — which is the 1.000 tell from the section above, in a slightly
different costume. Real veiling glare follows an inverse square of angle across
the whole frame. Nine octaves at unit weight *is* that law, and with them the far
field is live at every station and the first percentile lifts by 1.6 to 5.0
counts, which is what a lens does. Measured cost at the commit that landed it:
0.12 to 0.45 ms. Re-measured for this document on a busier machine the delta was
noisier than that, once even negative, so treat sub-millisecond veil costs as
being at the edge of what this instrument resolves.

### Lighting budget

One real `Light` object in the scene graph, and it casts the only shadow map.
This is not asceticism. A previous version had fourteen unshadowed spotlights
with a projected cookie, and disabling all of them changed the shaded frontage by
0.0 per cent and the carriageway by 0.10 per cent. They were removed anyway, and
the reason governs the whole design: fourteen lights and a cookie sit in every
material program in the street, and the texture-unit budget they forced is why
three paving materials were running without their baked occlusion maps.

The cost of a light in a forward renderer at this hour is not its radiance
contribution. It is a uniform count in every one of your draw calls, plus a
texture unit if it carries a cookie, plus a shadow map if it casts. Small sources
are therefore analytic: the street lamps, the neon, the car lamps and the lit
shop interiors are all evaluated in the receiving material from a uniform array,
at no draw call, no light slot and no texture unit.

The street lamps were re-levelled from 78 to 329 candela this week, and the
reason is a good illustration of a whole bug class. Their derivation was
scale-free by design — the lantern is set against the skylight it has to beat —
but the skylight in that ratio was a measured value from when the sun was at 4.2
degrees. The divisor had moved and nobody had noticed, because nothing about the
expression looked like a transcribed constant. Two further lessons came out of
re-levelling. A ratio between two lights on one surface needs no albedo, and
trying to measure one is what made this hard; differencing two builds at two
candela settings gives the answer directly, and this scene disagrees with itself
about the diffuse transfer by a factor of 2.2, which is written down rather than
papered over. And a downstream exaggeration calibrated against the old level does
not survive the new one: the volumetric cone gain had been set to thirty times
single scattering so that a weak lamp could be seen in its own air, and at 329 cd
that turned the frame into a fog bank. It is now derived from the lamp intensity
it was calibrated against, imported rather than typed.

### The cars

Nine vehicles, rebuilt this week from smooth lofts into something with real
shut lines cut into the body, arch lips, two-plane spoked rims, lamp housings
with lens depth, recessed glass with interiors behind it, handles and a rocker
seam. 114,466 triangles in the same four draw calls, up from something around
80,000 — the exact previous figure was not re-derived for this document, and
what fixes the order is the pass's own budget note, which describes its 320,000
triangle ceiling as about four times what the cars used to cost.
The argument for spending it is that every one of those is a *silhouette*
feature and a silhouette cannot be bought with a texture; the reason it is
affordable is that the cars are four merged buffers whatever is in them.

They also carry an analytic ground-contact term, computed from the cosine
weighted sky form factor of the underbody rather than painted, which is what
stops a parked car looking like it is hovering. That decal is the one whose
quads were wound backwards and which measured 1.000 against its own control.

### The street, filled

`world/placement.ts` is a single table read by two consumers that must never
disagree: `world/props.ts` builds the geometry from it and `scene/collide.ts`
derives the colliders from the same records. A prop that is not in the table is
not drawn, and a prop with a footprint is collidable, so adding one cannot forget
to add its collider. That file exists because both of this project's worst
duplication bugs were exactly this shape.

The placement itself is neither hand-authored nor scattered. Hand placement got
six objects aimed at six capture stops and left every other metre bare; uniform
scatter produced an even sprinkle that reads as a distribution rather than as a
street. Real kerbside clutter is clumped and functional, so clusters are anchored
to a *reason* — a doorway, a service alley, a lot gate — and the rest is filled
from a jittered grid whose acceptance probability is modulated by two octaves of
clump noise, so the density itself varies along the street.

Two constraints run underneath it, both learned the hard way. A gap between two
solids is either shut or walkable, never 300 mm, because the walker's
depenetration loop has nothing to converge on in a slot where every position is
inside something. And the walkable corridor is booked before anything is placed
rather than hoped for: the first dense run put down 175 individually plausible
props and sealed the near footway completely. Two intermediate versions of the
booking were also wrong in instructive ways — one refused every solid prop on
the street, taking the count to zero and turning the check green, which is this
codebase's signature failure wearing a new hat.

### Measuring instead of looking

The tooling is a substantial fraction of this repository, and it exists because
almost nothing about a frame this dark can be settled by looking at it. The same
PNG is moody on one panel and crushed on the next.

```bash
npm run shoot base            # six fixed stops, PNGs plus a report.json
npm run reel v3               # a scripted walk, frames plus mp4 plus reel.json
node tools/reel.mjs --dry     # walk the route on the CPU, no GPU, no lock
node tools/motion.mjs v3      # what moved, and what moved wrongly
node tools/gait.mjs           # the gait model alone, no browser
node tools/collide.mjs        # penetration, kerbs, wall slide, drift, sweep
node tools/route.mjs heroE    # trace a route against the real collider
node tools/propcount.mjs      # props, colliders and triangles, no browser
node tools/carcount.mjs       # the same for the cars, plus collider fit
node tools/framecost.mjs      # ms per frame at three stations, and the veil
node tools/coldstart.mjs      # where the load actually goes, from outside the app
node tools/shadowview.mjs     # ground points projected into the live shadow camera
node tools/px.mjs --t 0.4     # mean sRGB of named screen regions
node tools/agx.mjs 3.4 1.42 0.42   # one radiance to the 8-bit code it arrives at
node tools/diag.mjs           # scene graph, materials, camera, probe dump
```

Anything that renders should be wrapped in `node tools/withlock.mjs <tag> -- …`.

Four details in there are worth pulling out.

`reel.mjs` drives the real input path — a `KeyW` keydown into the same window
listener the keyboard uses — and advances the whole frame loop by hand at exactly
one over the frame rate, so a capture that takes twelve minutes produces the same
motion as one that takes two. Pausing the rig is not enough for this: it stops
only the rig's own update and leaves the dust, the shadow follower and the audio
engine running on wall-clock time.

`px.mjs` averages named rectangles rather than the whole frame, because
whole-frame histograms are dominated by the sky and therefore cannot answer "is
the asphalt reading darker than the concrete beside it". The same mistake in a
sharper form: a walk was accepted as "ending in the light" on a whole-frame 90th
percentile that was being carried entirely by a sunlit wall in the upper left,
while the road under the camera was three counts off the sensor floor. Ask what
physical thing the number is supposed to stand for, then measure that thing.

Frame cost is timed around a one-pixel `readPixels` rather than around
`glFinish`. `glFinish` in a page does not wait for the GPU — Chromium runs WebGL
over a command buffer into a separate process, and `finish` returns once the
queue has been handed over. Timed the wrong way, a post-processing chain appears
to cost forty microseconds and a higher quality tier appears to render faster
than a lower one.

`coldstart.mjs` installs itself with Playwright's `addInitScript` and patches the
WebGL context prototypes, so the application is not modified and does not know it
is being measured — which matters when every file an in-app profiler would live
in is being rewritten by somebody else the same week.

### Capture serialisation

Several agents shared this worktree and one GPU. Every tool that renders takes
`.capture.lock` first and releases it on exit, including on hard exits. Two
headless Chromium instances on a million-triangle street do not fail — they each
run at half speed, and the frame rate that then lands in the report is a
measurement of the other agent rather than of the scene. This is not
hypothetical: the frame timings in this README moved by two and a half
milliseconds between the evening's own measurement and today's re-run, and
contention is the most likely explanation.

The related hazard is comparing across time rather than across a toggle. An
A/B taken an hour apart on a shared tree attributes four other passes' work to
your change; the first before-and-after of the shadow roll showed the near cars
going from shaded to sunlit, which was entirely somebody else's. Every switchable
term in this tree — `?oldbox`, `?nosunfollow`, `?novol`, `?nospec`, `?nochips` —
exists so the experiment can be one page load with one variable.

## Layout

```
src/app/
  page.tsx        the route; hands off to Gate
  Gate.tsx        capability check and the load veil for the hosted build
  layout.tsx      metadata, and no next/font because that downloads a file

src/world/        procedural generation; no React, no scene knowledge
  glsl.ts           shared GLSL: hashes, tiling Perlin/FBM/Worley, helpers
  bake.ts           renders a GLSL surface description into a PBR texture set
  surfaces.ts       the surface descriptions: asphalt, concrete, iron, steel
  noise.ts          the CPU-side mirror of the above, for geometry
  dims.ts           real-world dimensions and fixture positions
  geometry.ts       road, kerb, pavement, manhole, gully and plate meshes
  emit.ts           indexed triangle soup with custom attributes, local frame
  block.ts          the massing, and the sun geometry that sets every height
  facade.ts         walls, windows, fire escapes, roof kit
  street3.ts        shopfronts, awnings, footway furniture
  frontage.ts       which trade stands where
  trades.ts         the deck of businesses, dealt without replacement
  signage.ts        projecting blades, swinging boards, enamel plates
  placement.ts      where every prop stands; the one table props and the
                    collider both read
  props.ts          the footway prop kit, built from that table
  propKinds.ts      the material and packing data per kind of prop
  cars.ts           body surfaces, and carSolids() for the collider
  lamps.ts          the luminaires
  neon.ts           swept tubes and the letterforms on them

src/scene/        the scene itself
  Street.tsx        the scene root: the sun, the environment, the subsystems
  Buildings.tsx / StreetLevel.tsx / Props.tsx / Cars.tsx / Lighting.tsx
  sun.ts            elevation, azimuth, the beam, the painted disc; a leaf
  sunShadow.ts      the shadow frustum, rolled along the street
  sunFollow.ts      keeps the box under the camera on every render, not
                    only on animation frames
  softShadow.ts     PCSS with a receiver-plane depth gradient
  env.ts            the analytic sky, and the probe convolved from it
  clouds.ts         three procedural decks, baked once into a sky cube
  haze.ts           directional haze, patched into the fog chunk globally
  volumetric.ts     raymarched air, sun shafts and lamp cones
  bloom.ts          nine-octave veiling glare
  pipeline.ts       the HDR post chain
  materials.ts      world-space macro detail layered over the baked tiles
  streetMaterials.ts    carriageway, footway, kerb, shopfront glazing
  buildingMaterials.ts  analytic brick, render, stone, glass, joinery, steel
  carMaterials.ts   paint, glazing, lamp lenses, tyres
  propMaterials.ts  the prop kit's surfaces
  lightMaterials.ts emissive fittings
  lights.ts         the analytic small sources
  lampFixtures.ts   the lantern photometry, and where the level came from
  signs.ts          the letterforms and the sign atlas
  dust.tsx          2,200 motes, one draw call, shadow-gated
  sensor.ts         a phone sensor's pedestal, read noise and dither
  tone.ts           the tone curve, shared with the tools
  grade.tsx         the colour grade
  collide.ts        the solid table the page collides with
  walker.ts         first-person movement, head bob, gait phase, ground follow
  Rig.tsx           input, camera, and the window.__scene debug API
  shaderWatch.ts    shader error checking, on deliberately
  NightStreet.tsx   the canvas, renderer and tone mapping setup

src/audio/        Web Audio, synthesised
  dsp.ts            oscillators, filters, the generated impulse response
  design.ts         what the street sounds like, and where from
  engine.ts         the graph and the master bus
  CityAudio.tsx     mounting it, and the gesture that unlocks it

tools/            the harness and the instruments; see the list above
docs/TECHNIQUE.md the lighting, atmosphere and post-processing brief
docs/COLDSTART.md where the load goes, and one unresolved contradiction in it
NOTES.md          deferred work, and the post-mortems
```

## Debug API

In development the page exposes `window.__scene`. It is absent in production
builds, deliberately, because it is a remote control for the renderer.

| call | does |
| --- | --- |
| `goTo(t)` | teleport along the street, `t` in 0..1 |
| `setYaw(rad)` / `setPitch(rad)` | absolute heading and pitch |
| `warp(seconds)` | advance springs and settling without waiting |
| `setDriven(bool)` | take the whole frame loop off the wall clock |
| `step(dt)` | advance every `useFrame` by `dt` and render |
| `renderOnce()` | apply state and draw, without an animation frame |
| `info()` | `{ calls, triangles, programs, textures }` |
| `probe()` | luminance histogram and percentiles of the current frame |
| `fps` | current measured frame rate |
| `walker` | the walker, for reading gait phase and speed |

`window.__sunFollow` is published alongside it and reports whether the shadow
box has ever been stale on a render, with the distribution of the drift.

## Stack

Next.js 16, React 19, TypeScript, Tailwind CSS 4, Three.js 0.185 through React
Three Fiber 9. Playwright drives the capture harness. ffmpeg encodes and
measures. No asset pipeline, because there are no assets.

## How it was built

The five prompts are in [PROMPTS.md](PROMPTS.md), verbatim. The first of them
sets the method as well as the subject: eight numbered systems, built strictly
in order, and after each one a separate sub-agent acting as a harsh visual
critic that sees only the rendered output and never the source, comparing the
result against real photography and sending it back if it reads as a render.

The build did follow that order — the commit history still names the systems as
it goes — and the critic loop ran throughout, against the screenshot archive
rather than against the code. One honest difference from
[jungle-trail](https://github.com/StarKnightt/jungle-trail), where the same
method was used: no score ledger was kept here, so there is no per-system "5/10
after six rounds" table to publish. What stands in its place is the "what is not
good enough yet" section above, which is the same information written down after
the fact instead of during.

The instruction against fanning out parallel sub-agents was relaxed partway
through, as it was on jungle-trail, and it left a mark on the codebase that is
worth knowing about: several agents shared this worktree and one GPU, which is
why every tool that renders takes `.capture.lock` first, and why the README
keeps saying that a measurement taken an hour apart from its control is a
measurement of somebody else's work.

What reviewing renders caught, which reading the source would not have:

- **The cars' ground-contact decal was invisible.** Its geometry was built, its
  material compiled, and the road under the cars was bit-identical with it on
  and off, because the quads were wound the wrong way and were being back-face
  culled.
- **The entire audio system was silent on every machine, from the day it was
  written.** A `ConvolverNode` threw on a sample-rate mismatch before the bed,
  the spot sources and the footsteps were constructed. The error was in the page
  console the whole time.
- **A field of 2,200 dust motes sat 32 m behind the camera in every capture ever
  reviewed**, while the interactive walk looked correct.
- **The sun's shadow box was stale in still captures**, so those stills had no
  cast shadows on the visible street at all and the volumetric sun-shaft term
  integrated to exactly zero.

All four are written up at length above and in [`NOTES.md`](NOTES.md). The
pattern they share is the reason the tooling in `tools/` is a substantial
fraction of this repository.

## Agent skills

This project leaned on [agent skills](https://skills.sh) — small packaged
briefs that give a coding agent procedural knowledge it would otherwise have to
be told. The original prompt named three Three.js skill repositories and pointed
at the directory for more, and a survey of what was installed and what was
available is written up in [`docs/TECHNIQUE.md`](docs/TECHNIQUE.md) under "what
the sources turned out to be worth".

None of the skill files used here are vendored into this repository. If you want
to find the same class of thing, the directory has a CLI. Searching it looks
like this:

```bash
npx skills find three          # Three.js
npx skills find webgl          # graphics and rendering
npx skills find game           # game development
```

Each result prints as `owner/repo@skill` with an install count and a
`skills.sh` link, and installing one is `npx skills add <owner/repo@skill>`.
Running `npx skills find` with no query opens an interactive search instead.

The honest finding from the survey is worth passing on, because it will save
somebody the same afternoon: for a project at this level of detail, the
available Three.js rendering skills were flat API catalogues with no measurement
discipline and no colour-space reasoning, and several of their recommendations
were actively wrong for this scene. By far the most useful source of technique
was the previous project's own code comments. Skills are good at telling an
agent what an API is. They were no help at all with what number to put in it.

## Licence

MIT. See [LICENSE](LICENSE).
