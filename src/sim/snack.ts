// The snack: an original 40 mm oat cube (GAME APPROXIMATION: size, mass and the simple drop below).
// It is only ever attached when the jaws have closed on it, and it falls from wherever the claw lets go.

import type { Course } from './course.ts';
import { add, apply3, mat3ToQuat, quatSlerp, quatToMat3, rotZ, sub, transpose3, type Mat3, type Quat, type Vec3 } from './math.ts';

export interface SnackState {
  mode: 'stand' | 'held' | 'falling' | 'rest';
  where: 'stand' | 'claw' | 'air' | 'dish' | 'floor';
  p: Vec3; // centre, world
  quat: Quat; // [w, x, y, z]
  v: Vec3;
  held: { arm: 'LF' | 'RF'; local: Vec3; localQuat: Quat } | null;
  settle: number; // seconds since landing (drives a small settle animation)
  restAt: Quat | null; // orientation it settles to
}

const G = 9.81;

export function snackOnStand(course: Course, yaw = 0.35): SnackState {
  const h = course.snackSize / 2;
  return {
    mode: 'stand',
    where: 'stand',
    p: [course.stand.c[0], course.stand.c[1], course.stand.topZ + h],
    quat: mat3ToQuat(rotZ(yaw)),
    v: [0, 0, 0],
    held: null,
    settle: 1,
    restAt: null,
  };
}

/** Attach to a palm frame without moving: store the snack's pose relative to the palm. */
export function attach(s: SnackState, arm: 'LF' | 'RF', palmR: Mat3, palmP: Vec3, gripWorld: Vec3, closingSlide = true): void {
  const RT = transpose3(palmR);
  // the jaws centre what they close on: the snack is drawn the last few mm onto the grip point during the close
  const p = closingSlide ? gripWorld : s.p;
  s.held = { arm, local: apply3(RT, sub(p, palmP)), localQuat: mat3ToQuat(mulM(RT, quatToMat3(s.quat))) };
  s.mode = 'held';
  s.where = 'claw';
  s.v = [0, 0, 0];
}

/** Follow the palm while held. */
export function followPalm(s: SnackState, palmR: Mat3, palmP: Vec3, dt: number): void {
  if (!s.held) return;
  const p = add(palmP, apply3(palmR, s.held.local));
  if (dt > 0) s.v = [(p[0] - s.p[0]) / dt, (p[1] - s.p[1]) / dt, (p[2] - s.p[2]) / dt];
  s.p = p;
  s.quat = mat3ToQuat(mulM(palmR, quatToMat3(s.held.localQuat)));
}

export function release(s: SnackState): void {
  s.held = null;
  s.mode = 'falling';
  s.where = 'air';
}

/** Integrate a falling snack and land it on the dish, the stand top or the floor. */
export function stepSnack(s: SnackState, course: Course, dt: number): 'dish' | 'floor' | 'stand' | null {
  if (s.mode === 'rest' || s.mode === 'stand') {
    if (s.restAt && s.settle < 0.25) {
      s.settle += dt;
      s.quat = quatSlerp(s.quat, s.restAt, Math.min(1, s.settle / 0.25));
    }
    return null;
  }
  if (s.mode !== 'falling') return null;
  const h = course.snackSize / 2;
  s.v[2] -= G * dt;
  s.p = [s.p[0] + s.v[0] * dt, s.p[1] + s.v[1] * dt, s.p[2] + s.v[2] * dt];
  const d = course.dish;
  const rd = Math.hypot(s.p[0] - d.c[0], s.p[1] - d.c[1]);
  const st = course.stand;
  const rs = Math.hypot(s.p[0] - st.c[0], s.p[1] - st.c[1]);
  let landed: 'dish' | 'floor' | 'stand' | null = null;
  if (rd < d.topR + h * 0.7 && s.p[2] - h <= d.rimZ) {
    if (rd + h * 0.6 <= d.innerR) {
      if (s.p[2] - h <= d.floorZ) { s.p[2] = d.floorZ + h; landed = 'dish'; }
    } else if (rd < d.innerR) {
      // caught on the inside of the rim: it tips in
      const k = (d.innerR - h * 0.6 - 0.002) / rd;
      s.p[0] = d.c[0] + (s.p[0] - d.c[0]) * k;
      s.p[1] = d.c[1] + (s.p[1] - d.c[1]) * k;
    } else {
      // on the outside of the rim: it slides off
      const k = (d.topR + h * 0.75) / Math.max(rd, 1e-6);
      s.p[0] = d.c[0] + (s.p[0] - d.c[0]) * k;
      s.p[1] = d.c[1] + (s.p[1] - d.c[1]) * k;
    }
  } else if (rs < st.topR + h * 0.5 && s.p[2] - h <= st.topZ && s.p[2] - h > st.topZ - 0.02) {
    s.p[2] = st.topZ + h;
    landed = 'stand';
  } else if (s.p[2] - h <= 0) {
    s.p[2] = h;
    landed = 'floor';
  }
  if (landed) {
    s.mode = landed === 'stand' ? 'stand' : 'rest';
    s.where = landed;
    s.v = [0, 0, 0];
    // settle flat, keeping the yaw it had
    const m = quatToMat3(s.quat);
    const yaw = Math.atan2(m[3], m[0]);
    s.restAt = mat3ToQuat(rotZ(yaw));
    s.settle = 0;
  }
  return landed;
}

function mulM(a: Mat3, b: Mat3): Mat3 {
  return [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
    a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
    a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
  ];
}
