# Scenic pacing, framing and ending follow-up

> Historical record. The scope, preservation rules, approval/hold decisions and validation steps below describe this past task, not current development prerequisites. Experiments and local commits follow the [current development policy](experimental-development.md). Recorded results and runtime eligibility remain evidence of the version reviewed.

The later [climb, pacing and ending review](scenic-climb-pacing-review-2026-10-22.md)
continues the runtime investigation below, including configured climb enforcement,
partial-outro reward and moonlit terrain readability. This record preserves the
R3 geometry-only comparison and its source identities.

The next iteration prioritizes camera quality before more locations. The offline
link generator now hands over horizontal heading and elevation separately when
its normal world-target interpolation cannot be used. Rebuilding Denali's
connections with that correction restores a useful named-Denali candidate. In
the matched actual-app Anthem plan, the configured Denali shot plays at the
128-second payoff and continues to the song end. Keep this revised package as a
candidate; its long transfer, close snow crest and dark ending still need work.

This follows the [15-library R2 review](scenic-rebuild-review-2026-10-22.md) and
[rejected ending-weight pilot](scenic-ending-pilot-2026-10-22.md). The global
ending penalty remains 4. No location or camera approval is added. The approved
geographic count remains **13**; work toward 30 pauses at the existing first
candidate wave while these camera issues are addressed.

## Correcting the fallback aim

For the historical Mount Foraker → Denali direct connection, the two endpoint
views look upward by approximately 12.378° and 11.378°, with a 156.012° horizontal
heading change. Interpolating their full three-dimensional directions along a
great circle raises the middle aim to about 45.3°. This introduced a skyward
excursion that neither endpoint requested.

The fallback in `tools/lib/scenic-links.mjs` now interpolates the shortest
wrapped horizontal heading and the endpoint elevations with the existing smooth
blend. It retains endpoint target distances, FOV, the analytic camera course and
clearance construction. Near a vertical endpoint it borrows the other heading;
existing path validation still rejects illegal vertical endpoint views. The
normal world-target branch is unchanged.

Changing aim also changes the combined travel/aim progress used by resampling.
Resampled eyes, tangents, flow, sample counts and feasible timings can therefore
change. This is not a claim of byte-identical interior motion. All 29 selected
packed R3 links have exactly matching endpoint eye/aim positions. The repaired
direct link's dense packed pitch is approximately 11.379–12.379°; interpolation
and packing have their own small excursions, so this is not a universal runtime
pitch bound.

The new production-builder regression failed on the old source and passes with
the correction. It covers opposing upward/downward views, heading wrap,
horizontal antipodes and rejected vertical endpoints. Independent review found
no actionable defect in this scoped fallback change. The packed R3 audit above
keeps its small interpolation/packing excursions distinct from the removed
45° detour.

## Regenerated connections and fitted Denali package

This is **connection regeneration and reselection from the same 141 fresh scored
shots**, not a new discovery run. Every ordered connection allowed by the
original neighborhood, fanout and reach rules was regenerated and rescored.
Original graphs, shot scores, R2 packages and captures are preserved.

| Step | Result |
| --- | --- |
| Ordered pairs / attempted variants | 1,767 / 7,068 |
| Newly legal variants | 5,912 |
| Variants within the existing 50 s minimum-feasible-duration leash | 1,336 |
| Safe Pareto connections | 830, versus 776 safe connections in the old graph |
| Final selected package | 13 shots, 12 non-rail; 29 links |
| Selected aim branches | 26 normal world-target; 3 heading/elevation fallback |
| Minimum selected sampled CPU terrain fraction | 0.26697530864197533; zero sampled all-sky links |
| Regional added bytes / unchanged cap | 607,399 / 800,000 |
| Fit iterations / holes / budget errors | 1 / 0 / 0 |
| Fitted forest bytes | 8,897,472 |
| Fitted terrain tiles | 472, versus 391 in R2 |
| Reported desktop / mobile triangles | 2,781,014 / 1,333,184 |

The selected named-Denali shot is `valley-denali-022-rev`, assigned to the hero
subject `denali`. The repaired direct Foraker085 → Denali022-rev connection is
2,871.100 m long, has a 35.775 s minimum feasible library duration, and scores
0.594904225 with 0.273919753 minimum sampled CPU terrain fraction. Positive
terrain is a technical presence check, not an aesthetic approval.

The final R3 shots-manifest SHA-256 is
`edfca94bfc203d1ed1fb2c8f7f12e742cca0bbed1769ccacebeb39d54b8a4aa5`;
compressed payload SHA-256 is
`162e6090ea9a5af05b3f3768aa5a3809a7c6a8e4bf0e51c25f4e567a1f2e2192`;
terrain-manifest SHA-256 is
`4eb64980f9c9048da8d9ecfbbf694b6aa7f4c59d107a4bc97f846f8fe8ec9324`.
Package, selected-link, endpoint and build audits are retained outside Git under
`verification/rebuild-20261022/pacing-framing-fixes/`.

## Matched actual-app geometry review

The frozen R2 baseline has 680 public files and digest
`b234caf5321e4c0c937d60fb1ad4d5ca24dc82c0fe42baa2a99f67e2d57e89aa`.
The R3 geometry-only snapshot has digest
`dbb15405b16500340778182ac27432ecfb4bf633bdc4c91dd1d181e6cd9e6f11`.
Exactly six public files differ: the generated catalog and five Denali package
or build files. Worker, planner, timeline and scene runtime source are identical
between arms, unchanged from `aafb89ee7cc68e655bde9b41937b3742f63b6d7e`.
Any later climb-runtime checks are separate from this comparison.

Both arms use production upload, audio analysis, worker planning and scene
rendering with the same Anthem WAV, SHA-256
`a691d46ebb2575a1ff5841960a50e39acb41cd085852f0a6b59030354b8fca90`,
duration 167984.76190476192 ms, construction seed 315 and actual song seed
2031031581. Chromium 156.0.8078.4 reported RTX 3060 through D3D12/ANGLE.
Quality is 0, viewport 640×360, with continuous export-clock drawing from zero
through the ending at 4 fps. The matched window manifest was selected before
candidate-image inspection.

Each arm saves **337 PNGs: 332 in 15 motion windows and five standalone
checkpoints**; 81.962 seconds of requested windows per arm cover the union of
35 original window records. Across the primary and independent reviewers, all
30 saved windows and the ten standalone checkpoint images were inspected.
Both captures and the matched comparison completed, while the comparison's
automatic quality verdict remains `unreviewed`. Editorial disposition is
recorded explicitly below.

| Actual camera allocation | R2 | R3 geometry, unchanged planner |
| --- | --- | --- |
| Opening | Tight unnamed-peak traverse | Valley assigned to Mount Foraker, 0–34.488 s |
| Main transfer | 75.104 s | 34.488–104.403 s; 69.915 s |
| Final shot | Unnamed-valley shot, followed by another transit | Assigned Denali valley, 104.403–167.985 s |
| Payoff times | 16 s, 128 s | 16 s, 128 s |
| Total link allocation | 94.224 s | 69.915 s, 24.309 s less |
| Final state | Inside a return link | Same final shot continues through the ending |

- **Anthem 10–19.75 s:** the revised opening separates near ridges and broad
  background layers, supplying geographic context beyond R2's dominant snow dome.
- **Anthem 62.767–75.267 s:** a close, smooth snowy crest dominates the early
  transfer, gradually passes left and opens the background. The inspected
  sequence has terrain and continuous travel. Close cropping and soft detail
  remain concerns; this is not a uniform framing improvement at every time.
- **Anthem 126–133 s:** the broad rounded background massif has a readable focal
  outline. The actual worker plan plays the shot assigned to Denali at 128 s.
  This verifies metadata-assigned playback, not independent mountain
  identification from the silhouette. Illumination/deformation pulses remain
  unisolated.
- **Anthem 163.975–167.975 s:** the final shot retains its focal massif and a
  restrained heading. Dark gray-blue faces, limited contrast and the cropped
  right foreground ridge still weaken the ending.

Retain this R3 package as a revised candidate. The main transfer still takes
69.915 seconds and the payoff interval remains 112 seconds. Both played moves
are valleys, so move-family variety is limited. Subject persistence improves; final lighting/readability and overall musical pacing remain open.
No global weight change or automatic aesthetic approval follows from this result.

The capture reports are `.smoke/rebuild-20261022/r3-heading-r2-baseline/report.json`
(SHA-256 `8d4ce5df055f4f5e94035a7d0f01c04639f8faf76e0d3dfa9df9dad1a2ffcf15`)
and `r3-heading-candidate-old-planner/report.json`
(SHA-256 `26bce8fc492ecd90458473fdfd52fa17637ae7d466d9a49b23e1449e769dacb5`).
The main actual-app gallery links to the matched geometry review. PNG hashes and
actual timestamps are authoritative; audio-backed MP4s are lossy viewing copies.
Matching audio is retained, but no auditory assessment was performed. These are
saved-window export-clock observations, not live playback FPS, physical-device
performance, whole-tour artistic acceptance or camera approval.

## Climb-limit investigation remains open

A separate source audit found that the configured `maxClimbMps` field (default
22 m/s) was inert in the runtime planner. The old Denali Drop holdout reaches
approximately **27.477 m/s vertical camera motion at 46.644 s**, with about
12.2 seconds above 22 m/s. A minimized decoded-shot control also produces
identical plans and camera keys under climb settings of 1, 22 and 100 m/s.
These establish an ignored configured limit; the documented motion-policy prose
previously described tangential acceleration, yaw and flow separately and did
not promise climb enforcement.

An isolated enforcement prototype bounds the smoothed vertical derivative,
accounts for neighboring spline supports and partial ranges, and checks the
actual Float32 key spline before delivery. Review caught and corrected a
both-support two-sample-link underbound and two false rejections caused by
already-passed or not-yet-reached rises. The prototype changes eight of the
15 exact reviewed Anthem routes, so the original R2 media cannot certify those
new routes. A pre-existing fixture's pacing requirement also regresses from
three payoffs to two despite a still-legal three-payoff alternative.
A later partial-link-ending reproduction still makes the planner accept a route
whose actual key spline reaches 37.333 m/s and is rejected by the prototype's
final guard: the planner included support from a next shot that playback never
reaches. That topology mismatch remains open, along with a conservative-bound
monotonicity assumption in terminal speed search.
The 13 narrow climb regressions pass on the final prototype, but the existing
cold-planning timing gate is unstable across focused runs (approximately 49.4 ms
in a passing run and 51.8 ms in a failing run). Neither that timing requirement
nor the payoff-count test was relaxed.

**This runtime prototype is withheld from the published source and candidate
asset branches.** The working patch, regression tests, exact source hashes and
failed-gate records are preserved outside Git in
`pacing-framing-fixes/climb-prototype/`. Fixing a physical motion constraint must
not silently weaken the existing pacing requirement or transfer old rendered
acceptance to changed routes. The current delivery corrects offline fallback
aiming and retains the reviewed R3 Denali package; it does not claim that runtime
climb enforcement or all pacing/ending issues are complete.

## Candidate delivery and validation

The revised package is prepared on a separate
[R3 candidate review branch](https://github.com/aepler315/midio-pixel/tree/review/scenic-denali-heading-20261022).
It retains the other 14 R2 useful libraries and replaces only Denali's fitted
package and matching catalog/configuration identity. Across the 15 useful
libraries, the revised inventory is **180 shots and 459 links**. The complete
Range asset tree is **64,853,210 bytes**. The original
[R2 review branch](https://github.com/aepler315/midio-pixel/tree/review/scenic-library-rebuild-20261022)
and frozen captures remain intact. These separate candidate branches do not
attach shot libraries to the primary source branch. Use the existing explicit
candidate and shot-tour diagnostic overrides for review; do not mark a base or
tour approved to make it appear in the normal picker.

For the offline heading correction, the source-pinned full suite ran **4,980
tests: 4,973 passes, one failure and six skips**. The sole failure is the
previously reproduced sky-pan assertion at `test/rangeAtmosphere.test.js:213`.
The planner's previous timing failure passed in this run; this does not establish
a timing fix. Lint passed. Five browser cases lacked a configured browser
executable in this full-suite command, and the published-Monument package case
had no attached library on the primary branch. Those skips remain unexecuted
in that command. The matched RTX actual-app captures above are separate checks.

The tested source snapshot is `/tmp/midio-heading-tests-hhakgycn`. Before the
later climb investigation, all 1,577 tracked source files matched it; the two
changed offline source/test hashes are retained in
`pacing-framing-fixes/source-test-verification.json`. Documentation-only updates
do not change that tested runtime or generator source.
