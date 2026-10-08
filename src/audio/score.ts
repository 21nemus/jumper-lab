// The score: an original, upbeat electro loop written for JUMPER LAB (MIT), in the spirit of a crab rave. It
// is NOT Noisestorm's "Crab Rave" (Monstercat) and quotes none of it: the progression is the ubiquitous
// I-V-vi-IV in C major and the lead melody is our own. Pure data, so tests can read it; src/audio/music.ts
// plays it with the Web Audio API.

export const BPM = 124; // the dance (src/sim/dance.ts) is built at this tempo
export const STEPS_PER_BAR = 16; // sixteenth notes

export type Section = 'intro' | 'groove' | 'build' | 'drop' | 'outro';

export type Hit =
  | { v: 'kick'; vel: number }
  | { v: 'clap'; vel: number }
  | { v: 'hat'; open: boolean; vel: number }
  | { v: 'bass'; note: number; steps: number }
  | { v: 'lead'; note: number; steps: number }
  | { v: 'stab'; notes: number[] }
  | { v: 'pad'; notes: number[]; steps: number }
  | { v: 'arp'; note: number; vel: number }
  | { v: 'riser'; steps: number };

/** C - G - Am - F, a bar each (MIDI notes, voiced close together). */
export const CHORDS: number[][] = [
  [60, 64, 67],
  [59, 62, 67],
  [60, 64, 69],
  [60, 65, 69],
];
const ROOTS = [36, 43, 45, 41]; // C2 G2 A2 F2

/** The lead hook: four bars of [step, MIDI note, length in steps], one bar per chord. Ours. */
const HOOK: [number, number, number][][] = [
  [[0, 76, 1], [2, 76, 1], [3, 79, 2], [6, 76, 2], [8, 74, 1], [10, 72, 1], [11, 74, 2], [14, 76, 2]],
  [[0, 74, 1], [2, 74, 1], [3, 79, 2], [6, 74, 2], [8, 79, 1], [10, 81, 1], [11, 79, 2], [14, 74, 2]],
  [[0, 72, 1], [2, 72, 1], [3, 76, 2], [6, 81, 2], [8, 79, 1], [10, 76, 1], [11, 79, 2], [14, 81, 2]],
  [[0, 81, 1], [2, 79, 1], [3, 77, 2], [6, 84, 3], [10, 81, 1], [11, 79, 1], [12, 76, 2], [14, 74, 2]],
];
/** Where the chord stabs land in a bar (an off-kilter house rhythm). */
const STABS = [0, 3, 6, 10, 12];

/** Everything that sounds on one sixteenth step of a section (`bar` counts from the section's start). */
export function hitsAt(section: Section, bar: number, step: number): Hit[] {
  const out: Hit[] = [];
  const chord = CHORDS[bar % 4];
  const root = ROOTS[bar % 4];
  const beat = step % 4 === 0;
  const offbeat = step % 4 === 2;
  const arpNotes = [chord[0], chord[1], chord[2], chord[0] + 12];

  if (section === 'intro' || section === 'outro') {
    // warm and calm: a pad, a soft arpeggio, a light tick; the outro thins out over four bars
    const fade = section === 'outro' ? Math.max(0, 1 - bar / 4) : 1;
    if (fade <= 0) return out;
    if (step === 0) out.push({ v: 'pad', notes: chord, steps: 16 });
    if (step % 2 === 0) out.push({ v: 'arp', note: arpNotes[(step / 2) % 4] + 12, vel: 0.7 * fade });
    if (offbeat) out.push({ v: 'hat', open: false, vel: 0.5 * fade });
    if (section === 'intro' && bar >= 2 && beat) out.push({ v: 'kick', vel: 0.55 });
    return out;
  }
  if (section === 'build') {
    // two bars of rising tension: kicks speed up, claps roll, a noise riser, no bass
    if (bar === 0 && step === 0) out.push({ v: 'riser', steps: 32 });
    if (step === 0) out.push({ v: 'pad', notes: chord, steps: 16 });
    if (bar === 0 ? beat : step % 2 === 0) out.push({ v: 'kick', vel: 0.75 });
    if (bar === 0 ? step === 4 || step === 12 : bar === 1 && step < 8 ? step % 2 === 0 : step >= 8) out.push({ v: 'clap', vel: bar === 1 ? 0.35 + 0.04 * (step % 8) : 0.6 });
    out.push({ v: 'arp', note: arpNotes[step % 4] + 12, vel: 0.35 + 0.4 * ((bar * 16 + step) / 32) });
    return out;
  }
  // groove and drop: four on the floor, claps on two and four, offbeat hats and bass
  if (beat) out.push({ v: 'kick', vel: 1 });
  if (step === 4 || step === 12) out.push({ v: 'clap', vel: 0.85 });
  if (offbeat) out.push({ v: 'hat', open: section === 'drop', vel: 0.8 });
  else if (step % 2 === 1) out.push({ v: 'hat', open: false, vel: 0.35 });
  if (offbeat || (step === 15 && bar % 2 === 1)) out.push({ v: 'bass', note: root + (step === 15 ? 12 : 0), steps: 2 });
  if (section === 'groove') {
    if (step === 0) out.push({ v: 'pad', notes: chord, steps: 16 });
    out.push({ v: 'arp', note: arpNotes[step % 4] + 12, vel: 0.45 });
  } else {
    if (STABS.includes(step)) out.push({ v: 'stab', notes: chord.map((n) => n + 12) });
    for (const [s, note, len] of HOOK[bar % 4]) if (s === step) out.push({ v: 'lead', note, steps: len });
  }
  return out;
}

/** Seconds per sixteenth step. */
export const STEP_SEC = 60 / BPM / 4;
/** The default music volume (0..1): 75 %, of an already quiet master level. */
export const DEFAULT_VOLUME = 0.75;
/** Fade-in when the music starts (s): it never starts at full level. */
export const FADE_IN = 3;
