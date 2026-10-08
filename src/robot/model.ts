// The robot description written by tools/build-robot.mjs (public/assets/robot/robot.json), and the lookups
// every other module needs. All quantities are in the model's frame: metres, +x forward, +y left, +z up.

import type { Vec3 } from '../sim/math.ts';

export type Leg = 'LF' | 'RF' | 'LM' | 'RM' | 'LR' | 'RR';
export const LEGS: readonly Leg[] = ['LF', 'RF', 'LM', 'RM', 'LR', 'RR'];
export const ARMS: readonly Leg[] = ['LF', 'RF'];

export interface BodyJson {
  name: string;
  parent: number;
  pos: Vec3;
  joint: { name: string; axis: Vec3; range: [number, number] } | null;
  inertial: { mass: number; pos: Vec3 };
  mesh: string;
  rgba: [number, number, number, number];
  sites: { name: string; pos: Vec3 }[];
  cameras: {
    name: string;
    pos: Vec3;
    quat: [number, number, number, number];
    resolution: [number, number];
    sensorsize?: [number, number];
    focal?: [number, number];
    fovy?: number;
  }[];
}

export interface MeshJson {
  name: string;
  body: string;
  file: string;
  trisSource: number;
  /** Triangles this project added to the link (the right-middle calf's missing servo). */
  trisAdded?: number;
  tris: number;
  centroid: Vec3;
  min: Vec3;
  max: Vec3;
}

export type PartKind = 'servo' | 'shell' | 'bracket' | 'pad' | 'module' | 'chassis' | 'electronics' | 'mount';

/** One real part inside a link mesh (tools/parts.mjs). Names are ours: upstream names only the links. */
export interface PartJson {
  body: string;
  name: string;
  kind: PartKind;
  /** How the name is known: a servo body on its joint's axis, the upstream link name, the part's shape, or
   *  added by this project. */
  basis: 'servo' | 'link' | 'shape' | 'added';
  /** For a servo: the joint it turns. */
  joint?: string;
  note?: string;
  /** Its triangles in the shipped link mesh: [start, start + count). */
  start: number;
  count: number;
  /** Where it is in the upstream STL: piece `piece` of `of` (largest first), with `slivers` leftovers merged
   *  in; or the link it was copied from. */
  source: { piece: number; of: number; tris: number; slivers?: number; copiedFrom?: string };
  /** Source bounds in the link frame. */
  sizeMm: Vec3;
  center: Vec3;
}

export interface RobotJson {
  schema: 'jumper-lab-robot/1';
  source: { repo: string; commit: string; license: string; copyright: string; retrieved: string; files: { path: string; sha256: string }[]; note: string };
  frame: { units: 'm'; forward: '+x'; left: '+y'; up: '+z' };
  freeJoint: { name: string; body: string };
  joints: string[];
  bodies: BodyJson[];
  home: number[];
  standZ: number;
  legs: Leg[];
  feet: { leg: Leg; body: string; site: string }[];
  nominalFootXY: Record<Leg, [number, number]>;
  footSiteZ: number;
  tripodGroups: [Leg[], Leg[]];
  claw: {
    side: string;
    mirror: number[];
    gripperOpen: number;
    gripperClosed: number;
    apertureMm: [number, number][];
    stow: number[];
    presetsDeg: Record<'arm_thumb_up' | 'arm_thumb_down' | 'arm_web_up', [number, number, number, number]>;
    fingerReleasedDeg: number;
    fingerPosedDeg: number;
  };
  meshes: MeshJson[];
  parts: PartJson[];
  partsSource: {
    method: string;
    names: string;
    upstream: { pieces: number; slivers: number; parts: number; servos: number };
    added: { body: string; from: string; why: string }[];
  };
  massTotal: number;
  citations: Record<string, string>;
}

/** Indexed views over a RobotJson, built once. */
export class RobotModel {
  readonly json: RobotJson;
  readonly nJoints: number;
  readonly bodyIndex = new Map<string, number>();
  readonly jointIndex = new Map<string, number>();
  /** For each joint (wire order), the body it moves. */
  readonly jointBody: number[] = [];
  /** For each body, the joint index that moves it, or -1 for a fixed link. */
  readonly bodyJoint: number[] = [];
  /** For each body, its children. */
  readonly children: number[][] = [];
  readonly limits: [number, number][] = [];
  readonly home: Float64Array;

  constructor(json: RobotJson) {
    this.json = json;
    this.nJoints = json.joints.length;
    json.joints.forEach((n, i) => this.jointIndex.set(n, i));
    json.bodies.forEach((b, i) => {
      this.bodyIndex.set(b.name, i);
      this.children.push([]);
      if (b.parent >= 0) this.children[b.parent].push(i);
      this.bodyJoint.push(b.joint ? this.jointIndex.get(b.joint.name)! : -1);
    });
    json.joints.forEach((n) => {
      const bi = json.bodies.findIndex((b) => b.joint?.name === n);
      this.jointBody.push(bi);
      this.limits.push(json.bodies[bi].joint!.range);
    });
    this.home = Float64Array.from(json.home);
  }

  body(name: string): number {
    const i = this.bodyIndex.get(name);
    if (i === undefined) throw new Error(`no body ${name}`);
    return i;
  }
  joint(name: string): number {
    const i = this.jointIndex.get(name);
    if (i === undefined) throw new Error(`no joint ${name}`);
    return i;
  }
  /** Joint indices of a limb, proximal first: J0..J2 on legs, J0..J4 on arms. */
  limbJoints(leg: Leg): number[] {
    const n = ARMS.includes(leg) ? 5 : 3;
    return Array.from({ length: n }, (_, k) => this.joint(`${leg}_J${k}_joint`));
  }
  /** The foot body (where the leg touches the floor) and its contact site. */
  foot(leg: Leg): { body: number; site: Vec3 } {
    const f = this.json.feet.find((x) => x.leg === leg)!;
    const body = this.body(f.body);
    return { body, site: this.json.bodies[body].sites.find((s) => s.name === f.site)!.pos };
  }
  clampJoint(j: number, q: number): number {
    const [lo, hi] = this.limits[j];
    return q < lo ? lo : q > hi ? hi : q;
  }
  /** Map a left-arm angle (J0..J4) onto the given arm. */
  armAngle(leg: Leg, k: number, leftValue: number): number {
    return leg === 'LF' ? leftValue : leftValue * this.json.claw.mirror[k];
  }
}
