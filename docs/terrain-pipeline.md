# Terrain profile pipeline

Terrain elevation is prepared offline. Playback loads only the generated JavaScript profile module; it never downloads elevation tiles or scans a DEM.

## Inputs and contract

`tools/build-terrain-profile.mjs` accepts a north-up Float32 elevation grid encoded in JSON and, optionally, a GeoJSON guide set. Each guide is one connected `LineString` (a one-component `MultiLineString` is normalized). Disconnected components are rejected rather than joined with invented geography.

The grid metadata should identify `source`, `provider`, `product`, `tileIds`, horizontal and vertical reference systems, elevation units, resolution, and no-data representation. Missing fields are recorded as `unverified`; the builder does not assume USGS 3DEP. The output records SHA-256 checksums for the grid and guide.

## Commands

Generic JSON output changes only the requested file:

```sh
node tools/build-terrain-profile.mjs grid.json out.json guides.geojson
```

Updating a bundled runtime module is explicit:

```sh
node tools/build-terrain-profile.mjs grid.json data/terrain/tetons-front.json \
  data/terrain/tetons-guides.geojson \
  --module=src/world/terrain/tetonsFrontData.js
```

Run the same command twice and compare hashes before accepting a regenerated asset. Commit the JSON, guide, and generated module together.

## Runtime representation

Angles are radians. JSON `null` represents a missing numeric sample and decodes to `NaN`; it is never coerced to zero. Normalization uses the profile-wide finite bounds so moving windows retain their relative relief. A finite zero-span profile draws at `0.5`. Entirely missing or malformed profiles are rejected, leaving the procedural fallback available.

Independently guided ridges are a regional composite, not a claim that all layers share one physical camera. The current Teton asset contains two real profiles (`L2` and `L4`); `L3` remains procedural until a third sourced guide and sufficient DEM extent are supplied.

At runtime, immutable profile geometry is shared. Palette-specific canvases are rasterized lazily and retained under a 64 MiB accounted RGBA budget; current and incoming palettes are pinned during a transition.
