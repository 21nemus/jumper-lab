// End to end: the Snack Heist driven through the real inputs (stick axes + the claw button).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World, DT, type SimEvent } from '../src/sim/world.ts';
import { Autopilot, CORNER_RUN, TOUR_RUN } from '../src/sim/autopilot.ts';
import { loadModel } from './helpers/assets.ts';

const model = loadModel();

function run(world: World, pilot: Autopilot, seconds: number, onStep?: (ev: SimEvent[], i: number) => void) {
  for (let i = 0; i < seconds / DT && !pilot.done; i++) {
    const ev = world.step(pilot.next(world, DT));
    onStep?.(ev, i);
  }
}

test('the reference run grabs the snack with the left claw and delivers it to the dish', () => {
  const world = new World(model);
  const pilot = new Autopilot(CORNER_RUN);
  const seen: string[] = [];
  let attachGap = Infinity;
  run(world, pilot, 120, (ev) => {
    for (const e of ev) {
      if (e.kind !== 'step') seen.push(e.kind);
      if (e.kind === 'attached') {
        // attached only when the closed jaws are on the snack: grip point within 6 mm of where it sat
        const g = world.kit.gripWorld(world.state.robot, 'LF');
        const st = world.course.stand;
        attachGap = Math.hypot(g[0] - st.c[0], g[1] - st.c[1], g[2] - (st.topZ + world.course.snackSize / 2));
      }
    }
  });
  console.log(`  ${seen.join(' > ')}`);
  console.log(`  mission ${world.state.mission.status} in ${world.state.mission.time.toFixed(1)} s, bumps ${world.state.mission.bumps}, misses ${world.state.mission.misses}; grip-to-snack at attach ${(attachGap * 1000).toFixed(1)} mm`);
  assert.equal(world.state.mission.status, 'delivered');
  assert.equal(world.state.snack.where, 'dish');
  assert.ok(attachGap < 0.006, `attached ${(attachGap * 1000).toFixed(1)} mm away`);
  assert.equal(world.state.claw.phase, 'foot');
  assert.equal(world.state.robot.carrier, null);
});

test('the tour route (claw pressed as soon as it can reach) also delivers, with the left claw', () => {
  const world = new World(model);
  const pilot = new Autopilot(TOUR_RUN);
  const arms: string[] = [];
  run(world, pilot, 120, (ev) => {
    for (const e of ev) if (e.kind === 'grab-start') arms.push(e.arm);
  });
  console.log(`  delivered in ${world.state.mission.time.toFixed(1)} s`);
  assert.deepEqual(arms, ['LF']);
  assert.equal(world.state.mission.status, 'delivered');
  assert.equal(world.state.claw.phase, 'foot');
});

test('the claw button does nothing useful out of reach: it gives a hint and never attaches', () => {
  const world = new World(model);
  const ev = world.step({ cmd: { fwd: 0, left: 0, turn: 0 }, action: true });
  for (let i = 0; i < 300; i++) ev.push(...world.step({ cmd: { fwd: 0, left: 0, turn: 0 }, action: i % 10 === 0 }));
  assert.ok(ev.some((e) => e.kind === 'hint'));
  assert.ok(!ev.some((e) => e.kind === 'attached'));
  assert.equal(world.state.snack.mode, 'stand');
});

test('freeze mid-carry and resume: the snapshot restores the exact state', () => {
  const world = new World(model);
  const pilot = new Autopilot(CORNER_RUN);
  run(world, pilot, 60, () => {});
  // drive until carrying
  const w2 = new World(model);
  const p2 = new Autopilot(CORNER_RUN);
  for (let i = 0; i < 120 / DT && w2.state.claw.phase !== 'carrying'; i++) w2.step(p2.next(w2, DT));
  assert.equal(w2.state.claw.phase, 'carrying');
  const snap = w2.snapshot();
  const before = JSON.stringify(w2.state);
  // "inspect" must not touch the sim; even if something did, restore puts it back exactly
  w2.state.robot.q[0] += 1;
  w2.state.snack.p = [0, 0, 0];
  w2.restore(snap);
  assert.equal(JSON.stringify(w2.state), before);
  assert.equal(w2.state.snack.mode, 'held');
});

test('rapid repeated button presses during a grab never break the sequence', () => {
  const world = new World(model);
  const pilot = new Autopilot(CORNER_RUN);
  let spam = 0;
  for (let i = 0; i < 120 / DT && !pilot.done; i++) {
    const inp = pilot.next(world, DT);
    if (world.state.claw.phase === 'grabbing' || world.state.claw.phase === 'releasing') inp.action = (spam++ % 3) === 0;
    world.step(inp);
  }
  assert.equal(world.state.mission.status, 'delivered');
});
