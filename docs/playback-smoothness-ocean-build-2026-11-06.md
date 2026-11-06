# Playback sampling, mountain framing and ocean opening

Starting main: `c10b820ad15caa5eaa198521c76c9e2ea155b33f`.

## Expired-note work

A long held MIDI note kept the prefix-end value high. Every pressure/source
query consequently walked thousands of earlier notes that had already ended.
The pressure sampler repeats those queries, and history construction repeated
the same scan over the song.

The fix retains the short descending scan and creates an interval maximum tree
only when note ends are out of order. An expired gap can jump to the preceding
live interval. Original accumulation order, weights and prefix guards remain;
conservative search bounds preserve fractional-release rounding too.

CPU benchmark: three rounds, a 300-second MIDI fixture with 6,000 short notes,
120 history queries per round and an optional note held across the whole song.
The baseline production modules were verified identical to starting main.

| Operation | Before | After |
| --- | ---: | ---: |
| Held-note history construction, median | 1,668.315 ms | 92.377 ms |
| Held-note history query, median | 2.731572 ms | 0.075138 ms |
| Held-note history query, p95 | 4.230967 ms | 0.202178 ms |
| Ordinary-note history query, median | 0.049418 ms | 0.052579 ms |
| Ordinary-note history query, p95 | 0.427019 ms | 0.248737 ms |

All six fixture output checksums match. An independent 1,032-query adversarial
comparison also matches the original full history/source output exactly,
including fractional releases and zero-strength sustained notes. The ordinary
control is roughly unchanged; these measurements establish a large reduction
in the sustained-note pathology, not a universal playback speedup.

The held fixture adds 384 KiB of CPU interval storage per retained generation;
the ordered-end control allocates no tree. This is CPU storage, separate from
the graphics residency ledger. Handoffs may retain both generations.

Reproduce with `node tools/benchmark-ridge-sampling.mjs --hold`. Use
`--module-root /path/to/baseline` for a comparison checkout. JSON reports include
source hashes, query settings, runtime identity and full output checksums.

## Bounded GPU work

The hybrid terrain-edge probe now returns zero immediately when no neighboring
cell has a competing surface. In that case the original result was already
zero. The scalar execution of the actual shader body measures **52 → 36 texture
samples** per ordinary interior cell and skips the sixteen subpixel neighbor
searches. Edge-mask bytes remain identical across 1,440 test cells. This is a
shader operation count, not measured GPU time or presented FPS.

At exactly zero mountain rise the terrain fragment shader returns the shared
ocean color before surface/material/reflection work. Diagnostic and water-only
paths retain their normal behavior. The opening also omits unused lake mirrors,
water overlays and source shoreline traces.

## Growing-range framing and ocean

The camera opening is driven by the same heard-time `rise01` that raises the
mountains. Ordinary rails pull back and crane above the area, within finite
distance limits, using an existing visible source summit when available. A
framing guard keeps a nearby summit in view during the approach. Generated
static-view shots follow their current action target during the same overview.
The overview settles by 70% growth; the complete
range returns the exact authored camera pose. Seeking reconstructs the same
result without a draw-dependent follow timer or random camera changes.

Actual flattened terrain and the existing analytic horizon plane share a
featureless shallow-water display color at zero rise. Materials return smoothly
over the first quarter of mountain growth. Forests, ink and coastline traces
follow that material handoff, while the construction cast continues updating.
The existing infinite plane supplies the horizon; no ocean texture, extra
terrain target or ocean render pass is introduced. This is an artistic opening
surface, not a new geographic water classification.

Large mapped tours that stream terrain windows retain their original admitted
camera/lens and vertical growth tracking. Wider mapped-tour cameras were tested
and rejected because previously admitted windows exceeded the mobile/desktop
triangle caps. This limitation is explicit: the broad opening applies to rails
and generated static-view shots, including a rail fallback, while streamed
tours preserve their existing coverage and cost. No triangle/error cap is raised.

## Shoreline reconstruction and composition

Mixed source-water cells now use a clamped cubic contour. Uniform wet/dry
cells retain the four-sample fast path; mixed cells use sixteen samples.
Source wet/dry posts, straight-bank positions, thin channels and dry islands
are preserved. A synthetic 20 m right-angle coast changes its diagonal corner
by 0.75039 m. Contours remain world-anchored as the camera moves.

CPU counts over shipped source texture domains found mixed cells in 0.18% of
Ross Lake, 0.41% of Jackson Lake and 0.10% of Crater Lake. These are texture-domain
counts; a close shoreline can occupy a larger share of the screen, and the
counts do not establish GPU cost.

The optional Direct terrain path now admits its existing physical water layer
before deferring native water appearance. That layer owns its shoreline, so
the duplicate native water render and nearest-scaled clipping mask are omitted
when admission succeeds. Budget refusal, arrival fades and render failure keep
native water available. The mirror temporarily restores ordinary wet shading
and restores the main-view flag even on errors.

Regular hybrid composition retains its refined shoreline restoration and
translucent-effect occlusion. The default single-stage renderer keeps its
existing path; a deliberately coarse native raster still limits physical edge
detail. This work does not add a second full-resolution terrain stage merely
to hide that limit.

## Validation and limits

Camera geometry checks covered 5,313 poses across 23 shipped rail views,
including fourteen with a source summit. All sampled focus points stayed in
frame (maximum absolute NDC x/y: 0.7867 / 0.6934); no sampled camera clearance
was negative. Maximum eye-to-target distance was 64.512 km. The independent
near-summit counterexample stays visible across 1,001 growth values after the
framing guard, and full-growth pose identity is preserved.

Production-protected Teton windows have identical before/after admission and
triangle counts: mobile windows 0/8 are 814,128 / 874,140 triangles; desktop
windows 0/8 are 1,046,784 / 1,057,242. Window 4 retains its baseline cap rejection.
No mapped-tour camera expansion or geometry-budget change is shipped.

**572 focused integration tests pass**, covering note sampling, growth/seek
framing, ocean endpoints,
mirror restoration, Direct water admission/fallback, hybrid effect occlusion,
crest output/color/readback, scene transitions and renderer composition.
Lint, the 519-module source graph and site staging pass. Evidence logs remain
under `.smoke/playback-smoothness/`; large captures are not added to Git.

## Existing artifacts and remaining review

The earlier transition audit already recorded staggered vertical seams and
mixed foreground edges at `327f960`, before the output-edge correction. This
change does not alter `TravelSeam.js` or remove those geometric boundaries.
The existing fine-target release before incoming-view admission remains intact;
fine ridge ink is still suppressed during two-view travel. See
[the transition audit](ridge-transition-audit-2026-11-06.md).

The Sierra inferred-ground horizon predates this change: temporary ground fills
areas omitted by cropped source packages. Its opening now shares the ocean
appearance, but the inferred support heights and final eight-percent retirement
remain. Wider static-view openings may expose more support; smooth intermediate
geology has not been established. See [landscape rise](landscape-rise.md).

Historical Whitney/Sneffels opening stalls (about 217 / 283 ms) and the separate
231 ms hybrid pacing stall remain unresolved observations. The held-note CPU
benchmark does not establish their cause or removal. See
[the expansion evidence](scenic-expansion-sierra-san-juan-2026-11-06.md) and
[the output-edge measurements](ridge-output-edge-2026-11-06.md).

The RTX workstation was offline and this executor has no hardware GPU device.
Actual WebGL compilation, matched rendered motion, delivered FPS and physical
JOYING JY-UTS18N12 thermal/playback performance remain unmeasured. The CPU and
geometry evidence above supports the stated reductions and behavior contracts;
it does not establish a head-unit frame rate.
