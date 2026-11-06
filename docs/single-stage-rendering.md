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

The step comparisons below were captured before integrating main at `2a91c5f`.
The final merged-tree measurements follow them and include its newer forest,
tour and landscape-rise changes.

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

On the merged tree (`1769d938`), actual Auto stayed at level 0 with planar
mirrors retained in both views. Under the same Classic/DPR/audio conditions,
the settled 45–55 second and continuous 55–65 second windows both delivered
60.00 FPS: p95 16.725 ms for Teton and 16.750 ms for Owens. The complete
25–55 second windows averaged 57.46 and 59.63 FPS respectively, including one
150 ms Teton stall and one 200 ms Owens stall. The continuous tails had no
stalls over 100 ms, failed presentations or repeated frames.

Merged-tree GPU and stage RGBA also matched exactly with opaque depth reuse
on/off at 0, 14, 21 and 42 seconds in both rail views, and at 15.5, 16, 16.5
and 42 seconds in Teton's planned shot tour. The latter exercised the forest
window transition with mirror and cast activity; all WebGL error checks were
clear. These are shot-tour checks, not the separate forced Teton highway tour.

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

The shipped rail bake was checked again on `1769d938`: the 40–46 and 75–81
second windows delivered 60.00 FPS, with p95 16.76 and 16.72 ms and no failed
or repeated presentations. The final 44 m surface rendered at 960×540 with
24° field of view; rewind reproduced the same image. Simulated context loss
fell back to normal rendering while audio continued. The compressed pack is
16,155,339 bytes and decodes to 115,380,248 bytes; a second bake reproduced its
SHA-256. Runtime, delivered source and payload hashes stayed unchanged during
the check.

## Flat-ground follow-up

The default Landscape rise now starts with level ground, then grows every
elevation from a stable view base. It replaces the former above-eye squash,
which left valleys intact and made the mountains look cut off. Camera height,
lighting, water, reflections, culling and tour coverage follow the growing
terrain. A bounded inferred backdrop covers unshipped terrain during growth
and fades away before completion. See `landscape-rise.md` for its limits.

Runtime `ec82b204` was measured on the same RTX 3060 / Chrome 156 / Direct3D 11
setup, at DPR 1.75 with the generated 90-second fixture. Auto stayed at quality
level 0 with planar mirrors retained in both views and both pixel grids:

| Grid | View | Settled 45–55 s | Continuous 55–65 s |
| --- | --- | --- | --- |
| Classic 320×180 | Teton–Jackson Lake | 60 FPS, p95 16.730 ms | 60 FPS, p95 16.725 ms |
| Classic 320×180 | White Mountains–Owens | 60 FPS, p95 16.735 ms | 60 FPS, p95 16.725 ms |
| Detailed 640×360 | Teton–Jackson Lake | 60 FPS, p95 16.720 ms | 60 FPS, p95 16.730 ms |
| Detailed 640×360 | White Mountains–Owens | 60 FPS, p95 16.725 ms | 60 FPS, p95 16.725 ms |

For either grid, the complete 25–55 second window averaged 59.73 FPS in Teton
and 59.63 in Owens, including one roughly 150/200 ms stall respectively.
The continuous tails had no stalls over 100 ms, failed or repeated frames.
Served source hashes matched the checkout and stayed unchanged during timing.

Fourteen rail and nine planned-tour snapshots checked the flat opening,
intermediate growth, near-completion fade, complete range and exact rewind.
Depth reuse on/off matched both GPU and stage RGBA at every checkpoint, with
no WebGL/browser errors. These visual checks used `f6d6408`, whose source tree
is identical to `ec82b204` (the latter rebases the fix onto merged PR #88).
This does not claim byte identity to the previous implementation: tour detail
selection is deliberately more conservative, and cross-run stage captures
also include temporal effects. The full-height geometry and authored camera
return to their original values.

The structural coverage check passes all 19 catalog views. The 146 focused
regressions cover height/camera rules, culling, inferred support retirement,
ownership/depth ordering, preparation/disposal and continuous tour coverage.
As above, these are bounded synthetic-song measurements, not a long-song or
physical-display certification.
