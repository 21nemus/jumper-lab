// Keyboard, touch and gamepad -> one Input. Keys are ignored while the user types into a form field, and
// browser shortcuts (Ctrl/Cmd + key) pass through untouched.

import type { Command } from '../sim/robot.ts';

export type Action = 'claw' | 'freeze' | 'reset' | 'pause' | 'build' | 'play' | 'sources' | 'wave' | 'depth' | 'tour';

const MOVE: Record<string, [keyof Command, number]> = {
  KeyW: ['fwd', 1], ArrowUp: ['fwd', 1],
  KeyS: ['fwd', -1], ArrowDown: ['fwd', -1],
  KeyA: ['left', 1], KeyD: ['left', -1],
  KeyQ: ['turn', 1], ArrowLeft: ['turn', 1], KeyJ: ['turn', 1],
  KeyE: ['turn', -1], ArrowRight: ['turn', -1], KeyL: ['turn', -1],
};
const ACTIONS: Record<string, Action> = {
  Space: 'claw', Enter: 'claw', KeyF: 'freeze', KeyI: 'freeze', KeyR: 'reset', Escape: 'pause', KeyB: 'build', KeyP: 'play', KeyH: 'wave', KeyV: 'depth', KeyT: 'tour',
};

function typing(e: Event): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

export class Controls {
  private keys = new Set<string>();
  private stick: [number, number] = [0, 0]; // touch joystick: x right, y up
  private turnHeld = 0;
  private queue: Action[] = [];
  private padPrev: boolean[] = [];
  enabled = true;
  onAction: (a: Action) => void = () => {};

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (!this.enabled || typing(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.code in MOVE) {
        this.keys.add(e.code);
        e.preventDefault();
      } else if (e.code in ACTIONS && !e.repeat) {
        // Space/Enter on a focused button already click it; don't fire twice.
        const onButton = (e.target as HTMLElement | null)?.closest?.('button, a, [role="button"]');
        if ((e.code === 'Space' || e.code === 'Enter') && onButton) return;
        e.preventDefault();
        this.fire(ACTIONS[e.code]);
      }
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.release());
    document.addEventListener('visibilitychange', () => document.hidden && this.release());
  }

  fire(a: Action): void {
    this.queue.push(a);
    this.onAction(a);
  }
  takeActions(): Action[] {
    const q = this.queue;
    this.queue = [];
    return q;
  }
  release(): void {
    this.keys.clear();
    this.stick = [0, 0];
    this.turnHeld = 0;
  }
  setStick(x: number, y: number): void {
    this.stick = [x, y];
  }
  setTurn(v: number): void {
    this.turnHeld = v;
  }

  command(): Command {
    const c: Command = { fwd: 0, left: 0, turn: 0 };
    for (const k of this.keys) {
      const [axis, v] = MOVE[k];
      c[axis] += v;
    }
    c.fwd += this.stick[1];
    c.left += -this.stick[0];
    c.turn += this.turnHeld;
    this.pollPad(c);
    c.fwd = Math.max(-1, Math.min(1, c.fwd));
    c.left = Math.max(-1, Math.min(1, c.left));
    c.turn = Math.max(-1, Math.min(1, c.turn));
    return c;
  }

  private pollPad(c: Command): void {
    const pads = navigator.getGamepads?.() ?? [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const dz = (v: number) => (Math.abs(v) < 0.15 ? 0 : (v - Math.sign(v) * 0.15) / 0.85);
      c.fwd += -dz(p.axes[1] ?? 0);
      c.left += -dz(p.axes[0] ?? 0);
      c.turn += -dz(p.axes[2] ?? 0);
      const map: [number, Action][] = [[0, 'claw'], [3, 'freeze'], [8, 'reset'], [9, 'pause']];
      for (const [b, a] of map) {
        const down = !!p.buttons[b]?.pressed;
        if (down && !this.padPrev[b]) this.fire(a);
        this.padPrev[b] = down;
      }
      break;
    }
  }
}

/** A thumb joystick for touch screens. Writes into Controls.setStick; never captures mouse input. */
export function mountJoystick(host: HTMLElement, controls: Controls): HTMLElement {
  const pad = document.createElement('div');
  pad.className = 'stick';
  pad.setAttribute('aria-hidden', 'true');
  const knob = document.createElement('div');
  knob.className = 'stick-knob';
  pad.append(knob);
  host.append(pad);
  let id: number | null = null;
  let cx = 0, cy = 0;
  const R = 48;
  const move = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    let dx = e.clientX - cx, dy = e.clientY - cy;
    const l = Math.hypot(dx, dy);
    if (l > R) { dx = (dx / l) * R; dy = (dy / l) * R; }
    knob.style.transform = `translate(${dx}px, ${dy}px)`;
    const nx = dx / R, ny = -dy / R;
    const mag = Math.hypot(nx, ny);
    const k = mag < 0.12 ? 0 : (mag - 0.12) / 0.88 / (mag || 1);
    controls.setStick(nx * k, ny * k);
  };
  const end = (e: PointerEvent) => {
    if (e.pointerId !== id) return;
    id = null;
    knob.style.transform = '';
    controls.setStick(0, 0);
    pad.classList.remove('active');
  };
  pad.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse') return;
    id = e.pointerId;
    const r = pad.getBoundingClientRect();
    cx = r.left + r.width / 2;
    cy = r.top + r.height / 2;
    pad.setPointerCapture(e.pointerId);
    pad.classList.add('active');
    move(e);
  });
  pad.addEventListener('pointermove', move);
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);
  return pad;
}

/** A button that reports while held (for turning on touch). */
export function holdButton(el: HTMLElement, onHold: (down: boolean) => void): void {
  const down = (e: PointerEvent) => {
    el.setPointerCapture(e.pointerId);
    el.classList.add('held');
    onHold(true);
  };
  const up = () => {
    el.classList.remove('held');
    onHold(false);
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', up);
}
