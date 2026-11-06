# Sierra Nevada and San Juan Mountains

This batch adds two new geographic regions to the Landscape catalog:
`sierra-whitney-east` (STEPPE) and `san-juan-sneffels-north` (CONIFER).
Both use newly acquired USGS 3DEP elevation data, normalized at 20 m spacing,
with authored aerial camera rails. They reuse the existing biome materials,
flat-ground song growth, progressive pixel detail and atmosphere.

The entries retain `candidate` status and use the separate `experimental: true`
flag for normal selection. This expands the normal pool from 16 to 18 locations;
CONIFER has three distinct regions and STEPPE has two. Neither entry has an
artistic approval or a shot library. The standard scheduled rail supplies motion;
no full-song glacier journey or synthetic terrain replaces the elevation data.

## Geography and source attribution

Mount Whitney's view looks west from above the Alabama Hills vicinity toward
the eastern Sierra escarpment. The [BLM's Alabama Hills description](https://www.blm.gov/visit/alabama-hills)
places the rounded hills below the Sierra Nevada's jagged peaks. The San Juan
view looks south-east from above the Dallas Divide vicinity into the Sneffels
Range. Camera coordinates and heights are authored estimates, not surveyed
public viewpoints. Material habitat and snow thresholds are artistic rules,
not measured land cover.

Landmark coordinates were queried on 2026-11-06 UTC from the
[USGS GNIS Landforms service](https://carto.nationalmap.gov/arcgis/rest/services/geonames/MapServer/5)
using `gaz_id IN (269051,196432)` and `outSR=4269` (NAD83):

| Landmark | GNIS ID | Longitude | Latitude |
| --- | ---: | ---: | ---: |
| Mount Whitney | 269051 | -118.2924218 | 36.5785700 |
| Mount Sneffels | 196432 | -107.7922734 | 38.0038447 |

The query returned duplicate identical Whitney coordinates; the authoring uses
one landmark. No surveyed vertical value is asserted. The build records retain
the DEM ground and nearby peak samples. The raw response is retained outside
Git in `work/sierra-san-juan-gnis.json`.

Each authoring entry uses a complete inline map of dated USGS 3DEP tile URLs
and `windowCache: "tile"`. The normalizer records the downloaded window hashes,
projection and source vertical datum; the package and build records retain
decoded/compressed payload identities, camera coordinates and achieved LOD
error. No existing terrain package is rebaked.

The Sierra window uses `n37w119` dated 20260610. The San Juan window crosses
`n38w108` and `n39w108`, both dated 20260630 (TNM publication date 2026-07-01).
The complete TNM API replies and selection records are retained in
`work/sierra-san-juan-source/` outside Git.

| View | Compressed terrain | Desktop / mobile triangles | Achieved error, px |
| --- | ---: | ---: | ---: |
| Mount Whitney | 1,694,942 B | 1,859,526 / 1,349,232 | 0.962 / 1.992 |
| Sneffels Range | 1,654,846 B | 1,819,776 / 971,856 | 0.797 / 1.979 |

Both normalized windows have valid elevation at every sample. The existing
despiking pass replaces one isolated Sierra sample; it replaces none in the San
Juan window. Both packages reproduce byte-for-byte on a second cached build.
At 21 camera stations, far-crest exposure and frame width are both 1.0 in each
view. The original full-height camera rail stays at least 380 m above sampled
terrain, and the named summit remains inside the nominal frame. These CPU
checks do not establish the appearance of the song-driven rise or transitions.

## Build and verification

The Windows Node builder consumes normalized grids produced by the existing
`normalize-dem.py` through installed WSL Ubuntu GDAL 3.12.2. The external bridge
uses the builder's exact `{dem, points}` cache key. This is a local execution
bridge, not a runtime dependency or a change to the terrain format.

Device checks use isolated muted Chrome on the actual RTX 3060 with
ANGLE/D3D11, DPR 1.75 and Detailed pixel density.
The synthetic 90-second `midio-perf-pilot.wav` fixture has SHA-256
`c0160a5c95669def70cfe43feeca1c06b81117cf01f2b4e43d59f1ef59e02297`.
These checks cover one fixture and one GPU; they do not establish broad song or
device coverage.

### Growth and source integrity

The 26 focused selection, provenance, payload and framing tests pass. They
include all normally eligible views and directed mixed-band travel combinations.
The structural flat-plane check also passes for both new packages at 21 poses;
it checks inferred support coverage, not unshipped DEM accuracy.

Twelve GPU captures cover both new views at 0, 14, 42, 70 and 89.984 seconds,
then a rewind to 0. The opening is flat, the terrain reaches full height, and
each rewind reproduces the exact opening stage pixels. All GL probes are zero;
there are no page errors or changed source files during the run. Representative
opening, middle and completed frames were inspected. The finished Sierra front
and the layered forested Sneffels view show distinct relief. The Sierra's
intermediate rise still shows the inferred ground horizon behind the growing
terrain; this is not a claim of seamless geological reconstruction.

These range-only checks use an isolated checkout of merge commit `575e19d`
with only the new authoring/catalog/packages copied in. Its single-stage
renderer is unchanged; the separate crest-overlay correction was being
developed concurrently and is not exercised by these range-only checks.
Served source hashes are recorded in the report. Evidence is retained outside
Git under `work/range-pipeline-evidence/sierra-san-juan-growth-20261106/`.

### Detailed / Auto timing

The same isolated range checkout uses the default single-stage pipeline,
Detailed 640x360, Auto effects and the normal tour gate. Both new views use
their ordinary rails and remain at full effects quality (rung 0).

| Region | 25-55 s presented FPS | Settled 45-55 s | Continuous 55-65 s |
| --- | ---: | ---: | ---: |
| Mount Whitney | 59.60 | 60.00 | 60.00 |
| Sneffels Range | 59.43 | 60.00 | 60.00 |

The long samples each include one early pacing stall: approximately 217 ms
for Whitney and 283 ms for Sneffels. Sneffels records one repeated callback;
neither view has unpresented frames, page errors or source changes during the
run. Follow-on p95 intervals are 16.745 and 16.725 ms respectively. This is not
a claim of uninterrupted 60 FPS from startup or across every song.
Raw results are retained in
`work/range-pipeline-evidence/sierra-san-juan-detailed-auto-20261106/`.

A final integration run on the combined range-and-ridge working tree confirms
both new views still select the single-stage renderer with no crest overlay.
At Detailed, fixed full effects and 40-46 seconds, Whitney measured 56.71 FPS
and Sneffels 56.83 FPS, with median CPU submission of 0.750 and 1.435 ms.
Neither run has a stall over 100 ms, an unpresented/repeated frame, a page
error or a source change. This later bounded run is lower than the earlier
60 FPS intervals; it is reported separately rather than attributing the
difference to a specific cause. Evidence is in
`work/range-pipeline-evidence/sierra-san-juan-final-integration-20261106/`.

### Controlled travel

Eighteen paused full-stage captures exercise Whitney -> Sneffels ->
Superstition -> Whitney at 42 and 70 seconds, each at transition fractions
0.25/0.5/0.75. Both scene sides are prepared and the real band draws and
composites run at quality 0. There are no transparent stage pixels, page or GL
errors, residency denials or overcommits. Maximum sampled live residency is
324,805,011 bytes; the reported peak is 354,999,908 bytes against the 512 MiB
desktop budget.

Three representative midpoint captures were inspected. The existing staggered
band reveal and the intermediate inferred horizon can produce visible vertical
boundaries, especially Superstition -> Whitney at 42 seconds. This is controlled
coverage evidence, not a claim of seamless transitions or natural-schedule
motion coverage. Overrides are restored after each capture. Reports and PNGs
are in `work/range-pipeline-evidence/sierra-san-juan-travel-20261106/`.
