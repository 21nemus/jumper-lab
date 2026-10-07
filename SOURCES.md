# Sources and provenance

Everything about the robot in JUMPER LAB comes from KingKong Robotics' public repository, pinned to one
commit and verified byte for byte. This file records which files were used, how, and which numbers mean what.

## Pinned inputs

| | |
|---|---|
| Repository | [KingKongRobotics/jumper](https://github.com/KingKongRobotics/jumper) |
| Commit | `61d065219fca767f3142c8f10aff59eae5a5a004` (2026-10-05) |
| License | Apache-2.0, Copyright 2026 KingKong Robotics |
| Retrieved | 2026-10-07 |
| Files | 61, 22,305,293 bytes, listed with size, git blob SHA-1 and SHA-256 in [`tools/upstream.lock.json`](tools/upstream.lock.json) |

`npm run upstream:fetch` downloads exactly these files from raw.githubusercontent.com at that commit and refuses
any file whose bytes do not match the lock. The build scripts read only that verified cache.

The companion repository [KingKongRobotics/jumper-design](https://github.com/KingKongRobotics/jumper-design)
(`918d192857fcea1678c2a40b339501004a94d838`) was checked but is not used. Its robot meshes are Git LFS
pointers to the same 41 STL files: their SHA-256 hashes match the jumper repository's files exactly. Its
character skins (third-party characters) are deliberately not used.

## What each upstream file provides

| Upstream file | Used for |
|---|---|
| `assets/jumper/jumper.xml` | The kinematic tree (41 links, 22 hinges, a free base), joint axes and limits, link masses and centres, colours, foot sites, the depth sensor and camera. No body or geom carries a rotation, which is asserted by the build. |
| `assets/jumper/urdf/jumper/meshes/visual/*.stl` | The visual geometry, 41 files, 430,915 triangles. |
| `tasks/jumper/common/constants.py` | `HOME` (the calibrated standing pose, 22 angles) and `STAND_Z` (0.10647 m), the leg order, the six feet, the measured stance footprint `NOMINAL_FOOT_XY`, the tripod grouping. |
| `out/bundle_example/jumper/locomotion.json` | A second statement of `HOME`, `STAND_Z`, the joint limits and the wire order, used to cross-check. |
| `tasks/jumper/five_foot/claw.py` | The claw's measured aperture table, `GRIPPER_OPEN`, `GRIPPER_CLOSED`, and the stow pose a five-foot carry uses. |
| `out/bundle_example/jumper/claw_left.json` | A second statement of the stow pose (cross-check). |
| `tasks/jumper/five_foot/deploy/lib.rs` | The three "arm straight out" presets. Every reach uses the "web up" preset's J1 roll. Its finger angles (60° and 90° from shut) are recorded in `robot.json`. The game opens the jaws to 55 mm through `claw.py`'s aperture table instead, which keeps the finger off the robot's own body. |
| `tasks/jumper/five_foot/README.md` | The five-foot support margins and the 2+2+1 carrying gait (concept text). |
| `out/bundle_example/jumper/{hello,bow,salute,paw}.motion.trajectory.json` + `gesture_*.json` | The four recorded gestures and their 50 Hz timing. |
| `docs/HARDWARE.md` | Published specifications (SOURCE SPEC). |
| `assets/jumper/motor/motor_config.yaml`, `assets/jumper/camera/camera_config.yaml` | Read for context; their figures are labelled MODEL VALUE where quoted. |
| `LICENSE`, `NOTICE` | Shipped unchanged with the derived assets. |

The standing pose is `HOME` + `STAND_Z`. Upstream's exporter writes the same values as an `init_state`
keyframe into a package that is not committed. `reference.json` in the bundle is a parity-check recording,
not a pose. jumper-design's `preview-pose.json` says itself that it is not the calibrated stance.

## Four kinds of number, kept apart

- **SOURCE SPEC**: what KingKong publishes about the product.
  - Source: `docs/HARDWARE.md`, plus the product page, whose claims are quoted as claims.
  - Examples: 400 × 400 × 200 mm, 1.8 kg (prototype 2.8 kg), 22 tactile servos, dToF 54 × 42 at 55° × 42°.
- **MODEL VALUE**: the simulation model and upstream's measurements on it.
  - Model mass 2.543 kg, which differs from the product weight.
  - Joint axes and limits; the 106.47 mm standing height.
  - Claw opening 0.4–73.3 mm.
  - Support margins of 152.0 mm on six feet and 92.3 mm on five.
- **TRAINING PARAMETER**: upstream's control and training settings.
  - Example: the walking policies drive 20 of the 22 joints.
  - Their command ranges are training settings, not speeds, and are never presented as performance.
- **GAME APPROXIMATION**: everything this game decides.
  - Walking speed, stride, step height and timing.
  - The snack, its stand and the dish, and the drop.
  - The claw's reach planning: jaw heading, approach distances, the 55 mm opening, and the self-collision footprints (measured from the meshes, simplified to boxes).
  - Collision shapes and the score.
  - The guided tour's time-lapse speeds, labelled on screen.

The inspector and the sources drawer tag every displayed number with its kind.

## What was verified

- **The model reproduces upstream.** Forward kinematics in plain TypeScript (no MuJoCo) puts all six feet on the floor at `HOME` + `STAND_Z`:
  - within 0.01 mm on the source meshes;
  - within 0.3 mm on the shipped, simplified meshes.
  - The six foot sites match upstream's `NOMINAL_FOOT_XY` to 0.000 mm. See `tests/robot.test.ts`.
- **Mass:** the model mass sums to 2.5430 kg.
- **Standing envelope:** 368 × 415 × 178 mm, consistent with the published 400 × 400 × 200 mm.
- **Joint limits:** all 22 agree between `jumper.xml` and the policy contracts, and `HOME` is inside every limit.
- **Grasp pose:** in the "web up" preset, the claw's jaws close horizontally. It is used for grasping because of that.

## Discrepancies found upstream (and what this project does)

1. **The URDFs carry three joint-limit errors.**
   - The errors: `LM_J0` (+0.75 lower bound), `RF_J4` (+0.1) and `RF_J2` (2.1).
   - `jumper.xml` repairs them deliberately, as `assets/jumper/tools/build_jumper.py` documents.
   - This project uses `jumper.xml`.
2. **Collision meshes:** there are 35 `*_col.STL` files. The six contact links collide with their visual meshes.
3. **Torque figures:** they are all simulation values.
   - The XML clamp is ±2 N·m and is superseded upstream.
   - The servo model gives 1.7464 N·m peak and 1.2 N·m continuous.
   - The servo's vendor and datasheet are `null` upstream, so no torque rating is shown as a specification.
4. **The camera figures conflict.** `HARDWARE.md` gives a 162.2° diagonal; the simulation config uses 123° (from a drawing). This project does not quote camera figures.
5. **The product page makes claims not found in `HARDWARE.md`:** top speed ≥ 0.5 m/s, jump ≥ 400 mm, about 2 h of battery. They are quoted as claims only, and nothing in the game uses them.

## What this is not

- It is not a validated digital twin.
- It is not a physics simulation of the robot.
- It does not run KingKong's trained policies.
  - Upstream's browser controller needs MuJoCo in WebAssembly, onnxruntime-web, and an exported robot package that is not published.
  - Running a MuJoCo-trained policy in another engine would not be equivalent.
- It is not an assembly manual. The BUILD order is educational.
- It cannot control a real robot.

## Open questions

- Upstream's own pre-release checklist (`docs/PUBLIC_RELEASE.md`) says to confirm publication rights for reference motion clips. The repository is published under Apache-2.0 with these clips inside it; whether that confirmation was recorded is not visible.
- The exact placement of the two round displays under the visor is not in the published mesh. The eyes are drawn on the visor at ±24 mm, as our own animation layer.
