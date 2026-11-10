# Song Range Composition Implementation Plan

> **For agentic workers:** Execute phase by phase. Each phase ends at a gate; stop at the gate, report evidence, and continue only when the gate's condition is met. Track completed steps here with `[x]`. Follow `AGENTS.md` and `docs/experimental-development.md`. Where this plan and the code disagree, the code is the truth: record the difference in the Execution record at the bottom and adapt.

**Goal:** Give every song its own mountain range. The range is assembled from real massifs cut out of real DEMs, laid out by the song's musical identity, and raised massif by massif by the song's structure.

**Why:** The owner finds the mountain build a strong visual that reads as random, because the music controls only its pace. A 500-song library also shares 13 approved ranges, so about 38 songs land on each one. Two fixes are needed together: a layout that belongs to the song, and a build whose location follows the song.

**Architecture:** An offline tool cuts full-coverage massif pieces from normalized source DEMs. A pure planner maps a song's identity record to a stage layout (which piece sits in which slot). A runtime assembler merges the chosen pieces into the same in-memory terrain data that `decodeTerrain` returns, so `RangeScene.prepare` consumes it unchanged. The scalar land rise becomes a per-slot rise scheduled from the song's sections.

**Tech stack:** JavaScript modules, Node 24, WebGL2/GLSL3 (Three.js 0.187.0), Node test runner, Playwright, GDAL Python for DEM normalization, native Windows Chrome on the RTX 3060 for captures.

**Starting point:** `main` at `be5852d`. Work on a new branch `feature/song-range`. The earlier pilot lives on `pilot/range-compose` (`tools/range-compose-pilot.mjs`) and is reference material only.

---

## 1. Verified facts about the current code

Checked against `be5852d` on 2026-11-10. Re-verify anything you depend on.

**Terrain packages**
- Schema `midio.terrain` v1 (`src/world/alpine/TerrainPackage.js`). 64-cell tiles, per-tile stored stride, planar-predictor uint16 heights, a flow byte per sample (255 = water), per-tile `lod` per budget and `errorsM` per stride.
- `decodeTerrain(manifest, bytes)` in `TerrainMesh.js` returns `{ manifest, tiles, byIndex, cells, grid }`. `terrainHeightAt(data, x, z)` samples it. Runtime LOD comes from the baked `lod` field (`tileStrides`); there is no distance-based selection at runtime.
- Shipped packages hold only the ground their authored cameras see. Denali ships 472 of 1,296 tiles. This is why shipped packages cannot serve as a parts bin.
- `RangeScene.prepare` derives the surface texture (normals, curvature, flow), receiver mask, baked horizon, ridge/drainage hierarchy (`TerrainHierarchy.js`), forest and rise ground from the decoded data.

**Offline pipeline**
- `tools/build-range-scene.mjs --view <id>` normalizes a DEM (`tools/lib/terrain-source.mjs`, `tools/terrain/normalize-dem.py`, needs GDAL Python), caches it under `.terrain-cache/`, and bakes with `bakeTerrain(grid, view, options)` in `tools/lib/terrain-bake.mjs`. `--publish` writes to `src/assets/range/v2/terrain/` and regenerates `src/world/terrain/sceneCatalogData.js`.
- `readDemGrid` returns `{ width, height, cellSizeM, originM, heightsM, valid, ... }`. `bakeTerrain` accepts that shape and has an `allTiles` option that requires complete coverage.
- `.terrain-cache/` is not in Git. Source DEM URLs are pinned per view in `data/terrain/scenic-views.json`.
- `docs/compiled-terrain-experiment.md` records that the Monument Valley normalized DEM rebuilt byte-identically and that full source coverage of its 44.8 km square exists.

**Catalog and selection**
- Runtime view record: `terrainManifestUrl` + sha256, `materialManifestUrl` + sha256, `camera` rail in local metres (`eyeStartM`, `eyeEndM`, `targetStartM`, `targetEndM`, `fovYDeg`), `composition`, `characterScores` on four axes (`RangeCharacter.AXES`), status and approval hashes. Validated by `sceneViewErrors` in `SceneCatalog.js`. Catalog version 57, matching version 2.
- `planSongScenes(profile, seed)` (`SongScenePlan.js`) picks the song's biomes and one view per biome, deterministically. A song can visit several biomes; the first is its home.
- `src/library/SongWorld.js` stores a compact record per track (seed plus five watch values: `drive`, `onset`, `texture`, `arc`, `contrast`) and produces the `World: ...` label without downloading terrain.
- Material families with more than one source view: dry-conifer (Tetons, Sawtooth, San Juan, Crater Lake, Pend Oreille), steppe (White Mountains, Sierra, Badlands), icefield (Denali, Chugach), canyon (La Sal, Monument Valley), desert (Panamint, Superstition), broadleaf (Black Mountains, Shenandoah). Wet-conifer, tundra, taiga, pine-oak and chaparral have one source each.

**The rise**
- `src/world/alpine/LandRise.js`: `drawnY = baseM + s * (y - baseM)`, one `s` for the whole view. `compileLandRise` integrates `0.6 + energy` over heard time, starts at 1/3, completes before the closing camera move, and is a pure function of heard time with a freeze/handoff contract for re-analysis.
- GLSL `riseLift(vec3 p)` already receives position and `gradNormal` already handles horizontal gradient terms. CPU helpers (`landRiseLift`, `risenHeight`, `risenFloor`, `risenSphere`) keep positional arguments.
- Fourteen files consume the rise: `BuildOcean`, `CompiledTerrainGL`, `ForestCulling`, `ForestDetail`, `ForestGL`, `LandRise`, `MirrorScissor`, `RangeAtmosphere`, `RangeScene`, `RiseGround`, `TerrainChunks`, `TerrainDeform`, `TerrainMaterial`, `TerrainWindow`. Also `LandRiseCamera.js`.
- A comment in `TerrainDeform.js` states the terrain fragment shader is at the mobile uniform budget.
- `RiseGround.js` exists to fill holes in view-culled packages while the land is flat. It costs 1,009,053 bytes per view.

**Song structure**
- `src/audio/StructureAnalyzer.js` produces sections with repeat labels from a self-similarity matrix. `src/world/terrain/SectionRoles.js` assigns roles and finds the chorus group (the repeated label with the highest mean energy).
- Playback starts on an opening analysis; whole-song analysis replaces it later. `LandscapeScore.js` already handles that handoff for phrases, weather, lens cues and rise.

---

## 2. Pilot evidence (2026-11-10)

`tools/range-compose-pilot.mjs` on `pilot/range-compose` cut Grand Teton, Heyburn Mountain and Mount Sneffels from three shipped dry-conifer packages and drew a CPU still.

- The composed skyline read as one continuous range with no visible join along the ridgeline.
- Radial feathering produced smooth featureless skirts, which filled most of the foreground.
- Missing ground was 1.8% for Grand Teton, 25% for Heyburn and 38% for Sneffels. The Sneffels feather band reached a 95th-percentile slope of 2.9 against 1.15 in its interior, from tile-culling edges.
- Pieces placed at their source viewing distance (7 to 18 km) overlapped heavily and the smallest massif dominated the foreground.
- The still came from a crude CPU renderer. It proves nothing about forest, water, materials, production lighting or device performance.

Consequences carried into this plan: cut from source DEMs, cut along valleys instead of circles, assign slots by size, and judge the look only in the production renderer.

---

## 3. Design decisions

Each has a default so work is never blocked. Section 9 lists the ones the owner may want to overrule.

- **D1. Real terrain only.** Pieces are measured DEM. The only invented ground is the stage floor between pieces, kept low and mostly under water.
- **D2. One material family per song.** The family comes from the song's home biome. Pieces never cross families.
- **D3. Layout from identity, build from structure.** The layout derives from the stored song world record (seed and watch values), which is available before terrain loads and stable across plays. The per-slot build schedule derives from sections, which can arrive later.
- **D4. Fixed stage templates.** A template defines the grid, floor, lake level, slots and one camera rail authored once. Pieces drop into slots. Per-song camera scouting is avoided entirely.
- **D5. Stage grid matches a standard view.** 2241 x 2241 samples at 20 m, 35 x 35 tiles, so existing memory budgets, surface texture size and quality rungs hold.
- **D6. Pieces are tile-aligned blocks with zero relief on their border.** Height is stored as relief above the piece's own base. Because every block meets the floor at zero relief, slots join without runtime resampling, and neighbouring slots can rise at different rates without opening cliffs.
- **D7. Translation only at runtime, plus optional mirroring.** Each piece is stored in a frame whose +Z points toward its source viewer. A slot off the centre line sees the piece up to the slot's azimuth off-axis, which pieces must cover.
- **D8. True scale.** Pieces keep their real dimensions. Large massifs go to far slots, small ones to near slots.
- **D9. The assembler emits ordinary terrain data.** Everything downstream of `decodeTerrain` stays as it is.
- **D10. Flag first.** `?songRange=1` enables the path. Catalog views and the scalar rise remain the default until the owner decides otherwise. Any failure falls back to the catalog view for that song.

---

## 4. Global constraints

- Branch `feature/song-range` from `main`. One draft PR per phase. Never push to `main`.
- Node 24. If the host has another version, say so and list what could not run.
- Evidence goes under `.smoke/<unique-run>/`. Nothing captured enters Git.
- Do not mark any view or piece `approved`. New catalog entries are `candidate`. Eligibility and approval metadata must stay truthful.
- Keep every shipped package, pin and hash intact. New assets get their own pins and manifest checks.
- Carry source attribution and licence text for every piece into the composed view's `credit`, and update `NOTICE` files.
- Claim a visual, musical or device result only when observed. Name the song, timestamp and machine.
- The JOYING JY-UTS18N12 head unit remains the performance target and stays unverified unless actually run.
- Report failed, skipped and unrun checks in each phase report.

---

## 5. Phases

### Phase 0: Ground truth and spec

Files: new `docs/superpowers/specs/2026-11-10-song-range-composition-design.md`.

- [x] Read `docs/landscape-rise.md`, `docs/song-world-library-2026-11-06.md`, `docs/compiled-terrain-experiment.md`, `docs/landscape-camera.md`, `docs/range-v2-progress.md`, `docs/local-validation.md`, and the pilot script.
- [x] Confirm Node 24 and a working GDAL Python (`findGdalPython` in `tools/lib/terrain-source.mjs`).
- [x] Rebuild the normalized DEMs for `teton-jackson-lake`, `sawtooth-redfish-north`, `san-juan-sneffels-north` and `crater-lake-watchman-east` with `node tools/build-range-scene.mjs --view <id>` (no `--publish`). Confirm each grid's coverage and that its height hash matches the shipped manifest's `source.demSha256`.
- [x] Find how a diagnostic override selects a specific view (the song-world doc says such overrides exist) and how `tools/landscape-review.mjs` targets one.
- [x] Find how chapter travel between biome views interacts with the rise (`SceneTravel.js`, `ProfileTravel.js`, `ChapterPlanner.js`).
- [x] Count samplers and uniform vectors in the terrain fragment and vertex shaders at the mobile rung.
- [x] Write the spec from Section 3 plus what these checks found.

**Gate G0:** DEMs rebuild with full coverage. If GDAL or the downloads are unavailable, stop and report. Do not substitute shipped packages.

### Phase 1: Offline composed stage in the production renderer

This is the decisive, cheap test: compose offline, bake with the existing baker, and look at it in the real renderer before building any runtime.

Files: new `tools/lib/massif-cut.mjs`, `tools/lib/stage-compose.mjs`, `tools/build-song-range-pilot.mjs`, `data/terrain/stage-templates.json`, tests `test/massifCut.test.js`, `test/stageCompose.test.js`.

- [ ] **Massif detection.** Seeds are the named landmarks plus peaks found by prominence on a coarse lattice. Reuse the drainage and ridge analysis in `TerrainHierarchy.js` where practical.
- [ ] **Cutting along valleys.** The piece mask follows height above nearest drainage (the hierarchy's `relief01`), combined with a distance window, so piece edges fall on real valley floors. Snap the block to whole tiles (multiples of 1,280 m), force a zero-relief ring at least two cells wide on the border, and reject a piece whose pre-feather border relief exceeds a threshold you set from the data.
- [ ] **Piece record.** Relief grid at 20 m, base elevation, peak relief, tile footprint, facing frame, the fan of view directions it covers, character scores from `skylineFeatures` and `characterFromFeatures` seen from the facing side, source view, credit and licence.
- [ ] **Stage template `lake-amphitheatre-a`.** Grid per D5, lake level, floor, and three rows of slots: a horizon row of long low ridges, a back row for the tallest pieces, a front row for small ones. Slots do not overlap in plan. Their screen projections from the rail must overlap so front pieces cover gaps in the row behind. Author one camera rail that passes `cameraRailErrors` and keeps the eye on the floor.
- [ ] **Floor.** Start with level ground at the lake shore and a lake covering most of the centre. Iterate here if the captures show bare skirts.
- [ ] **Compose three fixed layouts** from dry-conifer pieces into `readDemGrid`-shaped grids, bake each with `bakeTerrain`, and publish each as a `candidate`, non-experimental catalog view reachable only by the diagnostic override.
- [ ] **Tests.** Zero no-data cells; zero relief on every block border; determinism (same inputs, same bytes); feather-band slope 95th percentile at or below the piece's interior 95th percentile; catalog validation and `npm run test:rise-coverage` pass for the new views.
- [ ] **Captures.** Use `npm run review:landscape -- --out .smoke/<run>` on the RTX 3060 for each layout at rise 1/3, 2/3 and 1, day and one storm or dusk variant, plus one continuous playback of a full song. Inspect every image yourself and write down what you see.

**Gate G1 (owner):** In production captures the skyline is continuous, the ground between massifs is acceptable, forest and snowline look plausible across pieces from different source elevations, and the scalar rise still looks right. If two rounds of iteration on cutting, floor and template fail, stop and report with the captures.

### Phase 2: Planner, song to layout

Files: new `src/world/terrain/SongRangePlan.js`, generated `src/world/terrain/massifCatalogData.js`, new `tools/song-range-uniqueness.mjs`, tests `test/songRangePlan.test.js`; edits to `src/library/SongWorld.js` behind the flag.

- [ ] **Signature.** `planSongRange(profile, seed, { catalog, templates })` returns `{ version, family, templateId, slots: [{ slotId, pieceId, mirrored }], baseM, label }`. Pure: no downloads, no decoding, no GPU.
- [ ] **Family and template.** Family from `chooseSongBiomes(profile, seed)[0]`. Template chosen by seed among those the family supports.
- [ ] **Principal massif.** Match the song's terrain target (`songTerrainTarget`) to piece character with the existing axis distance, fair-share floor and `seedTicket`, restricted to pieces that fit the principal slot's size class.
- [ ] **Remaining slots.** Seeded draws without replacement, constrained by each slot's size class, preferring pieces from different source regions. `mirrored` is a seeded coin per slot.
- [ ] **Determinism.** No recent-view history. Order candidates by stable id. A `SONG_RANGE_VERSION` constant changes when rules change.
- [ ] **Uniqueness tool.** Over 10,000 synthetic records and the existing 16-profile evaluation corpus, report distinct layouts, the chance two given songs share a layout, the expected number of colliding pairs in libraries of 500 and 5,000, and the share taken by the most common principal massif. State plainly what catalog size each number assumes. With `p` pieces in a family and `K` slots the ceiling is `p!/(p-K)! * 2^K`; twelve pieces and four slots give 190,080.
- [ ] **Label.** `describeSongWorld` returns `World: <principal massif> range` when the flag is on, with the same caching and the same zero-download rule.
- [ ] **Tests.** Determinism, version stability, slot-class constraints, no piece repeated within a layout, label agreement between the compact record and the full profile over 10,000 comparisons.

**Gate G2:** The uniqueness report exists and the owner accepts the collision numbers for the current catalog size, or accepts them as a target for Phase 5.

### Phase 3: Runtime composition behind `?songRange=1`

Files: new `src/world/alpine/StageAssembly.js`, new assets under `src/assets/range/v2/massif/`, new `tools/build-massif-library.mjs`; edits to `RangeAssets.js`, `SceneCatalog.js`, `TerrainPackage.js`, `TerrainMesh.js` as needed; tests `test/stageAssembly.test.js`.

- [ ] **Piece packages.** Reuse the tile encoding of `midio.terrain` so `decodeResiduals` and the tile decoder are shared. Store every tile at stride 1 with `errorsM` for coarser strides. Add a manifest kind so a piece is never mistaken for a view. Pin each by sha256 in the massif catalog.
- [ ] **Runtime LOD.** Add a function that picks a tile's stride from its `errorsM`, its distance to the stage rail, the lens and the budget's pixel error, mirroring the baker's rule. Decide whether to precompute strides per slot offline instead; choose by measured load time.
- [ ] **Assembler.** Fetch the floor and the chosen pieces in parallel. Decode, mirror if flagged, add the stage base, translate tile indices to the slot, choose strides, optionally drop tiles hidden from every rail station, and synthesize a manifest that passes `validateTerrainManifest`. Return the same shape `decodeTerrain` returns.
- [ ] **Hydrology.** Each piece carries its own flow bytes from the offline bake. Floor tiles carry the lake as water. Authored rivers are absent on composed stages.
- [ ] **Integration.** A stage view record carries a plan in place of `terrainManifestUrl`. Extend `sceneViewErrors` for it. Composed stages replace the home biome's view only; other chapters keep their catalog views in this phase.
- [ ] **Fallback.** Any fetch, hash, decode, validation or memory-admission failure selects the catalog view for that song, logs once, and increments a stat.
- [ ] **Memory.** Admit the assembled stage through the existing ledger. It must fit where a standard view fits. If the stage has no holes, skip `RiseGround` for it and prove that with a coverage check.
- [ ] **Parity test.** Assembling a Phase 1 layout at runtime reproduces the Phase 1 offline heights at every sample within quantization (0.09 m).
- [ ] **Measurements.** Download bytes per song, time from plan to prepared view, peak and resident memory, triangle counts per band, all against a standard view on the same machine.

**Gate G3:** With the flag on, captures of the three Phase 1 layouts match their Phase 1 counterparts, the parity test passes, and load time and memory are reported next to a standard view's.

### Phase 4: Song-structured build

Files: edits to `LandRise.js`, `LandscapeScore.js`, `RangeScene.js` and the rise consumers listed in Section 1; new tests in `test/landRise*.test.js`.

- [ ] **Per-slot rise in the shader.** Preferred: a small single-channel texture at stage tile resolution whose texel is the owning slot's rise, sampled in `riseLift`, updated each frame. Alternative if the sampler or uniform budget refuses it: a per-vertex slot attribute with a small uniform array in the vertex shader and a varying into the fragment shader. Choose from the Phase 0 counts and record why. Catalog views keep the scalar path byte-for-byte.
- [ ] **CPU consumers.** Position-aware helpers look up the slot's rise. Bounds, culling and streaming windows use the lowest and highest slot rise conservatively. The stage eye stands on the floor, so camera clearance is unaffected; verify that rather than assume it.
- [ ] **Schedule.** `compileStageRise` is a pure function of heard time returning one rise per slot. Every slot starts at one third. The principal massif advances during sections in the chorus group. Other slots are assigned to the remaining labels in order of first appearance and advance during their sections. Within an owning section, progress integrates `0.6 + energy`. Every slot reaches 1 by the existing end time, with any shortfall made up in the final stretch.
- [ ] **No sections yet.** During the opening analysis, slots rise in a staggered back-to-front order from the scalar curve.
- [ ] **Handoff.** When whole-song analysis arrives, each slot continues from where it stood, never drops, and takes at least the existing catch-up time to finish.
- [ ] **Tests.** Purity under seeks, per-slot monotonicity, completion at the end time, handoff without jumps, the no-sections fallback, and exact agreement with `compileLandRise` for a one-slot stage.
- [ ] **Captures.** Three songs with clear verse and chorus structure, full playback, with section boundaries logged against which slot is rising.

**Gate G4 (owner):** Watching those three songs, the owner can tell which part of the music builds which mountain.

### Phase 5: Breadth and the default decision

- [ ] Add DEM-only source regions for the single-source families. Pieces need no authored camera, so this reuses normalization without scouting. Target at least twelve pieces per family.
- [ ] A second and third stage template.
- [ ] Captions and the library label wording, per Section 9.
- [ ] Report repository growth from piece assets and propose a budget.
- [ ] Decide with the owner how composed stages interact with multi-biome chapters.
- [ ] Run on the JOYING head unit and report.
- [ ] Owner decides whether composed ranges become the default.

---

## 6. Risks and the check that answers each

| Risk | Check |
| --- | --- |
| Ground between massifs looks artificial | Gate G1 captures in the production renderer |
| Forest line and snowline disagree across pieces from different base elevations | G1 captures; consider normalizing stage base per family |
| A piece shows a missing or coarse face from an off-axis slot | Coverage fan in the piece record; per-slot visibility test in Phase 1 |
| Load time or memory exceeds a standard view | Phase 3 measurements |
| Shader uniform or sampler budget on mobile | Phase 0 counts; Phase 4 alternative path |
| Too few pieces for real uniqueness | Phase 2 uniqueness report |
| Section detection is weak on some songs | Phase 4 fallback and per-song capture notes |
| Repository size | Phase 5 report |

---

## 7. Out of scope

- Procedurally generated mountains.
- Changes to Trio, the legacy ridge renderer, shot tours on catalog views, or the matcher for catalog views.
- Bringing the cast back into Landscape.
- Removing any catalog view.

---

## 8. Reporting

After each phase, add to the Execution record: commits, what was built, tests run with counts, tests not run and why, capture locations, measurements with machine and browser, and what you observed in the images. Then stop at the gate.

---

## 9. Owner decisions, with the defaults this plan uses

1. **Label.** Default `World: <principal massif> range`. Alternatives: list every massif, or generate a range name.
2. **Opening caption.** Default names the principal massif and its real location.
3. **Mirroring.** Default on. It doubles variety per slot and shows real mountains reversed.
4. **Chapters.** Default: the composed stage is the home view only, other biomes keep catalog views.
5. **Catalog views.** Default: kept, and used as the fallback.

---

## Execution record

### Phase 0 (2026-11-10)

**Built.** `docs/superpowers/specs/2026-11-10-song-range-composition-design.md`
and this plan. Documentation only; no runtime or asset change.

**Environment.** Linux cloud workspace. Host Node was 22.23.4; all commands ran
under an official Node 24.22.2 tarball. GDAL 3.8.4 Python bindings from
Ubuntu's `python3-gdal` under `/usr/bin/python3.12`. Playwright
`chromium-headless-shell` 156 on SwiftShader for shader linking. No RTX 3060
and no JOYING head unit.

**Gate G0: met.** All four normalized DEMs rebuilt with 100% valid samples.
Sawtooth, San Juan and Crater Lake match the shipped `source.demSha256`
byte for byte.

**Where the plan and the code disagree.**

1. Teton's rebuilt grid hash differs from the shipped `source.demSha256`. The
   3DEP files and window hashes are identical, and every stored sample of the
   shipped package (1,350,615 samples, 882 tiles) matches within half a
   quantization step. The difference lies in ground the package does not ship,
   on the 44° N 3DEP tile seam (rows 177 and 178). The normalizer documents
   the cause. The spec adds D11: multi-tile sources for pieces use
   `windowCache: 'tile'`, and pieces record their own grid hash.
2. Section 1 says shipped packages hold only the ground their cameras see. A
   local no-publish bake kept 251 Teton tiles where the shipped package has 882,
   so shipped coverage is wider than a rail-only bake. Both views carry shot
   libraries. Not investigated; pieces never come from packages.
3. There is no rise override. Phase 1 captures at fixed rise need a diagnostic
   `?rangeRise` and a matching review-tool option.
4. The source grids are not all 2241 x 2241. Sawtooth and Crater Lake are
   1601 x 1601, San Juan 1601 x 1801.
5. The fragment shader's budget is measured. It uses 218 naive vec4 rows of
   WebGL2's guaranteed 224, and 12 of 16 samplers. The vertex stage uses 37
   rows and 2 samplers. Phase 4's slot-rise texture therefore goes in the
   vertex stage only (D12).
6. The rise is one song-global scalar that also drives the incoming and
   outgoing views during chapter travel. The spec defines the stage's scalar
   as the mean of its slot rises.

**Tests.** None run. This phase changes documentation only.

**Checks run.**

| Check | Result |
| --- | --- |
| `node tools/build-range-scene.mjs --view <id>` x 4 | exit 0 each |
| Coverage and height hash against shipped manifests | 4/4 complete coverage; 3/4 hash match |
| Lattice-exact shipped-sample comparison (Teton, Sawtooth control) | 0 samples over 0.026 m in both |
| Teton `envelope` against `tile` layout | 1,008 cells differ, rows 177 and 178 only, maximum 0.62 m |
| Terrain program uniform and sampler counts | See the spec's shader-budget table |

**Not run.** `npm test`, lint, browser captures. No RTX 3060 or JOYING checks.

**Evidence** (local `.smoke/`, not in Git): `p0-dem/build.log`,
`p0-dem/dem-check.json`, `p0-dem/teton-diff.json`, `p0-dem/sawtooth-diff.json`,
`p0-dem/teton-layout-diff.json`, `p0-shader/budget.json`.
