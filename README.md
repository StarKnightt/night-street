# night-street

A first-person walkable city street at night, rendered in Next.js + React Three
Fiber. Every texture, mesh and light is generated procedurally at runtime —
there are no image, model, HDRI or audio files anywhere in this repository, and
none are fetched.

This is **Phase 0 + System 1**: the scaffold, the capture harness, and the road
and pavement. Buildings, street furniture, vehicles, the real lighting rig,
atmosphere, sound and post-processing are Systems 2–8 and are not here yet.

## Running it

One dev server, port 3000, and nothing starts a second one:

```bash
npm run dev
```

Then open http://localhost:3000 and click the canvas to capture the pointer.
`WASD` walks at 1.4 m/s, `Shift` breaks into a jog at 3.1 m/s, the mouse looks,
`Esc` releases the pointer. There is no jump — the pace is deliberate, because
the scene is meant to be looked at, and the jog exists mainly as a test
instrument: stride length, cadence and head-bob amplitude all scale together
with speed, so a gait term derived wrongly from the others is obvious at 3.1
m/s and nearly invisible at 1.4.

## Capturing

With the dev server already running, in a second terminal:

```bash
npm run shoot base
```

That launches exactly one headless Chromium, teleports the camera to a fixed set
of stops along the street, and writes `shots/base/NN.png` at 1600x900 plus a
`shots/base/report.json` containing the GL renderer string, per-stop draw calls,
triangle count, luminance histogram, steady-state FPS and any console or page
errors.

Flags, all optional:

| flag      | default                     | meaning                                  |
| --------- | --------------------------- | ---------------------------------------- |
| `--t`     | `0.02,0.2,0.4,0.6,0.8,0.95` | stops along the street, 0..1             |
| `--yaw`   | `0`                         | heading in radians, 0 looks down -Z      |
| `--pitch` | `-0.22`                     | pitch in radians, negative looks down    |
| `--fov`   | `52`                        | vertical field of view in degrees        |
| `--w`     | `1600`                      | capture width                            |
| `--h`     | `900`                       | capture height                           |
| `--js`    | —                           | expression evaluated in-page before each shot |
| `--cpu`   | —                           | force SwiftShader instead of the real GPU |

## Capturing motion

`shoot` stops and looks. `reel` walks:

```bash
npm run reel v3            # every shot, frames + mp4 + reel.json
node tools/reel.mjs --dry  # walk the route on the CPU, no GPU, no lock
node tools/motion.mjs v3   # what moved, and what moved wrongly
node tools/gait.mjs        # the gait model alone, no browser
```

The reel drives the real input path — a `KeyW` keydown into the same window
listener the keyboard uses, and steering through `walker.look()` at mouse
sensitivity — and advances the whole r3f frame loop by hand at exactly 1/fps
via `__scene.step()`, so a capture that takes twelve minutes produces the same
motion as one that takes two. `setPaused` is not enough for this: it stops only
the Rig's own update and leaves the dust, the shadow follower and the audio
engine running on wall-clock time.

Shots are fixed in the file for the same reason `shoot`'s six stops are. Three
of them are diagnostics rather than footage: `static` parks the camera so that
any frame-to-frame difference left is the scene animating rather than parallax,
`creep` steps at 1/240 s so the camera moves 5.8 mm between frames and anything
that still changes is aliasing rather than motion, and `car` and `lamp` aim
deliberately at solid objects.

`reel.json` carries per-frame walker state, frame cost timed around a one-pixel
`readPixels` rather than `glFinish`, and region means read off the framebuffer
before any encoding. `motion.mjs` turns that into foot slide, bob-to-footfall
registration, translation continuity, obstacle clearance and temporal stability.

**Run `--dry` before spending a capture slot.** It walks the same `Walker`
against the same obstacle table in about a second, and a route that grazes a
parked car is a defect in the route.

## Composing and delivering the walk

```bash
node tools/route.mjs heroE          # trace a route against the real collider
node tools/airtime.mjs heroE        # dust per frame, second by second
node tools/audiotake.mjs heroE      # record the audio at real speed
node tools/deliver.mjs heroE --fps 60 --half --mbps 12
node tools/digestcheck.mjs shots/heroE/reel.json
```

`route.mjs` exists because `--dry` reports against `tools/obstacles.mjs`, which
has drifted from `world/cars.ts` — one car short, the dumpster's half-extents
transposed — so it clears routes that are not clear. `route.mjs` traces the
same walk against `scene/collide.ts`, the table the page itself collides with,
and prints what is beside the camera and how much of the take stands in a sun
band. A route is a composition before it is a clearance test.

The two sun bands are the constraint everything else bends around. At 4.2° a
4 m frontage throws a 54 m shadow, so `world/block.ts` leaves only z −49..−32
and z −84..−73 lit at street level, and those are the only stretches where the
dust ignites. `airtime.mjs` counts motes per frame along a candidate; it is how
the delivered route was chosen over one that spent its first third in shade.

Audio is recorded by a second real-time pass over the same route rather than
during the capture, because the capture advances the clock by hand and Web
Audio cannot be. Both passes integrate against real `dt`, so they agree:
`audiotake.mjs` checks its own footfalls against the picture's and refuses the
take if they drift past 60 ms.

## Capture serialisation

Several agents share this worktree and one GPU. Every tool that renders takes
`.capture.lock` first (`tools/lock.mjs`), waits if another holds it, and
releases on exit including the hard exits `harness.mjs` takes. Two headless
Chromiums on an 866k-triangle street do not fail — they each run at half speed,
and the frame rate that lands in the report is then a measurement of the other
agent.

Two smaller tools sit alongside it:

```bash
node tools/px.mjs --t 0.4    # mean sRGB of fixed screen regions
node tools/diag.mjs          # scene graph, materials, camera, probe dump
```

`px.mjs` exists because whole-frame histograms are dominated by the sky, so they
cannot answer "is the asphalt reading darker than the concrete beside it". It
averages named rectangles instead, which is the only reliable way to tell a real
albedo change from no change at all when the frame is this dark.

## Debug API

In development the page exposes `window.__scene`:

| call                       | does                                              |
| -------------------------- | ------------------------------------------------- |
| `goTo(t)`                  | teleport along the street, `t` in 0..1             |
| `setYaw(rad)`              | absolute heading                                   |
| `setPitch(rad)`            | absolute pitch                                     |
| `warp(seconds)`            | advance springs and settling without waiting       |
| `setPaused(bool)`          | stop and restart the render loop                   |
| `renderOnce()`             | render one frame while paused                      |
| `setDriven(bool)`          | take the *whole* frame loop off the wall clock     |
| `step(dt)`                 | advance every `useFrame` by `dt` and render        |
| `clock`                    | virtual seconds since `setDriven(true)`            |
| `fps`                      | current measured frame rate                        |
| `info()`                   | `{ calls, triangles, programs, textures }`         |
| `probe()`                  | luminance histogram of the current frame           |
| `walker`                   | the `Walker`, for reading gait phase and speed     |

## Layout

```
src/world/     procedural generation, no React and no scene knowledge
  glsl.ts        shared GLSL: hashes, tiling Perlin/FBM/Worley, helpers
  bake.ts        renders a GLSL surface description into a PBR texture set
  surfaces.ts    the surface descriptions: asphalt, concrete, iron, steel
  noise.ts       the CPU-side mirror of the above, for geometry
  dims.ts        real-world dimensions and fixture positions
  geometry.ts    road, kerb, pavement, manhole, gully and plate meshes
  emit.ts        indexed triangle soup with custom attributes, in a local frame
  block.ts       the massing: where every building stands, and the sun geometry
                 that decides its height — the sunward row is low on purpose
  facade.ts      building geometry — walls, windows, fire escapes, roof kit
src/scene/     the scene itself
  materials.ts   world-space macro detail layered over the baked tiles
  buildingMaterials.ts  analytic brick, render, stone, glass, joinery and steel
  env.ts         procedural golden-hour sky, used as background and as IBL
  walker.ts      first-person movement, head bob and gait phase
  Street.tsx     assembles the geometry, materials and temporary lighting
  Buildings.tsx  the four merged building meshes
  Rig.tsx        input, camera, and the window.__scene debug API
  NightStreet.tsx  the canvas, renderer and tonemapping setup
tools/         harness.mjs, shoot.mjs, px.mjs, diag.mjs
  lock.mjs       the capture lock; every rendering tool takes it first
  reel.mjs       scripted walks, frame sequences and mp4
  motion.mjs     reads reel.json and reports motion defects
  gait.mjs       the gait model on the CPU, no browser and no GPU
  obstacles.mjs  the solid things on the street, for clearance checks
  shots.mjs      the route table, shared by the picture and audio passes
  route.mjs      trace a route against scene/collide.ts and the landmarks
  airtime.mjs    dust motes per frame along a take
  audiotake.mjs  record the procedural audio, aligned to the picture
  deliver.mjs    encode the mp4s a social timeline will re-encode well
  digestcheck.mjs  did the tree that rendered a take change since?
```
