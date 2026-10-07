// The claw's reach: the closed-form planar arm, the self-collision footprints checked against the meshes, and
// what the player gets from it (letting go where the snack is held, how big the grab and drop areas are, hints).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, DT, type SimEvent } from '../src/sim/world.ts';
import { Autopilot, CORNER_RUN } from '../src/sim/autopilot.ts';
import { NO_COMMAND } from '../src/sim/robot.ts';
import { ARM_SIDES, type Arm, type GripPlan } from '../src/sim/claw.ts';
import { apply3, rng, wrapAngle } from '../src/sim/math.ts';
import { forward, pointInWorld } from '../src/robot/kinematics.ts';
import { loadLinkMeshes, loadModel } from './helpers/assets.ts';

const model = loadModel();

/** A world carrying the snack in its left claw, standing still (the reference run up to the pick-up). */
function carrying(): World {
  const world = new World(model);
  const pilot = new Autopilot(CORNER_RUN);
  for (let i = 0; i < 120 / DT && world.state.claw.phase !== 'carrying'; i++) world.step(pilot.next(world, DT));
  for (let i = 0; i < 120; i++) world.step({ cmd: NO_COMMAND, action: false });
  assert.equal(world.state.claw.phase, 'carrying');
  return world;
}

/** Slide the standing robot (base and planted feet together) so `target` sits at robot-local (lx, ly). */
function place(world: World, target: [number, number], lx: number, ly: number): void {
  const r = world.state.robot;
  const c = Math.cos(r.yaw), s = Math.sin(r.yaw);
  const dx = target[0] - (c * lx - s * ly) - r.x, dy = target[1] - (s * lx + c * ly) - r.y;
  r.x += dx;
  r.y += dy;
  for (const f of Object.values(r.feet)) {
    for (const p of [f.p, f.from, f.target]) {
      p[0] += dx;
      p[1] += dy;
    }
  }
}

/** Area (cm^2) of robot-local target positions, on a 1 cm grid, where `ok` holds. */
function area(world: World, target: [number, number], ok: () => boolean): number {
  const base = world.snapshot();
  let n = 0;
  for (let ly = -0.3; ly <= 0.3 + 1e-9; ly += 0.01) {
    for (let lx = -0.05; lx <= 0.4 + 1e-9; lx += 0.01) {
      world.restore(base);
      place(world, target, lx, ly);
      if (ok()) n++;
    }
  }
  world.restore(base);
  return n;
}

test('planar reach: closed-form arm angles reproduce any arm pose in the web-up roll exactly (both claws)', () => {
  const { kit } = new World(model);
  const rand = rng(11);
  let worstP = 0, worstH = 0, sameQ = 0;
  for (const arm of ARM_SIDES) {
    const js = kit.joints[arm];
    for (let i = 0; i < 2000; i++) {
      // a random pose within the limits, then ask for its grip point and heading back
      const q = Float64Array.from(model.home);
      q[js[1]] = kit.webRoll(arm);
      q[js[4]] = kit.holdAngle(arm);
      for (const k of [0, 2, 3]) {
        const [lo, hi] = model.limits[js[k]];
        q[js[k]] = lo + 0.02 + rand() * (hi - lo - 0.04);
      }
      const f = kit.gripChain[arm].fk(q);
      const hv = apply3(f.R, kit.heading[arm]);
      const h = Math.atan2(hv[1], hv[0]);
      let found = false;
      for (const branch of [1, -1] as const) {
        const sol = kit.planarIK(arm, f.p[0], f.p[1], h, branch, q[js[4]]);
        if (!sol) continue;
        const q2 = Float64Array.from(q);
        js.forEach((j, k) => (q2[j] = sol.q[k]));
        const f2 = kit.gripChain[arm].fk(q2);
        const h2 = apply3(f2.R, kit.heading[arm]);
        worstP = Math.max(worstP, Math.hypot(f2.p[0] - f.p[0], f2.p[1] - f.p[1], f2.p[2] - f.p[2]));
        worstH = Math.max(worstH, Math.abs(wrapAngle(Math.atan2(h2[1], h2[0]) - h)));
        if ([0, 2, 3].every((k) => Math.abs(sol.q[k] - q[js[k]]) < 1e-9)) found = true;
      }
      assert.ok(found, `${arm}: the original pose is not among the closed-form solutions`);
      sameQ++;
    }
  }
  console.log(`  ${sameQ} poses recovered; worst grip point error ${worstP.toExponential(1)} m, heading ${worstH.toExponential(1)} rad`);
  assert.ok(worstP < 1e-9 && worstH < 1e-9);
});

test('dropping where you hold it: carried snack right over the dish, one press lets go and it lands in the dish', () => {
  const world = carrying();
  const { kit, course } = world;
  const r = world.state.robot;
  const g = kit.gripWorld(r, 'LF');
  const c = Math.cos(r.yaw), s = Math.sin(r.yaw);
  // the dish centre exactly under the carried snack
  const gl: [number, number] = [c * (g[0] - r.x) + s * (g[1] - r.y), -s * (g[0] - r.x) + c * (g[1] - r.y)];
  place(world, course.dish.c, gl[0], gl[1]);
  const plan = world.reach().drop;
  assert.ok(plan, 'no drop with the snack right over the dish');
  const now = kit.armQ(world.state.robot, 'LF');
  assert.ok(Math.max(...[0, 2, 3].map((k) => Math.abs(plan.q[k] - now[k]))) < 0.01, 'the claw should let go where it is');
  const seen: SimEvent['kind'][] = [];
  seen.push(...world.step({ cmd: NO_COMMAND, action: true }).map((e) => e.kind));
  for (let i = 0; i < 5 / DT; i++) seen.push(...world.step({ cmd: NO_COMMAND, action: false }).map((e) => e.kind));
  assert.ok(!seen.includes('hint'), `hinted instead of dropping: ${seen.join(' ')}`);
  assert.equal(world.state.mission.status, 'delivered');
  assert.equal(world.state.snack.where, 'dish');
  assert.equal(world.state.claw.phase, 'foot');
});

test('dropping near the dish: the claw reaches over it from anywhere within 4 cm of where the snack is held', () => {
  const world = carrying();
  const base = world.snapshot();
  const r0 = base.robot;
  const g = world.kit.gripWorld(r0, 'LF');
  const c = Math.cos(r0.yaw), s = Math.sin(r0.yaw);
  const gl = [c * (g[0] - r0.x) + s * (g[1] - r0.y), -s * (g[0] - r0.x) + c * (g[1] - r0.y)];
  for (let k = 0; k < 12; k++) {
    for (const off of [0.02, 0.04]) {
      world.restore(base);
      const a = (k * Math.PI) / 6;
      place(world, world.course.dish.c, gl[0] + Math.cos(a) * off, gl[1] + Math.sin(a) * off);
      assert.ok(world.reach().drop, `no drop with the dish ${off * 100} cm off the snack at ${k * 30} deg`);
    }
  }
});

test('reach areas: grabbing and dropping work from far more places than the old window (324 / 396 cm2)', () => {
  const grab = new World(model);
  for (let i = 0; i < 60; i++) grab.step({ cmd: NO_COMMAND, action: false });
  const g = area(grab, grab.course.stand.c, () => !!grab.reach().grab);
  const drop = carrying();
  const d = area(drop, drop.course.dish.c, () => !!drop.reach().drop);
  console.log(`  grab ${g} cm2, drop ${d} cm2 of robot-local target positions`);
  assert.ok(g >= 520, `grab area ${g} cm2`);
  assert.ok(d >= 660, `drop area ${d} cm2`);
});

test('every planned claw pose clears the robot itself (the meshes, in plan view at claw height)', async () => {
  const meshes = await loadLinkMeshes();
  const CELL = 0.003, Z0 = 0.06, Z1 = 0.115;
  const key = (x: number, y: number) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;
  /** Points over a link's triangles (about every CELL), in the base frame, that lie in the claw-height band. */
  function samples(f: ReturnType<typeof forward>, body: number, each: (x: number, y: number) => void): void {
    const m = meshes.get(model.json.bodies[body].name);
    if (!m) return;
    const v = (i: number) => pointInWorld(f, body, [m.position[3 * i], m.position[3 * i + 1], m.position[3 * i + 2]]);
    for (let t = 0; t < m.index.length; t += 3) {
      const a = v(m.index[t]), b = v(m.index[t + 1]), c = v(m.index[t + 2]);
      if (Math.max(a[2], b[2], c[2]) < Z0 || Math.min(a[2], b[2], c[2]) > Z1) continue;
      const n = Math.max(1, Math.ceil(Math.max(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), Math.hypot(c[0] - a[0], c[1] - a[1], c[2] - a[2])) / CELL));
      for (let i = 0; i <= n; i++) {
        for (let j = 0; i + j <= n; j++) {
          const u = i / n, w = j / n;
          const z = a[2] + (b[2] - a[2]) * u + (c[2] - a[2]) * w;
          if (z >= Z0 && z <= Z1) each(a[0] + (b[0] - a[0]) * u + (c[0] - a[0]) * w, a[1] + (b[1] - a[1]) * u + (c[1] - a[1]) * w);
        }
      }
    }
  }
  const stand = { pos: [0, 0, model.json.standZ] as [number, number, number], quat: [1, 0, 0, 0] as [number, number, number, number] };
  const home = forward(model, stand, model.home);
  const occupied: Record<Arm, Set<string>> = { LF: new Set(), RF: new Set() };
  for (const arm of ARM_SIDES) {
    model.json.bodies.forEach((b, i) => {
      if (!b.name.startsWith(`${arm}_`)) samples(home, i, (x, y) => occupied[arm].add(key(x, y)));
    });
  }
  const clawBodies = (arm: Arm) => ['palm', 'finger', 'palm_grip_insert', 'finger_grip_insert'].map((n) => model.body(`${arm}_${n}_link`));
  let checked = 0;
  function check(world: World, p: GripPlan, label: string): void {
    const { kit } = world;
    const poses: [number[], number, boolean][] = [
      [p.q, kit.mouthAngle(p.arm), false],
      [p.qPre, kit.mouthAngle(p.arm), false],
      [p.q, kit.holdAngle(p.arm), true], // closed on the snack
    ];
    for (const [armQ, finger, snack] of poses) {
      const q = Float64Array.from(model.home);
      kit.joints[p.arm].forEach((j, k) => (q[j] = k === 4 ? finger : armQ[k]));
      const f = forward(model, stand, q);
      let hits = 0;
      for (const body of clawBodies(p.arm)) samples(f, body, (x, y) => void (occupied[p.arm].has(key(x, y)) && hits++));
      if (snack) {
        const gp = kit.gripChain[p.arm].fk(q).p;
        const h = p.heading, u = [Math.cos(h), Math.sin(h)], v = [-u[1], u[0]];
        for (let a = -0.02; a <= 0.02; a += 0.002) for (let b = -0.02; b <= 0.02; b += 0.002) if (occupied[p.arm].has(key(gp[0] + u[0] * a + v[0] * b, gp[1] + u[1] * a + v[1] * b))) hits++;
      }
      assert.equal(hits, 0, `${label}: the ${p.arm} claw${snack ? ' (with the snack)' : ''} overlaps the robot`);
      checked++;
    }
  }
  const grab = new World(model);
  for (let i = 0; i < 60; i++) grab.step({ cmd: NO_COMMAND, action: false });
  const gBase = grab.snapshot();
  for (let ly = -0.28; ly <= 0.28; ly += 0.02) {
    for (let lx = 0.0; lx <= 0.32; lx += 0.02) {
      grab.restore(gBase);
      place(grab, grab.course.stand.c, lx, ly);
      const p = grab.reach().grab;
      if (p) check(grab, p, `grab at ${(lx * 100).toFixed(0)},${(ly * 100).toFixed(0)} cm`);
    }
  }
  const drop = carrying();
  const dBase = drop.snapshot();
  for (let ly = -0.28; ly <= 0.3; ly += 0.02) {
    for (let lx = 0.0; lx <= 0.4; lx += 0.02) {
      drop.restore(dBase);
      place(drop, drop.course.dish.c, lx, ly);
      const p = drop.reach().drop;
      if (p) check(drop, p, `drop at ${(lx * 100).toFixed(0)},${(ly * 100).toFixed(0)} cm`);
    }
  }
  console.log(`  ${checked} claw poses checked against the meshes`);
  assert.ok(checked > 300);
});

test('hints say what to do: get closer, turn to face it, back up, or turn to the claw holding the snack', () => {
  const world = carrying();
  const base = world.snapshot();
  const d = world.course.dish.c;
  const hintAt = (lx: number, ly: number) => {
    world.restore(base);
    place(world, d, lx, ly);
    assert.equal(world.reach().drop, null, `expected no drop at ${lx},${ly}`);
    return world.reachHint();
  };
  assert.match(hintAt(0.6, 0.1), /Get closer/);
  assert.match(hintAt(-0.25, 0.05), /Turn to face/);
  assert.match(hintAt(0.12, 0.3), /Turn to face/);
  assert.match(hintAt(0.22, -0.11), /left claw: turn right/);
  // too close only happens when grabbing (a drop works right up to where the robot bumps the dish)
  const grab = new World(model);
  for (let i = 0; i < 60; i++) grab.step({ cmd: NO_COMMAND, action: false });
  place(grab, grab.course.stand.c, 0.17, 0);
  assert.equal(grab.reach().grab, null);
  assert.match(grab.reachHint(), /Back up a little: the snack/);
});
