# Scenic shot tours

**Status:** in development on `feat/scenic-shot-tours`. This document is the
design and the shared contract; the per-region completion table and the
evidence links are kept at the end and updated as regions land.

Each approved scenic view gets an offline-discovered **shot library**: complete
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

## Why the Teton highway is not generalized as is

`tools/build-teton-tour.mjs` builds a road network first (A*, minimum
spanning tree, 1.35 spanner, station merges) and only then scores views on
the surviving roads, keeping one station and one best aim per subject. The
road pruning never sees scenery, and alternatives that would be shorter, a
stronger reveal or a better approach are discarded before they are judged.
It also assumes a north–south range, NAD83, US GeoNames, a 4700 m ceiling,
Teton names, and an all-tiles terrain package (13 MB) per region; the shared
Range asset budget (60 MB, about 11 MB free) cannot hold that for 13 views.

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
  bake      terrain package re-culled for rail + library poses (+ mirrored poses)
  validate  every path frustum against the baked package; clearance; joins
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
preferAzimuthDeg[], avoid[], overrides{}, notes}}}`. Region `status` is the
tour's own review state (`candidate | approved`); a view plays its tour in
production only when both the view and its tour are approved. Geography,
named-subject preferences, route anchors and region-dependent parameters live
here, never in code. DEM source details stay in `scenic-views.json`.

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
lane). Hard constraints: legal joins (links only), the speed/acceleration/
yaw/flow limits, and every payoff inside a visible interval. Planning is
pure and seeded; `poseAt` is a pure function of heard time.

### Runtime integration

- Catalog: an approved view may carry `shotsManifestUrl` and
  `shotsManifestSha256`; the approval hashes the library
  (`shotsManifestSha256`, conditional like `glacierSha256`).
- Prepare-time resources (mesh LOD, forest, rivers, actor routes, mirror)
  depend only on the rail plus the library footprint, never on a song's plan:
  replanning and seeking never rebuild GPU state.
- `RangePresentation` loads the library, plans per song in a worker over the
  chapter intervals where the view is on screen, and hands the timeline to
  `RangeScene.setCameraTour(viewId, timeline)`. Until a plan is ready, and
  whenever a library or plan fails, the view keeps its rail and records the
  reason in `status().shotTours[viewId]`.
- Refinement replans keep every committed pose (the Teton contract).

### Budgets and approval

- `src/assets/range/v2` stays within 60 MB. Per-region byte and triangle caps
  live in the regional config and are enforced by the pack step and a test.
- A view's terrain is re-culled only when its library needs tiles the rail
  package lacks. Any rebake changes the terrain identity and stales the
  view's approval, so each rebake is re-approved in the same commit with
  `--approve`, citing this document as the review record.

Reduced-motion support was removed from the app in 3eefb64 (PR #22); there is
no reduced-motion camera path to retain.

## Building and publishing a region

```sh
# GDAL Python for DEM normalization (once per machine), then per region:
export MIDIO_GDAL_PYTHON=/path/to/python-with-gdal
node tools/build-range-scene.mjs --view <viewId>          # warms .terrain-cache with the view's DEM grid
node tools/build-scenic-tours.mjs --view <viewId> --render   # discover, score, connect, fit, bake, review
node tools/plan-scenic-tour.mjs --library .smoke/scenic-tours/<viewId> --structure <structure.json> --song <song.wav>
node tools/build-scenic-tours.mjs --view <viewId> --publish  # write library (+ re-culled terrain); catalog marks it stale
node tools/build-range-scene.mjs --approve <viewId> --evidence docs/scenic-tours.md
```

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
short of the region's byte budget. `fitToBudget` then bakes the library's footprint and
measures the added bytes and triangles against the region's caps and the
shared 60 MB. While over, it calibrates the estimate on that bake, drops the
shot whose terrain is most its own per unit of score and rarity (the only
reveal, the only high shot or the only shot of a subject is worth more), and
chooses the links afresh from every scored pair among the shots that
remain, so a drop never strands the shots that were reached through it.
Tiles only tour cameras see are held to `budget.poseErrorScale` times the
rail's pixel budget (the app presents terrain on a 320×180 or 640×360
pixel grid); tiles the rail sees keep their approved detail.

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

#### In the application

Key frames from the review harness are not the experience: the harness
lights terrain from a fixed direction (north-west views glare white there)
and shows a shot at four moments. Libraries are therefore also judged in
the app: `tools/shot-reel.mjs` plays every published shot entry to exit at
its ideal pace through the real scene (frames, an MP4 with each shot's id,
and a sheet of five frames per shot; the drawn camera matches the library
path to the centimetre), and a continuous `tools/visual-evaluate.mjs`
manifest records the tour the planner actually makes for a song.

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
the product, not made here.

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
widest regions; those get 1.4 MB (`overrides.budget.assetBytes`, with a
`budgetNote`) inside the shared Range asset headroom. A compact tile table
in the terrain manifest would roughly halve that cost; it is a format change
left for later.

The rail shot costs nothing and adds no coverage poses: it is the authored
rail, which the approved package (and the rail stations every bake keeps)
already covers, reflections included.
