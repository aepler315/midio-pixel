# Range v2 progress

Plan: `docs/superpowers/plans/2026-09-29-range-geodata-master.md` (copied verbatim from the supplied package; removed, see [removed docs](removed-docs.md)).
Reference image: `docs/evidence/range-v2/reference.webp` (1806×871, documentation only; never staged into `/src`).

## Coherent terrain continuation — 2026-10-01

The implementation branch `codex/coherent-terrain-performance-20261001` adds actor-free composition, heard-time ridge advection, causal physical release, uniform output fitting, optional foreground composition and bounded water controls. All 13 approved views retain normal-picker coverage. New Teton/Monument `-coherent` variants and Pend Oreille remain forced candidates with no new approval.

Current evidence and remaining gates are recorded in [terrain continuation](evidence/terrain-continuation/README.md). Full suite: 3672 passed, 5 GDAL skips, 0 failures. Dependency-based runtime rebuild and staged delivery pass. CPU evidence is reproducible; current GPU captures, decoded export, real-song motion review and physical-device performance remain pending. No merge/deployment was performed.

## State

| Field | Value |
| --- | --- |
| Branch | `claude/amazing-brown-tbiycu` |
| Base | `b8a3d72b344792d149906449f1cd86d68df8cc2b` (= audited SHA; `origin/main` rechecked 2026-09-29) |
| Last completed task | 16; Task 17 in progress (v2 default, 13 approved views, evidence identity) |
| Next action | Task 17: the §10 sequence on the staged site (`--suite complete`), `docs/range-v2-validation.md`, diff review; device runs per `docs/range-v2-device-runs.md` |

## Decisions recorded with the user (2026-09-29)

- Runtime asset ceiling: **≤ 60 MB** total under `src/assets/range/v2/` (plain files, no Git LFS).
- Materials: **hybrid**. Procedural, offline-baked colour ramps and masks everywhere; procedural detail on distant terrain; CC0 photo-scan **normal/roughness data only** (no scan albedo) for the rock stage and nearest terrain. Provenance recorded per file.

## Environment (this execution session)

| Capability | Status |
| --- | --- |
| Node / npm | v22.22.2 / 10.9.7 |
| Python + GDAL | `/usr/bin/python3.12`, GDAL 3.8.4, numpy 1.26.4, Pillow 10.2.0 (apt `gdal-bin python3-gdal python3-numpy python3-pil`). The default `python3` (3.11) has no GDAL bindings. |
| ffmpeg | 6.1.1 (apt) |
| Browser | Playwright Chromium 1194 at `/opt/pw-browsers/chromium-1194/chrome-linux/chrome` (set `PLAYWRIGHT_CHROMIUM_PATH`). |
| WebGL2 | Available only through **SwiftShader** (software, `--use-angle=swiftshader --enable-unsafe-swiftshader`). No physical GPU and no phone: every frame timing from this session is software-rendered and **not** a device measurement. |
| Network | Terrarium tiles (AWS), USGS TNM API + `prd-tnm` S3, ambientCG API, npm registry reachable. Poly Haven download host returned 521. |

## Baseline (Task 0)

| Command | Result |
| --- | --- |
| `npm ci` | ok |
| `npm test` | 3228 pass / 0 fail |
| `npm run lint` | clean |
| `npm run stage:site` | ok |

## Audit findings re-checked at base

The four confirmed defects in plan §1 are re-verified in Task 1 against source before editing.

## Task status

| Task | State | Notes |
| --- | --- | --- |
| 0 baseline | done | 3228 tests at base |
| 1 quality/RNG/evidence | done | level-6 fixture captures now record actual 6; one final draw |
| 2 DEM normalize | done | 3DEP 1/3" COG windows + Terrarium fill (Canada), local tmerc, provenance per window |
| 3 bake + runtime bundle | done | heightfield tiles (documented deviation from explicit Float32 buffers for the 60 MB budget); occlusion-aware LOD |
| 4 corridor | done (geometry) | Ross Lake north pilot, 21 stations; Diablo/Baker Lake/Shuksan rejected with reasons |
| 5 selection | done | approved-only pool, 15/85, recency, explicit fallback; HOME_BIOME_FAIR_SHARE split |
| 6 travel + frame | done | sceneProgressAt == legacy fitted scroll; frozen RangeFrame; shared deformation |
| 7 residency | done | shared ledger incl. legacy strips; budgeted, generation-safe asset prep; staging verifies assets |
| 8 integration | done except recorder evidence | markers verified in main stage + real bulk-export MP4; recorder check timed out because software-GL live playback outran the 96 s fixture song — rerun with a longer song |
| 9 materials | done (pilot quality) | 11 packs, CC0 data maps + procedural; exposure calibrated to reference values; rock still reads smooth at 20 m spacing — revisit in Task 13 |
| 10 forest | done | 13 m lattice, stable quality subsets, instanced near conifers + far silhouette billboards; water rejection uses all four neighbouring samples |
| 11 rock stage | done | slabs on the rendered support curve every frame; broken ledges; pools level-tested on the slab and contained by its face; exact polygon wet masks. Found+fixed: y-down ortho camera culled every face; per-frame BufferAttribute leak |
| (fix) terrain shader | done | `triplanar()` called `triplanarRib()` before its definition, so the terrain program never linked in the app (only trees drew). Guarded by `test/rangeShaderSource.test.js` and shader-error detection in the scene smoke |
| (fix) residency | done | legacy strips for v2-covered biomes dropped/not prebaked: pilot 267 MB -> 110 MB of the 256 MiB budget |
| 12 reflections | done | single body draw into ordered source-over/lighter segments; mirror about each pool's water plane; clip = pool polygon ∩ slab top. Pilot pixel check: 124-129 px in pools, 0 elsewhere, paused re-render identical |
| 13 atmosphere/pilot | done | mist, secondary celestial + clouds; motion pilot 20 s @ 12 fps from 0 s (opening included), calm/energetic stills, backward seek 32 s -> 8 s returns to the identical rail position; `nc-ross-lake-north` approved against its terrain/material/camera hashes (catalog v2; a changed asset voids the approval). Evidence: `docs/evidence/range-v2/pilot-ross-lake-*.jpg` |
| 14 transitions/framing | done | View-to-view travel keeps the outgoing view and composites an incoming side (own target `range:render-target-B`, reserved before use, released after) through the shared travel seam (`src/world/TravelSeam.js`), nearest partition first; a loading/failed/unaffordable incoming view leaves the outgoing one drawing. `scenicProjection` keeps terrain at nominal pixels-per-radian under pull-back/overscan; DPR never changes framing; worst case (ZOOM_MIN + 64 px shake) is inside the extended bake. Mid-song legacy -> v2 handoff fades in over 1.2 s of heard time (legacy scenery drawn underneath; exports never fade). Far-crest exposure (legacy `MIN_EXPOSED` 0.55) measured on the shipped package at 21 stations and at 21 seam samples of every approved-view pair; `--approve` refuses a view below it. Ross Lake: 0.65-1.00 |
| (fix) approval identity | done | Review of PR #334: an approval now also covers the view's `materialRules` (key-sorted hash), hashes the published `.terrain.json` on disk rather than the build record's copy, and requires at least one existing evidence file. Ross Lake re-approved with the same evidence (catalog v3) |
| (fix) travel review round 2 | done | PR #334 second Codex round: the two sides blend in a reserved composition buffer (`range:travel-scratch`) with B added (`lighter`) so the feather stays opaque; a view that joins a travel late fades in over 1.2 s; the frame's resources are pinned before side B / the buffer are reserved; the app passes export mode to the presentation (the simulation never had it); travel exposure is checked at matching stations (both sides share the song's progress) and `--approve` checks every pair with the views already approved |
| (fix) travel review round 3 | done | PR #334 third Codex round: a late-joining view still fading when the travel ends keeps the A/B handoff (seam fully across) until its fade completes, and only a view some travel frame drew without counts as late; legacy-only passes (far shore, mirage, sea, sea life, horizon EQ) keep drawing under an arriving scene; exposure is measured per runtime partition from each shipped tile's own `band` (nearest-band masks), a travel composes the far/mid/near passes through their own seams (L2/L4/L5), and `--approve` also requires a far crest spanning half the frame at every station |
| 15 catalog | done | 11 approved views, one per biome (catalog v15); each passed the far-crest gate alone and in travel against every other view (0 failing pairs); habitat/shoreline fixes from the colour review; see the approvals table below |
| 16 lifecycle/perf | done (device runs unverified) | Budget crowding, fallback-strip lock-out, rock-stage crash and striped seam found and fixed; lifecycle suite 6/6 cycles (song replacement, resize, real context loss/restore) with stable ownership; v2 quality ladder; device probe + instructions. No phone or GPU here: device acceptance is **unverified** |

## Task 15 coverage (candidates)

One corridor per biome, chosen on a range that `RealBiomes.biomeOfRange` already puts in that biome, for a strong readable far crest. Summit checks compare the published height with the DEM maximum within 200 m.

| Biome | View id | Range (RESOLVE ecoregion) | Elevation source | Summit check |
| --- | --- | --- | --- | --- |
| RAINFOREST | `nc-ross-lake-north` (approved) | North Cascades | 3DEP 1/3" + Terrain Tiles | Jack Mtn 2763 |
| CONIFER | `teton-jackson-lake` | Tetons (South Central Rockies forests) | 3DEP 1/3" | Grand Teton 4199 / 4189; Moran 3842 / 3841 |
| ICEFIELD | `denali-wonder-lake` | Alaska Range (Rock and Ice) | Terrain Tiles z12 (the 3DEP query returned no Alaska coverage) | Denali 6190 / 6161; Foraker 5304 / 5313 |
| TUNDRA | `tombstone-north-klondike` | Yukon Ranges (Ogilvie-MacKenzie alpine tundra) | Terrain Tiles z12 | Tombstone 2192 / 2151 (located as the DEM maximum; the thin spire is under-resolved at z12 once the edge spikes are removed) |
| TAIGA | `muncho-lake-south` | Tower of London Range (Northern Cordillera forests) | Terrain Tiles z12 | lake located from the DEM (flat water mask) |
| PINE_OAK | `izta-popo-west` | Trans-Mexican Volcanic Belt pine-oak forests | Terrain Tiles z12 at 36 m (finer cells were refused as upsampled) | Izta 5230 / 5208; Popo 5426 / 5410 |
| BROADLEAF | `black-mountains-catawba` | Blue Ridge (Appalachian-Blue Ridge forests) | 3DEP 1/3" | Mitchell 2037 / 2036 |
| CHAPARRAL | `san-gabriel-baldy` | San Gabriel Mountains (California montane chaparral) | 3DEP 1/3" | San Antonio 3069 / 3068; Baden-Powell 2865 / 2864 |
| STEPPE | `white-mountains-owens` | White Mountains (Great Basin shrub steppe) | 3DEP 1/3" | White Mtn Peak 4344 / 4340 |
| CANYON | `la-sal-castle-valley` | La Sal Mountains (Colorado Plateau shrublands) | 3DEP 1/3" | Peale 3877 / 3876; Castleton Tower 2025 / 1965 (thin spire under-resolved at 22 m) |
| DESERT | `panamint-dantes-view` | Panamint Range (Mojave desert) | 3DEP 1/3" | Telescope 3366 / 3361 |

Terrain and material fixes found while reviewing these views (they apply to every view):

- **Spikes.** Terrain Tiles carried a cluster of fake 4200 m samples at the Tombstone grid's edge, and a few single-sample needles at Tombstone and Denali. The build now lowers any sample (or cluster up to three across) that stands more than 2 cell widths per ring step above its surroundings (~63 degrees) and records the count; no 3DEP view triggers it.
- **Dry flats.** A view can declare `water: false`; Badwater's salt pan was being marked as a lake.
- **Gentle-ground smoothing** (Terrain Tiles views only) softens resampling steps on flats; 3DEP views are untouched.
- **Cliff mask bug.** `smoothstep(max(40, forestMaxSlope - 6), forestMaxSlope + 10, slope)` inverts when a pack's forest limit is below 30 degrees (tundra, 20): every tundra flat was bare rock, and the rock detail texture tiled into a visible grid. The edges are now kept ordered (test in `test/rangeShaderSource.test.js`).
- **Alpine ground.** Above the treeline, rock now follows slope and convexity; gentle alpine ground stays meadow / tundra mat.
- **Surface normals** are taken from a bilinear surface across each tile's stored sample spacing, so coarse tiles no longer shade as flat triangle facets.
- **Snow** blends two unrelated tile scales; the snow/tree line breakup uses smooth value noise instead of a per-23 m-cell hash; drainage moss fades out on flats (filled-flat D8 routing is straight diagonal channels).
- A faint residual pattern remains on Tombstone's tundra valley floor at close range; recorded in its review.

Second review pass (colour in-app frames of all ten candidates):

- **Lake holes.** A tile's stride was chosen from height error alone, so a flat lake tile could fall to its four corners and ship half dry (Muncho Lake showed rectangular notches). A tile holding both water and land now keeps stride <= 4 (`SHORE_MAX_STRIDE`), and the surface texture draws water as the bilinear half-coverage contour of the four samples instead of the nearest sample (identical on stride-1 tiles). Re-baking changed only shoreline tiles: Tetons 18 of 251, Ross Lake 1 of 355; both were re-baked and re-approved.
- **Dry valley floors.** Steppe, canyon and desert packs placed 18-48 m conifers down to the valley floor (Owens Valley, Castle Valley read as dense forest). New optional pack rules: `forestFloorM` (lower forest limit, same stand breakup as the treeline, in placement and shader), `treeScale` (tree size), `airScale` (distance haze). Steppe 2000 m / 0.3, canyon 1700 m / 0.45, desert 1800 m / 0.3; pine-oak 2700 m (Mexican valley floors are farmland). Absent rules keep the old behaviour exactly, so the approved packs (wet-conifer, dry-conifer, icefield) are untouched.
- **Clear desert air.** `airScale` 0.5-0.6 for desert, canyon and steppe.
- **Broadleaf.** The treeline was 1600 m, so the Black Mountains' spruce-fir summits (Mitchell 2037 m) drew as bare ground; now 2300 m, with lighter deciduous canopy greens. The remaining grey at night is the shared night air over a dark forest, the same as the Tetons' forest.
- **Summer taiga and tundra.** Taiga snowline 900 m / treeline 700 m put Muncho Lake (817 m) above the treeline and under snow; now boreal forest to 1400 m and snow above 2000 m. Tundra snowline 1200 -> 1900 m. Both were indistinguishable from the icefield pack.

First placements that failed, and why: the Black Mountains from Craggy Pinnacle hid the far crest at 18 of 21 stations (nearer ridges; now seen broadside from the Catawba side); Muncho Lake's first eye sat in the mountains east of the lake; the Tetons from the east shore were too far for the range to read (moved over the lake).

## Task 15 approvals (catalog v17, 2026-09-29)

Each view: 21-station neutral/silhouette review, 61-frame motion review, in-app frame at 10 s (`docs/evidence/range-v2/<id>-stations.jpg`, `<id>-inapp-10s.jpg`), and the far-crest gate at its worst station (single) and in travel against every other approved view. Hashes are the approval record's (first 12 hex).

| Biome | View | Terrain | Material | Worst single | Notes |
| --- | --- | --- | --- | --- | --- |
| RAINFOREST | `nc-ross-lake-north` | 32ee5822fccb | 8f5ff6bb64b0 | 0.64 | re-approved after the shoreline re-bake (1 of 355 tiles); keeps its pilot frames |
| CONIFER | `teton-jackson-lake` | bd3b57442d20 | 6afff55ebe77 | 1.00 | re-approved after the shoreline re-bake (18 of 251 tiles, Jackson Lake) |
| ICEFIELD | `denali-wonder-lake` | 351aad9728f8 | ac0da317cbbc | 1.00 | unchanged approval |
| TUNDRA | `tombstone-north-klondike` | 5cbcec0d5132 | 76deaaa34707 | 0.81 | the range sits low in the frame; summer tundra; faint close-range pattern on the valley floor |
| TAIGA | `muncho-lake-south` | d25af9f0f975 | c44b2272c561 | 0.91 | a near hillside fills the right third; the lake and forest read |
| PINE_OAK | `izta-popo-west` | 435e0a01cab2 | 8959b57b8915 | 1.00 | `water: false`: the farmland plain was marked as two lakes |
| BROADLEAF | `black-mountains-catawba` | 0f5d8ce42c05 | 3e8ff42e5065 | 1.00 | softest composition of the set: low, rounded, fully forested ridges under night air |
| CHAPARRAL | `san-gabriel-baldy` | 56871dd030fa | f3357cb770f8 | 0.95 | |
| STEPPE | `white-mountains-owens` | a83a16041b11 | ada04aa0d676 | 1.00 | open Owens Valley floor below the pinyon belt |
| CANYON | `la-sal-castle-valley` | 930f04303855 | ca6259b1e0cd | 1.00 | scattered small trees on Castle Valley |
| DESERT | `panamint-dantes-view` | b7d3479f3160 | 2beecf1f1647 | 1.00 | pale by nature (salt pan, 25 km to the crest); `water: false` |
| ICEFIELD | `chugach-matanuska` | 1dc2cd8e74ff | ac0da317cbbc | 0.82 | Task 17 addition. Chugach Mountains above the Matanuska Glacier (Terrain Tiles z12): a real snow range with its valley opening; a second, different ICEFIELD view beside Denali |
| CANYON | `monument-valley-163` | 78779fcd2a01 | ca6259b1e0cd | 0.76 | Task 17 addition. From US-163 toward the mesa wall and buttes (3DEP 1/3"). View rule `forestFloorM: 1900`: the canyon pack's 1700 m floor put conifers across the valley floor. The floor reads olive rather than red sand (the shared canyon colour ramp) |

13 approved views: every biome has one, ICEFIELD and CANYON two. The plan aims for 12-18.

Task 17 candidate rejected: **`wrangell-copper-river`** (TUNDRA; Terrain Tiles z11). Mount Drum, Sanford and Wrangell are traceable, but the near and middle ground is one broad, smooth shield-volcano slope with little internal relief, filling the left third of the frame. Weaker than Tombstone, and not added for coverage. Its published package was removed; its authoring and review stay in `data/terrain/scenic-views.json`.

### Natural song casts (production selector, no forced view)

Five synthetic songs (`tools/gen-test-wav.mjs`: 120 bpm / 96 s, 80 / 150, 150 / 120, 174 / 100, 100 / 180), opened with `?rangeRenderer=v2` and no `rangeView`, frames at 10, 40 and 70 s. Each song's five biomes got their own approved view, deterministically per seed; the musical skyline pool is independent and still varies by song (the same biome draws different far/mid/near skyline ranges in different songs, e.g. TUNDRA and PINE_OAK, and each song draws its own horizon and massif ranges).

| Song | Biomes | On screen at 10 / 40 / 70 s |
| --- | --- | --- |
| 120 bpm, 96 s | RAINFOREST, CHAPARRAL, CONIFER, ICEFIELD, PINE_OAK | Ross Lake / Ross Lake / Denali |
| 80 bpm, 150 s | DESERT, ICEFIELD, CANYON, STEPPE, TAIGA | Panamint / Muncho Lake / White Mountains |
| 150 bpm, 120 s | PINE_OAK, CANYON, TAIGA, TUNDRA, ICEFIELD | Izta-Popo / Muncho Lake / Denali |
| 174 bpm, 100 s | TUNDRA, ICEFIELD, BROADLEAF, DESERT, TAIGA | Tombstone / Denali / Denali |
| 100 bpm, 180 s | TUNDRA, ICEFIELD, CHAPARRAL, PINE_OAK, CANYON | Tombstone / Denali / San Gabriel |

15 of 15 frames drew their v2 view, no page errors. The first run of these casts found three defects, all fixed:

- **Views crowded each other out of the budget.** `whenReady` prepared every view of the song at once; later biomes' pending reservations (not evictable) filled the 256 MiB budget, the view on screen was refused and the refusal was permanent, so the biome fell to legacy (whose strips then took 72 MB more). 0 of 6 frames were v2 in the first song. Now a budget refusal is deferred and retried (the biome still counts as covered), `whenReady` prepares in song order and stops at the first view that does not fit, and export frames `settle()` (wait for the views the frame wanted, keeping both travel sides resident) and are redrawn at the same heard time. Opening a natural song went from the 600 s readiness timeout to ~10 s.
- **Rock stage crash.** `RockStageGL._upload` allocated nothing when the first frame had no pools, and the next line threw inside the draw.
- **Striped travel seam.** The shared seam uses 4 constant-weight bands (fine for legacy strips); on real terrain they read as vertical stripes. v2 now uses 16 whole-pixel bands (`V2_TRAVEL_BANDS`); legacy keeps 4.

## No rock stage (catalog v18, 2026-10-01)

Ashton chose to drop the rock-stage ground strip from every Range view. Every authored view now carries `composition: { foreground: 'none', nearLedgeMaxFrac: 0 }`, so the terrain itself reaches the frame's bottom edge. The `-coherent` pilots keep their 12% ledge as the forced comparison.

- **Coverage.** `node tools/range-composition-coverage.mjs docs/evidence/range-v2/no-stage-coverage.json --all`: every catalogue view, 21 stations, nominal camera and the zoom, shake and roll extremes; zero uncovered samples in the lower 12% of the frame.
- **Re-approval.** The composition hash changed, so all 13 views were re-approved with `--approve`, which re-ran the far-crest gates (single and in travel). Each keeps its earlier evidence and adds `<id>-nostage-10s.jpg` and the coverage report.
- **Legacy foreground.** With the strip gone, two legacy foreground layers showed: a cartoon landmark silhouette at the bottom edge, and the soft white veil discs that read as faint circles in the sky. A view that composes its own foreground now draws neither.

## Tombstone forest, terrain seam and edge spike (catalog v19, 2026-10-01)

- Tombstone (tundra pack, treeline 300 m) drew its 1200-1450 m valley floor bare. A view override (treelineM 1550, forestDensity 0.12) brings open spruce taiga to the valley and lower slopes; evidence `tombstone-north-klondike-forest-{10,30}s.jpg`.
- The thin needle above the far ridge right of centre was a 2 x 5 sample blob (up to 4.7 km) on the DEM's west edge, wider than the old despike ring could see. `despikeGrid` now also takes a grey opening with a 3-cell disc and lowers whatever stands more than 120 m (63 degrees) above it, so blobs of any shape up to about six samples across go. Only a blob no wider than the disc in either direction, and within 3 cells of the grid edge or a no-data sample (where source seams leave them), goes, so a long narrow ridge or a compact butte inland stays. Tombstone was rebaked (23 samples lowered: the 10-sample blob and 13 single-sample spikes from the ring pass).
- The faint line across the meadow was the seam between the near and mid partitions: along a band boundary neither pass owned some pixels, so the sky showed through. A nearer band's border tiles now also draw in the farther pass (the same depth pre-pass decides visibility); during travel they draw under the same column scissor as that band, and their index buffers are counted in the view's GPU reservation (their exact size is counted from the tile plan without building anything, so one reservation covers them and a view that cannot fit is denied before the mesh is built).


## Cloud sea in quiet passages (2026-10-02, replaces the topo map)

Ashton asked for an underlying Forest Service topo map that occasionally shows through, and picked "quiet passages" for when. Seen in motion it read as cheesy: it repainted the real, lit land as a flat paper map (red section grid, map colours), hid the lake mirror and folded the trees, which is a UI layer over a place. Contours drawn into the world instead (glowing old shorelines, rime along isolines) were tried and dropped: from the Range's near-horizontal camera every isoline projects to a horizontal stripe and reads as scanlines. The quiet-passage moment is now weather: the valley fills with a sea of cloud and the peaks stand above it.

- **When.** Unchanged from the map: `CloudSea.js` compiles one curve per song from its energy: a 3 s trailing average of `globalEnergyNorm`, quiet within the lowest 30% of the song's own p10..p90 span (fading out by 45%). A quiet stretch must hold 1.5 s; the cloud then rises over 5 s and drains over 3 s once the song lifts. Nothing in the first 8 s (the scene's arrival), or on a song whose span is under 0.15. Indexed by heard time, so seeks either way read the same. `mgr.cloudSeaOverride` holds an amount for review.
- **What.** The shared valley mist (`RangeAtmosphere.js`) fills toward a flat top that rises from 30% to 65% of the way from the valley floor to the eye, so the camera always looks down on it; below the top the density is even (1.5e-3 /m when full) and the banks close up. Its colour is read where the view ray meets the top, so billows lie on that plane in perspective. Terrain and forest share it, the scene lights it, and the lake's mirror and lantern glints are hidden under it. The JS twin (`mistAmount`, `mistParams`) matches.
- **Massif cap.** Over a Range view the spectrum massif sits behind real terrain, and only its crest wire's tip cleared the skyline, as a lone glowing arch. The cap fades with the view's arrival (the body stays).
- Evidence (override, pilot song): `tombstone-north-klondike-cloud-sea-30s.jpg` (full, moonlit), `-cloud-sea-rising-30s.jpg` (0.6), `teton-jackson-lake-cloud-sea-20s.jpg` (full, sunrise).

## Lake mirror (2026-10-01)

Next item from the landscape brainstorm: lakes hold the land around them, as still water does at dusk.

- **Mirror image.** `WaterMirror.js` poses a second camera as the real one reflected about the view's lake level, and `RangeScene` renders every band through it into a half-size target once per frame (fragments below the level + 0.5 m are clipped in both terrain shaders). The water projects its own position through that camera to find what it reflects. A view mirrors only when at least 40 sampled water samples within 3 m of its median water level stand on visible tiles; other water (another level, rivers) keeps the sky.
- **Magical naturalism.** From a rail hundreds of metres above a lake, a physical reflection is nearly all sky. Reflections are drawn as if the eye stood at 0.45 of its height (`MIRROR_LIFT`): the mirror camera sits that much closer to the plane, and the distant backdrop (sky, aurora, moon and far ranges, copied from the canvas as the mid partition starts) is looked up along the same lowered ray. Teton's water now holds the peaks upside down; Muncho's holds its west shore and a moon path. Water reflectance is also raised (0.3 + 0.7 x Fresnel, capped at 0.9).
- **Motion.** Groove and kicks shiver the reflection in horizontal bands; the wind's gust fronts sweep cat's paws across the water (rougher, duller patches that cross the screen with each front).
- **Cost.** One extra render of the bands at quarter area per frame, plus a half-size canvas copy. The quality ladder sheds it at level 4 (after fog samples and sun shafts, before pool reflections); its two buffers are evictable residency entries.
- **Known limits.** Gentle slopes seen from below the water plane face away from the mirror camera, so a shallow far shore reflects in patches. The far partition's own water gets the ground mirror only (it is part of the backdrop it would sample).
- Evidence: `teton-jackson-lake-mirror-20s.jpg`, `teton-jackson-lake-mirror-60s.jpg` (pilot song), `muncho-lake-south-mirror-20s.jpg`.

## The cast as lights (2026-10-01)

> Superseded for routes and peaks by [landscape-cast.md](landscape-cast.md) (2026-10-22): each view now has a job, an Ascent or Lamplighters, timed by song structure; the peaks below are removed. Tour views keep the wandering routes. The light and its consequences are unchanged.

Brainstorm section 6, the "presence ladder" Ashton chose: light is the floor, consequence the body, a brief recognisable figure the peak. Under Range v2 nothing drew Midio, Broshi or Midasus before this.

- **Light.** Each actor is a small lantern in its hue (Midio teal 178, Broshi coral 16, Midasus violet 276) drawn inside the band passes: land in front hides it, the air dims it, and the lake mirror reflects it. Its light reaches the ground and trees (`actorLight`) and lays a path of glints on water. Brightness follows the actor's own lane (`narrative.sources[id].activity`, fast attack, slow release).
- **Where.** `actorRoutes` picks five anchors per actor from tile samples the rail sees, in frame at three rail stations, 0.7-12 km away: Midio skims the lake (else the valley floor), Broshi follows the shore (else low open ground), Midasus drifts in the sky above the land. Each walks its route back and forth; it moves faster while its lane plays (`travel` is integrated per song, so seeks agree).
- **Consequence.** Midio leaves a wake on the water (two opening arms that roughen and break the mirror, catching his light). Trees lean away from Broshi and show their pale sides as he passes. Midasus's light washes the peaks below her.
- **Peaks.** `compileActorScore` finds each lane's own swells (its 1.5 s average crossing from the song's median 65% of the way to its 97th percentile), none in the first 8 s and at most one per actor every 20 s. The swarm of 72 motes around the lantern then gathers into the actor's outline (points along `meshes.js` edges) over 0.8 s, holds 1.5-4 s and dissolves over 2.5 s. `biomes.actorPeakOverride` holds a peak for review.
- Evidence: `teton-jackson-lake-cast-45s.jpg` (pilot song, no peak), `teton-jackson-lake-cast-peak.jpg`, `muncho-lake-south-cast-peak.jpg` (peak held, figures reflected), `tombstone-north-klondike-cast-gathering.jpg` (peak at 0.6, no lake).

## One day per song (2026-10-01)

Ashton asked for songs to open just before sunrise in near-total darkness, with a dramatic sunrise, and to end on a dramatic sunset.

- **Clock.** `songSkyClock` (DayNight.js) replaces the repeating day/night cycle for any song of 30 s or more. It runs 7% of the song (9-22 s) in the dark before dawn, the sun's arc for the body of the song (lingering near the horizon: its pace runs at 1 - 0.6 cos 2 pi u of the mean), sunset 6% (8-18 s) before the end, then afterglow into dark with no moon. Every `cycle` consumer takes the clock in place of a length, so the legacy painters follow the same day.
- **Darkness.** A night with no moon up (`darkness01`) cuts 80% of the night fill and pulls every Range sky stop, the air and the haze 85% toward space; the crest light (alpenglow) dims by 75%.
- **Sunrise and sunset.** `twilightAt` burns from just before the sun crosses the horizon until it is well up: dawn in gold and rose, dusk in red-orange and magenta, as a glow around the sun in the 2D sky and as a tint on the sky stops and air (so distant ranges take the same light). The sun's own colour sinks toward red below altitude 0.35, which lights the peaks in alpenglow.
- **Day.** With the sun high the Range sky opens 60% toward a clear blue.
- **The cast.** The actors' light is strongest in the dark (gain x1.6 at night, x0.45 at noon) and the lanterns soften by day. Broshi starts from the far end of his route so he and Midio do not move as one, and Midasus has her three baby stars, small lights trailing her.
- Evidence (Teton, 90 s song): `teton-jackson-lake-day-{02,09,13,45,80,83,89}s.jpg`.

## A slow sunrise and one wind for the clouds (2026-10-02)

Ashton saw the sun come up "in an instant" and the clouds move as if by accident.

- **Sunrise.** The night used to lift in about 7 s: dayNight's night is a smoothstep across the last stretch of phase before the sun, and the clock walked that stretch at an even pace. The dark before dawn is now 25% of the song (12-24 s). Its first 10% stays fully dark, and after that the clock walks the stretch by the inverse smoothstep, so the night lifts at an even rate. With the sun's slow climb (gold until it is about 0.1 up), a three-minute song's sunrise now runs from first light at about 4 s to full colour at about 50 s. A test holds the night to no more than a tenth per two seconds in a two-minute song or longer, and a fifth in the shortest song that holds a day (30 s).
- **Clouds.** The banks drifted at 4-10 px/s each and two wisps rode along with the moon or sun disc. All banks now drift on one wind, the same way at 0.25% of the width per second (lower banks a little faster), and nothing follows the disc. `RangePresentation._skyPan` measures how far the section move has swung and tilted the sky (`skyTurn`: where the rail's own view direction lies in the moved pose, as tangents), turns that into NDC with the lens the scene renders with (`scenicProjection`), and the clouds pan and rise by it, so they hang over the land when the camera turns or cranes. Each view's rail is its own reference, and during a travel the turn and lens blend across the seam, so a handoff never jumps them.
- Evidence (Teton, 180 s song): `teton-jackson-lake-dawn-grid.jpg` (2-60 s).

## The land moves only at big moments (2026-10-02)

Ashton found the land moving with the song accidental. It heaved all the time: a swell rolling across the ridges at 0.045 Hz sized by groove and sustain, a lift on every kick, a melodic tilt, a summit gesture, and a section lift that dropped and regrew at every boundary. Together they came to 8-20 px. The default chosen for him ("Big moments only") keeps all of those channels on the frame as `music.source` (the water still ripples to the kick, and evidence still reads them) but lets none of them move the ground.

- `landMoment01` (RangeFrame.js) is a pure function of the section list. At each section change the land swells over 3 s, holds for 2 s and settles over 9 s. A lift into a louder part (`boundaryLift01`) swells fully, any other change by 0.35, and a repeat of the same part not at all. The song's start never swells. When the whole-song analysis replaces the opening one during play, boundaries already heard keep coming from the old section list (`chapterState.landSections`), so a swell under way carries on and none starts in the past.
- `landMotion` builds the geometry from that alone: a slow wave (50 m, rolling at 0.012 Hz) plus a lift (40 m), at a fixed calibration target. At full strength that is about 17 px; a plain change is about 6 px.

## Task 16: resource, lifecycle and performance

### Fixes found by exercising real (unforced) play

| Defect | Effect | Fix |
| --- | --- | --- |
| `whenReady` prepared every view of a song at once | Pending reservations (not evictable) of later biomes filled the 256 MiB budget; the view on screen was refused, permanently; natural songs drew legacy | Budget refusals are deferred and retried; sequential in-order `whenReady`; export `settle()` keeps both travel sides resident |
| Legacy strips baked by a frame drawn while a view prepared | Non-evictable; they held the room the view needed, so it was refused again (a travel frame stayed legacy even after settle) | Strips for biomes v2 covers are fallback: adopted as evictable (dispose forgets the cache entry), and a refusal drops them (`onBudgetRefusal`) |
| `RockStageGL._upload` on an empty first frame | Nothing allocated, next line threw inside the draw | Always allocate on first upload (test fails on the old code) |
| 4 constant-weight seam bands | Vertical stripes across real terrain in travels | v2 uses 16 whole-pixel bands; legacy keeps 4 |
| `settle()` during a lost context | Waited out its 120 s timeout | Returns at once |

### Lifecycle suite

`node tools/range-scene-smoke.mjs --suite lifecycle --cycles 6` (SwiftShader, desktop budget 256 MiB; report `docs/evidence/range-v2/t16-lifecycle-report.json`). Two songs alternate, two stage sizes alternate, a real `WEBGL_lose_context` loss/restore at cycles 2 and 5. Per cycle: inside the budget, no overcommit, no ledger entry of a replaced song (by generation and by legacy-strip owner), no page or shader error, every frame on its v2 view.

| Cycle | Song | Stage | Owned MiB | Entries | Generations | JS heap MiB | Frames (8 / 30 / 55 s) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 96 s | 1280x720 | 224.2 | 8 | 0, 1 | 174.9 | Ross / San Gabriel / Ross |
| 1 | 80 s | 1280x720 | 215.0 | 6 | 0, 2 | 151.3 | Panamint / Panamint / La Sal |
| 2 | 96 s | 960x540 | 157.6 | 6 | 0, 3 | 120.2 | Ross / San Gabriel / Ross; lost: legacy (context-lost), restored: Ross |
| 3 | 80 s | 960x540 | 215.0 | 6 | 0, 4 | 176.6 | Panamint / Panamint / La Sal |
| 4 | 96 s | 1280x720 | 214.0 | 7 | 0, 5 | 172.9 | Ross / San Gabriel / Ross |
| 5 | 80 s | 1280x720 | 133.6 | 5 | 0, 6 | 113.8 | Panamint / Panamint / La Sal; lost: legacy, restored: La Sal |

Same song and size four cycles apart: 224.2 -> 214.0 MiB (8 -> 7 entries), 215.0 -> 133.6 MiB (6 -> 5): ownership returns to a level at or below the earlier one rather than rising per cycle. 36/36 checks passed.

Plan checklist, as covered:

- all-pinned denial: `test/graphicsResidency.test.js` (a denial evicts nothing), `test/rangeSceneLifecycle.test.js` (a pinned view survives pressure);
- repeated resize and song replacement: the lifecycle suite;
- stale fetch completion: generation tests in `test/rangeSceneLifecycle.test.js`;
- context loss/restore: the lifecycle suite (real extension);
- idempotent disposal: ledger release;
- faults: injectable through the fake scenes in `test/rangePresentation.test.js`.

Not exercised separately: switching to another *world* (as opposed to another song) mid-session.

### Quality ladder and device runs

`src/world/alpine/RangeQuality.js`: foliage subset first, then fog samples (6 -> 4 -> 3 -> 2, frame haze within 3%), then pool reflections at level 6; landform, contact, performers and musical signatures are never touched; `PerfGovernor` supplies the hysteresis. The near rock scan is skipped where its weight is zero.

Device measurement: `tools/range-device-probe.js` and `docs/range-v2-device-runs.md` (Android, iPhone and desktop runs, report fields, acceptance). **No physical phone or GPU was available: device acceptance is unverified.** Software-rendered timings are not reported as device FPS.

## Task 17: delivery (in progress)

- **v2 is the default Range renderer.** `?rangeRenderer=legacy` opts out; unknown values take the default; any v2 failure still falls back to legacy per frame with a recorded reason. The site opens in the Range (one-world mode), so every visitor gets v2.
- **CI browser contracts under the v2 default** (local run, own server): smoke, lighting, shading, seek, worlds, export, car, urlload, bootstrap, chooser and chooser-keyboard pass. Two needed a change. `tools/smoke.mjs` and `tools/export-smoke.mjs` open the Range as their first world card and play a 24 s song live; software GL takes seconds per v2 frame, so the song ended before the HUD could be clicked. Both test the app shell and the recorder, not the scenery, and now pin `?rangeRenderer=legacy` through `withLegacyRange()` (`tools/lib/allWorlds.mjs`). `range-landscape-smoke` pins legacy because it measures the legacy ridge painters. v2 output, including the real bulk exporter and recorder, is covered by `range-scene-smoke`.
- **Evidence identity.** Every `range-scene-smoke` capture carries a digest of the files the page actually loaded under `src/` (modules, catalog, manifests, terrain buffers, textures, runtime bundle), each checked against the checkout. The served identity list also covers the quality ladder, atmosphere, strip cache, seam, forest, rock stage and `main.js`.
- **Review fixes (Codex, two rounds on PR #336).**
  - The device probe now: follows song restarts; measures the real cold start; reports per-frame render and copy totals; takes its peak from the ledger's own high-water mark.
  - The lifecycle suite needs at least 5 cycles.
  - A preparation that straddles a context loss or restore (context epoch) never publishes, and is retried.
  - Startup strips are fallback from the first bake.
  - A refused render target also asks for fallback strips to be dropped.

## Asset budget (60 MB ceiling)

| Item | Size |
| --- | --- |
| Terrain packages (13 views) | 17.0 MiB payload (0.8-2.1 MiB each) + manifests: 19.9 MB on disk |
| Shared data textures (10 x 512^2 lossless WebP) | 7.0 MB |
| Material packs (11 manifests) | 92 KB |
| **Total `src/assets/range/v2/`** | **27.2 MB** |
| Three.js subset bundle | 0.54 MB |

## Decisions taken without asking (assumptions)

- Under v2 the painted sea, far shore, mirage and sea life are off (the view is inland; the reference has no sea). The sea still draws during a live tsunami/withdrawal so that hazard stays visible.
- Under v2 the glyph ground scatter is off: the world-anchored rock stage carries the speed read.
- Midasus is reflected only when she is within 220 px of her floor and not on a voyage.
- Far-crest exposure is measured on terrain only, at normal framing (16:9, zoom 1) with Midio's ground line (625/720) as the rock-stage occluder. Trees and the cast are not counted as occluders.
- In-browser A/B travel between two different real views cannot be exercised until Task 15 adds a second approved view; it is covered by unit tests (`test/rangeSceneTransition.test.js`) and the exposure check for every approved pair.
- The motion pilot is captured at 1280x720, 12 fps, 20 s: software GL needs ~9 s per frame (the bulk exporter's 1080p minimum is slower still).

## Measurements so far (SwiftShader, not device numbers)

- **Correction (2026-09-29):** the per-frame "draw" times recorded by the smoke tools (e.g. 430-710 ms) measure command submission only. The 2D canvas defers work, and SwiftShader performs it at pixel readback: a full 1280x720 v2 frame takes ~8-9 s to read back (`toDataURL`). Neither number is a device measurement; Task 16 must time on real hardware.
- Partition copy (drawImage of the WebGL canvas) 0.1-0.3 ms of submission.
- Desktop LOD for the pilot: 1.85 M triangles; mobile budget 0.80 M.
- Pilot residency with v2 active: 110 MB (terrain GPU 66, CPU 9, material 11, targets 22).
- Live playback (staged site, SwiftShader): the legacy -> v2 arrival fade started at 10.0 s heard time and was complete by the next live frame (13.1 s; frames were ~3 s apart). Resizing the window with v2 active kept the view active and the canvas filled edge to edge at 1280x780, 1600x900 and portrait 900x1400 (stage 900x506). The 1920x800 sample was never drawn because the 240 s song ended first (software frames took up to ~70 s at these sizes). An earlier all-black reading was the song's end, not a render fault.
- Rock stage mean sRGB: ~(50,63,61) at 30 s (moon up), ~(26,33,36) at 90 s; reference foreground rock ~(45,52,58).

## Command log

- `node tools/build-range-scene.mjs --view nc-ross-lake-north --publish`
- `node tools/build-range-materials.mjs`
- `node tools/review-range-views.mjs --views nc-ross-lake-north --source published --stations 21 --modes neutral,silhouette`
- `node tools/range-scene-smoke.mjs --url http://127.0.0.1:8092 --source-root "$PWD" --expect-sha <sha> --suite pilot|export|motion|complete --output .smoke/range-v2`
- `node tools/gen-pilot-wav.mjs <out.wav> 60` (calm/energetic/calm motion-pilot song)
