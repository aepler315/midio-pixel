# Teton Song Highway progress

Current implementation: branch `teton-song-highway-resume`; real assets and runtime are implemented. See [current validation, evidence and limitations](teton-tour-validation.md). The dated entries below preserve the earlier blocked-source history and do not describe the current source-access state.

Plan: `docs/superpowers/plans/2026-10-08-teton-song-highway.md` (removed; see [removed docs](removed-docs.md)).

The plan was added to main in `bb098a3`, after this workspace's initial
snapshot. The task checkout has been advanced to that commit. Work is on
the managed checkout's `work` branch.

## Task 0: baseline and reading

- `npm ci --cache /workspace/.npm-cache`: passed (85 packages). The default
  npm cache was outside the writable workspace; the existing workspace cache
  resolves that environment issue without changing repository configuration.
- `npm test`: **3,742 tests passed, 0 failed** (39.38 s).
- `npm run lint`: passed, 0 findings.
- `npm run stage:site`: passed; site staged in `_site/`.

The first test attempt ran with networking disabled. `archiveServe`, `serve`
and `version-history` failed or stalled under those restrictions. After
execution networking was enabled, the complete suite passed. No application
or test code was changed to resolve those failures.

Read the terrain package/baker, camera rail and projection helpers, Range
presentation/frame/scene camera and lighting paths, forest placement, cloud
sea, sky composition, chapter scheduling/refinement, terrain source tooling,
Range v2 progress record and Ridgeview viewpoint scorer. The plan's seven
`cameraPoseAt` call sites still match the checkout. The terrain baker already
computes stride errors, but requires a rail and culls rail-hidden tiles; tour
bakes need an explicit all-tiles path. Forest cover is a derived habitat mask,
not measured land cover, as documented by `ForestCover.js`.

GDAL bindings are available through `/usr/bin/python3` (GDAL 3.10.3), rather
than the default `python3`. The existing `findGdalPython` detects this without
an installation or a runtime dependency.

## Task 1: whole-range terrain (in progress)

The authoring configuration, opt-in all-tiles bake, loader validation, build
entrypoint and ten summit checks are implemented. The default bake retains
its pre-change manifest and payload hashes. Summit reports include published
and GeoNames heights, with attribution in `NOTICE`; the summit scan uses a
200 m circle. No real tour terrain has been baked or shipped yet.

A code review identified three input failures, reproduced by failing tests:
residual DEM holes produced non-finite stride errors, local rasters shared
the remote normalization cache, and imported grids were not checked against
the requested region. All-tiles bakes now require complete source coverage;
the builder validates the finished manifest before writing it. Local caches
are isolated by input type, file path and SHA-256 content. Imported grids
must match the requested dimensions, spacing, origin, centre, NAD83 transverse
Mercator CRS, east/south axes and summit geographic identities.

The focused terrain suite passes **29 tests, 0 failures**, including the
three review regressions and the unchanged default-bake hashes.

After the review fixes, the full `npm test` run passed **3,752 tests, 0
failures** (41.09 s). `npm run lint` and `npm run stage:site` also passed.

USGS and GeoNames source requests currently return HTTP 403 from the cloud
proxy. Execution networking is enabled, but the cloud destination allowlist
still excludes `tnmaccess.nationalmap.gov`, `prd-tnm.s3.amazonaws.com`,
`s3.amazonaws.com` and `download.geonames.org`. The user is enabling those
hosts; source access must be observed before the real-data bake can proceed.
The actual `node tools/build-teton-tour.mjs --stage terrain` attempt also
stopped at the USGS source request with `Tunnel connection failed: 403
Forbidden`. Task 1 remains incomplete: the real four-tile package, summit
acceptance results and asset size have not been produced.

## Tasks 2–3: offline points and roles (in progress)

Source access is still blocked after the continuation request. The active
cloud configuration now reports revision 27, still with an empty custom
allowlist. A retry after the user said "now try" again returned HTTP 403
for USGS and GeoNames.

The independent point and role authoring code is implemented:

- Highest-first 8-neighbour union-find prominence, plateau merging, coverage
  edge truncation and exact distance to the nearest higher cell, capped at
  20 km; retained peaks supply their key cols and parent links.
- Lakes of at least 2 ha, shoreline and cirque measurements, an exact
  Euclidean interior fallback for concave lakes, high-flow canyon breaks,
  low buttes away from the crest, and the plan's measured point properties.
- GeoNames filtering, streamed local/remote dump input, NAD83 projection,
  source hashes, name matching and an audit for unmatched prominent peaks.
- Role suitability formulas, scarce-first assignment, four primaries per
  role with spacing and range-third constraints, and at most fourteen
  spread-out backups per role. The points build prints the primary table.

The point suite passes **17 tests**, including a local GeoNames/GDAL build
fixture. The role suite passes **5 tests**, including 44 unique primaries,
spacing, range spread, named drop/chorus pools, backup caps and determinism.
These are synthetic contracts. The real point files, named-peak acceptance,
and the 44-primary table cannot be produced until Task 1 has source data.
`node tools/build-teton-tour.mjs --stage points` connects these stages.
After this checkpoint the full suite passes **3,774 tests, 0 failures**
(46.16 s), with lint and site staging also passing.

## Task 8: section roles (complete)

The pure runtime classifier maps sections to the eleven tour roles, with
trusted lyric kinds and explicit conductor role cues taking precedence.
Repeated form labels identify choruses; energy, bass share, transition,
duration and rising-energy evidence distinguish drops and linking sections.
Repeated verse labels stay verses unless they supply build or link evidence.
Active `MIDIO` note onsets provide lead density for solo/interlude decisions.
Qualifying silent spans are measured across the song before clipping them to
individual sections, and the last actual chorus carries `finalChorus`.

All **12 classifier tests** pass, including verse/chorus and EDM sequences,
lyric and cue precedence, missing bass evidence, lead-lane selection,
cross-section stops, determinism and input preservation. The full suite
passes **3,786 tests, 0 failures** (42.70 s); lint and site staging pass.

## Tasks 4 and 6: clearance, stations and view scoring (in progress)

The exact-height view scorer is ported to local metres, with curvature and
refraction, skyline ownership, face, fit, openness, drama, water and summit
visibility. It adds the plan's skyline lift, depth layers, relative subject
height and foreground terms. Field authoring evaluates all headings and
height tiers, normalizes over the whole field and packs the heading lanes.
Workers share read-only DEM arrays and preserve sample order; one-worker and
two-worker output matches. The content-addressed cache covers heights,
validity, water, subjects, geometry and scoring settings.

The clearance field uses 60 m cells and Uint16 decimetres. Maximum filters
include the cell footprint so narrow summits cannot disappear between cells;
arbitrary-position queries use the maximum floor and minimum ceiling of the
four corners. Floors include up to 35 m of trees, 10 m slack and 40 m margin.
The existing forest can produce taller trees, so Task 11 must cap tour-mode
tree height at 35 m. This does not change the default forest in this checkpoint.

Station candidates are scored at their exact height and require opposite,
safe 800 m flight directions. Drop and chorus candidates outside the required
300–600 m ring or −120…+80 m height offsets receive zero preference. Authoring
rejects a point with no safe positive-quality pass. `--stage stations` reads
the material rules, updates the review points and saves the clearance cache.

The **12 focused tests** pass: best views over the lake face west; high and
plateau views score lower; higher eyes reveal more ridge layers; clearance is
conservative across a narrow summit; chosen stations are safe; malformed
workers and unsafe stations reject authoring. The full suite passes
**3,798 tests, 0 failures** (41.20 s); lint and site staging pass.

The latest cloud snapshot is revision 28, still restricted with an empty
custom host allowlist. USGS and GeoNames probes still return HTTP 403. No real
stations, road field, timings, budgets or imagery have been produced.

## Task 5: highway graph (synthetic implementation verified)

The authoring graph has a directional 100 m A* search with the plan's floor
gradient, climb and turn costs. Roads use 30 m simplification, centripetal
Catmull-Rom smoothing and 25 m samples. Validation rejects roads with turns
tighter than 400 m, vertical bands below 150 m or positions outside the
1 km boundary margin. The graph retains the south-to-north spine, a minimum
spanning tree and the 1.35 spanner, merges close stations, creates shared
crossing junctions and gives degree-one stations safe turnaround loops.
Orbit orientation accepts both arrival and reverse departure with joins of
at most 120 degrees; runtime circular fillets remain Tasks 9–10.

All **8 highway tests** pass on synthetic terrain. They check connectivity,
spine direction, clearance, radius, station-pair stretch, redundant-road
pruning, deterministic ordering, merging, crossing junctions, orbits and
100 m field sampling with every station included. Spanner stretch is measured
against the safe unpruned candidate graph; it does not bound straight-line
flights across terrain. `--stage highway` and `--stage field` connect authoring
and write real evidence only after the source and summit gates pass.

The full suite passes **3,806 tests, 0 failures, 0 skipped** (44.77 s); lint
and site staging pass. No real Teton highway or field has been generated.
Source access still fails with an empty custom allowlist at revision 30.
The user requested a pause here and a portable handoff for a new environment.
The code checkpoint is `0f5adb2`. See the environment handoff (`docs/teton-tour-handoff.md`, removed; see
[removed docs](removed-docs.md)) for transfer instructions, task status, source setup and resume commands.

## Remaining implementation and real acceptance

Tasks 7 and 9–13 have not started. The real terrain/summit checks, points and roles,
highway, view field, asset budgets, planner and timeline, mode integration,
windowed terrain/forest, visual evidence and the PR remain unverified.

## Resume: actual sources and Task 1 acceptance (2026-10-08)

The supplied archive was checksum-verified and its bundle restored at `73f733d` on `teton-song-highway-resume`. The existing plan remains the implementation brief. Fresh checkpoint validation: **3,806 tests passed**, no skips; lint and site staging passed.

USGS and GeoNames are reachable through the managed proxy in the new instance. Downloaded all four USGS windows and the GeoNames US dump (248 regional features). Normalized **2,401 × 3,801** cells at 20 m, with the specified NAD83 east/up/south frame. All ten published-summit checks passed; maximum absolute difference **17.2 m** (Teewinot). The provisional all-stride-1 bake has **2,280 tiles**, **14.56 MiB gz**. Source hashes and individual checks are recorded in [terrain-provisional.json](evidence/teton-tour/terrain-provisional.json). Final road-distance repacking and total asset budgets remain Task 7.

## Tasks 2–3: real point and role acceptance

Identified **1,208 peaks**, **237 cols**, **389 hydro-flattened lake/flat components**, and **32 canyon breaks**. Assigned **44 primaries** and **137 backups**, with one role per point, all same-role spacing and N–S spread constraints checked on the actual output. Grand Teton is a drop primary; the chorus pool includes Middle Teton and Teewinot. No known prominent GeoNames peak remains unmatched. This is candidate review data, not role approval. The water mask is derived from DEM flatness; components are not independently surveyed lake boundaries.

Tuning: the GeoNames West Horn record (5842614) reports 3,427 m, while a 3DEP summit only 30 m away is 3,514.161 m (48.912 m prominence, 240.832 m isolation). Teton-specific `nameElevationToleranceM` is **100 m**; the general default remains 60 m. Original heights and discrepancies over 60 m are retained in [name-audit.json](evidence/teton-tour/name-audit.json). Cost if this match is wrong: a nearby summit within 250 m and the wider height band could acquire the wrong name. No source coordinates or heights were rewritten.

| Role | Four primary points |
| --- | --- |
| intro | unnamed (43.63344, -110.73500, 1957 m); unnamed (43.66467, -110.71754, 1974 m); unnamed (43.89348, -110.67503, 2055 m); unnamed (43.85735, -110.67079, 2096 m) |
| verse | unnamed (43.53865, -110.61843, 2416 m); unnamed (44.04610, -110.81802, 2685 m); unnamed (44.00558, -110.61503, 2433 m); unnamed (43.99792, -110.56719, 2654 m) |
| pre-chorus | unnamed (43.80364, -110.80018, 3258 m); unnamed (43.71832, -110.80469, 3470 m); unnamed (43.83459, -110.78499, 3577 m); unnamed (43.53460, -110.98935, 2952 m) |
| chorus | Doane Peak; Housetop Mountain; Teewinot Mountain; Middle Teton |
| post-chorus | unnamed (43.77861, -110.78528, 3375 m); unnamed (43.74568, -110.84688, 3351 m); unnamed (43.80436, -110.86554, 3200 m); unnamed (43.61908, -110.94299, 3110 m) |
| bridge | unnamed (43.57789, -110.53287, 3007 m); unnamed (43.82071, -110.92000, 2852 m); unnamed (43.80256, -110.84516, 3195 m); unnamed (43.50426, -111.12553, 2696 m) |
| solo | unnamed (43.83747, -110.77355, 3791 m); unnamed (43.74891, -110.77885, 3569 m); Cloudveil Dome; unnamed (43.87114, -110.79392, 3288 m) |
| interlude | unnamed (43.85368, -110.86035, 2997 m); unnamed (43.58918, -110.95630, 3084 m); unnamed (43.96726, -110.86115, 2974 m); unnamed (43.78330, -110.80988, 3222 m) |
| breakdown | unnamed (43.51704, -110.74634, 1896 m); unnamed (43.49312, -110.80775, 1915 m); Upper Palisades Lake; unnamed (43.87205, -110.74620, 2068 m) |
| drop | Grand Teton; Mount Moran; Mount Woodring; Traverse Peak |
| outro | unnamed (43.86347, -110.66854, 2092 m); unnamed (43.89873, -110.65400, 2089 m); unnamed (43.96035, -110.67615, 2056 m); unnamed (43.82100, -110.67785, 2135 m) |

Highest twenty peaks (DEM elevation / prominence / isolation, metres; * means truncated prominence):

- Grand Teton: 4191.8 / 2427.7* / 20000.0
- peak-4676044: 4054.8 / 37.0 / 145.6
- Mount Owen: 3931.8 / 239.2 / 644.0
- Middle Teton: 3893.0 / 343.0 / 1066.8
- Mount Moran: 3841.7 / 815.1 / 9781.9
- South Teton: 3806.8 / 329.5 / 1208.3
- peak-3396441: 3790.8 / 21.0 / 184.4
- peak-4841703: 3765.5 / 40.0 / 140.0
- peak-4966534: 3759.4 / 53.4 / 291.2
- peak-4748095: 3744.6 / 79.7 / 161.2
- Teewinot Mountain: 3739.8 / 238.5 / 1220.0
- peak-3434797: 3666.3 / 89.5 / 501.6
- East Prong: 3665.3 / 56.3 / 160.0
- Thor Peak: 3660.9 / 125.3 / 696.6
- Cloudveil Dome: 3657.7 / 53.5 / 272.0
- Buck Mountain: 3629.6 / 393.5 / 3060.1
- Nez Perce: 3618.1 / 147.8 / 760.3
- peak-4623303: 3602.4 / 59.9 / 367.7
- peak-3458791: 3591.2 / 49.5 / 240.8
- peak-3336426: 3582.3 / 51.1 / 141.4

## Real station feasibility corrections

The first real station run rejected `col-3432475` (backup post-chorus): its 3,406.31 m col has a 3,603.3 m conservative floor, and none of the +80/+150/+250 m candidates supplies two safe opposite 800 m directions. Role assignment now retries after recording an unusable `(point, role)` pair, retaining the original spacing/spread constraints and four primaries per role. Rejected points remain scenery or may qualify for another role; the build still rejects insufficient pools. Grand Teton may not be silently dropped from the drop pool. Stations use the graph's existing 1 km boundary margin. This changes selection, not clearance or hero-height rules.

Repeated successful station scores are memoized within one build, with fixed terrain, points and material settings. The scorer sorts subjects once and only computes visibility for subjects actually chosen by a heading. On a real Grand Teton eye, all 72 aims and features remained byte-identical and cold scoring improved from **82.9 ms to 36.3 ms**. Focused station/role regressions first failed and then passed **14/14**; fresh full suite **3,810/3,810**, lint passed. Final real station/role tables remain pending the ongoing source build.

Final station and asset candidate

The initial primary table above is superseded by station-feasibility selection. Unsafe assignments were vetoed without reducing clearance, ring, spacing or through-flight constraints. A reviewed allowlist retains 77 backups, including connecting stations, under the original maximum14 per role. Uniform caps4 and8 disconnected the network and were discarded.

| Role | Four primaries | Backups |
| --- | --- | --- |
| intro | -110.65400, 43.89873 (2089 m) · -110.67079, 43.85735 (2096 m) · -110.68808, 43.80661 (2145 m) · -110.74049, 43.66158 (2065 m) | 12 |
| verse | -110.61503, 44.00558 (2433 m) · -110.56719, 43.99792 (2654 m) · -110.81802, 44.04610 (2685 m) · -110.61843, 43.53865 (2416 m) | 10 |
| pre-chorus | -110.78499, 43.83459 (3577 m) · -110.78729, 43.74567 (3501 m) · -110.80018, 43.80364 (3258 m) · -110.98935, 43.53460 (2952 m) | 4 |
| chorus | Doane Peak · Teewinot Mountain · Middle Teton · Housetop Mountain | 7 |
| post-chorus | -110.78528, 43.77861 (3375 m) · -110.86554, 43.80436 (3200 m) · -110.84688, 43.74568 (3351 m) · -110.94299, 43.61908 (3110 m) | 7 |
| bridge | -110.92000, 43.82071 (2852 m) · -110.84516, 43.80256 (3195 m) · -110.53287, 43.57789 (3007 m) · -111.12553, 43.50426 (2696 m) | 7 |
| solo | -110.79392, 43.87114 (3288 m) · -110.77355, 43.83747 (3791 m) · -110.77885, 43.74891 (3569 m) · Cloudveil Dome | 7 |
| interlude | -110.86115, 43.96726 (2974 m) · -110.86035, 43.85368 (2997 m) · -110.80988, 43.78330 (3222 m) · -110.95630, 43.58918 (3084 m) | 6 |
| breakdown | -110.90225, 43.74494 (2174 m) · -110.59185, 43.62825 (2040 m) · -110.71772, 43.50657 (1925 m) · -110.80775, 43.49312 (1915 m) | 7 |
| drop | Traverse Peak · Mount Moran · Mount Woodring · Grand Teton | 6 |
| outro | -110.64568, 43.93237 (2073 m) · -110.64752, 43.90322 (2085 m) · -110.66854, 43.86347 (2092 m) · -110.67785, 43.82100 (2135 m) | 4 |

Final highway: 154 nodes,256 roads,5 orbits,633.7km; one connected component, minimum turn radius405.47m, minimum vertical band414.1m, maximum stretch1.33912. Final field: 4885 samples,23451 tiers,100m spacing (150m on edges longer than3km), subject IDs at10degrees. Exact hero heights and best aims retained separately. Assets remain candidate until visual review. See docs/evidence/teton-tour/asset-budgets.json for measured download sizes.

## Runtime and fresh review, 2026-10-08

Tasks 9–12 are implemented behind the mode preference: oriented planning, worker height/aim timeline, committed-prefix refinement, sky/camera integration and bounded worker terrain windows. One fresh review found five Important defects, all addressed in one fix pass with published-data regression checks. Final five-song browser evidence and full-suite verification are recorded in the validation report. Strict cold-planner and some pixel-error targets remain unmet; candidate role approval and physical-device performance remain pending.
