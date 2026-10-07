// The snack (an original "oat cube" in a paper band, no brand) and the reach rings that light up when a
// claw can get to the snack or the dish.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { SnackState } from '../sim/snack.ts';

export class SnackMesh {
  readonly group = new THREE.Group();

  constructor(size: number) {
    const crumb = new THREE.MeshStandardMaterial({ color: new THREE.Color('#d6a463'), roughness: 0.92, bumpMap: oatBump(), bumpScale: 1.2 });
    const cube = new THREE.Mesh(new RoundedBoxGeometry(size, size, size, 3, size * 0.16), crumb);
    const band = new THREE.Mesh(
      new RoundedBoxGeometry(size * 1.02, size * 1.02, size * 0.42, 2, size * 0.05),
      new THREE.MeshStandardMaterial({ color: new THREE.Color('#f6f0e2'), roughness: 0.75 }),
    );
    const stripe = new THREE.Mesh(
      new RoundedBoxGeometry(size * 1.03, size * 1.03, size * 0.1, 2, size * 0.03),
      new THREE.MeshStandardMaterial({ color: new THREE.Color('#5fc4a6'), roughness: 0.6 }),
    );
    for (const m of [cube, band, stripe]) {
      m.castShadow = true;
      m.receiveShadow = true;
      this.group.add(m);
    }
    this.group.name = 'snack';
  }

  sync(s: SnackState): void {
    this.group.position.set(s.p[0], s.p[1], s.p[2]);
    this.group.quaternion.set(s.quat[1], s.quat[2], s.quat[3], s.quat[0]);
  }
}

function oatBump(): THREE.Texture {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgb(120,120,120)';
  g.fillRect(0, 0, S, S);
  for (let k = 0; k < 260; k++) {
    const v = Math.random() < 0.5 ? 220 : 40;
    g.fillStyle = `rgba(${v},${v},${v},0.5)`;
    g.beginPath();
    g.ellipse(Math.random() * S, Math.random() * S, 2 + Math.random() * 4, 1 + Math.random() * 2, Math.random() * 3, 0, Math.PI * 2);
    g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** A thin ring on the floor around a target; mint when a claw can reach it, pale when it cannot. */
export class ReachRing {
  readonly mesh: THREE.Mesh;
  private readonly mat: THREE.MeshBasicMaterial;
  private level = 0;
  private target = 0;

  constructor(radius: number) {
    this.mat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#5fc4a6'), transparent: true, opacity: 0, depthWrite: false, toneMapped: false });
    this.mesh = new THREE.Mesh(new THREE.RingGeometry(radius * 0.84, radius, 64), this.mat);
    this.mesh.position.z = 0.0046;
    this.mesh.renderOrder = 2;
  }

  /** state: 0 hidden, 1 nearby (pale), 2 reachable (mint). */
  set(state: 0 | 1 | 2): void {
    this.target = state;
  }

  update(dt: number, t: number): void {
    this.level += (this.target - this.level) * Math.min(1, dt * 8);
    const reach = Math.max(0, this.level - 1);
    const near = Math.min(1, this.level);
    this.mat.color.setRGB(0.37 + (1 - reach) * 0.55, 0.77 + (1 - reach) * 0.17, 0.65 + (1 - reach) * 0.25, THREE.SRGBColorSpace);
    this.mat.opacity = near * (0.35 + reach * (0.45 + 0.15 * Math.sin(t * 5)));
    this.mesh.visible = this.mat.opacity > 0.01;
  }
}
