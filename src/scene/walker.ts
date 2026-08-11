/* First-person walker.
 *
 * Deliberately dull: a person walking down a street at 1.4 m/s and looking
 * around. No jump and no acceleration curves worth the name. The only things
 * here that need any care are the ones a camera actually shows.
 *
 * Shift breaks into a jog at 3.1 m/s. That is not a movement feature so much
 * as a test instrument: stride length, cadence, bob amplitude and the rate at
 * which the camera closes on geometry all change together, so any of them
 * being derived wrongly from the others shows up at 3.1 m/s while staying
 * within a couple of millimetres of invisible at 1.4.
 *
 * The bob is the important one. A handheld night photograph is taken by
 * somebody standing still, but a *walk* down a street is read by the viewer
 * from the vertical rise and fall of the horizon and the small roll that goes
 * with the weight transfer. Get the amplitude wrong in either direction and
 * it reads as either a floating camera or a drunk. Real head displacement
 * while walking is about 25 mm peak to peak vertically at roughly two steps
 * per second, and it is *not* a sine — the head rises fast over the stance
 * leg and falls slower, so the vertical term is skewed.
 */
import { DIMS } from '@/world/dims';
import { slide, groundHeight } from './collide';

export type Input = {
  forward: number;   // -1..1
  strafe: number;    // -1..1
  /** Shift. Only honoured while pushing forward — nobody sprints backwards. */
  sprint?: boolean;
};

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

/* Jog pace.
 *
 * 3.1 m/s is 11.2 km/h — a person hurrying, not an athlete. The scene is a
 * photoreal street and the deliverable is a video someone is meant to believe;
 * anything faster turns the walk into a first-person shooter and the haze,
 * which is tuned for a 1.4 m/s reading of depth, starts to arrive too quickly
 * to read.
 */
export const SPRINT_SPEED = 3.1;

/* Step length against ground speed, and the reason there is no foot slide.
 *
 * Cadence is derived from step length here, not the other way round. The
 * previous model advanced the gait at 2 steps per second scaled linearly by
 * speed, which holds step length at a constant 0.70 m at every pace: correct
 * at a walk by construction, and at 3.1 m/s it is a 4.4 Hz shuffle with the
 * stride of a stroll. Anchoring the *length* instead and dividing means the
 * contact rate always equals distance over step length whatever the speed is,
 * including all the way through the acceleration ramp, so the feet cannot
 * slide relative to the ground at any pace.
 *
 * Two measured anchors, and the line through them: 0.70 m at 1.4 m/s is a
 * normal adult walking step, 1.13 m at 3.1 m/s a normal jogging one. The line
 * is exact at both, so the walk's cadence is unchanged to the last digit from
 * what the existing capture archive was shot at.
 */
const V_WALK = DIMS.walkSpeed, STEP_WALK = 0.70;
const V_RUN = SPRINT_SPEED, STEP_RUN = 1.13;
const STEP_SLOPE = (STEP_RUN - STEP_WALK) / (V_RUN - V_WALK);
const STEP_BASE = STEP_WALK - STEP_SLOPE * V_WALK;
/** Metres per step at a given ground speed. */
const stepLength = (v: number) => Math.max(0.30, STEP_BASE + STEP_SLOPE * v);

/* Where in the step the head is lowest, in step-phase radians after the
 * footfall event that `onFootstep` reports.
 *
 * The centre of mass keeps descending through heel strike and bottoms out in
 * double support, roughly a tenth of a step later — 0.70 rad of the 2*PI that
 * one step spans. This constant exists because the waveform below did not have
 * it: its own minimum sits 1.10 rad *before* the footfall, so the head was
 * reaching its lowest point about a third of a step early, which is a bob
 * running to its own clock rather than to the gait. Set it to WALK_W_MIN to
 * get the old registration back.
 */
const BOB_TROUGH = 0.70;
/** The walk waveform's own minimum, solved numerically off the expression. */
const WALK_W_MIN = -1.10;

/* Contact rounding on the running profile.
 *
 * A run is ballistic between footfalls, so the vertical profile is |sin| — a
 * rounded apex and a cusp where the foot lands. The cusp is wrong, and not
 * subtly: it is a corner, so the vertical head velocity reverses in zero time
 * and the peak acceleration is whatever the sample rate says it is. Measured
 * off this model at 30, 120 and 480 Hz it went 35, 138 and 540 m/s², which is
 * the signature of a waveform with no second derivative rather than of a hard
 * landing. On a 30 fps video it is a snap at the bottom of every stride.
 *
 * Real contact is spread over the stance phase, so the absolute value is
 * rounded parabolically inside |s| < RUN_K and left exactly alone outside it.
 * 0.30 rounds over about a tenth of a step, 35 ms at jog pace, and brings the
 * peak head acceleration to a converged 20 m/s² — two g at contact, which is
 * what a jogger's head actually sees.
 */
const RUN_K = 0.30;
const softAbs = (s: number) => {
  const a = Math.abs(s);
  return a >= RUN_K ? a : (s * s + RUN_K * RUN_K) / (2 * RUN_K);
};
/* Normalised once, to zero mean and a peak-to-peak of 2, so the profile can be
 * interpolated against the walk waveform without stepping the eye height as
 * the pace changes. */
const RUN_MEAN = (() => {
  let s = 0;
  const N = 2048;
  for (let i = 0; i < N; i++) s += softAbs(Math.sin((i / N) * Math.PI));
  return s / N;
})();
const RUN_SCALE = 2 / (softAbs(1) - softAbs(0));
/** Vertical profile of a run: minimum at u = 0, apex at u = PI. */
const bounce = (u: number) => (softAbs(Math.sin(u * 0.5)) - RUN_MEAN) * RUN_SCALE;

/* Climbing a kerb.
 *
 * The ground under this street is not flat anywhere: the carriageway cambers
 * 85 mm from the crown and dishes another 38 mm into the gutter, the footway
 * falls 31 mm across its width and settles per flag, and between the two there
 * is a 145 mm granite face. Before this the eye sat at a constant 1.6503 m on
 * the road and 1.6494 m on the footway — nine tenths of a millimetre apart
 * across a step that is a hundred and sixty times that.
 *
 * A kerb is not a ramp and it is not a teleport either. What actually happens
 * is that the swing leg lifts, the body vaults over it, and the head arrives
 * at the new height over roughly one step — fast enough to read as a step up
 * rather than as a slope, slow enough that the horizon does not jump. So the
 * raw ground height is not used directly. It goes through a one-pole lead,
 * which is what rounds the corner at the top and the bottom of the face, and
 * then a critically damped spring, which is what gives the rise its shape and
 * guarantees it does not overshoot — a camera that bobs up past a kerb and
 * settles back down reads as a stumble.
 *
 * The two constants are set from the measured profile rather than by eye. At
 * TAU = 0.050 s and W = 19 rad/s, crossing the kerb at 1.4 m/s takes 222 ms
 * from 10 to 90 per cent of the step, peaks at 0.68 m/s of vertical head speed
 * and 12.6 m/s² of vertical acceleration, and overshoots by a tenth of a
 * millimetre — which is to say not at all. For scale, the same walker's own
 * footfall peaks at 4.0 m/s² walking and 20.5 jogging, so the kerb lands
 * between the two: three times the event that a footstep at a walk is, and
 * still lighter than a footfall at pace. Mid-climb the eye is as much as
 * 129 mm below the surface the feet are on, which is what a step is.
 *
 * Both terms are needed. The lead is what keeps the acceleration finite: a
 * spring alone, given a step, opens with infinite jerk and its measured peak
 * acceleration is then whatever the sample rate is. With the lead in front of
 * it the largest one-frame change in eye height falls 0.45, 0.13, 0.033,
 * 0.028 m/s at 30, 120, 480 and 1920 Hz — a converging sequence, which is a
 * curve rather than a corner.
 */
const GROUND_TAU = 0.050;
const GROUND_W = 19;

export class Walker {
  x = 0;
  z: number = DIMS.walkStartZ;
  yaw = 0;
  pitch = 0;
  /** Gait phase in radians; one full step is PI. */
  phase = 0;
  /** Smoothed forward speed, used to scale the bob in and out. */
  speed = 0;

  eye = { x: 0, y: DIMS.eyeHeight as number, z: DIMS.walkStartZ as number };
  roll = 0;

  /* The ground the eye is actually standing on, filtered. `groundY` is what
   * eye height is measured from; `groundRaw` is the surface under the feet
   * this instant, and the two differ only while a step is being climbed. */
  groundY = 0;
  groundV = 0;
  private groundLead = 0;
  /** What the last resolved move ran into, or null. Read by the tools. */
  contact: string | null = null;
  /** How much of the pace the ground is taking: 1 free, 0 pressed into a car. */
  private stall = 1;
  /** Unit heading of the last commanded move, held through the run-down. */
  private headX = 0;
  private headZ = 0;

  constructor() {
    this.snapGround();
  }

  /** Put the eye on the ground here with no transition. For teleports. */
  snapGround() {
    this.groundY = this.groundLead = groundHeight(this.x, this.z);
    this.groundV = 0;
  }

  /** System 7 hooks in here. Called once per footfall with 0 or 1 for the foot. */
  onFootstep: ((foot: number) => void) | null = null;
  private lastStep = 0;

  /**
   * Where the block runs. `t` is normalised arc length, which for a straight
   * street is just distance, and the small lateral drift keeps the six capture
   * stops from being six photographs of the same composition.
   */
  pathAt(t: number): { x: number; z: number } {
    const z = DIMS.walkStartZ + (DIMS.walkEndZ - DIMS.walkStartZ) * t;
    const x = -0.85 + Math.sin(t * 5.1) * 0.62 + Math.sin(t * 1.7 + 0.9) * 0.35;
    return { x, z };
  }

  placeAt(t: number) {
    const p = this.pathAt(t);
    this.x = p.x;
    this.z = p.z;
    /* A stop is a fixed number in a table and nothing stops one of them being
     * inside a car, so a teleport resolves before it settles. Zero motion
     * through the same solver runs its depenetration pass and nothing else. */
    const s = slide(this.x, this.z, 0, 0);
    this.x = s.x; this.z = s.z;
    this.snapGround();
    // Sync the eye immediately: a teleport that leaves the derived camera
    // position a frame behind is how a harness ends up photographing the
    // previous stop.
    this.advanceGait(0);
    return this;
  }

  update(dt: number, input: Input): void {
    const cos = Math.cos(this.yaw), sin = Math.sin(this.yaw);
    // -Z is forward when yaw is zero.
    let vx = (-sin * input.forward + cos * input.strafe);
    let vz = (-cos * input.forward - sin * input.strafe);
    const len = Math.hypot(vx, vz);
    /* Let go of the key and the body keeps its heading while the pace runs out.
     *
     * `speed` already decelerates properly — it is the same smoothed term the
     * acceleration ramp uses, and the gait is anchored to it, so a falling pace
     * shortens the stride and slows the cadence with no foot slide. None of
     * that was reaching the ground. Translation was `direction * speed`, and
     * direction came straight from the input, so releasing forward multiplied
     * the whole thing by zero: 1.4 m/s to a dead stop between one frame and the
     * next, while the gait wound down over the next tenth of a second and the
     * feet took two more steps on the spot. Deceleration was modelled and then
     * gated out of existence.
     *
     * Keeping the last heading is the whole fix. `speed` decays at 9 per
     * second, so the walk coasts 0.16 m over about 0.3 s and stops — short of a
     * real pedestrian's half metre, but a curve rather than a corner, which is
     * the difference that shows.
     *
     * This cannot disturb anything already shot. Every capture to date holds
     * KeyW for the whole take, `len` is above the epsilon on every frame of
     * them, and the branch below is never taken. */
    if (len > 1e-4) {
      vx /= len; vz /= len;
      this.headX = vx; this.headZ = vz;
    } else {
      vx = this.headX; vz = this.headZ;
    }

    const running = !!input.sprint && input.forward > 0;
    const target = len > 1e-4 ? (running ? SPRINT_SPEED : DIMS.walkSpeed) : 0;
    /* A person reaches walking pace in about a third of a second, and slows
     * down faster than they speed up. Breaking into a jog over the same lag
     * takes about 0.6 s to get most of the way to 3.1 m/s, which is roughly
     * right and, more importantly, is slow enough that the gait model above
     * has time to lengthen the stride rather than the pace arriving before the
     * stride does. */
    this.speed += (target - this.speed) * Math.min(1, dt * (target > this.speed ? 7 : 9));

    const x0 = this.x, z0 = this.z;
    const moved = slide(this.x, this.z, vx * this.speed * dt, vz * this.speed * dt);
    this.x = moved.x;
    this.z = moved.z;
    this.contact = moved.hit;

    /* The building line is a solid now, and stops the body centre at exactly
     * this value; the clamp is the backstop for the ends of the street, which
     * are not, and for anything the solver could not resolve. */
    const limit = DIMS.roadHalf + DIMS.kerbDepth + DIMS.walkWidth - 0.4;
    this.x = clamp(this.x, -limit, limit);
    this.z = clamp(this.z, DIMS.zMin + 12, DIMS.zMax - 4);

    /* How much of the pace the ground actually took, 1 free and 0 stopped.
     *
     * The gait runs on `speed * stall` and the body runs on `speed`, and they
     * have to be separate. Feeding the achieved pace back into `speed` was
     * tried twice and is wrong both ways round. Assigned, it is a pop: `speed`
     * scales the bob, so meeting a car flank collapsed the vertical amplitude
     * from 12.5 mm to zero inside one frame and the eye jumped — 0.45, 0.43,
     * 1.48, 5.67 m/s of one-frame eye movement at 30, 120, 480 and 1920 Hz,
     * which is a step in the one term the gait model exists to keep smooth.
     * Fed in as a target it is worse and quieter: sliding along a wall at an
     * angle achieves `speed * cos t`, which becomes the next target, which
     * achieves `speed * cos^2 t`, and a walker leaning along the building line
     * coasts silently to a halt over a couple of seconds. Neither shows up in
     * a still and both show up in a walk.
     *
     * As a separate factor neither happens. Free of contact the achieved pace
     * *is* `speed`, so `stall` is exactly 1 and every number the gait produces
     * is bit for bit what it was — the 0.2 per cent of foot slide measured
     * over 85 footfalls is untouched. Sliding along a flank it settles at the
     * cosine, so the cadence matches the ground speed and the feet still do
     * not slide. Pressed square into a car it goes to zero over about 110 ms,
     * so the stride winds down and the camera settles instead of freezing
     * mid-bob or striding on the spot.
     */
    const want = this.contact && dt > 1e-6 && this.speed > 1e-4
      ? clamp(Math.hypot(this.x - x0, this.z - z0) / dt / this.speed, 0, 1)
      : 1;
    this.stall += (want - this.stall) * Math.min(1, dt * (want > this.stall ? 7 : 9));

    this.advanceGait(dt);
  }

  /** Run the gait without any wall-clock time passing, for the harness. */
  warp(seconds: number, step = 1 / 60) {
    for (let t = 0; t < seconds; t += step) this.advanceGait(step);
  }

  /* One-pole lead into a critically damped spring, integrated in closed form.
   *
   * Closed form rather than a Euler step because the frame loop hands out
   * deltas of up to 50 ms and this runs at W = 19: an explicit integrator at
   * W*dt = 0.95 is still stable but its rise is visibly different from the
   * same filter at 8 ms, which would make the kerb feel one way in the
   * interactive walk and another in a 30 fps capture. The exact solution of
   * `y'' = -2W y' - W^2 (y - L)` has no such dependence, and the driven
   * capture path and the live one then produce the same profile to five
   * decimal places from the same key presses.
   */
  private followGround(dt: number) {
    if (dt <= 0) return;
    const raw = groundHeight(this.x, this.z);
    this.groundLead += (raw - this.groundLead) * (1 - Math.exp(-dt / GROUND_TAU));

    const w = GROUND_W;
    const e = Math.exp(-w * dt);
    const c1 = this.groundY - this.groundLead;
    const c2 = this.groundV + w * c1;
    const s = c1 + c2 * dt;
    this.groundY = s * e + this.groundLead;
    this.groundV = (c2 - w * s) * e;
  }

  private advanceGait(dt: number) {
    this.followGround(dt);

    /* The pace the ground is actually seeing. Identical to `speed` unless the
     * walker is in contact with something, and `stall` is exactly 1 until it
     * is, so nothing below this line changes for a walk in the open. */
    const pace = this.speed * this.stall;

    /* One step is PI of phase, and a step covers stepLength(pace) metres, so
     * the number of steps per second is pace / stepLength. At 1.4 m/s that is
     * exactly 2.00 and the phase rate is exactly 2*PI, as it was before; at
     * 3.1 m/s it is 2.75, which is a jog and not a sprint on a treadmill. */
    const cadence = Math.PI * (pace / stepLength(pace));
    this.phase += cadence * dt;
    if (this.phase > Math.PI * 2) this.phase -= Math.PI * 2;

    const steps = Math.floor(this.phase / Math.PI);
    if (steps !== this.lastStep) {
      this.lastStep = steps;
      this.onFootstep?.(steps & 1);
    }

    /* How far past a walk we are, 0 at 1.4 m/s and 1 at 3.1. Everything below
     * is anchored at the walk values and interpolated from there, so nothing
     * about the walk changes. */
    /* Smoothstepped, not clamped.
     *
     * A bare clamp has a corner at each end, and a corner in a term that
     * multiplies the bob is a step in the head's vertical *velocity* the
     * instant the pace crosses it. It is invisible at 30 Hz and unmistakable
     * when sampled harder: accelerating into the jog, the peak vertical head
     * acceleration at the moment the speed passed 1.4 m/s read 20, 26, 56 and
     * 187 m/s² at 120, 480, 960 and 3840 Hz, doubling with the rate the way
     * only a discontinuity can, while the steady-state jog sat at a converged
     * 20.5 at every one of them. The kink is at runU = 0, where the profile
     * blend starts to move; smoothstep takes the slope to zero at both ends
     * and leaves the values at the ends, so the walk and the jog are bit for
     * bit what they were and only the ramp between them changes. */
    const ease = (u: number) => u * u * (3 - 2 * u);
    const runU = ease(clamp((pace - V_WALK) / (V_RUN - V_WALK), 0, 1));
    const walkU = ease(clamp(pace / V_WALK, 0, 1));

    /* Vertical amplitude. 25 mm peak to peak at a walk and about 70 at a jog:
     * running is a series of controlled falls and the head really does move
     * nearly three times as far, which is most of what distinguishes the two
     * from inside the eyes. */
    const ampY = lerp(0.0125, 0.0350, runU) * walkU;
    /* Lateral sway and roll go the other way. Running feet land closer to the
     * midline than walking feet, so side-to-side head travel *falls* from
     * about 38 mm to about 16 mm. Scaling every term up together is the usual
     * way a run ends up reading as a camera being shaken. */
    const ampX = lerp(0.0190, 0.0080, runU) * walkU;
    const ampR = lerp(0.0085, 0.0045, runU) * walkU;

    const p2 = this.phase * 2;
    /* Two vertical profiles, blended by pace, and both registered so that
     * their minimum falls BOB_TROUGH radians after the footfall.
     *
     * Walking is an inverted pendulum vaulting over the stance leg: a fast
     * rise and a slower fall, which the second harmonic supplies. Running is
     * ballistic — the head is in free flight between contacts — so the profile
     * is a bounce with a rounded apex and a much sharper bottom, which is what
     * `bounce` is. Interpolating between the two is what stops the jog looking
     * like the walk played at 2.2x. */
    const uW = p2 - BOB_TROUGH + WALK_W_MIN;
    const walkY = Math.sin(uW) + 0.28 * Math.sin(uW * 2 - 0.7);
    const bobY = lerp(walkY, bounce(p2 - BOB_TROUGH), runU) * ampY;

    // Lateral sway is at half the vertical rate — one sway per stride.
    const sway = Math.sin(this.phase) * ampX;
    this.roll = -Math.sin(this.phase) * ampR;

    const cos = Math.cos(this.yaw), sin = Math.sin(this.yaw);
    this.eye.x = this.x + cos * sway;
    this.eye.y = this.groundY + DIMS.eyeHeight + bobY;
    this.eye.z = this.z - sin * sway;
  }

  look(dx: number, dy: number, sensitivity = 0.0022) {
    this.yaw -= dx * sensitivity;
    this.pitch = clamp(this.pitch - dy * sensitivity, -1.35, 1.2);
  }
}
