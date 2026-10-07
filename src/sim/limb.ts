// One limb as a kinematic chain from the base to an end point, with forward kinematics in the base frame
// and a damped-least-squares IK that only moves the joints it is told to and never leaves the joint limits.
//
// Chains follow jumper.xml exactly: every link is its parent translated by `pos`, then turned about its hinge
// axis at the link origin.

import { add, apply3, axisAngle, cross, I3, mul3, sub, type Mat3, type Vec3 } from './math.ts';
import type { Leg, RobotModel } from '../robot/model.ts';

export interface ChainPose {
  p: Vec3; // end point, base frame
  R: Mat3; // end body orientation, base frame
  o: Vec3[]; // joint origins (base frame), per chain link
  a: Vec3[]; // joint axes (base frame), per chain link
}

export class Chain {
  readonly links: number[] = []; // body indices, proximal first
  readonly joints: number[] = []; // wire joint index per link, -1 if fixed
  readonly offsets: Vec3[] = [];
  readonly axes: Vec3[] = [];
  readonly end: Vec3;
  private readonly model: RobotModel;

  constructor(model: RobotModel, endBody: number, endLocal: Vec3) {
    this.model = model;
    this.end = endLocal;
    const path: number[] = [];
    for (let b = endBody; b > 0; b = model.json.bodies[b].parent) path.unshift(b);
    for (const b of path) {
      const body = model.json.bodies[b];
      this.links.push(b);
      this.joints.push(model.bodyJoint[b]);
      this.offsets.push(body.pos);
      this.axes.push(body.joint ? body.joint.axis : [0, 0, 0]);
    }
  }

  /** Forward kinematics in the base frame. */
  fk(q: ArrayLike<number>): ChainPose {
    let R = I3();
    let p: Vec3 = [0, 0, 0];
    const o: Vec3[] = [];
    const a: Vec3[] = [];
    for (let i = 0; i < this.links.length; i++) {
      p = add(p, apply3(R, this.offsets[i]));
      const j = this.joints[i];
      o.push(p);
      a.push(j >= 0 ? apply3(R, this.axes[i]) : [0, 0, 0]);
      if (j >= 0) R = mul3(R, axisAngle(this.axes[i], q[j]));
    }
    return { p: add(p, apply3(R, this.end)), R, o, a };
  }

  /** A point given in the end body's frame, in the base frame. */
  point(q: ArrayLike<number>, local: Vec3): Vec3 {
    const f = this.fk(q);
    const endBodyOrigin = sub(f.p, apply3(f.R, this.end));
    return add(endBodyOrigin, apply3(f.R, local));
  }

  /**
   * Move the `active` joints so the chain's end point reaches `target` (base frame). Writes into `q`.
   *
   * Damped least squares in joint space with a weak pull towards `rest` (per-joint weights `restWeight`), a
   * capped step, and the joint limits (shrunk by `margin`) enforced every iteration. The pull keeps the
   * solution on the same branch as the rest pose — the claw arms have two parallel pitch joints, so an
   * unbiased solver can fold the elbow the other way and stall against a stop. Returns the remaining error (m).
   */
  solve(
    q: Float64Array,
    target: Vec3,
    active: number[],
    opts: { iters?: number; tol?: number; lambda?: number; margin?: number; rest?: ArrayLike<number>; restWeight?: number[]; maxStep?: number } = {},
  ): number {
    const iters = opts.iters ?? 12;
    const tol = opts.tol ?? 2e-5;
    const lambda2 = (opts.lambda ?? 0.003) ** 2;
    const margin = opts.margin ?? 0.01;
    const maxStep = opts.maxStep ?? 0.3;
    const n = active.length;
    const rest = opts.rest;
    const w2 = active.map((_, k) => (rest ? (opts.restWeight?.[k] ?? 0.002) ** 2 : 0));
    const idx = active.map((j) => this.joints.indexOf(j));
    let err = Infinity;
    const A = new Float64Array(n * n);
    const b = new Float64Array(n);
    for (let it = 0; it < iters; it++) {
      const f = this.fk(q);
      const e = sub(target, f.p);
      err = Math.hypot(e[0], e[1], e[2]);
      if (err < tol) break;
      const cols = idx.map((i) => cross(f.a[i], sub(f.p, f.o[i])));
      // (J^T J + diag(lambda^2 + w^2)) dq = J^T e + diag(w^2) (rest - q)
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) A[r * n + c] = cols[r][0] * cols[c][0] + cols[r][1] * cols[c][1] + cols[r][2] * cols[c][2];
        A[r * n + r] += lambda2 + w2[r];
        b[r] = cols[r][0] * e[0] + cols[r][1] * e[1] + cols[r][2] * e[2] + (rest ? w2[r] * (rest[active[r]] - q[active[r]]) : 0);
      }
      const dq = solveN(A, b, n);
      let norm = 0;
      for (let k = 0; k < n; k++) norm = Math.max(norm, Math.abs(dq[k]));
      const s = norm > maxStep ? maxStep / norm : 1;
      for (let k = 0; k < n; k++) {
        const j = active[k];
        const [lo, hi] = this.model.limits[j];
        q[j] = Math.min(hi - margin, Math.max(lo + margin, q[j] + dq[k] * s));
      }
    }
    if (err >= tol) {
      const f = this.fk(q);
      const e = sub(target, f.p);
      err = Math.hypot(e[0], e[1], e[2]);
    }
    return err;
  }
}

/** Solve A x = b for a small dense system (Gaussian elimination with partial pivoting). */
function solveN(A: Float64Array, b: Float64Array, n: number): Float64Array {
  const M = Float64Array.from(A);
  const x = Float64Array.from(b);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[p * n + c])) p = r;
    if (Math.abs(M[p * n + c]) < 1e-18) return new Float64Array(n);
    if (p !== c) {
      for (let k = 0; k < n; k++) [M[c * n + k], M[p * n + k]] = [M[p * n + k], M[c * n + k]];
      [x[c], x[p]] = [x[p], x[c]];
    }
    for (let r = c + 1; r < n; r++) {
      const f = M[r * n + c] / M[c * n + c];
      for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k];
      x[r] -= f * x[c];
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r];
    for (let k = r + 1; k < n; k++) s -= M[r * n + k] * x[k];
    x[r] = s / M[r * n + r];
  }
  return x;
}

export interface FootChain {
  chain: Chain;
  gaitJoints: number[];
  restWeight: number[];
}

/** The chain from the base to a leg's contact site, the joints the gait drives on it, and how hard each is
 *  held near HOME. Legs: J0 yaw, J1 + J2 pitch. Claw arms walking as legs: J0, J1 (roll, held firmly), J2, J3;
 *  the J4 finger is never moved by walking. */
export function footChain(model: RobotModel, leg: Leg): FootChain {
  const { body, site } = model.foot(leg);
  const chain = new Chain(model, body, site);
  const js = model.limbJoints(leg);
  if (js.length === 3) return { chain, gaitJoints: js, restWeight: [0.002, 0.002, 0.002] };
  return { chain, gaitJoints: [js[0], js[1], js[2], js[3]], restWeight: [0.002, 0.05, 0.002, 0.002] };
}

/** Solve a foot: warm start from `q`; if that misses, retry from HOME and keep the better answer. */
export function solveFoot(fc: FootChain, q: Float64Array, home: Float64Array, target: Vec3, iters = 8): number {
  const opts = { iters, rest: home, restWeight: fc.restWeight };
  const warm = Float64Array.from(q);
  const e1 = fc.chain.solve(warm, target, fc.gaitJoints, opts);
  if (e1 < 3e-4) {
    for (const j of fc.gaitJoints) q[j] = warm[j];
    return e1;
  }
  const cold = Float64Array.from(home);
  const e2 = fc.chain.solve(cold, target, fc.gaitJoints, { ...opts, iters: 30 });
  const best = e2 < e1 ? cold : warm;
  for (const j of fc.gaitJoints) q[j] = best[j];
  return Math.min(e1, e2);
}
