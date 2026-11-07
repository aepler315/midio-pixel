# Valley-born mist engine

## Behavior

The earlier cloud sea raised a camera-relative horizontal top, increased density everywhere below it, closed its gaps and colored an intersected plane. This change replaces that branch with low banks that form near low drainage outlets, spread upstream through connected valleys, and move along drainage distance in heard time. Camera altitude no longer sets the bank ceiling or switches the effect off.

A fixed field is derived from actual source heights: ground elevation, low-source-connected valley affinity, upstream distance and valid coverage. The shared maximum is 96 samples on the longer axis for all device tiers. The original quiet-passage envelope supplies gradual formation and release. Local depth stays within a soft 85–135 metre band above the encoded ground, with uneven coverage and moving pulses; it does not raise a world-wide waterline. The ordinary exponential haze remains separate.

A bank is reconstructed at the heard timestamp, so pause, seeks, display and capture share state without a fluid simulation or previous-frame history. This is procedural transport through derived drainage, not physical airflow simulation. Sources/HAND are coarse terrain interpretations, not measured fog or meteorology.

The same local three-dimensional occupancy attenuates emitters and their light. An original actor source-height lane reconstructs its drawn anchor through the exact ground-lift/song-rise transform. This fixes the lower-height shortcut exposed by the new shallow fog banks.

## Cost and integration

- The field adds one RGBA8 texture lookup to each existing 2–6 ray sample during formed-bank rendering, reusing its existing noise mask. The earlier cloud-sea branch evaluated a second noise mask. No second terrain render, fullscreen target or frame-history texture is added.
- A maximum-sized field retains 36 KiB CPU bytes plus 36 KiB GPU bytes: 72 KiB per camera mode, at most 144 KiB for rail plus tour. Both copies are charged before preparation.
- The source field is built in bounded asynchronous slices. Up to 2 MiB of hydrology build scratch reuses the surface allowance; any additional scratch must fit without evicting an active view. Refusal preserves the landscape and uses low drifting fallback banks.
- Two terrain-aware affinity smoothing passes soften the drainage mask while retaining source connectivity, no-data, high-island and ridge guards.
- Cached sample fields plus a bounded arithmetic loop reconstruct adjacent ground slopes and analytically integrate the bank's vertical profile. Thin banks stay visible at two samples; sloping valleys avoid the fixed-ground integration error. There are no additional field/noise reads for this correction.
- Mist scalar packing and the three actor source heights retain the existing **248-vector terrain guard** for the Adreno 256-vector target. Complete software-linked programs use at most 10 fragment samplers (forest 4, cast vertex 3), below the WebGL2 minimum of 16 per stage.
- Rail/tour modes bind their respective source-ground fields. Streaming tours build once from package-wide source data, avoiding a new field at each terrain-window boundary. Fields retire with their view on eviction, failed preparation and context rebuild.

## Verification

Behavior tests cover branching and broad valley floors, steep divides, disconnected high terrain, no-data and boundaries, texture accounting, cancellation, source-first formation, upstream phase, local height, density-zero continuity, deterministic time, song-rise fallback, local emitters, sampler counts and mode/disposal wiring. Preparation tests also cover refusing optional fog scratch while keeping the view admitted.

A synthetic steep-ray reproduction originally lost all formed fog at two samples. A second reproduction followed a valley floor uphill by 500 or 2,000 metres. The corrected integration retains shallow banks across 2/3/4/6 samples; the linear-floor cases agree within 0.1% in the focused regression. Height antiderivatives clamp to their support, preventing float32 cancellation from inventing high-altitude fog on nearly horizontal rays.

Surfaceless EGL / Mesa llvmpipe GLES 3.2 compiled and linked 14 complete terrain, forest and cast programs using the actual factories and Three-generated prefixes. The final shared mist GLSL SHA-256 is `34d07ca71399ab842237c25b1a912485b12ff1f11ac10222eb04d8731a43f93c`. A 1,840-case-point CPU/GLSL fixture produced finite results. Actual GPU anchor reconstruction returned 590 m, matching the CPU oracle, while the previous shortcut yielded 545 m. Six nearly horizontal segments outside bank support at 2–20 km produced exactly zero occupancy.

The production RGBA8 linear-filter comparison had maximum absolute differences of 0.02501 ray opacity and 0.03260 local occupancy, exceeding its 0.003 diagnostic. The same packed bytes uploaded as a floating-point filtering control agreed within 1.16e-6 and 3.31e-6. This separates formula agreement from the software renderer's normalized-texture filtering precision; the production texture remains RGBA8. This is not a claim of exact hardware filtering or device FPS.

Synthetic perspective and field diagnostic captures were inspected. They show low corridor formation and softer boundaries after smoothing. Larger angular source-region outlines remain. These are generated synthetic terrain fixtures, not application-song or physical-device artistic acceptance.

Final command counts and the two separately reproduced baseline-suite failures are recorded in the pull request. Chromium browser smoke was attempted but launch aborted because `socket()` returned `Operation not permitted`; the offscreen GLSL checks above use no browser or socket.

## Remaining limits

The 96-sample field approximates terrain between its samples. A quantified Teton-tour example at world `(713.2395, 10301.3021)` has actual ground 2152.07 m and decoded field ground 2526.24 m, a 374 m difference. In that case banks can sit above the real valley floor. A 40,000-point deterministic probe found 38 of 13,541 high-affinity points more than 135 m high and eight more than 135 m low. This is a material coarse-field limitation, not a strict terrain-contact guarantee. A finer/multiresolution ground lane is a sensible next refinement if actual-view captures show detached patches.

The low-memory fallback has no real drainage map, so it preserves low drifting banks without source-network transport. Coarse source-region contours, real-song motion and sustained JOYING performance need application/device review. This change remains a draft for that review.

## Final integration record

The final affected run exercised 158 files: **1,393 passed, one baseline failure, four skipped** (1,398 tests total). The failure is `cinematicPresentation.test.js`'s bulk-export `buildPixelDetail` expectation; the same mismatch was reproduced in an untouched `c10b820` checkout. An earlier full-repository quality-checkpoint run had 6,230 passes, two independently reproduced baseline failures (the export mismatch and `shotPlanner`'s 50 ms timing bound), and the intentional forest-shader pin change; the pins were subsequently regenerated and verified. The complete repository suite was not rerun after the mist feature. Final lint, 518-module linkage, staging and whitespace checks pass. Focused mobile uniform and material-shader tests pass.
