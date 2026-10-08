// The two round expression displays (HARDWARE.md: 2 x 0.9-inch round TFTs). The published mesh models the
// face as one black visor, so the discs are placed on its front surface at +-24 mm. What they show is OUR
// animation layer, not the robot's software, and says nothing about what the robot understands.

import * as THREE from 'three';
import type { RobotRig } from './rig.ts';

export type Expression = 'idle' | 'focus' | 'happy' | 'oops' | 'off' | 'wave';

const SIZE = 128;

export class Eyes {
  readonly group = new THREE.Group();
  private readonly ctx: CanvasRenderingContext2D[] = [];
  private readonly tex: THREE.CanvasTexture[] = [];
  private expr: Expression = 'idle';
  private look: [number, number] = [0, 0];
  private lastDraw = -1;
  private blinkAt = 2.5;
  private shown = true;
  /** Whether the displays show anything. Changing it redraws at once, even while the simulation clock is
   *  frozen (Build). */
  get on(): boolean {
    return this.shown;
  }
  set on(v: boolean) {
    if (v === this.shown) return;
    this.shown = v;
    this.lastDraw = -1;
  }

  constructor(rig: RobotRig) {
    const link = rig.links[rig.model.body('display_module_link')];
    const normal = new THREE.Vector3(0.855, 0, 0.519);
    for (const side of [1, -1]) {
      const c = document.createElement('canvas');
      c.width = c.height = SIZE;
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      const disc = new THREE.Mesh(
        new THREE.CircleGeometry(0.0106, 40),
        new THREE.MeshBasicMaterial({ map: t, transparent: true, toneMapped: false, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
      );
      disc.position.set(0.0104, side * 0.024, -0.0012).addScaledVector(normal, 0.0006);
      disc.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
      // keep the texture's "up" pointing up the face
      disc.rotateZ(Math.PI / 2);
      disc.renderOrder = 3;
      this.group.add(disc);
      this.ctx.push(c.getContext('2d')!);
      this.tex.push(t);
    }
    link.add(this.group);
  }

  set(expr: Expression): void {
    if (expr !== this.expr) {
      this.expr = expr;
      this.lastDraw = -1;
    }
  }
  /** Gaze in [-1,1]^2: x to the robot's left, y up. */
  gaze(x: number, y: number): void {
    const nx = Math.max(-1, Math.min(1, x)), ny = Math.max(-1, Math.min(1, y));
    if (Math.abs(nx - this.look[0]) + Math.abs(ny - this.look[1]) > 0.04) {
      this.look = [this.look[0] + (nx - this.look[0]) * 0.35, this.look[1] + (ny - this.look[1]) * 0.35];
      this.lastDraw = -1;
    }
  }

  /** t: simulation time (keeps blinking deterministic for the tour). */
  update(t: number): void {
    let blink = 0;
    if (t > this.blinkAt) {
      const u = (t - this.blinkAt) / 0.16;
      blink = u < 1 ? Math.sin(u * Math.PI) : 0;
      if (u >= 1) this.blinkAt = t + 2.6 + ((Math.sin(t * 12.9898) * 43758.5453) % 1 + 1) % 1 * 2.4;
    }
    const key = Math.round(t * 30);
    if (key === this.lastDraw && blink === 0) return;
    this.lastDraw = key;
    this.ctx.forEach((g, i) => draw(g, this.on ? this.expr : 'off', this.look, blink, i === 0 ? 1 : -1, t));
    for (const tx of this.tex) tx.needsUpdate = true;
  }
}

function draw(g: CanvasRenderingContext2D, expr: Expression, look: [number, number], blink: number, side: number, t: number): void {
  const S = SIZE, c = S / 2;
  g.clearRect(0, 0, S, S);
  if (expr === 'off') return;
  g.save();
  g.translate(c + look[0] * -12, c - look[1] * 10);
  g.fillStyle = '#e6fff6';
  g.strokeStyle = '#e6fff6';
  g.shadowColor = 'rgba(120,255,210,0.85)';
  g.shadowBlur = 14;
  g.lineCap = 'round';
  if (expr === 'happy') {
    g.lineWidth = 16;
    g.beginPath();
    g.arc(0, 20, 36, Math.PI * 1.15, Math.PI * 1.85);
    g.stroke();
  } else if (expr === 'oops') {
    g.lineWidth = 9;
    g.beginPath();
    for (let a = 0; a < Math.PI * 3.2; a += 0.15) {
      const r = 4 + a * 3.2;
      const x = Math.cos(a + t * 6) * r, y = Math.sin(a + t * 6) * r;
      a === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
    }
    g.stroke();
  } else {
    const h = (expr === 'focus' ? 20 : 42) * (1 - blink * 0.92);
    const w = expr === 'focus' ? 38 : 28;
    const lift = expr === 'wave' ? -4 * side : 0;
    g.beginPath();
    g.ellipse(0, lift, w, Math.max(2, h), 0, 0, Math.PI * 2);
    g.fill();
    if (h > 8) {
      g.shadowBlur = 0;
      g.fillStyle = 'rgba(20,40,34,0.55)';
      g.beginPath();
      g.ellipse(9, lift - h * 0.36, 7, 7, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.restore();
}
