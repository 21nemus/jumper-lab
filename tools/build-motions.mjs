// Converts KingKong's recorded gesture clips into compact playback files (run after build-robot).
//
//   node --experimental-strip-types tools/build-motions.mjs
//
// Each upstream clip carries the joint angles (22, wire order, 50 Hz) and the body's orientation per frame,
// but no body position. The position is solved here, frame by frame, from the feet: the lowest foot sits on
// the floor, and feet that stay on the floor between two frames keep their place (so nothing slides when the
// clip plays). Output: public/assets/motions/<name>.json with joint angles and the solved body pose, both
// quantised to 1e-4, plus the upstream file and hash it came from.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { cached, readLock } from './upstream.mjs';
import { RobotModel } from '../src/robot/model.ts';
import { footChain } from '../src/sim/limb.ts';
import { apply3, mat3ToQuat, quatToMat3, transpose3, mul3 } from '../src/sim/math.ts';
import { LEGS } from '../src/robot/model.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'public/assets/motions');
const robot = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/assets/robot/robot.json'), 'utf8'));
const model = new RobotModel(robot);
const lock = readLock().sources.find((s) => s.id === 'jumper');
const BUNDLE = 'out/bundle_example/jumper/';

const CLIPS = [
  { name: 'hello', title: 'Hello (wave)' },
  { name: 'bow', title: 'Bow' },
  { name: 'salute', title: 'Salute' },
  { name: 'paw', title: 'Offer a paw' },
];

const chains = Object.fromEntries(LEGS.map((l) => [l, footChain(model, l).chain]));
// height of each foot's contact site above the floor when it stands (from HOME at STAND_Z)
const siteH = Object.fromEntries(LEGS.map((l) => [l, chains[l].fk(model.home).p[2] + robot.standZ]));

fs.mkdirSync(OUT, { recursive: true });
for (const clip of CLIPS) {
  const contractPath = `${BUNDLE}gesture_${clip.name}.json`;
  const contract = JSON.parse(fs.readFileSync(cached('jumper', contractPath), 'utf8'));
  const ref = contract.reference;
  const trajPath = BUNDLE + ref.file;
  const traj = JSON.parse(fs.readFileSync(cached('jumper', trajPath), 'utf8'));
  if (JSON.stringify(traj.joint_order) !== JSON.stringify(robot.joints)) throw new Error(`${clip.name}: joint order differs from robot.json`);
  const n = traj.q.length;
  if (n !== ref.n_frames) throw new Error(`${clip.name}: ${n} frames, contract says ${ref.n_frames}`);

  const R0 = quatToMat3(traj.root_quat[0]);
  const R0T = transpose3(R0);
  let xy = [0, 0];
  let prevFeet = null;
  const base = [];
  let worstSlide = 0;
  for (let f = 0; f < n; f++) {
    const q = traj.q[f];
    const R = mul3(R0T, quatToMat3(traj.root_quat[f])); // orientation relative to the first frame
    const feet = Object.fromEntries(LEGS.map((l) => [l, apply3(R, chains[l].fk(q).p)]));
    // the lowest foot touches the floor
    const z = Math.max(...LEGS.map((l) => siteH[l] - feet[l][2]));
    const planted = LEGS.filter((l) => feet[l][2] + z - siteH[l] < 0.002);
    if (prevFeet) {
      const both = planted.filter((l) => prevFeet.planted.includes(l));
      if (both.length) {
        let sx = 0, sy = 0;
        for (const l of both) {
          sx += prevFeet.world[l][0] - feet[l][0];
          sy += prevFeet.world[l][1] - feet[l][1];
        }
        const nx = sx / both.length, ny = sy / both.length;
        for (const l of both) worstSlide = Math.max(worstSlide, Math.hypot(prevFeet.world[l][0] - (nx + feet[l][0]), prevFeet.world[l][1] - (ny + feet[l][1])));
        xy = [nx, ny];
      }
    }
    const world = Object.fromEntries(LEGS.map((l) => [l, [xy[0] + feet[l][0], xy[1] + feet[l][1]]]));
    prevFeet = { planted, world };
    base.push([xy[0], xy[1], z, ...mat3ToQuat(R)]);
  }

  const home = model.home;
  const dev = (row) => Math.max(...row.map((v, j) => Math.abs(v - home[j])));
  const quant = (v) => Math.round(v * 10000);
  const out = {
    schema: 'jumper-lab-clip/1',
    name: clip.name,
    title: clip.title,
    hz: ref.rec_hz,
    frames: n,
    duration: n / ref.rec_hz,
    joints: robot.joints,
    scale: 1e-4,
    q: traj.q.map((row) => row.map(quant)),
    base: base.map((row) => row.map(quant)),
    source: {
      repo: lock.repo,
      commit: lock.commit,
      trajectory: { path: trajPath, sha256: lock.files.find((x) => x.path === trajPath).sha256 },
      contract: { path: contractPath, sha256: lock.files.find((x) => x.path === contractPath).sha256 },
      note: 'Recorded gesture from KingKong Robotics (cut from their own choreography recordings, per tools/import_wbc_gestures.py upstream). Joint angles unchanged; body position solved from the feet by jumper-lab.',
    },
  };
  const file = path.join(OUT, `${clip.name}.json`);
  fs.writeFileSync(file, JSON.stringify(out));
  const bytes = fs.statSync(file).size;
  console.log(`${clip.name.padEnd(7)} ${n} frames @ ${ref.rec_hz} Hz (${(n / ref.rec_hz).toFixed(2)} s)  start/end vs HOME ${(dev(traj.q[0]) * 57.3).toFixed(1)}/${(dev(traj.q[n - 1]) * 57.3).toFixed(1)} deg  body drift ${(Math.hypot(xy[0], xy[1]) * 1000).toFixed(1)} mm  worst planted slide ${(worstSlide * 1000).toFixed(2)} mm  ${(bytes / 1024).toFixed(0)} KB (gz ${(gz(file) / 1024).toFixed(0)} KB)`);
}

function gz(file) {
  return zlib.gzipSync(fs.readFileSync(file), { level: 9 }).length;
}
