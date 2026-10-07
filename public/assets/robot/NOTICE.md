# Jumper robot assets: notice of origin and changes

The files in `assets/robot/` and `assets/motions/` are derived from
[KingKongRobotics/jumper](https://github.com/KingKongRobotics/jumper) at commit
`61d065219fca767f3142c8f10aff59eae5a5a004` (retrieved 2026-10-07), which is licensed
under the Apache License, Version 2.0. Copyright 2026 KingKong Robotics.

- The license text is in `LICENSE-jumper-apache-2.0.txt`.
- Upstream's own notice is in `NOTICE-jumper.txt`, unchanged.

## What was changed (Apache-2.0 section 4(b))

| File | Derived from | Changes made by JUMPER LAB |
|---|---|---|
| `jumper.glb` | `assets/jumper/urdf/jumper/meshes/visual/*.stl` (41 files) | Converted from STL to glTF binary; vertices welded; large parts simplified to about 35% of their triangles within a 0.25%-of-size error bound (parts under 2,000 triangles kept whole); positions quantised to 14 bits; meshopt compression. Normals are not stored: the browser rebuilds them. One node per link, named after the link. |
| `robot.json` | `assets/jumper/jumper.xml`, `tasks/jumper/common/constants.py`, `tasks/jumper/five_foot/claw.py`, `tasks/jumper/five_foot/deploy/lib.rs`, `out/bundle_example/jumper/locomotion.json`, `out/bundle_example/jumper/claw_left.json` | Transcribed to JSON: kinematic tree, joint axes and limits, inertials, colours, sites, cameras, the HOME pose and STAND_Z, the stance footprint, the claw aperture table, stow and arm presets. Each value is cross-checked against a second upstream file where upstream states it twice. |
| `../motions/*.json` | `out/bundle_example/jumper/{hello,bow,salute,paw}.motion.trajectory.json` and their `gesture_*.json` contracts | Joint angles unchanged (quantised to 1e-4 rad). The body position, which upstream does not record, was added: it is solved per frame from the feet by `tools/build-motions.mjs`. |

Every source file's SHA-256 is listed in `robot.json` (`source.files`) and in the
project's `tools/upstream.lock.json`.

JUMPER LAB is an independent project. It is not affiliated with or endorsed by
KingKong Robotics. "Jumper" and "KingKong" identify the source of these assets only.
