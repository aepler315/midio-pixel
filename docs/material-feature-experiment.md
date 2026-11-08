# Stable material-feature cache pilot

## Intent

Continue selective scene distillation with a bounded cache of stable material
inputs. Keep geometry, musical deformation, live normals, material rules,
lighting, weather, cameras and growth in the existing renderer.

The first material target is the world-space noise that warps rock and snow
texture placement. The two 600 m noise evaluations currently reconstruct eight
integer-cell hashes per material fragment. One GPU-baked RGBA8 texel can hold
the four corner hashes for a cell; the shader retains its original cubic
interpolation and reads the cache twice.

## Representation and alternatives

The selected packed-corner lattice uses nearest integer texture fetches. It
trades hash precision for a maximum theoretical 0.58824 m warp error per axis
from UNORM8 quantization, before shader floating-point differences. GPU
comparisons must verify the real error. A GPU bake uses the same GLSL hash;
the existing JS double-precision noise is unsuitable as an equivalent bake.

A filtered 16-bit hash lattice offers lower quantization error but introduces
device-dependent hardware interpolation precision. A dense warp atlas costs
more memory. A full blended rock atlas would freeze the live normal weights
that drive triplanar shading and material boundaries. Those remain later
experiments; this pilot keeps the 23 m breakup noise and all triplanar samples
live.

## Resource and fallback contract

- Explicit `?materialFeatures=warp` opt-in; reference is the default.
- One lattice covers both shifted noise domains over the full source grid.
- A 256 by 256 cap bounds GPU storage at 256 KiB per prepared view; normal
  views should use smaller dimensions. No CPU image array or mip chain remains.
- Admit output and bounded build scratch before allocating. A cache may use
  only spare room and must not evict another view to fit.
- Reuse the currently unsampled `tSoil` terrain sampler. Add no fragment
  uniforms; retain Adreno uniform headroom. Two currently unused terrain
  scalars, `sSoil` and `sCanopy`, carry the exact integer cache origin.
  Inferring that origin from an uploaded floating-point world coordinate can
  round across a cell boundary. Cache-format/origin validation prevents
  treating an ordinary soil image as the lattice.
- Oversized/invalid bounds, budget denial or bake failure select the reference.
  Individual samples outside the lattice also use the original procedural noise.
- The prepared view owns disposal, cancellation and context-loss rebuilding.
  One world-space table works for rail/tour cameras and streaming windows.

## Validation

Check bounds, query selection, texture-format binding, memory admission,
renderer state restoration and disposal with focused tests. Compile terrain
and river variants, verify the mobile uniform budget, and compare the actual
GPU bake and noise reconstruction around negative coordinates, cell boundaries
and fallback edges. Measure warp/derivative error and representative material
output. Full-scene comparisons must pin camera, music, quality and geometry.

Keep evidence under `.smoke/`. Software-renderer timings cannot establish a
JOYING gain. Reference remains the default until hardware and visual evidence
support enabling the cache.

## Results

The cache is implemented behind `?materialFeatures=warp`. The reference is
still the default. Interior samples replace eight hash evaluations with two
integer texture reads; the original cubic interpolation, triplanar samples,
near-rock detail, 23 m breakup, normals, masks and lighting remain live. A
one-cell guard region blends back to procedural noise continuously.

### Native shader checks

Current terrain/river shaders linked in reference/cached and desktop/mobile
pixel configurations: eight programs. The fixture used GLSL ES 3.00 with
Three.js's high-precision sampler declaration on Mesa 25.0.7,
`llvmpipe (LLVM 19.1.7, 256 bits)`.

| Source grid | Lattice | GPU texel bytes | Maximum warp error | RMS warp error |
|---|---:|---:|---:|---:|
| Teton Range tour | 120 × 150 | 72,000 | 0.5830 m | 0.2727 m |
| Sierra Whitney east | 103 × 83 | 34,196 | 0.5851 m | 0.2697 m |
| San Juan Sneffels north | 93 × 83 | 30,876 | 0.5830 m | 0.2707 m |

Eleven grids, including eight floating-point boundary regressions, covered
42,942 GPU points. The maximum warp-component difference was 0.5850754 m;
the maximum final texture-coordinate position difference was 0.5859375 m.
These are material-coordinate differences, with unchanged terrain vertices.
Every shared atlas corner matched, all outputs were finite, and GL reported
zero errors. Guard-transition increment error stayed below 0.000046 m.

The shader receives the exact planned origin cells even when a world origin
such as 599.99999 m uploads as 600 m. GPU negative controls using the incorrectly
inferred origin produced 250–294 m errors; exact origin binding retained the
intended sub-meter bound.

The ledger admits texture bytes plus a 1 KiB fixed construction allowance
before baking, then retires that allowance. Opaque graphics-driver compilation
memory is unmeasured. Local reproducible source snapshots, raw outputs, atlases
and results are under `.smoke/material-feature-native/`.

### Full-application comparison

```sh
node tools/material-feature-compare.mjs --out .smoke/material-pilot --browser /path/to/chromium
```

Optional `--audio song.wav`, `--view VIEW_ID`, `--times 12000,24000`,
`--frames 60`, and `--hardware-gpu` select the recording, view and timing scope.
The default generates diagnostic audio, pins output/quality, captures two
checkpoints plus six consecutive frames, and warms before measuring.

The tool verifies linked terrain/river materials, the bound cache, exact origin,
format and ledger charge. Camera, music, geometry and other input uniforms must
match. Generated input textures receive actual GPU texel hashes; static assets
use identity-bound validated source hashes. Mirror/backdrop hashes are recorded
as derived outputs because they can reflect the intended material change.
Readback validation uses at most 32 MiB scratch per texture outside measured
loops. Fully flat/unmaterialized captures cannot alone pass. Missing, partial,
unresolved or disjoint timer queries cannot report a zero-cost GPU sample.

Chromium startup in this executor failed with `socket() failed: Operation not
permitted`. The tool saved a failed report with no observed browser renderer,
captures or timings. Full-scene appearance, hardware frame times, driver memory,
live adaptive quality and JOYING playback remain unmeasured.

### Repository checks and review

The full repository run completed with 6,393 passes, three reproduced baseline
failures and twelve skips. Its failures were the existing `buildPixelDetail`
expectation in `cinematicPresentation.test.js`, receiver-fill source assertion
in `landscapeLighting.test.js`, and 50 ms bound in `shotPlanner.test.mjs`.
Final review fixes were followed by 62 passing focused checks, clean repository
ESLint, a 522-module parse/link check and whitespace checks.

Regression coverage includes integer-origin transfer, target/global/manual
viewport and scissor restoration, device pixel ratio, exact cost admission,
optional fallback, stale ownership, context loss, release, partial timer
allocation and same-metadata/different-texel comparisons. The partial-timing fix
was also applied to the preceding gradient experiment.
If room disappears during a preparation yield, the unbuilt cache gives back
its allowance before the surface is retried; reference terrain can still
publish with its original byte charge.
