# Landscape performance schedule

LandscapeScore compiles phrase identity, measured energy, camera moves and zero
or more weather episodes once per analysis revision. RangeFrame snapshots the
score at heard time; sky, water, terrain and lighting consume that frame's storm.
Quiet flat material has no obligatory squall. Physical RMS, where available,
prevents normalized background noise from becoming weather. Distinct sustained
peaks can earn separate builds, rain, accents and recovery.

Automatic scenic punch is Off in Landscape: Simulation and RangeFrame publish
the neutral lens `{halfAngleScale: 1, zoomPulse: 0, cueIndex: -1}`. Trusted
musical turns add no pulse FOV, compositor dip or pulse-driven tilt, including
loading and legacy fallback scenery. Impact roll, base framing, slow RangeCamera
moves and the listener's pointer zoom remain available. Trio retains its shared
trusted lens cues and analysis-handoff rules. Terrain-detail planning keeps its
conservative .82 half-angle allowance; this change does not retune terrain LOD.

Each weather episode has a character, classified once when the storm score
compiles (`RangeStorm.stormKind`) from that episode's own strikes per minute
and energy:

| Kind | Rule | Look |
| --- | --- | --- |
| 0 shower | under 1.5 strikes/min | strength capped at .6, never flashes, lighter slate deck |
| 1 downpour | otherwise | the original squall colours, unchanged |
| 2 thunderstorm | at least 6 strikes/min and energy01 at least .7 | darker, cooler slate |

`storm.at(t).kind` is the kind of the episode giving the largest amount (or,
after the deck has gone, the clearing's own storm). Lightning is gated by the
episode that owns the hit strike, so a stray hit inside a shower never lights
it. A song with no percussion evidence at all keeps every episode a downpour,
as before kinds existed. `STORM_KINDS` holds one frozen row per kind: the sky's
overcast gradient, the deck's dark/lit tint and the GPU zenith/horizon/air;
the sky (drawStormSky) and RangeScene read the same row by index. Every row
stays slate, away from the protected hues.

Live analysis keeps the active phrase/weather and its already heard lightning
strikes. An adopted episode keeps its kind, because the kind is remembered on
its frozen strike list. A six-second camera join admits the future schedule continuously. Seeks
sample envelopes directly; no skipped-event burst is dispatched.

Normal-view sky anchors are lifted into the authored rail's direction basis and
projected through the same moved pose, lens and off-axis crop as terrain. Both
travel partitions project before blending, including a late incoming fade.
Camera bases are resolved once per immutable sky frame and shared by every star,
cloud and celestial projection. Tours retain their world-direction sky. Both update the resolved light anchor.

Tour worker energy sampling uses milliseconds throughout (250 ms per sample).
Station selection checks climb and heading feasibility before committing a leg.
Distant composition preserves the safe eye path, checks every yaw step and a
whole-tour quality budget, and can select an explicitly recorded same-role
alternative. It does not retime a road to rescue a missed close visit.

`heroFraming` records `station`, `distant` or `missed`, the originally requested
point, the framed point, station distance and the fraction of the three-second
window inside the central 80% of the projection. These are projection metrics,
not proof of terrain occlusion, recognizability, musical acceptance or hardware
frame pacing. The browser tour harness now asserts the existing 0.8 view-quality
target and projected framing for feasible station visits, rather than merely
recording quality. A short song can retry a bounded slower itinerary when its
fast altitude corridor clears the ground but misses that quality target.
An authored station may look at a different named subject than its road waypoint;
framing reports both identities rather than testing the waypoint behind the camera.
Generated five-tempo fixtures remain synthetic music coverage.

The core Node suite runs serially: server tests briefly create/remove public-src
fixtures while real browser tests snapshot that directory. Parallel execution
can race the fixture cleanup and fail with ENOENT, independently of scene code.

Captures, matching audio, device traces and review reports stay outside Git as
required by AGENTS.md. See the PR/chat evidence for the exact tested revision,
completed comparisons and remaining external CI/Pages configuration limits.

## Water-only terrain draw

The water pass repeats the terrain colour draw and discards every dry fragment.
A static view draws, in place of each band and seam mesh, a water-only index
(`WaterSubset.js`, see `docs/water-render-cost.md`): an index holding only
the triangles whose texel box can reach a wet surface texel, in their original
order, culled per tile like the bands (below). A `mapped-only` view has no terrain water, so its terrain
colour draw disappears. Tour views keep the whole draw.

The earlier index-range variant (`WaterColourRanges.js`, up to four draws per
mesh split at dry gaps) was removed: whenever a water subset existed it was
already bypassed, and it doubled the view's preparation time.

At the native grid the water pass copies the partition's depth
(`gl.blitFramebuffer`) instead of drawing the terrain's depth again. Above the
native grid the whole pass is scissored to the water boxes' projected
rectangle.

## Terrain culling

Each depth band stays one merged mesh, so three.js never re-sorts its
triangles. It is culled per tile through draw groups instead
(`TerrainChunks.js`). Before each render, the groups become the in-order runs
of tiles whose boxes reach the frustum and the target's scissor. The boxes are
lifted by the frame's own displacement bound. After the render, the
whole-index group is restored. A culled tile cannot make a fragment, so frames
stay byte-identical. The pilot song submits 3.8 M terrain triangles per frame
instead of 9.8 M. Terrain meshes hold `[material]` because three.js honours
draw groups only for array materials. Use `setTerrainMaterial` and
`terrainMaterial` to swap or read it.

## Forest culling

Each mesh-tree batch (band, species family and variant) stays one instanced
draw, so three.js never reorders its trees, whose soft crowns blend in
instance order. A whole batch is skipped instead (`ForestCulling.js`).
Before each render, every mesh-tree geometry is tested once: its trees,
binned by root into 256 m cells, become boxes that hold every vertex the tree
shader can place this frame (root lift, height, crown and trunk radii, and the
wind, gust, parting and storm lean, doubled, plus 1 m; the song's rise lowers
each floor to its bottom at its nearest point, `risenFloor`). A geometry with no box
in the frustum and the target's scissor gets `instanceCount` 0, which skips
only its draw call; after the render the count is restored. Frames stay
byte-identical. On `teton-jackson-lake` a frame submits 16.3 M triangles
instead of 45.5 M, and on the pilot view 6.6 M instead of 7.8 M. Billboards
are not culled. The counts a render that throws leaves at 0 are put back by
the next culled render of any scene, or by `restoreForestCulling`, which the
detail view and the rail/tour switch call first.

## Tour forest windows

On its shot tour a two-camera static view draws every mesh-ring tree of the
tour as a mesh. Most are far from the eye at any moment. The tour forest layer
(`TourForest.js`, `createForest`'s `tour` option) draws as meshes only the
trees near the part of the tour being played. Every other tree is drawn as a
billboard. The rail does not change: its batches, counts, shaders and draw
calls are those of a forest without the layer, and the layer's objects stay
hidden there.

The rule is set by constants in `TourForest.js`:

- **Windows.** The timeline is cut into 4 s windows (`TOUR_WINDOW_MS`), 40 eye
  keys each. Each window's keys are extended by half a fade, 0.5 s, on each side.
- **Window sets.** A window's set holds every tree whose root lies nearer the
  simplified key path than `reach + M + δ + τ + ε`:
  - `reach` is the tree's own mesh ring, 1200 m times its ring scale
    (`forestRingScale`).
  - `M` is a 50 m margin (`TOUR_MARGIN_M`).
  - `δ` bounds how far `poseAt`'s Catmull-Rom curve leaves its chords
    (`crDeviation`).
  - `τ` is the 2 m Douglas-Peucker tolerance (`TOUR_TAU_M`).
  - `ε` is 0.25 m (`TOUR_EPS_M`).

  A tree within its ring of the eye is therefore in the set of every window
  whose span holds the frame's time.
- **Dissolves.** Each window boundary dissolves over 1 s (`TOUR_FADE_MS`).
  Each instance carries two bits: whether it is in the outgoing set and
  whether it is in the incoming one. A tree in only one of the two sets turns
  into a mesh or a billboard when the fade passes its own key,
  `fract(id * 4099)`. The same rule decides mesh and board, so each tree is
  drawn once.
- **Schedule.** `TourForestSchedule` keeps up to 32 computed windows
  (`TOUR_CACHE_WINDOWS`) and computes at most one upcoming window per frame
  ahead of need. A new timeline (a replan) keeps only the windows whose keys
  it leaves byte-equal. The layer refills its twins whenever the drawn sets
  are different objects, so a replan of the playhead's window takes effect on
  the next pass.
- **Guard.** Each pass checks the eye it draws from, after the camera moves.
  It must lie within `δ + τ + ε` of both windows' paths. Otherwise that pass
  draws every tree of the layer as a mesh, which is the tour without the layer.

Each static mesh batch has a twin that holds that batch's trees in the drawn
sets, in placement order. Each band has a demote board holding all its trees,
which draws those that are not meshes. Neither carries a culling tag, so
`ForestCulling.js` never changes their counts. The static mesh-ring batches
are hidden on the tour.

Residency: the layer's bytes (`tourForestBytes`) are charged in the view's GPU
reservation. It is built only when it fits beside both cameras, and on phones
only when twice its size fits. Otherwise the view keeps the static tour
forest, and if even a reservation without the layer fails, the existing
refusal path follows. The layer costs 5.85 MiB on `teton-jackson-lake` and
15.87 MiB on `black-mountains-catawba`. The pre-placement room check
(`_tourRoom`) does not count the layer.

`RangeScene.tourForest` (true) switches the layer for views prepared after it
changes. Tests set it false to compare with the static tour forest. The view's
`stats.tourForest` reports the layer's bytes, trees, current window, refills,
guard failures and window computes. Without the layer it reports
`'static: no room or off'`.
