// The heads-up display: mode switch, mission card, timer, the claw button, touch controls, toasts and the
// credit line. Plain DOM; every control is a real <button> reachable by keyboard.

import { holdButton, mountJoystick, type Controls } from '../input/controls.ts';

export type Mode = 'play' | 'build' | 'inspect';

export interface HudRefs {
  root: HTMLElement;
  modeButtons: Record<Mode, HTMLButtonElement>;
  timer: HTMLElement;
  mission: HTMLElement;
  missionGoal: HTMLElement;
  stepSnack: HTMLElement;
  stepDish: HTMLElement;
  counters: HTMLElement;
  claw: HTMLButtonElement;
  freeze: HTMLButtonElement;
  reset: HTMLButtonElement;
  watch: HTMLButtonElement;
  menu: HTMLButtonElement;
  toast: HTMLElement;
  approx: HTMLButtonElement;
  touch: HTMLElement;
  legend: HTMLElement;
  overlay: HTMLElement;
}

export const isTouch = (): boolean => matchMedia('(pointer: coarse)').matches;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
}
function btn(cls: string, label: string, aria?: string): HTMLButtonElement {
  const b = h('button', cls, label);
  b.type = 'button';
  if (aria) b.setAttribute('aria-label', aria);
  return b;
}

export function mountHud(app: HTMLElement, controls: Controls): HudRefs {
  const root = h('div', 'hud');

  const top = h('header', 'top');
  const brand = h('div', 'brand', '<b>JUMPER LAB</b><span>Build a crab. Steal a snack.</span>');
  const modes = h('nav', 'modes');
  modes.setAttribute('aria-label', 'Mode');
  const modeButtons = {} as Record<Mode, HTMLButtonElement>;
  for (const [m, label] of [['play', 'Play'], ['build', 'Build'], ['inspect', 'Inspect']] as [Mode, string][]) {
    const b = btn('mode', label);
    b.dataset.mode = m;
    b.setAttribute('aria-pressed', 'false');
    modeButtons[m] = b;
    modes.append(b);
  }
  const right = h('div', 'top-right');
  const timer = h('span', 'timer', '0:00.0');
  timer.setAttribute('aria-label', 'Mission time');
  const watch = btn('pill watch', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg><span>Watch</span>', 'Watch the guided tour (T)');
  watch.title = 'Watch the guided tour (T)';
  const menu = btn('icon menu', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg>', 'Menu: modes, sources and settings');
  right.append(timer, watch, menu);
  top.append(brand, modes, right);

  const mission = h('section', 'mission');
  mission.setAttribute('aria-label', 'Mission');
  mission.innerHTML = `<div class="m-title">Snack Heist</div>`;
  const missionGoal = h('div', 'm-goal', 'Walk to the stand, grab the oat cube with a claw, drop it in the mint dish.');
  const steps = h('div', 'm-steps');
  const stepSnack = h('span', 'm-step', '<i></i>Grab the snack');
  const stepDish = h('span', 'm-step', '<i></i>Drop it in the dish');
  steps.append(stepSnack, stepDish);
  const counters = h('div', 'm-counters', '');
  mission.append(missionGoal, steps, counters);

  const toast = h('div', 'toast');
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');

  const actions = h('div', 'actions');
  const claw = btn('act claw', '<span class="k">Space</span><span class="l">Grab</span>', 'Claw: grab or drop');
  const freeze = btn('act freeze', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7"/></svg><span class="l">Freeze</span>', 'Freeze and inspect');
  const reset = btn('act small reset', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5v14M19 6l-9 6 9 6z"/></svg>', 'Reset the mission');
  actions.append(reset, freeze, claw);

  const touch = h('div', 'touch');
  mountJoystick(touch, controls);
  const turns = h('div', 'turns');
  const tl = btn('turn', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 7H5V3M5.6 7A8 8 0 1 1 4 12"/></svg>', 'Turn left');
  const tr = btn('turn', '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 7h4V3M18.4 7A8 8 0 1 0 20 12"/></svg>', 'Turn right');
  holdButton(tl, (d) => controls.setTurn(d ? 1 : 0));
  holdButton(tr, (d) => controls.setTurn(d ? -1 : 0));
  turns.append(tl, tr);
  touch.append(turns);

  const bottom = h('footer', 'bottom');
  const approx = btn('chip approx', 'Kinematic walk · game approximation');
  const legend = h('span', 'legend', '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> walk &amp; crab-step · <kbd>Q</kbd><kbd>E</kbd> turn · <kbd>Space</kbd> claw · <kbd>F</kbd> freeze · <kbd>R</kbd> reset');
  const credit = h('span', 'credit', 'Based on <a href="https://github.com/KingKongRobotics/jumper" target="_blank" rel="noopener">KingKong Robotics’ Jumper</a> (Apache-2.0) · independent · by <a href="https://x.com/21nemus" target="_blank" rel="noopener">@21nemus</a>');
  bottom.append(approx, legend, credit);

  const overlay = h('div', 'overlay');

  root.append(top, mission, toast, touch, actions, bottom);
  app.append(root, overlay);
  return { root, modeButtons, timer, mission, missionGoal, stepSnack, stepDish, counters, claw, freeze, reset, watch, menu, toast, approx, touch, legend, overlay };
}

let toastTimer = 0;
export function showToast(hud: HudRefs, text: string, ms = 2600, tone: 'info' | 'good' | 'warn' = 'info'): void {
  hud.toast.textContent = text;
  hud.toast.dataset.tone = tone;
  hud.toast.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => hud.toast.classList.remove('on'), ms);
}

export function formatTime(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}
