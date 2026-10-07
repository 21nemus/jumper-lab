// A scripted driver that produces the same inputs a player does (stick axes and the claw button). The
// guided tour and the end-to-end tests use it, so they exercise the real controls rather than a canned
// animation.

import type { Arm } from './claw.ts';
import { wrapAngle } from './math.ts';
import type { Input, World } from './world.ts';
import { NO_COMMAND } from './robot.ts';

export type Step =
  | { kind: 'go'; x: number; y: number; yaw?: number; tol?: number; speed?: number }
  | { kind: 'align'; target: 'snack' | 'dish'; arm: Arm; yaw: number; at?: [number, number]; early?: boolean }
  | { kind: 'act' }
  | { kind: 'until'; what: 'carrying' | 'foot' | 'delivered' | 'stopped'; timeout?: number }
  | { kind: 'wait'; t: number }
  | { kind: 'turn'; yaw: number };

export class Autopilot {
  readonly steps: Step[];
  i = 0;
  private t = 0;
  done = false;

  constructor(steps: Step[]) {
    this.steps = steps;
  }

  next(world: World, dt: number): Input {
    const s = world.state;
    const r = s.robot;
    for (;;) {
      const st = this.steps[this.i];
      if (!st) {
        this.done = true;
        return { cmd: NO_COMMAND, action: false };
      }
      this.t += dt;
      if (st.kind === 'wait') {
        if (this.t < st.t) return { cmd: NO_COMMAND, action: false };
      } else if (st.kind === 'act') {
        this.advance();
        return { cmd: NO_COMMAND, action: true };
      } else if (st.kind === 'until') {
        const ok =
          st.what === 'carrying' ? s.claw.phase === 'carrying' :
          st.what === 'foot' ? s.claw.phase === 'foot' && !s.claw.seq.length :
          st.what === 'delivered' ? s.mission.status === 'delivered' :
          !r.active && Math.hypot(r.v[0], r.v[1]) < 1e-3;
        if (!ok && this.t < (st.timeout ?? 20)) return { cmd: NO_COMMAND, action: false };
      } else {
        // `early`: done as soon as the claw can reach (a player would press the button there)
        if (st.kind === 'align' && st.early) {
          const reach = world.reach();
          if (st.target === 'snack' ? reach.grab : reach.drop) {
            this.advance();
            continue;
          }
        }
        const goal = this.goal(world, st);
        const cmd = drive(r, goal, st.kind === 'go' ? st.speed ?? 1 : 0.6);
        const posErr = Math.hypot(goal.x - r.x, goal.y - r.y);
        const yawErr = goal.yaw === undefined ? 0 : Math.abs(wrapAngle(goal.yaw - r.yaw));
        const tol = st.kind === 'go' ? st.tol ?? 0.06 : 0.006;
        if (posErr > tol || yawErr > (st.kind === 'go' ? 0.25 : 0.02)) return { cmd, action: false };
      }
      this.advance();
    }
  }

  private advance(): void {
    this.i++;
    this.t = 0;
  }

  /** Base pose that puts the target at a point in the arm's reach window with the given heading. */
  private goal(world: World, st: Exclude<Step, { kind: 'act' } | { kind: 'until' } | { kind: 'wait' }>): { x: number; y: number; yaw?: number } {
    if (st.kind === 'go') return { x: st.x, y: st.y, yaw: st.yaw };
    if (st.kind === 'turn') return { x: world.state.robot.x, y: world.state.robot.y, yaw: st.yaw };
    const c = world.course;
    const tp = st.target === 'snack' ? c.stand.c : c.dish.c;
    const at = st.at ?? (st.arm === 'LF' ? [0.222, 0.06] : [0.222, -0.06]);
    const cy = Math.cos(st.yaw), sy = Math.sin(st.yaw);
    return { x: tp[0] - (cy * at[0] - sy * at[1]), y: tp[1] - (sy * at[0] + cy * at[1]), yaw: st.yaw };
  }
}

/** Steering toward a goal pose: body-frame position error to stick axes, heading error to turn. */
function drive(r: World['state']['robot'], g: { x: number; y: number; yaw?: number }, speed: number) {
  const dx = g.x - r.x, dy = g.y - r.y;
  const c = Math.cos(r.yaw), s = Math.sin(r.yaw);
  const ex = c * dx + s * dy, ey = -s * dx + c * dy;
  const dist = Math.hypot(ex, ey);
  // far away: face the way you are going; close in: face the goal heading
  const pathYaw = Math.atan2(dy, dx);
  const wantYaw = g.yaw === undefined || dist > 0.25 ? (dist > 0.08 ? pathYaw : r.yaw) : g.yaw;
  const yawErr = wrapAngle(wantYaw - r.yaw);
  const k = Math.min(1, dist / 0.18) * speed;
  const n = dist || 1;
  return {
    fwd: (ex / n) * k * (Math.abs(yawErr) > 1.2 && dist > 0.25 ? 0.2 : 1),
    left: (ey / n) * k * 0.9,
    turn: Math.max(-1, Math.min(1, yawErr / 0.45)),
  };
}

/** The reference route through the corner course: a clean run used by the tour and the tests. */
export const CORNER_RUN: Step[] = [
  { kind: 'go', x: 0.45, y: 0.04, speed: 1 },
  { kind: 'go', x: 1.0, y: 0.1, speed: 1 },
  { kind: 'go', x: 1.38, y: 0.24, speed: 1 },
  { kind: 'align', target: 'snack', arm: 'LF', yaw: 0.75 },
  { kind: 'until', what: 'stopped', timeout: 2 },
  { kind: 'act' },
  { kind: 'until', what: 'carrying', timeout: 8 },
  { kind: 'go', x: 1.42, y: 0.72, speed: 1 },
  { kind: 'go', x: 0.95, y: 0.8, speed: 1 },
  { kind: 'go', x: 0.6, y: 0.74, speed: 1 },
  { kind: 'align', target: 'dish', arm: 'LF', yaw: Math.PI - 0.35 },
  { kind: 'until', what: 'stopped', timeout: 2 },
  { kind: 'act' },
  { kind: 'until', what: 'delivered', timeout: 8 },
  { kind: 'until', what: 'foot', timeout: 8 },
];

/** The same route, but pressing the claw as soon as it can reach, as a player would: the guided tour's. */
export const TOUR_RUN: Step[] = CORNER_RUN.map((st) => (st.kind === 'align' ? { ...st, early: true } : st));
