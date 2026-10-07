// Freeze the crab. INSPECT stops the simulation (robot, claw, snack, timer) at the exact frame, snapshots it,
// and flies the camera to a readable close-up of one limb: its joint axes, live angles inside their ranges,
// and one idea about how it works, with the source. Everything drawn here is a separate layer on the
// rendered rig; the simulation state is restored from the snapshot on resume, untouched.

import * as THREE from 'three';
import type { AppContext } from '../app/app.ts';
import { blendPose, type CamPose } from '../scene/camera.ts';
import { conceptFor, jointRole, LIMB_NAMES, type Label } from '../data/facts.ts';
import { LEGS, type Leg } from '../robot/model.ts';
import { forward } from '../robot/kinematics.ts';
import { mat3ToQuat, rpyToMat3, type Vec3 } from '../sim/math.ts';
import type { SimState } from '../sim/world.ts';
import './inspect.css';

type View = 'whole' | 'shell' | 'exploded' | 'isolated';
type Limb = Leg | 'body';
const JOINT_COLOURS = ['#2e8c73', '#d99a2b', '#d4624a', '#4f8fd6', '#8a6bd1'];
const DEG = 180 / Math.PI;

export function mountInspector(ctx: AppContext): void {
  const { stage, rig, model, world, hud } = ctx;
  let snapshot: SimState | null = null;
  let limb: Limb = 'LF';
  let view: View = 'whole';
  let blend = 1;
  let blendFrom: CamPose | null = null;
  let leaving = 0;
  let orbit = { yaw: 0, pitch: 0.42, dist: 0.5 };
  let target: Vec3 = [0, 0, 0.08];
  const overlay = new THREE.Group();
  overlay.name = 'inspect-overlay';
  const markers: { ring: THREE.Object3D; dot: THREE.Mesh; j: number; ref: THREE.Vector3; axis: THREE.Vector3; r: number }[] = [];
  const ghost = new THREE.MeshBasicMaterial({ color: '#d9cfc0', transparent: true, opacity: 0.16, depthWrite: false });
  const originalMats = rig.meshes.map((m) => m.material);

  // ── panel ──────────────────────────────────────────────────────────────────────────────────────────
  const panel = document.createElement('aside');
  panel.className = 'inspect';
  panel.setAttribute('aria-label', 'Inspector');
  panel.hidden = true;
  panel.innerHTML = `
    <div class="i-head">
      <div><div class="i-kicker">Frozen · inspect</div><h2 class="i-title"></h2><div class="i-sub"></div></div>
      <button type="button" class="pill primary i-resume">Resume <kbd>F</kbd></button>
    </div>
    <div class="i-limbs" role="group" aria-label="Choose a limb"></div>
    <p class="i-sentence"></p>
    <div class="i-joints"></div>
    <details class="i-more"><summary>More, with sources</summary><ul></ul></details>
    <div class="i-views" role="group" aria-label="View"></div>
    <p class="i-note">Angles are the frozen pose; ranges are the model’s joint limits (MODEL VALUE).</p>`;
  hud.root.parentElement!.append(panel);
  const $ = <T extends HTMLElement>(s: string) => panel.querySelector(s) as T;
  const limbBox = $('.i-limbs');
  for (const l of [...LEGS, 'body'] as Limb[]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'i-chip';
    b.dataset.limb = l;
    b.textContent = l === 'body' ? 'Body' : l;
    b.title = LIMB_NAMES[l];
    b.addEventListener('click', () => select(l));
    limbBox.append(b);
  }
  const viewBox = $('.i-views');
  for (const [v, label] of [['whole', 'Whole'], ['shell', 'Shell off'], ['exploded', 'Exploded'], ['isolated', 'Isolated']] as [View, string][]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'i-chip';
    b.dataset.view = v;
    b.textContent = label;
    b.addEventListener('click', () => setView(v));
    viewBox.append(b);
  }
  $('.i-resume').addEventListener('click', () => ctx.setMode('play'));

  // ── camera: drag to orbit the selected limb, wheel to zoom ────────────────────────────────────────
  const canvas = stage.renderer.domElement;
  let drag: { id: number; x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (ctx.mode !== 'inspect') return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id || ctx.mode !== 'inspect') return;
    orbit.yaw -= (e.clientX - drag.x) * 0.008;
    orbit.pitch = Math.max(-0.2, Math.min(1.35, orbit.pitch + (e.clientY - drag.y) * 0.006));
    drag.x = e.clientX;
    drag.y = e.clientY;
  });
  const endDrag = () => (drag = null);
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', (e) => {
    if (ctx.mode !== 'inspect') return;
    e.preventDefault();
    orbit.dist = Math.max(0.18, Math.min(1.4, orbit.dist * Math.exp(e.deltaY * 0.0012)));
  }, { passive: false });

  const inspectPose = (): CamPose => {
    const az = orbit.yaw;
    const d = orbit.dist;
    return {
      eye: [target[0] + Math.cos(az) * Math.cos(orbit.pitch) * d, target[1] + Math.sin(az) * Math.cos(orbit.pitch) * d, target[2] + Math.sin(orbit.pitch) * d],
      at: target,
      fov: 36,
    };
  };

  ctx.hooks.camera.push(() => {
    if (ctx.mode === 'inspect') {
      const p = inspectPose();
      if (blend < 1 && blendFrom) return blendPose(blendFrom, p, blend);
      return p;
    }
    if (leaving > 0 && blendFrom) return blendPose(blendFrom, ctx.camPose, 1 - leaving);
    return null;
  });
  ctx.hooks.frame.push((dt) => {
    const cam = stage.camera;
    if (ctx.mode === 'inspect') {
      blend = Math.min(1, blend + dt / (matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.01 : 0.7));
      updateMarkers();
      // centre the subject in the space the panel leaves free (desktop: panel on the right; phone: sheet below)
      const w = stage.renderer.domElement.clientWidth, h = stage.renderer.domElement.clientHeight;
      const rect = panel.hidden ? null : panel.getBoundingClientRect();
      const k = Math.min(1, blend * 1.5);
      const dx = rect && w > 720 ? ((rect.width + 16) / 2) * k : 0;
      const dy = rect && w <= 720 ? ((h - rect.top) / 2) * k : 0;
      if (dx > 0.5 || dy > 0.5) cam.setViewOffset(w, h, dx, dy, w, h);
      else cam.clearViewOffset();
    } else if (leaving > 0) {
      leaving = Math.max(0, leaving - dt / 0.55);
      const w = stage.renderer.domElement.clientWidth, h = stage.renderer.domElement.clientHeight;
      const dx = w > 720 ? (Math.min(380, w * 0.42) / 2) * leaving : 0;
      const dy = w <= 720 ? h * 0.23 * leaving : 0;
      if (dx > 0.5 || dy > 0.5) cam.setViewOffset(w, h, dx, dy, w, h);
      else cam.clearViewOffset();
    } else if (cam.view?.enabled) {
      cam.clearViewOffset();
    }
  });

  // ── enter / leave ──────────────────────────────────────────────────────────────────────────────────
  ctx.hooks.mode.push((m, prev) => {
    if (m === 'inspect') enter();
    else if (prev === 'inspect') leave();
  });

  function enter(): void {
    snapshot = world.snapshot();
    ctx.frozen = true;
    ctx.controls.release();
    hud.toast.classList.remove('on');
    hud.overlay.innerHTML = '';
    const s = world.state;
    limb = s.claw.arm ?? 'LF';
    blendFrom = ctx.camPose;
    blend = 0;
    panel.hidden = false;
    hud.root.classList.add('inspecting');
    stage.world.add(overlay);
    select(limb, true);
    setView('whole');
  }

  function leave(): void {
    if (snapshot) world.restore(snapshot);
    snapshot = null;
    ctx.frozen = false;
    panel.hidden = true;
    hud.root.classList.remove('inspecting');
    setView('whole');
    clearMarkers();
    stage.world.remove(overlay);
    blendFrom = inspectPose();
    leaving = 1;
  }

  // ── selection, framing ──────────────────────────────────────────────────────────────────────────────
  function frames() {
    const r = world.state.robot;
    return forward(model, { pos: [r.x, r.y, r.z], quat: mat3ToQuat(rpyToMat3(r.roll, r.pitch, r.yaw)) }, r.q);
  }

  function limbBodies(l: Limb): number[] {
    if (l === 'body') return ['base_link', 'upper_shell_link', 'display_module_link', 'tof_sensor_link', 'camera_link'].map((n) => model.body(n));
    return model.json.bodies.map((b, i) => (b.name.startsWith(`${l}_`) ? i : -1)).filter((i) => i >= 0);
  }

  function select(l: Limb, initial = false): void {
    limb = l;
    for (const b of limbBox.querySelectorAll<HTMLButtonElement>('.i-chip')) b.setAttribute('aria-pressed', String(b.dataset.limb === l));
    const s = world.state;
    const c = conceptFor(l, s.claw.phase === 'carrying' || s.claw.phase === 'releasing' ? s.claw.arm : null);
    $('.i-title').textContent = LIMB_NAMES[l];
    const nJ = l === 'body' ? 0 : model.limbJoints(l).length;
    $('.i-sub').textContent = l === 'body' ? 'Chassis, shell, display, depth sensor and camera' : `${nJ} joints, each one of the robot’s 22 tactile servos`;
    const sentence = $('.i-sentence');
    sentence.innerHTML = '';
    const strong = document.createElement('strong');
    strong.textContent = c.title + '. ';
    sentence.append(strong, document.createTextNode(c.sentence + ' '));
    const a = document.createElement('a');
    a.href = c.source.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.className = 'src';
    a.textContent = c.source.label;
    sentence.append(a);
    const ul = $('.i-more').querySelector('ul')!;
    ul.innerHTML = '';
    for (const f of c.more) {
      const li = document.createElement('li');
      li.append(tag(f.label), document.createTextNode(' ' + f.text + ' '));
      if (f.source) {
        const s2 = document.createElement('a');
        s2.href = f.source.url;
        s2.target = '_blank';
        s2.rel = 'noopener';
        s2.className = 'src';
        s2.textContent = f.source.label;
        li.append(s2);
      }
      ul.append(li);
    }
    buildJointRows(l);
    buildMarkers(l);
    frame(l, initial);
    applyView();
  }

  function frame(l: Limb, initial: boolean): void {
    const f = frames();
    const box = new THREE.Box3();
    for (const i of limbBodies(l)) {
      const g = rig.meshes[i].geometry;
      g.computeBoundingBox();
      const bb = g.boundingBox!.clone();
      const R = f.R[i], p = f.p[i];
      const m = new THREE.Matrix4().set(R[0], R[1], R[2], p[0], R[3], R[4], R[5], p[1], R[6], R[7], R[8], p[2], 0, 0, 0, 1);
      box.union(bb.applyMatrix4(m));
    }
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    target = [c.x, c.y, c.z];
    const r = world.state.robot;
    // look from outside the robot, on the limb's side, a little from the front
    const out = l === 'body' ? r.yaw + 0.7 : Math.atan2(c.y - r.y, c.x - r.x) + (l.endsWith('F') ? -0.35 : 0.25);
    if (!initial || blend >= 1) blendFrom = inspectPose();
    blend = initial ? 0 : 0.15;
    const portrait = stage.camera.aspect < 1;
    orbit = { yaw: out, pitch: l === 'body' ? 0.5 : 0.45, dist: Math.max(0.24, Math.min(portrait ? 1.4 : 0.9, size * (portrait ? 2.5 : 1.55))) };
  }

  // ── joint rows ─────────────────────────────────────────────────────────────────────────────────────
  const rowEls: { j: number; val: HTMLElement; mark: HTMLElement }[] = [];
  function buildJointRows(l: Limb): void {
    const box = $('.i-joints');
    box.innerHTML = '';
    rowEls.length = 0;
    if (l === 'body') {
      box.innerHTML = '<p class="i-empty">The body has no joints of its own: it is the base every limb hangs from. Pick a limb to see its servos.</p>';
      return;
    }
    model.limbJoints(l).forEach((j, k) => {
      const name = model.json.joints[j];
      const [lo, hi] = model.limits[j];
      const row = document.createElement('div');
      row.className = 'i-joint';
      row.innerHTML = `<span class="sw" style="background:${JOINT_COLOURS[k]}"></span><span class="jn"><b>${name.replace('_joint', '')}</b> ${jointRole(name)}</span><span class="val"></span><span class="bar"><i class="mark"></i></span><span class="lim">${(lo * DEG).toFixed(0)}° … ${(hi * DEG).toFixed(0)}°</span>`;
      box.append(row);
      rowEls.push({ j, val: row.querySelector('.val')!, mark: row.querySelector('.mark')! });
    });
    updateRows();
  }
  function updateRows(): void {
    const q = world.state.robot.q;
    for (const r of rowEls) {
      const [lo, hi] = model.limits[r.j];
      r.val.textContent = `${(q[r.j] * DEG).toFixed(1)}°`;
      r.mark.style.left = `${((q[r.j] - lo) / (hi - lo)) * 100}%`;
    }
  }

  // ── 3D markers: axis ring + range arc + live angle dot per joint ──────────────────────────────────
  function clearMarkers(): void {
    for (const m of markers) {
      m.ring.parent?.remove(m.ring);
      m.ring.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
      });
    }
    markers.length = 0;
  }

  function buildMarkers(l: Limb): void {
    clearMarkers();
    if (l === 'body') return;
    model.limbJoints(l).forEach((j, k) => {
      const bi = model.jointBody[j];
      const body = model.json.bodies[bi];
      const axis = new THREE.Vector3(...body.joint!.axis);
      // reference direction: towards the child's next joint (or mesh centre), projected off the axis
      const child = model.children[bi].find((c) => model.json.bodies[c].joint) ?? -1;
      const toward = child >= 0 ? new THREE.Vector3(...model.json.bodies[child].pos) : new THREE.Vector3(...model.json.meshes[bi].centroid);
      let ref = toward.clone().sub(axis.clone().multiplyScalar(toward.dot(axis)));
      if (ref.lengthSq() < 1e-8) ref = new THREE.Vector3(1, 0, 0).cross(axis).lengthSq() > 1e-6 ? new THREE.Vector3(1, 0, 0).cross(axis) : new THREE.Vector3(0, 1, 0).cross(axis);
      ref.normalize();
      const colour = new THREE.Color(JOINT_COLOURS[k]);
      const r = k === 4 ? 0.022 : 0.03;
      const holder = new THREE.Group();
      // the arc lives in the parent's frame at the joint origin, so it does not turn with the joint
      holder.position.set(...body.pos);
      const [lo, hi] = model.limits[j];
      const side = new THREE.Vector3().crossVectors(axis, ref);
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 48; i++) {
        const a = lo + ((hi - lo) * i) / 48;
        pts.push(ref.clone().multiplyScalar(Math.cos(a) * r).add(side.clone().multiplyScalar(Math.sin(a) * r)));
      }
      const mat = () => new THREE.MeshBasicMaterial({ color: colour, transparent: true, opacity: 0.95, depthTest: false, toneMapped: false });
      const arc = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 64, 0.0016, 6), mat());
      arc.renderOrder = 10;
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.0012, 0.0012, 0.05, 8), mat());
      shaft.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
      shaft.renderOrder = 10;
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.0035, 0.009, 12), mat());
      tip.quaternion.copy(shaft.quaternion);
      tip.position.copy(axis.clone().multiplyScalar(0.029));
      tip.renderOrder = 10;
      const dot = new THREE.Mesh(new THREE.SphereGeometry(0.0042, 16, 12), mat());
      dot.renderOrder = 11;
      holder.add(arc, shaft, tip, dot);
      const parent = body.parent >= 0 ? rig.links[body.parent] : rig.root;
      parent.add(holder);
      markers.push({ ring: holder, dot, j, ref, axis, r });
    });
    updateMarkers();
  }

  function updateMarkers(): void {
    const q = world.state.robot.q;
    for (const m of markers) {
      const side = new THREE.Vector3().crossVectors(m.axis, m.ref);
      m.dot.position.copy(m.ref.clone().multiplyScalar(Math.cos(q[m.j]) * m.r).add(side.multiplyScalar(Math.sin(q[m.j]) * m.r)));
    }
    updateRows();
  }

  // ── views ──────────────────────────────────────────────────────────────────────────────────────────
  function setView(v: View): void {
    view = v;
    for (const b of viewBox.querySelectorAll<HTMLButtonElement>('.i-chip')) b.setAttribute('aria-pressed', String(b.dataset.view === v));
    applyView();
  }

  function applyView(): void {
    const active = ctx.mode === 'inspect';
    const sel = new Set(limbBodies(limb));
    const shell = model.body('upper_shell_link');
    const f = active && view === 'exploded' ? frames() : null;
    const centre = f ? f.p[0] : null;
    // the snack is part of the picture: ghost it with the rest, and keep it in the claw that holds it
    const held = world.state.snack.held;
    const snackGhost = active && view === 'isolated' && !(held && sel.has(model.body(`${held.arm}_palm_link`)));
    ctx.snack.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.userData.mat ??= mesh.material;
      mesh.material = snackGhost ? ghost : mesh.userData.mat;
    });
    snackOffset.set(0, 0, 0);
    rig.meshes.forEach((m, i) => {
      m.material = active && view === 'isolated' && !sel.has(i) ? ghost : originalMats[i];
      m.visible = !(active && (view === 'shell' || view === 'exploded') && i === shell);
      m.position.set(0, 0, 0);
      if (f && centre) {
        // push each part away from the body centre, scaled by how far down its chain it sits
        const depth = chainDepth(i);
        const w = f.p[i];
        const out = new THREE.Vector3(w[0] - centre[0], w[1] - centre[1], 0);
        if (out.lengthSq() < 1e-6) out.set(0, 0, 1);
        out.normalize().multiplyScalar(0.018 * depth);
        if (i !== 0 && model.json.bodies[i].parent === 0 && !model.json.bodies[i].joint) out.set(0, 0, 0.05 + 0.02 * (i % 3));
        // into the link's own frame
        const R = f.R[i];
        m.position.set(R[0] * out.x + R[3] * out.y + R[6] * out.z, R[1] * out.x + R[4] * out.y + R[7] * out.z, R[2] * out.x + R[5] * out.y + R[8] * out.z);
        if (held && i === model.body(`${held.arm}_palm_link`)) snackOffset.copy(out);
      }
    });
  }
  // world-space offset applied to the held snack while exploded (model frame)
  const snackOffset = new THREE.Vector3();
  ctx.hooks.frame.push(() => {
    if (ctx.mode === 'inspect' && snackOffset.lengthSq() > 0) ctx.snack.group.position.add(snackOffset);
  });

  function chainDepth(i: number): number {
    let d = 0;
    for (let b = i; b > 0; b = model.json.bodies[b].parent) d++;
    return d;
  }

  function tag(label: Label): HTMLElement {
    const t = document.createElement('span');
    t.className = `tag ${label.split(' ')[0].toLowerCase()}`;
    t.textContent = label;
    return t;
  }
}
