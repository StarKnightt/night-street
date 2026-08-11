/* System 7 — every number, in one place.
 *
 * The engine reads this to build the graph and `tools/audio.mjs` reads the
 * same file to predict what the graph will produce, so a level that is wrong
 * here is wrong in both and shows up as a failed check rather than as silence.
 * Nothing in this file imports anything: it is loaded directly by Node, which
 * rules out the `@/` alias.
 *
 * Levels are dBFS RMS unless they say otherwise. Every generator is normalised
 * to `bufDb` when it is rendered, and the mix is then entirely in the node
 * gains, which means the tool can multiply the two together and say what each
 * source will measure at the listener without running a graph at all.
 */

/* ── Geometry ──────────────────────────────────────────────────────────────
 *
 * Copied from src/world/dims.ts rather than imported, because that module is
 * reached through the `@/` alias and this one has to load in bare Node. These
 * three numbers are the only coupling and they are all load-bearing for the
 * reverb, so if the street is ever re-proportioned they must be brought
 * across: BUILD_LINE = roadHalf + kerbDepth + walkWidth.
 */
export const GEO = {
  buildLine: 5.7,        // dims: 3.15 + 0.2 + 2.35
  canyonWidth: 11.4,     // face to face
  eyeHeight: 1.65,
  walkStartZ: 4,
  walkEndZ: -94,
  walkSpeed: 1.4,
} as const;

/* ── Buffer sample rates ───────────────────────────────────────────────────
 *
 * An AudioBuffer carries its own sample rate and the context resamples it on
 * playback, so a source with nothing above 1.5 kHz in it has no business
 * costing 48 kHz of memory. The traffic bed alone is fifty seconds of audio
 * across three layers; at the context rate that is ten megabytes, and at
 * 12 kHz it is two and a half. Each rate below is set at roughly three times
 * the highest frequency the generator actually produces.
 */
export const SR = {
  /* The bed and the AC both carry a broadband band now — the near-road tyre
   * roar and the condenser fans respectively — and a biquad corner at 4.6 or
   * 6.5 kHz needs somewhere to sit that is not four fifths of the way to
   * Nyquist, where the bilinear warping puts it somewhere other than where it
   * was asked for. Both rates went up to suit the content, which is the rule
   * this table already followed. */
  bed: 16000,
  passBy: 12000,
  horn: 16000,
  ac: 24000,
  rattle: 22050,
  step: 24000,
  bar: 8000,
  neon: 24000,
  ir: 24000,
  drift: 100,
} as const;

/* ── 1. Traffic bed ──────────────────────────────────────────────────────── */

/**
 * Three layers, and the lengths are the point.
 *
 * 13.7, 19.1 and 28.3 seconds have no common factor worth anything, so the
 * combined pattern does not repeat for over two hours — far longer than the
 * thirty-second walk, which is all that is required. Each also runs at a
 * playback rate slightly off unity, which shifts both its pitch and its period
 * and makes the recurrence irrational rather than merely long.
 *
 * The corner frequencies differ per layer because the bed is not one distant
 * road: it is the nearest arterial two streets over, the traffic on the far
 * side of the block, and the general wash of a city, and those arrive through
 * different amounts of building.
 */
/**
 * ...and the fourth layer is the road you are standing next to.
 *
 * The first three are distant and are meant to be dull; that part was always
 * right. What was missing is that a pavement beside a live road has a
 * broadband wash coming off the tarmac a couple of metres away which has not
 * travelled through anything, and it is the single largest contributor to the
 * 500 Hz to 4 kHz band in any real street recording.
 *
 * Its absence is what made the delivered mix put 95% of its energy below
 * 160 Hz and measure -35.5 dBFS above 500 Hz against -17.4 full band. That is
 * not a mix that needs tilting, it is a mix with a source missing: a phone
 * speaker reproduces almost nothing under 400 Hz, so the entire soundtrack
 * was arriving about 18 dB down on the device most of the audience uses.
 *
 * `roarDb` is the balance knob, in dB relative to the rest of that layer, and
 * it is applied after the distance filter because this road is not distant.
 */
export const BED_LAYERS = [
  { seconds: 13.7, seed: 0x4a1f, lpHz: 430, bumpHz: 108, bumpDb: 4.5, airDb: -13, rate: 0.973, gainDb: -3.5 },
  { seconds: 19.1, seed: 0x9d33, lpHz: 260, bumpHz: 78, bumpDb: 5.5, airDb: -19, rate: 1.041, gainDb: -1.5 },
  { seconds: 28.3, seed: 0xc70b, lpHz: 620, bumpHz: 143, bumpDb: 3.0, airDb: -9, rate: 0.917, gainDb: -8.0 },
  {
    seconds: 23.9, seed: 0x2e6d, lpHz: 1500, bumpHz: 165, bumpDb: 1.5, airDb: -2,
    rate: 1.013, gainDb: -4.0, roarDb: 9.0, roarLoHz: 360, roarHiHz: 4600,
  },
] as const;

/** The one place the layer options are assembled, so the engine and
 *  `tools/audio.mjs` cannot render two different beds and both pass. */
export function bedLayerOpts(L: (typeof BED_LAYERS)[number], targetDb: number = BED.bufDb) {
  return {
    seconds: L.seconds, seed: L.seed, lpHz: L.lpHz, bumpHz: L.bumpHz,
    bumpDb: L.bumpDb, airDb: L.airDb, targetDb,
    roarDb: 'roarDb' in L ? L.roarDb : undefined,
    roarLoHz: 'roarLoHz' in L ? L.roarLoHz : undefined,
    roarHiHz: 'roarHiHz' in L ? L.roarHiHz : undefined,
  };
}

export const BED = {
  /* Every continuous generator is rendered to this before any gain is
   * applied, and every one-shot to PEAK_DB below.
   *
   * Two currencies, on purpose. A bed contributes its average power to the
   * mix and its peaks mean nothing, so it is budgeted by RMS. A footstep
   * contributes its peak and its average means nothing — the first run of the
   * analysis tool caught a footstep normalised to -20 dBFS RMS peaking at
   * +1.9 dBFS, which would have been clipped before it reached a gain node. */
  bufDb: -14,
  /** Bus gain. The bed is the loudest continuous thing in the mix and it is
   *  supposed to be: a city's noise floor is not subtle, it is just dull. */
  busDb: -8,
  /** Predicted level at the listener, for the tool to check against. */
  expectDb: [-27, -21] as [number, number],
  /* Two bounds now, not one.
   *
   * The old check was `>= 90% below 500 Hz`, on the reasoning that a bed with
   * too much top has not been distance-filtered enough to be a city rather
   * than a hiss. That reasoning is sound and the check passed for weeks — and
   * the mix it was guarding was inaudible on a phone, because 90% below 500 Hz
   * turned into 98.5% once the whole street was summed and there was nothing
   * left up there for a small speaker to reproduce.
   *
   * So the floor stays, loosened for the near-road layer, and a ceiling joins
   * it. A one-sided check can only ever catch the failure it was written for,
   * and this one was written before anybody had heard the system.
   */
  minLowFraction: 0.55,
  maxLowFraction: 0.88,
  maxCentroidHz: 1250,
  /** ...and the same statement from the other end, which is the one that
   *  matters on a phone speaker. */
  minHighFraction: 0.12,
  /** Slow stereo decorrelation: the two channels use different layer phases so
   *  the bed is wide without being two different streets. */
  spreadMs: 37,
  /** ...and only above here. Decorrelating a 50 Hz wave across a human head
   *  is not a wide bed, it is a physically impossible one; below this corner
   *  both channels get the same signal. */
  spreadAboveHz: 220,
} as const;

/** Peak target for every one-shot buffer. Three dB of headroom is enough:
 *  nothing downstream of a buffer source adds gain except the bar's wall
 *  make-up, and the limiter is there for the sum. */
export const PEAK_DB = -3;

/* ── 2. Pass-bys ─────────────────────────────────────────────────────────── */

/**
 * Where the cars actually are.
 *
 * Both lanes are chosen off the block layout in src/world/block.ts. The cross
 * street is the eighteen-metre opening in the sunward frontage between
 * z = -64 and -40, so a vehicle crossing it at z = -52 is briefly visible-ish
 * and audibly less muffled; the far lane is behind the terminating wall at
 * z = -118 and never clears anything, so it stays a rumble.
 */
/**
 * Where the individual cars are, as against the general wash of the bed.
 *
 * Both lanes run *past* the walker rather than towards them, and that took a
 * failed check to get right. The first version sent a car along the cross
 * street from x = 46 to x = 6, which sounds reasonable until you notice that
 * the closest it ever gets to the walker is at the very end of its travel —
 * so the swell coincided with the fade-out and the analysis measured 5 dB of
 * rise where a passing car needs ten. A pass-by has to be symmetrical about
 * its closest approach or it is not a pass-by, it is an arrival.
 *
 * So: an arterial one street over, running parallel behind the sunward
 * frontage, and a road across the far end behind the terminating wall. Both
 * are heard through a building for their whole travel, which is what
 * `occludeHz` is: distance filtering cannot express occlusion, because forty
 * metres of clear air and forty metres with a four-storey block in the middle
 * are the same distance and nothing like the same sound.
 */
export const PASSBY_LANES = [
  { name: 'parallel', from: [22, 0.6, 12] as const, to: [22, 0.6, -108] as const, seconds: 9.0, closest: 23, speed: 13, engineHz: 44, gainDb: 2, occludeHz: 620 },
  { name: 'far', from: [58, 0.6, -114] as const, to: [-18, 0.6, -114] as const, seconds: 9.0, closest: 22, speed: 14, engineHz: 38, gainDb: 0, occludeHz: 480 },
] as const;

export const PASSBY = {
  /** Seconds between one starting and the next. */
  every: [7.5, 16.0] as [number, number],
  firstAt: [3.0, 7.0] as [number, number],
  /** How many distinct renders of each lane. Three is enough that a repeat
   *  inside one walk is unlikely and two adjacent repeats impossible. */
  variants: 3,
  maxCentroidHz: 900,
} as const;

/* ── 3. Horn ─────────────────────────────────────────────────────────────── */

/**
 * Three places a horn can come from, none of them near.
 *
 * The brief allows two or three across the walk, so the interval is set long
 * and the first one is held back past the point where the player has started
 * moving — a horn in the first second reads as a UI sound, not as a street.
 */
export const HORN_SPOTS = [
  /* Down the street past the terminating wall, so it is heard through a
   * building as well as through eighty metres of air: dull twice over, which
   * is what a horn a couple of streets away actually sounds like. */
  { name: 'downStreet', pos: [1.5, 1.1, -132] as const, occludeHz: 850 },
  /* Straight through the cross-street opening, so there is nothing in the way
   * and it stays comparatively bright even at thirty-four metres. That
   * contrast between the two is worth more than either of them alone. */
  { name: 'crossStreet', pos: [33, 1.2, -52] as const, occludeHz: 0 },
  { name: 'behind', pos: [-2.0, 1.1, 52] as const, occludeHz: 0 },
] as const;

/**
 * Horn voicings. Real twin horns are tuned to a dissonant interval on purpose;
 * these are a minor third, a major second and a minor third an octave apart in
 * character, which is about the spread you hear on one street.
 */
export const HORN_VOICES = [
  { f1: 412, f2: 494, seconds: 0.62, seed: 0x2a71 },
  { f1: 455, f2: 512, seconds: 0.41, seed: 0x5c19 },
  { f1: 372, f2: 442, seconds: 0.95, seed: 0x8f05 },
] as const;

export const HORN = {
  gainDb: -2,
  every: [11.0, 19.0] as [number, number],
  firstAt: [6.0, 10.5] as [number, number],
  /** Chance a blast is a double. Two short parps is the commonest real horn. */
  doubleChance: 0.35,
  /* Post-distance-filter limits on how much of the top survives, keyed to the
   * spot rather than fixed.
   *
   * The first version of this used one threshold for all three and failed the
   * cross-street horn for keeping 5% of its power above 2 kHz at thirty-four
   * metres — which is not a bug, it is correct: air absorption at 2 kHz over
   * thirty-four metres is a fraction of a dB and the sightline through the gap
   * is clear. What must be dull is the one that is behind a building. */
  maxHighFraction: { downStreet: 0.01, crossStreet: 0.12, behind: 0.09 } as Record<string, number>,
} as const;

/* ── 4. Footsteps ────────────────────────────────────────────────────────── */

export const STEPS = {
  /** Buffers per foot. Twelve total, times playback rate, gain and filter
   *  variation per step. */
  bankPerFoot: 6,
  /* Up from -13, and the reason is the near-road tyre roar the bed now
   * carries. The roar occupies 500 Hz to 4 kHz, which is precisely the band a
   * footstep lives in, and the first take with it measured the gait
   * autocorrelation of the mix down from r = 0.19 to r = 0.06 — the steps were
   * still there and were no longer the thing you noticed. A footstep has to
   * stay above the street it is being taken on. */
  busDb: -8,
  /** Playback rate spread. Retunes the whole step, including the transient. */
  rate: [0.93, 1.08] as [number, number],
  /** Per-step gain spread in dB, on top of the bank variation. */
  gainSpreadDb: 4.5,
  /** Per-step lowpass, which is the surface changing under the foot: a dusty
   *  flag, a worn one, the metal of a service plate. The bottom of the range
   *  was 2600 Hz, which took the heel transient off a third of the steps —
   *  and the heel transient is the only part of a footstep a phone speaker
   *  can reproduce at all. */
  lpHz: [3800, 9500] as [number, number],
  /** Feet are 0.16 m either side of the walk line and 1.65 m below the ear. */
  offset: 0.16,
  /** Below this cadence the walker is stopping and the step gets softer. */
  fullCadence: 2.0,
  /** The check the bank has to pass: steps must actually differ. */
  minCentroidSpreadPct: 8,
  minPeakSpreadDb: 2.0,
} as const;

/* ── 5. Air conditioning ─────────────────────────────────────────────────── */

/**
 * Four condensers, two buffers, four playback rates.
 *
 * The rates are the detune. One buffer at 0.907 and the same buffer at 1.114
 * are a whole tone and a bit apart, which is far enough that they never read
 * as the same machine, and the beating between two units heard at once is a
 * large part of what makes a street sound occupied.
 *
 * Positions are on the building lines from block.ts, avoiding the frontage
 * gaps: the east row is open between z = -64 and -40 and between -99 and -81,
 * and the west row has a service alley at -72.6 to -68.5.
 */
export const AC_UNITS = [
  { name: 'ac.w1', pos: [-5.52, 3.55, -12.5] as const, buf: 0, rate: 1.000, gainDb: -4.0 },
  { name: 'ac.e1', pos: [5.52, 3.90, -27.5] as const, buf: 1, rate: 0.907, gainDb: -2.0 },
  { name: 'ac.w2', pos: [-5.52, 6.45, -47.0] as const, buf: 0, rate: 1.114, gainDb: -6.0 },
  { name: 'ac.e2', pos: [5.52, 3.40, -73.5] as const, buf: 1, rate: 0.963, gainDb: -3.0 },
] as const;

export const AC_BUFFERS = [
  { humHz: 99.6, bladeHz: 41.5, seconds: 6.0, seed: 0x3311 },
  { humHz: 119.2, bladeHz: 34.8, seconds: 5.0, seed: 0x77a3 },
] as const;

export const AC = {
  busDb: -8,
  rattleGainDb: -13,
  rattleVariants: 6,
  /** Seconds between rattles on one unit. */
  rattleEvery: [2.2, 9.5] as [number, number],
  /** Do not schedule rattles for a unit further away than this; it would be
   *  filtered into inaudibility anyway and it costs two nodes an event. */
  rattleRange: 34,
  /* The ceiling was 900 Hz, which is what a condenser sounds like from inside
   * the compressor rather than from the pavement below it. The fan is the loud
   * part and the fan is a broadband rush; with it rolled off at 1.6 kHz these
   * four units contributed nothing at all to the only band a phone can
   * reproduce. */
  centroidHz: [180, 2200] as [number, number],
} as const;

/* ── 6. The bar ──────────────────────────────────────────────────────────── */

/**
 * One doorway, on the shaded row, a third of the way down the block.
 *
 * The cone is the door. A PannerNode cone pointed at +X out of a west-side
 * frontage means the music swells as the player walks across the opening and
 * falls away either side of it, which is exactly what a closed door in a wall
 * does and is much more convincing than distance attenuation alone.
 */
export const BAR = {
  pos: [-5.45, 1.25, -33.0] as const,
  /** Facing straight across the street. */
  orientation: [1, 0, 0] as const,
  coneInner: 84,
  coneOuter: 250,
  coneOuterGain: 0.28,

  bpm: 112,
  busDb: -8,
  /* Make-up gain for the wall, and it is zero.
   *
   * It was twenty-one dB for a while, on the strength of a post-wall level
   * that turned out to be an artefact: the analysis tool was applying the air
   * filter at a 15 kHz corner to a buffer sampled at 8 kHz, where the biquad
   * is far past its usable range and simply blew up. Measured properly the
   * wall costs about two and a half dB of RMS on this material and nothing
   * else, which on reflection is obvious — everything in the bar's mix is
   * already below 205 Hz, and a lowpass at 205 Hz has nothing to remove from
   * it. What the wall takes out is the *character*, not the level.
   *
   * Left here as an explicit zero rather than deleted, because the number a
   * reader will want when they ask why the bar is not quieter is this one. */
  wallMakeupDb: 0,

  /* Heard through a wall and a closed door.
   *
   * 205 Hz at 24 dB/octave is the whole trick. Above a few hundred Hz a
   * masonry wall and a fire door between them give thirty to fifty dB of
   * transmission loss, and below a hundred they give almost none, so what
   * reaches the street is the kick, the bass and nothing else — no vocal, no
   * cymbals, no sense of what the track is. The peaking filter under it is the
   * wall itself: a partition has a mass-spring resonance where it transmits
   * *better* than the mass law predicts, and putting one at 88 Hz is what
   * turns a lowpassed loop into something that sounds like it is on the other
   * side of a building. */
  wallLpHz: 205,
  wallLpPoles: 2,
  wallResHz: 88,
  wallResQ: 1.1,
  wallResDb: 5.5,
  wallHpHz: 34,

  /* And the gap under the door.
   *
   * Filtering to 205 Hz at 24 dB an octave measures at eighty-two dB of
   * rejection above 500 Hz, which is more than a real wall gives by thirty and
   * sounds like it: completely dead, with no sense of a room on the other
   * side. Every real door leaks broadband through the gap at its threshold, and
   * a few percent of it is what tells you there is a *room* in there rather
   * than a subwoofer in a cupboard. One bandpass and one gain. */
  leakHz: 1250,
  leakQ: 0.7,
  leakDb: -30,

  /** Bass notes available, in Hz. A minor pentatonic on E, low. */
  notes: [41.2, 49.0, 55.0, 61.7, 73.4, 82.4] as const,
  /** Sixteen bars of pattern before anything can repeat, and the pattern is
   *  regenerated from a running seed rather than looped. */
  patternBars: 16,
  /** Timing humanisation, seconds. */
  swingJitter: 0.009,

  maxCentroidHz: 190,
  maxHighFraction: 0.02,
  /** Transmission loss above 500 Hz, in dB. A masonry wall and a fire door. */
  tlDb: [26, 52] as [number, number],
} as const;

/* ── 7. Neon ─────────────────────────────────────────────────────────────── */

export const NEON = {
  pos: [5.48, 3.05, -19.0] as const,
  /* Deliberately almost inaudible.
   *
   * The original brief was eleven at night, when a neon buzz is one of two or
   * three things you can hear. At golden hour the tubes are only just striking
   * and there is a street full of traffic on top of them, so this sits thirty
   * dB under the bed and is only findable within a couple of metres of the
   * sign. It is here for the moment somebody walks under it, and for no other
   * reason. */
  busDb: -24,
  seconds: 2.0,
  seed: 0x6d21,
  /** Sputter events: the tube failing to hold, briefly. */
  sputterEvery: [8.0, 26.0] as [number, number],
  minCentroidHz: 900,
  /** How far under the bed it must sit, from a couple of metres away. */
  minBelowBedDb: 12,
} as const;

/* ── 8. Canyon reverb ────────────────────────────────────────────────────── */

export const IR = {
  seed: 0xb17e,
  seconds: 1.25,
  /* The walker's line is at x ~ -0.85, so the west face is 4.85 m away and the
   * east face 6.55 m. Those two distances are what set the first lateral
   * reflection times, at 28 and 38 ms, and they are the reason the reverb
   * sounds like a narrow street rather than a room. */
  nearWall: 4.85,
  farWall: 6.55,
  width: GEO.canyonWidth,
  eyeHeight: GEO.eyeHeight,
  /* Short, and shortest at the top. An eleven-metre canyon of brick and glass
   * with the sky open above it holds on to bass and lets treble go, and it
   * never rings the way an enclosed room does because most of the energy
   * simply leaves upwards. */
  rtLow: 1.15,
  rtMid: 0.85,
  rtHigh: 0.48,
  /** Energy, not RMS. See `IrOpts.energyDb` in dsp.ts for why. */
  energyDb: -1,
  returnDb: -7,
  /** RT60 tolerances the tool checks, in seconds. */
  rtTolerance: 0.22,
} as const;

/** Reverb send per bus. The bed gets none: it is already a diffuse field and
 *  convolving diffuse noise with a diffuse tail only makes it vaguer. */
export const SENDS = {
  bed: -Infinity,
  ac: -14,
  bar: -11,
  steps: -12,
  events: -8,
  neon: -18,
} as const;

/* ── Master ──────────────────────────────────────────────────────────────── */

export const MASTER = {
  gainDb: -3,

  /**
   * The master tilt, and it is small on purpose.
   *
   * The prescription that came back from the listening critique was +12 dB
   * above 500 Hz and -6 dB below 100, which is a lot of shelf to hang on a
   * finished bus — it raises whatever is up there, including the parts that
   * are up there by accident, and it does nothing for the fact that the
   * street had no near-road tyre roar and its air conditioners were rolled
   * off at 1.6 kHz. Those are fixed at source above. What is left here is the
   * last few dB of voicing, applied where a shelf is the honest tool: the
   * canyon reverb and the summed bed genuinely do pile up below 100 Hz in a
   * way no single source is responsible for.
   *
   * If this number ever has to grow back towards twelve, that is a sign a
   * source has gone quiet again and the shelf is covering for it.
   */
  tilt: {
    hiHz: 500,
    hiDb: 4.0,
    loHz: 100,
    loDb: -4.0,
    /**
     * Everything below this is summed to mono, at the very end.
     *
     * The delivered take had an L/R correlation of -0.0066 with the side
     * channel exactly as loud as the mid — two independent noise signals, at
     * every frequency including 40 to 80 Hz, where a wavelength is four to
     * eight metres and no pair of ears three inches apart could possibly
     * hear a difference. That was a synthesis artefact (three decorrelated
     * bed layers and a stereo convolution tail) and it is also the classic
     * way to lose your low end the moment anything sums to mono.
     */
    monoHz: 220,
  },

  /* A limiter, not a compressor. Everything in the mix is already levelled;
   * this exists so that a horn landing on a kick on a footstep cannot clip,
   * and it should be doing nothing at all most of the time. */
  limiter: { thresholdDb: -6, knee: 3, ratio: 12, attack: 0.003, release: 0.25 },
  /** Fade in over this many seconds after the context resumes. Audio that
   *  starts at full level on the same click that grabs the pointer is a jump
   *  scare. */
  fadeInSec: 1.6,
} as const;

/* ── Distance model ──────────────────────────────────────────────────────── */

export const PANNER = {
  distanceModel: 'inverse' as const,
  refDistance: 3.0,
  rolloffFactor: 1.15,
  maxDistance: 300,
  panningModel: 'equalpower' as const,
  /** How often the per-source air filter is retuned, in frames. Sixty times a
   *  second is pointless for a corner frequency that tracks walking pace. */
  filterEveryFrames: 6,
  /** Smoothing time for the corner frequency, seconds. */
  filterGlide: 0.09,
} as const;

/** The one function that makes distance sound like distance. Mirrors
 *  `airCutoff` in dsp.ts and is checked against it by the tool. */
export function airCutoffHz(d: number): number {
  const v = 18000 * Math.exp(-d / 26);
  return v < 220 ? 220 : v > 18000 ? 18000 : v;
}

export type StepVariation = {
  bank: number;
  rate: number;
  lpHz: number;
  gainDb: number;
  pan: number;
};

/**
 * What makes one footstep different from the next.
 *
 * Identical footsteps are the loudest tell in game audio, and a bank of
 * pre-rendered buffers alone does not fix it — twelve buffers over a
 * sixty-step walk is five repeats of each. What fixes it is that the buffer is
 * only the starting point: the playback rate retunes the whole step including
 * its transient, the lowpass changes what the flag under the foot is made of,
 * and the gain follows how hard the walker is going. The product is a space
 * far larger than a walk can exhaust.
 *
 * Extracted here rather than left inline in the engine so `tools/audio.mjs`
 * can render two dozen steps through the same randomisation and *measure*
 * that they differ, rather than taking the claim on trust.
 */
export function stepVariation(rng: () => number, foot: number, effort: number): StepVariation {
  const r = STEPS.rate;
  return {
    bank: Math.min(STEPS.bankPerFoot - 1, Math.floor(rng() * STEPS.bankPerFoot)),
    rate: (r[0] + rng() * (r[1] - r[0])) * (0.96 + 0.08 * effort),
    lpHz: STEPS.lpHz[0] + rng() * (STEPS.lpHz[1] - STEPS.lpHz[0]),
    gainDb: (rng() - 0.5) * STEPS.gainSpreadDb + 20 * Math.log10(Math.max(1e-3, effort)),
    pan: (foot & 1 ? 1 : -1) * 0.17,
  };
}
