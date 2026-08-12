# The prompts this was built from

Every prompt below is reproduced verbatim from the conversation that produced
this repository, lowercase and typos included. Nothing has been cleaned up or
made to sound more considered than it was, because a tidied prompt is a
reconstruction and the point of publishing these is that they are not.

There are five that matter. The first is the brief. The second changes the time
of day and therefore the whole project. The remaining three are art direction
against screenshots, which is most of what the back half of the build actually
consisted of.

What is *not* here is the volume of everything else — the "keep cooking", the
"how much time left", the scheduling, the request to close the dev server
because it was costing frames in Valorant. Those are omitted as noise, not
because they were rewritten.

---

## 1. The original brief

Monday, 10 August, 1:09 PM. This is the whole of what the project started from.
Note the last line of §"How to build this": the build order and the blind-critic
loop below were followed, and the constraint against parallel sub-agents was
relaxed later in the build, the same way it was on
[jungle-trail](https://github.com/StarKnightt/jungle-trail).

> # Photorealistic City Street at Night — Gauntlet Prompt
>
> I want you to build a first-person walkable city street at night. It should look like a real photograph taken on a phone camera at 11 PM. Not stylized. Not low-poly. Not a game. A photograph.
>
> The player walks forward slowly down one street. No turns, no choices. Just a straight walk through a city block at night.
>
> Do this in Three.js. Zero external assets. Every texture, every mesh, every light, every sound must be generated procedurally in code. No downloaded images, no HDRIs, no audio files.
>
> ## What the street needs
>
> Buildings on both sides. Not skyscrapers, just 3-5 story buildings with windows. Some windows lit warm yellow, some dark. Random pattern. The buildings should have fire escapes, ledges, AC units on walls, slight variation in height and width. Not copy-pasted boxes.
>
> Street level: shopfronts with awnings, closed roller shutters on some, a lit convenience store or bar with warm light spilling onto the sidewalk. Trash bags next to a dumpster. A fire hydrant. Street signs. Traffic lights cycling through colors.
>
> The road: asphalt with lane markings, slight wet sheen even without rain. Parked cars along the curb. Not detailed car models, just convincing dark shapes with reflective windows and tail lights.
>
> Lighting is everything:
> - Street lamps casting warm orange cones of light on the sidewalk
> - Neon signs on buildings (a bar sign, a pharmacy cross, an "OPEN" sign)
> - Window light bleeding onto the street
> - A distant glow on the horizon from the rest of the city
> - Car tail lights and headlights from a parked car with lights on
> - The blue-white flicker of a TV visible through one apartment window
>
> Atmosphere:
> - Light fog or haze that catches the light sources and creates glow
> - Volumetric light cones from the street lamps
> - Slight bloom on bright light sources
> - Dark shadows between buildings
> - Sky is not black, it's that deep dark blue-orange city sky from light pollution
>
> Sound:
> - Distant traffic hum
> - Occasional car horn far away
> - AC unit buzzing
> - Muffled music from the bar
> - A flickering neon sign buzzing
> - Footstep sounds on concrete as you walk
>
> ## How to build this
>
> Work on ONE system at a time in this exact order. Do NOT fan out multiple sub-agents in parallel. Build each system sequentially:
>
> 1. Road and sidewalk geometry with lane markings and curbs
> 2. Buildings — facades, windows, fire escapes, rooftop shapes, variation
> 3. Street-level details — shopfronts, awnings, shutters, dumpster, hydrant, signs
> 4. Parked cars — simple but convincing silhouettes with reflective surfaces
> 5. Lighting — street lamps, neon signs, window glow, traffic lights, car lights
> 6. Atmosphere — fog, volumetric light cones, bloom, city sky glow
> 7. Sound design — procedural ambient city sounds
> 8. Post-processing — color grading, depth of field, film grain, vignette
>
> For each system: build it, then spawn ONE separate sub-agent as a harsh visual critic. The critic should compare the result against real nighttime city photography (think NYC side street, Tokyo backstreet, London alley). Rate whether it looks like a real photo taken on a phone. If it doesn't, keep iterating before moving to the next system. The critic must never be the same agent that built it. It should only see the rendered output, not the code.
>
> /loop on each system until the critic says it genuinely looks like a real nighttime photograph, not a render. Then move to the next system.
>
> ## The test
>
> Screenshot the final result. Show it to someone without context. If they think it's a photo before they realize it's a browser, you're done. If they immediately think "3D render" or "game," keep going.
>
> ## Tech constraints
>
> - Next.js App Router, React, TypeScript, Tailwind CSS, Three.js via React Three Fiber
> - Zero external assets. Every texture is procedural (noise, patterns, gradients)
> - Target 30+ FPS on a mid-range GPU (RTX 4060 level)
> - First-person slow walk, no sprint, no jump
> - Mouse look, WASD movement
> - The walk is short — one city block, maybe 30 seconds of walking
>
> Don't stop until walking this street feels like watching a dashcam video, not playing a video game.
>
> ## Reference and inspiration
>
> Previous project that set the bar (jungle trail with Xbox CTO PR):
> - C:\Code\jungle-trail
>
> Three.js skill files for techniques and patterns:
> - https://github.com/cloudai-x/threejs-skills
> - https://github.com/majidmanzarpour/threejs-game-skills
> - https://github.com/dgreenheck/webgpu-claude-skill
> - Browse more at https://skills.sh
>
> Study these for procedural geometry, lighting, post-processing, and performance patterns. The jungle trail project is the quality bar. This city must match or exceed it.
>
> and read the cursor global skills file too, so that it won't my system, best of luck

---

## 2. The golden hour pivot

Monday, 10 August, 6:20 PM — five hours in, with the road, the buildings and
the first street-level pass already standing. The project is called
`night-street` because of the prompt above and it is not a night street because
of this one.

> change the time of day from night to golden hour evening. keep all the geometry and street layout. replace the dark sky with a sunset gradient (warm gold-orange near horizon, soft blue-purple above). change the main light source from street lamps to a low-angle golden sun casting long shadows. buildings on the sun side should be lit warm orange, shadow side should be cool blue. street lamps should be just starting to turn on. add warm haze and dust particles catching the sunlight.

This is a much larger instruction than it reads as. Nearly every constant in the
lighting, sky, atmosphere and grading systems is a function of the sun's
elevation, and the original brief had specified a scene with no sun in it at
all. The whole of the "night" tuning — the sodium levelling, the light-pollution
sky, the volumetric cones sized against a dark ambient — became the wrong
answer in one message. `scene/sun.ts` and its argument about the elevation
trade exist because of this pivot, and two of the bugs written up in the
README's post-mortems are constants that were derived under the old sun and did
not move with it.

Six and a half hours later, one more line, tagged optional:

> don't forget to add shift button so that it can run faster lol (optional)

Sprint is in, at 3.1 m/s, and it turned out to be a measuring instrument as
much as a control — the gait model's terms scale together with speed, so an
error that is invisible at a 1.4 m/s walk is obvious at a sprint.

---

## 3. The three post-ready fixes

Wednesday, 12 August, 10:59 AM, sent with a screenshot attached. This is the
first of the art-direction passes and the one that produced the cloud decks.

> **the street looks good but it's not post-ready. three fixes needed, do them in this order:**
>
> **1. sky — this is the biggest problem. the sky is a flat gradient with nothing in it. add procedural clouds. not cartoon clouds. volumetric-looking scattered clouds catching the golden hour light. warm orange on the bottom, cooler purple-pink on top. look at real golden hour photography for reference. the sky should take up half the frame and look beautiful on its own.**
>
> **2. street density — the right side of the street feels empty after the first building. add more buildings, shopfronts, awnings, and signs on both sides all the way down. fire hydrants, trash bags, newspaper boxes, AC units on walls. the street should feel lived-in, not abandoned. the jungle worked because every pixel had something in it. this street needs the same density.**
>
> **3. atmospheric haze — there's some haze but it needs more. golden dust particles catching the sunlight between buildings. light shafts where the sun hits gaps between buildings. more bloom on the sun-facing surfaces. the haze softens the hard edges on the cars and buildings and makes everything feel more photographic.**
>
> **do NOT touch the lighting, road texture, or building geometry that already works. only add to what's there. after each fix, screenshot and compare against real golden hour city photography. if it still looks like a game, keep going.**

Point 2 is why `world/placement.ts` is a single table with two consumers and a
walkable corridor booked before anything is placed. The first attempt at
"lived-in" put down 175 individually plausible props and sealed the near footway
completely.

---

## 4. The three follow-up fixes

Wednesday, 12 August, 12:18 PM. Same session, next screenshot.

> **three fixes left, do them in order:**
>
> **1. street lamps — every street lamp on both sides needs to be ON. warm orange glow from each lamp head. each lamp should cast a visible cone of light onto the sidewalk and road below it. the light pools should overlap slightly so the street feels lit, not dark. think real sodium street lamps at dusk when they first click on.**
>
> **2. golden hour warmth — the sun-facing side of the street is too dark right now. the left side buildings should be lit warm orange-gold from the low sun. right now the whole scene reads as post-sunset. push the sun angle and intensity back to where the hero shot was. buildings on the sun side should glow, shadow side should be cool blue. that warm/cool contrast is what makes golden hour photography work.**
>
> **3. duplicate BAR signs — the BAR COLD BEER neon sign appears multiple times down the street. keep it on one building only. vary the other shopfronts with different signs: laundry, deli, liquor store, tattoo. each shopfront should feel like a different business.**

Point 1 is the re-levelling of the lamps from 78 to 329 candela, which is
written up in the README as an illustration of a whole bug class: the lamp's
derivation was scale-free by design, but the skylight it was set against had
been measured when the sun was at 4.2 degrees, and the divisor moved when the
sun did.

Point 3 is now a test. `tools/signcount.mjs` exits non-zero if the street ever
advertises the same bar twice.

---

## 5. The car pass

Wednesday, 12 August, 6:20 PM, after "are you working on car models or not btw
like they doesn't look finished at all". This is the most specific prompt in the
project and the one that most obviously reads as somebody looking hard at a
picture.

> yeah the car is the weakest part right now. flat colors, no detail, blocky rear end, tail lights look like painted rectangles. needs a focused pass.
>
> the cars need a full material and detail pass. right now they look like clay models. fix these specifically:
>
> 1. paint material — cars need a glossy clearcoat finish that reflects the golden hour sky and surroundings. not matte, not flat color. real car paint has a base color layer plus a clear reflective layer on top. the reflection of the sunset sky on the car hood and roof is what sells it.
>
> 2. windows — windshield and side windows should be dark tinted glass that reflects the sky and buildings. right now they look like solid panels. add slight transparency so you can barely see headrests inside.
>
> 3. tail lights and headlights — these need to be recessed, not flat squares. red translucent material for tail lights with a slight glow. chrome or clear housing around them. headlights should be off but have a reflective lens.
>
> 4. wheels — add depth to the rims. right now they're flat circles with painted spokes. darken the tire rubber, add slight rubber texture, make the rim metallic and reflective.
>
> 5. body lines — add panel gaps between doors, hood, trunk. a thin dark line where panels meet. add door handles, side mirrors, and a subtle body crease line along the side. these small details are what make the brain read it as a real car instead of a shape.
>
> 6. ground contact — add a subtle shadow underneath the car and darken the area where the tires meet the road. right now the car looks like it's floating.
>
> do NOT change car positions or the number of cars. only improve materials and geometry detail on existing cars.

The cars went from something around 80,000 triangles to 114,466, in the same
four draw calls, and the argument for spending it is in the README: every one of
those is a *silhouette* feature, and a silhouette cannot be bought with a
texture. Point 6 produced the analytic ground-contact decal — the one whose
quads were wound backwards, which meant the road under the cars was
bit-identical with it on and off, and which is the cleanest example in the
project of a term measuring exactly 1.000 against its own control.

---

## What the prompts do not show

Two things worth saying plainly, because the list above flatters the process.

**The brief asked for a photograph and did not get one.** The test it sets —
show it to someone without context, and if they say "3D render" keep going — has
not been passed. What is in the repository is a render that is honest about
which of its parts hold up and which do not, and the README's "what is not good
enough yet" section is longer than most of these prompts.

**Almost none of the hard work is visible in the prompts.** "add procedural
clouds" is eleven words and three horizontal deck shells with a twelve-tap
scattering march. Nearly everything technically interesting in the repository —
the shadow box rolled along the street, the probe convolved from the same shader
as the background, nine-octave veiling glare, inverting target display values
through the measured AgX curve — was never asked for by name. It came out of the
critic loop and out of measuring things that looked fine.
