# Stable material-feature pilot plan

**Goal:** Replace repeated stable material hash work with a bounded GPU lattice.

**Spec:** `docs/material-feature-experiment.md` and the selective-distillation brief.

**Architecture:** Bake four corner hashes into RGBA8 once per prepared source
grid, reconstruct the original cubic noise in the terrain fragment shader, and
enable admitted caches by default, retaining explicit and automatic reference fallbacks.

**Constraints:** 256 KiB hard output cap; no new terrain uniforms; GPU hash
generation; all geometry, live normal weighting and material classification
remain in the existing renderer; actual evidence controls claims.

## Work

- [x] Implement lattice planning, shared hash source, GPU bake and cleanup with focused tests.
- [x] Integrate cache admission, binding, cancellation, release and diagnostics in RangeScene.
- [x] Integrate validated material selection without changing vertex/forest shaders or mobile uniform counts.
- [x] Validate actual GLSL bake/reconstruction; record unavailable full-scene measurements.
- [x] Add comparison tooling, run proportionate repository checks, review and prepare the independent pilot PR.

## Review focus

- Negative coordinates and exact lattice boundaries must remain supported.
- Bake and live shader must share the same hash calculation and coordinate origin.
- The optional cache must not evict active views or outlive its prepared owner.
- Fallbacks must bind the original material rather than sample an ordinary soil map.
- Normal, slope and material rules must continue responding to live deformation.
