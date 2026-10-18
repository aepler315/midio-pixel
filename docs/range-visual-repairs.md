# Range landscape and sky continuity repairs

Baseline: `5fade9d4645f6dab23fe8d0f756abb34b0715719`.

Water membership is classified at each surface texel before interpolation. This
avoids shrinking an interpolated drainage channel into isolated, angular water
patches. Shore coverage also controls shallow/deep colour, roughness and the
reflection edge. Native pixel rendering remains intact.

Forest detail and mesh cutovers vary deterministically within each stand, so an
entire contour no longer changes representation together. Distant instanced
trees fade into the terrain canopy using the same coverage in colour and depth
passes. Tree roots, dimensions, IDs, count and terrain ownership are preserved;
the canonical placement fingerprint is checked against the baseline.

A late tour-worker result is adopted only if it preserves the camera at the
current heard time. A discontinuous result is held and recomputed with the
current time committed. This addresses asynchronous route-handoff jumps without
changing the authored flight.

Lightning follows prominent analyzed kicks, snares and crashes at their heard
timestamps. Velocity and passage energy shape intensity, decay and restrikes;
weak intermediate percussion cannot consume the cooldown before a strong beat.
Reduced-flash mode still suppresses flashes.

The moon has a continuous lateral orbit independent of the storm and solar
visibility. Tour celestial directions use the final terrain camera, including
camera motion and lens scaling. Lunar illumination uses the signed solar path
through sunrise, avoiding a bright-limb flip. The Teton lunar arc stays within
the visible flight composition; terrain and clouds still occlude it naturally.
The Range star catalogue retains a daylight brightness floor after loading.

## Verification

The final serial full suite ran 4,599 tests: 4,592 passed, six skipped and one
failed. The sole failure, `test/slskdCompose.test.js`, also fails on the unchanged
baseline: its expected `slskd:0.26.0` conflicts with the existing Compose pin
`slskd:0.26.1`. That unrelated pin and assertion were not changed. ESLint,
`stage:site` and `git diff --check` passed.

Actual 1280 × 720 browser captures used Classic grid, Depth scale, Pixel look,
seed 315, quality 0 and the same audio, settings and GPU on both sides:

- Jackson Lake: generated 24-second `contrast` fixture, continuous 12 fps through
  23.5 seconds, 23 saved frames. At 12.958, 14.033, 15.108 and 16.175 seconds,
  stronger drum attacks visibly illuminate clouds, terrain and lake; the 17,
  20 and 23.5-second samples return to quieter illumination.
- Ross Lake: generated 120 BPM, 96-second WAV, sparse 30/45/60-second checkpoints
  and a 6 fps half-second clip at 45 seconds, five saved frames. This checks the
  forest boundary, shore coverage and daytime stars. Sparse evidence does not
  establish motion continuity between capture windows.
- Teton tour: the same 96-second WAV, 11 checkpoints at 1, 6, 12, 23.99, 24.01,
  30, 45, 60, 72, 84 and 94 seconds. The moon is visible before and after the
  storm and stays connected to the final camera. The ordinary tour camera
  positions agree with the baseline; a delayed-worker regression test separately
  exercises the unsafe handoff. The harness records one expected startup tour
  cancellation during the title-to-song transition and no capture errors.

Renderer: `ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce RTX 3060), OpenGL
4.6)`, DPR 1. All three final candidate sets have source digest
`a13ec78a36d255cac26faae9764b4ef73e3ca1cf9b144eda37af2712e7e67c1b`.

Capture reports, matching WAVs, before/after PNGs, manifests and validation logs
are kept outside Git. The official comparison reports retain their default
`unreviewed` judgment; changed pixels and a passing capture command are not
automatic aesthetic acceptance. These controlled fixtures support the scoped
repairs; they do not reproduce the user's original song or establish physical
phone, WebKit or user aesthetic acceptance. No merge or deployment is implied.
