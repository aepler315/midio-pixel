# Range v2 device runs

These procedures establish device-specific evidence, not permission to develop.
Task-authorized experiments may continue without the listed devices under the
[experimental development policy](experimental-development.md). Report missing
hardware measurements explicitly and reserve device-performance claims for
measurements on the identified hardware.

Task 16 of the Range v2 plan asks for real-device measurements of steady-state and cold/transition behaviour, including a 10-minute minimum-device run. This build was developed without a physical phone or GPU: every timing measured here is from Chromium SwiftShader (software WebGL2) and is **not** a device measurement. **Device acceptance is unverified** until the runs below are done on real hardware and their reports are added to the table at the end.

## What to run

Run each on the real device, with the tab in front, the screen awake and nothing else heavy running. Warm the device for a minute first by playing any song.

| Run | Device | Length | Why |
| --- | --- | --- | --- |
| A | JOYING JY-UTS18N12 (Android), minimum supported device | 10 min | Fullscreen playback, thermal throttling, governor rungs and scene transitions under the mobile budget |
| B | An iPhone (Safari) | 10 min | Same, on the other mobile engine |
| C | A desktop or laptop with a GPU (Chrome) | 5 min | Desktop budget (512 MiB, or 256 MiB when the machine reports under 8 GB), the 16-band travel seam at full resolution |

## How

1. **Open a fresh page** (not one that has already played a song): `https://supermaudio.com/?fpsHud=1` (v2 is the default renderer; `fpsHud=1` shows the frame rate on screen). For a legacy comparison run, add `&rangeRenderer=legacy`.
2. **Attach DevTools to the page** (while it still shows the title screen):
   - Android: connect the device by USB with USB debugging on, open `chrome://inspect` on a desktop Chrome, and choose **inspect** under the tab.
   - iPhone: turn on Settings → Safari → Advanced → Web Inspector, connect to a Mac, and use Safari's Develop menu → the phone → the tab.
   - Desktop: press F12.
3. **Start the probe before loading the song.** In the console, paste the whole of `tools/range-device-probe.js` and press Enter. It waits for a song, so its cold-start bucket covers the song's real start (world construction, strip bakes, the first view's preparation). To change the length, edit `MINUTES = 10` near its start.
4. **Load a song of at least 4 minutes,** so it passes through several biomes and view-to-view travels. Choose the Range world if a picker asks.
5. **Leave it running.** Keep the song playing (restart it if it ends). Don't switch tabs.
6. **Save the report.** When it finishes, the probe prints one JSON report and copies it to the clipboard. Do **not** commit it: `docs/evidence/` is closed to new files (see `AGENTS.md`). Keep it under `.smoke/`, or attach it to a GitHub Release when it must outlive CI retention, and link it from the pull request and from a row in the results table below.

For run A, use the browser or WebView you normally play through and enter fullscreen at the head unit’s native display size. Record the browser and screen resolution with the report.

Leave the FPS cap at its default (uncapped) for acceptance runs; the report records every cap it saw in `capFps`. A capped run is still useful, but its delivered intervals measure the cap.

## What the report contains

| Field | Meaning |
| --- | --- |
| `gpu`, `userAgent`, `deviceMemoryGB`, `dpr` | Device, browser and GPU as the browser reports them |
| `stage`, `rangeTarget` | CSS and backing size of the stage; size of the Range render target |
| `budget` | Residency budget class chosen (`desktop` 512 MiB, `mobile` 320 MiB; 256/192 MiB when the device reports less than 8 GB, or 192 MiB when mobile memory is unreported) |
| `coldStartCaptured` | True when the probe was running before the song loaded (otherwise `cold` is just the first 20 s it saw) |
| `songRestarts` | How many times the song was restarted during the run (the probe follows the new song) |
| `frameDelivery.cold` | The first 20 s of the song, including the frame that spans world construction |
| `frameDelivery.steady` | While a single view is drawn |
| `frameDelivery.travel` | While two views are composited (view-to-view travel) |
| `….callbacks` | requestAnimationFrame callback intervals (vsync waits included). Callback cadence only: a capped or failed frame still produces a callback |
| `….delivered` | Intervals between successfully **presented** frames, identified by the presentation's `(generation, frameId)`. A repeated id is the same frame; a failed presentation is counted in `failedPresentations` and its frozen picture stays inside the next delivered interval |
| `…medianMs / p95Ms / p99Ms / maxMs / stallsOver100ms / fps` | Interval statistics for `callbacks` and `delivered`. Percentiles come from a bounded, evenly thinned sample on long runs (`truncated: true`); counts, max and stalls are exact |
| `….excluded`, `generationChanges` | Callbacks while paused or hidden are excluded, and pause, visibility and song changes break the interval chains, so resuming never counts the gap as one frame |
| `….capFps` | FPS caps in effect during the bucket |
| `qualityLevels` | Frames spent at each governor level (0 is the full show; see the ladder below) |
| `levelTimeline` | The level sampled every callback, run-length encoded as `{level, frames, fromMs, toMs}`. `fromMs` and `toMs` are the first and last callback of the run, in ms from the start of recording (the song's start when the probe was pasted before the song, else the paste); a level that returns later is a new run. At most 2,000 runs; later changes are only counted in `levelRunsDropped` |
| `performance` | The governor's own record and the drawn scene at the end of the run: the same block as **Copy graphics report**'s `performance`, from `window.__SMW.performanceReport()`. It covers the current song only, since a restarted song starts a new governor. `null` with `performanceError` set when the build has no such hook |
| `performance.level`, `.fpsCap`, `.presentedFps`, `.callbackFps` | The level, FPS cap and presented and callback frame rates when the report was taken |
| `performance.governor.events` | The last 32 level changes, oldest first: `atMs` (ms since the governor's time origin: its first sample, or its warm-up start if earlier), `from`, `to`, `cause`, and the deciding frame's `periodMs`, `workMs`, `overCount` and `workOverCount`. `cause` is `period` (shed: missed frames), `work` (shed: callback work near the frame period), `probe-expired` (shed: a recovery probe ran out with no work timing), `recovered`, or an outside change: `limit`, `fixture`, `hold`, `retro`. `eventsDropped` counts older events overwritten; `counters.levelChanges` counts all of them |
| `performance.governor.levelMs`, `.sinceStartMs` | Milliseconds spent at each level 0–6, and the time from the governor's time origin to its latest frame |
| `performance.governor.counters` | `samples` (valid frames seen), `overBudget` (frame period over budget), `workPressure` (work at or above 85% of the frame period), `noHeadroom` (rendered frame with work above 70% of the period), `levelChanges` |
| `performance.governor.frames` | `{count, median, p95, max}` in ms over the last 600 frames for `periodMs` (every frame), `workMs` and `syncWaitMs` (rendered frames only; `syncWaitMs` only when timed, so its count can be lower) |
| `performance.syncWait` | `last`: the timed synchronous waits of the last rendered callback (`src/render/SyncWaitLedger.js`): `totalMs`, `calls`, and ms per kind — `crestRead` and `crestEdgesRead` (crest `getImageData`), `probeCollect` and `probeSyncRead` (crest probe readback), `presenterGetError` (the presenter's `getError`); `stats`: the same as `governor.frames.syncWaitMs` |
| `performance.drawn` | What the frame drew: `viewId`, `songRangeId`, `tiles` (the prepared view's manifest tiles, counted as `tools/range-frame-cost.mjs` counts them: hidden and tour-only tiles included), `geometryTriangles` (terrain geometry; a compiled-terrain view reports its own mesh count), `trees` (`mesh`, `billboards`), and whether the `mirror` and `backdrop` are active. `null` fields are unknown |
| `performance.governor` scalars | The governor's state when the report was taken: `level`, `minLevel` (the quality limit), `workTimingEnabled`, `framePeriodMs` (the detected display period), `observedWorkMs` and `workHeadroomMs` (the work filter and the room left under the work line), `probeLevel` and `probeUntilMs` (a recovery probe in progress, else `null`) |
| `performance.gpuTimer` | Always `null` in this build: a per-frame GPU timer is not implemented (see the frame-cost plan's Phase 0 record). It does not mean the timer extension is absent |
| `legacyFrames` | Frames where the Range drew legacy scenery (a view not ready, or refused room) |
| `residencyPeakMiB`, `residencyPeakByOwnerMiB` | Highest ledger ownership, recorded by the ledger whenever ownership grows (so short-lived scratch reservations count), and what owned it at that moment. `residencyPeakWindow` says where the window starts: `page load` when the probe ran before the song (so use a freshly opened page), else `probe start` |
| `overcommits`, `denials` | Ledger overcommits (should be 0) and refused reservations |
| `rangeRenderMsPerFrame`, `rangeCopyMsPerFrame` | CPU submission time per Range frame to render all its passes (far, mid, near, rock stage; both sides during a travel) and to composite them onto the stage. Not GPU completion time (`rangeTimingScope`) |

## Acceptance

| Check | Pass |
| --- | --- |
| Steady playback | `steady.delivered.p95Ms` ≤ 20 on desktop; on phones the governor holds a level with `steady.delivered.p95Ms` ≤ 34 (30 fps floor) |
| Stalls | `delivered.stallsOver100ms` ≤ 1 per minute outside `cold` |
| Travels | `travel.delivered.p95Ms` within 1.5 × `steady.delivered.p95Ms` |
| Memory | `overcommits` = 0; `residencyPeakMiB` ≤ the budget |
| Fallback | `legacyFrames` is only seen at song start or a view's first appearance (a few seconds), never for a whole section |
| Oscillation | `qualityLevels` concentrated on one or two adjacent levels after the first minute (no ladder chatter) |

## Quality ladder

`PerfGovernor` owns the level (0 = full quality … 6) and its hysteresis:
- it sheds a rung after about 1 s of sustained over-budget frames;
- it recovers one after 10 clean seconds;
- a rung that fails again after recovering waits twice as long before the next try.

What the Range scene gives up at each level is defined in `src/world/alpine/RangeQuality.js`:

| Level | Foliage kept | Fog samples | Pool reflections |
| --- | --- | --- | --- |
| 0–1 | all | 6 | on |
| 2 | 85% (stable subset) | 6 | on |
| 3 | 70% | 4 | on |
| 4 | 55% | 4 | on |
| 5 | 40% | 3 | on |
| 6 | 30% | 2 | off |

At no level does the ladder touch the landform (terrain meshes and their LOD budget), ground contact, the performers or the musical signatures.

Fewer fog samples keep the frame's overall haze within 3% of full quality (`test/rangeAtmosphere.test.js`). Only where individual mist puffs fall changes.

## Results

| Date | Device / GPU | Browser | Run | Steady delivered p95 | Travel delivered p95 | Delivered stalls | Peak MiB | Levels | Report |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| — | not yet run | | | | | | | | |

## Coherent terrain continuation — 2026-10-01

No current-source desktop or physical Android run was available for `codex/coherent-terrain-performance-20261001`. Hardware acceptance is **pending**; prior device results do not validate this branch. CPU geometry measurements and unit tests are not frame-time evidence. Use the procedure and gates above on the three forced candidates and ordinary approved views; see [the continuation record](evidence/terrain-continuation/README.md).

## Presented-frame evidence — 2026-10-13

The probe now reports delivered (presented) frames separately from rAF
callbacks (`src/render/FrameDelivery.js`, tested in
`test/frameDeliveryMetrics.test.mjs` with a 60 Hz / 30 FPS cap, repeated
frame ids, paused and hidden stretches, failed presentations and song
changes). The acceptance gates above now read the `delivered` intervals.
No physical desktop, Android or iPhone run was made for this change:
hardware acceptance remains **pending**, and SwiftShader runs cannot close
it. Optional GPU timer queries and governor threshold changes are deferred
until these reports show an attribution need.

## Measurement segments — 2026-10-17

Cold, steady and travel intervals now break when their measurement segment
changes. A steady bucket that resumes after thirteen seconds of actual travel
must not report that travel as one thirteen-second frozen frame. Earlier
multi-bucket runs without this boundary handling have invalid gap, stall and
aggregate FPS statistics; retain them as superseded evidence, not acceptance.

`frameDelivery.playback` also records the continuous post-cold chain across
steady/travel boundaries. It uses song load generation and a composite
presentation/frame identity, so an actual quality-refresh gap remains visible
instead of being discarded as a new song. Use this chain for the post-cold
stall gate. Keep deliberate quality interventions separate from automatic
ladder oscillation when interpreting the level counts.

## Governor record — 2026-11-10

Phase 0 of the frame-cost plan (`docs/superpowers/plans/2026-11-10-frame-cost.md`)
adds the governor's record to the probe (`performance`, `levelTimeline` above)
and to `npm run test:gpu -- --live-seconds N` (`tools/landscape-review.mjs`).
There, `live-report.json` gains `performance`, read once after the delivery
window, and `levelTimeline`, sampled on the same callbacks as `delivery` with
`fromMs`/`toMs` relative to the window start. Both are written before any
acceptance check runs, so a failed software-WebGL run still records them. A
build without `performanceReport` records `performance: null` and a
`performanceError` string; one without `perfLevel` records `level: null`
runs. Neither field feeds the pass/fail gates or the acceptance table above.
Use `performance.governor.events` for why a level changed, and `levelTimeline`
for when and for how long it held.
