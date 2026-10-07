// Procedural textures drawn on canvases at load: nothing to download, and every one is original.

import * as THREE from 'three';
import { rng } from '../sim/math.ts';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}
function tex(c: HTMLCanvasElement, srgb: boolean, repeat: [number, number] = [1, 1]): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat[0], repeat[1]);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Pale oak floorboards: map + roughness. One tile is 4 boards wide (0.56 m) and 2.4 m long. */
export function oakFloor(): { map: THREE.Texture; rough: THREE.Texture } {
  const W = 512, H = 1024;
  const [c, g] = canvas(W, H);
  const [rc, rg] = canvas(W / 2, H / 2);
  const r = rng(4);
  const boards = 4;
  const bw = W / boards;
  for (let b = 0; b < boards; b++) {
    const tint = 0.9 + r() * 0.16;
    const base = [203 * tint, 165 * tint, 122 * tint];
    const split = H * (0.3 + r() * 0.5);
    for (const [y0, y1] of [[0, split], [split, H]]) {
      const shade = 0.94 + r() * 0.1;
      g.fillStyle = `rgb(${base[0] * shade},${base[1] * shade},${base[2] * shade})`;
      g.fillRect(b * bw, y0, bw, y1 - y0);
      // grain: long wavy strokes
      for (let k = 0; k < 26; k++) {
        const x = b * bw + r() * bw;
        const a = 0.04 + r() * 0.07;
        g.strokeStyle = `rgba(${90 + r() * 40},${60 + r() * 25},${30},${a})`;
        g.lineWidth = 0.6 + r() * 1.6;
        g.beginPath();
        g.moveTo(x, y0);
        const amp = 2 + r() * 5, f = 0.004 + r() * 0.01, ph = r() * 6;
        for (let y = y0; y <= y1; y += 8) g.lineTo(x + Math.sin(y * f + ph) * amp, y);
        g.stroke();
      }
      // a knot now and then
      if (r() < 0.35) {
        const kx = b * bw + bw * (0.25 + r() * 0.5), ky = y0 + (y1 - y0) * r();
        const grd = g.createRadialGradient(kx, ky, 0, kx, ky, 9);
        grd.addColorStop(0, 'rgba(95,62,32,0.45)');
        grd.addColorStop(1, 'rgba(95,62,32,0)');
        g.fillStyle = grd;
        g.beginPath();
        g.ellipse(kx, ky, 6, 11, 0, 0, Math.PI * 2);
        g.fill();
      }
      // end joint
      g.fillStyle = 'rgba(70,48,28,0.55)';
      g.fillRect(b * bw, y1 - 1, bw, 2);
    }
    // board seams
    g.fillStyle = 'rgba(64,44,26,0.6)';
    g.fillRect(b * bw, 0, 1.5, H);
  }
  // roughness: boards ~0.55, seams rougher
  rg.fillStyle = 'rgb(140,140,140)';
  rg.fillRect(0, 0, W / 2, H / 2);
  for (let b = 0; b < boards; b++) {
    rg.fillStyle = 'rgb(215,215,215)';
    rg.fillRect((b * bw) / 2, 0, 1, H / 2);
  }
  for (let k = 0; k < 900; k++) {
    rg.fillStyle = `rgba(${r() < 0.5 ? 255 : 90},${r() < 0.5 ? 255 : 90},${r() < 0.5 ? 255 : 90},0.05)`;
    rg.fillRect(r() * (W / 2), r() * (H / 2), 2, 6 + r() * 30);
  }
  return { map: tex(c, true), rough: tex(rc, false) };
}

/** A large cream rug with one thin mint stripe inset from its edge (whole rug in one texture). */
export function rugMap(widthM: number, depthM: number): THREE.Texture {
  const px = 220; // pixels per metre
  const W = Math.round(widthM * px), H = Math.round(depthM * px);
  const [c, g] = canvas(W, H);
  const r = rng(9);
  g.fillStyle = '#efe6d6';
  g.fillRect(0, 0, W, H);
  // soft tonal variation
  for (let k = 0; k < 1400; k++) {
    g.fillStyle = r() < 0.5 ? 'rgba(255,252,245,0.06)' : 'rgba(205,190,165,0.05)';
    const s = 6 + r() * 26;
    g.fillRect(r() * W, r() * H, s, s);
  }
  // inset stripe: mint, thin, and a hairline of charcoal inside it
  const inset = 0.11 * px;
  g.strokeStyle = '#7fcdb3';
  g.lineWidth = 0.035 * px;
  g.strokeRect(inset, inset, W - 2 * inset, H - 2 * inset);
  g.strokeStyle = 'rgba(52,60,58,0.55)';
  g.lineWidth = 0.004 * px;
  const i2 = inset + 0.04 * px;
  g.strokeRect(i2, i2, W - 2 * i2, H - 2 * i2);
  return tex(c, true);
}

/** Bouclé loops, a small repeating bump tile. */
export function boucleBump(): THREE.Texture {
  const S = 256;
  const [c, g] = canvas(S, S);
  const r = rng(13);
  g.fillStyle = 'rgb(118,118,118)';
  g.fillRect(0, 0, S, S);
  for (let k = 0; k < 900; k++) {
    const x = r() * S, y = r() * S, rad = 2 + r() * 3.5;
    const grd = g.createRadialGradient(x - rad * 0.3, y - rad * 0.3, 0, x, y, rad);
    grd.addColorStop(0, 'rgba(255,255,255,0.75)');
    grd.addColorStop(0.7, 'rgba(160,160,160,0.4)');
    grd.addColorStop(1, 'rgba(60,60,60,0)');
    g.fillStyle = grd;
    for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) {
      g.beginPath();
      g.arc(x + dx, y + dy, rad, 0, Math.PI * 2);
      g.fill();
    }
  }
  return tex(c, false);
}

/** Warm plaster: a gentle mottled noise for walls (bump). */
export function plasterBump(): THREE.Texture {
  const S = 256;
  const [c, g] = canvas(S, S);
  const r = rng(21);
  g.fillStyle = 'rgb(128,128,128)';
  g.fillRect(0, 0, S, S);
  for (let k = 0; k < 2200; k++) {
    const v = 100 + r() * 60;
    g.fillStyle = `rgba(${v},${v},${v},0.18)`;
    const s = 1 + r() * 7;
    for (const dx of [-S, 0, S]) for (const dy of [-S, 0, S]) g.fillRect(r() * S + dx * 0, r() * S + dy * 0, s, s);
  }
  return tex(c, false);
}

/** Cream terrazzo with terracotta, sage and charcoal chips. */
export function terrazzo(): THREE.Texture {
  const S = 512;
  const [c, g] = canvas(S, S);
  const r = rng(31);
  g.fillStyle = '#ede5d8';
  g.fillRect(0, 0, S, S);
  const cols = ['#c96f4a', '#8fa58a', '#3c3f43', '#d9a77a', '#f8f4ec', '#6db8a0'];
  for (let k = 0; k < 520; k++) {
    g.fillStyle = cols[Math.floor(r() * cols.length)];
    const x = r() * S, y = r() * S, s = 2 + r() * (r() < 0.1 ? 16 : 7);
    g.beginPath();
    const n = 5 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r() * 0.5;
      const rr = s * (0.6 + r() * 0.6);
      i === 0 ? g.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr) : g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    g.closePath();
    g.fill();
  }
  return tex(c, true);
}

/** Chunky knit rows (bump), for the pouf. */
export function knitBump(): THREE.Texture {
  const W = 256, H = 256;
  const [c, g] = canvas(W, H);
  g.fillStyle = 'rgb(90,90,90)';
  g.fillRect(0, 0, W, H);
  const cols = 8, rows = 10;
  for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
    const x = (i + 0.5) * (W / cols), y = (j + 0.5) * (H / rows);
    for (const side of [-1, 1]) {
      const grd = g.createLinearGradient(x, y - 10, x, y + 10);
      grd.addColorStop(0, 'rgba(255,255,255,0.0)');
      grd.addColorStop(0.5, 'rgba(255,255,255,0.85)');
      grd.addColorStop(1, 'rgba(255,255,255,0.0)');
      g.fillStyle = grd;
      g.beginPath();
      g.ellipse(x + side * 7, y, 6, 12, side * 0.5, 0, Math.PI * 2);
      g.fill();
    }
  }
  return tex(c, false);
}

/** Basket weave (bump). */
export function weaveBump(): THREE.Texture {
  const S = 256;
  const [c, g] = canvas(S, S);
  g.fillStyle = 'rgb(100,100,100)';
  g.fillRect(0, 0, S, S);
  const n = 8, cell = S / n;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const horiz = (i + j) % 2 === 0;
    const grd = horiz ? g.createLinearGradient(0, j * cell, 0, (j + 1) * cell) : g.createLinearGradient(i * cell, 0, (i + 1) * cell, 0);
    grd.addColorStop(0, 'rgba(60,60,60,1)');
    grd.addColorStop(0.5, 'rgba(230,230,230,1)');
    grd.addColorStop(1, 'rgba(60,60,60,1)');
    g.fillStyle = grd;
    g.fillRect(i * cell + 1, j * cell + 1, cell - 2, cell - 2);
  }
  return tex(c, false);
}

/** A soft radial blob, for contact shadows under furniture. */
export function blobShadow(): THREE.Texture {
  const S = 128;
  const [c, g] = canvas(S, S);
  const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  grd.addColorStop(0, 'rgba(60,40,20,0.55)');
  grd.addColorStop(0.55, 'rgba(60,40,20,0.22)');
  grd.addColorStop(1, 'rgba(60,40,20,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
