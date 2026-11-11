# Frame Cost Implementation Plan

> **For agentic workers:** Execute phase by phase. Each phase ends at a gate; stop at the gate, report evidence, and continue only when the gate's condition is met. Track completed steps here with `[x]`. Follow `AGENTS.md` and `docs/experimental-development.md`. Where this plan and the code disagree, the code is the truth: record the difference in the Execution record at the bottom and adapt. Read section 4 before measuring anything.

**Goal:** A composed song range keeps its full picture on the owner's RTX 3060, lake reflections included, for the whole song. The quality ladder becomes cheaper at every rung it descends, and the governor returns detail when the machine can afford it. The same work lowers the cost of every Landscape frame.

**Why:** The owner reported that a composed range shows its reflections after a seek and loses them shortly after playback resumes. The audit ([docs/frame-cost-audit-2026-11-10.md](../../frame-cost-audit-2026-11-10.md)) reproduced both states by pinning the governor at levels 0 and 1, and found that the first rung adds over a thousand filtered canvas operations per frame, that recovery demands ten flawless seconds, that every seek discards what the governor learned, that a readback inside the frame callback adds the GPU's time to the governor's work signal, and that runtime stage assembly submits up to 2.2 times the triangles of an offline bake of the same layout.

**Architecture:** No new renderer. The work is (1) a performance record inside the product, so one owner command yields hardware evidence; (2) removal of work the frame repeats or adds for no picture: per-operation blur, a second sky draw, a synchronous `getError`, and a work signal that counts waiting as work; (3) governor rules that survive a seek and an isolated slow frame; (4) a stage that plants trees and spends triangles only where a rail framing looks; (5) forest submission that follows visibility; (6) a shorter path from song start to first sound.

**Tech stack:** JavaScript modules, Node 24, WebGL2/GLSL3 (Three.js 0.187.0), Canvas 2D, Node test runner, Playwright (headless Chromium, software WebGL on cloud hosts), native Windows Chrome on the RTX 3060 through `npm run test:gpu`.

**Starting point:** `main` at `e9d0945`, plus the audit branch `audit/song-range-performance` (the audit, this plan and the instruments in `tools/`). Branch each phase from `main` after the previous phase merges: `perf/p0-record`, `perf/p1-first-rung`, and so on. One pull request per phase. The owner merges.

---

## 1. Verified facts about the current code

Checked against `main` at `e9d0945` on 2026-11-10. File references are the places to start reading.

- **Frame loop and work signal.** `frame(tRaf)` in `src/main.js` measures the whole rAF callback and passes the previous callback's duration to `perfGovernor.sample(rafDeltaMs, tRaf, { capFps, workMs })`. The HUD (`P` key, `?fpsHud=1`) prints presented fps, callback fps and the level.
- **Governor.** `src/render/PerfGovernor.js`. Budget 18.5 ms of period; shed after 60 units (8 on a recovered rung); work pressure from 85% of the period, headroom up to 70%; recovery after 10 s in which every sample is clean and has headroom; retry window doubles per fall; `WARMUP_MS` 2500. `setFixtureLevel(n)` pins a rung. `diagnostics` returns six fields and no history. Tests: `test/perf-governor.test.js`, `test/perfGovernorHeadroom.test.js`, `test/perfGovernorConsumers.test.js`, `test/adaptiveQualityWiring.test.js`.
- **A governor per timeline.** `startTimeline` constructs `new PerfGovernor(...)`; `seekSong` calls `startTimeline`. Warm-up restarts at construction, at reveal after the scenic wait, on resume from pause and on becoming visible.
- **Ladder table.** `rangeQuality(level)` in `src/world/alpine/RangeQuality.js`: `waterMirror: q < 1`, `nearDetail: q < 2`, foliage keep by level, fog samples, `landscapeGiants: q < 4`. Other thresholds live at their consumers: `CREST_GRID_SCAN_LEVEL` = 4 and `CREST_PIXEL_SPLIT_LEVEL` = 2 (`RangeCrest.js`, `RangePresentation._crestProbeShed`) and the `>= 4` in `RangePresentation.drawMidDepthForWater` (output-resolution water). `test/rangeQuality.test.js` pins the table.
- **Mirror.** `RangeScene._prepareMirror` renders the reflected depth scene and bands when `rangeQuality(level).waterMirror` holds; `easeRungAmount(..., { down: 'snap' })` drops it at once on a shed and fades it in over 1.5 s on recovery.
- **Reflection backdrop.** `RangeScene.captureBackdrop(ctx, stage, frame, drawSky, drawnViewIds)` is called from `RangePresentation.drawPartition` at the mid pass. It sets `b.ctx.filter` to a blur when the mirror is shed, calls `drawSky` (which runs `BiomeManager.drawHighResolutionSky` → `RangeSkyRenderer.draw`), then copies the grid, then uploads the canvas as a `CanvasTexture`.
- **Output sky.** `PresentingRenderer` passes a `background` callback to `output.finishFrame`; it calls `drawHighResolutionSky` again at output resolution with `rangeSkyLayer.scenicTransform`.
- **Cinematic presenter.** `CinematicPixel.draw` (`src/render/CinematicPixel.js`, a WebGL1 context) uploads the grid with `texImage2D`, draws one triangle, then calls `gl.getError()` every frame.
- **Crest line.** `RangeCrest.prepareGrid` calls `_prepareEdges`, and both call `ctx.getImageData` on the working grid: one to three calls per frame. `PixelPresentation._workingContextHint` keeps that canvas GPU-backed in Cinematic, so the first call of a frame waits for the GPU process to finish the frame's scene. `RangeCrest.diagnostics.readbackMs` times the reads in `prepareGrid`; the read in `_prepareEdges` is untimed. The GL probe readback is asynchronous in live playback (`CrestProbe.js`); its collection (`getBufferSubData`) is timed as `collectMs`.
- **Stage assembly.** `assembleStage` in `src/world/alpine/StageAssembly.js` marks each tile `framing: 'core' | 'extended' | 'outside'` against the template rail, sets `visible: true` on all of them, and picks `lod.desktop` and `lod.mobile` strides from `LOD_BUDGETS` (`TerrainTiles.js`: desktop 1 px at 1080 rows, mobile 2 px at 720). `loadSongRangeStage` runs on the main thread and caches two stages.
- **Stage floor.** `stageFloorHeight` → `distanceToLake` in `src/world/terrain/StageFloor.js`: 80 bisection steps per sample outside the lake ellipse. The offline compositor (`tools/lib/stage-compose.mjs`) shares the function. All three templates centre the lake on a grid node.
- **Forest placement.** `ForestCover.js` skips tiles with `!tile.visible` (two loops). Mesh trees are instanced batches per band, species family and variant; `ForestCulling.js` culls a batch only when none of its 256 m cells reaches the frustum. Billboards are never culled. Foliage thinning discards vertices in the shader.
- **Terrain culling.** `TerrainChunks.js` culls each band per tile through draw groups, in order, with at most 8 draws per geometry.
- **Pixel-grid terrain.** Mapped tours plan strides against the pixel grid with protected shore, near and summit tiles (`pixelTerrainPlan`, `terrainPixelProtection` in `TerrainWindow.js`). Static rail views and stages draw `tile.lod[budget]` through `createBandGeometries(THREE, data, { budget, railSplit })`.
- **Slot rise shader.** `SLOT_LAND_RISE_GLSL` in `LandRise.js`: `riseLift` and `riseGrad` each call `slotSink(p)`, four `texelFetch` each.
- **Hardware tooling that exists.** `npm run test:gpu -- [--song-range force] [--view ID] [--live-seconds N] --out DIR` runs `tools/landscape-review.mjs` on the RTX 3060 (native Windows Chrome from WSL) and writes `live-report.json` with delivered-frame statistics. `tools/range-device-probe.js` and `docs/range-v2-device-runs.md` cover the JOYING. Display settings has "Copy graphics report" (`graphicsReport` in `src/render/GraphicsDiagnostics.js`, `test/graphicsDiagnostics.test.js`).
- **Instruments from the audit.** `tools/range-frame-cost.mjs`, `tools/range-live-callbacks.mjs`, `tools/perf-governor-sim.mjs`, `tools/song-range-stage-geometry.mjs`, `tools/range-prepare-cost.mjs`, `tools/cpuprofile-top.mjs`. Their headers say how to run them. `test/rangeFrameCostCounters.test.mjs` pins what the counters count.
- **Suite.** `npm test` on `main`: 5,563 pass, 2 skipped, 3 fail (`test/songRangePlan.test.mjs:52` and `:113`, `test/shotPlanner.test.mjs:177`). The hosted Test workflow (`.github/workflows/test.yml`) runs `npm run lint` and `npm test` on manual dispatch only; routine validation is local, and pull requests get no automatic checks.

## 2. Audit evidence this plan rests on

| Evidence | Value | Class |
| --- | --- | --- |
| Filtered 2D operations per frame at levels 1 to 6 | 1,015 to 1,276 on a stage; 65 to 809 on catalog views | Count |
| Level 1 stage frame against level 0, software rasterizer | 7 to 13 times slower | Software |
| Pixels changed by dropping the mirror on a stage at full rise | 29.6% (5.9% by more than 48 levels); the 2026-11 order rests on 0 to 2% | Software pixels |
| Recovery | One 30 ms frame every 4 s, or one 12 ms callback every 8 s, blocks it for good | Rule |
| Seek | New governor at level 0; learned state lost | Rule |
| Readback inside the callback | `getImageData` on the GPU-backed grid one to three times per frame; 93% of live callback time on the audit host | Count, software |
| 2D operations per stage frame at level 0 | 3,136 to 3,672, the sky drawn twice | Count |
| Sky share of main-thread frame time, this host | 24 to 37% on three views | Software |
| Stage triangles per frame, level 0 | 7.8 to 16.2 million; median approved view 3.4 to 4.6 million | Count |
| Runtime stage against offline bake of the same layout | 1.4 to 2.2 times the triangles; 287,002 surplus billboards and 9,162 surplus mesh trees on 285 tiles outside every framing (layout A) | Count |
| Stage geometry at the mobile budget (one grid pixel on the Detailed grid) | 63% fewer triangles | Count |
| `nc-ross-lake-north` | 205 to 245 million triangles per frame at level 0, 96% trees; 97.7 million at level 6 | Count |
| Ladder levels 2, 3, 5, 6 | Submit the same triangles as the level above (within 0.5%) | Count |
| Stage load and prepare against a catalog view, Node | 2.2 to 3.0 times; `distanceToLake` is 31% on `lake-narrows-b` | Software |

Not known: any timing on the RTX 3060 or the JOYING. Phase 0 exists to get it.

## 3. Design decisions

1. **Counts gate geometry and canvas work; hardware gates timing.** Every phase that claims a saving proves it with `range-frame-cost.mjs --dry` counts. No phase claims a frame rate.
2. **The product reports its own performance.** The governor keeps a bounded event log and frame statistics. The graphics report and `live-report.json` carry them. The owner pastes a report or runs one command.
3. **A lower rung never costs more than the rung above.** Asserted by count for the 2D canvas and the scene at every level.
4. **Keep every stage tile.** A stage has no holes and no `RiseGround`. Savings come from trees and level of detail. Hiding tiles is measured first and built only if the conservative rule in Phase 3 leaves a share worth having.
5. **Identity where it is free, a measured difference where it is the point.** Culling and single-draw changes stay byte-identical and are gated on SHA-256. Level-of-detail and blur changes alter pixels; they ship behind a comparison switch with paired captures and the difference reported.
6. **The governor keeps one authority and its two lines.** The 18.5 ms period line and the work lines stay. What changes is memory across a seek and tolerance for isolated frames, both specified by traces.
7. **Stages first, catalog second.** The forest work in Phase 4 benefits every view and is the largest number in the audit; it follows the stage work because the owner's report is about stages and the stage fixes are smaller.

## 4. Rules of evidence and global constraints

1. **Software milliseconds never rank GPU cost.** SwiftShader is fragment bound and completes work inside readbacks. `rangeState.timings.frameRenderMs` is command submission time. An earlier claim in this project broke this rule and was withdrawn (audit, section 10). Use counts here and the owner's reports for time.
2. **State the class of every number:** count, rule, software, or hardware with the machine named.
3. **Measure at rise below 1 and at rise 1**, on all three templates where a stage is involved, and on a forested and a bare view where the catalog is involved. Defaults: 12.0 s and 86.4 s of the 90 s `contrast` fixture.
4. **Use analyzer-produced song structure** in any test of stage behaviour. Idealized sections hid a bug in Phase 4.
5. **A dry count run takes under a minute. A full software frame takes 10 to 80 s at level 0 and minutes at level 1.** Budget captures accordingly, give each long run its own process and timeout, and never start a second copy of a running job.
6. **Byte identity means equal SHA-256 of the frame PNG** from `range-frame-cost.mjs --png` or the review tool, at both instants, against two baseline runs.
7. Evidence goes in `.smoke/` or the pull request, never in Git. Headless, isolated, muted browser. Never use the owner's linked work computer.
8. Run `npm run lint` and the focused tests for every change, and the full `npm test` before each gate. Report failed, skipped and unrun checks by name.
9. Catalog views, their approval metadata and their pixels stay as they are unless a step says otherwise and its gate reports the difference.
10. JOYING JY-UTS18N12 remains the performance target and stays unverified until Phase 7.

## 5. Phases

### Phase 0: Green suite and a performance record

**Purpose:** A trustworthy baseline, and a product that says what its governor did and why.

**Files:** `test/songRangePlan.test.mjs`; `src/render/PerfGovernor.js`; `src/render/GraphicsDiagnostics.js`; `src/main.js` (frame loop, graphics report handler); `tools/landscape-review.mjs` (`liveReview`, `reviewDiagnostics`); `tools/range-device-probe.js`; `docs/range-v2-device-runs.md`; tests beside each.

- [ ] Fix `test/songRangePlan.test.mjs:52`: build the "no plan" case from a restricted catalog fixture, since every family now plans. Fix `:113`: compare the catalog's families with the plannable subset the builder publishes. Add tests for the Phase 5 planner paths that have none (`canFill`, the constrained principal pool, the most-constrained-first retry). Answer the review thread on PR #122 with the commit.
- [ ] `test/shotPlanner.test.mjs:177` asserts a wall-clock bound and fails on slow hosts. Leave its bound. Record in the Execution record the host it failed on and whether it passes on the owner's machine or a hosted Test run.
- [ ] Governor event log. A fixed-size ring (32 entries, preallocated) of level changes: time since the governor started, from, to, cause (`period`, `work`, `probe-expired`, `recovered`), the period and work of the deciding sample, both accumulators. Counters: milliseconds spent at each level; samples over the period budget; samples with work pressure; samples without headroom. No allocation inside `sample()`.
- [ ] Time every synchronous wait in the callback and sum them per frame: both `getImageData` sites in `RangeCrest` (`_prepareEdges` has no timer today), the probe collection (`collectMs`), and the presenter's `getError`. Expose the frame's total as `syncWaitMs`. Count each wait once: `crest.cutMs` already contains the presenter's `getError`, which runs inside `RangeCrest.drawTerrain`.
- [ ] Frame statistics. Three fixed rings of the last 600 periods, works and synchronous waits; `diagnostics` computes median, p95 and maximum on demand.
- [ ] `graphicsReport` gains a `performance` block: the governor snapshot, the current level, fps cap, presented and callback fps, the synchronous wait statistics, the drawn view id and song range id, the prepared view's tiles, geometry triangles and tree counts, and whether the mirror and backdrop are active. Extend `test/graphicsDiagnostics.test.js`.
- [ ] `liveReview` in `tools/landscape-review.mjs` adds the same block and a level timeline (level sampled each frame, run-length encoded) to `live-report.json`. They do not change its pass/fail gates. `tools/range-device-probe.js` reports the same block; update the field table in `docs/range-v2-device-runs.md`.
- [ ] Optional, only if it fits in half a day: GPU time of the scene's WebGL work per frame through `EXT_disjoint_timer_query_webgl2` when the extension exists, median and p95 in the performance block. Skip it if a query disturbs a frame or the extension is absent in headless Chromium.
- [ ] Unit tests for the remaining pure parts of the instruments: `summarizeCallbacks` (`range-live-callbacks.mjs`), `summarizeProfile` (`cpuprofile-top.mjs`), `runTrace` (`perf-governor-sim.mjs`). `test/rangeFrameCostCounters.test.mjs` already covers the in-page counters, `passTable` and `mainThreadMs`.
- [ ] Record the baseline counts this plan gates against by running the audit's section 11 commands; attach the reports to the pull request.

**Gate G0:** `npm run lint` clean; `npm test` green apart from a recorded host-timing test; a graphics report from a headless run shows a shed event with its cause; the pull request states the owner commands below. Phases 1 to 3 do not wait for the owner's reply.

**Owner request at G0** (about five minutes on the RTX machine):

```sh
npm run test:gpu -- --song-range force --live-seconds 60 --out .smoke/gpu-stage
npm run test:gpu -- --view teton-jackson-lake --live-seconds 60 --out .smoke/gpu-teton
npm run test:gpu -- --view nc-ross-lake-north --live-seconds 30 --out .smoke/gpu-ross
```

Or, with no terminal: play a `?songRange=1` song for a minute, open Display settings, press "Copy graphics report", paste it.

### Phase 1: The first rung stops adding work, and the callback stops waiting

**Purpose:** Remove work that buys no picture: 1,000 filtered operations per frame from level 1 down, a second sky draw at every level, and a synchronous GL call every frame.

**Files:** `src/world/alpine/RangeScene.js` (`captureBackdrop`, `releaseBackdrop`, `_bindBackdrop`); `src/world/alpine/RangePresentation.js` (`drawPartition`); `src/render/PresentingRenderer.js` (`background`); `src/world/BiomeManager.js` (`drawHighResolutionSky`); `src/render/CinematicPixel.js`; tests `test/rangeBackdropRelease.test.mjs`, `test/waterMirror.test.js`, a new `test/backdropFilter.test.mjs`, `test/cinematicPixel.test.js`, `test/cinematicPixelGpu.test.mjs`.

- [ ] **1a. One blur.** In `captureBackdrop`, draw the sky and copy the grid with `filter = 'none'`. When the mirror is shed, soften the finished backdrop in one operation. Two candidates; measure both with the dry tool and pick by filtered operations and upload bytes: (i) one filtered `drawImage` of the backdrop into a second canvas of the same size, which becomes the texture source; (ii) a backdrop at a quarter of the area with no filter, softened by the shader's bilinear fetch. Unit test with a recording 2D context: at every level 1 to 6 `captureBackdrop` issues at most one filtered operation.
- [ ] **1b. One sky draw per frame.** Draw the high-resolution sky once, early in the frame, into a sky layer at output size with the frame's own `scenicTransform`; the reflection backdrop takes a scaled `drawImage` of that layer, and `finishFrame`'s `background` blits the layer 1:1. The sky frame (`rangeSkyLayer`) is fixed for a frame, so both uses see the same sky. Account the layer in the residency ledger; when the ledger refuses it, keep today's two draws. Confirm before building that `scenicTransform` is final when the mid partition runs; if it is set later, move the single draw to where it is final and let the backdrop use the previous frame's layer (the sky moves slowly), and record the choice.
- [ ] **1c. No `getError` in steady state.** `CinematicPixel.draw` checks `gl.getError()` on the first three draws after `_createObjects` or a buffer size change and after a context-restored event, and otherwise relies on `isContextLost()` and exceptions. Test with a recording GL context: steady-state draws call `getError` zero times; an error injected on a first draw still returns `false` with `reason = 'draw-failed'`.
- [ ] **1d. The work signal measures work.** The frame loop passes the governor the callback's duration minus the frame's `syncWaitMs` (Phase 0). Period pressure is untouched, so a GPU that cannot keep up still sheds through missed frames, as the governor's design intends. Wiring test in `test/adaptiveQualityWiring.test.js`: a callback of 15 ms with 9 ms of timed wait reports 6 ms of work; with no timers available the signal is the whole callback, as today.
- [ ] Re-run the audit's level 0 and level 1 full frames of the forced stage with `--png` at both instants.

**Tests:** the unit and wiring tests above; existing backdrop, water and presenter tests; `npm test`.

**Gate G1:**
- Count: `range-frame-cost.mjs --dry --quality 0,1,2,3,4,5,6` on the forced stage, layout A, `teton-jackson-lake` and `white-mountains-owens`: filtered operations at most 1 per frame at every level; 2D operations per frame at level 0 on the forced stage at most 2,150 at 12.0 s (3,140 today).
- Identity: level 0 frames of the forced stage and of `teton-jackson-lake` equal the baseline everywhere except on water (the backdrop's sky is now a scaled copy); show the difference image, and report the share of pixels that differ and the largest difference.
- Level 1 frames differ from today's only on water; report the share and show the pair. Owner look, non-blocking.
- Software: a level 1 full frame takes at most 1.2 times the level 0 frame of the same instant on the same host (7 to 13 times today). This is the one software time this plan gates on, because it compares two frames of one scene on one host and the defect is two orders of magnitude.

### Phase 2: A governor that remembers, and a ladder that keeps what a stage is for

**Purpose:** A seek keeps the learned level. One slow frame does not cost ten seconds. On a stage the mirror is among the last things to go.

**Files:** `src/render/PerfGovernor.js`; `src/main.js` (`startTimeline`, `seekSong`); `src/world/alpine/RangeQuality.js`; `src/world/alpine/RangeScene.js`, `RangePresentation.js`, `RangeCrest.js` (consumers of the thresholds); `tools/perf-governor-sim.mjs`; tests `test/perf-governor.test.js`, `test/perfGovernorHeadroom.test.js`, `test/adaptiveQualityWiring.test.js`, `test/rangeQuality.test.js`.

- [ ] **2a. Seek keeps the governor.** `seekSong` passes the live governor through `startTimeline`; a seek within the same song and presentation reuses it and calls `beginWarmup`. A new song, a presentation or quality change, and export build a fresh one as today. Wiring test: level and fallback counts survive a seek; a new song starts at the selected level.
- [ ] **2b. Recovery tolerates an isolated frame.** Keep both lines and the ten-second window. An isolated over-budget period or callback without headroom costs a bounded part of the accumulated clean time; a run of three or more restarts it, as does any catastrophic frame. Write the behaviour as tests on the traces of `tools/perf-governor-sim.mjs` before changing the governor:
  - trace 3 (one 30 ms frame every 4 s) and trace 5 (one 12 ms callback every 8 s) recover within 30 s;
  - trace 2 (level 0 misses every third vsync) still falls back within 0.5 s of each probe and doubles its window;
  - trace 9 (levels 0 to 3 unaffordable) ends at level 4 and probes no more often than today;
  - traces 1, 6 and 8 are unchanged;
  - trace 4 (every callback 12.5 ms) still never recovers.
- [ ] **2c. One table.** Move the thresholds that live at consumers into `rangeQuality`: `fineCrest` (today `level < CREST_GRID_SCAN_LEVEL`), `outputWater` (today `level < 4`), `crestSplit`. Behaviour unchanged; `test/rangeQuality.test.js` pins every field at every level.
- [ ] **2d. A stage order.** `rangeQuality(level, { stage })`: a composed stage (`view.songRange`) takes its own order. Level 1 sheds the fine crest probe and the output-resolution water pass, level 2 near-tree detail, level 3 the mirror; from level 4 as today. Every other view keeps today's table. Verify that water drawn in the partitions samples the mirror when the output water pass is off; that combination does not occur today. A catalog lake view could join later through a measured mirror share (`_mirrorScissor` computes the share of the mirror target that lake fragments read); that is outside this step.
- [ ] Count each level of the forced stage and layout A with the dry tool, and capture levels 0 to 4 at 86.4 s for the owner.

**Gate G2:** the trace tests pass; `npm test` green; on the forced stage and layout A every level submits fewer triangles than the level above or changes a named 2D cost (table in the pull request); the owner picks the stage order from the captures (decision D2). Default if the owner does not answer: the order in 2d.

### Phase 3: A stage that spends where a framing looks

**Purpose:** Runtime assembly costs what the offline bake of the same layout costs, with every tile kept.

**Files:** `src/world/alpine/StageAssembly.js`; `src/world/alpine/TerrainPackage.js` (manifest validation, if a tile field is added); `src/world/alpine/ForestCover.js`; `src/world/alpine/RangeScene.js` (`prepare`, geometry budget for stage views); `src/world/alpine/LandRise.js` (`SLOT_LAND_RISE_GLSL`); `tools/song-range-stage-geometry.mjs`; tests `test/stageAssembly.test.mjs`, `test/forestCover.test.js`, `test/landRiseStage.test.mjs`, `test/landRiseStageGpu.test.mjs`, `test/landRiseStageScene.test.mjs`.

- [ ] **3a. No trees outside every framing.** Assembly already knows each tile's framing. Tiles with `framing: 'outside'` carry no forest: add a tile field the forest honours, or have `ForestCover` read the framing for stage manifests. The terrain of those tiles stays. Node check with `range-prepare-cost.mjs pilot-a`: billboards at most 35,000 (318,203 today), mesh trees at most 17,500 (26,265). The opening overview (`LandRiseCamera`) looks beyond the rail's framings while the forest is still fading in: capture the forced stage and layout A at rise 0.34, 0.45 and 0.6 with and without, and show the pairs.
- [ ] **3b. Level of detail for the grid.** Stage views draw terrain at one grid pixel of error. On the Detailed grid that is the `mobile` strides assembly already computes; on smaller grids it is coarser, so compute strides for the grid in use (budget `errorPx: 1` at `heightPx` = grid rows) at prepare or carry extra budgets from assembly. Shore tiles keep `SHORE_MAX_STRIDE`. Protect near-band and summit tiles and their neighbours as `terrainPixelProtection` does if captures show the skyline stepping. `?stageLod=desktop` restores today's strides for comparison. The grid can grow during a song ("Building detail"): use the final grid's budget throughout.
- [ ] **3c. One sink evaluation per vertex.** `riseLift` and `riseGrad` share one `slotSink(p)` result (a struct or two globals set once in `main`). The transform-feedback parity test (`test/landRiseStageGpu.test.mjs`) and `test/landRiseStageScene.test.mjs` stay green; `tools/song-range-shader-budget.mjs` reports the same uniform rows or fewer.
- [ ] **3d. Hidden terrain, measurement only.** Extend `tools/song-range-stage-geometry.mjs` to count the tiles that pass this rule, after 3b: for every rail station at fine spacing, for the eye and for the eye mirrored in the lake, and for the overview camera states of `LandRiseCamera`, every sample of the tile raised to its highest position (its slot fully risen, plus `LAND_MAX_DISPLACEMENT_M`) lies behind terrain that is at its lowest position (other slots at rise 1/3; the tile's own slot tested at rise 1/3 and at rise 1 with the same occluder hiding it at both). Blend-zone tiles at slot edges never qualify. Report tiles and triangles. Build the hiding only if they are at least 15% of the stage's remaining terrain triangles on at least two templates; otherwise record the numbers and close the item.

**Tests:** assembly tests for the new tile field and strides; forest counts per pilot layout; shader parity; `npm test`.

**Gate G3:**
- Count, dry tool, layouts A, B, C at 12.0 s and 86.4 s: instanced triangles within 10% of the offline bake's (layout A: 907,352 and 4,245,784; today 4,885,864 and 6,078,016); geometry triangles at most 700,000 per layout (1,596,074 to 1,738,292 today); frame triangles at most the offline bake's (7,481,100 and 10,823,024 for A).
- Pixels: paired captures at both instants on three templates, default against `?stageLod=desktop`; share of pixels that differ and the largest difference reported; owner look at the skyline and at the overview (decision D3).
- No holes: every stage tile is still `visible: true` (assert in `test/stageAssembly.test.mjs`) and a stage still has no `RiseGround` (`test/landRiseStageScene.test.mjs`).

### Phase 4: Forest submission follows visibility

**Purpose:** Trees that cannot reach a pass's pixels are not submitted to it. This is the largest number in the audit: `nc-ross-lake-north` submits 205 to 245 million triangles per frame, `black-mountains-catawba` 32 to 36 million, and a forested stage 4.9 to 6.1 million of trees after Phase 3 removes the surplus.

**Files:** `src/world/alpine/ForestGL.js`, `ForestCulling.js`, `TourForest.js`; `src/world/alpine/RangeScene.js` (`renderWater`, `_probeFineCrest`, `_prepareMirror`); `tools/range-frame-cost.mjs`; tests `test/forestCulling.test.mjs`, `test/forestCullingRender.test.mjs`.

- [ ] **4a. Measure the ceiling.** For each pass and forest batch, report instances submitted against instances whose 256 m cell box reaches that pass's frustum and scissor (`ForestCulling.js` has the boxes). Run on `nc-ross-lake-north`, `black-mountains-catawba`, `teton-jackson-lake` and layout A. This number bounds what 4b can save and decides whether 4c is needed.
- [ ] **4b. Cull inside a batch, in order.** Cut each batch's instance list into runs of consecutive instances (the list order is kept, so soft crowns blend as today) with a box per run. Per render, draw the runs whose box reaches the frustum and scissor, merging neighbours and capping draws per batch as `TerrainChunks.js` does for terrain. WebGL2 has no first-instance argument: start a run by binding the instanced attributes at a byte offset into one interleaved instance buffer, or keep a vertex array per run; choose by the main-thread cost the dry tool reports. A culled run has no vertex in the clip volume, so frames stay byte-identical. Billboards get the same treatment.
- [ ] **4c. Depth-only passes.** The grid water pass, the output water pass and the fine crest probe draw trees only for depth. For each, state which trees can change its result (inside the water scissor; able to reach the crest rows) and cull the rest with a brute-force test in the style of `test/forestCulling.test.mjs`.
- [ ] **4d. Thinning by submission.** Order instances within a run so that the subset the ladder keeps at each level is a prefix, and lower the drawn count where the shader discards today. Frames at every level stay byte-identical to today's at that level.

**Gate G4:** dry counts at level 0: submitted forest triangles per pass within 1.5 times the in-frustum figure from 4a on all four views; levels 2 to 6 each submit fewer forest triangles than the level above on `teton-jackson-lake` and layout A; frames byte-identical at level 0 and at level 3 on `nc-ross-lake-north`, `teton-jackson-lake` and layout A at both instants; draw calls per frame at most 1.5 times today's and `outside waits` no higher than today's plus 10% on the same host.

### Phase 5: Time to first sound on a composed stage

**Purpose:** A stage reaches a prepared scene in about the time a catalog view does.

**Files:** `src/world/terrain/StageFloor.js`; `src/world/alpine/StageAssembly.js`; `src/world/alpine/TerrainMesh.js` (`terrainHeightAt` and a grid sampler); the grid-scanning callers (`TerrainOcclusion.js`, `TerrainHierarchy.js`, `OpeningCoverage.js`, `MistFlow.js`, `surfaceTextureSteps`); a new stage assembly worker beside `terrainWindowWorker.js`; `tools/lib/stage-compose.mjs` (shares the floor); tests `test/stageAssembly.test.mjs`, `test/stageCompose.test.mjs`, a new `test/stageFloor.test.mjs`.

- [ ] **5a. Floor distance, bit for bit.** Keep the function's results and compute fewer of them. (1) Leave the bisection as soon as the midpoint equals one end of the bracket: from there the remaining iterations change nothing, so the result is the same double. (2) The distance depends only on the absolute offsets from the lake centre, and every template centres the lake on a grid node: evaluate each distinct pair of offsets once per assembly (a transient `Float64Array`, about 12 to 15 MB for the largest template, released after assembly) and reuse it for mirrored samples and shared tile edges. Property test: equal to today's function, `Object.is`, over every grid node of the three templates. The assembled stage's `decodedSha256` is unchanged for the three pilot layouts and twenty synthetic plans. A faster solver that changes the last bits (Newton from `t = 0`) is a separate decision, because it moves stage hashes and the offline pilots' pins.
- [ ] **5b. Grid sampling.** Add a sampler that walks a row of a terrain grid and looks the covering tile up once per tile crossed, with the arithmetic of `terrainHeightAt`. Use it in the callers that scan grids. Outputs stay bit-identical (assert on the horizon, hierarchy and coverage arrays for one catalog view and one stage). This helps every view.
- [ ] **5c. Assemble off the main thread.** Run `loadSongRangeStage`'s assembly in a module worker with transferable buffers and a main-thread fallback, following `TerrainWindowWorkerClient.js`. `songRangeStats.late` and `SONG_RANGE_WAIT_MS` behave as today. The first sound comes no sooner for this; the page stays responsive, and frames keep flowing whenever a stage is assembled while a song plays.
- [ ] Re-run `range-prepare-cost.mjs` for `stage`, `pilot-a`, `white-mountains-owens` and `teton-jackson-lake`, with a CPU profile of `stage`.

**Gate G5:** in Node on one host, assembly at most 900 ms on `lake-narrows-b` and 600 ms on `lake-amphitheatre-a` (2,342 and 832 ms on the audit host today); `terrainHeightAt` under 8% of the stage profile (16 to 20% today); stage hashes, geometry and tree counts unchanged; `npm test` green; the new total against `white-mountains-owens` and the new profile reported (2.2 to 3.0 times today).

### Phase 6: What the hardware record decides

**Purpose:** Spend effort where the RTX 3060's own numbers point. Starts when the owner's Phase 0 reports exist; each item is taken only if its condition holds.

- [ ] **Let main-thread and GPU work overlap.** If the record shows a median synchronous wait of 2 ms or more on the RTX 3060: take the crest line's pixel inputs (edge colours and crest rows) from the asynchronous probe, which already delivers per-column data a frame or two late and which `RangeCrest` already aligns to the current grid, and drop `getImageData` from the live frame. Export keeps its synchronous read. This is the largest change in the plan to a delicate module: write the design as a short note first, with what each consumer of the pixels needs and how a frame of lag shows under camera motion. Gate: `getImageData` calls per live frame 0 (count, `range-live-callbacks.mjs`); crest tests green; paired captures in motion; the owner's record shows the wait gone.
- [ ] **Still shedding on a stage after Phases 1 to 3.** Use the event log's cause. If the cause is period: render the mirror at grid size, and draw the mirror with one level coarser strides; count and capture each. If the cause is work: profile the callback on the RTX machine with `range-live-callbacks.mjs --hardware-gpu --profile` and take the top function.
- [ ] **Start level per view.** If reports show level 0 shed within seconds on heavy views and held on light ones: remember per view id the level that held for the last minute of its previous play (session memory only) and start there.
- [ ] **Uniform preparation per pass.** `RangeScene._setUniforms` runs for each partition and both water sizes (item 7 of `docs/adaptive-quality-cost-audit-2026-11-07.md`). Take it only if the hardware profile shows it above 5% of the callback.

**Gate G6:** each item taken reports its count or hardware number before and after; items skipped are recorded with the number that ruled them out.

### Phase 7: Head unit and the default

**Purpose:** The JOYING JY-UTS18N12 run and the decision on whether composed ranges become the default.

- [ ] Run A of `docs/range-v2-device-runs.md` on a composed stage and on two catalog views, with the Phase 0 record in the probe output. Owner runs it; the executor prepares the page and reads the report.
- [ ] Record results in the table of that document. State which levels the governor held.

**Gate G7 (owner):** composed ranges become the default, stay behind `?songRange=1`, or get a device-specific rule.

## 6. Risks and the check that answers each

| Risk | Check |
| --- | --- |
| A softened backdrop looks different from the per-operation blur | Phase 1 pairs at level 1; owner look; the switch between candidates (i) and (ii) |
| The sky layer costs memory on small budgets | Residency ledger admission with fallback to two draws; `residency.overcommits` stays 0 in `live-report.json` |
| Dropping `getError` hides a failed draw | First-draw checks, context events, the injected-error test |
| A more forgiving recovery oscillates | Traces 2 and 9 must keep their backoff; add any oscillation seen on hardware as a new trace |
| Reusing the governor across a seek keeps a stale low level | A seek keeps recovery running; the event log shows recoveries after seeks in the owner's report |
| Bare land in the opening overview after 3a | Captures at rise 0.34 to 0.6; the owner decides (D3) |
| Coarser stage terrain steps along the skyline | Protection of summit tiles; pairs against `?stageLod=desktop` |
| Sub-batch forest draws cost more main-thread time than they save on the GPU | Draw-call cap; the `outside waits` bound in G4 |
| A floor shortcut changes a height | `Object.is` over every grid node of three templates; stage hashes over pilot layouts and synthetic plans |
| Software evidence is read as device timing | Rule 1; every pull request names the class of each number |

## 7. Out of scope

- A new renderer, WebGPU, or moving 2D canvas work to WebGL.
- Changing the pixel grid, the look, the rise schedule or any camera.
- Multi-biome chapters and other open items of the song range plan.
- Changing approved catalog views' terrain strides (a candidate for a later plan once stage results exist).
- Network download size and caching of piece packages.

## 8. Reporting

At each gate post: the step list with what was done; the count tables before and after with the command lines; the class of every number; tests run with totals; failed, skipped and unrun checks by name; paired captures where pixels change; the owner decisions the gate needs, each with its default. Keep reports to what the owner needs to decide.

## 9. Owner decisions, with the defaults this plan uses

| # | Decision | Default |
| --- | --- | --- |
| D1 | Run the three `test:gpu` commands (or paste a graphics report) after Phase 0 | Phases 1 to 3 proceed without it; Phase 6 waits for it |
| D2 | On a stage, what goes first: the mirror, or the fine crest and output-resolution water | Fine crest and output water first, mirror at level 3 |
| D3 | Accept bare land outside the rail's framings during the opening overview, and one grid pixel of terrain error on stages | Accept both; `?stageLod=desktop` stays for comparison |
| D4 | After Phase 4, whether `nc-ross-lake-north` keeps its approval if it still cannot hold a level on the RTX 3060 | Keep; record the level it holds |
| D5 | Whether composed ranges become the default | Stay behind `?songRange=1` until Phase 7 |

## Execution record

Empty. Add one section per phase: date, branch and pull request, what changed against this plan and why, the gate evidence, and what was not run.
