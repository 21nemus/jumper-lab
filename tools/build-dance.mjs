// Writes our crab-rave choreography (src/sim/dance.ts) as a playback clip, like the recorded gestures, and the
// crowd's scuttle cycle (one period of the real gait crab-walking left):
//
//   node --experimental-strip-types tools/build-dance.mjs
//
// It needs only the committed robot model (public/assets/robot/robot.json), not the upstream cache, and the
// result is deterministic: tests/dance.test.ts checks the shipped file matches what this writes.

import fs from 'node:fs';
import path from 'node:path';
import { RobotModel } from '../src/robot/model.ts';
import { buildRaveClip, buildScuttleCycle, quantiseClip } from '../src/sim/dance.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const robot = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/assets/robot/robot.json'), 'utf8'));
const model = new RobotModel(robot);
const clip = quantiseClip(buildRaveClip(model));
const file = path.join(ROOT, 'public/assets/motions/rave.json');
fs.writeFileSync(file, JSON.stringify(clip));
console.log(`rave.json: ${clip.frames} frames, ${clip.duration.toFixed(2)} s, ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
const cycle = buildScuttleCycle(model);
const round = (v) => Math.round(v * 1e5) / 1e5;
const out = { ...cycle, q: cycle.q.map((r) => r.map(round)), z: cycle.z.map(round) };
fs.writeFileSync(path.join(ROOT, 'public/assets/motions/scuttle.json'), JSON.stringify(out));
console.log(`scuttle.json: ${cycle.frames} frames, ${(cycle.distance * 1000).toFixed(1)} mm per ${cycle.period.toFixed(2)} s period`);
