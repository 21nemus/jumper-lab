// Renderer, camera, light and the frame bridge. The simulation and the robot use the model's frame (Z up,
// X forward, Y left, metres); everything in it hangs under `world`, which rotates that frame into three.js's
// Y-up frame: model (x, y, z) -> three (x, z, -y).

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import type { Vec3 } from '../sim/math.ts';

export const toThree = (v: Vec3, out = new THREE.Vector3()): THREE.Vector3 => out.set(v[0], v[2], -v[1]);
export const fromThree = (v: THREE.Vector3): Vec3 => [v.x, -v.z, v.y];

export interface StageOptions {
  canvas: HTMLCanvasElement;
  background: THREE.ColorRepresentation;
  shadowMapSize?: number;
  antialias?: boolean;
}

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly world = new THREE.Group();
  readonly camera = new THREE.PerspectiveCamera(38, 1, 0.01, 60);
  readonly sun: THREE.DirectionalLight;
  readonly fill: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  private envTarget: THREE.WebGLRenderTarget | null = null;
  pixelRatioCap = 2;

  constructor(opts: StageOptions) {
    this.renderer = new THREE.WebGLRenderer({ canvas: opts.canvas, antialias: opts.antialias ?? true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.background = new THREE.Color(opts.background);
    this.world.rotation.x = -Math.PI / 2;
    this.scene.add(this.world);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTarget = pmrem.fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = this.envTarget.texture;
    this.scene.environmentIntensity = 0.38;
    pmrem.dispose();

    this.hemi = new THREE.HemisphereLight(0xfff4e4, 0xb89b78, 0.5);
    this.scene.add(this.hemi);
    // a soft, shadowless fill from the viewer's side keeps the robot readable against the window light
    this.fill = new THREE.DirectionalLight(0xeaf0ff, 0.55);
    this.scene.add(this.fill, this.fill.target);
    this.sun = new THREE.DirectionalLight(0xffe4bd, 3.1);
    this.sun.castShadow = true;
    const size = opts.shadowMapSize ?? 2048;
    this.sun.shadow.mapSize.set(size, size);
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.012;
    this.sun.shadow.radius = 4;
    const sc = this.sun.shadow.camera;
    sc.left = -0.6; sc.right = 0.6; sc.top = 0.6; sc.bottom = -0.6; sc.near = 0.1; sc.far = 8;
    this.scene.add(this.sun, this.sun.target);
  }

  /**
   * Aim the sun at a model-frame point from a fixed direction (low, from the window in the back wall, a little
   * from the left), keeping its shadow frustum tight around the point. The fill comes from `viewer`.
   */
  aimSun(target: Vec3, viewer?: Vec3, dir: Vec3 = [1.9, 1.1, 1.75], halfExtent = 0.6): void {
    const t = toThree(target);
    this.sun.target.position.copy(t);
    this.sun.position.copy(t).add(toThree(dir));
    this.fill.target.position.copy(t);
    if (viewer) this.fill.position.copy(toThree(viewer)).add(toThree([0, 0, 0.6]));
    else this.fill.position.copy(t).add(toThree([-2, -0.6, 1.2]));
    const sc = this.sun.shadow.camera;
    if (sc.right !== halfExtent) {
      sc.left = -halfExtent; sc.right = halfExtent; sc.top = halfExtent; sc.bottom = -halfExtent;
      sc.updateProjectionMatrix();
    }
  }

  resize(width: number, height: number): void {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.pixelRatioCap));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.envTarget?.dispose();
    this.renderer.dispose();
  }
}
