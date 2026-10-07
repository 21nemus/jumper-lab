// Gate 1: the shipped robot assets reproduce the upstream model and its calibrated standing pose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { forward, footSite, pointInWorld, standingBase, centreOfMass } from '../src/robot/kinematics.ts';
import { LEGS } from '../src/robot/model.ts';
import { loadLinkMeshes, loadModel, readSTL, ROOT } from './helpers/assets.ts';

const model = loadModel();
const json = model.json;

test('the tree is jumper.xml: 41 bodies, a free base and 22 hinges in wire order', () => {
  assert.equal(json.bodies.length, 41);
  assert.equal(json.freeJoint.body, 'base_link');
  assert.equal(json.joints.length, 22);
  const expected = ['LF', 'RF'].flatMap((l) => [0, 1, 2, 3, 4].map((k) => `${l}_J${k}_joint`))
    .concat(['LM', 'RM', 'LR', 'RR'].flatMap((l) => [0, 1, 2].map((k) => `${l}_J${k}_joint`)));
  assert.deepEqual(json.joints, expected);
  // 22 hinged links + 18 fixed links + the base
  assert.equal(json.bodies.filter((b) => b.joint).length, 22);
  assert.equal(json.bodies.filter((b) => !b.joint && b.parent >= 0).length, 18);
  for (const b of json.bodies) {
    if (!b.joint) continue;
    const a = b.joint.axis;
    assert.equal(Math.hypot(...a), 1, `${b.joint.name} axis is not a unit vector`);
    assert.equal(a.filter((v) => v !== 0).length, 1, `${b.joint.name} axis is not x, y or z`);
    // J0 yaws about z on every limb; the arm's J1 rolls about y; everything else pitches about x
    const k = +b.joint.name.match(/_J(\d)_/)![1];
    const arm = b.joint.name.startsWith('LF') || b.joint.name.startsWith('RF');
    const want = k === 0 ? [0, 0, 1] : arm && k === 1 ? [0, 1, 0] : [1, 0, 0];
    assert.deepEqual(a, want, b.joint.name);
  }
});

test('the three URDF limit errors upstream repaired are repaired here too', () => {
  const lim = (n: string) => model.limits[model.joint(n)];
  assert.deepEqual(lim('LM_J0_joint'), [-0.75, 1]);
  assert.deepEqual(lim('RF_J4_joint'), [-0.1, 1.6]);
  assert.deepEqual(lim('RF_J2_joint'), [-1.65, 2.2]);
});

test('HOME is inside every limit, with at least 12% margin on the 20 gait joints', () => {
  json.joints.forEach((n, j) => {
    const [lo, hi] = model.limits[j];
    const q = json.home[j];
    assert.ok(q >= lo && q <= hi, `${n} outside its limits`);
    if (!n.endsWith('J4_joint')) assert.ok(Math.min(q - lo, hi - q) / (hi - lo) >= 0.12, `${n} margin`);
  });
});

test('model mass is 2.5430 kg (a model value, not the 1.8 kg product weight)', () => {
  assert.ok(Math.abs(json.massTotal - 2.543) < 1e-4);
  const f = forward(model, standingBase(model), model.home);
  assert.ok(Math.abs(centreOfMass(model, f).mass - 2.543) < 1e-4);
});

test('at HOME the six foot sites land on upstream NOMINAL_FOOT_XY (within 0.01 mm)', () => {
  const f = forward(model, standingBase(model), model.home);
  for (const leg of LEGS) {
    const p = footSite(model, f, leg);
    const [x, y] = json.nominalFootXY[leg];
    assert.ok(Math.hypot(p[0] - x, p[1] - y) < 1e-5, `${leg} off by ${(Math.hypot(p[0] - x, p[1] - y) * 1000).toFixed(4)} mm`);
    // the site is the pad centre, ~8.8 mm above the floor (FOOT_SITE_Z)
    assert.ok(Math.abs(p[2] - json.footSiteZ) < 0.0005, `${leg} site height ${p[2]}`);
  }
});

function lowestZ(position: Float32Array, R: number[], p: number[]): number {
  let min = Infinity;
  for (let i = 0; i < position.length; i += 3) {
    const z = R[6] * position[i] + R[7] * position[i + 1] + R[8] * position[i + 2] + p[2];
    if (z < min) min = z;
  }
  return min;
}

test('shipped meshes: at HOME + STAND_Z every foot touches the floor (within 0.3 mm)', async () => {
  const meshes = await loadLinkMeshes();
  assert.equal(meshes.size, 41);
  const f = forward(model, standingBase(model), model.home);
  const lows = LEGS.map((leg) => {
    const { body } = model.foot(leg);
    return lowestZ(meshes.get(json.bodies[body].name)!.position, f.R[body], f.p[body]);
  });
  for (const z of lows) assert.ok(Math.abs(z) < 3e-4, `foot ${(z * 1000).toFixed(3)} mm from the floor`);
  assert.ok(Math.max(...lows) - Math.min(...lows) < 3e-4);
  // and nothing else is below the floor
  json.bodies.forEach((b, i) => {
    const z = lowestZ(meshes.get(b.name)!.position, f.R[i], f.p[i]);
    assert.ok(z > -3e-4, `${b.name} is ${(z * 1000).toFixed(2)} mm below the floor`);
  });
});

const CACHE = path.join(ROOT, 'tools/.cache/upstream/jumper/assets/jumper');
test('source STLs: at HOME + STAND_Z the feet are coplanar to 0.01 mm (needs npm run upstream:fetch)', { skip: !fs.existsSync(CACHE) }, () => {
  const f = forward(model, standingBase(model), model.home);
  const lows = LEGS.map((leg) => {
    const { body } = model.foot(leg);
    const mesh = json.meshes.find((m) => m.body === json.bodies[body].name)!;
    return lowestZ(readSTL(path.join(CACHE, mesh.file)), f.R[body], f.p[body]);
  });
  for (const z of lows) assert.ok(Math.abs(z) < 1e-5, `foot ${(z * 1e6).toFixed(2)} um from the floor`);
  assert.ok(Math.max(...lows) - Math.min(...lows) < 1e-5);
});

test('the standing envelope is close to the published 400 x 400 x 200 mm', async () => {
  const meshes = await loadLinkMeshes();
  const f = forward(model, standingBase(model), model.home);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  json.bodies.forEach((b, i) => {
    const pos = meshes.get(b.name)!.position;
    for (let k = 0; k < pos.length; k += 3) {
      const w = pointInWorld(f, i, [pos[k], pos[k + 1], pos[k + 2]]);
      for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], w[a]); max[a] = Math.max(max[a], w[a]); }
    }
  });
  const size = [0, 1, 2].map((a) => (max[a] - min[a]) * 1000);
  assert.ok(Math.abs(size[0] - 368.5) < 1.5 && Math.abs(size[1] - 415.3) < 1.5 && Math.abs(size[2] - 178.4) < 1.5, `envelope ${size.map((s) => s.toFixed(1))}`);
});

test('claw tables: aperture shrinks monotonically from GRIPPER_OPEN to GRIPPER_CLOSED; mirror holds', () => {
  const t = json.claw.apertureMm;
  assert.equal(t[0][0], json.claw.gripperOpen);
  assert.equal(t.at(-1)![0], json.claw.gripperClosed);
  for (let i = 1; i < t.length; i++) assert.ok(t[i][0] > t[i - 1][0] && t[i][1] < t[i - 1][1]);
  for (let k = 0; k < 5; k++) {
    const l = model.limits[model.joint(`LF_J${k}_joint`)];
    const r = model.limits[model.joint(`RF_J${k}_joint`)];
    const m = json.claw.mirror[k];
    assert.deepEqual(m > 0 ? l : [-l[1], -l[0]], r);
  }
  // the stow is inside the left arm's limits
  json.claw.stow.forEach((q, k) => {
    const [lo, hi] = model.limits[model.joint(`LF_J${k}_joint`)];
    assert.ok(q >= lo && q <= hi);
  });
});
