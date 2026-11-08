# Trio presentation, build detail and distant edges

**Goal:** Render Trio smoothly and cap Landscape's gradual build detail at the former Detailed raster, 640×360.

**Architecture:** Keep Landscape's existing pixel presentation and its 24 music-driven growth rungs. Give the Trio experience an output-resolution presentation with no palette, dithering or cinematic cell reconstruction. Keep user display preferences available when returning to Landscape.

**Stack:** Existing canvas presentation, Node tests and ESLint. No new dependencies.

## Tasks

- [x] Cap `landscapeResolutionPlan` using `PIXEL_GRIDS.detailed`; test large and small fit/cover layouts, monotone growth, seeking and allocation fallback.
- [x] Make Trio smooth across title, playback, resize, recording and export; test experience changes and retained Landscape preferences.
- [x] Audit the supplied distance-artifact screenshot against the current source before changing shaders.
- [x] Stabilize wave filtering at shoreline boundaries by computing input gradients before varying branches and fragment discards; test finite footprints and unresolved-wave suppression.
- [x] Run combined behavior tests, lint, module checks and independent review.
- [ ] Publish a reviewable branch and PR.

## Distance-artifact investigation

The supplied screenshot is named `Screenshot_20261107_155006_Chrome.png`.
The current base, `f721305`, includes the later shoreline correction in
`94eef03`: native wet/dry material appearance blends using continuous
world-anchored coverage and fragment derivatives. Its behavior is checked by
`test/nativeShoreCoverage.test.mjs`. The flat opening already shares one
featureless shader between terrain and the infinite ocean.

The audit also found that water-wave filtering computes fragment derivatives
inside wet/dry branches and after discards. GLSL leaves those derivatives
undefined where adjacent fragments take different paths. Compute the shared
coordinate gradients before those exits, then evaluate phase footprints from
those stable inputs. Keep the existing wave amplitudes and filtering cutoffs.
This corrects a shoreline filtering defect; attribution of the screenshot's
broader distant terraces still needs a matching current render.

The shader rule is documented in the [GLSL ES specification, derivative
functions](https://registry.khronos.org/OpenGL/specs/es/3.2/GLSL_ES_Specification_3.20.html#derivative-functions).

An attempted headless Chromium capture failed during browser startup:
`process_singleton_posix.cc: socket() failed: Operation not permitted`.
Consequently, test evidence does not amount to visual confirmation of this
specific screenshot, hardware performance or JOYING device validation.

## Verification

- The initial full run completed with **6,298 tests: 6,272 passed, 14 failed,
  12 skipped**. It started before the final derivative regression file and
  before asset restoration; final focused reruns below cover those changes.
- Final combined presentation, growth, governor and water suite: **157 passed,
  0 failed**. ESLint, the **520-module** parse/link check and whitespace check
  pass. Independent review covered presentation, resize/capture behavior and
  shader math. Its output-width performance finding was fixed and rechecked.
- The checkout initially omitted large assets through sparse checkout. After
  restoring the committed assets, all **70** asset/material/framing/lifecycle
  tests and the published Monument Valley planner regression pass.
- The broad run also caught one stale water-helper signature assertion; it was
  updated and its complete four-test file passes.
- Five unrelated failures reproduce on untouched `f721305`: cairn rail
  visibility (`castJobs.test.js`), Cinematic export profile normalization
  (`cinematicPresentation.test.js`), an old receiver-fill shader assertion
  (`landscapeLighting.test.js`), mobile uniform headroom
  (`mobileUniformBudget.test.js`), and the under-50-ms planner timing gate
  (`shotPlanner.test.mjs`). These are retained and reported, not relaxed.
- The updated Trio browser smoke has not run; Chromium failed before opening
  a page. No matching current screenshot or physical-device evidence exists.
