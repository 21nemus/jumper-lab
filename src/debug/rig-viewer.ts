// Gate 1 viewer (`?rig`): the robot in a neutral studio, every joint on a slider, upstream's documented
// poses one click away, and fixed camera views for checking the import from every side.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadRobot } from '../robot/loader.ts';
import { RobotRig } from '../robot/rig.ts';
import { forward, standingBase, type BasePose } from '../robot/kinematics.ts';
import { ARMS, LEGS, type Leg, type RobotModel } from '../robot/model.ts';
import { Stage, toThree } from '../scene/stage.ts';
import type { Vec3 } from '../sim/math.ts';
import './rig-viewer.css';

const DEG = 180 / Math.PI;
type PoseName = 'home' | 'zero' | 'stow' | 'arm_thumb_up' | 'arm_thumb_down' | 'arm_web_up';

export async function startRigViewer(app: HTMLElement): Promise<void> {
  const canvas = document.createElement('canvas');
  canvas.className = 'stage';
  app.append(canvas);
  const stage = new Stage({ canvas, background: '#f3ece1' });
  const status = el('div', 'rv-status', 'Loading…');
  app.append(status);

  const t0 = performance.now();
  const loaded = await loadRobot('./assets/robot/', (f, label) => (status.textContent = `${label} · ${Math.round(f * 100)}%`));
  const loadMs = performance.now() - t0;
  const model = loaded.model;
  const rig = new RobotRig(model, loaded.geometries);
  stage.world.add(rig.root);

  // Studio floor: a soft cream disc that catches the shadow.
  const floor = new THREE.Mesh(new THREE.CircleGeometry(3, 96), new THREE.MeshStandardMaterial({ color: '#efe6d8', roughness: 0.95 }));
  floor.receiveShadow = true;
  stage.world.add(floor);

  const q = Float64Array.from(model.home);
  let base: BasePose = standingBase(model);
  const controls = new OrbitControls(stage.camera, canvas);
  controls.enableDamping = true;
  controls.target.copy(toThree([0.02, 0, 0.07]));
  stage.camera.position.copy(toThree([0.75, 0.62, 0.42]));
  controls.update();
  stage.aimSun([0, 0, 0]);

  // Lowest point of the whole robot for the current joints (so the zero pose can sit on the floor too).
  const lowest = (): number => {
    const f = forward(model, { pos: [0, 0, 0], quat: [1, 0, 0, 0] }, q);
    let min = Infinity;
    model.json.bodies.forEach((b, i) => {
      const pos = loaded.geometries.get(b.name)!.getAttribute('position');
      const R = f.R[i];
      for (let k = 0; k < pos.count; k += 7) {
        const z = R[6] * pos.getX(k) + R[7] * pos.getY(k) + R[8] * pos.getZ(k) + f.p[i][2];
        if (z < min) min = z;
      }
    });
    return min;
  };

  const panel = el('aside', 'rv-panel');
  const sliders: { input: HTMLInputElement; out: HTMLElement; j: number }[] = [];
  panel.append(el('h1', '', 'Jumper · import check'));
  panel.append(el('p', 'rv-note', `${model.json.source.repo}@${model.json.source.commit.slice(0, 7)} · ${model.nJoints} joints · ${model.json.bodies.length} links`));

  const poses = el('div', 'rv-row');
  const poseButtons: [PoseName, string][] = [['home', 'HOME (calibrated)'], ['zero', 'Zero pose'], ['stow', 'Claw stow'], ['arm_web_up', 'Arm out · web up'], ['arm_thumb_up', 'Arm out · thumb up'], ['arm_thumb_down', 'Arm out · thumb down']];
  let arm: Leg = 'LF';
  for (const [name, label] of poseButtons) poses.append(button(label, () => applyPose(name)));
  panel.append(poses);
  const armRow = el('div', 'rv-row');
  for (const a of ARMS) armRow.append(button(`Claw arm ${a}`, () => { arm = a; }));
  panel.append(armRow);

  for (const leg of LEGS) {
    const group = el('fieldset', 'rv-limb');
    group.append(el('legend', '', leg));
    for (const j of model.limbJoints(leg)) {
      const name = model.json.joints[j];
      const [lo, hi] = model.limits[j];
      const row = el('label', 'rv-joint');
      row.append(el('span', 'rv-jname', name.replace('_joint', '')));
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(lo);
      input.max = String(hi);
      input.step = '0.001';
      input.value = String(q[j]);
      input.setAttribute('aria-label', `${name} angle`);
      const out = el('output', 'rv-val');
      input.addEventListener('input', () => {
        q[j] = +input.value;
        sync();
      });
      row.append(input, out, el('span', 'rv-lim', `${(lo * DEG).toFixed(0)}…${(hi * DEG).toFixed(0)}°`));
      group.append(row);
      sliders.push({ input, out, j });
    }
    panel.append(group);
  }

  const views: [string, Vec3, Vec3][] = [
    ['front', [0.95, 0, 0.16], [0.02, 0, 0.08]],
    ['back', [-0.95, 0, 0.2], [0.02, 0, 0.08]],
    ['left', [0.05, 0.98, 0.18], [0.02, 0, 0.08]],
    ['right', [0.05, -0.98, 0.18], [0.02, 0, 0.08]],
    ['top', [0.02, 0.001, 1.15], [0.02, 0, 0.05]],
    ['three-quarter', [0.75, 0.62, 0.42], [0.02, 0, 0.07]],
  ];
  const viewRow = el('div', 'rv-row');
  for (const [name, eye, at] of views) viewRow.append(button(name, () => setView(eye, at)));
  viewRow.append(button('sweep joints', () => sweep()));
  viewRow.append(button('capture 6 views', () => captureAll()));
  panel.append(viewRow);
  const stats = el('pre', 'rv-stats');
  panel.append(stats);
  app.append(panel);

  function setView(eye: Vec3, at: Vec3): void {
    stage.camera.position.copy(toThree(eye));
    controls.target.copy(toThree(at));
    controls.update();
  }

  function applyPose(name: PoseName): void {
    q.set(model.home);
    if (name === 'zero') q.fill(0);
    else if (name !== 'home') {
      const c = model.json.claw;
      const left = name === 'stow' ? c.stow : [...c.presetsDeg[name].map((d) => d / DEG), c.gripperClosed - c.fingerPosedDeg / DEG];
      model.limbJoints(arm).forEach((j, k) => (q[j] = model.clampJoint(j, model.armAngle(arm, k, left[k]))));
    }
    base = standingBase(model);
    if (name === 'zero') base = { pos: [0, 0, -lowest()], quat: [1, 0, 0, 0] };
    sync();
  }

  let sweeping = false;
  async function sweep(): Promise<void> {
    if (sweeping) return;
    sweeping = true;
    applyPose('home');
    for (let j = 0; j < model.nJoints && sweeping; j++) {
      const [lo, hi] = model.limits[j];
      const h = model.home[j];
      const keys = [h, hi, lo, h];
      for (let s = 0; s < keys.length - 1; s++) {
        const a = keys[s], b = keys[s + 1];
        const dur = 250 + 260 * Math.abs(b - a);
        const start = performance.now();
        for (;;) {
          const t = Math.min(1, (performance.now() - start) / dur);
          q[j] = a + (b - a) * (0.5 - 0.5 * Math.cos(Math.PI * t));
          sync();
          await new Promise(requestAnimationFrame);
          if (t >= 1) break;
        }
      }
    }
    sweeping = false;
  }

  async function captureAll(): Promise<void> {
    for (const [name, eye, at] of views) {
      setView(eye, at);
      for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame);
      stage.render();
      const data = canvas.toDataURL('image/png');
      await fetch(`/__capture?name=gate1-${name}`, { method: 'POST', body: data });
    }
    status.textContent = 'captured 6 views';
  }

  function sync(): void {
    rig.setPose(base, q);
    for (const s of sliders) {
      s.input.value = String(q[s.j]);
      s.out.textContent = `${(q[s.j] * DEG).toFixed(1)}°`;
    }
  }

  function resize(): void {
    stage.resize(app.clientWidth, app.clientHeight);
  }
  window.addEventListener('resize', resize);
  resize();
  applyPose('home');

  let frames = 0, fpsT = performance.now(), fps = 0;
  const s = loaded.stats;
  function tick(): void {
    controls.update();
    stage.render();
    frames++;
    const now = performance.now();
    if (now - fpsT > 1000) {
      fps = (frames * 1000) / (now - fpsT);
      frames = 0;
      fpsT = now;
      stats.textContent = [
        `jumper.glb  ${(s.glbBytes / 1024).toFixed(0)} KB · robot.json ${(s.jsonBytes / 1024).toFixed(0)} KB`,
        `triangles   ${s.triangles.toLocaleString()} · vertices ${s.vertices.toLocaleString()}`,
        `normals     ${s.normalsMs.toFixed(0)} ms (${s.usedWorker ? 'worker' : 'main thread'})`,
        `load total  ${loadMs.toFixed(0)} ms · ${fps.toFixed(0)} fps · dpr ${stage.renderer.getPixelRatio()}`,
      ].join('\n');
    }
    requestAnimationFrame(tick);
  }
  status.textContent = 'Ready';
  setTimeout(() => status.remove(), 1200);
  tick();
  (window as unknown as { __rig: unknown }).__rig = { model, q, rig, stage, applyPose, setView, stats: loaded.stats, loadMs };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
function button(label: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'rv-btn', label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}
export type { RobotModel };
