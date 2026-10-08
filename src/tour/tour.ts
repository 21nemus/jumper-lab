// The guided showcase (~60 s, deterministic, framed for a 16:9 screen recording). It drives the real app
// through the controls a visitor has: KingKong's recorded wave, the Build panel's own buttons and its claw
// slider, the mission through the autopilot's stick and claw inputs, a real freeze whose panel chips are
// pressed one by one, the depth view and the delivery. Captions and a few camera moves are layered on top;
// nothing is a canned clip. While it plays only the captions and the live Build and Inspect panels show, the
// pointer hides when idle, and sped-up stretches say so.

import * as THREE from 'three';
import type { AppContext } from '../app/app.ts';
import { Autopilot, TOUR_RUN } from '../sim/autopilot.ts';
import { RAVE_BEATS } from '../sim/dance.ts';
import { blendPose, type CamPose } from '../scene/camera.ts';
import { fromThree } from '../scene/stage.ts';
import type { Vec3 } from '../sim/math.ts';
import './tour.css';

interface Shot {
  name: string;
  caption?: [string, string?];
  start(): void;
  /** Returns true when the shot is over. */
  update(dt: number, t: number): boolean;
  camera?(t: number): CamPose | null;
}

export interface Tour {
  start(capture?: boolean): void;
  stop(): void;
  running(): boolean;
}

const ease = (u: number) => {
  const c = Math.max(0, Math.min(1, u));
  return c * c * (3 - 2 * c);
};

/** Run each action once, when the shot's clock passes its time. */
function cues(list: [number, () => void][]): (t: number) => void {
  let i = 0;
  return (t) => {
    while (i < list.length && t >= list[i][0]) list[i++][1]();
  };
}

export function mountTour(ctx: AppContext): Tour {
  const { world, hud, model, rig } = ctx;
  let shots: Shot[] = [];
  let i = -1;
  let t = 0;
  let camFrom: CamPose | null = null;
  let camBlend = 1;
  let active = false;
  let idle = 0;
  let elapsed = 0;

  const host = hud.root.parentElement!;
  const cap = document.createElement('div');
  cap.className = 'tour-cap';
  cap.setAttribute('aria-live', 'polite');
  cap.innerHTML = '<div class="tc-line"></div><div class="tc-sub"></div><div class="tc-speed"></div>';
  const end = document.createElement('div');
  end.className = 'tour-end';
  end.innerHTML = '<div class="te-title">JUMPER LAB</div><div class="te-line">Build a crab. Steal a snack.</div><div class="te-credit">A playable lab built on KingKong Robotics’ open Jumper · by @21nemus</div>';
  const stopBtn = document.createElement('button');
  stopBtn.type = 'button';
  stopBtn.className = 'pill tour-stop';
  stopBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>Stop tour <kbd>Esc</kbd>';
  stopBtn.addEventListener('click', () => stop());
  host.append(cap, end, stopBtn);
  const speed = cap.querySelector('.tc-speed') as HTMLElement;

  function caption(line: string, sub = ''): void {
    (cap.querySelector('.tc-line') as HTMLElement).textContent = line;
    (cap.querySelector('.tc-sub') as HTMLElement).textContent = sub;
    cap.classList.toggle('on', !!line);
  }

  // Esc or T stops the tour; moving the pointer brings the stop button back for a moment.
  window.addEventListener(
    'keydown',
    (e) => {
      if (!active || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code === 'Escape' || e.code === 'KeyT') {
        e.preventDefault();
        e.stopImmediatePropagation();
        stop();
      }
    },
    true,
  );
  window.addEventListener('pointermove', () => {
    idle = 0;
    document.body.classList.remove('tour-idle');
  });

  const pilotFrom = (from: number, to: number) => new Autopilot(TOUR_RUN.slice(from, to));
  const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
  const press = (sel: string) => $<HTMLButtonElement>(sel)?.click();
  /** Scroll on the scene, as a visitor zooms: positive backs the camera off. */
  const zoom = (notches: number) => {
    const canvas = ctx.stage.renderer.domElement;
    for (let k = 0; k < Math.abs(notches); k++) canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: Math.sign(notches) * 100 * Math.min(1, Math.abs(notches) - k), cancelable: true }));
  };
  const standCam = (): CamPose => ({ eye: [1.99, 0.25, 0.25], at: [1.66, 0.5, 0.085], fov: 31 });
  const faceCam = (): CamPose => ({ eye: [0.56, -0.27, 0.18], at: [0.05, -0.07, 0.085], fov: 34 });

  /** Where a robot link is right now (model frame), from the rendered rig. */
  const v = new THREE.Vector3();
  const linkAt = (name: string): Vec3 => fromThree(rig.links[model.body(name)].getWorldPosition(v));

  function build(): Shot[] {
    // Build: press the panel's own buttons; stop on the claw arm to sweep its slider.
    let wait = 0, sweep = -1, tried = false, doneAt = -1, near = 0;
    let claw: Vec3 = [0, 0, 0]; // the left claw as Build mode poses it (read after Build has posed the rig)
    // The finale: the crab rave once Jumper stands in the middle of the room.
    let raving = false, endAt = -1;
    // Freeze: the inspect panel's chips, pressed on a timeline once frozen.
    let frozeAt = -1;
    let inspectCues: (t: number) => void = () => {};

    return [
      {
        name: 'hello',
        caption: ['Meet Jumper', 'KingKong’s open-source crab robot: 22 servos, and two claws that are also feet'],
        start() {
          ctx.setMode('play');
          world.reset();
          ctx.follow.snap(world.state.robot);
          ctx.timeScale = 1;
          world.play('hello', 1);
        },
        update: (_dt, tt) => tt > 5.4 || (!world.state.clip && tt > 0.5),
        camera: () => faceCam(),
      },
      {
        name: 'build',
        caption: ['Build it', 'KingKong’s real parts, snapped on module by module'],
        start() {
          ctx.timeScale = 1;
          ctx.setMode('build');
          wait = 0.7;
          sweep = -1;
          tried = false;
          doneAt = -1;
          near = 0;
        },
        update(dt, tt) {
          claw = linkAt('LF_finger_link');
          const title = $('.b-title')?.textContent ?? '';
          const go = $<HTMLButtonElement>('.b-go');
          const tryBox = $('.b-try');
          near += ((sweep >= 0 ? 1 : 0) - near) * Math.min(1, dt * 3);
          if (sweep >= 0) {
            // the claw's own "try it" slider: wide open, shut, then half open, with the measured-aperture readout
            sweep += dt;
            const slider = tryBox.querySelector('input') as HTMLInputElement;
            const open = +slider.min, shut = +slider.max;
            const k = sweep / 2.6;
            const val = k < 0.42 ? shut + (open - shut) * ease(k / 0.42) : k < 0.78 ? open + (shut - open) * ease((k - 0.42) / 0.36) : shut + (open - shut) * 0.55 * ease((k - 0.78) / 0.22);
            slider.value = String(val);
            slider.dispatchEvent(new Event('input', { bubbles: true }));
            if (sweep >= 2.6) {
              sweep = -1;
              wait = 0.25;
              caption('Build it', 'KingKong’s real parts, snapped on module by module');
            }
            return false;
          }
          if (title === 'Assembled') {
            if (doneAt < 0) doneAt = tt;
            return tt - doneAt > 0.6;
          }
          wait -= dt;
          if (wait > 0 || !go) return false;
          if (!tried && /Claw arms/.test(title) && !tryBox.hidden) {
            tried = true;
            sweep = 0;
            caption('Try any joint', 'The claw opens 0.4 to 73.3 mm: KingKong’s measured range');
            return false;
          }
          const label = go.textContent ?? '';
          if (/Standing up/.test(label)) return false;
          go.click();
          wait = /^Attach/.test(label) ? 0.8 : 0.2; // (the snap-on animation takes 0.75 s)
          return false;
        },
        camera: (tt) => {
          // a slow orbit around the build spot; in close on the left claw while its slider moves
          const s = world.course.start;
          const az = -0.8 + 0.32 * ease(tt / 12), el = 0.5, d = 1.12;
          const wide: CamPose = {
            eye: [s.x + Math.cos(az) * Math.cos(el) * d, s.y + Math.sin(az) * Math.cos(el) * d, 0.02 + Math.sin(el) * d],
            at: [s.x + 0.01, s.y, 0.0],
            fov: 40,
          };
          if (near < 0.01) return wide;
          // at the zero pose the left claw points straight out to the side and its finger hinges about the forward
          // axis, so it swings up and down: watch it in profile from just in front
          const f = claw;
          const close: CamPose = { eye: [f[0] + 0.36, f[1] + 0.06, f[2] + 0.075], at: [f[0], f[1] + 0.035, f[2] - 0.004], fov: 30 };
          return blendPose(wide, close, near);
        },
      },
      {
        name: 'walk',
        caption: ['Walk it like a crab', 'The real joints and limits; the gait itself is this game’s, not physics'],
        start() {
          ctx.music.play([[0, 'groove']]);
          ctx.setMode('play');
          world.reset();
          ctx.follow.snap(world.state.robot);
          ctx.pilot = pilotFrom(0, 4);
          ctx.timeScale = 2.3;
        },
        update: () => !!ctx.pilot?.done,
      },
      {
        name: 'grab',
        caption: ['Grab with the real claw', 'Its documented arm-out roll; the finger stops at the measured 40 mm opening'],
        start() {
          ctx.pilot = pilotFrom(4, 7);
          ctx.timeScale = 1;
        },
        update: () => world.state.claw.phase === 'carrying' || !!ctx.pilot?.done,
        camera: () => standCam(),
      },
      {
        name: 'freeze',
        caption: ['Freeze it, anytime', 'Every joint: its live angle, its limits and its source'],
        start() {
          ctx.pilot = pilotFrom(7, 8);
          ctx.timeScale = 1.5;
          frozeAt = -1;
          inspectCues = cues([
            [2.4, () => {
              press('.inspect [data-view="shell"]');
              caption('Take it apart', 'Shell off, exploded or isolated: the same frozen moment');
            }],
            [4.4, () => {
              press('.inspect [data-view="exploded"]');
              zoom(2.2); // back off a little so the spread-out parts fit
            }],
            [6.9, () => {
              press('.inspect [data-view="isolated"]');
              zoom(-1.6);
              caption('Five joints in one claw', 'Shoulder, roll, elbow, wrist and finger, each inside its real range');
            }],
          ]);
        },
        update(_dt, tt) {
          if (frozeAt < 0) {
            if (tt > 1.3 && ctx.mode === 'play') {
              ctx.setMode('inspect');
              frozeAt = tt;
              ctx.timeScale = 1;
            }
            return false;
          }
          inspectCues(tt - frozeAt);
          return tt - frozeAt > 9.4;
        },
      },
      {
        name: 'carry',
        caption: ['Steal the snack', 'Carrying, it walks on five feet: two pairs, then the lone claw'],
        start() {
          ctx.setMode('play');
          ctx.pilot = pilotFrom(7, 15);
          ctx.timeScale = 3;
        },
        update: (_dt, tt) => tt > 3.2 && ((ctx.pilot?.i ?? 0) >= 1 || !!ctx.pilot?.done),
      },
      {
        name: 'depth',
        caption: ['See what it sees', 'Its dToF sensor’s view, 54 × 42 points: synthetic depth rendered from this room'],
        start() {
          ctx.timeScale = 1.7;
          if (!ctx.depth.enabled) ctx.controls.fire('depth');
        },
        update: (_dt, tt) => {
          const r = world.state.robot, d = world.course.dish.c;
          return tt > 6 || (tt > 4.3 && Math.hypot(d[0] - r.x, d[1] - r.y) < 0.55);
        },
      },
      {
        name: 'drop',
        caption: ['Drop it in', 'Over the dish, one press: the claw lets go'],
        start() {
          ctx.depth.enabled = false;
        },
        update: () => {
          // walk in at 2x, then the drop itself at real speed
          const c = world.state.claw;
          ctx.timeScale = c.phase === 'carrying' && !c.waiting ? 2 : 1;
          return world.state.mission.status === 'delivered' && (c.phase === 'foot' || !!ctx.pilot?.done);
        },
      },
      {
        // the finale: to the middle of the room, then the crab rave; the end card comes in over the dancing
        name: 'rave',
        caption: ['Then everybody dances', 'Our own music and choreography: claws up, balanced on four feet'],
        start() {
          hud.overlay.innerHTML = '';
          ctx.pilot = new Autopilot([{ kind: 'go', x: 0.08, y: 0.02, yaw: 0, tol: 0.05 }, { kind: 'turn', yaw: 0 }, { kind: 'until', what: 'stopped' }]);
          ctx.timeScale = 2.5;
          raving = false;
          endAt = -1;
        },
        update(_dt, tt) {
          if (!raving) {
            if (ctx.pilot?.done || tt > 7) {
              ctx.pilot = null;
              ctx.timeScale = 1;
              raving = ctx.rave.start();
              if (!raving) return true; // (can't happen on the tour's route; end rather than hang)
            }
            return false;
          }
          if (endAt < 0 && (ctx.rave.beat() ?? 0) >= RAVE_BEATS.setup + 5) {
            endAt = tt;
            end.classList.add('on');
            caption('');
          }
          return endAt >= 0 && tt - endAt > 3;
        },
      },
    ];
  }

  ctx.hooks.camera.unshift(() => {
    if (!active || i < 0 || i >= shots.length) return null;
    const shot = shots[i];
    let want = shot.camera?.(t) ?? null;
    if (!want) {
      camFrom = null;
      return null;
    }
    // portrait (9:16): keep the horizontal framing by widening the vertical field of view
    const aspect = ctx.stage.camera.aspect;
    if (aspect < 1) {
      const h = 2 * Math.atan(Math.tan((want.fov * Math.PI) / 360) * Math.min(1.9, 1.25 / aspect)) * (180 / Math.PI);
      want = { ...want, fov: Math.min(75, h) };
    }
    if (camFrom && camBlend < 1) return blendPose(camFrom, want, camBlend);
    return want;
  });

  ctx.hooks.frame.push((dt) => {
    if (!active || i < 0) return;
    hud.overlay.querySelectorAll('.card').forEach((c) => c.remove());
    t += dt;
    elapsed += dt;
    camBlend = Math.min(1, camBlend + dt / 0.9);
    idle += dt;
    if (idle > 1.6) document.body.classList.add('tour-idle');
    const x = ctx.mode === 'play' && ctx.timeScale > 1.2 ? `${(Math.round(ctx.timeScale * 10) / 10).toString()}× speed` : '';
    if (speed.textContent !== x) speed.textContent = x;
    const shot = shots[i];
    if (shot.update(dt, t)) next();
  });

  function next(): void {
    i++;
    t = 0;
    if (import.meta.env.DEV) console.debug(`[tour] ${shots[i]?.name ?? 'end'} at ${elapsed.toFixed(2)} s`);
    if (i >= shots.length) return stop();
    camFrom = ctx.camPose;
    camBlend = 0;
    const shot = shots[i];
    shot.start();
    if (shot.caption) caption(...(shot.caption as [string, string?]));
  }

  function start(capture = false): void {
    if (active) return;
    active = true;
    ctx.rave.stop(true);
    ctx.music.play([[0, 'intro']]); // from the click or key press that started the tour, so it may sound
    idle = 0;
    document.body.classList.add('touring');
    document.body.classList.toggle('capture', capture);
    hud.watch.setAttribute('aria-pressed', 'true');
    ctx.controls.release();
    ctx.controls.enabled = false;
    ctx.follow.enabled = false;
    shots = build();
    elapsed = 0;
    i = -2; // waiting for the recorded gestures
    end.classList.remove('on');
    void ctx.clipsReady.then(() => {
      if (!active) return;
      i = -1;
      next();
    });
  }

  function stop(): void {
    if (!active) return;
    active = false;
    ctx.pilot = null;
    ctx.timeScale = 1;
    caption('');
    speed.textContent = '';
    end.classList.remove('on');
    document.body.classList.remove('touring', 'capture', 'tour-idle');
    hud.watch.setAttribute('aria-pressed', 'false');
    ctx.controls.enabled = true;
    ctx.follow.enabled = true;
    ctx.depth.enabled = false;
    ctx.rave.stop(true);
    ctx.music.stop(1.6);
    if (ctx.mode !== 'play') ctx.setMode('play');
    world.reset();
    ctx.follow.snap(world.state.robot);
  }

  const api: Tour = { start, stop, running: () => active };
  if (import.meta.env.DEV) (window as unknown as { __tour: Tour }).__tour = api;
  return api;
}
