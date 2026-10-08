// BUILD: an optional, educational assembly sequence (not a verified manufacturing order). The robot's 92 parts,
// split out of KingKong's link meshes (91 as published, plus one servo upstream's mesh is missing), fly onto
// the chassis step by step: servos, shell halves, brackets, pads. After a step one of its joints can be tried;
// the Explode slider spreads every part apart at any time; tapping a part says what it is and where it comes
// from. The finale stands the robot up from its zero pose into the calibrated standing pose. Render-only: the
// game simulation is frozen and restored on exit.

import * as THREE from 'three';
import type { AppContext } from '../app/app.ts';
import { blendPose, type CamPose } from '../scene/camera.ts';
import { terrazzo } from '../scene/textures.ts';
import { forward, type Frames } from '../robot/kinematics.ts';
import { LEGS, type PartJson } from '../robot/model.ts';
import type { Eyes } from '../robot/eyes.ts';
import type { SimState } from '../sim/world.ts';
import { add, apply3, applyT3, type Vec3 } from '../sim/math.ts';
import { jointRole, LIMB_NAMES } from '../data/facts.ts';
import { buildSteps, type BuildStep } from './sequence.ts';
import './build.css';

interface TryIt {
  label: string;
  joints: [string, number][];
  range: [number, number];
  readout?: 'aperture';
}

const PUCK_TOP = 0.047;
const BASE_Z = 0.056; // chassis bottom sits on the puck; the claws hang clear of the floor in the zero pose
const DEG = 180 / Math.PI;
const BEAT = 0.16; // s between beats while a step flies in
const FLIGHT = 0.5; // s for one part to fly into place
const HIDDEN = 0, WAITING = 1, FLYING = 2, PLACED = 3;
const KIND_LABEL: Record<PartJson['kind'], string> = {
  servo: 'Servo', shell: 'Shell', bracket: 'Bracket', pad: 'Pad or insert', module: 'Module', chassis: 'Chassis', electronics: 'Likely electronics', mount: 'Mount',
};

export function mountBuild(ctx: AppContext, eyes: Eyes): void {
  const { model, rig, stage, hud, world } = ctx;
  const B = (n: string) => model.body(n);
  const jn = (n: string) => model.joint(n);
  const claw = model.json.claw;
  const parts = model.json.parts;
  const steps = buildSteps(model.json);
  const displayPart = parts.findIndex((p) => p.body === 'display_module_link');
  const servoTotal = parts.filter((p) => p.kind === 'servo').length;
  const bodyOf = parts.map((p) => B(p.body));
  const stepOf = new Int8Array(parts.length).fill(-1);
  steps.forEach((s, si) => s.beats.flat().forEach((k) => (stepOf[k] = si)));
  const tries: Partial<Record<BuildStep['id'], TryIt>> = {
    mid: { label: 'Knee (J2)', joints: [['LM_J2_joint', 1], ['RM_J2_joint', -1]], range: model.limits[jn('LM_J2_joint')] },
    rear: { label: 'Hip swing (J0)', joints: [['LR_J0_joint', 1], ['RR_J0_joint', -1]], range: model.limits[jn('LR_J0_joint')] },
    claws: { label: 'Claw (J4)', joints: [['LF_J4_joint', 1], ['RF_J4_joint', -1]], range: [claw.gripperOpen, claw.gripperClosed], readout: 'aperture' },
  };

  // ── how each part comes apart ──────────────────────────────────────────────────────────────────────
  // Limb and face parts spread out from the body centre; a servo also slides out of its shell, and two halves
  // part from each other. Chassis parts rise in layers, the rear electronics back and up, the shell straight up.
  const base = B('base_link');
  // the biggest non-servo part of each part's link: the shell a servo slides out of
  const main = parts.map((p, k) => {
    const own = parts.flatMap((o, j) => (o.body === p.body && o.kind !== 'servo' ? [j] : []));
    return own.length ? own.reduce((a, j) => (parts[j].count > parts[a].count ? j : a)) : k;
  });
  const halves = parts.map((p) => (/ half$/.test(p.name) ? parts.flatMap((q, j) => (q.body === p.body && / half$/.test(q.name) ? [j] : [])) : []));
  const group = (pred: (p: PartJson) => boolean) => parts.flatMap((p, j) => (p.body === 'base_link' && pred(p) ? [j] : []));
  const rearGroup = group((p) => p.center[0] < -0.08);
  const frontGroup = group((p) => p.center[0] > 0.06);
  const mean = (ks: number[]): Vec3 => ks.reduce<Vec3>((s, j) => add(s, parts[j].center.map((v) => v / ks.length) as Vec3), [0, 0, 0]);
  const rearMid = mean(rearGroup), frontMid = mean(frontGroup);
  const CHASSIS: Record<string, Vec3> = { 'Chassis frame': [0, 0, 0], 'Mounting plate': [0, 0, 0.045], 'Front tray': [0.085, 0, 0.005], 'Long box': [0, 0, 0.1] };
  const centreOf = (k: number, f: Frames): Vec3 => add(f.p[bodyOf[k]], apply3(f.R[bodyOf[k]], parts[k].center));

  /** Where part k goes in the exploded view, as an offset in the base frame, at the pose `f` (base at the origin). */
  function spread(k: number, f: Frames): Vec3 {
    const p = parts[k];
    if (bodyOf[k] === base) {
      const c = p.center;
      if (CHASSIS[p.name]) return CHASSIS[p.name];
      if (rearGroup.includes(k)) return [-0.06 + (c[0] - rearMid[0]) * 1.4, (c[1] - rearMid[1]) * 1.6, 0.1 + (c[2] - rearMid[2]) * 1.4];
      if (frontGroup.includes(k)) return [0.1, (c[1] - frontMid[1]) * 1.8, 0.035];
      return [0, 0, 0.06];
    }
    if (p.body === 'upper_shell_link') return [0, 0, 0.19];
    const c = centreOf(k, f);
    const off: Vec3 = [(c[0] + 0.01) * 0.75, c[1] * 0.75, (c[2] - 0.025) * 0.38];
    const push = (from: Vec3, to: Vec3, len: number) => {
      const d: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
      const l = Math.hypot(...d);
      if (l > 1e-6) for (let a = 0; a < 3; a++) off[a] += (d[a] / l) * len;
    };
    if (p.kind === 'servo' && main[k] !== k) push(centreOf(main[k], f), c, 0.03);
    if (halves[k].length === 2) push(centreOfMean(halves[k], f), c, 0.012);
    return off;
  }
  function centreOfMean(ks: number[], f: Frames): Vec3 {
    const s: Vec3 = [0, 0, 0];
    for (const j of ks) {
      const c = centreOf(j, f);
      for (let a = 0; a < 3; a++) s[a] += c[a] / ks.length;
    }
    return s;
  }
  /** Where a part waits before its step attaches: part way to its exploded place, lifted clear. */
  function waiting(k: number, f: Frames): Vec3 {
    const s = spread(k, f);
    const p = parts[k];
    if (bodyOf[k] === base) return [s[0], s[1], s[2] + 0.085];
    if (p.body === 'upper_shell_link') return [0, 0, 0.24];
    return [s[0] * 0.7, s[1] * 0.7, s[2] * 0.7 + 0.03];
  }

  // ── state ──────────────────────────────────────────────────────────────────────────────────────────
  let meshes: THREE.Mesh[] = [];
  let snapshot: SimState | null = null;
  let step = 0; // the step on screen
  const stepDone = steps.map(() => false);
  let attach: { t: number } | null = null;
  let standing: { t: number } | null = null;
  let done = false;
  let auto = false;
  let autoWait = 0;
  let explode = 0;
  let selected = -1;
  const state = new Uint8Array(parts.length);
  const fly = new Float32Array(parts.length);
  const q = new Float64Array(model.nJoints);
  const basePose = { pos: [0, 0, BASE_Z] as Vec3, quat: [1, 0, 0, 0] as [number, number, number, number] };
  let orbit = { yaw: -0.8, pitch: 0.52, dist: 1.15 };
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
    <div class="b-head"><h2 class="b-title"></h2><div class="b-count" aria-live="polite"></div></div>
    <p class="b-text"></p>
    <div class="b-try" hidden><label><span class="b-try-l"></span> <output class="b-try-v"></output><input type="range" step="0.001" /></label></div>
    <label class="b-explode"><span>Explode</span> <output>0%</output><input type="range" min="0" max="1" step="0.01" value="0" /></label>
    <div class="b-row">
      <button type="button" class="pill primary b-go"></button>
      <button type="button" class="pill b-auto">Auto-assemble</button>
      <button type="button" class="pill b-skip">Skip to play</button>
    </div>
    <p class="b-note">Not a verified manufacturing order. Part names are ours, read from each part’s shape and place: upstream names only the 41 links. Fasteners and cables are not in the published model. Tap a part to see what it is. Thanks to yishan (@tspy) and @GoMorko for showing the parts inside these meshes.</p>`;
  const card = document.createElement('aside');
  card.className = 'b-part';
  card.hidden = true;
  card.setAttribute('aria-label', 'Part');
  hud.root.parentElement!.append(panel, card);
  const $ = <T extends HTMLElement>(s: string) => panel.querySelector(s) as T;
  const dots = $('.b-dots');
  steps.forEach(() => dots.append(document.createElement('i')));
  const go = $<HTMLButtonElement>('.b-go');
  const tryBox = $('.b-try');
  const slider = tryBox.querySelector('input') as HTMLInputElement;
  const explodeIn = $('.b-explode input') as HTMLInputElement;
  const explodeOut = $('.b-explode output') as HTMLElement;
  go.addEventListener('click', () => primary());
  $('.b-auto').addEventListener('click', () => { auto = true; autoWait = 0; });
  $('.b-skip').addEventListener('click', () => finishNow(true));
  slider.addEventListener('input', () => applyTry(+slider.value));
  explodeIn.addEventListener('input', () => {
    explode = +explodeIn.value;
    explodeOut.textContent = `${Math.round(explode * 100)}%`;
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.target as HTMLElement).tagName !== 'BUTTON') { e.preventDefault(); primary(); }
  });

  function primary(): void {
    if (attach || standing) return;
    if (done) { ctx.setMode('play'); return; }
    if (!stepDone[step]) startAttach();
    else if (step < steps.length - 1) { step++; showStep(); }
    else standUp();
  }

  // ── camera ─────────────────────────────────────────────────────────────────────────────────────────
  // the aim drifts toward the step on screen (the claws are out front), whatever orbit the visitor chose
  const FOCUS: Record<BuildStep['id'], number> = { chassis: 0, face: 0.04, mid: 0, rear: -0.03, claws: 0.1, shell: 0.02 };
  let focus = 0;
  const pose = (): CamPose => {
    // aim a little below the robot so it sits above the panel; back off as it comes apart
    const at: [number, number, number] = [spot[0] + 0.02 + focus, spot[1], 0.035 - 0.075 * explode];
    // portrait screens see less sideways: step back so the legs and claws fit
    const d = orbit.dist * (1 + 0.55 * explode) * (stage.camera.aspect < 1 ? 1.45 : 1);
    return {
      eye: [at[0] + Math.cos(orbit.yaw) * Math.cos(orbit.pitch) * d, at[1] + Math.sin(orbit.yaw) * Math.cos(orbit.pitch) * d, at[2] + Math.sin(orbit.pitch) * d],
      at,
      fov: 38,
    };
  };
  const canvas = stage.renderer.domElement;
  let drag: { id: number; x: number; y: number; x0: number; y0: number; t0: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (ctx.mode !== 'build') return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now() };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId || ctx.mode !== 'build') return;
    orbit.yaw -= (e.clientX - drag.x) * 0.008;
    orbit.pitch = Math.max(0.08, Math.min(1.3, orbit.pitch + (e.clientY - drag.y) * 0.006));
    drag.x = e.clientX;
    drag.y = e.clientY;
  });
  canvas.addEventListener('pointerup', (e) => {
    // a tap (not a drag) picks the part under the pointer
    const tap = drag && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6 && performance.now() - drag.t0 < 500;
    if (tap && ctx.mode === 'build' && !document.body.classList.contains('touring')) pick(e.clientX, e.clientY);
    drag = null;
  });
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
    meshes = rig.parts();
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
    focus = 0;
    stepDone.fill(false);
    attach = null;
    standing = null;
    done = false;
    auto = false;
    explode = 0;
    explodeIn.value = '0';
    explodeOut.textContent = '0%';
    select(-1);
    q.fill(0);
    basePose.pos = [spot[0], spot[1], BASE_Z];
    rig.showParts(true);
    state.fill(HIDDEN);
    puck.position.set(spot[0], spot[1], PUCK_TOP / 2);
    puck.visible = true;
    stage.world.add(puck);
    eyes.on = false;
    ctx.snack.group.visible = world.state.snack.mode !== 'held';
    blendFrom = ctx.camPose;
    blend = 0;
    orbit = { yaw: -0.8, pitch: 0.52, dist: 1.15 };
    showStep();
    requestAnimationFrame(() => go.focus());
  }

  function leave(): void {
    select(-1);
    clearGlow();
    rig.showParts(false);
    eyes.group.position.set(0, 0, 0);
    model.json.bodies.forEach((b, i) => rig.links[i].position.set(b.pos[0], b.pos[1], b.pos[2]));
    eyes.on = true;
    ctx.snack.group.visible = true;
    stage.world.remove(puck);
    panel.hidden = true;
    hud.root.classList.remove('building');
    if (snapshot) world.restore(snapshot);
    snapshot = null;
    if (ctx.mode !== 'inspect') ctx.frozen = false; // straight on to Inspect: it has just frozen the game itself
    blendFrom = pose();
    leaving = 1;
  }

  // ── steps ──────────────────────────────────────────────────────────────────────────────────────────
  function showStep(): void {
    for (const k of steps[step].beats.flat()) if (state[k] === HIDDEN) state[k] = WAITING;
    render();
  }

  function startAttach(): void {
    attach = { t: 0 };
    clearGlow();
    tryBox.hidden = true;
    render();
  }

  function standUp(): void {
    standing = { t: 0 };
    tryBox.hidden = true;
    render();
  }

  function finishNow(thenPlay: boolean): void {
    stepDone.fill(true);
    state.fill(PLACED);
    step = steps.length - 1;
    attach = null;
    standing = null;
    q.set(model.home);
    basePose.pos = [spot[0], spot[1], model.json.standZ];
    puck.visible = false;
    eyes.on = true;
    done = true;
    clearGlow();
    render();
    if (thenPlay) ctx.setMode('play');
  }

  function applyTry(v: number): void {
    const t = tries[steps[step].id];
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

  // ── the panel ──────────────────────────────────────────────────────────────────────────────────────
  function count(): void {
    let n = 0, s = 0;
    parts.forEach((p, k) => {
      if (state[k] !== PLACED) return;
      n++;
      if (p.kind === 'servo') s++;
    });
    const text = `${n} / ${parts.length} parts · ${s} / ${servoTotal} servos`;
    const el = $('.b-count');
    if (el.textContent !== text) el.textContent = text;
  }

  function render(): void {
    const s = steps[step];
    panel.dataset.busy = attach || standing ? '1' : '';
    dots.querySelectorAll('i').forEach((d, i) => (d.className = stepDone[i] ? 'done' : i === step ? 'now' : ''));
    count();
    if (done) {
      $('.b-title').textContent = 'Assembled';
      $('.b-text').textContent = `${parts.length} parts, standing in the calibrated pose: the base 106.47 mm up, all six feet level to about a thousandth of a millimetre (upstream calibration, MODEL VALUE). Slide Explode to take it apart again.`;
      go.textContent = 'Play the Snack Heist';
      tryBox.hidden = true;
      return;
    }
    $('.b-title').textContent = `${step + 1}. ${s.title}`;
    $('.b-text').textContent = s.text;
    if (attach) {
      go.textContent = 'Attaching…';
    } else if (!stepDone[step]) {
      go.textContent = `Attach the ${s.title.toLowerCase()}`;
      glowWaiting();
      tryBox.hidden = true;
    } else if (s.id === 'shell') {
      go.textContent = standing ? 'Standing up…' : 'Stand up';
    } else {
      go.textContent = 'Next step';
      const t = tries[s.id];
      if (t) {
        tryBox.hidden = false;
        (tryBox.querySelector('.b-try-l') as HTMLElement).textContent = `Try it · ${t.label}`;
        slider.min = String(Math.min(...t.range));
        slider.max = String(Math.max(...t.range));
        const v = q[jn(t.joints[0][0])];
        slider.value = String(v);
        applyTry(v);
      } else tryBox.hidden = true;
    }
  }

  // ── highlights: the waiting parts pulse; the picked part glows ─────────────────────────────────────
  const glow = new Map<THREE.Mesh, THREE.Material>(); // highlighted meshes and their own material
  function glowOn(k: number, colour: string): void {
    const m = meshes[k];
    if (!glow.has(m)) {
      glow.set(m, m.material as THREE.Material);
      m.material = (m.material as THREE.MeshStandardMaterial).clone();
    }
    const mat = m.material as THREE.MeshStandardMaterial;
    mat.emissive.set(colour);
    mat.emissiveIntensity = 0;
  }
  function glowOff(m: THREE.Mesh): void {
    const own = glow.get(m);
    if (!own) return;
    (m.material as THREE.Material).dispose();
    m.material = own;
    glow.delete(m);
  }
  function clearGlow(): void {
    for (const m of [...glow.keys()]) if (m !== meshes[selected]) glowOff(m);
  }
  function glowWaiting(): void {
    clearGlow();
    for (const k of steps[step].beats.flat()) if (state[k] === WAITING && k !== selected) glowOn(k, '#5fc4a6');
  }

  // ── tap a part ─────────────────────────────────────────────────────────────────────────────────────
  const ray = new THREE.Raycaster();
  function pick(x: number, y: number): void {
    const r = canvas.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1), stage.camera);
    const hit = ray.intersectObjects(meshes.filter((m) => m.visible), false)[0];
    select(hit ? (hit.object.userData.part as number) : -1);
  }

  function select(k: number): void {
    if (selected >= 0 && meshes[selected]) {
      const prev = selected;
      selected = -1;
      glowOff(meshes[prev]);
      if (!done && !attach && state[prev] === WAITING && stepOf[prev] === step) glowOn(prev, '#5fc4a6');
    }
    selected = k;
    if (k < 0) {
      card.hidden = true;
      return;
    }
    glowOff(meshes[k]);
    glowOn(k, '#f2a93b');
    card.innerHTML = describe(k);
    card.hidden = false;
    card.querySelector('.bp-x')!.addEventListener('click', () => select(-1));
  }

  function describe(k: number): string {
    const p = parts[k];
    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    const limb = p.body.slice(0, 2);
    const link = p.body.replace(/^(LF|RF|LM|RM|LR|RR)_/, '').replace(/_link$/, '').replace(/_/g, ' ');
    const where = p.body === 'base_link' ? 'Body · chassis' : LIMB_NAMES[limb] ? `${LIMB_NAMES[limb]} · ${link}` : `Body · ${link}`;
    const file = model.json.meshes.find((m) => m.body === p.body)!.file.split('/').pop()!;
    const lines: string[] = [];
    if (p.joint) lines.push(`Turns ${p.joint.replace('_joint', '')}, the ${jointRole(p.joint)}.`);
    if (p.note) lines.push(p.note);
    const basis = {
      servo: 'One of the model’s identical servo bodies; each is centred on its joint’s hinge axis (checked when the assets are built). Its dark colour is ours.',
      link: `Named after its upstream link, ${p.body}.`,
      shape: 'The name is ours, read from its shape and place: upstream names only the 41 links.',
      added: 'Added by JUMPER LAB: upstream’s mesh for this calf has no servo. Copied unchanged from the right rear calf, whose mesh is otherwise the same vertex for vertex.',
    }[p.basis];
    const src = p.source.copiedFrom
      ? `Copied from ${p.source.copiedFrom}.stl, piece ${p.source.piece} of ${p.source.of}`
      : `${file}, piece ${p.source.piece} of ${p.source.of}${p.source.slivers ? ` (+${p.source.slivers} sliver${p.source.slivers > 1 ? 's' : ''} merged)` : ''}`;
    return `
      <button type="button" class="bp-x" aria-label="Close">×</button>
      <div class="bp-kind ${p.kind}">${KIND_LABEL[p.kind]}</div>
      <h3>${esc(p.name)}</h3>
      <div class="bp-where">${esc(where)}</div>
      ${lines.map((l) => `<p>${esc(l)}</p>`).join('')}
      <dl>
        <dt>Size</dt><dd>${p.sizeMm.map((v) => v.toFixed(1)).join(' × ')} mm <span class="tag model">MODEL VALUE</span></dd>
        <dt>Source</dt><dd>${esc(src)} · ${p.source.tris.toLocaleString('en')} triangles, ${p.count.toLocaleString('en')} drawn</dd>
      </dl>
      <p class="bp-basis">${esc(basis)}</p>`;
  }

  // ── per frame: pose the rig and place every part ───────────────────────────────────────────────────
  let frames: Frames | null = null;
  ctx.hooks.frame.push((dtReal) => {
    if (ctx.mode !== 'build') {
      if (leaving > 0) leaving = Math.max(0, leaving - dtReal / 0.6);
      return;
    }
    const dt = dtReal * ctx.timeScale;
    blend = Math.min(1, blend + dtReal / 0.8);
    focus += ((done ? 0.02 : FOCUS[steps[step].id]) - focus) * Math.min(1, dtReal * 2.5);
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (auto && !attach && !standing && !done) {
      autoWait += dt;
      if (autoWait > (stepDone[step] ? 0.35 : 0.15)) { autoWait = 0; primary(); }
    }
    if (attach) {
      attach.t += dt;
      const beats = steps[step].beats;
      const beat = reduce ? 0 : BEAT;
      const flight = reduce ? 0.05 : beats.length === 1 ? 0.75 : FLIGHT;
      let all = true;
      beats.forEach((ks, b) => {
        const u = Math.max(0, Math.min(1, (attach!.t - b * beat) / flight));
        for (const k of ks) {
          fly[k] = u;
          state[k] = u >= 1 ? PLACED : u > 0 ? FLYING : WAITING;
          if (u < 1) all = false;
        }
      });
      count();
      if (all) {
        stepDone[step] = true;
        if (steps[step].id === 'face') eyes.on = true;
        attach = null;
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
      basePose.pos = [spot[0], spot[1], Math.max(z0, liftFor(z0))];
      puck.position.x = spot[0] - 0.42 * Math.max(0, e - 0.75) * 4;
      puck.visible = e < 0.999;
      if (u >= 1) {
        standing = null;
        done = true;
        render();
      }
    }

    rig.setPose(basePose, q);
    frames = forward(model, { pos: [0, 0, 0], quat: [1, 0, 0, 0] }, q, frames ?? undefined);
    const f = frames;
    for (let k = 0; k < parts.length; k++) {
      const m = meshes[k];
      const s = state[k];
      m.visible = s !== HIDDEN;
      if (s === HIDDEN) continue;
      let off: Vec3;
      if (s === PLACED) {
        if (explode <= 0) { m.position.set(0, 0, 0); continue; }
        off = spread(k, f).map((v) => v * explode) as Vec3;
      } else {
        const w = waiting(k, f);
        const k1 = s === FLYING ? 1 - easeOutBack(fly[k]) : 1;
        off = w.map((v) => v * k1) as Vec3;
      }
      const local = applyT3(f.R[bodyOf[k]], off);
      m.position.set(local[0], local[1], local[2]);
    }
    // the eyes are drawn on the display module: they travel with it
    eyes.group.position.copy(meshes[displayPart].position);
    // pulse the waiting parts, hold the picked one
    const pulse = reduce ? 0.4 : 0.35 + 0.3 * Math.sin(performance.now() / 260);
    for (const [mesh] of glow) (mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = mesh === meshes[selected] ? 0.55 : pulse;
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
