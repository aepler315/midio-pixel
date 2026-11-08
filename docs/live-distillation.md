# Live scene distillation defaults

The owner requested that the implemented optimizations become live by default,
and that work continue on distant forests. This release combines the gradient
and material-cache changes with a bounded statistical-canopy handoff. Normal
application loads require no experiment query strings.

| Path | Normal behavior | Explicit comparison override |
|---|---|---|
| Terrain tilt | Factored one-meter gradient stencil | `deformGradient=reference` |
| Stable material noise | GPU hash lattice when admitted | `materialFeatures=reference` |
| Tiny distant crowns | Blend to the existing live mean canopy | `canopySummary=reference` |

`off` and `0` also disable the selected path. Invalid explicit values select
the reference. Material cache denial, invalid bounds, a failed bake or lost
preparation room keeps reference material sampling; the other optimizations
remain active. Terrain vertices, musical displacement and depth transforms
retain the same source path.

## Distant canopy

The renderer already computes mean canopy coverage and lighting before its
individual painted-crown search. The new handoff uses the local mean crown
diameter divided by the projected lateral pixel footprint:

- At or below 0.75 pixels, keep the statistical canopy and skip the search.
- From 0.75 to 1.5 pixels, smoothly blend individual detail in.
- At or above 1.5 pixels, retain the existing individual-crown result.

The existing quality, distance, reach, vertical-footprint, placement, water and
habitat gates still apply. Mean canopy density, palette and view/light response
remain live. No new GPU textures or uniforms are introduced by this handoff.

## Release validation

- 98 focused checks passed, including real no-query `RangeScene` construction,
  combined material defines, explicit reference controls, cache fallback,
  resource cleanup, forest rules and the conservative mobile uniform budget.
- Repository ESLint, 524-module parsing/linkage and whitespace checks passed.
- Native GLSL ES checks on llvmpipe compiled 36 actual material configurations:
  all three defaults plus all eight feature combinations across desktop/mobile
  and terrain/river variants.
- The 32,768-point gradient fixture retained maximum component error
  `7.6294e-6`, normal-vector error below `3.45e-6`, and identical displacement.
- The 42,942-point material fixture over eleven grids retained maximum warp
  error `0.5850754 m`; guard transitions remained continuous.
- An unresolved 0.51-pixel canopy fixture retained mean coverage `0.0082445`
  while its individual-search branch ran zero times versus 4,096 reference
  entries. Small resolved and mature resolved stands produced identical RGBA
  results with the handoff enabled. These are controlled shader fixtures,
  not full-scene artistic judgments or a hardware frame-time measurement.

The fixtures used identical current terrain shaders and recorded source hashes.
Scripts and raw results are in `.smoke/live-distillation-native/`. The known
repository baseline failures concern the Cinematic `buildPixelDetail`
expectation, receiver-fill source assertion and shot planner's 50 ms bound;
full-run results are reported with the release PR.

Chromium launch in this executor remains blocked by socket permissions.
Hardware FPS, full-scene appearance, adaptive-quality behavior and JOYING
playback remain unmeasured. Default activation is the requested rollout choice,
separate from those outstanding measurements.

## Publication

The active Pages publisher deploys `main` to `https://supermaudio.com/`.
Verify the deployment's revision and the changed live modules rather than
the optional staged `version.json`. Existing application tabs need a reload
to load the new module defaults.
