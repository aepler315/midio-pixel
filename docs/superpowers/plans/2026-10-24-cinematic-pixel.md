# Cinematic Pixel Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans. Track completed steps here.

**Goal:** Create an experimental real-time landscape Look with stronger form, layered air and smooth tonal continuity around deliberate pixel silhouettes.

**Architecture:** Extend the existing forward terrain/forest lighting with a uniform-gated profile and reuse the hybrid high-resolution sky. Add conservative cell-color reconstruction at presentation, with shared live/export behavior and graceful nearest fallback.

**Tech Stack:** JavaScript modules, WebGL2/GLSL3 terrain, Canvas2D scene composition, optional WebGL presentation, Node tests, Playwright, native Windows Chrome.

**Spec:** `docs/superpowers/specs/2026-10-24-cinematic-pixel-design.md`.

## Global Constraints

- Keep Classic+ and all existing grids available; Pixel/Palette defaults retain their behavior.
- Preserve procedural geometry, music, weather, camera, forest LOD and GPU residency rules.
- No captured evidence in Git. Use external output directories.
- A passing build/test is not aesthetic acceptance; inspect real captures.
- New mode must work in live presentation and export/recording, including switch back.

## Review Focus

- Unknown/saved older preferences must migrate safely; new Look must round-trip.
- Shader variants (river, mirrors, forest meshes and impostors) must compile and agree.
- Night, storm and high-altitude air must remain readable without flattening near terrain.
- Reconstruction must not blur alpha silhouettes or leak color across contrasting boundaries.
- Context loss/allocation refusal/disposal and capture resizing must have a valid fallback.

### Task 1: Baseline and ingress

Files: `DisplayProfile.js`, `PresentingRenderer.js`, `RangePresentation.js`, `index.html`, `BulkExport.js`, `tools/lib/visual-evaluation.mjs`, `tools/landscape-review.mjs`; tests in displayProfile/pixelDisplayControls/visual evaluation.

- [x] Capture unmodified Classic+ with the bounded background GPU review; inspect it.
- [x] Add failing behavior tests for cinematic preference, strict manifests, render policy delivery and CLI option.
- [x] Implement `look: 'cinematic'`, returning `cinematicPixel: true` from `resolvePresentation`. Pass this boolean through the scene boundary; retain selected grid. Add discoverable Look copy.
- [x] Verify targeted tests and commit ingress together with the design and plan.

### Task 2: Forward lighting and atmosphere

Files: `TerrainMaterial.js`, `ForestGL.js`, `RangeScene.js`, new `CinematicLighting.js`, targeted numerical/profile tests.

- [x] Pin finite/day/night profile behavior and baseline-off controls with tests.
- [x] Add shared `uCinematic` gate/profile and linear grade helpers; tune fill, diffuse wrap, shadow residual and distance air, with terrain-horizon consistent trees.
- [x] Compile actual shaders in native GPU captures, inspect both Looks at identical controls, fix issues and commit.

### Task 3: Sky and color reconstruction

Files: `RangeSkyRenderer.js`, `BiomeManager.js`, new `CinematicPixel.js`, `PixelPresentation.js`, capture tests.

- [x] Test bounded compatible-sample reconstruction and mode-off/fallback/capture lifecycle behavior.
- [x] Add conservative spatial gradients at presentation while preserving alpha/color edges, no history, no CPU frame readback; share compositor with export.
- [x] Add gated sky/cloud light and atmospheric glow using existing cached fields. Reserve scratch resources and release on mode change/disposal.
- [x] Inspect native/output images and consecutive motion; revise or remove reconstruction if it harms the silhouettes. Commit accepted implementation.

### Task 4: Review and deliver

- [x] Extend bounded GPU review with `--look cinematic`, strict profile validation and tests; label cross-Look comparisons explicitly rather than relaxing existing comparability.
- [x] Capture baseline regression, candidate, multiple landscapes/times and deterministic repeats or motion as practical. Retain PNGs and review reports outside Git.
- [x] Run `npm test`, `npm run lint`, `npm run stage:site`; fix introduced failures and report baseline failures separately.
- [x] Independent code review; address substantive findings. Document real observations, timing scope, known limitations and next work ranked by impact.
- [x] Commit milestones; deliver source bundle/patch and evidence through the task outputs directory.


## Execution record

- Base `387f963`; investigation `b460d5b`; ingress/reconstruction `72c3359`; terrain/forest/sky `5f168a3`; depth-color iteration and lifecycle `e8a8394`; GPU provenance `8c1c865`; idle-context quality transitions `7af566c`; streaming-aware optional-memory shedding `9d1f4b5`.
- Baseline captured before source edits on native Windows Chrome / RTX 3060. All five corresponding final Pixel PNGs were byte-identical. The original WSL bridge omitted required source commit metadata; standard comparison rejected that run. Evidence was preserved, direct byte equality verified, and the bridge corrected for future runs. Existing comparison requirements were not weakened.
- Initial source-level lighting adjustments were visually insufficient. Retained the depth-dependent atmospheric-color iteration only after inspecting actual predawn and storm captures. Corrected an overly dark cloud variant after sunrise inspection.
- Explicit dry-lighting study: same real procedural renderer, audio hash, camera, controls and25-frame schedule per Look at45–47 s/12 fps. Existing storm override held weather dry in both runs; cloud-sea fill = 0, sun visible, daylight. These are labeled controlled diagnostics, separate from authored weather acceptance.
- Natural-state captures additionally cover predawn Jackson Lake 12 s, Ross Lake cloud sea24 s, Ross Lake storm60 s, Black Mountains Detailed 45–47 s and Panamint 45 s. No screenshot claims full-scene or physical-device acceptance.
- Native GPU fixture verified color ramps, alpha and orientation, true context restore, denied-resize cleanup and repeated idle-context suspension. Two independent reviews found no blocking integrated code issue; their resource/lifecycle findings were fixed and retested.
- The live trace found voluntary context-loss events on quality shedding, then retained title/cloud cosmetic memory that delayed terrain windows. Fixed both and repeated. Final30 s RTX 3060 tour: zero failed presentations/browser errors/overcommits, advancing heard time, ~21.4delivered FPS vs Pixel~21.3; both p95=66.7 ms. Delivery target remains failed in both; this is a documented performance limit, not a passing60 FPS claim.
- Rendering acceptance is bounded: clearer near/far hierarchy and richer cool/warm relationships are observed, while broad distant faces, cloud rims, forest regularity and moving thin silhouettes remain future work. Color reconstruction does not provide a separate smooth irradiance buffer.
- Final test/lint/staging details and evidence file hashes are recorded in the delivery validation report. Captured media stays outside Git.

Final serial checks: `npm test` 5198 total / 5187 passed / 11 skipped / 0 failed; `npm run lint` passed; `npm run stage:site` passed; native Windows RTX 3060 GPU regression passed separately.
