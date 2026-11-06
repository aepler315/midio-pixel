# Crater Lake and western Badlands terrain candidates

These are two new, selectable **experimental candidates**, not visually approved
views. Their terrain is newly baked from dated USGS 3DEP 1/3 arc-second sources
onto a 20 m local grid. Catalog version 57 retains the 13 existing approved
views and adds these to the experimental pool. No existing approval is extended
to the new scenes.

## Geography and authoring

- `crater-lake-watchman-east`: a 32 × 32 km corridor centered at
  122.10° W, 42.94° N. An elevated west-rim rail looks across the caldera toward
  its eastern rim. Camera endpoints are 310 m above their DEM ground samples;
  these are authored aerial positions, not surveyed visitor viewpoints.
  Wizard Island, the Watchman, Llao Rock and Mount Scott use USGS GNIS NAD83
  primary points. No surveyed landmark elevations are claimed. The existing
  dry-conifer material rules supply vegetation; water classification uses the
  source DEM's hydro-flattened cells.
- `badlands-pinnacles-south`: a 30 × 30 km corridor centered at
  102.30° W, 43.80° N. An authored aerial rail near the western Pinnacles looks
  south toward eroded ridges and prairie, 95 m above its endpoint ground
  samples. It uses the existing steppe material pack. No unverified landmark
  points or surveyed geologic color layers are added.

Geographic references: [NPS Watchman overlook](https://www.nps.gov/articles/400006.htm)
and [NPS Pinnacles Overlook](https://www.nps.gov/places/pinnacles-overlook.htm).
Exact source URLs and authoring anchors are in `data/terrain/scenic-views.json`;
source-window SHA-256 hashes, CRS, vertical reference and license are retained
in each shipped terrain manifest and build record.

| View | Dated 3DEP tiles | Gzip bytes | Tiles | Desktop triangles | Mobile triangles | Achieved desktop/mobile error |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Crater Lake | n43w122 20260601; n43w123 20260818; n44w122 20261027; n44w123 20260202 | 624,477 | 251 | 790,504 | 398,548 | 0.999 / 1.998 px |
| Badlands | n44w103 20250910 | 741,580 | 340 | 866,810 | 445,226 | 0.990 / 1.997 px |

These mesh/error numbers are bake diagnostics at the existing reference
projection, not a measured native-output GPU cost or a guarantee of subpixel
error at every new progressive resolution. Both builds retain the existing
mobile LOD policy, memory admission and terrain source provenance.

## Framing correction and coverage

The first Crater Lake rail, 160 m above endpoint ground, failed the existing
21-station far-crest exposure test: the near rim hid the distant band during
the beginning of the rail. The failure was introduced by this candidate's
camera, not by the existing renderer. Raising the rail endpoints to 310 m and
rebaking changes the visible tile set. The skyline requirement remains intact.

The final exposure measurements and regression results are recorded in
[the implementation evidence](progressive-landscape-detail-2026-11-06.md).
Both final packages pass the 21-pose inferred-ground topology/flat-plane
coverage check. Crater Lake uses 10,007 inferred samples; Badlands uses 7,273.
Each view's support admission estimate is 1,009,053 bytes. Inferred support is
not surveyed ground: these checks cannot rule out an unattractive intermediate
horizon, water appearance or a visible seam in the rendered scene.

The previous [transition audit](ridge-transition-audit-2026-11-06.md) still
applies. Historical travel seams, early stalls and the Sierra growth-ground
horizon have not been visually revalidated or declared fixed by this addition.

## Reproduction and outstanding review

```sh
MIDIO_GDAL_PYTHON=/usr/bin/python3 node tools/build-range-scene.mjs --view crater-lake-watchman-east --publish
MIDIO_GDAL_PYTHON=/usr/bin/python3 node tools/build-range-scene.mjs --view badlands-pinnacles-south --publish
node tools/rise-coverage-check.mjs crater-lake-watchman-east badlands-pinnacles-south --poses 21
node tools/review-range-views.mjs --views crater-lake-watchman-east,badlands-pinnacles-south --source published --stations 21 --modes neutral,silhouette,depth --out .smoke/caldera-badlands-review
```

The browser command is a follow-up check, not a passing result from this task.
This environment cannot run a WebGL browser. Live visual acceptance, musical
motion, transition screenshots, delivered FPS and physical JOYING JY-UTS18N12
sustained playback remain unverified.
