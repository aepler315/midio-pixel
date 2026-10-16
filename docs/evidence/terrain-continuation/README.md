# Coherent terrain continuation — 2026-10-01

Implemented on `codex/coherent-terrain-performance-20261001`, from `c7c22e850a92bdea6313653ab03903f587e03e28`. Production and evidence-tool source is frozen at `bc2b82d`; later commits add evidence documentation only. This branch is ready for visual review, with browser, export and physical-device acceptance pending. No new catalog approval, merge or deployment is implied.

## What changed

- Default Range listening is actor-free. The unconditional inhabited shore no longer covers the lower terrain. Actual Renderer tests keep the manager draw path present and assert zero resident passes.
- Dancing Ridge band advection reconstructs from heard time, independently of Simulation's reset travel origin. Existing source-specific 2×/3× tuning remains intact.
- Terrain presence and physical melody release causally through silence on the immutable history clock. Weighted pitch releases with melody activity, so silence cannot abruptly change its wavelength. Calibration uses causal pressure; raw source ownership remains noise-gated. No renderer-owned filter was added.
- Optional per-view foreground composition supplies one shallow ledge or no artificial stage. Support uses nominal height, overscan and the existing glacier offset. Actual outgoing/incoming views own their composition through late joins and budget refusal. Empty stages clear receivers and release the shared target when neither side needs it. Optional allocation failure does not resurrect a broad legacy foreground.
- Nonstandard output sizes use uniform centered fitting, including scenery, fixed ground, captions, HUD, film and heat distortion. Portrait output preserves proportions; a portrait phone still uses its landscape stage.
- Natural-water sky and glint controls are bounded and use the existing shared celestial light. No reflection target or additional full-resolution canvas was added.

## Pilot rollout

Directly making Teton and Monument Valley candidates removed the only approved CONIFER and DESERT views. The catalog tests correctly rejected that regression. Instead, all **13 approved views remain unchanged in the normal picker**. Two separately forced candidates reuse their published terrain packages, camera rails and forest seed. There are 16 catalog entries over the original 14 terrain packages.

| Forced `rangeView` | Composition | Water controls | Status |
|---|---|---|---|
| `teton-jackson-lake-coherent` | Single ledge, at most 12% nominal height | Sky `.65`, glint `1.5` | Candidate |
| `monument-valley-163-coherent` | Single ledge, at most 12% nominal height | Existing dry material | Candidate |
| `pend-oreille-valley` | No artificial stage | Existing source water/ice | Candidate |

Use `?rangeRenderer=v2&rangeView=<id>` on a development build. Optional composition hashes invalidate changed or removed composition metadata without invalidating old metadata-free approvals. Candidate variants inherit no approval. `terrainSourceId` shares baked assets; rebuild the source view and regenerate the catalog, rather than baking a duplicate package.

## Verification

| Gate | Result |
|---|---|
| Baseline full suite | 3,637 passed, 5 GDAL skips, zero failures |
| Implementation full suite | **3,672 passed, 5 GDAL skips, zero failures**; `npm test -- --test-concurrency=4` |
| Final authoring follow-up | 13 approval/glacier tests passed after shared-source build-tool cleanup |
| ESLint and diff whitespace | Passed |
| Staged runtime | Passed dependency-based rebuild comparison, `rebuilt: true`; all 16 catalog entries verified |
| HTTP delivery | Six served staged files match local bytes/SHA256; see `staged-delivery.json` |
| CPU lower-frame coverage | Three candidates, 21 stations, zero uncovered samples; see `coverage.json` |
| CPU projected motion | Twelve fixed-camera synthetic pairs; see `projected-motion.md` and `.json` |
| Independent review | Two important findings reproduced and fixed: melodic silence edge and legacy ground on allocation refusal. Focused re-review confirmed both fixes. |
| Fresh `npm ci` | Offline clean-prefix attempt blocked: `ENOTCACHED` for `yocto-queue`; installed locked-version dependencies were used |
| Current browser/GPU captures and decoded export | Pending: Chromium absent and installation blocked |
| Desktop/physical Android performance | Pending: no physical-device run available |

An initial unbounded final-suite process returned incomplete output without a test summary; it is not counted as a pass. The bounded full run completed with the counts above. Tests verify functional invariants, not final appearance or hardware frame times. The HTTP smoke verifies delivery, not JavaScript execution in a browser.

The coverage tool imports the production 64px overscan, camera attenuation, projection and glacier mapping. Each view has 147,840 nominal and 2,365,440 extreme sample checks across 21 stations. It checks desktop triangles in the lower 12%, including the bottom row. It excludes music deformation, trees, materials and travel compositing, so it cannot approve final pixels. An earlier diagnostic mistakenly used a 32px reserve; its apparent buffer holes were invalid and are superseded by the committed report.

The projected-motion report preserves the actual run-start file hash. A later change to `buildRangeFrame` altered the enclosing source file; `sourceContinuity` records independently compared, unchanged hashes of the three functions used by the synthetic probe. It does not silently relabel that run as a later source capture.

## Direction supported by the measurements

Keep the existing 180m / 6.5%-relief geological limits. At the midpoint, Monument's dense near-feature p95 is 4.51px at nominal 720p; Teton is 0.12px and Pend Oreille 0.43px. These are separate near-feature groups, not universal whole-terrain movement. None of the sampled sustained flanks establishes the proposed 4–10px role. Hydro-pinned vertices move exactly zero.

The next artistic decision is a closer-framing audition on visible flanks, after final-composite motion clips establish which features remain readable. Raising a global multiplier would conceal the difference between nominal displacement budgets and visible motion. No multiplier or cap increase was made.

## Remaining acceptance work

1. Capture final GPU composites for the three forced candidates and Ross, at start/mid/end and 20/50/80% travel seams, quality 0/3/6 and both directions of ledge/no-stage travel. Check target refusal, context recovery and repeated paused draws.
2. Run the existing browser transport and export smoke plus `landscape-performance-smoke.mjs --suite motion`. Compare equal immutable histories through playback, seek, restart and analysis handoff. Decode video/audio and inspect proportions, water, foreground coverage and resident absence.
3. Compare current-source 20–40s response-enabled/disabled clips with real music, including quiet, dense and onset-to-silence passages. Synthetic channel probes do not establish musical quality.
4. Record desktop and physical Android sustained playback with the existing device probe and its published memory/frame-time gates. Do not use screenshot-loop timing.
5. Review Teton's water audition in sun, moon, dusk and key gaps; then approve changed candidates only with actual visual evidence through the existing authoring tool. Broader catalog migration remains gated on those results.

Reproduce CPU coverage with `node tools/range-composition-coverage.mjs`; reproduce projected motion using the command in `projected-motion.md`. Historical screenshots and device evidence remain historical and are not reused as new passes.
