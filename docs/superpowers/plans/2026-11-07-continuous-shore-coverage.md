# Continuous Shore Coverage Implementation Plan

**Goal:** Reduce native shoreline color popping during camera movement while
retaining the current terrain raster, rendering path and source water policy.

**Architecture:** Filter material appearance from the existing world-anchored
coverage and fragment derivatives. Keep binary source classification separate
from appearance; no new render resources or texture reads.

**Tech Stack:** Existing GLSL3 terrain shader and Node behavior tests.

**Spec:** `docs/superpowers/specs/2026-11-07-continuous-shore-coverage-design.md`.

## Constraints and review focus

- JOYING JY-UTS18N12 remains the minimum target; preserve single-stage rendering.
- Uniform dry/wet interiors must retain their existing output and fast paths.
- Water-only, debug, mapped river, glacier and Direct separation behavior remains
  governed by source classification and existing pass ownership.
- Avoid a new hard switch in forest/material skip or optical contributions.
- Native spatial detail remains bounded by the working raster; report it plainly.

## Tasks

- [x] Add a failing regression for a moving shoreline using production shader
  scalar logic: neighboring camera phases must change appearance continuously,
  including derivative-width extremes and dry/wet endpoints.
- [x] Filter native shoreline material appearance in `TerrainMaterial.js`,
  keeping one material evaluation and preserving classification/ownership guards.
- [x] Verify water, mirror, shader, scene/camera/ocean and renderer contracts;
  run lint/module checks and obtain an independent review.
- [x] Record actual results and browser/device limitations; commit a focused
  reviewable change only after verification.
