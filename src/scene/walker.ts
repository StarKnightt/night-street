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
    if (len > 1e-4) { vx /= len; vz /= len; } else { vx = 0; vz = 0; }

    const running = !!input.sprint && input.forward > 0;
    const target = len > 1e-4 ? (running ? SPRINT_SPEED : DIMS.walkSpeed) : 0;
    /* A person reaches walking pace in about a third of a second, and slows
     * down faster than they speed up. Breaking into a jog over the same lag
     * takes about 0.6 s to get most of the way to 3.1 m/s, which is roughly
     * right and, more importantly, is slow enough that the gait model above
     * has time to lengthen the stride rather than the pace arriving before the
     * stride does. */
    this.speed += (target - this.speed) * Math.min(1, dt * (target > this.speed ? 7 : 9));

    this.x += vx * this.speed * dt;
    this.z += vz * this.speed * dt;

    // Stay on the paved world; the buildings that would really stop you are
    // System 2, so this is a soft bound rather than collision.
    const limit = DIMS.roadHalf + DIMS.kerbDepth + DIMS.walkWidth - 0.4;
    this.x = clamp(this.x, -limit, limit);
    this.z = clamp(this.z, DIMS.zMin + 12, DIMS.zMax - 4);

    this.advanceGait(dt);
  }

  /** Run the gait without any wall-clock time passing, for the harness. */
  warp(seconds: number, step = 1 / 60) {
    for (let t = 0; t < seconds; t += step) this.advanceGait(step);
  }

  private advanceGait(dt: number) {
    /* One step is PI of phase, and a step covers stepLength(speed) metres, so
     * the number of steps per second is speed / stepLength. At 1.4 m/s that is
     * exactly 2.00 and the phase rate is exactly 2*PI, as it was before; at
     * 3.1 m/s it is 2.75, which is a jog and not a sprint on a treadmill. */
    const cadence = Math.PI * (this.speed / stepLength(this.speed));
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
    const runU = clamp((this.speed - V_WALK) / (V_RUN - V_WALK), 0, 1);
    const walkU = clamp(this.speed / V_WALK, 0, 1);

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
    this.eye.y = DIMS.eyeHeight + bobY;
    this.eye.z = this.z - sin * sway;
  }

  look(dx: number, dy: number, sensitivity = 0.0022) {
    this.yaw -= dx * sensitivity;
    this.pitch = clamp(this.pitch - dy * sensitivity, -1.35, 1.2);
  }
}
