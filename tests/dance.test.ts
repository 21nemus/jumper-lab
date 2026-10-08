// The crab rave (our choreography): balanced, inside every limit, feet planted, on the beat, and the shipped
// clip is exactly what the generator writes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildRaveClip, danceFrame, quantiseClip, RAVE_BEATS, RAVE_BPM } from '../src/sim/dance.ts';
import { sampleClip, type ClipData } from '../src/sim/clip.ts';
import { World, DT } from '../src/sim/world.ts';
import { NO_COMMAND } from '../src/sim/robot.ts';
import { centreOfMass, footSite, forward } from '../src/robot/kinematics.ts';
import { LEGS } from '../src/robot/model.ts';
import { loadModel, ROOT } from './helpers/assets.ts';

const model = loadModel();
const clip = buildRaveClip(model);
const shipped = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/assets/motions/rave.json'), 'utf8')) as ClipData;

/** Convex hull of 2D points, counter-clockwise. */
function hull(pts: number[][]): number[][] {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: number[][] = [], up: number[][] = [];
  for (const q of p) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  for (const q of p.reverse()) {
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}
/** How far a point is inside a convex polygon (negative outside). */
function inside(h: number[][], c: number[]): number {
  let m = Infinity;
  for (let i = 0; i < h.length; i++) {
    const a = h[i], b = h[(i + 1) % h.length];
    const ex = b[0] - a[0], ey = b[1] - a[1];
    m = Math.min(m, (ex * (c[1] - a[1]) - ey * (c[0] - a[0])) / Math.hypot(ex, ey));
  }
  return m;
}

test('the shipped rave.json is what tools/build-dance.mjs writes (npm run dance)', () => {
  const fresh = quantiseClip(clip);
  const { q, base, ...meta } = shipped;
  const { q: fq, base: fb, ...freshMeta } = JSON.parse(JSON.stringify(fresh)) as ClipData;
  assert.deepEqual(meta, freshMeta);
  // the same numbers, give or take one quantisation step (a different Node's maths could round one differently)
  let worst = 0;
  q.forEach((row, i) => row.forEach((v, j) => (worst = Math.max(worst, Math.abs(v - fq[i][j])))));
  base.forEach((row, i) => row.forEach((v, j) => (worst = Math.max(worst, Math.abs(v - fb[i][j])))));
  assert.ok(worst <= 1, `rave.json is stale: off by ${worst} steps of 1e-4 (run npm run dance)`);
  assert.equal(shipped.source && 'generator' in shipped.source, true, 'labelled as generated choreography, not a recording');
});

test('the crab rave: every joint inside its limits, from HOME back to HOME', () => {
  let worst = -Infinity;
  for (const q of clip.q) q.forEach((v, j) => (worst = Math.max(worst, model.limits[j][0] - v, v - model.limits[j][1])));
  assert.ok(worst <= 0, `a joint passes its limit by ${(worst * 57.3).toFixed(3)} deg`);
  for (const q of [clip.q[0], clip.q[clip.frames - 1]]) q.forEach((v, j) => assert.ok(Math.abs(v - model.home[j]) < 1e-6));
});

test('the crab rave: feet that are down stay planted, and the centre of mass stays inside them (both claws up on four feet)', () => {
  const standing = forward(model, { pos: [0, 0, model.json.standZ], quat: [1, 0, 0, 0] }, model.home);
  const contact = Object.fromEntries(LEGS.map((l) => [l, footSite(model, standing, l)[2]]));
  const since: Record<string, number[] | null> = {};
  let drift = 0, worstMargin = Infinity, fourFeetFrames = 0, clawsUpFrames = 0;
  const tip = { LF: model.body('LF_finger_tip_link'), RF: model.body('RF_finger_tip_link') };
  for (let i = 0; i < clip.frames; i++) {
    const b = clip.base[i];
    const f = forward(model, { pos: [b[0], b[1], b[2]], quat: [b[3], b[4], b[5], b[6]] }, clip.q[i]);
    const down: number[][] = [];
    for (const leg of LEGS) {
      const p = footSite(model, f, leg);
      if (p[2] < contact[leg] + 0.002) {
        down.push([p[0], p[1]]);
        since[leg] ??= p;
        drift = Math.max(drift, Math.hypot(p[0] - since[leg]![0], p[1] - since[leg]![1]));
      } else since[leg] = null;
    }
    if (down.length === 4) fourFeetFrames++;
    if (f.p[tip.LF][2] > 0.2 && f.p[tip.RF][2] > 0.2) clawsUpFrames++;
    assert.ok(down.length >= 4, `only ${down.length} feet down at ${(i / clip.hz).toFixed(2)} s`);
    worstMargin = Math.min(worstMargin, inside(hull(down), centreOfMass(model, f).com));
  }
  console.log(`  centre of mass at least ${(worstMargin * 1000).toFixed(1)} mm inside the feet that are down; planted feet drift at most ${(drift * 1000).toFixed(2)} mm; ${(fourFeetFrames / clip.hz).toFixed(1)} s on four feet`);
  assert.ok(worstMargin > 0.015, `centre of mass only ${(worstMargin * 1000).toFixed(1)} mm inside`);
  assert.ok(drift < 0.0005, `a planted foot drifts ${(drift * 1000).toFixed(2)} mm`);
  assert.ok(clawsUpFrames / clip.hz > (RAVE_BEATS.dance * 60) / RAVE_BPM, 'both claws are up for the whole dance');
});

test('the crab rave is on the beat: claws shut on every beat, open between, the body lowest on the beat', () => {
  for (let d = 1; d < RAVE_BEATS.dance - 2; d++) {
    const on = danceFrame(d), off = danceFrame(d + 0.6);
    assert.ok(on.open < 0.01 && off.open > 0.99, `beat ${d}: claws ${on.open.toFixed(2)} on, ${off.open.toFixed(2)} after`);
    assert.ok(on.z < 1e-6 && danceFrame(d + 0.5).z > 0.0075);
  }
  assert.equal(clip.duration, ((RAVE_BEATS.setup + RAVE_BEATS.dance + RAVE_BEATS.outro) * 60) / RAVE_BPM);
});

test('the crab rave plays like a gesture and hands back to walking', () => {
  const world = new World(model);
  world.clips.set('rave', shipped);
  for (let i = 0; i < 1 / DT; i++) world.step({ cmd: NO_COMMAND, action: false }); // let it settle
  assert.ok(world.play('rave'));
  const events: string[] = [];
  for (let i = 0; i < (shipped.duration + 0.5) / DT; i++) for (const e of world.step({ cmd: NO_COMMAND, action: false })) events.push(e.kind);
  assert.ok(events.includes('clip-end'));
  assert.equal(world.state.clip, null);
  const before = world.state.robot.x;
  for (let i = 0; i < 1.5 / DT; i++) world.step({ cmd: { fwd: 1, left: 0, turn: 0 }, action: false });
  assert.ok(world.state.robot.x - before > 0.1, 'walks off after dancing');
  const smp = sampleClip(shipped, shipped.duration);
  smp.q.forEach((v, j) => assert.ok(Math.abs(v - model.home[j]) < 2e-4));
});
