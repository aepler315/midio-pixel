# Range terrain gaps and repeated material detail

Base: `0fab5edb0c4e69b6638f52acaeb5cc21624ba4b1` (merged pixel-mode PR #455).
Investigation and validation: October 14, 2026.

## Observations and retained changes

The user's screenshots show repeated blue surface patches and floating
terrain sections late in a song, in Natural and Pixel. The graphics report
identifies Chugach as the only prepared view, a 3648×2197 scenic target,
438,838,230 resident bytes against a 512 MiB budget, and 2,981 admission
denials. Range was inactive with reason `preparing`; there was no context loss.
The exact song, timestamp, and zoom state were unavailable.

1. **Zoom coverage:** the terrain bake omits occluded tiles. A physical
   user-camera dolly can reveal these omitted tiles even while its frustum
   stays inside the authored cone. A controlled Chugach frame at 255 seconds
   of a 300-second clock reproduces the floating shelf with
   `fx=.72, rx=-.12, uy=.05`. Production static-view zoom now crops the
   projection while retaining the geographic eye and target. The matched
   capture removes those floating sections. Cinematic moves and tour poses
   retain their existing behavior; the general camera helper still supports
   dolly mode for consumers with full terrain coverage.
2. **Repeated stamps:** a material-mask diagnostic attributes most repeated
   patches in the controlled close-up to macro rock detail under blue light.
   A smooth, fixed world-space warp now varies rock and snow texture phases.
   Matched 1280×772 captures show less regular stamping. It adds no texture
   fetches, assets, frame history, or DEM changes. Snow-only sampling and
   glacier-grain experiments did not improve the observation and were discarded.
3. **Preparation recovery:** a completed section could leave its previous
   terrain pinned when the replacement returned early as `preparing`.
   Preparation now refreshes pins first, preserving both travel sides and an
   outgoing late-join fade. A one-view-budget regression reproduces the stall
   before the fix and admits the replacement afterward. This does not prove
   that every view will fit the user's resolution and device budget.

The projection change also requires reflected horizontal crop offsets,
matching cloud-shadow centers/radii, and compensation for screen-sized cast
elements. Independent review found these consumers; failure-first tests now
cover each correction. The existing landscape visibility policy is untouched.

## Checks and evidence

- Focused camera, projection, material-domain, presentation, transition,
  reflection, cloud and cast checks: **144/144 passed**.
- `npm run lint`: passed.
- Final `npm test`: **4,508 passed, 30 failed, 4,538 total**. The untouched base,
  independently extracted with `git archive`, has **4,498 passed, 30 failed,
  4,528 total**. The failure-name sets match exactly. They concern the existing
  landscape policy expectations, null optional controllers, and renderer
  fixtures. No tests were weakened or skipped to hide those failures.
- The standard audio-backed visual evaluator was attempted on both untouched
  base and candidate with the same generated four-second `terrain-contrast`
  fixture, checkpoint 2 seconds. Both fail on their first export frame with
  `Cannot read properties of null (reading 'draw')`. These are failed app
  captures, not visual acceptance evidence.
- Actual production `RangeScene` diagnostic captures use Chromium
  151.0.7922.173 / SwiftShader, seed 315, quality 0, and immutable source
  snapshots. Chugach cases cover progress .85 and 1 (255 and 300 seconds),
  1280×772 at 0/4 MSAA samples, and a 320×193 scenic source with Pixel edge
  policy and zero MSAA. Every compared direct/partition pair loses zero
  opaque terrain pixels. Browser reports contain no shader/page errors and
  disposal returns tracked residency to zero. A post-review Jackson Lake
  render checks the production reflection path; projection tests establish
  off-center reflected coverage. These diagnostics do not include the full
  Canvas sky or final Pixel presentation.

Evidence is ignored under `.smoke/terrain-gaps/`; no captures are committed:

| Evidence | Location |
| --- | --- |
| Original floating shelf / camera correction | `coverage-baseline/`, `camera-fixed/` |
| Matched larger material captures | `final-material-baseline-v2/`, `final-natural-v2/` |
| Low-resolution scene checks | `final-pixel-grid/` |
| Post-review production captures | `post-review-chugach/`, `post-review-lake-v2/` |
| Side-by-side diagnostic review | `comparison.html` |
| Standard evaluator failures | `app-baseline/`, `app-candidate/` |
| Full-suite baseline / candidate logs | `main-baseline-tests.log`, `reviewed-tests.log` |
| Exact failure-name comparison | `baseline-failure-comparison.json` |
| Focused suite / lint | `reviewed-focused.log`, `reviewed-lint.log` |

Actual song playback, uninterrupted transitions under the reported GPU
pressure, NVIDIA performance, and full audio-backed appearance acceptance
remain unverified. The retained changes address the reproduced zoom and
material symptoms plus a demonstrated preparation stall; they are not a
claim that the user's entire reported session has been reproduced.
