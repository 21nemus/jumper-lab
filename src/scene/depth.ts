// Synthetic depth inset for the published dToF sensor (HARDWARE.md: 54 x 42 points, 55 x 42 degrees,
// 5 cm to 8.8 m indoors). The camera sits where jumper.xml puts the `tof` camera, and the scene is rendered at
// exactly 54 x 42 with each pixel's distance colour-mapped. It is rendered scene depth from our room, not
// sensor footage, not noise-modelled, and not a perception model.

import * as THREE from 'three';
import type { RobotRig } from '../robot/rig.ts';
import type { Stage } from './stage.ts';

const W = 54;
const H = 42;
const NEAR = 0.05;
const FAR = 8.8;
const SHOW_FAR = 3.0; // colour ramp spans 5 cm to 3 m (indoor corner); beyond that it saturates

export class DepthInset {
  enabled = false;
  readonly camera: THREE.PerspectiveCamera;
  private readonly target = new THREE.WebGLRenderTarget(W, H, { magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter, depthBuffer: true });
  private readonly material: THREE.ShaderMaterial;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  readonly label: HTMLElement;

  constructor(rig: RobotRig, host: HTMLElement) {
    const tofBody = rig.model.body('tof_sensor_link');
    const cam = rig.model.json.bodies[tofBody].cameras.find((c) => c.name === 'tof')!;
    const [sx, sy] = cam.sensorsize!;
    const [fx, fy] = cam.focal!;
    const vfov = (2 * Math.atan(sy / 2 / fy) * 180) / Math.PI; // 42.0 deg
    this.camera = new THREE.PerspectiveCamera(vfov, sx / fx / (sy / fy), NEAR, FAR);
    // MuJoCo cameras look along -z with +y up, as three.js cameras do: the model's pose applies directly.
    this.camera.position.set(cam.pos[0], cam.pos[1], cam.pos[2]);
    this.camera.quaternion.set(cam.quat[1], cam.quat[2], cam.quat[3], cam.quat[0]);
    rig.links[tofBody].add(this.camera);

    this.material = new THREE.ShaderMaterial({
      uniforms: { near: { value: NEAR }, far: { value: FAR }, showFar: { value: SHOW_FAR } },
      vertexShader: /* glsl */ `
        varying vec3 vView;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vView = mv.xyz;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying vec3 vView;
        uniform float near, far, showFar;
        vec3 ramp(float t) {
          // warm near -> cool far, perceptually even enough for a 54 x 42 thumbnail
          vec3 a = vec3(0.98, 0.93, 0.80), b = vec3(0.95, 0.55, 0.30), c = vec3(0.37, 0.77, 0.65), d = vec3(0.16, 0.30, 0.42), e = vec3(0.09, 0.10, 0.16);
          if (t < 0.15) return mix(a, b, t / 0.15);
          if (t < 0.4) return mix(b, c, (t - 0.15) / 0.25);
          if (t < 0.75) return mix(c, d, (t - 0.4) / 0.35);
          return mix(d, e, (t - 0.75) / 0.25);
        }
        void main() {
          float dist = length(vView);
          if (dist < near || dist > far) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
          float t = clamp((dist - near) / (showFar - near), 0.0, 1.0);
          gl_FragColor = vec4(ramp(t), 1.0);
        }`,
    });
    // the shader writes display-ready colours; mark the target sRGB so the up-scaling pass passes them through
    this.target.texture.colorSpace = THREE.SRGBColorSpace;
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: this.target.texture, toneMapped: false }));
    this.quadScene.add(quad);

    this.label = document.createElement('div');
    this.label.className = 'depth-label';
    this.label.innerHTML = '<b>Synthetic depth · 54 × 42</b><span>Rendered from this room at the dToF’s pose and field of view (55° × 42°). Not sensor data.</span><i class="ramp"></i><span class="ends"><em>5 cm</em><em>3 m+</em></span>';
    this.label.hidden = true;
    host.append(this.label);
  }

  /** Render after the main pass: 54 x 42 depth into the target, then up-scaled (pixelated) into a corner. */
  render(stage: Stage): void {
    this.label.hidden = !this.enabled;
    if (!this.enabled) return;
    const r = stage.renderer;
    const scene = stage.scene;
    const prevOverride = scene.overrideMaterial;
    const prevBg = scene.background;
    const prevFog = scene.fog;
    scene.overrideMaterial = this.material;
    scene.background = new THREE.Color(0, 0, 0);
    scene.fog = null;
    r.setRenderTarget(this.target);
    r.render(scene, this.camera);
    r.setRenderTarget(null);
    scene.overrideMaterial = prevOverride;
    scene.background = prevBg;
    scene.fog = prevFog;
    // inset in the bottom-left corner, above the bottom line
    const canvas = r.domElement;
    const css = this.label.getBoundingClientRect();
    // bigger during the guided tour, so it reads in a screen recording
    const touring = document.body.classList.contains('touring');
    const scale = Math.max(2, touring ? Math.min(6, Math.floor(canvas.clientWidth / 210)) : Math.min(4, Math.floor(canvas.clientWidth / 260)));
    const w = W * scale, h = H * scale;
    const x = css.left, y = canvas.clientHeight - css.top; // bottom of the inset sits on top of the label
    r.setScissorTest(true);
    r.setScissor(x, y, w, h);
    r.setViewport(x, y, w, h);
    const tm = r.toneMapping;
    r.toneMapping = THREE.NoToneMapping;
    r.render(this.quadScene, this.quadCam);
    r.toneMapping = tm;
    r.setScissorTest(false);
    r.setViewport(0, 0, canvas.clientWidth, canvas.clientHeight);
    this.label.style.setProperty('--inset-w', `${w}px`);
    this.label.style.setProperty('--inset-h', `${h}px`);
  }
}
