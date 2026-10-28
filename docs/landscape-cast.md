# Landscape cast: expeditions

**Status:** implemented 2026-10-22 (see [Implementation notes](#implementation-notes)
for where the code reads the proposal more narrowly, and what is not yet
validated). It replaces the cast's routes and peaks described in
[range-v2-progress.md](range-v2-progress.md#the-cast-as-lights-2026-10-01)
and the cast half of [landscape-peaks.md](landscape-peaks.md). Trio is
untouched.

## The problem

In Landscape the cast are three lanterns (Midio teal, Broshi coral, Midasus
violet) that light the ground, trees and water around them. The light is the
part that works. What they do does not:

- **No destination.** `actorRoutes` picks five seeded anchors per actor and
  `routePosition` walks them back and forth, one sweep every 40–200 s. Lane
  activity changes the speed, but nothing is ever reached.
- **Peaks with no visible cause.** `compileActorScore` fires a peak when a
  lane's 1.5 s average crosses a song-relative level (at most one per actor
  per 20 s). The swarm gathers into the actor's outline, holds 1.5–4 s and
  dissolves. It is tied to the music statistically but to nothing in the
  scene, so it reads as random.
- **Nothing accumulates.** The valley at the end of a song looks the same as
  at the start.

## Decisions (Ashton, 2026-10-22)

| Question | Answer |
| --- | --- |
| What the cast does | **Per view, by terrain**: an *Ascent* where a clear summit holds the frame, *Lamplighters* elsewhere |
| What sets timing | **Song structure**: milestones are pinned to sections, and the payoff lands on the climax phrase |
| Figure gathering | **Removed entirely**: lights, their work and its traces only |
| Midasus's height | **Six feet up** (1.83 m): she flies but keeps to the ground like the others. Her high flights read as random |

## Model: one job per view, resumed on return

A song visits several views. `BiomeManager` casts biomes by structural label,
so every recurrence of a label returns to the same place. The cast take that
literally: **each view has its own job, and the cast pick it up where they
left it when the song returns.** A verse view's climb continues on the next
verse. The camp light from the last visit is where they are standing when the
view comes back.

Definitions, all compiled once per song from heard-time data (seek-safe,
like `LandscapeScore`):

- **Stays** of view *v*: the section intervals whose biome resolves to *v*.
  During a travel blend, the outgoing view is frozen and the incoming view
  advances. Work happens only in the view being travelled to.
- **Finish time** `F_v`:
  - The **climax view** is the view of the climax phrase. The climax phrase
    is the `LandscapeScore` phrase with the highest `relEnergy01`, the later
    one on a tie. For the climax view, `F_v` = the phrase's start + min(4 s,
    25% of the phrase).
  - **Every other view**: `F_v` = 85% of the way through its last stay.
- **Work** `W_v(t)` = ∫ over the stays of *v* up to *t* of `rate(τ)`, where
  `rate = (0.35 + 0.65 · team(τ)) · weather(τ)`. Here `team` is the mean of
  the three lanes' `glow`, and `weather` is defined under Storms below.
- **Progress** `p_v(t) = W_v(t) / W_v(F_v)`, clamped to [0, 1]. So the
  cast work faster when they play, but always finish at `F_v`. Structure sets
  *when*; the lanes set *how* the time inside it is spent.
- **Camps**: the end of each stay. Progress at that time is a camp position,
  known at compile time.

Fallbacks:

- **One view for the whole song**: a single job, finishing on the climax.
- **No trusted phrases** (for example, every section has confidence 0):
  the stays still come from the sections, as above, so views camp and
  resume. Only the climax changes: it is the maximum of a 3 s trailing
  `globalEnergyNorm` after 25% of the song. The climax view is the view of
  the section holding that time; if that section has no view, the nearest
  viewed section before it, then after it. That view finishes at the
  climax, clamped into its stay; every other view finishes 85% of the way
  through its last stay. A song with one view (or under 30 s) keeps its
  single whole-song stay, as above.
- **Songs under 30 s**: one job, no camps, finishing at 85% of the song.

## Choosing a job per view

`classifyCastJob(data, view, { waterLevelM, seed })` runs at prepare time,
where `actorRoutes` runs today (`RangeScene` ~line 1140). It returns
`ascent` when all of these hold, and `lamplighters` otherwise:

1. **A summit candidate exists.** This is a visible tile sample
   (`tile.visible`), within |x| ≤ 0.72 NDC at the three rail stations
   (0.15 / 0.5 / 0.85), 1.5–12 km deep, below the sky band (y ≤ 0.55).
2. **It rises over its own foot.** Its screen y minus the lowest visible
   ground within ±0.15 NDC x of it is ≥ 0.25 NDC (about 90 px on the 720 px
   stage). The candidate with the largest rise wins.
3. **A path to it is visible.** The planned path (below) has at least 70% of
   its waypoints seen from the middle station. This uses the line-of-sight
   test in `LandscapeGiants.seenFrom`, exported for this purpose.

Tour views (`view.tour`) move the eye too far for either job to stay in
frame. They keep plain wandering lanterns with no peaks (see Out of scope).

## The Ascent

### Geometry (`ascentPlan`)

- **Summit** S: the winning candidate.
- **Approach.** If the main lake is visible, use the mirror lake: the same
  water test as `giantLayout`, near water nearest S's screen x. Midio's start
  W0 is that water's near edge. The landing L is the shore sample nearest S
  in xz. Without a lake, L is the lowest visible ground within ±0.2 NDC x of
  S, and there is no water leg.
- **Path** L → S: 24 steps of greedy ascent. At each step, try headings
  within ±50° of the bearing to S, at step length |LS|/24. Keep a candidate
  only if it is seen from the middle station and in frame at all three
  stations. Among those, prefer slope ≤ 35°. On a steep face this produces
  switchbacks. If no heading qualifies, take the straight step and mark the
  waypoint hidden. The result is one parameterized polyline (water leg plus
  climb) with arc-length `u ∈ [0, 1]`. The water leg takes the first 12% of
  `u`, or none.
- Everything is seeded by `${view.id}:cast`, the same as today's routes.

### Roles (positions on the path at progress `p = p_v(t)`)

- **Midio, lead climber**, at `u = p`. On the water leg he skims, and the
  existing wake (`uWake`) now runs from W0 toward L. That gives the wake a
  heading. On the face his `hoverM` drops to 2 m: a headlamp on rock.
- **Broshi, porter and rope-fixer**, at `u = p − δb`. `δb` goes from 0.07
  when his lane is quiet to 0.03 when it plays, so he closes the gap on the
  bass. During the water leg he walks the shore to L instead. The tree
  parting (`uParting`) follows him: he is cutting the approach.
  - He sets **fixed-line lights** along the path he has passed. Lights are
    spaced evenly in `u`, up to 32 per view (12 at quality level 4). Each
    light's scheduled time is when Broshi's `u` passes it. It actually
    kindles on the **nearest Broshi-lane onset within ±1 beat** of that time,
    found at compile time from the timeline. With no onset in the window,
    it kindles at the scheduled time.
  - A light never goes out. It stays for every later stay of that view and
    through the end of the song.
- **Midasus, scout**, at `u = p + δm`, six feet (1.83 m) above the path. `δm` goes
  from 0.04 to 0.12 with her lane: she ranges further ahead while she plays.
  Her 700 m light radius washes the next pitch before the others reach it,
  so the viewer sees where they are going. Her three baby stars trail her
  as now.
- **Camps.** At the end of each stay, the team's three positions collapse
  together over 2 s and leave a **camp light**: a steady, two-tone light at
  Midio's `u`. The camp light stays. When the view returns, they set out
  from it.

### Payoff

When `p_v` reaches 1:

- **Climax view.** Midio's light becomes the **beacon**: radius ×3 and
  gain ×2 over 1.5 s. A **fuse** of brightness then runs up the fixed lines
  from L to S over 2 s, each light flaring once as it passes. The beacon
  holds for the rest of that stay and every later stay of the view.
- **Other views.** The same beacon at half the gain, with no fuse. It reads
  as "reached", not "the moment".

## The Lamplighters

### Geometry (`lampPlan`)

- **Cairn sites**, 6–8: shore samples, falling back to low open ground,
  picked with `pickAnchors` into 8 screen-x bins.
- **Buoy sites**, 0–6: mirror-lake samples, 6 bins. None without a lake.
- **Sweep order**: left to right, starting from the site nearest wherever the
  actor stood at the end of the view's previous stay.

### Roles

- **Broshi** lights the cairns in order. Cairn *k* is due at
  `p = (k + 1) / (Nc + 1)`, snapped to the nearest Broshi onset within
  ±1 beat. Between cairns he walks a smooth path to the next one.
- **Midio** lights the buoys the same way, on his own lane. With no lake, he
  lights alternate cairns and Broshi lights the others.
- **Midasus** draws **survey threads**. Once both ends of a neighbouring pair
  (by sweep order) are lit, she flies the ground between them six feet up and
  leaves a faint thread of light in her hue, draped over the terrain. Each thread is due when its
  second end kindles, snapped to her lane's nearest onset.
- Lit sites and threads never go out.

### Payoff

At `p = 1`, the last thread closes the network back to the first cairn.

- **Climax view**: every thread brightens once, from the closing thread
  outward, over 2 s.
- **Other views**: the threads simply settle to a steady glow.

## Shared rules

- **The lit thing comes from the lantern.** When any light kindles, 12 of
  the actor's motes leave the lantern and settle into it over 0.8 s. This
  causal transfer is the swarm's only remaining choreography. Otherwise the
  swarm wanders as now, with no outline gathering.
- **Storms.** `weather(τ)` is 0.15 inside a `LandscapeScore` episode, ramped
  over its 6 s build, and 1 elsewhere. Ascent: the team bunches up
  (`δb` and `δm` × 0.3) and the lanterns dim
  to 60%. Lamplighters: they pause in place. Normalization makes the time up
  after the storm.
  - **Exception: the climax view's final stay.** There `weather = 1`. The
    summit push goes on through the storm, and the lightning (`strikes`)
    lights the team. The highest-energy phrase is often also a storm episode,
    and the climax should not be spent sheltering.
- **Day and night.** The gain law is unchanged: ×1.6 in the dark, ×0.45 at
  noon. Placed lights follow the same law at 40% of a lantern's gain. Kept
  lights read best after sunset, which the one-day clock puts at the end of
  the song.
- **Lighting budget.** Only the three lanterns light the terrain, through the
  existing `uActorPos` / `uActorColor` slots. Fixed lines, camps, cairns,
  buoys and threads are emissive billboards and ribbons only (the fixed line
  is also a rope ribbon up to the light Broshi is fixing). They add no
  per-fragment light loop. A lantern sunk under the cloud sea lights nothing:
  its pool and its glints go with it (`actorShown`).
- **Drawing.** The cast draws in a pass of its own after the near partition,
  against every band's depth and the trees' crown cut, so the land in front
  hides it exactly, and only while some of it can show (a lantern out, or a
  light or thread lit); the presenter lays that layer bilinear over the
  nearest-upscaled pixel frame, in full colour, so its lights and lines are
  not stair-stepped. `CastRaster.js` filters every light over each pixel, so
  nothing twinkles with sub-pixel motion, and a light finer than a pixel
  keeps a peak in proportion to its size, so motes and far lights stay
  visible. A thread or rope is a double-sided ribbon whose centre line is as
  bright as the 1-px line it replaced (`THREAD_PEAK`); on the cast's layer
  its overlaps keep the brightest layer (max blending) instead of beading
  where a short, turning drape step folds it. The layer therefore sits
  above the 2D layers the working buffer holds (far vignettes and mid-depth
  life between partitions; the cut flash, bloom, film finish and an in-frame
  HUD after them), except the range caption, whose plate it shows through.
  A travel, and a caller with no smooth layer, keep it in the band passes;
  the lake mirror always reflects it with each band. Every light, lanterns
  and motes included, is fogged in its shader at its true position on the
  drawn (lifted) ground: through the valley mist as the ground under it is,
  and more completely by the cloud sea -- under a full sea's top it is gone
  while the ground beside it may keep a trace (`emitterVisibility`).
- **Analysis refresh.** When the full analysis replaces the opening one during
  play, the schedule takes `previous` and `committedThroughMs`, the same way
  `compileLandscapeScore` does. Work, camps and lights already heard are
  frozen. Only the future is re-normalized, so nothing already lit moves or
  goes out.
- **Seeking.** Every state is a function of heard time and the compiled
  schedule, so seeking either way reads the same, as it does today.

## What is removed

- The peak machinery in `RangeActors.js`: `ACTOR_PEAK_*`,
  `ACTOR_RISE_MS` / `HOLD` / `MAX_HOLD` / `FALL`, the `peak` curve, the
  `peaks` output, `ACTOR_OUTLINES`, `edgePoints`, and the `+0.5 · peak` term
  in the light gain.
- `uCohere`, `uShapePx`, `uShapeLift` and the outline targets in `ActorsGL`.
- `biomes.actorPeakOverride`. It is replaced by
  `biomes.castProgressOverride` (a number, or `{ [viewId]: p }`), which holds
  job progress for review.
- The giant code in `LandscapeGiants.js` (`giantMaskData`, `giantLayout`,
  `mirrorGiantSpan`, `aheadOfEye`, mask uniforms). `giantAmounts()` already
  returns zeros, but `RangeScene` still computes `giantLayout` at prepare
  time (~line 1199) and updates giant uniforms every frame (~1730–1745).
  Those call sites go too. `seenFrom` moves to a small shared module, and the
  matching tests in `landscapeGiants.test.js` are removed.
- `actorRoutes` / `routePosition` back-and-forth routes, except for tour
  views (see Out of scope).

## Implementation plan

New pure modules (no THREE, unit-testable):

- `src/world/alpine/CastJobs.js`: `classifyCastJob`, `ascentPlan`,
  `lampPlan`, and `pathPosition(plan, u)` (Catmull-Rom over the waypoints,
  terrain-clamped as `routePosition` does now).
- `src/world/alpine/CastSchedule.js`:
  `compileCastSchedule({ sections, viewForSection, phrases, episodes, timeline, lanes, durationMs, previous, committedThroughMs })`.
  It returns per view: stays, `F_v`, camps, and placement times (snapped to
  onsets). `at(timeMs)` returns per view
  `{ p, offsets: { broshi, midasus }, lit: n, camps: n, payoff01, weather }`.

Changes:

- `RangeActors.js`: keep the glow compilation (`compileActorScore` without
  peaks). `rangeActorsAt` adds `jobs: schedule.at(t)`.
- `RangeFrame.js`: no new field. `frame.actors` carries the schedule state.
- `RangeScene.js`: build the plan beside today's route call and store it on
  the prepared view. Rewrite `_setActors` to place lanterns from
  `pathPosition` and drive the new light sets.
- `ActorsGL.js`: drop the outline gathering. Add `SiteLights` (one instanced
  billboard set per view, max 48) and `SurveyThreads` (line strips, max 12).
  Count both in `ActorsGL.bytes()` so the prepare budget stays honest.
- `docs/landscape-peaks.md` and `range-v2-progress.md`: point to this
  document for the cast.

Tests:

- **Classifier.** A synthetic cone above a lake gives `ascent` with a water
  leg. A cone with no water gives `ascent` with no water leg. A flat basin
  gives `lamplighters`. A summit hidden behind a nearer ridge fails the
  visibility check.
- **Schedule.**
  - `p` is monotone and reaches 1 exactly at `F_v`.
  - Progress is frozen outside the view's stays and resumes from the last
    camp on return.
  - Storms slow progress except in the climax view's final stay.
  - Every placement is within one beat of its scheduled time.
  - A refreshed analysis never moves or removes a light at or before
    `committedThroughMs`.
  - Seeking forward or back gives identical state.
- Update `rangeActors.test.js` for the removed peaks.

## Validation

Follow [the visual evaluation loop](visual-evaluation-loop.md). The default
corpus (24 s generated clips) is too short for camps and returns. Add a
generated song of at least 150 s with an A-B-A-B-C-B form, or use
representative recordings. Judge these moments, each stated with song and
timestamp:

1. The first stay's end: the camp light appears and stays.
2. The first return to that view: the team is at the camp, the fixed lines
   are still lit, and the climb continues.
3. Arrival at the climax: beacon and fuse on the climax phrase. Check that
   the lighting lands with the music, not just that it happens.
4. A storm hold outside the climax view.
5. The final frames: the record of the song left in each view.

Views to cover:

- `teton-jackson-lake`: Ascent with a lake crossing.
- `tombstone-north-klondike`: Ascent without a lake.
- `panamint-dantes-view`: expected Lamplighters.
- `monument-valley-163`: whichever the classifier picks. Check that the
  choice reads well.

## Out of scope

- **Tour views** (`view.tour`, e.g. `teton-range-tour`): they keep plain
  wandering lanterns, with the peaks removed.
- **Trio**: Trio's cast choreography (`TrioPerformance`) is unchanged.

## Tunables chosen without review

These were set by Claude and are open to change:

- Rise threshold: 0.25 NDC.
- Path: 24 steps, 70% visible.
- Finish at 85% of a view's last stay.
- Climax arrival: the phrase start + min(4 s, 25% of the phrase).
- Gaps: `δb` 0.03–0.07, `δm` 0.04–0.12.
- Storm rate: 0.15.
- Light counts: 32 fixed lines, 6–8 cairns, 0–6 buoys.
- Placed-light gain: 40% of a lantern's.
- Beacon: radius ×3, gain ×2.

## Implementation notes

Code: `CastJobs.js` (classifier, plans, `castWork` lights and marks),
`CastSchedule.js`, `LineOfSight.js` (`seenFrom`), `RangeActors.rangeActorsAt`
(schedule cache, `castProgressOverride`), `RangeScene._setActors` /
`_castJob` / `_setCastLights`, and `ActorsGL` (`SiteLights`, `SurveyThreads`,
the mote kindling). Tests: `castJobs.test.js`, `castSchedule.test.js`,
`rangeActors.test.js`, `rangeCastPresence.test.js`.

Choices the proposal left open, as implemented:

- **A summit's foot** is the lowest ground on screen within 0.15 NDC x of it
  *between half its depth and its own depth*. The nearest foreground would
  otherwise be every candidate's foot. A candidate must also be a local top
  (no neighbouring sample higher), so a high sample on a face never wins.
- **The storm exception** applies to the stay that holds the climax view's
  finish (the summit push), not the view's last stay, which can come after
  the climax. When that stay is the whole song (the one-job fallbacks), it
  runs from the climax phrase onward. Storms ramp in over their 6 s build and
  out over 4 s.
- **Other views' beacon** gets half the climax boost: gain ×1.5 instead of ×2.
  The radius is ×3 in both.
- **`at(t)`** returns `{ p, active, finishMs, climax, offsets, gather01, camps,
  payoff01, fuse01, weather, shelter01 }` per view. A light's kindling is
  `kindleTimes(viewId, marks)` (memoized per marks array), so the scene counts
  lit lights itself rather than reading `lit`.
- **Beat** for onset snapping is the section's `barMs / 4` (500 ms
  fallback). A thread snaps only forward, never ahead of the light it joins.
- **Lamplighters** sweep a fixed left-to-right order. Resuming where they left
  off already starts each return at the actor's last position. They make no
  camps. Threads join neighbouring cairns only (at most 8), and the closing
  thread is due at `p = 1`. A view with fewer than two cairn sites, and a
  tour view, keeps wandering lanterns. A shot tour over a rail view keeps
  the view's job, so no light it has left goes out while the camera moves.
- **Sites** may stand up to 30 km out when fewer than 16 framed ground
  samples lie within 12 km (a view down onto a wide basin, like Panamint).
  They are drawn at a fixed size on screen.
- **Quality level 4 and up** draws 12 of the 32 fixed lines, evenly spaced.
  The schedule is unchanged.
- **Refresh.** If the new analysis puts a view's finish at or before
  `committedThroughMs` while the view is unfinished, it finishes at the
  first time in its stays at least 4 s later.

Classifier on the current catalog: Ascent with a lake leg for
`teton-jackson-lake`, `nc-ross-lake-north` and `muncho-lake-south`. Ascent
without one for `tombstone-north-klondike`, `denali-wonder-lake`,
`izta-popo-west`, `white-mountains-owens`, `la-sal-castle-valley` and
`chugach-matanuska`. Lamplighters for `panamint-dantes-view` (4 cairns),
`monument-valley-163`, `black-mountains-catawba` and `san-gabriel-baldy`.
`pend-oreille-valley` wanders (no cairn sites). Planning takes 7–64 ms per
view at prepare time (Node, desktop CPU).

### Validation so far (2026-10-22)

Generated song: 162 s, A-B-A-B-C-B at 27 s per section, 120 BPM (A quiet,
B kicks, bass and melody, C loudest). The analysis detected its sections
with confidence 0, so there were no trusted phrases and the energy fallback
set the climax at 111.0 s, about 3 s into C. The capture tool forces one
view per run, so every run is one job (no camps or returns).

- `teton-jackson-lake` (Ascent, lake leg). At 50 s the team is low on the
  face above the shore. 30 of 32 fixed lines are lit by 110 s. At 113.6 s
  Midio's teal beacon floods the summit and the fuse flares up the fixed
  lines. At 160 s (dusk) the full line runs from the shore to the summit,
  with the team on top. At 110–116 s (midday by the song's clock) the lit
  lines are faint: the day law puts placed lights at 0.4 x 0.45 of the
  lanterns' night gain.
- `panamint-dantes-view` (Lamplighters). Threads are drawn across the basin
  through the song, and by 160 s the network closes back on the first
  cairn.
- Not yet judged: camps and returns, which need several views in one song.
  Even with no forced view, the generated song's 13 detected sections
  (all confidence 0) resolved to one biome, so it never left its view.
  This needs a representative recording; a storm hold, since this
  song has no storm episode; `tombstone-north-klondike` and
  `monument-valley-163` on screen; and listening to whether the arrival
  lands with the music. Untrusted sections now keep their stays (see
  Fallbacks), so such a song exercises camps and returns too once it leaves
  its view; that path has not been judged visually either.
