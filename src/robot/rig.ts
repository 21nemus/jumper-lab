// The rendered robot: one THREE.Group per link, nested like jumper.xml. A link's group sits at the body's
// `pos` in its parent and turns about its hinge axis; the link mesh is in the link's own frame. The rig only
// ever displays a pose handed to it — it holds no simulation state of its own.
//
// For Build, the rig can also draw the robot as its separate parts: one mesh per part, each a triangle range
// of its link's geometry (the GLB stores every link's triangles grouped by part), so no buffer is copied.

import * as THREE from 'three';
import type { BasePose } from './kinematics.ts';
import type { RobotModel } from './model.ts';
import { finishOf, RobotMaterials, type Finish, type PartFinish } from './materials.ts';

export class RobotRig {
  readonly model: RobotModel;
  readonly root = new THREE.Group();
  readonly links: THREE.Group[] = [];
  readonly meshes: THREE.Mesh[] = [];
  readonly finishes: Finish[] = [];
  readonly materials: RobotMaterials;
  private readonly axes: THREE.Vector3[] = [];

  constructor(model: RobotModel, geometries: Map<string, THREE.BufferGeometry>, materials = new RobotMaterials()) {
    this.model = model;
    this.materials = materials;
    this.root.name = 'jumper';
    model.json.bodies.forEach((b, i) => {
      const link = new THREE.Group();
      link.name = b.name;
      link.position.set(b.pos[0], b.pos[1], b.pos[2]);
      link.userData.body = i;
      const finish = finishOf(b.rgba);
      const mesh = new THREE.Mesh(geometries.get(b.name)!, materials.get(finish));
      mesh.name = `${b.name}_mesh`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.body = i;
      link.add(mesh);
      (b.parent >= 0 ? this.links[b.parent] : this.root).add(link);
      this.links.push(link);
      this.meshes.push(mesh);
      this.finishes.push(finish);
      this.axes.push(b.joint ? new THREE.Vector3(...b.joint.axis) : new THREE.Vector3());
    });
  }

  /** Display a base pose (world, model axes) and a joint vector (wire order). */
  setPose(base: BasePose, q: ArrayLike<number>): void {
    this.root.position.set(base.pos[0], base.pos[1], base.pos[2]);
    this.root.quaternion.set(base.quat[1], base.quat[2], base.quat[3], base.quat[0]);
    for (let i = 0; i < this.links.length; i++) {
      const j = this.model.bodyJoint[i];
      if (j >= 0) this.links[i].quaternion.setFromAxisAngle(this.axes[i], q[j]);
    }
  }

  setShadows(cast: boolean): void {
    for (const m of this.meshes) m.castShadow = cast;
    for (const m of this.partMeshes ?? []) m.castShadow = cast;
  }

  private partMeshes: THREE.Mesh[] | null = null;

  /** One mesh per entry of robot.json `parts`, in that order, each a child of its link (made on first use). */
  parts(): THREE.Mesh[] {
    if (this.partMeshes) return this.partMeshes;
    this.partMeshes = this.model.json.parts.map((p, k) => {
      const i = this.model.body(p.body);
      const src = this.meshes[i].geometry;
      // shares the link's attributes and index: never dispose these geometries on their own
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', src.getAttribute('position'));
      g.setAttribute('normal', src.getAttribute('normal'));
      g.setIndex(src.getIndex());
      g.setDrawRange(p.start * 3, p.count * 3);
      const half = new THREE.Vector3(...p.sizeMm).multiplyScalar(0.0005 * 1.02);
      const c = new THREE.Vector3(...p.center);
      g.boundingBox = new THREE.Box3(c.clone().sub(half), c.clone().add(half));
      g.boundingSphere = new THREE.Sphere(c, half.length());
      const mesh = new THREE.Mesh(g, this.materials.get(this.partFinish(k)));
      mesh.name = `${p.body}:${p.name}`;
      mesh.castShadow = this.meshes[i].castShadow;
      mesh.receiveShadow = true;
      mesh.visible = false;
      mesh.userData.part = k;
      mesh.userData.body = i;
      this.links[i].add(mesh);
      return mesh;
    });
    return this.partMeshes;
  }

  partFinish(k: number): PartFinish {
    const p = this.model.json.parts[k];
    return p.kind === 'servo' ? 'servo' : this.finishes[this.model.body(p.body)];
  }

  /** Draw the robot as its separate parts (Build) or as one mesh per link (everywhere else). */
  showParts(on: boolean): void {
    if (!on && !this.partMeshes) return;
    for (const m of this.meshes) m.visible = !on;
    for (const m of this.parts()) {
      m.visible = on;
      m.position.set(0, 0, 0);
    }
  }
}
