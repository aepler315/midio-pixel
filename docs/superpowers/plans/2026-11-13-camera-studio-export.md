# Camera Studio and MP4 Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Compose optional custom landscape cameras and export complete performances to MP4 with source audio.

**Architecture:** Pure heard-time camera sampling is shared by live and fixed-step rendering. A DOM panel edits normalized immutable settings. A bounded browser encoder consumes each fixed-clock frame and interleaved PCM audio.

**Tech Stack:** Native JavaScript modules, Three.js terrain runtime, WebCodecs, pinned Mediabunny, Node tests, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-13-camera-studio-export-design.md`

## Global Constraints

- No uploads, runtime CDN, merge or deployment. Keep geographic assets unchanged.
- Exactly 30 or 60 fps; six even 16:9 resolutions from 360p through 4K.
- Preserve default automatic camera, terrain admission and coherent sky projection.
- Use song time; snapshot settings for export; cap in-memory output at 512 MiB.

## Review Focus

- Pruned terrain packages: custom controls must not reveal missing geometry.
- Seek/pause/replay/analysis adoption: camera state remains deterministic.
- User cancellation or song replacement during async export: cleanup must not overwrite a newer session.
- Unsupported H.264/AAC, failed frame presentation or exhausted memory: explicit failure, no corrupt success.
- Export restore: gain, pause, presentation, seed, camera schedule and source position remain usable.

### Task 1: Deterministic camera engine

**Files:** `src/world/alpine/CameraStudio.js`, RangeFrame/RangeScene/RangePresentation/TerrainWindow and focused tests.

**Interfaces:** normalized camera settings; immutable `sim.cameraStudioSettings`; spatial and projection sampling by heard time.

- [ ] Write/run failing tests for normalization, disabled identity, orbit direction, delay/overshoot, FPS/seek equivalence, bounded coverage and clearance.
- [ ] Implement presets, temporal response and renderer integration with coherent sky and coverage.
- [ ] Run focused tests/lint and commit owned files.

### Task 2: Camera controls

**Files:** `src/ui/CameraStudioPanel.js`, `src/ui/camera-studio.css`, UI behavior tests.

**Interfaces:** panel constructor takes settings/HUD parents, settings and callback; `setSettings` and `setState` synchronize controls/status.

- [ ] Verify toggle/preset/reset and input normalization behavior.
- [ ] Build accessible compact stationary overlay, collapse and responsive controls.
- [ ] Run focused checks and commit owned files.

### Task 3: Frame-by-frame encoder

**Files:** `src/render/Mp4Export.js`, pinned export runtime/build script, focused tests.

**Interfaces:** `exportMp4({canvas,audioBuffer,settings,renderFrame,signal,onProgress,writable})`; normalized six-resolution settings and filename helper.

- [ ] Write/run failing cadence, PCM, backpressure, cancellation, capability and budget tests.
- [ ] Implement H.264/AAC MP4 with quality-mode encoding, lockstep source audio and streaming target.
- [ ] Run focused tests/lint and verify vendored license/hash; commit owned files.

### Task 4: App integration and verification

**Files:** `src/main.js`, `index.html`, `src/ui/style.css`, integration/smoke tooling and user documentation.

- [ ] Persist studio settings safely and install immutable settings before every simulation draw.
- [ ] Add Export video dialog with resolution/FPS/quality, progress, cancel and reusable download.
- [ ] Own asynchronous export lifecycle: snapshot, await full analysis/terrain, rebuild on fixed clock, render every frame, restore previous session on all exits.
- [ ] Run focused/full tests, lint, module graph, stage production, isolated browser control/motion/export checks and relevant benchmark.
- [ ] Independent review, fix material findings, document measured results/limitations, commit integration.
