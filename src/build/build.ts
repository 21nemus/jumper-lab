// BUILD: an optional, educational assembly sequence (not a verified manufacturing order). The robot's own
// link meshes, grouped into the subassemblies the model actually has, snap onto the chassis one module at a
// time; after each, one joint of that module can be tried. The finale stands the robot up from its zero pose
// into the calibrated standing pose. Render-only: the game simulation is frozen and restored on exit.

import * as THREE from 'three';
import type { AppContext } from '../app/app.ts';
import { blendPose, type CamPose } from '../scene/camera.ts';
import { terrazzo } from '../scene/textures.ts';
import { forward } from '../robot/kinematics.ts';
import { LEGS } from '../robot/model.ts';
import type { Eyes } from '../robot/eyes.ts';
import type { SimState } from '../sim/world.ts';
import './build.css';

interface Module {
  id: string;
  title: string;
  text: string;
  roots: string[]; // link groups that move as one when the module snaps on
  stage: [number, number, number][]; // where each root waits (offset from its true place, base frame)
  tryIt?: { label: string; joints: [string, number][]; range: [number, number]; readout?: 'aperture' };
}

const PUCK_TOP = 0.047;
const BASE_Z = 0.056; // chassis bottom sits on the puck; the claws hang clear of the floor in the zero pose
const DEG = 180 / Math.PI;

export function mountBuild(ctx: AppContext, eyes: Eyes): void {
  const { model, rig, stage, hud, world } = ctx;
  const B = (n: string) => model.body(n);
  const jn = (n: string) => model.joint(n);
  const claw = model.json.claw;

  const modules: Module[] = [
    {
      id: 'face', title: 'Face and senses',
      text: 'The visor holds the two round expression displays; the depth sensor (54 × 42 points) and the camera sit just below it.',
      roots: ['display_module_link', 'tof_sensor_link', 'camera_link'],
      stage: [[0.16, 0.06, -0.08], [0.2, -0.05, -0.04], [0.22, -0.11, -0.04]],
    },
    {
      id: 'mid', title: 'Middle legs',
      text: 'Each walking leg is three links and three servos: a hip that swings, a thigh and a calf that lift and fold, ending in a silicone foot tip.',
      roots: ['LM_hip_link', 'RM_hip_link'],
      stage: [[-0.02, 0.14, -0.05], [-0.02, -0.14, -0.05]],
      tryIt: { label: 'Knee (J2)', joints: [['LM_J2_joint', 1], ['RM_J2_joint', -1]], range: model.limits[jn('LM_J2_joint')] },
    },
    {
      id: 'rear', title: 'Rear legs',
      text: 'The rear pair is the same leg again. Their hips can swing far back (to 158°), more than the middle pair’s.',
      roots: ['LR_hip_link', 'RR_hip_link'],
      stage: [[-0.12, 0.13, -0.05], [-0.12, -0.13, -0.05]],
      tryIt: { label: 'Hip swing (J0)', joints: [['LR_J0_joint', 1], ['RR_J0_joint', -1]], range: model.limits[jn('LR_J0_joint')] },
    },
    {
      id: 'claws', title: 'Claw arms',
      text: 'Each front limb is five servos and ten parts: shoulder, roll, elbow, wrist and the finger that closes the claw. In walking it is also a foot.',
      roots: ['LF_shoulder_link', 'RF_shoulder_link'],
      stage: [[0.1, 0.17, -0.04], [0.1, -0.17, -0.04]],
      tryIt: { label: 'Claw (J4)', joints: [['LF_J4_joint', 1], ['RF_J4_joint', -1]], range: [claw.gripperOpen, claw.gripperClosed], readout: 'aperture' },
    },
    {
      id: 'shell', title: 'Shell',
      text: 'The red upper shell closes the body. Then the robot stands up from its zero pose into the calibrated standing pose, all six feet level.',
      roots: ['upper_shell_link'],
      stage: [[0, 0, 0.16]],
    },
  ];

  // ── state ──────────────────────────────────────────────────────────────────────────────────────────
  let snapshot: SimState | null = null;
  let step = 0; // index of the next module to place
  let anim: { m: number; t: number } | null = null;
  let standing: { t: number } | null = null;
  let done = false;
  let auto = false;
  let autoWait = 0;
  const q = new Float64Array(model.nJoints);
  const base = { pos: [0, 0, BASE_Z] as [number, number, number], quat: [1, 0, 0, 0] as [number, number, number, number] };
  const placed = modules.map(() => false);
  const highlight = new Map<THREE.Mesh, THREE.Material>();
  let orbit = { yaw: -0.8, pitch: 0.52, dist: 1.05 };
  let blend = 1;
  let blendFrom: CamPose | null = null;
  let leaving = 0;
  const spot: [number, number] = [0, 0];

  const puck = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.066, PUCK_TOP, 48),
    new THREE.MeshStandardMaterial({ map: terrazzo(), roughness: 0.5 }),
  );
  puck.rotation.x = Math.PI / 2;
  puck.castShadow = true;
  puck.receiveShadow = true;

  // ── panel ──────────────────────────────────────────────────────────────────────────────────────────
  const panel = document.createElement('aside');
  panel.className = 'build';
  panel.hidden = true;
  panel.setAttribute('aria-label', 'Build');
  panel.innerHTML = `
    <div class="b-kicker">Build · educational assembly sequence</div>
    <div class="b-dots" aria-hidden="true"></div>
    <h2 class="b-title"></h2>
    <p class="b-text"></p>
    <div class="b-try" hidden><label><span class="b-try-l"></span> <output class="b-try-v"></output><input type="range" step="0.001" /></label></div>
    <div class="b-row">
      <button type="button" class="pill primary b-go"></button>
      <button type="button" class="pill b-auto">Auto-assemble</button>
      <button type="button" class="pill b-skip">Skip to play</button>
    </div>
    <p class="b-note">Not a verified manufacturing order. Battery mounting, circuit boards, servo gears, fasteners and cables are not in the published model, so they are not drawn.</p>`;
  hud.root.parentElement!.append(panel);
  const $ = <T extends HTMLElement>(s: string) => panel.querySelector(s) as T;
  const dots = $('.b-dots');
  modules.forEach(() => dots.append(document.createElement('i')));
  const go = $<HTMLButtonElement>('.b-go');
  const tryBox = $('.b-try');
  const slider = tryBox.querySelector('input') as HTMLInputElement;
  go.addEventListener('click', () => primary());
  $('.b-auto').addEventListener('click', () => { auto = true; autoWait = 0; });
  $('.b-skip').addEventListener('click', () => finishNow(true));
  slider.addEventListener('input', () => applyTry(+slider.value));
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'BUTTON') { e.preventDefault(); primary(); }
  });

  function primary(): void {
    if (anim || standing) return;
    if (done) { ctx.setMode('play'); return; }
    if (step < modules.length && !placed[step]) place(step);
    else if (step < modules.length - 1) { step++; render(); }
    else if (!standing && step === modules.length - 1 && placed[step]) standUp();
  }

  // ── camera ─────────────────────────────────────────────────────────────────────────────────────────
  const pose = (): CamPose => {
    const at: [number, number, number] = [spot[0] + 0.02, spot[1], 0.07];
    return {
      eye: [at[0] + Math.cos(orbit.yaw) * Math.cos(orbit.pitch) * orbit.dist, at[1] + Math.sin(orbit.yaw) * Math.cos(orbit.pitch) * orbit.dist, at[2] + Math.sin(orbit.pitch) * orbit.dist],
      at,
      fov: 38,
    };
  };
  const canvas = stage.renderer.domElement;
  let drag: { id: number; x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (ctx.mode !== 'build') return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId || ctx.mode !== 'build') return;
    orbit.yaw -= (e.clientX - drag.x) * 0.008;
    orbit.pitch = Math.max(0.08, Math.min(1.3, orbit.pitch + (e.clientY - drag.y) * 0.006));
    drag.x = e.clientX;
    drag.y = e.clientY;
  });
  canvas.addEventListener('pointerup', () => (drag = null));
  canvas.addEventListener('pointercancel', () => (drag = null));
  canvas.addEventListener('wheel', (e) => {
    if (ctx.mode !== 'build') return;
    e.preventDefault();
    orbit.dist = Math.max(0.45, Math.min(1.8, orbit.dist * Math.exp(e.deltaY * 0.0012)));
  }, { passive: false });

  ctx.hooks.camera.push(() => {
    if (ctx.mode === 'build') return blend < 1 && blendFrom ? blendPose(blendFrom, pose(), blend) : pose();
    if (leaving > 0 && blendFrom) return blendPose(blendFrom, ctx.camPose, 1 - leaving);
    return null;
  });

  // ── enter / leave ──────────────────────────────────────────────────────────────────────────────────
  ctx.hooks.mode.push((m, prev) => {
    if (m === 'build') enter();
    else if (prev === 'build') leave();
  });

  function enter(): void {
    snapshot = world.snapshot();
    ctx.frozen = true;
    ctx.controls.release();
    hud.toast.classList.remove('on');
    hud.overlay.innerHTML = '';
    hud.root.classList.add('building');
    panel.hidden = false;
    // build where the mission starts: open rug
    spot[0] = world.course.start.x;
    spot[1] = world.course.start.y;
    step = 0;
    anim = null;
    standing = null;
    done = false;
    auto = false;
    placed.fill(false);
    q.fill(0);
    base.pos = [spot[0], spot[1], BASE_Z];
    base.quat = [1, 0, 0, 0];
    puck.position.set(spot[0], spot[1], PUCK_TOP / 2);
    puck.visible = true;
    stage.world.add(puck);
    eyes.on = false;
    ctx.snack.group.visible = world.state.snack.mode !== 'held';
    blendFrom = ctx.camPose;
    blend = 0;
    orbit = { yaw: -0.8, pitch: 0.52, dist: 1.05 };
    render();
    requestAnimationFrame(() => go.focus());
  }

  function leave(): void {
    clearHighlight();
    // the rig goes back to showing the simulation: restore link placement and the frozen state
    model.json.bodies.forEach((b, i) => rig.links[i].position.set(b.pos[0], b.pos[1], b.pos[2]));
    rig.meshes.forEach((m) => (m.visible = true));
    eyes.on = true;
    ctx.snack.group.visible = true;
    stage.world.remove(puck);
    panel.hidden = true;
    hud.root.classList.remove('building');
    if (snapshot) world.restore(snapshot);
    snapshot = null;
    ctx.frozen = false;
    blendFrom = pose();
    leaving = 1;
  }

  // ── placing modules ────────────────────────────────────────────────────────────────────────────────
  function place(m: number): void {
    anim = { m, t: 0 };
    clearHighlight();
    tryBox.hidden = true;
  }

  function standUp(): void {
    standing = { t: 0 };
    tryBox.hidden = true;
    render();
  }

  function finishNow(thenPlay: boolean): void {
    placed.fill(true);
    step = modules.length - 1;
    anim = null;
    standing = null;
    q.set(model.home);
    base.pos = [spot[0], spot[1], model.json.standZ];
    puck.visible = false;
    eyes.on = true;
    done = true;
    clearHighlight();
    render();
    if (thenPlay) ctx.setMode('play');
  }

  function applyTry(v: number): void {
    const t = modules[step].tryIt;
    if (!t) return;
    for (const [name, sign] of t.joints) q[jn(name)] = v * sign;
    const out = tryBox.querySelector('.b-try-v') as HTMLElement;
    if (t.readout === 'aperture') out.textContent = `${aperture(v).toFixed(1)} mm open · ${(v * DEG).toFixed(0)}°`;
    else out.textContent = `${(v * DEG).toFixed(0)}°`;
  }
  function aperture(left: number): number {
    const tb = claw.apertureMm;
    if (left <= tb[0][0]) return tb[0][1];
    for (let i = 1; i < tb.length; i++) if (left <= tb[i][0]) return tb[i - 1][1] + ((left - tb[i - 1][0]) / (tb[i][0] - tb[i - 1][0])) * (tb[i][1] - tb[i - 1][1]);
    return tb[tb.length - 1][1];
  }

  // ── render the panel ───────────────────────────────────────────────────────────────────────────────
  function render(): void {
    const m = modules[step];
    dots.querySelectorAll('i').forEach((d, i) => d.className = placed[i] ? 'done' : i === step ? 'now' : '');
    if (done) {
      $('.b-title').textContent = 'Assembled';
      $('.b-text').textContent = 'Standing in its calibrated pose: the base 106.47 mm up, all six feet level to about a thousandth of a millimetre (upstream calibration, MODEL VALUE).';
      go.textContent = 'Play the Snack Heist';
      tryBox.hidden = true;
      return;
    }
    $('.b-title').textContent = `${step + 1}. ${m.title}`;
    $('.b-text').textContent = m.text;
    if (!placed[step]) {
      go.textContent = `Attach the ${m.title.toLowerCase()}`;
      setHighlight(m);
      tryBox.hidden = true;
    } else if (m.id === 'shell') {
      go.textContent = standing ? 'Standing up…' : 'Stand up';
    } else {
      go.textContent = 'Next module';
      if (m.tryIt) {
        tryBox.hidden = false;
        (tryBox.querySelector('.b-try-l') as HTMLElement).textContent = `Try it · ${m.tryIt.label}`;
        slider.min = String(Math.min(...m.tryIt.range));
        slider.max = String(Math.max(...m.tryIt.range));
        const v = q[jn(m.tryIt.joints[0][0])];
        slider.value = String(v);
        applyTry(v);
      } else tryBox.hidden = true;
    }
  }

  function setHighlight(m: Module): void {
    clearHighlight();
    const roots = new Set(m.roots.map(B));
    rig.meshes.forEach((mesh, i) => {
      if (!inModule(i, roots)) return;
      highlight.set(mesh, mesh.material as THREE.Material);
      const c = (mesh.material as THREE.MeshStandardMaterial).clone();
      c.emissive = new THREE.Color('#5fc4a6');
      c.emissiveIntensity = 0;
      mesh.material = c;
    });
  }
  function clearHighlight(): void {
    for (const [mesh, mat] of highlight) {
      (mesh.material as THREE.Material).dispose();
      mesh.material = mat;
    }
    highlight.clear();
  }
  function inModule(i: number, roots: Set<number>): boolean {
    for (let b = i; b >= 0; b = model.json.bodies[b].parent) if (roots.has(b)) return true;
    return false;
  }

  // ── per frame: pose the rig ────────────────────────────────────────────────────────────────────────
  ctx.hooks.frame.push((dt) => {
    if (ctx.mode !== 'build') {
      if (leaving > 0) leaving = Math.max(0, leaving - dt / 0.6);
      return;
    }
    blend = Math.min(1, blend + dt / 0.8);
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (auto && !anim && !standing && !done) {
      autoWait += dt;
      if (autoWait > (placed[step] ? 0.35 : 0.15)) { autoWait = 0; primary(); }
    }
    if (anim) {
      anim.t += dt / (reduce ? 0.05 : 0.75);
      if (anim.t >= 1) {
        placed[anim.m] = true;
        if (modules[anim.m].id === 'face') eyes.on = true;
        anim = null;
        render();
      }
    }
    if (standing) {
      standing.t += dt / (reduce ? 0.05 : 2.2);
      const u = Math.min(1, standing.t);
      const e = u * u * (3 - 2 * u);
      for (let j = 0; j < q.length; j++) q[j] = model.home[j] * e;
      // keep every foot on or above the floor while the legs come down; the base rises off the puck
      const z0 = BASE_Z + (model.json.standZ - BASE_Z) * e;
      base.pos = [spot[0], spot[1], Math.max(z0, liftFor(z0))];
      puck.position.x = spot[0] - 0.42 * Math.max(0, e - 0.75) * 4;
      puck.visible = e < 0.999;
      if (u >= 1) {
        standing = null;
        done = true;
        render();
      }
    }

    // place the module roots: staged offsets ease to zero as each snaps on
    modules.forEach((m, mi) => {
      const k = placed[mi] ? 0 : anim && anim.m === mi ? 1 - easeOutBack(Math.min(1, anim.t)) : 1;
      m.roots.forEach((r, ri) => {
        const b = B(r);
        const p = model.json.bodies[b].pos;
        const o = m.stage[ri];
        rig.links[b].position.set(p[0] + o[0] * k, p[1] + o[1] * k, p[2] + o[2] * k);
      });
    });
    rig.setPose(base, q);
    // pulse the next module
    const pulse = 0.35 + 0.3 * Math.sin(performance.now() / 260);
    for (const mesh of highlight.keys()) (mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = reduce ? 0.4 : pulse;
  });

  /** Base height that keeps the lowest foot site at or above its standing height during the stand-up. */
  function liftFor(z: number): number {
    const f = forward(model, { pos: [0, 0, z], quat: [1, 0, 0, 0] }, q);
    let need = -Infinity;
    for (const leg of LEGS) {
      const { body, site } = model.foot(leg);
      const R = f.R[body], p = f.p[body];
      const wz = R[6] * site[0] + R[7] * site[1] + R[8] * site[2] + p[2];
      need = Math.max(need, model.json.footSiteZ - 0.0002 - wz);
    }
    return z + Math.max(0, need);
  }
}

function easeOutBack(t: number): number {
  const c1 = 1.4, c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}
