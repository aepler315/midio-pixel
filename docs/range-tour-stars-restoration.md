# Range camera access and narrative stars

The branch starts at fetched `main` **f7e8abb66683a4d1d16d7936bac49705c78b4262**, preserving the newer default-off experimental terrain shading. It does not reset to the previously inspected `2a5e46f9` checkpoint. No mountain material, terrain sampling, dedicated camera trajectory, musical planning, foreground water/boats overlay or character behavior is changed.

## Diagnosis

The dedicated tour was present and functional in the baseline local app. With the generated 120 BPM / 96-second kick, hat and melody fixture, construction seed 315 (derived song seed 769733695) and a 1280×720 viewport, `?rangeTour=tetons` loaded the real assets and selected `teton-range-tour`. The camera eye moved from approximately `[1850, 3354, -16143]` at 1 second to `[522, 3602, -16226]` at 30 seconds. Ordinary playback with `rangeTour=off` selected the ordinary scenic package. A missing selection is sufficient to explain ordinary playback, but it does not establish what happened in the user's deployed session.

The entry point was labeled “Range: Tetons only” and did not distinguish a requested tour from a prepared, rendered flight. Selection before a song could start needless preparation, while song replacement/disposal could retain stale active-frame diagnostics. A rejected tour-memory commit could publish an unowned tour. Those lifecycle links are repaired; the existing download, planning, `SceneTravel.poseAt()` and final scene-camera path remains intact. `applyCameraMoves()` still returns early for tour poses.

“Camera tour: Tetons” now explains the continuous, music-timed flight and reports Off, Ready, Loading, Active or Unavailable with a useful reason. Runtime failure details survive subsequent songs. Title and non-Alpine readiness return promptly without planning an unused tour. Diagnostics separate requested renderer mode, actual rendered mode, runtime readiness, selected view, preparation generation/state and fallback reason. Query precedence and `range-tour` storage remain unchanged.

The star defect is independent: Alpine's non-null narrative branch painted its own background and returned before `_drawStarfield()`. The compositor supplies that narrative in normal Range playback. The repair calls the existing catalogue painter once after the Range background and twilight glow, retaining the early return. It does not run the ordinary sky background/effects afterward.

## Star rendering

The existing catalogue, clusters, magnitude/brightness variation, scintillation, extinction, colour and Range aurora attenuation are retained. The Range's existing solar night value attenuates stars through dawn and suppresses them in daylight, even when the narrative palette is dark. Astronomy remains prohibited in Fathom and Nave.

Under the actual pixel policy, each point is mapped through the current Canvas transform and painted as one aligned native pixel; faintness is alpha rather than a fractional footprint. Classic and Detailed retain separate native grids. This does not modify terrain pixel sizing or its depth sampler.

The dedicated tour maps stable catalogue fractions to celestial directions with `tourSkyDirection()` and `projectSkyDirection()`, using the resolved `skyPan.tourPose` lens/aspect once. Camera turns reveal a persistent hemisphere. Final-composition inspection found the narrow low-angle opening technically drew stars but left them only 2 RGB levels above the sky at the median (13 at the brightest point). A fixed tour-only display exposure curve, `1 - exp(-4 * alpha)`, lifts faint points by about two stops with a smooth shoulder, without a brightness floor or larger sprites. It stays before aurora/cloud/terrain attenuation and preserves brightness ordering rather than exact ratios. The gain stays fixed through turns. V2 terrain/cloud passes cover the field; the inherited flat ocean horizon remains only for the legacy path. No unrelated sky decorations are enabled.

## Reproduction

```sh
npm ci
npm test
npm run lint
npm run stage:site
# Use an installed Chromium if Playwright's bundled browser is unavailable:
PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium node --test test/rangeStarsRendered.test.mjs
PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium node tools/tour-access-smoke.mjs .smoke/tour-access
PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium node tools/range-stars-smoke.mjs . .smoke/stars-ordinary ordinary
PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium node tools/range-stars-smoke.mjs . .smoke/stars-tour tour
node tools/teton-tour-runtime-check.mjs .smoke/runtime-metrics.json
# Existing Teton browser diagnostic requires a local app server:
TETON_SMOKE_QUICK=1 TETON_SMOKE_SKIP_REVIEW=1 PLAYWRIGHT_CHROMIUM_PATH=/path/to/chromium node tools/teton-tour-smoke.mjs http://127.0.0.1:8080 .smoke/teton-existing
```

`range-stars-smoke.mjs` accepts an immutable baseline source directory as its first argument. It serves a frozen public tree, records hashes for the served code/assets, uploads and analyzes the actual WAV, and captures the real final presentation. Its matrix covers Uniform/Depth × Classic/Detailed × Pixel/Palette at the dark opening, a daytime frame, and a sampled substantial authored turn plus returning night for the tour. Each opening profile includes an identical-time star-disabled control. The evidence is diagnostic fixture coverage, not representative-song or physical-device certification.

## Validation results and limits

The full Node suite with Chromium available ran **4,586 tests: 4,579 passed, one failed, six skipped**. The sole failure is inherited and reproduced on the starting checkout: `test/slskdCompose.test.js` expects image version `0.26.0` while the repository pins `0.26.1`. This task does not change that pin or weaken the assertion. Lint and site staging pass.

The narrative regression was run before the production repair and failed on the missing pass and native-pixel/projection behavior. All seven focused narrative tests now pass. The real Canvas/presentation regression passes all eight grid/scale/Palette combinations, plus upward-looking tour raster checks: distinct brightness, a crisp native footprint, changed pixels after a turn and identical pixels when returning to the same orientation. Dedicated tour poses still bypass ordinary camera offsets. The last status-only refinement follow-up passes 62 focused tour tests, including sections-only deferrals, repeated notes, successful recovery and stale-worker ownership.

The existing Teton browser harness was run in its quick mode against the actual served checkout: one 120 BPM / 96-second fixture, five captures, all active with finite/cleared camera poses and settled pause-pixel parity. Its off/on geography/chapter regression passes. The other four songs and the 44-primary artistic review were not rerun.

The six-minute runtime diagnostic still exits unsuccessfully on the inherited planner target: **132.88 ms versus 60 ms**. Mean quality 0.81718, optical fraction 1.0, climb, yaw, acceleration and clearance pass in that fixture. The 96-second browser fixture records quality 0.66997, below 0.8; window diagnostics retain the existing relaxed pixel-budget limits. None of those thresholds or terrain policies is changed. A live tour replan requested at 12 seconds also encountered the existing “no rate-limited altitude corridor” planner constraint. The safe prior route and committed camera remained intact; that request is **not** counted as successfully applied.

Sixteen real-browser behavior checkpoints pass: fresh and persisted activation through the final scene camera; explicit query precedence including blocked tour storage; live off/on with the same audio engine, seed, clock and pause state; restored geography and chapters; unavailable tour/runtime assets; non-Alpine preference retention; and the truthful held-refinement outcome. The 12-second paused toggle preserves the clock exactly. A playing toggle advances from 380.23 to 487.62 ms without pausing or replacing the audio engine. Earlier aggregate runs that later hit screenshot/action timeouts or the inherited refinement constraint are retained as interrupted/failed runs, with only their already-completed assertions indexed. The final startup and refinement groups pass in full.

The matched evidence contains **102 PNGs**: 18 ordinary Range frames and 33 tour frames per revision. The eight display combinations use 3 seconds (night 0.97219); daytime is 30 seconds (night 0); returning tour night is 93 seconds (night 1). Thirteen actual frames sample 27.5–33.5 seconds at 2 fps, covering an authored **24.51343°** turn. Every matched frame has the same actual camera position, orientation, resolved lens, effective presentation and inputs. All star-disabled images, daylight images and turn frames match their baseline counterparts exactly. The sampled sequence demonstrates travel and turning, not smooth 60 fps delivery.

At normal 1280×720 viewing size, stars contribute pixels in all eight dark-opening combinations. The ordinary Range retains its clustered field and existing reflected light. In the narrow tour opening, Pixel retains 26 native points in each grid; Palette retains 16 in Classic and 17 in Detailed. Contributions stay above the terrain; daytime contributes zero, and the returning night contributes 272 output pixels. The final exposure is retained because the first projected candidate's median two-level RGB change was too faint, while the final opening has a median 7.5-level change with varied brightness and the same one-pixel footprint. The sky, clouds, mountains and musical framing remain intact.

The initial 30-second tour draw has an inherited repeat-draw sky variation: 25,744 output pixels change by at most four RGB levels on the next draw, identically before and after the repair. Both initial draws remain in the evidence. The next captured star-enabled draw (`turn-30000.png`) occurs at exactly the same timestamp and exactly matches `day-off.png` in both revisions; that is the verified daytime star control. No tolerance or difference subtraction is used. Interrupted capture sessions resumed only after checking source, settings, browser, seed, view and existing PNG hashes; their attempt records are retained.

Evidence images and reports remain outside Git, as required by the repository workflow. Each report identifies the actual served source rather than assuming that a port corresponds to this checkout. Final control-source digest: `15f87f9a9bd03d3b32dba0d684b312ba80fba1012695f6d429102a2f713f6f5b`. The matched scenery capture uses `a8486818b3228f3a49d8f1776553e651f9733d14fa87ce00b1f7f04b48629ca2`; the only subsequent public-source changes are held-refinement diagnostics in `RangePresentation.js` and `RangeTourControl.js`. Star, sky, lens, terrain and camera-trajectory code match the captures.

The historical candidate limitations in [Teton tour validation](teton-tour-validation.md) remain binding. This restoration does not approve the station catalogue, remove planner/quality/pixel-budget thresholds, or establish device performance. No deployed build, physical phone, head unit or hardware GPU has been verified by these local software-renderer runs. The user's original playback session and any stale deployment remain unverified.
