# Progressive Landscape detail

Starting main: `0ab829bb4a3fe34adc69b79bdf0b921d21baf954` (merged PR #95).
This implements the request to start with Classic pixels and resolve the
picture as the mountains build. It also adds two experimental views and
removes the HUD's plus/minus buttons.

Updated 2026-11-07: progressive detail now stops at the former Detailed preset,
640 × 360, while retaining smaller fitted/covered endpoints.

## Behavior

**Build pixel detail** is enabled by default for ordinary Landscape Pixel and
Cinematic. It reads the same heard-time `LandscapeScore.rise01` as terrain and
the construction trio. Quiet passages retain the cumulative rise; seeking
backward selects the matching earlier raster. Completed growth selects Detailed
or a smaller admitted picture. No new musical randomness or independent build timer is
introduced.

The raster advances through 24 geometric size changes, from 320 × 180 to the
Detailed ceiling of 640 × 360. For a 1920 × 1080 output with no admission reduction:

| Mountain rise | Working raster |
| ---: | --- |
| 0% | 320 × 180 |
| 25% | 381 × 214 |
| 50% | 453 × 255 |
| 75% | 538 × 303 |
| 100% | 640 × 360 |

These are discrete, small changes, not a continuously resized target. The
physical output canvas stays the same size until layout, DPR or quality changes.
The default single-stage composition remains; growth adds no terrain pass.
Cinematic retains its existing hybrid presentation and output-resolution ridge.
Caption/effect units scale proportionally with runtime raster width, avoiding
integer-unit jumps. Growth temporarily uses fit instead of fixed integer
scaling, and fullscreen uses cover. Saved fixed preferences are preserved.

Selecting a fixed preset in Display or using the detail keyboard shortcut turns
growth off. The checkbox turns it back on. The HUD reports "Building detail";
the plus/minus buttons and their click bindings are removed. Trio renders
smoothly at display resolution. Palette, voxel/native/direct diagnostic paths
and fixed export renders remain fixed. Desktop Landscape snapshots capture
the five named presets; Android saves one selected fixed preset. Both restore
the previous growing presentation afterward. Trio saves one smooth snapshot
at its live output size.
Historical fixed-capture manifests normalize to `buildPixelDetail: false`.
The live smoke tool records progressive frame diagnostics separately.

## Performance and admission

- Graphics budgets remain 320 MiB for qualifying mobile devices, 192 MiB for
  low-memory mobile and the existing desktop budgets. JOYING JY-UTS18N12 remains
  the minimum target.
- Output follows the existing quality governor even in growing fullscreen.
  Windowed output retains the 1080-line ceiling; fullscreen output is bounded
  to 4096 × 2304 before fitting the landscape. The progressive working raster
  stops at 640 × 360; smaller output pictures retain their fit/cover endpoint,
  with a minimum source of 320 × 180.
- A plan allocates at most 25 grid descriptors per output layout. Normal forward
  growth changes targets at most 24 times; a pause reuses its raster. Seeking,
  layout/quality changes and setting changes may require additional resizes.
- New working canvases are reserved before replacing a useful old canvas.
  Refused increases retain it; repeated refusals for the same size are cached.
  Smaller/fixed rasters release the old allocation first. A cold seek whose
  first hybrid allocation fails retries Classic once in the same draw.
- Scenic target refusal caps growth at the last presented rung; if a heavier
  incoming scene also refuses that rung, it falls back to Classic. Waiting for tour
  coverage is distinguished from target refusal and does not cap density.
  A changed layout/quality permits fresh admission. Diagnostics record requested
  and admitted grids, mountain rise, rung, endpoint and the refusal reason.
- Tour terrain/forest LOD planning uses the stable endpoint height, avoiding a
  new coverage plan at every raster change. This can admit endpoint detail early;
  it does not claim that opening geometry cost scales with raster area.

Later frames render more pixels than fixed Classic, up to fixed Detailed.
The smaller opening raster reduces submitted raster work relative to rendering
at the endpoint throughout; neither that arithmetic nor unit tests establishes
GPU time, delivered FPS, startup stalls or thermal behavior. No new RTX 3060
benchmark or physical head-unit performance result is available.

## New views and artifact attribution

[Crater Lake and the western Badlands](scenic-expansion-caldera-badlands-2026-11-06.md)
use newly baked 20 m USGS terrain and stay experimental candidates. The initial
Crater Lake camera failed far-crest visibility; the rail was raised and rebaked.
Existing cross-view seams and inferred growth-ground horizons remain separately
reviewable limitations, as documented in the earlier transition audit. This
change does not claim to remove those artifacts or the reported early stalls.

## Verification record

- Final focused integration: **192 passed, 0 failed** across growth policy,
  presentation admission, display controls, output sizing, snapshots, export
  metadata, terrain provenance, candidate eligibility and expression calibration.
- Renderer/wash contract rerun: **17 passed, 0 failed**. These use mocked GL;
  they are not GPU rendering evidence. The combined focused total is 209.
- Full development integration run: **6,120 tests, 6,099 passed, 12 skipped,
  9 failed**. Eight failures were introduced compatibility expectations/mocks:
  two fixed-export profile records, four UI binding fixtures anchored to a
  changed comment, and two presentation doubles missing the new frame-grid
  method. All eight were fixed and included in the passing focused reruns.
  The entire 17-minute suite was not rerun after those fixes.
- The remaining 18-shot planner's under-50-ms gate fails independently on clean
  starting main and this branch. Isolated minimum warm/fresh-library times were
  105.9/153.3 ms on clean main and 67.6/107.0 ms on the branch. This code is
  unchanged; these variable CPU timings are evidence of a baseline gate failure,
  not an optimization claim. The threshold was not relaxed.
- Existing 21-station framing and all-pairs travel-coverage tests pass with the
  final new packages. Minimum far-crest exposure: Crater Lake **0.9609375**,
  Badlands **1.0**; both have **1.0** minimum crest-column coverage. These are
  CPU geometric measurements, not rendered screenshot judgments.
- The final 21-pose rise coverage check passes for both views. Cached independent
  rebakes reproduce both manifests/payloads byte-for-byte and both build records
  exactly.
- ESLint, the 513-module parse/link check, site staging and whitespace checks pass.

Focused command (plus `node --test test/webglRenderer.test.js`):

```sh
node --test --test-concurrency=1 test/progressiveLandscapeResolution.test.js \
  test/renderOutputSize.test.mjs test/displayProfile.test.js \
  test/visualEvaluation.test.mjs test/experimentalScenes.test.mjs \
  test/sierraSanJuanTerrain.test.mjs test/rangeExpression.test.js \
  test/pixelDisplayControls.test.js test/bulkExport.test.js \
  test/rendererComposition.test.js test/rangePresentation.test.js
```

Evidence logs are kept under `.smoke/progressive-*`, with the final view
metrics in `.smoke/new-view-framing-final.json` and reproducibility results in
`.smoke/new-view-repeatability.log`.

Browser/WebGL checks are unavailable: local Chromium cannot create its required
socket, the connected workstation is offline, and the available cloud browser
reports disabled GL. The updated `tools/detail-snapshot-smoke.mjs` contains a
live 0 → 30 → 100 → 30 second seek/capture check, but it has not run successfully
here. Independent agent review was unavailable after the agent quota was
exhausted; implementation review was performed in this session. No independent
security-review claim is made for this change.

Useful commands on a machine with working Chromium:

```sh
npm run test:snapshot -- --out .smoke/progressive-detail-live
node tools/review-range-views.mjs --views crater-lake-watchman-east,badlands-pinnacles-south --source published --stations 21 --modes neutral,silhouette,depth --out .smoke/caldera-badlands-review
```

Review live early/middle/finale frames in Pixel and Cinematic, integer/fit/cover,
backward seek and resume, Android fullscreen/DPR, quality changes and two-view
travel at 192/320 MiB before treating the experiment as visually validated.
Physical JOYING validation must include sustained playback and thermal load.
