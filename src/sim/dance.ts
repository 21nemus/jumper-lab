// The crab rave: OUR choreography (GAME APPROXIMATION), not one of KingKong's recordings. A routine generated
// from the model at the music's tempo, played through the same path as the recorded gestures:
//   - widen the stance: each middle foot steps 45 mm forward. At HOME the centre of mass sits 17 mm in front
//     of the four walking feet, so lifting both claws as it stands would tip it over; the wider stance puts
//     the centre of mass about 3 cm inside them;
//   - lift both claws (they are the front feet) into a claws-up pose;
//   - dance eight bars on the four walking legs: pump, wave, sway and double time, the claws clacking on the
//     beat and the body bouncing between beats;
//   - put the claws back where they stood and step the middle feet home.
// Feet that are down stay planted (IK) and every joint stays inside its limits; tests/dance.test.ts checks
// both, and that the centre of mass stays inside the feet that are down. tools/build-dance.mjs writes the
// clip to public/assets/motions/rave.json.

import type { ClipData } from './clip.ts';
import { CORNER, type Course } from './course.ts';
import { RobotController } from './robot.ts';
import { footChain, solveFoot, type FootChain } from './limb.ts';
import { applyT3, mat3ToQuat, rpyToMat3, smoothstep, type Vec3 } from './math.ts';
import { LEGS, type Leg, type RobotModel } from '../robot/model.ts';

export const RAVE_BPM = 124;
/** In beats: stance and claws up (two bars), the dance (eight bars), claws down and stance back (two bars). */
export const RAVE_BEATS = { setup: 8, dance: 32, outro: 8 } as const;
export const RAVE_TOTAL_BEATS = RAVE_BEATS.setup + RAVE_BEATS.dance + RAVE_BEATS.outro;

export const STANCE_STEP = 0.045; // middle feet forward (m)
const SWING = 0.022; // how high a stepping foot lifts (m)
const CLAW_LIFT = 0.03; // claws come straight up this far before they swing into the dance pose (m)
const BOUNCE = 0.008; // body rise between beats (m)
const DEG = Math.PI / 180;
/** The left claw's dance pose, J0..J3 (left-arm convention; the right claw mirrors it): the arm out on the
 *  front-left diagonal with the forearm and claw raised, pointing up. */
const UP = [-45 * DEG, 0, 50 * DEG, 35 * DEG];
const FINGER_OPEN = -0.45; // about 54 mm open (upstream's aperture table), left-arm convention

type Arm = 'LF' | 'RF';
const ARMS: Arm[] = ['LF', 'RF'];

/** One frame of the dance itself, at dance beat d (0..32): left-arm-convention offsets from UP per claw,
 *  finger openness (0 shut .. 1 open) and the body's offsets. */
export function danceFrame(d: number): { left: number[]; right: number[]; open: number; z: number; y: number; roll: number; yaw: number } {
  const f = d - Math.floor(d); // 0 on the beat
  const onBeat = (1 + Math.cos(2 * Math.PI * f)) / 2; // 1 on the beat, 0 between
  const half = Math.sin(Math.PI * d); // a two-beat swing
  // each move fades in and out over half a beat, so moves hand over without a jump
  const w = (from: number, to: number) => smoothstep((d - from) / 0.5) * (1 - smoothstep((d - to + 0.5) / 0.5));
  const pump = w(0, 8), wave = w(8, 16), sway = w(16, 24), dbl = w(24, 31), tada = smoothstep((d - 30.5) / 1);
  const left = [0, 0, 0, 0], right = [0, 0, 0, 0];
  // pump: both claws dip on the beat
  left[2] += -16 * DEG * onBeat * pump;
  left[3] += 6 * DEG * onBeat * pump;
  right[2] += -16 * DEG * onBeat * pump;
  right[3] += 6 * DEG * onBeat * pump;
  // wave: one claw up while the other goes down, a beat each
  left[2] += 15 * DEG * half * wave;
  right[2] += -15 * DEG * half * wave;
  // sway: both claws swing the same way overhead (J0 mirrors, so the right claw's offset flips sign)
  left[0] += 12 * DEG * half * sway;
  right[0] += -12 * DEG * half * sway;
  // double time: a quick dip on every half beat
  const eighth = (1 + Math.cos(4 * Math.PI * f)) / 2;
  left[2] += -10 * DEG * eighth * dbl;
  right[2] += -10 * DEG * eighth * dbl;
  // ta-da: claws spread wide and high on the last beat
  left[0] += 22 * DEG * tada;
  right[0] += 22 * DEG * tada;
  left[2] += 12 * DEG * tada;
  right[2] += 12 * DEG * tada;
  // the claws clack shut on the beat and spring open after it
  const snap = f < 0.1 ? 0 : f < 0.4 ? smoothstep((f - 0.1) / 0.3) : f < 0.86 ? 1 : 1 - smoothstep((f - 0.86) / 0.14);
  const open = snap * (1 - tada) + tada;
  return {
    left,
    right,
    open,
    z: BOUNCE * (1 - onBeat) * (1 - tada) + BOUNCE * tada,
    y: 0.012 * half * sway,
    roll: (2.5 * DEG * half * wave) * (1 - tada),
    yaw: 5 * DEG * half * sway,
  };
}

/** The whole routine as a clip (joint angles and body pose at `hz`), from standing at HOME back to HOME. */
export function buildRaveClip(model: RobotModel, hz = 50): ClipData {
  const beatSec = 60 / RAVE_BPM;
  const duration = RAVE_TOTAL_BEATS * beatSec;
  const frames = Math.round(duration * hz) + 1;
  const home = Float64Array.from(model.home);
  const standZ = model.json.standZ;
  const claw = model.json.claw;
  const chains = {} as Record<Leg, FootChain>;
  const foot0 = {} as Record<Leg, Vec3>; // where each foot stands at HOME (clip frame, z up from the floor)
  for (const leg of LEGS) {
    chains[leg] = footChain(model, leg);
    const p = chains[leg].chain.fk(home).p;
    foot0[leg] = [p[0], p[1], p[2] + standZ];
  }
  const forward = (p: Vec3): Vec3 => [p[0] + STANCE_STEP, p[1], p[2]];
  const lerp3 = (a: Vec3, b: Vec3, u: number): Vec3 => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
  /** A stepping foot: from `a` to `b` in [t0, t0 + 1.5] beats, lifted on the way. */
  const step = (b: number, t0: number, a: Vec3, c: Vec3): Vec3 => {
    const u = Math.max(0, Math.min(1, (b - t0) / 1.5));
    const p = lerp3(a, c, smoothstep(u));
    return [p[0], p[1], p[2] + SWING * Math.sin(Math.PI * u)];
  };
  // actual joint angles for a claw from left-convention values
  const armQ = (arm: Arm, left: number[], open: number): number[] => {
    const out = left.map((v, k) => model.armAngle(arm, k, v));
    out.push(model.armAngle(arm, 4, claw.gripperClosed + (FINGER_OPEN - claw.gripperClosed) * open));
    return out;
  };
  const setArm = (q: Float64Array, arm: Arm, a: number[]) => model.limbJoints(arm).forEach((j, k) => (q[j] = a[k]));
  const getArm = (q: Float64Array, arm: Arm) => model.limbJoints(arm).map((j) => q[j]);
  // the claws lifted straight up off their floor spots (standing body), and in the dance pose
  const lifted = {} as Record<Arm, number[]>;
  for (const arm of ARMS) {
    const ql = Float64Array.from(home);
    const p = foot0[arm];
    solveFoot(chains[arm], ql, home, [p[0], p[1], p[2] + CLAW_LIFT - standZ], 40);
    lifted[arm] = getArm(ql, arm);
  }
  const up = { LF: armQ('LF', UP, 0), RF: armQ('RF', UP, 0) };
  const blendArm = (a: number[], b: number[], u: number) => a.map((v, k) => v + (b[k] - v) * u);

  const q = Float64Array.from(home);
  const qOut: number[][] = [];
  const baseOut: number[][] = [];
  const setup = RAVE_BEATS.setup, danceEnd = setup + RAVE_BEATS.dance;
  for (let i = 0; i < frames; i++) {
    const b = Math.min(RAVE_TOTAL_BEATS, i / hz / beatSec);
    // body pose
    let x = 0, y = 0, z = standZ, roll = 0, yaw = 0;
    let move: ReturnType<typeof danceFrame> | null = null;
    if (b >= setup && b < danceEnd) {
      move = danceFrame(b - setup);
      y = move.y;
      z += move.z;
      roll = move.roll;
      yaw = move.yaw;
    } else if (b >= danceEnd) {
      z += danceFrame(RAVE_BEATS.dance).z * (1 - smoothstep(b - danceEnd)); // settle from the ta-da
    }
    const R = rpyToMat3(roll, 0, yaw);
    const toBase = (p: Vec3): Vec3 => applyT3(R, [p[0] - x, p[1] - y, p[2] - z]);

    // the four walking legs: planted, except the middle feet stepping out (setup) and back (outro)
    const feet: Partial<Record<Leg, Vec3>> = {
      LR: foot0.LR,
      RR: foot0.RR,
      LM: b < 2 ? step(b, 0.25, foot0.LM, forward(foot0.LM)) : b < danceEnd + 5 ? forward(foot0.LM) : step(b, danceEnd + 5.25, forward(foot0.LM), foot0.LM),
      RM: b < 4 ? step(b, 2.25, foot0.RM, forward(foot0.RM)) : b < danceEnd + 3 ? forward(foot0.RM) : step(b, danceEnd + 3.25, forward(foot0.RM), foot0.RM),
    };
    for (const leg of ['LM', 'RM', 'LR', 'RR'] as Leg[]) solveFoot(chains[leg], q, home, toBase(feet[leg]!), 12);

    // the claws: feet on the floor, lifted straight up, swung into the dance pose, dancing, and back
    for (const arm of ARMS) {
      const p = foot0[arm];
      if (b < 4 || b >= danceEnd + 3) {
        // standing on it (the body is at its standing pose here)
        solveFoot(chains[arm], q, home, toBase(p), 12);
      } else if (b < 4.75) {
        solveFoot(chains[arm], q, home, toBase([p[0], p[1], p[2] + CLAW_LIFT * smoothstep((b - 4) / 0.75)]), 12);
      } else if (b < 7) {
        setArm(q, arm, blendArm(lifted[arm], up[arm], smoothstep((b - 4.75) / 2.25)));
      } else if (b < setup) {
        setArm(q, arm, up[arm]);
      } else if (b < danceEnd) {
        const m = move!;
        setArm(q, arm, armQ(arm, UP.map((v, k) => v + (arm === 'LF' ? m.left : m.right)[k]), m.open));
      } else if (b < danceEnd + 2.25) {
        // from where the dance ended (ta-da) down to just above the floor spot
        const end = danceFrame(RAVE_BEATS.dance);
        const from = armQ(arm, UP.map((v, k) => v + (arm === 'LF' ? end.left : end.right)[k]), end.open);
        setArm(q, arm, blendArm(from, lifted[arm], smoothstep((b - danceEnd) / 2.25)));
      } else {
        solveFoot(chains[arm], q, home, toBase([p[0], p[1], p[2] + CLAW_LIFT * (1 - smoothstep((b - danceEnd - 2.25) / 0.75))]), 12);
      }
    }
    // land exactly on HOME at the end, so the gait takes over from a clean stance
    const settle = smoothstep((b - (RAVE_TOTAL_BEATS - 0.5)) / 0.5);
    if (settle > 0) for (let j = 0; j < q.length; j++) q[j] += (home[j] - q[j]) * settle;

    qOut.push(Array.from(q));
    const quat = mat3ToQuat(R);
    baseOut.push([x, y, z, quat[0], quat[1], quat[2], quat[3]]);
  }
  return {
    schema: 'jumper-lab-clip/1',
    name: 'rave',
    title: 'Crab rave',
    hz,
    frames,
    duration,
    joints: [...model.json.joints],
    scale: 1,
    q: qOut,
    base: baseOut,
    source: {
      generator: 'src/sim/dance.ts',
      bpm: RAVE_BPM,
      note: 'Our choreography (game approximation), generated from the model, not a KingKong recording. Stance widened so the centre of mass stays inside the four walking feet while both claws are up.',
    },
  };
}

/** The clip as shipped: values quantised to 1e-4, like the recorded gestures. */
export function quantiseClip(c: ClipData): ClipData {
  const quant = (v: number) => Math.round(v * 10000);
  return { ...c, scale: 1e-4, q: c.q.map((r) => r.map(quant)), base: c.base.map((r) => r.map(quant)) };
}

/** One period of Jumper crab-walking to its left at full speed: the real gait controller at a steady pace,
 *  resampled at `hz`, for the rave crowd to loop while they scuttle in and out. Joint angles and body height
 *  per frame, and how far the body travels in one period (so the feet stay planted when it is played back). */
export interface ScuttleCycle {
  hz: number;
  frames: number;
  period: number;
  distance: number;
  q: number[][];
  z: number[];
}

export function buildScuttleCycle(model: RobotModel, hz = 60): ScuttleCycle {
  const ctl = new RobotController(model);
  const open: Course = { ...CORNER, obstacles: [], bounds: { min: [-100, -100], max: [100, 100] } };
  const s = ctl.initial(0, 0, 0);
  const dt = 1 / 120;
  const cmd = { fwd: 0, left: 1, turn: 0 };
  for (let i = 0; i < 4 / dt; i++) ctl.step(s, dt, cmd, open); // up to speed, a steady gait
  let prev = s.phase;
  while (!(s.phase < prev)) {
    prev = s.phase;
    ctl.step(s, dt, cmd, open); // to the start of a period
  }
  const rec: { phase: number; q: number[]; z: number; y: number }[] = [{ phase: s.phase, q: [...s.q], z: s.z, y: s.y }];
  for (;;) {
    prev = s.phase;
    ctl.step(s, dt, cmd, open);
    const wrapped = s.phase < prev;
    rec.push({ phase: wrapped ? s.phase + 1 : s.phase, q: [...s.q], z: s.z, y: s.y });
    if (wrapped) break;
  }
  const first = rec[0], last = rec[rec.length - 1];
  const period = ((rec.length - 1) * dt) / (last.phase - first.phase); // seconds per gait period
  const frames = Math.round(period * hz);
  const q: number[][] = [], z: number[] = [];
  for (let f = 0; f < frames; f++) {
    const ph = first.phase + f / frames; // one full period of phase
    let i = 0;
    while (i < rec.length - 2 && rec[i + 1].phase < ph) i++;
    const a = rec[i], b = rec[i + 1];
    const u = Math.max(0, Math.min(1, (ph - a.phase) / (b.phase - a.phase || 1)));
    q.push(a.q.map((v, j) => v + (b.q[j] - v) * u));
    z.push(a.z + (b.z - a.z) * u);
  }
  // distance covered in exactly one period of phase
  const yAt = (ph: number) => {
    let i = 0;
    while (i < rec.length - 2 && rec[i + 1].phase < ph) i++;
    const a = rec[i], b = rec[i + 1];
    return a.y + (b.y - a.y) * Math.max(0, Math.min(1, (ph - a.phase) / (b.phase - a.phase || 1)));
  };
  const distance = yAt(first.phase + 1) - yAt(first.phase);
  return { hz, frames, period, distance, q, z };
}
