# Pixel preservation and depth validation

Validated on 2026-10-15 against Midio-5 commit `e53db1e0663ce0f8db6d9d89d168dc6d6dbdb308`. The complete source snapshot matched its original Git tree before any changes.

## Original appearance

The baseline and new Uniform setting were captured with identical audio, construction seed, quality, view, export schedule and Chromium version. All **five PNGs were byte-for-byte identical**. These cover 6s, 12s, 12.167s, 12.333s and 20s of the contrast fixture, including a short movement sequence.

Settings: Teton Jackson Lake, CONIFER, quality 0, seed 315, Pixel / Classic / Auto / Uniform, 1280×720 output. Chromium 153.0.8010.0 used SwiftShader. Both capture reports passed, with no page or shader errors and no source changes during either run.

## Depth behavior

Three real Depth captures at 6s, 12s and 20s passed with the same fixture, seed, view and quality. Images were inspected for terrain, skyline and atmosphere preservation. Depth changes terrain sampling while keeping the existing scene, colors and composition.

Four additional Original/Depth pairs used real Monument Valley scenery at 6s. The catalog camera reached 1.274km minimum camera-space depth and showed visibly coarser foreground ground texture. A separately labelled diagnostic camera at 50m ground clearance reached 278m depth, exercising full 4× cells while retaining finer distant mesas. Every alpha byte matched across all four pairs. These are native scenic stills; the diagnostic low camera is not a claim about the normal camera path or projection-only user zoom.

The production GLSL shader is also compiled and drawn in WebGL2 by `test/pixelDepthShader.test.mjs`; raw RGBA readback checks exact Uniform and distant identity, 2×/4× cells, alpha preservation, depth/opacity guards, smooth transitions and repeatability. Lifecycle tests cover A/B target ownership, sun-shaft depth borrowing and copy-uniform reset.

## Checks

| Check | Result |
| --- | --- |
| Final root suite, including actual WebGL shader test | 4,549 passed, 6 existing skips, 0 failures |
| Ridgeview suite | 26 passed |
| Focused depth/render lifecycle suite | 118 passed, 0 skipped |
| Pixel-only preferences, controls and export tests | 97 passed |
| Project-wide ESLint | Passed |
| Production staging and runtime asset hash checks | Passed |
| Real Chromium title/settings and preference migration | Passed, no page errors |
| Independent implementation review | No blocking findings |

The six existing skips are retained from the source suite. The direct GPU test was run, not skipped. Browser wake-lock warnings in the software-rendered captures are expected in the headless environment.

## Reproduce

```sh
npm ci
npm run lint
npm test
npm --prefix ridgeview test
npm run stage:site
npx playwright install --with-deps chromium
node --test test/pixelDepthShader.test.mjs
npm run visual:eval -- --manifest test/fixtures/visual-evaluation-depth.json --out .smoke/pixel-depth
```

Use `PLAYWRIGHT_CHROMIUM_PATH` for a separately installed browser. The Pixel validation workflow repeats behavior checks, production shader readback and actual Depth scene capture, retaining the scene evidence as an artifact. Captured audio and images are not added to source control.

These are fixed-clock export and software-GPU checks. They do not establish device FPS, sustained live playback performance or cross-device equivalence. Depth scale currently applies to Range v2 terrain; other worlds and the legacy fallback retain Uniform pixels.
