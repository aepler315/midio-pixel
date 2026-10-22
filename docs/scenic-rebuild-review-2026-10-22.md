# Fresh scouting rebuild and application review

This follows the [scouting fixes](camera-scouting-fixes-2026-10-22.md) at
`f51c27f7855ca6a3f163f77afaee4827438e2973` and begins the
[first geographic expansion wave](scenic-expansion-wave1-2026-10-22.md).
The work is on `feat/scenic-rebuild-batch-one-20261022`, based on the unmerged
implementation branch. Main was checked at
`8a5a1e362e4da2dda21a4cc523909b1eeb0bfda1`; neither merge nor deployment is
part of this review.

## What is being rebuilt

Fresh discovery runs the corrected stratified generator, render gates,
connected selection and terrain fitting. It does not use `--reselect` or
reuse the old scored graph. All 13 existing regions have their original,
parameter-keyed normalized DEM grids restored from the preserved Claude
checkout. Every height/validity payload was verified against its recorded
hash and length before and after transfer. This avoids silently acquiring
different source data while changing the cameras.

The five exclusions from the earlier review are retained as
`historicalExcludedShots` in regional authoring. Shot IDs contain a global
enumeration index; after stratification an old ID can identify different
geometry. Those IDs therefore do not exclude fresh candidates. Exact old-path
recurrence is checked separately, and an absent exact match does not establish
that a similar visual defect is gone.

The build command for each region is:

```sh
node tools/build-scenic-tours.mjs --view teton-jackson-lake \
  --workers 8 --render \
  --out .smoke/rebuild-20261022/libraries/teton-jackson-lake
```

The local batch uses three concurrent regions. Its execution records preserve
commands, completion states, elapsed times, fitted byte counts, source/config
identities and coverage results. The three new regions join the queue after
their revised candidate rail packages are staged. Tombstone's existing
source-drift restriction remains active.

The first three build processes loaded the `f51c27f` driver before the
connection-pruning correction. Their final graphs are already connected, so
the correction preserves their selected links. Denali started 43.67 seconds
before the final corrected driver's recorded modification time; its exact
loaded driver hash is unconfirmed. The stratified discovery code did not
change during this correction. Later processes start after the final driver
cutover. Per-region execution timestamps, source-cutover facts and independent
package/connectivity checks retain this distinction instead of attributing
every build to the final source hash.

## Connection pruning found during the rebuild

An independent graph audit reproduced another defect in the current offline
selection code: ten shots and 42 scored links formed one strongly connected
graph, but the outgoing-link preference discarded both low-scoring bridges
between two scenic clusters. The resulting ten shots and 40 links were two
closed five-shot loops. Every shot still had a way in and out, so the old
orphan check accepted them as one tour. Preserved R3 Muncho and Black Mountains
artifacts also contained separate components; those historical artifacts are
not fresh build results.

The correction preserves link output for an already connected selection. When
local ranking splits a component, it restores actual scored Pareto links,
then removes redundant links to make room without breaking connectivity.
Relinking after a shot is dropped keeps the best actual strongly connected
tour and its fallback rail. The rail can participate in a useful cycle or
remain isolated as fallback. An isolated shot's self-loop is insufficient.

`maxLinksPerShot` was already a preference because the incoming-link restoration
could exceed it. A graph that genuinely requires more outgoing links now
reports that exception in `connectivity.overCap`, the selection funnel and
`fit.json`. All retained bridge footprints still count toward byte, triangle
and forest limits. No fit threshold is relaxed.

Four regression cases failed before the correction and passed afterward. The
independent production reproduction now retains both bridges, all ten shots,
40 links and one component, still meeting the preferred cap of four. Connected
fresh fits can be retained unchanged. Any split fresh fit is selected again
from **this run's freshly discovered and scored graph**; an old Claude graph
cannot supply the new angle coverage or weights. Original build artifacts and
replacement selection outputs retain separate identities and execution records.

## Production rails and review assets

Rebuilding coverage for a shot library can change the terrain-manifest hash
even when the authored rail is unchanged. Existing rail approvals bind to
exact terrain bytes. Publishing all rebuilt packages over the originals
would stale those approvals; technical success is not permission to renew them.

The 13 approved rail terrain/build triples remain unchanged. Rebuilt library
terrain is instead staged in a separate temporary review checkout using
`--publish-from <exact-fitted-directory>`. Its catalog marks stale bases and
all tours as candidates. `rangeShots=all` permits diagnostic playback while
retaining terrain, payload and base-identity checks. Production keeps its
approved rails until the appropriate base and tour reviews are complete.

Only the three new geographic candidate packages are added to the expansion
branch's runtime assets. Catalog v20 has 20 entries: 13 approved rails and
seven candidates. No new geographic view or tour is approved here.

There is no global 60 MB asset ceiling. Delivery bytes, per-region fit caps,
triangle/forest costs and runtime graphics residency are reported separately.

The status CLI previously inferred a tour's approval from its base rail's
status. It now uses the runtime tour-eligibility contract and verifies the
actual manifest, payload and terrain identities. Candidate, rejected and
stale tours remain distinct. A malformed readable manifest produces a stale
row instead of aborting the table. To inspect this batch's fit records:

```sh
node tools/scenic-tour-status.mjs \
  --build-root .smoke/rebuild-20261022/libraries --markdown
```

The table labels catalog tour status separately from build-fit counts and
costs. Choosing a build directory neither publishes its packages nor approves
them. It does not search sibling or historical directories implicitly.

## Application capture controls

The review uses actual upload, analysis, worker planning, export-clock drawing,
terrain material, forest, sky and weather in the application. Immutable public
snapshots are served from verified content hashes. A reel override is a
separate diagnostic: individual shots with cuts do not establish link quality
or the pacing of a song-planned tour.

Matched rail baselines use the generated 168-second `anthem.wav`, construction
seed 315 and actual song seed 2031031581. The audio SHA-256 is
`a691d46ebb2575a1ff5841960a50e39acb41cd085852f0a6b59030354b8fca90`.
The baseline public-source digest is
`565e2a80743abd28d0e59bf2cffd7c95639d9e2d4f3d21a9e32e63a13c7b5753`.
Each opening-passage comparison fixes quality 0, 640×360, 8 fps and
12.000–15.875 seconds. This bounded passage does not verify history before
12 seconds. The longer candidate manifest draws continuously from zero
through the 168-second ending at 4 fps, with saved windows derived from the
actual plan's moves, links, payoffs and outro.

Successful hardware baselines use Chromium 156.0.8078.4 and the recorded
renderer `ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce RTX 3060),
OpenGL ES 3.1)`. The candidate gate requires that renderer. On this WSL host,
the headless hardware configuration is:

```sh
GALLIUM_DRIVER=d3d12 MESA_LOADER_DRIVER_OVERRIDE=d3d12 \
MESA_D3D12_DEFAULT_ADAPTER_NAME=NVIDIA \
LD_LIBRARY_PATH=/usr/lib/wsl/lib:/usr/lib/x86_64-linux-gnu \
VISUAL_ANGLE=gl node tools/visual-evaluate.mjs --manifest <manifest> --out <new-output>
```

Use the installed compatible Chromium 156 headless shell. An older explicit
Chromium 153 executable could create a simple WebGL context but failed the
application's Three.js context on this host. The earlier software runs and
failed runner/browser attempts remain saved; they are not matched hardware
baselines or successful rebuilds. Hardware rendering here does not certify
foreground playback, physical display scanout, phone performance or owner
aesthetic acceptance.

For each candidate capture, retain the actual worker-produced plan, song seed,
library and terrain identities, visible intervals, moves, payoffs and drawn
camera. Saved frames are checked against that timeline's eye and forward
direction. A 60 Hz audit of the exact application timeline reports motion
and ending limits; it does not replace watching the rendered movement.

## Evidence and disposition

Captured PNG, audio, MP4, HTML and JSON evidence stays outside Git under
`.smoke/rebuild-20261022/` and `.smoke/expansion-20261022/`. The adjacent local
`verification/rebuild-20261022/` directory retains immutable snapshots,
acquisition inventories, exact commands, report hashes and the review helpers.
The GitHub connector available for this run cannot upload Release assets;
local evidence is not represented as a durable remote attachment.

The matched baselines passed for Teton, Monument Valley and Ross Lake, with
32 consecutive frames each and zero browser errors. At `anthem` 12–16 seconds,
Teton holds its skyline and broad lake reflection, Ross holds layered ridges
with a large dark foreground, and Monument Valley holds a distant mesa above
soft foreground terrain. All three brighten late in the same passage. That
shared light/weather change must be separated from camera motion when
assessing the rebuilt tours.

The first completed fits and planned-move findings follow below. Remaining
regions are still building. None of the baseline observations, fit checks or
capture controls automatically promotes a candidate.

The source audio is retained with exact frame players and MP4 previews.
Auditory input was unavailable to the reviewing agent, so the review does not
claim to have heard or aesthetically accepted the musical coupling. The actual
camera, timeline and rendered-image observations remain independently useful.

## First completed libraries and actual moves (R1)

These initial results precede the terrain-presence correction described below.
Their snapshots and captures remain immutable evidence. The final R2 selection
uses this run's fresh cached graphs and receives a new app review whenever its
package or camera identities change.

The first-three public snapshot digest is
`78bfe215572634c878f9e528490f06fc3c0dd659caf99938707bf27225edb501`.
All 656 frozen files were rehashed. Each of these packages passed its final
fit, render and nine-station rail-parity comparison. All non-rail shots are
mutually reachable in the full selected graph; an isolated fallback rail is
permitted. Byte additions include shot packages and added terrain coverage.

| View | Shots / non-rail / links | Added bytes | Source drift | Initial app disposition |
| --- | ---: | ---: | --- | --- |
| Teton / Jackson Lake | 10 / 9 / 26 | 1,116,251 | false | Retain for review; repeated approaches and long transit need work |
| Monument Valley | 18 / 17 / 54 | 1,158,808 | false | Retain for review; close opening and dark cropped ending need work |
| Ross Lake | 8 / 7 / 19 | 1,207,146 | true, previously allowed rebake | Retain for review; repeated orbits, long transit and dark ending need work |

Compared with the preserved R3 artifacts, Ross grows from 6 shots/9 links to
8/19, Monument grows from 16/39 to 18/54, and Teton shrinks from 13/28 to
10/26. Teton's recorded non-rail azimuths move from 45-degree bins 0–2 to
bins 4–6, demonstrating that the fresh selection reaches the previously
undersampled side. It does not retain more move families: four fresh
families replace six in that historical library. Ross still retains only
two distinct subjects. Those are measured artifact differences, not an
otherwise identical baseline experiment or evidence that every region has
full-circle selected coverage. The actual song plan can also use a much
narrower subset than its library provides.

Monument's actual song plan selects two traverses and a valley payoff, with
payoffs at 8.1, 64.5 and 128 seconds. The 12–16-second comparison replaces a
distant mesa panorama with a near-buttes traverse and visible foreground
parallax. The join around 18.4 seconds reads continuously in the captured
sequence; the 34–38-second transit opens wider butte context. The Mittens are
legible at the 126–129.75-second hero passage. The last four seconds remain
dark with a large cliff cropped at the left. Three links occupy roughly
30–36 seconds each. A useful selected library is not yet a fully paced edit.

Teton's plan uses two approaches, with payoffs at 48 and 128 seconds. The
opening shows deeper peak layering and foreground movement in place of the
rail's lake panorama. The first approach lasts about 65 seconds; its join
into a 42.69-second link appears continuous at 62.95–66.70 seconds. The
84–88-second transit opens distant ridges as a foreground peak passes left.
Mount Moran remains readable above fog at 126–129.75 seconds, and the ending
holds wide layered peaks while still inside a link. These frames support
retaining the camera material, with repeated move families and long holds
still open editorial issues.

Ross's plan uses two orbits, with payoffs at 16 and 128 seconds and one
3.93-kilometre link from 35.14 to 104.50 seconds. That link lasts 69.36 seconds
at the song's selected comfort pace. The builder's `maxLinkS` currently gates
the fastest feasible duration; this longer playback does not demonstrate a
bypassed builder gate. The join frames around 33–37 seconds remain continuous,
and the 67.8–71.6-second transit gives Jack Mountain readable context behind
the foreground ridge. The hero keeps a clear outline as weather darkens its
face. The ending is a low-contrast central silhouette. Repeated orbits, long
transit and that dark ending remain reasons to withhold aesthetic approval.

These are actual worker-planned tours, with camera assertions against the
application timeline and 4 fps drawing history from song start. Saved
sequences cover moves, joins, link interiors, payoffs and the ending; matched
opening captures use 8 fps. They do not establish smooth physical playback
between sampled frames. Six bounded 8 fps supplements inspected the sharpest
measured vector-acceleration and yaw windows, 32 frames each. No camera snap or
terrain gap appeared in those windows. Ross's yaw passage has a brief brightness
pulse without a matching camera discontinuity; its cause is unisolated. Peak
vector acceleration was 19.62/19.31/14.91 m/s² for Monument/Teton/Ross. The
existing policy does not cap sideways acceleration; these values are reported
separately from tangential/yaw limits and are not labeled failed gates. The
captions' separate
HORIZON and MASSIF names describe the song's independent skyline cast; VIEW
names the curated terrain, as specified by `sceneCaptionFor`.

## Denali exposed an all-sky link

Denali's R1 fit produced 13 shots and 30 links, with connected non-rail moves,
no final coverage holes/LOD violations and passing rail parity. Actual app
review nevertheless found a blank sky passage in
`link-valley-mount-foraker-085-valley-denali-022-rev-direct`.
The 66.125–69.875 and 67.417–71.167-second saved sequences contain only sky.
The terrain is loaded, the renderer is ready and no resource-admission denial
is recorded; drawn eye/forward still match the actual planned timeline.

The endpoint viewing directions differ by 146.362 degrees, which invokes
`scenic-links.mjs`'s spherical direction blend. Both endpoint pitches are
about 12 degrees upward; their spherical turn reaches about 45.3 degrees
upward in the middle. The near-vertical guard allows this, while the link's
weakest-window penalty can only halve its score. The old score is about
0.09534 with zero coverage holes. Coverage and view composition are distinct.

Actual production-depth readback has zero finite-depth pixels out of 74,624
at every integer-second sample from 58 through 83 seconds. The 57-second
sample has one finite pixel; 84 seconds has 84. These are 26 sampled zero-hit
observations spanning 25 seconds, with boundaries bracketed by 57–58 and
83–84 seconds; they do not claim inspection of every live frame. Both named
payoff compositions remain readable. The R1 link is marked for rework.

The correction records exact `minTerrainFrac`, `allSkySamples` and
`visibilitySamples` during existing CPU link scoring. A link must contain
finite terrain in every scored frame. This is a zero-terrain floor, with no
arbitrary pitch or quality-score cutoff: the same high look remains valid
when a real mountain occupies its frame. Fresh generation rejects empty or
unmeasured variants before Pareto selection. Reselection measures missing
evidence once across the entire retained fresh front, preserving existing
paths, scores, durations and flow. Only validated pairs reach connected
selection and later budget/forest relinks. Packing and publication also fail
closed when retained-link evidence is empty, invalid or missing.

Per-link evidence is packed without rounding a tiny positive fraction to
zero, and the report and fit retain gate summaries. CPU scoring samples
every 120 metres at 96×54; this technical floor does not certify every live
frame, musical lens change, transit quality or artistic acceptance.

The patch was prepared and tested in an isolated copy of `6cac5b0`, then
applied at 2026-10-22 21:23:21 UTC. Pausing only the launch controller for
0.153 seconds prevented a new job from reading partially updated files;
already-running builds continued. All pre-cutover outputs are retained as
R1 history and reselected to separate R2 directories from **this run's fresh
stratified graphs**. The retained old Pareto fronts cannot recover variants
discarded before they were cached; they can still produce a fully measured
safe candidate pool. No historical Claude graph replaces fresh discovery.
A clean R2 stage avoids carrying an old R1 library forward if a new selection
becomes rail-only or fails.

The copied-cache Denali proof measures all 817 retained variants: 776 retain
terrain in every scored frame, 41 have an all-sky sample and none remain
unmeasured. After removing only the three added fields, its enriched graph
exactly matches every original field. Final fitted and app results are
recorded with the R2 batch rather than inferred from this CPU proof.

## Source validation snapshots

The connectivity correction and final candidate data were tested on Node
24.10.0 with system GDAL 3.12.2, using a byte-copied source directory without
spaces to avoid the encoded-path harness issue. The completed post-status suite ran
4,968 tests: **4,960 passed, two failed and six were skipped**. The failures
are the sky-pan assertion at `test/rangeAtmosphere.test.js:213` and the
synthetic 18-shot/594-link cold-planning timing threshold at
`test/shotPlanner.test.mjs:190`. Both failures also reproduce on the unchanged
parent `f51c27f`; the timing comparison used reserved physical CPU cores.
The thresholds remain unchanged, and the full suite remains red. Six checks
that previously skipped for missing GDAL now execute. Linking the restored DEM
cache into the final isolated test copy enabled another four real-data checks,
which passed. The remaining six full-suite skips are five Chromium-dependent
checks whose executable was not configured in that command, and one check
requiring a library published in the primary checkout. All five exact
Chromium-dependent cases subsequently executed and passed in targeted runs
using their prescribed/default SwiftShader launches on Chromium 156. The route
deadline case initially failed because the copied source lacked Git metadata;
a temporary metadata-only Git pointer allowed the unchanged case to exercise
and pass all four routes, then was removed. Both attempts are retained.
The published-Monument case remains unexecuted in the primary checkout.
These separate passes do not rewrite the full-suite skip count or establish
device performance.

All 53 connectivity-targeted tests pass, including four new regressions;
all 47 status/runtime/catalog/review-targeted tests also pass, with four new
status regressions covering approval, stale bytes, malformed data and explicit
build roots.
Lint and whitespace checks pass. Independent source, capture-harness and
candidate-integrity reviews found no P1/P2 blocker. All 1,511 non-Markdown
files in that post-status snapshot matched before the subsequent four-file
terrain-presence correction. The correction passed 88 targeted tests with
zero failures/skips, full lint and independent source review. Six initial
regressions and three unsafe-publication mutation regressions failed before
their fixes. A new full suite on the integrated correction runs separately;
its result is recorded with the final R2 validation.

The source and first three terrain candidates are published in
[draft PR #31](https://github.com/aepler315/midio-pixel/pull/31), stacked on
[draft PR #29](https://github.com/aepler315/midio-pixel/pull/29). Its initial
checkpoint is `21878a1ae3ba2eacf5c4445f4b5a38784963e362`, with sole parent
`f51c27f7855ca6a3f163f77afaee4827438e2973`. The remote commit, tree, comparison
and all 20 changed blob identities were read back and verified. This records
publication of the candidate work; it is not a merge, deployment or approval.
