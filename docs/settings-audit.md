# Settings audit (2026-11-13, base a2ff8f5)

Before the settings registry ([settings](settings.md)), configuration lived in
25 module-private query parsers, 11 localStorage keys and hand-written
controls in `index.html`/`main.js`. Each parameter was traced from its parser
to the subsystem that consumed it. This table drove the implementation; the
registry (`src/config/settingsRegistry.js`) is now the authority.

Status: **F** implemented and functional · **E** experimental · **P** partial ·
**U** present but unreachable · **O** obsolete · **I** internal mechanism.
Lifecycle is the honest one after this change (see the registry).

## URL parameters read by the app page (35)

| Parameter | Values (default) | Parser → consumer | Prior UI | Lifecycle | Status | Disposition |
| --- | --- | --- | --- | --- | --- | --- |
| `rangePace` | 1–4 (3) | CameraRun.readRailPace → CameraRun/RangePresentation | select | next landscape | F | basic; UI no longer rewrites the URL |
| `rangeTour` | shots/off/tetons (shots) | RangePresentation.resolveRangeMode | on/off checkbox | scene | F | basic; Teton tour now selectable |
| `rangeRenderer` | v2/legacy (v2) | resolveRangeMode → main presentation | — | renderer | F | advanced (Performance) |
| `rangeView` | view id (none) | resolveRangeMode → forcedSceneChoice | — | renderer | F (diagnostic) | advanced, catalog list |
| `rangeDiag` | markers | resolveRangeMode → RangeScene | — | renderer | F (diagnostic) | developer |
| `rangeTourIntended` | 1 | resolveRangeMode → tour planner | — | renderer | E | experimental |
| `rangeShots` | all | resolveRangeMode → shot libraries | — | renderer | E | experimental |
| `rangeTourGate` | off | CameraChoice.autoGateEnabled → RangePresentation ctor | — | renderer | F | advanced |
| `rangeMsaa` | 0/2/4 (auto) | RangeRenderPolicy.msaaOverride → RangeScene ctor | — | renderer | F | advanced (Antialiasing) |
| `rangeDebug` | masks…sun | RangeScene ctor | — | renderer | F (diagnostic) | developer |
| `forestDebug` | 1 | RangeScene ctor | — | renderer | F (diagnostic) | developer |
| `terrainShading` | moran | TerrainShadingExperiment → RangeScene ctor | — | renderer | E | experimental |
| `canopySummary` | on/reference (on) | ForestCanopySummary → RangeScene ctor | — | renderer | F (A/B) | developer "reference implementations" |
| `materialFeatures` | warp/reference (warp) | MaterialFeatureCache → RangeScene ctor | — | renderer | F (A/B) | developer |
| `deformGradient` | factored/reference | DeformationGradient → RangeScene ctor | — | renderer | F (A/B) | developer |
| `compiledTerrain` | columns/mesh (original) | CompiledTerrain → RangeScene ctor | — | renderer | P: packs are build output, absent from the site | experimental, disabled with reason when packs are missing |
| `compiledTerrainCamera` | rail id | CompiledTerrain | — | renderer | E | URL only (measurement aid) |
| `compiledTerrainGroup` | 1/2/4/8 | CompiledTerrain | — | renderer | E | URL only (measurement aid) |
| `compiledTerrainProfile` | name | CompiledTerrain | — | renderer | E | URL only (measurement aid) |
| `landDance` | 0–1 (1) | TerrainHierarchy → RangeFrame (memoized), RangeScene admission | — | renderer | F | advanced slider; captured per scene |
| `rangeRise` | 0–1 | LandscapeScore (import-time const) | — | next song | F (diagnostic) | developer; read lazily now |
| `rangeRelief` | 0.25–6 | StageAssembly | — | next song | F (diagnostic) | developer |
| `songRange` | 1/on/force (off) | SongRangePlan → RangeLibrary, SongWorld | — | next song | E | experimental |
| `songRangeLayout` | pilot id | SongRangePlan → RangeLibrary | — | next song | E | URL only (measurement aid) |
| `performance` | dual-summits/off (auto) | DualSummitsMusic/Scene, main hash gate | — | next song | E | experimental |
| `perf` | lite/high (device) | PerfGovernor.resolvePerfStartLevel (boot const) | — | next song | F | advanced; recomputed on change |
| `renderer` | canvas/webgl (canvas) | WebGLRenderer.resolveRendererMode (boot const) | — | renderer | E | experimental; read per renderer creation |
| `fps` | presence | FpsMeter (P key toggled session-only) | P key | live | F | advanced checkbox; P key saves the same setting |
| `voxelRange` | 1 | VoxelRange (constructed with page) | — | reload | E | experimental, Reload |
| `directTerrain` | 1 | DirectTerrainExperiment → effectivePresentation (parsed per fit) | — | live | E | experimental; no per-call parsing |
| `dev` | 1 | main DEV_MODE const | — | live | F | developer |
| `bulkExport`, `exportW`, `exportH` | 1, px | main.readBulkExportFromUrl | — | next song | I | URL only (tools/bulk-export, visual evaluation) |
| `style` | classic/rendered | main → VisualStyle.resolveVisualStyle (always "rendered") | — | — | O (no-op) | parser removed; reported as ignored |

## Other names found

| Name | Where | Status | Disposition |
| --- | --- | --- | --- |
| `rangePipeline` | test asserted ignored; `docs/pixel-presentation.md` still described it | O | retired list; doc corrected |
| `version` | `src/ui/HistoryPicker.js` (history shell, separate page) | I | foreign list, untouched |
| `retry` | RangePresentation module/asset URLs, not a page parameter | I | untouched |
| `seed` | many tools append it; nothing reads it (tools pin seeds by init script) | O | retired list |
| `experience`, `rangeExperience`, `pixelScale` | tests/tools/docs from removed features | O | retired list |
| `fpsHud` | `docs/range-v2-device-runs.md` (wrong name) | doc bug | retired list; doc corrected to `fps=1` |
| `quality` (`plex-smoke`), `stageLod` (plan doc) | tools/docs only | never read | reported as unknown |

## localStorage

| Key | Owner | Disposition |
| --- | --- | --- |
| `midio-pixel:display:v1` (+ `smw:display:v1/v2`, `smw:stageRes`) | DisplayProfile | adapter for pixelGrid/scaling/buildPixelDetail; migration kept. `look`/`pixelScale`/`quality` record fields remain only for older readers |
| `midio-pixel:render-quality:v1` | RenderQuality | adapter for maxQuality (Economy → Low migration kept) |
| `smw:stageFps` | main | adapter for fpsCap; three ad-hoc helpers removed |
| `range-pace`, `range-tour` | CameraRun, RangePresentation, main | adapters; URL write-back removed |
| `midio.playback.v1` | PlaybackPreferences | adapter for shuffle/continuous (title toggles are a second view) |
| `smw:noLyrics` | Accessibility | adapter for lyrics (inverted) |
| `smw:btLatencyTrimMs` (+ legacy `smw:btLatencyTrim`) | Accessibility | adapter for btLatency (HUD chip + panel) |
| `midio-pixel:settings:v1` | new | settings that had no storage |
| `smw:groove`, lyrics cache, range history, file-chooser probe, library view, IndexedDB analysis cache | — | learned state or caches, not settings |
| `smw:vision*` (provider, model, endpoint; an API key is never persisted, and a legacy saved key is removed) | vision/config.js via the dev overlay | reachable once *Developer keys and overlay* is on; provider credentials stay out of the registry |
| `midio-pixel:export:v1` (VideoExport) | no reader in src | video recording is retired; left for its own cleanup |
| Soulseek config | SoulseekSearch | credentials; out of scope |

## Prior UI

`#titleSettings` held hand-written controls (lyric grounding, General quality,
Pixel detail, Build pixel detail, Landscape pace, Camera tours on/off, Scaling,
Frame rate, graphics report), re-parented into `#displaySettingsDialog` during
playback; shuffle/continuous on the title; BT latency in a HUD popover; FPS on
the P key. All are now generated from or bound to the registry with the same
element ids, which tools drive.

## Counts

- 45 parameter names audited (35 read by the app, 2 internal/foreign, 8
  constructed or documented but unread).
- 43 registry definitions: the 34 functional parameters plus 9 new URL names
  for formerly storage-only settings (`pixelGrid`, `buildDetail`, `scaling`,
  `maxQuality`, `fpsCap`, `shuffle`, `continuous`, `lyrics`, `btLatency`).
- 36 in the panel; 25 of them had no UI before (plus the Teton tour option).
- 7 URL-only by design: `bulkExport`, `exportW`, `exportH`,
  `compiledTerrainCamera`, `compiledTerrainGroup`, `compiledTerrainProfile`,
  `songRangeLayout`.
- 7 retired names reported as ignored; 1 dead parser (`style`) removed.
