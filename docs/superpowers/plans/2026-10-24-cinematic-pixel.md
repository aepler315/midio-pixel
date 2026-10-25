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

- [ ] Capture unmodified Classic+ with the bounded background GPU review; inspect it.
- [ ] Add failing behavior tests for cinematic preference, strict manifests, render policy delivery and CLI option.
- [ ] Implement `look: 'cinematic'`, returning `cinematicPixel: true` from `resolvePresentation`. Pass this boolean through the scene boundary; retain selected grid. Add discoverable Look copy.
- [ ] Verify targeted tests and commit ingress together with the design and plan.

### Task 2: Forward lighting and atmosphere

Files: `TerrainMaterial.js`, `ForestGL.js`, `RangeScene.js`, new `CinematicLighting.js`, targeted numerical/profile tests.

- [ ] Pin finite/day/night profile behavior and baseline-off controls with tests.
- [ ] Add shared `uCinematic` gate/profile and linear grade helpers; tune fill, diffuse wrap, shadow residual and distance air, with terrain-horizon consistent trees.
- [ ] Compile actual shaders in native GPU captures, inspect both Looks at identical controls, fix issues and commit.

### Task 3: Sky and color reconstruction

Files: `RangeSkyRenderer.js`, `BiomeManager.js`, new `CinematicPixel.js`, `PixelPresentation.js`, capture tests.

- [ ] Test bounded compatible-sample reconstruction and mode-off/fallback/capture lifecycle behavior.
- [ ] Add conservative spatial gradients at presentation while preserving alpha/color edges, no history, no CPU frame readback; share compositor with export.
- [ ] Add gated sky/cloud light and atmospheric glow using existing cached fields. Reserve scratch resources and release on mode change/disposal.
- [ ] Inspect native/output images and consecutive motion; revise or remove reconstruction if it harms the silhouettes. Commit accepted implementation.

### Task 4: Review and deliver

- [ ] Extend bounded GPU review with `--look cinematic`, strict profile validation and tests; label cross-Look comparisons explicitly rather than relaxing existing comparability.
- [ ] Capture baseline regression, candidate, multiple landscapes/times and deterministic repeats or motion as practical. Retain PNGs and review reports outside Git.
- [ ] Run `npm test`, `npm run lint`, `npm run stage:site`; fix introduced failures and report baseline failures separately.
- [ ] Independent code review; address substantive findings. Document real observations, timing scope, known limitations and next work ranked by impact.
- [ ] Commit milestones; deliver source bundle/patch and evidence through the task outputs directory.
