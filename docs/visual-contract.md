# Visual contract

Current implementation evidence: `DisplayProfile`, `PixelRenderPolicy`,
`PresentingRenderer`, `LandRise`, `LandRiseCamera`, `LandscapeScore`, `RangeQuality`
and `ValleyMistEngine`, inspected at `58454dd`. This is a review guide and explicit
regression contract, not a freeze on intentional experiments.

| Property | Current implementation | Review obligation / aspiration |
|---|---|---|
| Pixel identity | Cinematic terrain on discrete native grids; output-space crest reconstruction and smooth sky/water composition | Preserve crisp terrain structure and purposeful reconstruction; do not replace terrain with a blurred photographic treatment. “Every output pixel is a nearest-scaled cell” is not current behavior. |
| Geography | Measured catalog packages, shared metre coordinates and sample lattice; real ridges/spurs | Retain provenance, no-data handling, orientation and recognizable silhouettes across LOD. Composed stages relocate source pieces and can scale relief; state that claim separately. |
| Depth-aware scaling | Retired. `pixelScale` resolves to `original` (Uniform) | Desired future depth treatment needs a new experiment with tests and review. Do not make a removed mode a passing requirement. |
| Color and air | Cinematic grading, music-mood hue, atmospheric perspective, haze/mist | Retain strong terrain colors, separation of near/far masses and legible ridges; more haze is not automatically more atmosphere. No unmeasured universal haze threshold. |
| Camera | Tight growing-land opening, widening lens, ground clearance, summit/action focus; rails/tours and song-specific overrides | Review opening, intermediate and distant composition and consecutive motion. A static screenshot cannot prove apex tracking or smooth motion. |
| Construction | Catalog begins at one-third scalar rise; composed ranges at 5% geometric relief with per-slot schedules; Dual Summits has explicit independent cues | Keep musical progression meaningful, monotonic structural building and seek/late-analysis continuity. Do not force all paths to the same starting height. |
| Resolution | Classic 320×180 through Detailed 640×360; live Building detail grows under governor caps | Fixed export corpus explicitly disables Building detail to compare the requested raster. Test live transitions separately. |
| Atmosphere | Smooth sky, weather episodes, valley mist, lighting, water and shadows; quality sheds selected work | Movement and grounded mist should support visible terrain; weather is music dependent. Still comparisons capture states, not temporal realism. |
| Scale | Catalog sources retain source lattice/units; growth maps heights about one stable floor | No unrelated parallax, water, forest, fog or camera scale drift. Composite placement and relief are artistic transformations with recorded provenance. |

Initial/partial/late Classic and Detailed, a held half-relief diagnostic and a
quality-3 weather checkpoint form the small automatic corpus. A threshold pass
means similarity within configured tolerances and valid render state. It cannot
judge artistic improvement, musical intention or live motion. Consecutive clips,
matching audio and relevant source regions are needed for visual feature review.

A new artistic direction may intentionally change these references. State the
hypothesis, show matched evidence and update the contract/reference explicitly.
Never replace baselines as part of capture or after a failed comparison merely
to make CI green. See [baseline process](verification.md).

Historical conflicts: `landscape-review.md` still described Pixel as default and
both grids, while current CLI defaults are Cinematic/Detailed; the command help
and current source govern. `pixel-presentation.md` contains historical Depth,
Pixel and Palette passages; current behavior above supersedes those options.
Removed flowing-water, cast/performer and video-recording ideas stay retired.
