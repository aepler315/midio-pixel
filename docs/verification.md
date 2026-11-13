# Verification commands and evidence

Run with Node 24, `npm ci --no-fund`, and `npx playwright install chromium`.
`PLAYWRIGHT_CHROMIUM_PATH` selects an installed Chromium. All new browser runs
are isolated, headless, muted, fixed-clock software WebGL, with external requests
blocked. They serve a frozen hash-addressed runtime snapshot from a private
loopback server. Source edits during capture fail the run. No model API is used.

## Functional contracts and production build

```sh
npm run lint
npm test
npm --prefix ridgeview test
npm run check:modules
npm run stage:site
```

| Relationship | Existing production tests (selected) |
|---|---|
| Audio → shared frame, mood and weather | `rangeFrame.test.js`, `landscapeScore.test.js`, `moodScore.test.js` |
| Song construction → terrain and per-slot heights | `landRise.test.mjs`, `landRiseStage.test.mjs`, `dualSummitsPerformance.test.js` |
| Growing terrain → camera and focus | `buildCameraScene.test.mjs`, `landRiseCamera.test.mjs`, `rangeProjectionZoom.test.js` |
| Source data → package/geometry | `rangeAssets.test.js`, `guideGeojson.test.js`, `terrainChunks.test.mjs` |
| Quality → grids and adaptive behavior | `pixelRenderPolicy.test.js`, `pixelGridHandoff.test.js`, `adaptiveQualityWiring.test.js`, `perfGovernorHeadroom.test.js` |
| Loading/admission/cancellation → fallback | `terrainBuildAdmission.test.js`, `rangeReadinessOwnership.test.js`, `graphicsResidency.test.js`, `tourAccess.test.mjs` |

These are real tests already present; this change extends the verification system
rather than duplicating thousands of working behavior tests. New
`engineeringVerification.test.mjs` tests fail-closed comparison contracts, real
PNG differences/corruption, CLI retention and explicit reference creation.
Production staging verifies bundled assets and module pins without deployment.

## Bounded visual corpus

```sh
npm run verify:visual:capture -- --out .smoke/visual-1
npm run verify:visual:capture -- --out .smoke/visual-repeat
```

`tools/verification/scenarios.json` pins viewport 640×360, DPR 1, seed 315,
heard timestamps, authored Teton lake rail, pace, CONIFER receiver, quality,
Cinematic/Uniform and a generated 90-second contrast song. WAV generation is
44.1 kHz; AudioContext decoding is fixed to 48 kHz. Frames include Classic and
Detailed opening/partial/late views, diagnostic exact half-rise and an energetic
quality-3 checkpoint. Each stores actual camera, terrain, audio, presentation,
weather/mist and graphics diagnostics. Camera position comes from the fixed
production heard-time schedule; it is not a fabricated screenshot pose.

The fixed corpus disables Building detail so Classic and Detailed remain distinct.
Run existing live/quality-transition tests and `review:landscape --live-seconds N`
for dynamic grid transitions. Use `review:landscape --grid both --no-mp4` for
consecutive motion/audio evidence. The fixed corpus does not certify the intended
camera motion, mist flow, live scaling or musical artistry by itself.

### Two reference kinds

**Inspected image baseline:** inspect all candidate images and relevant audio,
state/provenance and differences before explicitly creating a reference:

```sh
npm run verify:visual:approve -- --candidate .smoke/visual-1 --out .smoke/approved-reference --reviewer REVIEWER --reason "specific review and intended behavior"
npm run verify:visual -- --baseline .smoke/approved-reference --candidate .smoke/visual-repeat --out .smoke/visual-diff
```

The approval command validates completed status, every PNG hash/dimension and
controls before copying a small reference. It refuses to overwrite any directory.
Approval always leaves artistic verdict unreviewed; document owner artistic review
separately when actually obtained. If intentionally committing an image baseline,
place the reviewed images/report in `test/fixtures/verification/baseline/` with the
review evidence in the PR. Do not commit generated audio or entire capture runs.

**Approved source comparison:** CI renders the exact clean PR base SHA and the
candidate using the same harness/browser on one runner. An explicit approval step
with `--source-commit FULL_SHA` verifies the source identity and clean checkout.
The reference is labeled `approved-source-comparison`, not inspected/artistically
approved images. This protects against candidate regressions even before a
portable inspected-image corpus is available, and adapts to the installed browser.
It does not automatically approve the candidate. Workflow dispatch compares the
dispatched source with itself as a repeatability check, not a historical change.

No initial inspected application-image baseline was created in the implementation
workspace: its sandbox prevented Chromium startup. CI therefore uses approved
source comparison by default. This limitation is explicit rather than seeding a
reference from an unobserved output. The local approval/comparison mechanism is
fully executable and tested with real synthetic PNG fixtures.

### Comparisons and failures

Full-resolution RGBA changed area (channel tolerance), local 8×8 luminance SSIM and
horizontal/vertical edge error all must pass. Default limits are in the corpus,
whose hash is part of the controls identity. This is neither pixel-perfect equality
nor an artistic quality score. There is no ignored terrain region or implicit
weather mask. Frozen seeds/clocks avoid nondeterminism; residual browser noise is
bounded by explicit tolerances. Review differences rather than increasing them
until a failure passes.

Controls/fixture/harness hashes, Chromium major version and actual renderer must
match. Full browser versions are recorded; patch versions within the same major
can be compared with the stated tolerances. For stricter investigations, use the
same exact executable. A browser-major, renderer, harness or corpus change needs a
matched recapture/migration with explicit review; it is never silently normalized.

`report.json`, `summary.md` and `index.html` retain source/configuration, observed
metrics, errors and before/after/magenta absolute-difference images. Missing
frames, corrupt PNGs, mismatched controls, failed capture and invalid thresholds
fail nonzero. Capture leaves a failed root report and partial images on error.
A comparison directory is always new, including on failure. To reproduce, run the
recorded command with the same source, corpus, audio hash and environment.

## Benchmarks

```sh
npm run bench:engineering -- --out .smoke/bench-before
npm run bench:engineering -- --out .smoke/bench-after --baseline .smoke/bench-before/report.json
# Same candidate harness, separate production source checkout:
npm run bench:engineering -- --source OTHER_CHECKOUT --out .smoke/bench-source
```

Reports retain source/workload/asset identity, timing distributions, Node memory,
output checksums and comparison deltas. No baseline means collection, not a
regression pass against a prior version. Missing/nonfinite metrics and mismatched
hosts/workloads fail; changed geometry/output hashes fail even if faster. See
[performance budget](performance-budget.md) for the diagnostic timing allowances
and browser/GPU/device tiers. `--samples 7..30`, `--relative` and `--absolute-ms`
make bounded workloads/allowances explicit. Retain baseline failures and compare
sequential runs; do not infer GPU time or head-unit FPS from Node.

## CI tiers

`agent-verification.yml` runs on PRs and manual dispatch, with only `contents: read`:
core lint/module/tests/production staging; same-runner CPU base/candidate; and the
8-image-per-side matched-source visual corpus. Jobs have finite timeouts and
14-day artifact retention, summaries on success/failure and concurrency cancellation.
Actions and dependency locks are pinned; no secrets, privileged PR target event,
production deploy or PR-write permission is added. Existing manual extended,
forest, landscape, shading and visual workflows remain available for deeper work.
Hosted execution/billing availability is external; a configured workflow is not
proof it ran. Final PR evidence names observed runs and blockers accurately.
