# Fresh scouting rebuild and application review

This follows the [scouting fixes](camera-scouting-fixes-2026-10-22.md) at
`f51c27f7855ca6a3f163f77afaee4827438e2973` and begins the
[first geographic expansion wave](scenic-expansion-wave1-2026-10-22.md).
The work is on `feat/scenic-rebuild-batch-one-20261022`, initially based on the
implementation branch while it was unmerged. Main was initially checked at
`8a5a1e362e4da2dda21a4cc523909b1eeb0bfda1`. During the rebuild the owner merged
PR #29 into main at `6feed187f7cfe82ff11ec734e784208aabb78f78`, then merged
PR #31 into the implementation branch. The follow-up source at `aafb89ee7cc68e655bde9b41937b3742f63b6d7e`
therefore still needs [continuation PR #32](https://github.com/aepler315/midio-pixel/pull/32)
to reach main. Main's separate pixel-presentation changes are not represented in
the exact-source captures below. No merge or deployment was performed by this review.

## What is being rebuilt

Initial discovery runs the corrected stratified generator, render gates,
connected selection and terrain fitting. Those initial runs do not use
`--reselect` or reuse an old scored graph. The subsequent R2 selection below
uses only the fresh graphs produced by these runs. All 13 existing regions have their original,
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

The local batch used three concurrent regions. Its execution records preserve
commands, completion states, elapsed times, fitted byte counts, source/config
identities and coverage results. The three new regions joined the queue after
their revised candidate rail packages were staged. Tombstone's existing
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

The first wave's 84 new directed seam pairings, with 74 passes and ten
failures, apply to the initial new-rail source freeze
`d1e7337d52dc8904cdb3cd5a8dc108836f79163ac0fa628f590d8719a6749177`
and the 13 unchanged primary rails. They do not transfer to the R2 rebaked
terrain identities. A passing per-view rail comparison is not a composite
seam certificate; R2 cross-view seam acceptance remains pending.

There is no global 60 MB asset ceiling. Delivery bytes, per-region fit caps,
triangle/forest costs and runtime graphics residency are reported separately.

The status CLI previously inferred a tour's approval from its base rail's
status. It now uses the runtime tour-eligibility contract and verifies the
actual manifest, payload and terrain identities. Candidate, rejected and
stale tours remain distinct. A malformed readable manifest produces a stale
row instead of aborting the table. To inspect this batch's fit records:

```sh
node tools/scenic-tour-status.mjs \
  --build-root .smoke/rebuild-20261022/selected-libraries --markdown
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

GPU depth observations below measure **drawn-surface coverage** in the production
depth scene: terrain, mapped river surfaces and tree depth geometry, excluding
sky and atmosphere. They are not a terrain-only segmentation or final-color
readability score. The observer runs after each saved image/camera record and
restores render state. The CPU link-scoring terrain floor is a separate measure.

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

All 16 regions have finished and are classified below. Actual move review is
recorded separately from the fit outcome. None of the baseline observations, fit checks or
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
exactly matches every original field. Its fitted replacement has 12 shots,
32 safe links and 11 mutually reachable non-rail shots. The known blank-sky
link is absent; the minimum sampled terrain fraction is 0.11168981481481481.
The one-iteration fit has zero coverage holes and zero LOD violations, adding
777,333 bytes including a 54,407-byte shot library. This isolated proof loaded
the builder before the publication-only guard was added, while scoring,
selection and fitting match the final correction. It remains validation
evidence. Exact committed-source fitted and app results are recorded with
the R2 batch rather than inferred from this proof.

## R2 application checks

The first clean R2 snapshot, containing Denali and Teton, is
`48e9ce377c7d5e54f6b2681eb3d0e35cb0d27dde2eeb895abc29a68c69ae29f2`.
Its 654 public files were frozen from the exact integrated correction.
Both packages completed fit, render, rail-parity, native-identity and connected
graph checks before admission. Changed package identities require fresh app
captures; the R1 captures remain tied to their original snapshots.

Denali's actual R2 plan replaces its former valley pair with a traverse, a
75.104-second high transit, a valley move and a final direct transit. The
first production-depth preflight inspects 105 checkpoints: every integer
second inside both actual played links, their joins and the former blank-sky
times. None is all sky; the minimum sampled prepared-depth coverage is
30.690%. At 66.125, 68.125 and 69.875 seconds, the matched R1/R2 comparison
replaces empty sky with visible snow ridges and valley terrain. Each frame
retains its actual plan item, source/package identities and controls.

The subsequent full-history run preserves 173 distinct frames across 11
motion windows. All saved frames were visually inspected: no empty-sky
frame, visible camera snap or terrain gap appeared. Saved-frame prepared
depth remains at least 31.393%, with drawn eye error 0 m and forward error
below 6.0e-16. The close opening tightly crops a softly sculpted snow dome;
the long transit gives coherent ridge/valley context; the 128-second passage
frames an unnamed snowy peak, and the ending remains dark and low contrast.
The 48-second checkpoint also exposes a rectilinear shading boundary on a
close snow face. Depth remains present and the camera assertions pass;
its cause is unisolated, so it is recorded as a visible shading/readability
concern rather than a demonstrated coverage hole or camera-path defect.
These observations resolve the former sampled blank-sky passage for this
recording, while retaining the editorial rework below.

This is a changed selected plan, not a rewrite of the old link's path. It
uses two move families but still has a long transit. Its played shots target
unnamed DEM peaks; the retained library has a named Mount Foraker subject
but no selected shot with the named `denali` subject. This does not establish
which named mountains are visible elsewhere in those frames. A source/DEM
sanity check reproduces the named Denali point: the configured geographic
landmark agrees within 0.049 m of stored projection, and the same local
summit search reproduces the cached subject. Its 39.6 m difference from the
authored elevation is not evidence of a misplaced summit; the preserved
32 m mixed-source grid has an unverified vertical reference. Fifteen fresh
named-Denali shots are usable, including two inside the safe best connected
component; final connected/budget selection chooses other subjects. Pacing and
named-subject selection remain candidate review issues. The depth checks
do not grant aesthetic approval or certify unsampled live frames.

### Actual planned camera moves

All 15 useful libraries now have actual-app camera reviews and complete representative-move evidence. The Anthem plans give useful foreground parallax and continuous saved joins, while repeatedly favoring close terrain over the geographic context of the approved rails. Long transfers and dark endings remain editorial work. Thirteen routes require rework or explicit acceptance; Redfish and Superstition are retained for owner editorial review. These dispositions grant no base-view or tour approval.

| View | Played moves and readable result | Pacing and ending to revisit |
|---|---|---|
| Denali / Wonder Lake | Traverse and valley moves replace the sampled empty-sky passage with coherent snow ridges and a valley. The opening tightly crops a rounded snow dome; the climax targets an unnamed DEM subject. | A 75.104 s high transfer; dark, low-contrast ending inside a link. A close snow face also exposes an unisolated rectilinear shading boundary. |
| Teton / Jackson Lake | Two approaches give layered mountain aerials and a readable 128 s Moran payoff. Saved joins and hotspot windows remain continuous. | The first approach lasts 64.951 s, followed by a 42.689 s transfer; limited move-family variety and a dark ending inside the final link. |
| Monument Valley | Traverses and valley moves provide legible butte parallax and the Mittens payoff, with continuous joins. | Link travel occupies 99.513 s. A dark, cropped cliff dominates the ending; the final shot receives only 1.015 s. |
| Ross Lake | Two orbits retain layered ridge context and a readable Jack Mountain silhouette. The long link opens useful mountain context. | A 69.359 s transfer and repeated orbit family; the ending holds a nearly black foreground beneath the mountain silhouette. |
| Muncho Lake | Traverse and approach moves preserve ridge parallax, though the sampled opening does not establish the lake. | A 65.165 s transfer; fog and rain obscure the unnamed valley payoff, followed by a low-contrast ridge ending. |
| Iztaccíhuatl / Popocatépetl | A close unnamed-peak approach leads continuously into the attributed Iztaccíhuatl orbit; the 128 s ridge silhouette is readable. | The initial approach lasts 68.586 s with limited compositional change; a 37.634 s transfer and dark ending still need a decision. |
| Black Mountains / Catawba | Reveal and traverse moves produce a strong layered-valley opening and a readable earlier Mount Mitchell payoff. The 128 s climax targets an unnamed valley. | Transfers total 105.310 s, or 62.69% of the song. Fog weakens the climax and the ending continues moving inside the last link. |
| San Gabriel Mountains | Orbit and reveal moves supply detailed ridge/gully parallax and continuous joins; the selected subjects remain unnamed. | A 55.511 s high transfer prolongs tight downward terrain framing. Broad geographic context arrives late; the ending retains a dark cropped ridge. |
| La Sal / Castle Valley | Orbit, traverse, pullback and approach supply four played move families; the pullback opens distinct ridges and valley layers. | The first transfer lasts 43.001 s. The final 7.561 s approach is still moving at cutoff; the dark opening and closing pace need work. |
| Panamint / Dante's View | Reveal and traverse give coherent folded-ridge parallax. The configured Telescope Peak shot is foreground dominated in the inspected payoff. | One high transfer lasts 88.944 s, over half the song. The ending tightly crops a dark near ridge with little far context. |
| Chugach / Matanuska | Pullback and approach give a useful layered-valley opening and continuous joins, with unnamed subjects. Large smooth near snow slopes later dominate. | A 68.545 s high transfer; fine repeating near-slope banding, restricted climax context and a dark cropped ending need review. |
| White Mountains / Owens | Pullback and traverse provide coherent near/far ridge separation and a source-supported White Mountain Peak payoff. | A 70.046 s high transfer; bright, smooth near faces reduce detail and broader context. The quiet ending leaves dark foreground hills over a modest far silhouette. |
| Sawtooth / Redfish | Traverse and pullback preserve a blue lake corridor and coherent jagged-peak layers; the Heyburn-targeted payoff stays readable through haze. | A 60.676 s transfer; weather weakens contrast and the song ends inside the link toward the unplayed Grand Mogul reveal. |
| Shenandoah / Stony Man | Reveal and approach open rounded ridge and broad valley layers; saved arrivals stay continuous. The Stony-Man-targeted climax has subdued subject separation. | A dark close opening, a 48 s first reveal and a 56.862 s transfer; the quiet ending retains haze and a dark valley. Distinctness from Black Mountains needs an editorial decision. |
| Superstition west front | Traverse and orbit preserve layered desert relief and a distinct narrow two-topped silhouette in the Weavers-Needle-targeted payoff. | A 68.999 s transfer and very bright middle passage; the focal shape remains at the ending, but foreground and face detail become dark. Retain for owner editorial review. |

The retained source audio, actual song seed, full worker plan/timeline and package/base identities bind these observations to their captures. A named subject in plan metadata does not independently identify every visible mountain; unnamed DEM peaks remain unnamed. Matching audio is available for audition, but no auditory assessment was performed.

The application drew continuously from zero to 167.983 s on a fixed 4 fps export clock. Only the saved representative windows were visually inspected. The hardened evidence ledger now covers every played shot midpoint and assigned payoff, every played link entry/interior/arrival or song cutoff, and the global vector, tangential and yaw hotspots for all 15 plans, with no missing or uninspected required anchor. Shots without an assigned payoff are recorded explicitly. Fresh actual-app probes against the complete final source freeze verified all 15 retained captures: runtime and loaded assets, complete forced-view entries, package/base identities, audio, seed, duration, renderer, plan and full timeline arrays match. Retained media keeps its original source identity; the final-source reuse proof is recorded separately.

All 15 main captures passed their drawn-camera assertions and have no saved zero-surface-depth frame; the lowest sampled drawn-surface fraction is 31.393% in Denali. The auxiliary production depth scene measures drawn-surface presence, including terrain, water surfaces and tree depth; it does not segment terrain alone. Its saved-frame observations are separate from the CPU link floor used during scouting. Exact timeline-camera assertions and headless RTX rendering do not establish live frame rate, physical-device performance, unseen frames or artistic approval. Every tour remains a candidate.

Redfish and Superstition are retained pending editorial review. The other thirteen routes, including Stony Man, require rework or explicit acceptance of their recorded findings. All fifteen remain unapproved.

## Ending and pacing continuation

The [Denali ending pilot](scenic-ending-pilot-2026-10-22.md) follows this completed
batch without replacing its original reviews. Exact replay reproduced all 15
Anthem plans and isolated four transit endings. A diagnostic ending penalty of
16 instead of 4 changed only Denali on those exact inputs. Matched actual-app
captures reached the same 128-second hero payoff and remained on that shot to
the ending, but the changed main transfer became more sky-heavy and both played
shots were valley moves. The ending remained dark. The higher default was
rejected; its evidence and broader opening remain useful references. Primary
application source, review packages and all approvals are unchanged.

## Final fitted libraries

All 16 regional builds completed. Fifteen have useful, mutually reachable
non-rail moves and are staged as candidates; Tombstone remains blocked for an
expanded tour by its existing source-drift policy. Its one-shot fallback is not
counted in the useful totals. The final candidate freeze contains 680 public
files with digest
`b234caf5321e4c0c937d60fb1ad4d5ca24dc82c0fe42baa2a99f67e2d57e89aa`.
Each staged library passed native manifest/payload/terrain identity checks,
complete useful-graph connectivity, sampled link framing, final coverage/LOD,
render checks and its nine-station rail comparison. These checks do not confer
base or tour approval.

| Region | Shots / non-rail / links | Added bytes including library | Library bytes | Forest tour bytes |
| --- | ---: | ---: | ---: | ---: |
| Ross Lake | 8 / 7 / 19 | 1,208,609 | 33,616 | 152,936,320 |
| Teton / Jackson Lake | 10 / 9 / 26 | 1,118,252 | 42,901 | 137,137,728 |
| Denali / Wonder Lake | 12 / 11 / 32 | 777,333 | 54,407 | 22,500,032 |
| Muncho Lake | 12 / 11 / 31 | 765,761 | 50,360 | 71,122,560 |
| Iztaccíhuatl / Popocatépetl | 24 / 23 / 67 | 947,903 | 109,873 | 166,940,928 |
| Black Mountains | 11 / 10 / 30 | 1,362,184 | 48,133 | 144,801,216 |
| San Gabriel | 4 / 3 / 4 | 194,645 | 11,305 | 29,734,592 |
| White Mountains | 10 / 9 / 24 | 400,315 | 41,526 | 20,606,912 |
| La Sal / Castle Valley | 20 / 19 / 55 | 1,304,605 | 85,579 | 16,830,528 |
| Panamint / Dante's View | 10 / 9 / 26 | 710,968 | 44,463 | 24,584,512 |
| Chugach / Matanuska | 8 / 7 / 18 | 757,223 | 29,969 | 13,711,488 |
| Monument Valley | 18 / 17 / 54 | 1,162,965 | 81,663 | 12,267,968 |
| Redfish Lake | 6 / 5 / 7 | 270,385 | 16,336 | 101,895,424 |
| Stony Man | 11 / 10 / 29 | 645,665 | 45,555 | 167,236,096 |
| Superstition west front | 15 / 14 / 40 | 670,248 | 63,052 | 23,473,792 |
| Tombstone, blocked rail only | 1 / 0 / 0 | 2,042, not staged | 2,042 | 5,312,704 |

The fifteen useful libraries contain **179 shots, 164 non-rail shots and 462
links**. Stony Man's forest union is only 536,064 bytes below its 167,772,160-byte
regional cap; Iztaccíhuatl is also close to that cap. A bigger catalog does not
justify relaxing these measured regional fits. Forest figures describe each
tour's modeled residency and must not be summed into a browser/GPU memory claim.

The primary source branch has **52,718,916 bytes** under `src/assets/range/v2/`.
The complete candidate review asset tree has **65,023,144 bytes**, a
12,304,228-byte increase: 12,297,061 bytes of fitted replacement/library growth
plus 7,167 bytes of publication-generated build metadata. Shared assets are
counted once. This exceeds both 60 decimal MB and 60 MiB and is permitted by the
removed global ceiling. It is a logical asset-tree size, not a measured startup
download or decoded runtime memory value. No per-region `fit.deliveryBytes`
totals were summed.

All 39 original approved-rail terrain/build files remain byte-identical on the
primary branch. The three new primary rail triples remain the original sourced
3,813,190-byte candidate wave. Rebaked tour terrain and generated candidate
approval metadata belong to the separate review asset branch. Exact fitted
artifacts are retained under `.smoke/rebuild-20261022/selected-libraries/`, with
source directories, execution records, before/after hashes and package identities
in `source-index.json`. Original discovery and R2 reselection directories remain
available. Tombstone's retained blocked output is clearly labeled and is not
attached as an expanded tour.

## Candidate asset branch and diagnostic playback

The separate
[`review/scenic-library-rebuild-20261022` branch](https://github.com/aepler315/midio-pixel/tree/review/scenic-library-rebuild-20261022)
retains the fitted terrain, fifteen shot libraries, generated catalog and both
authoring files as a coherent candidate artifact. Its asset delta has 78 files
and 34,342,688 bytes of replacement/new file content; that delta is not the final
65,023,144-byte asset-tree size. Capture media remains local outside Git.

Rebaking invalidates the original exact-byte base approvals on this review
branch. Its catalog has one approved rail, Tombstone, and nineteen candidates;
all fifteen attached tours are candidates. Normal selection therefore yields
Tombstone for TUNDRA and explicit no-approved-view fallbacks for the other
biomes. This diagnostic branch is not a replacement production catalog. The
primary source branch retains thirteen approved rails and seven candidates.

To inspect a candidate interactively, check out the review branch, install the
repository dependencies and run `npm start`. Open
`http://127.0.0.1:8080/?rangeView=sawtooth-redfish-north&rangeShots=all`,
load a recording and choose Landscape. Substitute any staged view ID from the
table above. Both query parameters are diagnostic overrides; neither changes
approval or bypasses package/base identity checks. Omitting `rangeShots=all`
keeps candidate tours disabled.

Native validation decoded all twenty catalog entries' eighteen unique terrain
packages, the fifteen attached shot libraries and the legacy pilot tour package.
The two coherent aliases match their rebuilt originals' terrain and camera
bindings while inheriting no shot approval. In 1,100 production-picker samples
the primary task source chose only approved bases. The review branch produced
100 Tombstone choices and 1,000 explicit biome fallbacks, with no candidate
selection. Missing optional libraries settle to the authored rail, and diagnostic
mode still rejects stale identities.

## Source validation snapshots

The primary source and initial three candidate rail packages were tested on Node
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

These source-suite results apply to the primary task checkout. The separate
78-file candidate asset branch did not receive a full-suite run; it received the
native package/catalog, fit, rail comparison and actual application checks above.
Its diagnostic candidate statuses intentionally differ from the primary
production-style catalog. Neither set of results certifies the additional
rendering changes on current main.

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
their fixes.

The completed full suite on the integrated terrain-presence correction ran
4,979 tests: **4,971 passed, two failed and six skipped**, exit 1, in
303,094.09881 ms. It retains the same sky-pan and planner-timing failures and
the same six skips described above. All 1,511 non-Markdown tracked files,
including the 87 generated assets, match the recorded test snapshot, current
primary checkout and committed correction `aafb89ee7cc68e655bde9b41937b3742f63b6d7e`.
The 1,424-file source-only subset also matches. The five separate browser
passes remain source-identical; they do not change the full-suite result.
The final evidence audit caught a stale hash in the original browser summary:
the successful route-deadline rerun was labeled with its initial failed
attempt's hash. Both logs and the original summary remain preserved. A new
corrected manifest records each actual log hash, exit status and source
identity; the successful unchanged case still records one pass and zero skips.

The initial source and three terrain candidates were published in
[PR #31](https://github.com/aepler315/midio-pixel/pull/31), starting at
`21878a1ae3ba2eacf5c4445f4b5a38784963e362` with sole parent
`f51c27f7855ca6a3f163f77afaee4827438e2973`. The status and terrain-presence
follow-ups culminate in `aafb89ee7cc68e655bde9b41937b3742f63b6d7e`, tree
`da3756de47fc5bba06e3551db31ba3dd7434e2e9`, sole parent
`6cac5b0d3d62f0cb5dc07fbb631015b9fa0be022`. The remote commit, tree,
comparison and all 24 changed blob identities were read back and verified.

The owner merged PR #29 to main at 21:56:47 UTC and PR #31 to the implementation
branch at 21:56:59 UTC. Because main had already advanced, the follow-up source
and final documentation continue in
[draft PR #32](https://github.com/aepler315/midio-pixel/pull/32), targeting main.
The rendering and test claims here retain the exact task-source identity;
they do not certify main's additional pixel-presentation changes or a future
combined merge. No camera approval or deployment is recorded.

## Framing correction after the ending pilot

The [next motion iteration](scenic-motion-fixes-2026-10-22.md) fixes the fallback
link generator's skyward direction detour and regenerates all Denali connections
from the same 141 fresh scored shots. The fitted R3 candidate has 13 shots and
29 links. A separate matched actual-app review keeps the original runtime and
ending weight, plays the assigned Denali shot at 128 seconds and holds that shot
through the song end. Total transit falls from 94.224 to 69.915 seconds. The
remaining long transfer, close snowy crest and dark ending prevent whole-tour
approval. This later result does not rewrite the R2 findings or media above.
