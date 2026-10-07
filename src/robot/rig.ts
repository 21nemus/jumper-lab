// The rendered robot: one THREE.Group per link, nested like jumper.xml. A link's group sits at the body's
// `pos` in its parent and turns about its hinge axis; the link mesh is in the link's own frame. The rig only
// ever displays a pose handed to it — it holds no simulation state of its own.

import * as THREE from 'three';
import type { BasePose } from './kinematics.ts';
import type { RobotModel } from './model.ts';
import { finishOf, RobotMaterials, type Finish } from './materials.ts';

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
  }
}
