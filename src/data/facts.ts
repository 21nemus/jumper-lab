// Every number the inspector shows, kept in four separate buckets and tied to where it comes from.
//   SOURCE SPEC        KingKong's published hardware sheet or product page
//   MODEL VALUE        the simulation model and upstream measurements on it (jumper.xml, constants, claw.py)
//   TRAINING PARAMETER upstream training/control settings (named as such, never presented as performance)
//   GAME APPROXIMATION choices made for this game

export type Label = 'SOURCE SPEC' | 'MODEL VALUE' | 'TRAINING PARAMETER' | 'GAME APPROXIMATION';

const REPO = 'https://github.com/KingKongRobotics/jumper/blob/61d065219fca767f3142c8f10aff59eae5a5a004/';

export interface Source {
  label: string;
  url: string;
}
export const SRC = {
  xml: { label: 'jumper.xml', url: `${REPO}assets/jumper/jumper.xml` },
  constants: { label: 'constants.py (HOME, STAND_Z)', url: `${REPO}tasks/jumper/common/constants.py` },
  claw: { label: 'claw.py (aperture table)', url: `${REPO}tasks/jumper/five_foot/claw.py` },
  hook: { label: 'deploy/lib.rs (arm presets)', url: `${REPO}tasks/jumper/five_foot/deploy/lib.rs` },
  fiveFoot: { label: 'five_foot/README.md', url: `${REPO}tasks/jumper/five_foot/README.md` },
  deploy: { label: 'deploy/README.md', url: `${REPO}deploy/README.md` },
  hardware: { label: 'HARDWARE.md', url: `${REPO}docs/HARDWARE.md` },
  motor: { label: 'motor_config.yaml', url: `${REPO}assets/jumper/motor/motor_config.yaml` },
  product: { label: 'kingkong.tech/en/jumper', url: 'https://kingkong.tech/en/jumper' },
} satisfies Record<string, Source>;

export interface Fact {
  label: Label;
  text: string;
  source?: Source;
}

export interface Concept {
  title: string;
  sentence: string;
  more: Fact[];
  source: Source;
}

/** Descriptive names for the joints (ours: upstream calls them J0..J4). */
export function jointRole(name: string): string {
  const k = +name.match(/_J(\d)_/)![1];
  const arm = name.startsWith('LF') || name.startsWith('RF');
  if (arm) return ['shoulder swing', 'arm roll', 'elbow', 'wrist', 'finger (the claw)'][k];
  return ['hip swing', 'hip lift', 'knee'][k];
}

export const LIMB_NAMES: Record<string, string> = {
  LF: 'Left claw arm',
  RF: 'Right claw arm',
  LM: 'Left middle leg',
  RM: 'Right middle leg',
  LR: 'Left rear leg',
  RR: 'Right rear leg',
  body: 'Body and sensors',
};

export function conceptFor(limb: string, carrying: string | null): Concept {
  if (limb === 'LF' || limb === 'RF') {
    if (carrying === limb) {
      return {
        title: 'Carrying means walking on five feet',
        sentence: 'With one claw holding the snack, Jumper walks on its four legs and the other claw: two pairs swing in turn, then the lone front claw steps by itself.',
        more: [
          { label: 'MODEL VALUE', text: 'Support margin on six feet: 152.0 mm. On five, with one claw carried: 92.3 mm (upstream measurement on its model).', source: SRC.fiveFoot },
          { label: 'MODEL VALUE', text: 'Upstream finds the remaining front claw cannot be lifted without the robot tipping when standing still, so in their five-foot gait it steps on its own between the two leg pairs.', source: SRC.fiveFoot },
          { label: 'GAME APPROXIMATION', text: 'Here the same 2+2+1 order is played by a kinematic controller. It shows the pattern; it does not prove balance.' },
        ],
        source: SRC.fiveFoot,
      };
    }
    return {
      title: 'A claw that is also a foot',
      sentence: 'Each front limb is a leg and a hand: walking, it stands on the rear pad of its jaw; grasping, the same five servos lift it, roll it level and close the finger.',
      more: [
        { label: 'MODEL VALUE', text: 'J0 swings the shoulder, J1 rolls the whole arm, J2 and J3 bend elbow and wrist, and only J4 moves the finger.', source: SRC.xml },
        { label: 'MODEL VALUE', text: 'Mouth opening measured upstream: 73.3 mm at finger −0.65 rad down to 0.4 mm shut at +0.10 rad. This 40 mm snack stops the finger at −0.30 rad.', source: SRC.claw },
        { label: 'MODEL VALUE', text: 'Grasp pose: upstream’s “arm straight out, thumb-web up” preset rolls J1 to −90°, which stands J0, J2 and J3 upright, so the jaws close level.', source: SRC.hook },
        { label: 'TRAINING PARAMETER', text: 'Upstream’s walking policies drive 20 of the 22 joints: both fingers (wire indices 4 and 9) are left out.', source: SRC.deploy },
      ],
      source: SRC.claw,
    };
  }
  if (limb === 'body') {
    return {
      title: 'Six feet, one calibrated stance',
      sentence: 'Jumper stands on six points, four foot tips and the rear pads of both claws, and upstream solved the standing pose so all six touch the floor together.',
      more: [
        { label: 'MODEL VALUE', text: 'Standing height of the base: 106.47 mm. Six contact points level to about 0.001 mm (upstream calibration).', source: SRC.constants },
        { label: 'MODEL VALUE', text: 'Model mass, summed over 41 parts: 2.543 kg.', source: SRC.xml },
        { label: 'SOURCE SPEC', text: 'Published weight: 1.8 kg (engineering prototype 2.8 kg). Size 400 × 400 × 200 mm.', source: SRC.hardware },
        { label: 'SOURCE SPEC', text: 'Depth sensor: dToF, 54 × 42 points, 55° × 42° field of view, 5 cm–8.8 m indoors. Two 0.9-inch round displays for expressions.', source: SRC.hardware },
        { label: 'GAME APPROXIMATION', text: 'The eyes on the face are our animation layer, not the robot’s software, and they do not mean the robot understands anything.' },
      ],
      source: SRC.constants,
    };
  }
  return {
    title: 'Three servos per leg',
    sentence: 'Each walking leg has three servos: J0 swings it around the body, and J1 and J2, turning about parallel axes, lift and fold it.',
    more: [
      { label: 'MODEL VALUE', text: 'In the standing pose the knees sit 13–14% of their range from the stop, which leaves little room to fold further: the steps in this game are only 1–2.5 cm high for that reason (measured on the model).', source: SRC.constants },
      { label: 'SOURCE SPEC', text: 'All 22 joints are KingKong “tactile servos”.', source: SRC.hardware },
      { label: 'MODEL VALUE', text: 'Upstream’s servo model: 1.75 N·m peak for up to 0.3 s, 1.2 N·m continuous. A simulation curve: no servo datasheet is published.', source: SRC.motor },
      { label: 'GAME APPROXIMATION', text: 'Step timing, stride and speed here are game settings, not hardware performance.' },
    ],
    source: SRC.xml,
  };
}
