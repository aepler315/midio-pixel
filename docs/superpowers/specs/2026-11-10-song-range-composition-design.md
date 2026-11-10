# Song range composition: design

Plan: [`docs/superpowers/plans/2026-11-10-song-range-composition.md`](../plans/2026-11-10-song-range-composition.md).
Base: `main` at `be5852d`. Branch: `feature/song-range`. Written at the end of
Phase 0 (2026-11-10) from the plan's Section 3 and the ground-truth checks below.

## Goal

Every song gets its own mountain range. Real massifs are cut from real DEMs, the
song's identity decides which massif sits in which slot of a fixed stage, and the
song's sections decide which massif rises when. The catalog views remain the
default and the fallback until the owner decides otherwise.

## Decisions

These are the plan's D1 to D10, unchanged except where Phase 0 found something
the plan did not know. Changes are marked **(P0)**.

| | Decision | Default |
| --- | --- | --- |
| D1 | Real terrain only | Pieces are measured DEM. The only invented ground is the stage floor between pieces, kept low and mostly under water. |
| D2 | One material family per song | From the song's home biome. Pieces never cross families. |
| D3 | Layout from identity, build from structure | Layout derives from the stored song-world record (seed plus five watch values), available before terrain loads. The per-slot build derives from sections, which can arrive later. |
| D4 | Fixed stage templates | A template owns grid, floor, lake level, slots and one authored camera rail. No per-song camera scouting. |
| D5 | Stage grid matches a standard view | 2241 x 2241 samples at 20 m, 35 x 35 tiles of 64 cells. **(P0)** Source grids are not all this size (see below); pieces are cut from whatever size the source has and dropped into the 2241-sample stage. |
| D6 | Tile-aligned pieces with zero relief on their border | Relief above the piece's own base. Slots join without resampling and can rise at different rates without opening cliffs. |
| D7 | Translation at runtime, plus optional mirroring | Pieces are stored facing +Z toward their source viewer. Off-axis slots see a piece up to the slot's azimuth off-axis, which the piece's coverage fan must include. |
| D8 | True scale | Large massifs go to far slots, small ones near. |
| D9 | The assembler emits ordinary terrain data | Everything downstream of `decodeTerrain` is unchanged. |
| D10 | Flag first | `?songRange=1`. Any failure falls back to the song's catalog view. |
| D11 **(P0)** | Normalize two-tile sources with the `tile` window-cache layout | See "3DEP tile seams". Record the layout and the rebuilt height hash in every piece's provenance. |
| D12 **(P0)** | Per-slot rise is sampled in the vertex stage only | See "Shader budget". The fragment stage keeps the scalar `uLandRise` for song-global effects. |
| D13 **(P1)** | A massif is a watershed region above a smooth base | See "Cutting". Replaces the plan's height-above-drainage mask with a distance window. |
| D14 **(P1)** | The lake is the floor | The lake reaches under the front row and between pieces. Land rises from its shore only behind it. This is D1's "mostly under water", made literal. |
| D15 **(P1)** | Stages bake like ordinary views | Rail bake from the template's camera, not `allTiles`. Gaps the rise exposes fall to `RiseGround` as on every shipped view. Full-coverage pieces belong to Phase 3. |
| D16 **(P1)** | Stage views have their own authoring file | `data/terrain/stage-views.json`, merged into the catalog by `writeCatalog`. Tools that rebuild views from a DEM and a lon/lat rail never see them. |

## Phase 0 findings

### Toolchain

| Item | Found | Used |
| --- | --- | --- |
| Node | Host had 22.23.4 | Official 24.22.2 Linux tarball in the session scratch directory; `npm ci` ran under it |
| GDAL Python | Default `python3` (3.13) has no `osgeo` | Ubuntu `python3-gdal` 3.8.4 with NumPy 1.26.4 under `/usr/bin/python3.12`, which `findGdalPython` already probes; `MIDIO_GDAL_PYTHON` set explicitly |
| Chromium | None installed | Playwright `chromium-headless-shell` 156 (SwiftShader, Vulkan backend), for shader linking only |

No RTX 3060 and no JOYING head unit were available to this session.

### Normalized DEMs (Gate G0)

`node tools/build-range-scene.mjs --view <id>` (no `--publish`) rebuilt all
four. Full coverage for every grid. Evidence: `.smoke/p0-dem/`.

| View | Grid | Extent | Valid | Height hash vs shipped `source.demSha256` |
| --- | --- | --- | --- | --- |
| `teton-jackson-lake` | 2241 x 2241 | 44.8 x 44.8 km | 100% | **differs** (see below) |
| `sawtooth-redfish-north` | 1601 x 1601 | 32.0 x 32.0 km | 100% | identical |
| `san-juan-sneffels-north` | 1601 x 1801 | 32.0 x 36.0 km | 100% | identical |
| `crater-lake-watchman-east` | 1601 x 1601 | 32.0 x 32.0 km | 100% | identical |

Each rebuild took under 90 s, including the 3DEP window downloads.

### 3DEP tile seams

Teton's window spans two 1° 3DEP tiles (`n44w111`, `n45w111`). The other three
fit in one. The 3DEP source files, their ETags and the SHA-256 of every window
read are identical to the shipped provenance.

- Every stored sample of the shipped Teton package (1,350,615 samples, all 882
  tiles) matches the rebuilt, despiked grid within half a quantization step
  (maximum 0.025 m at a 0.05 m step). The same check on Sawtooth, a hash match,
  gives the same result. So the difference lies only in ground the package does
  not ship.
- Normalizing Teton with the `tile` window-cache layout gives a third hash. It
  differs from the default `envelope` layout in 1,008 cells, all in grid rows
  177 and 178 (z = -18,860 to -18,840 m, the 44° N seam), by up to 0.62 m.
- `tools/terrain/normalize-dem.py` documents this: with `envelope`, GDAL's
  average warp lets the later tile overwrite the seam with partial-coverage
  averages. With `tile`, the warp is bit-identical to reading the remote tiles
  directly.

Neither layout reproduces the shipped grid's seam cells on GDAL 3.8.4. The
shipped grid was probably built under a different GDAL version or cache state.
That was not investigated further, since it does not affect the pieces.

Consequences:

1. Pieces must not claim the shipped `demSha256`. Each piece records the hash of
   the grid it was actually cut from, the window-cache layout, the GDAL version,
   and the 3DEP window hashes.
2. Multi-tile sources are normalized with `windowCache: 'tile'` for pieces
   (D11). This makes seam cells independent of cache history. Shipped views keep
   their authoring unchanged.
3. Determinism tests compare piece bytes from the same grid hash, not across
   hosts.

The local bake kept fewer tiles than the shipped packages (Teton 251 against
882, Sawtooth 163 against 415). Both shipped views carry shot libraries, which
plausibly widened their baked coverage. This was not investigated, because
pieces are cut from grids and never from packages.

### Diagnostic view selection

- `?rangeView=<id>` calls `forcedSceneChoice` (`SceneCatalog.js`), which accepts
  any catalog view including candidates and flags `forcedCandidate`. It applies
  to every biome of the song (`RangePresentation.js`).
- `tools/landscape-review.mjs --view <id>` passes the id through the review
  manifest. `--view natural` lets the production selector choose. The default is
  `teton-range-tour`.
- **No rise override exists.** There is no URL or review option that pins
  `rise01`. Phase 1 captures "at rise 1/3, 2/3 and 1" need one. The smallest
  addition is a diagnostic `?rangeRise=<0..1>` read where `LandscapeScore`
  returns `rise01`, plus `--rise` in the review tool. The alternative is
  choosing `--start-ms` per song so the natural curve passes those heights.
  Phase 1 adds the override and records it as diagnostic-only.

### Chapter travel and the rise

- The rise is one song-global value. `compileLandRise` runs inside
  `compileLandscapeScore`, and `stateAt(t).rise01` reaches every prepared view
  through the frame (`RangeFrame.js`).
- `SceneTravel.js`, `ProfileTravel.js` and `ChapterPlanner.js` never read the
  rise. During a view-to-view transition the outgoing and incoming views are
  drawn with the same `rise01`. Each view uses its own base from
  `landRiseBase(prepared)`: the rail's water level, else the manifest's minimum
  height.
- Consequence for Phase 4: a composed home stage needs per-slot rise, but other
  chapters' catalog views keep consuming the scalar. The stage schedule must
  define the scalar too. The default is the mean of the slot rises, so a travel
  between a stage and a catalog view stays continuous and a catalog view rises
  at the song's average pace. That also makes `compileStageRise` with one slot
  reduce to `compileLandRise`.

### Shader budget

Measured by linking the real terrain programs (`TerrainMaterial.js`, Three
0.187.0 `ShaderMaterial`, GLSL3) in headless Chromium. Each stage was linked
against a stub of the other stage so only that stage's active uniforms count.
Rows are vec4 uniform vectors. "Naive" gives every non-sampler uniform whole
rows. "Packed" is a GLSL ES Appendix A style estimate. Drivers vary between
the two.

| Program | Stage | Uniforms | Naive rows | Packed rows | Samplers |
| --- | --- | --- | --- | --- | --- |
| Scene, mobile, default flags | fragment | 120 | 218 | ~162 | 12 |
| | vertex | 30 | 37 | ~23 | 2 |
| Scene, river surface | fragment | 116 | 212 | ~158 | 11 |
| Depth | fragment | 1 | 1 | 1 | 0 |
| | vertex | 30 | 37 | ~23 | 2 |

Mobile and desktop rungs link identical uniform sets; the rung changes only the
`FAR_FOREST_KMAX` loop bound. The scene program uses 5 varyings.

Against WebGL2's guaranteed minimums (224 fragment and 256 vertex vectors, 16
texture units per stage, 15 varyings):

- The fragment stage has 6 rows of naive headroom and 4 free samplers. That
  agrees with the comment in `TerrainDeform.js`. Nothing should be added there.
- The vertex stage has over 200 free rows and 14 free samplers.
- The rise already flows vertex to fragment. `riseLift`/`riseGrad` run in the
  vertex shader and reach the fragment as `vRiseGrad`. The fragment reads
  `uLandRise` only for song-global effects: the flat-land gate, the mirror
  camera height, the opening ocean and the source-edge fade.

So Phase 4 takes the plan's preferred path, restricted to the vertex stage
(D12). One single-channel slot-rise texture is sampled in `riseLift`/`riseGrad`
in the vertex shader, and the local value reaches the fragment through
`vRiseGrad`, which already carries both gradient and drop. `uLandRise` stays as
the song-global scalar for the fragment's global uses. Fragment cost: zero rows,
zero samplers. The per-vertex attribute alternative is unnecessary.

Programs not yet counted, to be counted in Phase 4 before editing them: forest
(`ForestGL`, `ForestDetail`), river, mirror, `RiseGround`, `BuildOcean`.

Evidence: `.smoke/p0-shader/budget.json`, with per-stage uniform lists.

### Other facts Phase 1 depends on

- `buildTerrainHierarchy(lattice)` accepts a plain lattice
  `{ width, height, cellXM, cellZM, heights }`, so the cutter can run it
  directly on a normalized grid at full 20 m resolution offline. At runtime
  the hierarchy is built on at most 384 (desktop) or 256 (mobile) samples a
  side.
- Its `relief01` is height above nearest drainage over its 95th percentile,
  smoothstepped: 0 on valley floors, lakes and channels.
- `bakeTerrain(grid, view, { allTiles: true })` refuses a grid with any
  no-data. Composed stages must therefore be complete, and the floor fills
  every cell no piece covers.
- `skylineFeatures`, `characterFromFeatures`, `cameraRailErrors`,
  `songTerrainTarget`, `seedTicket`, `chooseSongBiomes` and
  `validateTerrainManifest` exist at the paths the plan names.
- Catalog version 57, matching version 2.

## Phase 1 as built

### Cutting (`tools/lib/massif-cut.mjs`)

1. **Sources.** Each source view's DEM is normalized again with the `tile`
   window-cache layout (D11) into `.terrain-cache/massif-sources/`, then
   despiked as the production bake does. A grid with any no-data is refused.
2. **Seeds.** Named landmarks, snapped to the highest sample within 300 m,
   come first. Then summits that are the highest sample within 3 km on a
   200 m lattice. A seed within 2.5 km of an earlier one is dropped.
3. **Partition.** A marker-controlled watershed floods downhill from every
   seed at once, highest cell first, so neighbouring massifs meet along the
   valleys between them.
4. **Region.** The seed's own watershed cells above a level L, 8-connected to
   the seed. L is the lowest level at which the region's tile block fits 10
   tiles a side and stays 4 cells inside the source grid. Both limits are
   monotone in L, so a binary search to 2 m finds it.
5. **Base.** The harmonic (Laplace) surface B with B = h on every outline cell,
   solved by over-relaxation from an inverse-distance first guess. Relief is
   max(0, h − B). It is exactly zero on the whole outline and continuous up
   to it. Inside, it is the measured DEM above a gently varying base.
6. **Block.** The region's bounding box plus a two-cell zero ring, rounded up
   to whole tiles. Lossless quarter turns put the source camera on +Z; the
   residual angle is recorded. The source DEM is complete around the region,
   so the coverage fan is the full 360°.

Two simpler cuts were tried first and rejected on the real grids:

| Cut | Result on the four sources |
| --- | --- |
| Contour island (relief = h − L inside the island above L) | Zero borders, but continuous ranges merge long before their flanks are included. Most pieces kept only 300–600 m of summit cap; Mount Sneffels kept 369 m, and only 393 m with a 14-tile budget. |
| Watershed region over an inverse-distance base | Large reliefs, but B equals h on outline cells and not on their interior neighbours. Relief jumped up to 116 m in one cell next to the outline. Caught by the unit test. |

**Outline check (changed from the plan).** The plan asked for the feather
band's slope 95th percentile to stay at or below the piece's interior. This
cut has no feather. Its outline band is real terrain, which is legitimately
steeper than the interior on caldera walls and cliff-bound massifs (Mount
Scott: band 0.88 against interior 0.59). The check that catches what the plan
feared, a cut that steepens ground, compares the band's relief slope with the
source DEM's slope on the same cells. Pieces fail above 1.15 times plus 0.02.
On the four sources, all 41 accepted pieces lie within 1.11 times.

### Library

41 pieces from 83 seeds (Teton 19, Sawtooth 11, Sneffels 5, Crater Lake 6).
The largest reliefs are Grand Teton (1,680 m), Mount Moran (1,532 m), a Teton
summit at 3,459 m (1,109 m), a Teton summit seeded at 3,329 m (1,007 m), and
Sawtooth summits of 994, 959, 892 (Heyburn Mountain) and 887 m. Rejected seeds
mostly touch their source grid's edge. Ids are `<source view>:<landmark slug>`
or `<source view>:summit-<seed height m>`; the table is written by `--list`.

### Stage (`tools/lib/stage-compose.mjs`, `data/terrain/stage-templates.json`)

`lake-amphitheatre-a` keeps the plan's grid (2241 x 2241 at 20 m) and three
rows: horizon 3 slots of 11 x 10 tiles, back 3 of 9 x 10, front 2 of 7 x 7.
The camera stands on the south shore and looks north with a 32° lens. Shipped
approved views use 18–30°; the first draft's 38° made every massif small.

The floor is a level lake at 2,050 m (Jackson Lake lies at about 2,064 m), an
ellipse 48 x 16 km under the front row. Land rises from its shore at 3%. The
baker marks any 3 x 3 patch within 0.35 m as water, so land must never be level.
A unit test runs the baker's `waterMask` over the floor to prove no land cell
becomes water. The first draft used a small lake and a land floor everywhere
else. Its CPU still showed separate humps on a wide empty plain, which is the
pilot's bare-skirt failure again.

With the lake at 2,050 m and the floor rising behind it, the Grand Teton piece
tops out near 4,200 m, close to its real 4,199 m. The dry-conifer rules
(snowline 3,000 m, treeline 3,100 m) therefore put snow and forest where they
belong on the tallest pieces.

### Bake and publish (`tools/build-song-range-pilot.mjs`)

`--list` cuts the library. `--build [--publish]` composes the layouts in
`data/terrain/song-range-pilot.json` and bakes each with `bakeTerrain` and the
template rail. It writes the same files and build record as
`build-range-scene.mjs`, plus a `composition` block naming every piece, slot,
mirroring flag, source grid hash, window layout and GDAL version. Published
stages are `candidate`, not `experimental`, and are reachable only by
`?rangeView=<id>`. Regenerating the catalog on an unchanged tree reproduces
`sceneCatalogData.js` byte for byte; publishing adds the three views and
nothing else.

### Diagnostic rise

`?rangeRise=<0..1>` holds `rise01` in `LandscapeScore` for every consumer, and
`npm run review:landscape -- --rise N` sets it. Values outside 0..1 are
ignored. Captures taken with it are labelled diagnostic.

## Phase 2 as built

### Planner (`src/world/terrain/SongRangePlan.js`)

`planSongRange(profile, seed, { catalog })` is pure. It reads only the five
watch values, through `songTerrainTarget` and `chooseSongBiomes`, plus the
seed, so a compact library record and a full profile plan the same layout.

1. **Family.** The home biome's material family. `BIOME_FAMILY` mirrors
   `DEFAULT_PACKS` in `tools/build-range-scene.mjs`, and a test keeps the two
   equal.
2. **Template.** A seeded draw among the templates that support the family.
3. **Principal.** Every piece that fits the principal slot, drawn with
   `sceneOdds`: the catalog views' tempered ranks, 15% fair share and kernel,
   against the song's terrain target.
4. **Other slots.** In template order, a uniform seeded draw among unused
   fitting pieces from the source regions used least so far.
5. **Mirroring.** A seeded coin per slot.

Candidates are sorted by id; reversing the catalog changes no plan. There is
no recent-view history. `SONG_RANGE_VERSION = 1`. A song whose family has no
pieces, or not enough to fill every slot, gets `null` and keeps its catalog
view.

**Slot fit (P2).** Footprint alone let a 959 m stump compete for a front slot
beside 500 m pieces, and let small pieces take back slots. Each slot now has a
peak relief range in `stage-templates.json` (`reliefM`): horizon 400 m and
up, back 700 m and up, front 300 to 1,000 m. This is D8 (big massifs far,
small near) in data. Only the planner applies it; composition accepts any
piece that fits.

**Catalog.** `node tools/build-song-range-pilot.mjs --catalog` writes
`src/world/terrain/massifCatalogData.js`: templates plus piece metadata (id,
name, family, source range, footprint, relief, character and relief hash).
It is 22 KB and holds no terrain bytes. A test checks it against
`stage-templates.json`.

**Label.** With `?songRange=1`, `describeSongWorld` labels a song that has a
plan `World: <principal> range` and marks it experimental. Its tooltip names
every massif. Caching and the zero-download rule are unchanged, and the
cache key includes the flag. Without the flag, or without a plan, the label
is exactly the catalog-view label.

### Uniqueness (`tools/song-range-uniqueness.mjs`)

These figures assume today's catalog: one family (dry-conifer), 41 pieces and
one template of 8 slots. Fitting pieces per slot are 29 for each horizon slot,
8 for each back slot and 17 for each front slot.

| | Synthetic (10,000) | Corpus (16 tracks x 625 seeds) |
| --- | --- | --- |
| Songs that get a composed range | 8.7% | 9.4% |
| Distinct layouts among them | 867 of 867 | 942 of 942 |
| P(two ranged songs share a layout), 95% bound | ≤ 8.0 x 10⁻⁶ | ≤ 6.8 x 10⁻⁶ |
| Colliding pairs, 500-song library (95% bound) | ≤ 0.007 | ≤ 0.007 |
| Colliding pairs, 5,000-song library (95% bound) | ≤ 0.75 | ≤ 0.75 |
| Distinct principal massifs | 8 | 8 |
| Most common principal | Teton summit seeded at 3,329 m, 18.1% | Heyburn Mountain, 23.8% |
| For context, today's home catalog views: P(two songs share) | 0.065 | 0.065 |
| For context, colliding pairs in 500 songs | about 8,100 | about 8,060 |

The layout space under the fit rules is between 1.9 x 10¹¹ and 9.2 x 10¹¹,
mirroring included. The plan's p!/(p−K)! x 2^K formula, which ignores fit,
gives 9.9 x 10¹⁴.

What limits the result is breadth, not collisions:

1. **Coverage.** Only songs with a CONIFER home get a range: about 9%. Every
   other family needs pieces (Phase 5).
2. **Labels repeat.** Only 8 pieces fit the 9 x 10-tile back slot at 700 m or
   more, so `World: <principal> range` comes from 8 names, and the most common
   covers about a fifth of ranged songs. Layouts stay distinct; library
   labels do not. Section 9, item 1 (list every massif, or generate a range
   name) is the owner's call.

## Known limits of this session

- Captures were not taken on the RTX 3060 or the JOYING head unit. SwiftShader
  links shaders but its images and timings are not production evidence.
- Gate G1 is an owner gate and needs production captures. It has no recorded
  owner verdict; Phase 2 started at the owner's instruction to continue.
