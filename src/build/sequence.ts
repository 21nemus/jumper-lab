// The Build order: an educational assembly sequence over the robot's 92 parts (not a verified manufacturing
// order). Steps group the parts a visitor attaches with one press; within a step, parts fly in beat by beat,
// and a left/right pair shares a beat. Plain data, resolved against robot.json and checked by the tests.

import type { RobotJson } from '../robot/model.ts';

export interface BuildStep {
  id: 'chassis' | 'face' | 'mid' | 'rear' | 'claws' | 'shell';
  title: string;
  text: string;
  /** Indices into robot.json `parts`; each inner list flies in together. */
  beats: number[][];
}

type Pick = [link: string, part: string];

const LEG: Pick[] = [
  ['hip', 'Hip swing servo'],
  ['hip', 'Hip shell'],
  ['thigh', 'Hip lift servo'],
  ['thigh', 'Thigh bracket, lower half'],
  ['thigh', 'Thigh bracket, upper half'],
  ['calf', 'Knee servo'],
  ['calf', 'Calf shell'],
  ['foot_tip', 'Foot tip'],
];

const ARM: Pick[] = [
  ['shoulder', 'Shoulder swing servo'],
  ['shoulder', 'Shoulder shell, rear half'],
  ['shoulder', 'Shoulder shell, front half'],
  ['upper_arm', 'Arm roll servo'],
  ['upper_arm', 'Upper-arm shell, lower half'],
  ['upper_arm', 'Upper-arm shell, upper half'],
  ['forearm', 'Elbow servo'],
  ['forearm', 'Forearm bracket, lower half'],
  ['forearm', 'Forearm bracket, upper half'],
  ['palm', 'Wrist servo'],
  ['palm', 'Palm shell'],
  ['palm_pad_b', 'Palm pad (b)'],
  ['palm_pad_f', 'Palm pad (f)'],
  ['palm_grip_insert', 'Palm grip insert'],
  ['finger', 'Finger servo'],
  ['finger', 'Servo mount ring'],
  ['finger', 'Finger frame'],
  ['finger', 'Finger cover'],
  ['finger_grip_insert', 'Finger grip insert'],
  ['finger_tip', 'Fingertip'],
];

const CHASSIS: string[][] = [
  ['Chassis frame'],
  ['Mounting plate'],
  ['Front tray'],
  ['Long box'],
  ['Rear bracket'],
  ['Rear board'],
  ['Multi-pin connector'],
  ['Small connector'],
  ['Push button'],
  ['Small pin'],
  ['Rear corner bracket, left', 'Rear corner bracket, right'],
  ['Front corner piece 1', 'Front corner piece 2', 'Front corner piece 3', 'Front corner piece 4'],
];

export function buildSteps(json: RobotJson): BuildStep[] {
  const index = new Map(json.parts.map((p, i) => [`${p.body}:${p.name}`, i]));
  const at = (body: string, name: string): number => {
    const i = index.get(`${body}:${name}`);
    if (i === undefined) throw new Error(`build sequence: no part "${name}" on ${body}`);
    return i;
  };
  const pair = (sides: [string, string], picks: Pick[]) => picks.map(([link, name]) => sides.map((s) => at(`${s}_${link}_link`, name)));
  const servos = (beats: number[][]) => beats.flat().filter((i) => json.parts[i].kind === 'servo').length;
  const steps: BuildStep[] = [
    {
      id: 'chassis',
      title: 'Chassis',
      text: 'The base holds the parts every limb hangs from: a frame, a plate with cups for the servos, a long box, and a rear board with its connectors.',
      beats: CHASSIS.map((names) => names.map((n) => at('base_link', n))),
    },
    {
      id: 'face',
      title: 'Face and senses',
      text: 'The display module sits behind the visor. The depth sensor (54 × 42 points) and the camera go just below it.',
      beats: [[at('display_module_link', 'Display module')], [at('tof_sensor_link', 'Depth sensor')], [at('camera_link', 'Camera module')]],
    },
    {
      id: 'mid',
      title: 'Middle legs',
      text: '',
      beats: pair(['LM', 'RM'], LEG),
    },
    {
      id: 'rear',
      title: 'Rear legs',
      text: 'The rear pair is the same leg again. Their hips can swing far back (to 158°), more than the middle pair’s.',
      beats: pair(['LR', 'RR'], LEG),
    },
    {
      id: 'claws',
      title: 'Claw arms',
      text: '',
      beats: pair(['LF', 'RF'], ARM),
    },
    {
      id: 'shell',
      title: 'Shell',
      text: 'The red upper shell closes the body. Then the robot stands up from its zero pose into the calibrated standing pose, all six feet level.',
      beats: [[at('upper_shell_link', 'Upper shell')]],
    },
  ];
  const mid = steps[2], claws = steps[4];
  mid.text = `Each walking leg is ${LEG.length} parts around ${servos(mid.beats) / 2} servos: a hip that swings, a thigh and a calf that lift and fold, and a foot tip.`;
  claws.text = `Each front limb is ${ARM.length} parts and ${servos(claws.beats) / 2} servos: shoulder, roll, elbow, wrist and the finger that closes the claw. In walking it is also a foot.`;
  return steps;
}
