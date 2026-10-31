# Black, White and Izta/Popo alternate camera review

> Historical record. The scope, preservation rules, approval/hold decisions and validation steps below describe this past task, not current development prerequisites. Experiments and local commits follow the [current development policy](experimental-development.md). Recorded results and runtime eligibility remain evidence of the version reviewed.

**Later follow-up:** [R7 framing and ending repair](scenic-framing-endings-review-2026-10-23.md)
addresses this review's Izta opening and Black ending concerns. R7 locally
retains both improvements with limits after memory and forest partition fixes
and matched full-song review. Draft PR #38 records source/candidate commit
identities and publication status. The R6 results and candidate references
below remain their historical baseline.

This wave retains a shorter Izta/Popo route with a more readable Iztaccíhuatl
ending, retains White Mountains' revised readable opening and summit framing,
and rejects Black Mountains' increased total transit. White's first replacement
was rejected before its opening was repaired. Both retained networks remain
unapproved candidates with explicit review limits. The approved geographic
count remains **13** and further geographic expansion stays on hold.

The wave starts from source `f7b7b16de158014b20d0b6f52f48644fe5d2e555`
and exact R5 candidate assets `830d1213caa64bb8b2d1e5c6261da5ca957387a6`.
The prior [Panamint and Teton repair](scenic-transfer-endings-review-2026-10-23.md)
is preserved. R6 adds no application-code changes, global planner weights,
motion-limit changes or regional budget increases. The global 60 MB gate
remains removed. The source proposal keeps the original 13 approved rail
packages intact. The separate candidate asset snapshot rebakes White and Izta
bases, retains unapproved catalog status, and preserves their rail geometry;
rendered rail parity is checked separately below.

## Decisions and measured tradeoffs

All route comparisons use the uploaded `anthem.wav`, natural seed
**2031031581**, duration **167.984762 seconds**, and the detected song
structure. Audio SHA-256 is
`a691d46ebb2575a1ff5841960a50e39acb41cd085852f0a6b59030354b8fca90`.
These are the selected production planner routes, not discovery-duration
estimates. The unchanged 50-second authoring leash admits legal minimum
connection durations; the song planner can stretch a connection beyond it.

| Location / candidate | R5 total transit | Candidate total transit | Disposition |
|---|---:|---:|---|
| Black: new three-camera network | 53.094 s | 113.373 s | Reject; preserve R5 Black |
| Black: extended paths | 53.094 s | 89.864 s | Reject; also loses a scenic node from the connected component |
| Izta: fitted early orbit | 85.957 s | **40.421 s** | Retain with unresolved opening limits |
| White: original shoulder/valley sweep | 70.046 s | 66.138 s | Reject whole replacement on opening images |
| White: revised same-shoulder opening | 70.046 s | **36.069 s** | Retain with later first payoff and remaining visual limits |

Black's new network reduces the longest single transfer from 53.094 to
36.578 seconds, but its repeated camera changes more than double total
transit. The extended version still regresses total transit and fails full
scenic connectivity. Both were rejected before terrain fitting or new GPU
capture. Passing tangential motion checks does not clear the separate high
lateral-acceleration diagnostic. No new Black camera is retained, and its
existing dark foreground ending remains an editorial concern.

## Izta: retain the shorter transfer and held named ending

The fitted early-orbit package contains two mutually reachable scenic shots,
two directed connections and the unchanged fallback rail. It opens on an
unnamed peak, not a separately named Popocatépetl shot. The closing hero is
Iztaccíhuatl. Independent technical review reproduced the decoded package
identities, route, original budgets, supported paths and unused return.

| Anthem item | Start | End | Payoff |
|---|---:|---:|---:|
| Opening orbit | 0 s | 63.529 s | 16 s |
| Direct transfer to Iztaccíhuatl | 63.529 s | 103.950 s | — |
| Named Iztaccíhuatl traverse | 103.950 s | 167.985 s | 128 s |

Longest transit falls from **60.044 to 40.421 seconds**; total transit falls
from **85.957 to 40.421 seconds**. The final 64.035 seconds complete the
named shot instead of drifting away on an unfinished closing link.

Independent image review inspected all 657 saved images per arm through
whole-frame contact pages, verified all **1,314 native PNG hashes**, and
additionally inspected **34 native PNGs** at opening, joins, payoffs and
cutoff. At Anthem **156–167.975 seconds**, the retained shot keeps both upper
peaks separated from the sky and more of the intervening basin visible.
The baseline's near crest grows across the center and lower frame. Retain
this ending and the shorter transfer.

The opening at **4–32 seconds** still sits inside a close snow-ridge corridor.
The larger mountain is displaced toward and clipped by the left edge; the
16-second planned payoff does not produce a substantial visual reveal.
The **128-second** twin-summit composition remains readable but is effectively
the same framing as baseline, with substantial lower-right foreground.
The candidate does not solve the opening, broad volcano framing or outro
lighting. No audio audition or judgment of musical feel is claimed.

An independent final-delivery addendum binds this decision to the final
combined snapshot. Izta's four asset files, actual worker items, all timeline
values, audio, settings and saved timestamps match the first reviewed
candidate. Of 657 final PNGs, 614 are byte-identical; the other 43 differ by
at most one RGB channel level across 1,027 changed pixel instances, with no
alpha differences. Native 16/128/167.975-second controls are byte-identical.
The prior visual disposition therefore applies to the final delivery.

The exact retained Izta package identities are:

| File | SHA-256 |
|---|---|
| Shots manifest | `b6d0b8645236e92ba59534bbf0306f22a3adf71fba866282bbca4a87cb7b0b57` |
| Shots payload | `577a50b038ae62acdb7e9d8ab06c78a1b41720c5908a0e893bafb82983b74755` |
| Terrain manifest | `4a5e7ff09b647f6316ee57b270c0cbb9e2789cd05979ed55d5b6620e122ab6b1` |
| Terrain payload | `ad4edda40673ca37ee0ba56999b322ed3093577c0e0dfdfac9614a1199085e21` |

Independent fit accounting finds **84,056 added bytes** against the original
1,400,000-byte regional cap, 1,141,420 desktop / 572,938 mobile triangles,
and a 76,264,000-byte tour forest bound under 167,772,160 bytes. Footprint
coverage has zero holes and zero LOD violations. Dense 0.1-metre progress
checks of all scenic support combinations and both connections find no
below-floor sample; the smallest hero floor margin is **2.581 metres**.
That is finite sampling, not an analytic continuous-clearance proof, and
subsequent geometry changes require a fresh check.

## White: retain the repaired opening and summit framing

The first `fit-shoulder-valley-sweep` package passed independent technical
admission under the original White caps. It shortened the single transfer
by only **3.907 seconds**, from 70.046 to 66.138, and kept the 16/128-second
payoffs. Both baseline and candidate ended in a shot.

Image review covered all 657 images per arm and additional native controls.
At Anthem **4–36 seconds**, the replacement looks steeply down into folds
and a drainage without a skyline or convincing landscape scale. The
16-second payoff remains a texture-heavy crop. This sustained regression
outweighs the small pacing gain, so the whole replacement was rejected.

Its summit geometry is useful: at **128 seconds**, the summit ridge is
larger, near center and separated from the sky; at **156–167.975 seconds**,
the face and gullies remain readable above the close shoulder. Preserve it
for a revised opening. Broad level distant strips and the late moon/summit
tangent remain bounded composition/geography observations, not diagnosed
terrain holes. The earlier numeric zero-hole result does not settle them.

### Retained replacement opening

The scoped revision in `white-opening-fix/fit-axis-same-shoulder` changes the
opening aim toward the neighboring real valley and regenerates its links.
All five decoded closing-summit lanes (`s`, `eye`, `aim`, `fov`, `flow`)
remain exactly equal to the first R6 summit geometry. The raw entrypoint is
`white-opening-fix/same-shoulder-records.mjs`. An inner-shoulder alternative
regressed to about 75 seconds; its completed fit is preserved and rejected.

| Anthem item | Start | End | Payoff |
|---|---:|---:|---:|
| Valley-axis opening | 0 s | 72.231 s | 48 s |
| High connection to summit | 72.231 s | 108.300 s | — |
| Preserved summit traverse | 108.300 s | 167.985 s | 128 s |

Total and longest transit are **36.069152 seconds**, a reduction of
**33.976543 seconds (48.51%)** from R5. The plan still has two formal payoffs;
the first arrives at **48 seconds**, later than R5's 16-second payoff.
The scenic image is already readable before that formal payoff, but this
review does not establish that the later timing is musically preferable.

Independent image re-review inspected all **17 whole-frame contact pages**
covering all **657 saved final images**, plus **14 native PNGs**. At Anthem
**4/16/32/36 seconds**, sky, separate ridges, distant terrain and valley haze
communicate landscape space instead of the rejected downward crop. The
opening remains quiet and sustained through 72 seconds. Native pairs around
**72.231 and 108.300 seconds** show no obvious saved-frame cut or pose jump.
The **128-second** summit and **156–167.975-second** ending retain the larger,
readable mountain face with sky above. The independent reviewer marks the
previous important opening gap addressed and finds no new critical or
important issue in the scoped review. Retain this revised candidate.

The distant flat/stepped contours, bright snow and minor moon/crest tangent
remain documented. Their cause and geographic correctness are unjudged;
there is no diagnosed terrain hole. Four-fps images do not establish
full-speed perceptual smoothness, and no audio was auditioned.

The final fit uses **536,536 added bytes** under White's original 800,000-byte
cap, **1,540,676 desktop / 879,224 mobile triangles**, and a **17,979,136-byte**
tour forest bound under 167,772,160 bytes. It reports zero budget errors,
coverage holes and LOD violations. Independent clearance enumeration extends
the worker's 33,061 samples to **45,294 samples across 35 support cases**,
including unused returns and one-sided supports. Scenic/link floor margin
is at least **587.961 metres**; selected 60 Hz timeline margin is
**593.900 metres**, with zero invalid samples. These remain finite sampling
checks. Exact key-spline climb is **16.892 m/s** under the original 22 m/s
limit; the other retained motion gates pass. The 3.5 m/s² tangential cap does
not bound all vector or sideways acceleration components.

| Final White file | SHA-256 |
|---|---|
| Shots manifest | `ad906abd178bbfe82ba53430f8993cad99f85be8bdf84604fe3cf56d4cf4c4cb` |
| Shots payload | `1e87c40cba9a5a781725b17b187b95cd0ded8b921ba24ab855821ac0000e8fe2` |
| Terrain manifest | `65c323bf32b3dd5818516cf2a70e95a9d74a4d1b4590d1a3d52ab1f6bf647d84` |
| Terrain payload | `bfa47b182a6cd3a5d5f67256bc76e42801988a9994f77a04570d44dc441a069f` |

## Evidence coverage and validation limits

Matched full tours continuously render the actual app from song start to
cutoff, saving **657 frames per arm** at 4 fps from **4.000 to 167.975 seconds**
at 640 × 360, quality zero. The first fade is drawn but unsaved. Chromium
156.0.8078.4 reports NVIDIA RTX 3060 through ANGLE/D3D12. Captures run
headless, muted and isolated. PNGs and actual saved timestamps are the
image evidence; audio-backed video copies do not establish an audio audition.

For the final Izta and repaired White arms, actual worker plan items and
all four restored timeline lanes (`eye`, `target`, `fov`, `meta`) match
production CPU replay. There are no reported capture errors. Four-fps
sampling cannot certify high-rate jerk, every internal draw, live frame rate,
other songs/seeds, mobile behavior or owner artistic acceptance. Shared
153.5-second flashes/block marks are preserved observations in both arms.

Original-rail comparison at nine stations for White's final terrain passes
numeric checks; root inspected all three native pair sheets and retained its
terrain/forest parity. The earlier nine-station Izta check and three native
pair sheets still apply because its final asset bytes are unchanged. These
are neutral-light station checks, separate from whole-song scenic playback.

Fresh source checks at `f7b7b16` report **5,048 tests: 5,043 passed, zero failed,
five skipped**; lint exits zero and stored snapshots are unchanged. A
separate cached-DEM run passes **19/19**, covering four cache-dependent skips;
a separate published Monument library test passes **1/1**, covering the fifth.
Those extra runs remain distinct from the full-suite count. Final all-15
Anthem CPU replay changes only White and Izta relative to R5, with no timeline
or climb failures. The other 13 plans and keys match exactly, including the
R5 Panamint and Teton repairs.

## Source, candidate assets and diagnostic playback

The source proposal is [draft PR #38](https://github.com/aepler315/midio-pixel/pull/38).
Its starting main is `1b46e5e3fad38b7b8c75d2391af2e6b79500bfff`;
R6 uses the later source and R5 asset pins stated above. The separate
[review/scenic-camera-wave-20261023 asset branch](https://github.com/aepler315/midio-pixel/tree/review/scenic-camera-wave-20261023)
carries the reviewed candidate packages. The final candidate has **15 libraries, 144 shots and 335 links** in a
**64,125,061-byte Range asset tree**. Tombstone remains rail-only. The R6 asset
changes are White and Izta's shot/terrain packages and build metadata, plus
library identities in regional configuration and generated catalog data;
regional configuration excluding library identities remains unchanged from R5.
The runtime implementation is unchanged.

The final served snapshot has **682 files**, digest
`1ddf3ecac2ea3f87c455785251c92f8fb04920d3308c18fc06574e58951f2209`.
The inventory belongs to this final snapshot; the earlier combined snapshot
included the rejected White opening. Its byte total must not be substituted
for this result. Exact published commits, parent/tree identities, changed-file
scope and independent remote readback are recorded in
`publication-readback-proof.json` in the external evidence folder below.
No merge, deployment, owner acceptance or geographic approval is claimed.

On the review asset branch, use Node 24 and the existing server:

```sh
npm ci --ignore-scripts
node tools/serve.js 8080
```

Upload the same `anthem.wav` in Landscape and use the appropriate URL:

```text
http://localhost:8080/?rangeView=izta-popo-west&rangeShots=all
http://localhost:8080/?rangeView=white-mountains-owens&rangeShots=all
http://localhost:8080/?rangeView=black-mountains-catawba&rangeShots=all
```

These force candidate review and still enforce package/base identity. They
do not approve a camera or reproduce the matched capture clock by themselves.
Black continues to use its preserved R5 assets.

Captures, prototypes, failed candidates, reports and proofs stay outside Git:

```text
C:\Users\aeple\Documents\ChatGPT\Midio Pixel\verification\rebuild-20261022\camera-wave-r6
```

Key evidence is `izta-technical-review.md`, `izta-visual-review.md`,
`izta-popo-west/fitted-early-orbit/final-report.json`,
`white-technical-review.md`, `white-visual-review.md`,
`white-mountains-owens/findings.md`, `black-mountains-catawba/decision.json`,
`white-fix-technical-review.md`, `white-fix-visual-review.md`,
`izta-final-delivery-review.md`, `final-inventory.json`,
`final-all-15-anthem-cpu.json` and `final-rail-parity/`.
The local gallery `actual-app-camera-wave-review.html` includes final White
and Izta matched clips and the rejected first White replacement. Historical
R5 documents and captures remain unchanged.
