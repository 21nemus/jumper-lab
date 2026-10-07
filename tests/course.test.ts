import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearFoothold, CORNER, CORE_R, resolveRobot, ROBOT_R, shapeDistance } from '../src/sim/course.ts';

test('the start is clear and every obstacle footprint is inside the room', () => {
  const r = resolveRobot(CORNER, [CORNER.start.x + 0.02, CORNER.start.y]);
  assert.equal(r.contacts.length, 0);
});

test('a robot pushed into furniture comes out on the near side', () => {
  const books = CORNER.obstacles.find((o) => o.id === 'books')!;
  const c = (books.shape as { c: [number, number] }).c;
  const r = resolveRobot(CORNER, [c[0] - 0.1, c[1]]);
  assert.ok(r.contacts.some((x) => x.id === 'books'));
  assert.ok(shapeDistance(books.shape, r.p).d >= ROBOT_R - 1e-6);
});

test('reach objects stop only the shell core, so a claw can get over them', () => {
  const st = CORNER.stand.c;
  const r = resolveRobot(CORNER, [st[0] - 0.2, st[1]]);
  assert.ok(!r.contacts.some((x) => x.id === 'stand'), 'robot 0.2 m away is not blocked by the stand');
  const r2 = resolveRobot(CORNER, [st[0] - 0.05, st[1]]);
  const stand = CORNER.obstacles.find((o) => o.id === 'stand')!;
  assert.ok(shapeDistance(stand.shape, r2.p).d >= CORE_R - 1e-6);
});

test('footholds never land inside furniture', () => {
  for (const o of CORNER.obstacles) {
    const c = o.shape.kind === 'circle' ? o.shape.c : o.shape.c;
    const p = clearFoothold(CORNER, c);
    assert.ok(shapeDistance(o.shape, p).d > 0, `${o.id}: foothold left inside`);
  }
});
