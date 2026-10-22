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

Fresh library totals, actual planned-move findings and final validation are
recorded below when their runs complete. None of the baseline observations,
fit checks or capture controls automatically promotes a candidate.

The source audio is retained with exact frame players and MP4 previews.
Auditory input was unavailable to the reviewing agent, so the review does not
claim to have heard or aesthetically accepted the musical coupling. The actual
camera, timeline and rendered-image observations remain independently useful.
