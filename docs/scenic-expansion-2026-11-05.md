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
resource admission and camera-comfort checks are unchanged. This policy does
not increase terrain detail, texture sizes, resident-view counts or the quality
ladder, and does not change the sustained-60-FPS governor.

## Current verification

Focused CPU tests cover ordinary regional selection and recency, unchanged
candidate/approval metadata, deterministic pools, strict package identities,
scheduled fallback rails and the separate transition appearance review.

Current RTX 3060 visual, travel and timing results are pending when this source
record is created. Captures and later findings must identify the exact runtime,
song and timestamps before supporting a visual or performance claim.
