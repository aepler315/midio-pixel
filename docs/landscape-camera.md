# Landscape camera pace

Landscape's **Landscape pace** setting offers 1×, 2×, 3× and 4×; new runs
default to a requested 3×. The automatic short scenic lens punch is Off.
Trio keeps its existing camera accents. Wheel/pinch zoom and the slower
structural camera moves retain their existing behavior and restrictions.

Pace expands the part of an approved camera rail traversed during each
landscape appearance. Adjacent sections showing the same view share one
move. Incoming and outgoing landscapes have independent progress through
transitions, including the outgoing late-arrival allowance.

The selected number is a multiplier of the existing rail-progress rate,
not a guarantee of screen-space speed. A long held scene can run out of
approved path. Its pace is then reduced uniformly over the complete move;
the camera does not rush to the endpoint and stop early. No route is
extended, looped or reversed. Longer reviewed routes are separate work.

Changing pace applies to the next **unplayed** landscape or a fresh replay.
The run remembers its highest reached heard time: rewinding does not unlock
already reached landscapes, and seeking forward commits the skipped prefix.
Seeking to zero keeps this schedule; Replay builds a fresh one at the
selected pace. Full-analysis adoption retains committed scene choices,
timing and progress curves before refining the future.

Bulk export uses the effective scene schedule, including pace changes made
during the run. Highlights save their own immutable schedule and camera-tour
policy for redraw. Older moments without a schedule are explicitly marked
as approximate. Existing analysis/history approximation notices remain:
these camera records do not reproduce live input or every other scene effect.

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
