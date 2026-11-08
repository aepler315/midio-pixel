# Deformation-gradient distillation pilot

## Intent and scope

Start the selective-distillation proposal with the smallest shader experiment:
reduce repeated work estimating terrain tilt while retaining the existing
one-meter central stencil. Keep displacement, camera, musical coefficients,
growth, materials, glacier blending, and subsequent normal transport live.

The pilot is available through `?deformGradient=factored`. The default and
`?deformGradient=reference` retain the six-call implementation. Unknown values
fall back to the reference. Material defines and scene snapshots identify the
selected implementation; a URL alone is not proof of activation.

## Approaches

1. **Factor the existing stencil (selected):** share the center receiver,
   hierarchy and musical harmonic between the two vertical samples. Retain
   four horizontal evaluations, original sampling positions and height clamps.
   This needs no new assets, textures or uniforms and introduces floating-point
   reordering rather than an intentional loss of spatial information.
2. **Analytic derivatives:** evaluate the continuous musical derivative and
   sampled geographic derivatives. Potentially cheaper, but changes the
   finite-stencil behavior at receiver and height boundaries. A later experiment.
3. **Stored gradient maps:** precompute stable geographic derivatives. Adds
   texture residency, filtering/error policy and preparation work; unnecessary
   for this first comparison.

In ordinary non-tour rendering the common hierarchy contribution cancels from
the vertical difference. During a tour it remains multiplied by the two
original fade samples. Horizontal shoreline/hierarchy samples stay live.

## Acceptance and evidence

- Compare the actual scalar GLSL calculation against the six-call reference,
  including zero/full receiver values, height-clamp shoulders, short height
  spans, all musical channels, hierarchy, and tour-fade shoulders.
- Verify identical vertex shader source and no additional uniforms or assets.
- Capture matched fixed-quality scene states and a moving sequence; reject
  mismatched cameras, geometry, music, presentation, or inactive variants.
- Report valid GPU timer samples separately from CPU submission times. Missing,
  disjoint or unresolved queries cannot become zero-cost measurements.
- Keep captures under `.smoke/`. Report startup failures and unrun checks.
- Enable by default only after useful measured performance and visual evidence,
  including the JOYING target. Compiler common-subexpression elimination may
  already remove some of the repeated work.

## Results

The implementation shares work in the terrain/river fragment shaders only.
The common displacement shader remains byte-identical, and the existing forest
shader pins pass without regeneration. No textures, uniforms, terrain geometry,
or preparation assets were added.

Before compiler optimization, receiver lookups decrease from six to five.
Enabled hierarchy lookups decrease from six to four outside tours, or five
with a tour fade. The two musical sine terms are evaluated ten times instead
of twelve. These source counts do not establish a GPU performance gain.

### Numerical shader validation

The current terrain and river shaders compiled and linked in reference and
factored modes through surfaceless EGL, GLSL ES 3.00, Mesa 25.0.7,
`llvmpipe (LLVM 19.1.7, 256 bits)`. A float-framebuffer fixture compared 32 cases
of 1,024 source points with nearest/linear receiver and hierarchy textures,
clamped texture edges, height clamps and tour-fade shoulders.

| Observation | Result |
|---|---:|
| Point comparisons | 32,768 |
| Maximum absolute gradient-component difference | 0.00000762939453125 |
| Maximum normal-vector difference using the production inverse Jacobian | 0.00000321892685 |
| Displacement difference (`deformAt`) | 0 |
| Nonfinite outputs / GL errors | 0 / 0 |

The differences occurred in the vertical component when the common hierarchy
term was cancelled outside tours. This is software GLSL numerical evidence;
it does not establish final-image equivalence, browser behavior or hardware speed.
Local evidence is under `.smoke/deformation-gradient-native/`.

### Browser comparison

```sh
node tools/deformation-gradient-compare.mjs --out .smoke/gradient-pilot --browser /path/to/chromium
```

Add `--hardware-gpu` to require a hardware renderer, `--audio song.wav` for a
recording, and `--view VIEW_ID` for another scene. The default generates a
40-second diagnostic WAV, uses the Jackson Lake view, pins quality and output,
captures two checkpoints plus six consecutive frames, and warms before timing.
It verifies actual material activation and matching scene inputs. Fully flat or
zero-deformation captures are labeled unexercised and cannot alone pass.

The browser attempt in this environment failed during Chromium startup with
`socket() failed: Operation not permitted`. The harness retained a failed report
with zero captures and no observed renderer or timing. Full-scene appearance,
performance, loading/transition memory and JOYING playback remain unmeasured.
The reference therefore remains the default.

### Repository checks

- All 54 focused tests passed, including the new scalar/material/comparison
  tests and existing hierarchy, expression, rise and forest shader checks.
- Repository ESLint, the 522-module parse/link check and whitespace checks passed.
- Broad branch and clean `788d7a1` runs hit a 240-second deadline; the remaining
  files were run separately. The suite is not green. These failures were
  reproduced on both trees:
  - `cinematicPresentation.test.js`: export expects `buildPixelDetail: true`
    while current behavior returns `false`.
  - `landscapeLighting.test.js`: the receiver-fill shader-source assertion
    expects an older conditional.
  - `shotPlanner.test.mjs`: the existing 50 ms timing bound is exceeded on this
    executor.
- Independent review found no production blocker. Its evidence-gating finding
  was fixed: silent or fully flat captures cannot alone pass the benchmark.
