// Rebuilds creased normals off the main thread. Receives each link's quantised positions plus the node
// transform that dequantises them, returns float positions in the link frame (metres), normals and indices.

import { creaseNormals } from './crease.ts';

export interface NormalsJob {
  name: string;
  position: Int16Array | Uint16Array | Int8Array | Uint8Array | Float32Array;
  normalized: boolean;
  matrix: number[]; // column-major 4x4, the GLB node's local transform
  index: Uint16Array | Uint32Array;
}
export interface NormalsResult {
  name: string;
  position: Float32Array;
  normal: Float32Array;
  index: Uint16Array | Uint32Array;
}

export function dequantise(job: NormalsJob): Float32Array {
  const src = job.position;
  const div = !job.normalized || src instanceof Float32Array ? 1
    : src instanceof Int16Array ? 32767 : src instanceof Uint16Array ? 65535 : src instanceof Int8Array ? 127 : 255;
  const signed = src instanceof Int16Array || src instanceof Int8Array;
  const m = job.matrix;
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    let x = src[i] / div, y = src[i + 1] / div, z = src[i + 2] / div;
    if (signed && div !== 1) { x = Math.max(x, -1); y = Math.max(y, -1); z = Math.max(z, -1); }
    out[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    out[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    out[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  return out;
}

export function processJob(job: NormalsJob, creaseAngle: number): NormalsResult {
  const pos = dequantise(job);
  const r = creaseNormals(pos, job.index, creaseAngle);
  const nV = r.position.length / 3;
  return { name: job.name, position: r.position, normal: r.normal, index: nV < 65536 ? Uint16Array.from(r.index) : r.index };
}

// Worker entry (ignored when this module is imported on the main thread as a fallback).
const scope = globalThis as unknown as { WorkerGlobalScope?: unknown; onmessage: unknown; postMessage: (m: unknown, t: Transferable[]) => void };
if (typeof scope.WorkerGlobalScope !== 'undefined') {
  scope.onmessage = (e: MessageEvent<{ jobs: NormalsJob[]; creaseAngle: number }>) => {
    const out = e.data.jobs.map((j) => processJob(j, e.data.creaseAngle));
    scope.postMessage({ out }, out.flatMap((r) => [r.position.buffer, r.normal.buffer, r.index.buffer]));
  };
}
