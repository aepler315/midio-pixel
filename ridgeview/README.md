# Ridgeview

A 3D Earth terrain viewer for mountain ranges. Every range opens on a
viewpoint that was **calculated** to show its crest well, the way a
photographer would choose a spot: the skyline belongs to the range, the
whole face is visible from its base to the summits, nothing in the
foreground blocks it, and a lake in front is a bonus. Jumping between
ranges is a ballistic flight across the globe, and the look of the scene
(light, weather, rendering style, analysis overlays) changes with
animated transitions.

Self-contained: plain ES modules, a vendored copy of three.js, no build
step. Elevation streams live from the free AWS Terrain Tiles dataset.

## Run

```sh
cd ridgeview
npm install        # only needed for tests and the offline tools
npm start          # http://127.0.0.1:8090/
```

Any static file server works too (`python3 -m http.server` in this
folder). The page needs WebGL2 and an internet connection for elevation
tiles. Add `?proxy=1` to route tiles through the dev server's disk cache
(`.tile-cache/`).

## Controls

| Input | Action |
| --- | --- |
| Scroll | Fly toward the point under the cursor; scroll back to back away |
| Drag | Look around from where you are |
| Right-drag / Ctrl-drag | Orbit the point you grabbed |
| Shift-drag / middle-drag | Drag the ground (pan) |
| Double-click | Glide halfway to a spot |
| Shift + scroll | Move the sun |
| W A S D, Q E, arrow keys | Fly and look (speed follows height above ground) |
| `[` `]` | Previous / next range (nearest-neighbour tour) |
| Space | Surprise jump to a distant range |
| V · H | Next viewpoint · back to the viewpoint |
| 1 – 7 | Light: alpenglow, golden hour, midday, raking, backlit, blue hour, moonlight |
| Shift + 1 – 5 | Weather: summer, autumn, winter, storm, cloud sea |
| T · O · L | Next style · next overlay · peak labels |
| C | Copy a link to this exact view and look (also the Share button) |
| F · ? | Fullscreen · help |

Touch: one finger looks, pinch flies toward the pinch point, two-finger
twist/drag orbits.

URL parameters: `range=<id>`, `view=<0..2>`, `light`, `weather`, `style`,
`overlay`, `quality=low|medium|high|ultra`, `labels=0`, `instant` (skip the
dive from orbit), `at=lon,lat,height,heading,pitch[,fov]` (an exact pose).

Quality preset names are case-insensitive across URL, saved preference, Engine
construction and setters. Unsupported values (including an explicitly empty
`quality` URL) fall back to `high`. Without a URL or saved preference, startup
uses `medium` on small/coarse-pointer devices and `high` otherwise.

## How viewpoints are calculated

`tools/compute-viewpoints.mjs` runs offline over every range in
`data/ranges.json` (88 North American ranges) and writes
`data/viewpoints.json`. For each range (`src/core/viewpoints.js`):

1. **Crest.** Elevation tiles (~90 m cells) are stitched around the range
   with a 47 km margin. The highest 10% of cells inside the range box are
   the crest; their weighted principal axis gives its trend and length;
   the summit is the highest point (re-measured on ~15 m data).
2. **Candidates.** Eyes on a polar grid around the crest: 36 bearings x
   6 distances (scaled to the range's relief) x 4 heights above ground
   (2 m standing, 120 m, 400 m, 1000 m) — 864 eyes per range.
3. **Skyline rays.** From each eye a fan of rays (120 degrees, 1.5 degree
   steps) is marched across the terrain with Earth curvature and
   refraction, recording every sample's elevation angle and whether it is
   visible. Each ray yields: which point makes the skyline, the visible
   base of the face below it, how much the foreground hides, and whether
   a lake is seen.
4. **Framing.** Every lens width (30 to 80 degrees) and aim is tried; the
   frame is scored on
   - *ownership*: share of the skyline that is the crest itself,
   - *face*: visible face height as a share of the frame (bump around
     20-50%),
   - *openness*: how much of the face the foreground leaves visible,
   - *drama*: summed prominence of skyline peaks,
   - *water*: a lake in the frame, with the pitch tilted to include it,
   - *summit*: the high point visible inside the frame,
   - a mild preference for normal-to-short-telephoto lenses.
5. **Refinement.** The best eight distinct candidates are hill-climbed in
   position and height; the final three must look from clearly different
   places.

Check: the calculator, without being told, places one Teton viewpoint
about 5 km from Midio's hand-placed Jackson Lake view, looking the same
way (238 vs ~240 degrees), and its best view looks across Jenny Lake at
Grand Teton.

## Rendering

- **Streaming globe.** A quadtree of Web Mercator tiles over a sphere
  (`src/engine/TerrainTiles.js`). Tiles refine until their mesh spacing
  projects to a few pixels, with frustum and horizon culling. Elevation
  (terrarium PNG, levels 0-15) is fetched and decoded in workers with an
  exact PNG decoder; tiles are built in workers too.
- **Precision.** Positions are kept in float64 on the CPU and drawn
  relative to the camera, so centimetre detail holds anywhere on Earth;
  depth is logarithmic, so the same frame can hold a rock at 2 m and the
  planet's limb.
- **Detail past the data.** Up to ~3 m per pixel the mesh follows the
  DEM 1:1 (Catmull-Rom between samples). Beyond, band-limited ridged
  noise adds rock steps and ribs below 32 m wavelength, scaled by
  steepness (`src/core/detail.js`); finer still, normals get procedural
  micro-relief that fades with the on-screen footprint. Each tile carries
  a per-texel slope/water/convexity texture for lighting.
- **Materials.** Procedural: rock (strata, crack networks, fall-line
  staining), talus, meadow, forest stands driven by moisture, aspect and
  avalanche paths, tree crowns up close, snow by latitude-aware snowline
  with lingering couloir snow, lakes (detected from hydro-flattened DEMs)
  and sea. Palettes follow each range's ecoregion (RESOLVE 2017).
- **Light.** Single-scattering atmosphere (Rayleigh, Mie, ozone) for the
  sky from the ground to orbit; aerial perspective on the terrain; the
  Earth's shadow per fragment, which is what turns the summits pink at
  alpenglow while valleys are in shade; two sun shadow cascades; moon and
  stars at night.
- **Water.** Lakes in view are found by ray sampling; a half-resolution
  mirrored pass reflects the mountains in them, broken by ripples.
- **Trees.** Within ~1-2 km (by quality) instanced 3D conifers or
  broadleaf crowns stand on a world-locked jittered grid; the vertex
  shader runs the same land-cover function as the ground shader, so trees
  grow exactly where the ground is painted forest, shrink toward the
  treeline, and carry snow in winter.
- **Sky.** High cloud at ~8 km catches dawn and dusk colour; storms bring a
  low dark deck that swallows the summits, and falling snow.
- **Looks.** Light presets are aimed at the current viewpoint (golden
  hour lights the face you are looking at; backlit puts the sun behind
  the crest) and kept to azimuths the sun can reach at that latitude.
  Changing light sweeps the sun across the sky; weather animates (snow
  creeps down, a cloud sea rises and the camera lifts above it); styles
  and overlays wipe over a snapshot of the previous frame.

## Data and credits

- Elevation: [Terrain Tiles on AWS](https://registry.opendata.aws/terrain-tiles/)
  (USGS 3DEP, SRTM, GMTED2010, ETOPO1, Canada CDEM and others;
  [attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)).
- Range list: Midio-5 (`data/terrain/ranges.json`, `discovered.json`;
  range names from Wikidata, CC0).
- Summit names: [GeoNames](https://www.geonames.org/), CC BY 4.0
  (`tools/build-peaks.mjs` -> `data/peaks.json`).
- Ecoregions: RESOLVE Ecoregions 2017 (Dinerstein et al.), CC BY 4.0.
- three.js r186 (MIT), vendored in `vendor/`.

## Development

```sh
npm test                       # unit tests (geo, PNG, tile builder, viewpoints, looks, flights)
npm run smoke                  # headless interaction test (scroll, drag, keys, jumps, search)
node tools/compute-viewpoints.mjs [--only tetons,sawtooth]
node tools/build-peaks.mjs
node tools/shot.mjs "range=tetons&view=0" out.png     # headless render
node tools/gallery.mjs "range=tetons" .smoke/gallery  # every look
npm run vendor                 # refresh vendor/ after changing three
```

Headless renders use SwiftShader (software WebGL), which is slow: allow
several minutes for full detail.

## Layout

```
src/core     pure math: geo, PNG/terrarium, DEM grid, viewpoints, detail noise
src/engine   renderer: tiles, workers, shaders, sky, shadows, clouds, water, post
src/scene    camera rig, controls, flights, looks
src/ui       DOM interface and peak labels
tools        dev server, offline calculators, headless capture
data         ranges, computed viewpoints, named peaks
```

Moving it to its own repository: `git subtree split --prefix=ridgeview -b ridgeview`
in the Midio-5 checkout, then push that branch to the new repository.
