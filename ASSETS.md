# Assets

Everything the site downloads, where it comes from, and its license. Sizes are raw / gzip.

## Derived from KingKong Robotics' Jumper (Apache-2.0)

Changes are listed in [`public/assets/robot/NOTICE.md`](public/assets/robot/NOTICE.md). Upstream's license
and notice ship next to the files. Sources are pinned in [`SOURCES.md`](SOURCES.md).

| File | Size | What it is |
|---|---|---|
| `assets/robot/jumper.glb` | 512 KB / 375 KB | 41 link meshes, 162,953 triangles, each link's triangles grouped by part (92 parts). Positions and indices only; normals are rebuilt in a Web Worker on load. Includes one servo body copied from the right rear calf into the right middle calf, whose published mesh lacks it. |
| `assets/robot/robot.json` | 53 KB / 10 KB | Kinematic tree, limits, HOME and STAND_Z, stance footprint, claw tables, with per-file SHA-256 of the sources; and the parts table (names ours): each part's triangle range, source piece and bounds. |
| `assets/motions/hello.json` | 56 KB / 7 KB | Recorded "hello" gesture, 7.32 s at 50 Hz. Body position solved from the feet. |
| `assets/motions/bow.json` | 65 KB / 14 KB | Recorded "bow", 8.56 s. |
| `assets/motions/salute.json` | 46 KB / 8 KB | Recorded "salute", 6.02 s. |
| `assets/motions/paw.json` | 48 KB / 7 KB | Recorded "offer a paw", 6.38 s. |
| `assets/robot/jumper-crowd.glb` | 57 KB / 30 KB | The crab-rave crowd's robot: `jumper.glb` simplified to 8,038 triangles (about 5 %), one node per link. Loaded only when a crab rave starts. |
| `assets/robot/LICENSE-jumper-apache-2.0.txt`, `assets/robot/NOTICE-jumper.txt` | — | Upstream's license and notice, unchanged. |

## Original to JUMPER LAB (MIT)

- **The room:** floor, rug, walls, window, sofa, books, plant, pouf, ramp and basket.
- **Course props:** the snack (an original oat cube in a paper band, no brand), its stand and the delivery dish.
- **Textures:** all drawn procedurally at load in `src/scene/textures.ts`. There are no image downloads.
- **Display expressions:** the eye animation in `src/robot/eyes.ts`. It is our animation layer, not the robot's software.
- **`og-image.jpg`** (94 KB): a real frame rendered by the app with the title composited on top.
- **The music:** an original electro loop (`src/audio/score.ts`), synthesized live in the browser with the Web Audio API (`src/audio/music.ts`). There is no audio file. It is not "Crab Rave" by Noisestorm and quotes none of it.
- **`assets/motions/rave.json`** (166 KB / 40 KB): the crab-rave choreography, generated from the model by `tools/build-dance.mjs` (`src/sim/dance.ts`). It is not a KingKong recording.
- **`assets/motions/scuttle.json`** (7 KB / 3 KB): one period of this game's gait controller crab-walking sideways, for the crowd to loop.

## Libraries and fonts bundled into the build

| | License | Text |
|---|---|---|
| three.js 0.186.1 | MIT | [`public/licenses/three.js-MIT.txt`](public/licenses/three.js-MIT.txt) |
| Manrope (500, 700; latin) via @fontsource/manrope 5.3.0 | SIL OFL 1.1 | [`public/licenses/Manrope-OFL-1.1.txt`](public/licenses/Manrope-OFL-1.1.txt) |

## Measured initial download (production build, gzip where the host compresses)

| | Size |
|---|---|
| JavaScript (three.js + app) | ~225 KB |
| CSS + HTML | ~8 KB |
| Fonts | 28 KB |
| `robot.json` | 10 KB |
| `jumper.glb` | 512 KB raw (375 KB if the host gzips `.glb`) |
| **Total before first play** | **≈ 0.65–0.78 MB** |
| Gestures (loaded after the robot) | 37 KB |
| Crab rave, on first use (dance, crowd robot, scuttle cycle) | ~73 KB |

## Not used, on purpose

- Upstream's ONNX/RKNN policies, controller binaries and `jumper.app`.
- The training stack and the collision hulls.
- jumper-design's skins and maps, which include third-party characters.
- Any KingKong product-page media, and any third-party music. A commenter asked for "Crab Rave". It is Noisestorm's track, released by Monstercat, so it is not shipped here; the soundtrack is original.
