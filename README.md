# night-street

A first-person walkable city street at golden hour, in a browser.

**[Walk it here](https://night-street.vercel.app)** — desktop, keyboard and
mouse. Give it about thirty seconds on first load; the reason why is the whole
point of the project.

Every texture, every mesh, every light and every sound in this scene is
generated in code. There are no image files in this repository, no models, no
HDRIs, no audio files, and nothing is fetched at runtime. The asphalt is a GLSL
surface description baked into a PBR texture set in your GPU while you wait. The
buildings are emitted as indexed triangle soup from a massing solver. The sky is
a closed-form analytic dome that serves as both the background and the image
based lighting. The traffic, the tyre noise on the wet gutter and the
reverberation of the canyon are a Web Audio graph rendered offline. Nothing was
authored in Blender, Substance or Photoshop, because nothing was authored
anywhere except in a text editor.

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

## The thirty seconds

The hosted build spends between thirty and forty seconds on a black screen
before the first frame, on a desktop GPU. This is not a loading bar being coy
about a download. The network is finished in under a second — the entire page is
about half a megabyte of JavaScript — and everything after that is the street
being manufactured: every surface description compiled, every texture set baked
into a render target, every mesh emitted and merged, every material program
linked.

Measured on the deployed build against an RTX 4060, the first lit frame arrives
at 32.4 s, and the main thread is blocked for 47.8 s in total across three
tasks of roughly 5, 20 and 23 seconds. The work is dominated by the GPU bakes
rather than by JavaScript: throttling the CPU by four times moved the first lit
frame by less than a second.

This is the honest cost of the constraint, and it is the one place where the
project's central claim charges the visitor directly. `src/app/Gate.tsx` covers
the gap with an explanation rather than a black page, and its progress bar is a
CSS transform animation specifically because the main thread is blocked for the
entire time the bar is on screen, so anything driven by a timer or an animation
frame would sit frozen for exactly the interval it exists to cover.

## What is measured

Numbers in this README are measurements rather than estimates, and the tool that
produced each one is named so it can be re-run.

**Performance.** 66 fps at 1080p on an RTX 4060, with 866,000 triangles and 45
draw calls. The draw call count is the number that matters: the street is four
merged building meshes, a merged street-level pass, and one draw call for all
2,200 dust motes.

**Collision.** Worst-case penetration of 0.09 mm, across every solid on the
street, approached from sixteen angles each. `scene/collide.ts` is the table the
page itself collides with, and `tools/route.mjs` traces candidate walks against
that same table rather than against a copy of it.

**Gait.** Zero measurable foot slide at either pace: 0.700 m of stride measured
against 0.700 m modelled, over 58 footfalls. `tools/gait.mjs` runs the gait model
on the CPU with no browser and no GPU; `tools/motion.mjs` checks the delivered
capture against it.

**Dust.** The motes are real objects with parallax rather than a noise overlay,
which is a claim worth testing because the cheap version looks similar in a
still. Frame-to-frame persistence of a mote is 5.05 px, against 76.5 px for a
randomised control — a field that was being regenerated each frame rather than
moved through would score like the control.

**Audio.** Synthesised from oscillators, filtered noise and a generated impulse
response, and recorded by a second real-time pass over the same route rather than
during the capture, because the capture advances the clock by hand and Web Audio
cannot be. Both passes integrate against real `dt`, so they agree:
`tools/audiotake.mjs` checks its own footfalls against the picture's and refuses
the take if they drift past 60 ms.

## What is not good enough yet

An honest list, because the alternative is that you find these yourself and
wonder what else is being oversold.

**The road and paving system is the weakest part of the build.** The paving has
no per-slab variance — every slab is the same slab — and no chamfered edges,
which is the detail that makes real paving read as a set of separate stones
rather than as a textured plane. This is the first thing a second pass should
take.

**The brick lacks albedo variance.** The relief, the mortar and the weathering
are there; the colour differences between individual bricks are not. Brick in
reality varies more between neighbours than almost any other common surface.

**The road's hue and saturation are still off.** The carriageway sits at about
three degrees red with a saturation of 0.23 where real asphalt measures 0.05 to
0.12. The colour grade takes the sunlit carriageway from 0.263 to 0.227 and that
is as far as a grade can go without desaturating the sunlight itself, which is
the look. The residual is in the albedo. One dead end is recorded so it is not
retried: tinting the inter-chip cavities toward zenith blue made the saturation
*worse*, because the chip scatter is sparse and leaves too few cavities to act
on.

**The road centreline is over-worn.** It reads as a crack rather than as paint.

**There are no touch controls.** Movement is read off keyboard events and looking
requires a locked pointer, so the scene is not drivable on a phone at all. The
hosted build detects this and says so instead of handing over a street you cannot
walk down.

Further deferred items, each owned by a pass that has not run, are in
[`NOTES.md`](NOTES.md).

## The class of bug that cost this project most

This is the part worth reading if you read nothing else, and it is written up at
greater length at the top of [`NOTES.md`](NOTES.md).

Three separate failures here have the same shape. Each time, a system was
verified by measuring the things it *makes*, and each time the thing that was
broken was the way those things were *wired together* — which the measurement
could not see, and which was reporting itself loudly somewhere nobody was
reading.

**The entire audio system was silent on every machine, in every capture, from
the day it was written.** `tools/audio.mjs` checks the generators, and every one
of them was producing correct samples: the tyre noise, the pink bed, the footstep
transients, the impulse response. What it could not check was `build()`.
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
renders inside one synchronous evaluation. Same shape: the particle generator was
right, the integration was not, and the instrument was pointed at the generator.

**`tools/obstacles.mjs` cleared routes that were not clear**, because it is a
hand-copy of `world/cars.ts` that drifted — one car short, and the dumpster's
half-extents transposed. The routine was correct; the data it ran against was not
the data the page uses.

The defence is cheap and it is now a rule here: **make the check load the real
assembly.** That is why `tools/route.mjs` imports `scene/collide.ts` instead of a
copy, why `tools/aim.mjs` derives sign positions from `world/street3.ts` rather
than from a table typed out of it, and why `tools/audiotake.mjs` records the
master bus through a `MediaStreamDestination` instead of summing the generators
itself. The second rule is to read what the assembly says about itself: a
non-empty `errors` array is a finding, not noise.

A closely related trap has its own write-up in
[`docs/TECHNIQUE.md`](docs/TECHNIQUE.md): **you cannot judge a linear quantity by
looking at a display-space image.** Five separate expensive bugs reduce to that
one sentence, including a haze pass that mixed a linear radiance into a
display-encoded buffer and produced hard-edged flat orange rectangles that three
review rounds read as a UV bug. The remedy is to author every radiance by
inverting a target display value through the measured tone curve, which
`tools/agx.mjs` does by porting AgX and the sRGB encode out of `node_modules` and
inverting them numerically. It agrees with nine sky pixels, where the scene
radiance is known in closed form, to a mean absolute error of 0.0 counts.

## How it is built

### The rendering

Next.js App Router with React Three Fiber, one client-side route, no server
component doing anything interesting. Three.js renders forward, with AgX tone
mapping at an exposure of 0.296 rather than ACES: the frame is lit by a
narrow-band source near the horizon, and ACES turns a saturated orange highlight
yellow and then white as it rolls off, which is the wrong answer for sodium. AgX
holds the hue into the clip.

Shadows use `BasicShadowMap`, which is not a downgrade. It is the only type whose
uniform is a plain `sampler2D` rather than a hardware comparison sampler, and
reading the stored depth is what makes a blocker search possible. All of the
filtering is done in `scene/softShadow.ts`, which runs a 12-tap blocker search
and a 20-tap Vogel filter with a receiver-plane depth gradient solve against a
4096 square map — strictly softer and better distributed than the PCF kernel it
replaces. The gradient solve exists because this scene has to shade surfaces
nearly parallel to their own key light.

### The sun is the level designer

The sun sits at an elevation of 4.2 degrees, which means a four-metre frontage
throws a fifty-four-metre shadow. There are consequently only two stretches of
this street lit at street level, and `world/block.ts` decides how tall every
building is in order to produce them. The sunward row is low on purpose.

Everything else bends around those two bands. They are where the dust ignites,
they are what the delivered camera route was chosen to end in, and
`tools/airtime.mjs` exists to count motes per frame along a candidate route so
that choice could be made from numbers rather than from taste.

### Lighting budget

Four real `Light` objects or fewer, and exactly one of them casts a shadow. This
is not asceticism. A previous version had fourteen unshadowed spotlights with a
projected cookie, and disabling all of them changed the shaded frontage by 0.0
per cent and the carriageway by 0.10 per cent. They were removed anyway, and the
reason governs the whole design: fourteen lights and a cookie sit in every
material program in the street, and the texture-unit budget they forced is why
three paving materials were running without their baked occlusion maps.

The cost of a light in a forward renderer at this hour is not its radiance
contribution. It is a uniform count in every one of your draw calls, plus a
texture unit if it carries a cookie, plus a shadow map if it casts. Small sources
are therefore analytic instead: evaluated in the receiving material from a
uniform array, at no draw call, no light slot and no texture unit.

### Measuring instead of looking

The tooling is a substantial fraction of this repository, and it exists because
almost nothing about a frame this dark can be settled by looking at it. The same
PNG is moody on one panel and crushed on the next.

```bash
npm run shoot base          # six fixed stops, PNGs plus a report.json
npm run reel v3             # a scripted walk, frames plus mp4 plus reel.json
node tools/reel.mjs --dry   # walk the route on the CPU, no GPU, no lock
node tools/motion.mjs v3    # what moved, and what moved wrongly
node tools/gait.mjs         # the gait model alone, no browser
node tools/route.mjs heroE  # trace a route against the real collider
node tools/px.mjs --t 0.4   # mean sRGB of named screen regions
node tools/agx.mjs 3.4 1.42 0.42   # one radiance to the 8-bit code it arrives at
node tools/expose.mjs shots/heroI/night-street-1080p30.mp4
node tools/diag.mjs         # scene graph, materials, camera, probe dump
```

Three details in there are worth pulling out.

`reel.mjs` drives the real input path — a `KeyW` keydown into the same window
listener the keyboard uses — and advances the whole frame loop by hand at exactly
one over the frame rate, so a capture that takes twelve minutes produces the same
motion as one that takes two. Pausing the rig is not enough for this: it stops
only the rig's own update and leaves the dust, the shadow follower and the audio
engine running on wall-clock time.

`px.mjs` averages named rectangles rather than the whole frame, because
whole-frame histograms are dominated by the sky and therefore cannot answer "is
the asphalt reading darker than the concrete beside it".

Frame cost is timed around a one-pixel `readPixels` rather than around
`glFinish`. `glFinish` in a page does not wait for the GPU — Chromium runs WebGL
over a command buffer into a separate process, and `finish` returns once the queue
has been handed over. Timed the wrong way, a post-processing chain appears to cost
forty microseconds and a higher quality tier appears to render faster than a
lower one.

### Capture serialisation

Several agents shared this worktree and one GPU. Every tool that renders takes
`.capture.lock` first and releases it on exit, including on hard exits. Two
headless Chromium instances on an 866,000-triangle street do not fail — they each
run at half speed, and the frame rate that then lands in the report is a
measurement of the other agent rather than of the scene.

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
  cars.ts           body surfaces, and carSolids() for the collider
  lamps.ts          the luminaires
  neon.ts           swept tubes and the letterforms on them

src/scene/        the scene itself
  materials.ts      world-space macro detail layered over the baked tiles
  streetMaterials.ts    carriageway, footway, kerb, shopfront glazing
  buildingMaterials.ts  analytic brick, render, stone, glass, joinery, steel
  carMaterials.ts   paint, glazing, lamp lenses, tyres
  lightMaterials.ts emissive fittings
  env.ts            the analytic sky: background and light probe, baked apart
  haze.ts           directional haze, patched into the fog chunk globally
  dust.tsx          2,200 motes, one draw call, shadow-gated
  softShadow.ts     PCSS with a receiver-plane depth gradient
  sensor.ts         a phone sensor's pedestal, read noise and dither
  grade.tsx         the colour grade and the tone curve
  collide.ts        the solid table the page collides with
  walker.ts         first-person movement, head bob, gait phase
  Rig.tsx           input, camera, and the window.__scene debug API
  NightStreet.tsx   the canvas, renderer and tone mapping setup

src/audio/        Web Audio, synthesised
  dsp.ts            oscillators, filters, the generated impulse response
  design.ts         what the street sounds like, and where from
  engine.ts         the graph and the master bus
  CityAudio.tsx     mounting it, and the gesture that unlocks it

tools/            the harness and the instruments; see the list above
docs/TECHNIQUE.md the lighting, atmosphere and post-processing brief
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
| `info()` | `{ calls, triangles, programs, textures }` |
| `probe()` | luminance histogram and percentiles of the current frame |
| `fps` | current measured frame rate |
| `walker` | the walker, for reading gait phase and speed |

## Stack

Next.js 16, React 19, TypeScript, Tailwind CSS 4, Three.js 0.185 through React
Three Fiber 9. Playwright drives the capture harness. ffmpeg encodes and
measures. No asset pipeline, because there are no assets.
