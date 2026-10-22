# First scenic expansion wave

Work started 2026-10-22 with three new geographic **candidates** toward the
[13 → 18 → 24 → 30 direction](scenic-view-expansion.md). The approved geographic
count remains 13. These entries add source acquisition, authored fallback rails
and regional shot-discovery inputs; they do not carry base or tour approvals.

| Candidate | Biome gap | Composition to test | Initial corridor |
| --- | --- | --- | --- |
| `sawtooth-redfish-north` | CONIFER has one approved view | Granite peaks above a compact lake opening; compare with the much broader Teton front so this earns a distinct place | Redfish north shore looking southwest, 32 × 32 km source extent |
| `shenandoah-stony-man-west` | BROADLEAF has one approved view | Blue Ridge escarpment with close rolling ridges; compare compact moves with the Black Mountains' layered range | West of Stony Man looking east-southeast, 36 × 36 km source extent |
| `superstition-west-front` | DESERT has one approved view | Volcanic wall and pillars above Sonoran foothills; a different silhouette from the Panamint basin escarpment | West of the Superstition front looking southeast, 30 × 30 km source extent |

The cameras are proposals to render and revise. The short lateral rails are
about 1–1.2 km long, with 280–450 m endpoint AGL and a 35° vertical field of view.
Endpoint AGL does not establish clearance between endpoints. Regional discovery
uses the corrected stratified camera generator; the western or northern rail
side is a comparison baseline, not a locked scouting azimuth.

## Geographic sources and precision

Named peak locations came from the live [USGS Geographic Names Information
System](https://www.usgs.gov/tools/geographic-names-information-system-gnis),
through its [National Map landforms service](https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer/5).
The queries requested `outSR=4269`. GNIS uses NAD83; its [coordinate
description](https://www.usgs.gov/us-board-on-geographic-names/what-geographic-names-information-system-gnis)
distinguishes a summit point from the approximate center of an areal feature.
The retained decimal places identify the returned point and are not a survey
accuracy claim. The authoring entries do not assert a published elevation where
one was not checked.

| Landmark | GNIS ID | Longitude, latitude (NAD83) |
| --- | ---: | --- |
| Heyburn Mountain | 396651 | -114.976695918, 44.100795363 |
| Grand Mogul | 382498 | -114.959966494, 44.079674938 |
| Stony Man | 1475210 | -78.373278436, 38.598160447 |
| Hawksbill | 1467849 | -78.395003105, 38.555393535 |
| Old Rag Mountain | 1471867 | -78.316034348, 38.551715709 |
| Superstition Peak | 42805 | -111.400674100, 33.411156200 |
| Weavers Needle | 35931 | -111.370406600, 33.433105600 |

The [Recreation.gov North Shore Picnic Area record](https://www.recreation.gov/camping/campgrounds/232076)
places the site beside Redfish Lake and describes its lodgepole pine setting.
Its public campground API returned longitude -114.915795, latitude 44.143686;
this locates the camera vicinity, not the proposed airborne rail. The [Forest
Service Red Fish Lake Moraine record](https://research.fs.usda.gov/rmrs/rnas/locations/red-fish-lake-moraine)
describes the glacial landform and Douglas-fir, lodgepole pine and subalpine fir
communities. Redfish Lake's discovery subject coordinate is an approximate map
position and remains marked `approximate` for feature snapping.

The [National Park Service Stony Man description](https://www.nps.gov/places/000/stony-man.htm)
identifies the Blue Ridge setting and views over the Shenandoah Valley. Its
[geology interpretation](https://www.nps.gov/places/000/stony-man-a-billion-years-in-the-making.htm)
gives an approximate 4,011-foot summit, converted to 1,222.5528 m in authoring.
That converted number retains the stated feet value; it is not centimetre
accuracy. The [Skyland trail map](https://www.nps.gov/shen/planyourvisit/upload/Skyland_RoadTrail.pdf)
provides regional context. Candidate camera positions are authored estimates,
not positions advertised as an NPS overlook or trail.

[Arizona State Parks](https://azstateparks.com/lost-dutchman/explore/the-dutchman)
places Lost Dutchman at the foot of the Superstition Mountains in the Sonoran
Desert. Its [location and map page](https://azstateparks.com/lost-dutchman/explore/maps)
anchors the western camera vicinity; the camera eye/target coordinates and
heights are authored estimates. The named discovery points use GNIS rather than
assuming that a visitor-map label is a measured peak coordinate.

## Terrain acquisition and water policy

All three use the existing `3dep13` normalizer at a **20 m output spacing**.
USGS documents [full CONUS coverage at 1/3 arc-second, about 10 m](https://www.usgs.gov/faqs/what-projection-horizontal-datum-vertical-datum-and-resolution-a-usgs-digital-elevation-model).
Coverage is verified by actual acquisition, not inferred from the product's
national description alone. The normalizer resolves dated USGS publications,
keeps native-window pixel hashes and source URLs, and writes a local transverse
Mercator grid. It averages into 20 m cells; there is no claim of native 20 m
survey resolution. The normalized record supplies the actual CRS and vertical
reference. No Terrarium fill is configured for this wave.

Redfish is a sourced lake; its shoreline geometry and the rendered reflection
still need inspection. Shenandoah and Superstition explicitly set `water: false`.
This avoids depicting a drainage or intermittent wash as a permanent wet
surface. A later water addition needs mapped presence/permanence evidence and
its own review. No glacier or ice surface is asserted for these candidates.

Raw acquisition records, normalized grids, source responses and rendered
evidence stay outside Git under `.terrain-cache/` and
`.smoke/expansion-20261022/`. Runtime terrain packages are deliverable assets,
separate from captured evidence. Each package's build record binds the
normalized source window hashes, camera and compressed payload; the terrain
manifest records its source-grid hash and LOD/error results.

## Build and review record

Initial builds use `buildView` exported by `tools/build-range-scene.mjs` and write
to `.smoke/expansion-20261022/terrain/<view>/`. The reviewed candidate source is
now in `data/terrain/scenic-views.json`, and discovery inputs are in
`data/terrain/scenic-tours.json`. A repeatable current-authoring rail build is:

```sh
MIDIO_GDAL_PYTHON=/usr/bin/python3 node tools/build-range-scene.mjs \
  --view sawtooth-redfish-north \
  --out .smoke/expansion-20261022/terrain/sawtooth-redfish-north
```

Repeat with the other IDs. Do not use `--approve` or `--approve-tour` to make a
capture runnable. Candidate diagnostic forcing is sufficient for app review.
Once exact terrain bytes are staged, regenerate the catalog and build fresh
shot libraries. `--reselect` on an old cache cannot exercise the new scouting.

Technical checks and rendered findings are recorded below as they complete.
No capture result changes candidate status automatically. Before promotion,
retain rail clearance and far-crest exposure at all stations, transitions in
both directions against all approved views, actual-renderer geometry/material
and reflection review, and continuous shots/tours with matching audio and exact
song timestamps. Revisit compact neighborhoods when transit overwhelms a short
visible window. Software WebGL review does not establish physical-device frame
pacing or owner aesthetic acceptance.

## Initial rail results and revision

Actual neutral geometry frames exposed a composition problem in the first
Shenandoah and Superstition rails. Their primary fronts were closer than the
unchanged 7 km far-partition distance and hid the rear far crest. The initial
21-station checks, including the default biome forests, measured minimum
exposure 0.1683 and 0.4187 respectively, below the existing 0.55 requirement.
Their DEM clearance passed; raising the camera was not the first correction.

A focused full-grid probe varied only western stand-off. The revised rails move
approximately 2.5 km farther west for Shenandoah and 4.5 km for Superstition, at
the same endpoint AGL, target and lens. Fresh bakes make the primary fronts part
of the far composition. The existing thresholds and partition distances remain
unchanged. Original frames/packages remain in `.smoke/expansion-20261022/terrain/`,
and the two revised packages are in `terrain-revision1/` below that run directory.
Matched neutral geometry triage is in `baseline-stand-off/` and
`candidate-stand-off/`: one station per view, 320 × 180, same software renderer.
This isolates the initial composition decision; it is not whole-rail or musical
acceptance.

These are the rail packages before any shot-tour coverage rebake:

| Candidate | Terrain triple bytes | Desktop / mobile triangles | Achieved error desktop / mobile | Minimum centerline AGL, 101 samples | Minimum far exposure, 21 stations |
| --- | ---: | ---: | --- | ---: | ---: |
| Redfish north | 1,152,554 | 1,164,416 / 817,922 | 0.959 / 1.957 px | 326.42 m | 0.7552 |
| Stony Man west, revised | 765,349 | 781,440 / 372,630 | 0.959 / 1.961 px | 448.77 m | 0.9714 |
| Superstition west, revised | 1,895,287 | 1,880,480 / 888,878 | 0.996 / 1.997 px | 279.86 m | 0.8073 |

The three triples total **3,813,190 bytes**, before libraries or any later
coverage bake. All three have a far crest across the complete frame at the
sampled stations. These are numeric rail checks, not proof that every point in
the camera volume is clear. Source spacing is 10.307 m as reported by the
normalizer and averaged to 20 m output spacing. No fill was needed. The existing
despiker removed one Superstition sample; the two other grids required none.

| Rail source identity | Normalized height-grid SHA-256 | Terrain-manifest SHA-256 |
| --- | --- | --- |
| Redfish | `cffa2eff0e78427163aa6df9e8ff5fea91816c9051176f965a022d74a16100b8` | `f35bc8812afc805781cca08eca36b3b8ecf0878e2f36cded0cd868731ddfbe7f` |
| Stony Man revised | `73a6bfc49d18471b1de1cd929fb24d0b3332eca6b86d6ac6f9b9abcc2dc663e8` | `b7c6a56b96cd47190402f0bf0ec8aa75fe0e02aab1b1935113bdf9c4be594204` |
| Superstition revised | `9dd9504bf35fe0ae6ed5d0dcaba768cbc19a4726e6bf079549ba4d838b71c174` | `9e708586a94925274bdbc3dc4ecd3c1f05040329af8f27f7c1e7217b529ccc24` |

Redfish reads dated 3DEP tiles `n44w116`, `n44w115`, `n45w116` and `n45w115`;
Stony Man uses `n39w079`; Superstition uses `n34w112`. Exact dated URLs and
native-window hashes are retained in the normalized metadata and terrain
manifests; build records also retain the window hashes. The revised packages use
the same normalized heights as their initial
rails: the source did not change while testing the stand-off.

## Directed seam gate remains open

The initial sweep measured each candidate in both transition directions
against all 13 approved views: 70 of 78 directed pairs passed, eight failed.
The six mutual directions between the three new candidates add four passes
and two failures. The complete incremental sweep is therefore **74 of 84
directed pairs passed, ten failed**, without changing cameras or thresholds.
All measured crest widths were 1.0. The failures are exposure during mixed-band
travel, with the existing 0.55 threshold:

| From → to | Minimum exposure | Rail station / 20 | Seam progress |
| --- | ---: | ---: | ---: |
| Ross Lake → Redfish | 0.40885 | 0 | 0.40 |
| Stony Man → Ross Lake | 0.52604 | 0 | 0.50 |
| Stony Man → Tombstone | 0.50000 | 12 | 0.60 |
| Stony Man → Muncho Lake | 0.54948 | 16 | 0.55 |
| Stony Man → San Gabriel | 0.50000 | 1 | 0.50 |
| Superstition → Ross Lake | 0.54167 | 1 | 0.45 |
| Ross Lake → Superstition | 0.51302 | 0 | 0.40 |
| Superstition → Tombstone | 0.52083 | 16 | 0.60 |
| Stony Man → Redfish | 0.39323 | 0 | 0.55 |
| Superstition → Redfish | 0.46354 | 0 | 0.55 |

The source/package/material/camera identities and all pair results are in
`.smoke/expansion-20261022/candidate-pair-checks.json` and the adjacent
`verification/rebuild-20261022/new-view-mutual-seams.json`. The latter records
all 2,646 mutual-pair composite samples and verifies the same source identities
as the initial sweep. These failures block base
approval. They do not remove any approved fallback or prevent candidate scouting
and in-app diagnostic review. The worst seams need rendered review and a scoped
camera/composition decision before promotion; the threshold has not been relaxed.

## Actual app rail review

All three candidate rails were forced through the real app's upload, analysis,
Range v2 preparation and export clock. Each completed **32 consecutive frames**
from Anthem **12.000 to 15.875 seconds**, at 8 fps, 640 × 360, quality 0, with the
same source recording, seed and settings. The requested clip ends at 16 seconds;
the final saved sample is 15.875 seconds. This is a bounded continuous window,
not uninterrupted playback from song start or live frame-rate measurement.

The verified renderer was Chromium **156.0.8078.4**,
`ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce RTX 3060), OpenGL ES 3.1)`.
All three reports passed their capture controls with no app/browser errors, the
requested candidate active in Range v2, and no shot library attached. The
immutable runtime snapshot digest is
`d1e7337d52dc8904cdb3cd5a8dc108836f79163ac0fa628f590d8719a6749177`.
The recording SHA-256 is
`a691d46ebb2575a1ff5841960a50e39acb41cd085852f0a6b59030354b8fca90`.

The actual rendered frames were inspected at every saved time, with the
following provisional findings. These are rail candidates for continued
scouting, not approved compositions:

| View and song window | Rendered finding | Measured camera evidence | Next review |
| --- | --- | --- | --- |
| Redfish, Anthem 12.000–15.875 s | The lake opening and mountain wall remain readable as the rail advances; the reflection gives foreground separation. No sudden turn or visible terrain break occurs in this window. A high-contrast lower-right reflection patch deserves a later reflection pass. | 98.09 m eye travel; largest 125 ms eye step 3.23 m | Mid/late rail, reflection poses, and closer alternate shots; compare similarity with Teton before promotion |
| Stony Man, Anthem 12.000–15.875 s | The revised stand-off keeps the ridge and overlapping foothill layers visible. Haze makes the low-relief layers quiet; the larger stand-off sacrifices prominence, so closer candidate shots must demonstrate useful variety. | 126.99 m eye travel; largest step 4.17 m | Compare haze/contrast and short-window payoff with the existing Black Mountains view; review the failed outgoing seams |
| Superstition, Anthem 12.000–15.875 s | The volcanic front reads as a separate central silhouette and the move remains restrained. Moving west solved the numeric rail occlusion but reduced the close wall's scale; that trade-off remains an editorial decision. | 140.79 m eye travel; largest step 4.62 m | Review side and closer shots for pillar/front detail, all failed seams, and whether the quiet baseline earns a DESERT slot |

The actual app applies its musical lens after the rail: drawn vertical FOV spans
35.985–40.745° in these matched windows. Camera-distance measurements help check
continuity; they do not establish perceptual smoothness at 60 Hz. A brief overall
brightening around 15.5 seconds occurs across all three captures; its layer has
not been isolated by an ablation and is not attributed to the new cameras.

The audio-backed previews, exact PNGs, copied recording, all-frame contact
sheets and reports are retained in
`.smoke/expansion-20261022/app-rails-hardware156/<view>/`. Each view has
`rail-motion.mp4`, `review-sheet.png`, `all-frames-sheet.png`, `report.json` and
an offline `index.html` player. The recording is playable with the captured
frames. Auditory review was unavailable to the reviewing agent, so musical
coupling and aesthetic approval remain open; no listening judgment is inferred
from audio-energy diagnostics.

The first explicit Chromium 153 hardware attempt could not create the app's
WebGL context and produced no frames. Its failed reports remain under
`app-rails/`; they are not counted as passing captures. The successful retry
used the installed Chromium 156 headless shell and the same frozen source/audio.
Earlier diagnostic contact-sheet attempts also retained their valid raw frames
and failed logs when Python/Pillow helpers were unavailable. Completed matched
geometry reports use the corrected helper environment.

Targeted catalog/discovery/tour verification passed **47 tests, zero skipped**
(`test/sceneCatalog.test.js`, `test/rangeDiscovery.test.js`,
`test/scenicTours.test.mjs`); `git diff --check` passed. The 96 captured PNG hashes
were read back and verified against their reports, and all three staged runtime
terrain triples matched the exact rail bytes used for this review. These checks
do not discharge the ten failed seams, remaining view/tour review, whole-song
coverage or device validation.
