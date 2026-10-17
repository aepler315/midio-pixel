# Teton Song Highway validation

Implementation branch: `teton-song-highway-resume`. Enable The Range's
**Camera tour: Tetons** Display preference, or open `?rangeTour=tetons`.
`?rangeTour=off` overrides the saved preference. The authored Teton catalog
entry remains a **candidate**: these checks do not approve the station roles
or establish physical-device performance.

The access and narrative-star restoration is documented in [Range tour and stars](range-tour-stars-restoration.md). Its local checks do not supersede the candidate limits below.

## Reproduce

```sh
npm ci --cache /workspace/.npm-cache
npm test
npm run lint
npm run stage:site
npm run dev
# In a second terminal, with a working Chromium installation:
PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium node tools/teton-tour-smoke.mjs
node tools/teton-tour-runtime-check.mjs
```

The runtime diagnostic exits unsuccessfully if any declared metric gate
fails, including the 60 ms planner target. The browser harness records its
source-content hash; its commit records the starting checkpoint because
runtime changes were not yet committed while evidence was generated.

## Real source and assets

The 48 × 76 km NAD83 transverse-Mercator grid contains 2,401 × 3,801
samples at 20 m spacing. Four USGS 3DEP source rasters and the GeoNames
US dump supply elevations and names; provenance, attribution and SHA-256
identities are in the source reports, published manifests and `NOTICE`.
All ten named summit checks differ from published heights by less than
25 m. The West Horn name match retains the recorded GeoNames/DEM height
discrepancy instead of inventing a replacement elevation.

The review table has 44 primaries (four for each of eleven roles) and 77
curated backups. Grand Teton is a drop primary. The connected, undirected
highway has 154 nodes, 256 roads and five orbits; measured minimum road
radius is 405.47 m, minimum corridor band 414.1 m, and candidate-graph
spanner stretch 1.33912. Directional turns impose additional restrictions:
undirected connectivity does not imply every station is reachable from
any incoming road.

The field contains 4,885 samples and 23,451 height tiers. Published gzip
payloads are 12.45 MiB terrain and 3.76 MiB tour; the complete Range asset
directory is 46.64 MiB. The tour manifest also carries cached, validated
junction geometry. Full measured point properties remain in
`data/terrain/teton-tour-points.json`; portable runtime metadata omits them.

## Verification

The final whole suite passed **3,840 tests, zero failures or skips**. Lint and site staging passed. Five-song browser evidence is recorded separately below.

## Runtime evidence

`docs/evidence/teton-tour/runtime-metrics.json` measures a six-minute,
thirteen-role fixture against the published tour and decoded terrain at
100 ms intervals. Optical flow uses actual terrain height, not clearance
height as a substitute for ground. The latest recorded measurements are:

| Check | Measurement | Result |
| --- | --- | --- |
| Cold planner | 79.81 ms; target ≤60 ms | Target unmet |
| Joint height/aim solve, worker | 6.70 s | Recorded, no device claim |
| Mean field-quality ratio | 0.81718; target ≥0.8 | Pass |
| Optical speed within 0.03–0.3 rad/s | 100%; target ≥98% | Pass |
| Maximum climb | 30 m/s | Pass |
| Maximum yaw | 22.48 degrees/s | Pass |
| Longitudinal acceleration | 11.81 m/s² | Pass |
| Minimum clearance margin | 125.08 m | Pass |

This fixture proposes thirteen visits, all marked **passed at range** after
travel, acceleration, height and aim feasibility. Passing these metric
gates does not mean the camera reaches every proposed hero station. The
exact stored station views are separately available in the review page
and primary contact sheet. Planning is deterministic and stays on the
joined highway; it may substitute backups or pass an unreachable visit
rather than cut the camera.

The browser harness covers five generated WAVs: 120 BPM / 96 seconds,
80 / 150, 150 / 120, 174 / 100 and 100 / 180. It captures every proposed
hero time and the longest-section midpoint, checks active terrain,
finite poses, conservative clearance, shader/page errors, and identical
settled pause pixels. Its report also checks that switching off restores
the original geography inputs and switching on rebuilds the CONIFER
chapter schedule. All **57 captures** passed those browser checks; the source-content hash
matches committed implementation `c75c64b`. The report and PNGs are in
`docs/evidence/teton-tour/`. The browser harness records quality without
asserting its target. Three fixtures remain below 0.8:

| BPM / duration | Mean field-quality ratio |
| --- | --- |
| 120 / 96 s | 0.9300 |
| 80 / 150 s | 0.6692 — target unmet |
| 150 / 120 s | 0.7865 — target unmet |
| 174 / 100 s | 0.7169 — target unmet |
| 100 / 180 s | 0.9851 |

The six-minute quality pass therefore does not establish quality acceptance
across the five browser songs.

Review `/src/dev/teton-tour-review.html` locally for the highway/role map,
example route and 44 neutral station views. `map.png` and `primaries.jpg`
are review artifacts, not aesthetic approval.

## Fresh review and limits

A fresh whole-branch review found five Important issues; one fix pass
addressed each:

1. Slowdown now scales elapsed time after the committed boundary and
   blends from its existing velocity. Committed keyframes remain identical.
2. Orbit reachability checks the arrival-to-orbit turn and repeating lap,
   and filler uses that legal arrival. Truncated moving routes are rejected.
3. A zero-length opening anchor no longer forces a long stationary span.
4. Terrain replacement owns a generation-specific residency key, preserves
   the active window until swap, and rejects stale jobs before allocation.
5. The Display toggle rebuilds the simulation's geography and chapter plan
   while preserving the audio clock, seed and pause state.

Published-data regression tests cover long single sections, moving
openings, orbit coverage, committed-prefix motion, replacement ownership
and stale jobs. The reviewer made no claim about physical GPUs or phones.
The review's Minor readability finding (dense runtime modules) is deferred.

Remaining limitations:

- Three of five browser songs fall below the 0.8 field-quality target;
  further route/aim tuning remains necessary.
- Cold planning exceeds 60 ms in the recorded run. The metric checker
  reports this failure; it is not waived by worker execution.
- Some windows relax the requested 1 px desktop / 2 px mobile error to
  2, 4 or 8 px to meet triangle caps. Effective error and the reason appear
  in scene diagnostics. The strict pixel gate is unmet in those windows.
- Desktop material normals sample 40 m and mobile normals 80 m; terrain
  geometry remains 20 m near roads. This preserves residency headroom.
- Hardware frame time, actual phone memory behavior and nonisolated
  deployment performance are unverified. SharedArrayBuffer is used when
  available; accounted clone fallback exists otherwise.
- Primary-role aesthetic approval is pending human review. DEM-derived
  flat-water candidates are not surveyed lake polygons.

## Implementation rulings

Each item states the choice, its basis and its cost. Historical rulings
that were superseded are identified explicitly.

1. Reject residual no-data and incomplete stride errors: finite package
   contracts require it; incomplete coverage must be repaired offline.
2. Use the managed isolated checkout: it already isolates the task;
   no separate worktree or independent cleanup boundary was created.
3. Use Gaussian role-distance bumps and constrained backtracking: the
   plan supplies initial formulas plus binding spread rules; aesthetic
   ranking may need retuning.
4. Require positive primary suitability: preserve role meaning; scarce
   pools reject instead of silently filling with unrelated points.
5. Infer drop before assigning form choruses, using ordinary choruses as
   comparison: required EDM and form fixtures agree; repeated bass-heavy
   cuts can become drops without a separate ordinary chorus.
6. Require rising energy or a short link for repeated pre-chorus labels:
   literal predecessor matching mislabeled verses; long flat builds may
   remain verses without lyrics or authored cues.
7. Build independent algorithms during the earlier source-access block:
   their contracts were specified; real-data adjustments were still needed.
8. Cap tour trees at 35 m: clearance assumes that bound; tour trees are
   shorter than ordinary Range trees.
9. Expand maximum-filter footprints and use corner max/min reconstruction:
   preserve narrow-feature safety between cells; floors are conservative.
10. Enforce drop/chorus ring and height-offset constraints: these are binding
    station acceptance rules; some promising viewpoints are rejected.
11. Measure spanner stretch against the safe candidate graph: blocked
    terrain prevents a Euclidean guarantee; straight-line stretch can exceed
    1.35.
12. Raise Teton-only name-height tolerance to 100 m, retaining discrepancy
    audits: West Horn's source name/elevation disagrees with the DEM;
    nearby mistaken name matches remain possible. Default tolerance is 60 m.
13. Veto unsafe point/role pairs and rerun roles: clearance is binding;
    safe replacements may have weaker role scores. Grand Teton failure
    remains fatal.
14. Split unsafe station-centroid merges and honor the existing 1,000 m
    boundary margin: preserve validated station heights and turns; some
    nearby nodes remain distinct.
15. Supersede uniform backup caps of four/eight with the curated 77-point
    allowlist, keeping the cap of fourteen: uniform caps disconnected
    relay paths; fewer alternatives remain than the initial 136 backups.
16. Sample roads longer than 3 km at 150 m and pack subject IDs at 10 degrees:
    meet the 4 MB gzip payload budget; fallback field sampling is coarser.
    Exact station hero aims retain their independent precision.
17. Use continuous height targets and a bounded beam of 60 states: discrete
    tier jumps cannot obey 7.5 m per 250 ms climb; the search is approximate
    rather than exhaustive Viterbi.
18. Interpolate eyes linearly and directions with slerp: prevent cubic
    clearance overshoot; eye velocity has piecewise-linear keyframe detail.
19. Fit curved-road junctions with validated Hermite fillets: ideal circles
    mismatched real road endpoints; invalid turns reduce reachability.
20. Preserve incoming orientation, require actual orbit entry and repeating
    laps, and defer infeasible visits: directional roads need legal filler;
    exact hero coverage is reduced.
21. Use a global acceleration envelope with 11.8 / 5.9 m/s² Float32 headroom:
    local segment profiles jumped at anchors; timing can miss hero stations.
22. Interpolate 250 ms envelope bounds and neighboring road field samples:
    rounded bounds emptied feasible beams and nearest samples snapped;
    reported quality uses interpolated fields rather than new ray casts.
23. Project celestial state before freezing the frame and retain offscreen
    physical direction: frozen mutation failed and screen coordinates do
    not describe world-fixed light; tour replaces screen-authored positions.
24. Relax pixel error up to 8 px when triangle caps require it: a real opening
    otherwise exceeded 1.5 million triangles; the strict pixel target is unmet.
25. Build material surfaces at 40 / 80 m: full-resolution scratch exceeded
    residency headroom; material normals are coarser than geometry.
26. Strip authoring properties and cache validated junctions in the hashed
    manifest: reduce metadata and runtime fitting; algorithm changes require
    repacking, and the full point audit stays in authoring data.
27. Tune view-quality weight from the initial 6 to 100 and cap cruise at
    60 m/s, retaining 0.6 s aim smoothing: the real fixture otherwise failed
    joint quality/optical gates; musical altitude has less influence and
    fewer exact deadlines are feasible. The old weight-6 result is superseded.
28. Constrain optical height from conservative clearance and current speed,
    then measure acceptance against actual terrain: clearance alone is not
    ground height; this heuristic is verified on fixtures, not every song.
29. Scale refinement time from its frozen boundary with a velocity blend:
    absolute-time division froze the remainder; a slowed replan may miss
    later deadlines. If no safe continuation exists, retain the old timeline.
30. Give each window generation separate ownership and reject stale jobs:
    active-key reuse failed; replacement temporarily needs both windows.
31. Rebuild chapters on mode changes with audio retained: biome-array edits
    left old assignments behind; switching modes reconstructs simulation state.
32. Prune impossible approach paths and dominated transition costs before
    Dijkstra: nonnegative remaining costs make the pruning valid; timing
    is still measured cold rather than claimed from warm caches.

33. Retain planner/pixel failures as explicit candidate limits: the checks
    establish gaps rather than acceptance; further performance/detail work
    is required before approval.
34. Limit corner evidence to sampled routes: no reviewer validated every
    directional join; other routes may reject turns or need corrections.
35. Keep field-quality measurements separate from aesthetic approval:
    scores do not establish rendered beauty; all 44 views need human review.
36. Treat browser captures as software-renderer evidence: physical devices
    were not tested; GPU and phone behavior may differ.
37. Require real moving-route tests as well as finite synthetic poses:
    finiteness concealed stops; other song combinations may need coverage.

The mode-switch fix also prevents reuse of a cancelled residency generation. Unreachable section proposals remain visible as passed-at-range entries rather than disappearing from the timeline metadata.

## Delivery

The implementation branch is pushed to `origin/teton-song-highway-resume`.
Draft PR creation returned `Forbidden` from `https://api.github.com/graphql`;
`gh auth status` also reported an invalid token. The prepared description
was saved in `docs/teton-tour-pr-description.md` (removed; see [removed docs](removed-docs.md)). No merge or deployment was performed.
