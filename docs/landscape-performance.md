# Landscape performance schedule

LandscapeScore compiles phrase identity, measured energy, camera moves and zero
or more weather episodes once per analysis revision. RangeFrame snapshots the
score at heard time; sky, water, terrain and lighting consume that frame's storm.
Quiet flat material has no obligatory squall. Physical RMS, where available,
prevents normalized background noise from becoming weather. Distinct sustained
peaks can earn separate builds, rain, accents and recovery.

Each weather episode has a character, classified once when the storm score
compiles (`RangeStorm.stormKind`) from that episode's own strikes per minute
and energy:

| Kind | Rule | Look |
| --- | --- | --- |
| 0 shower | under 1.5 strikes/min | strength capped at .6, never flashes, lighter slate deck |
| 1 downpour | otherwise | the original squall colours, unchanged |
| 2 thunderstorm | at least 6 strikes/min and energy01 at least .7 | darker, cooler slate |

`storm.at(t).kind` is the kind of the episode giving the largest amount (or,
after the deck has gone, the clearing's own storm). Lightning is gated by the
episode that owns the hit strike, so a stray hit inside a shower never lights
it. A song with no percussion evidence at all keeps every episode a downpour,
as before kinds existed. `STORM_KINDS` holds one frozen row per kind: the sky's
overcast gradient, the deck's dark/lit tint and the GPU zenith/horizon/air;
the sky (drawStormSky) and RangeScene read the same row by index. Every row
stays slate, away from the protected hues.

Live analysis keeps the active phrase/weather and its already heard lightning
strikes. An adopted episode keeps its kind, because the kind is remembered on
its frozen strike list. A six-second camera join admits the future schedule continuously. Seeks
sample envelopes directly; no skipped-event burst is dispatched.

Normal-view sky anchors are lifted into the authored rail's direction basis and
projected through the same moved pose, lens and off-axis crop as terrain. Both
travel partitions project before blending, including a late incoming fade.
Camera bases are resolved once per immutable sky frame and shared by every star,
cloud and celestial projection. Tours retain their world-direction sky. Both update the resolved light anchor.

Tour worker energy sampling uses milliseconds throughout (250 ms per sample).
Station selection checks climb and heading feasibility before committing a leg.
Distant composition preserves the safe eye path, checks every yaw step and a
whole-tour quality budget, and can select an explicitly recorded same-role
alternative. It does not retime a road to rescue a missed close visit.

`heroFraming` records `station`, `distant` or `missed`, the originally requested
point, the framed point, station distance and the fraction of the three-second
window inside the central 80% of the projection. These are projection metrics,
not proof of terrain occlusion, recognizability, musical acceptance or hardware
frame pacing. The browser tour harness now asserts the existing 0.8 view-quality
target and projected framing for feasible station visits, rather than merely
recording quality. A short song can retry a bounded slower itinerary when its
fast altitude corridor clears the ground but misses that quality target.
An authored station may look at a different named subject than its road waypoint;
framing reports both identities rather than testing the waypoint behind the camera.
Generated five-tempo fixtures remain synthetic music coverage.

The core Node suite runs serially: server tests briefly create/remove public-src
fixtures while real browser tests snapshot that directory. Parallel execution
can race the fixture cleanup and fail with ENOENT, independently of scene code.

Captures, matching audio, device traces and review reports stay outside Git as
required by AGENTS.md. See the PR/chat evidence for the exact tested revision,
completed comparisons and remaining external CI/Pages configuration limits.
