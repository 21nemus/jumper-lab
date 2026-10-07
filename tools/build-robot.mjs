// Builds the robot's web assets from the pinned upstream sources (run `npm run upstream:fetch` first).
//
//   node tools/build-robot.mjs
//
// Writes public/assets/robot/:
//   jumper.glb     one node per link, welded + simplified, positions + indices only (normals are rebuilt in
//                  the browser), 14-bit quantised, meshopt-compressed. Vertices stay in each link's own frame.
//   robot.json     the kinematic tree of jumper.xml (bodies, hinge axes, limits, inertials, colours, sites,
//                  cameras), the calibrated standing pose, the stance footprint and the claw's documented
//                  poses, each with the upstream file it was read from.
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

const doc = new Document();
const buffer = doc.createBuffer();
const scene = doc.createScene('jumper');
const meshes = [];
let trisIn = 0;
let trisOut = 0;
for (const b of bodies) {
  const file = up(path.posix.join('assets/jumper', meshFile[b.mesh]));
  const raw = readSTL(file);
  const m = measure(raw);
  let g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(raw, 3));
  g = mergeVertices(g, 1e-6);
  let index = new Uint32Array(g.index.array);
  const source = raw.length / 9;
  if (source > KEEP_TRIS) {
    const target = Math.max(KEEP_TRIS * 3, Math.floor((index.length * RATIO) / 3) * 3);
    [index] = MeshoptSimplifier.simplify(index, g.attributes.position.array, 3, target, ERROR, ['LockBorder']);
  }
  // Drop vertices the simplifier left unreferenced.
  const all = g.attributes.position.array;
  const remap = new Int32Array(all.length / 3).fill(-1);
  const keep = [];
  for (const i of index) if (remap[i] < 0) { remap[i] = keep.length; keep.push(i); }
  const position = new Float32Array(keep.length * 3);
  keep.forEach((v, k) => position.set(all.subarray(v * 3, v * 3 + 3), k * 3));
  const indices = Uint32Array.from(index, (i) => remap[i]);
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(position).setBuffer(buffer))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(indices).setBuffer(buffer));
  scene.addChild(doc.createNode(b.name).setMesh(doc.createMesh(b.mesh).addPrimitive(prim)));
  trisIn += source;
  trisOut += indices.length / 3;
  meshes.push({ name: b.mesh, body: b.name, file: meshFile[b.mesh], trisSource: source, tris: indices.length / 3, centroid: m.centroid, min: m.min, max: m.max });
}

await doc.transform(prune(), reorder({ encoder: MeshoptEncoder }), quantize({ quantizePosition: 14 }));
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
doc.createExtension(KHRMeshQuantization).setRequired(true);
doc.getRoot().getAsset().generator = 'jumper-lab tools/build-robot.mjs';
doc.getRoot().getAsset().copyright = `${lock.copyright} (${lock.license}); converted by jumper-lab`;
fs.mkdirSync(OUT, { recursive: true });
const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization]).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
await io.write(path.join(OUT, 'jumper.glb'), doc);

// ── robot.json ──────────────────────────────────────────────────────────────────────────────────────────
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
    note: 'Converted from upstream: STL to GLB (welded, simplified, quantised, normals rebuilt at load), MJCF and Python/Rust constants transcribed to JSON. See NOTICE.md.',
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
console.log(`jumper.glb ${kb('jumper.glb')}, robot.json ${kb('robot.json')}`);
