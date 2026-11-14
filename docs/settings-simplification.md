# Settings after Camera Studio

Decision for the follow-up to PR #137: assume the richer production options
perform acceptably. Everyday settings should express a visible artistic choice,
personal playback preference, or output requirement. Engineering comparisons and
ways to reduce quality belong in Diagnostics → Engineering controls.

| Surface | Keep | Reason |
| --- | --- | --- |
| Appearance | Pixel detail, Build pixel detail, Fit/Integer scaling | Pixel size changes the texture; progressive detail is part of the song's construction. Detailed remains the destination. |
| Camera | Music-timed tours, authored rails, Teton tour, pace, Camera Studio | These change the journey, framing and motion. Teton still provides full spatial Studio controls. |
| Landscape | Land dance | Music response is an artistic choice. |
| Audio & playback | Shuffle, continuous play, lyric grounding, Bluetooth delay | Personal listening and timing preferences. |
| Video export | 360p–4K, 30/60 fps | Output dimensions, cadence, file size and player compatibility still matter when rendering is fast. Defaults stay 1080p/30. |
| Experiments | Composed song ranges, Dual Summits direction, WebGL post-effects, terrain-only pipeline, voxel pilot, Mount Moran snow study | These create visibly different results. They retain their labels and existing defaults; experimental does not imply better. |

The following 19 controls remain accessible in the collapsed Engineering
controls disclosure, with working reset and sharing:

| Controls | Why removed from everyday settings |
| --- | --- |
| General quality, Starting quality, live Frame rate, Landscape renderer | Quality ceilings, throttles and fallback forcing. Defaults stay High, Automatic, 60 fps and 3D terrain. Automatic shedding and fallback remain available to the engine. |
| Tour quality gate, Candidate shot libraries, Try intended tour subjects | Review overrides for the approved shot-selection policy. |
| Force a landscape view, Hold land height, Fixed composed relief | Reproduction and measurement overrides that bypass song decisions. |
| Compiled terrain, Distant canopy summary, Material feature cache, Factored deformation gradient | Backend and implementation comparisons. |
| Show frame rate, Developer keys and overlay, Terrain debug view, Forest representation colours, Landscape markers | Instrumentation. |

No URL names, stored preferences or runtime defaults are removed by this
presentation change. A previously saved Low/30/Lite/Painted choice still appears
in Diagnostics with its source and can be reset individually or with Reset all.
There is no automatic enabling of candidate shots, new render experiments or
unapproved terrain implementations.

Camera Studio and MP4 preferences now use the settings registry/store, including
legacy saved records, URL precedence, share links, per-field diagnostics and
Reset all. Their dedicated controls are reached through one grouped action per
feature. MP4 export borrows the scene with listener zoom preserved; fixed-clock
export frames continue to exclude wheel/pinch input.

See [verification evidence](settings-zoom-validation.md) and the generated
[parameter reference](url-parameters.md).
