/* The route table.
 *
 * Fixed in a file rather than passed in on the command line, for the same
 * reason shoot.mjs's six stops are fixed: a motion defect is a difference
 * between two builds, and two builds can only be differenced if they walked
 * the same way.
 *
 * It lives here rather than inside reel.mjs because two tools walk it now.
 * The picture is captured off the wall clock, one frame of simulated time at a
 * time; the audio cannot be, because Web Audio schedules against the device
 * clock and has no equivalent of step(dt), so tools/audiotake.mjs walks the
 * same route again at real speed and records the master bus. Those two passes
 * are only the same walk if they read the same numbers, and a route copied
 * into a second file is a route that will be edited in one of them.
 *
 * `look` is a list of [second, yaw, pitch] keyframes in radians, interpolated
 * with a smoothstep and *delivered through walker.look()* as a pixel delta, so
 * the steering exercises the same code the mouse does. `keys` is what is held
 * down for the whole shot; `hold` is [key, fromSec, toSec] for keys pressed
 * and released partway through, which is how the sprint shot gets its
 * acceleration and deceleration ramps into the same take as the steady jog.
 */
export const SHOTS = [
  {
    /* Nobody moves.
     *
     * The control, and the only way to separate shimmer from parallax. Every
     * region difference in a moving shot is dominated by the camera having
     * travelled 47 mm since the last frame, so a large number there means
     * nothing on its own. With the camera parked and the simulation still
     * being stepped, whatever is left is the scene moving by itself: dust,
     * traffic, any animated shader, and the sensor grain. A noise model keyed
     * only to gl_FragCoord contributes exactly zero here and a temporally
     * independent one contributes its full amplitude, which makes this shot a
     * direct test of which one is installed. */
    name: 'static',
    t: 0.34,
    seconds: 3,
    keys: [],
    look: [[0.0, 0.05, -0.10]],
  },
  {
    /* The deliverable: 40.7 m in one take. Down the west footway inside the
     * light, off the kerb, diagonally across the carriageway as the shade line
     * sweeps past, and on down the crown of the road to the neon corner.
     *
     * It starts 26 m further down the street than the cut it replaces, and the
     * reason is arithmetic rather than taste. The sun is at 4.2 degrees, so a
     * 4 m frontage throws a 54 m shadow, and `world/block.ts` derives the only
     * two stretches of ground that see the disc at all from the gaps in the
     * sunward row: z -49..-32 and z -84..-73. The old route started at z = +2
     * and spent its first 33 m inside that shadow. Three independent
     * instruments say the same thing about it: the whole-frame mean in
     * `shots/v4/reel.json` is flat at 0.19 until t 14 and only reaches 0.45 at
     * t 20; the near-footway region climbs 40 -> 200 counts over the same
     * seconds; and the atmosphere pass counted under 30 dust pixels per frame
     * until 8 s. A third of the take was dead and the best of it was over by
     * 25 s.
     *
     * What this one does per second, measured off `shots/heroE/reel.json`:
     *
     *   .358 .414 .409 .438 .410 .361 .345 .346 .347 .345 .339 .333 .328 .312
     *   .299 .261 .231 .220 .212 .208 .206 .205 .208 .214 .221 .233 .233 .244
     *   .243 .247
     *
     * against 0.246 falling to 0.205 and back to 0.299 for the best of the
     * alternatives. It opens at nearly twice the old take's brightness, holds
     * above 0.30 for fourteen seconds, and then goes to evening — which is the
     * right shape for a clip somebody scrolls past, and is also just what the
     * hour does.
     *
     *   t 0-6    z -22, west footway. Lit paving in the near field at a
     *            grazing 4.2 degrees, the shade line laid across it, the sun
     *            in the shop glass
     *   t 6-14   off the kerb — a 145 mm drop the collider resolves, the only
     *            vertical move in the clip — and diagonally across the road,
     *            following the light rather than walking out of it. This is
     *            where the wet carriageway and the sun glow between the
     *            buildings are, and it is the best twenty metres in the scene
     *   t 14-18  onto the crown, the cross street open to the east
     *   t 18-26  into the shadow and the evening half: the pharmacy cross,
     *            then BAR / COLD BEER, the signal head at z -61.6 facing back
     *            up the street, OPEN 24 HRS and the van at -63.5 opposite
     *   t 26-30  past the corner with the neon still in frame
     *
     * Where the air is decided the route as much as where the light is, and
     * the two turn out to be the same place: the shaft that lights the paving
     * is the shaft the motes are in. `node tools/airtime.mjs heroE
     * heroEnodust` — two driven captures differing only in `?haze=nodust`,
     * differenced frame for frame — counts 70 dust pixels per frame averaged
     * over the take, peaking at 200, with 53% of the clip carrying 30 or more.
     * The same measurement on the alternative route gives 20, peak 123, 26%.
     * And `tools/air.mjs` puts the persistence at 5.05 px against the 76.5 px
     * that the same number of points thrown down at random would give, so the
     * air is a field of objects and not the grade's grain — which at the same
     * threshold contributes 10 px per frame, an order of magnitude less.
     *
     * The crossing is steered, not strafed. `walker` has no head-body
     * decoupling, so yaw *is* lateral travel: 0.43 rad from t 6.5 to t 13 is
     * the 5 m from the building line to the crown, at a 25 degree turn away
     * from the street axis, which is what somebody crossing a road does with
     * their head. It lands in the 1.81 m corridor between the van's east flank
     * at x = -0.81 and the east-kerb hatches at x = +1.00.
     *
     * Four earlier drafts are in `tools/route.mjs`, which traces a candidate
     * through `scene/collide.ts` in a second and reports what is around it as
     * well as what is near it. heroB went straight down the crown and never
     * got lit paving into the near field. heroC tried to reach the road on too
     * little yaw and was still on the footway at t 30. heroD is the one this
     * beat. And the first draft of heroA drifted 0.82 m left on an unpaired
     * glance and jammed head-on into the back of the van for four and a half
     * seconds. None of that cost a capture slot.
     *
     * `node tools/route.mjs heroE`: 40.7 m travelled, closest approach 0.477 m
     * to the building line at t 4, nothing touched. */
    name: 'walk',
    /* `t` only decides where `goTo` drops the walker before `place` moves it,
     * and it is set to the same stretch of street so the ground type under it
     * does not change between the two. 0.347 is z = -30 on `pathAt`. */
    t: 0.265,
    /* 0.70 m off the shopfronts on the west footway. The kerb-side strip here
     * carries the sign post at (-3.73, -25.5), so the lane between it and the
     * building line is the way through, and the route holds x = -5.05 until it
     * turns off. */
    place: [-5.00, -22.0],
    seconds: 30,
    keys: ['KeyW'],
    /* Small, paired, zero-mean yaw, and the pairing is not a stylistic
     * preference — the walker steers where it looks, with no decoupling of
     * head from body, so every radian of glance is also lateral travel. An
     * unpaired 0.07 rad held for four seconds is 390 mm across a 1.81 m
     * corridor, and the first cut of this route drifted 0.82 m left on exactly
     * that and jammed head-on into the back of the van at z = -61.0 for four
     * and a half seconds. `tools/route.mjs` found it in under a second.
     *
     * Positive yaw is left. The mean is biased very slightly right so the walk
     * opens the sunward side of the street as it goes, and the pitch lifts
     * from -0.04 to -0.012 over the last five seconds, which is what walking
     * back into the light looks like from inside a head. */
    look: [
      [0.0, 0.020, -0.050],
      [4.0, 0.000, -0.045],
      [6.5, -0.430, -0.045],
      [13.0, -0.430, -0.040],
      [16.0, -0.060, -0.045],
      [20.0, -0.020, -0.035],
      [24.0, 0.020, -0.035],
      [27.0, 0.045, -0.028],
      [30.0, 0.030, -0.015],
    ],
  },
  {
    /* The deliverable, third cut: lit, shade, lit.
     *
     * `walk` and `walkF` are both compositionally backwards, and the number
     * that says so is an exposure, not a dust count. Median luminance on the
     * delivered frames peaks at 125.8 at t 3.5 and falls monotonically to 43.4
     * by t 29.3; the final second contains no highlight of any kind — nothing
     * clips, and the brightest of two million pixels is 227. That is not a
     * golden-hour photograph, it is an underexposed dusk frame, and it is the
     * real reason the ending "stopped rather than arrived". Holding on it, as
     * walkF does, holds on a shot with no light in it.
     *
     * `tools/route.mjs` had been printing the cause all night: 43% of the take
     * is inside a sun band and every second of it falls between t 8 and t 21.
     * `block.ts` lights z -49..-32 and z -84..-73, and the old route ran -22
     * to -62.7 — it stops 10.3 m short of the second band. Same 42 m walk,
     * started 18.5 m further down the street, and the arc inverts:
     *
     *   t 0-6.2    inside sun band 1 from the first frame. Direct sun on the
     *              carriageway, the motes lit instead of shadow-gated off, and
     *              a sunlit estate sliding out of the left of frame
     *   t 6.2-23.3 the shade middle — which is where the neon belongs. The
     *              pharmacy cross at -52, the signal at -61.6, BAR / COLD BEER
     *              at -65.26 and the bar's warm glazing at -67.88 all fall
     *              inside it. Neon in shade is a better shot than neon in sun,
     *              so the dim third is spent on the only emitters in the scene
     *              rather than on empty shadowed road
     *   t 23.3-30  into sun band 2 and staying there. The hatch at -76.3 is
     *              the one parked car in the scene with direct sun on it and
     *              the shade line lies across its bonnet; the vacant lot opens
     *              the east side to the sky; the saloon at -96.4 sits in the
     *              haze to give the far end of the street a known size
     *
     * It ends walking. heroF was built around releasing KeyW and letting the
     * walker coast to rest, and `Walker.update` does not do that: with
     * `input.forward` at zero the direction vector is zeroed before `speed` is
     * applied, so translation stops in one frame while the bob and cadence
     * wind down over the next 0.35 s. A trace shows z frozen to four decimals
     * with `speed` still reading 0.98 m/s — a step from 23 mm of optical flow
     * per frame to zero, and a third of a second of foot slide in a walk that
     * measures 0.2% over 85 footfalls. That wants a change to walker.ts and
     * walker.ts is not a 5 a.m. edit. What arrives at the end here is light.
     *
     * Lateral: starts 0.80 east of the crown so the west-kerb row — estate at
     * -42.6 and supermini at -47.55, nose to tail with 700 mm between the
     * bumpers — is 1.8 m away rather than 0.7 m, which keeps the car with the
     * see-through wheel arch and the two-cuboid mirror out of the opening
     * frame and lets it leave to the left as a sunlit shape. Then west across
     * the second half, because the east kerb carries both hatches: the closest
     * approach on the whole route is 0.631 m to the one at -70. Every yaw is
     * paired, because the walker steers where it looks. */
    name: 'walkG',
    t: 0.265,
    place: [0.80, -33.5],
    seconds: 30,
    keys: ['KeyW'],
    look: [
      [0.0, 0.000, -0.045],
      [3.0, 0.030, -0.045],
      [7.0, 0.050, -0.038],
      [11.0, -0.025, -0.030],
      [14.0, -0.055, -0.022],
      [17.0, 0.045, -0.020],
      [20.0, 0.090, -0.026],
      [23.0, 0.045, -0.030],
      [26.0, 0.020, -0.024],
      /* Left, not straight, for the last four seconds. The sunlit hatch at
       * -76.3 is the only parked car in the scene with direct sun on it and it
       * is worth having in the closing frames — but the walk finishes level
       * with its tail, so on a heading of zero its far end sits 18% of a
       * half-width right of centre and reads as a pale wedge across the corner
       * rather than as a car. Seven hundredths of a radian left puts it at 73%
       * out, where it is a foreground edge, and swings the west frontage in:
       * that side carries the lit shopfronts and the OPEN neon, which as of
       * a0eb6f5 has a colour instead of clipping to white. It also opens the
       * clearance on the hatch from 0.77 m to 1.1 m. */
      [28.0, 0.055, -0.018],
      [30.0, 0.070, -0.010],
    ],
  },
  {
    /* walkG, but it arrives: the same walk with the last 2.6 s at rest.
     *
     * Identical to `walkG` for 27.2 s — same start, same keys, same look table
     * up to 26 — and then KeyW is released and nothing else happens. That
     * matters for more than tidiness: the footfalls up to the release are the
     * same footfalls, so an audio take cut against one route is still in step
     * with the other for everything except the run-down.
     *
     * Why the stop is here and not on a sign. The obvious ending is the BAR /
     * COLD BEER blade, and `walkF` below does exactly that. It cannot be had on
     * this route, and the reason is geometric rather than a matter of taste.
     * The blade hangs at (5.16, -65.26); to sit at a sane 0.5 rad off the
     * street axis the camera has to rest about 10 m short of it, near z -55.
     * The sun bands are z -49..-32 and z -84..-73. Anywhere the blade is
     * well framed is in the shaded middle, and anywhere in the light has
     * already walked past it. The whole point of this recut was to end in the
     * sun, so the sign loses.
     *
     * So the subject is the light, and the rest point is chosen off the
     * measured arc rather than by eye. Mean frame luminance along this route
     * plateaus from about z -71 to z -74 — 84.1, 85.8, 84.5 at t 27, 28, 29 —
     * so there is a three-metre window where stopping costs nothing. Release
     * at 27.2 plus 0.16 m of coast rests the camera at z -71.5, the near end
     * of it.
     *
     * The near end, specifically, because of what is on the east kerb. The
     * sunlit hatch spans z -78.5..-74.1 and it is the only car in the scene
     * with direct sun on it, which also makes it the only one that will hold a
     * two-second look. From the rest point its rear corner is 2.6 m out at 65%
     * of a half-width right and its far end is 7 m out at 26%, so it sits
     * whole, inside the right third, with the shade line across it. Resting
     * three metres further on — which the luminance would equally allow — puts
     * the camera level with its tail, and then a car whose wheel arch is
     * see-through and whose mirror is two cuboids is a wall down the right of
     * the frame for the last two seconds. Same light, quarter of the quality.
     *
     * The camera settles rather than turning. `walkF` swings 0.39 rad onto its
     * sign because there is a sign; here a turn of that size would either
     * centre the weakest asset in the shot or throw away the sunlit road, so
     * the tail drifts 0.028 rad and lifts to level, which reads as a head
     * coming to rest. The arrival is carried by the deceleration — `speed`
     * decaying at 9 per second, the stride shortening with it, the bob winding
     * out — and by the last 1.5 s being two identical keyframes, so the camera
     * is numerically still and the dust, the signal and the grain are the only
     * things left moving. That is a held shot rather than a freeze, and it is
     * the only invitation this clip makes to look at the paving instead of at
     * motion. */
    name: 'walkH',
    t: 0.265,
    place: [0.80, -33.5],
    seconds: 30,
    /* Empty, with KeyW in `hold`: releasing a key partway is the whole shot. */
    keys: [],
    hold: [['KeyW', 0, 27.2]],
    look: [
      [0.0, 0.000, -0.045],
      [3.0, 0.030, -0.045],
      [7.0, 0.050, -0.038],
      [11.0, -0.025, -0.030],
      [14.0, -0.055, -0.022],
      [17.0, 0.045, -0.020],
      [20.0, 0.090, -0.026],
      [23.0, 0.045, -0.030],
      [26.0, 0.020, -0.024],
      /* The look leads the release by 400 ms, because that is the order the two
       * happen in: you see the thing, then you stop. Almost all of the 0.26 rad
       * is spent after the walker is at rest, so it is a head turning and not a
       * steer — the walker steers where it looks, and the whole swing displaces
       * the rest point by 40 mm.
       *
       * West, onto the frontage, and this was measured rather than guessed:
       * `restlook` holds this rest point at three headings for six seconds
       * each. Level, the sunlit hatch is a dark mass across the bottom right,
       * because the flank facing the camera is its shaded side — the one car in
       * the scene with sun on it is the one thing at this rest point that does
       * not read as sunlit, and two still seconds is an invitation to stare at
       * the asset with the see-through wheel arch. Pitched up trades the near
       * paving for haze and keeps the car. A quarter of a radian west puts the
       * car's near corner outside the half-width, leaves it as a corner weight,
       * and fills the frame with the thing this clip is actually claiming:
       * sunlit stucco, shopfront glazing with reflections in it, fire escapes,
       * and eight metres of procedural paving running diagonally out of the
       * bottom of the frame.
       *
       * It is not brighter, and that is the cost of the hold rather than of the
       * heading. Measured on the three test framings, the turn is very slightly
       * up on both counts — p50 72 against 69, p99 185 against 182 — but the
       * walking ending reaches p99 229, because it carries on another 3.8 m and
       * the haze glow at the end of the street grows as you approach it. Almost
       * all of that gap is the two metres given up to stop in, not the heading.
       * Mean and p90 are flat from z -71 to z -74, so the trade is a small area
       * of very bright pixels against a still frame with the paving, the
       * glazing and the air in it. */
      [26.8, 0.035, -0.018],
      [28.6, 0.298, -0.002],
      [30.0, 0.298, -0.002],
    ],
  },
  {
    /* The deliverable, second cut: the same walk, but it arrives.
     *
     * `walk` above is 40.7 m of correct street that stops mid-stride between
     * two parked cars, and its last frame is the weakest in the take. That is
     * the worst place on a timeline for a weak frame: a clip is judged twice,
     * once in the first second and once on whatever is on screen when the
     * viewer decides whether to reply or keep scrolling. This cut is identical
     * for 25.9 s and then does one thing — it stops and looks at the bar.
     *
     * Nothing about the stop is animated. KeyW is released at 26.2 and
     * `walker.update` does the rest: speed decays with a 111 ms time constant,
     * so the walker coasts 155 mm and is at rest by 27.0; the bob amplitude is
     * scaled by smoothstep(pace / 1.4), so the stride shortens and the head
     * settles from 1.6366 m to 1.6417 m with its vertical velocity going to
     * zero rather than stepping to it; and the cadence term falls with the
     * pace, so the last footfall lands where a last footfall would. The camera
     * arrives at rest the way a person does. This is the collision and gait
     * work being spent on something other than not walking into a car.
     *
     * The head turn *leads* the release by 300 ms, because that is the order
     * the two happen in — you see the thing, then you stop. Over two seconds
     * it swings 0.39 rad right and lifts 0.155 rad onto the BAR / COLD BEER
     * blade. A projecting blade is the right sign to end on and that is not
     * luck: `world/neon.ts` hung it perpendicular to the frontage precisely
     * because "the elevation of a street the camera walks down is edge-on in
     * every frame", so its lettered jambs face back up the road at the camera.
     *
     * The aim is deliberately *off* the sign. From the rest point, `node
     * --experimental-transform-types tools/aim.mjs 0.672 -57.414` puts the
     * blade at yaw -0.519, pitch 0.249, 9.0 m out; the camera holds -0.380 /
     * 0.125. At fov 45 on 16:9 — half-angles 0.635 and 0.393 — that leaves the
     * blade 22% of a half-width right of centre and 32% of a half-height up,
     * the bar's warm glazing just right of centre, the signal head at 65% out
     * to the right, and the street axis still 60% of the way to the left edge
     * with the sun glow at the end of it. The subject of the last frame is the
     * street; the neon is what the eye lands on inside it. Centring the sign
     * would throw the road away and make it a photograph of a sign.
     *
     * The final 2.1 s are two identical keyframes, so the camera is not merely
     * slow but numerically still. Two reasons. Platforms lift a poster frame
     * from near the end of a clip, and a still camera is the only invitation
     * this thirty seconds makes to look *at* the paving, the air and the
     * letterforms instead of at motion — which is the whole claim being made.
     * What still moves in those two seconds is the dust, the signal aspect on
     * its own clock, and the grain. That is the difference between a held shot
     * and a freeze. */
    name: 'walkF',
    t: 0.265,
    place: [-5.00, -22.0],
    seconds: 30,
    /* Empty, with KeyW in `hold` instead: `hold` is the only way to release a
     * key partway through, and the release is the shot. */
    keys: [],
    hold: [['KeyW', 0, 26.2]],
    look: [
      [0.0, 0.020, -0.050],
      [4.0, 0.000, -0.045],
      [6.5, -0.430, -0.045],
      [13.0, -0.430, -0.040],
      [16.0, -0.060, -0.045],
      [20.0, -0.020, -0.035],
      [24.0, 0.020, -0.035],
      [25.9, 0.010, -0.030],
      [27.9, -0.380, 0.125],
      [30.0, -0.380, 0.125],
    ],
  },
  {
    /* The last four seconds of `walkF`, from a standing start.
     *
     * A framing is worth one capture slot to check and thirty seconds of walk
     * to check the slow way. This parks the walker on the rest point `node
     * tools/route.mjs heroF` reports — 0.672, -57.414, which is where the
     * release at 26.2 plus 155 mm of coast puts it — and plays only the turn.
     * 120 frames at 720p instead of 1800 at 1080p.
     *
     * It is not a substitute for the take: it starts at rest, so it says
     * nothing about whether the settle reads. It answers the one question that
     * is expensive to get wrong, which is what is in the last frame. */
    name: 'endbeat',
    t: 0.265,
    place: [0.672, -57.414],
    seconds: 5,
    keys: [],
    look: [
      [0.0, 0.010, -0.030],
      [2.0, -0.380, 0.125],
      [5.0, -0.380, 0.125],
    ],
  },
  {
    /* Three framings of `walkH`'s rest point, six seconds each, to settle an
     * argument the still frames could not.
     *
     * Holding at z -71.5 puts the sunlit hatch in the right of the frame, and
     * on paper that is the best subject available: the only car in the scene
     * with direct sun on it. In the frame it is the near flank that faces the
     * camera and the near flank is the shaded side, so it reads as a dark mass
     * across the bottom right rather than as a sunlit car — and two still
     * seconds is an invitation to look straight at the one asset that cannot
     * take it. So the question is whether turning off it recovers the hold, or
     * whether the hold is simply the wrong idea on this route.
     *
     * a: what walkH does now, level and slightly left.
     * b: 0.25 rad further left, which puts the hatch's near corner outside the
     *    half-width and leaves the west frontage, its glazing and the paving.
     * c: level but pitched up 0.06, trading near paving for the haze glow at
     *    the end of the street and the roofline. */
    name: 'restlook',
    t: 0.265,
    place: [-0.12, -71.5],
    seconds: 18,
    keys: [],
    look: [
      [0.0, 0.048, -0.002],
      [5.5, 0.048, -0.002],
      [6.0, 0.298, -0.002],
      [11.5, 0.298, -0.002],
      [12.0, 0.048, 0.058],
      [18.0, 0.048, 0.058],
    ],
  },
  {
    /* The walk the collider makes available: one that leans on things.
     *
     * The shot above is hand-routed around every solid object on the street,
     * because when it was cut that was the only option — there was no
     * collision anywhere in the walker and the route was the only thing
     * keeping the camera out of a parked car. It took three attempts. This one
     * goes the other way and aims to make contact, because a scene that claims
     * to be walkable has to be seen to be walked rather than flown through:
     *
     *   t 3.5   up over the kerb from the carriageway, a 145 mm step
     *   t 6.5   the near side of the fire hydrant at z = -7.0, 300 mm off its
     *           centre, which is 106 mm inside it — the shoulder catches and
     *           the slide puts the walker round it
     *   t 20    squeezing between the kerb and hatch B's door mirror, which
     *           pushes the walker off the kerb and down into the gutter
     *   t 23    out across the carriageway
     *
     * Nothing is aimed dead centre. A head-on contact with a post is an
     * unstable equilibrium — the tangential part of the contact is exactly
     * zero — so the walker stands against it until it is steered, which is
     * what a person walking into a hydrant does and is no use as a shot.
     *
     * **`--dry` flags this shot and is wrong about it.** It reports 0.50 s
     * within a body radius of the hatch at z = -25.4, closest 0.169 m. That is
     * the mirror squeeze, and the mirror is why: `obstacles.mjs` carries the
     * car bodies only, and a door mirror stands 150 mm proud of the flank at
     * 0.97 m. The walker is resting on the mirror at exactly one body radius,
     * which puts it 169 mm off the *flank* — clear of everything that is
     * actually there and inside a table that does not know the mirror exists.
     * `scene/collide.ts` derives both from `carSolids()` and reports no
     * penetration anywhere on this route.
     *
     * Designed against `node tools/collide.mjs route`, which traces this same
     * route through the same `Walker` in a second.
     */
    name: 'brush',
    t: 0,
    place: [-2.50, 2.0],
    seconds: 30,
    keys: ['KeyW'],
    look: [
      [0.0, 0.000, -0.05],
      [1.0, 0.000, -0.05],
      [3.2, 0.330, -0.06],
      [5.0, 0.000, -0.05],
      [8.0, 0.000, -0.06],
      [13.0, -0.030, -0.05],
      [18.0, 0.010, -0.06],
      [23.0, -0.320, -0.07],
      [27.0, -0.050, -0.05],
      [30.0, 0.000, -0.05],
    ],
  },
  {
    /* The same walk, stepped eight times finer than it is played.
     *
     * This is the instrument for "does anything shimmer that a still cannot
     * show". In the ordinary walk the camera travels 47 mm between frames, so
     * every region difference is dominated by parallax and a large number
     * means nothing. Stepping at 1/240 s moves it 5.8 mm instead. Real image
     * content cannot change much over 5.8 mm, so the frame-to-frame difference
     * should fall by roughly the same factor of eight. Anything that does not
     * fall — a specular highlight flicking on and off between samples of a
     * surface finer than a pixel, a shadow edge crawling on the map's own
     * lattice, a moire beat on a window grid — is aliasing rather than motion,
     * and the ratio is the measurement.
     *
     * Framed at the near road and the gutter deliberately: at 4.2 degrees
     * those are the grazing-specular surfaces, and grazing specular on a wet
     * surface is where this class of defect lives. */
    name: 'creep',
    t: 0.30,
    seconds: 4,
    dt: 1 / 240,
    keys: ['KeyW'],
    look: [[0.0, 0.10, -0.30]],
  },
  {
    /* Walk, jog, walk, in one take.
     *
     * The pace change is the stress test: stride length, cadence, bob
     * amplitude and the closing rate on geometry all move together, so a term
     * derived wrongly from any of the others is two millimetres of error at
     * 1.4 m/s and six at 3.1. The two ramps are in shot on purpose — a gait
     * model that is right at both ends and wrong in between shows up nowhere
     * else.
     *
     * Kept out of the deliverable cut. A thirty-second video of a photoreal
     * street is a walk; this is a diagnostic. */
    name: 'sprint',
    t: 0.10,
    /* Biased to the crown of the road. The corridor between the two kerb-side
     * rows of parked cars is only about 1.5 m wide and a jog crosses it in
     * half a second, so the lane matters more here than it does at a walk. */
    place: [0.55, -5.8],
    seconds: 18,
    keys: ['KeyW'],
    hold: [['ShiftLeft', 4.0, 14.0]],
    look: [
      [0.0, 0.00, -0.05],
      [5.0, 0.05, -0.07],
      [11.0, -0.05, -0.04],
      [18.0, 0.00, -0.06],
    ],
  },
  {
    /* Straight through a parked car, and straight through a lamp column.
     *
     * "Are there collision pops near cars and street furniture" cannot be
     * answered by a route that never goes near any: the first cut of this reel
     * passed no closer than 3.42 m to a lamp and its nearest car was across
     * the carriageway. So these two aim at the objects deliberately. The hatch
     * in `world/cars.ts` is centred at x = -1.945, z = -25.40; the lamp column
     * from `world/dims.ts` stands at x = -4.30, z = -45. Both shots start
     * eight metres short of their target on a heading that goes through it.
     *
     * `place` bypasses the walk path, because the path's lateral drift is the
     * one thing that would stop the walker arriving at a specific x. */
    name: 'car',
    t: 0,
    place: [-1.945, -18.0],
    seconds: 8,
    keys: ['KeyW'],
    look: [[0.0, 0.0, -0.12], [8.0, 0.0, -0.16]],
  },
  {
    name: 'lamp',
    t: 0,
    place: [-4.30, -37.0],
    seconds: 8,
    keys: ['KeyW'],
    look: [[0.0, 0.0, -0.10], [8.0, 0.0, -0.14]],
  },
  {
    /* Straight at the kerb, then along it. The walker has no ground-height
     * term and no collider, so this is the shot that shows what the eye does
     * when the surface under it changes by 145 mm. Short, because it is a
     * diagnostic and not part of the cut. */
    name: 'kerb',
    t: 0.30,
    seconds: 8,
    keys: ['KeyW', 'KeyD'],
    look: [
      [0.0, 0.00, -0.16],
      [4.0, 0.55, -0.20],
      [8.0, 0.55, -0.20],
    ],
  },
];
