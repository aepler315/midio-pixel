# Expanding scenic views from 13 toward 30

**Proposal dated 2026-10-22**, based on main
`05725b8b753f18234ab9f3aa21b7c5c6cc4d12ac`.
This is an initial direction for discussion and later implementation.
The owner has rejected the inherited 60 MB bundle limit as a requirement for
this expansion. Remove that arbitrary hard gate during implementation and retain
existing features. This documentation pass does not change code enforcement,
locations, cameras or approval state. Read the [camera scouting audit](camera-scouting-audit-2026-10-22.md)
and [current tour status](scenic-tours.md#current-delivery-and-reported-builds) first.

## What should grow

Count an approved view as a curated geographic camera corridor with a sourced
terrain package and a reviewed fallback rail. Count alternative shots within that
view separately. The starting point is 13 approved views across 11 biomes, four
additional runtime candidates, and zero committed shot libraries.

The useful target is about 30 **distinct, reviewed geographic views**, with
different silhouettes, internal relief, foreground relationships and musical
character. Thirty similar summit shots would satisfy a count while adding little
variety. Existing `-coherent` pilots reuse their originals' packages; promoting
one would not necessarily add another geographic location.

The runtime already draws among multiple approved views per biome using a
deterministic 15% equal-share / 85% character-weighted lottery, excluding recent
views and regions while alternatives exist (`SceneCatalog.js:113-175`).
Preserve that policy initially. Geographic catalog expansion and the number of
different views shown within one song are separate product decisions.

## Recommended sequence

Use **13 → 18 → 24 → 30 approved views** as planning milestones, with review waves
of two or three inside each batch. These are proposed milestones, not current
acceptance. Retaining all four existing candidates would make the total runtime
catalog 22, 28 and 34 entries at those milestones, before additional candidates.

1. **Establish the expansion contract before adding assets.** Retire the inherited global asset-size hard gate while retaining byte reporting;
   revise the total-18 and approved-13 assertions intentionally; make
   approval state unambiguous; retain a review index keyed to exact source and
   package/library identities. Keep approved rails available during candidate
   tour work. Address the candidate-angle bias before using this generator as
   the standard scouting tool.
2. **13 → 18: prove the workflow on five distinct gaps.** Prioritize currently
   singleton biomes, with contrasting relief, camera orientation and source
   conditions. Include both a compact route suited to short visible windows and
   a broad scenic corridor. Review the first two or three before completing five.
3. **18 → 24: improve the weakest coverage.** Aim first for two credible geographic
   choices in every biome. Nine biomes currently have one approved view; ICEFIELD
   and CANYON have two. Filling those singleton gaps would reach 22; use the next
   two slots where the measured composition/character gaps remain greatest.
4. **24 → 30: fill demonstrated variety gaps.** Add six after comparing selection
   frequency, near copies, performance and review effort across the earlier
   batches. Extra slots should earn their place through different geography and
   composition, not make every biome's count equal.

Choose real locations only after checking elevation-source coverage, attribution,
resolution, extent, water/ice data where relevant and review cost. This proposal
does not assert DEM availability or recommend unresearched place names.
The 83 legacy skyline range modules can supply leads, but they are not 83 baked,
approved camera corridors. Retain rejected locations and reasons as scouting
history; additional count is not a reason to revive a rejected composition.

## A repeatable scouting record

Each proposed location should have one small text record attached to its authoring
entry or linked review document:

| Decision | Required evidence |
| --- | --- |
| Geographic identity | Stable view ID and region ID, biome, place, source attribution and extent; distinguish an additional corridor from a new region |
| Data identity | Source dataset/tile references, acquisition hashes, CRS/vertical datum, normalized grid hash, cell size and any fill, smoothing or despiking |
| Subjects | Named features with coordinate provenance; approximate/snapped positions labeled; actual subject visibility and resolution at the chosen distance |
| Alternative cameras | Comparable azimuth, distance, height and lens samples; explain the selected side and rejected alternatives |
| Fallback rail | Entry/exit eye and target, height or AGL, FOV and arcs; clearance, skyline exposure, reflection and seam checks |
| Shot neighborhood | Compact cluster versus broad circuit, shot/link lengths, connected alternatives, visible payoff opportunities and transit quality |
| Costs | Combined on-disk bytes, terrain triangles and surface textures, forest reservation, library decoded bytes and two-view seam residency |
| Review | Source and asset hashes, exact shots reviewed, song and timestamps, verdicts, unresolved limitations and durable evidence links |

Use existing `scenic-views.json` fields for data, rail, composition, landmarks and
approval. Use `scenic-tours.json` for supported regional discovery controls.
Do not add speculative unused schema fields merely to match this table.
Authoring metadata such as `weight` or `avoid` must not be presented as working
selection controls before implementation.

Prefer a bounded, stratified camera search over move, azimuth, distance, elevation
and lens. Keep a fixed total render budget per region and expose the number kept
from each category in the funnel. Raising the global candidate cap is a useful
comparison experiment, but expensive as a permanent default. The old rail side
can be a baseline without dominating which alternatives reach scoring.

The horizon-as-sky allowance is a rendering policy, not proof of distant terrain.
Check it again for new landforms, wide lenses and reflection poses. Match cell
resolution to the projected subject: a close view of a coarse source is not made
detailed by a higher score.

## Delivery budget

**Decision: retire the inherited 60 MB ceiling.** Do not reduce the geographic
catalog, delete existing features or force inferior camera framing to satisfy it.
The code still contains that hard gate today; removing its blocking paths in the
Teton builder, scenic-tour fitter and budget tests is future implementation work,
not a change made by this documentation pass. Per-region byte caps also deserve
an intentional review as authoring trade-offs rather than proxies for GPU safety.

Keep reporting real asset, download and storage costs. Do not replace 60 MB with
another unexplained ceiling. Measure regression against the delivered feature
set, and keep decoded CPU memory, graphics residency, startup work and frame
pacing as separate constraints.

The audited source provides a useful size baseline:

| Quantity | Bytes | Interpretation |
| --- | ---: | --- |
| Current Range asset tree, 79 files | 48,905,726 | Includes candidates and the retained Teton highway feature |
| Mean approved terrain triple | 1,530,590 | Terrain manifest, compressed payload and build record; shared materials excluded |
| Seventeen similar new terrain packages | about 26,020,037 | Estimate from current mean; unseen geography will differ |
| Projected tree with 30 approved rail views | about 74,925,763 | Planning baseline before new shot libraries, not a new limit |

PR #25's 12 rounded regional additions total about 10,487,808 bytes, including
their terrain growth and shot libraries. That is a reported candidate-build
estimate, not the independently measured combined publication. Adding it to the
rail-growth estimate suggests about **85.4 MB** for those two increments together,
before any libraries for the 17 new views. Measure each real publication rather
than promising that extrapolated total.

Compact terrain manifests, sensible camera footprints, shared biome materials and
reusable packages can improve download and preparation cost. They remain useful
optimizations; they are not prerequisites imposed by the retired 60 MB number.
The proposed compact tile table would affect manifest overhead; an estimated
halving there is not a halving of the entire asset tree. `terrainSourceId`
supports legitimate package reuse for nearby views, but 17 new geographic places
must not be counted as aliases of existing scenery.

Measure current bytes with the existing read-only helper:

```sh
node --input-type=module -e "import {rangeAssetBytes} from './tools/lib/scenic-coverage.mjs'; console.log({bytes:await rangeAssetBytes(process.cwd())});"
```

Today `assetBudgetErrors(root)` and scenic fitting still apply the old global
check; the future removal must cover all call sites and tests. Verify that a
catalog above 60 MB can build and stage while invalid paths, corrupt assets,
missing files, unsupported schemas and runtime residency failures still fail
their own checks. Preserve per-view byte reports so unexpected growth remains
visible without blocking the catalog on an arbitrary total.

## Runtime and offline work

The catalog contains lightweight records; terrain loading is selected-view work.
Do not prepare 30 terrains simultaneously. Preserve bounded two-view transitions,
generation checks and fallback behavior.

Decoded shot libraries, however, are cached for the page as non-evictable
reservations (`RangeShotTours.js:89-109`). More views used across successive
songs can accumulate libraries even though meshes are released. Measure a long
session across the larger catalog, including library tables, forest preparation,
surface textures and both sides of a seam. The configured per-region triangle
caps are not permission to add every region's GPU footprint together.

Approval checks both directed transitions against all already approved views
(`build-range-scene.mjs:277-289`). A full catalog has 156 directed pairs at 13
views and 870 at 30, about 5.6 times as many. Retain full numeric coverage, cache
by camera/package/composition identity, and review rendered seams selected by
measured worst cases and diverse landforms. Any reduction in visual review needs
an explicit rationale; don't silently replace pair coverage with one happy path.

PR #25 reports 10–20 minutes to build a region on 32 cores. At that same throughput,
17 additional regions would imply about 170–340 minutes of serial build time,
before review and rebuilds. This is an external report extrapolated for planning,
not a benchmark on the audit machine. Bound concurrency by DEM/renderer memory
and retain cached normalization, scoring and link graphs with their source/config
identities.

## Acceptance for each wave

A wave is ready for review only when the following are concrete and linked:

- Every location is sourced; normalized data, camera, materials and optional
  water/ice identities are recorded. Source drift is resolved or stays blocked.
  Tombstone remains rail only until that existing gate is separately resolved.
- Rails pass clearance, skyline exposure and both transition directions.
  Compare existing approved rails whenever a rebake changes their package.
- Reviewed cameras cover the intended angle/elevation/lens categories.
  Candidate pruning and reviewer collection show what was omitted or conflicted.
- Actual-renderer station review is followed by continuous in-app shots and
  planned tours with matching audio. Include quiet, rising and peak passages,
  short visible windows, entry/exit/hold, seeking and reflections where present.
- Transit quality and on-screen payoff gaps are reported per song/window.
  Decide whether compact clusters or broad travel serve each view. No universal
  payoff-count target is approved here.
- Combined asset bytes are reported and staging integrity checks pass. Runtime checks include cold
  preparation, two-view seams, repeated songs through different regions,
  pause/seek and failed-library rail fallback on relevant devices.
- Aesthetic acceptance, catalog approval, committed assets, PR merge and
  deployment are reported as separate states. Publishing a candidate must not
  silently remove a biome's only approved fallback.

The next implementation proposal should cover removal of the inherited asset
ceiling, independent tour approval, stratified discovery and one small geographic
pilot wave. It
should use measured pilot results to refine the remaining catalog, rather than
committing all 17 new locations up front.
