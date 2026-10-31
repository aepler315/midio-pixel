# WP03: legal tour planning and bounded hero-shot repair

> Historical record. The scope, preservation rules, approval/hold decisions and validation steps below describe this past task, not current development prerequisites. Experiments and local commits follow the [current development policy](../experimental-development.md). Recorded results and runtime eligibility remain evidence of the version reviewed.

This implements WP03 from the [consolidated audit roadmap](2026-10-20-astra-sol-consolidated-audit.md): repair C01's planning failure, then C28's semantic coverage and bounded distant-shot repair. It preserves safe short-song fallback, motion constraints, committed poses and accepted subjects. It does not promise that every musical hero can be framed legally.

Branch: `impl/wp03-legal-tour-planning`. Sole implementation parent: WP01 `1f36735e2ff84fbdd8150dd7c05f733a3d00e18e`, tree `d830169c5b7628798f6970a29a6ac179b1794df9`. WP01 is the roadmap's explicit prerequisite. Main was verified at `cace36893003e4161b243f22a69204be17181df6`; this branch intentionally includes WP01's diagnostics and excludes the independent WP02 library implementation. Existing audit reports remain historical evidence rather than being rewritten as proof of fixes.

## Findings, repairs and regressions

| Finding / failure | Repair | Verification |
| --- | --- | --- |
| C01: real 90-second intro/verse/outro schedule throws before the next active shot | Share the actual future yaw capacity between feasibility, DP transitions, final enforcement and composition | Former TODO now a required passing test, with 60/120-second controls and broader real-package schedules |
| Future feasibility assumes 25 degrees/s when outro or breakdown permits 12 | Integrate published frame intervals by role, reduced motion, stops and actual elapsed duration | Mixed-role reachable-lock regression; independent sampled corpus |
| No beam survives before a future lock's active window | Release the blocking authored lock and refresh remaining altitude constraints inside a bounded local DP retry | True RED against WP01, legal no-active-lock recovery and immutable-prefix tests |
| Dense, incompatible windows can evict an earlier feasible shot | Resolve later incompatible aim deadlines chronologically; retain compatible repeated shots | Dense 18-lock regression with bounded route construction and retained feasible shots |
| Fractional final interval receives a full 100 ms of motion or wrong interpolation | Use actual frame times for altitude corridors, final climb/yaw and pose interpolation | Fractional durations, exact endpoint and midpoint assertions |
| A complete frozen horizon omits the fractional final frame | Compare actual frame times and include the final index when the horizon reaches duration | 50/184/14,951 ms regressions preserve all four arrays and exact endpoint despite a changed route |
| C28: a pitch-clamped subject is accepted despite being outside the projection | Measure the prospective candidate's actual projection before committing targets; try the next bounded candidate if it fails | Offscreen intended subject / feasible alternative regression and rollback test |
| Repair changes an accepted earlier shot's pitch | Begin after protected prior windows and preserve all target components in those windows | Pitch-only corruption reproduced, then exact pose/FOV preservation verified |
| An earlier repair destroys a future subject already in frame | Protect all initially covered windows before attempting any repair, including their interpolation boundary samples | Review regression passes with chronological and reversed hero arrays; independent 25 ms pose probes |
| Distant repair turns a stopped camera by changing pitch | Preserve held pitch as well as the shared zero-yaw stopped interval | Stopped-route RED-to-GREEN regression and independent held-pitch/FOV replay checks |
| Scenic quality or a successful alternative can conceal an intended hero miss | Separate intended/composed subject coverage and publish explicit ending outcomes | Summary, authored-subject, worker serialization, deferred refinement and presentation snapshot tests |

## Planning contract

[TourMotion.js](../../src/world/terrain/TourMotion.js) exports the shared yaw-rate/capacity model. General motion permits 25 degrees/s; outro, breakdown and reduced motion permit 12 degrees/s. Both-stopped intervals have zero yaw capacity. Each published interval uses its endpoint role and actual elapsed time; the last interval can be shorter than 100 ms. The capacity integral is used consistently by [TourTimeline.js](../../src/world/terrain/TourTimeline.js) for DP transitions, future reachability, compatibility checks, final frame enforcement and distant composition.

The original 90-second failure occurred at about 48.25 seconds, before the upcoming shot's active window. Its future feasibility check retained a heading using 25 degrees/s even though the actual outro permitted 12. The old recovery only handled an active lock. Recovery now identifies the active or next blocking lock, releases that requirement explicitly as passed at range, refreshes the remaining altitude locks, and retries the DP locally. There are at most `heroes.length + 1` attempts. It does not reset route scale or quality-retry settings through recursive route rebuilding, remove every hero, raise comfort limits, or manufacture a camera outside the corridor.

Climb limits remain 30 m/s normally and 15 m/s under reduced motion. Clearance and the altitude envelope remain mandatory. A future station cannot overwrite already committed heights. Refinement retains the old motion preference's committed prefix, applies the new preference only after its horizon, and keeps the existing deferred-refinement path when no safe road continuation exists.

## Composition and reporting contract

Distant composition retains a bounded candidate list and approach window. It cannot move the eye, retime the route or lift the altitude corridor. A proposed target array must satisfy the shared yaw budget, held-camera requirements, protected accepted windows, existing scenic-quality budget and actual projected coverage of the candidate before it is published. An unsuccessful attempt leaves the safe camera and FOV unchanged. Earlier and future accepted subjects are constraints; the order of the hero array does not permit a repair to replace a previously covered subject.

`heroFraming` keeps its existing `framedPointId`, `framedFraction` and station/distant/missed outcome. It adds `intendedPointId`, `intendedFramedFraction`, `alternative`, role/final-chorus markers, the measured window, sample count and decision reason. The exact final song endpoint is included even when it is off the 250 ms sampling grid.

`heroCoverage` summarizes intended coverage, successful alternatives, station/distant/missed counts and individual final-chorus/outro outcomes. It is explicitly `projectionOnly`. [TourRuntime.js](../../src/world/terrain/TourRuntime.js), [tour-worker.js](../../src/world/terrain/tour-worker.js) and [RangePresentation.js](../../src/world/alpine/RangePresentation.js) retain this report across worker transport, deferred refinement and capture snapshots. The dedicated tour smoke now records semantic coverage for every hero and validates complete accounting, while keeping existing quality/station checks. It imposes no invented universal hit-rate requirement.

Projection measures front-facing placement within the existing NDC window. It does not establish terrain visibility, native-grid subject footprint, user/cinematic camera transforms or musical/artistic acceptance.

## Captured-input replay and ending outcomes

The maintained [tour-coverage-check.mjs](../../tools/tour-coverage-check.mjs) replays an initial captured worker request against the actual published terrain/tour package:

```sh
npm run test:tour-coverage -- --request /path/to/input.json --out .smoke/wp03-candidate/report.json
node tools/tour-coverage-check.mjs --request /path/to/input.json --source /path/to/WP01 --out .smoke/wp03-base/report.json
npm run test:tour-coverage -- --request /path/to/input.json --baseline .smoke/wp03-base/report.json --out .smoke/wp03-compare/report.json
```

The tool hashes terrain JavaScript and its literal relative dependency graph, the tour package, harness and validator, then verifies no source changed during replay. It samples actual 25 ms intervals and the exact endpoint, reconstructs route scale/origin/tau, checks integrated role/stop yaw, held pitch/FOV, climb, clearance and every previously accepted baseline subject. The independent holdout uses its own budget calculation rather than importing the implementation helper. These are CPU trajectory/projection checks, not rendering or performance benchmarks.

The generated 90-second contrast audio has SHA-256 `c0160a5c95669def70cfe43feeca1c06b81117cf01f2b4e43d59f1ef59e02297`. Landscape review pins AudioContext to 48 kHz; the ordinary visual-evaluation transport used 44.1 kHz on this host. They produce different analyzed schedules and must not be mixed as an identical baseline/candidate pair.

| Fresh measured schedule | WP01 projected subjects covered | WP03 projected subjects covered | Preservation and endings |
| --- | ---: | ---: | --- |
| 48 kHz Landscape review, 89,984 ms, nine heroes | 5/9 | 7/9 | All five original accepted subjects retain coverage 1.0; final chorus at 83.012 s gains a legal alternative; outro at 87.885 s remains missed |
| 44.1 kHz visual evaluation, 89,977.324 ms, eleven heroes | 7/11 | 10/11 | All seven original accepted subjects retain coverage 1.0; final chorus at 79.234 s gains an alternative; outro at 84.393 s remains covered |

In the 48 kHz reconstruction, the final chorus's intended `peak-4832087` still has intended coverage 0; alternative `peak-614508` has coverage 1. The report states that distinction. Scenic quality changes from 0.86511561 to 0.85550266, within the existing budget. Sampled maximum yaw is 17.69064 degrees/s, climb is 30 m/s, floor margin is 99.087 m, ceiling margin is 582.503 m, and integrated yaw-budget excess is zero. The route/eye safety metrics are unchanged by distant repair.

The fresh 48 kHz schedule reconstructs the historical nine-hero pattern, but individual times differ from the archived request by a few milliseconds. It is a measured reconstruction, not a claim of byte-identical historic worker input. The old artifact's rendered frames covered 12–14 seconds; those frames never established what its endings looked like.

The remaining 48 kHz pre-chorus and outro stay explicit misses. Instrumented, in-memory-only diagnostics found the bounded outro candidates exceeded the cubic approach's available yaw. A further per-step saturated-yaw diagnostic still accepted none. That establishes a limit of these bounded attempts, not mathematical impossibility for every joint route/shot planner. A broader transition search is separate work; this change retains safe fallback rather than claiming an unearned ending shot.

## Verification and rendered review

| Check | Result |
| --- | --- |
| C01 planner focused suite | 26 passed, 0 failed, no TODOs |
| C28 dedicated regressions | 11 passed, 0 failed |
| Review-boundary/reporting/motion group | 24 passed, 0 failed |
| Final full repository suite | 4,862 total: 4,856 passed, 0 failed, 6 GDAL skips, 0 TODOs; Node v24.10.0 with explicitly selected Chromium |
| Final repository lint / changed-tool lint / whitespace checks | Passed, 0 errors |
| Independent holdout corpus | 18/18 schedules, 81,145 poses, unchanged 136-file source graph; no finite/motion/clearance/held-view failures |
| Independent correctness review | Both reproduced candidate blockers fixed and independently closed; no remaining blocker in reviewed scope |
| Captured-input CPU replay | Both transports pass finite/motion/clearance/accepted-subject gates with unchanged source graphs |
| Matched continuous browser evidence | All three matched 48 kHz captures and comparisons passed: opening 7 frames, chorus 8, outro 7; zero fatal browser diagnostics; source unchanged |
| Ordinary staged Landscape / selected Tetons / persisted Tetons / Trio | Standard 120-second fixture: 3/4 passed; persisted Tetons reached ready/advancing playback but failed its 30-second screenshot timeout; overall gate remains failed |

The new regression tests were observed failing before their fixes. The 90-second TODO was removed only after the production solver passed it. Additional review tests reproduced future-covered-subject replacement and fractional endpoint mutation before the final guards.

Rendered review uses immutable WP01 source as baseline and the final WP03 public-source snapshot as candidate, the same audio/settings/browser and Classic 1280x720 at two frames/s, in isolated headless muted Chromium 153.0.8010.12. Matched 48 kHz windows cover the opening (0.5–3.5 s), final chorus (81.5–84.6 s), and a bounded outro (86–89 s). The outro interval ends 0.385 s before the complete projected viewing window ends, so that rendered control is partial. Fixed-clock consecutive captures are separate from ordinary live route evidence and physical-device frame delivery.

Actual baseline/candidate frames at 83.0 seconds show the candidate bringing a broad wooded ridge closer to mid-frame and exposing more sky. At 87.5 seconds, fog bands and tree texture remain with a stable ridge silhouette. The opening's seven PNGs are byte-identical; all eight chorus and seven outro PNGs changed. Inspection of the complete ending contact sheets at this cadence showed no blank frame or obvious hard camera cut. Those observations do not identify the named summit or prove terrain visibility, native-grid footprint or 60 fps motion. Vertical sky bands are visible in candidate ending frames; their cause has not been attributed by an ablation, and no graphics repair is claimed. Retain the legal planning/projection corrections as a reviewable technical candidate; musical legibility and aesthetic acceptance remain open.

Frozen public-runtime SHA-256: baseline `6ab27207666b50772cf8bf3685cb999a31930ff7692702b17d92452c0ddbbc11`, candidate/staged artifact `574bd21532f767c7f46059a43b310372d7d1c1e191f55185b387e60be213a67a`. Matched captures use song seed 3,108,273,946, quality 0, the same browser/environment and audio. Only expected canceled preparation fetch warnings appeared in opening/outro; the chorus had none. No fatal graphics warning was suppressed.

The independent holdout covers 10 normal-motion and eight reduced-motion schedules, durations 8–360 seconds, up to 45 sections, and exact fractional endpoints. Its independently calculated maximum per-sample yaw-budget excess is 0.000269363 degrees (gate 0.002); normal climb peaks at 30.002441 m/s, consistent with Float32 quantization (gate 30.05); reduced climb peaks at 15 m/s. Minimum floor/ceiling margins are 64.3343/0.01992 m. All 3,322 stopped intervals preserve pitch/FOV within the stated numerical tolerances. It retains 47 projection misses among 201 heroes; safety success does not relabel those as covered.

The ordinary staged four-route gate is **not fully passing**. With the unchanged standard WP01 120-second fixture (audio SHA-256 `0bbee2957cc72a3e4214a84c3bb67dac20871f9796be0e43014fc2da7224be85`), default Landscape, selected Tetons and Trio passed. Persisted Tetons reached active/ready state and produced valid advancing samples (audio 50.805 to 53.359 seconds, simulation 0.119 to 52.250 seconds, presenter frames 5 to 10), but `page.screenshot` exceeded 30 seconds and no PNG was saved for that row. All four rows had zero browser diagnostic errors/warnings and the staged source remained unchanged. This establishes that persisted planning reached playback in this run; it does not satisfy the complete screenshot/integration gate.

An earlier run using the 90-second contrast recording during parallel captures passed only Trio; default/selected routes missed their usable playback-observation window, and persisted Tetons timed out during screenshot. Both failed reports are retained. A complete standard repeat was run after all capture browsers closed, without relaxing any assertion or timeout. The persisted screenshot failure remains unresolved; neither GPU contention nor an application defect is established as its cause. No further equivalent reruns or unrelated renderer changes were used to manufacture a green gate.

Even the passing selected-tour row is limited integration evidence: its observations span audio 58.909 to 109.784 seconds while simulation advances from 0.119 to 61.399 seconds, presenter frames 5 to 12. Those SwiftShader delays do not establish acceptable playback latency, audio/visual synchronization or physical-device performance. The matched fixed-clock comparisons and CPU constraint tests answer different questions.

Matching source audio and clips are retained for listening, but this environment cannot audition them; no auditory or artistic sign-off is claimed. Captured PNGs, audio, requests, JSON reports and logs stay outside Git in ignored `.smoke/` and the task evidence archive. Publication is a branch candidate, separate from merge and deployment.
