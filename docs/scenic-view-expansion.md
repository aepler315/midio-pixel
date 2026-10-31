# Expanding scenic views from 13 toward 30

This document records a dated proposal and its follow-ups. Its sequence, holds,
preservation lists and budgets are historical planning context, not standing
limits on task-authorized experiments. The
[experimental development policy](experimental-development.md) permits further
camera, terrain, catalog, feature and budget changes with proportional validation
and explicit reporting of runtime eligibility and remaining evidence gaps.

**Proposal dated 2026-10-22**, based on main
`05725b8b753f18234ab9f3aa21b7c5c6cc4d12ac`.
This remains an initial geographic expansion direction. The [implementation
follow-up](camera-scouting-fixes-2026-10-22.md) removes the inherited global 60 MB
hard gate and adds stratified discovery, separate tour approval and review
identity checks. Those source changes merged through
[PR #29](https://github.com/aepler315/midio-pixel/pull/29); deployment was not
verified. That implementation added no
locations, assets or approvals. Read the historical [camera scouting audit](camera-scouting-audit-2026-10-22.md)
and [current tour status](scenic-tours.md#current-delivery-and-reported-builds) first.

**Execution follow-up:** the [first sourced wave](scenic-expansion-wave1-2026-10-22.md)
now adds Redfish Lake (CONIFER), Stony Man (BROADLEAF) and the Superstition west
front (DESERT) as candidates. Their source acquisition and fallback rails are
concrete assets; all three still need the recorded promotion gates. Catalog v20
contains 20 entries: 13 approved rails and seven candidates. The
[rebuild and app review](scenic-rebuild-review-2026-10-22.md) tracks fresh shot
discovery and actual camera motion. These are the first three proposals within
the five-location 13 → 18 batch, with two locations still to scout after this
wave's failures and distinctness are understood.

**Historical 2026-10-23 quality hold:** the [Panamint and Teton repair](scenic-transfer-endings-review-2026-10-23.md)
took priority over those two additional locations in that review. A smaller
transfer total
does not establish a better tour: the first Panamint rebuild was rejected after
actual-app review exposed a prolonged close-slope opening. Keep first payoff,
intermediate scenery, climax, closing shot and unused return connections in the
review gate. Report total delivery bytes separately from regional terrain fit,
forest placement and simultaneous resident-view costs. The global 60 MB gate
remains removed; the original regional constraints were retained in that revision
and may be revised intentionally in later work.

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
That policy is the implementation baseline, open to further experiments.
Geographic catalog expansion and the number of different views shown within one
song are separate product decisions.

## Recommended sequence

The proposal used **13 → 18 → 24 → 30 approved views** as planning milestones,
with review waves of two or three inside each batch. These are proposed milestones, not current
acceptance. Retaining all four existing candidates would make the total runtime
catalog 22, 28 and 34 entries at those milestones, before additional candidates.

1. **Develop the expansion contract alongside asset work.** The recorded source
   fixes retire the global asset-size hard gate, retain byte reporting, separate base
   and tour approvals, preserve valid approved rails during candidate-library
   work, and stratify discovery within its existing budget. Validate fresh
   builds and retain reviews keyed to exact source and package/library
   identities. The pinned main baseline has 17 entries with 13 approved rails;
   the current expansion branch has 20 entries and the same 13 approved rails.
   The three new geographic entries are candidates. Update the approved count
   only when their base reviews are accepted.
2. **13 → 18: prove the workflow on five distinct gaps.** Prioritize currently
   singleton biomes, with contrasting relief, camera orientation and source
   conditions. Include both a compact route suited to short visible windows and
   a broad scenic corridor. Early reviews can inform later scouting without
   preventing parallel authoring or implementation.
3. **18 → 24: improve the weakest coverage.** Aim first for two credible geographic
   choices in every biome. Nine biomes currently have one approved view; ICEFIELD
   and CANYON have two. Filling those singleton gaps would reach 22; use the next
   two slots where the measured composition/character gaps remain greatest.
4. **24 → 30: fill demonstrated variety gaps.** Use comparisons of selection
   frequency, near copies, performance and review effort across the earlier
   batches to guide further additions. Extra slots should earn their place through
   different geography and composition, not make every biome's count equal.

When choosing real locations, check elevation-source coverage, attribution,
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
Subject `weight` now reaches candidate `subjectWeight` and affects selection:
finite positive values are clamped to 0.25–4, with other values defaulting to 1.
Render, clearance and coverage quality gates retain their independent checks.
`avoid[]` remains unsupported.

The current generator stratifies the existing per-subject budget over move,
azimuth, distance, elevation and direction, including generated preferred angles
before filling angular gaps. The default forward cap remains 48 candidates per
subject. Verify the resulting funnel on fresh builds; `--reselect` cannot recover
cameras or weights absent from an old graph cache. Lens variety and a measured
regional render budget remain useful review dimensions. The old rail side can
be a baseline without dominating which alternatives reach scoring.

The horizon-as-sky allowance is a rendering policy, not proof of distant terrain.
Check it again for new landforms, wide lenses and reflection poses. Match cell
resolution to the projected subject: a close view of a coarse source is not made
detailed by a higher score.

## Delivery budget

**Decision implemented in source: retire the inherited 60 MB ceiling.** The
Teton builder reports delivery bytes; scenic fitting reports
`budget.deliveryBytes` while retaining its per-region byte, triangle and forest
caps. `assetBudgetErrors(root)` has no default limit and accepts an explicit
finite nonnegative caller limit when needed. No new unexplained global ceiling
replaces 60 MB. These changes retain existing features and do not approve asset
growth or new locations by themselves. Per-region byte caps still deserve an
intentional review as authoring trade-offs rather than proxies for GPU safety.

Keep reporting real asset, download and storage costs. Do not replace 60 MB with
another unexplained ceiling. Measure regression against the delivered feature
set, and keep decoded CPU memory, graphics residency, startup work and frame
pacing as separate constraints.

The audited source provides a useful size baseline:

| Quantity | Bytes | Interpretation |
| --- | ---: | --- |
| Audited Range asset tree, 79 files | 48,905,726 | Historical 2026-10-22 baseline; includes candidates and the retained Teton highway feature |
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

Verification covers the removed default limit and explicit caller limits;
results are recorded in the PR. Invalid paths, corrupt assets, missing files,
unsupported schemas and runtime residency failures retain their own checks.
Per-view byte reports keep growth visible. The first sourced wave below
records actual candidate assets; the earlier implementation follow-up changed
source only. Actual staging costs for a full 30-location catalog remain to be
measured.

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

## First-wave inventory and remaining gaps

The three new terrain/build triples total **3,813,190 bytes**. The primary
expansion branch's logical Range v2 tree grows from 48,905,726 to
52,718,916 bytes, with 88 files. Source and normalization caches are separate
build-storage costs. These totals do not measure browser memory, transfer
compression or physical-device performance, and the final rebuilt-library
review bundle has its own inventory.

The 20 runtime entries include two coherent aliases sharing their original
terrain and two earlier pilots. They are not 20 approved geographic choices.
Accepting the new three would bring the approved geographic count to 16,
still 14 short of 30. Their six new/new directed seams join 78 new/existing
directions: a full 16-view matrix has 240 potential directed pairs, 84 more
than the 13-view baseline. Numeric coverage and failed values are recorded
in the [wave report](scenic-expansion-wave1-2026-10-22.md).

Nine approved biome pools currently have one geographic view. The new three
address CONIFER, BROADLEAF and DESERT; even if accepted, six singleton pools
remain. The next two proposals in the five-location milestone should target
remaining gaps, beginning with research for contrasting RAINFOREST and STEPPE
landforms. This is a composition/source criterion, not approval of unresearched
place names. Prefer a compact cluster with useful payoffs inside short visible
windows, retain alternative sides and lenses, and compare against the existing
location before adding another entry.

The page-retained library Map, separate camera footprints and worker-returned
planning tables need a measured successive-song audit. Their reservation
formula is an accounting estimate, not a JS heap measurement. This is a
code-supported reason to measure retention across a larger catalog; this run
has not observed or established a device memory failure.

The current app review adds two checks to carry into later waves. First,
track configured named subjects through usable discovery shots, the safe
connected component, final selection and actual playback. Denali has 15 usable
named shots and two in its safe component, but none selected or played in the
reviewed song. Teton retains three Grand Teton shots while that song plays a
Mount Moran shot. These are assigned-shot observations, not claims that a
mountain is absent from other frames. They flag editorial/selection tradeoffs
without inventing a mandatory named-shot quota.

Second, inspect the payoff and midpoint of every actually played shot,
including repeated move families, along with every played link's entry,
interior and arrival or explicit song cutoff. Initial reviewed plans contain
43–75-second links even though the builder's fastest-feasible-duration gate
passes. The song planner's selected comfort pace and the resulting visible
transit need their own review. Library diversity alone does not establish
variety in a particular song's edit.

Catalog size and per-song planning complexity are separate measurements:
planning uses the chosen library's shot/link graph, while successive locations
can increase retained page data. Preserve source/config/algorithm provenance
for cache reuse. A new eligibility check applied to a retained Pareto front
cannot recover variants discarded before that front was cached; distinguish
that reselection from fresh variant generation when interpreting comparisons.

## Evidence for each wave

Use the following checklist to assess and report a wave. Partial builds and
incomplete evidence can be reviewed and iterated; identify the missing checks
rather than treating this whole checklist as a prerequisite for development:

- Every location is sourced; normalized data, camera, materials and optional
  water/ice identities are recorded. Source drift and its resolution are explicit.
  The recorded Tombstone source drift left that build rail only; further work
  can investigate a revised source, package or approval path.
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

The first sourced wave is now the three candidates linked above. Fresh builds,
exact review identities, rendered rail comparisons and visible-window pacing
evidence can refine the remaining catalog while work continues on the other 14
needed for 30 approved geographic views. That remaining count assumes all three
candidates are eventually accepted. Tombstone source drift and whole-song
aesthetic acceptance are separate findings to track, not standing blocks on
further expansion experiments.
