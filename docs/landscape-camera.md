# Landscape camera pace

Landscape's **Landscape pace** setting offers 1×, 2×, 3× and 4×; new runs
default to a requested 3×. The automatic short scenic lens punch is Off.
Trio keeps its existing camera accents. Wheel/pinch zoom and the slower
structural camera moves retain their existing behavior and restrictions.

Pace expands the part of an approved camera rail traversed during each
landscape appearance. Adjacent sections showing the same view share one
move. Incoming and outgoing landscapes have independent progress through
transitions, including the outgoing late-arrival allowance.

At 2×, 3× and 4× the number multiplies each appearance's own natural,
energy-driven travel before that travel is fitted to the finite rail, so a
short chapter in a long song does not inherit the whole song's slowdown. At
1× the camera keeps the whole-song fitted rate. The number is not a guarantee
of screen-space speed. A long held scene can run out of approved path. Its
pace is then reduced uniformly over the complete move; the camera does not
rush to the endpoint and stop early. No route is extended, looped or reversed.
Longer reviewed routes are separate work. Schedules saved by earlier versions
keep their original fits and pace rule.

Changing pace applies to the next **unplayed** landscape or a fresh replay.
The run remembers its highest reached heard time: rewinding does not unlock
already reached landscapes, and seeking forward commits the skipped prefix.
Seeking to zero keeps this schedule; Replay builds a fresh one at the
selected pace. Full-analysis adoption retains committed scene choices,
timing and progress curves before refining the future.

Bulk export uses the effective scene schedule, including pace changes made
during the run. Highlights save their own immutable schedule and camera-tour
policy for redraw. Saved rail progress and view timing are retained. Existing
slow structural camera moves may recompute when analysis or scene history
differs; the retained scene/analysis approximation notices cover that limit.
Older Landscape moments without a schedule are explicitly marked as approximate.
These camera records do not reproduce live input or every other scene effect.

Prepared shot tours and the Teton highway tour retain their music timing.
The glacier retains its coupled camera/ice journey. Terrain previews remain
at their midpoint. Audio, weather and celestial clocks are unchanged.

For repeatable review, `?rangePace=1|2|3|4` takes precedence over saved
`range-pace`, then the default. An invalid selected value becomes 3×.
`rangeState.cameraRails` reports the actual sides, occurrence IDs, requested
and effective multipliers, coverage, caps and timing policies. The full
versioned schedule is available through `cameraRunState` and the export
result; lightweight per-frame diagnostics omit its progress tables.

See [background Landscape review](landscape-review.md) for matched ordinary
rail captures, explicit tours-Off selection and longer continuous clips.

## Close-up opening

Playback opens with 4× lens magnification over the growing landscape. The
camera keeps its horizontal route and ground clearance, follows the rising
summit or tour action, and smoothly widens to the authored lens by 70% relief.
Seeking reconstructs the same framing. Sky anchors use the same zoom, and
wheel/pinch zoom continues to work over the opening lens.

## One default camera

Camera tours on is the single default camera. For every landscape the song
shows, the camera is chosen once, before the view's first frame, from what is
available for that song:

1. its music-timed **shot tour**, when the view has an approved library and the
   song's plan beats the authored rail on the checks below;
2. otherwise the **authored rail** at the selected Landscape pace, with its
   energy-following progress and section moves.

Off keeps every authored rail. The Teton highway tour (`?rangeTour=tetons`)
stays a separate forced tour. The choice never changes mid-landscape: an
in-place rebuild (a seek or full-analysis adoption) keeps a playing tour and
keeps a view that was given its rail on that rail. A seek tears the
presentation down, so the camera run (`CameraRun`) carries both the heard
timelines and the rail-kept views to the rebuild. A refinement that would fail
the checks is held without retrying, and the tour already playing stays; only
newly refined sections plan again.

`src/world/alpine/CameraChoice.js` compares a plan with the rail over the heard
time the view is on screen (`visibleIntervals`: the rail schedule's
appearances of the view, from their first frame through the outgoing
allowance; the same windows the plan was made over):

| Check | Rail is kept when |
| --- | --- |
| Transit share | more than 50% of on-screen time is spent on connecting moves |
| Payoffs | no shot's payoff lands on a musical moment on screen |
| Payoff timing | a payoff lands more than 1.5 s from its moment |
| Image flow | flow exceeds 1.25× its comfort limit |
| Motion limits | the timeline reports an acceleration or climb over its limit |

The status line under **Camera tours** names the reason, for example "Rail —
the authored rail beats this song's tour (the tour spends 62% in transit)".
`rangeState.shotTours.views[id].choice` reports the verdict and metrics.
`?rangeTourGate=off` plays every planned tour, for reviewing weak plans.

**Calibration (2026-11-03).** The thresholds were set by planning the 15 R7
candidate libraries from
[`review/scenic-framing-endings-20261023`](https://github.com/aepler315/midio-pixel/tree/review/scenic-framing-endings-20261023)
in Node against four synthetic songs (200 s pop, 240 s two-drop, 300 s
ambient, 90 s short), with the view on screen for the whole song. Every plan
hit its payoffs to the 100 ms key and stayed under 1.0× image flow; transit
share was the only discriminating measure, ranging 18–65% on full-length
songs. At 50%, 40 of 60 plans play their tour and 20 keep the rail. Black
Mountains keeps the rail on all three long songs; Muncho, San Gabriel and
White Mountains play their tour on all four; every 90 s plan is a single
transit-free shot. These
are geometry-only measurements, not rendered or listening reviews. In the app
the checks run over the view's scheduled appearances rather than the whole
song, so a view shown for part of a song can be judged on a different share of
its plan than this calibration measured. No library
is approved on `main`, so on `main` every landscape still plays its rail.

