# Monotone second composition pass for tour endings

> Historical record. The scope, preservation rules, approval/hold decisions and validation steps below describe this past task, not current development prerequisites. Experiments and local commits follow the [current development policy](../experimental-development.md). Recorded results and runtime eligibility remain evidence of the version reviewed.

Branch `impl/wp03-monotone-endings`, based on `7b59de6362617154d151f3b3efb6f6ed2336857b` (the published WP03 follow-up). This is a reviewable candidate, not merged or deployed. It applies the rate-limited chase measured in the WP03 follow-up **without losing any coverage the WP03 planner already provides**. It ships two modes: the default (misses only), and an opt-in intended-upgrade mode wired end to end and enabled by `?rangeTourIntended=1`.

## Design

`buildTourTimeline` now runs WP03's builder unchanged. Its station rebuild and quality-retry recursion stay internal, so pass 2 cannot influence which route WP03 picks. The builder is followed by one second pass on the chosen result, in [TourTimeline.js](../../src/world/terrain/TourTimeline.js):

1. **Protect.** Every hero covered after pass 1 keeps its window exactly. Window frames are compared within 1e-5°, and targets inside protected windows are never rewritten.
2. **Record in-frame subjects.** For each uncovered hero, if its intended subject or an eligible same-role alternative is already projected-covered (≥ 0.8) by the camera as it stands, record it (`retained-in-frame-subject`) without moving anything. This happens before any chase, so no chase can turn away from an unrecorded subject.
3. **Chase remaining misses,** in song order. The same eased ramp is followed at the shared yaw capacity instead of being rejected when its smoothstep peak exceeds it. Saturated frames shrink by the measured slerp turn peak, so sub-frame yaw stays within budget. A ramp must rejoin the unchanged route before its end, except at the song's final frame. Outcomes are `rate-limited-intended-subject` and `rate-limited-distant-alternative`.
4. **Optional, `upgradeIntended` (off by default).** A hero covered by an alternative may try its intended subject, easing from the aim its pass-1 shot replaced. Only that hero's own window is released; every other window stays protected. Success is labelled `rate-limited-intended-upgrade`. This replaces an accepted subject, so it is a product decision.

With pass 2 disabled, the final code is byte-identical to `7b59de6` on all 20 jobs (18 holdout cases and both captures): every published array, `heroFraming`, coverage, notes, quality ratio and hero field. This was re-proven on the final planner, with pass 2 bypassed in a scratch copy. After the runtime plumbing, both modes produce byte-for-byte the same published outputs on all 20 jobs as before it.

## Results

| Check | Default (misses only) | With `upgradeIntended` |
| --- | --- | --- |
| 48 kHz capture (9 heroes) | 7/9, byte-identical to `7b59de6` | **8/9, 4 intended**: final chorus frames intended Middle Teton (0.92); outro covered by alternative `peak-749717` (0.85); target changes 75.9–90.0 s; quality 0.856 → 0.819 |
| 44.1 kHz capture (11 heroes) | 11/11: the 23.45 s verse is recorded as WP01's in-frame `peak-5775431`; camera unchanged | Same as default |
| Strict `acceptedBaselineSubjects`, WP03 and WP01 baselines | Pass on both captures | Pass, except 48 kHz versus WP03 (final chorus: Wildcat Peak → Middle Teton, the deliberate upgrade) |
| Sampled yaw / climb / clearance / held view (25 ms replay) | Pass; excess 0 | Pass; maximum exactly 25.00°/s, excess 0 |
| Independent holdout, 18 cases | 18/18; maximum yaw excess 0.00031° | 18/18; same safety maxima |
| Holdout heroes versus WP03 (201): reporting only, no camera change | 26 recorded in frame | 26 recorded in frame |
| Holdout heroes versus WP03 (201): camera changed | **7 chased** misses now covered by alternatives | 7 chased, plus **6 alternatives upgraded to intended** |
| Holdout heroes versus WP03 (201): regressions | **0 lost, 0 intended demoted, 0 swapped, 0 fraction drops** | 0 lost, 0 demoted, 0 swapped |
| Deferred refinement (`replanTour`), 48 kHz | Commits at 30 s and 60 s: committed prefix byte-identical (0/1,321 and 0/2,521 samples differ). Arrays identical to the baseline's refinement. Gates unchanged. 2–3 committed heroes WP03 reports as `no-uncommitted-approach` (0.00) are recorded at 1.00 with the alternatives still on screen. | Inherited setting. Commits at 30 s and 60 s: prefix identical (0/1,321, 0/2,521); Middle Teton (0.92) and the 0.85 outro survive. Commit at 82 s (frozen through 85 s): prefix identical (0/3,401); the committed Middle Teton shot is retained, and the replanned tail leaves alternative `peak-4209527` fully in frame at the outro (1.00, recorded in frame). Yaw excess ≤ 0.00028°, climb ≤ 30 m/s, floor margin 99.09 m. |

**The 26 records are reclassifications, not new shots.** Each recorded subject is one of the six nearest-bearing candidates pass 1 itself tries (26/26); pass 1's centred ramp toward it had failed while it was already in frame. They are mostly scenery tier (21 scenery, 4 backup, 1 primary), at a median 24.8 km and median |NDC x| 0.13, from same-role pools with a median of 124 points. **The 7 chases** each took the nearest-bearing candidate (scenery tier, centred).

**The two real captures never trigger a default-mode chase,** so default-mode camera changes have CPU and holdout evidence only. No rendered evidence exists for them.

Scenic quality stays within WP03's existing floor of `min(0.8, current)`, but chased shots can cost a lot. Default mode: H05 0.979 → 0.862, H12 0.957 → 0.899, H13 0.818 → 0.806. Upgrades: H11 0.955 → 0.886, H17 0.882 → 0.844, H18 0.883 → 0.838. That budget predates this work; the costs are reported, not approved.

## Tests

[tourMonotoneComposition.test.mjs](../../test/tourMonotoneComposition.test.mjs) adds six tests:

- an in-frame subject is recorded on a held camera, with targets unchanged;
- a miss reachable only at the full rate is covered at 25°/s, and at 12°/s with reduced motion, with yaw within budget at 25 ms and 50 ms sampling;
- a chase that cannot rejoin leaves the camera unchanged;
- a later first-pass shot is never traded for an earlier miss;
- the upgrade flag is off by default, and when on changes only the alternative it is asked to.

On `7b59de6`, four fail as intended (the in-frame record, both chases, the upgrade). On the reverted greedy prototype, the monotonicity guard fails, which is the holdout failure mode it exists to catch.

[tourUpgradeIntendedPlumbing.test.mjs](../../test/tourUpgradeIntendedPlumbing.test.mjs) adds six plumbing tests. All six fail on `7b59de6` and pass with the plumbing. They cover:

- only `?rangeTourIntended=1` requests upgrades;
- the runtime posts the setting, false by default, and serializes it on the previous tour;
- the worker builds and refines with it and reports it;
- `replanTour` inherits it from the previous tour, an explicit `false` overrides, the upgraded shot after the frozen horizon survives, and the committed prefix stays byte-identical;
- RangePresentation requests it on the initial plan and on refinement, and reports `requestedUpgradeIntended` and `effectiveUpgradeIntended`.

The existing `resolveRangeMode` shape assertions in `test/rangePresentation.test.js` now include `upgradeIntended: false`.

All tour, presentation and plumbing suites pass. The full suite (`npm test`, Node v24.10.0, WSL): 4,878 tests, 4,872 passed, 0 failed, 6 GDAL skips. `npm run lint` and `git diff --check` are clean.

## Rendered evidence (RTX 3060, headless, muted)

Matched `landscape-review` captures used the pinned 48 kHz pipeline, the 90 s contrast WAV (`c0160a5c…`), seed 315, quality 0, Classic, and WP03's windows, run on the same renderer for both sides. The baseline is staged `7b59de6` (`99e7db42…`). The upgrade side is a scratch copy of the staged prototype whose only difference is the flag default forced on (`122232cc…`); it is not proposed for commit. The tool's own comparison step refused the staged trees for lacking git provenance, so frames were compared by hash. Each capture report embeds its tour plan. Baseline and default-mode captures show Wildcat Peak (1.00) at the final chorus and the outro missed. The upgrade captures show Middle Teton (0.92) and `peak-749717` (0.85), matching the CPU replay.

| Window | Frames identical to baseline |
| --- | --- |
| Opening 0.5–3.5 s, upgrade | 7/7 |
| Final chorus 81.5–84.6 s, **default mode** | 8/8 |
| Approach 76.0–81.5 s (4 fps), upgrade | 0/23 |
| Final chorus 81.5–84.6 s, upgrade | 0/8 |
| Outro 86.0–89.0 s, upgrade | 0/7 |

What the frames show:

- **Final chorus.** The baseline frames a broad dark wooded ridge with vertical sky bands. The upgrade frames a serrated line of peaks above a low cloud sea, and the sky bands are much less prominent.
- **Approach.** It swings progressively from 77.5 s into layered ridges over valley haze, with no hard cut at 4 fps.
- **Outro.** The upgrade frames distant low ridgelines on a bright cloud layer that fills about two thirds of the frame. The baseline frames a nearer dark ridge over forest fog.

Pixels cannot identify which summit is Middle Teton, establish terrain visibility or subject footprint, or show 60 fps smoothness. No audio was auditioned, and none of this is artistic acceptance.

## Enabling intended upgrades

The setting is off unless the page URL has `?rangeTourIntended=1`. It flows through every layer:

1. `resolveRangeMode` reads the parameter.
2. Each `RangePresentation` built in [main.js](../../src/main.js), including the one created by the tour toggle, takes it as `upgradeIntended`.
3. [RangePresentation.js](../../src/world/alpine/RangePresentation.js) passes it to `prepareTourTimeline` on the initial plan and on every refinement.
4. [TourRuntime.js](../../src/world/terrain/TourRuntime.js) posts it to [tour-worker.js](../../src/world/terrain/tour-worker.js), and also serializes it on the previous tour.
5. The worker calls `buildTourTimeline` or `replanTour` with it.

The published tour records `upgradeIntended`, and `replanTour` defaults to the previous tour's value, so a refinement keeps the mode its tour was planned with. `status().tourPreparation` reports both the requested and the effective setting.

## Limitations

- The pass is greedy within its own scope. It never harms pass-1 coverage, but its order among misses is chronological, not jointly optimal.
- Rendered evidence covers the upgrade flag on the 48 kHz schedule only. It was captured before the URL parameter existed, by forcing the flag default in a scratch copy of the staged site. It does not cover default-mode chases.
- The refinement checks reuse the initial plan rather than the worker's continuation plan. The worker's own refinement path is covered by the fixture test above.
- The 48 kHz pre-chorus remains a large-gap miss.
