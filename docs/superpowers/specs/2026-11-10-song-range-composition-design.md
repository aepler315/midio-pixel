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

## Phase 1 approach

1. Normalize source grids for the dry-conifer pieces with the `tile` layout
   for multi-tile sources (D11).
2. Run the hierarchy on each full grid. Grow each massif from a landmark or
   prominence seed over cells whose `relief01` exceeds a threshold, limited by
   a distance window. Snap the bounding box to whole 64-cell tiles. Subtract
   the piece base, a low percentile of the masked cells. Force a zero ring
   at least two cells wide. Reject pieces whose border relief before
   feathering exceeds a data-set threshold.
3. Compose three fixed layouts on `lake-amphitheatre-a` into
   `readDemGrid`-shaped grids. The floor fills the rest. Bake with `allTiles`.
   Publish as `candidate`, reachable only by `?rangeView`.
4. Add the diagnostic rise override for the captures.

## Known limits of this session

- Captures were not taken on the RTX 3060 or the JOYING head unit. SwiftShader
  links shaders but its images and timings are not production evidence.
- Gate G1 is an owner gate and needs production captures.
