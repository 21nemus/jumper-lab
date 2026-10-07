// The follow camera: low, toy-photography framing behind the robot, easing after its heading. A drag
// orbits it around the robot for a moment; it drifts back once the robot walks off. Model frame throughout.

import * as THREE from 'three';
import type { Vec3 } from '../sim/math.ts';
import { toThree } from './stage.ts';

export interface CamPose {
  eye: Vec3;
  at: Vec3;
  fov: number;
}

export class FollowCamera {
  yaw = 0; // camera azimuth (model frame, radians): the direction it looks along
  pitch = 0.42;
  dist = 0.9;
  orbitYaw = 0;
  orbitPitch = 0;
  zoom = 1;
  private at: Vec3 = [0, 0, 0.07];
  private idle = 0;
  private near = 0; // 0 far from the target .. 1 right at it (eased)
  private side = 0; // which side of the robot the target is on: -1 right .. 1 left (eased)
  portrait = false;
  enabled = true;

  constructor(canvas: HTMLCanvasElement) {
    let drag: { id: number; x: number; y: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (!this.enabled || e.pointerType !== 'mouse' || e.button !== 0) return;
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      this.orbitYaw -= (e.clientX - drag.x) * 0.006;
      this.orbitPitch = Math.max(-0.3, Math.min(0.75, this.orbitPitch + (e.clientY - drag.y) * 0.004));
      drag.x = e.clientX;
      drag.y = e.clientY;
      this.idle = 0;
    });
    const end = () => (drag = null);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener(
      'wheel',
      (e) => {
        if (!this.enabled) return;
        e.preventDefault();
        this.zoom = Math.max(0.55, Math.min(1.8, this.zoom * Math.exp(e.deltaY * 0.0012)));
      },
      { passive: false },
    );
  }

  /** Jump straight to the follow pose (no easing), e.g. after a reset. */
  snap(robot: { x: number; y: number; yaw: number }): void {
    this.yaw = robot.yaw;
    this.at = [robot.x + Math.cos(robot.yaw) * 0.12, robot.y + Math.sin(robot.yaw) * 0.12, 0.07];
    this.orbitYaw = 0;
    this.orbitPitch = 0;
  }

  update(dt: number, robot: { x: number; y: number; yaw: number }, moving: boolean, focus?: Vec3 | null): CamPose {
    // ease the heading behind the robot
    let dy = robot.yaw - this.yaw;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    this.yaw += dy * Math.min(1, dt * 2.2);
    this.idle += dt;
    if (moving && this.idle > 1.2) {
      this.orbitYaw *= Math.exp(-dt * 1.5);
      this.orbitPitch *= Math.exp(-dt * 1.5);
    }
    // Close to the target (the snack on its stand, or the dish) the robot's own back would hide it: look down
    // over the robot from the side the target is on, so the claw, the target and its reach ring stay in view.
    let near = 0, side = 0;
    if (focus) {
      const dx = focus[0] - robot.x, dy = focus[1] - robot.y;
      const t = Math.max(0, Math.min(1, (0.8 - Math.hypot(dx, dy)) / 0.45));
      near = t * t * (3 - 2 * t);
      side = Math.max(-1, Math.min(1, (-Math.sin(robot.yaw) * dx + Math.cos(robot.yaw) * dy) / 0.12));
    }
    const e = Math.min(1, dt * 2.5);
    this.near += (near - this.near) * e;
    this.side += (side - this.side) * e;
    const lead = 0.12;
    let want: Vec3 = [robot.x + Math.cos(robot.yaw) * lead, robot.y + Math.sin(robot.yaw) * lead, 0.07];
    if (focus) {
      const f = 0.33 + 0.22 * this.near;
      want = [want[0] + (focus[0] - want[0]) * f, want[1] + (focus[1] - want[1]) * f, 0.075];
    }
    const k = Math.min(1, dt * 5);
    this.at = [this.at[0] + (want[0] - this.at[0]) * k, this.at[1] + (want[1] - this.at[1]) * k, this.at[2] + (want[2] - this.at[2]) * k];
    const dist = (this.portrait ? 1.45 : 1.18) * this.zoom * (1 - 0.15 * this.near);
    const pitch = Math.max(0.12, Math.min(1.3, (this.portrait ? 0.56 : 0.5) + this.orbitPitch + 0.4 * this.near));
    const az = this.yaw + this.orbitYaw + Math.PI - 0.5 * this.near * this.side;
    const eye: Vec3 = [this.at[0] + Math.cos(az) * Math.cos(pitch) * dist, this.at[1] + Math.sin(az) * Math.cos(pitch) * dist, this.at[2] + Math.sin(pitch) * dist];
    return { eye, at: this.at, fov: this.portrait ? 50 : 40 };
  }
}

/** Ease a camera between poses (used by inspect and the tour). */
export function applyCamera(cam: THREE.PerspectiveCamera, pose: CamPose): void {
  cam.position.copy(toThree(pose.eye));
  cam.lookAt(toThree(pose.at));
  if (Math.abs(cam.fov - pose.fov) > 0.01) {
    cam.fov = pose.fov;
    cam.updateProjectionMatrix();
  }
}

export function blendPose(a: CamPose, b: CamPose, t: number): CamPose {
  const u = t * t * (3 - 2 * t);
  const l = (x: Vec3, y: Vec3): Vec3 => [x[0] + (y[0] - x[0]) * u, x[1] + (y[1] - x[1]) * u, x[2] + (y[2] - x[2]) * u];
  return { eye: l(a.eye, b.eye), at: l(a.at, b.at), fov: a.fov + (b.fov - a.fov) * u };
}
