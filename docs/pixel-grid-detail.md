# Geometry and material work at the pixel grid

Pixel preparation omits the three multisample ownership materials and their
startup compilation. The ordinary terrain depth prepass remains active.
The pixel terrain material skips snow detail when its contribution is zero
or replaced by water, and near rock detail when water replaces its normal.
Projected UV gradients are evaluated before conditional texture samples;
macro heights and scalar snow coverage still participate in water lighting.
Explicit texture gradients can introduce small driver-dependent shading
differences, so image equivalence needs matched rendered evidence.

Tour terrain windows retain their existing geographic coverage, measured
reference plan and graphics caps. Additional simplification uses Classic's
180 or Detailed's 360 native vertical pixels as a conservative upper bound
on focal scale at maximum normal zoom. The quarter-pixel bound includes
pitched and off-axis projection, the mirror camera, the permitted structural
land wave, and interior error combined with snapped coarser tile edges.
Summit and water tiles, the near-root/tour-fade region, and their neighbouring
tiles retain their reference grids. Glacier views retain their existing
geometry. A grid change invalidates plans and worker revisions while retaining
the displayed full forest/terrain until replacement detail is ready, provided
its geographic coverage still contains the actual camera. Diagnostics report
`detail-pending` with the displayed and target heights during this handoff.
Geographic coverage and route changes retain strict revision checks.
Static views retain their authored baked
terrain grids.

This policy may retain all existing terrain detail: a reference plan already
coarsened to fit its triangle budget can leave no additional level within
the native-pixel error bound. Diagnostics distinguish that result from a
successful reduction with `detailHeightPx`, `pixelCoarsenedTiles`,
`pixelTrianglesSaved`, `pixelProtectedTiles` and
`pixelCoarsenedMaxErrorPx`. The latter includes the extra land-motion and
seam bounds; the older `maxErrorPx` remains the source-height metric.

Forest detail uses each existing species/variant batch's largest potentially
visible tree footprint in the actual target. The main view and half-size
lake mirror choose independently. A conservative apparent bound of 32–64
pixels transitions between the existing light and full assets. Placements,
dimensions and IDs remain shared. Complementary deterministic pixel
selection preserves geometric coverage and agreement between colour and
depth; multiplying both meshes' alpha would expose the background.
Each paired batch adds eight retained attribute bytes, at most 144 bytes
per forest, included in its graphics reservation. The quality governor
still caps full-detail use independently.

`snapshot().windows[].forestDetail` records the last main and mirror choices
and their target sizes. Detail selection reconstructs the current camera
and frame without temporal hysteresis, so seeks and fixed-clock exports do
not replay a transition history. Frame, source identity, quality and camera
invariants should accompany any before/after comparison.
