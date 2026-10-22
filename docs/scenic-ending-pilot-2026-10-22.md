# Denali ending and transit pilot

**Decision: keep the evidence and reject the higher ending penalty as a default
change.** The actual app reaches a useful final shot, but the changed route has
a more sky-heavy main transfer, less move variety and no clear improvement in
ending readability. Production `weights.endInLink` remains 4. No source camera,
library, budget or approval changed in this iteration.

This continues the [15-library rebuild review](scenic-rebuild-review-2026-10-22.md).
The primary baseline is `75704e30b05c561f85bec98772385bd63122d180`, whose runtime
source is unchanged from `aafb89ee7cc68e655bde9b41937b3742f63b6d7e`. The separate
[candidate asset branch](https://github.com/aepler315/midio-pixel/tree/review/scenic-library-rebuild-20261022)
remains at `d3d0d0462a40a8a0df2e48aa1160ccb55b5b856f`. It does not contain
this experimental planner override.

## What the pacing audit established

Exact CPU replay reproduced all 15 reviewed Anthem plans, including every item
boundary with 0 ms maximum difference. Ten contain a link lasting at least
55 seconds. Four end inside a link: Black Mountains, Denali, Sawtooth and Teton.

The discovery `maxLinkS` setting filters a connecting path by its **minimum
feasible library duration**. It is not an upper bound on the runtime playback
duration; see [the builder](../tools/build-scenic-tours.mjs#L277). The planner
chooses payoff times and the timeline maps cumulative travel through them. In
Denali, 16-second and 128-second payoffs leave a 112-second interval containing
the main transfer. The `linkTime` and long-gap costs are soft preferences that
compete with subject, hero and musical rewards.

The [terminal search](../src/world/terrain/ShotPlanner.js#L850) permits an ending
inside a link only when that particular search state cannot otherwise reach
the end. Its candidate then competes by total cost with endings from other
states. This is not a global requirement to prefer every available shot ending.
A blanket preference is unsupported: an existing synthetic 150-second case can
obtain a shot ending by stretching one shot across the entire song and losing
earlier payoffs. Some Black Mountains alternatives merely reach a final shot
16.58 milliseconds before the song ends, covering one metre without its payoff.
Improving the endpoint label would not establish a useful ending.

Denali had a more promising alternative already enumerated by the search. It
cost 11.806 points more, preserved both payoff times and the hero climax, and
completed a full final shot. Raising the existing ending penalty from 4 to 16
was sufficient to select it on the exact reviewed input. This warranted a
bounded render experiment rather than a product default change.

## Matched actual-app experiment

The baseline immutable public snapshot contains 680 files, with digest
`b234caf5321e4c0c937d60fb1ad4d5ca24dc82c0fe42baa2a99f67e2d57e89aa`.
An external diagnostic snapshot changes exactly one literal in
`src/world/terrain/ShotPlanner.js`: `endInLink: 4` to `endInLink: 16`. Its digest
is `abd420ead83060fb3822bb50256a84c972a87aa8933dbd598a134e38577a9ad5`.
All files were verified against their hashes. The primary application files
were not edited. The experimental weight is global within that frozen runtime;
this is not an implemented regional configuration or an outro-only camera edit.

Both arms use actual upload, audio analysis, worker planning, camera timelines
and production scene rendering. They use identical candidate packages and the
same Anthem WAV, SHA-256
`a691d46ebb2575a1ff5841960a50e39acb41cd085852f0a6b59030354b8fca90`,
duration 167984.76190476192 ms, construction seed 315 and actual song seed
2031031581. Chromium 156.0.8078.4 reported NVIDIA RTX 3060 through D3D12/ANGLE.
Quality is 0, viewport 640×360, with continuous export-clock drawing from zero
through the ending at 4 fps.

The identical capture manifest was selected before inspecting candidate images.
It combines both plans' shot midpoints/payoffs, link entries/interiors/arrivals,
vector/tangential/yaw hotspots, the former sky passage and fixed checkpoints.
Fifteen merged motion windows span 83.138 seconds of requested saved footage
per arm. Each arm saves 338 PNGs, including two standalone checkpoints. All
30 motion windows and the standalone checkpoints were visually inspected across
the primary reviewer and an independent reviewer. The independent review covers
the opening, main transfer and ending (three windows and 115 frames per arm);
the primary review covers the remaining windows and standalone checkpoints.
Both captures and the repository's matched comparison completed successfully;
the comparison's automatic quality verdict remains `unreviewed`. The explicit
editorial decision is recorded separately below.

| Actual plan or measurement | Baseline, weight 4 | Diagnostic, weight 16 |
| --- | --- | --- |
| Opening | Traverse assigned to `peak-w15040-s25730` | Valley assigned to Mount Foraker |
| Played move families | Traverse and valley | Valley and valley |
| Main transfer | 35.778–110.882 s; 75.104 s | 35.079–103.146 s; 68.067 s |
| Final hero shot | 110.882–148.864 s | 103.146–167.985 s |
| Final transit | 148.864–167.985 s; 19.121 s | Removed |
| Payoff times | 16 s and 128 s | 16 s and 128 s |
| Strong-hit outcome | 2 of 5; hero climax | 2 of 5; hero climax |
| Maximum tangential acceleration, 60 Hz timeline samples | 1.394 m/s² | 0.916 m/s² |
| Maximum yaw, 60 Hz timeline samples | 3.969°/s | 3.376°/s |
| Minimum saved drawn-surface fraction | 30.698% at 70.250 s | 17.311% at 67.750 s |

Both actual worker plans match the CPU control. Both rendered camera positions
match their timelines with zero measured eye error; maximum direction error is
below 8×10⁻¹⁶. Neither capture reports an application error. Both retain the
same three wake-lock/fallback-video warnings from the headless environment.
Matching controls and legal motion do not settle the visual decision.

## Rendered findings and disposition

- **Anthem 10.000–19.750 s:** the diagnostic opening shows broader layered
  ridges than the baseline's dominant foreground snow dome. Its configured
  payoff subject changes to Mount Foraker; the image review does not independently
  identify the mountain from its silhouette. The later 21.100–24.850 s passage
  still contains substantial near slopes.
- **Anthem 61.000–75.250 s:** the diagnostic main transfer has a thinner strip
  of terrain below a larger sky field. At 68 seconds its drawn-surface fraction
  is 17.359%, versus 32.195% in the matched baseline. Twenty-one of its 58 saved
  frames in this window have less than 20% drawn-surface depth coverage; the
  baseline has zero such frames. This auxiliary depth measurement includes
  production terrain, mapped water and trees and is not final-color sky segmentation.
  No saved frame is entirely sky. This is a visible composition regression
  despite passing the existing terrain-presence floor.
- **Anthem 101.142–112.625 s and 126.000–137.308 s:** the diagnostic arrives on
  the final valley earlier and reaches the same 128-second payoff. The inspected
  joins retain continuous travel. White-snow/illumination pulses remain in the
  footage; their material/weather causes were not isolated by this experiment.
- **Anthem 146.858–160.175 s and 163.975–167.975 s:** the diagnostic stays on the
  final valley instead of starting the return transit. Both endings retain
  broad ridges but remain dark and low in contrast. No clear readability gain
  justifies the weaker transfer and repeated valley moves. The 68.067-second
  main transfer also remains long.

Retain the broader opening as a useful reference and preserve both complete
captures. Do not adopt weight 16 from this experiment. The next Denali camera
iteration should compare lower-aim or more compact connecting alternatives
while preserving useful opening and payoff compositions under the existing
fit and motion limits. A positive terrain-depth fraction is a presence check,
not a composition score; these measurements do not establish a universal sky
quota. Named-Denali shot retention, geographic readability and lighting need
separate attribution and review.

## Controls, evidence and limits

The 15-view weight control reproduces every baseline and changes only Denali's
selected plan on these exact Anthem inputs. All 15 retain identical payoff
times and search statistics. Black Mountains, Sawtooth and Teton still end in
transit. Denali with Anthem seed 0 also still ends in transit at weight 16;
its 150-second Anthem, Drop and Short holdouts keep their selected sequences.
The minimized external reproduction contains one positive control and one
intentional failure of a proposed editorial preference under the current
default. It is not a newly failing product regression test.

Local evidence stays outside Git under
`verification/rebuild-20261022/denali-ending-pilot/`: experiment provenance,
matched manifest/window selection, the 15-view replay, holdouts, manual review
and a side-by-side gallery. Original capture directories are
`.smoke/rebuild-20261022/denali-ending-pilot-baseline`,
`denali-ending-pilot-candidate` and `denali-ending-pilot-comparison`.
The main actual-app gallery links to the pilot without replacing any R1/R2
review. PNG hashes and actual timestamps remain authoritative; audio-backed
MP4s are lossy viewing copies with a possible held final-frame tail.

This is representative saved-window review at a fixed export cadence, not
continuous human observation, live playback/device FPS, auditory assessment or
camera approval. Matching audio is retained for audition. No primary application source
or assets changed, so the existing full-suite result remains 4,971 passes, two
baseline-reproduced failures and six skips; it was not rerun for this
documentation-only continuation. The [source validation record](scenic-rebuild-review-2026-10-22.md#source-validation-snapshots)
retains those failures and the separate browser checks.

The approved geographic count remains **13**. The three first-wave locations
and all rebuilt shot tours remain candidates. This pilot adds no view and
changes no seam, base or tour acceptance state.
