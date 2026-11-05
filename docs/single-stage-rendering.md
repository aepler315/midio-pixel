# Single-stage Landscape restoration

The live Pixel and Palette renderer uses one native canvas for terrain, the
current musical sky, weather, cast, lake shading, post effects and captions.
Classic is 320×180. The existing larger pixel grids remain selectable. CSS
nearest-neighbour scaling presents the completed scene, including fullscreen
cover cropping. The audio clock, camera schedules, terrain assets and normal
scene eligibility feed the same current simulation.

Cinematic Pixel, explicit offline capture sizes and `?rangePipeline=hybrid`
use the separate smooth-layer presentation. The native path uses its natural
terrain skyline and shoreline instead of refined crest probes and split cells.
`?rangePipeline=native` retains hybrid passes at native output size for the
resolution-only diagnostic. The default is `single`.

## RTX 3060 measurements

Measured in isolated, muted, headless Chrome 156 on the local RTX 3060 using
ANGLE Direct3D 11. The visible preview was paused. Both approved views used the
same generated 90-second audio, tours off, Classic grid, DPR 1.75 and warmed
14–19.5 second passage. The hybrid backing was 960×540; native backing was
320×180. These rows pin quality level 0 for an equal quality comparison.

| Change | Teton–Jackson Lake FPS | White Mountains–Owens FPS |
|---|---:|---:|
| Hybrid presentation | 15.09 | 45.09 |
| Native output size, hybrid passes retained | 16.30 | 48.99 |
| One native stage | 25.87 | 60.00 |
| Reuse opaque terrain depth | 30.46 | 60.00 |

The depth snapshot replaces two opaque terrain prepasses with exact GPU depth
copies while preserving soft crown, hard forest, cast and shaft ordering.
On/off GPU canvas RGBA matched exactly at 0, 14, 21 and 42 seconds in both views.
The 42-second fixture included storm and cast activity. CPU tests separately
cover depth state, travel fallbacks, resource admission, target replacement,
context loss and retirement of prepared views.

Actual Auto quality was then measured over 25–55 seconds, including the
energetic passage, with a continuous Teton 55–65 second follow-up. Teton
settled at level 2, using the existing lighter near-tree assets and sky/far
water reflection. Both settled 45–55 and 55–65 second Teton windows delivered
60.00 FPS, with p95 intervals of 16.75 and 16.74 ms. Owens stayed at level 0,
retained its planar mirror and delivered 60.00 FPS in its settled window.
Initial preparation, quality adaptation and occasional recovery probes remain
part of live playback; the table does not claim full quality at 60 FPS on Teton.

The former governor decayed pressure fast enough to accept persistent 50 FPS
on a requested 60 FPS cap. The corrected policy accumulates that deficit,
preserves tolerance of isolated hitches and quickly ends failed recovery
probes. It retains the existing quality choices and exponential recovery
backoff.

These are short synthetic-song hardware measurements, not a physical-display
or all-song/device certification. Raw captures, profiles and per-step JSON
are kept outside tracked source under the session's `work/range-pipeline-evidence`.

## Song-built mountain preview

`?voxelRange=1&rangeView=white-mountains-owens&rangeTour=off` selects the separate
mountain preview. Its pinned terrain pack ships with the repository and staged
site; no local bake is required. Regenerate it with `node tools/build-voxel-range.mjs`.
The source is the shipped USGS 3DEP terrain's rail subset, excluding the extra
ground used only by camera tours. The generated metadata records that source's
manifest, payload and DEM identities, plus compressed and decoded pack hashes
and sizes. Runtime and staging verify the pack; staging also rejects stale
source pins. Offline geometry progresses from
500 m columns through 250, 125 and 62.5 m cells into a smooth 44 m DEM mesh.
Only the current level or adjacent dissolving pair draws, from one GPU upload.

The camera gradually widens from 15.6° to the authored 24° view, the raster
grows from 320×180 to at most 1280×720, and analytic fog, distance haze and a
sky glow add atmosphere. Physical growth completes at 84% of scored song
progress before the open smooth surface takes over; the remaining progress
refines the surface and camera. All of these states sample the heard-time
score and reproduce on an in-session seek.

The initial hardware run delivered 60 FPS through early, middle, late and
smooth-transition windows, including about 991,000 submitted triangles during
the heaviest adjacent-level transition. Final validation also checks the
bounded gzip loader, aspect-preserving raster and growth completion.
