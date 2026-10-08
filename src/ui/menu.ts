// The menu: play style (calm or time trial), recorded gestures, cosmetic shell colour, the guided tour, a
// shareable setup link, and the sources and credits. Settings live in the URL fragment (shareable, validated)
// and the best time in localStorage. Nothing is sent anywhere.

import type { AppContext } from '../app/app.ts';
import { store } from '../app/store.ts';
import { SHELL_COLOURS, type ShellColour } from '../robot/materials.ts';
import { SRC, type Label } from '../data/facts.ts';
import { formatTime, showToast } from './hud.ts';
import { parseSettings, shareFragment, type Settings } from './settings-parse.ts';
import './menu.css';

export type { Settings };

/** Read settings from the URL fragment (#shell=mint&trial=1), ignoring anything unknown or malformed. */
export function readSettings(): Settings {
  return parseSettings(location.hash, store.get<unknown>('settings'));
}

function shareUrl(s: Settings): string {
  return `${location.origin}${location.pathname}#${shareFragment(s)}`;
}

const CREDITS: [string, string, string][] = [
  ['Jumper robot model, poses, gestures', 'KingKong Robotics · Apache-2.0', 'https://github.com/KingKongRobotics/jumper'],
  ['First to take Jumper’s meshes apart, part by part', 'yishan (@tspy) · Jumper Assembly Lab', 'https://jumper-assembly-lab.yishan-lin.chatgpt.site'],
  ['Pointed out the extra parts in the STLs', '@GoMorko', 'https://x.com/GoMorko'],
  ['three.js', 'three.js authors · MIT', 'https://threejs.org/'],
  ['Manrope typeface', 'The Manrope Project Authors · SIL OFL 1.1', 'https://github.com/sharanda/manrope'],
  ['JUMPER LAB code, room, props, the part split and names', '@21nemus · MIT', 'https://x.com/21nemus'],
  ['Music and the crab-rave choreography', '@21nemus · MIT, original', 'https://x.com/21nemus'],
];

const SPEC_FACTS: [Label, string, string][] = [
  ['SOURCE SPEC', '400 × 400 × 200 mm · 1.8 kg (engineering prototype 2.8 kg) · grasps up to 1 kg', SRC.hardware.url],
  ['SOURCE SPEC', '22 tactile servos · 6-axis IMU · dToF 54 × 42, 55° × 42°, 5 cm–8.8 m indoors', SRC.hardware.url],
  ['SOURCE SPEC', '2 × 0.9-inch round displays · 25.2 V 3000 mAh battery · indoor use only', SRC.hardware.url],
  ['SOURCE SPEC', 'Product page claims (not tested here): top speed ≥ 0.5 m/s, jump ≥ 400 mm, about 2 h battery', SRC.product.url],
  ['MODEL VALUE', 'Model mass 2.543 kg · standing height 106.47 mm · six feet level to about 0.001 mm', SRC.constants.url],
  ['MODEL VALUE', 'Joint axes and limits for all 22 joints, as in jumper.xml (three URDF limit errors repaired there)', SRC.xml.url],
  ['MODEL VALUE', 'Claw opening 0.4–73.3 mm (finger +0.10 to −0.65 rad), measured upstream', SRC.claw.url],
  ['MODEL VALUE', '92 parts inside the 41 link meshes: 22 servos, shells, brackets, pads and the chassis (one servo copied in where the published mesh lacks it)', SRC.meshes.url],
  ['TRAINING PARAMETER', 'Walking policies drive 20 of 22 joints; their command ranges are training settings, not speeds', SRC.deploy.url],
  ['GAME APPROXIMATION', 'Walking, speed, step timing, the claw’s reach planning, the snack, the drop and the score are this game’s', ''],
];

export function mountMenu(ctx: AppContext, settings: Settings, apply: (s: Settings) => void, startTour: () => void): void {
  const { hud, world } = ctx;
  const dlg = document.createElement('div');
  dlg.className = 'menu-dlg';
  dlg.hidden = true;
  dlg.setAttribute('role', 'dialog');
  dlg.setAttribute('aria-modal', 'true');
  dlg.setAttribute('aria-label', 'Menu');
  dlg.innerHTML = `
    <div class="mn-sheet">
      <div class="mn-head"><h2>JUMPER LAB</h2><button type="button" class="icon mn-close" aria-label="Close menu"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg></button></div>
      <section><h3>Play</h3>
        <div class="seg" role="group" aria-label="Play style">
          <button type="button" data-trial="0">Calm</button><button type="button" data-trial="1">Time trial</button>
        </div>
        <p class="mn-best"></p>
      </section>
      <section><h3>Gestures <span class="tag model">recorded by KingKong</span></h3>
        <div class="mn-row mn-gestures"></div>
        <p class="mn-small">Played joint for joint from KingKong’s recordings when Jumper stands still with empty claws.</p>
        <div class="mn-row mn-rave-row"><button type="button" class="pill primary mn-rave">Crab rave <kbd>C</kbd></button><span class="tag game">our choreography</span></div>
        <p class="mn-small">Not a KingKong recording: generated from the model on the beat of our own music. Jumper steps its middle legs forward so its centre of mass stays over its four feet with both claws up, then the crowd comes in.</p>
      </section>
      <section><h3>Sound</h3>
        <div class="mn-row mn-sound">
          <div class="seg" role="group" aria-label="Music"><button type="button" data-music="1">Music on</button><button type="button" data-music="0">Off</button></div>
          <label class="mn-vol"><span>Volume</span><input type="range" min="0" max="100" step="5" aria-label="Music volume" /><output></output></label>
        </div>
        <p class="mn-small">Original music, synthesized live in your browser (no recordings). It only plays during the guided tour and the crab rave, starts quietly and fades in. The ♪ button at the top mutes it.</p>
      </section>
      <section><h3>Shell colour <span class="tag game">cosmetic only</span></h3><div class="mn-row mn-shells"></div></section>
      <section><h3>Show me</h3>
        <div class="mn-row"><button type="button" class="pill mn-tour">Guided tour · 1 min <kbd>T</kbd></button><button type="button" class="pill mn-depth">Depth view (dToF) <kbd>V</kbd></button><button type="button" class="pill mn-share">Copy setup link</button></div>
      </section>
      <section class="mn-sources"><h3>Sources and credits</h3>
        <ul class="mn-facts"></ul>
        <p class="mn-small">Robot data from <a href="https://github.com/KingKongRobotics/jumper/tree/61d065219fca767f3142c8f10aff59eae5a5a004" target="_blank" rel="noopener">KingKongRobotics/jumper @ 61d0652</a>, retrieved 2026-10-07. This is an independent project, not an official KingKong product, not a validated digital twin and not a robot controller.</p>
        <ul class="mn-credits"></ul>
        <p class="mn-small mn-repo">Open source: <a href="https://github.com/21nemus/jumper-lab" target="_blank" rel="noopener">github.com/21nemus/jumper-lab</a></p>
        <p class="mn-small">Made by <a href="https://x.com/21nemus" target="_blank" rel="noopener">@21nemus</a> · also <a href="https://21nemus.github.io/vibe-a1-explainer/" target="_blank" rel="noopener">Inside the Vibe A1</a></p>
      </section>
    </div>`;
  hud.root.parentElement!.append(dlg);
  const $ = <T extends HTMLElement>(s: string) => dlg.querySelector(s) as T;

  $('.mn-rave').addEventListener('click', () => {
    close();
    if (ctx.mode !== 'play') ctx.setMode('play');
    ctx.controls.fire('rave');
  });
  for (const b of dlg.querySelectorAll<HTMLButtonElement>('[data-music]')) {
    b.addEventListener('click', () => {
      if ((b.dataset.music === '0') !== ctx.music.muted) ctx.controls.fire('mute');
      sync();
    });
  }
  const vol = dlg.querySelector('.mn-vol input') as HTMLInputElement;
  vol.addEventListener('input', () => {
    ctx.music.setVolume(+vol.value / 100);
    store.set('music-volume', ctx.music.volume);
    sync();
  });
  for (const [name, title] of [['hello', 'Hello'], ['bow', 'Bow'], ['salute', 'Salute'], ['paw', 'Offer a paw']]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pill';
    b.textContent = title;
    b.addEventListener('click', () => {
      close();
      if (ctx.mode !== 'play') ctx.setMode('play');
      if (!world.play(name)) showToast(hud, 'Gestures play when Jumper stands still with empty claws.', 2400);
    });
    $('.mn-gestures').append(b);
  }
  for (const [key, c] of Object.entries(SHELL_COLOURS) as [ShellColour, (typeof SHELL_COLOURS)[ShellColour]][]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.dataset.shell = key;
    b.title = c.label;
    b.setAttribute('aria-label', `${c.label} shell`);
    b.style.background = `rgb(${c.rgb.map((v) => Math.round(v * 255)).join(',')})`;
    b.addEventListener('click', () => {
      settings.shell = key;
      apply(settings);
      sync();
    });
    $('.mn-shells').append(b);
  }
  for (const b of dlg.querySelectorAll<HTMLButtonElement>('[data-trial]')) {
    b.addEventListener('click', () => {
      settings.trial = b.dataset.trial === '1';
      apply(settings);
      sync();
    });
  }
  for (const [label, text, url] of SPEC_FACTS) {
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.className = `tag ${label.split(' ')[0].toLowerCase()}`;
    t.textContent = label;
    li.append(t, document.createTextNode(' ' + text + ' '));
    if (url) {
      const a = document.createElement('a');
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'source';
      a.className = 'src';
      li.append(a);
    }
    $('.mn-facts').append(li);
  }
  for (const [what, who, url] of CREDITS) {
    const li = document.createElement('li');
    li.innerHTML = `<b></b> · <a target="_blank" rel="noopener"></a>`;
    li.querySelector('b')!.textContent = what;
    const a = li.querySelector('a')!;
    a.textContent = who;
    a.href = url;
    $('.mn-credits').append(li);
  }

  $('.mn-depth').addEventListener('click', () => {
    close();
    ctx.controls.fire('depth');
  });
  $('.mn-tour').addEventListener('click', () => {
    close();
    startTour();
  });
  $('.mn-share').addEventListener('click', async () => {
    const url = shareUrl(settings);
    try {
      await navigator.clipboard.writeText(url);
      showToast(hud, 'Setup link copied. It shares the course and the look, not a score or a replay.', 3200, 'good');
    } catch {
      prompt('Copy this link', url);
    }
  });
  $('.mn-close').addEventListener('click', () => close());
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) close();
  });
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  });
  hud.menu.addEventListener('click', () => (dlg.hidden ? open() : close()));

  let lastFocus: HTMLElement | null = null;
  function open(): void {
    lastFocus = document.activeElement as HTMLElement;
    sync();
    dlg.hidden = false;
    ctx.controls.enabled = false;
    ctx.controls.release();
    $<HTMLButtonElement>('.mn-close').focus();
  }
  function close(): void {
    dlg.hidden = true;
    ctx.controls.enabled = true;
    lastFocus?.focus?.();
  }
  function sync(): void {
    for (const b of dlg.querySelectorAll<HTMLButtonElement>('[data-music]')) b.setAttribute('aria-pressed', String((b.dataset.music === '0') === ctx.music.muted));
    vol.value = String(Math.round(ctx.music.volume * 100));
    (dlg.querySelector('.mn-vol output') as HTMLElement).textContent = `${vol.value} %`;
    for (const b of dlg.querySelectorAll<HTMLButtonElement>('[data-trial]')) b.setAttribute('aria-pressed', String((b.dataset.trial === '1') === settings.trial));
    for (const b of dlg.querySelectorAll<HTMLButtonElement>('.swatch')) b.setAttribute('aria-pressed', String(b.dataset.shell === settings.shell));
    const best = store.get<number>('best:corner:v1');
    $('.mn-best').textContent = settings.trial
      ? best !== null ? `Best on this device: ${formatTime(best)}. Times are local only.` : 'Your best time is kept on this device only.'
      : 'No clock. Take your time.';
  }
}
