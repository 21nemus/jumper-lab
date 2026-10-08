// The whole game simulation: robot, claw, snack and mission in one plain, cloneable state, advanced on a
// fixed step. Rendering only reads it; freezing for inspection snapshots it and restores it exactly.

import { ARM_SIDES, advanceClaw, ClawKit, grabSequence, initialClaw, releaseSequence, startSequence, type Arm, type ClawState, type GripPlan } from './claw.ts';
import { CORNER, type Course } from './course.ts';
import { NO_COMMAND, RobotController, type Command, type RobotState } from './robot.ts';
import { attach, followPalm, release, snackOnStand, stepSnack, type SnackState } from './snack.ts';
import type { RobotModel } from '../robot/model.ts';
import { apply3, mat3ToQuat, quatToMat3, rotZ, smoothstep, type Vec3 } from './math.ts';
import { clipPose, sampleClip, type ClipData, type ClipState } from './clip.ts';

export const DT = 1 / 120;

export interface MissionState {
  status: 'ready' | 'running' | 'delivered';
  time: number; // seconds since the first move
  bumps: number;
  misses: number;
  deliveredAt: number | null;
}

export interface SimState {
  t: number;
  robot: RobotState;
  claw: ClawState;
  snack: SnackState;
  mission: MissionState;
  resetSnackIn: number; // a missed snack goes back on its stand after this many seconds (0 = none pending)
  /** While the jaws close on the snack, it is drawn onto the grip point and squared up to the jaws. */
  squeeze: { p0: Vec3; yaw0: number; yaw1: number } | null;
  /** A recorded gesture playing (the robot stands still otherwise). */
  clip: ClipState | null;
}

export type SimEvent =
  | { kind: 'bump' }
  | { kind: 'step'; legs: string[] }
  | { kind: 'grab-start'; arm: Arm }
  | { kind: 'attached'; arm: Arm }
  | { kind: 'carrying'; arm: Arm }
  | { kind: 'released'; arm: Arm }
  | { kind: 'landed'; where: 'dish' | 'floor' | 'stand' }
  | { kind: 'delivered'; time: number }
  | { kind: 'missed' }
  | { kind: 'snack-reset' }
  | { kind: 'hint'; text: string }
  | { kind: 'started' }
  | { kind: 'clip-start'; name: string }
  | { kind: 'clip-end'; name: string }
  | { kind: 'arm-home' };

export interface Input {
  cmd: Command;
  action: boolean; // the single claw button: grab when empty, drop when carrying
}

export interface Reach {
  grab: GripPlan | null;
  drop: GripPlan | null;
}

export class World {
  readonly model: RobotModel;
  readonly course: Course;
  readonly ctl: RobotController;
  readonly kit: ClawKit;
  readonly clips = new Map<string, ClipData>();
  state: SimState;

  constructor(model: RobotModel, course: Course = CORNER) {
    this.model = model;
    this.course = course;
    this.ctl = new RobotController(model);
    this.kit = new ClawKit(model, this.ctl, course.snackSize);
    this.state = this.fresh();
  }

  fresh(): SimState {
    const c = this.course;
    return {
      t: 0,
      robot: this.ctl.initial(c.start.x, c.start.y, c.start.yaw),
      claw: initialClaw(),
      snack: snackOnStand(c),
      mission: { status: 'ready', time: 0, bumps: 0, misses: 0, deliveredAt: null },
      resetSnackIn: 0,
      squeeze: null,
      clip: null,
    };
  }

  reset(): void {
    this.state = this.fresh();
  }
  snapshot(): SimState {
    return structuredClone(this.state);
  }
  restore(s: SimState): void {
    this.state = structuredClone(s);
  }

  /** What the claw button would do right now, per arm, if pressed (null when out of reach). */
  reach(): Reach {
    const s = this.state;
    const r = s.robot;
    if (s.claw.phase === 'foot' && s.snack.mode === 'stand') {
      let best: GripPlan | null = null;
      for (const arm of ARM_SIDES) {
        const p = this.kit.plan(r, arm, s.snack.p, 'grab');
        if (p && (!best || p.cost < best.cost)) best = p;
      }
      return { grab: best, drop: null };
    }
    if (s.claw.phase === 'carrying' && s.claw.arm) {
      // Anywhere over the dish's inner area lands inside it. Try where the snack is now when that is already
      // over the dish (let go right there), then points over the dish nearest to it, so the claw moves the
      // snack as little as it can.
      const arm = s.claw.arm;
      const d = this.course.dish;
      const g = this.kit.gripWorld(r, arm);
      const ring = d.innerR - this.course.snackSize * 0.55;
      const candidates: Vec3[] = [[d.c[0], d.c[1], g[2]]];
      for (const f of [0.5, 1]) {
        for (let k = 0; k < 12; k++) {
          const a = (k * Math.PI) / 6;
          candidates.push([d.c[0] + Math.cos(a) * ring * f, d.c[1] + Math.sin(a) * ring * f, g[2]]);
        }
      }
      const away = (p: Vec3) => Math.hypot(p[0] - g[0], p[1] - g[1]);
      if (Math.hypot(g[0] - d.c[0], g[1] - d.c[1]) <= ring) candidates.push(g);
      candidates.sort((a, b) => away(a) - away(b));
      const from = this.kit.armQ(r, arm);
      for (const t of candidates) {
        const p = this.kit.plan(r, arm, t, 'drop', from);
        if (p) return { grab: null, drop: p };
      }
      return { grab: null, drop: null };
    }
    return { grab: null, drop: null };
  }

  /** Why the claw button can't act right now, in words a player can act on. */
  reachHint(): string {
    const s = this.state;
    const r = s.robot;
    const carrying = s.claw.phase === 'carrying' && !!s.claw.arm;
    const what = carrying ? 'dish' : 'snack';
    const p = carrying ? this.course.dish.c : s.snack.p;
    const c = Math.cos(r.yaw), sn = Math.sin(r.yaw);
    const dx = p[0] - r.x, dy = p[1] - r.y;
    const x = c * dx + sn * dy, y = -sn * dx + c * dy; // robot frame: x ahead, y to the left
    const arms = carrying ? [s.claw.arm!] : ARM_SIDES;
    const reach = Math.min(...arms.map((a) => Math.hypot(x - this.kit.shoulder(a)[0], y - this.kit.shoulder(a)[1])));
    if (x < 0.05 || Math.abs(Math.atan2(y, x)) > 1.1) return `Turn to face the ${what}.`;
    if (reach > 0.25) return `Get closer to the ${what}.`;
    if (carrying) {
      const left = s.claw.arm === 'LF';
      if ((left ? y : -y) < -0.02) return `The snack is in the ${left ? 'left' : 'right'} claw: turn ${left ? 'right' : 'left'} a little so the dish is on that side.`;
    }
    if (x < 0.2) return `Back up a little: the ${what} is too close for the claw.`;
    return `Line the ${what} up in front of a claw.`;
  }

  /** Can a gesture start now? Only standing still on all six feet, with nothing in the claws (and, unless
   *  `overGesture`, no other gesture playing). */
  canPlay(overGesture = false): boolean {
    const s = this.state;
    return (overGesture || !s.clip) && s.claw.phase === 'foot' && !s.claw.seq.length && !s.claw.waiting && !s.robot.active && !s.robot.carrier && s.snack.mode !== 'held';
  }

  play(name: string, speed = 1): boolean {
    const data = this.clips.get(name);
    if (!data || !this.canPlay()) return false;
    const r = this.state.robot;
    this.state.clip = { name, t: 0, speed, x0: r.x, y0: r.y, yaw0: r.yaw, out: null };
    r.locked = true;
    return true;
  }

  private stepClip(input: Input, moving: boolean, ev: SimEvent[]): void {
    const s = this.state;
    const r = s.robot;
    const st = s.clip!;
    const data = this.clips.get(st.name)!;
    if ((moving || input.action) && !st.out) st.out = { t: 0, dur: 0.35, q: [...r.q], z: r.z, roll: r.roll, pitch: r.pitch };
    if (st.out) {
      st.out.t += DT;
      const u = smoothstep(st.out.t / st.out.dur);
      const home = this.model.home;
      r.q = st.out.q.map((v, j) => v + (home[j] - v) * u);
      r.z = st.out.z + (this.ctl.standZ - st.out.z) * u;
      r.roll = st.out.roll * (1 - u);
      r.pitch = st.out.pitch * (1 - u);
      if (st.out.t >= st.out.dur) this.endClip(ev);
      return;
    }
    st.t += DT * st.speed;
    const smp = sampleClip(data, st.t);
    const pose = clipPose(st, smp);
    r.q = smp.q;
    r.x = pose.x;
    r.y = pose.y;
    r.z = pose.z;
    r.roll = pose.roll;
    r.pitch = pose.pitch;
    r.yaw = pose.yaw;
    if (st.t >= data.duration) this.endClip(ev);
  }

  /** Back to walking: plant every foot where the limb actually put it. */
  private endClip(ev: SimEvent[]): void {
    const s = this.state;
    const r = s.robot;
    const name = s.clip!.name;
    s.clip = null;
    r.locked = false;
    r.v = [0, 0, 0];
    r.roll = 0;
    r.pitch = 0;
    r.z = this.ctl.standZ;
    const R = this.ctl.baseRotation(r);
    for (const leg of Object.keys(r.feet) as (keyof typeof r.feet)[]) {
      const local = this.ctl.chains[leg].chain.fk(r.q).p;
      const w: Vec3 = [r.x + R[0] * local[0] + R[1] * local[1] + R[2] * local[2], r.y + R[3] * local[0] + R[4] * local[1] + R[5] * local[2], this.ctl.standZ + this.ctl.nominal[leg][2]];
      r.feet[leg] = { planted: true, p: w, from: [...w], target: [...w] };
    }
    this.ctl.solveFeet(r);
    ev.push({ kind: 'clip-end', name });
  }

  step(input: Input): SimEvent[] {
    const s = this.state;
    const ev: SimEvent[] = [];
    const r = s.robot;
    const c = s.claw;
    s.t += DT;

    const moving = Math.abs(input.cmd.fwd) + Math.abs(input.cmd.left) + Math.abs(input.cmd.turn) > 0.05;
    if (s.mission.status === 'ready' && (moving || input.action)) {
      s.mission.status = 'running';
      ev.push({ kind: 'started' });
    }
    if (s.mission.status === 'running') s.mission.time += DT;

    if (s.clip) {
      this.stepClip(input, moving, ev);
      stepSnack(s.snack, this.course, DT);
      return ev;
    }

    // The claw button.
    if (input.action && !c.seq.length && !c.waiting) {
      const reach = this.reach();
      if (c.phase === 'foot') {
        if (reach.grab) { c.waiting = true; c.pending = 'grab'; r.locked = true; }
        else if (s.snack.mode === 'stand') ev.push({ kind: 'hint', text: this.reachHint() });
      } else if (c.phase === 'carrying') {
        if (reach.drop) { c.waiting = true; c.pending = 'release'; r.locked = true; }
        else ev.push({ kind: 'hint', text: this.reachHint() });
      }
    }

    // Walk (or come to a stop when the claw has asked for one).
    const step = this.ctl.step(r, DT, r.locked ? NO_COMMAND : input.cmd, this.course);
    if (step.bumped) {
      if (s.mission.status === 'running') s.mission.bumps++;
      ev.push({ kind: 'bump' });
    }
    if (step.touchdowns.length) ev.push({ kind: 'step', legs: step.touchdowns });

    // Start a pending claw sequence once the robot is standing still on all its feet.
    if (c.waiting && !r.active) {
      c.waiting = false;
      const reach = this.reach();
      if (c.pending === 'grab' && reach.grab) {
        c.arm = reach.grab.arm;
        c.phase = 'grabbing';
        this.ctl.setCarrier(r, c.arm);
        startSequence(this.kit, c, r, grabSequence(this.kit, r, reach.grab));
        ev.push({ kind: 'grab-start', arm: c.arm });
      } else if (c.pending === 'release' && reach.drop && c.arm) {
        c.phase = 'releasing';
        startSequence(this.kit, c, r, releaseSequence(this.kit, r, reach.drop));
      } else {
        r.locked = c.phase === 'grabbing' || c.phase === 'releasing';
        ev.push({ kind: 'hint', text: `Out of reach after stopping. ${this.reachHint()}` });
      }
      c.pending = null;
      if (!c.seq.length) r.locked = false;
    }

    // Run the claw, and keep the carried arm at its pose (walking never drives it).
    const arm = c.arm;
    if (arm && c.seq.length) {
      for (const e of advanceClaw(this.kit, c, r, DT)) {
        if (e === 'attach') {
          const palm = this.kit.palmPose(r, arm);
          attach(s.snack, arm, palm.R, palm.p, this.kit.gripWorld(r, arm));
          ev.push({ kind: 'attached', arm });
        } else if (e === 'detach') {
          release(s.snack);
          ev.push({ kind: 'released', arm });
        } else if (e === 'carry') {
          c.phase = 'carrying';
          c.hold = this.kit.armQ(r, arm)[4];
          r.locked = false;
          ev.push({ kind: 'carrying', arm });
        } else if (e === 'foot') {
          this.returnFoot(arm);
          c.phase = 'foot';
          c.arm = null;
          r.locked = false;
          ev.push({ kind: 'arm-home' });
        }
      }
    }

    // The jaws closing: the snack slides onto the grip point and turns square to the jaws (a cube only ever
    // needs up to 45 degrees for that).
    const seg = c.seq[c.seg];
    if (c.phase === 'grabbing' && c.arm && seg?.name === 'close' && s.snack.mode === 'stand') {
      if (!s.squeeze) {
        const m = quatToMat3(s.snack.quat);
        const yaw0 = Math.atan2(m[3], m[0]);
        const palm = this.kit.palmPose(r, c.arm);
        const h = apply3(palm.R, this.kit.heading[c.arm]);
        const jaw = Math.atan2(h[1], h[0]);
        const k = Math.round((yaw0 - jaw) / (Math.PI / 2));
        s.squeeze = { p0: [...s.snack.p], yaw0, yaw1: jaw + (k * Math.PI) / 2 };
      }
      const u = smoothstep(c.t / seg.dur);
      const g = this.kit.gripWorld(r, c.arm);
      const q = s.squeeze;
      s.snack.p = [q.p0[0] + (g[0] - q.p0[0]) * u, q.p0[1] + (g[1] - q.p0[1]) * u, q.p0[2] + (g[2] - q.p0[2]) * u];
      s.snack.quat = mat3ToQuat(rotZ(q.yaw0 + (q.yaw1 - q.yaw0) * u));
    } else if (s.squeeze && s.snack.mode !== 'stand') {
      s.squeeze = null;
    }

    // The snack.
    if (s.snack.mode === 'held' && s.snack.held) {
      const palm = this.kit.palmPose(r, s.snack.held.arm);
      followPalm(s.snack, palm.R, palm.p, DT);
    } else {
      const landed = stepSnack(s.snack, this.course, DT);
      if (landed) {
        ev.push({ kind: 'landed', where: landed });
        if (landed === 'dish' && s.mission.status !== 'delivered') {
          s.mission.status = 'delivered';
          s.mission.deliveredAt = s.mission.time;
          ev.push({ kind: 'delivered', time: s.mission.time });
        } else if (landed === 'floor') {
          s.mission.misses++;
          s.resetSnackIn = 1.4;
          ev.push({ kind: 'missed' });
        }
      }
    }
    if (s.resetSnackIn > 0) {
      s.resetSnackIn -= DT;
      if (s.resetSnackIn <= 0) {
        s.resetSnackIn = 0;
        s.snack = snackOnStand(this.course);
        ev.push({ kind: 'snack-reset' });
      }
    }
    return ev;
  }

  /** The claw is back on the floor: hand it to the gait as a planted foot. */
  private returnFoot(arm: Arm): void {
    const r = this.state.robot;
    const fc = this.ctl.chains[arm];
    const R = this.ctl.baseRotation(r);
    const local = fc.chain.fk(r.q).p;
    const w: Vec3 = [r.x + R[0] * local[0] + R[1] * local[1] + R[2] * local[2], r.y + R[3] * local[0] + R[4] * local[1] + R[5] * local[2], r.z + R[6] * local[0] + R[7] * local[1] + R[8] * local[2]];
    this.ctl.setCarrier(r, null);
    r.feet[arm].p = [w[0], w[1], this.model.json.standZ + this.ctl.nominal[arm][2]];
    r.feet[arm].from = [...r.feet[arm].p];
    r.feet[arm].target = [...r.feet[arm].p];
  }
}
