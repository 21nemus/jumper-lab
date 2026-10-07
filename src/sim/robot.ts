// The kinematic walking controller (GAME APPROXIMATION, labelled as such in the UI).
//
// What is real: the joint tree, axes and limits (jumper.xml), the calibrated standing pose and height
// (HOME, STAND_Z), the stance footprint those give, and the gait groupings upstream documents. What is ours:
// speeds, step timing, swing heights and the foothold planner. There is no physics: feet that are planted
// stay exactly where they were put (so they cannot skate), the body follows the command, and every limb is
// solved by IK inside its joint limits.

import { clearFoothold, CORE_R, resolveRobot, ROBOT_R, type Contact, type Course } from './course.ts';
import { allPlanted, fivePattern, footPhase, stanceTime, swingLift, swingTime, swingTravel, TRIPOD, type GaitPattern } from './gait.ts';
import { footChain, solveFoot, type FootChain } from './limb.ts';
import { applyT3, clamp, rpyToMat3, sub, type Mat3, type Vec3 } from './math.ts';
import { ARMS, LEGS, type Leg, type RobotModel } from '../robot/model.ts';

/** Player command, each axis in [-1, 1]: forward, left (crab walk), turn left. */
export interface Command {
  fwd: number;
  left: number;
  turn: number;
}
export const NO_COMMAND: Command = { fwd: 0, left: 0, turn: 0 };

/** GAME APPROXIMATION: top speeds per gait (m/s, rad/s). Not hardware figures. */
export const SPEEDS = {
  tripod: { fwd: 0.2, left: 0.15, turn: 0.85 },
  five: { fwd: 0.1, left: 0.07, turn: 0.5 },
} as const;
const ACCEL = { lin: 0.55, ang: 2.4 };
/** Longest distance a planted foot may travel relative to the body during one stance (m). */
const STRIDE_MAX = 0.068;

export interface FootState {
  planted: boolean;
  p: Vec3; // contact-site position in the world
  from: Vec3; // where the current swing started
  target: Vec3; // where it will land
}

export interface RobotState {
  x: number;
  y: number;
  yaw: number;
  z: number;
  roll: number;
  pitch: number;
  v: [number, number, number]; // body-frame vx, vy, wz
  q: number[]; // 22 joint angles, wire order
  phase: number;
  active: boolean;
  pattern: 'tripod' | 'five';
  carrier: 'LF' | 'RF' | null;
  feet: Record<Leg, FootState>;
  lift: number; // extra body height requested by the claw (m)
  wobble: { t: number; nx: number; ny: number } | null;
  locked: boolean; // the claw owns the robot (grasping / releasing): no walking
}

export interface StepEvents {
  contacts: Contact[];
  bumped: boolean;
  touchdowns: Leg[];
  ikError: number; // worst distance between a foot's planned position and where its limb reaches (m)
}

export class RobotController {
  readonly model: RobotModel;
  readonly chains: Record<Leg, FootChain>;
  /** Contact-site position of each foot in the body frame at HOME. */
  readonly nominal: Record<Leg, Vec3>;
  readonly standZ: number;

  constructor(model: RobotModel) {
    this.model = model;
    this.standZ = model.json.standZ;
    this.chains = {} as RobotController['chains'];
    this.nominal = {} as RobotController['nominal'];
    for (const leg of LEGS) {
      this.chains[leg] = footChain(model, leg);
      this.nominal[leg] = this.chains[leg].chain.fk(model.home).p;
    }
  }

  pattern(s: RobotState): GaitPattern {
    return s.pattern === 'five' && s.carrier ? fivePattern(s.carrier) : TRIPOD;
  }

  /** A robot standing at HOME at a pose on the floor. */
  initial(x: number, y: number, yaw: number): RobotState {
    const s: RobotState = {
      x, y, yaw, z: this.standZ, roll: 0, pitch: 0, v: [0, 0, 0], q: Array.from(this.model.home), phase: 0, active: false,
      pattern: 'tripod', carrier: null, feet: {} as Record<Leg, FootState>, lift: 0, wobble: null, locked: false,
    };
    for (const leg of LEGS) {
      const p = this.foothold(s, leg, 0);
      s.feet[leg] = { planted: true, p, from: [...p], target: [...p] };
    }
    return s;
  }

  /** World foothold of a leg if the body kept its current velocity for `tau` seconds. */
  foothold(s: RobotState, leg: Leg, tau: number): Vec3 {
    const [vx, vy, wz] = s.v;
    const yawM = s.yaw + (wz * tau) / 2;
    const px = s.x + (Math.cos(yawM) * vx - Math.sin(yawM) * vy) * tau;
    const py = s.y + (Math.sin(yawM) * vx + Math.cos(yawM) * vy) * tau;
    const yawP = s.yaw + wz * tau;
    const n = this.nominal[leg];
    const c = Math.cos(yawP), sn = Math.sin(yawP);
    return [px + c * n[0] - sn * n[1], py + sn * n[0] + c * n[1], n[2] + this.standZ];
  }

  baseRotation(s: RobotState): Mat3 {
    return rpyToMat3(s.roll, s.pitch, s.yaw);
  }

  /** Feet that walk in the current pattern. */
  gaitLegs(s: RobotState): Leg[] {
    return LEGS.filter((l) => l !== s.carrier);
  }

  step(s: RobotState, dt: number, cmd: Command, course: Course): StepEvents {
    const pat = this.pattern(s);
    const ev: StepEvents = { contacts: [], bumped: false, touchdowns: [], ikError: 0 };

    // 1. Velocity: command -> target, stride-limited, acceleration-limited.
    const top = SPEEDS[pat.name];
    let tv: [number, number, number] = s.locked ? [0, 0, 0] : [cmd.fwd * top.fwd, cmd.left * top.left, cmd.turn * top.turn];
    const stance = stanceTime(pat);
    let worst = 0;
    for (const leg of this.gaitLegs(s)) {
      const n = this.nominal[leg];
      const ex = tv[0] - tv[2] * n[1], ey = tv[1] + tv[2] * n[0];
      worst = Math.max(worst, Math.hypot(ex, ey) * stance);
    }
    if (worst > STRIDE_MAX) tv = tv.map((v) => (v * STRIDE_MAX) / worst) as [number, number, number];
    for (let k = 0; k < 3; k++) {
      const a = (k < 2 ? ACCEL.lin : ACCEL.ang) * dt;
      s.v[k] += clamp(tv[k] - s.v[k], -a, a);
      if (Math.abs(s.v[k]) < 1e-5 && tv[k] === 0) s.v[k] = 0;
    }

    // 2. Integrate the body on the floor and resolve collisions (slide along what it hits).
    const [vx, vy, wz] = s.v;
    const yawM = s.yaw + (wz * dt) / 2;
    s.yaw += wz * dt;
    let nx = s.x + (Math.cos(yawM) * vx - Math.sin(yawM) * vy) * dt;
    let ny = s.y + (Math.sin(yawM) * vx + Math.cos(yawM) * vy) * dt;
    const off = 0.02; // the footprint is centred slightly ahead of the base origin
    const cx = nx + Math.cos(s.yaw) * off, cy = ny + Math.sin(s.yaw) * off;
    const r = resolveRobot(course, [cx, cy], ROBOT_R, CORE_R);
    if (r.contacts.length) {
      nx += r.p[0] - cx;
      ny += r.p[1] - cy;
      // remove the velocity going into the contact
      const wvx = Math.cos(s.yaw) * vx - Math.sin(s.yaw) * vy, wvy = Math.sin(s.yaw) * vx + Math.cos(s.yaw) * vy;
      let ax = wvx, ay = wvy;
      let into = 0;
      for (const c of r.contacts) {
        const d = ax * c.n[0] + ay * c.n[1];
        if (d < 0) { ax -= d * c.n[0]; ay -= d * c.n[1]; into = Math.max(into, -d); }
      }
      s.v[0] = Math.cos(s.yaw) * ax + Math.sin(s.yaw) * ay;
      s.v[1] = -Math.sin(s.yaw) * ax + Math.cos(s.yaw) * ay;
      ev.contacts = r.contacts;
      if (into > 0.045 && (!s.wobble || s.wobble.t > 0.6)) {
        ev.bumped = true;
        const n = r.contacts[0].n;
        // wobble direction in the body frame
        s.wobble = { t: 0, nx: Math.cos(s.yaw) * n[0] + Math.sin(s.yaw) * n[1], ny: -Math.sin(s.yaw) * n[0] + Math.cos(s.yaw) * n[1] };
      }
    }
    s.x = nx;
    s.y = ny;

    // 3. Gait timing: step while moving or while any foot is away from where it should stand.
    const legs = this.gaitLegs(s);
    const moving = Math.hypot(s.v[0], s.v[1]) > 0.004 || Math.abs(s.v[2]) > 0.02 || (!s.locked && (Math.abs(cmd.fwd) + Math.abs(cmd.left) + Math.abs(cmd.turn) > 0.05));
    let misaligned = false;
    for (const leg of legs) {
      const f = s.feet[leg];
      const h = this.foothold(s, leg, 0);
      const home = clearFoothold(course, [h[0], h[1]]); // where it would stand, furniture allowing
      if (Math.hypot(f.p[0] - home[0], f.p[1] - home[1]) > 0.006 || !f.planted) misaligned = true;
    }
    const want = moving || misaligned;
    if (want || !allPlanted(pat, s.phase)) {
      s.active = true;
      s.phase = (s.phase + dt / pat.period) % 1;
    } else {
      s.active = false;
    }

    // 4. Feet: planted feet stay put; swinging feet travel to a foothold planned for mid-stance.
    const tSwing = swingTime(pat);
    for (const leg of legs) {
      const f = s.feet[leg];
      const fp = s.active ? footPhase(pat, leg, s.phase) : { swing: false, s: 0 };
      if (fp.swing) {
        if (f.planted) {
          f.planted = false;
          f.from = [...f.p];
        }
        const tau = (1 - fp.s) * tSwing + stance / 2;
        const t = this.foothold(s, leg, tau);
        const c = clearFoothold(course, [t[0], t[1]]);
        f.target = [c[0], c[1], t[2]];
        const u = swingTravel(fp.s);
        f.p = [f.from[0] + (f.target[0] - f.from[0]) * u, f.from[1] + (f.target[1] - f.from[1]) * u, f.target[2] + swingLift(fp.s, pat.swingHeight[leg])];
      } else if (!f.planted) {
        f.planted = true;
        f.p = [...f.target];
        ev.touchdowns.push(leg);
      }
    }

    // 5. Body height and tilt: the claw's lift, a little settle while feet are in the air, and a short
    //    wobble after a bump.
    const swinging = legs.filter((l) => !s.feet[l].planted).length / legs.length;
    s.z = this.standZ + s.lift - 0.0015 * swinging;
    s.roll = 0;
    s.pitch = 0;
    if (s.wobble) {
      s.wobble.t += dt;
      const k = Math.exp(-s.wobble.t / 0.18) * Math.sin(s.wobble.t * 24);
      s.pitch = 0.045 * k * s.wobble.nx;
      s.roll = -0.045 * k * s.wobble.ny;
      if (s.wobble.t > 1.2) s.wobble = null;
    }

    // 6. IK: every walking limb reaches its foot from the current base pose.
    ev.ikError = this.solveFeet(s);
    return ev;
  }

  /**
   * Solve the walking limbs for their current foot positions. A swinging foot whose full step height is out
   * of reach (the calibrated stance leaves the knees and wrists little room to fold further) is lowered until
   * it is reachable, so what is drawn is always what the limb can do.
   */
  solveFeet(s: RobotState): number {
    const R = this.baseRotation(s);
    const q = Float64Array.from(s.q);
    const home = this.model.home;
    const base: Vec3 = [s.x, s.y, s.z];
    let worst = 0;
    for (const leg of this.gaitLegs(s)) {
      const fc = this.chains[leg];
      const f = s.feet[leg];
      let err = solveFoot(fc, q, home, applyT3(R, sub(f.p, base)));
      if (err > 3e-4 && !f.planted) {
        const ground = f.target[2];
        let lo = 0, hi = f.p[2] - ground;
        const trial = Float64Array.from(q);
        for (let k = 0; k < 6; k++) {
          const mid = (lo + hi) / 2;
          trial.set(q);
          const e = solveFoot(fc, trial, home, applyT3(R, sub([f.p[0], f.p[1], ground + mid], base)));
          if (e < 3e-4) lo = mid;
          else hi = mid;
        }
        f.p = [f.p[0], f.p[1], ground + lo];
        err = solveFoot(fc, q, home, applyT3(R, sub(f.p, base)));
      }
      worst = Math.max(worst, err);
    }
    for (let j = 0; j < q.length; j++) s.q[j] = q[j];
    return worst;
  }

  /** Switch between six feet and five (one claw carried). Only while stopped with every foot planted. */
  setCarrier(s: RobotState, carrier: 'LF' | 'RF' | null): void {
    s.carrier = carrier;
    s.pattern = carrier ? 'five' : 'tripod';
    s.phase = 0;
    if (!carrier) {
      for (const arm of ARMS) {
        const f = s.feet[arm];
        f.planted = true;
        f.from = [...f.p];
        f.target = [...f.p];
      }
    }
  }
}
