// The crowd's robot: a low-poly copy of the shipped jumper.glb for the crab-rave dancers (about 5 % of the
// triangles), one node per link like the original, so the same forward kinematics poses it.
//
//   node --experimental-strip-types tools/build-crowd.mjs
//
// Derived from public/assets/robot/jumper.glb (itself converted from KingKong's meshes, Apache-2.0), so it
// needs no upstream download. Output: public/assets/robot/jumper-crowd.glb.

import path from 'node:path';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';
import { Document, NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { quantize, reorder, prune } from '@gltf-transform/functions';
import { loadLinkMeshes } from '../tests/helpers/assets.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'public/assets/robot/jumper-crowd.glb');
const RATIO = 0.05; // keep about this share of each link's triangles
const MIN_TRIS = 24;
const ERROR = 0.25; // relative simplification error allowed (the dancers are small on screen)

await MeshoptSimplifier.ready;
const links = await loadLinkMeshes();
const doc = new Document();
const buffer = doc.createBuffer();
const scene = doc.createScene('jumper-crowd');
let trisIn = 0, trisOut = 0;
for (const [name, m] of links) {
  const tris = m.index.length / 3;
  const target = Math.max(MIN_TRIS, Math.floor(tris * RATIO)) * 3;
  let [index] = MeshoptSimplifier.simplify(m.index, m.position, 3, target, ERROR, []);
  if (index.length > target * 1.6) [index] = [MeshoptSimplifier.simplifySloppy(m.index, m.position, 3, null, target, ERROR)[0]];
  if (process.env.VERBOSE) console.log(name.padEnd(32), tris, '->', index.length / 3);
  // keep only the vertices still in use
  const remap = new Int32Array(m.position.length / 3).fill(-1);
  const keep = [];
  for (const i of index) if (remap[i] < 0) { remap[i] = keep.length; keep.push(i); }
  const position = new Float32Array(keep.length * 3);
  keep.forEach((v, k) => position.set(m.position.subarray(v * 3, v * 3 + 3), k * 3));
  const indices = Uint32Array.from(index, (i) => remap[i]);
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(position).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer));
  scene.addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)));
  trisIn += tris;
  trisOut += indices.length / 3;
}
await doc.transform(prune(), reorder({ encoder: MeshoptEncoder }), quantize({ quantizePosition: 12 }));
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
doc.createExtension(KHRMeshQuantization).setRequired(true);
doc.getRoot().getAsset().generator = 'jumper-lab tools/build-crowd.mjs';
doc.getRoot().getAsset().copyright = 'Jumper model by KingKong Robotics (Apache-2.0); converted and simplified by jumper-lab';
const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
await io.write(OUT, doc);
const { size } = await import('node:fs').then((fs) => fs.statSync(OUT));
console.log(`jumper-crowd.glb: ${links.size} links, ${trisIn} -> ${trisOut} triangles, ${(size / 1024).toFixed(0)} KB`);
