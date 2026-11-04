# Water render cost: where Landscape frames went, and what changed

Reported: Landscape lags badly on consumer hardware. This page records the
measurement, the changes it led to, and how to repeat the check.

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

## Change 3: the native water pass copies the partition's depth

At the native grid, the side's partition target already holds this frame's
terrain and forest depth when `renderWater` runs. `_sharedDepth` checks that
it is the same frame, view and side, and `_copyDepth` blits it into the water
target (`gl.blitFramebuffer`, `DEPTH_BUFFER_BIT`) instead of redrawing the
whole terrain's depth. Only the trees' hard crown cut (layer 2) is drawn on
top when the partition did not already cut it. The output-resolution pass
cannot copy: its target is a different size. The mirror cannot either: its
camera is different. This removes one full-terrain pass per frame.

## Change 4: per-tile culling inside each band (`TerrainChunks.js`)

Each depth band is one merged mesh drawn with `frustumCulled = false`. The
land moves vertically every frame, so three.js would have to cull the band
as one object. Splitting a band into one mesh per chunk is not safe for
identity: three.js sorts opaque meshes of one material by distance, and the
colour passes test LEQUAL without writing depth, so equal-depth seams resolve
to whichever triangle draws last. A band therefore stays one mesh and one
render item, and it is culled by draw groups.

- `buildTerrainGeometry` records each tile's index range, which is
  contiguous in the band index and in its seam fill, and its box.
- Each band, seam-fill and water-subset geometry carries that table in
  `userData.terrainChunks`. Its meshes hold `[material]`, because three.js
  honours draw groups only for array materials.
- `Scene.onBeforeRender` runs before three.js culls or sorts. There, the
  groups become the runs of tiles whose boxes reach the camera's frustum, in
  index order. The frustum is narrowed to the target's scissor plus a pixel.
  Each box is lifted by this frame's displacement bound
  (`MirrorScissor.liftBounds`, twice the deformation uniforms plus the ice,
  plus 1 m) and padded by 1 m.
- Gaps under about 2,000 triangles are drawn through, and each geometry
  gets at most 8 draws. `Scene.onAfterRender` puts back the whole-index group.

A culled tile lies wholly outside one clip plane, so it could not have made a
fragment. Every drawn triangle keeps its place in the sequence. This applies
to every pass that draws the bands: the partitions and their depth pre-pass,
the mirror (through the mirror camera and its scissor), the fine crest probe,
ownership, travel seams and tour windows.

## Change 5: a scissored output-resolution water pass

Above the native grid, nothing reads the water target's depth, and its water
can only appear on water-subset triangles. When every band and seam geometry
has a subset and no river shares the band scenes, the whole pass is
scissored to the projected rectangle of the water boxes, depth pre-pass
included (`MirrorScissor.waterScissor`). These boxes hold whole triangles,
each binned by its first vertex's cell, so a box the camera culls holds no
visible water. They are lifted the same way, with 2 px of margin. The culling then drops every tile outside that
rectangle. The native pass stays whole, because the crest probe reads its
depth and colour.

## Result (changes 3 to 5)

Pilot song, 1280×720, Classic grid, 30 export frames from 2 s to 45.5 s
(scratch harness counting what each `renderer.render` submits). Base is main
before these changes, run twice, before and after the branch:

| per frame | base | after |
| --- | --- | --- |
| terrain triangles submitted | 9.81 M | 3.80 M |
| partitions (depth + far, mid, near) | 2.90 M | 1.49 M |
| lake mirror | 2.74 M | 1.44 M |
| fine crest probe | 1.37 M | 0.72 M |
| water, native + output | 2.80 M | 0.15 M |
| draw calls | 89 | 140 |
| wall time, software rasterizer | 3.46 s, 3.41 s | 2.41 s |

All 30 frames are byte-identical to both base runs. The culling keeps 45% of
the indices it tests. The output water scissor covers 13% to 30% of the
target (25% on average). The extra draw calls are the visible runs, at most
8 per geometry and render. Full-terrain vertex passes at rung 0 go from 7 to 6
(the copied depth), and every remaining pass submits only what can reach its
target.

The pilot's 9 s frame is not deterministic: two runs of the same build have
differed by about 1% of its pixels. Compare it against two base runs, not one.

`test/terrainChunks.test.mjs` checks the culling by brute force. Every
sampled point of every culled tile, displaced anywhere inside the lift,
falls outside the clip volume, for random cameras, view offsets and
scissors. Visible tiles are never culled, and groups stay in order. It
fails when the lift is dropped or a plane is tightened. It also checks the
tables of real bakes and of the water subsets RangeScene builds.
`test/terrainChunksRender.test.mjs` runs real three.js renders on a
recording WebGL2 context: consecutive in-order runs per band, scissors,
stale rectangles, a moved viewport and a failed render.
`test/mirrorScissor.test.mjs` checks that every pixel a lake triangle can
draw in the main view lies inside the water scissor, including when a
frustum side falls between two boxes. It also checks that `liftBounds`
holds every displacement of the CPU twins (ice, deformation, dance).
`test/waterScissor.test.mjs` checks when the water pass is scissored, and
`test/waterDepthCopy.test.mjs` checks every guard on the depth copy.

## Change 6: whole-batch forest culling (`ForestCulling.js`)

The pilot view has few trees. A forested view does not: on
`teton-jackson-lake` at 20 s, the forest was 35.8 M of the frame's 41.9 M
triangles, over 11 traversals (mirror, partitions, water, crest probe,
cast). The mesh trees are instanced batches, one per band, species family
and variant (`ForestGL.createForest`), each spread along the whole rail and
drawn with `frustumCulled = false`, so every pass submitted every tree.
Culling trees inside a batch would change which trees draw before which,
and the soft crowns blend in instance order. A whole batch can go, though,
when none of its trees can reach what the render draws.

- `Scene.onBeforeRender`, chained after the terrain culling, tests each
  mesh-tree geometry once per render. Its trees, binned by root into 256 m
  cells, become boxes that hold every vertex the tree shader can place this
  frame: the root lift (`liftBounds`), the height (asset positions are
  checked to lie in [0, 1] up), the crown and trunk radii (measured from the
  asset, times the shader's largest scale) and the wind, gust, parting and
  storm lean. The lean is doubled and every box padded by 1 m.
- A geometry with no box inside the frustum (narrowed to the target's
  scissor) gets `instanceCount` 0 for that render, and `Scene.onAfterRender`
  puts it back. three.js still binds, uploads and orders everything as
  before: with a count of 0, `renderInstances` skips only the draw call. A
  render that throws is restored by the scene's next render.
- Billboards are never culled, and neither is a mesh with a model matrix
  or a batch whose bound is unknown (non-finite uniforms, an asset outside
  [0, 1] up).

Result, `teton-jackson-lake`, 1280×720, 8 export frames from 2 s to 44 s:

| per frame | main (two runs) | after |
| --- | --- | --- |
| triangles submitted | 45.49 M | 16.26 M |
| lake mirror | 14.99 M | 8.48 M |
| partitions | 15.31 M | 4.05 M |
| water, native + output | 8.15 M | 2.03 M |
| fine crest probe | 4.01 M | 1.14 M |
| cast | 3.04 M | 0.56 M |
| draw calls | 319 | 203 |
| wall time, software rasterizer | 32.1 s, 32.4 s | 27.7 s |

All 8 frames are byte-identical to both main runs. The pilot view has no
mesh trees, so its counts do not move; its 30 frames stay byte-identical to
three main runs.

`test/forestCulling.test.mjs` checks the bound by brute force against a
CPU twin of the tree shader, whose lines it pins: every vertex of every
asset, for random trees, deformation, dance, wind, storm and parting, lies
inside its cell's box with no safety factor and no padding. Each term of the
bound is needed (shrinking it lets a vertex out), and a batch it culls has
no vertex inside the clip volume for random and mirrored cameras.
`test/forestCullingRender.test.mjs` runs real three.js renders on a
recording WebGL2 context: a culled batch loses its draw call and nothing
else, every program bind, vertex array bind and other draw staying in
order, and the counts come back after the render, after a render that
throws, and with the terrain culling chained in.

## What is left, in order

1. **The mirror scissor's cell gap.** The mirror still uses main's boxes,
   which bin vertices. A lake triangle crossing a 384 m cell line leaves a
   strip in neither box. When a main-view frustum side falls in that strip,
   the mirror scissor can stop short of texels a frame-edge lake fragment
   reads. Those pixels then reflect only the backdrop. Giving the mirror the
   water scissor's triangle boxes fixes it. It is left out here because it
   changes pixels, and this change keeps every frame identical.
2. **The mirror's fragment cost** on real GPUs. It is scissored and now
   culled, but it is still a full-material pass at twice the grid. It is
   shed first by the quality ladder (below).
3. **Offline bake.** The water index, its boxes and the chunk tables depend
   only on the terrain package. `tools/build-range-scene.mjs` could bake
   them and serve them with it instead of computing them on the device
   (about 125 ms of main-thread work on a desktop, sliced; several times that
   on a head unit).
4. **The fine crest probe's depth.** It is the same camera and frame as the
   output water pass, but its size matches only when the output is exactly
   4× the grid, and it has no depth texture. Since change 5 the payoff is
   small.
5. **Forest depth drawn twice.** Where a depth-only render also draws the
   crown cut (the output water pass, travel depth, the cast), the core depth
   mesh of the same batch writes depth the crown cut writes anyway. Dropping
   it was estimated to save 1.7 M triangles per frame on
   `teton-jackson-lake` before change 6, which already culls part of that.
6. **Trees inside a batch.** The lake mirror still submits about 8.5 M forest
   triangles there. Culling single trees while keeping their order (a
   compacted instance list per render) would cut it further, at the cost of
   per-render uploads.

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
