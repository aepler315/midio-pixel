# Scenic climb, pacing and ending review

Camera quality remains the priority before further geographic expansion. This
iteration implements the configured climb limit, corrects the pacing regression
that its enforcement exposed, and retains a scoped moonlit terrain-fill change
for readability. The final runtime's CPU controls and complete source suite
pass; the optional published-library case also passes separately with its assets
attached. Matched actual-app review is complete for all 15 Anthem candidate
tours and the natural-seed R2 Denali Drop control. The review records useful
lighting and framing gains while retaining the long-transfer, subject and
ending problems as explicit camera-quality gates.

This supersedes the open climb investigation in the historical
[motion-fixes record](scenic-motion-fixes-2026-10-22.md). The original
[R2 review](scenic-rebuild-review-2026-10-22.md),
[ending-weight pilot](scenic-ending-pilot-2026-10-22.md), R3 packages and their
captures remain preserved. No new location, camera approval or deployment is implied. The owner merged
the runtime during this review; the delivery section records that separately. The approved geographic count remains **13**.

## Runtime changes and their boundaries

The default and regional `maxClimbMps` setting was previously inert. The exact R2
Denali Drop CPU holdout reaches **27.476535 m/s** at **46.644444 s**, above the
configured **22 m/s**. A decoded-shot control also produced identical plans and
keys with climb limits of 1, 22 and 100 m/s. These establish an ignored configured
field; the older motion-policy prose separately enumerated tangential
acceleration, yaw and flow and did not promise climb enforcement.

[ShotPlanner](../src/world/terrain/ShotPlanner.js) now bounds vertical eye motion
on the same Catmull-Rom path and Hermite progress mapping that playback uses.
Uniform-spacing derivative extrema are exact; uneven spacing uses conservative
analytic product bounds over fixed cells. Those fixed cells make the bound
monotone as a query prefix expands. Cheap Bernstein-hull upper bounds skip unnecessary refinement. A remaining
contender receives a tighter exact-factor upper bound before the unchanged
fixed-cell result is calculated. These prefilters never replace a returned
analytic bound with a sampled estimate. Shared bend/climb coefficients, flat-path
fast paths and an irrelevant-predecessor early return reduce first-request work.
The existing 50 ms assertion and physical thresholds remain unchanged.

The bound participates in shared leg caps, starts, committed continuations,
heads, tails and endings. It uses the **selected support topology**: a reached
neighbour supplies support, while a final item has no outgoing support from an
unreached shot. End-speed search runs separately within each topology. Partial
ranges exclude climbs already passed or not traversed before cutoff.

Two-sample links and shots require both neighbouring supports together. Review
found that independent one-sided checks could miss the combined rising spline's
midpoint derivative. When a selected departure changes a shot's already checked
head segment, the planner also rechecks that preceding interval's cap. A
continuation carries the actual committed predecessor through its payoff;
manually supplied starts receive no invented predecessor. These corrections
retain legal short shots rather than excluding that schema-valid case.

[ShotTimeline](../src/world/terrain/ShotTimeline.js) independently checks the
maximum vertical derivative of the actual Float32 100 ms key spline over the
newly built span, including interior extrema and the partial last interval.
Fresh plans cover the full timeline; committed replans audit the rebuilt suffix
starting at the last frozen key. Float32 rounding or a committed splice can
exceed an otherwise legal source-path bound. A checked timeline
above the limit is rejected before publication by the worker. Where a legal,
same-duration previous timeline exists, refinement retains it with an explicit
deferral note. Committed keys remain bit-exact; the new positive continuation
regression also rejects unnecessary climb deferral.

The final independent review closed the production-API two-support-shot sweep
at 21–27 s and continued-shot sweep at 14.50–14.90 s. The former previously
accepted a plan whose final key climb reached 10.309347 m/s against a configured
10 m/s; its corrected 21 s control remains nonfallback at 4.811198 m/s. These are
minimized correctness fixtures, not rendered camera-quality results.

## Pacing regression corrected without changing weights

Enforcing climb reduced the comfort cap of a terminal candidate. That changed
its pace cost enough for a two-payoff route with a token partial pullback to
beat a still-legal three-payoff route in fixture 2 Drop. The existing requirement
continues to demand at least half the motion-feasible payoff bound: bound 5
requires at least 3 payoffs. Neither that assertion nor any source weight was
relaxed.

A partial final shot now earns the share of its outro reward corresponding to
its head actually played, `(endingProgress - throughProgress) / payoffS`, clamped
to 0–1. Entering an outro by a metre no longer earns its entire reward. Completed
outros retain their full reward. This restores the fixture's three-payoff route
at unchanged weights. The rejected global ending-penalty experiment remains
rejected; `endInLink` remains 4. The separate bounded terminal-speed correction below adds three distinct
interior means only after collapsed quick choices fail. It changes no editorial
weight or physical predicate.

## Exact CPU replay of all 15 useful libraries

The source/library replay uses the final R3 candidate packages, full visibility,
Anthem duration **167984.76190476192 ms** and explicit song seed **2031031581**.
The same packages and inputs run on the prior runtime and the final climb/pacing
runtime. These are CPU replays of the reviewed structure; the separate app
batch verifies upload, analysis, worker selection and images independently.

All 15 final timelines are nonfallback and construct successfully. All checked maximum-eye-speed, tangential acceleration, yaw, flow, payoff
and last-tangential checks pass, as does the new exact key-climb check. The highest exact key climb
is **20.583326551649307 m/s**, at **Anthem 95.061111 s** in San Gabriel, below the
configured 22 m/s. Full vector/sideways acceleration and second-difference spike
diagnostics remain separately reported; passing the declared gates does not
assert that every acceleration component is capped or that every join is
visually smooth.

Nine selected timelines change. Some transitions become shorter and some
become longer; physical feasibility does not establish better editing.

| View | Timeline changes | Payoffs s, previous → final | Total transit s, previous → final | Ending, previous → final | Final key climb m/s |
| --- | --- | --- | --- | --- | ---: |
| black-mountains-catawba | yes | 16 / 64.5 / 128 → 48 / 128 | 105.310 → 53.094 | link → shot | 11.9646 |
| chugach-matanuska | no | 16 / 128 → same | 68.545 → same | shot → shot | 16.9173 |
| denali-wonder-lake | yes | 16 / 128 → 12.1 / 64.5 / 128 | 69.915 → 90.245 | shot → link | 5.4319 |
| izta-popo-west | yes | 48 / 128 → 37 / 128 | 37.634 → 85.957 | shot → link | 13.3084 |
| la-sal-castle-valley | yes | 16 / 83.5 / 128 → 48 / 128 | 87.512 → 54.872 | shot → shot | 12.6530 |
| monument-valley-163 | yes | 8.1 / 64.5 / 128 → same | 99.513 → 99.491 | shot → shot | 15.5233 |
| muncho-lake-south | no | 16 / 128 → same | 65.165 → same | shot → shot | 5.9298 |
| nc-ross-lake-north | no | 16 / 128 → same | 69.359 → same | shot → shot | 14.2218 |
| panamint-dantes-view | yes | 16 / 128 → same | 88.944 → 114.854 | shot → link | 20.2580 |
| san-gabriel-baldy | yes | 16 / 128 → 48 / 128 | 55.511 → 62.954 | shot → link | 20.5833 |
| sawtooth-redfish-north | yes | 16 / 128 → same | 93.804 → 62.979 | link → shot | 13.4872 |
| shenandoah-stony-man-west | no | 48 / 128 → same | 56.862 → same | shot → shot | 9.8488 |
| superstition-west-front | no | 16 / 128 → same | 68.999 → same | shot → shot | 5.3143 |
| teton-jackson-lake | yes | 48 / 128 → 16 / 128 | 72.092 → 95.173 | link → link | 20.4871 |
| white-mountains-owens | no | 16 / 128 → same | 70.046 → same | shot → shot | 13.2989 |

Black Mountains and La Sal lose a payoff while reducing total transit, but their
longest uninterrupted transfers grow: **37.409 → 53.094 s** in Black Mountains
and **43.001 → 54.872 s** in La Sal. Redfish similarly lowers total transit while
its longest link grows from **60.676 to 62.979 s**. Izta,
Panamint, San Gabriel and Teton gain transit exposure. Panamint's longest link
increases from 88.944 s to **95.341 s**; Teton's from 42.689 s to **70.356 s**.
Izta, Panamint and San Gabriel now end inside a link. Those are explicit pacing
and ending concerns for the changed-tour app review, not accepted improvements.

The assigned 128-second climax also changes in five views. These are library
subject and `hero` flags, rather than independent geographic identification or
a visual-quality verdict:

| View | Previous climax subject | Final climax subject | Hero flag |
| --- | --- | --- | --- |
| Black Mountains | `valley-e5110-s2590` | `mount-mitchell` | no → yes |
| La Sal | `peak-e10260-s7230` | `mount-peale` | no → yes |
| San Gabriel | `valley-w2990-n9000` | `peak-e980-s1480` | yes → no |
| Redfish | `heyburn-mountain` | `redfish-lake` | yes → no |
| Teton | `mount-moran` | `peak-w7600-s3060` | yes → no |

San Gabriel, Redfish and Teton therefore have explicit climax-subject review
gates alongside their transfer and ending checks. A legal replacement route
does not establish that the intended regional hero is adequately presented.
Izta also falls from two to one of the five strong-impact slots despite
retaining two payoff events; its musical allocation needs separate review.

The separately controlled R2 Denali Drop holdout keeps payoffs at **15 and
97.5 s**, while exact key climb falls from 27.476535 to **9.891181 m/s**.
Its new legal route spends **81.009 s** in transit, with a **52.403 s** longest
transfer and a final partial link. The climb-only intermediate had lost the
opening payoff and stayed on one shot; the bounded terminal fallback restores
the two-payoff route. The final route therefore requires fresh framing and
ending review rather than inheriting acceptance from either predecessor.
The CPU holdout explicitly uses seed **2031031581**. Uploading Drop derives
**3871261898**; that actual-app control is recorded separately.

Authoritative records remain outside Git under
`verification/rebuild-20261022/climb-pacing-r4/`: `final-combined-r4-cpu.json` and
`final-combined-r4-existing-motion-gates.json`. They bind source, package, structure,
timeline and diagnostic identities. The motion-gates record reports all 15 Anthem cases and the explicitly seeded
R2 Drop holdout passing its defined checks. Original reports remain immutable.

## Moonlit ending fill: separate matched visual result

At the late Denali ending, Range's visible lunar override leaves a moonlit scene
while coda unravel extinguishes direct light. At Anthem 167.750 s, the existing
ambient multiplier is .35 and storm amount is 0; the late dark terrain is not an
ongoing squall. The final massif persists, but its relief and foreground
separation are weak. The right foreground ridge crop is a separate composition
issue.

The retained [RangeScene](../src/world/alpine/RangeScene.js) change blends terrain
receiver fill toward the existing sheltered response using actual night,
moon-visibility and inverse sun-visibility factors. Missing or nonfinite
visibility contributes zero. Full daylight and true celestial gaps retain their
fill. Physical celestial state, direct key light, authored sky/air, storm,
exposure, audio and camera geometry remain controls. An earlier hard
`body === 'moon'` switch was analytically rejected before GPU capture because
it would abruptly raise fill from .875 to 1.93125 at the handoff.

The completed comparison isolates this one renderer file on the **old R3
planner/timeline**, not the final combined runtime. Each arm saves 120 PNGs:
117 clip frames and 3 extra checkpoints, **240 PNGs total**. All images and all
14 consecutive-frame sheets were independently inspected. The 32 daylight
control PNGs at 46–50 s and 126–130 s are byte-identical between arms. Audio,
seed, camera keys, package, schedule and rendering settings match: Anthem,
640×360, quality 0, continuous export-clock drawing at 4 fps on Chromium 156
through the RTX 3060 D3D12/ANGLE path.

- **Anthem 4–8 s and 14–18 s:** snow grooves and ridge faces become more legible
  while dark blue sky, stars and shaded folds retain a nocturnal opening. No
  new clipping or washout was apparent in the inspected frames.
- **Anthem 150–154 s and 156–161 s:** twilight terrain gains a modest readable
  lift. Existing pulses and diagonal banding around 153.5 s remain. Native-size
  157.75, actual 157.900 and 158 s checks show no new hard receiver gate; an
  existing visible sun/moon lighting lift remains in both arms. This is not a
  claim that total lighting is seamless.
- **Anthem actual 163.975–167.975 s:** the background massif and foreground
  saddle separate more clearly while the sky remains dark blue and folds stay
  shaded. The cropped right ridge and soft detail remain.

Retain the smooth fill as a scoped readability improvement, supported by the
final combined-runtime observations below. This does not approve a camera, another region
or an entire tour. Matching audio is retained, but no auditory assessment or
live playback performance claim follows from these saved frames.
`moon-fill-independent-visual-review.md/.json` binds the inspected evidence.

The final Black Mountains comparison still has dark forest faces at Anthem
167.975 s. A separate read-only trace confirms that the retained receiver fill
reaches terrain and all canopy material forms. The capture records exposure 2,
storm amount 0, flash 0 and clearing .99829955. Frozen-source reconstruction
gives night 1, visible moon, absent sun, coda unravel 1 and direct key 0; the
calculated receiver scale is 1.93125 versus the old .875. These reconstructed
light/uniform values were not directly recorded by the capture.

The forest clearing mask can still multiply combined receiver lighting,
including ambient, by .50085–1 in that state. Actual fragment openings, sky RGB
and canopy self-occlusion were not saved, so this is a supported contributor
rather than proof that every dark pixel loses half its light. Storm amount 0
does not establish the absence of clearing clouds or shadows. The next bounded
forest-ending comparison should isolate this ambient/clearing interaction with
the final route, palette, exposure, sky, coda and storm history fixed. Useful
detail must be judged against glowing foliage, lifted blacks and canopy/ground
mismatch. No further fill or clearing-mask change is adopted here.
`black-forest-ending-cause-audit.md/.json` records the source and image hashes.

## Bounded terminal search and long-transfer review

The quick ending search could clamp `comfort`, `keep` and `pinV` to the same
infeasible speed and miss a legal interior mean. A dependency-free decoded
fixture with three flat shots, two links and 24 samples reproduces this through
the production planner: all original choices are 35.007346 m/s and fail, while
11.751837 m/s passes the unchanged predicate. The old planner discards the
opening 16-second payoff; the regression requires it and the hero climax at
128 s, then checks the delivered timeline's physical limits.

The retained correction first tries the existing candidates. Only when quick
choices have all failed, all three are identical and `hi > lo`, it tries
`lo + (hi - lo) * share` for shares **.5, .25, .75**, in that order. It allocates
no fallback array when an original choice succeeds. There is no always-on
17-speed grid, changed beam, global transit reward or higher ending penalty.
The selected plans and Float32 keys match the visually reviewed eager diagnostic
on all 15 Anthem cases and both controlled/natural Denali Drop seeds.

The separate Denali Anthem comparison uses the combined climb/pacing/moon-fill
runtime as its baseline and changes only this terminal search. Each arm has
**409 saved PNGs in 15 continuous windows**, **818 PNGs total**. Independent
review inspected every saved frame and 13 native-size pairs. Root also inspected
13 native-time pairs and both arms' consecutive transfer, middle-payoff,
climax-approach, late-lighting and final-release windows.

The longest transfer falls from **69.915 to 42.891 s**, with payoffs changing
from 16 / 128 s to **12.1 / 64.5 / 128 s**. At 59.074–71.445 s, the candidate
opens a receding valley beyond a cropped near-left snow slope while the
baseline remains dominated by a close triangular crest. Reviewed joins and
hotspots showed coherent parallax without an apparent camera snap or all-sky
run at 4 fps. At 161.8–167.975 s, the back massif moves toward and partly beyond
the left edge while lower foreground opens center-right. The gradual release
offers valley depth, with the clipped climax background an explicit framing
tradeoff. It does not establish a centered hold or full visibility of the named
Denali subject. Its partial-link label alone does not establish quality.

Retain this as a scoped search improvement with explicit tradeoffs: total
transit rises from **69.915 to 90.245 s**, opening and climax repeat Denali, all
three played shots remain in the valley family, and the ending has more sky.
Eleven second-difference spikes remain diagnostic targets; the inspected 4 fps
frames cannot certify continuous high-frame-rate smoothness. Bright pulses,
diagonal blocks, soft snow detail and dark ground are also still visible.
This is not whole-tour approval. The final integrated source receives its own
fresh actual-worker probes and matched captures below; the earlier isolated
search review is not relabelled as final-source capture evidence.

The next editorial pass should prioritize the largest remaining uninterrupted
transfers and the final subject hold under these legal limits. Panamint, Teton
and Izta need alternative staging or connections before their route changes
can count as pacing improvements. Black Mountains and La Sal need earlier
musical delivery as well as relief from their longer single transfers. The
forest-ending lighting hypothesis above requires its own matched comparison;
raising global exposure would not test that cause in isolation.

Long transfers remain open in other views. Panamint, Teton, Izta and San Gabriel
need editorial work under the legal motion limits. The current regional shot
and link packages are unchanged; further geographic expansion stays on hold.

## Validation and final app-review status

The final full-source run has **5,004 tests: 5,003 passed, zero failed, one
skipped**, and complete lint exits 0. It runs with the cached DEM and configured
headless Chromium; the sole skip is the published Monument Valley library test
because the primary source checkout intentionally has no attached libraries.
The candidate library receives a separate matched actual-app case. All 19 climb
regressions and the new dependency-free terminal regression run in the suite.

The existing published Monument Valley test is then run separately in a clean
copy of source commit `58a6068` with all 78 verified candidate overlay entries
attached. It passes **1/1 with no skip**, exercising that published library
across the test's song fixtures and its motion/ending assertions. This closes
the library-availability gap for that case without relabelling the earlier
full-suite skip. `published-library-focused-test.log/.json` pins its source,
asset donor, command and result.

The unchanged **50 ms** planning assertion passes at **46.6 ms cold minimum**,
48.9 ms median and 64.5 ms maximum; warm minimum is 31.8 ms. Those host planning
timings do not measure live rendering or physical-device performance. The
independent copied source remains byte-identical throughout the command.
Authoritative logs are `verified-final-npm-test.log`, `verified-final-lint.log`
and `verified-final-exit.json`; `verified-final-source.json` pins the copy.

The earlier stable-runtime full run failed the cold gate at 51.3 ms. Profiling
identified unnecessary vertical-geometry prefilter work and irrelevant incoming
support lookup. The exact-output optimization described above passed independent
source review and preserved every all-view plan/key in its control. The eager
terminal fallback also incurred avoidable work; its retained lazy form only
tries extras after the original candidates fail. Earlier focused timing failures,
including the final guarded source's 50.1 ms minimum, remain preserved rather
than being relabelled as passes. Two complete final-runtime runs passed the
unchanged gate at 47.7 ms and 46.6 ms respectively.

The remaining sky-pan failure in the first final-runtime full run came from a
stale test double. Production constructs `RangeShotTours`, including when tours
are disabled. The test's prototype-call receiver omitted `shots`, so the lookup
threw and the existing catch returned zero movement. The repair supplies
`shots: { timeline: () => null }` for the intended rail-only case. All original
pan, seam and fade assertions remain unchanged. Two independent checks matched
the repaired fixture to an actual production-shaped presentation; no rendering
code changed for this repair. The focused atmosphere file passes 21/21 and the
complete source suite above confirms the repair.

All 16 actual-app case pairs have fresh final-source candidate worker probes,
with their selected items, payoffs and Float32 keys bound exactly to the CPU
controls before union-window selection and image inspection. Only the 16
unchanged baseline probes are reused with their hashes verified. Final captures
use the frozen final source directly; earlier candidate probes or images are not
relabelled as final-source evidence.

The final combined comparison is complete: **16 case pairs, 32 passed and
encoded arms, 220 matched window pairs, 440 individual clips and 9,834 retained
PNGs**, including the extra checkpoints. All saved PNGs in both arms were
visually inspected using paired chronological sheets, with selected native-size
controls. Black Mountains and Chugach use 160-pixel thumbnails plus original
sheet/native checks; the other 14 cases use 320-pixel thumbnails plus native
controls. This inspection covers the saved windows and checkpoints, not the
unsaved intervals.

The captures use 640×360, quality 0, continuous export-clock drawing at 4 fps,
headless muted Chromium 156 and the RTX 3060 D3D12/ANGLE path. Baseline/candidate
pairs share audio bytes, derived seed, packages, union selection, exact capture
times and settings. The captured source digests are pinned below. Actual-worker
plan/key equivalence is checked separately before selection. The Drop case uses
the natural upload seed **3871261898**; its exact captured key climb is
**27.476535 → 9.891181 m/s**. Both matched Drop arms have two payoff events;
restoration refers to the rejected intermediate, not an added event versus the
old baseline.

Every canonical manual record retains `approvalGranted: false`. The integrated
source is retained as a review candidate with the pacing/framing/ending gates
below. Matching source audio is included in the clips; no audio audition, live
FPS, physical-device performance, independent geographic identification or
owner artistic acceptance is claimed. `combined-review/combined-runtime-review-coverage.json`
and `final-combined-app/manual-reviews/` bind the completed counts and inspected
source/report/selection/clip/PNG identities. The earlier isolated comparisons
remain separate evidence.

Two unsuccessful capture attempts remain preserved outside the completed
comparison set. The earlier Black Mountains baseline lost its WebGL context
around 158.4 s; its replacement passed through 167.975 s. A later orchestration
SIGTERM interrupted Stony Man's candidate after 191 PNGs through 128.25 s,
before it wrote a final report. The sender and cause are unconfirmed. Recovery
inventoried that incomplete directory and log, validated all 23 completed arms,
and resumed only missing capture/encode phases against the unchanged frozen
source, helper, song seeds, selections and settings. An incomplete attempt does
not contribute to completed coverage or acceptance.

## Completed visual findings by case

The following findings refer to Anthem unless the row explicitly says Drop.
They describe saved windows from the actual app. Subject names in package
metadata do not establish independent geographic identification. Every record
retains `approvalGranted: false`.

| Case | Visible result at the stated times | Remaining pacing, framing or ending gate |
| --- | --- | --- |
| Black Mountains | At 128 s the revised route reaches the Mount Mitchell-assigned shot; late moonlit forest relief improves modestly. | First payoff moves 16 → 48 s, three payoffs become two, the uninterrupted link grows to 53.094 s, and final foreground remains dark. |
| Chugach | Added fill exposes some shaded snow/ridge detail; camera keys are unchanged. | Bright low-contrast snow at 58–68 s, a 68.545 s transfer and a close foreground snow wall at 128 s/ending remain. |
| Denali | At 59.074–71.445 s a receding valley supplies a middle visual break. At 161.8–167.975 s the foreground opens while the back massif partly exits left. | Longest transfer drops to 42.891 s, but total transit rises to 90.245 s; repeated valley/subject framing and the clipped final background remain. |
| Izta / Popo | At 79–128 s the candidate separates the two summits more clearly; ending blue snow relief becomes more readable. | Longest transfer grows to 60.044 s, total transit to 85.957 s and the payoff interval to 91 s. Strong-impact coverage falls 2/5 → 1/5; a near crest still dominates the partial-link ending. |
| La Sal | The final traverse retains the Mount Peale-assigned rounded summit and crags through 167.975 s, improving on the old unfinished ending structure. | Total transit falls to 54.872 s, but its longest link grows to the same 54.872 s. First payoff moves 16 → 48 s, the middle payoff is lost, and the valley/foreground stays dark. |
| Monument | 8.1, 64.5 and 128 s payoff compositions persist with modest face detail. | The total-transit difference is only about 22 ms; 99.491 s of links remain. The dominant butte exits left late, the ending is dark, and its final shot receives only 0.554 s. |
| Muncho | At 6, 12, 16 s and the ending, added fill reveals near-slope relief. | The 128 s scene remains fog-obscured; the ending is a low-contrast overlap of ridges. The 65.165 s transfer and 112 s payoff interval are unchanged. |
| Ross | At 163.9–167.975 s summit and upper-face snow/rock channels emerge from the baseline silhouette; the central mountain stays framed. | Lower terrain remains very dark. The 69.359 s transfer and 16/128 s payoffs are unchanged. |
| Panamint | At 54.75 s the candidate opens ravine separation; by 167.975 s the near ridge moves right and reveals more central valley/background relief. | The longest transfer grows to 95.341 s and total transit to 114.854 s. At 96–113 s a huge soft near crest dominates; the ending is still an unanchored partial link with dark ground. |
| San Gabriel | At 85–97.85 s, 109.775–124.45 s and 128 s the candidate opens valley depth and sky beyond the baseline close bright slope. At 163.9–167.975 s layered ridges replace a nearly cropped foreground mountain. | The climax is a broad diagonal ridge/valley rather than an isolated named summit. First payoff moves 16 → 48 s, the opening shot lasts 76.562 s, total transit grows to 62.954 s and the final 24.130 s link stays dark. |
| Redfish | The inspected 36.069/99.048 s join windows show coherent parallax. At 163.9–167.975 s blue lake water becomes readable center-right. | The 128 s assigned lake climax is largely hidden by cloud sea behind a tall cropped left face. Total transit drops, but the single 62.979 s transfer, dark/cropped foreground and shared highlight wash remain. |
| Stony Man | At 48 s the rounded forested hill becomes modestly clearer; the 104.862 s handover is continuous in inspected frames. The ending stays on its Stony Man-assigned approach. | The 56.862 s transfer and 80 s payoff interval are unchanged. At 128 s and 151.983–167.975 s the ridge remains hazy, dark and low-contrast; the hero label does not establish a strong reveal. |
| Superstition | Warm-night relief improves on the point and nearby hill. Its named orbit remains centered and continuous through the ending. | The 68.999 s transfer and 112 s payoff interval are unchanged. Strong cream/yellow daylight washout at 81.6/99.1 s occurs in both arms; the lighting change does not resolve it. |
| Teton | At 16 s the Moran-assigned opening establishes a jagged rock outline. At 128 s the alternate unnamed peak is a readable pointed focal contour; at 157.775–167.975 s wider layers improve the moving ending. | The longest transfer grows to 70.356 s and total transit to 95.173 s. The alternate climax is an editorial tradeoff, not a failure because its assigned name is absent. Dark foreground, cropped near crests and nine second-difference diagnostic spikes remain. |
| White Mountains | At 163.9–167.975 s the candidate reveals blue snow/rock grooves across near and distant ridges while retaining the dark sky. | Framing and the 70.046 s transfer are unchanged. At 128 s and the ending a rounded near shoulder partly hides the distant jagged peak; daytime slopes at 52.9–107.742 s remain very bright, soft and low-contrast. |
| Denali, R2 Drop | At 12/15 s the candidate opens a broad snowy massif beyond the old left-slope occlusion. At actual 142.475 s it keeps a recognizable snow-mountain outline with clearer upper faces. | Both baseline and final have payoffs at 15/97.5 s; restoration is relative to the rejected climb-only intermediate. Total transit grows to 81.009 s, the longest to 52.403 s and the final link lasts 28.606 s. Repeated valley framing, dark foreground and a cropped left slope remain. |

The local paired gallery is generated from hash-verified completed records. It links matched clips, all saved frame sheets and derived
native-size controls where prepared.

## Source and candidate delivery identity

The implementation starts from source commit
`bc3a495ba62570f7514f7928afe3251f0b54fd37`. The tested runtime and regressions
are published in commit
[`58a6068142c313e11986dcda5666697784c6f71f`](https://github.com/aepler315/midio-pixel/commit/58a6068142c313e11986dcda5666697784c6f71f),
tree `dec655385d873a3335f40fab28b725516b134b07`, sole parent
`bc3a495ba62570f7514f7928afe3251f0b54fd37`.
Its nine files are the three runtime modules and six test/fixture files.
Remote ref, ancestry, tree/blob identities and all nine UTF-8 file contents were
read back exactly. The stable runtime hashes are:

| File | SHA-256 |
| --- | --- |
| `ShotPlanner.js` | `540cd030c0cb1f3f62f559cb7de29dfd9f87b7c836d3a5a875cc33a5c642534e` |
| `ShotTimeline.js` | `da204aa4ef390ed7f0b6646f6ee8a04bb19a50ac542f81c4c4303be54f3eb086` |
| `RangeScene.js` | `405ffcacdce271866d014fb7f60e72265838115bbe111675c672dc639c33621f` |

`final-combined-r4-source-hashes.json` also pins the test and fixture files. The old-runtime
lighting diagnostic has its own one-file public freeze. The final combined
public snapshots each contain 680 files:

- R3 candidate packages: `5ac43558fd79f8c15245dd910ce81941c0581392f476482b0bf47d62ccb02593`.
- R2 Drop control packages: `9b985694650347d2cca85fd3de6b685e1efe4b9d59bf002364591aee93806627`.

Only Planner, Timeline and RangeScene differ from each corresponding prior
public baseline. The test-double repair is outside the public runtime snapshot.

Candidate geometry and assets are unchanged from R3. The 15 useful libraries
contain **180 shots and 459 links**; the entire Range asset tree is
**64,853,210 bytes**. No scout, fit,
connection regeneration or new location is claimed in this runtime iteration.
The global 60 MB cap remains removed; the existing regional limits remain.
Candidate libraries remain unapproved and excluded from the normal picker.

The source branch is `feat/scenic-rebuild-batch-one-20261022`. During the
review, the owner `aepler315` merged [PR #32](https://github.com/aepler315/midio-pixel/pull/32)
at **2026-10-23 06:28:25 UTC**, using runtime head
`58a6068142c313e11986dcda5666697784c6f71f` and merge commit
`112641de29258c995814d18b7a69a8530c51aaf2`. This agent did not issue that merge.
Final readback caught the changed PR state before reporting completion.

The five-file Markdown update is commit
`c13078d806f5c5e75b24c1f2387014d0f1df1da1`, sole parent the tested runtime.
It contains this review, the README and the three linked scenic documents and
was published after the owner's merge; it is outside merged PR #32. A subsequent
one-file documentation correction records that external state change. These
Markdown changes are delivered in a separate draft follow-up from the source
branch; the PR description records its exact current head.

The source tests and captures remain pinned to the reviewed runtime. The
initial main comparison used `6feed187f7cfe82ff11ec734e784208aabb78f78`, which
adds Medium+ pixel detail outside the freeze. Final readback finds main at
`c55ad6f62ca7e8bec247bbd483128cae1b74e5a8`, also containing
landscape-cast work merged through PR #35. Those render/actor changes are outside the
680-file camera-review snapshot. No current-main integration, live deployment
or GitHub CI pass follows from these local tests and saved images.

The [combined-runtime candidate branch](https://github.com/aepler315/midio-pixel/tree/review/scenic-climb-pacing-20261022)
is `review/scenic-climb-pacing-20261022`. Its first assembly is
`1c4fd074dbd07979006084a2dcf25284e1750923`, sole parent the five-file Markdown
commit `c13078d806f5c5e75b24c1f2387014d0f1df1da1`. A documentation-only child
preserves that assembly history and records the external merge. The candidate
continues to reproduce runtime `58a6068` with the reviewed R3 assets.

It overlays **78 byte-identical R3 entries** from
`5cd3bf7f2651ab1bae2b9d6bd651915f44eda245`; no new asset blob is created.
All **680 public files** remain bound to the final R3 app-review snapshot
above. Remote tree/blob identities and sizes provide the binary readback check;
binary downloads through the UTF-8 connector are not claimed. The external
candidate publication manifests and readbacks bind the initial assembly and
its documentation-only child to their exact commit/tree identities. The PR
description records current SHAs without making this document refer to its own
content hash.

The preserved [R2 branch](https://github.com/aepler315/midio-pixel/tree/review/scenic-library-rebuild-20261022)
remains at `d3d0d0462a40a8a0df2e48aa1160ccb55b5b856f`, and the
[R3 geometry branch](https://github.com/aepler315/midio-pixel/tree/review/scenic-denali-heading-20261022)
remains at `5cd3bf7f2651ab1bae2b9d6bd651915f44eda245`.

For local review, the paired gallery is served at
[the combined runtime review](http://127.0.0.1:8799/verification/rebuild-20261022/climb-pacing-r4/combined-review/combined-runtime-review.html).
Its files remain outside Git at
`C:\Users\aeple\Documents\ChatGPT\Midio Pixel\verification\rebuild-20261022\climb-pacing-r4`.
The server and media are local to that machine. For an interactive diagnostic
run from the candidate checkout, use `npm start` and
`http://127.0.0.1:8080/?rangeView=sawtooth-redfish-north&rangeShots=all`, upload
the recording and choose Landscape. These explicit diagnostic parameters do
not grant camera approval or bypass package identity checks.

The runtime merge is confirmed, while deployment and owner camera/device
acceptance remain unverified. The documentation follow-up remains a draft.
Expansion stays on hold at 13 approved views. Local source tests, saved app
images, remote publication and owner/device acceptance remain distinct states.
