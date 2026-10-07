// Recorded gestures: played as recorded, starting and ending in the calibrated stance.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { World, DT } from '../src/sim/world.ts';
import { NO_COMMAND } from '../src/sim/robot.ts';
import type { ClipData } from '../src/sim/clip.ts';
import { loadModel, ROOT } from './helpers/assets.ts';

const model = loadModel();
const clips = ['hello', 'bow', 'salute', 'paw'].map((n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public/assets/motions', `${n}.json`), 'utf8')) as ClipData);
const idle = { cmd: NO_COMMAND, action: false };

function world(): World {
  const w = new World(model);
  for (const c of clips) w.clips.set(c.name, c);
  return w;
}

test('each clip starts and ends at HOME, and its joints stay inside the limits', () => {
  for (const c of clips) {
    const first = c.q[0], last = c.q[c.frames - 1];
    first.forEach((v, j) => assert.ok(Math.abs(v * c.scale - model.home[j]) < 2e-4, `${c.name} start ${c.joints[j]}`));
    last.forEach((v, j) => assert.ok(Math.abs(v * c.scale - model.home[j]) < 2e-4, `${c.name} end ${c.joints[j]}`));
    for (const row of c.q) row.forEach((v, j) => {
      const [lo, hi] = model.limits[j];
      assert.ok(v * c.scale >= lo - 1e-3 && v * c.scale <= hi + 1e-3, `${c.name} ${c.joints[j]} out of limits`);
    });
  }
});

test('playing the wave: the robot ends back on six planted feet and walks on afterwards', () => {
  const w = world();
  assert.ok(w.play('hello'));
  let ended = false;
  for (let i = 0; i < 10 / DT && !ended; i++) ended = w.step(idle).some((e) => e.kind === 'clip-end');
  assert.ok(ended);
  const r = w.state.robot;
  assert.equal(w.state.clip, null);
  r.q.forEach((v, j) => assert.ok(Math.abs(v - model.home[j]) < 0.02, model.json.joints[j]));
  for (const f of Object.values(r.feet)) assert.ok(f.planted);
  let worst = 0;
  for (let i = 0; i < 2 / DT; i++) worst = Math.max(worst, w.ctl.step(r, DT, { fwd: 1, left: 0, turn: 0 }, w.course).ikError);
  assert.ok(worst < 1.5e-3, `walking after the clip: IK ${(worst * 1000).toFixed(2)} mm`);
});

test('moving cancels a gesture with a short blend back to standing', () => {
  const w = world();
  w.play('salute');
  for (let i = 0; i < 1.5 / DT; i++) w.step(idle);
  assert.ok(w.state.clip && !w.state.clip.out);
  let t = 0;
  while (w.state.clip && t < 2) { w.step({ cmd: { fwd: 1, left: 0, turn: 0 }, action: false }); t += DT; }
  assert.equal(w.state.clip, null);
  assert.ok(t < 0.5, `cancel took ${t.toFixed(2)} s`);
});

test('no gesture while carrying or mid-grab', () => {
  const w = world();
  w.state.claw.phase = 'carrying';
  assert.equal(w.play('hello'), false);
});
