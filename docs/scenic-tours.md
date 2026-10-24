# Scenic shot tours

**Original delivery baseline checked 2026-10-22:** tooling merged in PRs
[#24](https://github.com/aepler315/midio-pixel/pull/24) and
[#25](https://github.com/aepler315/midio-pixel/pull/25). At main
`05725b8b753f18234ab9f3aa21b7c5c6cc4d12ac`, the production catalog still has
13 approved rail views and **no committed shot libraries**. All 13 regional
tour configurations remain candidates. This document contains the intended
contract and historical development results; the delivery table below separates
those results from current production behavior.

The [camera scouting audit](camera-scouting-audit-2026-10-22.md) records contract
gaps and evidence limits at its audited revision. The [implementation follow-up](camera-scouting-fixes-2026-10-22.md)
documents the subsequent fixes to discovery, approval, review identity, planning
and reel evidence, plus removal of the global 60 MB hard gate. Those source
changes merged through [PR #29](https://github.com/aepler315/midio-pixel/pull/29).
Deployment was not verified. They added no assets or camera approvals;
the 13 approved rails and candidate regional configurations above are unchanged.
The [30-view proposal](scenic-view-expansion.md) now has a
[first sourced candidate wave](scenic-expansion-wave1-2026-10-22.md): Redfish
Lake, Stony Man and the Superstition west front. Catalog v20 on the expansion
branch keeps the 13 approved rails and adds these three candidates beside the
four existing pilots. The [fresh rebuild and app review](scenic-rebuild-review-2026-10-22.md)
separates new discovery artifacts, actual song-planned movement and remaining
approval gates from the historical results below.

**Current expansion-branch inventory:** catalog v20 has 20 runtime entries
(13 approved bases and seven candidates), while `scenic-tours.json` has
16 candidate regional configurations. The primary expansion branch has no
attached shot libraries and preserves all 13 approved rail packages. Fresh
libraries were rebuilt and staged in an isolated candidate review snapshot.
The v19 inventory and R3 delivery table below describe their explicitly dated
baselines. See [PR #32](https://github.com/aepler315/midio-pixel/pull/32), merged
by the owner on 2026-10-23,
and the [dated rebuild review](scenic-rebuild-review-2026-10-22.md) for current
artifacts and actual planned-move findings.

The completed fresh R2 batch has 15 useful candidate libraries with 179 shots and
462 links; Tombstone remains blocked with only its rail. Its separate candidate
asset tree is 65,023,144 bytes. The primary branch keeps the 13 approved rail
packages unchanged; no fit, capture or diagnostic setting approves a tour.
The separate
[review asset branch](https://github.com/aepler315/midio-pixel/tree/review/scenic-library-rebuild-20261022)
contains those exact packages. Its rebaked bases are candidates, so interactive
review uses the explicit overrides in the
[playback instructions](scenic-rebuild-review-2026-10-22.md#candidate-asset-branch-and-diagnostic-playback).

The [Denali ending pilot](scenic-ending-pilot-2026-10-22.md) explains why long
runtime transfers can exceed the discovery duration setting and why a legal
shot ending can lose to a transit ending. Its matched rendered experiment
rejected a higher ending penalty as a default change: the broader opening and
final-shot completion came with a more sky-heavy transfer and less move variety.
The existing planner defaults and candidate approval states remain unchanged.

The subsequent [framing and ending follow-up](scenic-motion-fixes-2026-10-22.md)
regenerates Denali's connections after correcting fallback direction handover.
Its matched geometry-only app review uses the unchanged planner: the assigned
Denali shot plays at the 128-second payoff and continues through the ending,
while total transit falls from 94.224 to 69.915 seconds. The long remaining
transfer, close crest and dark final view remain editorial gates. Original R2
packages and captures are preserved; this revised package remains unapproved.

The [2026-10-23 transfer and ending repair](scenic-transfer-endings-review-2026-10-23.md)
starts from main `1b46e5e3fad38b7b8c75d2391af2e6b79500bfff`, which includes
the R4 runtime climb and pacing fixes. It corrects authoring duration bounds,
rebuilds Panamint and Teton, and records their full-song actual-app review.
The source proposal leaves the approved rail packages intact. Revised assets
remain on a separate candidate branch; the approved geographic count stays 13.

The [parallel camera wave on 2026-10-23](scenic-camera-wave-review-2026-10-23.md)
continues camera repair at three existing locations from source `f7b7b16` and
R5 assets `830d121`. It retains a shorter Izta route and readable named ending,
rejects Black's increased total transit, and replaces White's rejected downward
opening with a readable valley-axis view. The retained White route cuts transit
to 36.069 seconds, with a later 48-second first formal payoff. Izta's opening
remains unresolved. The final review set has 15 libraries, 144 shots and
335 links in a 64,125,061-byte Range asset tree on the separate
[R6 review asset branch](https://github.com/aepler315/midio-pixel/tree/review/scenic-camera-wave-20261023).
The R5 inventory and historical results below remain their dated baselines.
The approved geographic count stays 13; geographic expansion remains on hold.

The [R7 framing and ending follow-up](scenic-framing-endings-review-2026-10-23.md)
retains Izta's wider opening and Black's late-rise ending within the reviewed
Anthem scope. A surface-memory reduction and static forest partition repair
let the same strict Black assets prepare and render without the broad bare
forest bands that rejected two earlier packages. Softer forest texture, dark
foreground and narrow memory headroom remain explicit limits. The locally
retained snapshot has 15 libraries, 137 shots and 314 links in 64,967,986 Range
asset bytes. Local implementation and image gates are complete;
[draft PR #38](https://github.com/aepler315/midio-pixel/pull/38) records source/candidate
commit identities and publication status. The R6 baseline stays preserved,
and no geographic approval is added.

The intended system gives each approved scenic view an offline-discovered **shot library**: complete
camera moves around the region's real subjects, plus connecting moves between
them. At playback a deterministic planner strings shots and links together
against the song, schedules each shot's visual payoff on a musical moment, and
produces a `poseAt(heardTimeMs)` camera. The authored rail stays in every
library and is the fallback whenever a library or plan is unavailable.

## Inventory (catalog v19, 2026-10-21)

- **Production (approved, 13 views, 11 biomes):** `nc-ross-lake-north`
  (RAINFOREST), `teton-jackson-lake` (CONIFER), `denali-wonder-lake` and
  `chugach-matanuska` (ICEFIELD), `tombstone-north-klondike` (TUNDRA),
  `muncho-lake-south` (TAIGA), `izta-popo-west` (PINE_OAK),
  `black-mountains-catawba` (BROADLEAF), `san-gabriel-baldy` (CHAPARRAL),
  `white-mountains-owens` (STEPPE), `la-sal-castle-valley` and
  `monument-valley-163` (CANYON), `panamint-dantes-view` (DESERT).
- **Candidates (4, never drawn for songs):** `pend-oreille-valley` (glacial
  pilot), `teton-jackson-lake-coherent` and `monument-valley-163-coherent`
  (foreground pilots sharing their originals' packages), `teton-range-tour`
  (the Teton highway tour, forced by `?rangeTour=tetons`).
- **Rejected (4):** kept in `data/terrain/scenic-views.json`, never shipped.
- **Legacy skyline-only ranges:** 83 scanned range modules; 13 host an
  approved view, 70 are skyline-only. They supply the musical ridges for
  every song and are out of scope for tours.

## Current delivery and reported builds

The clean main checkout reports every configured region as **rail only**:

```sh
node tools/scenic-tour-status.mjs --markdown
```

Without local `.smoke/scenic-tours/<id>/fit.json` files, the command's “not built”
means no build record is available in that checkout. It does not contradict the
historical local builds reported in PR #25. None of the round-3 shot libraries
below is committed or approved for production. The four forced runtime candidates
and four rejected authoring entries are separate from the 13 approved views.

For the final batch, use `--build-root .smoke/rebuild-20261022/selected-libraries`.
The status tool labels **catalog tour state** separately from **build-fit
counts/costs**. An approved rail cannot approve an attached candidate tour;
approval also requires current verified library, payload and terrain identities.
Choosing a build directory does not install or approve its packages. Valid
rejections and stale identities are reported separately.

The fresh rebuild also adds a sampled terrain-presence floor for connecting
moves after actual Denali playback exposed a roughly 25-second blank-sky
passage. Existing CPU link scoring records exact minimum terrain fraction and
empty/sample counts; any sampled all-sky link is excluded before Pareto and
connected selection. Missing legacy-cache evidence is measured once on the
fresh retained front. The validated pair pool stays closed through budget
relinks, and packing/publication reject missing or invalid link evidence.
This adds no pitch cutoff and changes no source camera path or fit budget.
See the [measured cause and R1/R2 evidence](scenic-rebuild-review-2026-10-22.md#denali-exposed-an-all-sky-link).

| View | Current production camera | R3 shots / links reported in PR #25 | Reported in-app coverage |
| --- | --- | --- | --- |
| `nc-ross-lake-north` | authored rail | 6 / 9 | smoke |
| `teton-jackson-lake` | authored rail | 13 / 28 | smoke |
| `denali-wonder-lake` | authored rail | 18 / 54 | smoke |
| `tombstone-north-klondike` | authored rail | blocked by source drift | none for a shot library |
| `muncho-lake-south` | authored rail | 15 / 33 | smoke |
| `izta-popo-west` | authored rail | 28 / 87 | smoke, reel, one planned tour |
| `black-mountains-catawba` | authored rail | 11 / 21 | smoke |
| `san-gabriel-baldy` | authored rail | 4 / 5 | smoke |
| `white-mountains-owens` | authored rail | 9 / 25 | smoke |
| `la-sal-castle-valley` | authored rail | 15 / 34 | smoke |
| `panamint-dantes-view` | authored rail | 8 / 16 | smoke |
| `chugach-matanuska` | authored rail | 7 / 17 | smoke |
| `monument-valley-163` | authored rail | 16 / 39 | smoke, reel, one planned tour |

These reported totals are **150 shots / 368 links in 12 regions**, built from
`8851754b6036619fe86efb91657299c37fc377dd`. “Published” in the PR means
written to its local working tree for review, not delivered in the merged
repository. All-region smoke and review outcomes are attributed reports;
this documentation audit did not reproduce or visually accept those builds.

The [evidence prerelease](https://github.com/aepler315/midio-pixel/releases/tag/scenic-tours-evidence-r3)
retains 15 attachments: Monument Valley R2/R3 reels and a R3 anthem tour,
horizon and wet-ground comparisons, and R2 replay/pacing material. It targets
`627f7a6680dc87b23ceef5439659afa3d8116ed1`, before final source head
`fb08bcece9c2ce47cb1e473220b38724de38e7e8`. Exact round-3 library packages,
all-region raw review collections and all-region smoke reports are not in
those attachments. Source, build and capture identities must remain distinct.

The R3 Monument Valley tour is reported in PR #25 as two shots and two links
over the 168 s anthem; known weak frames and long transit remain. The horizon
and pacing discussion below records development findings, not blanket current
whole-song acceptance. No new camera, library or source is approved here.

## Why the Teton highway is not generalized as is

`tools/build-teton-tour.mjs` builds a road network first (A*, minimum
spanning tree, 1.35 spanner, station merges) and only then scores views on
the surviving roads, keeping one station and one best aim per subject. The
road pruning never sees scenery, and alternatives that would be shorter, a
stronger reveal or a better approach are discarded before they are judged.
It also assumes a north–south range, NAD83, US GeoNames, a 4700 m ceiling,
Teton names, and an all-tiles terrain package (13 MB) per region. Its regional
assumptions and route-first pruning still matter for generalization. The
inherited 60 MB bundle ceiling has been removed from the current builder and
scenic fitter; see the [delivery policy](scenic-view-expansion.md#delivery-budget)
for the historical size baseline and the byte reports retained by the tools.

Shot tours reuse its proven parts — DEM loading and normalization, the
clearance idea, the exact-height scorer as a cheap pre-filter, the
committed-prefix replanning contract, the 100 ms keyframe pose format — but
score whole moving shots and every connecting alternative **before** pruning,
and validate them against the view's actual packaged terrain.

## Pipeline

```
data/terrain/scenic-tours.json  (regional config)
        │
tools/build-scenic-tours.mjs --view <id>|all [--render] [--publish | --publish-from DIR]
  terrain   normalized DEM grid of the view (.terrain-cache, same key as build-range-scene)
  subjects  config subjects + authored landmarks + rail target + DEM features
  shots     generators per subject and landform → sampled paths (ShotPath)
  score     cheap CPU depth-raster scoring: every candidate coarsely, the best
            per subject and move in full; long shots cut to their best window
  render    actual-renderer key frames of every scored candidate
            (src/dev/shot-review.html) fold into its score
  cost      each candidate's terrain footprint as the baker would ship it
  select    rounds of diverse, budget-charged, reachable shots; links between
            them scored, leashed and Pareto-pruned; unconnected shots dropped
  bake      terrain for library poses + ordinary-detail rail/reflection viewers
  validate  derive final-terrain direct/mirror requirements; both-budget coverage;
            reject failed closure before packing; clearance; joins
  pack      src/assets/range/v2/tour/<viewId>.shots.json + .shots.bin.gz
```

## Contracts

### Local frame and paths

Every library uses its view's terrain frame: metres, X east, Y up, Z south,
origin at the DEM grid centre. A **path** (`src/world/terrain/ShotPath.js`)
is a dense sample list `{s, eye, aim, fov, flow}`: progress `s` (eye metres
plus `AIM_PROGRESS_M = 400` metres per radian of aim turn), eye and aim
points, vertical FOV in degrees, and `flow`, the 95th-percentile angular
image speed of visible terrain per unit progress speed (rad per progress
metre). `pathPoseAt(path, s)` interpolates C1 (uniform Catmull–Rom in `s`).

### Shot library (`src/world/terrain/ShotLibrary.js`, schema `midio.shots` v1)

Manifest fields: `schema, version, viewId, regionId, terrainManifestSha256,
axes, subjects[], shots[], links[], payload{url, byteLength, sha256,
decodedByteLength, decodedSha256}, provenance{}`.

- `subjects[]`: `{id, kind, name|null, posM:[x,y,z], radiusM, heightM}`;
  kinds `landmark | peak | butte | ridge | lake | valley | shore | rail-target`.
- `shots[]`: `{id, subjectId, move, samples{offset,count}, lengthM, payoffS,
  holdS:[a,b], durationMs{min,ideal,max}, traits{headingDeg, azimuthDeg,
  elevationDeg, aglM, distanceM, lens, foreground, side}, score{total,
  composition, subject, depth, parallax, reveal, weakest, render|null},
  tags[]}`. Moves: `rail | traverse | approach | reveal | orbit | pullback |
  valley | crest`. `payoffS` is where the visual payoff lands (the reveal
  completes, the subject reaches its best framing); `holdS` brackets the
  sustained view around it.
- `links[]`: `{id, from, to, kind, samples, lengthM, durationMs{min,max},
  score{total, weakest}}`; kinds `direct | arc | high | low`. A link starts
  exactly at its `from` shot's last sample (position, look direction, FOV)
  and ends exactly at its `to` shot's first sample, with matching tangents.
- Binary payload: per path, `count × 9` little-endian Float32
  (`s, eye xyz, aim xyz, fov, flow`).

### Regional config (`data/terrain/scenic-tours.json`)

`{version, defaults{lenses, clearance, motion, discovery, budget}, regions{
<viewId>: {status, landform, subjects[{name, lonLat, kind, weight}], hero[],
preferAzimuthDeg[], avoid[], overrides{}, notes, library?, approval?}}}`.
Region `status` is the tour's independent review state (`candidate | approved`).
Publication records `library{shotsManifestSha256, terrainManifestSha256,
baseViewSha256}`, marks the tour candidate and clears its earlier approval.
`--approve-tour` records `approval{date, evidence[], shotsManifestSha256,
terrainManifestSha256, baseViewSha256}` only after the base rail has a current
approval. `--approve` approves the base alone. Normal playback requires both
approvals and matching identities; no libraries currently ship.

Geography, named-subject preferences, route anchors and region-dependent
parameters live here. DEM source details stay in `scenic-views.json`.
Subject `weight` reaches each generated candidate as `subjectWeight` and affects
connected-component, shot and winning-library selection; finite positive values
are clamped to 0.25–4, with other values defaulting to 1. It does not change render
or coverage quality gates. `avoid[]` remains unsupported. `hero`, `excludeShots`
and `preferAzimuthDeg` have consumers. Discovery now stratifies its existing
per-subject candidate budget over move, azimuth, elevation, distance and direction,
including generated preferred angles before filling angular gaps. The default
forward budget remains 48 candidates per subject; this does not increase it.
Existing graph caches require fresh discovery to contain these alternatives and
candidate weights; see the [migration notes](camera-scouting-fixes-2026-10-22.md#migration-and-review).

### Music model (`ShotMusic.js`)

`musicMoments({durationMs, sections, roles, energy, energyStepMs})` returns
`{impacts[], climax, calm[], intensityAt(t)}`. Payoff targets are **energy
impacts** (the strongest 1 s energy rise within ±3 s of a section boundary,
or a strong rise anywhere), not section-relative energy peaks; the climax is
the strongest impact in the last 55% of the song. Detected section labels are
a weak cue: on the structured test songs the detector misplaces boundaries by
up to 2.5 s and the final-chorus label, while the energy rise lands within
0.1 s of every chorus downbeat.

### Planner (`ShotPlanner.js`) and timeline (`ShotTimeline.js`)

```
planShotTour(library, {durationMs, sections, roles, energy, energyStepMs,
  visible:[{startMs,endMs}], seed, start, tunables}) → plan
  plan = {durationMs, moments[], items[{kind:'shot'|'link', id, startMs,
          endMs, sFrom, sTo, payoffMs?}], notes[], cost, fallback:null|reason}
buildShotTimeline(library, plan, {previous, frozenThroughMs}) → timeline
  timeline = {durationMs, eye, target, fov (Float32, 100 ms lattice),
              meta (Uint16 ×4: item, kind, phase, subject), items, payoffs[],
              poseAt(t), stateAt(t), diagnostics}
```

Shot choice, link choice, payoff times and speeds are chosen together by a
beam search with lookahead over the moments; the final chorus and outro are
planned as one passage. Costs: shot quality weighted by moment importance,
repetition (subject, viewpoint, elevation, foreground, move type), link
quality, timing error, and comfort (required speed against the shot's flow
lane). Hard constraints: legal joins (links only), the speed, tangential
acceleration, yaw, climb and flow limits, and every payoff inside a visible interval. Planning is
pure and seeded; `poseAt` is a pure function of heard time.

Climb feasibility follows the drawn Catmull-Rom path and Hermite progress,
including the supports supplied by the neighbours actually reached. A fresh
Float32-key guard covers the full plan; a committed replan checks its rebuilt
suffix while preserving frozen keys. A partial final shot earns its outro
reward in proportion to the head it plays. When quick terminal-speed candidates
all clamp to the same failed value, the search tries three distinct interior
means through the existing physical predicate. These checks retain the configured
limits and weights; their visual and pacing tradeoffs are recorded in the
[current review](scenic-climb-pacing-review-2026-10-22.md).

### Runtime integration

- Catalog: a view with an optional library carries `shotsManifestUrl`,
  `shotsManifestSha256`, `baseViewSha256` and `shotTour{status, identity,
  approval}`. Tour eligibility checks this independent identity and approval;
  missing, stale, candidate or malformed tour metadata leaves a valid approved
  base rail available. `?rangeShots=all` permits diagnostic candidate playback
  while retaining package identity checks.
- Prepare-time resources (mesh LOD, forest, rivers, actor routes, mirror)
  depend only on the rail plus the library footprint, never on a song's plan:
  replanning and seeking never rebuild GPU state.
- `RangePresentation` loads the library, plans per song in a worker over the
  chapter intervals where the view is on screen, and hands the timeline to
  `RangeScene.setCameraTour(viewId, timeline)`. Until a plan is ready, and
  whenever a library or plan fails, the view keeps its rail and records the
  reason in `status().shotTours[viewId]`.
- Cold bend and join tables are measured in the planning worker and returned
  for reuse by later requests for the same decoded library. Preparing a request
  on the rendering thread only clones library data and any cached tables.
- Ending search tries every retained outgoing link alternative, including
  alternatives that differ in bend, flow and join feasibility.
- Refinement replans keep every committed pose (the Teton contract).

### Budgets and approval

- There is no global Range asset-size ceiling. The Teton builder reports
  delivery bytes, and scenic fitting reports `budget.deliveryBytes` alongside
  added bytes. `assetBudgetErrors(root)` has no default limit; an explicit
  caller may supply a finite nonnegative `limit`. Per-region byte, triangle
  and forest caps remain configured discovery/fit and runtime feasibility
  checks. Download size and decoded memory remain separate measurements.
- A view's terrain is re-culled only when its library needs tiles the rail
  package lacks. Publishing a candidate library alone preserves base approval.
  A real rebake changes the terrain identity and stales base approval; review
  and re-approve that base with `--approve`, then separately review the tour
  before `--approve-tour`. Neither command substitutes for aesthetic review.

Reduced-motion support was removed from the app in 3eefb64 (PR #22); there is
no reduced-motion camera path to retain.

## Building and publishing a region

```sh
# Discovery and review; these commands do not approve the result:
export MIDIO_GDAL_PYTHON=/path/to/python-with-gdal
node tools/build-range-scene.mjs --view <viewId>          # warms .terrain-cache with the view's DEM grid
node tools/build-scenic-tours.mjs --view <viewId> --render   # discover, score, connect, fit, bake, review
node tools/plan-scenic-tour.mjs --library .smoke/scenic-tours/<viewId> --structure <structure.json> --song <song.wav>
```

After the fitted artifact has been reviewed, `--publish-from
.smoke/scenic-tours/<viewId>` writes that artifact without rebuilding it.
`--publish` builds again, so it is not a substitute for publishing the reviewed
bytes. Publishing an optional candidate library preserves a current base rail
approval when its terrain is unchanged. A terrain rebake stales that approval
and requires its own review. After reviewing the exact published bytes:

```sh
# Needed when the base/package changed; this approves only the base:
node tools/build-range-scene.mjs --approve <viewId> --evidence <base-review.md>
# Separate promotion of the reviewed library against the current approved base:
node tools/build-range-scene.mjs --approve-tour <viewId> --evidence <tour-review.md>
```

Both commands require existing evidence files. A document's existence is not
itself aesthetic acceptance. Keep captures outside Git and link retained evidence
from the review record. Rebuild discovery into a fresh output directory when
adopting the angle/weight fixes; `--reselect` reuses the old candidate graph.
Fresh discovery can change shot IDs, so re-check `excludeShots` against the new
IDs and collect fresh verdicts rather than copying historical exclusions or
reviews blindly.

`tools/song-structure-probe.mjs` captures a song's detected sections, roles
and energy from the real upload/analysis path; `tools/plan-scenic-tour.mjs`
replays the runtime planner and timeline on them offline (the same pure
code the worker runs). `tools/tour-evidence.mjs` turns two `visual:eval`
runs of the identical manifest into side-by-side clips with the song's
audio, a checkpoint sheet and an index of timestamps and camera state.

### Selection and budgets

Discovery judges scenery on the full DEM; a tile the shipped package lacks
is not a flaw of a shot but a cost. A song's big moments come every 30-60 s
and a tour should reach a few subjects between them, so a shot longer than
`discovery.maxShotS` (16 s) at its ideal pace keeps its best window around
the payoff (a reveal keeps the hidden stretch before it) and is scored again
as cut, and a link that cannot be flown within `discovery.maxLinkS` (50 s)
even at full pace is not offered. In large landscapes the links are a real
part of the film: they are scored for scenery like shots.

The duration lower bound uses the runtime's supported camera curve, including
climb and the actual source-shot/link/target-shot support. Cached `--reselect`
runs refresh shot and link estimates, then reapply the unchanged 50-second
admission leash before Pareto and connected selection. Cached reselection
retains its rejected geometry for diagnostics. This bounds the fastest admitted geometry;
the music planner can allocate a longer transfer, and the decoded geometry,
timed speed profile and delivered camera keys still need their own checks.

The cheap scores pick which candidates are worth rendering; the renderer
then has the last word on each. One package is baked for every scored
candidate's poses, and each candidate's entry, payoff, end of hold and exit
are rendered through the production terrain material and forest
(`renderReview`). The render score weighs whether the subject is actually
visible at the payoff, the frame's local contrast and its terrain share; a
candidate keeps its DEM score in full when the render scores 0.45 or more,
falls to 55% of it as the render fades, and is dropped when the render is
near empty (`renderedTotal`).

Every candidate shot and every link on a pair's Pareto front records its
footprint: the stride the baker itself gives each tile when it bakes the
rail plus that record's poses (and their reflections) at the tour pixel
budget (`tools/lib/scenic-cost.mjs`). A tile's stride is set by the
sharpest viewer that sees it, so footprints add up tile by tile. A new tile
costs its compressed samples (bytes per stride measured on posed bakes) and
its manifest entry (about 470 bytes of JSON, often more than a coarse
tile's samples); a shipped or already paid-for tile costs only the step to
a finer stride. Selection divides a shot's (and a link's) worth by 1 + the bytes it adds
beyond the shipped package and the shots already chosen, over
`discovery.byteScaleKB`: the first shot over a range pays for terrain the
later ones share, so it is discounted rather than refused. Selection stops
short of the region's byte budget. `fitToBudget` then bakes the library's footprint
and measures the added bytes and triangles against the region's caps, retaining
combined delivery-byte reporting without a global hard gate. While over a fit
limit, it calibrates the estimate on that bake, drops the
shot whose terrain is most its own per unit of score and rarity (the only
reveal, the only high shot or the only shot of a subject is worth more), and
chooses the links afresh from every scored pair among the shots that
remain, so a drop never strands the shots that were reached through it.
Tiles only tour cameras see are held to `budget.poseErrorScale` times the
rail's pixel budget (the app presents terrain on a 320×180, 480×270 or 640×360
pixel grid). Retained rail viewers and their reflections use ordinary declared
rail limits through the independent `railPoses` channel. Final decoded
terrain determines mirror eligibility/level and coverage requirements;
failed final coverage is rejected before packing, including after a rebake.

#### Horizon and the grid edge

The package has no terrain beyond the DEM grid. From an elevated eye over
open country, rays just below the horizontal leave the grid; the app
paints them with the sky, so the grid's far boundary reads as the horizon
(rendered in the app at the deepest such band any round-2 camera saw,
11.4° at Izta, with no visible crop). Generators therefore tilt a view
down only while a ray more than `discovery.edgeDipDeg` (12°) below the
horizontal would leave the grid, and the scorer's raster counts only those
deeper rays as holes (`edge`); shallower ones are sky. Both sides use the
same allowance, so a horizon shot is neither tilted away nor scored as
holes.

Before this rule every such view was tilted until no ray left the grid,
and high eyes aimed at a subject's mid-height looked 20–35° down: 47 of
the 126 round-2 shots framed no horizon, mostly near terrain, which the
app draws soft at that range. Generators now also keep the horizon in
frame (`discovery.frame`): an aim is raised, keeping its heading and
distance, until the horizon sits at least `horizonBelowTop` (20%) of the
frame below the top edge, as far as the subject's aim point stays at
least `subjectAboveBottom` (10%) above the bottom edge. Where the subject
would leave the frame first, the look is raised only that far.

### Connected selection

Selection works on the candidate link graph rather than on shots alone.
Each scored shot is linked to its `discovery.linkFanout` nearest reachable
shots (exit to entry); every link variant is scored, leashed and pruned to
each pair's Pareto front. Tours stay inside the strongly connected part of
that graph whose best shots are worth most. There the shortlist grows by
ears: it is seeded with the best shortest cycle, then extended only by a
chain of at most `discovery.earShots` new shots that leaves the set and
rejoins it. Every shot chosen therefore has a way in and a way out among
the others, so no shot is selected only to be pruned afterwards. Large
landscapes link their shots in long loops, which is why seeds and ears are
found by breadth-first search rather than as pairs.

### Motion policy and links

The planner holds the camera to two limits, region by region (`motion`): a
change of speed at most `maxAccelMps2` (3.5 m/s², a lurch a viewer feels),
with the change that path curvature adds to it measured on the drawn curve,
and a look that rotates at most `maxYawDegPerSec`. Sideways acceleration in
turns is reported, not limited: a viewer sees a turn as rotation, which the
yaw limit governs (the tunable `vectorAccelRatio` can bound the whole
acceleration; at 2 it costs about a quarter of the payoffs). The library
builder times paths conservatively, capping speed where curvature would pull
harder than twice `maxAccelMps2` (`maxLateralMps2`), so its durations and its
link leash never promise a pace the timeline cannot fly.

Links run over the ground as Dubins courses: the shortest path of arcs of
radius `discovery.linkRadiusM` and straights from the outgoing shot's
heading to the incoming one's, so no link cusps or turns tighter than its
radius; their height is a cubic in course length that leaves and arrives at
each shot's own climb. Most of a link's time is detour when two shots face
away from each other, so moves that read the same flown either way
(traverse, orbit, valley, crest) also enter discovery reversed; a link can
then arrive along the heading the next shot already travels, and near-copy
rejection keeps only the direction that serves the library. In wide
landscapes a link of 30-50 s is part of the film: links are scored for
scenery like shots, and the leash (`discovery.maxLinkS`) is 50 s.

### Rendered review

The first complete libraries (12 regions, 170 shots) were reviewed shot by
shot from their rendered key frames (entry, payoff, end of hold, exit) as a
film editor would: 103 good or acceptable, 67 weak or broken. No frame had
holes, missing terrain or a data-edge cut, and every rail rendered the same
on the rebaked package. The failures were of film, not data: frames with no
horizon looking down on featureless slopes, close terrain too soft to show
detail filling the frame, subjects that never appear (the Ross Dam
approaches fly into a ridge), near copies a few hundred metres apart, and
too little variety (eight of Denali's nine shots framed one foothill dome).

Joining the verdicts with the renderer's own metrics showed which ones
separate them: whether the subject is in frame at the payoff, how much of
the frame it fills, and how much of the picture is terrain too close for the
DEM's detail (a source cell spanning more than 10 pixels of the 640x360
picture). Sky share did not: good aerial shots have none either. Selection
now drops a candidate whose subject is out of frame at the payoff, fills the
frame, or whose payoff and hold are all soft close terrain, and discounts
soft close terrain short of that (`renderedGate`). On the reviewed shots
these gates drop 37 of the 67 weak shots and 14 of the 91 good ones; fitted
on half the regions and tested on the other half they drop 38-44% of weak
shots and 16-22% of good ones. Shots that pay off on the same frame now
count as copies whatever moves lead in and out, and steep look-downs are
penalised once a library has some. Payoffs stay at or before 88% of a shot,
so every shot holds its view before it ends.

Reviewer collection now checks exact manifest, compressed payload, decoded
payload and terrain-manifest hashes, as well as the final shot set. Results
carry source/capture provenance; that provenance is reviewer attribution, not
authenticated proof of the referenced capture. Use
`tools/scenic-review-collect.mjs --journal <journal.jsonl> --views <id>` with
`--libraries <tour-directory>` and, for a separate staged terrain directory,
`--terrain <terrain-directory>`. Known aliases use their catalog terrain filename;
`--terrain-manifest <file>` selects a custom manifest for one view and is rejected
for multiple views. The collector derives and verifies expected identity from
those files. See the [result schema](camera-scouting-fixes-2026-10-22.md#review-identity)
for required fields and migration from old ID-only results.

#### In the application

Key frames from the review harness are not the experience: the harness
lights terrain from a fixed direction (north-west views glare white there)
and shows a shot at four moments. Libraries are therefore also judged in
the app: `tools/shot-reel.mjs` plays every published shot entry to exit at
its ideal pace through the real scene (frames, an MP4 with each shot's id,
and a sheet of five frames per shot; the drawn camera matches the library
path to the centimetre), and a continuous `tools/visual-evaluate.mjs`
manifest records the tour the planner actually makes for a song. The reel uses
one timeline factory for its browser camera and frame labels; at and after the
final endpoint it holds the final shot's end pose. Its index records the exact
review-library identity and source digest.

Seen there, a bright sheet on flat desert floor (Monument Valley) is the
app's music-driven weather, not data: after a squall `wet01` lowers the
terrain's roughness (`RangeStorm.js`, the shader's wet receivers), and flat
ground then mirrors lightning, the moon or a low sun. The same pose with dry
ground shows nothing; the DEM water mask is not under it. It is independent
of tours (the rail shows it facing the light at those times).

#### Pacing

What a viewer sees is the planned tour, and there the limit is distance. The
planner lands a payoff where a leg -- the rest of one shot, a link, the next
shot up to its payoff -- can be flown within the motion limits; selected
shots lie 2-5 km apart, so a leg takes 45-60 s even at the speed caps
(links are held to 20-90 m/s by their bend, calm music lowers the flow cap
further) and a 168 s song holds two or three payoffs. Replaying the round-2
libraries over three songs planned 57 payoffs where each part flown at its
own cap would allow 129. More reward per payoff (x10) or a wider search did
not change that (61, 57); letting each part of a leg keep its own pace
between join knots gave 59. More payoffs per song need shots closer
together -- fewer subjects per view -- or smoother link joins where those
set the cap (Ross Lake: 11 of 13 links); that trade-off is a choice for
the product, not made here. Offline ground-truth payoff hits now require the
target time to be inside a visible interval; the ground-truth reach denominator
also uses only visible target times. Historical all-song counts above are not
recomputed results from that corrected metric.

### Terrain policy, drift and per-region budgets

Every build first bakes the rail alone. When that no longer reproduces the
shipped package, the region's DEM source has drifted since approval and a
rebake would change the approved rail. Such a region keeps its package:
selection admits only shots and links whose terrain the package already
holds at enough detail, and an uncovered library is fitted down instead of
rebaked. A region may allow the rebake (`rebakeOnDrift`) only with recorded
rail-parity evidence that the rail renders the same (Ross Lake: 0.00% of
rail pixels change). Tombstone's drift is visible (3.3% of rail pixels), so
it stays coverage-only, and its package covers no tour shot: it keeps the
authored rail until its source is re-approved.

A new tile costs its compressed samples and about 470 bytes of manifest
JSON. In wide views the manifest dominates: one shot over a large range
brings hundreds of distant tiles at the coarsest stride. The default
region budget (800 KB) therefore fits only three to eight shots in the
widest regions; wider allowances are recorded in `overrides.budget.assetBytes`
with a `budgetNote`. Most existing overrides remain 1.4 MB. R7 separately
raises **only Black Mountains to 2.3 MB**, with 2,210,427 cumulative added bytes
against the original rail reference: 810,427 bytes beyond its former 1.4 MB
allowance. That measured download tradeoff preserves strict reflection
coverage and old visible terrain detail; triangle, forest, runtime residency,
motion and quality limits remain unchanged. See the
[R7 review](scenic-framing-endings-review-2026-10-23.md#black-terrain-repair-and-explicit-download-tradeoff).
Regional allowances remain separate from the removed global Range asset-size
gate. A compact tile table could reduce manifest cost; it remains a later
format change.

The fallback rail is already present, but its final reflection requirements
cannot be assumed to add no coverage. Every final decoded package determines
its own mirror eligibility and exact plane. Validation includes retained rail
reflection stations and both endpoints at ordinary unscaled desktop/mobile
rail limits, separately from tour-scaled direct and mirror poses. The optional
`railPoses` bake channel retains those ordinary-detail viewers without tour
dedupe or thinning; an absent/empty channel preserves prior output bytes.
A newly active or shifted mirror must pass final-state coverage and LOD
checks. Failed closure is rejected before packing/publication, even after a
rebake; the gate does not attempt automatic retry bakes. This does not replace
rendered original-rail parity or actual-song image review.
