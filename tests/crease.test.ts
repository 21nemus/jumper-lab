import { test } from 'node:test';
import assert from 'node:assert/strict';
import { creaseNormals } from '../src/robot/crease.ts';
import { loadLinkMeshes } from './helpers/assets.ts';

test('a cube splits into 24 vertices with axis-aligned normals', () => {
  const p = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]);
  // outward-facing faces, two triangles each
  const q = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [0, 4, 7, 3]];
  const idx = new Uint32Array(q.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]));
  const m = creaseNormals(p, idx, (40 * Math.PI) / 180);
  assert.equal(m.position.length / 3, 24);
  for (let i = 0; i < m.normal.length; i += 3) {
    const n = [m.normal[i], m.normal[i + 1], m.normal[i + 2]];
    assert.equal(n.filter((v) => Math.abs(Math.abs(v) - 1) < 1e-6).length, 1);
    // the normal points away from the cube centre
    const c = [m.position[i] - 0.5, m.position[i + 1] - 0.5, m.position[i + 2] - 0.5];
    assert.ok(n[0] * c[0] + n[1] * c[1] + n[2] * c[2] > 0);
  }
});

test('a smooth surface does not split', () => {
  // a 32x16 UV sphere: neighbouring faces differ by ~11 degrees, well under the crease angle
  const pos: number[] = [];
  const idx: number[] = [];
  const W = 32, H = 16;
  for (let j = 0; j <= H; j++) for (let i = 0; i <= W; i++) {
    const th = (j / H) * Math.PI, ph = (i / W) * 2 * Math.PI;
    pos.push(Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph));
  }
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const a = j * (W + 1) + i, b = a + 1, c = a + W + 1, d = c + 1;
    if (j > 0) idx.push(a, c, b);
    if (j < H - 1) idx.push(b, c, d);
  }
  const used = new Set(idx);
  const m = creaseNormals(new Float32Array(pos), new Uint32Array(idx), (32 * Math.PI) / 180);
  assert.equal(m.position.length / 3, used.size);
});

test('the full robot rebuilds its normals quickly enough to run at load (Node timing)', async () => {
  const meshes = await loadLinkMeshes();
  let tris = 0, vin = 0, vout = 0;
  const t0 = performance.now();
  for (const m of meshes.values()) {
    const r = creaseNormals(m.position, m.index, (32 * Math.PI) / 180);
    tris += m.index.length / 3;
    vin += m.position.length / 3;
    vout += r.position.length / 3;
  }
  const ms = performance.now() - t0;
  console.log(`  crease normals: ${tris} triangles, ${vin} -> ${vout} vertices in ${ms.toFixed(0)} ms`);
  assert.ok(ms < 1500);
});
