# Three additional mountain regions

The 2026-11-05 expansion enables three already-shipped regional experiments in
normal song selection. Their base and shot-tour statuses remain `candidate`,
with no invented approval record. Authoring and the generated catalog carry
`experimental: true`; other candidates remain diagnostic-only. The product may
label these locations **New**.

| View | Biome | Shot / link count | Existing terrain triple bytes |
| --- | --- | ---: | ---: |
| `sawtooth-redfish-north` — Redfish Lake, Sawtooth Range | CONIFER | 6 / 7 | 1,498,609 |
| `shenandoah-stony-man-west` — Stony Man, Blue Ridge | BROADLEAF | 11 / 29 | 1,420,046 |
| `superstition-west-front` — Superstition Mountains | DESERT | 15 / 40 | 2,530,463 |

These are three additional geographic regions, increasing the normal pool from
13 to 16 locations. Each of these biomes gains a second distinct region. Their
terrain, shared biome materials and pinned camera libraries already ship, so
activation adds no new elevation payload or download. Existing per-song
deterministic selection, regional recency and the 15% equal-share lottery remain.

The source acquisition and earlier composition findings are recorded in
[the first expansion wave](scenic-expansion-wave1-2026-10-22.md). All three use
shipped USGS 3DEP terrain at 20 m output spacing. This change does not acquire,
rebake or relabel their elevation data. Package hashes remain in the catalog
and manifests. Candidate shot playback still requires matching terrain,
library and base-view identities; mismatches fall back to the authored rail.
Auto retains its payoff, transit and camera-comfort checks. A new region kept
on its rail uses the ordinary scheduled Landscape pace.

## A narrower appearance restriction

Individual rail views retain the 0.55 minimum far-crest exposure requirement
and the 0.5 minimum far-crest frame width. Mixed-band transitions retain the
frame-width check, but exposure below 0.55 is now reported for visual review
rather than automatically rejecting a complete region. Closer terrain may
briefly cover the far skyline during a valid transition.

The earlier expansion review measured ten such warnings in 84 directed seams,
with a lowest exposure of 0.393. Those are historical measurements, not a claim
about current frames. Terrain integrity, full-height coverage, source pins,
resource admission and camera-comfort checks remain enforced. This policy does
not increase terrain detail, texture sizes, resident-view counts or the quality
ladder, and does not change the sustained-60-FPS governor.

## Current verification

Focused CPU tests cover ordinary regional selection and recency, unchanged
candidate/approval metadata, deterministic pools, strict package identities,
scheduled fallback rails and the separate transition appearance review.

Hardware checks use isolated, muted Chrome 156.0.8078.80 with the actual NVIDIA
RTX 3060 through ANGLE/D3D11, DPR 1.75 and Detailed 640x360. The synthetic
90-second `midio-perf-pilot.wav` fixture has SHA-256
`c0160a5c95669def70cfe43feeca1c06b81117cf01f2b4e43d59f1ef59e02297`.
Each harness verifies served source hashes and records changes during its run.
This is one fixture/device check, not broad song or device coverage.

### Growth and travel

Runtime `409ac56` passed 18 paused checks: all three regions at 0, 14, 42, 70,
89.984 seconds and a rewind to 0. Ground starts flat, reaches the complete
landform, and returns to the exact opening GPU pixels after rewind. GPU depth
reuse on/off captures match, and all GL error probes are zero. Auto chose the
authored rail for all three on this fixture; these captures do not establish
shot-tour motion quality.

At `327f960`, 18 additional controlled full-stage travel captures cover the ring
Sawtooth -> Shenandoah -> Superstition -> Sawtooth, at 42 and 70 seconds with
transition fractions .25/.5/.75. Both views are prepared, and assertions verify
the real band draws and composites. Page-only scheduling overrides are restored
after each capture. No page or GL errors occurred. Six representative frames
were inspected: no obvious ground hole was identified, but the existing
staggered reveal has visible vertical boundaries and mixed foreground edges.
These are controlled paused samples, not a claim of seamless transitions or
natural-schedule motion coverage.

Raw reports and PNGs are retained outside Git under
`work/range-pipeline-evidence/regional-growth-auto-20261105/` and
`work/range-pipeline-evidence/regional-travel-20261105/`.

### Forest cost found during benchmarking

The first Detailed/Auto run at `327f960` exposed a real forest bottleneck.
Shenandoah averaged 26.49 FPS from 25-55 seconds and 27.43 FPS from 55-65
seconds even at the bottom of the effects ladder. Sawtooth reached 60 FPS late
in the sample after shedding effects; Superstition stayed at the full-quality
rung and reached 60 FPS. Those results are retained in
`work/range-pipeline-evidence/regional-detailed-auto-20261105/`.

A matched fixed-quality-0 diagnostic at 40-46 seconds isolated Shenandoah's
instanced forest: normal 22.90 FPS, trees hidden 60.00 FPS, normal repeat 22.86
FPS. Terrain canopy shading, atmosphere and camera stayed unchanged. Hiding
trees is a diagnostic override only. The report is in
`work/range-pipeline-evidence/regional-shen-forest-diagnostic-20261105/`.

Commit `651bdff` addresses that cost by applying the existing conservative
contiguous-span culling to static mesh trees. Draws omit off-screen prefixes and
suffixes while preserving instance order, the visible trees, density, assets,
shaders and GPU instance-buffer bytes. The additional CPU index/cache build
allowance is charged to static, window and compiled ownership paths; disposal
restores pending attribute swaps after an interrupted render.

With the culling change, the same fixed-quality-0 Shenandoah passage measured
59.16 FPS in both normal runs (p95 16.74/16.77 ms), with the trees-off control
still 60 FPS. At 42 seconds, static mesh instances kept across the sampled
forest passes fell from 129,852 to 33,744. The diagnostic is retained in
`work/range-pipeline-evidence/regional-shen-static-spans-20261105/`.

Under the final source, Shenandoah and existing Teton captures at 42 and 70
seconds have exact matching GPU pixels after settling, including repeated
off/on flips; all four saved stage-PNG pairs are byte-identical. GL errors are
zero and attribute offsets restore. One first-activation frame at Shenandoah
42 seconds differed in 68 GPU pixels by at most one channel value; the next
frame exactly matched the baseline, as did all later flips. The harness retains
this transient rather than hiding it behind a tolerance. Full comparisons are
in `work/range-pipeline-evidence/regional-static-span-settling-20261105/`.

### Final Detailed / Auto timing

The final run at `651bdff` keeps Auto enabled, the default single-stage pipeline
and the normal shot-tour gate. All three views stay at effects quality 0, with
no quality shedding. As in the visual run, Auto selects the authored rails for
this fixture because the proposed tours spend too much time in transit.

| Region | 25-55 s presented FPS | Settled 45-55 s FPS | Continuous 55-65 s FPS |
| --- | ---: | ---: | ---: |
| Sawtooth | 59.53 | 60.00 | 60.00 |
| Shenandoah | 56.43 | 60.00 | 60.00 |
| Superstition | 58.40 | 60.00 | 60.00 |

The longer windows include initial frame-pacing disturbances; this is not a
claim of uninterrupted 60 FPS from the first frame or throughout every song.
Superstition records 33 repeated-frame callbacks in its initial window, none
in the follow-on window. Every view has zero unpresented frames and zero page
errors. Final follow-on p95 frame intervals are approximately 16.74 ms.
Source hashes stayed unchanged. Raw timing and quality transitions are in
`work/range-pipeline-evidence/regional-final-detailed-auto-20261105/`.

The same 18 controlled travel captures were repeated at `651bdff` after the
forest memory changes. Both sides render at quality 0 with no transparent
stage pixels, no page/GL errors and no residency overcommits. Maximum sampled
live residency is 270,947,461 bytes. The final report is in
`work/range-pipeline-evidence/regional-final-travel-20261105/`; the earlier
visual limitations still apply.
