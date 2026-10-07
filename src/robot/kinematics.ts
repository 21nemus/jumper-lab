// Forward kinematics of the jumper.xml tree. Every body frame is its parent's frame translated by the
// body's `pos` and then rotated about its hinge axis (jumper.xml has no fixed body rotations; build-robot
// asserts it). The same function serves rendering, IK, contact checks and the tests.

import { add, apply3, axisAngle, I3, mul3, quatToMat3, type Mat3, type Quat, type Vec3 } from '../sim/math.ts';
import type { RobotModel } from './model.ts';

export interface BasePose {
  pos: Vec3;
  quat: Quat; // [w, x, y, z]
}

export interface Frames {
  R: Mat3[]; // body orientation in the world
  p: Vec3[]; // body origin in the world
}

/** World frames of every body for a base pose and a joint vector in wire order. */
export function forward(model: RobotModel, base: BasePose, q: ArrayLike<number>, out?: Frames): Frames {
  const bodies = model.json.bodies;
  const R = out?.R ?? new Array<Mat3>(bodies.length);
  const p = out?.p ?? new Array<Vec3>(bodies.length);
  for (let i = 0; i < bodies.length; i++) {
    const b = bodies[i];
    let Ri: Mat3, pi: Vec3;
    if (b.parent < 0) {
      Ri = quatToMat3(base.quat);
      pi = base.pos;
    } else {
      Ri = R[b.parent];
      pi = add(p[b.parent], apply3(R[b.parent], b.pos));
    }
    const j = model.bodyJoint[i];
    if (j >= 0) Ri = mul3(Ri, axisAngle(b.joint!.axis, q[j]));
    R[i] = Ri;
    p[i] = pi;
  }
  return { R, p };
}

/** A point given in a body's frame, in world coordinates. */
export const pointInWorld = (f: Frames, body: number, local: Vec3): Vec3 => add(f.p[body], apply3(f.R[body], local));

/** World position of a leg's contact site (foot pad centre). */
export function footSite(model: RobotModel, f: Frames, leg: Parameters<RobotModel['foot']>[0]): Vec3 {
  const { body, site } = model.foot(leg);
  return pointInWorld(f, body, site);
}

/** The identity base pose at the calibrated standing height. */
export const standingBase = (model: RobotModel): BasePose => ({ pos: [0, 0, model.json.standZ], quat: [1, 0, 0, 0] });

/** Orientation of the world's identity, for convenience. */
export const IDENTITY: Mat3 = I3();

/** Total mass and centre of mass (world) from the model's inertials. */
export function centreOfMass(model: RobotModel, f: Frames): { mass: number; com: Vec3 } {
  let m = 0;
  const c: Vec3 = [0, 0, 0];
  model.json.bodies.forEach((b, i) => {
    const w = pointInWorld(f, i, b.inertial.pos);
    m += b.inertial.mass;
    c[0] += w[0] * b.inertial.mass;
    c[1] += w[1] * b.inertial.mass;
    c[2] += w[2] * b.inertial.mass;
  });
  return { mass: m, com: [c[0] / m, c[1] / m, c[2] / m] };
}
