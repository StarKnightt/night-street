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
`WASD` walks at 1.4 m/s, the mouse looks, `Esc` releases the pointer. There is
no sprint and no jump — the pace is deliberate, because the scene is meant to be
looked at.

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
| `fps`                      | current measured frame rate                        |
| `info()`                   | `{ calls, triangles, programs, textures }`         |
| `probe()`                  | luminance histogram of the current frame           |

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
```
