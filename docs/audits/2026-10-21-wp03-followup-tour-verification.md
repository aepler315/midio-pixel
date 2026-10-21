# WP03 follow-up: tour route stalls, mirror backdrop release and ending reachability

This follow-up independently verifies the published WP03 checkpoint and investigates its two remaining problems: the persisted-Tetons screenshot failure in the staged four-route gate, and the remaining ending misses. It makes one application fix (a WebGL error found during the investigation), adds two diagnostic tools, and documents a composition experiment that was measured and deliberately not shipped.

Branch: `impl/wp03-followup-tour-verification`. Sole parent: WP03 `ac5db24a49c96645f377366dd7e753494c1f04ab` (itself on WP01 `1f36735e2ff84fbdd8150dd7c05f733a3d00e18e`; WP02 is not included). The remote WP03 branch was verified at that SHA before work began, and its local worktree was clean. The WP03 branch is unchanged. The tour planner (`TourTimeline.js`, `TourMotion.js`, `TourPlanner.js`) is byte-identical to WP03, so WP03's replay and holdout results still describe this branch's planner.

## Outcomes

| Item | Result |
| --- | --- |
| Persisted-Tetons screenshot timeout | Diagnosed: a software-rasterizer limit triggered by the tour's heavy terrain-window frames. Not specific to the persisted route, not a compositor hang, and not a harness defect. The SwiftShader gate remains intermittently failing (final run: 3/4, persisted screenshot timeout); no timeout, assertion or fixture was changed. |
| Same routes on the local RTX 3060 | All four rows pass the gate's own sample, validation and 30 s screenshot deadline (45–120 ms). Sustained tour playback: 32/32 screenshots under 0.5 s. |
| New defect: released mirror backdrop still bound | Fixed in `RangeScene.js` with a RED-to-GREEN regression test. It caused two fatal WebGL diagnostics on both tour routes during sustained hardware playback. |
| 48 kHz ending misses | Quantified with a new reachability tool. The pre-chorus and outro are large gaps under the current protected framing; no change shipped. |
| Saturated-chase composition | Measured: 8/9 at 48 kHz (final chorus frames intended Middle Teton; outro covered) and 11/11 at 44.1 kHz, but not monotone across the holdout (7 covered heroes lost, 2 intended subjects demoted). Reverted; decision documented below. |
| WP03 reporting inconsistency | Documented: at 44.1 kHz the 23.45 s verse is reported `missed` while WP01's accepted alternative remains fully in frame. Not changed here. |

## 1. Persisted-Tetons screenshot timeout

### Prior evidence

The failure predates WP03 and is not specific to the persisted route. The retained WP01 route logs show the same gate run three times on the WP01 source: one run passed all four rows, one failed **both** tour rows with the same 30 s `page.screenshot` timeout, and one timed out both tour rows at 180 s. WP03's standard run then failed only the persisted row. In both tour rows of that WP03 run, the first sample shows simulation time 118.67 ms on presented frame 5, while audio had already reached 50.8 s (persisted) and 58.9 s (selected). The default Landscape row showed about a 3 s gap at the same point.

### Method

[route-stall-probe.mjs](../../tools/route-stall-probe.mjs) repeats one ordinary route against a frozen staged tree, using the gate's own `playbackSample` (now exported from [current-routes-smoke.mjs](../../tools/current-routes-smoke.mjs)) and `validateRoutePlayback`. It records:

- rAF delivery from an independent callback;
- long animation frames with script attribution;
- `page.evaluate` round trips that do not wait for rAF;
- per-thread Chromium CPU from `/proc` (Linux only);
- optionally, a WebGL call wrapper (per-frame draws, submitted indices, upload bytes, program compiles, and stacks of calls taking at least 100 ms);
- an always-on trap that attributes any texture allocation or canvas upload whose size is not positive;
- a Chromium trace;
- screenshot latency under a configurable deadline.

It never decides acceptance. Its long default screenshot deadline exists only to distinguish "slow" from "hung". Each run used the unchanged standard 120 s fixture (SHA-256 `0bbee2957cc72a3e4214a84c3bb67dac20871f9796be0e43014fc2da7224be85`), the WP03 staged artifact (digest `574bd21532f767c7f46059a43b310372d7d1c1e191f55185b387e60be213a67a`), Chromium 153.0.8010.12, and the gate's launch flags. The traced baseline run, the hardware runs and the Windows control ran with no other workload. Single-threaded CPU analyses overlapped the GL-wrapped and second traced runs, which were used for attribution rather than timing.

### SwiftShader attribution (WSL, gate flags)

| Measurement | Landscape | Persisted Tetons |
| --- | --- | --- |
| GPU-process main thread busy | 26.8 s of 32.5 s | 109.8 s of 113.6 s |
| Longest GPU-process tasks | 1.2–2.5 s | `SkiaOutputSurfaceImplOnGpu::SwapBuffers` 38.9 s, 24.6 s, 24.2 s |
| Renderer main thread | waits in readbacks, 2.4–3.7 s | sample readback blocked 38.9 s; app `frame()` blocked 24.1 s in `CommandBufferProxyImpl::WaitForToken` |
| Screenshots (diagnostic deadline) | 5.2 s, 3.8 s | 1.5 s, **50.1 s** |

Long-animation-frame entries for the long tour frames show tiny script time before the render phase. Each one follows a `TerrainWindowWorkerClient` worker message. The renderer is waiting on the GPU process, which executes queued WebGL work on its own schedule. A screenshot needs a composited frame, so it waits behind whatever is queued. When the queue holds more than 30 s of work, `page.screenshot` times out.

During heavy frames, total Chromium CPU drops to about 6.3 cores. The GPU-process main thread runs at about 0.93 of a core, and SwiftShader's worker threads at about 0.2 each. During normal frames the total is about 14.2 cores. The long work is therefore largely serial.

A third, otherwise identical SwiftShader run (`gpu.angle` trace category, which this build does not populate) showed the same 22.7–25.0 s GPU tasks about every 25 s, yet both of its screenshots completed in 2.4 s and 2.7 s. Whether the gate passes depends on where the screenshot lands in this cycle, which explains the intermittency.

### What the heavy frames submit

With the WebGL wrapper on (persisted route, SwiftShader):

| Frame kind | Draws | Submitted indices | Programs used | Compiles / links |
| --- | ---: | ---: | ---: | ---: |
| Coarse fallback window (no forest) | 39 | 11–15 M | 31 | 0 / 0 |
| Detailed window (with forest) | 135–273 | 155–290 M | 53–75 | 12 / 6 at each adoption |

Detailed-window frames with **no** program links still precede gaps of about 24 s. The dominant SwiftShader cost is therefore the detailed window's instanced forest submission, not shader compilation. Under SwiftShader each such frame forces a `FixedStepClock` resync more than 250 ms later, which jumps simulation time by tens of seconds. Prefetched 8 s windows are then always stale. A coarse window is built synchronously, the detailed window arrives from the worker, and the cycle repeats. Three.js `renderer.info.programs` alternates 12 → 6 → 12: the six forest `ShaderMaterial`s per window are released whenever the coarse fallback (which has no forest) displaces the last detailed window, then recompiled at the next adoption. The `bufferData(ELEMENT_ARRAY_BUFFER)` calls that blocked for 23.4 s and 48.6 s are index uploads for a newly adopted window, waiting for the GPU queue to drain.

### Discriminating runs on the local RTX 3060

The same probe ran under native Windows Node (`v25.9.0`, with a loader that resolves the WSL-installed Playwright package, as [gpu-review.mjs](../../tools/gpu-review.mjs) does) and Windows Chromium 1243 (the same 153.0.8010.12 build). It used `--enable-gpu --ignore-gpu-blocklist` instead of the SwiftShader flags, against the same WP03 artifact (digest verified unchanged) and fixture, with the gate's 30 s screenshot deadline.

| Run (RTX 3060, D3D11 ANGLE) | Routes | Playback validation | Screenshots | Browser diagnostics |
| --- | --- | --- | --- | --- |
| Gate-equivalent, WP03 artifact | landscape, tour-selected, tour-persisted, trio | all passed | 1 per row: 83, 120, **117**, 45 ms | 0 errors, 0 warnings |
| Sustained, WP03 artifact | tour-selected, tour-persisted | both passed | 32/32, 89–357 ms over about 83 s of audio | **2 fatal per row** (section 2) |
| Sustained, this branch | tour-selected, tour-persisted | both passed | 32/32, 119–445 ms over about 84 s of audio | 0 errors, 0 warnings, 0 invalid uploads |
| Gate-equivalent, this branch | landscape, tour-selected, tour-persisted, trio | all passed | 1 per row: 79, 118, 118, 39 ms | 0 errors, 0 warnings, 0 invalid uploads |

On hardware, simulation time tracks audio from the first sample. For example, in the persisted row audio 1,230 ms coincides with simulation 1,135 ms on frame 49. No ping after ready saw `playbackPreparing`. Three.js held 12 programs throughout, so no window fell back to coarse and no forest programs were recompiled.

The hardware runs changed the operating system, Node version and ANGLE backend as well as the GPU. A control isolated the GPU. It used the same Windows Node and Windows Chromium 1243 with the gate's SwiftShader flags, on the persisted route with a 180 s diagnostic screenshot deadline, and the renderer reported SwiftShader as expected. It ran against this branch's staged artifact, which differs from WP03's only by the backdrop fix. The stall reproduced on Windows:

- The first sample came 41 s late (audio 40.4 s, simulation 0 on frame 4).
- Screenshots took **53.6 s and 67.1 s**, both beyond the gate's 30 s.
- rAF gaps of 23–44 s each followed a `TerrainWindowWorkerClient` message, with `frame()` blocked for 22.6–25.8 s.

Software versus hardware rendering is therefore the deciding variable, not WSL versus Windows, the Node version or the host.

### Conclusion

The persisted-Tetons screenshot timeout is an **environment limitation of software rendering**, triggered by the tour's heavy detailed-window frames:

- It is not a persisted-route defect: both tour rows are affected, as WP01 already showed.
- It is not a compositor hang: queued work drains, and screenshots of 50–74 s eventually succeed.
- It is not a harness defect: on the GPU, the gate's own observations and 30 s deadline pass with a wide margin.

Under SwiftShader, individual tour frames cost 20–50 s of GPU-process time, so any 30 s screenshot deadline fails intermittently, depending on where the screenshot lands.

No timeout, assertion, fixture or launch flag of `current-routes-smoke.mjs` was changed, and the probe's long deadline is not used for acceptance. The standard SwiftShader gate is expected to keep failing intermittently on tour rows in this environment. Making it reliable needs either a hardware-GPU gate configuration, or a cheaper tour workload under software rendering (WP08). Both are decisions beyond this follow-up.

### Related observations, not changed here

- **Cold synchronous compile (C35).** On the RTX 3060, the first tour preparation in a fresh browser contains a 3.49 s blocking `setTimeout` task. The second tour row, with a warm shader cache, takes 0.33 s. Under SwiftShader the same preparation task spends 9.6 s in `GetShaderiv` and 0.6 s in `GetProgramiv`. This is before ready, and belongs to WP08/C35.
- **Forest program churn.** Six forest programs are recompiled on every coarse-to-detailed adoption once the coarse fallback has released the last forest materials. No churn was seen on hardware (12 programs throughout), where windows are prefetched in time. It is still a synchronous compile hitch whenever a coarse fallback occurs after a seek, a slow worker, or a slow device. It belongs to WP08/C35.
- **Instanced forest volume.** Detailed windows submit 155–290 M indices per frame across the scene, mirror and depth passes, about 15 times the coarse window. Hardware cost on integrated or mobile GPUs is unmeasured.
- **Mid-playback re-preparation.** `adoptFullAnalysisLive` (`src/main.js:3674`) can rebuild the timeline during playback when whole-song analysis lands late. It was not observed in the traced SwiftShader runs: no ping after ready saw `playbackPreparing`, and no trace shows a second compile burst. The hardware runs were not traced, and their pings checked only `playbackPreparing`, so a re-preparation that does not set that flag is not excluded there.

## 2. Mirror backdrop released while still bound (fixed)

During sustained hardware playback (16 screenshots, 5 s apart, about 83 s of audio), both tour routes recorded two fatal diagnostics about 17.3 s after upload:

- `WebGL: INVALID_VALUE: texSubImage2D: no canvas`
- `GL_INVALID_VALUE: glTexStorage2D: One or more image dimensions are not positive.`

The probe's trap attributed both to one Three.js sampler-uniform upload (`setTexture2D` ← `renderBufferDirect`): `texStorage2D(TEXTURE_2D, 1, RGBA8, 0, 0)` followed by `texSubImage2D` from a **0×0 `OffscreenCanvas`**, at a moment when `scene.backdrop` was already null.

The cause is in [RangeScene.js](../../src/world/alpine/RangeScene.js). The lake mirror copies the stage into a `CanvasTexture` backdrop. Every release path (mirror no longer wanted, resize, residency eviction, context loss) disposes that texture and empties its canvas. `_prepareMirror`, however, rebinds `uBackdrop` only while it draws a mirror. Its early-return branch sets `uBackdropAmount` to 0 and leaves the sampler pointing at the disposed texture. Three.js then reallocates that texture from the 0×0 canvas. On that early-return path the amount is 0, so nothing visible changes, but it is a real WebGL error and the route gate counts it as fatal. A residency eviction after `_prepareMirror` has bound the backdrop within a frame would leave the amount at 1, and the old code would then sample the emptied texture for that frame. The trap did not record `uBackdropAmount`, so it does not tell the two paths apart. The fix covers both, and on the second path the water falls back to its sky reflection. The change is intended to be nonvisual, so no matched render comparison was run.

The fix: the backdrop's owner now unbinds exactly that texture from every prepared view's uniforms on every release path, before disposing it (`_unbindBackdrop`). A live backdrop bound to another view is left alone.

[rangeBackdropRelease.test.mjs](../../test/rangeBackdropRelease.test.mjs) covers release without a ledger, release with the residency ledger, eviction by another owner's reservation, and the unrelated-view case. All four failed on WP03 and pass with the fix. With the WP03 artifact, the two errors appeared in all 3 sustained hardware route runs, each time about 17 s after upload. With this branch's staged artifact (digest `99e7db4296f6afefbfb834d3d1fef56e3823e331cf6829652565134941cd10be`), they appeared in 0 of 2 sustained runs, and in none of the four gate-equivalent hardware rows. Those runs recorded no browser errors or warnings and no invalid texture uploads.

## 3. Ending coverage

### How far each miss is from any legal shot

[tour-reachability-check.mjs](../../tools/tour-reachability-check.mjs) replays an initial captured worker request. For each hero whose intended subject is not covered, and for every same-role candidate, it computes `s*`: the smallest uniform multiple of the published yaw capacity for which **any** heading sequence on the fixed eye path covers the subject (|NDC| ≤ 0.8 on the samples `measureHeroFraming` needs, allowing its two misses). Other accepted windows and the headings outside the approach stay fixed. `s* ≤ 1` means a legal shot exists under the hard limits. It does not mean the planner finds it, that the subject is unoccluded, or that the shot is musically right.

Pinned 48 kHz request (89,984 ms, nine heroes):

| Hero | Outcome | Intended s* | Legal candidates | If the preceding accepted shot were released |
| --- | --- | ---: | ---: | ---: |
| Chorus 14.444 s (intended Middle Teton) | alternative | 0.93 | 27/37 | 0.93 |
| Pre-chorus 23.177 s | **missed** | 6.61 | **0/12** | 6.61 |
| Bridge 31.731 s | alternative | 2.88 | 34/614 | 0.94 |
| Drop 54.257 s | alternative | 1.04 | 16/26 | 1.04 |
| Final chorus 83.012 s (intended Middle Teton) | alternative | **0.83** | 36/37 | 0.58 |
| Outro 87.885 s | **missed** | 2.61 | **0/66** (best 1.65) | **0.68** |

- **Pre-chorus.** A large gap: about 153° to the coverage edge, with 144° of capacity, and boxed in by the protected verse window that follows.
- **Outro.** Also a large gap given the final chorus's protected framing. Its approach can start only at 84.5 s, leaving 1.9 s and 47° of capacity, against 144° to the coverage edge. None of the 66 outro-role candidates is reachable.
- **The ending trade-off.** If the final chorus's accepted alternative were not protected, the intended outro subject would become reachable (s* 0.68). Covering the outro therefore requires changing an accepted shot, which these constraints do not allow automatically.
- **Middle Teton.** At both choruses it is reachable under the hard limits (s* 0.83–0.93). At the final chorus, WP03's retained diagnostics show it rejected by a per-step yaw check (2.55° against 2.5°), which follows from the smoothstep approach peaking at 1.5× its mean rate. The rejection at 14.44 s was not instrumented.

### Saturated-chase experiment (reverted)

To test that last point, a prototype chased the same eased target at the shared yaw capacity instead of rejecting a candidate whose ease peak exceeded it. Where the ease fits, the output is exactly the eased heading. The song's final frame was allowed to hold, while every other ramp still had to rejoin the fixed timeline. Results:

| Check | Result |
| --- | --- |
| 48 kHz replay | 8/9 framed: the final chorus frames intended Middle Teton (0.92) instead of Wildcat Peak (1.0), and the outro is covered by alternative `peak-749717` (0.85). The pre-chorus stays missed. |
| 44.1 kHz replay | 11/11: the 23.45 s verse is covered by an alternative. |
| Published arrays versus WP03 | Eye, FOV and meta byte-identical. Target differs only at 75.9–90.0 s (48 kHz) and 20.8–26.4 s (44.1 kHz). |
| Safety | First version failed holdout H06 by 0.0028° of yaw excess: `poseAt` slerps directions, so a saturated frame that also changes pitch turns unevenly (up to 1.16× its mean at 10° of pitch change). A slerp-aware saturation then passed 18/18 holdout cases with maximum excess 0.00031°. |
| Monotonicity, all 201 holdout heroes | 157 unchanged; 19 now frame their intended subject where WP03 framed another; 12 newly covered; 4 swapped one alternative for another; **7 previously covered heroes lost**; **2 intended subjects demoted to alternatives** |
| Accepted subjects | Against WP03, the 48 kHz final chorus changes accepted subject. Against WP01, at 44.1 kHz, WP01's accepted `peak-5775431` drops from 1.0 to 0.23 in frame at 23.45 s. |

Greedy chronological composition lets an earlier success consume heading budget that a later, previously covered hero depended on. That violates the accepted-subject constraint, so the prototype was reverted. Its diff is retained outside Git with the rest of the evidence. Shipping the gains safely needs a composition that protects every hero the previous solution covered, or solves endings jointly. Upgrading an accepted alternative to its intended subject is also a product decision, because the accepted subject changes.

### WP03 reporting inconsistency at 44.1 kHz

For the host-default 44.1 kHz request, WP03's replay preservation gate measures WP01's accepted `peak-5775431` fully in frame (1.0) at the 23.45 s verse. The reachability tool confirms it needs 0° of turn. WP03's own `heroFraming`, however, reports that hero as `missed` / `no-legal-projected-shot` against its intended `peak-1253175`. Composition checks only the intended or assigned subject before trying candidates, and none of its centered attempts succeeded. The report therefore understates coverage for that hero. It is documented here and not changed: correcting it alters `accepted`, which constrains later heroes and needs the same monotonicity analysis as above.

## 4. Verification

| Check | Result |
| --- | --- |
| Checkpoint identity | Remote and local `impl/wp03-legal-tour-planning` at `ac5db24`; worktree clean; planner files byte-identical to the WP03 receipt |
| Focused tour suites (5 files) plus the backdrop test, on the final source | 35 passed, 0 failed, 0 skipped |
| Backdrop regression | 4 failed on WP03, 4 passed with the fix |
| Full repository suite (`npm test`, Node v24.10.0, WSL) | 4,866 total: 4,860 passed, 0 failed, 6 GDAL skips, 0 TODOs (WP03's 4,862 plus the four backdrop tests) |
| Lint / whitespace | `npm run lint` clean; `git diff --check` clean |
| Captured-input replays | Planner unchanged from WP03; reachability reports for both captures retained |
| SwiftShader standard four-route gate (run once; unchanged harness and default fixture `0bbee295…`; clean commit `0f0fcdcff2af9b5a8166a4382461a023155861cb`, staged digest `99e7db42…`, unchanged during the run) | **Failed, 3/4.** Landscape, tour-selected and Trio passed. Persisted Tetons reached ready playback (audio 67.3 s with simulation 0.18 s on frame 5, then audio 69.2 s and simulation 68.4 s on frame 9), then exceeded the 30 s screenshot deadline. All rows recorded 0 browser errors and 0 warnings. This matches the diagnosis in section 1 and was not rerun to obtain a pass. The commit that adds this row changes only this document. |

## 5. Limitations

- **Remaining failed gates.** The standard SwiftShader four-route gate still fails on persisted Tetons (section 1). The 48 kHz pre-chorus and outro remain projection misses, and the final chorus still frames an alternative rather than its intended subject.
- The hardware and Windows-control runs used native Windows Node v25.9.0, outside the repository's pinned 24.x. All test, lint, replay and gate runs used the pinned Node v24.10.0 in WSL.
- Hardware evidence comes from one machine (RTX 3060, D3D11 ANGLE, Windows). It is integration evidence, not a performance benchmark, and it says nothing about integrated or mobile GPUs. The hardware runs observed a few seconds (gate-equivalent) and about 83 s (sustained) of tour playback, not whole songs.
- SwiftShader captures and CPU projection checks do not establish smooth playback, audio/visual synchronization, terrain visibility, subject footprint or artistic quality. No audio was auditioned.
- The reachability tool considers only headings on the fixed eye path and fixed FOV. Route, eye or FOV changes, and joint multi-hero solutions, are outside it.

## Reproduction

```sh
node tools/route-stall-probe.mjs --site-root _site --out .smoke/stall-probe --audio fixture.wav --routes landscape,tour-persisted --trace on
node tools/route-stall-probe.mjs --site-root _site --out .smoke/stall-probe-gl --audio fixture.wav --routes tour-persisted --trace off --wrap-gl on
node tools/route-stall-probe.mjs --hardware-gpu --browser /path/to/chrome --site-root _site --out .smoke/stall-probe-hw --audio fixture.wav --routes landscape,tour-selected,tour-persisted,trio --trace off --screenshots 1 --screenshot-timeout-ms 30000 --timeout-ms 180000
node tools/tour-reachability-check.mjs --request /path/to/input-0.json --out .smoke/reachability/report.json
node --test test/rangeBackdropRelease.test.mjs
```

Captured traces, PNGs, probe JSON, logs, the reverted prototype diff and the failed and passing holdout reports stay outside Git under ignored `.smoke/` directories and the task evidence archive. Successful and failed runs are both retained. Publication is a branch candidate, separate from merge and deployment.
