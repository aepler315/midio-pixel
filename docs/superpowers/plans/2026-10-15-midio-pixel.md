# Midio Pixel implementation plan

> Historical plan: the user subsequently removed Depth scaling and requested a smooth Landscape sky experiment. Current behavior is documented in [Display presentation](../../pixel-presentation.md).

**Goal:** Deliver the separate pixel-only repository without losing upstream pixel capabilities, adding physical depth scale.

**Architecture:** Preserve the existing scene renderer and pixel presentation. Enforce pixel-only at display ingress; add depth sampling inside the existing scenic GPU copy, with independently owned depth attachments.

**Tech stack:** JavaScript modules, Canvas2D, Three/WebGL2, Node 24 tests, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-15-midio-pixel-design.md`.

## Global constraints

- Original repository remains unchanged; retain exact source baseline and provenance.
- Preserve all worlds, lighting, weather, audio, palette, grid, export, accessibility and Auto quality behavior.
- Default Pixel / Classic / Auto / Depth; `pixelScale` choices are `depth` and `original`.
- Palette remains supported. Original scale bypasses all new scene sampling.
- Preserve alpha and suppress cross-surface samples; reset copy uniforms per use.
- No captured evidence in git; use `.smoke/` and CI artifacts.

## Review focus

Stale Natural preferences and raw export overrides must remain pixelated. Context loss/resize/quality changes must not leak depth textures. Night and disabled shafts must retain depth scaling. A/B travel must not share stale depth state. Classic pixels and palettes must keep their current colors and raster behavior when Original scale is selected.

## Tasks

- [x] Reconstruct and hash-verify all 1,431 source files; preserve an immutable baseline.
- [x] Capture the pinned pixel baseline and run its unit suite.
- [x] Add regression tests; implement pixel-only preferences/controls/exports, isolated storage, branding and domain-neutral staging. Files: DisplayProfile, PixelPresentation, main/index, BulkExport, associated tests/tools/docs.
- [x] Add depth-scale behavior tests; implement PixelDepthScale, PixelRenderPolicy, RangePresentation/RangeScene and SunShaftGL lifetime changes. Test original bypass, distant identity, continuity, alpha/depth guards, travel texture ownership and reset behavior.
- [x] Update relevant browser tools and validation fixtures for pixel-only, and add focused depth evidence. Retain necessary shared rendering tests.
- [x] Run full unit tests/lint and focused real-browser captures. Inspect original equality and depth behavior; fix concrete regressions.
- [x] Independent code review and covering fixes.
- [x] Populate the private destination with the preserved source and reviewed implementation; verify remote commit/tree and CI status.
