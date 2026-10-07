// The claw: geometry and poses from upstream, sequencing ours.
//
// From upstream (cited in robot.json):
//   - the "arm straight out, thumb-web up" preset (deploy/lib.rs PRESETS): J1 = -90 deg rolls the arm so its
//     J0, J2 and J3 axes all stand vertical. The arm becomes a planar three-joint arm at shoulder height and
//     its jaws close horizontally -- the pose we grasp in;
//   - the stow the five-foot policy walks with (claw.py LF_GRASP), used to carry;
//   - the finger's open angles (FINGER_POSED_DEG, FINGER_RELEASED_DEG) and the measured aperture table
//     (claw.py APERTURE_MM), which says where the finger stops on an object of a given width;
//   - the left/right mirror rule (J0, J2, J3, J4 flip sign; J1 does not).
// Ours (GAME APPROXIMATION): the reach planning, the self-collision footprints, approach distances, timings
// and the body lift.

import { add, apply3, smoothstep, sub, wrapAngle, type Mat3, type Vec3 } from './math.ts';
import { Chain, solveFoot } from './limb.ts';
import type { RobotController, RobotState } from './robot.ts';
import type { RobotModel } from '../robot/model.ts';

export type Arm = 'LF' | 'RF';
export const ARM_SIDES: Arm[] = ['LF', 'RF'];
const DEG = Math.PI / 180;

/** [x0, x1, y0, y1], base frame, metres. */
type Box = [number, number, number, number];
/** [u0, u1, v0, v1] around the grip point: u along the jaws, v to their left. */
type Rect = [number, number, number, number];

// What the claw must not pass through, at claw height (60-115 mm above the floor). Footprints measured from the
// shipped meshes at the stand pose, written for the LEFT claw; the right claw uses them mirrored (y -> -y).
const KEEP_OUT: Box[] = [
  // chassis, stepped: its front corners are rounded off where the shoulders sit
  [-0.097, 0.094, -0.05, 0.05],
  [-0.09, 0.087, -0.06, 0.06],
  [-0.08, 0.075, -0.07, 0.07],
  [-0.06, 0.056, -0.08, 0.08],
  [-0.036, 0.041, -0.09, 0.09],
  // the other front claw, standing, stepped along its inner edge
  [0.03, 0.065, -0.126, -0.039],
  [0.065, 0.085, -0.128, -0.056],
  [0.085, 0.15, -0.153, -0.074],
  [0.15, 0.18, -0.135, -0.095],
  [-0.031, 0.017, 0.051, 0.2], // the middle leg on this side
];
const CLEARANCE = 0.005;
// The left claw's outline around its grip point (from the palm and finger meshes in the web-up roll). Holding
// the 40 mm snack, the snack sits inside the shut outline.
const CLAW_SHUT: Rect = [-0.1, 0.047, -0.037, 0.04];
const FINGER_OPEN: Rect = [-0.075, 0.033, -0.049, -0.037]; // the finger opened to MOUTH
/** How wide the jaws open to take or let go of the snack: 7.5 mm clear of the 40 mm snack on each side, set
 * through upstream's measured aperture table. Opening only this far keeps the finger off the robot's own body
 * (swung fully open it would sweep 8 cm inwards, into the other claw). */
const MOUTH = 0.055;
const WRIST_R = 0.016;
const HEADING_STEP = 5 * DEG;
const HEADING_SPAN = 18; // search the jaw heading up to 90 degrees either side of pointing straight out

/**
 * The arm in the web-up roll, where J0, J2 and J3 stand vertical: in plan view a three-joint planar arm.
 * Measured once from forward kinematics at J0 = J2 = J3 = 0.
 */
interface Planar {
  S: [number, number]; // J0 axis (base frame xy)
  l1: number; // J0 axis to J2 axis
  a1: number;
  l2: number; // J2 axis to J3 axis
  a2: number;
  g: [number, number]; // J3 axis to the grip point
  h0: number; // jaw heading
  s: [number, number, number]; // J0, J2, J3 axis signs (+1 up, -1 down)
  z: number; // grip point height (base frame)
}

export interface Segment {
  name: string;
  dur: number;
  to: number[]; // arm J0..J4 (actual angles for this arm)
  lift: number; // body lift at the end of the segment (m)
  event?: 'attach' | 'detach' | 'carry' | 'foot';
}

export interface ClawState {
  phase: 'foot' | 'grabbing' | 'carrying' | 'releasing';
  arm: Arm | null;
  seq: Segment[];
  seg: number; // index of the running segment
  t: number; // time in the running segment
  from: number[]; // arm joints at the start of the running segment
  liftFrom: number;
  hold: number; // finger angle (actual) the snack is held at
  waiting: boolean; // the robot is still coming to a stop before the sequence starts
  pending: 'grab' | 'release' | null;
}

export interface GripPlan {
  arm: Arm;
  q: number[]; // J0..J4 for the grasp / drop pose
  qPre: number[]; // backed off along the jaws: the approach (grab) or the retract (drop)
  heading: number; // jaw heading, base frame (rad)
  cost: number; // lower is better: heading off straight-out (grab), joint travel (drop)
  retractLift: number; // body lift while retracting, when there is no room to back off along the jaws (m)
}

export function initialClaw(): ClawState {
  return { phase: 'foot', arm: null, seq: [], seg: 0, t: 0, from: [], liftFrom: 0, hold: 0, waiting: false, pending: null };
}

export class ClawKit {
  readonly model: RobotModel;
  readonly ctl: RobotController;
  readonly joints: Record<Arm, number[]>;
  readonly palm: Record<Arm, number>;
  /** Grip point in the palm frame: midway between the two grip inserts with the jaws closed on the snack. */
  readonly grip: Record<Arm, Vec3>;
  /** The jaws' pointing direction in the palm frame. */
  readonly heading: Record<Arm, Vec3>;
  readonly gripChain: Record<Arm, Chain>;
  readonly planar: Record<Arm, Planar>;
  readonly snackSize: number;

  constructor(model: RobotModel, ctl: RobotController, snackSize: number) {
    this.model = model;
    this.ctl = ctl;
    this.snackSize = snackSize;
    this.joints = { LF: model.limbJoints('LF'), RF: model.limbJoints('RF') };
    this.palm = { LF: model.body('LF_palm_link'), RF: model.body('RF_palm_link') };
    this.grip = {} as Record<Arm, Vec3>;
    this.heading = {} as Record<Arm, Vec3>;
    this.gripChain = {} as Record<Arm, Chain>;
    const mesh = (body: string) => model.json.meshes.find((m) => m.body === body)!.centroid;
    for (const arm of ARM_SIDES) {
      const bodies = model.json.bodies;
      // palm grip insert: fixed to the palm. finger grip insert: on the finger, which turns about J4.
      const palmInsert = model.body(`${arm}_palm_grip_insert_link`);
      const finger = model.body(`${arm}_finger_link`);
      const fingerInsert = model.body(`${arm}_finger_grip_insert_link`);
      const a = add(bodies[palmInsert].pos, mesh(`${arm}_palm_grip_insert_link`));
      const fj = bodies[finger];
      const hold = this.holdAngle(arm);
      const Rf = axisRot(fj.joint!.axis, hold);
      const b = add(fj.pos, apply3(Rf, add(bodies[fingerInsert].pos, mesh(`${arm}_finger_grip_insert_link`))));
      this.grip[arm] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      this.heading[arm] = [0, arm === 'LF' ? 1 : -1, 0];
      this.gripChain[arm] = new Chain(model, this.palm[arm], this.grip[arm]);
    }
    this.planar = { LF: this.measurePlanar('LF'), RF: this.measurePlanar('RF') };
  }

  private measurePlanar(arm: Arm): Planar {
    const js = this.joints[arm];
    const q = Float64Array.from(this.model.home);
    q[js[0]] = 0;
    q[js[1]] = this.webRoll(arm);
    q[js[2]] = 0;
    q[js[3]] = 0;
    q[js[4]] = this.holdAngle(arm);
    const chain = this.gripChain[arm];
    const f = chain.fk(q);
    const at = (k: number) => chain.joints.indexOf(js[k]);
    const sign = (k: number) => {
      const a = f.a[at(k)];
      if (Math.hypot(a[0], a[1]) > 1e-6) throw new Error(`${arm} J${k} is not vertical in the web-up roll`);
      return Math.sign(a[2]);
    };
    const S = f.o[at(0)], E = f.o[at(2)], W = f.o[at(3)];
    const h = apply3(f.R, this.heading[arm]);
    return {
      S: [S[0], S[1]],
      l1: Math.hypot(E[0] - S[0], E[1] - S[1]),
      a1: Math.atan2(E[1] - S[1], E[0] - S[0]),
      l2: Math.hypot(W[0] - E[0], W[1] - E[1]),
      a2: Math.atan2(W[1] - E[1], W[0] - E[0]),
      g: [f.p[0] - W[0], f.p[1] - W[1]],
      h0: Math.atan2(h[1], h[0]),
      s: [sign(0), sign(2), sign(3)],
      z: f.p[2],
    };
  }

  /** Map a left-arm angle vector (J0..J4) onto `arm`. */
  mirror(arm: Arm, left: number[]): number[] {
    return left.map((v, k) => this.model.armAngle(arm, k, v));
  }
  /** Finger angle (actual) that holds an object of `width` metres, from the measured aperture table. */
  holdAngle(arm: Arm, width = this.snackSize): number {
    const t = this.model.json.claw.apertureMm;
    const mm = width * 1000;
    let left = t[t.length - 1][0];
    for (let i = 1; i < t.length; i++) {
      if (t[i][1] <= mm) {
        const [x0, y0] = t[i - 1], [x1, y1] = t[i];
        left = x0 + ((mm - y0) / (y1 - y0)) * (x1 - x0);
        break;
      }
    }
    return this.model.armAngle(arm, 4, left);
  }
  /** Finger angle that opens the jaws to MOUTH, ready to take or let go of the snack. */
  mouthAngle(arm: Arm): number {
    return this.holdAngle(arm, MOUTH);
  }
  stow(arm: Arm, finger: number): number[] {
    const s = this.mirror(arm, this.model.json.claw.stow);
    s[4] = finger;
    return s;
  }
  /** J1 of the web-up preset (degrees in deploy/lib.rs), mirrored. */
  webRoll(arm: Arm): number {
    return this.model.armAngle(arm, 1, this.model.json.claw.presetsDeg.arm_web_up[1] * DEG);
  }

  /** Shoulder (J0 origin) in the base frame. */
  shoulder(arm: Arm): Vec3 {
    return this.model.json.bodies[this.model.body(`${arm}_shoulder_link`)].pos;
  }

  /**
   * Arm angles (J0..J4) that put the grip point at (x, y) in the base frame with the jaws pointing along
   * `heading`, in the web-up roll: closed form, one solution per elbow branch. Null when it is out of reach or
   * a joint would pass its limit. Also returns the elbow (J2) and wrist (J3) axes in plan view.
   */
  planarIK(arm: Arm, x: number, y: number, heading: number, branch: 1 | -1, finger: number): { q: number[]; elbow: [number, number]; wrist: [number, number] } | null {
    const P = this.planar[arm];
    const phi = heading - P.h0; // how far the jaws turn from the reference pose
    const c = Math.cos(phi), sn = Math.sin(phi);
    const wx = x - (c * P.g[0] - sn * P.g[1]), wy = y - (sn * P.g[0] + c * P.g[1]);
    const dx = wx - P.S[0], dy = wy - P.S[1];
    const d = Math.hypot(dx, dy);
    if (d >= P.l1 + P.l2 || d <= Math.abs(P.l1 - P.l2)) return null;
    const g1 = Math.atan2(dy, dx) + branch * Math.acos((P.l1 * P.l1 + d * d - P.l2 * P.l2) / (2 * P.l1 * d));
    const ex = P.S[0] + P.l1 * Math.cos(g1), ey = P.S[1] + P.l1 * Math.sin(g1);
    const r1 = g1 - P.a1; // turned by J0
    const r2 = Math.atan2(wy - ey, wx - ex) - P.a2; // turned by J0 + J2
    const js = this.joints[arm];
    const t0 = this.withinLimits(js[0], P.s[0] * r1);
    const t2 = this.withinLimits(js[2], P.s[1] * (r2 - r1));
    const t3 = this.withinLimits(js[3], P.s[2] * (phi - r2));
    if (t0 === null || t2 === null || t3 === null) return null;
    return { q: [t0, this.webRoll(arm), t2, t3, finger], elbow: [ex, ey], wrist: [wx, wy] };
  }

  private withinLimits(j: number, v: number): number | null {
    const [lo, hi] = this.model.limits[j];
    const w = wrapAngle(v);
    for (const k of [0, -1, 1]) {
      const a = w + k * 2 * Math.PI;
      if (a >= lo + 0.01 && a <= hi - 0.01) return a;
    }
    return null;
  }

  /** Jaw heading (base frame) of an arm pose in the web-up roll. */
  headingOf(arm: Arm, armQ: number[]): number {
    const q = Float64Array.from(this.model.home);
    this.joints[arm].forEach((j, k) => (q[j] = armQ[k]));
    const h = apply3(this.gripChain[arm].fk(q).R, this.heading[arm]);
    return Math.atan2(h[1], h[0]);
  }

  /** Grip point height (base frame) in the web-up roll: fixed by the shoulder, whatever J0/J2/J3 do. */
  gripHeight(arm: Arm): number {
    return this.planar[arm].z;
  }

  /**
   * True when the claw (shut, or with its finger swung open) and its wrist clear the chassis, the other front
   * claw and this side's middle leg. Plan view, base frame.
   */
  clear(arm: Arm, x: number, y: number, heading: number, wrist: [number, number], open: boolean): boolean {
    const m = arm === 'LF' ? 1 : -1; // work in left-claw coordinates
    const gx = x, gy = y * m, h = heading * m;
    const u = [Math.cos(h), Math.sin(h)], v = [-u[1], u[0]];
    const rects = open ? [CLAW_SHUT, FINGER_OPEN] : [CLAW_SHUT];
    for (const r of rects) {
      const corners: [number, number][] = [
        [gx + u[0] * r[0] + v[0] * r[2], gy + u[1] * r[0] + v[1] * r[2]],
        [gx + u[0] * r[1] + v[0] * r[2], gy + u[1] * r[1] + v[1] * r[2]],
        [gx + u[0] * r[1] + v[0] * r[3], gy + u[1] * r[1] + v[1] * r[3]],
        [gx + u[0] * r[0] + v[0] * r[3], gy + u[1] * r[0] + v[1] * r[3]],
      ];
      for (const b of KEEP_OUT) if (quadHitsBox(corners, b, CLEARANCE)) return false;
    }
    const wx = wrist[0], wy = wrist[1] * m;
    for (const b of KEEP_OUT) {
      if (wx > b[0] - WRIST_R && wx < b[1] + WRIST_R && wy > b[2] - WRIST_R && wy < b[3] + WRIST_R) return false;
    }
    return true;
  }

  /**
   * Plan a grasp or a drop at a world point for one arm, from the robot's current pose: search the jaw heading
   * (straight out from the shoulder first, then up to 90 degrees either way) and both elbow branches, keep the
   * poses whose claw clears the robot's own body, and pick the cheapest. Grabs prefer the jaws pointing
   * straight out; drops prefer the least joint travel from `from` (the carry pose), so a snack that is already
   * over the dish is let go right where it is. Null when nothing works (out of reach, too close, blocked).
   */
  plan(s: RobotState, arm: Arm, world: Vec3, kind: 'grab' | 'drop', from?: number[]): GripPlan | null {
    const R = this.ctl.baseRotation(s);
    const local = applyT(R, sub(world, [s.x, s.y, s.z]));
    const P = this.planar[arm];
    if (kind === 'grab' && Math.abs(local[2] - P.z) > 0.03) return null;
    const rx = local[0] - P.S[0], ry = local[1] - P.S[1];
    if (Math.hypot(rx, ry) > P.l1 + P.l2 + Math.hypot(P.g[0], P.g[1])) return null;
    const side = arm === 'LF' ? 1 : -1;
    if (local[1] * side < -0.07) return null; // not across the centre line: the other claw is there
    const grab = kind === 'grab';
    const finger = grab ? this.mouthAngle(arm) : this.holdAngle(arm);
    const radial = Math.atan2(ry, rx);
    const headings: number[] = from ? [this.headingOf(arm, from)] : [];
    for (let k = 0; k <= HEADING_SPAN; k++) {
      headings.push(radial + k * HEADING_STEP);
      if (k) headings.push(radial - k * HEADING_STEP);
    }
    let best: GripPlan | null = null;
    for (const heading of headings) {
      for (const branch of [1, -1] as const) {
        const sol = this.planarIK(arm, local[0], local[1], heading, branch, finger);
        if (!sol) continue;
        // keep the elbow out, away from the body: it is on the outboard side of the shoulder-wrist line
        const out = side * ((sol.wrist[0] - P.S[0]) * (sol.elbow[1] - P.S[1]) - (sol.wrist[1] - P.S[1]) * (sol.elbow[0] - P.S[0])) > 0;
        const cost = (grab || !from ? Math.abs(wrapAngle(heading - radial)) : travel(sol.q, from)) + (out ? 0 : 0.3);
        if (best && cost >= best.cost) continue;
        if (!this.clear(arm, local[0], local[1], heading, sol.wrist, true)) continue; // open: on arrival or on letting go
        // Back off along the jaws: the approach for a grab (a short one: the open mouth is 15 mm wider than the
        // snack), the retract after a drop. A drop with no room to back off lifts the body
        // instead, so the open jaws rise clear of the snack.
        let pre: number[] | null = null;
        for (const back of grab ? [0.03, 0.02, 0.012] : [0.025, 0.015]) {
          const bx = local[0] - Math.cos(heading) * back, by = local[1] - Math.sin(heading) * back;
          const p = this.planarIK(arm, bx, by, heading, branch, finger);
          if (p && this.clear(arm, bx, by, heading, p.wrist, true)) {
            pre = p.q;
            break;
          }
        }
        if (!pre && grab) continue;
        best = { arm, q: sol.q, qPre: pre ?? sol.q, heading, cost, retractLift: pre ? 0 : GRAB_LIFT };
      }
    }
    return best;
  }

  /** Arm angles with the claw's pad lifted `h` above where it stands (still in its walking roll). */
  liftedFoot(s: RobotState, arm: Arm, h: number): number[] {
    const fc = this.ctl.chains[arm];
    const q = Float64Array.from(s.q);
    const pad = fc.chain.fk(q).p;
    solveFoot(fc, q, this.model.home, [pad[0], pad[1], pad[2] + h], 30);
    return this.joints[arm].map((j) => q[j]);
  }

  armQ(s: RobotState, arm: Arm): number[] {
    return this.joints[arm].map((j) => s.q[j]);
  }
  setArmQ(s: RobotState, arm: Arm, q: number[]): void {
    this.joints[arm].forEach((j, k) => (s.q[j] = q[k]));
  }

  /** World pose of the palm (for attaching the snack). */
  palmPose(s: RobotState, arm: Arm): { R: Mat3; p: Vec3 } {
    const Rb = this.ctl.baseRotation(s);
    const chain = this.gripChain[arm];
    const f = chain.fk(s.q);
    const palmOrigin = sub(f.p, apply3(f.R, this.grip[arm]));
    return { R: mulM(Rb, f.R), p: add([s.x, s.y, s.z], apply3(Rb, palmOrigin)) };
  }
  /** World position of the grip point. */
  gripWorld(s: RobotState, arm: Arm): Vec3 {
    const { R, p } = this.palmPose(s, arm);
    return add(p, apply3(R, this.grip[arm]));
  }
}

// ── sequences ─────────────────────────────────────────────────────────────────────────────────────────

export const GRAB_LIFT = 0.024; // body rise that lifts the snack clear of its stand (GAME APPROXIMATION)

export function grabSequence(kit: ClawKit, s: RobotState, p: GripPlan): Segment[] {
  const { arm } = p;
  const open = kit.mouthAngle(arm);
  const hold = kit.holdAngle(arm);
  const raised = kit.liftedFoot(s, arm, 0.03);
  raised[4] = kit.armQ(s, arm)[4];
  const withFinger = (q: number[], f: number) => q.map((v, k) => (k === 4 ? f : v));
  return [
    { name: 'lift claw', dur: 0.3, to: raised, lift: 0 },
    { name: 'reach', dur: 0.65, to: withFinger(p.qPre, open), lift: 0 },
    { name: 'approach', dur: 0.45, to: withFinger(p.q, open), lift: 0 },
    { name: 'close', dur: 0.4, to: withFinger(p.q, hold), lift: 0, event: 'attach' },
    { name: 'lift snack', dur: 0.35, to: withFinger(p.q, hold), lift: GRAB_LIFT },
    { name: 'stow', dur: 0.7, to: kit.stow(arm, hold), lift: GRAB_LIFT },
    { name: 'settle', dur: 0.3, to: kit.stow(arm, hold), lift: 0, event: 'carry' },
  ];
}

export function releaseSequence(kit: ClawKit, s: RobotState, p: GripPlan): Segment[] {
  const { arm } = p;
  const now = kit.armQ(s, arm);
  const hold = now[4];
  const open = kit.mouthAngle(arm);
  const withFinger = (q: number[], f: number) => q.map((v, k) => (k === 4 ? f : v));
  const raised = kit.liftedFoot({ ...s, q: [...kit.model.home] } as RobotState, arm, 0.03);
  raised[4] = kit.model.home[kit.joints[arm][4]];
  const foot = kit.joints[arm].map((j) => kit.model.home[j]);
  // a snack already over the dish barely moves before it is let go
  const reach = 0.2 + 0.5 * Math.min(1, travel(p.q, now) / 1.2);
  return [
    { name: 'reach over dish', dur: reach, to: withFinger(p.q, hold), lift: 0 },
    { name: 'open', dur: 0.28, to: withFinger(p.q, open), lift: 0, event: 'detach' },
    { name: 'retract', dur: 0.55, to: withFinger(p.qPre, open), lift: p.retractLift },
    { name: 'tuck', dur: 0.55, to: raised, lift: p.retractLift },
    { name: 'set down', dur: 0.35, to: foot, lift: 0, event: 'foot' },
  ];
}

/** Advance a running sequence. Returns the events whose segments finished (or started, for detach). */
export function advanceClaw(kit: ClawKit, c: ClawState, s: RobotState, dt: number): ('attach' | 'detach' | 'carry' | 'foot')[] {
  const out: ('attach' | 'detach' | 'carry' | 'foot')[] = [];
  if (!c.seq.length || !c.arm) return out;
  let seg = c.seq[c.seg];
  c.t += dt;
  while (c.t >= seg.dur) {
    // finish this segment
    kit.setArmQ(s, c.arm, seg.to);
    s.lift = seg.lift;
    if (seg.event && seg.event !== 'detach') out.push(seg.event);
    c.t -= seg.dur;
    c.seg++;
    if (c.seg >= c.seq.length) {
      c.seq = [];
      c.seg = 0;
      c.t = 0;
      return out;
    }
    c.from = kit.armQ(s, c.arm);
    c.liftFrom = s.lift;
    seg = c.seq[c.seg];
    if (seg.event === 'detach') out.push('detach');
  }
  const u = smoothstep(c.t / seg.dur);
  kit.setArmQ(s, c.arm, c.from.map((v, k) => v + (seg.to[k] - v) * u));
  s.lift = c.liftFrom + (seg.lift - c.liftFrom) * u;
  return out;
}

export function startSequence(kit: ClawKit, c: ClawState, s: RobotState, seq: Segment[]): void {
  c.seq = seq;
  c.seg = 0;
  c.t = 0;
  c.from = kit.armQ(s, c.arm!);
  c.liftFrom = s.lift;
}

// helpers
function axisRot(axis: Vec3, a: number): Mat3 {
  const [x, y, z] = axis;
  const c = Math.cos(a), sn = Math.sin(a), t = 1 - c;
  return [t * x * x + c, t * x * y - sn * z, t * x * z + sn * y, t * x * y + sn * z, t * y * y + c, t * y * z - sn * x, t * x * z - sn * y, t * y * z + sn * x, t * z * z + c];
}
function applyT(m: Mat3, v: Vec3): Vec3 {
  return [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];
}
function mulM(a: Mat3, b: Mat3): Mat3 {
  return [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
    a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
    a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
  ];
}
/** Largest change of J0, J2 or J3 between two arm poses (rad). */
function travel(a: number[], b: number[]): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[2] - b[2]), Math.abs(a[3] - b[3]));
}
/** Does a convex quad overlap an axis-aligned box grown by `m`? Separating axes: x, y and the quad's edges. */
function quadHitsBox(c: [number, number][], b: Box, m: number): boolean {
  const box: [number, number][] = [[b[0] - m, b[2] - m], [b[1] + m, b[2] - m], [b[1] + m, b[3] + m], [b[0] - m, b[3] + m]];
  const axes: [number, number][] = [[1, 0], [0, 1], [c[1][1] - c[0][1], c[0][0] - c[1][0]], [c[2][1] - c[1][1], c[1][0] - c[2][0]]];
  for (const [ax, ay] of axes) {
    let q0 = Infinity, q1 = -Infinity, b0 = Infinity, b1 = -Infinity;
    for (const [x, y] of c) {
      const p = x * ax + y * ay;
      q0 = Math.min(q0, p);
      q1 = Math.max(q1, p);
    }
    for (const [x, y] of box) {
      const p = x * ax + y * ay;
      b0 = Math.min(b0, p);
      b1 = Math.max(b1, p);
    }
    if (q1 < b0 || q0 > b1) return false;
  }
  return true;
}
