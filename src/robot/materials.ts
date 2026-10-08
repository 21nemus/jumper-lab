// Robot materials. Colours are jumper.xml's geom RGBA, read as display (sRGB) values the way MuJoCo shows
// them, so the red matches upstream renders. Finishes (gloss, clearcoat) are our art direction.

import * as THREE from 'three';

export type Finish = 'red' | 'grey' | 'silicone' | 'black';
/** A part's finish: its link's, except the servos, which get their own (our colour: upstream paints each link
 *  in one colour, servo included, and hides the servos inside the shells). */
export type PartFinish = Finish | 'servo';

export function finishOf(rgba: [number, number, number, number]): Finish {
  const [r, g, b] = rgba;
  if (r > 0.8 && g < 0.2) return 'red';
  if (r === 0 && g === 0 && b === 0) return 'black';
  if (r > 0.79) return 'silicone';
  return 'grey';
}

const srgb = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);

/** Cosmetic shell colours. Purely visual; nothing mechanical changes. */
export const SHELL_COLOURS = {
  red: { label: 'Jumper red', rgb: [0.85, 0.08, 0.05] as const, source: 'jumper.xml geom rgba' },
  cream: { label: 'Oat', rgb: [0.93, 0.89, 0.8] as const, source: 'cosmetic (ours)' },
  mint: { label: 'Mint', rgb: [0.45, 0.78, 0.66] as const, source: 'cosmetic (ours)' },
  graphite: { label: 'Graphite', rgb: [0.2, 0.21, 0.23] as const, source: 'cosmetic (ours)' },
} as const;
export type ShellColour = keyof typeof SHELL_COLOURS;

export class RobotMaterials {
  readonly red = new THREE.MeshPhysicalMaterial({
    color: srgb(0.85, 0.08, 0.05),
    roughness: 0.34,
    metalness: 0,
    clearcoat: 0.8,
    clearcoatRoughness: 0.16,
  });
  readonly grey = new THREE.MeshPhysicalMaterial({ color: srgb(0.68, 0.7, 0.72), roughness: 0.38, metalness: 0.45 });
  readonly silicone = new THREE.MeshStandardMaterial({ color: srgb(0.816, 0.82, 0.804), roughness: 0.82, metalness: 0 });
  // Pure black reads as a hole; a near-black satin keeps the chassis' shape visible.
  readonly black = new THREE.MeshPhysicalMaterial({ color: srgb(0.035, 0.036, 0.04), roughness: 0.48, metalness: 0.1, clearcoat: 0.35, clearcoatRoughness: 0.4 });

  // The servo bodies only show when the robot is taken apart (Build); a dark satin keeps them apart from the shells.
  readonly servo = new THREE.MeshPhysicalMaterial({ color: srgb(0.2, 0.21, 0.23), roughness: 0.38, metalness: 0.35 });

  get(f: PartFinish): THREE.Material {
    return this[f];
  }
  setShell(c: ShellColour): void {
    const [r, g, b] = SHELL_COLOURS[c].rgb;
    this.red.color.copy(srgb(r, g, b));
  }
  all(): THREE.Material[] {
    return [this.red, this.grey, this.silicone, this.black, this.servo];
  }
}
