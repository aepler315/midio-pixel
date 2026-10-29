# Compiled terrain experiment (pilot: Monument Valley)

An opt-in prototype that replaces the Landscape terrain draw for one scene
with precompiled meshes, to find out whether weaker hardware (an Android car
head unit) can keep the cinematic rail and the live musical effects at a
lower terrain cost. It compares a stepped height-column surface with a
triangulated control that uses the same material approach, and both with the
existing renderer. The existing renderer stays the default. Nothing here runs
an LLM, a vector database or a per-angle visibility table.

## What already happens, and when

- **Offline** (`tools/build-range-scene.mjs`, `tools/lib/terrain-bake.mjs`): the
  real DEM (USGS 3DEP for this view) is normalized into a local metric grid,
  despiked, and baked into 64-cell tiles with per-tile LOD strides, bands
  (near < 1800 m, mid < 7000 m, far) and hydrology flags. Static views keep
  **only tiles visible from their own rail**: Monument Valley ships 128 of
  1225 tiles, a south-west wedge with occlusion holes. That package cannot
  support new viewpoints.
- **Scene preparation** (`RangeScene.prepare`): decode the package; build one
  merged position/index buffer per band (893 k triangles on desktop), the
  2241² RGBA surface texture (normals, curvature, flow; 26.8 MB), the
  receiver mask, the baked horizon and the forest; compile and link every
  program. Buffers are uploaded once and reused. Nothing is rebuilt per frame.
- **Each frame**: one full-terrain depth pre-pass, then each band (far, mid,
  near) redraws its own mesh with the full material shader (triplanar rock,
  forest, snow, water, GGX, mist ray-march, cloud shadows) at LEQUAL against
  that depth. Each band is then copied into the 2D grid canvas
  (`drawImage` of the WebGL canvas, three times). The smooth sky, water,
  shores, mid effects, cast and post effects are composited at output
  resolution afterwards. Terrain draws use `frustumCulled = false`.

`docs/frame-pacing.md` and `docs/cinematic-grid-harmony.md` attribute most of
a 1080p frame to output-resolution work (the smooth sky, composites and
cross-context copies), not to the terrain grid. This experiment changes only
the terrain geometry and its material, so at best it removes the terrain
share. The comparison reports whole-frame delivery separately for that
reason.

## Pilot

`monument-valley-163` was chosen because it is:

- approved and dry (both mapped reaches are dry; terrain water is
  `mapped-only`);
- canyon material;
- a linear 1.2 km rail at 16°, with buttes from 320 m to beyond 20 km.

The normalized DEM (2241 × 2241 at 20 m, every sample valid) rebuilt
byte-identically to the shipped payload. Its height hash equals the shipped
package's `source.demSha256`, so complete source coverage of the whole
44.8 km square is available.

## Using it

```sh
npm run build:compiled-terrain                    # default profile
npm run build:compiled-terrain -- --profile lean  # optional second profile
npm run build:compiled-terrain -- --verify        # compile twice, require identical bytes
```

- **Inputs.** The build reads the same normalized DEM as the production
  bake. It comes from `.terrain-cache/`; on a miss it is normalized again,
  which needs GDAL Python and network access to the USGS bucket. Every
  build also decodes the material's rock and snow detail textures (WebP)
  with Python 3 and Pillow (`python3`, or `MIDIO_GDAL_PYTHON`).
- **Despike.** It applies the production despike step to that DEM.
- **Identity checks.** It refuses a DEM whose hash differs from the shipped
  package's (`--allow-dem-mismatch` overrides this). It also checks the
  catalog's terrain and material hashes and the texture hashes.
- **Output.** Packs are written to `src/assets/range/v2/compiled/` (a profile
  gets a sub-folder). That folder is git-ignored. Generated packs total
  about 37 MB for the default profile (both representations) and about
  17 MB for lean. Source snapshots (`snapshotSource`) and `stage:site` leave
  the folder out; only the comparison harness opts in. On this machine the
  default profile took about 45 s to build and the lean profile about 25 s.

The app selects a mode from URL flags:

| Flag | Effect |
| --- | --- |
| `?compiledTerrain=columns` | Stepped height columns |
| `?compiledTerrain=mesh` | Triangulated control (same chunks, levels, colours, shader) |
| absent, `off` or `original` | Existing renderer |
| `?compiledTerrainCamera=reverse` | The declared multi-angle test rail, in any mode |
| `?compiledTerrainProfile=lean` | Packs built with `--profile lean` |
| `?compiledTerrainGroup=1\|2\|4\|8` | Draw batching (tiles per block side; default 4) |

Every other scene, a tour, a glacier view, a composition variant and every
pack failure keeps the existing renderer. The pack failures are: missing,
wrong schema or version, hash mismatch, compiled against another terrain,
tampered, and budget denial. `window.__SMW.rangeState.scene.compiledTerrain`
reports three things:

- `request`: what was asked;
- `views[id]`: what was selected and why, with pack hashes, counts and
  preparation timings;
- `drawn`: the renderer each prepared view is actually drawn with.

A fallback is logged with `console.warn` and can never pass for the
prototype.

## Pack format (`midio.compiled-terrain` v1)

Each representation of a view is a JSON manifest plus a deterministic gzip
payload.

- **Manifest fields:**
  - `source`: DEM and validity hashes, the hash of the compiled heights, grid,
    CRS, vertical reference, metres, provenance, despike count, and the
    shipped terrain package's hashes;
  - `material`: manifest URL and hash, palette, rules, texture hashes, and
    what the bake fixes;
  - `coverage`: rule, cameras, chunk counts, bounds, completeness;
  - `settings`: levels with cell size and vertical quantum, detail selection,
    merge block, atlas, quantization and seam rules;
  - `deform`: height range, merge-gap bounds, tolerance, cull padding;
  - `compilerVersion`, `payload` hashes, `stats`, and one record per chunk.
- **Chunk records:** 64 source cells (1280 m) on the shipped tile lattice, so
  bands are kept per tile. Each has a band, level, origin, base height,
  bounds, counts and byte ranges.
- **Per chunk in the payload:** Int16 positions (x/z metres from the chunk
  origin, y decimetres above its base), Int8 normals, Uint16 material-atlas
  coordinates, Uint16/Uint32 indices, and the displayed ground. That ground is
  the lattice heights (the control's vertices, seam-snapped), plus the column
  tops for the columns pack.
- **Per pack in the payload:** an sRGB8 albedo + AO8 atlas and the sparse
  receiver mask (water pinning for the swell).

## Chosen settings

| | default | lean |
| --- | --- | --- |
| level 0 | 20 m cells, 5 m step, within 4 km of a declared eye | same, within 3 km |
| level 1 | 40 m cells, 10 m step | 80 m cells, 20 m step |
| merge block | 160 m, world-aligned | same |
| chunks | 744 (128 shipped tiles plus the rest of both rails' frusta) | same |

Horizontal cell size and vertical step are set per level and independently.
Both are anchored in world coordinates: cells on the DEM lattice from its
origin, heights at multiples of the step from 0 m. Physical block size is
independent of the presentation's pixel grid. The presentation, the grid and
the output sizing are unchanged.

### Coverage

Coverage is the union of rail frusta, using the production extended framing
with boxes lifted by the largest swell, for 21 stations of the default rail
and 21 of the declared reverse rail. There is no occlusion culling. Every
shipped tile is included. Every included chunk has complete source samples.
Nothing is invented: an invalid sample would leave a hole closed by walls.

### Columns

- **Height:** each cell is one column whose height is the area mean of the
  bilinear DEM over the cell, rounded to the step. Its error is at most half
  a step.
- **Faces:** top faces, and side spans at 20 m resolution against the
  neighbour's displayed column at any level and in any chunk. The taller side
  owns a span. At the pack's edge, spans close down to the chunk floor.
  Interior faces are never emitted, including across chunk and level borders.
- **Merging:**
  - Tops merge greedily, and sides along their line, within 160 m
    world-aligned blocks, and never next to water.
  - Colour does not limit merging: it comes from an atlas texel per column
    (`texelFetch`), so merging loses no colour variation.
  - Vertices are shared within a chunk.

### Control mesh

A regular lattice at the same spacing: the decimated DEM, with finer edges
snapped to the coarser neighbour (TerrainMesh's rule), quads split as
production splits them, and smooth normals. Its atlas has one texel per
vertex, linearly filtered.

### Swell

The vertex shader applies production's `deformAt` at each vertex's source
position, so trees and the cast, which read the same field, stay on the land.
A merged edge interpolates its corners: its gap under the swell is at most
`L²/8 · A·k²`.

- **Landscape's channels:** the wave at 50 m × the view's calibration, with
  wavelength 4.8 km. A 160 m block bounds the gap at **0.091 m** (recorded
  in each manifest's `deform.gapBoundM`), inside the declared 0.1 m
  tolerance.
- **Every channel at the cap,** including the melodic tilt, which Landscape
  zeroes: about 0.97 m.

The test suite checks the bound against `sceneDeformation`. Culling bounds
are padded by the largest swell, 180 m.

### Seams

Fixed detail selection: a chunk's level never changes at runtime. Sides are
built against the neighbour's actual level, so no crack can open. Band
partitions keep production's seam fill: a nearer band's chunks touching a
farther band also draw in the farther pass.

### Baked appearance

The production albedo rules are ported to JS: cliff, ground, moss, strata,
lichen, streak and rib terms, forest habitat and cover, snow, and ambient
occlusion. They are evaluated from the same surface quantities (normal,
curvature, flow) and box-filtered over each texel's footprint. Two terms are
view-dependent in production and are fixed at the rail's middle eye: the
forest's distance colour and its crown cover.

### Live material

The live material is deliberately light. From the scene's existing uniforms
it keeps:

- a wrap-diffuse key with production's GGX lobe, so the ground glints when
  rain wets it;
- the storm's shadow, clearing and sheltered ambient;
- the cast's light;
- the sky hemisphere;
- exposure, tonemap, the cinematic grade and the narrative fades;
- valley mist, from production's exact layer integral with the noise banks
  at their mean (no ray-march);
- distance air and the rain veil.

It does **not** reproduce:

- the baked horizon shadow and cloud shadows;
- rock and snow detail normals;
- far-forest dots;
- silhouette ink and its feature lines;
- mapped rivers (none flow in this view).

### Runtime

- **What loads:** the view's PreparedView is built from the pack. The
  production terrain package, surface texture, horizon bake, material
  textures and terrain shader are never loaded for it.
- **Draws:** chunks of one band are merged per 4 × 4 tile block (one draw
  each) into the existing band scenes, the depth pre-pass and the travel and
  seam scenes. They are frustum-culled and backface-culled, and keep the
  invariant vertex transform that the LEQUAL partition contract needs.
- **Ground:** `terrainHeightAt` follows the drawn surface through
  `data.groundAt`, so camera clearance, the cast and line of sight see the
  columns. Trees are placed with production's slope rules, then re-seated on
  the column tops.
- **Memory:** after preparation only the ground stays on the CPU, beyond
  Three's copies of the merged buffers, which are charged.
- **Lifecycle:** release, eviction and context loss follow the existing
  lifecycle.

## Measuring it

```sh
# Hardware GPU from WSL: native Windows Node + Chromium (D3D11), as test:gpu does
node.exe --import <playwright loader> tools/compiled-terrain-compare.mjs --out .smoke/<run> \
  --hardware-gpu --browser 'C:\…\ms-playwright\chromium-1243\chrome-win64\chrome.exe'
# Software (SwiftShader) baseline
node tools/compiled-terrain-compare.mjs --out .smoke/<run>
```

From WSL, hardware WebGL needs native Windows Node and Chromium. Mesa's
D3D12 path (`GALLIUM_DRIVER=d3d12`) reaches the GPU, but loses the WebGL and
2D contexts after the first exported frames, in every mode including the
existing renderer.

The harness runs every mode in a fresh browser (cold shader, driver and
HTTP caches) with the same song, seed, output size, grid, pinned quality
rung, look and pace. Live runs start only after the whole-song analysis is
adopted. It records:

- **Cold load:** the view's preparation time and phases, and the first frame,
  where GPU upload happens.
- **Matched captures:** identical heard times, the reverse camera, the
  listener's zoom, and the strongest land-swell moment.
- **Steady state:** fixed-clock frames with GPU timer queries on the scene's
  context, split into terrain scenes and the rest. It also counts
  terrain-surface draws and triangles, separately from trees and cast drawn
  in the same scenes.
- **Live playback:** at the default pace and the faster pace (3× and 4×),
  with delivered frame intervals, stalls, the same GPU split, pause and
  resume, and a seek round trip while paused.

## Device test procedure (Android head unit)

Not run: no Android device was available. Device performance is
**unverified**.

1. Build both profiles on a workstation (above) and run `npm start`
   (`tools/serve.js`, loopback port 8080).
2. Connect the unit by USB with debugging enabled and run
   `adb reverse tcp:8080 tcp:8080`. Under WSL2, run adb on the Windows side
   or use mirrored networking. Serving over plain LAN HTTP does not work:
   the page is then not a secure context, `crypto.subtle` is missing, and
   every pack and package hash check fails, so every mode falls back.
3. On the unit, open Chrome at
   `http://localhost:8080/?rangeView=monument-valley-163&rangeTour=off&perf=high`,
   adding `&compiledTerrain=columns` or `…=mesh` (optionally
   `&compiledTerrainProfile=lean`), or nothing for the existing renderer.
4. Connect `chrome://inspect` from the workstation. Load the same song in
   every mode, and wait until `__SMW.sim.analysisOpening` is null (the
   whole-song analysis is adopted).
5. Pin the rung the unit's governor settles at, the same in every mode,
   with `__SMW.perf.setFixtureLevel(1)` (or that level).
6. Measure 30 s of delivery in the DevTools console:

   ```js
   const { FrameDeliveryAggregator } = await import('/src/render/FrameDelivery.js');
   const meter = new FrameDeliveryAggregator(), start = performance.now();
   await new Promise(done => { const tick = w => { const s = __SMW, f = s.presentationDiagnostics.frame;
     meter.push({ wallMs: w, generation: s.generation, frameId: `${f.generation}:${f.frameId}`, presented: f.presented,
       attempted: f.reason !== 'not-rendered', paused: s.paused, hidden: document.hidden, capFps: s.fpsCap });
     w - start < 30000 ? requestAnimationFrame(tick) : done(); }; requestAnimationFrame(tick); });
   copy(JSON.stringify(meter.summary()));
   ```

7. Record `__SMW.rangeState.scene.compiledTerrain` (confirm `drawn` shows the
   requested mode), `.prepareLog`, `__SMW.rangeState.residency`, and the GPU
   string (`WEBGL_debug_renderer_info`).
8. Repeat at pace 4 (`#range-pace`), then compare delivered fps, p95
   interval, stalls over 100 ms and preparation time.

## Results

Measured on 2026-10-29 at commit `dfd10f2` plus the harness as committed.
The setup, the same in every mode:

- the `contrast` pilot song (90 s, seed 315);
- 1280×720 output on the Classic (320×180) grid, Pixel look;
- quality rung 0 pinned, effects as in production;
- 4 × 4 draw batching unless stated.

The evidence (PNG frames, `report.json`, `summary.md`) is in `.smoke/ct-A`,
`ct-B1`, `ct-B2`, `ct-Blean` and `ct-C`, kept out of Git.

**Hardware:** `ANGLE (NVIDIA GeForce RTX 3060, Direct3D11)`, headless
Chromium 1243 on Windows. **Software:** `SwiftShader` in WSL (CPU
rasterization); its milliseconds are CPU time, not GPU time, and are
reported separately.

### Steady-state terrain cost (fixed clock, 180 frames)

The default camera, at the start of the song's steady section. "Surface"
counts the terrain meshes only; the terrain scenes also draw trees and the
cast. GPU times come from timer queries on the scene's context.

| mode | surface draws | surface triangles | RTX GPU ms p50 (p95) | SwiftShader ms p50 |
|---|---:|---:|---:|---:|
| existing | 11 | 2.80 M | 1.16 (5.64) | 336 |
| columns | 59 | 1.74 M | 1.28 (5.15) | 132 |
| mesh | 59 | 2.78 M | 0.64 (3.92) | 205 |
| columns, lean | 59 | 1.04 M | 0.80 (1.59) | – |
| mesh, lean | 59 | 1.67 M | 0.75 (1.30) | – |
| columns, 1 × 1 batching | 455 | 1.32 M | 1.09 (2.80) | – |
| mesh, 1 × 1 batching | 455 | 1.93 M | 0.84 (1.67) | – |

- **Reverse camera, RTX:** existing 0.83 ms (2.80 M triangles), columns
  1.68 ms (2.79 M), mesh 1.13 ms (4.33 M). Coarse batching culls less from
  this angle.
- **Mesh vs existing:** at an equal triangle count, the mesh's baked
  appearance and light shader remove about 40 % of the terrain work in the
  software proxy.
- **Columns vs existing:** with 38 % fewer triangles, the columns remove
  about 60 %.
- **RTX:** terrain is a millisecond or two in every mode, so the desktop
  GPU cannot separate them.

### Whole-frame delivery (live, RTX)

Each segment is 20 s after the whole-song analysis was adopted, with the
rung pinned at 0, at pace 3 then 4.

| mode | pace | delivered fps | interval p50 / p95 / max ms | stalls > 100 ms |
|---|---:|---:|---:|---:|
| existing | 3 | 59.1 | 16.7 / 16.8 / 33 | 0 |
| existing | 4 | 59.7 | 16.7 / 16.8 / 83 | 0 |
| columns | 3 | 58.8 | 16.7 / 16.8 / 34 | 0 |
| columns | 4 | 59.8 | 16.7 / 16.8 / 83 | 0 |
| mesh | 3 | 57.7 | 16.7 / 16.8 / 34 | 0 |
| mesh | 4 | 59.8 | 16.7 / 16.8 / 83 | 0 |

The lean packs delivered 55.1 and 59.6 fps (columns) and 58.7 and 58.6 fps
(mesh), with no stalls.

- **Pause, seek and resume:** in every mode, pausing held the heard clock,
  seeking to 30 s, 52 s and back to 30 s reproduced the same camera pose and
  swell amplitude, and resume continued. The stage pixels after the seek
  round trip differ in every mode, the existing renderer included, so that
  is not a regression.
- **Software live:** SwiftShader delivered about 1 fps; the compiled runs
  timed out waiting for the analysis, and no software live comparison
  exists.

### Load, bytes and memory

| | existing | columns | mesh | columns, lean | mesh, lean |
|---|---:|---:|---:|---:|---:|
| download for this view | 0.86 MB terrain + 5.5 MB textures | 19.0 MB | 16.9 MB | 7.7 MB | 8.1 MB |
| covered area | 128 tiles | 744 tiles | 744 tiles | 744 tiles | 744 tiles |
| view preparation, cold browser (RTX) | 4.35 s | 1.33 s | 1.25 s | 1.17 s | 1.17 s |
| view preparation, SwiftShader | 1.47 s | 0.56 s | 0.53 s | – | – |
| GPU bytes (vertices, indices, atlas, receiver) | – | 53.6 MB | 38.9 MB | 25.7 MB | 20.4 MB |
| accounted residency, live / peak | 95 / 175 MiB | 130 / 225 MiB | 112 / 190 MiB | 67 / 124 MiB | 59 / 110 MiB |

- **Preparation:** the compiled views spend about 1 s of their preparation
  linking programs in the cold browser, whatever the pack size. Download,
  verification and decoding take 0.1–0.25 s on loopback. The existing
  renderer builds its meshes, the 2241² surface texture and the horizon on
  the CPU.
- **Download size:** the compiled packs are several times larger to
  download, because they carry six times the area and precomputed
  geometry.

### What the frames show

These compare matched frames at 12, 24 and 45 s, the swell at 33.25 s, the
zoom, and the reverse camera.

- **Mesh (default):** reproduces the landscape closely. It has the same butte
  silhouettes, mist, cast light, and wet-ground moon glints under rain.
  Missing: cloud and horizon shadows and the rock detail normals. Distant
  cliffs are slightly flatter in tone.
- **Columns:** the buttes stay recognizable but become stacks of 20–40 m
  blocks. From the rail's 60 m eye height, the 5 m steps on the gently
  rising desert floor show as dark camera-facing risers between lit tops.
  These contour bands dominate the lower half of the frame where production
  shows hazed ground. They come from the representation (the share of
  visible riser does not depend on the step size), not from a defect. Small
  ledge tops on stepped cliffs read as bluish dashes.
- **Lean profile:** the 80 m far cells visibly damage the landmarks. The
  mesh's left Mitten becomes a spike, and the columns' mesa rim steps.
- **Reverse camera:**
  - The existing renderer shows sky where the mesa under the camera and the
    horizon beyond the buttes should be: the shipped package never contained
    them.
  - Both compiled modes draw complete terrain from the same source samples,
    including the buttes' far faces.

## Recommendation

**Reject the stepped column surface** as the head-unit route for real-terrain
landscapes. **Keep, and revise, the triangulated control with baked
appearance.**

- **Columns:** they did cost the least in the software proxy, but only
  through fewer triangles. They carry twice the control's vertices and the
  largest packs and memory, and they change the landscape the most: the
  terraced foreground and blocky buttes replace the hazed desert floor and
  smooth silhouettes. At the eye heights the rails use, the step size cannot
  fix the terracing.
- **Mesh control:** at the same triangle count as production, the baked
  material with a light shader already removed about 40 % of the measured
  terrain work and kept the landscape, rail, swell and effects intact.
  Next steps, in order:
  1. A level-of-detail error budget for the 320×180 grid instead of 1080p
     (the shipped mesh's budget), aiming for the lean triangle counts without
     the lean profile's silhouette damage.
  2. Occlusion-aware coverage, or the shipped tile set for the default
     camera, to bring packs and memory below production's.
  3. Restoring cloud and horizon shadows if the device budget allows.
  4. Measuring on the head unit with the procedure above.
- **Pre-rendered view atlases** stay a later fallback. Geometry with baked
  appearance kept free camera movement, zoom, swell and complete reverse
  views. Nothing measured here requires giving those up.

All device conclusions remain unverified until the procedure above runs on
the JOYING unit.
