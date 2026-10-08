// The crab-rave crowd plan: room for a crowd, nobody inside furniture or walls, nobody walking through anybody
// (or the hero), everyone in place before the drop, and the dancers move in step with the hero's dance.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { dancerPose, planRave, MAX_DANCERS, type RavePlan } from '../src/sim/rave.ts';
import { buildScuttleCycle, RAVE_BEATS } from '../src/sim/dance.ts';
import { sampleClip, type ClipData } from '../src/sim/clip.ts';
import { CORNER, shapeDistance } from '../src/sim/course.ts';
import { loadModel, ROOT } from './helpers/assets.ts';

const model = loadModel();
const rave = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/assets/motions/rave.json'), 'utf8')) as ClipData;
const cycle = buildScuttleCycle(model);
// the open rug where a game starts, and where the guided tour's delivery leaves the hero
// the open rug where a game starts (and where the tour's finale dances), by the dish, and by the stand facing
// into the room's corner (every camera spot in front of it would be inside a wall, so it is seen from behind)
const SPOTS = [
  { name: 'start', hero: { x: 0, y: 0, yaw: 0 }, min: 14, front: true },
  { name: 'by the dish', hero: { x: 0.42, y: 0.55, yaw: Math.PI - 0.35 }, min: 1, front: true },
  { name: 'facing the corner', hero: { x: 1.5, y: 0.45, yaw: 0.75 }, min: 1, front: false },
];

function check(plan: RavePlan, hero: { x: number; y: number }, label: string): void {
  let closest = Infinity, toHero = Infinity, toObstacle = Infinity;
  for (let beat = -3; beat < 52; beat += 0.1) {
    const at = plan.dancers.map((d) => dancerPose(d, beat, rave, cycle)).filter((p) => p) as { pos: number[] }[];
    for (let i = 0; i < at.length; i++) {
      const p = at[i].pos;
      toHero = Math.min(toHero, Math.hypot(p[0] - hero.x, p[1] - hero.y));
      for (const o of CORNER.obstacles) if (o.height > 0.03) toObstacle = Math.min(toObstacle, shapeDistance(o.shape, [p[0], p[1]]).d);
      for (let j = i + 1; j < at.length; j++) closest = Math.min(closest, Math.hypot(p[0] - at[j].pos[0], p[1] - at[j].pos[1]));
    }
  }
  console.log(`  ${label}: ${plan.dancers.length} dancers; closest pair ${closest.toFixed(2)} m, closest to the hero ${toHero.toFixed(2)} m, to furniture ${toObstacle.toFixed(2)} m`);
  assert.ok(closest > 0.4, `${label}: two dancers ${closest.toFixed(2)} m apart`);
  assert.ok(toHero > 0.42, `${label}: a dancer comes ${toHero.toFixed(2)} m from the hero`);
  assert.ok(toObstacle > 0.15, `${label}: a dancer comes ${toObstacle.toFixed(2)} m from furniture`);
}

for (const spot of SPOTS) {
  test(`crowd plan ${spot.name}: room for a crowd, no collisions, in place before the drop`, () => {
    const plan = planRave(CORNER, spot.hero, 7);
    assert.ok(plan.dancers.length >= spot.min && plan.dancers.length <= MAX_DANCERS, `${plan.dancers.length} dancers`);
    // the camera looks at the hero's front half, not its back
    const toEye = Math.atan2(plan.eye[1] - spot.hero.y, plan.eye[0] - spot.hero.x);
    if (spot.front) assert.ok(Math.abs(Math.atan2(Math.sin(toEye - spot.hero.yaw), Math.cos(toEye - spot.hero.yaw))) <= Math.PI / 2 + 1e-6, 'camera behind the hero');
    for (const d of plan.dancers) assert.ok(d.arrive < RAVE_BEATS.setup, 'arrives before the drop');
    // the camera spot is inside the room and not inside furniture
    const b = CORNER.bounds;
    assert.ok(plan.eye[0] > b.min[0] && plan.eye[0] < b.max[0] && plan.eye[1] > b.min[1] && plan.eye[1] < b.max[1]);
    for (const o of CORNER.obstacles) if (o.height > 0.25) assert.ok(shapeDistance(o.shape, [plan.eye[0], plan.eye[1]]).d > 0.1, `camera inside the ${o.label}`);
    check(plan, spot.hero, spot.name);
  });
}

test('the crowd dances in step with the hero', () => {
  const plan = planRave(CORNER, SPOTS[0].hero, 7);
  const d = plan.dancers[0];
  for (const beat of [12, 20.5, 33.25]) {
    const p = dancerPose(d, beat, rave, cycle)!;
    const hero = sampleClip(rave, ((beat + d.jitter) * 60) / 124);
    p.q.forEach((v, j) => assert.ok(Math.abs(v - hero.q[j]) < 1e-9));
  }
});
