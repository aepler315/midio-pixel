# Deformation-gradient pilot implementation plan

**Goal:** Implement and compare a compact version of the existing normal-gradient stencil.

**Architecture:** A compile-time material variant selects reference or factored
GLSL. The factored path shares the vertical stencil's geographic inputs;
the vertex displacement and other shading remain unchanged.

**Tech stack:** ES modules, GLSL3, Three.js, node:test, Playwright.

**Spec:** `docs/deformation-gradient-experiment.md` and the user's selective-distillation brief.

## Global constraints

- Factored gradients are now the default at the owner's request; retain explicit reference comparison.
- Add no texture, uniform, geometry or asset residency.
- Preserve the one-meter stencil and all sampling/clamp boundaries.
- Claim only observed outcomes; JOYING validation remains device-specific.

## Review focus

- Short height spans clamp at minimum plus max(1, span).
- Receiver/hierarchy variation cancels vertically only where tour fade permits.
- Actual material defines must match the requested comparison mode.
- Timing must exclude invalid/unresolved/disjoint GPU queries.
- Browser launch failure must be reported as a blocker, never a passing render.

## Tasks

### 1. Factor the gradient

- [x] Add tests executing scalar production GLSL against independent six-call reference cases.
- [x] Run failing tests, implement `FACTORED_DEFORM_GRAD_GLSL` and query selection in `DeformationGradient.js`, then rerun.
- [x] Select the helper under `FACTORED_DEFORM_GRAD` in the terrain fragment shader.

The helper stays in `TerrainMaterial.js`, preserving the shared `TerrainDeform.js`
and forest shader source pins. The pin regression was reproduced and verified
fixed without updating hashes.

### 2. Connect and identify the material variant

- [x] Add material tests; observe failures before implementation.
- [x] Add `deformationGradient` option, define and metadata in `TerrainMaterial.js`.
- [x] Wire terrain/river material creation and requested/drawn snapshot in `RangeScene.js`.
- [x] Verify integration, expression, hierarchy and rise checks.

### 3. Compare and deliver

- [x] Add a bounded fixed-quality comparison harness using existing evaluation helpers.
- [x] Verify invariant gates, valid timing handling and focused lint/tests.
- [x] Attempt actual shader/render validation; record environment limitations.
- [x] Run broad validation, identify baseline/environment failures, review the branch, and document results.
- [x] Package the reviewable branch and PR description with evidence and remaining device work.
