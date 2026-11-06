# Output-resolution ridge edges

The reported skyline stripe on supermaudio.com came from a crest path that
averaged fine terrain columns back onto native pixel columns and used a broad
land-color average plus a constant sky-color estimate. The live presentation,
crest and display modules were checked against the starting revision. The
affected overlay is used by Cinematic and an explicit hybrid pipeline; fresh
Pixel playback continues to use the single-stage renderer.

The correction retains each physical-output silhouette column through the
terrain cut, restored edge cells, pocket fill and stroke. The fine target
includes the scenic camera margin and follows the actual output scale,
including noninteger scaling. Compact silhouette rows share the existing
asynchronous probe readback and reset on size, view, timeline and mode changes.
The four-by-four native ownership mask remains separate from the silhouette.
Duplicate legacy fine-column GPU scans are replaced by sampling the same
coordinates from the compact data.

The ridge stroke uses the mean of the actual composed pixel one physical row
above and one row below its output position. Sampling happens after terrain
corrections and before every ridge stroke. The mean is not hue-rotated or
snapped to the terrain palette. A bounded, admitted canvas copies the two
neighbor rows and blends them on the GPU; the resulting pattern follows the
physical output coordinates. No output `getImageData` is needed for edge color.
Each band paints one continuous one-physical-pixel path, restarting at missing
or skipped samples. At settled view fade its mean color is opaque. Elevation
and visibility metadata do not widen, dim or subdivide the modern stroke.

Dense geometry remains clipped behind nearer terrain. A fully ready native
split canvas cannot suppress the fine terrain cut, since a narrow fine peak
may enter a cell that native classification never crossed. Missing bands keep
finite ordered horizontal coordinates; scanning and release clear obsolete
geometry. When fine sampling is shed at heavy quality levels, unsupported or
denied, the modern path omits the outline rather than drawing a stale or
invented coarse diagonal. Native terrain and the single-stage default remain
available.

## Verification and performance

Hardware checks use isolated muted Chrome, the actual RTX 3060 through
ANGLE/D3D11, DPR 1.75 and the existing synthetic 90-second
`midio-perf-pilot.wav`. Fixture SHA-256:
`c0160a5c95669def70cfe43feeca1c06b81117cf01f2b4e43d59f1ef59e02297`.
These are bounded checks on one device and recording, not broad device/song
coverage. The unchanged starting revision is retained in a separate worktree.

Before captures at 1920x1080, Classic, Cinematic and 14/42/70 seconds show the
pale ridge stripe. The first fine-geometry capture at 42 seconds removed the
stripe and had no GL or page errors, but exposed an unacceptable color-readback
cost: nine reads covering 150,743 pixels took 50.88-51.79 ms; the 2,371 stroke
calls themselves took 0.65-0.81 ms. This measurement drove the GPU-copy pattern
implementation. The slow CPU-readback version is not the final renderer.

Raw before captures and the diagnostic are retained outside Git in
`work/range-pipeline-evidence/ridge-before-cinematic-1080-20261106/` and
`work/range-pipeline-evidence/ridge-cost-profile-20261106/`.
The GPU-copy helper passed an actual Chrome/RTX 3060 pixel oracle at integer
and fractional output transforms. Both RGB means and opaque alpha matched
exactly, with output `getImageData` forced to throw during preparation and zero
calls observed. Dense geometry, missing samples, nearer clipping, timeline and
size reset, denied storage and shared pre-stroke sampling have focused tests.

GPU copies alone were insufficient: hundreds of separately clipped patterned
strokes reduced the fixed full-quality check to 26.48 FPS. Disabling only the
strokes, while retaining the copies, restored 52.27 FPS. The final renderer uses
at most one patterned path per band and keeps every fine silhouette vertex.

### Matched full-quality comparison

White Mountains, Detailed 640x360 into 960x540, explicit hybrid pipeline,
40-46 seconds, fixed effects rung 0, reflections enabled:

| Renderer | Presented FPS | Median CPU submission | p95 frame interval |
| --- | ---: | ---: | ---: |
| Starting renderer, adjacent baseline run | 53.92 | 6.180 ms | 18.540 ms |
| Final output-resolution edge | 50.90 | 4.645 ms | 35.320 ms |

The final full-resolution correction has about 6% lower presented throughput
in this bounded comparison, despite lower CPU submission time. Neither run
has a stall over 100 ms, an unpresented frame or a page error. These results
do not establish a 60 FPS hybrid renderer or a performance improvement.

### Auto quality

The final renderer's separate 25-55 second Auto sample measured 51.63 FPS,
53.29 FPS during 45-55 seconds, then 55.98 FPS during continuous 55-65 second
playback. It stayed at rung 0 throughout, with the fine edge and mirror
enabled. The long sample contains one 231 ms pacing stall; the follow-on
contains none. There are no unpresented frames, page errors or source changes.
The earlier baseline Auto sample measured 50.03 / 50.00 / 56.55 FPS but
progressively shed quality from 0 to 4; it is not a same-quality comparison.

Raw reports are retained outside Git under `work/range-pipeline-evidence/`:
`ridge-paired-before-fixed0-20261106`, `ridge-single-path-fixed0-20261106`,
`ridge-final-auto-20261106` and `ridge-pattern-browser-20261106.json`.

The final Classic/Cinematic capture at 1920x1080 and 42 seconds was compared
with the starting renderer at the same timestamp. The pale stripe is absent
and the fine silhouette follows the terrain while the interior stays pixelated.
All four GL checks returned zero, there were no page errors, and served source
hashes stayed unchanged. This is a paused-frame comparison, not a motion test.
The final capture is in `ridge-final-cinematic-1080-20261106`.

### Full-HD Cinematic timing

A separate adjacent before/after pair uses Cinematic, Classic 320x180 into
1920x1080, fixed rung 0 and White Mountains at 40-46 seconds. The harness
explicitly selects Classic after Cinematic and verifies the measured look,
working/output sizes, fine overlay and reflections.

| Renderer | Presented FPS | Median CPU submission | p95 frame interval |
| --- | ---: | ---: | ---: |
| Starting renderer | 30.75 | 11.095 ms | 36.065 ms |
| Final output-resolution edge | 28.27 | 8.445 ms | 36.065 ms |

The final edge costs about 8% presented throughput here. Both runs stay at
full quality, with no >100 ms stall, unpresented/repeated frame, page error or
source change. Cinematic at this output size remains substantially heavier
than the default single-stage renderer. The corrected edge does not resolve
that broader performance limit. Evidence: `ridge-fullhd-before-20261106` and
`ridge-fullhd-after-20261106` under the same external evidence directory.
