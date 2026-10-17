# Mount Moran terrain shading study

One default-off experiment in the Jackson Lake view. The aim is to make
the existing mountain's snow boundaries and rock faces easier to read at
the normal pixel grid, without adding an independent texture pattern.
This is an artistic study, not an accepted replacement for the original.

## Baseline and scope

The inspected starting tree is `87d9cc7a93d26a6d87e53ce09cabf23e8d1b4241`,
identical to main at `2a5e46f9b0b8d7652a0ae4bdf10d0c46b7810c57`
("Remove foreground sea and boat overlay from the Range"). The local
reconstructed checkout recorded `e46a0e9`; tree and file hashes were
verified against GitHub before editing. Captures record the source digest
as well as that local base commit; the initial local candidate captures were
made from an uncommitted working tree, identified by their per-file hashes.
The rejected A/B/C atlas pilot is absent
from this tree; it was not expanded or rolled back. The overlay removal
and unrelated rendering improvements are retained.

The active path is Range v2, `RangeScene` → `createSceneMaterial` →
`SCENE_FRAG`, followed by the existing pixel presentation. Original/Depth
pixel scaling remains an independent presentation choice. No changes were
made to its sizing policy, resolution controls or copy shader.

## Treatment and inputs

Mount Moran is the large snow-and-rock subject at the right of the Jackson
Lake composition. The terrain package places its summit at source XZ
`[-6128.6, -558.4]` metres. Mesh transforms are identity. Source coordinates
are X east, Y up, Z south; source height is retained in `vWorld`, separately
from the musically displaced `vRenderedWorld`.

The existing `uSurface` texture contains encoded XZ normals, signed
curvature (positive gullies, negative ridges) and flow/water coverage. The
20 m source grid and its existing mip chain are sampled with the material's
half-texel-corrected UV. One extra LOD-2 curvature lookup, only inside the
subject, gives an approximately 80 m neighbourhood. It does not quantize
or replace the geometry normal.

The experiment:

- Reduces unrelated rock-tile albedo and normal variation, leaving actual
  geological normals to describe the faces and retaining more fracture
  detail near convex/concave relief.
- Gently reshapes the existing mixed snow coverage using curvature. Fully
  bare and fully snowy endpoints stay intact. Continuous pixel-footprint
  filtering avoids a hard new coverage threshold.
- Uses existing rock/snow palette tones and the original light calculation.
  Its source-space footprint fades above the treeline around this mountain;
  water, glacier and forest coverage are excluded.

There are no added textures, geometry, render targets or asset pipeline.
OFF selects the original fragment string without injecting experimental
GLSL. Other views never select the experimental material. Camera choreography,
musical controls, weather, lights, palette and pixel scaling are unchanged.

The first implementation made snow edges clearer but flattened rock into
large dark patches. One focused revision restored more fracture variation,
reduced the snow remapping and kept face tones closer to the original.
The localized concept is a design study, not evidence of an implemented render.

## Enable

Add `terrainShading=moran` to the URL and reload. To reproduce the selected
scene, also use `rangeRenderer=v2&rangeView=teton-jackson-lake`. Remove the
shading parameter (or set `terrainShading=off`) to use the original path.
This developer setting is intentionally separate from Original/Depth and
Classic/Detailed pixel controls. It is neither persisted nor enabled by default.

## Reproduce and review

```sh
node tools/terrain-shading-evaluate.mjs --manifest test/fixtures/terrain-shading-stills.json --out .smoke/moran-off --close 1
node tools/terrain-shading-evaluate.mjs --manifest test/fixtures/terrain-shading-stills.json --out .smoke/moran-on --shading moran --close 1
node tools/terrain-shading-compare.mjs .smoke/moran-off .smoke/moran-on .smoke/moran-review
```

Use `terrain-shading-motion.json` instead for the 18–30 s passage; omit
`--close`. `PLAYWRIGHT_CHROMIUM_PATH` can select an installed Chromium.
Both sides must use the same browser and launch flags. The HTML report
offers full-size toggles and a wipe, with labels outside the scene.

The real application's generated 96 s contrast recording is decoded and
analysed through the normal upload path. Captures retain atmosphere,
foreground scenery and musical controls. Fixed-clock output is 1280×720,
DPR 1, Classic 320×180, Depth scaling, Pixel look and the existing world
palette. Stills use quality 0 at 18 and 24 s; close uses the existing 1.8×
listener zoom at 24 s. Motion uses quality 3, 6 captured FPS for 12 s.
Each pair has identical settings; the motion quality/cadence limitation is
explicit and is not evidence of hardware frame rate or high-cadence stability.

The runner verifies the compiled material, active view, actual camera,
asset readiness and shader linkage. The comparison rejects mismatched
camera projection, audio, weather, lighting or effective presentation.
Original-base versus current-OFF is a separate preservation check using
`visual:eval --compare ... --require-identical`. OFF preservation is not
an artistic result for ON.

The **Terrain shading study** PR workflow retains `terrain-shading-stills`
and `terrain-shading-motion` artifacts for 14 days. Open `review/index.html`
after extracting them. Captured images, audio and reports stay outside git.
The PR records the evaluated result, observed timings and remaining limits.
