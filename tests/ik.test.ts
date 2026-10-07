import { test } from 'node:test';
import assert from 'node:assert/strict';
import { footChain, solveFoot } from '../src/sim/limb.ts';
import { LEGS } from '../src/robot/model.ts';
import { add, rng, type Vec3 } from '../src/sim/math.ts';
import { loadModel } from './helpers/assets.ts';

const model = loadModel();

test('limb FK in the base frame agrees with the full-tree FK at HOME', async () => {
  const { forward, footSite } = await import('../src/robot/kinematics.ts');
  const f = forward(model, { pos: [0, 0, 0], quat: [1, 0, 0, 0] }, model.home);
  for (const leg of LEGS) {
    const { chain } = footChain(model, leg);
    const a = chain.fk(model.home).p;
    const b = footSite(model, f, leg);
    assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-12, leg);
  }
});

test('every foothold in the stride envelope (+-35 mm fore-aft, +-25 mm sideways) is reached within 1 mm', () => {
  const r = rng(7);
  for (const leg of LEGS) {
    const fc = footChain(model, leg);
    const { chain, gaitJoints } = fc;
    const home = chain.fk(model.home).p;
    let worst = 0;
    for (let n = 0; n < 300; n++) {
      const target: Vec3 = add(home, [(r() - 0.5) * 0.07, (r() - 0.5) * 0.05, 0]);
      const q = Float64Array.from(model.home);
      worst = Math.max(worst, solveFoot(fc, q, model.home, target, 30));
      for (const j of gaitJoints) {
        const [lo, hi] = model.limits[j];
        assert.ok(q[j] >= lo && q[j] <= hi);
      }
      // walking never moves the finger
      model.limbJoints(leg).filter((j) => !gaitJoints.includes(j)).forEach((j) => assert.equal(q[j], model.home[j]));
    }
    assert.ok(worst < 1e-3, `${leg}: worst ${(worst * 1000).toFixed(2)} mm`);
  }
});

test('from anywhere in that envelope a foot can still lift clear of the floor (>= 5 mm)', () => {
  const r = rng(9);
  for (const leg of LEGS) {
    const fc = footChain(model, leg);
    const home = fc.chain.fk(model.home).p;
    let minLift = Infinity;
    for (let n = 0; n < 60; n++) {
      const d: Vec3 = [(r() - 0.5) * 0.07, (r() - 0.5) * 0.05, 0];
      let lo = 0, hi = 0.03;
      for (let k = 0; k < 10; k++) {
        const mid = (lo + hi) / 2;
        const q = Float64Array.from(model.home);
        if (solveFoot(fc, q, model.home, add(home, [d[0], d[1], mid]), 30) < 3e-4) lo = mid;
        else hi = mid;
      }
      minLift = Math.min(minLift, lo);
    }
    console.log(`  ${leg}: worst-case lift ${(minLift * 1000).toFixed(1)} mm`);
    assert.ok(minLift >= 0.005, `${leg}: worst-case lift ${(minLift * 1000).toFixed(1)} mm`);
  }
});
