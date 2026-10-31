# Camera scouting audit — 2026-10-22

> Historical record. The scope, preservation rules, approval/hold decisions and validation steps below describe this past task, not current development prerequisites. Experiments and local commits follow the [current development policy](experimental-development.md). Recorded results and runtime eligibility remain evidence of the version reviewed.

**Implementation follow-up:** the [camera scouting fixes](camera-scouting-fixes-2026-10-22.md)
address discovery coverage, independent tour approval, review identity, the
retired global size ceiling and the confirmed planner/tool defects. The findings
and verification below retain the original audited source and historical state;
they do not describe the follow-up implementation's current behavior.

This audit covers Claude's recent work on camera locations, framing and routes in
`aepler315/midio-pixel`, against main commit
[`05725b8b753f18234ab9f3aa21b7c5c6cc4d12ac`](https://github.com/aepler315/midio-pixel/commit/05725b8b753f18234ab9f3aa21b7c5c6cc4d12ac).
It changes documentation only. [The expansion proposal](scenic-view-expansion.md)
considers roughly 30 approved geographic views; it does not approve new locations,
camera changes, package changes or shot libraries.

## Assessment

The useful advance is a reusable way to discover complete camera moves, score
their composition, connect them and fit their terrain and forest footprint.
Connected selection, checks against the packaged terrain and a preserved rail
fallback are sound foundations for a larger catalog.

The recent work explores alternative shots **within the existing 13 locations**.
It has not delivered 30 locations, replaced the approved rails or enabled the
reported candidate libraries in production. Its remaining weaknesses are early
angle pruning, a mismatch between the documented approval model and runtime,
incomplete retained review evidence, and long travel between payoffs.

## Scope and provenance

| Source | What it establishes |
| --- | --- |
| [PR #24](https://github.com/aepler315/midio-pixel/pull/24), merged as `c640e41778273cdc06b76a2fe5eb39aa6ceeb46f` | Discovery, scoring, packaging, runtime and first graph selection |
| [PR #25](https://github.com/aepler315/midio-pixel/pull/25), merged as `dd0c3ab49d32526bf15015dc6a3776b1b25c0064`; source head `fb08bcece9c2ce47cb1e473220b38724de38e7e8` | Connected selection, horizon policy, forest fitting, review and planner revisions |
| Current catalog v19 | 13 approved views, four forced candidates, 11 biomes; no shot manifest references |
| Current tour configuration | 13 regional entries, all `candidate` |
| Current tracked assets | Zero `.shots.json` or `.shots.bin.gz` files |
| PR #25's round-3 table | Reported local builds: 150 shots and 368 links in 12 regions; Tombstone blocked |
| [Evidence prerelease](https://github.com/aepler315/midio-pixel/releases/tag/scenic-tours-evidence-r3) | 15 retained attachments; release target `627f7a6680dc87b23ceef5439659afa3d8116ed1`, before the final review fixes |

The two tour PRs did not change `scenic-views.json`, generated
`sceneCatalogData.js` or packaged Range assets. The approved rails therefore
retain their earlier authoring and approval provenance. PR #25 says its round-3
builds came from `8851754b6036619fe86efb91657299c37fc377dd` and explicitly
says the generated libraries were not committed. Its word “published” means
written into the local working tree used for smoke checks.

Repository source and asset identity were refreshed for this audit: all 1,558
tracked blobs match GitHub, and the reconstructed tree is
`dbfd16247a521cb14c3b4c57380c84bb29bd6f0d`. Local probes below use production
functions or an extracted production expression. No new visual or device
acceptance is claimed.

## Findings

### C01 — Candidate thinning removes angle alternatives before scoring

**Priority:** P2, scouting quality. **Evidence:** reproduced on a controlled
synthetic DEM; source-confirmed ordering.

[`generateShots`](https://github.com/aepler315/midio-pixel/blob/05725b8b753f18234ab9f3aa21b7c5c6cc4d12ac/tools/lib/scenic-shots.mjs#L510-L558)
generates azimuths beginning at the approved rail's side, appends preferred
azimuths, then retains at most 48 candidates per subject by round-robin over
move/tag groups in insertion order. The builder calls that default before
scoring (`tools/build-scenic-tours.mjs:180`).

On a synthetic cone, with eight base angles, rail azimuth 180° and a preferred
203°, the default retained ten orbit and ten traverse candidates all at 180°.
Approaches covered only 183° and 228°. Changing only the cap to 10,000 admitted
108 orbits and 162 traverses spanning all nine angles, including 203°.
This demonstrates an ordering bias, not the artistic quality of the missing
angles on real terrain.

**Cause and consequence:** move diversity survives thinning, but azimuth,
distance, elevation and direction diversity can disappear before the expensive
scorer sees it. Additional views would inherit that bias toward their existing
rails.

**Recommended follow-up:** stratify the fixed candidate budget across move,
azimuth, distance and elevation, including preferred angles explicitly; test
invariance to enumeration order. Rendering everything is an alternative with
substantially higher offline cost. Measure the retained-angle funnel on real
regions before changing the policy.

### C02 — Separate tour approval is documented but not enforced

**Priority:** P2, promotion contract. **Evidence:** direct production-function
probe and end-to-end source trace; no current production exposure.

The regional config and [tour contract](scenic-tours.md) say a view and its
tour must both be approved. In reality,
[`publishView`](https://github.com/aepler315/midio-pixel/blob/05725b8b753f18234ab9f3aa21b7c5c6cc4d12ac/tools/build-scenic-tours.mjs#L1169-L1192)
adds a library reference to view authoring, and
[`buildCatalog`](https://github.com/aepler315/midio-pixel/blob/05725b8b753f18234ab9f3aa21b7c5c6cc4d12ac/tools/build-range-scene.mjs#L180-L215)
carries its hash under the view's approval. Neither consumes the regional tour
status. Runtime
[`shotTourEligible`](https://github.com/aepler315/midio-pixel/blob/05725b8b753f18234ab9f3aa21b7c5c6cc4d12ac/src/world/alpine/RangeShotTours.js#L22-L26)
requires a library URL, valid hash and approved **view**.

A synthetic approved view with a valid-looking library identity is eligible
even when given `tourStatus: 'candidate'`; all regional config statuses are
currently candidate. Actual loading still validates asset identity. Current
production has no library references, so this is a latent promotion problem.

**Cause and consequence:** rail and library identity share one effective approval.
Publishing stales the view's approval, and re-approving it enables the library
regardless of the regional candidate flag. It can also remove the only approved
view for a biome while review is pending; Izta is the sole PINE_OAK view.

**Recommended follow-up:** carry independent rail and tour approvals through
authoring, catalog generation and runtime eligibility, keeping the approved rail
selectable while a library awaits review. Alternatively formalize a single joint
approval and remove the separate-status promise. The former gives safer staged
rollout but needs schema and regression work. This documentation update records
actual behavior without changing either state.

### C03 — Retained evidence does not support blanket round-3 acceptance

**Priority:** P2, evidence completeness. **Evidence:** GitHub PR and release
metadata read back during this audit.

The release retains Monument Valley round-2 and round-3 shot reels, one round-3
anthem tour, horizon and wet-ground comparisons, and round-2 replay/pacing
material. It does not contain the 12 exact round-3 library packages, all-region
raw review collections or all-region smoke reports. Its target commit is older
than PR #25's final source head. A release target is not proof of each capture's
complete source and asset identity.

**Cause and consequence:** broad PR-reported build/smoke results and a small
retained visual sample are being discussed together. They establish different
things. The historical prose and reported counts are useful, but cannot be
treated as fresh all-region visual acceptance. The status table in
[scenic tours](scenic-tours.md#current-delivery-and-reported-builds) now makes
that distinction.

**Recommended follow-up:** retain one review index per library revision with
source SHA, normalized DEM hashes, terrain/library hashes, exact shot IDs,
collector results, smoke report, rail parity and linked reel/planned-tour
evidence. Keep binary captures outside Git under the existing evidence policy.
This adds review and storage work, but makes review reusable across 30 views.

### C04 — The horizon rule is a rendering policy with bounded evidence

**Priority:** P2, expansion acceptance. **Evidence:** source-confirmed policy;
visual outcomes remain Claude's reported observations.

The [horizon rule](scenic-tours.md#horizon-and-the-grid-edge) admits rays leaving
the finite DEM within 12° below horizontal as sky. It tries to raise the look
until the horizon is 20% below frame top, stopping sooner if the subject would
fall below its 10% bottom margin. Later grid-edge coverage adjustment can tilt
the look down again, so this is not a universal simultaneous framing invariant.
It addresses the reported steep downward framing in earlier libraries.
The deepest reported inspected band was 11.4° at Izta.

**Cause and consequence:** the finite grid's edge stands in for the distant
horizon. “No holes” under this policy does not establish that distant geographic
terrain exists or that the boundary is invisible from every future angle.

**Recommended follow-up:** review each new landform and lens near its most
exposed grid boundary, at entry, payoff, hold and exit, including continuous
motion, wide framing and reflections where present. Enlarge the sourced DEM or
reject a shot where the surrogate fails. Do not generalize one region's bounded
inspection into universal approval. Enlarging grids increases normalization,
bake and package costs.

### C05 — More geographic views will not resolve within-view pacing

**Priority:** P2, product decision. **Evidence:** reported round-2 replays and
source constraints; not independently re-rendered here.

PR #25 and the [pacing discussion](scenic-tours.md#pacing) report 57 payoffs
across 36 replays, versus a 129 bound when each part flies at its own cap.
These are round-2 measurements, not a final-main benchmark. Selected shots are
reported 2–5 km apart, with 45–60 s legs and about two or three payoffs per
168 s song. Reward/search/pace prototypes changed the aggregate only to
61, 57 and 59.

**Cause and consequence:** connected does not mean usefully close for a song.
A large region can have attractive still frames but spend most of its on-screen
window in transit. Increasing geographic catalog size helps between-song variety,
while leaving that problem intact.

**Recommended follow-up:** compare compact clusters around fewer subjects against
broad regional circuits, measuring visible payoff gaps and the quality of transit.
Choose the desired geographic breadth and pace before rebuilding every region.
Retain travel-only passages where they serve the music; a universal payoff-count
quota would encourage repetitive or rushed footage.

### C06 — Inherited size and count gates conflict with the expansion decision

**Priority:** P2, stale expansion gates; not a current playback defect.
**Evidence:** measured bytes and source-confirmed gates.

The tracked Range asset tree contains **48,905,726 bytes in 79 files**, against
`RANGE_ASSET_LIMIT = 60,000,000`: **11,094,274 bytes free**.
The 13 approved terrain triples average about 1,530,590 bytes per view.
Seventeen similar additions imply about **74,925,763 bytes total before new
shot libraries**. This is an estimate from current packages, not a forecast of
new geography.

[`test/sceneCatalog.test.js:113`](https://github.com/aepler315/midio-pixel/blob/05725b8b753f18234ab9f3aa21b7c5c6cc4d12ac/test/sceneCatalog.test.js#L109-L114)
caps the **total** runtime catalog at 18 entries; it currently has 17 including
candidates.
[`test/sceneApproval.test.mjs:93`](https://github.com/aepler315/midio-pixel/blob/05725b8b753f18234ab9f3aa21b7c5c6cc4d12ac/test/sceneApproval.test.mjs#L80-L94)
also fixes the approved count at 13. The runtime picker itself does not impose
these caps.

**Decision and follow-up:** the owner has rejected the inherited 60 MB limit.
Retire its hard-fail paths in implementation, keep byte reporting, and consciously
replace the old count assertions with the new catalog contract. Preserve biome
coverage, candidate exclusion, integrity checks and actual runtime memory limits.
Do not remove existing features to satisfy the obsolete bundle number.
[Delivery estimates](scenic-view-expansion.md#delivery-budget) describe expected
growth; they are not new ceilings. No enforcement code changes in this audit.

### C07 — Review completeness does not prove current camera identity

**Priority:** P2, evidence reuse. **Evidence:** source-confirmed; no historical
stale review is asserted.

[`scenic-review-collect.mjs:35-45`](https://github.com/aepler315/midio-pixel/blob/05725b8b753f18234ab9f3aa21b7c5c6cc4d12ac/tools/scenic-review-collect.mjs#L35-L45)
passes only the current shot ID lists to the validator.
[`collectReviews`](https://github.com/aepler315/midio-pixel/blob/05725b8b753f18234ab9f3aa21b7c5c6cc4d12ac/tools/lib/scenic-review.mjs#L55-L74)
checks region, exact IDs and verdict coverage, without manifest, payload, terrain
or path hashes. Shot IDs contain move, subject and an enumeration index
(`scenic-shots.mjs:560`); changed paths can retain the same IDs.

**Cause and consequence:** the collector correctly detects missing, duplicate,
conflicting and unknown-shot responses, but its “complete and current” label
cannot establish that the rendered camera content matches the current library.

**Recommended follow-up:** bind reviews to source/capture provenance plus exact
library manifest, payload and terrain identities, optionally per-shot path hashes.
Keep the present coverage checks. Stricter identity can require more re-review,
but prevents older judgments attaching silently to rebuilt cameras.

## Other open review findings

PR #25 has four unresolved, current P2 review threads as checked on 2026-10-22.
A merge does not close these findings.

| Finding | Evidence and current confidence | Follow-up |
| --- | --- | --- |
| Reel endpoint selects first shot but labels last | [Review](https://github.com/aepler315/midio-pixel/pull/25#discussion_r4347416875); `tools/shot-reel.mjs:86,94-99`. Reproduced by evaluating the extracted source expression with two spans: at the final end time camera = first, label = last. `Math.max(0, findIndex(...))` makes the -1 fallback unreachable. | Resolve the index before clamping and cover the inclusive final frame. This affects the endpoint when capture lands exactly on it; it does not invalidate every reel frame. |
| Ground-truth hit can refer to an off-screen target | [Review](https://github.com/aepler315/midio-pixel/pull/25#discussion_r4347416883); `tools/plan-scenic-tour.mjs:298-302`. A production metric probe gave a 15,900 ms target `visible:false, hit:true` for a payoff at the 16,000 ms window boundary. | Require target visibility in hit counts and denominators; test both sides of visibility seams. |
| Cold tables are prepared synchronously before worker creation | [Review](https://github.com/aepler315/midio-pixel/pull/25#discussion_r4347416858); `ShotRuntime.js:18-25,29-48`. Synchronous call order is source-confirmed. Review timing of 24–61 ms is externally reported, not measured in this audit. | Measure cold request preparation separately from worker planning, then consider worker-side table caching. |
| In-link ending considers only the top-scored alternative | [Review](https://github.com/aepler315/midio-pixel/pull/25#discussion_r4347416896); `ShotPlanner.js:880-894`. Source confirms the `j !== top` exclusion; the reported five-second counterexample was not independently reproduced here. | Reproduce the feasibility counterexample before changing the search; evaluate all relevant Pareto alternatives within an explicit search budget. |

Subject `weight` is retained as discovery metadata, but there is no observed
consumer of that weight in scoring/selection. The documented `avoid[]` field
also has no implementation in this pipeline. Treat these as unsupported authoring
controls until they have explicit semantics and production tests; `hero`,
`excludeShots` and generation-time `preferAzimuthDeg` do have consumers.

## Verification and limits

- Node 24.10.0 full suite: **4,879 tests, 4,857 pass, six fail, 16 skipped**.
  Five failure entries concern asset/staging paths containing literal `%20`;
  one is the sky-pan assertion in
  `rangeAtmosphere.test.js:213`. See the exact breakdown below.
  These were run against unchanged application/test source; they are not a
  green-suite claim. `npm run lint` passed.
- Full-suite failure breakdown: four `stageSite.test.mjs` cases fail with
  `ENOENT` on paths containing `Midio%20Pixel`; `rangeSceneFraming.test.js`
  fails from an asynchronous asset read after a test ends, on the same encoded
  path. The sky-pan case reports “the scene pose drives the pan.” These are
  retained as failed checks, not silently skipped.
- Fresh status command reports all 13 configured regions as rail only. On this
  clean checkout “not built” means there is no local `.smoke/.../fit.json`;
  it does not deny the historical builds reported in PR #25.
- Focused scenic, shot, catalog, approval and runtime suites: **179 tests,
  174 pass, zero failures, five skips**. These are contract checks, not a visual
  verdict. The existing skipped cases remain unexecuted.
- Markdown local-link checks pass for all five edited documents, and
  `git diff --check` passes. Only those five Markdown files are included.
- Production-code probes confirm the candidate-gate mismatch, reel endpoint and
  visibility metric examples above. The controlled angle probe tests enumeration,
  not real-region artistic quality.
- The actual-tree asset budget check returns no errors at the audited source.
- No GDAL rebake, browser capture, physical-device pacing test or new aesthetic
  promotion was performed. Historical smoke/reel outcomes remain attributed to
  their original source. This audit does not establish deployment or owner
  acceptance.
