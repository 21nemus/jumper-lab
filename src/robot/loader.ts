// Loads robot.json and jumper.glb, then rebuilds normals in a worker. Returns one BufferGeometry per link,
// in the link's own frame (metres, MuJoCo axes).

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RobotModel, type RobotJson } from './model.ts';
import { processJob, type NormalsJob, type NormalsResult } from './normals.worker.ts';

export const CREASE_ANGLE = (32 * Math.PI) / 180;

export interface LoadedRobot {
  model: RobotModel;
  geometries: Map<string, THREE.BufferGeometry>; // by body name
  stats: { glbBytes: number; jsonBytes: number; triangles: number; vertices: number; normalsMs: number; usedWorker: boolean };
}

export type Progress = (fraction: number, label: string) => void;

async function fetchJson(url: string, signal?: AbortSignal): Promise<{ json: RobotJson; bytes: number }> {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} (${url})`);
  const text = await res.text();
  return { json: JSON.parse(text) as RobotJson, bytes: text.length };
}

function runWorker(jobs: NormalsJob[]): Promise<NormalsResult[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./normals.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ out: NormalsResult[] }>) => {
      worker.terminate();
      resolve(e.data.out);
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'normals worker failed'));
    };
    worker.postMessage({ jobs, creaseAngle: CREASE_ANGLE }, jobs.map((j) => j.position.buffer as ArrayBuffer));
  });
}

export async function loadRobot(base: string, onProgress: Progress = () => {}, signal?: AbortSignal): Promise<LoadedRobot> {
  onProgress(0.02, 'Reading the robot description');
  const { json, bytes: jsonBytes } = await fetchJson(`${base}robot.json`, signal);
  const model = new RobotModel(json);

  onProgress(0.06, 'Downloading the robot');
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  let glbBytes = 0;
  const gltf = await new Promise<Awaited<ReturnType<GLTFLoader['loadAsync']>>>((resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    loader.load(
      `${base}jumper.glb`,
      resolve,
      (e) => {
        glbBytes = e.loaded;
        if (e.total) onProgress(0.06 + 0.64 * (e.loaded / e.total), 'Downloading the robot');
      },
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
    );
  });
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');

  const jobs: NormalsJob[] = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    // Quantised VEC3 shorts arrive interleaved (padded to a 4-byte stride); the accessors de-interleave
    // and denormalise, leaving only the node's dequantisation transform for the worker to apply.
    const pos = mesh.geometry.getAttribute('position') as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    const flat = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      flat[3 * i] = pos.getX(i);
      flat[3 * i + 1] = pos.getY(i);
      flat[3 * i + 2] = pos.getZ(i);
    }
    const index = mesh.geometry.getIndex()!;
    jobs.push({
      name: mesh.name,
      position: flat,
      normalized: false,
      matrix: mesh.matrixWorld.toArray(),
      index: (index.array as Uint16Array | Uint32Array).slice(),
    });
    mesh.geometry.dispose();
  });

  onProgress(0.75, 'Shaping the surfaces');
  const t0 = performance.now();
  let results: NormalsResult[];
  let usedWorker = true;
  try {
    results = await runWorker(jobs);
  } catch {
    usedWorker = false;
    results = jobs.map((j) => processJob(j, CREASE_ANGLE));
  }
  const normalsMs = performance.now() - t0;

  const geometries = new Map<string, THREE.BufferGeometry>();
  let triangles = 0, vertices = 0;
  for (const r of results) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(r.position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(r.normal, 3));
    g.setIndex(new THREE.BufferAttribute(r.index, 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    geometries.set(r.name, g);
    triangles += r.index.length / 3;
    vertices += r.position.length / 3;
  }
  for (const b of json.bodies) if (!geometries.has(b.name)) throw new Error(`jumper.glb has no mesh for ${b.name}`);
  onProgress(1, 'Ready');
  return { model, geometries, stats: { glbBytes, jsonBytes, triangles, vertices, normalsMs, usedWorker } };
}
