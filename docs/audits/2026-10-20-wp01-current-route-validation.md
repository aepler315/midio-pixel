# WP01: current staged routes and diagnostic acceptance

> Historical record. The scope, preservation rules, approval/hold decisions and validation steps below describe this past task, not current development prerequisites. Experiments and local commits follow the [current development policy](../experimental-development.md). Recorded results and runtime eligibility remain evidence of the version reviewed.

Date: October 20, 2026. Implementation base: `cace36893003e4161b243f22a69204be17181df6`.

This implements the first package in the [independent consolidated roadmap](https://github.com/aepler315/midio-pixel/blob/b469304bebb1cb3f8ed27e46dfb5ca61a5ced933/docs/audits/2026-10-20-astra-sol-independent-consolidated-audit.md). It strengthens C40 route coverage, C42 graphics diagnostics and C39 source-comparison provenance. Changes are limited to validation tools, tests, documentation and manual workflows. Application source and rendered behavior are unchanged.

## Implemented contracts

| Area | Behavior and evidence |
|---|---|
| Ordinary staged routes | `npm run test:routes` freezes staged `index.html` and `src/`, serves them on isolated loopback, and uses four fresh headless contexts: default Landscape v2, UI-selected Tetons, Tetons persisted through clean navigation in the same context, and Trio selected before upload. It does not inject a renderer, world gallery or export path. |
| Actual playback and output | Each route requires a real decoded source buffer; running, advancing audio/context/simulation/heard clocks; audio still within the decoded duration; no preparation hold or world-picker modal; and multiple completed presentation IDs matched to the final capture source. Pixel changes alone cannot pass. |
| Failure ownership | A route deadline closes its context, bounds best-effort diagnostics and preserves a failed report. An abandoned operation cannot later mark itself passed. A native browser regression blocks the renderer in JavaScript and verifies all four deadlines settle with nonzero CLI exit and a failed report. |
| Graphics diagnostics | Shared instrumentation retains original message, browser severity, phase and fatal disposition. Both `INVALID_*` and `GL_INVALID_*` graphics warnings, shader/program failures and unexpected native context loss fail acceptance. Native loss is observed on connected and detached WebGL canvases; wrappers preserve native context return values and release their observation state. |
| Final acceptance | Fatal diagnostics arriving during context closure invalidate a saved success. Earlier causal errors remain intact. All shared visual-evaluation consumers perform the final diagnostic gate after lifecycle cleanup. |
| Comparison provenance | Visual comparisons retain both commit labels, public digests and working-tree states. Identical public digests are repeatability, including documentation-only different commits. Same-commit changed bytes are working-tree comparisons. Clean distinct commits with different public bytes are committed-source comparisons; missing cleanliness remains unverified. Visual verdicts remain unreviewed. |
| Manual workflows | Core browser validation and optional staged Pages deployment retain legacy/gallery smoke and add the current-route suite. Visual evaluation, terrain shading and forest close-ups accept explicit optional `baseline_ref` inputs, retain both actual commits/digests and label repeatability, same-source toggles and historical Phase 1 references accurately. All workflow triggers remain manual; no hosted jobs or deployments were dispatched. |
| Documentation | Current presentation summaries describe Uniform sampling. Historical Depth evidence remains preserved and is marked historical. The validation matrix distinguishes startup/live route coverage from separate transition/device gates. |

## Verification

The final frozen implementation produced:

- Root Node suite: **4,834 tests; 4,827 passed, 0 failed, 6 skipped, 1 TODO**. The one TODO is the known C01 planner failure below.
- ESLint: exit 0. Companion `ridgeview` suite: 26 passed, 0 failed. Site staging: exit 0.
- Final current-route repeat: **failed (exit 1)** in headless Chromium **153.0.8010.12**, using ANGLE Vulkan SwiftShader for Landscape/Tetons. Default Landscape and Trio passed. Both selected and persisted Tetons retained fatal `texSubImage2D: no canvas` and `GL_INVALID_VALUE: glTexStorage2D` warnings during live playback, plus a 30-second Playwright screenshot timeout. The final report remains failed. A preceding complete 120-second-fixture run passed all four with zero errors/warnings; both results are retained. This establishes that the gate detects C42 recurrence, not that the underlying renderer issue is fixed. The repeat ran alongside the Node suite; no causal workload attribution or device performance claim is made.
- Native diagnostics tests include connected/detached canvas losses, exact archived `GL_INVALID_VALUE` text, prefixed invalid-operation warnings and late cleanup warnings. Comparison tests cover same-runtime different commits and dirty/unknown provenance.
- Five modified workflows parsed with `workflow_dispatch` as their sole trigger; all 34 shell blocks passed syntax checks. The baseline owner additionally executed 21 provenance-script scenarios against temporary Git repositories, including distinct documentation commits with identical public bytes and historical trees missing the helper.
- Independent review identified timeout ownership, ended-buffer false acceptance, detached-canvas loss, prefixed warning classification, discarded consumer events, commit-only comparison labels and late acceptance races. These were corrected before publication; final review found no remaining blockers.
- `git diff --check`: clean. No `src/` change or captured evidence is part of the commit.

Frozen public source digest: `6ab27207666b50772cf8bf3685cb999a31930ff7692702b17d92452c0ddbbc11`.

Generated audio SHA-256: `0bbee2957cc72a3e4214a84c3bb67dac20871f9796be0e43014fc2da7224be85`. It is the deterministic 120-second kick/hat/melody signal from `tools/gen-test-wav.mjs` at 120 BPM. Only observed playback windows are checked; a full 120-second listening or endurance pass is not claimed.

**Release acceptance remains blocked by the failing repeated tour cases.** The C42 warning-acceptance gap is repaired; its underlying graphics cause and visual impact remain unresolved. No hosted validation, merge or deployment was performed.

The first attempt used 24 seconds. Default Landscape and Trio passed, but software-GPU tour startup outlived the decoded recording and selected/persisted tour observations timed out. That failed run was retained. The harness uses longer audio, validates remaining duration, and still treats a timeout as failure. The longer fixture does not relax any route, completed-frame or diagnostic gate.

## C01 remains open for WP03

`test/tourPlannerRegression.test.mjs` uses the actual published Tetons package and production planner/timeline with a minimized intro/verse/outro role schedule. The 60-second and 120-second controls complete. The desired 90-second completion fails with `Tour timeline has no feasible aim state`, recorded as an explicit Node TODO. WP03 must repair the planner and remove that marker. Passing the generated browser fixture does not close this input-dependent failure.

## Reproduce and continue

```sh
npm ci --ignore-scripts
npm test
npm run lint
npm --prefix ridgeview test
npm run stage:site
npm run test:routes -- --site-root _site --out .smoke/current-routes-fresh
```

Use Node 24 and set `PLAYWRIGHT_CHROMIUM_PATH` if Chromium is installed outside Playwright's default path. The output directory must be new. `--audio PATH` uses a supplied recording. Reports, PNGs, audio and logs remain outside Git; the manual jobs retain `.smoke/` artifacts.

This package covers current-route startup and observed live playback. The legacy suite retains pause/resume/replace/stop coverage; specialized seek, export, lifecycle and context-recovery suites remain separate. Real music, Firefox/WebKit, physical-device memory/endurance, native-GPU pacing and musical/artistic acceptance remain unverified here. Bulk-export correctness and real codec/cap-boundary recording are future roadmap gates.

The next integrity package is WP02: preserve earned library metadata through incomplete scans, stale pruning and cross-tab root allocation, then address reconnection identity. WP03 follows the known tour-planner failure; WP04 protects output paths and recording truth. Their application fixes are not implemented by this validation package.
