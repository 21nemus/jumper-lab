// The parts inside each link mesh. KingKong exports one STL per moving link, so one file welds several real
// pieces together: shell halves, the servo that turns the link, pads and inserts. This module splits a welded
// link mesh into its connected pieces (triangles that share vertices), folds tiny zero-volume slivers (export
// leftovers) into the piece next to them, and names every piece.
//
// The names are ours, read from each piece's shape and place: upstream names only the 41 links. Each link must
// split exactly the way the tables below expect (piece count and triangle counts), otherwise the build stops,
// so a new upstream export cannot be labelled wrongly without anyone noticing.

/** The one servo body all 22 joints share, as published: 972 triangles, 10.57 cm³, 36.8 mm long. */
export const SERVO = { tris: 972, volCm3: 10.57, lengthMm: 36.8 };
const SLIVER_CM3 = 0.01; // a piece with less volume than this is a surface leftover, not a part
const SLIVER_MM = 2; // and so is anything smaller than this in every direction

const LEG_ROLES = ['hip swing', 'hip lift', 'knee'];
const ARM_ROLES = ['shoulder swing', 'arm roll', 'elbow', 'wrist', 'finger'];

function fail(msg) {
  throw new Error(`parts: ${msg}`);
}

/** Connected pieces of an indexed mesh (link frame, metres). Pieces are sorted by triangle count (largest
 *  first, ties by position); `vertexPiece` maps each vertex to its piece. A triangle whose index is at or past
 *  `addedFrom` was appended by this project; a piece made of such triangles is flagged `added`. */
export function splitPieces(position, index, addedFrom = Infinity) {
  const nV = position.length / 3;
  const nT = index.length / 3;
  const parent = new Int32Array(nV);
  for (let i = 0; i < nV; i++) parent[i] = i;
  const find = (a) => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  const unite = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[a] = b;
  };
  for (let t = 0; t < nT; t++) {
    unite(index[3 * t], index[3 * t + 1]);
    unite(index[3 * t], index[3 * t + 2]);
  }
  const byRoot = new Map();
  for (let t = 0; t < nT; t++) {
    const r = find(index[3 * t]);
    let p = byRoot.get(r);
    if (!p) byRoot.set(r, (p = { root: r, tris: 0, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], vol: 0, added: 0 }));
    p.tris++;
    if (t >= addedFrom) p.added++;
    const a = 3 * index[3 * t], b = 3 * index[3 * t + 1], c = 3 * index[3 * t + 2];
    for (const o of [a, b, c]) {
      for (let k = 0; k < 3; k++) {
        if (position[o + k] < p.min[k]) p.min[k] = position[o + k];
        if (position[o + k] > p.max[k]) p.max[k] = position[o + k];
      }
    }
    // signed volume by the divergence theorem (closed pieces); near zero for open surfaces
    p.vol += (position[a] * (position[b + 1] * position[c + 2] - position[b + 2] * position[c + 1])
      - position[a + 1] * (position[b] * position[c + 2] - position[b + 2] * position[c])
      + position[a + 2] * (position[b] * position[c + 1] - position[b + 1] * position[c])) / 6;
  }
  const pieces = [...byRoot.values()].map((p) => {
    if (p.added && p.added !== p.tris) fail('an added piece touches upstream geometry');
    return {
      root: p.root,
      tris: p.tris,
      center: p.min.map((v, k) => (v + p.max[k]) / 2),
      sizeMm: p.max.map((v, k) => (v - p.min[k]) * 1000),
      volCm3: p.vol * 1e6,
      added: p.added > 0,
    };
  });
  pieces.sort((a, b) => b.tris - a.tris || a.center[0] - b.center[0] || a.center[1] - b.center[1] || a.center[2] - b.center[2]);
  const pieceOfRoot = new Map(pieces.map((p, i) => [p.root, i]));
  const vertexPiece = new Int32Array(nV);
  for (let v = 0; v < nV; v++) vertexPiece[v] = pieceOfRoot.get(find(v));
  return { pieces, vertexPiece };
}

const isSliver = (p) => Math.abs(p.volCm3) < SLIVER_CM3 || Math.max(...p.sizeMm) < SLIVER_MM;
export const isServoPiece = (p) => p.tris === SERVO.tris && Math.abs(p.volCm3 - SERVO.volCm3) < 0.01;

/**
 * Turns one link's pieces into named parts. Returns the parts (in piece order) and, for every piece, the part it
 * belongs to (slivers join the nearest part).
 *
 * `body` is a jumper.xml body ({ name, joint, rgba }); servos are checked against its hinge: each one must lie on
 * the joint's axis, centred within 3 mm of the joint, with its 36.8 mm length along the axis.
 */
export function nameParts(body, pieces) {
  const real = [];
  const partOfPiece = new Int32Array(pieces.length).fill(-1);
  pieces.forEach((p, i) => {
    if (!isSliver(p)) {
      partOfPiece[i] = real.length;
      real.push({ ...p, piece: i, merged: 0 });
    }
  });
  if (!real.length) fail(`${body.name} has no parts`);
  pieces.forEach((p, i) => {
    if (partOfPiece[i] >= 0) return;
    let best = 0, bestD = Infinity;
    real.forEach((r, k) => {
      const d = Math.hypot(r.center[0] - p.center[0], r.center[1] - p.center[1], r.center[2] - p.center[2]);
      if (d < bestD) { bestD = d; best = k; }
    });
    partOfPiece[i] = best;
    real[best].merged++;
  });

  const type = body.name.replace(/^(LF|RF|LM|RM|LR|RR)_/, '').replace(/_link$/, '');
  const arm = /^(LF|RF)_/.test(body.name);
  const servos = real.filter(isServoPiece);
  const rest = real.filter((p) => !isServoPiece(p));
  const set = (p, name, kind, basis = 'shape', note) => Object.assign(p, { name, kind, basis, ...(note ? { note } : {}) });
  const expect = (want) => {
    const got = rest.map((p) => p.tris).sort((a, b) => b - a);
    const exp = [...want].sort((a, b) => b - a);
    if (got.join() !== exp.join()) fail(`${body.name} splits into [${got}] besides its servo, expected [${exp}]`);
  };
  const byAxis = (k) => [...rest].sort((a, b) => a.center[k] - b.center[k]);

  // the servo: one per hinged link, on its hinge axis (or none, where upstream left it out)
  if (servos.length > 1) fail(`${body.name} has ${servos.length} servo bodies`);
  if (servos.length && !body.joint) fail(`${body.name} has a servo but no joint`);
  for (const s of servos) {
    const k = +body.joint.name.match(/_J(\d)_/)[1];
    const role = (arm ? ARM_ROLES : LEG_ROLES)[k];
    const a = body.joint.axis;
    const along = s.center[0] * a[0] + s.center[1] * a[1] + s.center[2] * a[2];
    const off = Math.hypot(s.center[0] - along * a[0], s.center[1] - along * a[1], s.center[2] - along * a[2]);
    const lengthMm = Math.abs(s.sizeMm[0] * a[0]) + Math.abs(s.sizeMm[1] * a[1]) + Math.abs(s.sizeMm[2] * a[2]);
    if (off > 5e-4 || Math.abs(along) > 3e-3 || Math.abs(lengthMm - SERVO.lengthMm) > 0.1) {
      fail(`${body.name}: the servo is not on the ${body.joint.name} axis (off ${(off * 1000).toFixed(2)} mm, along ${(along * 1000).toFixed(2)} mm, length ${lengthMm.toFixed(1)} mm)`);
    }
    set(s, `${role[0].toUpperCase()}${role.slice(1)} servo`, 'servo', s.added ? 'added' : 'servo');
    s.joint = body.joint.name;
  }

  switch (type) {
    case 'hip':
      expect([12196]);
      set(rest[0], 'Hip shell', 'shell');
      break;
    case 'thigh':
    case 'forearm': {
      expect([4962, 3076]);
      const T = type === 'thigh' ? 'Thigh' : 'Forearm';
      const [lower, upper] = byAxis(2);
      const same = 'All four thighs and both forearms use this same bracket: their meshes match in triangles, size and volume.';
      set(lower, `${T} bracket, lower half`, 'bracket', 'shape', same);
      set(upper, `${T} bracket, upper half`, 'bracket', 'shape', same);
      break;
    }
    case 'calf':
      expect([13366]);
      set(rest[0], 'Calf shell', 'shell');
      break;
    case 'shoulder': {
      expect([7508, 6594]);
      const [rear, front] = byAxis(0);
      set(rear, 'Shoulder shell, rear half', 'shell');
      set(front, 'Shoulder shell, front half', 'shell');
      break;
    }
    case 'upper_arm': {
      expect([5822, 5316]);
      const [lower, upper] = byAxis(2);
      set(lower, 'Upper-arm shell, lower half', 'shell');
      set(upper, 'Upper-arm shell, upper half', 'shell');
      break;
    }
    case 'palm':
      expect([14108]);
      set(rest[0], 'Palm shell', 'shell', 'shape', 'The fixed jaw of the claw, and the foot it walks on.');
      break;
    case 'finger': {
      expect([3750, 2672, 768]);
      const t = (n) => rest.find((p) => p.tris === n);
      set(t(3750), 'Finger frame', 'shell', 'shape', 'The moving jaw of the claw: the finger servo (J4) swings it.');
      set(t(2672), 'Finger cover', 'shell');
      set(t(768), 'Servo mount ring', 'mount', 'shape', 'A ring with four screw holes at the finger’s hinge. Upstream does not label it; the name describes its shape.');
      break;
    }
    case 'foot_tip':
    case 'palm_pad_b':
    case 'palm_pad_f':
    case 'palm_grip_insert':
    case 'finger_grip_insert':
    case 'finger_tip': {
      if (rest.length !== 1) fail(`${body.name} should be one piece, found ${rest.length}`);
      const names = { foot_tip: 'Foot tip', palm_pad_b: 'Palm pad (b)', palm_pad_f: 'Palm pad (f)', palm_grip_insert: 'Palm grip insert', finger_grip_insert: 'Finger grip insert', finger_tip: 'Fingertip' };
      set(rest[0], names[type], 'pad', 'link');
      break;
    }
    case 'upper_shell':
    case 'display_module':
    case 'tof_sensor':
    case 'camera': {
      if (rest.length !== 1) fail(`${body.name} should be one piece, found ${rest.length}`);
      const names = { upper_shell: ['Upper shell', 'shell'], display_module: ['Display module', 'module'], tof_sensor: ['Depth sensor', 'module'], camera: ['Camera module', 'module'] };
      set(rest[0], ...names[type], 'link');
      break;
    }
    case 'base': {
      expect([35248, 12908, 5990, 4040, 2832, 2248, 2134, 1394, 1110, 1110, 896, 280, 36, 36, 12, 12]);
      const t = (n) => rest.filter((p) => p.tris === n);
      const unlabelled = 'Upstream does not label it; the name describes its shape.';
      set(t(35248)[0], 'Chassis frame', 'chassis');
      set(t(12908)[0], 'Mounting plate', 'chassis');
      set(t(5990)[0], 'Front tray', 'chassis');
      set(t(4040)[0], 'Long box', 'chassis', 'shape', 'A closed box under the shell. Upstream does not say what it holds.');
      set(t(2832)[0], 'Rear bracket', 'chassis');
      set(t(2248)[0], 'Multi-pin connector', 'electronics', 'shape', unlabelled);
      set(t(2134)[0], 'Push button', 'electronics', 'shape', unlabelled);
      set(t(1394)[0], 'Small connector', 'electronics', 'shape', unlabelled);
      const [left, right] = t(1110).sort((a, b) => b.center[1] - a.center[1]);
      set(left, 'Rear corner bracket, left', 'chassis');
      set(right, 'Rear corner bracket, right', 'chassis');
      set(t(896)[0], 'Rear board', 'electronics', 'shape', '1.6 mm thick, the usual thickness of a circuit board. Upstream does not label it.');
      set(t(280)[0], 'Small pin', 'electronics', 'shape', unlabelled);
      [...t(36), ...t(12)].sort((a, b) => b.center[1] - a.center[1]).forEach((p, i) => set(p, `Front corner piece ${i + 1}`, 'chassis'));
      break;
    }
    default:
      fail(`no part names for ${body.name}`);
  }
  for (const p of real) if (!p.name) fail(`${body.name}: piece ${p.piece} has no name`);
  if (new Set(real.map((p) => p.name)).size !== real.length) fail(`${body.name}: two parts share a name`);
  return { parts: real, partOfPiece };
}

/** The pieces a link's STL holds, before and after slivers are folded in, for the report. */
export function summary(pieces) {
  const slivers = pieces.filter(isSliver).length;
  return { pieces: pieces.length, slivers, parts: pieces.length - slivers, servos: pieces.filter((p) => !isSliver(p) && isServoPiece(p)).length };
}
