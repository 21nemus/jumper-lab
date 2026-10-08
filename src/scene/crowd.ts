// The crab-rave crowd on screen: low-poly Jumpers (jumper-crowd.glb, about 8k triangles each) drawn as one
// instanced mesh per link, so twenty of them cost about what the full-detail hero does. Posed with the same
// forward kinematics as the hero; shells in a few colours; little happy eyes; soft blob shadows instead of a
// second shadow pass. Render-only. Also the party lights: three soft coloured lights that circle the dance
// floor and breathe with the beat (no strobing; still under reduced motion).

import * as THREE from 'three';
import type { RobotModel } from '../robot/model.ts';
import { forward } from '../robot/kinematics.ts';
import { finishOf, type Finish } from '../robot/materials.ts';
import { loadLinkGeometries } from '../robot/loader.ts';
import { MAX_DANCERS, type DancerPose } from '../sim/rave.ts';
import type { Vec3 } from '../sim/math.ts';
import { blobShadow } from './textures.ts';
import type { Stage } from './stage.ts';

const srgb = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

/** A happy squint (^ ^) on the round display, drawn once. */
function happyEyes(): THREE.Texture {
  const S = 64;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.strokeStyle = '#bff5e3';
  g.lineWidth = 9;
  g.lineCap = 'round';
  g.beginPath();
  g.arc(S / 2, S * 0.62, S * 0.24, Math.PI * 1.15, Math.PI * 1.85);
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Crowd {
  readonly group = new THREE.Group();
  ready = false;
  private links: { mesh: THREE.InstancedMesh; body: number; shell: boolean }[] = [];
  private eyes: THREE.InstancedMesh | null = null;
  private eyeLocal: THREE.Matrix4[] = [];
  private display = -1;
  private readonly shadows: THREE.InstancedMesh;
  private readonly model: RobotModel;
  private readonly m = new THREE.Matrix4();
  private readonly m2 = new THREE.Matrix4();
  private readonly color = new THREE.Color();

  constructor(model: RobotModel) {
    this.model = model;
    this.group.name = 'rave-crowd';
    this.shadows = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(0.5, 0.5),
      new THREE.MeshBasicMaterial({ map: blobShadow(), transparent: true, depthWrite: false, opacity: 0.55 }),
      MAX_DANCERS,
    );
    this.shadows.count = 0;
    this.shadows.frustumCulled = false;
    this.shadows.renderOrder = 1;
    this.group.add(this.shadows);
  }

  async load(url: string): Promise<void> {
    const geos = await loadLinkGeometries(url);
    const mats: Record<Finish, THREE.Material> = {
      // white, so each dancer's instance colour is its shell colour
      red: new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.36, clearcoat: 0.7, clearcoatRoughness: 0.2 }),
      grey: new THREE.MeshStandardMaterial({ color: srgb(0.68, 0.7, 0.72), roughness: 0.4, metalness: 0.4 }),
      silicone: new THREE.MeshStandardMaterial({ color: srgb(0.816, 0.82, 0.804), roughness: 0.82 }),
      black: new THREE.MeshStandardMaterial({ color: srgb(0.035, 0.036, 0.04), roughness: 0.5, metalness: 0.1 }),
    };
    this.model.json.bodies.forEach((b, i) => {
      const g = geos.get(b.name);
      if (!g) return;
      const finish = finishOf(b.rgba);
      const mesh = new THREE.InstancedMesh(g, mats[finish], MAX_DANCERS);
      mesh.count = 0;
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      if (finish === 'red') for (let k = 0; k < MAX_DANCERS; k++) mesh.setColorAt(k, this.color.set(0xffffff));
      this.group.add(mesh);
      this.links.push({ mesh, body: i, shell: finish === 'red' });
    });
    // two happy eyes on each dancer's display, placed like the hero's (src/robot/eyes.ts)
    this.display = this.model.body('display_module_link');
    const normal = new THREE.Vector3(0.855, 0, 0.519);
    for (const side of [1, -1]) {
      const o = new THREE.Object3D();
      o.position.set(0.0104, side * 0.024, -0.0012).addScaledVector(normal, 0.0007);
      o.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
      o.rotateZ(Math.PI / 2);
      o.updateMatrix();
      this.eyeLocal.push(o.matrix.clone());
    }
    this.eyes = new THREE.InstancedMesh(
      new THREE.CircleGeometry(0.0106, 20),
      new THREE.MeshBasicMaterial({ map: happyEyes(), transparent: true, toneMapped: false, depthWrite: false }),
      MAX_DANCERS * 2,
    );
    this.eyes.count = 0;
    this.eyes.frustumCulled = false;
    this.eyes.renderOrder = 3;
    this.group.add(this.eyes);
    this.ready = true;
  }

  /** Draw these dancers this frame (an empty list hides the crowd). */
  show(dancers: { pose: DancerPose; shell: [number, number, number] }[]): void {
    const n = this.ready ? Math.min(dancers.length, MAX_DANCERS) : 0;
    for (const l of this.links) l.mesh.count = n;
    if (this.eyes) this.eyes.count = n * 2;
    this.shadows.count = n;
    for (let k = 0; k < n; k++) {
      const { pose, shell } = dancers[k];
      const f = forward(this.model, { pos: pose.pos, quat: pose.quat }, pose.q);
      const tint = this.color.setRGB(shell[0], shell[1], shell[2], THREE.SRGBColorSpace);
      for (const l of this.links) {
        const p = f.p[l.body], R = f.R[l.body];
        this.m.set(R[0], R[1], R[2], p[0], R[3], R[4], R[5], p[1], R[6], R[7], R[8], p[2], 0, 0, 0, 1);
        l.mesh.setMatrixAt(k, this.m);
        if (l.shell) l.mesh.setColorAt(k, tint);
      }
      if (this.eyes) {
        const p = f.p[this.display], R = f.R[this.display];
        this.m.set(R[0], R[1], R[2], p[0], R[3], R[4], R[5], p[1], R[6], R[7], R[8], p[2], 0, 0, 0, 1);
        for (let e = 0; e < 2; e++) this.eyes.setMatrixAt(k * 2 + e, this.m2.multiplyMatrices(this.m, this.eyeLocal[e]));
      }
      this.m.makeTranslation(pose.pos[0], pose.pos[1], 0.0045);
      this.shadows.setMatrixAt(k, this.m);
    }
    for (const l of this.links) {
      l.mesh.instanceMatrix.needsUpdate = true;
      if (l.mesh.instanceColor) l.mesh.instanceColor.needsUpdate = true;
    }
    if (this.eyes) this.eyes.instanceMatrix.needsUpdate = true;
    this.shadows.instanceMatrix.needsUpdate = true;
  }
}

/** Three soft coloured lights over the dance floor. Created at start-up (dark) so turning them on never makes
 *  the renderer recompile its shaders mid-party. */
export class PartyLights {
  private readonly lights: THREE.PointLight[] = [];
  private readonly sun: number;
  private readonly hemi: number;
  private level = 0;
  private readonly stage: Stage;

  constructor(stage: Stage) {
    this.stage = stage;
    for (const c of ['#5fc4a6', '#ff7a59', '#8f7cff']) {
      const l = new THREE.PointLight(c, 0, 3.2, 2);
      l.castShadow = false;
      stage.world.add(l);
      this.lights.push(l);
    }
    this.sun = stage.sun.intensity;
    this.hemi = stage.hemi.intensity;
  }

  /** Ease towards on/off; `beat` drives a slow circle and a gentle swell on each beat. */
  update(dt: number, on: boolean, beat: number, centre: Vec3): void {
    this.level += ((on ? 1 : 0) - this.level) * Math.min(1, dt * 1.2);
    if (this.level < 0.001 && !on) this.level = 0;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.lights.forEach((l, i) => {
      const a = (still ? 0 : (beat * Math.PI) / 16) + (i * 2 * Math.PI) / 3;
      l.position.set(centre[0] + Math.cos(a) * 1.0, centre[1] + Math.sin(a) * 1.0, 0.75);
      const swell = still ? 1 : 0.88 + 0.12 * Math.cos(2 * Math.PI * beat);
      l.intensity = 1.8 * this.level * swell;
    });
    // the room dims a little so the colours read
    this.stage.sun.intensity = this.sun * (1 - 0.35 * this.level);
    this.stage.hemi.intensity = this.hemi * (1 - 0.3 * this.level);
  }
}
