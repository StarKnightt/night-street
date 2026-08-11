/* First-person walker.
 *
 * Deliberately dull: a person walking down a street at 1.4 m/s and looking
 * around. No sprint, no jump, no acceleration curves worth the name. The only
 * things here that need any care are the ones a camera actually shows.
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
};

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

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

    const target = len > 1e-4 ? DIMS.walkSpeed : 0;
    // A person reaches walking pace in about a third of a second.
    this.speed += (target - this.speed) * Math.min(1, dt * 7);

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
    // Two steps per second at full pace, scaled by how fast we are going.
    const cadence = 2.0 * Math.PI * (this.speed / DIMS.walkSpeed);
    this.phase += cadence * dt;
    if (this.phase > Math.PI * 2) this.phase -= Math.PI * 2;

    const steps = Math.floor(this.phase / Math.PI);
    if (steps !== this.lastStep) {
      this.lastStep = steps;
      this.onFootstep?.(steps & 1);
    }

    const amp = this.speed / DIMS.walkSpeed;
    // Skewed vertical: fast rise over the stance leg, slower fall.
    const p2 = this.phase * 2;
    const bobY = (Math.sin(p2) + 0.28 * Math.sin(p2 * 2 - 0.7)) * 0.0125 * amp;
    // Lateral sway is at half the vertical rate — one sway per stride.
    const sway = Math.sin(this.phase) * 0.019 * amp;

    this.roll = -Math.sin(this.phase) * 0.0085 * amp;

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
