// The crab rave, put together: the original music, the hero's choreography in the simulation (held on the
// beat), the crowd scuttling in to dance around it, party lights, and a camera out front. Start it from the
// Gestures menu, the C key, the card after a delivery, or the guided tour's finale. Moving, the claw button,
// freezing or building interrupt it the way they interrupt any gesture: the crowd scuttles off, the music
// fades.

import type { AppContext } from './app.ts';
import { Crowd, PartyLights } from '../scene/crowd.ts';
import { blendPose, type CamPose } from '../scene/camera.ts';
import { dancerPose, planRave, type RavePlan } from '../sim/rave.ts';
import { RAVE_BEATS, RAVE_BPM, type ScuttleCycle } from '../sim/dance.ts';
import type { ClipData } from '../sim/clip.ts';
import { showToast } from '../ui/hud.ts';

const BEAT = 60 / RAVE_BPM;
const END = RAVE_BEATS.setup + RAVE_BEATS.dance + RAVE_BEATS.outro;

export interface Rave {
  /** Start the crab rave (from a click or key press, so the music may play). False if Jumper can't now. */
  start(): boolean;
  /** Cut it short: the crowd leaves, the music fades. `now`: everything gone this frame (the tour's reset). */
  stop(now?: boolean): void;
  /** Rave beats since the hero started dancing (negative while it waits for the bar line), or null. */
  beat(): number | null;
  active(): boolean;
}

export function mountRave(ctx: AppContext): Rave {
  const { world, stage, hud, music } = ctx;
  const crowd = new Crowd(ctx.model);
  stage.world.add(crowd.group);
  const party = new PartyLights(stage);
  let cycle: ScuttleCycle | null = null;
  let loading: Promise<void> | null = null;
  let plan: RavePlan | null = null;
  let hero: [number, number] = [0, 0];
  let beat0 = 0; // song beat at which the hero's dance starts
  let state: 'off' | 'waiting' | 'dancing' | 'leaving' = 'off';
  let cut = Infinity; // rave beat at which it was cut short
  let cam = 0; // 0 the usual camera .. 1 the rave camera
  let camFrom: CamPose | null = null;
  let lastBeat = 0;

  const load = () =>
    (loading ??= Promise.all([
      crowd.load('./assets/robot/jumper-crowd.glb'),
      fetch('./assets/motions/scuttle.json')
        .then((r) => r.json() as Promise<ScuttleCycle>)
        .then((c) => {
          cycle = c;
        }),
    ])
      .then(() => undefined)
      .catch(() => undefined)); // no crowd then; the hero still dances

  /** The rave's beat: the song's while it plays; after it has faded, the wall clock carries on. */
  const raveBeat = (dt = 0): number => {
    const song = music.beat();
    return song !== null ? song - beat0 : lastBeat + dt / BEAT;
  };

  function start(): boolean {
    if (state !== 'off') return false;
    // a recorded gesture still playing (the salute after a delivery) is cut short for the rave
    const clip = world.state.clip;
    const gesture = !!clip && clip.name !== 'rave';
    if (!world.clips.has('rave') || !world.canPlay(gesture) || ctx.mode !== 'play') {
      showToast(hud, 'The crab rave starts when Jumper stands still with empty claws.', 2600);
      return false;
    }
    if (gesture && clip && !clip.out) clip.out = { t: 0, dur: 0.35, q: [...world.state.robot.q], z: world.state.robot.z, roll: world.state.robot.roll, pitch: world.state.robot.pitch };
    void load();
    const r = world.state.robot;
    hero = [r.x, r.y];
    plan = planRave(world.course, { x: r.x, y: r.y, yaw: r.yaw }, 7);
    // build (stance, claws up) - drop (the dance) - outro (claws down), on the song's bar lines
    beat0 = music.play([[0, 'build'], [8, 'drop'], [40, 'outro'], [48, 'stop']]);
    state = 'waiting';
    cut = Infinity;
    camFrom = ctx.camPose;
    cam = 0;
    lastBeat = -1;
    return true;
  }

  function stop(now = false): void {
    if (state === 'off') return;
    if (now) {
      state = 'off';
      cam = 0;
      crowd.show([]);
      music.stop(1.2);
      return;
    }
    const b = raveBeat();
    if (world.state.clip?.name === 'rave' && !world.state.clip.out) world.state.clip.out = { t: 0, dur: 0.6, q: [...world.state.robot.q], z: world.state.robot.z, roll: world.state.robot.roll, pitch: world.state.robot.pitch };
    cut = Math.min(cut, b);
    if (state === 'waiting') state = 'leaving';
    music.stop(1.2);
  }

  function dancers(b: number) {
    if (!plan || !cycle || !crowd.ready) return [];
    const rave = world.clips.get('rave') as ClipData;
    const out = [];
    for (const d of plan.dancers) {
      const pose = dancerPose(cut < Infinity ? { ...d, leave: Math.min(d.leave, cut) } : d, b, rave, cycle);
      if (pose) out.push({ pose, shell: d.shell });
    }
    return out;
  }

  ctx.hooks.frame.push((dt) => {
    const on = state !== 'off';
    if (on) {
      const b = raveBeat(dt);
      lastBeat = b;
      const clip = world.state.clip;
      if (state === 'waiting' && b >= 0) {
        if (ctx.mode === 'play' && !ctx.frozen && world.play('rave')) state = 'dancing';
        else if (!(world.state.clip?.out && b < 1.5)) stop(); // (a gesture blending out: start a little late)
      } else if (state === 'dancing') {
        if (clip?.name === 'rave' && !clip.out) {
          // hold the dance on the music's beat: nudge its speed, or jump if it is far off (after a freeze)
          if (ctx.mode === 'play' && !ctx.frozen) {
            const err = Math.max(0, b * BEAT) - clip.t;
            if (Math.abs(err) > 0.3) clip.t = Math.max(0, b * BEAT);
            else clip.speed = Math.max(0.9, Math.min(1.1, 1 + err * 1.5));
          }
        } else {
          // the dance ended, or was cut short (moved, pressed the claw)
          if (b < END - 1) {
            cut = Math.min(cut, b);
            music.stop(1.2);
          }
          state = 'leaving';
        }
      }
      const shown = dancers(b);
      crowd.show(ctx.mode === 'build' ? [] : shown);
      if (state === 'leaving' && shown.length === 0 && (b > Math.min(cut, END) + 1 || !crowd.ready)) {
        state = 'off';
        crowd.show([]);
      }
    }
    // the rave camera eases in and back out
    cam = Math.max(0, Math.min(1, cam + (state === 'off' ? -dt / 1.2 : dt / 1.4)));
    party.update(dt, state === 'waiting' || state === 'dancing', lastBeat, plan ? plan.at : [hero[0], hero[1], 0.12]);
  });

  function raveCam(b: number): CamPose {
    const p = plan!;
    const swing = 0.14 * Math.sin((2 * Math.PI * b) / 32); // a slow sway around the hero
    const dx = p.eye[0] - hero[0], dy = p.eye[1] - hero[1];
    const c = Math.cos(swing), s = Math.sin(swing);
    const portrait = stage.camera.aspect < 1;
    return { eye: [hero[0] + c * dx - s * dy, hero[1] + s * dx + c * dy, p.eye[2] + (portrait ? 0.12 : 0)], at: p.at, fov: portrait ? 64 : 44 };
  }

  ctx.hooks.camera.push(() => {
    if (!plan || ctx.mode !== 'play' || cam <= 0) return null;
    const pose = raveCam(lastBeat);
    if (state !== 'off') return camFrom && cam < 1 ? blendPose(camFrom, pose, cam) : pose;
    // on the way out, back to the follow camera
    const r = world.state.robot;
    const follow = ctx.follow.update(1 / 60, r, false, null);
    return blendPose(follow, pose, cam);
  });

  return {
    start,
    stop,
    beat: () => (state === 'off' ? null : raveBeat()),
    active: () => state !== 'off',
  };
}
