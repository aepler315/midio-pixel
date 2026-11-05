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
  storm lean. The lean is doubled and every box padded by 1 m. The song's
  rise (`LandRise.js`) moves every vertex last and only down, by more the
  higher it stands and the nearer it is to the eye, so a box's floor drops
  to its bottom at its nearest point (`risenFloor`), as the terrain chunks'
  floors do.
- A geometry with no box inside the frustum (narrowed to the target's
  scissor) gets `instanceCount` 0 for that render, and `Scene.onAfterRender`
  puts it back. three.js still binds, uploads and orders everything as
  before: with a count of 0, `renderInstances` skips only the draw call.
  The band and depth scenes share these geometries, so the counts a render
  that throws leaves at 0 are put back by the next culled render of any
  scene, and before the detail view (whose footprints read the count) or
  the rail/tour switch (which sets it) touches them.
- Billboards are never culled, and neither is a mesh with a model matrix
  or a batch whose bound is unknown: non-finite deformation, dance, wind or
  parting uniforms, an asset outside [0, 1] up, a tree id outside [0, 1],
  or a rise the floor cannot bound. The shader reads the rise raw, so that
  is a sink above 1 or NaN, or a positive sink with a negative or
  non-finite pivot or no finite eye. A sink of 0 or less draws no rise and
  culls as usual.

Result on main 181d2a3, 1280×720. `teton-jackson-lake`, 8 export frames
from 2 s to 44 s:

| per frame | main (two runs) | after |
| --- | --- | --- |
| triangles submitted | 45.49 M | 16.26 M |
| lake mirror | 14.99 M | 8.48 M |
| partitions | 15.31 M | 4.05 M |
| water, native + output | 8.15 M | 2.03 M |
| fine crest probe | 4.01 M | 1.14 M |
| cast | 3.04 M | 0.56 M |
| draw calls | 319 | 203 |
| wall time, software rasterizer | 34.5 s, 34.7 s | 26.3 s |

The pilot view (30 frames from 2 s to 45.5 s) has mesh trees since its
rebake: 7.84 M triangles and 243 draw calls per frame become 6.62 M and
185. Every frame of both views is byte-identical to both main runs.

`test/forestCulling.test.mjs` checks the bound by brute force against a CPU
twin of the tree shader, whose lines it pins and which reads the rise
uniforms raw, as the shader does: every vertex of every asset, for random
trees, deformation, dance, wind, storm, parting and the rise (with the eye
far from the trees and among them), lies inside its cell's box with no
safety factor and no padding. Each term of the bound is needed (shrinking it
lets a vertex out), each deformation and dance term keeps a tree it lifts or
sinks into view, the rise keeps a tree it brings down into view (also with
only 3 m of trunk in the frame), a box under the rise takes its floor where
it comes nearest the eye even when that is not a corner, and a batch it
culls has no vertex inside the clip volume, for random and mirrored cameras
and for views pitched up under the rise, where it brings trees down through
the frame's top edge. Every value the rise accepts is covered, small sinks
and a sink of 1 among them, and the bounds `forestGeometryVisible` uses are
checked to hold the tight ones the brute force uses.
Whole spans of the shader are pinned, so an added term fails.
`test/forestCullingRender.test.mjs` runs real three.js renders on a
recording WebGL2 context: a culled batch loses its draw call and nothing
else, every program bind, vertex array bind and other draw staying in
order. Each batch gets its own count back after the render, after a render
that throws (also when another scene sharing the batch draws next), and
with the terrain culling chained in.

## Change 7: the mirror leaves out what nothing tests (`RangeScene._prepareMirror`)

With soft trees, the lake mirror draws its target in five steps: the depth
scene and the bands on layer 0, the bands' soft crowns on layer 1, the
crown cut (layer 2, depth only), and then the ink and the cast (layers 3 to
5, each band). The crown cut is there for the ink and the cast to test
against: the mirror target has no depth texture, and it is cleared before
every redraw, so nothing else reads that depth. When the ink is below the
ink shader's discard and no cast is on screen, the ink and the cast draw no
pixel, and the crown cut has nothing to occlude. The mirror now leaves all
three out in that case.

- The gate is `!(uNarrativeInk < MIRROR_INK_SKIP) || _castShown(p)`, with
  `MIRROR_INK_SKIP` = .004. `FEATURE_FRAG` discards below .005, and .004
  stays below it in float32 with room for the literal's rounding. NaN and
  Infinity keep drawing, as the shader keeps them.
- `_castShown` is the predicate the main view's cast pass already uses: a
  lantern group visible, or a site, thread or rope laid out and lit. With
  none of these, every cast fragment is clipped, discarded or adds zero.
- Skipping a render must not move state three.js caches the first time a
  render lists a mesh: `geometry.boundingSphere` is computed then, and its
  centre is the depth three sorts that mesh by from then on. Every layer-2
  tree depth mesh shares its geometry and its visibility with a tree the
  same mirror pass draws earlier on layer 0 or 1 (a test pins this against
  `createForest`). The ink's lines and the cast's quads never move, and the
  survey threads are laid out from the view's fixed `castWork` before the
  first render.
- Today the ink is always 0 (the compiled landscape sources give materials
  1 and sky dark 1), so the skip follows the cast alone. With the pilot
  song the cast comes on about 3 s in, on the pilot view and on the Teton
  tour alike: the skip fires on the frames before that and on none after.

Result on main 7d48f2f, 1280×720, frames from 0.25 s every 0.5 s:

| per frame, 0.25 s to 2.75 s (no cast yet) | main | after |
| --- | --- | --- |
| `teton-jackson-lake` tour: triangles | 140.6 to 142.2 M | 127.4 to 128.6 M |
| its lake mirror | 48.8 to 50.4 M in 11 renders | 35.6 to 36.8 M in 7 |
| its draw calls | 200 to 203 | 188 to 191 |
| pilot view: triangles | 4.42 to 4.56 M | 4.37 to 4.52 M |
| its draw calls | 134 to 143 | 126 to 135 |

From 3.25 s on, with the cast out, both views do the same work as main.
Frames compared by PNG SHA-256: the pilot view, 60 frames from 0.25 s to
29.75 s, and the Teton tour, 8 frames from 0.25 s to 3.75 s. Every frame is
identical except 2.75 s, which also differs between runs of main itself
(three runs, three hashes on the pilot view; the pixels that move are sky
clouds and skyline and ridge borders, nowhere near the lake). The saving is
the trees' crown cut, so it is large on the Teton tour, which still draws
trees along every shot line (a fix for that is in progress), and small on
the pilot view, which has few trees.

`test/mirrorSkip.test.mjs` checks the gate: ink just under and at the
threshold, at the discard, NaN, Infinity and negative; a visible group; a
site, a thread and the fixed line, each lit and unlit (the last two on the
real `ActorsGL`); both values of `castInBands`, which the mirror must not
follow; and a decision taken afresh on each redraw of one target. It checks
that the threshold stays under the shader's discard in float32, that a
scissored mirror makes the same choice, and that a mirror with no soft trees
keeps its single combined pass. On the forest's side, layer 2 holds only
depth-only meshes, layers 3 to 5 hold none of the forest's, and each
layer-2 mesh, the rail's own batches and the tour layer's twins and demote
boards included, shares its geometry and its visibility with a tree drawn
first, through detail, lite and blended footprints, a hidden forest, a
dropped detail ring, the rail and the tour, and a refill.

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
   it cannot be shown to keep every pixel: the core and the cut are two
   programs (`FOREST_CORE`), only `gl_Position` is declared invariant, and
   their discard tests (the detail/lite hash, `sin` of large phases, the
   `fwidth` divisions) may round differently between two compilations.
   Where the core keeps a fragment the cut discards, its depth would be
   lost. Dropping only cores whose every box is past the fade (at least
   6630 m out, where no core fragment survives) is provable, but whole
   batches span the view, so it saves almost nothing until they are split.
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
