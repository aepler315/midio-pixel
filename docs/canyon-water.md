# Canyon water

Canyon water uses mapped stream reaches and representative conditions bundled
with the scenic catalog. Playback does not request live gauge data. Channel
geometry, flow permanence and the selected wet/dry state are separate fields:
a positive mean annual estimate does not make an intermittent reach wet under
the ordinary no-runoff condition.

The authoring records are in `data/terrain/scenic-views.json`. Regenerate the
runtime catalog with `node tools/build-range-scene.mjs --catalog` after editing.
Each reach carries its source URL, NHDPlus ID, FCode, downstream sequence,
retrieval date, original flow/velocity values and source-response SHA-256.

## Sources and estimates

The channel paths and QEMA/VEMA values were retrieved on 2026-10-21 from the
[USGS NHDPlus HR flowline service](https://hydro.nationalmap.gov/arcgis/rest/services/NHDPlus_HR/MapServer/3).
QEMA is modeled mean annual flow in cubic feet per second; VEMA is modeled
mean annual velocity in feet per second. The runtime values use m³/s and m/s:

```
dischargeM3s = QEMA * 0.028316846592
velocityMps = VEMA * 0.3048
widthM = dischargeM3s / (velocityMps * depthM)
```

The representative mean wetted depth is an assumed 0.1 m. Width and depth
are unmeasured visualization estimates, not surveyed or bankfull dimensions.
The [USGS NHDPlus HR guide](https://pubs.usgs.gov/sir/2025/5031/sir20255031.pdf)
documents the fields and differing model reference periods. The exact EROM
reference period of this service release was not confirmed, so `modelPeriod`
remains null. None of these values are current discharge observations.

Castle Valley contains 21 Castle Creek reach records clipped to the existing
terrain's actual tile footprint: 18 mapped perennial reaches are flowing and
three intermittent headwater reaches are dry in the selected condition.
Flowing reaches have modeled discharge about 0.046–0.098 m³/s and velocity
about 0.35–0.39 m/s. Paths retain digitized downstream order after clipping
and 2 m simplification. [USGS feature classifications](https://www.usgs.gov/ngp-standards-and-specifications/national-hydrography-dataset-nhd-data-dictionary-feature-domains)
distinguish perennial, intermittent, ephemeral and unknown permanence.

The Monument Valley camera-area query returned 262 stream/river features,
all mapped intermittent. Two named reaches, Gypsum Creek and West Gypsum
Creek, document the selected ordinary dry condition. Their unobserved flow,
velocity and dimensions remain null. This camera-area sample does not establish
that every watercourse in the larger terrain footprint is dry. Regional
context is provided by [USGS report 99-4074](https://www.usgs.gov/publications/hydrology-and-water-quality-oljato-alluvial-aquifer-monument-valley-area-utah-and).

## Rendering

`RiverChannel.js` clips metre-width channel ribbons to the terrain triangles
actually drawn, preserving LOD, no-data gaps and depth-band ownership. A
0.15 m geometric lift prevents coincident depth artifacts. Channel distances
increase downstream; the water shader advances its pattern by velocity times
heard time. Reduced motion holds that clock still. Descending channels do
not use the lake's single planar reflection.

The canyon `mapped-only` policy prevents flat DEM patches from being treated
as lakes. DEM drainage accumulation is not interpreted as measured flow or
proof of wetness. Missing, dry, unknown and explicit zero-discharge reaches
create no flowing ribbon. Existing lake views retain their water mask,
swells and reflections. New channel buffers share the terrain preparation,
budget, depth passes and disposal lifecycle.
