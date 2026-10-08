// Builds the robot's web assets from the pinned upstream sources (run `npm run upstream:fetch` first).
//
//   node tools/build-robot.mjs
//
// Writes public/assets/robot/:
//   jumper.glb     one node per link, welded + simplified, positions + indices only (normals are rebuilt in
//                  the browser), 14-bit quantised, meshopt-compressed. Vertices stay in each link's own frame.
//                  Each link's triangles are grouped by part (see tools/parts.mjs), so a part is one range.
//   robot.json     the kinematic tree of jumper.xml (bodies, hinge axes, limits, inertials, colours, sites,
//                  cameras), the calibrated standing pose, the stance footprint and the claw's documented
//                  poses, each with the upstream file it was read from; and the parts table: every part
//                  inside the link meshes, its name, its triangle range and the source piece it came from.
//   LICENSE-jumper-apache-2.0.txt, NOTICE-jumper.txt   upstream's licence and notice, unchanged.
//
// Every number is read from an upstream file and cross-checked against a second one where upstream states
// it twice; a disagreement stops the build rather than picking one.

import fs from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';
import { Document, NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { quantize, reorder, prune } from '@gltf-transform/functions';
import { cached, readLock } from './upstream.mjs';
import { isServoPiece, nameParts, splitPieces, summary, SERVO } from './parts.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'public/assets/robot');
const SRC = 'jumper';
const up = (p) => cached(SRC, p);
const text = (p) => fs.readFileSync(up(p), 'utf8');
const lock = readLock().sources.find((s) => s.id === SRC);

// Simplification: keep small parts whole, cut large ones to ~35% within a 0.25%-of-extent error bound.
const KEEP_TRIS = 2000;
const RATIO = 0.35;
const ERROR = 0.0025;

function assert(cond, msg) {
  if (!cond) throw new Error(`build-robot: ${msg}`);
}
const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const vec = (s, n) => (s ? String(s).trim().split(/\s+/).map(Number) : new Array(n).fill(0));
const r6 = (v) => +v.toFixed(6);

// ── jumper.xml ──────────────────────────────────────────────────────────────────────────────────────────
const XML_PATH = 'assets/jumper/jumper.xml';
const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  isArray: (name, _p, _l, isAttr) => !isAttr && ['body', 'geom', 'joint', 'site', 'camera', 'mesh'].includes(name),
}).parse(text(XML_PATH)).mujoco;

assert(xml.compiler.angle === 'radian', 'compiler angle is not radian');
const meshFile = Object.fromEntries(xml.asset.mesh.map((m) => [m.name, m.file]));
const ROTATION_ATTRS = ['quat', 'euler', 'axisangle', 'xyaxes', 'zaxis'];

const bodies = [];
const joints = [];
let freeJoint = null;
function walk(b, parent) {
  for (const a of ROTATION_ATTRS) assert(b[a] === undefined, `body ${b.name} has a ${a}; the rig assumes translation-only bodies`);
  const hinges = (b.joint ?? []).filter((j) => (j.type ?? 'hinge') === 'hinge');
  const free = (b.joint ?? []).find((j) => j.type === 'free');
  if (free) freeJoint = { name: free.name, body: b.name };
  assert(hinges.length <= 1, `body ${b.name} has ${hinges.length} hinges`);
  const visual = (b.geom ?? []).filter((g) => g.class === 'visual');
  assert(visual.length === 1, `body ${b.name} has ${visual.length} visual geoms`);
  for (const g of b.geom ?? []) for (const a of [...ROTATION_ATTRS, 'pos']) assert(g[a] === undefined, `geom ${g.name} has a ${a}`);
  const j = hinges[0];
  if (j) {
    assert(j.class === 'motor', `${j.name} is not class motor`);
    assert(vec(j.pos, 3).every((v) => v === 0), `${j.name} is not at its body origin`);
    joints.push(j.name);
  }
  const index = bodies.length;
  bodies.push({
    name: b.name,
    parent,
    pos: vec(b.pos, 3).map(r6),
    joint: j ? { name: j.name, axis: vec(j.axis, 3), range: vec(j.range, 2) } : null,
    inertial: { mass: +b.inertial.mass, pos: vec(b.inertial.pos, 3) },
    mesh: visual[0].mesh,
    rgba: vec(visual[0].rgba, 4),
    sites: (b.site ?? []).map((s) => ({ name: s.name, pos: vec(s.pos, 3) })),
    cameras: (b.camera ?? []).map((c) => ({
      name: c.name,
      pos: vec(c.pos, 3),
      quat: vec(c.quat, 4), // MuJoCo order (w x y z); the camera looks along its -z
      resolution: vec(c.resolution, 2),
      ...(c.sensorsize ? { sensorsize: vec(c.sensorsize, 2), focal: vec(c.focal, 2) } : {}),
      ...(c.fovy ? { fovy: +c.fovy } : {}),
    })),
  });
  for (const c of b.body ?? []) walk(c, index);
}
for (const b of xml.worldbody.body) walk(b, -1);
assert(freeJoint && freeJoint.body === bodies[0].name, 'the root body has no free joint');
assert(bodies.length === 41, `expected 41 bodies, found ${bodies.length}`);
assert(joints.length === 22, `expected 22 hinges, found ${joints.length}`);

// ── Standing pose and stance: contracts + constants.py ─────────────────────────────────────────────────
const CONSTANTS = 'tasks/jumper/common/constants.py';
const constants = text(CONSTANTS);
const loco = JSON.parse(text('out/bundle_example/jumper/locomotion.json'));
const clawContract = JSON.parse(text('out/bundle_example/jumper/claw_left.json'));

assert(JSON.stringify(loco.wire_joint_order) === JSON.stringify(joints), 'XML joint order differs from the contract wire order');
const homeBlock = constants.split('HOME: dict[str, float] = {')[1].split('}')[0];
const homePy = Object.fromEntries([...homeBlock.matchAll(/"(\w+_J\d_joint)": (-?[\d.]+)/g)].map((m) => [m[1], +m[2]]));
assert(Object.keys(homePy).length === 22, 'HOME in constants.py does not have 22 joints');
const home = joints.map((n) => {
  assert(close(homePy[n], loco.default_joint_pos[n], 1e-6), `HOME ${n}: constants ${homePy[n]} vs contract ${loco.default_joint_pos[n]}`);
  return homePy[n];
});
const standZ = +constants.match(/^STAND_Z = ([\d.]+)/m)[1];
assert(close(standZ, loco.base_height, 1e-9), 'STAND_Z differs between constants.py and the contract');
for (const n of joints) {
  const b = bodies.find((x) => x.joint?.name === n);
  const [lo, hi] = loco.joint_limits[n];
  assert(close(lo, b.joint.range[0], 1e-6) && close(hi, b.joint.range[1], 1e-6), `limits of ${n} differ between jumper.xml and the contract`);
  assert(homePy[n] >= lo && homePy[n] <= hi, `HOME ${n} is outside its limits`);
}
const legs = constants.match(/^LEGS: tuple\[str, \.\.\.\] = \(([^)]*)\)/m)[1].match(/"(\w+)"/g).map((s) => s.slice(1, -1));
assert(legs.join() === 'LF,RF,LM,RM,LR,RR', `unexpected LEGS ${legs}`);
const feetBlock = constants.split('FEET: tuple[str, ...] = (')[1].split(')')[0];
const feetBodies = [...feetBlock.matchAll(/"(\w+)"/g)].map((m) => m[1]);
assert(feetBodies.length === 6, 'FEET does not list six bodies');
const nominalBlock = constants.split('NOMINAL_FOOT_XY: tuple[tuple[float, float], ...] = (')[1].split('\n)')[0];
const nominalFootXY = Object.fromEntries([...nominalBlock.matchAll(/\((-?[\d.]+),\s*(-?[\d.]+)\),\s*#\s*(\w\w)/g)].map((m) => [m[3], [+m[1], +m[2]]]));
assert(Object.keys(nominalFootXY).join() === legs.join(), 'NOMINAL_FOOT_XY legs differ from LEGS');
const footSiteZ = +constants.match(/^FOOT_SITE_Z = ([\d.]+)/m)[1];
assert(constants.includes("the tripod gait's two groups: LF/RM/LR and RF/LM/RR"), 'tripod grouping comment moved');
const feet = legs.map((leg, i) => {
  const body = feetBodies[i];
  assert(body.startsWith(leg), `FEET[${i}] ${body} is not leg ${leg}`);
  const site = bodies.find((b) => b.name === body).sites.find((s) => s.name === leg);
  assert(site, `no site ${leg} on ${body}`);
  return { leg, body, site: leg };
});

// ── The claw: claw.py, the claw contract, the deploy hook ──────────────────────────────────────────────
const CLAW = 'tasks/jumper/five_foot/claw.py';
const claw = text(CLAW);
const gripperOpen = +claw.match(/^GRIPPER_OPEN = (-?[\d.]+)/m)[1];
const gripperClosed = +claw.match(/^GRIPPER_CLOSED = (-?[\d.]+)/m)[1];
const apertureBlock = claw.split('APERTURE_MM: tuple[tuple[float, float], ...] = (')[1].split('\n)')[0];
const apertureMm = [...apertureBlock.matchAll(/\((-?[\d.]+), ([\d.]+)\)/g)].map((m) => [+m[1], +m[2]]);
assert(apertureMm.length >= 10 && apertureMm[0][0] === gripperOpen && apertureMm.at(-1)[0] === gripperClosed, 'aperture table does not span GRIPPER_OPEN..GRIPPER_CLOSED');
const graspBlock = claw.split('LF_GRASP: dict[str, float] = {')[1].split('}')[0];
const stow = Object.fromEntries([...graspBlock.matchAll(/"(LF_J\d_joint)": (-?[\d.]+)/g)].map((m) => [m[1], +m[2]]));
stow.LF_J4_joint = gripperOpen; // `FINGER_JOINT: GRIPPER_OPEN` in LF_GRASP
for (const [n, v] of Object.entries(stow)) assert(close(v, clawContract.unactuated_joints[n], 1e-6), `stow ${n} differs between claw.py and claw_left.json`);
const HOOK = 'tasks/jumper/five_foot/deploy/lib.rs';
const hook = text(HOOK);
const presetsBlock = hook.split('const PRESETS: [[f32; 4]; 3] = [')[1].split('];')[0];
const presetRows = [...presetsBlock.matchAll(/\[(-?[\d.]+), (-?[\d.]+), (-?[\d.]+), (-?[\d.]+)\]/g)].map((m) => m.slice(1, 5).map(Number));
const controls = hook.match(/const ARM_CONTROLS: \[&str; 3\] = \[([^\]]*)\]/)[1].match(/"(\w+)"/g).map((s) => s.slice(1, -1));
assert(presetRows.length === 3 && controls.length === 3, 'arm presets not found');
const presetsDeg = Object.fromEntries(controls.map((c, i) => [c, presetRows[i]]));
const fingerReleasedDeg = +hook.match(/const FINGER_RELEASED_DEG: f32 = ([\d.]+);/)[1];
const fingerPosedDeg = +hook.match(/const FINGER_POSED_DEG: f32 = ([\d.]+);/)[1];
// Mirror of a left-arm angle onto the right arm, from HOME and the limits: J0, J2, J3, J4 flip sign, J1 does not.
const mirror = [-1, 1, -1, -1, -1];
for (let k = 0; k < 5; k++) {
  const l = bodies.find((b) => b.joint?.name === `LF_J${k}_joint`).joint.range;
  const r = bodies.find((b) => b.joint?.name === `RF_J${k}_joint`).joint.range;
  const m = mirror[k];
  const mapped = m > 0 ? l : [-l[1], -l[0]];
  assert(close(mapped[0], r[0], 1e-6) && close(mapped[1], r[1], 1e-6), `mirror rule fails on J${k}`);
}

// ── Meshes ──────────────────────────────────────────────────────────────────────────────────────────────
await MeshoptSimplifier.ready;
await MeshoptEncoder.ready;

function readSTL(file) {
  const buf = fs.readFileSync(file);
  const n = buf.readUInt32LE(80);
  assert(84 + n * 50 === buf.length, `${file} is not a binary STL`);
  const pos = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;
    for (let k = 0; k < 9; k++) pos[i * 9 + k] = buf.readFloatLE(o + k * 4);
  }
  return pos;
}

/** Area-weighted surface centroid and bounds of a triangle soup, in the link frame (m). */
function measure(pos) {
  const c = [0, 0, 0];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let area = 0;
  for (let i = 0; i < pos.length; i += 9) {
    const ax = pos[i + 3] - pos[i], ay = pos[i + 4] - pos[i + 1], az = pos[i + 5] - pos[i + 2];
    const bx = pos[i + 6] - pos[i], by = pos[i + 7] - pos[i + 1], bz = pos[i + 8] - pos[i + 2];
    const a = 0.5 * Math.hypot(ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx);
    area += a;
    for (let k = 0; k < 3; k++) {
      c[k] += (a * (pos[i + k] + pos[i + 3 + k] + pos[i + 6 + k])) / 3;
      for (const o of [0, 3, 6]) {
        min[k] = Math.min(min[k], pos[i + o + k]);
        max[k] = Math.max(max[k], pos[i + o + k]);
      }
    }
  }
  return { centroid: c.map((v) => r6(v / area)), min: min.map(r6), max: max.map(r6), area };
}

/** Welds a triangle soup at 1 µm. Triangle t of the soup is triangle t of the returned index. */
function weld(raw) {
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(raw, 3));
  g = mergeVertices(g, 1e-6);
  return { position: g.attributes.position.array, index: new Uint32Array(g.index.array) };
}
const stlOf = (body) => up(path.posix.join('assets/jumper', meshFile[bodies.find((b) => b.name === body).mesh]));

// ── The missing servo ───────────────────────────────────────────────────────────────────────────────────
// Upstream's right-middle calf has no servo body; the other three calves have one. Its mesh is otherwise the
// right-rear calf's, vertex for vertex (to 1 µm), so the right-rear calf's servo triangles are copied in unchanged.
// The copy is marked as added in the parts table.
const FILL = { body: 'RM_calf_link', from: 'RR_calf_link' };
const fill = (() => {
  const target = readSTL(stlOf(FILL.body));
  const donor = readSTL(stlOf(FILL.from));
  const t = weld(target);
  assert(!splitPieces(t.position, t.index).pieces.some(isServoPiece), `${FILL.body} has a servo upstream now: remove the fill`);
  const d = weld(donor);
  const { pieces, vertexPiece } = splitPieces(d.position, d.index);
  const servo = pieces.findIndex(isServoPiece);
  assert(servo >= 0 && pieces.filter(isServoPiece).length === 1, `${FILL.from} should hold exactly one servo`);
  // every target vertex must sit on a donor vertex (within 1 µm: a few differ in the last float bit)
  const cell = (v) => Math.round(v * 1e6);
  const donorVertices = new Set();
  for (let i = 0; i < donor.length; i += 3) donorVertices.add(`${cell(donor[i])},${cell(donor[i + 1])},${cell(donor[i + 2])}`);
  const near = (x, y, z) => {
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      if (donorVertices.has(`${cell(x) + a},${cell(y) + b},${cell(z) + c}`)) return true;
    }
    return false;
  };
  for (let i = 0; i < target.length; i += 3) assert(near(target[i], target[i + 1], target[i + 2]), `${FILL.body} is no longer the ${FILL.from} mesh without its servo`);
  const tris = [];
  for (let k = 0; k < d.index.length / 3; k++) if (vertexPiece[d.index[3 * k]] === servo) tris.push(k);
  assert(tris.length === SERVO.tris && donor.length / 9 - tris.length === target.length / 9, `${FILL.body} and ${FILL.from} differ by more than the servo`);
  const triangles = new Float32Array(tris.length * 9);
  tris.forEach((k, j) => triangles.set(donor.subarray(k * 9, k * 9 + 9), j * 9));
  return { ...FILL, triangles, piece: servo + 1, of: pieces.length };
})();

const doc = new Document();
const buffer = doc.createBuffer();
const scene = doc.createScene('jumper');
const meshes = [];
const partsOf = new Map(); // body -> { parts (in triangle order), pieces }
const tally = { pieces: 0, slivers: 0, parts: 0, servos: 0 };
let trisIn = 0;
let trisOut = 0;
for (const b of bodies) {
  const upstream = readSTL(stlOf(b.name));
  const source = upstream.length / 9;
  const m = measure(upstream);
  let raw = upstream;
  if (b.name === fill.body) {
    raw = new Float32Array(upstream.length + fill.triangles.length);
    raw.set(upstream);
    raw.set(fill.triangles, upstream.length);
  }
  const w = weld(raw);
  const { pieces, vertexPiece } = splitPieces(w.position, w.index, source);
  const { parts, partOfPiece } = nameParts(b, pieces);
  const s = summary(pieces.filter((p) => !p.added));
  for (const k of Object.keys(tally)) tally[k] += s[k];
  let index = w.index;
  if (source > KEEP_TRIS) {
    const target = Math.max(KEEP_TRIS * 3, Math.floor((index.length * RATIO) / 3) * 3);
    [index] = MeshoptSimplifier.simplify(index, w.position, 3, target, ERROR, ['LockBorder']);
  }
  // Every simplified triangle stays inside one part: the simplifier only collapses edges, and parts share none.
  const partOfVertex = (v) => partOfPiece[vertexPiece[v]];
  const kept = new Array(parts.length).fill(0);
  for (let t = 0; t < index.length; t += 3) {
    const p = partOfVertex(index[t]);
    assert(p === partOfVertex(index[t + 1]) && p === partOfVertex(index[t + 2]), `${b.name}: a triangle spans two parts`);
    kept[p]++;
  }
  parts.forEach((p, i) => assert(kept[i] >= 4, `${b.name}: ${p.name} lost its triangles in simplification`));
  // Drop vertices the simplifier left unreferenced.
  const all = w.position;
  const remap = new Int32Array(all.length / 3).fill(-1);
  const keep = [];
  for (const i of index) if (remap[i] < 0) { remap[i] = keep.length; keep.push(i); }
  const position = new Float32Array(keep.length * 3);
  keep.forEach((v, k) => position.set(all.subarray(v * 3, v * 3 + 3), k * 3));
  const indices = Uint32Array.from(index, (i) => remap[i]);
  const tag = Float32Array.from(keep, (v) => partOfVertex(v)); // each vertex's part; read and removed below
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(position).setBuffer(buffer))
    .setAttribute('_PART', doc.createAccessor().setType('SCALAR').setArray(tag).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer));
  scene.addChild(doc.createNode(b.name).setMesh(doc.createMesh(b.mesh).addPrimitive(prim)));
  partsOf.set(b.name, { parts, pieces });
  trisIn += source;
  trisOut += indices.length / 3;
  meshes.push({ name: b.mesh, body: b.name, file: meshFile[b.mesh], trisSource: source, ...(raw !== upstream ? { trisAdded: raw.length / 9 - source } : {}), tris: indices.length / 3, centroid: m.centroid, min: m.min, max: m.max });
}
assert(tally.servos === 21 && tally.parts === 91, `expected 91 parts with 21 servos upstream, found ${tally.parts} with ${tally.servos}`);
// The thighs and forearms share one bracket design: all six links' halves match in triangles, size and volume.
for (const half of ['lower half', 'upper half']) {
  const list = [...partsOf.values()].flatMap(({ parts }) => parts.filter((p) => p.kind === 'bracket' && p.name.endsWith(half)));
  const sig = (p) => [p.tris, p.volCm3.toFixed(3), [...p.sizeMm].sort((a, c) => a - c).map((v) => v.toFixed(1))].join();
  assert(list.length === 6 && new Set(list.map(sig)).size === 1, `the bracket ${half}s are not all one part`);
}

// Optimise for the GPU's vertex cache, then put each link's triangles in part order (keeping the cache order
// within a part), so the browser can draw any part on its own as one range of its link's index.
await doc.transform(prune(), reorder({ encoder: MeshoptEncoder }));
for (const node of doc.getRoot().listNodes()) {
  const prim = node.getMesh().listPrimitives()[0];
  const tag = prim.getAttribute('_PART');
  const acc = prim.getIndices();
  const idx = acc.getArray();
  const nT = idx.length / 3;
  const partOfTri = Int32Array.from({ length: nT }, (_, t) => tag.getScalar(idx[3 * t]));
  const order = Array.from({ length: nT }, (_, t) => t).sort((a, c) => partOfTri[a] - partOfTri[c] || a - c);
  const sorted = new idx.constructor(idx.length);
  order.forEach((t, k) => sorted.set(idx.subarray(3 * t, 3 * t + 3), 3 * k));
  // vertices in order of first use, so the vertex stream follows the new triangle order (it compresses better)
  const pos = prim.getAttribute('POSITION');
  const src = pos.getArray();
  const first = new Int32Array(pos.getCount()).fill(-1);
  let used = 0;
  for (const v of sorted) if (first[v] < 0) first[v] = used++;
  assert(used === pos.getCount(), `${node.getName()}: unused vertices after reorder`);
  const moved = new src.constructor(src.length);
  for (let v = 0; v < used; v++) moved.set(src.subarray(3 * v, 3 * v + 3), 3 * first[v]);
  pos.setArray(moved);
  for (let i = 0; i < sorted.length; i++) sorted[i] = first[sorted[i]];
  acc.setArray(sorted);
  const { parts } = partsOf.get(node.getName());
  let start = 0;
  parts.forEach((p, i) => {
    p.start = start;
    p.count = partOfTri.reduce((n, q) => n + (q === i ? 1 : 0), 0);
    start += p.count;
  });
  assert(start === nT, `${node.getName()}: the part ranges do not cover the mesh`);
  prim.setAttribute('_PART', null);
  tag.dispose();
}
await doc.transform(quantize({ quantizePosition: 14 }));
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
doc.createExtension(KHRMeshQuantization).setRequired(true);
doc.getRoot().getAsset().generator = 'jumper-lab tools/build-robot.mjs';
doc.getRoot().getAsset().copyright = `${lock.copyright} (${lock.license}); converted by jumper-lab`;
fs.mkdirSync(OUT, { recursive: true });
const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
await io.write(path.join(OUT, 'jumper.glb'), doc);

// ── robot.json ──────────────────────────────────────────────────────────────────────────────────────────
const r1 = (v) => +v.toFixed(1);
const parts = bodies.flatMap((b) => {
  const { parts: ps, pieces } = partsOf.get(b.name);
  // number the pieces as they are in the upstream file (the added servo is not one of them)
  let n = 0;
  const rank = pieces.map((p) => (p.added ? 0 : ++n));
  return ps.map((p) => ({
    body: b.name,
    name: p.name,
    kind: p.kind,
    basis: p.basis,
    ...(p.joint ? { joint: p.joint } : {}),
    ...(p.note ? { note: p.note } : {}),
    start: p.start,
    count: p.count,
    source: p.added
      ? { copiedFrom: fill.from, piece: fill.piece, of: fill.of, tris: p.tris }
      : { piece: rank[p.piece], of: n, tris: p.tris, ...(p.merged ? { slivers: p.merged } : {}) },
    sizeMm: p.sizeMm.map(r1),
    center: p.center.map(r6),
  }));
});
const used = [XML_PATH, CONSTANTS, CLAW, HOOK, 'out/bundle_example/jumper/locomotion.json', 'out/bundle_example/jumper/claw_left.json', ...meshes.map((m) => path.posix.join('assets/jumper', m.file))];
const robot = {
  schema: 'jumper-lab-robot/1',
  source: {
    repo: lock.repo,
    commit: lock.commit,
    license: lock.license,
    copyright: lock.copyright,
    retrieved: readLock().retrieved,
    files: used.map((p) => ({ path: p, sha256: lock.files.find((f) => f.path === p).sha256 })),
    note: 'Converted from upstream: STL to GLB (welded, simplified, quantised, normals rebuilt at load, triangles grouped by part, one servo copied into RM_calf_link), MJCF and Python/Rust constants transcribed to JSON. See NOTICE.md.',
  },
  frame: { units: 'm', forward: '+x', left: '+y', up: '+z' },
  freeJoint,
  joints,
  bodies,
  home,
  standZ,
  legs,
  feet,
  nominalFootXY,
  footSiteZ,
  tripodGroups: [['LF', 'RM', 'LR'], ['RF', 'LM', 'RR']],
  claw: {
    side: 'LF frame; mirror onto RF with `mirror` (per joint J0..J4)',
    mirror,
    gripperOpen,
    gripperClosed,
    apertureMm,
    stow: [0, 1, 2, 3, 4].map((k) => stow[`LF_J${k}_joint`]),
    presetsDeg,
    fingerReleasedDeg,
    fingerPosedDeg,
  },
  meshes,
  parts,
  partsSource: {
    method: 'Each link mesh is split into its connected pieces (triangles that share vertices, welded at 1 µm). Pieces under 0.01 cm³ or 2 mm are export leftovers and join the nearest part. Each part is one triangle range (start, count) of its link in jumper.glb; center and sizeMm are its source bounds in the link frame.',
    names: 'Ours, from each part’s shape and place: upstream names only the 41 links. Servos are identified by their shared geometry, each centred on its joint’s hinge axis.',
    upstream: { pieces: tally.pieces, slivers: tally.slivers, parts: tally.parts, servos: tally.servos },
    added: [{ body: fill.body, from: fill.from, why: `Upstream's ${fill.body} mesh has no servo body; the other three calves have one. Its mesh is otherwise the ${fill.from} mesh vertex for vertex (to 1 µm), so that calf's servo is copied in unchanged.` }],
  },
  massTotal: r6(bodies.reduce((s, b) => s + b.inertial.mass, 0)),
  citations: {
    tree: `${XML_PATH}`,
    home: `${CONSTANTS} (HOME, STAND_Z) = out/bundle_example/jumper/locomotion.json (default_joint_pos, base_height)`,
    stance: `${CONSTANTS} (LEGS, FEET, NOMINAL_FOOT_XY, FOOT_SITE_Z)`,
    tripod: `${CONSTANTS} (LEGS comment: "the tripod gait's two groups: LF/RM/LR and RF/LM/RR")`,
    claw: `${CLAW} (GRIPPER_OPEN, GRIPPER_CLOSED, APERTURE_MM, LF_GRASP) = out/bundle_example/jumper/claw_left.json (unactuated_joints)`,
    presets: `${HOOK} (PRESETS, ARM_CONTROLS, FINGER_RELEASED_DEG, FINGER_POSED_DEG)`,
  },
};
fs.writeFileSync(path.join(OUT, 'robot.json'), JSON.stringify(robot));
fs.copyFileSync(up('LICENSE'), path.join(OUT, 'LICENSE-jumper-apache-2.0.txt'));
fs.copyFileSync(up('NOTICE'), path.join(OUT, 'NOTICE-jumper.txt'));

const kb = (f) => (fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0) + ' KB';
console.log(`bodies ${bodies.length}, hinges ${joints.length}, mass ${robot.massTotal} kg, STAND_Z ${standZ}`);
console.log(`triangles ${trisIn} -> ${trisOut}`);
console.log(`parts: ${tally.pieces} pieces upstream = ${tally.parts} parts (${tally.servos} servos) + ${tally.slivers} slivers; + 1 servo added to ${fill.body}; ${parts.length} parts shipped`);
console.log(`jumper.glb ${kb('jumper.glb')}, robot.json ${kb('robot.json')}`);
