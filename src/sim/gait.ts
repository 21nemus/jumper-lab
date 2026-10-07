// Gait patterns and timing. All of it is game tuning (GAME APPROXIMATION) except the leg groupings:
//
// - six feet: the tripod, LF/RM/LR against RF/LM/RR (upstream constants.py, the LEGS comment);
// - carrying with a claw: five feet in three groups, 2+2+1 (upstream tasks/jumper/five_foot/README.md):
//   LM+RR against RM+LR, and the front foot that is left stepping on its own.

import type { Leg } from '../robot/model.ts';

export interface GaitPattern {
  name: 'tripod' | 'five';
  period: number; // s per full cycle
  duty: number; // fraction of the cycle each foot spends planted
  groups: Leg[][]; // feet that swing together; group g starts its swing at phase g / groups.length
  swingHeight: Record<Leg, number>; // m above the planted height at mid-swing
}

const HEIGHTS: Record<Leg, number> = { LF: 0.018, RF: 0.018, LM: 0.024, RM: 0.024, LR: 0.024, RR: 0.024 };

export const TRIPOD: GaitPattern = {
  name: 'tripod',
  period: 0.62,
  duty: 0.56,
  groups: [['LF', 'RM', 'LR'], ['RF', 'LM', 'RR']],
  swingHeight: HEIGHTS,
};

export function fivePattern(carrier: 'LF' | 'RF'): GaitPattern {
  const lone: Leg = carrier === 'LF' ? 'RF' : 'LF';
  return {
    name: 'five',
    period: 0.96,
    duty: 0.7,
    groups: [['LM', 'RR'], ['RM', 'LR'], [lone]],
    swingHeight: HEIGHTS,
  };
}

/** Where a foot is in its cycle: in swing with progress s in [0,1), or planted. */
export function footPhase(p: GaitPattern, leg: Leg, phase: number): { swing: boolean; s: number } {
  const g = p.groups.findIndex((grp) => grp.includes(leg));
  if (g < 0) return { swing: false, s: 0 };
  const u = (((phase - g / p.groups.length) % 1) + 1) % 1;
  const swingFrac = 1 - p.duty;
  return u < swingFrac ? { swing: true, s: u / swingFrac } : { swing: false, s: 0 };
}

/** True when no foot of the pattern is in swing at this phase (a moment the gait may stop at). */
export function allPlanted(p: GaitPattern, phase: number): boolean {
  return p.groups.every((grp) => grp.every((leg) => !footPhase(p, leg, phase).swing));
}

/** Seconds a foot spends in swing. */
export const swingTime = (p: GaitPattern): number => (1 - p.duty) * p.period;
/** Seconds a foot spends planted. */
export const stanceTime = (p: GaitPattern): number => p.duty * p.period;

/** Vertical swing profile: zero at lift-off and touch-down, `h` at mid-swing, smooth at both ends. */
export function swingLift(s: number, h: number): number {
  const x = Math.sin(Math.PI * Math.min(1, Math.max(0, s)));
  return h * x * x * (3 - 2 * x);
}
/** Horizontal progress along the swing: eased so the foot leaves and lands gently. */
export function swingTravel(s: number): number {
  const u = Math.min(1, Math.max(0, s));
  return u * u * (3 - 2 * u);
}
