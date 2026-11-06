# Landscape detail build and scenic expansion

## Intent and design

Implement the owner's November 6 request: add real landscape views, improve
the visual suite, progressively resolve Classic pixels as mountains are built,
and temporarily remove the HUD's plus/minus detail buttons. Current repository
policy authorizes routine implementation decisions without another design gate.

The selected approach is deterministic, bounded raster growth driven by the
same heard-time mountain-rise score. Start at 320×180, advance through small
geometric resolution rungs and finish at the admitted physical picture size.
Keep the authored aspect and framing stable. Retain the default single-stage
composition and JOYING JY-UTS18N12 target, existing memory accounting and quality
governor. Full-resolution rendering throughout followed by artificial coarse
sampling would spend finale GPU work during the opening; per-frame target
resizing would churn buffers and terrain-window plans. Neither is selected.

Saved detail presets remain fixed presets. Dynamic grids are trusted runtime
state, not arbitrary stored preference values. Provide a clear way to turn
growth off. Snapshot/export fixed-resolution contracts and Trio remain fixed.
Palette processing must retain its bounded CPU budget rather than silently
quantizing a full display every frame. Pauses, direct seeks, completed scenes,
quality changes, fullscreen, resize and two-view travel must remain coherent.

Add two genuinely new geographic rail views from pinned USGS 3DEP data. Prefer
fresh bounded terrain bakes over relabeling a shared camera. Keep candidacy,
source attribution, manifest hashes, coverage and visual-review status accurate.

## Task 1: Progressive Landscape resolution

- [x] Add a pure resolution policy with endpoint, aspect, monotonicity, finite
  input and bounded-rung tests; observe the missing behavior before implementing.
- [x] Integrate runtime grids into PixelPresentation/PixelRenderPolicy and
  PresentingRenderer without normalizing them back to Classic.
- [x] Connect heard-time LandRise and stable terrain LOD planning, avoiding
  per-frame target churn and avoiding an added terrain rendering pass.
- [x] Connect output sizing and a Landscape setting in main/index. Make raster
  changes explicit in diagnostics; retain fixed snapshots/export/Trio/Palette.
- [x] Verify pause/seek/endpoints, display resize, quality ceilings, memory
  denial, real single-stage path and default saved-preset compatibility.

## Task 2: Two additional real views

- [x] Select two geographically distinct candidates, verify source coverage
  and landmark coordinates and pin USGS sources through the existing
  bake pipeline; label camera anchors as authored estimates.
- [x] Author rail/framing/material rules and publish bounded 20 m terrain bakes,
  retaining candidate/experimental labels and exact source identities.
- [x] Regenerate the catalog/pins and cover candidate scheduling, framing,
  terrain integrity and flat-to-complete ground coverage.

## Task 3: HUD and visual suite

- [x] Remove the plus/minus HUD buttons and their dead bindings; retain settings
  and keyboard behavior where appropriate. Update the existing UI smoke flow.
- [x] Extend meaningful validation for growth checkpoints and new views; keep
  exact playback/capture outputs separate from CPU or synthetic evidence.
- [x] Run focused suites, lint, module/staging checks and one broad integration
  run; review and fix any introduced failures.
- [x] Publish a reviewable branch/PR with measured results and unavailable
  browser/device checks. Do not claim physical JOYING or visual acceptance from
  tests that never rendered those scenes.

## Review focus

1. Dynamic resolution must not change the camera aspect, jump caption scale or
   restart scene/analysis state.
2. Seeking backwards must restore coarser pixels from the same score, and a
   quiet musical passage must not reverse cumulative mountain construction.
3. Terrain-window LOD must not re-plan on every raster rung or outrun its memory
   admission; allocation failure needs a bounded usable fallback.
4. Manual fixed-grid captures and Palette/Trio must not unexpectedly grow to
   native resolution or alter their stored preferences.
5. New terrain must be real, hash-pinned and covered; source aliases must not
   accidentally reuse an unrelated camera or count as a new region.

## Outcome and limits

Implementation and source validation are recorded in
[the evidence](../../progressive-landscape-detail-2026-11-06.md). Final focused
checks pass; the full run and baseline timing failure are reported separately.
Browser/WebGL and physical JOYING checks remain unavailable. Independent agent
review was blocked by the agent quota; session implementation review caught
several admission/capture edge cases. Publish as a draft pending live review.
