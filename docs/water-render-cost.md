# Water render cost: where Landscape frames went, and what changed

Reported: Landscape lags badly on consumer hardware. This page records the
measurement, the two changes it led to, and how to repeat the check.

## How it was measured

`tools/render-hotspots.mjs` draws fixed export frames (no wall clock, no
frame pacing), records the wall time of each `renderExportFrame`, a V8 CPU
profile grouped by function, and a SHA-256 of every frame's PNG. Two runs
with the same song and settings are byte-comparable, so a performance change
can be checked for an identical picture.

```sh
node tools/gen-pilot-wav.mjs .smoke/pilot.wav 90
npm start &   # or any static server on the repo root
node tools/render-hotspots.mjs --url http://localhost:8080/ --wav .smoke/pilot.wav \
  --frames 30 --out .smoke/hotspots.json --png-dir .smoke/hotspots-png
```

**Caveat on magnitudes:** the cloud container rasterizes WebGL in software
(SwiftShader). There, the GPU's work shows up inside `drawImage` of the
WebGL canvas, and absolute milliseconds are far above any real GPU. Which
pass costs what, the ratios between passes and the pixel identity are what
transfer; the per-frame numbers are not device timings.

## What the profile showed

Pilot song, 1280×720 output, Classic 320×180 grid (scene grid 352×212 with
overscan), 30 frames from 2 s to 45.5 s:

| | per frame |
| --- | --- |
| whole frame | 11.26 s |
| `drawImage` (all WebGL work lands here) | 97% |
| `RangePresentation._keepWater` | 71% |

The lake layer renders the scene twice per frame (native grid for the shore
mask, then up to output size for the smooth water) and each time it draws
**every terrain triangle** with `uWaterOnly` set, so the material shader runs
glacier, six deformation samples and the coverage lookup before discarding
the fragment as dry. At 4× the grid, that is 16× the terrain's own fragment
work, almost all thrown away. Isolated timings in the same harness:

| pass | before |
| --- | --- |
| terrain partitions (far + mid + near) | 0.88 s |
| water at native grid | 1.28 s |
| water at 4× (output) | 6.37 s |
| water at 16×9 px (vertex/fixed cost only) | 0.66 s |

## Change 1: a precomputed water-only index (`WaterSubset.js`)

A fragment is water only where `waterCoverageAt` reaches a fully wet surface
texel (alpha 255), and a triangle's fragments only sample texels inside the
box of its vertices' grid coordinates. At view preparation, before the
surface texture's CPU copy is dropped, each band and seam-fill geometry gets
a second index holding only triangles with a wet texel in that box (plus a
texel of margin), in their original order. `renderWater` swaps those indices
in for the water-only colour passes. Dropped triangles could only ever
discard, and kept ones draw in the same order, so the picture is unchanged.

The pilot view keeps 29,590 of about a million terrain triangles. The build
runs in bounded slices (256 texel rows, 65,536 triangles) because views
prepare while a song plays. A band where more than half the triangles could
be wet keeps its full index. Tours (streamed terrain windows) are unchanged.

## Change 2: a scissored lake mirror (`MirrorScissor.js`)

The planar mirror re-renders the whole view, reflected, at twice the grid.
Only lake fragments read it, at `uMirrorMatrix * vRenderedWorld` plus a
shiver, through a bilinear fetch. Lake fragments lie on the precomputed
water triangles, so their bounding boxes (384 m bins) are projected through
the mirror matrix, with the frame's vertical lift and shiver bounded from its
own uniforms (times two for safety), boxes outside the main view skipped,
and two texels added for the bilinear footprint. The mirror render is
scissored to that rectangle. A box that reaches the mirror camera's plane
widens the rectangle to the clamp edge it can run off toward; anything that
cannot be bounded draws the whole mirror as before. The pilot frame's mirror
drew 40% of its texels.

## Result

| | before | after |
| --- | --- | --- |
| water at 4× (output) | 6.37 s | 0.85 s |
| water at native grid | 1.28 s | 0.42 s |
| whole frame, mean of 30 | 11.26 s | 4.40 s (change 1); 4.83 s on a later run with both |

All 30 frames are byte-identical to the original renderer, after each
change. In the software rasterizer the mirror's remaining cost is mostly
vertex work, so change 2 measures small there (about 7% of the mirror); on a
real GPU the mirror's cost is its full-material fragment shading, which is
what the scissor removes. The two whole-frame runs differ by about 10%,
which is run-to-run noise in this shared container, not a cost of the
scissor (it projects 134 boxes per frame).

`test/waterSubset.test.mjs` and `test/mirrorScissor.test.mjs` check both
bounds by brute force: every sampled point of every triangle that can shade
water is kept, and every texel a visible lake fragment can fetch is inside
the scissor. Both fail when their margins are removed.

## What is left, in order

1. **Vertex work.** Every frame still pushes the full terrain (about 1.5 M
   triangles in the pilot view) through the vertex shader six times: the
   partition depth pre-pass, the three partitions, two water depth
   pre-passes and the mirror's depth and colour passes. Each band is one
   merged mesh drawn with `frustumCulled = false`. Splitting bands into
   spatial chunks with precomputed bounds, and skipping chunks outside the
   (lift-padded) frustum, keeps the picture identical and cuts this in
   proportion to what the rail is not looking at.
2. **The far partition** (0.6 s here) is mostly that same full-terrain
   depth pre-pass.
3. **Offline bake.** The water index and boxes depend only on the terrain
   package, so they could be baked by `tools/build-range-scene.mjs` and served
   with it instead of computed on the device (about 125 ms of main-thread
   work on a desktop, sliced; several times that on a head unit).

## The mirror is shed first

Rendered both ways at 8, 20, 32 and 44 s of the pilot song, dropping the
mirror changed 1.4%, 2.0%, 0% and 1.0% of pixels (largest: faint shoreline
detail in the water at 8 s) and made the frame about 11% cheaper in the
software rasterizer. The quality ladder (RangeQuality.js) now sheds the
mirror at rung 1, before anything else, instead of rung 4. Level 0 keeps it;
any machine that sheds at all, Economy, and the phone start rung draw the
lake from the reused sky/far backdrop, blurred (RangeScene.captureBackdrop).
A low camera over a lake under a steep shore is where the mirror shows most;
that case was not captured.
