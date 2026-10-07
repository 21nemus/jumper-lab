import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RobotController, NO_COMMAND, type Command } from '../src/sim/robot.ts';
import { CORNER } from '../src/sim/course.ts';
import { forward, footSite } from '../src/robot/kinematics.ts';
import { LEGS } from '../src/robot/model.ts';
import { quatToMat3, rng, mat3ToQuat, rpyToMat3 } from '../src/sim/math.ts';
import { loadModel } from './helpers/assets.ts';

const model = loadModel();
const ctl = new RobotController(model);
const DT = 1 / 120;

function footWorld(s: ReturnType<RobotController['initial']>, leg: (typeof LEGS)[number]) {
  const base = { pos: [s.x, s.y, s.z] as [number, number, number], quat: mat3ToQuat(rpyToMat3(s.roll, s.pitch, s.yaw)) };
  return footSite(model, forward(model, base, s.q), leg);
}

test('standing at HOME: feet at the nominal footholds, joints at HOME', () => {
  const s = ctl.initial(0, 0, 0);
  ctl.solveFeet(s);
  s.q.forEach((v, j) => assert.ok(Math.abs(v - model.home[j]) < 1e-6, model.json.joints[j]));
  void quatToMat3;
});

test('a 40 s random walk: limbs always reach their feet, stay in limits, planted feet never slide', () => {
  const s = ctl.initial(CORNER.start.x, CORNER.start.y, CORNER.start.yaw);
  const r = rng(11);
  let cmd: Command = NO_COMMAND;
  let worstIk = 0, worstSlide = 0, steps = 0, touchdowns = 0;
  const plantedAt = new Map<string, [number, number, number]>();
  for (let i = 0; i < 40 * 120; i++) {
    if (i % 60 === 0) cmd = { fwd: r() * 2 - 1, left: r() * 2 - 1, turn: r() * 2 - 1 };
    const ev = ctl.step(s, DT, cmd, CORNER);
    worstIk = Math.max(worstIk, ev.ikError);
    touchdowns += ev.touchdowns.length;
    for (let j = 0; j < 22; j++) {
      const [lo, hi] = model.limits[j];
      assert.ok(s.q[j] >= lo - 1e-9 && s.q[j] <= hi + 1e-9, `${model.json.joints[j]} left its limits`);
    }
    // a planted foot's actual (FK) position must not move while it stays planted
    for (const leg of LEGS) {
      if (!s.feet[leg].planted) { plantedAt.delete(leg); continue; }
      const w = footWorld(s, leg);
      const p0 = plantedAt.get(leg);
      if (!p0) plantedAt.set(leg, w);
      else worstSlide = Math.max(worstSlide, Math.hypot(w[0] - p0[0], w[1] - p0[1], w[2] - p0[2]));
    }
    steps++;
  }
  console.log(`  ${steps} steps, ${touchdowns} touchdowns, worst IK ${(worstIk * 1000).toFixed(3)} mm, worst planted-foot slide ${(worstSlide * 1000).toFixed(3)} mm`);
  assert.ok(touchdowns > 200);
  assert.ok(worstIk < 1e-3, `IK error ${(worstIk * 1000).toFixed(2)} mm`);
  assert.ok(worstSlide < 1e-3, `planted foot slid ${(worstSlide * 1000).toFixed(2)} mm`);
});

test('letting go of the controls: the robot comes to rest on its six nominal footholds', () => {
  const s = ctl.initial(0, 0, 0);
  for (let i = 0; i < 240; i++) ctl.step(s, DT, { fwd: 1, left: 0.3, turn: 0.5 }, CORNER);
  for (let i = 0; i < 360; i++) ctl.step(s, DT, NO_COMMAND, CORNER);
  assert.equal(s.active, false);
  for (const leg of LEGS) {
    assert.ok(s.feet[leg].planted);
    const h = ctl.foothold(s, leg, 0);
    assert.ok(Math.hypot(s.feet[leg].p[0] - h[0], s.feet[leg].p[1] - h[1]) < 0.0065, `${leg} not home`);
  }
});

test('walking forward covers ground at about the commanded speed, and walls stop it', () => {
  const s = ctl.initial(0, 0, 0);
  for (let i = 0; i < 4 * 120; i++) ctl.step(s, DT, { fwd: 1, left: 0, turn: 0 }, CORNER);
  assert.ok(s.x > 0.6 && s.x < 0.85, `x ${s.x}`);
  const w = ctl.initial(1.8, 0, 0);
  for (let i = 0; i < 6 * 120; i++) ctl.step(w, DT, { fwd: 1, left: 0, turn: 0 }, CORNER);
  assert.ok(w.x < 2.2 - 0.17, `went through the wall: ${w.x}`);
});
