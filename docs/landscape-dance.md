# Landscape dance: the ridge/drainage hierarchy

Status: prototype, **on by default** for static views. `?landDance=0` (or a
0..1 value) remains only as an opt-out for side-by-side checks; with it at 0
every frame is unchanged.

## Why a hierarchy

The music already moves the land (`TerrainDeform.js`): a long sine swell and
a lift, weighted by normalized height squared. That reads as a sheet being
shaken, because the only geography it knows is "higher moves more". Real
relief is organized: water carves a branching drainage network, and the
ridges between the branches form their own branching network of spurs, side
ridges and main spines. Motion routed through that structure reads as the
range itself responding, and it keeps the parts that must not move (valley
floors, lakes, shores) still for a reason the eye accepts.

## What the prototype computes (`src/world/alpine/TerrainHierarchy.js`)

From one coarse lattice of the drawn heights (384² desktop, 256² mobile,
roughly 0.5 s per view in Node, built in slices during view preparation):

| Field | Method | Used for |
| --- | --- | --- |
| Filled surface | Priority-Flood+epsilon (Barnes, Lehman & Mulla 2014) | every cell drains, pits and lakes included |
| Flow direction | D8 steepest descent on the filled surface | drainage tree |
| Contributing area, drainage order | accumulation in flood order; Strahler order over cells above 0.25 km² | channel network |
| Height above nearest drainage (HAND) | Rennó et al. 2008, followed down the D8 tree | `relief01`: 0 on valley floors, lakes and channels |
| Flow distance to outlet | summed along the D8 tree | phase of the downstream wave |
| Ridge network, ridge order | D8 steepest *ascent* on raw heights (≥ 3 % rise), ascent area above 0.12 km², Strahler order; only where relief ≥ 12 % of the reference | order of `spine01` |
| Crest convexity | minus the Laplacian of heights smoothed over ~1 cell, over its 90th percentile | shape of `spine01` |

D8 only knows eight directions, so a band built from its cells steps at 45°.
The network therefore supplies only the ridge *order* (dilated and blurred);
the band's *shape* is the crest convexity, which follows a ridge at any angle
(`test/terrainHierarchy.test.mjs`: a 30° ridge stays within one cell). For
drawing, `networkPolylines` walks either tree and Chaikin-smooths each link.

Packed into one RGBA8 texture (R relief, G spine band (order × convexity), B/A cos/sin of the
flow-distance phase, blurred so divides and confluences fade instead of
tearing). `tools/terrain-hierarchy-preview.mjs` writes PNG panels of the
networks and fields for any baked view.

## How the music drives it (`landDance` in `RangeFrame.js`)

Two channels, added to the existing field in the same vertex function
(`danceField` in `DEFORM_GLSL`, CPU twin `danceDisplacement`):

- **Spine breath.** Ridge spines rise with the music's energy (55 %), the
  section moment (50 %) and only a trace of the kick (15 %), capped at 1 and
  scaled by relief. (The first version heaved 75 % on the kick at 32 m;
  Ashton found it read as the ridges retching.) A gate walks down the ridge
  orders with energy: quiet music moves only the highest-order spines, a
  loud section or a section change opens every spur.
- **Downstream wave.** `relief · sin(k·d + φ)` with `d` the flow distance and
  `φ = 2π · beats / 16`: a 6 km wave runs down every drainage, one
  wavelength per four bars, locked to the song's beat transport (heard time, so
  seeking and export reproduce it). Free-time songs fall back to 2 beats/s.

Both are multiplied by the receiver mask and the tour fade like the rest of
the field, and by relief, which is zero on drainage.

**Budget.** At full dance the section swell gives up 15 % of its share
(`LAND_DANCE.swellYield`), and spine (10 m) plus wave (6 m) take it: the
summed bound stays under `RANGE_MOTION_REFERENCE_M`, so the calibrated
on-screen motion (8–20 px), `LAND_MAX_DISPLACEMENT_M`, the camera's
`DEFORM_PAD_M` and the forest's detail bound all hold unchanged.

## Compatibility

- **Water-only index (PR #64, `WaterSubset.js`).** The dance is vertical only
  and never changes a vertex's x/z, so the set of triangles that can sample a
  wet texel is unchanged. Water and shores are pinned twice (receiver 0,
  relief 0). Tested in `test/terrainHierarchy.test.mjs`.
- **Lake mirror scissor (`MirrorScissor.liftBounds`).** Extended with
  `|spine| + √2·(128/127.5)·|wave|` from `uLandDance`; tested.
- **Skyline and crest.** Both are read from what the GPU drew (skyline from
  the partition alpha, crest from the GPU column probe), so the full-res
  clipped outline follows the dancing crest with no extra code. Not yet
  checked: whether the crest's temporal steadying filter lags a beat-rate
  wave (see "Not verified").
- **Uniform budget.** One `vec4` and one sampler: the terrain fragment scan
  goes from 245 to 247 of the 248-vector ceiling. The next addition needs to
  pack something.
- **Cost when opted out.** A uniform branch; no texture fetch, no residency charge.
  Pilot song, 1280×720, 8 frames 4 s–39 s via `tools/render-hotspots.mjs`:
  7 of 8 frames byte-identical to the water-cost branch with the dance off.
  The 9 s frame differs between two runs of that base branch too, so it is
  not a usable identity check. With `?landDance=1` every frame changes along
  the crest and flanks; lake pixels do not move.

## Not verified / limits

- Tours (streamed terrain windows) do not build a hierarchy yet; the dance
  uniforms stay zero there. A tour would need the hierarchy per window, or
  baked into the terrain package (the bake already stores D8 accumulation as
  `log2(acc)·16`; flow distance and ridge order would be two more bytes).
- `landDetailErrorM` (tour LOD) does not include the field's curvature;
  `stats.curvaturePerM2` is computed for that bound but not wired.
- Ashton (2026-10-02) asked that the land move only at big moments because
  constant heaving read as accidental. The spine gate and the drainage
  anchoring are meant to make beat motion read as deliberate; that is an
  aesthetic call to make on real playback, not something the tests settle.
- Real-GPU cost of the extra fetch (six per fragment through `deformGrad`
  when dancing) was not measured.

## Next methods, ranked

1. **Basin call-and-response.** Label every cell with its outlet basin
   (free from the D8 tree) and give basins to stems or stereo pan, so the
   left valley answers the right one. Strongest musical read for the cost.
2. **Bake the hierarchy into the terrain package** so tours dance too and
   preparation drops the 0.5 s build.
3. **Hillslope breathing.** Displace by the surface texture's existing
   curvature channel (B, Laplacian): quiet passages soften the land toward a
   diffused version, loud ones sharpen it. No new data at all.
4. **Ridge-geodesic delay.** Propagate a kick from the highest summit out
   along the ridge tree with a delay by ridge distance, so a hit visibly
   travels down the spines.
5. **Stream-power morph at section peaks.** Precompute an incised height
   (`K·A^m·S^n` over the existing area and slope) and ease toward it at a
   chorus, so canyons deepen when the song does.
