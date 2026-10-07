// Test helpers: read the shipped robot assets in Node (the same files the browser downloads).

import fs from 'node:fs';
import path from 'node:path';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { MeshoptDecoder } from 'meshoptimizer';
import { RobotModel, type RobotJson } from '../../src/robot/model.ts';

export const ROOT = path.resolve(import.meta.dirname, '../..');
export const ROBOT_DIR = path.join(ROOT, 'public/assets/robot');

export function loadModel(): RobotModel {
  return new RobotModel(JSON.parse(fs.readFileSync(path.join(ROBOT_DIR, 'robot.json'), 'utf8')) as RobotJson);
}

export interface LinkMesh {
  body: string;
  position: Float32Array; // link frame, metres (dequantised)
  index: Uint32Array;
}

/** Decode jumper.glb into per-link float positions in each link's own frame. */
export async function loadLinkMeshes(): Promise<Map<string, LinkMesh>> {
  await MeshoptDecoder.ready;
  const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.decoder': MeshoptDecoder });
  const doc = await io.read(path.join(ROBOT_DIR, 'jumper.glb'));
  const out = new Map<string, LinkMesh>();
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const prim = mesh.listPrimitives()[0];
    const pos = prim.getAttribute('POSITION')!;
    const m = node.getMatrix(); // the dequantisation transform (column-major)
    const n = pos.getCount();
    const position = new Float32Array(n * 3);
    const e = [0, 0, 0];
    for (let i = 0; i < n; i++) {
      pos.getElement(i, e);
      position[3 * i] = m[0] * e[0] + m[4] * e[1] + m[8] * e[2] + m[12];
      position[3 * i + 1] = m[1] * e[0] + m[5] * e[1] + m[9] * e[2] + m[13];
      position[3 * i + 2] = m[2] * e[0] + m[6] * e[1] + m[10] * e[2] + m[14];
    }
    const idx = prim.getIndices()!;
    out.set(node.getName(), { body: node.getName(), position, index: Uint32Array.from(idx.getArray() as ArrayLike<number>) });
  }
  return out;
}

/** Positions of a binary STL (triangle soup) in the link frame. */
export function readSTL(file: string): Float32Array {
  const buf = fs.readFileSync(file);
  const n = buf.readUInt32LE(80);
  const pos = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;
    for (let k = 0; k < 9; k++) pos[i * 9 + k] = buf.readFloatLE(o + k * 4);
  }
  return pos;
}
