// Gate 7: the parts inside the link meshes. Every shipped triangle belongs to exactly one named part, the 22
// servos sit on their joints' hinge axes, the one servo this project added is marked as added, every upstream
// piece is accounted for, and Build attaches every part exactly once.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadLinkMeshes, loadModel, readSTL, ROOT } from './helpers/assets.ts';
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { buildSteps } from '../src/build/sequence.ts';
import { splitPieces, summary } from '../tools/parts.mjs';

const model = loadModel();
const json = model.json;

test('92 parts tile the link meshes: every shipped triangle is in exactly one part', async () => {
  const meshes = await loadLinkMeshes();
  assert.equal(json.parts.length, 92);
  for (const b of json.bodies) {
    const own = json.parts.filter((p) => p.body === b.name).sort((a, c) => a.start - c.start);
    assert.ok(own.length >= 1, `${b.name} has no parts`);
    let at = 0;
    for (const p of own) {
      assert.equal(p.start, at, `${b.name}: ${p.name} starts at ${p.start}, expected ${at}`);
      assert.ok(p.count >= 4, `${b.name}: ${p.name} has ${p.count} triangles`);
      at += p.count;
    }
    assert.equal(at, meshes.get(b.name)!.index.length / 3, `${b.name}: the parts cover ${at} triangles`);
    assert.equal(new Set(own.map((p) => p.name)).size, own.length, `${b.name}: two parts share a name`);
  }
});

test('22 servos, one per joint, each centred on its hinge axis; exactly one added, and marked', async () => {
  const meshes = await loadLinkMeshes();
  const servos = json.parts.filter((p) => p.kind === 'servo');
  assert.equal(servos.length, 22);
  assert.deepEqual(servos.map((p) => p.joint).sort(), [...json.joints].sort());
  for (const p of servos) {
    const b = json.bodies[model.body(p.body)];
    assert.equal(p.joint, b.joint!.name, `${p.body}: the servo should turn ${b.joint!.name}`);
    // from the shipped triangles: centred on the axis, near the joint, 36.8 mm long along the axis
    const m = meshes.get(p.body)!;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let i = p.start * 3; i < (p.start + p.count) * 3; i++) {
      const v = m.index[i] * 3;
      for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], m.position[v + a]);
        max[a] = Math.max(max[a], m.position[v + a]);
      }
    }
    const axis = b.joint!.axis;
    const c = min.map((v, a) => (v + max[a]) / 2);
    const along = c[0] * axis[0] + c[1] * axis[1] + c[2] * axis[2];
    const off = Math.hypot(c[0] - along * axis[0], c[1] - along * axis[1], c[2] - along * axis[2]);
    const len = axis.reduce((s, v, a) => s + Math.abs(v) * (max[a] - min[a]), 0);
    assert.ok(off < 1e-3 && Math.abs(along) < 3e-3, `${p.body}: servo ${(off * 1000).toFixed(2)} mm off its axis, ${(along * 1000).toFixed(2)} mm along it`);
    assert.ok(Math.abs(len - 0.0368) < 5e-4, `${p.body}: servo ${(len * 1000).toFixed(1)} mm long`);
  }
  const added = json.parts.filter((p) => p.basis === 'added');
  assert.equal(added.length, 1);
  assert.equal(added[0].body, 'RM_calf_link');
  assert.equal(added[0].kind, 'servo');
  assert.equal(added[0].source.copiedFrom, 'RR_calf_link');
  assert.equal(json.meshes.find((m) => m.body === 'RM_calf_link')!.trisAdded, 972);
  assert.deepEqual(json.partsSource.added.map((a) => a.body), ['RM_calf_link']);
  // the copy sits exactly where the right rear calf's own servo sits in its link
  const rr = json.parts.find((p) => p.body === 'RR_calf_link' && p.kind === 'servo')!;
  assert.deepEqual(added[0].center, rr.center);
  assert.deepEqual(added[0].sizeMm, rr.sizeMm);
});

test('the parts table accounts for every upstream piece: 123 = 91 parts + 32 slivers', () => {
  const u = json.partsSource.upstream;
  assert.deepEqual(u, { pieces: 123, slivers: 32, parts: 91, servos: 21 });
  let pieces = 0, slivers = 0;
  for (const b of json.bodies) {
    const own = json.parts.filter((p) => p.body === b.name && p.basis !== 'added');
    pieces += own[0].source.of;
    slivers += own.reduce((s, p) => s + (p.source.slivers ?? 0), 0);
    assert.ok(own.every((p) => p.source.of === own[0].source.of), `${b.name}: inconsistent piece count`);
    assert.equal(new Set(own.map((p) => p.source.piece)).size, own.length, `${b.name}: two parts claim one piece`);
  }
  assert.equal(pieces, u.pieces);
  assert.equal(slivers, u.slivers);
  assert.equal(json.parts.filter((p) => p.basis !== 'added').length, u.parts);
});

const CACHE = path.join(ROOT, 'tools/.cache/upstream/jumper/assets/jumper');
test('source STLs: each file splits into the pieces the table says (needs npm run upstream:fetch)', { skip: !fs.existsSync(CACHE) }, () => {
  for (const b of json.bodies) {
    const mesh = json.meshes.find((m) => m.body === b.name)!;
    // welded at 1 µm, as tools/build-robot.mjs does (a few shared corners differ in the last float bit)
    let g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(readSTL(path.join(CACHE, mesh.file)), 3));
    g = mergeVertices(g, 1e-6);
    const s = summary(splitPieces(g.getAttribute('position').array, g.getIndex()!.array).pieces);
    const own = json.parts.filter((p) => p.body === b.name && p.basis !== 'added');
    assert.equal(s.pieces, own[0].source.of, `${b.name}: ${s.pieces} pieces`);
    assert.equal(s.parts, own.length, `${b.name}: ${s.parts} parts`);
    assert.equal(s.slivers, own.reduce((n, p) => n + (p.source.slivers ?? 0), 0), `${b.name}: ${s.slivers} slivers`);
  }
});

test('Build attaches every part exactly once, servos before what goes around them, left and right together', () => {
  const steps = buildSteps(json);
  assert.deepEqual(steps.map((s) => s.id), ['chassis', 'face', 'mid', 'rear', 'claws', 'shell']);
  const all = steps.flatMap((s) => s.beats.flat());
  assert.equal(all.length, json.parts.length);
  assert.equal(new Set(all).size, json.parts.length);
  for (const s of steps) {
    // within a link, its servo flies in first
    const order = s.beats.flat();
    for (const k of order) {
      const p = json.parts[k];
      if (p.kind === 'servo') continue;
      const servo = order.findIndex((j) => json.parts[j].body === p.body && json.parts[j].kind === 'servo');
      if (servo >= 0) assert.ok(servo < order.indexOf(k), `${p.body}: ${p.name} before its servo`);
    }
    if (['mid', 'rear', 'claws'].includes(s.id)) {
      for (const beat of s.beats) {
        assert.equal(beat.length, 2);
        const [l, r] = beat.map((k) => json.parts[k]);
        assert.equal(l.name, r.name);
        assert.equal(l.body.slice(1), r.body.slice(1), `${l.body} and ${r.body} should be a mirror pair`);
      }
    }
  }
});
