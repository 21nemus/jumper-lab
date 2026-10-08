// Planning the crab rave's crowd (GAME APPROXIMATION, render-only: the crowd never enters the simulation).
// From where the hero stands: a camera spot in front of it that is clear of walls and furniture, rows of
// dance spots beside and behind it facing that camera, and for each dancer a sideways scuttle in from
// off-screen (the meme's crab walk), timed so a row arrives like a conga line, nobody walking through anybody,
// all before the drop; then the same way out after the dance.

import { RAVE_BEATS, RAVE_BPM, type ScuttleCycle } from './dance.ts';
import { sampleClip, type ClipData } from './clip.ts';
import { shapeDistance, type Course } from './course.ts';
import { mat3ToQuat, mul3, quatToMat3, rotZ, type Quat, type Vec3 } from './math.ts';

export const MAX_DANCERS = 20;
const SPACING = 0.5; // between neighbours in a row, and between rows (m)
const CLEAR = 0.21; // a dancer's spot keeps this far from any obstacle footprint (m)
const SCURRY = 4; // they scuttle at four times the real gait's pace: a scurry, feet still planted
const BEAT = 60 / RAVE_BPM;
const ARRIVE = 6.5; // beat they all reach their spots (the drop is at beat 8)

export interface DancerPlan {
  slot: [number, number];
  yaw: number;
  /** +1: walks in towards its own left (it comes from its right); -1 the other way. */
  side: 1 | -1;
  /** Distance it walks in (and out again). */
  path: number;
  enter: number; // beats (rave clock): starts walking in
  arrive: number;
  leave: number; // starts walking off
  jitter: number; // beats of dance timing offset, so the crowd isn't perfectly robotic
  shell: [number, number, number];
}

export interface RavePlan {
  eye: Vec3; // the camera spot
  at: Vec3; // where it looks
  dir: [number, number]; // from the hero towards the camera
  dancers: DancerPlan[];
}

const SHELLS: [number, number, number][] = [
  [0.85, 0.08, 0.05], // Jumper red, most of them
  [0.85, 0.08, 0.05],
  [0.85, 0.08, 0.05],
  [0.85, 0.08, 0.05],
  [0.93, 0.89, 0.8], // oat
  [0.45, 0.78, 0.66], // mint
];

function clearOf(course: Course, p: [number, number], r: number, minHeight = 0): boolean {
  const b = course.bounds;
  if (p[0] < b.min[0] - 2 || p[0] > b.max[0] - 0.12 || p[1] < b.min[1] - 2 || p[1] > b.max[1] - 0.12) return false;
  return course.obstacles.every((o) => o.height < minHeight || shapeDistance(o.shape, p).d > r);
}
function insideBounds(course: Course, p: [number, number], margin: number): boolean {
  const b = course.bounds;
  return p[0] > b.min[0] + margin && p[0] < b.max[0] - margin && p[1] > b.min[1] + margin && p[1] < b.max[1] - margin;
}

/** On the floor, inside the walls: the open sides of the room run on past the course bounds (oak floor). */
function onFloor(course: Course, p: [number, number]): boolean {
  const b = course.bounds;
  return p[0] > b.min[0] - 2 && p[0] < b.max[0] - 0.25 && p[1] > b.min[1] - 2 && p[1] < b.max[1] - 0.25;
}

/** Plan the crowd around a hero standing at (x, y) facing `yaw`. Deterministic for a given `seed`. */
export function planRave(course: Course, hero: { x: number; y: number; yaw: number }, seed = 1): RavePlan {
  // Try camera spots around the hero (in front first) and keep the one that leaves room for the biggest crowd
  // behind the hero; swinging the camera away from the hero's front costs a little.
  let best: { score: number; plan: RavePlan } | null = null;
  for (const deg of [0, 25, -25, 50, -50, 75, -75, 105, -105, 135, -135, 180]) {
    const a = hero.yaw + (deg * Math.PI) / 180;
    const p: [number, number] = [hero.x + Math.cos(a) * 1.2, hero.y + Math.sin(a) * 1.2];
    if (!insideBounds(course, p, 0.08) || !clearOf(course, p, 0.15, 0.25)) continue;
    let blocked = false; // the view to the hero must not go through a wall
    for (let k = 1; k < 10 && !blocked; k++) {
      const s: [number, number] = [hero.x + (p[0] - hero.x) * (k / 10), hero.y + (p[1] - hero.y) * (k / 10)];
      blocked = course.obstacles.some((o) => o.height > 1 && shapeDistance(o.shape, s).d < 0.05);
    }
    if (blocked) continue;
    const plan = layout(course, hero, [p[0], p[1], 0.42], seed);
    const score = plan.dancers.length - Math.abs(deg) / 25 - (Math.abs(deg) > 90 ? 8 : 0); // never its back, if it can help it
    if (!best || score > best.score) best = { score, plan };
  }
  return best?.plan ?? layout(course, hero, [hero.x + Math.cos(hero.yaw) * 1.2, hero.y + Math.sin(hero.yaw) * 1.2, 0.6], seed);
}

function layout(course: Course, hero: { x: number; y: number; yaw: number }, eye: Vec3, seed: number): RavePlan {
  const dl = Math.hypot(eye[0] - hero.x, eye[1] - hero.y) || 1;
  const dir: [number, number] = [(eye[0] - hero.x) / dl, (eye[1] - hero.y) / dl];
  const left: [number, number] = [-dir[1], dir[0]];
  const yaw = Math.atan2(dir[1], dir[0]);
  const at: Vec3 = [hero.x - dir[0] * 0.3, hero.y - dir[1] * 0.3, 0.12];

  // spots: rows beside and behind the hero (away from the camera), staggered by half a spacing
  let s = seed >>> 0 || 1;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const at2 = (depth: number, lat: number): [number, number] => [hero.x - dir[0] * depth + left[0] * lat, hero.y - dir[1] * depth + left[1] * lat];
  const candidates: { slot: [number, number]; row: number; lat: number }[] = [];
  for (let row = 0; row < 4; row++) {
    const offset = row % 2 ? SPACING / 2 : 0;
    for (let k = -4; k <= 4; k++) {
      const lat = k * SPACING + offset;
      if (row === 0 && Math.abs(lat) < 0.4) continue; // the hero's own spot
      candidates.push({ slot: at2(row * SPACING, lat), row, lat });
    }
  }
  const edge = (row: number) => 1.5 + 0.4 * row; // off-screen, sideways from the hero (m along `left`)
  const pathClear = (from: [number, number], to: [number, number]) => {
    const n = Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1]) / 0.05);
    for (let k = 0; k <= n; k++) {
      const p: [number, number] = [from[0] + ((to[0] - from[0]) * k) / n, from[1] + ((to[1] - from[1]) * k) / n];
      if (!clearOf(course, p, 0.19, 0.03)) return false;
      if (Math.hypot(p[0] - hero.x, p[1] - hero.y) < 0.45) return false; // never through the hero
    }
    return true;
  };
  const picked: { slot: [number, number]; row: number; lat: number; side: 1 | -1; path: number }[] = [];
  candidates.sort((a, b) => a.row - b.row || Math.abs(a.lat) - Math.abs(b.lat));
  for (const c of candidates) {
    if (picked.length >= MAX_DANCERS) break;
    if (!onFloor(course, c.slot) || !clearOf(course, c.slot, CLEAR)) continue;
    if (Math.hypot(c.slot[0] - hero.x, c.slot[1] - hero.y) < 0.48) continue;
    // come in from the nearer side if that way is clear, else from the other
    const sides: (1 | -1)[] = c.lat >= 0 ? [-1, 1] : [1, -1];
    for (const side of sides) {
      // side +1 walks along +left, so it starts on the -left side of its spot
      const startLat = -side * Math.max(edge(c.row), Math.abs(c.lat) + 0.45);
      if (side === 1 ? startLat > c.lat : startLat < c.lat) continue;
      const start = at2(c.row * SPACING, startLat);
      if (!pathClear(start, c.slot)) continue;
      picked.push({ ...c, side, path: Math.abs(c.lat - startLat) });
      break;
    }
  }

  // timing: everyone arrives together, so a row walks in at one pace with its spacing intact
  const speed = 0.15 * SCURRY * BEAT; // metres per beat
  const dancers: DancerPlan[] = picked.map((p) => ({
    slot: p.slot,
    yaw,
    side: p.side,
    path: p.path,
    enter: ARRIVE - p.path / speed,
    arrive: ARRIVE,
    leave: RAVE_BEATS.setup + RAVE_BEATS.dance + rand() * 0.6,
    jitter: (rand() - 0.5) * 0.08,
    shell: SHELLS[Math.floor(rand() * SHELLS.length)],
  }));
  return { eye, at, dir, dancers };
}

export interface DancerPose {
  pos: Vec3;
  quat: Quat;
  q: number[];
}

/**
 * Where a dancer is and how it stands at rave beat `beat`, or null while it is off stage. The dance is the
 * hero's own clip (so the crowd moves in step); walking is the recorded scuttle cycle, mirrored in time for
 * the other direction, at the pace that keeps its feet planted.
 */
export function dancerPose(d: DancerPlan, beat: number, rave: ClipData, cycle: ScuttleCycle): DancerPose | null {
  const speed = (cycle.distance / cycle.period) * SCURRY; // m/s
  const c = Math.cos(d.yaw), sn = Math.sin(d.yaw);
  const left: [number, number] = [-sn, c];
  const walkOut = d.leave + 1;
  const tIn = (beat - d.enter) * BEAT, tOut = (beat - walkOut) * BEAT;
  const outDist = tOut * speed;
  if (beat < d.enter || outDist > d.path + 0.2) return null;

  const scuttle = (dist: number, dirSign: number): number[] => {
    // the cycle walks to the left; played backwards it walks to the right
    let ph = (dist / cycle.distance) * dirSign;
    ph -= Math.floor(ph);
    const f = ph * cycle.frames;
    const i = Math.floor(f) % cycle.frames, j = (i + 1) % cycle.frames, u = f - Math.floor(f);
    return cycle.q[i].map((v, k) => v + (cycle.q[j][k] - v) * u);
  };
  const dance = (b: number) => sampleClip(rave, Math.max(0, (b + d.jitter) * BEAT));
  const yawQuat = (q: Quat): Quat => mat3ToQuat(mul3(rotZ(d.yaw), quatToMat3(q)));
  const place = (lat: number, z: number): Vec3 => [d.slot[0] + left[0] * lat, d.slot[1] + left[1] * lat, z];
  const level = mat3ToQuat(rotZ(d.yaw));

  if (beat < d.arrive) {
    // walking in: from `path` away on the -side, to the spot
    const done = Math.min(d.path, tIn * speed);
    return { pos: place(-d.side * (d.path - done), cycle.z[0]), quat: level, q: scuttle(done, d.side) };
  }
  const blendIn = Math.min(1, (beat - d.arrive) / 1);
  const smp = dance(beat);
  const dancePos = (k: number): Vec3 => {
    // the clip's own body offsets (sway, bounce), turned to the dancer's heading
    const ox = smp.x * c - smp.y * sn, oy = smp.x * sn + smp.y * c;
    return [d.slot[0] + ox * k, d.slot[1] + oy * k, cycle.z[0] + (smp.z - cycle.z[0]) * k];
  };
  if (beat < d.leave) {
    if (blendIn < 1) {
      const from = scuttle(d.path, d.side);
      return { pos: dancePos(blendIn), quat: yawQuat(smp.quat), q: from.map((v, k) => v + (smp.q[k] - v) * blendIn) };
    }
    return { pos: dancePos(1), quat: yawQuat(smp.quat), q: smp.q };
  }
  // leaving: settle into the walk, then scuttle back the way it came
  const back = -d.side as 1 | -1;
  if (beat < walkOut) {
    const u = beat - d.leave;
    const to = scuttle(0, back);
    return { pos: dancePos(1 - u), quat: level, q: smp.q.map((v, k) => v + (to[k] - v) * u) };
  }
  return { pos: place(back * outDist, cycle.z[0]), quat: level, q: scuttle(outDist, back) };
}
