// JUMPER LAB: boots the stage, loads the robot, runs the fixed-step simulation and keeps the HUD in sync.

import * as THREE from 'three';
import { loadRobot } from '../robot/loader.ts';
import { RobotRig } from '../robot/rig.ts';
import type { RobotModel } from '../robot/model.ts';
import { Stage, toThree } from '../scene/stage.ts';
import { buildRoom, fadeOccluders, type Room } from '../scene/room.ts';
import { shapeDistance } from '../sim/course.ts';
import { ReachRing, SnackMesh } from '../scene/props.ts';
import { applyCamera, FollowCamera, type CamPose } from '../scene/camera.ts';
import { Controls, type Action } from '../input/controls.ts';
import { formatTime, isTouch, mountHud, showToast, type HudRefs, type Mode } from '../ui/hud.ts';
import { DT, World, type Input, type Reach, type SimEvent } from '../sim/world.ts';
import { mat3ToQuat, rpyToMat3 } from '../sim/math.ts';
import { CORNER } from '../sim/course.ts';
import { store } from './store.ts';
import type { Autopilot } from '../sim/autopilot.ts';
import { mountInspector } from '../inspect/inspector.ts';
import { Eyes } from '../robot/eyes.ts';
import { DepthInset } from '../scene/depth.ts';
import { mountBuild } from '../build/build.ts';
import { mountMenu, readSettings, type Settings } from '../ui/menu.ts';
import { mountTour, type Tour } from '../tour/tour.ts';

const params = new URLSearchParams(location.search);
import type { ClipData } from '../sim/clip.ts';

export interface AppContext {
  stage: Stage;
  hud: HudRefs;
  controls: Controls;
  world: World;
  model: RobotModel;
  rig: RobotRig;
  room: Room;
  snack: SnackMesh;
  follow: FollowCamera;
  depth: DepthInset;
  camPose: CamPose;
  mode: Mode;
  frozen: boolean;
  setMode(m: Mode): void;
  /** Hooks other features register (inspect, build, tour). */
  hooks: {
    frame: ((dt: number) => void)[];
    mode: ((m: Mode, prev: Mode) => void)[];
    event: ((e: SimEvent) => void)[];
    camera: (() => CamPose | null)[];
  };
  input: { override: Input | null };
  /** When set, a scripted driver feeds the sim through the same input path a player uses. */
  pilot: Autopilot | null;
  /** Simulation speed multiplier (the tour uses it, and shows it while it is above 1). */
  timeScale: number;
  /** Resolves once the recorded gestures are loaded (or failed to load). */
  clipsReady: Promise<void>;
}

export async function startApp(app: HTMLElement): Promise<AppContext | null> {
  const canvas = document.createElement('canvas');
  canvas.className = 'stage';
  canvas.setAttribute('aria-label', 'The Jumper robot in a sunlit room corner');
  canvas.tabIndex = -1;
  app.append(canvas);

  let stage: Stage;
  try {
    stage = new Stage({ canvas, background: '#efe6d8', shadowMapSize: isTouch() ? 1024 : 2048, antialias: !isTouch() || devicePixelRatio < 2 });
  } catch {
    fatal(app, 'This needs WebGL', 'Your browser could not start 3D graphics. Try a recent Chrome, Safari, Firefox or Edge, or enable hardware acceleration.');
    return null;
  }
  stage.pixelRatioCap = isTouch() ? 1.75 : 2;
  stage.scene.fog = new THREE.Fog('#efe6d8', 3.2, 9);

  const controls = new Controls();
  const hud = mountHud(app, controls);
  hud.root.classList.add('booting');
  const room = buildRoom(CORNER);
  stage.world.add(room.group);

  // first paint: the room, framed from the start position, while the robot downloads
  const follow = new FollowCamera(canvas);
  follow.snap(CORNER.start);
  const resize = () => {
    stage.resize(app.clientWidth, app.clientHeight);
    follow.portrait = app.clientHeight > app.clientWidth * 1.1;
  };
  window.addEventListener('resize', resize);
  resize();
  let camPose = follow.update(0, CORNER.start, false);
  applyCamera(stage.camera, camPose);
  stage.aimSun([0, 0, 0]);
  stage.render();

  const loading = document.createElement('div');
  loading.className = 'loading';
  loading.innerHTML = '<div class="msg">Unpacking the crab…</div><div class="bar"><i></i></div>';
  hud.overlay.append(loading);
  const bar = loading.querySelector('i') as HTMLElement;
  const msg = loading.querySelector('.msg') as HTMLElement;

  let loaded: Awaited<ReturnType<typeof loadRobot>>;
  for (;;) {
    try {
      // dev only: ?failload exercises the failed-download path
      const base = import.meta.env.DEV && params.has('failload') ? './assets/robot-missing/' : './assets/robot/';
      loaded = await loadRobot(base, (f, label) => {
        bar.style.width = `${Math.round(f * 100)}%`;
        msg.textContent = label === 'Ready' ? 'Ready' : `${label}…`;
      });
      break;
    } catch (err) {
      console.error(err);
      const retry = await new Promise<boolean>((resolve) => {
        loading.innerHTML = '';
        const c = card('The robot did not load', 'The 3D model could not be downloaded. Check your connection and try again.', [['Try again', true]], resolve);
        hud.overlay.append(c);
      });
      hud.overlay.innerHTML = '';
      hud.overlay.append(loading);
      if (!retry) return null;
    }
  }
  loading.remove();
  hud.root.classList.remove('booting');

  const model = loaded.model;
  const world = new World(model, CORNER);
  const rig = new RobotRig(model, loaded.geometries);
  stage.world.add(rig.root);
  const snack = new SnackMesh(CORNER.snackSize);
  stage.world.add(snack.group);
  const eyes = new Eyes(rig);
  const depth = new DepthInset(rig, hud.root.parentElement!);
  const standRing = new ReachRing(0.06);
  standRing.mesh.position.set(CORNER.stand.c[0], CORNER.stand.c[1], standRing.mesh.position.z);
  const dishRing = new ReachRing(0.11);
  dishRing.mesh.position.set(CORNER.dish.c[0], CORNER.dish.c[1], dishRing.mesh.position.z);
  stage.world.add(standRing.mesh, dishRing.mesh);

  const ctx: AppContext = {
    stage, hud, controls, world, model, rig, room, snack, follow, depth, camPose, mode: 'play', frozen: false,
    setMode: (m) => setMode(m),
    hooks: { frame: [], mode: [], event: [], camera: [] },
    input: { override: null },
    pilot: null,
    timeScale: 1,
    clipsReady: Promise.resolve(),
  };

  // ── modes ────────────────────────────────────────────────────────────────────────────────────────────
  function setMode(m: Mode): void {
    const prev = ctx.mode;
    if (m === prev) return;
    ctx.mode = m;
    for (const [k, b] of Object.entries(hud.modeButtons)) b.setAttribute('aria-pressed', String(k === m));
    for (const f of ctx.hooks.mode) f(m, prev);
  }
  for (const [m, b] of Object.entries(hud.modeButtons)) b.addEventListener('click', () => setMode(m as Mode));
  hud.modeButtons.play.setAttribute('aria-pressed', 'true');

  // ── actions ──────────────────────────────────────────────────────────────────────────────────────────
  let pendingClaw = false;
  let tour: Tour | null = null; // mounted below
  const act = (a: Action) => {
    if (a === 'tour') {
      if (tour) tour.running() ? tour.stop() : tour.start();
    } else if (a === 'depth') {
      depth.enabled = !depth.enabled;
      showToast(hud, depth.enabled ? 'Synthetic depth view on: rendered scene depth at the dToF’s pose, not sensor data.' : 'Depth view off.', 2600);
    } else if (a === 'wave' && ctx.mode === 'play' && !ctx.frozen) {
      if (!world.play('hello')) showToast(hud, 'Gestures play when Jumper stands still with empty claws.', 2400);
    } else if (a === 'claw' && ctx.mode === 'play' && !ctx.frozen) pendingClaw = true;
    else if (a === 'freeze') setMode(ctx.mode === 'inspect' ? 'play' : 'inspect');
    else if (a === 'reset') resetMission();
    else if (a === 'build') setMode('build');
    else if (a === 'play') setMode('play');
    else if (a === 'pause' && ctx.mode !== 'play') setMode('play');
  };
  controls.onAction = act;
  hud.claw.addEventListener('click', () => act('claw'));
  hud.freeze.addEventListener('click', () => act('freeze'));
  hud.reset.addEventListener('click', () => act('reset'));
  hud.watch.addEventListener('click', () => act('tour'));
  hud.approx.addEventListener('click', () =>
    showToast(
      hud,
      world.state.clip
        ? 'This gesture is KingKong’s own recording, played back joint for joint. The body position is solved from the feet.'
        : 'The walk is a kinematic game controller on the real joints and limits, not a physics simulation or a trained policy.',
      5200,
    ),
  );

  function resetMission(): void {
    world.reset();
    follow.snap(world.state.robot);
    hud.overlay.innerHTML = '';
    lastStatus = 'ready';
    syncHud(true);
    if (ctx.mode !== 'play') setMode('play');
  }

  // ── events ───────────────────────────────────────────────────────────────────────────────────────────
  let lastStatus = 'ready';
  const onEvent = (e: SimEvent) => {
    switch (e.kind) {
      case 'hint': showToast(hud, e.text, 3000); break;
      case 'attached': showToast(hud, `Got it: the ${e.arm === 'LF' ? 'left' : 'right'} claw closed on 40 mm, finger at ${Math.abs(world.kit.holdAngle(e.arm) * 57.3).toFixed(0)}°.`, 2800, 'good'); break;
      case 'carrying': showToast(hud, 'Carrying: walking on five feet now.', 2600); break;
      case 'bump': break;
      case 'missed': showToast(hud, 'Missed the dish. The snack goes back on its stand (miss +1).', 2800, 'warn'); break;
      case 'delivered': onDelivered(e.time); break;
      case 'arm-home': if (world.state.mission.status === 'delivered') world.play('salute'); break;
    }
    for (const f of ctx.hooks.event) f(e);
  };

  function onDelivered(t: number): void {
    const trial = settings.trial;
    const best = store.get<number>('best:corner:v1');
    // a scripted run (the guided tour) never counts as a best time
    const isBest = trial && !ctx.pilot && (best === null || t < best);
    if (isBest) store.set('best:corner:v1', t);
    const s = world.state.mission;
    window.setTimeout(() => {
      if (ctx.mode !== 'play' || ctx.pilot) return;
      hud.overlay.innerHTML = '';
      const c = card(
        isBest ? 'Snack secured · new best' : 'Snack secured',
        'The oat cube is in the dish. No neural network was involved: you drove the real joint tree, and the claw reached with the roll of Jumper’s documented arm-out pose and carried in its documented stow.',
        trial ? [['Play again', 'again'], ['Freeze & look at the claw', 'inspect']] : [['Play again', 'again'], ['Try a time trial', 'trial'], ['Freeze & look at the claw', 'inspect']],
        (v) => {
          hud.overlay.innerHTML = '';
          if (v === 'again') resetMission();
          else if (v === 'trial') { settings.trial = true; applySettings(settings); resetMission(); }
          else if (v === 'inspect') setMode('inspect');
        },
      );
      const stats = document.createElement('div');
      stats.className = 'stat';
      stats.innerHTML = `<div><b>${formatTime(t)}</b><span>time</span></div><div><b>${s.bumps}</b><span>bumps</span></div><div><b>${s.misses}</b><span>misses</span></div>${trial ? `<div><b>${formatTime(isBest ? t : best!)}</b><span>best</span></div>` : ''}`;
      c.querySelector('h2')!.after(stats);
      hud.overlay.append(c);
    }, 1400);
  }

  // ── settings (shell colour, calm / time trial) ───────────────────────────────────────────────────────
  const settings = readSettings();
  function applySettings(s: Settings): void {
    rig.materials.setShell(s.shell);
    hud.timer.hidden = !s.trial;
    store.set('settings', s);
  }
  applySettings(settings);

  // ── HUD sync ─────────────────────────────────────────────────────────────────────────────────────────
  let reach: Reach = { grab: null, drop: null };
  let reachTick = 0;
  function syncHud(force = false): void {
    const s = world.state;
    hud.timer.textContent = formatTime(s.mission.time);
    const carrying = s.claw.phase === 'carrying' || s.snack.mode === 'held';
    const delivered = s.mission.status === 'delivered';
    hud.stepSnack.classList.toggle('done', carrying || delivered || s.snack.where === 'dish');
    hud.stepSnack.classList.toggle('now', !carrying && !delivered);
    hud.stepDish.classList.toggle('done', delivered);
    hud.stepDish.classList.toggle('now', carrying && !delivered);
    const counters = s.mission.bumps || s.mission.misses ? `${s.mission.bumps} bump${s.mission.bumps === 1 ? '' : 's'} · ${s.mission.misses} miss${s.mission.misses === 1 ? '' : 'es'}` : '';
    if (hud.counters.textContent !== counters || force) hud.counters.textContent = counters;
    const busy = s.claw.phase === 'grabbing' || s.claw.phase === 'releasing' || s.claw.waiting;
    const label = s.claw.phase === 'carrying' || s.claw.phase === 'releasing' ? 'Drop' : 'Grab';
    const state = busy ? 'busy' : reach.grab || reach.drop ? 'ready' : 'off';
    const l = hud.claw.querySelector('.l')!;
    if (l.textContent !== label) l.textContent = label;
    hud.claw.dataset.state = state;
  }

  // ── loop ─────────────────────────────────────────────────────────────────────────────────────────────
  let acc = 0;
  let last = performance.now();
  let frameEma = 16;
  let slow = 0, fast = 0;
  const robotPose = () => {
    const r = world.state.robot;
    return { pos: [r.x, r.y, r.z] as [number, number, number], quat: mat3ToQuat(rpyToMat3(r.roll, r.pitch, r.yaw)) };
  };

  // ── eyes and the motion label ────────────────────────────────────────────────────────────────────────
  let approxText = '';
  function updateEyes(): void {
    const s = world.state;
    const r = s.robot;
    const clip = s.clip?.name;
    eyes.set(
      s.mission.status === 'delivered' && (clip === 'salute' || s.claw.phase !== 'foot') ? 'happy'
        : r.wobble && r.wobble.t < 0.7 ? 'oops'
        : s.claw.phase === 'grabbing' || s.claw.phase === 'releasing' || s.claw.waiting ? 'focus'
        : clip === 'hello' ? 'wave'
        : 'idle',
    );
    // glance at the snack when it is close, otherwise look ahead
    const dx = s.snack.p[0] - r.x, dy = s.snack.p[1] - r.y;
    const d = Math.hypot(dx, dy);
    if (d < 1.3 && s.snack.mode !== 'held') {
      const a = Math.atan2(dy, dx) - r.yaw;
      eyes.gaze(Math.sin(a) * 1.6, 0.15);
    } else eyes.gaze(0, 0);
    eyes.update(s.t);
    const text = clip ? `Recorded motion · KingKong “${world.clips.get(clip)?.title ?? clip}”` : 'Kinematic walk · game approximation';
    if (text !== approxText) {
      approxText = text;
      hud.approx.textContent = text;
      hud.approx.classList.toggle('recorded', !!clip);
    }
  }

  // Recorded gestures load after the robot; the intro wave plays while Jumper waits for its first command.
  ctx.clipsReady = Promise.all(['hello', 'bow', 'salute', 'paw'].map((n) => fetch(`./assets/motions/${n}.json`).then((r) => (r.ok ? (r.json() as Promise<ClipData>) : null)).catch(() => null))).then((list) => {
    for (const c of list) if (c) world.clips.set(c.name, c);
    window.setTimeout(() => {
      if (ctx.mode === 'play' && world.state.mission.status === 'ready' && !ctx.pilot && !params.has('tour') && !params.has('capture')) world.play('hello');
    }, 700);
  });

  function simStep(): void {
    const input: Input = ctx.pilot ? ctx.pilot.next(world, DT) : ctx.input.override ?? { cmd: controls.command(), action: pendingClaw };
    pendingClaw = false;
    for (const e of world.step(input)) onEvent(e);
  }

  let devHold = false; // dev only: freeze the live loop so a script can step frames exactly
  function frame(now: number): void {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!devHold) advanceFrame(dt, now);
    requestAnimationFrame(frame);
  }

  function advanceFrame(dt: number, now: number): void {
    if (ctx.mode === 'play' && !ctx.frozen) {
      acc += dt * ctx.timeScale;
      let n = 0;
      while (acc >= DT && n < 8 * Math.max(1, Math.ceil(ctx.timeScale))) {
        simStep();
        acc -= DT;
        n++;
      }
      if (acc >= DT) acc = 0;
    } else {
      controls.takeActions();
      acc = 0;
    }
    present(dt, now);
  }

  function present(dt: number, now: number): void {
    const s = world.state;
    if (s.mission.status !== lastStatus) lastStatus = s.mission.status;

    // reach rings (a few times per second is plenty)
    if (++reachTick % 4 === 0 && ctx.mode === 'play') {
      reach = world.reach();
      const r = s.robot;
      const near = (c: [number, number]) => Math.hypot(c[0] - r.x, c[1] - r.y) < 0.75;
      standRing.set(s.snack.mode === 'stand' && s.claw.phase === 'foot' ? (reach.grab ? 2 : near(CORNER.stand.c) ? 1 : 0) : 0);
      dishRing.set(s.claw.phase === 'carrying' ? (reach.drop ? 2 : near(CORNER.dish.c) ? 1 : 0) : 0);
    }
    standRing.update(dt, now / 1000);
    dishRing.update(dt, now / 1000);

    rig.setPose(robotPose(), s.robot.q);
    snack.sync(s.snack);
    updateEyes();

    // camera: a feature may take over (inspect, tour); otherwise follow
    let pose: CamPose | null = null;
    for (const f of ctx.hooks.camera) pose = pose ?? f();
    if (!pose) {
      const moving = Math.hypot(s.robot.v[0], s.robot.v[1]) > 0.01 || Math.abs(s.robot.v[2]) > 0.05;
      // the current target: the snack while it sits on its stand, the dish once it has been picked up
      const t = s.snack.mode === 'stand' ? CORNER.stand.c : CORNER.dish.c;
      const focus = Math.hypot(t[0] - s.robot.x, t[1] - s.robot.y) < 0.8 ? ([t[0], t[1], 0.075] as [number, number, number]) : null;
      pose = follow.update(dt, s.robot, moving, focus);
    }
    ctx.camPose = pose;
    applyCamera(stage.camera, pose);
    stage.aimSun([s.robot.x, s.robot.y, 0], pose.eye);
    fadeOccluders(room, pose.eye, [pose.at[0], pose.at[1], Math.max(0.06, pose.at[2])], dt, (sh, p) => shapeDistance(sh, p).d);

    for (const f of ctx.hooks.frame) f(dt);
    syncHud();
    stage.render();
    depth.render(stage);

    // adaptive resolution
    frameEma = frameEma * 0.95 + dt * 1000 * 0.05;
    if (frameEma > 24) { slow += dt; fast = 0; } else if (frameEma < 13) { fast += dt; slow = 0; } else { slow = 0; fast = 0; }
    if (slow > 1.5 && stage.pixelRatioCap > 1) {
      stage.pixelRatioCap = Math.max(1, stage.pixelRatioCap - 0.25);
      resize();
      slow = 0;
    } else if (fast > 5 && stage.pixelRatioCap < Math.min(2, devicePixelRatio)) {
      stage.pixelRatioCap = Math.min(2, stage.pixelRatioCap + 0.25);
      resize();
      fast = 0;
    }
  }

  mountInspector(ctx);
  mountBuild(ctx, eyes);
  const showcase = mountTour(ctx);
  tour = showcase;
  mountMenu(ctx, settings, applySettings, () => showcase.start(false));
  if (params.has('tour') || params.has('capture')) window.setTimeout(() => showcase.start(params.has('capture')), 900);

  follow.snap(world.state.robot);
  syncHud(true);
  requestAnimationFrame(frame);
  if (import.meta.env.DEV) {
    const { Autopilot, CORNER_RUN } = await import('../sim/autopilot.ts');
    (window as unknown as { __jl: unknown }).__jl = {
      ctx,
      autopilot: () => (ctx.pilot = new Autopilot(CORNER_RUN)),
      /** Step the simulation synchronously (works while the tab is hidden), then draw one frame. */
      advance: (seconds: number, until?: (s: typeof world.state) => boolean) => {
        for (let i = 0; i < seconds / DT; i++) {
          simStep();
          if (until?.(world.state)) break;
        }
        present(1 / 60, performance.now());
        return world.state;
      },
      present: () => present(1 / 60, performance.now()),
      hold: (on: boolean) => (devHold = on),
      /** Run whole frames at a fixed rate (the same code path as requestAnimationFrame). */
      frames: (seconds: number, fps = 60, until?: () => boolean) => {
        const dt = 1 / fps;
        let now = performance.now();
        for (let i = 0; i < seconds * fps; i++) {
          now += dt * 1000;
          advanceFrame(dt, now);
          if (until?.()) break;
        }
      },
    };
  }
  return ctx;
}

export function card<T>(title: string, text: string, buttons: [string, T][], onPick: (v: T) => void): HTMLElement {
  const c = document.createElement('div');
  c.className = 'card';
  c.setAttribute('role', 'dialog');
  c.setAttribute('aria-label', title);
  const h = document.createElement('h2');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = text;
  const row = document.createElement('div');
  row.className = 'row';
  buttons.forEach(([label, v], i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `pill${i === 0 ? ' primary' : ''}`;
    b.textContent = label;
    b.addEventListener('click', () => onPick(v));
    row.append(b);
  });
  c.append(h, p, row);
  requestAnimationFrame(() => (row.querySelector('button') as HTMLButtonElement | null)?.focus());
  return c;
}

function fatal(app: HTMLElement, title: string, text: string): void {
  const o = document.createElement('div');
  o.className = 'overlay';
  o.append(card(title, text, [], () => {}));
  app.append(o);
}

export { toThree };
