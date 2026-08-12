# The cold start: where the thirty seconds go, and what to do about it

This is a measurement report and an implementation plan. Nothing in it has been
applied. It was produced against the tree at `facb599` plus the paving pass's
in-flight `scene/materials.ts`, and deliberately stops short of code because
three other passes — procedural cloud in `scene/env.ts`, a large increase in
prop and building density across `StreetLevel.tsx` / `Buildings.tsx` /
`buildingMaterials.ts` / `Cars.tsx`, and heavier atmosphere in `haze.ts` — are
about to change the thing being optimised.

**The headline, before any detail: the texture bakes are not the problem.** All
seven of them together cost **244 milliseconds** of GPU time. Ninety-nine per
cent of the cold start is the ANGLE/D3D11 compilation of the scene's shader
programs, and about **fifteen seconds of that is compiled and then thrown
away**, because the environment map and the fog are attached to the scene one
React effect after the first frame has already been drawn.

---

## 1. How this was measured

`tools/coldstart.mjs`. It installs itself with Playwright's `addInitScript`, so
it runs before any of the page's own script, and it patches the WebGL context
prototypes. The application is not modified and does not know it is being
measured — which matters right now, because every file an in-app profiler would
have to live in is being rewritten by somebody else this week.

```
node tools/withlock.mjs cold -- node tools/coldstart.mjs --sync
node tools/withlock.mjs cold -- node tools/coldstart.mjs --sync --noinfolog
node tools/withlock.mjs cold -- node tools/coldstart.mjs --sync --noinfolog --dump
```

`--sync` reads one pixel back after each bake draw, which is what makes a bake's
GPU cost attributable. `--noinfolog` is the ablation described in §5.
`--dump` writes the eight largest shader sources to `tmp/prof/shaders/` so they
can be identified by grepping the real tree rather than a table copied out of
it.

**Hardware and configuration.** RTX 4060, Windows, headless Chromium via
Playwright, ANGLE on the D3D11 backend, 1600×900, `dpr` 1. Next dev server on
port 3000. Every run is a fresh browser profile, so Chrome's on-disk shader
cache is **always cold** — which is the correct case for the visitor this work
is for, someone tapping a link from a timeline, but it is not the case for a
reload, and it is why re-running the tool never gets faster.

**Numbers move between runs.** Two different figures appear below — about 32 s
and about 46 s — and the difference is real, not noise in the instrument. See
§6.

---

## 2. Per-bake cost

Seven surfaces, three passes each, twenty-one draws. GPU time, measured by
blocking on a one-pixel readback from each target immediately after its draw.

| surface | size | passes | GPU ms | share of bakes | share of a 32 s load |
| --- | --- | --- | --- | --- | --- |
| asphalt | 2048 | 3 | 118.9 | 48.7% | 0.37% |
| concrete | 2048 | 3 | 78.4 | 32.1% | 0.24% |
| granite | 1024 | 3 | 12.3 | 5.0% | 0.04% |
| gully | 1024 | 3 | 11.9 | 4.9% | 0.04% |
| manhole | 1024 | 3 | 11.3 | 4.6% | 0.04% |
| tread | 512 | 3 | 5.7 | 2.3% | 0.02% |
| cast iron | 512 | 3 | 5.6 | 2.3% | 0.02% |
| **total** | | **21** | **244.1** | **100%** | **0.75%** |

A second run agreed to within 4% on every row (`tmp/prof/A-baseline.json`,
`tmp/prof/B-noinfolog.json`).

The normal pass is the expensive one within each surface — it evaluates `surf()`
four times per texel for the central differences, against once for albedo and
once for ORM — but at this scale it does not matter. **Halving every bake
resolution would save about 120 ms of a load that is thirty seconds long.**

Do not spend effort here. Specifically, do not implement any of the following,
all of which were on the table and are all worth under a quarter of a second in
total: progressive low-resolution bakes swapped for full ones later, dropping
asphalt and concrete from 2048 to 1024, chopping bakes into scissored bands to
yield to the event loop, or auditing for surfaces that are baked but never
sampled. (All seven bakes *are* sampled; that much was checked.)

### Why an earlier measurement said the bakes cost 5.3 seconds

An in-app profiler, since reverted, wrapped each `bakeSurface` pass in a span
that ended with `readRenderTargetPixels`, and reported 5,278 ms across the seven
surfaces — asphalt 2,103 ms, concrete 1,756 ms. That number is not wrong, it is
mis-attributed. A bake pass's span contained the first use of that pass's
shader program, and three checks a program on first use. So 5.0 s of the 5.3 s
was the compilation of the twenty-one bake programs, not the baking. The
external tool separates the two because it buckets `getProgramInfoLog` and
`getProgramParameter` away from `drawElements`.

The bake *programs* cost 4.4 s to compile, which is real, and is addressed by
§4.2 rather than by anything done to the bakes themselves.

---

## 3. Shader compilation is the load

Time spent inside every WebGL entry point during a complete cold load, sorted:

| entry point | calls | total |
| --- | --- | --- |
| `getProgramInfoLog` | 99 | **45,906 ms** |
| `drawElements` | 9,653 | 249 ms |
| `readPixels` (the instrument's own sync) | 42 | 244 ms |
| `bufferData` | 386 | 24 ms |
| `getUniformLocation` | 2,526 | 2.1 ms |
| `getActiveUniform` | 2,526 | 1.5 ms |
| everything else | — | under 3 ms |

That is the whole load in one line: 45.9 seconds of 46.4 seconds of WebGL time
is a single call, and every draw the page issues during startup — including all
twenty-one bakes and the first several frames — adds up to a quarter of a
second.

### What the programs are

> **UNRESOLVED CONTRADICTION — read before optimising against this table.**
>
> A second, independent measurement (atmosphere pass, A/B of the HDR chain via
> `?post=nohdr`) reports numbers that cannot both be true with the table below:
>
> - `LINK_STATUS` totals **7.1 ms**, not tens of seconds. The ~33 s sits in
>   `getProgramInfoLog` at roughly **430 ms per program across 76 programs**,
>   which three only calls because `debug.checkShaderErrors` is on.
> - **69 of the 76 programs are surface bakes and PMREM**, not scene materials —
>   the reverse of the split in this table.
>
> That second point is the one that matters, because if it is right this whole
> document points optimisation at scene materials that account for under 10% of
> the programs.
>
> The two are not obviously reconcilable by arithmetic, but they may both be
> honest observations of the same thing: with `KHR_parallel_shader_compile`
> present, compilation is asynchronous and the cost surfaces at whichever call
> first forces a synchronisation. §5's ablation found that removing the info-log
> calls simply moved the identical cost into `LINK_STATUS`, which is exactly what
> that theory predicts — and would mean *neither* call is the cause and disabling
> `checkShaderErrors` buys nothing, as §5 concluded. It does not explain the
> program-mix disagreement, which is a straight counting question and should be
> settled by counting.
>
> **Do not delete either measurement to make the document tidy.** Settle it by
> re-counting programs by group on one build, in one run, with both call sites
> instrumented simultaneously.

With the info-log ablation applied (§5) the same cost lands on
`getProgramParameter(LINK_STATUS)`, one call per program, which makes it
attributable per program:

| group | distinct programs | link events | total |
| --- | --- | --- | --- |
| bake programs and PMREM helpers (11k–20k chars) | ~24 | 50 | 4,429 ms |
| scene material programs (100k–230k chars) | 47 | 75 | 41,776 ms |
| **total** | | **127** | **46,867 ms** |

Mean cost of a scene material program: **557 ms**. The distribution is very
top-heavy:

| chars | first linked at | cost | identified as |
| --- | --- | --- | --- |
| 229,734 | 25.0 s | **8,845 ms** | road / paving, `scene/materials.ts` |
| 212,371 | 6.4 s | **8,184 ms** | road / paving, same material, no envmap/fog |
| 182,451 | 36.3 s | 4,032 ms | shopfront + shutter, `streetMaterials.ts` |
| 165,088 | 16.4 s | 3,196 ms | shopfront + shutter, no envmap/fog |
| 186,255 | 33.9 s | 1,692 ms | road family with `gDbg`/`uFlag`, `materials.ts` |
| 168,892 | 14.5 s | 1,470 ms | same, no envmap/fog |
| 192,090 | 45.4 s | 1,196 ms | car paint, `carMaterials.ts` |
| 174,727 | 23.3 s | 842 ms | car paint, no envmap/fog |

Identification is by grepping the dumped sources for tokens that occur in
exactly one material file (`gDbg` and `uFlag` → `materials.ts`, `carPaint` →
`carMaterials.ts`, `shutter` → `streetMaterials.ts`, `litWall` →
`streetMaterials.ts`).

For scale: a stock `MeshStandardMaterial` on this renderer assembles to roughly
30,000 characters. These are five to eight times that. **The two road variants
alone are 17.0 s — 40% of all scene shader compilation.**

### The three long tasks

`PerformanceObserver` with `buffered: true`, so the entries are read after the
fact and nothing has to be installed before the page's own scripts. This
reproduces the previously reported "47.8 s across three long tasks" almost
exactly, and now attributes them:

| task | starts | length | program linking inside it | bake draws | unattributed |
| --- | --- | --- | --- | --- | --- |
| 1 | 0.54 s | 5,809 ms | 5,026 ms | 236 ms | 547 ms |
| 2 | 6.35 s | 18,638 ms | 18,561 ms | 0 | 77 ms |
| 3 | 25.03 s | 23,084 ms | 23,028 ms | 0 | 56 ms |
| small | — | 179 ms | — | — | 179 ms |
| **total** | | **48,258 ms** | **46,615 ms** | **236 ms** | **859 ms** |

- **Task 1 is `Street`'s `useMemo`**: it links the 21 bake programs and 3 PMREM
  programs (5.0 s), runs the 21 bake draws (236 ms) and builds the geometry
  (about 0.5 s of JavaScript, the only genuinely CPU-bound part of the load).
- **Task 2 is the first `gl.render`**, compiling every visible material
  **without** `USE_ENVMAP` and **without** `USE_FOG`.
- **Task 3 is the second `gl.render`**, compiling every one of them again
  **with** both.

---

## 4. The findings, in order of what they are worth

### 4.1 Half of task 2 is thrown away — about 15 s — because the sky is attached too late

**This is the largest single win available and it does not change a pixel.**

`scene/Street.tsx` lines 87–116 assign `scene.background`, `scene.environment`,
`scene.backgroundIntensity`, `scene.environmentIntensity` and `scene.fog`, and
call `installHaze`, inside a `useEffect`. React runs effects after the commit,
and r3f's loop draws at least one frame before that effect lands. So the first
frame compiles every material in the street with the environment map and the fog
*absent*, and the effect then makes the program cache key of every one of them
stale.

`installHaze` makes this worse and makes it more than a performance problem: it
rewrites `THREE.ShaderChunk` in place (`scene/haze.ts:100`), globally, for every
material. Every program compiled in task 2 therefore contains the *stock* fog
chunks, and every program in task 3 contains the patched ones. The first frame
the visitor could see is rendered with the wrong atmosphere, and it is only not
visible today because the veil is still up.

The evidence is not circumstantial. Of the eight large programs linked before
20 s, **seven have an exact twin linked later that is larger by 17,363
characters** (one pair differs by 17,302 and one by 17,785, being materials with
slightly different chunk sets). Grepping the dumped sources: every early
program has `#define USE_ENVMAP` and `#define USE_FOG` absent, every late one
has both. The two are otherwise textually identical.

| | programs | cost |
| --- | --- | --- |
| linked before 20 s, no envmap/fog — **discarded** | 8 | **15,090 ms** |
| linked after 20 s, with envmap/fog — used | 53 | 27,289 ms |

**Edit.** Assign the environment, background and fog *before the first render*,
not in an effect. Two places will do it:

- Inside `Street`'s existing `useMemo` (line 43), immediately after
  `makeNightEnv(gl)` returns at line 59 — the `useMemo` body runs during render,
  before r3f draws. Move the six assignments and the `installHaze` call there
  and leave the cleanup in the `useEffect` (`scene.background = null` etc. on
  unmount); only the forward direction has to move. `scene` is already in
  scope. This is the smaller edit but it is in `scene/Street.tsx`, which the
  paving pass owns.
- Or in `NightStreet.tsx`'s `onCreated`, which receives `scene` and runs before
  any frame. This needs `makeNightEnv` to be called from there rather than from
  `Street`, which is a larger structural change but keeps the edit out of the
  paving pass's file.

**Expected saving: about 15 s, measured, with no visual change at all** — the
final program set is byte-identical, only the discarded intermediate goes.

**Verify it worked** by re-running `--noinfolog --dump` and checking that no
program size has a `+17,363` twin, and that the count of large link events falls
from 75 towards 47. Do not accept "it looks faster".

### 4.2 Compile the remaining programs in parallel, off the blocking path

`KHR_parallel_shader_compile` **is present** on this adapter — the tool reports
it directly. three 0.185.1 has `WebGLRenderer.compileAsync` (`three.module.js`
line 17481); it calls `compile()`, which issues `linkProgram` for every material
in the scene without blocking, and then polls `program.isReady()`, which reads
`COMPLETION_STATUS_KHR` (line 7232) and also does not block.

Today the compiles are strictly serial: the renderer draws, hits a program it
has not used, and stalls the main thread until the driver finishes that one
program, forty-seven times. With `compileAsync` all of them are handed to the
driver at once, the driver compiles them across its own threads, and the main
thread is free the whole time.

**Edit.** In `NightStreet.tsx`:

1. Give `<Canvas>` `frameloop="never"`.
2. Add a component mounted inside the canvas that, in an effect, does
   `await gl.compileAsync(scene, camera)` and then
   `setFrameloop('always')` (`useThree((s) => s.setFrameloop)`; `Rig.tsx`
   already uses this API, so the pattern is established in the tree).
3. Have that component report progress — `compileAsync` does not expose a
   count, so either poll `renderer.info.programs.length` against an expected
   total, or replace the single `compileAsync` with a loop that calls it once
   per subsystem group and resolves five times.

**Expected saving: not yet measured, and it should be measured before it is
believed.** The floor is the single longest program, which after 4.1 is about
8.8 s; the serial total after 4.1 is about 27 s. If ANGLE's parallel compile
uses four threads the result should land somewhere near 10–14 s. If ANGLE
serialises on one compile thread the wall clock will barely move — and the win
is then only that the main thread is no longer blocked, which is still worth
having, because it is what allows a real progress bar and stops the tab being a
candidate for the unresponsive-page dialog.

**Caveat that must be checked.** `compile()` prepares beauty programs by
traversing the scene; it does not prepare the depth/shadow variants, which are
built during the shadow pass. If a material has a `customDepthMaterial` those
will still stall the first frame. Count the link events before and after.

### 4.3 Stage the scene so the first frame needs a handful of programs, not forty-seven

Once 4.1 and 4.2 are in, the remaining cost is genuine compilation of programs
that are genuinely needed, and the only way to get an interactive frame sooner
is to need fewer of them at frame one.

`Buildings.tsx`, `StreetLevel.tsx`, `Cars.tsx` and `Lighting.tsx` are each
mounted by `Street.tsx` and each own their own materials. Any of them can defer
*itself* without `Street.tsx` changing: return `null` until a shared stage
counter reaches its number.

**Edit.** New `src/scene/stage.ts` exporting a tiny subscribable counter and a
`useStage(n): boolean` hook. Each of the four components returns `null` while
`!useStage(n)`. A driver in `NightStreet.tsx` advances the counter, calling
`compileAsync` on the subtree about to be mounted and waiting for it before
advancing again. Suggested order, cheapest and most load-bearing first:

| stage | contents | programs |
| --- | --- | --- |
| 0 | road, kerb, walk, skirt, apron, sun, sky | the two road variants + paving |
| 1 | `Buildings` | wall, glass, trim, metal |
| 2 | `StreetLevel` | shop, shop glass, shutter, awning, furniture |
| 3 | `Cars` | paint, glass, wheel, shade |
| 4 | `Lighting` | lamp, neon, glow |

**Expected: time to first interactive frame becomes the cost of stage 0.** That
is currently about 8.8 s, because the road material is the most expensive
program in the scene and it is also the ground the visitor stands on. Stages 1–4
then land over the following seconds while the street is already walkable.

Note the honest limitation: this makes the street *walkable* early, it does not
make it *complete* early, and the buildings appearing at three seconds is a
visible pop. Whether that reads better than a veil is a judgement call, and it
should be looked at before it is committed to.

### 4.4 The road program is 40% of the compile budget

`scene/materials.ts` produces the two most expensive programs in the scene:
229,734 chars at 8,845 ms and 212,371 chars at 8,184 ms. After 4.1 removes the
second, one 8.8 s program remains and it sets the floor for every other
optimisation in this document.

This is the paving pass's file and this document does not propose an edit to it.

**Two claims originally made in this section were tested by the paving pass and
are false. They are corrected here rather than deleted, because both are
plausible enough to be re-derived by the next person.**

- ~~Compilation cost grows with program size, so adding to this shader costs
  roughly 40 ms of first-visit load per thousand characters.~~ **Withdrawn.**
  42.2% of the road program is comment prose — 96,992 of its 229,734
  characters. On code alone the road is 132,002 characters against car paint's
  124,301, within 6% of each other, yet they cost 8,845 ms and 1,196 ms: a
  1.06× size difference against 7.4× the compile time. Stripping the comments
  behind a URL flag (liveness confirmed first — the road left the eight-largest
  list, 229,734 to under 154k) should have bought 3.9 s at the rate above. It
  bought nothing: 35,201 and 30,519 ms with the flag on against 33,294, 35,582
  and 31,780 ms with it off, all inside run-to-run spread. **Compile cost here
  is instruction count and register pressure, not program length.** Do not trim
  a material's look to hit a character budget, and do not strip comments to buy
  load time.
- ~~`X3595 gradient instruction used in a loop with varying iteration` suggests
  hoisting texture samples out of loops or forcing `textureLod`.~~
  **Withdrawn — nothing to act on.** There are zero `texture()`, `dFdx`, `dFdy`
  and `fwidth` calls inside any loop in that fragment shader.

What actually remains: the road is a 1,793-line `main` at 96,405 characters
doing the whole material model inline. The 8.8 s is in what those lines do, and
locating it needs a bisection of `main`, not a size reduction. The paving pass
is folding that into its rewrite rather than doing it twice.

Also confirmed by that pass: the two expensive variants were the envmap/fog
twins that §4.1 has since removed, so there is no per-instance variant left to
fold, and `road`, `walk`, `kerb` and `apron` each already force a
`customProgramCacheKey`. Of the preprocessor blocks in `main` over 25 lines,
only `DEBUG_ROAD_NO_BOUNCE` (34 lines) is removable dead weight.

### 4.5 What not to do

- **Do not turn off `renderer.debug.checkShaderErrors`.** Measured; see §5. It
  saves nothing.
- **Do not optimise the bakes.** 244 ms.
- **Do not chase the JavaScript.** Summing the part of each long task that is
  not accounted for by program linking or by draws gives **859 ms** for the
  entire load, and 547 ms of that is inside task 1, which is where the geometry
  is built. Under a second, against forty-six. A CPU profile of the load will
  show you the geometry builders at the top and it will still be the wrong
  thing to work on.

---

## 5. Negative results and measurement traps

Recorded because each one cost time and each one would have been shipped as a
fix if it had not been checked.

**`getProgramInfoLog` looked like the cause and is not.** 45.9 s of the 46.4 s
of WebGL time is inside it, and three only calls it because
`scene/shaderWatch.ts:82` sets `renderer.debug.checkShaderErrors = true`
unconditionally. three's `onFirstUse` (`three.module.js:7097–7101`) fetches the
program log and both shader logs *before* it looks at `LINK_STATUS`, so the
obvious fix is to guard it. Ablated — returning an empty string from
`getProgramInfoLog` and `getShaderInfoLog` without calling through — the total
did not move: it reappeared as 46,867 ms inside
`getProgramParameter(LINK_STATUS)`. The info-log call is not the cost, it is
merely the first call that forces ANGLE to finish the deferred D3D compile.
Suppress it and the next call pays. **Turning off shader error checking would
buy nothing and would cost the project its only defence against a silently dead
program.**

**"GPU-bound" was a correct observation and a wrong inference.** Throttling the
renderer's CPU 4× really does not move the load, and that was read as GPU
execution. It is not: ANGLE's HLSL translation and the D3D compile happen in
Chrome's *GPU process*, which CDP's CPU throttling does not touch. Actual GPU
execution across the entire load is 249 ms of `drawElements`.

**`gl.finish()` does not block in Chrome.** The first version of the tool called
`finish()` after every draw to time it. Over 3,764 calls it accumulated twelve
milliseconds, while the bakes it was supposed to be waiting for demonstrably
took hundreds. Chrome forwards WebGL commands to the GPU process asynchronously.
Use `readPixels` — it has to return a value, so it waits.

**An instrument that queries GL state changes what it measures.** The first
version also called `getParameter` three times per draw to learn the bound
framebuffer, viewport and current program. Each is a synchronous round trip to
the GPU process; across the load it added roughly eighteen seconds to the number
it was measuring. Shadow the state in JavaScript by patching `bindFramebuffer`,
`viewport` and `useProgram` instead.

**Naming a program by content needs a probe that is unique.** The first attempt
took the first substantial line of each surface body in `world/surfaces.ts` as
its fingerprint, and every surface matched every other because they share their
opening lines — the report came back naming all seven bakes "asphalt". The tool
now requires a probe that appears in exactly one body and says so when a surface
has none.

**`performance.now()` is clamped to 100 µs** in a page that is not
cross-origin-isolated, so anything faster than that reads as zero. Sum a batch;
do not trust an individual sub-millisecond figure.

**Turbopack refuses a junctioned `node_modules`.** An attempt to stand up an
isolated dev server in a sibling directory with `node_modules` linked across
failed with `Symlink [project]/node_modules is invalid, it points out of the
filesystem root`. If you need an isolated server, copy `node_modules` or use a
git worktree inside the same filesystem root.

**Chrome's shader cache makes a warm reload unrepresentative.** Playwright uses
a fresh profile per launch, so `coldstart.mjs` always measures a first visit.
That is the right case for the link-from-a-timeline visitor this work targets,
but it means the tool can never be used to demonstrate an improvement by
re-running it in the same browser.

---

## 6. Why two different totals appear in this document

An in-app profiler measured first lit frame at 6.8 s and first interactive frame
at **28.7 s** against `facb599`. The external tool, run about forty minutes
later, measures the same load at **46–48 s**. Both are believed.

The most likely explanation is that the paving pass's in-flight change to
`scene/materials.ts` — a debug readout adding `gDbg`, reachable through a
negative `uFlag.z` — landed in between, and it landed in the single most
expensive program in the scene. That would be consistent with the compile cost
growing super-linearly in program size. It is a correlation across two runs, not
a controlled comparison, and it should not be quoted as a regression without
one; the honest statement is that **a change to the road shader is capable of
moving the cold start by tens of per cent, and nothing currently measures that.**

The practical recommendation: run `tools/coldstart.mjs` before and after any
change to `materials.ts`, `streetMaterials.ts`, `carMaterials.ts` or
`buildingMaterials.ts`, and treat the total `LINK_STATUS` figure as a budget.

**Two hazards found while doing exactly that, both worth knowing before you
trust a number:**

- **Another agent's edit will silently ruin your run.** Fast Refresh rebuilds
  the scene mid-load, inflating the program count to 148, 221, even 292. Gate on
  bake count and only compare runs with the same number of `readPixels` as your
  baseline (42 at the time of writing). A contaminated run does not look
  obviously wrong; it just reports a worse number.
- **Fast Refresh can preserve a `useMemo` across an edit while still running an
  effect cleanup.** The first version of the §4.1 fix therefore left the scene
  stripped of its environment after a hot reload and recompiled everything
  without it. Harmless in production, highly visible to anyone walking the
  street on a dev server, so the layout effect must re-assert rather than only
  tear down. It cannot dirty a material: three keys the program cache on whether
  an environment exists, not on which one.

---

## 7. Suggested order of work

1. ~~**§4.1**, move the environment/fog assignment ahead of the first render.~~
   **DONE** by the paving pass in `6fb36ef`. Forward assignments moved into the
   `useMemo`, teardown left in an effect. Programs linked 99 → 76, `LINK_STATUS`
   46,708 ms → 33,294 ms (repeat 35,582 ms): 11–13 s recovered against the 15 s
   predicted here. The frame is unchanged, and that is a measurement rather than
   an assertion — before-against-after is mean 0.062/255 across three stops,
   while two captures of the *same* build differ by 0.061–0.064. The animated
   dust is the floor; there is no signal above it.
2. ~~**Re-measure.** Confirm the `+17,363`-character twins are gone.~~ **DONE.**
   Of the eight largest programs dumped, every one linked on the first mount now
   has `USE_ENVMAP` and `USE_FOG` defined. Remaining duplicates are exact-size
   copies from hot reloads, not `+17,363` pairs.
3. **§4.2**, `compileAsync` with `frameloop="never"`. Unblocks the main thread
   whatever it does to the wall clock, which is what makes a truthful progress
   bar possible and lets `Gate.tsx`'s fake CSS sweep be deleted.
4. **Re-measure**, and only now decide whether §4.3 is needed.
5. **§4.3**, staged mounting, if the number after step 3 is still too high.
6. **§4.4** is a conversation with whoever owns the paving shader, not a task.

Steps 1 and 3 together are the ones with a measured or well-founded expectation.
Everything after them should be re-derived against the scene as it exists by
then, because the cloud, density and atmosphere passes will all have changed the
program set.
