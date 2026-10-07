// "The Corner": a sunlit, floor-level apartment corner built from the course definition, so what the robot
// bumps into is exactly what is drawn. Model frame (Z up, metres). All geometry and textures are original.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { Course, Obstacle } from '../sim/course.ts';
import { blobShadow, boucleBump, knitBump, oakFloor, plasterBump, rugMap, terrazzo, weaveBump } from './textures.ts';

const srgb = (hex: string) => new THREE.Color(hex);

export interface Occluder {
  object: THREE.Object3D;
  shape: Obstacle['shape'];
  zMax: number;
  fade: number;
}

export interface Room {
  group: THREE.Group;
  /** Meshes near the robot that should cast dynamic shadows. */
  casters: THREE.Object3D[];
  stand: THREE.Group;
  dish: THREE.Group;
  window: THREE.Object3D;
  /** Tall furniture that fades out when it comes between the camera and the robot. */
  occluders: Occluder[];
}

/** Fade occluders standing between the camera and a target (both in the model frame). */
export function fadeOccluders(room: Room, eye: [number, number, number], target: [number, number, number], dt: number, distance: (s: Obstacle['shape'], p: [number, number]) => number): void {
  for (const o of room.occluders) {
    let hit = false;
    for (let k = 0; k <= 10 && !hit; k++) {
      const u = k / 10;
      const p: [number, number, number] = [eye[0] + (target[0] - eye[0]) * u, eye[1] + (target[1] - eye[1]) * u, eye[2] + (target[2] - eye[2]) * u];
      if (p[2] < o.zMax && distance(o.shape, [p[0], p[1]]) < 0.04) hit = true;
    }
    const want = hit ? 1 : 0;
    const before = o.fade;
    o.fade += (want - o.fade) * Math.min(1, dt * 6);
    if (Math.abs(before - o.fade) < 1e-4 && (o.fade === 0 || o.fade === 1)) continue;
    o.object.traverse((m) => {
      const mesh = m as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material as THREE.MeshStandardMaterial;
      mat.transparent = o.fade > 0.01;
      mat.opacity = 1 - 0.82 * o.fade;
      mat.depthWrite = o.fade < 0.5;
      mesh.castShadow = o.fade < 0.5 && mesh.userData.castShadow !== false;
    });
  }
}

function std(color: string, roughness = 0.8, extra: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: srgb(color), roughness, metalness: 0, ...extra });
}

/** A lathe profile [radius, height] around Z (LatheGeometry spins around Y, so rotate it up). */
function lathe(points: [number, number][], segments = 64): THREE.LatheGeometry {
  const g = new THREE.LatheGeometry(points.map(([r, z]) => new THREE.Vector2(r, z)), segments);
  g.rotateX(Math.PI / 2);
  return g;
}

function blob(group: THREE.Group, x: number, y: number, sx: number, sy: number, yaw = 0, opacity = 0.7): void {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: SHADOW, transparent: true, depthWrite: false, opacity }));
  m.position.set(x, y, 0.0042);
  m.scale.set(sx, sy, 1);
  m.rotation.z = yaw;
  m.renderOrder = 1;
  group.add(m);
}
let SHADOW: THREE.Texture;

export function buildRoom(course: Course): Room {
  SHADOW = blobShadow();
  const group = new THREE.Group();
  group.name = 'room';
  const casters: THREE.Object3D[] = [];
  const occluders: Occluder[] = [];
  const ob = (id: string) => course.obstacles.find((o) => o.id === id) as Obstacle;

  // Floor: pale oak boards, running front to back.
  const oak = oakFloor();
  const floorSize: [number, number] = [8, 7];
  oak.map.repeat.set(floorSize[1] / 0.56, floorSize[0] / 2.4);
  oak.rough.repeat.copy(oak.map.repeat);
  oak.map.rotation = oak.rough.rotation = Math.PI / 2;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(floorSize[0], floorSize[1]), new THREE.MeshStandardMaterial({ map: oak.map, roughnessMap: oak.rough, roughness: 1, color: '#ffffff' }));
  floor.position.set(0.4, 0.0, 0);
  floor.receiveShadow = true;
  group.add(floor);

  // Rug: cream boucle with a mint stripe. Its top sits 3 mm above the boards.
  const rugW = 3.05, rugD = 2.25;
  const rug = new THREE.Mesh(
    new RoundedBoxGeometry(rugW, rugD, 0.006, 2, 0.003),
    new THREE.MeshStandardMaterial({ map: rugMap(rugW, rugD), bumpMap: boucleBump(), bumpScale: 1.4, roughness: 0.97, color: '#ffffff' }),
  );
  (rug.material as THREE.MeshStandardMaterial).bumpMap!.repeat.set(rugW * 9, rugD * 9);
  rug.position.set(0.62, 0.02, 0.0);
  rug.receiveShadow = true;
  group.add(rug);

  // Walls with skirting and a big window in the back wall.
  const plaster = plasterBump();
  plaster.repeat.set(6, 3);
  // the walls face away from the window light; a little warm emissive stands in for bounce light off the floor
  const wallMat = new THREE.MeshStandardMaterial({ color: srgb('#f5eee4'), roughness: 0.95, bumpMap: plaster, bumpScale: 0.6, emissive: srgb('#6b5843'), emissiveIntensity: 0.32 });
  // Plane basis: local X along the wall, local Y up (+z), local Z the normal into the room.
  const facing = (x: THREE.Vector3, z: THREE.Vector3) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, new THREE.Vector3(0, 0, 1), z));
  const BACK = facing(new THREE.Vector3(0, -1, 0), new THREE.Vector3(-1, 0, 0));
  const LEFT = facing(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, -1, 0));
  const back = new THREE.Mesh(new THREE.PlaneGeometry(7, 2.6), wallMat);
  back.position.set(2.2, 0.2, 1.3);
  back.quaternion.copy(BACK);
  back.receiveShadow = true;
  group.add(back);
  const left = new THREE.Mesh(new THREE.PlaneGeometry(7, 2.6), wallMat);
  left.position.set(0.4, 1.2, 1.3);
  left.quaternion.copy(LEFT);
  left.receiveShadow = true;
  group.add(left);
  const skirtMat = std('#fbf8f2', 0.55);
  const skirtBack = new THREE.Mesh(new RoundedBoxGeometry(0.018, 7, 0.085, 2, 0.006), skirtMat);
  skirtBack.position.set(2.191, 0.2, 0.0425);
  const skirtLeft = new THREE.Mesh(new RoundedBoxGeometry(7, 0.018, 0.085, 2, 0.006), skirtMat);
  skirtLeft.position.set(0.4, 1.191, 0.0425);
  group.add(skirtBack, skirtLeft);

  // Window: a bright opening with a slim white frame (light source dressing; the sun light itself is in the stage).
  const win = new THREE.Group();
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(1.3, 1.45),
    new THREE.MeshBasicMaterial({ color: srgb('#fff6e4'), toneMapped: false }),
  );
  glow.quaternion.copy(BACK);
  glow.position.set(2.197, -0.35, 0.5 + 0.725);
  const frameMat = std('#fbfaf6', 0.4);
  const bars: [number, number, number, number, number, number][] = [
    [2.192, -0.35, 0.5, 0.04, 1.36, 0.035], [2.192, -0.35, 1.95, 0.04, 1.36, 0.035],
    [2.192, -1.01, 1.225, 0.04, 0.035, 1.48], [2.192, 0.31, 1.225, 0.04, 0.035, 1.48],
    [2.192, -0.35, 1.225, 0.03, 0.022, 1.45], [2.18, -0.35, 0.49, 0.07, 1.42, 0.03],
  ];
  for (const [x, y, z, sx, sy, sz] of bars) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), frameMat);
    b.position.set(x, y, z);
    win.add(b);
  }
  win.add(glow);
  group.add(win);

  // Sofa (oatmeal linen) along the left wall, behind the start.
  {
    const o = ob('sofa');
    const s = o.shape as Extract<Obstacle['shape'], { kind: 'box' }>;
    const linen = std('#d9cdb9', 0.95);
    const sofa = new THREE.Group();
    const base = new THREE.Mesh(new RoundedBoxGeometry(s.half[0] * 2, s.half[1] * 2, 0.2, 4, 0.04), linen);
    base.position.set(0, 0, 0.08 + 0.1);
    const seat = new THREE.Mesh(new RoundedBoxGeometry(s.half[0] * 2 - 0.04, s.half[1] * 2 - 0.06, 0.14, 4, 0.05), std('#e2d7c4', 0.97));
    seat.position.set(0, -0.02, 0.28 + 0.05);
    const backrest = new THREE.Mesh(new RoundedBoxGeometry(s.half[0] * 2, 0.16, 0.42, 4, 0.06), linen);
    backrest.position.set(0, s.half[1] - 0.06, 0.48);
    sofa.add(base, seat, backrest);
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) {
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.011, 0.08, 16), std('#6f4a2f', 0.5));
      leg.rotation.x = Math.PI / 2;
      leg.position.set(sx * (s.half[0] - 0.08), sy * (s.half[1] - 0.06), 0.04);
      sofa.add(leg);
    }
    sofa.position.set(s.c[0], s.c[1], 0);
    sofa.traverse((m) => {
      const mesh = m as THREE.Mesh;
      mesh.receiveShadow = true;
      if (mesh.isMesh) mesh.material = (mesh.material as THREE.Material).clone();
    });
    group.add(sofa);
    occluders.push({ object: sofa, shape: s, zMax: 0.72, fade: 0 });
    blob(group, s.c[0], s.c[1], s.half[0] * 2.3, s.half[1] * 2.6, 0, 0.5);
  }

  // Two stacked hardbacks with blank covers.
  {
    const o = ob('books');
    const s = o.shape as Extract<Obstacle['shape'], { kind: 'box' }>;
    const books = new THREE.Group();
    const pages = std('#f4ecdc', 0.9);
    const make = (w: number, d: number, h: number, cover: string, z: number, yaw: number, dx: number, dy: number) => {
      const b = new THREE.Group();
      const block = new THREE.Mesh(new RoundedBoxGeometry(w - 0.006, d - 0.01, h - 0.006, 2, 0.002), pages);
      const top = new THREE.Mesh(new RoundedBoxGeometry(w, d, 0.004, 2, 0.0015), std(cover, 0.62));
      top.position.z = h / 2 - 0.002;
      const bottom = top.clone();
      bottom.position.z = -h / 2 + 0.002;
      const spine = new THREE.Mesh(new RoundedBoxGeometry(w, 0.006, h, 2, 0.002), std(cover, 0.62));
      spine.position.y = -d / 2 + 0.003;
      b.add(block, top, bottom, spine);
      b.position.set(dx, dy, z + h / 2);
      b.rotation.z = yaw;
      books.add(b);
    };
    make(s.half[0] * 2, s.half[1] * 2, 0.036, '#8fa58a', 0, 0, 0, 0);
    make(s.half[0] * 2 - 0.02, s.half[1] * 2 - 0.012, 0.032, '#c97a54', 0.036, 0.12, 0.008, -0.004);
    books.position.set(s.c[0], s.c[1], 0);
    books.rotation.z = s.yaw;
    books.traverse((m) => { (m as THREE.Mesh).castShadow = true; (m as THREE.Mesh).receiveShadow = true; });
    casters.push(books);
    group.add(books);
    blob(group, s.c[0], s.c[1], s.half[0] * 2.6, s.half[1] * 2.8, s.yaw, 0.6);
  }

  // Speckled pot with a leafy plant.
  {
    const o = ob('plant');
    const s = o.shape as Extract<Obstacle['shape'], { kind: 'circle' }>;
    const plant = new THREE.Group();
    const potMap = terrazzo();
    potMap.repeat.set(2, 1);
    const pot = new THREE.Mesh(lathe([[0.0, 0], [s.r * 0.78, 0], [s.r * 0.82, 0.01], [s.r, 0.27], [s.r * 1.04, 0.29], [s.r * 0.95, 0.3], [s.r * 0.9, 0.285]]), new THREE.MeshStandardMaterial({ map: potMap, roughness: 0.75 }));
    const soil = new THREE.Mesh(new THREE.CircleGeometry(s.r * 0.88, 40), std('#4a3a2e', 1));
    soil.position.z = 0.27;
    plant.add(pot, soil);
    const leafShape = new THREE.Shape();
    leafShape.moveTo(0, 0);
    leafShape.bezierCurveTo(0.07, 0.05, 0.08, 0.17, 0, 0.24);
    leafShape.bezierCurveTo(-0.08, 0.17, -0.07, 0.05, 0, 0);
    const leafGeo = new THREE.ShapeGeometry(leafShape, 12);
    const leafMat = new THREE.MeshStandardMaterial({ color: srgb('#4f7d55'), roughness: 0.55, side: THREE.DoubleSide });
    const stemMat = std('#5d6b45', 0.8);
    const r = mulberry(5);
    for (let i = 0; i < 11; i++) {
      const a = (i / 11) * Math.PI * 2 + r() * 0.4;
      const h = 0.36 + r() * 0.42;
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.006, h - 0.25, 6), stemMat);
      stem.rotation.x = Math.PI / 2;
      const lean = 0.04 + r() * 0.06;
      stem.position.set(Math.cos(a) * lean * 0.5, Math.sin(a) * lean * 0.5, 0.25 + (h - 0.25) / 2);
      const leaf = new THREE.Mesh(leafGeo, leafMat.clone());
      (leaf.material as THREE.MeshStandardMaterial).color.offsetHSL((r() - 0.5) * 0.03, 0, (r() - 0.5) * 0.08);
      leaf.position.set(Math.cos(a) * lean, Math.sin(a) * lean, h);
      leaf.rotation.set(Math.PI / 2 - 0.5 - r() * 0.6, 0, a - Math.PI / 2, 'ZXY');
      leaf.scale.setScalar(0.8 + r() * 0.5);
      leaf.castShadow = true;
      plant.add(stem, leaf);
    }
    plant.position.set(s.c[0], s.c[1], 0);
    pot.castShadow = true;
    pot.receiveShadow = true;
    casters.push(pot);
    group.add(plant);
    occluders.push({ object: plant, shape: { kind: 'circle', c: s.c, r: 0.3 }, zMax: 0.85, fade: 0 });
    blob(group, s.c[0], s.c[1], s.r * 3, s.r * 3, 0, 0.7);
  }

  // Knit pouf.
  {
    const o = ob('pouf');
    const s = o.shape as Extract<Obstacle['shape'], { kind: 'circle' }>;
    const kb = knitBump();
    kb.repeat.set(10, 2);
    const pouf = new THREE.Mesh(
      lathe([[0, 0], [s.r * 0.86, 0], [s.r * 0.97, 0.02], [s.r, 0.07], [s.r * 0.97, 0.13], [s.r * 0.85, o.height], [0, o.height + 0.004]]),
      new THREE.MeshStandardMaterial({ color: srgb('#ece3d3'), roughness: 0.98, bumpMap: kb, bumpScale: 2.5 }),
    );
    pouf.position.set(s.c[0], s.c[1], 0);
    pouf.castShadow = true;
    pouf.receiveShadow = true;
    casters.push(pouf);
    group.add(pouf);
    blob(group, s.c[0], s.c[1], s.r * 2.6, s.r * 2.6, 0, 0.6);
  }

  // Birch ramp against the left wall (an edge feature, not climbed in this version).
  {
    const o = ob('ramp');
    const s = o.shape as Extract<Obstacle['shape'], { kind: 'box' }>;
    const prof = new THREE.Shape();
    const L = s.half[0] * 2, H = o.height;
    prof.moveTo(-L / 2, 0);
    prof.lineTo(L / 2 - 0.02, 0);
    prof.quadraticCurveTo(L / 2, 0, L / 2, 0.02);
    prof.lineTo(L / 2, H - 0.02);
    prof.quadraticCurveTo(L / 2, H, L / 2 - 0.03, H);
    prof.lineTo(-L / 2 + 0.06, 0.004);
    prof.lineTo(-L / 2, 0);
    const geo = new THREE.ExtrudeGeometry(prof, { depth: s.half[1] * 2, bevelEnabled: true, bevelSize: 0.006, bevelThickness: 0.006, bevelSegments: 3 });
    geo.translate(0, 0, -s.half[1]);
    geo.rotateX(Math.PI / 2);
    const ramp = new THREE.Mesh(geo, std('#e8d3b0', 0.6));
    ramp.position.set(s.c[0], s.c[1], 0);
    ramp.castShadow = true;
    ramp.receiveShadow = true;
    group.add(ramp);
    blob(group, s.c[0], s.c[1], L * 1.15, s.half[1] * 2.8, 0, 0.45);
  }

  // Woven basket with a folded throw.
  {
    const o = ob('basket');
    const s = o.shape as Extract<Obstacle['shape'], { kind: 'circle' }>;
    const wb = weaveBump();
    wb.repeat.set(9, 2);
    const basket = new THREE.Mesh(
      lathe([[0, 0], [s.r * 0.9, 0], [s.r, 0.02], [s.r * 1.05, o.height], [s.r * 0.98, o.height + 0.006], [s.r * 0.95, o.height - 0.01]]),
      new THREE.MeshStandardMaterial({ color: srgb('#c9a676'), roughness: 0.85, bumpMap: wb, bumpScale: 3, side: THREE.DoubleSide }),
    );
    const throwMesh = new THREE.Mesh(new RoundedBoxGeometry(s.r * 1.7, s.r * 1.3, 0.07, 4, 0.03), std('#8fbfae', 0.95));
    throwMesh.position.set(0.01, 0, o.height + 0.01);
    throwMesh.rotation.set(0.12, 0.08, 0.4);
    basket.add(throwMesh);
    basket.position.set(s.c[0], s.c[1], 0);
    basket.castShadow = true;
    group.add(basket);
    occluders.push({ object: basket, shape: s, zMax: o.height + 0.08, fade: 0 });
    blob(group, s.c[0], s.c[1], s.r * 2.7, s.r * 2.7, 0, 0.6);
  }

  // The snack stand: terrazzo foot, brass stem, a small cup the snack sits on.
  const stand = new THREE.Group();
  {
    const st = course.stand;
    const tz = terrazzo();
    tz.repeat.set(0.4, 0.4);
    const foot = new THREE.Mesh(lathe([[0, 0], [st.baseR, 0], [st.baseR, 0.006], [st.baseR * 0.85, 0.009], [0, 0.009]], 48), new THREE.MeshStandardMaterial({ map: tz, roughness: 0.45 }));
    const brass = new THREE.MeshStandardMaterial({ color: srgb('#c9a35f'), roughness: 0.28, metalness: 1 });
    const stem = new THREE.Mesh(lathe([[st.stemR * 1.6, 0.009], [st.stemR, 0.016], [st.stemR, st.topZ - 0.008], [st.topR, st.topZ - 0.002], [st.topR, st.topZ], [0, st.topZ]], 32), brass);
    stand.add(foot, stem);
    stand.position.set(st.c[0], st.c[1], 0);
    stand.traverse((m) => { (m as THREE.Mesh).castShadow = true; (m as THREE.Mesh).receiveShadow = true; });
    casters.push(stand);
    group.add(stand);
    blob(group, st.c[0], st.c[1], 0.11, 0.11, 0, 0.6);
  }

  // The delivery dish: mint glaze on a short terrazzo-and-brass stand.
  const dish = new THREE.Group();
  {
    const d = course.dish;
    const tz = terrazzo();
    tz.repeat.set(0.4, 0.4);
    const foot = new THREE.Mesh(lathe([[0, 0], [d.baseR, 0], [d.baseR, 0.006], [d.baseR * 0.8, 0.009], [0, 0.009]], 48), new THREE.MeshStandardMaterial({ map: tz, roughness: 0.45 }));
    const brass = new THREE.MeshStandardMaterial({ color: srgb('#c9a35f'), roughness: 0.28, metalness: 1 });
    const stem = new THREE.Mesh(lathe([[d.stemR * 1.5, 0.009], [d.stemR, 0.014], [d.stemR, d.floorZ - 0.012]], 32), brass);
    const glaze = new THREE.MeshPhysicalMaterial({ color: srgb('#8fd3bd'), roughness: 0.22, clearcoat: 0.9, clearcoatRoughness: 0.12 });
    const bowl = new THREE.Mesh(lathe([[0, d.floorZ - 0.012], [d.topR * 0.6, d.floorZ - 0.012], [d.topR * 0.95, d.rimZ - 0.01], [d.topR, d.rimZ], [d.innerR, d.rimZ], [d.innerR * 0.92, d.floorZ + 0.004], [0, d.floorZ]], 64), glaze);
    dish.add(foot, stem, bowl);
    dish.position.set(d.c[0], d.c[1], 0);
    dish.traverse((m) => { (m as THREE.Mesh).castShadow = true; (m as THREE.Mesh).receiveShadow = true; });
    casters.push(dish);
    group.add(dish);
    blob(group, d.c[0], d.c[1], 0.2, 0.2, 0, 0.55);
  }

  return { group, casters, stand, dish, window: win, occluders };
}

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
