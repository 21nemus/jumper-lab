// Playback of KingKong's recorded gestures (RECORDED PLAYBACK in the UI): joint angles exactly as recorded,
// body pose solved from the feet by tools/build-motions.mjs. Interpolated between the 50 Hz frames. The crab
// rave plays through here too, but it is our generated choreography (src/sim/dance.ts), and says so.

import { mul3, quatToMat3, rotZ, type Mat3, type Quat } from './math.ts';

export interface ClipData {
  schema: 'jumper-lab-clip/1';
  name: string;
  title: string;
  hz: number;
  frames: number;
  duration: number;
  joints: string[];
  scale: number;
  q: number[][];
  base: number[][]; // x, y, z, qw, qx, qy, qz relative to the first frame
  /** A KingKong recording (repo, commit, file), or our own generated choreography (generator). */
  source: { repo: string; commit: string; trajectory: { path: string; sha256: string }; note: string } | { generator: string; bpm: number; note: string };
}

export interface ClipState {
  name: string;
  t: number;
  speed: number;
  x0: number;
  y0: number;
  yaw0: number;
  /** When cancelled: blend from the frozen pose back to standing over `dur` seconds. */
  out: { t: number; dur: number; q: number[]; z: number; roll: number; pitch: number } | null;
}

export function sampleClip(c: ClipData, t: number): { q: number[]; x: number; y: number; z: number; quat: Quat } {
  const f = Math.max(0, Math.min(c.frames - 1, t * c.hz));
  const i = Math.min(c.frames - 2, Math.floor(f));
  const u = f - i;
  const s = c.scale;
  const qa = c.q[i], qb = c.q[i + 1];
  const q = qa.map((v, j) => (v + (qb[j] - v) * u) * s);
  const ba = c.base[i], bb = c.base[i + 1];
  const b = ba.map((v, k) => (v + (bb[k] - v) * u) * s);
  const n = Math.hypot(b[3], b[4], b[5], b[6]) || 1;
  return { q, x: b[0], y: b[1], z: b[2], quat: [b[3] / n, b[4] / n, b[5] / n, b[6] / n] };
}

/** Roll, pitch, yaw of R = Rz(yaw) Ry(pitch) Rx(roll). */
export function mat3ToRpy(m: Mat3): { roll: number; pitch: number; yaw: number } {
  const pitch = Math.asin(Math.max(-1, Math.min(1, -m[6])));
  return { roll: Math.atan2(m[7], m[8]), pitch, yaw: Math.atan2(m[3], m[0]) };
}

/** World pose of the body for a clip sample, starting from (x0, y0, yaw0). */
export function clipPose(st: ClipState, smp: ReturnType<typeof sampleClip>): { x: number; y: number; z: number; roll: number; pitch: number; yaw: number } {
  const c = Math.cos(st.yaw0), s = Math.sin(st.yaw0);
  const R = mul3(rotZ(st.yaw0), quatToMat3(smp.quat));
  const rpy = mat3ToRpy(R);
  return { x: st.x0 + c * smp.x - s * smp.y, y: st.y0 + s * smp.x + c * smp.y, z: smp.z, ...rpy };
}
