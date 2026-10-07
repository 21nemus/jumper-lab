// The Snack Heist course: a floor-level apartment corner, in the model frame (metres, +x forward from the
// start, +y left, +z up). Layout, sizes and collision are GAME APPROXIMATION; the scale is real (the robot
// stands 368 x 415 x 178 mm, a hardback is ~24 cm, a sofa base ~40 cm high).

export type Shape =
  | { kind: 'circle'; c: [number, number]; r: number }
  | { kind: 'box'; c: [number, number]; half: [number, number]; yaw: number; round: number };

export interface Obstacle {
  id: string;
  label: string;
  shape: Shape;
  height: number;
  /** Reach objects (the stand, the dish) only stop the robot's core, so a claw can get over them. */
  reach?: boolean;
}

export interface Pedestal {
  c: [number, number];
  baseR: number;
  stemR: number;
  topR: number;
  topZ: number; // height of the top surface
}

export interface Course {
  id: string;
  version: number;
  title: string;
  bounds: { min: [number, number]; max: [number, number] };
  start: { x: number; y: number; yaw: number };
  obstacles: Obstacle[];
  stand: Pedestal; // the snack sits on its top
  dish: Pedestal & { innerR: number; floorZ: number; rimZ: number }; // the delivery tray
  snackSize: number; // edge length of the snack cube
}

/** Robot collision radii (GAME APPROXIMATION): its whole footprint, and the shell core. */
export const ROBOT_R = 0.195;
export const CORE_R = 0.115;
export const FOOT_R = 0.016;

export const CORNER: Course = {
  id: 'corner',
  version: 1,
  title: 'The Corner',
  bounds: { min: [-0.85, -1.05], max: [2.2, 1.2] },
  start: { x: 0, y: 0, yaw: 0 },
  obstacles: [
    { id: 'wall-back', label: 'wall', shape: { kind: 'box', c: [2.45, 0.1], half: [0.25, 2.4], yaw: 0, round: 0 }, height: 2.6 },
    { id: 'wall-left', label: 'wall', shape: { kind: 'box', c: [0.7, 1.45], half: [2.4, 0.25], yaw: 0, round: 0 }, height: 2.6 },
    { id: 'sofa', label: 'sofa', shape: { kind: 'box', c: [-0.42, 0.98], half: [0.62, 0.24], yaw: 0, round: 0.06 }, height: 0.42 },
    { id: 'books', label: 'stacked hardbacks', shape: { kind: 'box', c: [0.72, 0.42], half: [0.125, 0.088], yaw: 0.32, round: 0.006 }, height: 0.07 },
    { id: 'plant', label: 'plant pot', shape: { kind: 'circle', c: [1.18, -0.32], r: 0.13 }, height: 0.3 },
    { id: 'pouf', label: 'pouf', shape: { kind: 'circle', c: [0.32, -0.78], r: 0.23 }, height: 0.16 },
    { id: 'ramp', label: 'birch ramp', shape: { kind: 'box', c: [1.5, 1.04], half: [0.34, 0.11], yaw: 0, round: 0.04 }, height: 0.07 },
    { id: 'basket', label: 'woven basket', shape: { kind: 'circle', c: [1.98, -0.62], r: 0.17 }, height: 0.24 },
    { id: 'stand', label: 'snack stand', shape: { kind: 'circle', c: [1.72, 0.58], r: 0.036 }, height: 0.07, reach: true },
    { id: 'dish', label: 'delivery dish', shape: { kind: 'circle', c: [0.2, 0.62], r: 0.034 }, height: 0.06, reach: true },
  ],
  stand: { c: [1.72, 0.58], baseR: 0.034, stemR: 0.009, topR: 0.013, topZ: 0.066 },
  dish: { c: [0.2, 0.62], baseR: 0.032, stemR: 0.012, topR: 0.074, topZ: 0.058, innerR: 0.064, floorZ: 0.043, rimZ: 0.058 },
  snackSize: 0.04,
};

/** Signed distance from a point to a shape's footprint (negative inside) and the outward normal there. */
export function shapeDistance(s: Shape, p: [number, number]): { d: number; n: [number, number] } {
  if (s.kind === 'circle') {
    const dx = p[0] - s.c[0], dy = p[1] - s.c[1];
    const l = Math.hypot(dx, dy);
    if (l < 1e-9) return { d: -s.r, n: [1, 0] }; // dead centre: any way out will do
    return { d: l - s.r, n: [dx / l, dy / l] };
  }
  const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
  const lx = c * (p[0] - s.c[0]) + sn * (p[1] - s.c[1]);
  const ly = -sn * (p[0] - s.c[0]) + c * (p[1] - s.c[1]);
  const hx = s.half[0] - s.round, hy = s.half[1] - s.round;
  const qx = Math.abs(lx) - hx, qy = Math.abs(ly) - hy;
  let d: number, nx: number, ny: number;
  if (qx > 0 || qy > 0) {
    const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
    const l = Math.hypot(ox, oy) || 1e-9;
    d = l - s.round;
    nx = (ox / l) * (lx >= 0 ? 1 : -1);
    ny = (oy / l) * (ly >= 0 ? 1 : -1);
  } else if (qx > qy) {
    d = qx - s.round; nx = lx >= 0 ? 1 : -1; ny = 0;
  } else {
    d = qy - s.round; nx = 0; ny = ly >= 0 ? 1 : -1;
  }
  return { d, n: [c * nx - sn * ny, sn * nx + c * ny] };
}

export interface Contact {
  id: string;
  n: [number, number];
  depth: number;
}

/**
 * Push a robot centred at `p` out of every obstacle and the course bounds. Returns the corrected centre and
 * the contacts that pushed it.
 */
export function resolveRobot(course: Course, p: [number, number], r = ROBOT_R, core = CORE_R): { p: [number, number]; contacts: Contact[] } {
  let x = p[0], y = p[1];
  const contacts: Contact[] = [];
  for (let iter = 0; iter < 3; iter++) {
    for (const o of course.obstacles) {
      const rr = o.reach ? core : r;
      const { d, n } = shapeDistance(o.shape, [x, y]);
      if (d < rr) {
        const depth = rr - d;
        x += n[0] * depth;
        y += n[1] * depth;
        if (iter === 0) contacts.push({ id: o.id, n, depth });
      }
    }
    const { min, max } = course.bounds;
    if (x < min[0] + r) { if (iter === 0) contacts.push({ id: 'bounds', n: [1, 0], depth: min[0] + r - x }); x = min[0] + r; }
    if (y < min[1] + r) { if (iter === 0) contacts.push({ id: 'bounds', n: [0, 1], depth: min[1] + r - y }); y = min[1] + r; }
    if (x > max[0] - r) { if (iter === 0) contacts.push({ id: 'bounds', n: [-1, 0], depth: x - (max[0] - r) }); x = max[0] - r; }
    if (y > max[1] - r) { if (iter === 0) contacts.push({ id: 'bounds', n: [0, -1], depth: y - (max[1] - r) }); y = max[1] - r; }
  }
  return { p: [x, y], contacts };
}

/** Move a planned foothold out of any obstacle footprint (feet never land on furniture). */
export function clearFoothold(course: Course, p: [number, number]): [number, number] {
  let x = p[0], y = p[1];
  for (const o of course.obstacles) {
    const { d, n } = shapeDistance(o.shape, [x, y]);
    const need = FOOT_R + (o.reach ? 0.004 : 0.01);
    if (d < need) {
      x += n[0] * (need - d);
      y += n[1] * (need - d);
    }
  }
  return [x, y];
}
