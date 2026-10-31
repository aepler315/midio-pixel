# Midio Pixel technical audit and implementation roadmap

> Historical record. The scope, preservation rules, approval/hold decisions and validation steps below describe this past task, not current development prerequisites. Experiments and local commits follow the [current development policy](../experimental-development.md). Recorded results and runtime eligibility remain evidence of the version reviewed.

> **Publication note — October 20, 2026.** This is the completed read-only audit of commit `8f7c10fecdb9c436f7e789ec094c79efe88eff31`, published as documentation after the investigation. The audit was not rerun or updated to make new application findings. Statements below about no GitHub branches being changed describe the original investigation; this publication adds only audit documentation on a new branch. All 22 findings, source references, technical analysis, qualifications, recommendations and roadmap phases are preserved. The sole change within the original report body replaces the local PNG embed with its original artifact path and checksum. The publication appendix supplies retained textual evidence, reproduction details and artifact hashes. Captured images/audio/HTML/capture JSON/archive bytes remain in the original local evidence bundle rather than Git history, as required by `AGENTS.md`. Evidence filenames below refer to that bundle unless explicitly linked to a repository file.
>
> **Sortable implementation roadmap:** [2026-10-20-midio-pixel-prioritized-roadmap.csv](2026-10-20-midio-pixel-prioritized-roadmap.csv).

Audit date: October 20, 2026, America/Los_Angeles. Repository: `aepler315/midio-pixel`. Audited GitHub `main`: **`8f7c10fecdb9c436f7e789ec094c79efe88eff31`**. This is a read-only application audit. No application source, existing checkout, GitHub branch, issue, pull request, repository setting, or deployment was changed.

The immediate priorities are playback availability, preservation of library metadata, truthful recording results, and removing synchronous preparation from rendering/loading turns. The renderer already has useful foundations: real terrain, instanced forests, deterministic heard-time motion, explicit graphics ownership, bounded native pixel grids, and carefully separated presentation diagnostics. Substantial graphical progress is possible without replacing those foundations. A wholesale WebGPU rewrite would be premature before measuring the existing GPU work and consolidating the compositor.

**The strongest observed failure is a selected or persisted Tetons tour startup failure that the passing unit suite does not catch.** The maintained local RTX review passed fixed-clock captures for both grids, but its independent real-upload/live-playback phase failed before audio could start. A fresh Linux browser and a pure Node replay reproduced the same planner error. The planner's future-turn feasibility check uses 25 degrees/second while the active outro limits motion to 12 degrees/second. This is actionable independently of rendering speed. Clean default Landscape does not automatically select the tour, and is not asserted to fail this way.

## Scope and evidence rules

All 1,518 tracked file blobs were reconstructed into an isolated audit snapshot and checked against GitHub's recursive tree using Git blob SHA-1; there were zero mismatches. Source links below are pinned to the audited commit. The snapshot has no original `.git` directory: history was read separately from GitHub and an older local object store, with the latter never treated as current `main`. The last 25 GitHub commits were reviewed, including recent tour, terrain-window, pixel-grid, cloud and validation-policy changes. This audit is a snapshot, not an assertion about later commits.

Evidence classes used throughout:

- **M — Measured or reproduced:** an actual browser result, deterministic production-code reproduction, counted execution, or a stated host microbenchmark. Boundary fakes and synthetic inputs are identified.
- **C — Code-supported:** a reachable implementation/control-flow property. Its real-world frequency or performance magnitude may be unmeasured.
- **H — Hypothesis or opportunity:** a proposed improvement whose visual value or hardware payoff requires evaluation. It is not an existing measured defect.

Confidence refers to the stated finding, not to an assumed speedup. Estimates are engineering judgments for someone familiar with the code: **S** about half to two days; **M** about three to seven days; **L** about two to four weeks; **XL** a multi-stage effort of roughly one to three months. They exclude broad browser/device acceptance and are not delivery promises.

## Current architecture and important execution paths

| Path | Current implementation and implication |
| --- | --- |
| Upload and analysis | `main.js` owns selection tickets, abort controllers, decode, opening/whole analysis, fingerprint/cache lookup, late adoption, lyrics, and session creation. Mix fingerprint, pitch, structure and tour planning have worker support. Native decoder boundaries remain uninterruptible but stale adoption is guarded. |
| Session and time | `startTimeline` loads the shared conductor, creates the simulation/governor/presenting renderer, resets or reuses RangePresentation, and `RenderReadyPlayback` coordinates graphics readiness with audio. Simulation follows the AudioContext clock with display lead. `FixedStepClock` bounds long-gap catch-up. |
| Default Landscape | `main.js` → `PresentingRenderer` → native Canvas painter stack → `BiomeManager` → `RangePresentation` → `RangeScene`. Range v2 is the default; the optional `?renderer=webgl` class is a separate post-effect wrapper, not the terrain backend. |
| Terrain and forest | RangeScene uses a WebGL2/Three runtime, real terrain packages, far/mid/near scene partitions, instanced forest batches, material/lighting shaders, water mirrors and narrative actors. Each partition is copied into the Canvas composition order. Travel can have two sides and seam ownership. |
| Presentation | Classic is 320×180; Detailed is 640×360. `PixelPresentation.setPresentation` forces pixelated presentation at this SHA. Smooth sky is drawn at destination resolution behind nearest-neighbor terrain. Natural/MSAA branches are dormant in the current product path. |
| Quality and memory | `PerfGovernor`, Range quality policies, pixel-aware forest detail and terrain windows reduce work. `GraphicsResidency` reserves before allocation, tracks pending/live ownership, supports leases and generation checks. Its byte ledger is an estimate of owned resources, not actual browser RSS or GPU memory. |
| Trio | Trio has separate update/draw early exits but is selected after shared simulation construction, so some Landscape initialization and subscriptions are retained unnecessarily. |
| Export | Live `SongRecorder` uses capture streams/MediaRecorder; offline bulk export has separate fixed-clock and readiness requirements. Those paths share presentation infrastructure but must be validated separately. |

Relevant pinned entry points: [main.js:465–470](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/main.js#L465-L470), [PresentingRenderer.js:45–80](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/render/PresentingRenderer.js#L45-L80), [PixelPresentation.js:58–79](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/render/PixelPresentation.js#L58-L79), [FixedStepClock.js:19–35](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/core/FixedStepClock.js#L19-L35).

## Diagnostic results and their limits

| Diagnostic | Observed result | What it establishes |
| --- | --- | --- |
| Source identity | 1,518 blobs verified; zero mismatches | Findings refer to the fetched GitHub snapshot. |
| Root tests, Node 24.10.0 | 4,801 tests: **4,793 passed, 8 skipped, 0 failed**; 322.39 s | Existing root test contract passed. This does not cover every production integration path. |
| ESLint | Exit 0 | Current configured source/tool/test lint passed. |
| Static-site staging | Exit 0, including runtime/asset checks | The staging tool accepted this source and its installed renderer dependencies. |
| Source bootstrap smoke | Exit 0 | App booted and Browse opened a chooser in headless Chromium. No song playback is implied. |
| RTX 3060 fixed-clock tour | Both Classic and Detailed: seven saved frames each, 12–13 s, lifecycle and removed-overlay checks passed | Actual headless NVIDIA/D3D11 rendering worked for the controlled capture route. |
| RTX 3060 live tour | **Failed before playback**, `Tour timeline has no feasible aim state` | No delivered p95/FPS or sustained tour performance result was obtained. |
| Independent fresh browser | Same tour error in Linux Chromium/SwiftShader | Failure is not specific to the NVIDIA driver. Captured exact tour worker inputs. |
| Node tour replay | Same throw; narrowly transformed diagnostic alternatives succeed | Supports the yaw-feasibility root cause in F01. Transformations ran outside application source and are not proposed production patches. |
| RTX static Jackson Lake capture | Detailed grid, seven consecutive frames at 45–46 s; technical checks passed | Additional actual mountain/forest/water visual evidence. |
| RTX static live repeat | 30 s; delivered p95 33.4 ms, 50.20 fps, three gaps >100 ms; no failed/hidden frames | Short current-view pacing misses existing targets; actual limiting phase remains unresolved. |
| Software fixed-clock review | Classic and Detailed each saved seven frames and passed technical checks | Portable rendering/lifecycle evidence, with no hardware or live pacing claim. |
| Focused reproductions | Library history loss; cache wait/cancel; recorder chunk omission/pause; failed-context cleanup; stem blocking; cloud cost; render-call counts | Production functions were executed with stated browser/encoder/IDB boundary fakes. These are not physical-device or real-codec acceptance. |

The bundled evidence index records software and static-live diagnostics separately. A partial, failed or cancelled run is retained with that status. No GPU completion timing, optical scanout timing, foreground scheduling guarantee, thermal endurance result, or physical phone/WebView acceptance is inferred from headless tests. CPU benchmarks ran on this host with concurrent audit activity; they are evidence of blocking work, not controlled cross-device benchmarks.

## Prioritized finding register

| ID | Priority | Finding | Basis | Confidence | Cost | Key dependencies |
| --- | --- | --- | --- | --- | --- | --- |
| F01 | P1 | Tour readiness can fail on valid analyzed music | M+C | High | M | Default-route and selected-tour fixtures |
| F02 | P1 | Incomplete library scans prune durable history | M+C | High | S–M | Scan completeness model |
| F03 | P1 | Optional cache lookup blocks ready analysis/cancellation | M+C | High | M | Load ownership and deadline policy |
| F04 | P1 | Cloud sprites are generated synchronously during drawing | M+C | High; device severity medium | M | Bounded async preparation |
| F05 | P1 | Recorder drops final bytes and reports success | M+C | High; codec damage conditional | M | Explicit partial/error result |
| F06 | P2 | Playback pause leaves recorder running | M+C | High | S–M | Combined user/terrain pause ownership |
| F07 | P2 | Stem cache identity blocks the main thread | M+C | High | M | Async fingerprint descriptors |
| F08 | P2 | Failed audio boot abandons unclosed contexts | M+C | High; native impact medium | S | Disposable audio owner |
| F09 | P2 | Exact sRGB decode is paired with approximate output gamma | M+C | High; appearance medium | S–M | Shared color-domain contract |
| F10 | P2 | Visible actors trigger repeated opaque depth work | M+C | High; GPU gain unmeasured | M–L | GPU/pass instrumentation |
| F11 | P2 | New density clouds lack local receiver transmission | C+H | High disconnection; medium visual value | L | F04, F09, lighting ablation |
| F12 | P2 | Sky/reflection/frame setup have separate unbudgeted work | C+H | High routing; medium payoff | M | F21 phase timings |
| F13 | P2–P3 | Large merged batches prevent useful spatial culling | C+H | High representation; medium payoff | L | F21, camera/mirror bounds |
| F14 | P3 | Water pixels execute land material work later overwritten | C+H | High source; GPU gain unmeasured | S–M | Shader timing/derivative checks |
| F15 | P1 | Core smoke bypasses the current default playback route | C, corroborated by F01 | High | M | Exact staged artifact |
| F16 | P2 | Cache maintenance clones full bundles and lacks byte policy | C | High; impact size unmeasured | M | Real IndexedDB tests |
| F17 | P2 | Session lifecycle is spread across large shared orchestrators | C+H | High coupling; benefit inferred | L | F15, transition tests |
| F18 | P2 | Trio constructs unused Landscape state/prepass | C | High; savings unmeasured | M | F17 or narrow lazy prepass |
| F19 | P3 | Optional worlds remain eager default-route dependencies | C+H | High; startup payoff uncertain | M | Descriptor/factory split |
| F20 | P2 | Documented automation contract contradicts manual policy | C+history | High | S | Local preflight manifest |
| F21 | P2 | Short RTX pacing misses targets; pass-level attribution is absent | M+C+H | High observation; root cause open | M | Repair F01 for tour traces |
| F22 | Strategic | Shared GPU composition and selective compute backend | C+H | High constraint; payoff unproven | XL | F09–F13, F17, F21 |

Priorities combine affected behavior, expected impact, confidence, cost and dependencies. P1 is an early repair recommendation, not a CVSS rating. Opportunities with unknown hardware payoff do not outrank reproduced availability/data defects merely because they are ambitious.

## Detailed findings

### F01 Tour startup fails when future-turn feasibility uses an optimistic yaw rate

**Behavior and evidence — M+C, high confidence.** The maintained GPU review's generated 90-second contrast recording fails `renderReady` before audio advances; a separate fresh browser and Node replay reproduce it. At 46,500 ms of the planned timeline, 80 aim candidates are rejected. The next subhero is at 53,174.1657 ms; the current beam is near heading 100° and its target is 235°. See [TourTimeline.js:119–148](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/terrain/TourTimeline.js#L119-L148), [TourRuntime.js:5–19](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/terrain/TourRuntime.js#L5-L19), and `evidence/landscape-rtx/live-report.json`.

**Cause.** Actual outro/breakdown transitions use at most 12°/s, but the next-station reachability filter uses global yaw 25°/s. It retains paths that cannot prepare the turn early enough. Once the lookahead eliminates every candidate outside the lock interval, the existing lock-only downgrade cannot run and the planner throws. Planning covers the entire song before readiness, so a future conflict blocks startup now.

**Solution and alternatives.** Use a consistent, role-aware future yaw envelope across the available timeline, and downgrade an unreachable upcoming hero safely when search exhausts. A diagnostic substitution using the active role rate made the captured payload succeed; extending the existing downgrade to the next hero also succeeded, at the cost of passing that visit at range. These differential probes establish cause; neither is a reviewed complete fix for mixed future roles.

**Benefit, cost and risk.** Restores playback for affected analysis outputs; M complexity. Preserve altitude/turn limits, committed-prefix continuity, final hero framing and reduced-motion behavior. Do not simply remove constraints or start audio over an unprepared tour.

**Validation.** Retain the exact captured payload as a regression input, test role changes and close subheroes, and run the unmodified production upload with selected or persisted Tetons tour against the staged artifact. Require readiness, advancing heard time, finite/rate-limited poses, deterministic seek/replan and a sustained delivery trace. Frequency across real music remains unknown.

### F02 Library access failures can delete saved play history and tags

**Behavior and evidence — M+C, high confidence.** A directory `values()` failure is swallowed at [LibraryScanner.js:55–62](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/library/LibraryScanner.js#L55-L62); any `getFile()` rejection is skipped at [168–172](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/library/LibraryScanner.js#L168-L172). [MusicLibrary.js:230–277](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/library/MusicLibrary.js#L230-L277) treats the resulting empty/partial scan as complete and prunes omitted rows. Both injected synchronous directory and asynchronous file `NotAllowedError` cases removed a previously stored `song.mp3` row with play count 1 and duration 90 seconds, without reporting rescan failure. Browser filesystem error frequency is unmeasured.

**Cause.** Missing files, access loss and incomplete traversal are collapsed into the same absence signal. Cancellation and thrown asynchronous iterator failures have protection; the swallowed paths bypass it.

**Solution and alternatives.** Return scan completeness/errors and prune only confirmed successfully traversed regions. Alternatively abort the rescan on access failure and preserve all prior rows. A failed-prefix model supports partial progress without destroying inaccessible-subtree metadata.

**Benefit, cost and risk.** Protects user metadata; S–M. Failed scans may retain stale entries until a successful retry, which is preferable to treating permission loss as deletion. Keep genuine deletion behavior explicit.

**Validation.** Assert persistence after root/child iterator failures, asynchronous getFile errors, revocation, cancellation and later retry; separately prove actual deletion prunes. Add real-browser permission and IndexedDB coverage beyond the existing fakes.

### F03 Optional cache lookup can indefinitely withhold healthy analysis

**Behavior and evidence — M+C, high confidence.** [main.js:2656–2685](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/main.js#L2656-L2685) waits for lookup before using analysis already running; full-song adoption repeats this at [2695–2707](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/main.js#L2695-L2707). [AnalysisCache.js:41–70](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/audio/AnalysisCache.js#L41-L70) and [107–118](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/audio/AnalysisCache.js#L107-L118) do not bound or abort IDB waits. With immediate analysis and a never-resolving cache request, no result was offered and cancellation did not settle the load promise.

**Cause.** Cache exceptions become misses, but a pending optional operation becomes a mandatory availability dependency. The mix fingerprint's 120-second deadline is also a long gate. Opening-first playback mitigates ordinary long-song startup, but not every short/stem/export path or final adoption. A blocked-open request that later succeeds also leaves its late connection unclosed in the reproduction.

**Solution and alternatives.** Admit the first valid final result from analysis or cache under current load ownership, bound cache work with a deadline/abort wrapper, and close late IDB opens. Alternatively use a short cache budget and let fingerprint/cache population finish in the background. Handle losing-task errors and cancellation explicitly.

**Benefit, cost and risk.** Optional storage cannot hold playback/export indefinitely; M. Some late cache hits will cease saving compute. Avoid duplicate adoption or cancelling the winning result's resources.

**Validation.** Immediate analysis/never-cache, cache-first success, late errors, abort during open/get, blocked-then-success close, and long-song adoption. A real browser disk stall was not measured; the reproduced control-flow defect is conditional on delayed cache work.

### F04 Cold cloud textures are built synchronously inside rendering

**Behavior and evidence — M+C, high confidence in work, medium in device severity.** [RangeSkyRenderer.js:95–113](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangeSkyRenderer.js#L95-L113) calls a 192×128 volumetric texture builder from live sky painting. [RangeCloudTexture.js:63–103](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangeCloudTexture.js#L63-L103) performs twelve samples per texel with density/noise work. Seed replacement and LRU eviction make cold work reachable after initial startup.

Saved Node 24 CPU measurements for eight unique shapes were **23.90–40.30 ms each, median 28.16 ms**. A mocked-Canvas execution of the real cache miss took 27.89 ms; 10,000 cache hits totaled 1.70 ms. These exclude real Canvas transfer and GPU cost, include JIT warm-up/concurrent host effects, and must not be multiplied by visible-bank count into a predicted frame time. They nevertheless show one synchronous build can exceed a 16.67 ms frame budget.

**Solution and alternatives.** Prepare visible/near-future bank identities off the drawing turn using a cancellable bounded worker queue, publishing transferred RGBA/ImageBitmap atomically. Readiness-time prewarming or cooperative row-sliced preparation is a lower-risk alternative. Prebaked assets trade variety for simpler preparation.

**Benefit, cost and risk.** Fewer cold-view/seek/weather long tasks without losing detailed seeded clouds; M. Add reservation/cancellation ownership, cap pending memory, retain deterministic shapes and define a temporary missing-sprite policy. A warm-cache optimization alone does not address first use.

**Validation.** Measure long tasks and delivered frames on cold upload, seek, storm onset and travel; both grids, repeated seeds, eviction, cancellation and export. Compare identical frames/audio and resident bytes. No actual cloud-caused browser stall or GPU speedup is asserted from this microbenchmark.

### F05 Recorder limit and encoder errors can produce a success-shaped incomplete file

**Behavior and evidence — M+C, high confidence in omitted bytes/reporting; container damage conditional.** [SongRecorder.js:175–189](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/render/SongRecorder.js#L175-L189) rejects the entire chunk crossing 512 MiB, then can reject the final stop flush too. [_finish:333–350](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/render/SongRecorder.js#L333-L350) returns a Blob without error/partial status. [main.js:4735–4755](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/main.js#L4735-L4755) downloads it and reports Saved. Encoder error uses the same owner callback.

The bounded reproduction retained a placeholder `HEAD` chunk, injected a near-cap counter and crossing chunk, then flushed `MOOV` on stop. It returned a normal result containing only `HEAD`; both later chunks were omitted and no result error was supplied. These are placeholder bytes, not proof of a corrupt real MP4.

**Cause and solution.** A hard retained-byte cap and asynchronous encoder finalization have no negotiated headroom or explicit failure result. Stop before a soft threshold with reserved finalization allowance and propagate stoppedEarly/error/partial. Alternatively discard the result truthfully at hard failure; streaming to writable storage with backpressure is a larger option.

**Benefit, cost and risk.** Prevent misleading successful exports and preserve necessary final bytes; M. Finalization size varies by browser/container, so do not assume a magic fixed allowance alone guarantees validity. Keep byte and session-finalization protections.

**Validation.** Final-metadata chunks, encoder error after partial data, stop/pause overlap, and near-limit real MP4/WebM playback/ffprobe. Show accurate warning and endpoint. Maximum-duration physical-memory/codec acceptance remains open.

### F06 User playback pause does not pause recording

**Behavior and evidence — M+C, high confidence.** [main.js:1147–1158](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/main.js#L1147-L1158) suspends audio but never calls recorder pause/resume. The frame loop exits while paused at [3348–3350](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/main.js#L3348-L3350); [SongRecorder.js:98–129](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/render/SongRecorder.js#L98-L129) only subtracts its own explicit pauses. Executing the real functions with boundary fakes produced a recorder-reported result duration of 7,000 ms for 1,000 ms play + 5,000 ms pause + 1,000 ms play, with MediaRecorder still recording during the pause.

**Cause and solution.** Audio transport and recording transport have separate pause ownership. Integrate user pause/resume using the existing recorder API while preserving terrain-preparation holds at [main.js:4658–4674](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/main.js#L4658-L4674). A reason-counted hold abstraction avoids resuming one hold while another remains. Real-time wall-clock capture could be intentional only with explicit semantics and accurate reporting.

**Benefit, cost and risk.** Recording duration and song time agree; S–M. Overlapping user/terrain pauses and pause failures need careful handling. Actual encoded silence/held-image behavior was not measured.

**Validation.** User pause during recording/preparation, stop while paused, repeated holds, and a real encoded file whose duration and AV sync follow active playback.

### F07 Stem cache-key construction performs full synchronous fingerprints

**Behavior and evidence — M+C, high confidence.** [main.js:2660](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/main.js#L2660) reaches [AnalysisCache.js:184–192](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/audio/AnalysisCache.js#L184-L192), which calls synchronous `fingerprintBuffer` per stem. [SongFingerprint.js:178–281](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/audio/SongFingerprint.js#L178-L281) resamples/scans/transforms signal data without a yield in this API. Four synthetic 60-second, 8 kHz stereo stem descriptors, reusing one buffer under distinct names to bound memory, held Node's event loop for **649.1 ms**; a pending zero-delay timer could not run before return.

**Cause and solution.** The mix uses a worker/cooperative client, while stem identity bypasses it. Compute cancellable stem descriptors through that asynchronous path and pass completed descriptors to a pure key constructor, bounding concurrency by memory. Encoded-byte digests plus a revision are an alternative with changed identity semantics.

**Benefit, cost and risk.** Cancel/new-selection input remains responsive, especially for larger stems; M. Preserve key parity, avoid detaching live audio buffers, and handle worker startup/transfer cost. The synthetic CPU result is not browser/mobile latency and should not be extrapolated linearly to maximum inputs.

**Validation.** Existing identity fixtures, reordered/renamed/changed stems, cancellation between and within descriptors, bounded workers and main-thread response latency on representative long stems.

### F08 Sequential failed audio initialization abandons contexts without closing them

**Behavior and evidence — M+C, high confidence in cleanup gap; medium native-resource severity.** [main.js:825–837](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/main.js#L825-L837) creates an engine, receives failed resume, clears its handle and throws. [AudioEngine.js:9–26](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/audio/AudioEngine.js#L9-L26) already created/connected the context. Three sequential injected failures created three contexts and closed zero. Existing in-flight deduplication protects concurrent callers, not repeated failed attempts.

**Solution and alternatives.** Retain/retry the same blocked context on a later gesture where supported, or explicitly disconnect and close it before relinquishing ownership. A reusable idempotent AudioEngine disposal API can cover other boot failures too.

**Benefit, cost and risk.** Avoid accumulating abandoned graphs/context resources; S. Close is asynchronous and browser activation behavior differs. Garbage collection may eventually reclaim resources; native exhaustion was not observed and is not claimed.

**Validation.** Rejected resume, silently suspended resume, close rejection, concurrent callers and successful later gestures in target browsers/WebViews; confirm resources plateau across repeated attempts.

### F09 Terrain and forest color transfer does not match the CPU and Canvas domains

**Behavior and evidence — M+C, high numerical confidence; visual severity requires review.** [MaterialPackage.js:130–136](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/MaterialPackage.js#L130-L136) uses exact piecewise sRGB decoding; [TerrainMaterial.js:392](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/TerrainMaterial.js#L392) encodes gamma 2.2, [464](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/TerrainMaterial.js#L464) approximately decodes copied imagery, and [ForestGL.js:259](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/ForestGL.js#L259) independently encodes gamma 2.2. Automatic renderer sRGB output is disabled. Canvas sky uses sRGB colors.

**Cause.** These transfer functions are not inverses. Scalar round trips map channel 5→13.34, 16→23.32, 32→37.16 and 128→127.03 before other lighting. This is most material for dark fog/terrain/sky endpoints. Some mirror round trips are internally approximate but consistent; not every reflection is doubly encoded.

**Solution and alternatives.** Define color domains for palette input, material textures, copied Canvas/reflections, linear shading and final output; use shared piecewise sRGB transfer at boundaries. Alternatively specify one custom display transfer consistently across Canvas and GPU. Express intentional lifted blacks through grading/exposure rather than mismatch.

**Benefit, cost and risk.** Predictable dark ramps, sky/terrain handoffs and palette thresholds; S–M implementation with medium appearance risk. Accuracy does not automatically imply preferred art direction.

**Validation.** Numerical ramp/endpoints plus matched dawn/night/storm/lake captures and export/display comparisons. Review forest handoff and horizon. Do not auto-approve the darker/brighter candidate from unit tests alone.

### F10 Actor occlusion requires repeated whole-scene depth reconstruction

**Behavior and evidence — M+C, high call-count confidence; GPU benefit unmeasured.** [RangeScene.js:1848–1933](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangeScene.js#L1848-L1933) shares opaque depth with later forest hard-depth writes. With actors visible, it invalidates `depth.frame` after crown depth, so the next partition rebuilds opaque terrain. Actual-source execution with mocked rendering across three partitions counted **7 scene-render calls/1 opaque-depth render** with actors hidden versus **15 calls/3 opaque-depth + 3 forest-depth renders** with one visible actor. These are scene invocations, not actual driver draw counts or GPU durations.

**Cause and solution.** The invalidation is a correctness safeguard. Preserve reusable opaque terrain depth separately from combined forest/actor depth, or scope combined depth work to partitions with visible actors. A depth blit or GPU composition reorganization is an alternative. Simply deleting invalidation is incorrect.

**Benefit, cost and risk.** Less repeated vertex/submission work while retaining cast visibility; M–L. Additional depth storage/copy bandwidth may offset savings, especially at native low resolution. Translucent crowns, travel scissor ownership, narrative interleaving and mirrors are sensitive.

**Validation.** Actual asynchronous GPU timers, triangles and draw counts at wooded scenes with actors on/off, both grids and quality 0/6. Continuous captures must prove lanterns/crowns/terrain occlude correctly during motion and travel. Mirrors already cache once per frame/view and are not alleged to render once per partition.

### F11 Couple world cloud density to terrain, forest and water lighting

**Behavior and evidence — C+H.** [BiomeManager.js:3782–3813](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/BiomeManager.js#L3782-L3813) explicitly clears `scene.skyClouds` in the hybrid path because its density clouds cannot be represented by the older ellipse banks. [RangeScene.js:1679–1689](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangeScene.js#L1679-L1689) then sets `uCloudCount=0`. The older receiver transmission in [CloudOcclusion.js:59–75](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/CloudOcclusion.js#L59-L75), consumed by [TerrainMaterial.js:734–752](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/TerrainMaterial.js#L734-L752), consequently remains open for new local cloud cover. Global storm dimming/openings remain implemented; they are not missing.

**Solution and alternatives.** Build a coarse world-space optical-transmission field from the same deterministic cloud-bank positions/density used for sprites. Share it with terrain/forest/moonlit lake shading and reflections. A small atlas, coarse lobe integration, or an authored broad receiver mask are viable alternatives. Restore coherent moon transmission first, then deliberately extend solar shadows. Avoid reinstating visibly incorrect old ellipse geometry.

**Benefit, cost and risk.** Potentially substantial depth/atmosphere: clouds and the landscape respond to one light field, with slow phrase-scale motion rather than extra screen overlays. L complexity. Additional receiver work, mobile uniform limits, overly dark scenes, double storm attenuation and pixel-scale flicker are risks. Confidence is high in the disconnection, medium in artistic priority.

**Validation.** Bank/no-bank ablations at a fixed world receiver, moon versus sun, mirrors, storm overlap, pause/seek/export reconstruction and continuous matched music. Spatially filter shadow motion. A changed transmittance number is not artistic acceptance.

### F12 Attribute smooth-sky, mirror-sky and per-view setup costs independently

**Behavior and evidence — C+H, high routing confidence.** [RangePresentation.js:951–955](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangePresentation.js#L951-L955) can repaint the high-resolution sky into reflection backdrop capture. [RangeSkyRenderer.js:177–256](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangeSkyRenderer.js#L177-L256) traverses a 2,600-star catalog and builds aurora commands; the hybrid descriptor lacks quality level. Actual visible stars are far fewer than the catalog. [RangeScene.js:1858](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangeScene.js#L1858) calls scene setup per partition, revisiting calibration, colors, mist and actor transforms at [1528–1788](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangeScene.js#L1528-L1788).

**Cause and solution.** Work is organized around painter partitions while much input is frame/view invariant. Separate invariant preparation from camera/pass uniforms, cache by frame/view/context epoch, and reuse appropriate sky projection/command data. Introduce a measured sky quality policy separately from native terrain quality. Full raster caching is an alternative but adds resolution-dependent memory and blit cost.

**Benefit, cost and risk.** Avoid repeated CPU work and prevent a general governor from shedding the wrong visual layer; M, payoff unmeasured. Camera, reflection, pointer crop, weather and output transforms must all participate in cache invalidation. Do not cache only by heard time or dim the sky indiscriminately.

**Validation.** Distinct CPU phases for view setup, output sky, mirror sky, native terrain, palette and composite at 1080p/4K, both grids, clear/night/storm/aurora. Pair this with GPU completion timing from F21. Confirm visual identity and export parity survive quality changes.

### F13 Introduce spatial culling within merged terrain and forest bands

**Behavior and evidence — C+H.** [TerrainMesh.js:130–145](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/TerrainMesh.js#L130-L145) merges tiles per depth band. Terrain, depth and fringe meshes disable frustum culling at [RangeScene.js:1018–1057](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangeScene.js#L1018-L1057). [ForestGL.js:562–610](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/ForestGL.js#L562-L610) batches by band/species/variant with culling disabled; shader thinning happens after vertex submission. Static baked visibility and tour windows already bound the scene.

**Solution and alternatives.** Add moderately sized spatial cells inside bands, conservative motion-expanded bounds and projected-size LOD. Alternatively compact visible instance indices per coarse cell or extend tour-window concepts to static rails. Retain batching; one object per tree would likely increase overhead badly.

**Benefit, cost and risk.** Potentially less off-axis/cropped/mirrored vertex work and fewer full-batch detail scans, enabling denser nearby detail; L. Extra draws, CPU bounding tests and buffer updates can exceed savings at 320×180. Musical deformation, wind, reflection cameras and authored pan cones must fit conservative bounds. High confidence in representation, medium in payoff.

**Validation.** Draws/triangles, CPU submission and GPU elapsed for cropped/uncropped views, mirrors and tours on desktop and integrated/mobile GPUs. Continuous zoom/travel tests must show no ridge/tree popping or broken ownership. Select cell size from measurement.

### F14 Skip land material calculations for pixels already classified as water

**Behavior and evidence — C+H.** [TerrainMaterial.js:539–540](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/TerrainMaterial.js#L539-L540) knows water coverage, yet macro triplanar samples at [557–558](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/TerrainMaterial.js#L557-L558) and substantial land material work execute before water overrides albedo/normal/roughness at [663–674](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/TerrainMaterial.js#L663-L674). Pixel mode already skips near/snow samples where appropriate; the full Natural path is not the current product cost.

**Solution and alternatives.** Extract semantic land/water material functions that share final light/atmosphere. An explicit branch, specialized water draw, or guarded land work may help. Trace surviving flow/curvature/ambient and debug consumers before moving expressions. Preserve valid texture derivatives, using explicit gradients where needed.

**Benefit, cost and risk.** Shorter water shader path/register lifetime on large lakes; S–M, lower priority than cloud preparation. Compiler elimination may already remove some expressions, so source fetch counts are not actual hardware instruction counts. Shore divergence, derivative discontinuities, ice ordering and reflections can regress.

**Validation.** Compiled shader/instruction/register investigation plus real GPU timing in lake-heavy and dry scenes. Match shores, glints, rain/wakes, ice, debug masks and continuous zoom; accept only a measured gain without visual loss.

### F15 Core smoke does not exercise ordinary staged v2 playback

**Behavior and evidence — C, high confidence, with F01 corroboration.** [tools/smoke.mjs:111](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/tools/smoke.mjs#L111) explicitly uses all-worlds and legacy Range helpers; [tools/lib/allWorlds.mjs:10–18](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/tools/lib/allWorlds.mjs#L10-L18) explains the speed trade-off. [bootstrap-smoke.mjs:50–62](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/tools/bootstrap-smoke.mjs#L50-L62) only opens Browse. Dedicated v2/pixel/visual tests exist; this is a gap in the inexpensive ordinary-route integration contract, not absence of rendering tests.

**Solution and alternatives.** Add a bounded headless local smoke against the exact staged artifact using an unmodified normal URL, plus a separately selected/persisted Tetons case. Verify real upload, readiness/audio order, delivered frames, pause/seek, experience switch and explicit preparation failure behavior. Keep the legacy compatibility smoke. A tiny default-route fixture can be supplemented by scheduled/manual longer corpus checks.

**Benefit, cost and risk.** Catches the class of integration failure seen in F01 despite a passing root suite; M harness cost. Avoid artistic or device-performance claims from this gate. Keep runtime bounded and record actual source digest and renderer.

**Validation.** Demonstrate the tour regression fails before repair and passes after; verify clean default Landscape and Trio as separate routes. Run source and staged artifact paths and assert the loaded bytes match the audited build. Do not silently force legacy to make a new v2 gate fast.

### F16 Cache maintenance reads whole analysis bundles for metadata operations

**Behavior and evidence — C, high confidence; user impact unmeasured.** [AnalysisCache.js:128–147](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/audio/AnalysisCache.js#L128-L147) performs full-row `getAll()` after every successful store, then sorts/deletes only above 100 entries; [156–164](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/audio/AnalysisCache.js#L156-L164) also reads full rows to list small metadata, but this listing API currently has only test callers and is not asserted to impose live UI cost. A `usedMs` index exists. The limit is 100 entries rather than bytes, while bundles include timeline/energy/fingerprint structures.

**Solution and alternatives.** Use LRU index key cursors for eviction; store lightweight metadata separately or use a small metadata index; track estimated serialized bytes and apply a byte ceiling. Await transactional maintenance and handle quota/upgrade/blocked paths. A simpler first step is indexed eviction and metadata-only listing without schema-wide redesign. Include F03's late-open cleanup in the same cache-owner repair.

**Benefit, cost and risk.** Avoid transient cloning/allocation growing with cached music; M. IDB migration/transaction behavior is easy to get wrong, and byte estimates are not browser storage accounting. Preserve optional-cache failure-to-miss behavior and existing identity validation.

**Validation.** Real-browser cold/warm cache, 100 existing large varied bundles followed by insertion of the 101st and later, eviction order, quota abort, blocked upgrade and cancellation. Measure clone duration and memory around metadata listing/stores; faked IndexedDB alone cannot establish persistence or native peak memory.

### F17 Extract explicit session ownership from the entrypoint

**Behavior and evidence — C+H, high confidence in coupling.** The 4,964-line [main.js](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/main.js) combines `changeExperience` (583–655), stop (1076–1133), start (1770 onward), loader (2483 onward), frame pump (3348 onward), recording and export. The larger `BiomeManager` mixes scheduling, scene/resources and painting. Preserve flags and callbacks cross these boundaries, so one transition requires nonlocal ordering knowledge.

**Solution and alternatives.** Extract a session/transport owner with explicit prepare/play/pause/seek/replace/stop transitions and one disposable scope. Then extract experience-specific scenes and the frame pump behind current callers. A first stage can be dependency-injected existing functions without behavior changes. Retain useful existing seams such as `RenderReadyPlayback`, selection tickets and `FixedStepClock`.

**Benefit, cost and risk.** Cheaper lifecycle reasoning, direct transition tests and clearer async cancellation/resource ownership; L. This is a maintainability inference, not a measured defect-rate claim. A rewrite could reintroduce the exact held-audio, recording and stale-generation bugs that recent history repaired.

**Validation.** Establish F15 first. Cover pause/seek during replacement, analysis refinement, recorder holds, ready/fail/abort, experience return, context loss and export in a transition matrix. Extract one owner at a time with unchanged image/audio fixtures and disposal invariants.

### F18 Trio starts with dormant Landscape state and unused highlight analysis

**Behavior and evidence — C, high confidence.** [Simulation.js:134–195](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/sim/Simulation.js#L134-L195) constructs Landscape systems and calls highlight planning before selecting experience. [HighlightReel.js:74–89](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/render/HighlightReel.js#L74-L89) can replay detector ticks at 120 Hz through the song. Trio exits before Landscape step/draw/highlight consumers. Some Landscape conductor subscriptions also remain. This is unused CPU/state construction, not evidence that Trio eagerly creates the v2 GPU scene.

**Solution and alternatives.** Defer highlight planning until a consumer needs it, then lazily construct experience scene state around a small shared song/musical context. Retain/suspend or dispose inactive scenes with explicit switching semantics. Deferring only the highlight prepass is the narrower first step.

**Benefit, cost and risk.** Less startup work and dormant heap for Trio; M, magnitude unmeasured. Switching back, current musical state and late-analysis refinement must remain correct. The analytical maximum of roughly 144,001 detector ticks for a 20-minute input is a bound, not a measured normal workload; early stopping can reduce it.

**Validation.** Cold-start CPU/heap in Trio versus Landscape on identical audio; long-song construction, repeated switching, seek and refinement. Ensure conductor subscriptions/resources do not multiply and defer work without moving a large hitch to the first visible scene switch.

### F19 Load optional world implementations only when the gallery route needs them

**Behavior and evidence — C+H.** Normal startup hides world choice and picks Alpine at [main.js:181–182](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/main.js#L181-L182) and [1395–1405](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/main.js#L1395-L1405). [Worlds.js:15–21](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/Worlds.js#L15-L21) and [WorldRegistry.js:24–30](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/WorldRegistry.js#L24-L30) eagerly import optional palettes/renderers. A source-graph count identified 21 files/95,635 uncompressed bytes within the seven optional world directories. This is not network transfer size or a measured load-time saving.

**Solution and alternatives.** Separate world descriptors from renderer factories; dynamically import optional chooser/preview/render implementations on `?worlds=all` or other explicit use. Alternatively document the compatibility boundary and postpone splitting until lifecycle extraction. These worlds remain reachable and should not be deleted as dead code.

**Benefit, cost and risk.** Clearer product boundaries and a smaller initial graph; M, lower expected impact than F04/F17. Dynamic registration ordering, recommendations, previews, imports and historical support can regress. High confidence in eager reachability, low-to-medium in significant latency payoff.

**Validation.** Measure cold request/parse/compile graph with cache disabled and representative network latency; exercise every explicitly supported world and persisted gallery selection. Proceed only if graph reduction or maintenance clarity justifies asynchronous complexity.

### F20 Reconcile validation documentation with intentional local execution

**Behavior and evidence — C+history, high confidence.** [.github/workflows/test.yml:1–4](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/.github/workflows/test.yml#L1-L4) is manual, while [docs/test-matrix.md:27–31](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/docs/test-matrix.md#L27-L31) still claims automatic PR/main/reusable gates. [validationMatrix.test.js:28–33](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/test/validationMatrix.test.js#L28-L33) checks names, not trigger semantics. Commit `51dae09` explicitly chose local validation/manual hosted tests; manual operation is intentional.

**Solution and alternatives.** Create one documented local preflight manifest/command recording Node/dependency versions, exact source SHA/digest, dirty state, commands and outcomes; derive the matrix from that contract. Keep hosted jobs manual unless policy changes. Remove unreachable automatic-PR assumptions in comparison tooling or expose explicit baseline refs.

**Benefit, cost and risk.** Reproducible assurance without recurring hosted cost or misleading historical green labels; S, low product risk. Do not infer branch protection, live Pages configuration or deployment status from comments. Those settings were not audited as verified-current external state.

**Validation.** Run the local contract against the same staged artifact, check trigger/document agreement, retain evidence without adding captures to Git. This report's successful local tests are not CI or deployment claims.

### F21 Short RTX playback misses delivery targets and lacks pass-level GPU attribution

**Behavior and evidence — M+C for short-trace pacing, C+H for bottleneck attribution.** Two 30-second headless native Windows RTX 3060 traces of static Jackson Lake, Classic grid, 1280×720 and auto quality both had delivered p95 **33.4 ms**. The first overlapped other audit work (50.84 fps, two >100 ms gaps); the repeat after the full tests/software capture ended measured **50.20 fps**, p99 **50 ms**, maximum **249.9 ms**, and **three >100 ms gaps**. It had zero failed presentations, no hidden/paused samples and advancing heard time. The repeat misses the existing live-review targets of p95≤20 ms and at most one >100 ms gap/minute. It is a static-view diagnostic, not a successful tour trace or physical-display benchmark. Auto quality and normal host activity prevent fixed-quality/device-wide extrapolation. Both raw runs are retained. The repeat observed quality levels 0 through 4, ending at 4; owned graphics peak was 248.29 MiB with zero ledger overcommits. That is accounted ownership, not measured VRAM/RSS.  [RangePresentation.js:948–984](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangePresentation.js#L948-L984) measures CPU wall/submission/copy boundaries, not completed GPU work. [FrameDelivery.js:1–15](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/render/FrameDelivery.js#L1-L15) correctly distinguishes callback cadence, delivered frame identity and GPU timing. [GraphicsResidency.js:24–25](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/render/GraphicsResidency.js#L24-L25) explicitly limits what its accounting proves.

**Solution and alternatives.** Add optional asynchronous disjoint timer queries around terrain/depth/forest/mirror/composite passes, sampled CPU phase/long-task markers, and phase-tagged delivery/quality metrics. Measure process/browser/GPU memory separately across repeated transition/seek/export/context-loss cycles. Query availability and disjoint results must be handled; avoid synchronous readback or per-frame diagnostic `getParameter/getError` polling. Browser graphics best practices support batching, measured resolution choices and nonblocking observation. [MDN WebGL best practices](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices), [MDN timer-query extension](https://developer.mozilla.org/en-US/docs/Web/API/EXT_disjoint_timer_query).

**Benefit, cost and risk.** Identifies whether the limiting resource is CPU preparation, Canvas work, GPU vertices/fill, copy bandwidth, allocation or scheduling; M. Measurement overhead and debug-only instrumentation can distort results, so sample and retain an instrumentation-off baseline. No actual GPU-memory leak is established by this audit.

**Validation.** Repair F01 before tour pacing. Compare cold/warm and fixed/auto quality on discrete/integrated/mobile GPUs at both grids and 1080p/4K output; include a full song and repeated session loops. Record p50/p95/p99, >100 ms gaps, failed presentations, quality residency and memory high-water/plateau. A green owned-byte budget does not prove process/GPU memory is safe.

### F22 Build an explicit GPU composition graph before considering a broad backend replacement

**Constraint and evidence — C+H.** The per-partition WebGL-to-Canvas path at [RangePresentation.js:945–984](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangePresentation.js#L945-L984), CPU palette readback at [PaletteQuantize.js:138–152](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/render/PaletteQuantize.js#L138-L152), and final hybrid composition at [PixelPresentation.js:24–32](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/render/PixelPresentation.js#L24-L32) constrain shared depth, lighting and full-frame effects. The copies are GPU/Canvas interoperation, not automatically CPU readPixels; only the explicit palette operation establishes a CPU readback.

**Ambitious solution.** Model one frame graph with explicit color/depth domains, lifetimes and ownership: stable terrain depth, forest coverage/actor occlusion, water reflection, cloud/air transmission, narrative layers, native-grid palette/dither, then smooth-sky/pixel-terrain output. Move one expensive boundary at a time into GPU render targets/shader passes, preserving layer order and stylistic pixel rules. A lookup-texture palette shader can replace CPU quantization if it reproduces exact selective-dither/alpha behavior. Retain a Canvas compatibility route until parity is demonstrated.

**Alternatives and modern capabilities.** Use WebGL2 first with existing instancing and render targets. Workers/OffscreenCanvas can move pure preparation or an isolated render owner off the UI thread; transfer must occur before obtaining a context, so it is an ownership redesign rather than a switch. [MDN OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas), [transferControlToOffscreen](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/transferControlToOffscreen). A feature-detected WebGPU experiment could later target cell visibility/instance compaction, terrain preparation or atmospheric integration. WebGPU requires a secure context and capability/fallback checks; no uniform device-availability promise is made. [MDN WebGPU](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API).

**Benefit, cost and risk.** Potentially the largest combined visual/performance advance: coherent depth-aware light/atmosphere, better local detail within budget, fewer duplicated passes/readbacks and cleaner resource lifetimes. XL, with high artistic/export/browser risk. A full rewrite has no demonstrated ROI today; limit experiments to pass-level A/Bs with measurable acceptance criteria.

**Validation.** Establish F09/F10/F12/F13/F21 baselines and F17 ownership first. Require matched still and continuous music captures, cloud/forest/water occlusion, exact-grid/palette rules, pause/seek/context restore, export parity, fallback compatibility and measured improvement on more than one GPU class. Backend novelty is not an acceptance criterion.

## Visual assessment of the captured scenes

The synthetic input is the maintained review tool's generated 90-second contrast recording, retained with a SHA-256 in the capture reports. The following observations apply to these recorded timestamps, not to every song or view. Frame/audio players are retained for review; this audit's visual observations came from actual saved images, with no claim of full musical/artistic acceptance.

At **12–13 seconds, Tetons tour, Classic and Detailed**, the scene has a broad dark wooded foreground, subdued distant ridges, smooth blue sky and soft world-cloud banks. Detailed resolves finer forest structure than Classic. This is an opening composition, so the absence of a hero summit at this moment is not alone a defect. It is a useful shadow/air-color test case for F09 and a cold cloud preparation case for F04.

At **45–46 seconds, Jackson Lake, Detailed, RTX 3060**, the scene shows distinct snow/ridge structure, forest depth layers, smooth cloud banks, celestial bodies and a reflected mountain/glare field. Strong foundations include coherent large terrain shapes and a stylized pixel-scale forest. The bright central reflection and pale shore create a concentrated highlight against dark water; whether to retain that emphasis or reduce clipping is an aesthetic question. A useful experiment would give sky, snow, shore and water a common exposure/transfer policy, with controlled water roughness and cloud transmission rather than another global contrast wash.

Potential high-value visual directions, subject to matched evaluation, are:

1. **Depth and lighting coherence:** F09's transfer contract followed by F11's shared cloud/receiver field; broad shadow motion and consistent aerial perspective should improve separation without adding clutter.
2. **Local detail where it resolves:** spatial-cell detail/culling from F13 can spend saved work on nearer tree crown structure, shoreline contact and rock/snow material variation. Avoid adding subpixel texture that only flickers in the native grid.
3. **Atmosphere with stable motion:** filtered world-space cloud transmission and depth-aware haze, preserving deterministic heard-time reconstruction. A low-resolution, temporally stable atmospheric pass is a more plausible first experiment than full volumetric ray marching everywhere.
4. **Water as part of the scene light field:** preserve reflection geometry while unifying cloud/sky exposure, roughness and glint limits; evaluate F14 separately for performance, not as proof of a better-looking lake.
5. **Presentation consistency:** test smooth-sky/pixel-terrain scale relationships, star/aurora brightness and foreground readability under the same camera. Maintain the intentionally stylized language; higher resolution and more effects are not automatic improvements.

Representative native Detailed capture at 45 seconds:

**Original graphical evidence:** Jackson Lake at 45 seconds, Detailed grid, headless RTX 3060. The exact PNG is retained in the original evidence bundle at `evidence/landscape-lake-rtx/detailed/review-audio/frame-00000.png` (SHA-256 `daf7da6288b47e494b0afe86a40a1076dc49f3741cb1a5588aa7b0d3e764ea3a`). It is not committed to Git, in accordance with the repository capture policy.

## Implementation roadmap and acceptance gates

### Phase 0 Establish a reproducible current-route safety net

**Work:** F15 and F20; preserve the minimized F01 regression plus recorded worker-input provenance. Produce one local preflight command against a frozen/staged artifact. Keep intentional manual hosted policy. Add real IndexedDB and library-error integration cases where fakes currently mask completeness/lifecycle behavior.

**Gate:** exact source/staged hashes, Node/dependency/runtime identity, existing tests/lint/stage, clean default Landscape and Trio uploads, selected/persisted tour startup, explicit failed preparation, pause/seek/replace, and no false success on failed runs. This gate makes subsequent repairs reviewable; it is not an artistic sign-off.

### Phase 1 Repair availability and data correctness

**Work:** F01, F02, F03, F05, F06 and F08. Planner and library/cache/recording repairs are mostly independent and can be implemented in parallel by owners with a shared transition test matrix. F05/F06 should share recorder-result/pause semantics. Include late-open connection cleanup with F03.

**Gate:** minimized tour schedule succeeds while turn/altitude/continuity limits remain valid; access loss preserves history; cancelled stalled cache settles; valid analysis is not withheld; partial/error export is explicit; active-playback recording duration is correct; repeated failed audio boots dispose or reuse their context. Validate real near-limit encoder behavior before claiming export durability.

### Phase 2 Remove obvious blocking preparation and characterize pacing

**Work:** F04, F07, F16 and F21. Move cloud/stem generation to cancellable bounded work, use indexed/byte-aware cache maintenance, collect uncontended and instrumentation-off delivery/GPU/CPU/memory evidence. Keep generation/residency checks in every async publication path.

**Gate:** no cloud/stem long task on the draw/input turn; deterministic cache identity and imagery; bounded live+pending work; stable bytes after repeated replacement/seek; delivery targets recorded at fixed and auto quality without hiding transition stalls. Do not substitute an average FPS improvement for p95/stall evidence.

### Phase 3 Improve visual consistency and targeted render cost

**Work:** F09 first, then F10/F12 and profiled F14. Treat F13 as an experiment with a pass-level budget; promote spatial cells only if saved GPU work outweighs new submissions. Preserve the current interleaving and pixel-grid contracts.

**Gate:** matched dawn/night/storm/lake/tour captures and continuous playback, numerical color endpoints, depth/forest/cast occlusion, mirror/export parity, actual measured pass reductions on discrete and integrated/mobile GPU classes. Review appearance changes with matching audio and a retain/revert decision.

### Phase 4 Consolidate ownership and make experience work lazy

**Work:** F17, then F18; consider F19 after a cold-module profile. Extract existing owners incrementally, then remove unused startup work. Do not mix lifecycle extraction with a new lighting/backend implementation in one change set.

**Gate:** full transition matrix, no duplicated callbacks/resources, unchanged camera/recording semantics, lazy work does not turn into a first-switch hitch, and explicit state transfer between Landscape and Trio.

### Phase 5 Pursue substantial graphical advances through measured prototypes

**Work:** F11 shared optical field and F22 GPU composition graph. Prototype a single scene/pass at a time. Start with coherent cloud receiver lighting or GPU palette composition; reserve a WebGPU branch for a measured kernel such as instance compaction after the WebGL2 baseline is understood.

**Gate:** richer depth/lighting/atmosphere accepted from matched motion/audio evidence; equal or better delivery/memory on target devices; predictable fallback and context recovery; deterministic export. A prototype that only looks better on an RTX desktop does not establish mobile viability.

The companion CSV gives a sortable per-finding work order, benefit, complexity, confidence, dependencies and validation gate. Phase sizes should be re-estimated after the correctness repairs and first uncontended GPU profile; adding these broad estimates into a fixed project deadline would be misleading.

## Relevant recent history

| Commit | Change and audit implication |
| --- | --- |
| [6cacb1b](https://github.com/aepler315/midio-pixel/commit/6cacb1b8691ae438670c1a861bb3464038e96628) | Yielded Landscape surface/contour preparation. Remaining synchronous cloud/stem paths should follow the same responsiveness principle. |
| [99ad7ca](https://github.com/aepler315/midio-pixel/commit/99ad7ca0077791a44eb5b76ff5147169c66b8afd) | Reduced terrain-window planning and prioritized the current view. The audit does not reassert pre-fix window cost as current behavior. |
| [052ce85](https://github.com/aepler315/midio-pixel/commit/052ce85e5b729d4405a7906272ce20b8f42badb2) and [0fe7c31](https://github.com/aepler315/midio-pixel/commit/0fe7c31671d8f31b2683c8a77abbacf82995cde2) | Matched detail to the pixel grid and retained displayed forests during detail rebuilds. Any new culling/LOD work must preserve those continuity guarantees. |
| [e546764](https://github.com/aepler315/midio-pixel/commit/e546764fa593625a5022e3f69b572348798d7970) | Added smooth Landscape skies/background review, introducing the independent sky/presentation boundary assessed in F11/F12. |
| [b00124a](https://github.com/aepler315/midio-pixel/commit/b00124a71e60c4fa07e47f68a1c04aac792f6769) and [65b2278](https://github.com/aepler315/midio-pixel/commit/65b227860a02de7124d7b5cf214f7581ab6fd971) | Fixed world cloud motion, replaced flat masks, varied world shapes and added local GPU validation. The new synchronous per-shape preparation and receiver-field disconnection are evaluated at this current implementation. |
| [51dae09](https://github.com/aepler315/midio-pixel/commit/51dae09ffb673c2b26317219c5530973eb48fb33) | Intentionally moved validation local and kept hosted jobs manual. F20 proposes documentation/local-preflight repair, not reversing that policy. |

The read-only GitHub history receipt contains the exact subjects, timestamps and parent SHAs for the last 25 commits. Historical success/defect descriptions were treated as leads and checked against current code; no prior test total or screenshot was substituted for this audit's results.

## Existing strengths, exclusions and remaining evidence

Retain the current reservation identities, stale-generation checks, shader-link validation before publication, context epochs, pixel-aware forest policy, once-per-frame/view mirror cache, stable seeded placement and heard-time reconstruction. The governor does affect Range effects; it is incorrect to claim v2 ignores performance policy. The native grid is bounded and smooth sky does not silently increase terrain raster resolution.

Several apparent issues were deliberately excluded: dormant Natural/MSAA costs, a mirror-per-partition allegation, an inverted forest-LOD suspicion, and a numerical fog counterexample whose camera/cloud configuration was not reachable under authored clearance. No benchmark percentage, security vulnerability, actual GPU-memory leak or physical-device failure was invented. Conditional missing disposal is distinguished from measured native exhaustion.

Remaining validation includes representative real-music tours, full-song and repeated-session pacing, real IDB permission/quota/upgrade behavior, real codec finalization near the cap, Firefox/Safari/WebViews, integrated/mobile GPUs, thermal endurance and owner artistic acceptance. Current tests, short synthetic headless captures and owned-byte accounting cannot settle those questions. Repository branch-protection/Pages settings and live deployment bytes were not verified, and this audit makes no deployment claim.

## Evidence and reproduction guide

Open `evidence/index.html` for final diagnostic statuses, exact metrics and links to logs/JSON/captures. The ZIP includes the same evidence, audit notes and scratch reproduction scripts, without the application source tree, node_modules or a staged duplicate site. Pinned source links require repository access. Reproduction scripts expect the exact audited source snapshot at the documented workspace path; adapt the source root to an equivalent clean checkout before rerunning elsewhere.

Important raw artifacts are `source-verification.json`, `github-history.json`, `tests.log`, `lint.log`, `stage.log`, `bootstrap.log`, `reliability-repros.json`, `rendering-repros.json`, `tour-minimal-repro.json`, `tour-differential-replay.json`, the failing tour `live-report.json`, and `static-live-rtx.json`. The large exact captured worker payload is retained in the evidence archive; the minimized role schedule is sufficient for the regression. Captured frames, source-audio hashes, camera/control data and runtime hashes remain beside each graphical report.


## Publication appendix Evidence provenance and reproduction results

This appendix republishes retained textual investigation evidence; it introduces no new audit measurements. Browser-boundary fakes, CPU microbenchmarks, fixed-clock graphics and live delivery retain the limitations stated in the findings. The complete binary evidence bundle remains available in the original task output directory at `/mnt/c/Users/aeple/Documents/Codex/2026-10-20/conduct-a-comprehensive-evidence-based-technical-2/outputs/`. Those local artifacts have not been uploaded as part of this documentation publication.

### Preservation receipt

| Artifact | SHA-256 |
| --- | --- |
| Original `midio-pixel-technical-audit.md` | `9f8bb615b518b29ba2c3f9dfad5fe8eae003f34b1c1ce41a2756dab622fd282c` |
| Original `midio-pixel-prioritized-roadmap.csv` | `bbb8baf5c0463929cb34af7aca5f4147d5e051d8d7860258434c4bb2087d3a2c` |
| Original `midio-pixel-audit-evidence.zip` | `e73c8aea6bf41da71d75383f35f675ba2f5a5cc21f676dfe5689df76efc6beb5` |
| Original `SHA256SUMS.json` | `e6a30245ee83fe905cc419537e0e6aaf3b984f0cd39df79c9720086ca51d3227` |

The published report preserves all `F01`–`F22` sections and all 67 pinned source-reference URLs from the original Markdown. Their line numbers refer to the audited commit, not the publication commit. The companion roadmap CSV is byte-identical to the completed local deliverable.

### Final source-integrity verification

Original evidence file: `source-verification-final.json`. SHA-256: `efb21b2a23ab6249ae628ae474b265a190fa3ba9bfb4c511e42b27d5256a2094`.

```json
{
  "repository": "aepler315/midio-pixel",
  "commit": "8f7c10fecdb9c436f7e789ec094c79efe88eff31",
  "verifiedBlobs": 1518,
  "mismatches": [],
  "additionalApplicationFiles": [],
  "applicationUnchanged": true,
  "mainRecheckedAtEnd": "8f7c10fecdb9c436f7e789ec094c79efe88eff31"
}
```

### Final audit and diagnostic summary

Original evidence file: `audit-summary.json`. SHA-256: `da09a7e033fac2ae63910214cb8addce6b32aa1c7f242e0066b92d4b64769a93`.

```json
{
  "source": {
    "repository": "aepler315/midio-pixel",
    "commit": "8f7c10fecdb9c436f7e789ec094c79efe88eff31",
    "verifiedBlobs": 1518,
    "mismatches": [],
    "additionalApplicationFiles": [],
    "applicationUnchanged": true,
    "mainRecheckedAtEnd": "8f7c10fecdb9c436f7e789ec094c79efe88eff31"
  },
  "rootTests": {
    "total": 4801,
    "passed": 4793,
    "skipped": 8,
    "failed": 0,
    "durationMs": 322387.484437
  },
  "lint": "passed",
  "staging": "passed",
  "bootstrap": "passed",
  "fixedClock": {
    "rtxTourBothGrids": "passed",
    "rtxLakeDetailed": "passed",
    "softwareBothGrids": "passed"
  },
  "liveTour": {
    "status": "failed-before-playback",
    "reason": "tour: Tour timeline has no feasible aim state"
  },
  "staticLiveRepeat": {
    "seconds": 30,
    "uploadToReadyMs": 6126,
    "browser": "155.0.8059.80",
    "gpu": "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)",
    "delivery": {
      "callbacks": {
        "frames": 1534,
        "intervals": 1534,
        "medianMs": 16.7,
        "p95Ms": 33.4,
        "p99Ms": 50,
        "maxMs": 249.9,
        "stallsOver100ms": 3,
        "fps": 51.13
      },
      "delivered": {
        "frames": 1506,
        "intervals": 1506,
        "medianMs": 16.7,
        "p95Ms": 33.4,
        "p99Ms": 50,
        "maxMs": 249.9,
        "stallsOver100ms": 3,
        "fps": 50.2
      },
      "deliveredFrames": 1507,
      "repeatedFrames": 28,
      "failedPresentations": 0,
      "generationChanges": 0,
      "excluded": {
        "paused": 0,
        "hidden": 0
      },
      "capFps": [
        60
      ],
      "truncated": false
    },
    "qualityLevels": [
      0,
      1,
      2,
      3,
      4
    ],
    "ledgerPeakMiB": 248.28924369812012,
    "ledgerLiveMiB": 125.76267147064209,
    "ledgerOvercommits": 0,
    "meetsP95Target": false,
    "meetsGapTarget": false,
    "scope": "30-second headless native Windows hardware trace, static Jackson Lake diagnostic view, Classic grid, 1280x720, auto quality. Different route from failing Teton tour. No OS fullscreen or optical/physical-device acceptance."
  },
  "findings": 22,
  "applicationCodeChanged": false
}
```

### Reliability reproduction results

Original evidence file: `reliability-repros.json`. SHA-256: `fe2cded743e376af24070d0af51df87192ead7506eed4f0c2047ad2912c3ce19`.

```json
{
  "sourceSha": "8f7c10fecdb9c436f7e789ec094c79efe88eff31",
  "runtime": "v24.10.0",
  "platform": "linux",
  "architecture": "x64",
  "scope": "Production functions imported or exact source extracted; browser/audio/IDB boundary fakes. No browser execution.",
  "script": "work/repros/reliability-repros.mjs",
  "results": [
    {
      "repro": "healthy analysis withheld behind optional cache",
      "analyzed": true,
      "offered": false,
      "loadResolved": false
    },
    {
      "repro": "abort does not settle stalled cache load",
      "loadResolved": false
    },
    {
      "repro": "blocked cache open then late success",
      "result": null,
      "dbCloseCount": 0
    },
    {
      "repro": "cap removes crossing and final chunks",
      "returned": true,
      "resultText": "HEAD",
      "error": "Recording reached the 512 MB export limit.",
      "resultError": null
    },
    {
      "repro": "user playback pause does not pause recorder",
      "stateDuringPause": "recording",
      "contextSuspendCalls": 1,
      "contextResumeCalls": 1,
      "expectedActiveDurationMs": 2000,
      "recorderDurationMs": 7000
    },
    {
      "repro": "inaccessible iterator treated as completed empty scan",
      "before": [
        {
          "path": "song.mp3",
          "playCount": 1,
          "durationSec": 90
        }
      ],
      "after": [],
      "rescanError": null,
      "rootStillPresent": true
    },
    {
      "repro": "file getFile access error treated as missing and pruned",
      "before": [
        {
          "path": "song.mp3",
          "playCount": 1,
          "durationSec": 90
        }
      ],
      "after": [],
      "rescanError": null,
      "rootStillPresent": true
    },
    {
      "repro": "synchronous stem cache fingerprints",
      "stems": 4,
      "secondsPerStem": 60,
      "sampleRate": 8000,
      "keyCallMs": 649.1,
      "timerCouldRunBeforeReturn": false,
      "scope": "synthetic Node on this host; not browser or phone measurement"
    },
    {
      "repro": "failed boot attempts discard without closing",
      "attempts": 3,
      "contextsCreated": 3,
      "contextsClosed": 0,
      "engineForgotten": true
    }
  ]
}
```

### Rendering reproduction results

Original evidence file: `rendering-repros.json`. SHA-256: `b60e33216dca9925ff5fc329c405ff56b13bc201e29bca1f48b6998ed15fdeda`.

```json
{
  "metadata": {
    "sourceSha": "8f7c10fecdb9c436f7e789ec094c79efe88eff31",
    "node": "v24.10.0",
    "platform": "linux",
    "runAtUtc": "2026-10-20T11:15:20.733Z",
    "gpuUsed": false,
    "limitation": "Local CPU durations in a concurrent environment. Mocked rendering counts execute actual source branches but do not measure GPU rendering or real Canvas paint."
  },
  "cloudBuilder": {
    "width": 192,
    "height": 128,
    "uniqueSeeds": 8,
    "cloudMs": [
      40.29945399999997,
      28.286699,
      29.315800999999965,
      29.439239000000043,
      23.90321499999982,
      28.024576000000025,
      25.797528000000057,
      26.69897500000002
    ],
    "medianMs": 28.15563750000001,
    "checksum": 33397720,
    "limitation": "Pure RGBA builder only. JIT becomes warmer during the sequence; this does not simulate browser cached Canvas work."
  },
  "cloudCache": {
    "cacheMissMs": 27.892156000000114,
    "cacheHitIterations": 10000,
    "cacheHitTotalMs": 1.6953950000001896,
    "ownedMockCanvases": 1,
    "limitation": "Mock Canvas context; validates source cache work only and excludes real Canvas/GPU transfers."
  },
  "gammaRoundTrip": [
    {
      "input": 1,
      "linear": 0.0003035269835488375,
      "shaderRoundTrip": 6.420058063009699,
      "errorCodeValues": 5.420058063009699
    },
    {
      "input": 5,
      "linear": 0.0015176349177441874,
      "shaderRoundTrip": 13.342972599553741,
      "errorCodeValues": 8.342972599553741
    },
    {
      "input": 16,
      "linear": 0.005181516702338386,
      "shaderRoundTrip": 23.316156101739118,
      "errorCodeValues": 7.316156101739118
    },
    {
      "input": 32,
      "linear": 0.014443843596092545,
      "shaderRoundTrip": 37.15629068386404,
      "errorCodeValues": 5.156290683864043
    },
    {
      "input": 64,
      "linear": 0.05126945837404324,
      "shaderRoundTrip": 66.0864358340589,
      "errorCodeValues": 2.0864358340589035
    },
    {
      "input": 128,
      "linear": 0.21586050011389926,
      "shaderRoundTrip": 127.0257083481777,
      "errorCodeValues": -0.9742916518222984
    }
  ],
  "partitionBranchCounts": [
    {
      "actorsVisible": false,
      "wholeTerrainDepthCalls": 1,
      "forestDepthCalls": 0,
      "totalRenderCalls": 7,
      "calls": [
        {
          "scene": "depth",
          "layer": 1
        },
        {
          "scene": "far",
          "layer": 1
        },
        {
          "scene": "far",
          "layer": 2
        },
        {
          "scene": "mid",
          "layer": 1
        },
        {
          "scene": "mid",
          "layer": 2
        },
        {
          "scene": "near",
          "layer": 1
        },
        {
          "scene": "near",
          "layer": 2
        }
      ],
      "limitation": "Renderer is mocked; layer masks 1,2,4,8 mean layers0,1,2,3. No actual GPU, copies, mirror or per-scene draw count measured."
    },
    {
      "actorsVisible": true,
      "wholeTerrainDepthCalls": 3,
      "forestDepthCalls": 3,
      "totalRenderCalls": 15,
      "calls": [
        {
          "scene": "depth",
          "layer": 1
        },
        {
          "scene": "far",
          "layer": 1
        },
        {
          "scene": "far",
          "layer": 2
        },
        {
          "scene": "depth",
          "layer": 4
        },
        {
          "scene": "far",
          "layer": 8
        },
        {
          "scene": "depth",
          "layer": 1
        },
        {
          "scene": "mid",
          "layer": 1
        },
        {
          "scene": "mid",
          "layer": 2
        },
        {
          "scene": "depth",
          "layer": 4
        },
        {
          "scene": "mid",
          "layer": 8
        },
        {
          "scene": "depth",
          "layer": 1
        },
        {
          "scene": "near",
          "layer": 1
        },
        {
          "scene": "near",
          "layer": 2
        },
        {
          "scene": "depth",
          "layer": 4
        },
        {
          "scene": "near",
          "layer": 8
        }
      ],
      "limitation": "Renderer is mocked; layer masks 1,2,4,8 mean layers0,1,2,3. No actual GPU, copies, mirror or per-scene draw count measured."
    }
  ],
  "staticRailCloudCandidateCounts": [
    {
      "view": "nc-ross-lake-north",
      "fair": 9,
      "storm": 10,
      "total": 19
    },
    {
      "view": "teton-jackson-lake",
      "fair": 7,
      "storm": 10,
      "total": 17
    },
    {
      "view": "denali-wonder-lake",
      "fair": 6,
      "storm": 5,
      "total": 11
    },
    {
      "view": "tombstone-north-klondike",
      "fair": 8,
      "storm": 11,
      "total": 19
    },
    {
      "view": "muncho-lake-south",
      "fair": 6,
      "storm": 11,
      "total": 17
    },
    {
      "view": "izta-popo-west",
      "fair": 7,
      "storm": 9,
      "total": 16
    },
    {
      "view": "black-mountains-catawba",
      "fair": 5,
      "storm": 9,
      "total": 14
    },
    {
      "view": "san-gabriel-baldy",
      "fair": 8,
      "storm": 11,
      "total": 19
    },
    {
      "view": "white-mountains-owens",
      "fair": 6,
      "storm": 9,
      "total": 15
    },
    {
      "view": "la-sal-castle-valley",
      "fair": 6,
      "storm": 8,
      "total": 14
    },
    {
      "view": "panamint-dantes-view",
      "fair": 7,
      "storm": 9,
      "total": 16
    },
    {
      "view": "chugach-matanuska",
      "fair": 6,
      "storm": 11,
      "total": 17
    },
    {
      "view": "monument-valley-163",
      "fair": 3,
      "storm": 4,
      "total": 7
    },
    {
      "view": "pend-oreille-valley",
      "fair": 10,
      "storm": 11,
      "total": 21
    },
    {
      "view": "teton-jackson-lake-coherent",
      "fair": 7,
      "storm": 10,
      "total": 17
    },
    {
      "view": "monument-valley-163-coherent",
      "fair": 3,
      "storm": 4,
      "total": 7
    }
  ]
}
```

### Minimized real-route tour regression

Original evidence file: `tour-minimal-repro.json`. SHA-256: `8395be61a8b0a7e7fcc8c6f27e7768e942823277418089f758db89767173edc7`.

```json
{
  "sourceSha": "8f7c10fecdb9c436f7e789ec094c79efe88eff31",
  "node": "v24.10.0",
  "scope": "Real published tour package, real planner/timeline, minimized synthetic role schedule; no source transformations or browser.",
  "results": [
    {
      "durationMs": 60000,
      "success": true,
      "elapsedMs": 226.658479,
      "qualityRatio": 0.8732127774340575
    },
    {
      "durationMs": 90000,
      "success": false,
      "elapsedMs": 132.4548299999999,
      "error": "Tour timeline has no feasible aim state"
    },
    {
      "durationMs": 120000,
      "success": true,
      "elapsedMs": 685.1544979999999,
      "qualityRatio": 0.900013346421309
    }
  ]
}
```

### Planner differential replay evidence

Original evidence file: `tour-differential-replay.json`. SHA-256: `3e64a5041d1ba1461e504d12a6ab17276db1d3a42ee57709e4967dba8184a73c`. These alternatives transformed source only in memory during diagnosis; no application fix was applied. Internal quality ratios are planner diagnostics, not artistic acceptance scores.

```json
{
  "sourceSha": "8f7c10fecdb9c436f7e789ec094c79efe88eff31",
  "node": "v24.10.0",
  "platform": "linux",
  "architecture": "x64",
  "scope": "Captured browser worker inputs, published route data, original production planner, original and in-memory-only transformed timelines. No application edits or browser/device performance measurement.",
  "sourceFiles": {
    "probeScript": {
      "path": "/mnt/c/Users/aeple/Documents/Codex/2026-10-20/conduct-a-comprehensive-evidence-based-technical-2/work/repros/tour-differential-replay.mjs",
      "sha256": "b373deaeeaa982ee70beff006011c3f090d0c6c6e98d81d833e174278bc18b9e"
    },
    "timeline": {
      "path": "/mnt/c/Users/aeple/Documents/Codex/2026-10-20/conduct-a-comprehensive-evidence-based-technical-2/work/repository/src/world/terrain/TourTimeline.js",
      "sha256": "6d0978d664a1c9c9ab6f166669673d06aceae391ab83ce62e11778e27d1aa77a",
      "unchangedAfterReplay": true
    },
    "tourManifest": {
      "path": "/mnt/c/Users/aeple/Documents/Codex/2026-10-20/conduct-a-comprehensive-evidence-based-technical-2/work/repository/src/assets/range/v2/tour/teton-range-tour.tour.json",
      "sha256": "82cd0767dfd32ef69840e8aff4d9e910b3946d4f10600d9c1e3e06d39437f86c"
    },
    "tourPayload": {
      "path": "/mnt/c/Users/aeple/Documents/Codex/2026-10-20/conduct-a-comprehensive-evidence-based-technical-2/work/repository/src/assets/range/v2/tour/teton-range-tour.tour.bin.gz",
      "sha256": "f570ee90ae0f5dd8ea096b9ac6023d9ae172dde397b29d242700c710e14252c5"
    },
    "capturedInputs": {
      "path": "/mnt/c/Users/aeple/Documents/Codex/2026-10-20/conduct-a-comprehensive-evidence-based-technical-2/work/evidence/tour-probe.json",
      "sha256": "6ce8bfbeee224602fba22896b4b64645d19457fa51063508de3f87bb446a3e24"
    }
  },
  "input": {
    "durationMs": 90000,
    "reducedMotion": false,
    "energySamples": 361,
    "sections": [
      {
        "startMs": 0,
        "endMs": 9347.068935709012,
        "role": "intro"
      },
      {
        "startMs": 9347.068935709012,
        "endMs": 16348.331353671532,
        "role": "verse"
      },
      {
        "startMs": 16348.331353671532,
        "endMs": 90000,
        "role": "outro"
      }
    ],
    "planHeroes": [
      {
        "timeMs": 2000,
        "pointId": "peak-1953955",
        "sectionIndex": 0,
        "role": "intro",
        "finalChorus": false,
        "subHero": false,
        "passedAtRange": false
      },
      {
        "timeMs": 11347.068935709012,
        "pointId": "peak-1253175",
        "sectionIndex": 1,
        "role": "verse",
        "finalChorus": false,
        "subHero": false,
        "passedAtRange": true
      },
      {
        "timeMs": 31078.665082937227,
        "pointId": "peak-2129226",
        "sectionIndex": 2,
        "role": "outro",
        "finalChorus": false,
        "subHero": false,
        "passedAtRange": true,
        "incoming": {
          "edgeId": "road-0165",
          "reverse": false
        }
      },
      {
        "timeMs": 53174.165676835764,
        "pointId": "peak-1898831",
        "sectionIndex": 2,
        "role": "outro",
        "subHero": true,
        "passedAtRange": false,
        "incoming": {
          "edgeId": "road-0161",
          "reverse": true
        }
      }
    ],
    "planNotes": [
      "Section 1: no legal junction route; passed at range",
      "peak-2129226: route follows the junction fillet (216.3m trim)",
      "Orbit filler: road-0157, road-0147.1, road-0143.0, road-0140, road-0151"
    ]
  },
  "limits": "Elapsed times are incidental uncontrolled host/JIT observations. Pose rates/clearance are sampled every 100ms. Internal quality ratios and projection framing are not artistic acceptance. Neither transformed alternative is a complete reviewed production fix.",
  "results": [
    {
      "name": "baseline",
      "success": false,
      "elapsedMs": 137.69973800000002,
      "error": "Tour timeline has no feasible aim state",
      "trace": [],
      "transforms": []
    },
    {
      "name": "traceOnly",
      "success": false,
      "elapsedMs": 108.37487899999996,
      "error": "Tour timeline has no feasible aim state",
      "trace": [
        {
          "step": 186,
          "time": 46500,
          "scale": 1,
          "lock": null,
          "nextHero": {
            "timeMs": 53174.165676835764,
            "pointId": "peak-1898831",
            "sectionIndex": 2,
            "role": "outro",
            "subHero": true,
            "passedAtRange": false,
            "incoming": {
              "edgeId": "road-0161",
              "reverse": true
            }
          },
          "station": null,
          "frameRole": "outro",
          "rejects": {
            "rise": 0,
            "station": 0,
            "nextStation": 80,
            "candidates": 80,
            "heads": [
              {
                "heading": 103,
                "desired": 235,
                "remaining": 5.174165676835765,
                "limit": 3,
                "yaw": 25
              },
              {
                "heading": 97,
                "desired": 235,
                "remaining": 5.174165676835765,
                "limit": 3,
                "yaw": 25
              },
              {
                "heading": 100,
                "desired": 235,
                "remaining": 5.174165676835765,
                "limit": 3,
                "yaw": 25
              },
              {
                "heading": 103,
                "desired": 235,
                "remaining": 5.174165676835765,
                "limit": 3,
                "yaw": 25
              },
              {
                "heading": 100,
                "desired": 235,
                "remaining": 5.174165676835765,
                "limit": 3,
                "yaw": 25
              },
              {
                "heading": 97,
                "desired": 235,
                "remaining": 5.174165676835765,
                "limit": 3,
                "yaw": 25
              }
            ],
            "beam": [
              {
                "y": 2386.806640625,
                "heading": 100,
                "cost": 68798.29467964968
              },
              {
                "y": 2362.02,
                "heading": 100,
                "cost": 68725.866978914
              }
            ]
          }
        }
      ],
      "transforms": [
        [
          "const states=new Map();",
          "const states=new Map();const rejects={rise:0,station:0,nextStation:0,candidates:0,heads:[],beam:beam.slice(0,8).map(p=>({y:p.y,heading:p.heading,cost:p.cost}))};"
        ],
        [
          "if(prev&&Math.abs(y-prev.y)>rise+.001)continue;",
          "if(prev&&Math.abs(y-prev.y)>rise+.001){rejects.rise++;continue;}"
        ],
        [
          "if(station&&Math.abs(diff(heading,station.bestAim.headingDeg))>.01)continue;",
          "rejects.candidates++;if(station&&Math.abs(diff(heading,station.bestAim.headingDeg))>.01){rejects.station++;continue;}"
        ],
        [
          "if(nextStation&&Math.abs(diff(nextStation.bestAim.headingDeg,heading))>yaw*Math.max(0,(nextHero.timeMs-1500-time)/1000)+.01)continue;",
          "if(nextStation&&Math.abs(diff(nextStation.bestAim.headingDeg,heading))>yaw*Math.max(0,(nextHero.timeMs-1500-time)/1000)+.01){rejects.nextStation++;if(rejects.heads.length<6)rejects.heads.push({heading,desired:nextStation.bestAim.headingDeg,remaining:Math.max(0,(nextHero.timeMs-1500-time)/1000),limit,yaw});continue;}"
        ],
        [
          "if(!states.size){",
          "if(!states.size){globalThis.__midioAuditTourTrace.push({step,time,scale,lock:lock||null,nextHero:nextHero||null,station:station||null,frameRole:frame.role,rejects});"
        ]
      ],
      "transformedSourceSha256": "b14c7b6009d43c02ccb06282d063f8a14f7e18c36b4be387a8ab035eb153de41"
    },
    {
      "name": "effectiveYaw",
      "success": true,
      "elapsedMs": 169.800749,
      "meanQualityRatio": 0.8296023031650626,
      "scale": 1,
      "sampling": {
        "intervalMs": 100,
        "maxYawDegPerSecond": 12.000055589580825,
        "maxClimbMPerSecond": 30,
        "minFloorMarginM": 162.9066406249999,
        "maxCeilingExcessM": -488.1910156250001
      },
      "notes": [
        "Section 1: no legal junction route; passed at range",
        "peak-2129226: route follows the junction fillet (216.3m trim)",
        "Orbit filler: road-0157, road-0147.1, road-0143.0, road-0140, road-0151",
        "peak-2129226: composed distant alternative peak-2360086"
      ],
      "heroes": [
        {
          "pointId": "peak-1953955",
          "timeMs": 2000,
          "passedAtRange": false,
          "subHero": false
        },
        {
          "pointId": "peak-1253175",
          "timeMs": 11347.068935709012,
          "passedAtRange": true,
          "subHero": false
        },
        {
          "pointId": "peak-2129226",
          "timeMs": 31078.665082937227,
          "passedAtRange": true,
          "subHero": false
        },
        {
          "pointId": "peak-1898831",
          "timeMs": 53174.165676835764,
          "passedAtRange": false,
          "subHero": true
        }
      ],
      "heroFraming": [
        {
          "pointId": "peak-1953955",
          "framedPointId": "peak-2021452",
          "timeMs": 2000,
          "framedFraction": 1,
          "stationVisit": true,
          "stationReached": true,
          "stationDistanceM": 14.999368228161348,
          "outcome": "station"
        },
        {
          "pointId": "peak-1253175",
          "framedPointId": "peak-1253175",
          "timeMs": 11347.068935709012,
          "framedFraction": 0,
          "stationVisit": false,
          "stationReached": false,
          "stationDistanceM": 10659.571621609859,
          "outcome": "missed"
        },
        {
          "pointId": "peak-2129226",
          "framedPointId": "peak-2360086",
          "timeMs": 31078.665082937227,
          "framedFraction": 1,
          "stationVisit": false,
          "stationReached": true,
          "stationDistanceM": 88.546705876945,
          "outcome": "distant"
        },
        {
          "pointId": "peak-1898831",
          "framedPointId": "peak-2992987",
          "timeMs": 53174.165676835764,
          "framedFraction": 1,
          "stationVisit": true,
          "stationReached": true,
          "stationDistanceM": 87.36036022250205,
          "outcome": "station"
        }
      ],
      "trace": [],
      "transforms": [
        [
          ">yaw*Math.max(0,(nextHero.timeMs-1500-time)/1000)+.01",
          ">(frame.role==='outro'||frame.role==='breakdown'?Math.min(12,yaw):yaw)*Math.max(0,(nextHero.timeMs-1500-time)/1000)+.01"
        ]
      ],
      "transformedSourceSha256": "cb421da739d128de397f30cd94abe3940fe41138018cacde4bf8552619bd62cf"
    },
    {
      "name": "releaseUpcomingHero",
      "success": true,
      "elapsedMs": 433.459063,
      "meanQualityRatio": 0.8908831832047281,
      "scale": 1,
      "sampling": {
        "intervalMs": 100,
        "maxYawDegPerSecond": 12.00001410505024,
        "maxClimbMPerSecond": 30,
        "minFloorMarginM": 162.9066406249999,
        "maxCeilingExcessM": -503.8612792968752
      },
      "notes": [
        "Section 1: no legal junction route; passed at range",
        "peak-2129226: route follows the junction fillet (216.3m trim)",
        "Orbit filler: road-0157, road-0147.1, road-0143.0, road-0140, road-0151",
        "peak-1898831: aim lock unreachable under yaw limit",
        "peak-2129226: composed distant alternative peak-2360086"
      ],
      "heroes": [
        {
          "pointId": "peak-1953955",
          "timeMs": 2000,
          "passedAtRange": false,
          "subHero": false
        },
        {
          "pointId": "peak-1253175",
          "timeMs": 11347.068935709012,
          "passedAtRange": true,
          "subHero": false
        },
        {
          "pointId": "peak-2129226",
          "timeMs": 31078.665082937227,
          "passedAtRange": true,
          "subHero": false
        },
        {
          "pointId": "peak-1898831",
          "timeMs": 53174.165676835764,
          "passedAtRange": true,
          "subHero": true
        }
      ],
      "heroFraming": [
        {
          "pointId": "peak-1953955",
          "framedPointId": "peak-2021452",
          "timeMs": 2000,
          "framedFraction": 1,
          "stationVisit": true,
          "stationReached": true,
          "stationDistanceM": 14.999368228161348,
          "outcome": "station"
        },
        {
          "pointId": "peak-1253175",
          "framedPointId": "peak-1253175",
          "timeMs": 11347.068935709012,
          "framedFraction": 0,
          "stationVisit": false,
          "stationReached": false,
          "stationDistanceM": 10659.571621609859,
          "outcome": "missed"
        },
        {
          "pointId": "peak-2129226",
          "framedPointId": "peak-2360086",
          "timeMs": 31078.665082937227,
          "framedFraction": 1,
          "stationVisit": false,
          "stationReached": true,
          "stationDistanceM": 88.546705876945,
          "outcome": "distant"
        },
        {
          "pointId": "peak-1898831",
          "framedPointId": "peak-1898831",
          "timeMs": 53174.165676835764,
          "framedFraction": 1,
          "stationVisit": false,
          "stationReached": true,
          "stationDistanceM": 87.36036022250205,
          "outcome": "distant"
        }
      ],
      "trace": [],
      "transforms": [
        [
          "if(lock){lock.passedAtRange=true;",
          "if(lock||nextHero){const rejected=lock||nextHero;rejected.passedAtRange=true;"
        ],
        [
          "`${lock.pointId}: aim lock unreachable under yaw limit`",
          "`${rejected.pointId}: aim lock unreachable under yaw limit`"
        ]
      ],
      "transformedSourceSha256": "ed321c79cf7ed2b70f1423ffa815ca8eacbb89a5b547b324b3abcf342034fdc3"
    }
  ]
}
```

### Reproduction scripts

These exact scratch scripts were used in the completed investigation. They are reproduced as documentation rather than installed as application or test code. They retain their original path assumptions; use an exact checkout of the audited commit and adapt only source-root/import paths when running elsewhere. The native Windows browser probes additionally require the original Playwright/Chrome runtime or an equivalent explicitly recorded environment.

#### tour-minimal-repro.mjs

Original script SHA-256: `db0f49d1fb4635f97fba712fc93439692170401bcb61216b14a53ba549e79f28`.

```javascript
import fs from 'node:fs/promises';
import {gunzipSync} from 'node:zlib';
import {decodeTour} from '../repository/src/world/terrain/TourPackage.js';
import {planTour} from '../repository/src/world/terrain/TourPlanner.js';
import {buildTourTimeline} from '../repository/src/world/terrain/TourTimeline.js';
const root=new URL('../repository/src/assets/range/v2/tour/',import.meta.url);
const data=decodeTour(JSON.parse(await fs.readFile(new URL('teton-range-tour.tour.json',root))),gunzipSync(await fs.readFile(new URL('teton-range-tour.tour.bin.gz',root))));
const results=[];
for(const durationMs of [60000,90000,120000]){
 const sections=[{startMs:0,endMs:10000,role:'intro',relEnergy01:.5},{startMs:10000,endMs:20000,role:'verse',relEnergy01:.5},{startMs:20000,endMs:durationMs,role:'outro',relEnergy01:.5}];
 const start=performance.now();
 try{const tour=buildTourTimeline(data,planTour(data,{sections,durationMs}));results.push({durationMs,success:true,elapsedMs:performance.now()-start,qualityRatio:tour.meanQualityRatio});}
 catch(error){results.push({durationMs,success:false,elapsedMs:performance.now()-start,error:error.message});}
}
const result={sourceSha:'8f7c10fecdb9c436f7e789ec094c79efe88eff31',node:process.version,scope:'Real published tour package, real planner/timeline, minimized synthetic role schedule; no source transformations or browser.',results};
console.log(JSON.stringify(result,null,2));
if(!results[0].success||results[1].success||!results[2].success)process.exitCode=1;
```

#### tour-differential-replay.mjs

Original script SHA-256: `b373deaeeaa982ee70beff006011c3f090d0c6c6e98d81d833e174278bc18b9e`.

```javascript
// Read-only replay of the captured browser tour-worker request. Application
// source is read, optionally transformed in memory and imported as a data URL.
// Default output: work/evidence/tour-differential-replay.json.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { decodeTour, tourClearanceAt } from '../repository/src/world/terrain/TourPackage.js';
import { planTour } from '../repository/src/world/terrain/TourPlanner.js';
import { buildTourTimeline } from '../repository/src/world/terrain/TourTimeline.js';

const repository = new URL('../repository/', import.meta.url);
const inputUrl = process.argv[2] ? pathToFileURL(resolve(process.argv[2])) : new URL('../evidence/tour-probe.json', import.meta.url);
const outputUrl = process.argv[3] ? pathToFileURL(resolve(process.argv[3])) : new URL('../evidence/tour-differential-replay.json', import.meta.url);
const timelineUrl = new URL('src/world/terrain/TourTimeline.js', repository);
const manifestUrl = new URL('src/assets/range/v2/tour/teton-range-tour.tour.json', repository);
const payloadUrl = new URL('src/assets/range/v2/tour/teton-range-tour.tour.bin.gz', repository);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const [captureText, originalSource, manifestText, payload] = await Promise.all([
  fs.readFile(inputUrl, 'utf8'), fs.readFile(timelineUrl, 'utf8'),
  fs.readFile(manifestUrl, 'utf8'), fs.readFile(payloadUrl),
]);
const capture = JSON.parse(captureText);
const input = capture.tourInputs[0].data;
const data = decodeTour(JSON.parse(manifestText), gunzipSync(payload));
assert.equal(input.data.id, data.id);
assert.equal(input.data.points.length, data.points.length);
assert.equal(input.data.field.samples.length, data.field.samples.length);
const energyAt = time => input.energy[Math.min(input.energy.length - 1, Math.max(0, Math.round(time / 250)))];
const plan = planTour(data, {
  sections: input.sections, roles: input.roles, durationMs: input.durationMs,
  energyAt, reducedMotion: input.reducedMotion,
});
const moduleSource = originalSource.replace(/from '([^']+)'/g, (_, specifier) => `from '${new URL(specifier, timelineUrl).href}'`);
const replaceOne = (source, from, to) => {
  assert.equal(source.split(from).length - 1, 1, `Expected one source anchor: ${from}`);
  return source.replace(from, to);
};

const traceTransforms = [
  ['const states=new Map();', 'const states=new Map();const rejects={rise:0,station:0,nextStation:0,candidates:0,heads:[],beam:beam.slice(0,8).map(p=>({y:p.y,heading:p.heading,cost:p.cost}))};'],
  ['if(prev&&Math.abs(y-prev.y)>rise+.001)continue;', 'if(prev&&Math.abs(y-prev.y)>rise+.001){rejects.rise++;continue;}'],
  ['if(station&&Math.abs(diff(heading,station.bestAim.headingDeg))>.01)continue;', 'rejects.candidates++;if(station&&Math.abs(diff(heading,station.bestAim.headingDeg))>.01){rejects.station++;continue;}'],
  ['if(nextStation&&Math.abs(diff(nextStation.bestAim.headingDeg,heading))>yaw*Math.max(0,(nextHero.timeMs-1500-time)/1000)+.01)continue;', 'if(nextStation&&Math.abs(diff(nextStation.bestAim.headingDeg,heading))>yaw*Math.max(0,(nextHero.timeMs-1500-time)/1000)+.01){rejects.nextStation++;if(rejects.heads.length<6)rejects.heads.push({heading,desired:nextStation.bestAim.headingDeg,remaining:Math.max(0,(nextHero.timeMs-1500-time)/1000),limit,yaw});continue;}'],
  ['if(!states.size){', 'if(!states.size){globalThis.__midioAuditTourTrace.push({step,time,scale,lock:lock||null,nextHero:nextHero||null,station:station||null,frameRole:frame.role,rejects});'],
];
const effectiveYawTransforms = [
  ['>yaw*Math.max(0,(nextHero.timeMs-1500-time)/1000)+.01', ">(frame.role==='outro'||frame.role==='breakdown'?Math.min(12,yaw):yaw)*Math.max(0,(nextHero.timeMs-1500-time)/1000)+.01"],
];
const releaseUpcomingHeroTransforms = [
  ['if(lock){lock.passedAtRange=true;', 'if(lock||nextHero){const rejected=lock||nextHero;rejected.passedAtRange=true;'],
  ['`${lock.pointId}: aim lock unreachable under yaw limit`', '`${rejected.pointId}: aim lock unreachable under yaw limit`'],
];
const transformed = async transforms => {
  let source = moduleSource;
  for (const [from, to] of transforms) source = replaceOne(source, from, to);
  const module = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'));
  return { build: module.buildTourTimeline, transformedSourceSha256: sha256(source), transforms };
};
const versions = {
  baseline: { build: buildTourTimeline, transforms: [] },
  traceOnly: await transformed(traceTransforms),
  effectiveYaw: await transformed(effectiveYawTransforms),
  releaseUpcomingHero: await transformed(releaseUpcomingHeroTransforms),
};

function summarize(tour) {
  let maxYawDegPerSecond = 0, maxClimbMPerSecond = 0;
  let minFloorMarginM = Infinity, maxCeilingExcessM = -Infinity, previous = null;
  for (let time = 0; time <= tour.durationMs; time += 100) {
    const pose = tour.poseAt(time), v = pose.targetM.map((x, i) => x - pose.eyeM[i]);
    const heading = Math.atan2(v[0], -v[2]) * 180 / Math.PI;
    if (previous) {
      maxYawDegPerSecond = Math.max(maxYawDegPerSecond, Math.abs(((heading - previous.heading + 540) % 360) - 180) * 10);
      maxClimbMPerSecond = Math.max(maxClimbMPerSecond, Math.abs(pose.eyeM[1] - previous.pose.eyeM[1]) * 10);
    }
    const band = tourClearanceAt(data.clearance, pose.eyeM[0], pose.eyeM[2]);
    minFloorMarginM = Math.min(minFloorMarginM, pose.eyeM[1] - band.floorY);
    maxCeilingExcessM = Math.max(maxCeilingExcessM, pose.eyeM[1] - band.ceilY);
    previous = { heading, pose };
  }
  return {
    meanQualityRatio: tour.meanQualityRatio, scale: tour.scale,
    sampling: { intervalMs: 100, maxYawDegPerSecond, maxClimbMPerSecond, minFloorMarginM, maxCeilingExcessM },
    notes: tour.notes,
    heroes: tour.heroes.map(({ pointId, timeMs, passedAtRange, subHero }) => ({ pointId, timeMs, passedAtRange, subHero })),
    heroFraming: tour.heroFraming,
  };
}

const results = [];
for (const [name, version] of Object.entries(versions)) {
  globalThis.__midioAuditTourTrace = [];
  const start = performance.now();
  try {
    const tour = version.build(data, plan, { reducedMotion: input.reducedMotion });
    results.push({ name, success: true, elapsedMs: performance.now() - start, ...summarize(tour), trace: globalThis.__midioAuditTourTrace, transforms: version.transforms, transformedSourceSha256: version.transformedSourceSha256 });
  } catch (error) {
    results.push({ name, success: false, elapsedMs: performance.now() - start, error: error.message, trace: globalThis.__midioAuditTourTrace, transforms: version.transforms, transformedSourceSha256: version.transformedSourceSha256 });
  }
}
delete globalThis.__midioAuditTourTrace;
const originalSourceAfter = await fs.readFile(timelineUrl, 'utf8');
assert.equal(originalSourceAfter, originalSource, 'Application source changed during diagnostic');
const result = {
  sourceSha: '8f7c10fecdb9c436f7e789ec094c79efe88eff31', node: process.version,
  platform: process.platform, architecture: process.arch,
  scope: 'Captured browser worker inputs, published route data, original production planner, original and in-memory-only transformed timelines. No application edits or browser/device performance measurement.',
  sourceFiles: {
    probeScript: { path: fileURLToPath(import.meta.url), sha256: sha256(await fs.readFile(new URL(import.meta.url))) },
    timeline: { path: fileURLToPath(timelineUrl), sha256: sha256(originalSource), unchangedAfterReplay: true },
    tourManifest: { path: fileURLToPath(manifestUrl), sha256: sha256(manifestText) },
    tourPayload: { path: fileURLToPath(payloadUrl), sha256: sha256(payload) },
    capturedInputs: { path: fileURLToPath(inputUrl), sha256: sha256(captureText) },
  },
  input: {
    durationMs: input.durationMs, reducedMotion: input.reducedMotion, energySamples: input.energy.length,
    sections: input.sections.map((s, i) => ({ startMs: s.startMs, endMs: s.endMs, role: input.roles[i].role })),
    planHeroes: plan.heroes, planNotes: plan.notes,
  },
  limits: 'Elapsed times are incidental uncontrolled host/JIT observations. Pose rates/clearance are sampled every 100ms. Internal quality ratios and projection framing are not artistic acceptance. Neither transformed alternative is a complete reviewed production fix.',
  results,
};
await fs.writeFile(outputUrl, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ output: fileURLToPath(outputUrl), sourceUnchanged: true, results: results.map(({ name, success, error, meanQualityRatio, trace }) => ({ name, success, error, meanQualityRatio, emptyBeamEvents: trace.length, firstEmptyBeam: trace[0] })) }, null, 2));
assert.equal(results[0].success, false, 'Baseline should reproduce the failure');
assert.equal(results[1].success, false, 'Tracing alone must not change failure');
assert.equal(results[1].trace[0]?.rejects.candidates, 80);
assert.equal(results[1].trace[0]?.rejects.nextStation, 80);
assert.equal(results[2].success, true, 'Role-aware yaw diagnostic should succeed');
assert.equal(results[3].success, true, 'Upcoming-hero downgrade diagnostic should succeed');
```

#### reliability-repros.mjs

Original script SHA-256: `e13fd6bba5c78d991c79cdfe1cac2f6bcffcd724c10057e8228bfe6a09d62dd1`.

```javascript
// Run from any directory with:
// /home/aepler315/tools/node24/bin/node /absolute/task/path/work/repros/reliability-repros.mjs
// Read-only production imports plus existing test fakes. Writes only work/evidence.
import fs from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import * as cache from '../repository/src/audio/AnalysisCache.js';
import { createAudioSelection } from '../repository/src/audio/AudioSelection.js';
import { normalizeSourceMetadata } from '../repository/src/audio/SourceMetadata.js';
import * as sessionIdentity from '../repository/src/audio/AudioSessionIdentity.js';
import { fingerprintBuffer } from '../repository/src/audio/SongFingerprint.js';
import { GrooveFingerprint } from '../repository/src/sim/GrooveFingerprint.js';
import { ensureRidgeMusicSession, upgradeRidgeMusicSession } from '../repository/src/world/RidgeMotionHistory.js';
import * as opening from '../repository/src/audio/OpeningAnalysis.js';
import * as limits from '../repository/src/audio/loadLimits.js';
import { SongRecorder, MAX_RECORDING_BYTES } from '../repository/src/render/SongRecorder.js';
import { presetById, STAGE_W, STAGE_H } from '../repository/src/render/VideoExport.js';
import { MusicLibrary } from '../repository/src/library/MusicLibrary.js';
import { listTracks } from '../repository/src/library/LibraryDB.js';
import { fakeIdb } from '../repository/test/helpers/fakeLibraryIdb.js';

const rows = [];
const record = (value) => { rows.push(value); console.log(JSON.stringify(value)); };
const read = (path) => fs.readFileSync(new URL('../repository/' + path, import.meta.url), 'utf8');
const main = read('src/main.js');

// R2: exact real upload orchestrator, original test harness browser/audio boundaries.
const loadSource = main.slice(main.indexOf('async function resolveLyricsForAudio('), main.indexOf('\nfunction handleFile('));
const loadTest = read('test/audioLoadLifecycle.test.js');
const harnessSource = loadTest.slice(loadTest.indexOf('const element ='), loadTest.indexOf("test('accepting an upload"));
const outer = vm.createContext({ ...cache, ...sessionIdentity, ...opening, ...limits,
  cache, opening, sessionIdentity, createAudioSelection, normalizeSourceMetadata,
  fingerprintBuffer, GrooveFingerprint, ensureRidgeMusicSession, upgradeRidgeMusicSession,
  vm, loadSource, console, AbortController });
vm.runInContext(harnessSource, outer);
const { context } = vm.runInContext('harness()', outer);
let offered = false, analyzed = false, resolved = false, finishCache;
context.getBundle = () => new Promise(resolve => { finishCache = resolve; });
context.audioToTimeline = async () => { analyzed = true; return { timeline: [], barGrid: [], durationMs: 2000 }; };
context.offerWorldsThenStart = () => { offered = true; };
const loading = context.loadAudioFiles([{ name: 'sample.wav', arrayBuffer: async () => new ArrayBuffer(1024) }])
  .then(() => { resolved = true; });
await new Promise(resolve => setTimeout(resolve, 50));
record({ repro: 'healthy analysis withheld behind optional cache', analyzed, offered, loadResolved: resolved });
context.audioSelections.cancel();
await new Promise(resolve => setTimeout(resolve, 25));
record({ repro: 'abort does not settle stalled cache load', loadResolved: resolved });
finishCache(null); await loading;

// R2: an IndexedDB request may succeed after having emitted blocked.
let closeCount = 0, req;
const db = { close() { closeCount++; } };
const blockedScope = { indexedDB: { open() { req = {}; queueMicrotask(() => req.onblocked()); return req; } } };
const cacheResult = await cache.getBundle('k', blockedScope);
req.result = db; req.onsuccess();
record({ repro: 'blocked cache open then late success', result: cacheResult, dbCloseCount: closeCount });

// Recorder test fakes; bytes are real tiny Blobs, counter is injected near cap.
const recorderTest = read('test/songRecorder.test.js');
const recorderHelpers = recorderTest.slice(recorderTest.indexOf('const H264 ='), recorderTest.indexOf("test('terrain preparation"));
const recorderSandbox = vm.createContext({ SongRecorder, MAX_RECORDING_BYTES, presetById, STAGE_W, STAGE_H,
  Blob, Uint8Array, queueMicrotask, console });
vm.runInContext(recorderHelpers, recorderSandbox);
const { stage, scope } = vm.runInContext('({stage,scope:fakeScope({chunkOnStart:false})})', recorderSandbox);
let rec, stopped;
rec = new SongRecorder({ stage, scope, onAutoStop: () => { stopped = rec.stop(); } });
rec.start();
const mr = scope.recorders[0];
mr.ondataavailable({ data: new Blob(['HEAD']) });
rec.bytes = MAX_RECORDING_BYTES - 2;
mr.stop = function () { this.state = 'inactive'; this.ondataavailable({ data: new Blob(['MOOV']) }); this.onstop(); };
mr.ondataavailable({ data: new Blob(['CROSSING']) });
const recorderResult = await stopped;
record({ repro: 'cap removes crossing and final chunks', returned: !!recorderResult,
  resultText: await recorderResult.blob.text(), error: rec.error, resultError: recorderResult.error ?? null });

// R4: exact user toggle function plus actual recorder duration implementation.
const pauseScope = vm.runInContext('fakeScope({chunkOnStart:false})', recorderSandbox);
const pauseRec = new SongRecorder({ stage, scope: pauseScope });
pauseRec.start();
pauseScope.recorders[0].ondataavailable({ data: new Blob(['FRAME']) });
pauseScope.advance(1000);
let suspended = 0, resumed = 0;
const transport = vm.createContext({ running: true, sim: {},
  audioEngine: { ctx: { suspend() { suspended++; }, resume() { resumed++; } } },
  renderPlayback: { status: 'ready' }, paused: false, playbackPreparing: false,
  playbackCadence: { reset() {} }, presentedFps: { reset() {} },
  resumeRecordingAfterTerrain() {}, updatePauseButtonUI() {}, songRecorder: pauseRec });
vm.runInContext(main.slice(main.indexOf('function togglePause()'), main.indexOf('/** Leave the native top layer')), transport);
transport.togglePause(); pauseScope.advance(5000);
const stateDuringPause = pauseScope.recorders[0].state;
transport.togglePause(); pauseScope.advance(1000);
const pauseResult = await pauseRec.stop();
record({ repro: 'user playback pause does not pause recorder', stateDuringPause,
  contextSuspendCalls: suspended, contextResumeCalls: resumed, expectedActiveDurationMs: 2000,
  recorderDurationMs: pauseResult.durationMs });

// R1: both synchronous iterator loss and realistic asynchronous getFile failure.
for (const mode of ['iterator', 'getFile']) {
  const bytes = new Uint8Array(64);
  const file = { name: 'song.mp3', size: bytes.length, lastModified: 1,
    slice: () => ({ arrayBuffer: async () => bytes.slice().buffer }) };
  let denied = false;
  const accessError = () => Object.assign(new Error('access denied'), { name: 'NotAllowedError' });
  const handle = { name: 'Music', queryPermission: async () => 'granted', values() {
    if (denied && mode === 'iterator') throw accessError();
    return (async function* () { yield { kind: 'file', name: 'song.mp3', getFile: async () => {
      if (denied && mode === 'getFile') throw accessError(); return file;
    } }; })();
  } };
  const libraryScope = fakeIdb(); libraryScope.showDirectoryPicker = async () => handle;
  const library = new MusicLibrary({ scope: libraryScope });
  await library.pickFolder(); await library.notePlayed(library.tracks[0], 90);
  const rootId = library.root.id, before = await listTracks(rootId, libraryScope);
  denied = true;
  let error = null;
  try { await library.rescan(); } catch (reason) { error = reason.message; }
  const after = await listTracks(rootId, libraryScope);
  record({ repro: mode === 'iterator' ? 'inaccessible iterator treated as completed empty scan'
    : 'file getFile access error treated as missing and pruned',
    before: before.map(t => ({ path: t.path, playCount: t.playCount, durationSec: t.durationSec })),
    after, rescanError: error, rootStillPresent: !!library.root });
}

// R5: one synthetic host-only measurement, no browser/phone inference.
const samples = Float32Array.from({ length: 8000 * 60 }, (_, i) => Math.sin(i * .217) * (.3 + .1 * Math.sin(i * .00071)));
const buffer = { sampleRate: 8000, length: samples.length, numberOfChannels: 2, duration: 60, getChannelData: () => samples };
const fp = fingerprintBuffer(buffer), started = performance.now();
let timer = false;
setTimeout(() => { timer = true; }, 0);
cache.analysisCacheKey(fp, { stems: Array.from({ length: 4 }, (_, i) => ({ name: `stem-${i}.wav`, buffer })) });
record({ repro: 'synchronous stem cache fingerprints', stems: 4, secondsPerStem: 60, sampleRate: 8000,
  keyCallMs: +(performance.now() - started).toFixed(1), timerCouldRunBeforeReturn: timer,
  scope: 'synthetic Node on this host; not browser or phone measurement' });

// R6: exact failed initialization branch, fake engine records context ownership.
const bootSource = main.slice(main.indexOf('async function bootAudioOnce()'), main.indexOf('let soundfontsInFlight'));
let created = 0, closed = 0;
class FakeAudioEngine {
  constructor() { created++; this.ctx = { close() { closed++; } }; }
  async resume() { return false; }
}
const bootContext = vm.createContext({ audioEngine: null, AudioEngine: FakeAudioEngine, applyBtLatencyToAudioEngine() {} });
vm.runInContext(bootSource, bootContext);
for (let i = 0; i < 3; i++) { try { await bootContext.bootAudioOnce(); } catch {} }
record({ repro: 'failed boot attempts discard without closing', attempts: 3,
  contextsCreated: created, contextsClosed: closed, engineForgotten: bootContext.audioEngine === null });

const evidence = { sourceSha: '8f7c10fecdb9c436f7e789ec094c79efe88eff31',
  runtime: process.version, platform: process.platform, architecture: process.arch,
  scope: 'Production functions imported or exact source extracted; browser/audio/IDB boundary fakes. No browser execution.',
  script: 'work/repros/reliability-repros.mjs', results: rows };
fs.writeFileSync(new URL('../evidence/reliability-repros.json', import.meta.url), JSON.stringify(evidence, null, 2) + '\n');
```

#### rendering-repros.mjs

Original script SHA-256: `169b85dc755070360bc61e69d8eafc2949a8fa174e45878da6a70a549d5a2f33`.

```javascript
// Read-only source reproductions. Execute from any directory with Node 24.
import { performance } from 'node:perf_hooks';
import { buildCloudTexture } from '../repository/src/world/alpine/RangeCloudTexture.js';
import { RangeSkyRenderer } from '../repository/src/world/alpine/RangeSkyRenderer.js';
import { hexToLinear } from '../repository/src/world/alpine/MaterialPackage.js';
import { RangeScene } from '../repository/src/world/alpine/RangeScene.js';
import CATALOG from '../repository/src/world/terrain/sceneCatalogData.js';
import { cloudBanks } from '../repository/src/world/alpine/RangeCloudField.js';
import { scenePoseAt } from '../repository/src/world/terrain/SceneTravel.js';

const result = {
  metadata: { sourceSha: '8f7c10fecdb9c436f7e789ec094c79efe88eff31', node: process.version,
    platform: process.platform, runAtUtc: new Date().toISOString(), gpuUsed: false,
    limitation: 'Local CPU durations in a concurrent environment. Mocked rendering counts execute actual source branches but do not measure GPU rendering or real Canvas paint.' },
};
const cloudMs = []; let checksum = 0;
for (let i = 0; i < 8; i++) {
  const started = performance.now();
  const pixels = buildCloudTexture(12345 + i * 71);
  cloudMs.push(performance.now() - started);
  checksum += pixels.reduce((sum, value) => sum + value, 0);
}
const ordered = [...cloudMs].sort((a, b) => a - b);
result.cloudBuilder = { width: 192, height: 128, uniqueSeeds: 8, cloudMs,
  medianMs: (ordered[3] + ordered[4]) / 2, checksum,
  limitation: 'Pure RGBA builder only. JIT becomes warmer during the sequence; this does not simulate browser cached Canvas work.' };

// This isolates the actual cache branch without a browser or GPU. The context
// owns real typed image bytes but putImageData is deliberately a no-op.
const cloudCanvases = new Map();
const cached = {
  seed: 12345, cloudCache: new Map(), painted: new WeakSet(),
  buffers: {
    ensure(key, width, height) {
      if (!cloudCanvases.has(key)) cloudCanvases.set(key, {
        width, height, getContext: () => ({
          createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {},
        }),
      });
      return cloudCanvases.get(key);
    },
    release(key) { cloudCanvases.delete(key); },
  },
};
let started = performance.now();
RangeSkyRenderer.prototype._cloud.call(cached, 17);
const cacheMissMs = performance.now() - started;
started = performance.now();
for (let i = 0; i < 10000; i++) RangeSkyRenderer.prototype._cloud.call(cached, 17);
result.cloudCache = { cacheMissMs, cacheHitIterations: 10000,
  cacheHitTotalMs: performance.now() - started, ownedMockCanvases: cloudCanvases.size,
  limitation: 'Mock Canvas context; validates source cache work only and excludes real Canvas/GPU transfers.' };

result.gammaRoundTrip = [1, 5, 16, 32, 64, 128].map(input => {
  const channel = input.toString(16).padStart(2, '0');
  const linear = hexToLinear(`#${channel.repeat(3)}`)[0];
  const shaderRoundTrip = Math.pow(linear, 1 / 2.2) * 255;
  return { input, linear, shaderRoundTrip, errorCodeValues: shaderRoundTrip - input };
});

result.partitionBranchCounts = [];
for (const actorsVisible of [false, true]) {
  const scene = Object.create(RangeScene.prototype), calls = [];
  const camera = { layers: { mask: 1, set(n) { this.mask = 1 << n; }, enable(n) { this.mask |= 1 << n; } } };
  const prepared = { view: { id: 'audit' }, forest: { counts: { mesh: 1 } },
    actors: { groups: { midio: { visible: actorsVisible } } },
    uniforms: { uNarrativeInk: { value: 0 }, uBackdropAmount: { value: 0 }, uDiag: { value: 0 } },
    depthScene: 'depth', scenes: { far: 'far', mid: 'mid', near: 'near' } };
  Object.assign(scene, { prepared: new Map([['audit', prepared]]), sideTargets: {}, target: {}, camera,
    size: { width: 320, height: 180 }, depthCache: { A: { frame: -1, view: null } },
    stats: { depthPasses: 0, partitions: 0 }, renderer: { setRenderTarget() {}, setClearColor() {}, clear() {},
      render(name) { calls.push({ scene: name, layer: camera.layers.mask }); } } });
  for (const name of ['_setCamera', '_setUniforms', '_prepareMirror', '_updateForestDetail', '_setCanvasSize', '_copyTexture']) scene[name] = () => {};
  for (const pass of ['far', 'mid', 'near']) scene.renderPartition({ frameId: 42, qualityLevel: 6, viewFromId: 'audit' }, pass);
  result.partitionBranchCounts.push({ actorsVisible,
    wholeTerrainDepthCalls: calls.filter(call => call.scene === 'depth' && call.layer === 1).length,
    forestDepthCalls: calls.filter(call => call.scene === 'depth' && call.layer === 4).length,
    totalRenderCalls: calls.length, calls,
    limitation: 'Renderer is mocked; layer masks 1,2,4,8 mean layers0,1,2,3. No actual GPU, copies, mirror or per-scene draw count measured.' });
}

result.staticRailCloudCandidateCounts = CATALOG.views.filter(view => view.camera).map(view => {
  const pose = scenePoseAt(view, { progress01: .5, timeMs: 12000 });
  const options = { camera: { tourPose: { ...pose, aspect: 16 / 9 } }, width: 320, height: 180, timeSec: 12, seed: 12345 };
  const fair = cloudBanks(options).length, storm = cloudBanks({ ...options, storm: true }).length;
  return { view: view.id, fair, storm, total: fair + storm };
});
console.log(JSON.stringify(result, null, 2));
```

### Retained evidence inventory

All paths below are relative to the completed local output bundle. Checksums identify exact artifacts without adding generated captures or archives to Git history.

| Original artifact path | SHA-256 |
| --- | --- |
| `evidence/audit-summary.json` | `da09a7e033fac2ae63910214cb8addce6b32aa1c7f242e0066b92d4b64769a93` |
| `evidence/bootstrap.log` | `cab6f77f5bbdb81712554db21a771fea5cbd81ef8f10b9ee578c325b3c5899b6` |
| `evidence/github-history.json` | `033805be3904e7892fa3289bbbada877f08b0da682c6cd87bb957ede4d3cea2e` |
| `evidence/github-ref-final.json` | `5205d9839e0960b90e885fab2da2e7e1c013ef67430691921c797e920f44a175` |
| `evidence/github-tree.json` | `3cee8b11223ff051630b8c5b081c2c8558930ebdd40f4e2d8f892bf376ecb045` |
| `evidence/index.html` | `90485fb6abb2c59290aca7b26bb8019c3bd05e5ac1b0c797b7eb7138b59937f7` |
| `evidence/landscape-lake-rtx.log` | `681ef85cae3c6f53d9fa4afacf69446825ba40f5da5dc9ee6cad97ea37ff577f` |
| `evidence/landscape-lake-rtx/detailed/contact-sheet.png` | `a460141815b2754bd768e38550bc3154aefa58e2ecf2d0bb05f956eeb3ff0ae5` |
| `evidence/landscape-lake-rtx/detailed/index.html` | `5c8eed31c571c6bdc5fef9836bda85453602ea587948704ea5d3da1bad835c0d` |
| `evidence/landscape-lake-rtx/detailed/manifest.json` | `4afa0badc524aa5a8e1931903c30ae5afb02575a1b791e9faa4d59c230f262d0` |
| `evidence/landscape-lake-rtx/detailed/report.json` | `ab7c5995542ecca5b1c4c8c86f1275b3e47f7b0723fd0d978ddaf00f594fc153` |
| `evidence/landscape-lake-rtx/detailed/review-audio/audio.wav` | `c0160a5c95669def70cfe43feeca1c06b81117cf01f2b4e43d59f1ef59e02297` |
| `evidence/landscape-lake-rtx/detailed/review-audio/frame-00000.png` | `daf7da6288b47e494b0afe86a40a1076dc49f3741cb1a5588aa7b0d3e764ea3a` |
| `evidence/landscape-lake-rtx/detailed/review-audio/frame-00001.png` | `4d32b21ab0e13bb1b7ec3a1d850efb808122a8c03c49ef52a6c553f5618683b9` |
| `evidence/landscape-lake-rtx/detailed/review-audio/frame-00002.png` | `965734bd75d16e051fa22153e657727e00e2970fa6fe707cf5cef6c61c4568b0` |
| `evidence/landscape-lake-rtx/detailed/review-audio/frame-00003.png` | `965f7125598c9e183745c5461278ac720fd55712e69f658b86772a03a7cedee8` |
| `evidence/landscape-lake-rtx/detailed/review-audio/frame-00004.png` | `a4ea3e7a4800e90cbb01820fd328d0283bdc79866255a53bb36e12f8993c4735` |
| `evidence/landscape-lake-rtx/detailed/review-audio/frame-00005.png` | `0b0401489bbad7d8c8e20280a5ce3127a651aa8131bc092ee8c502e87cd27093` |
| `evidence/landscape-lake-rtx/detailed/review-audio/frame-00006.png` | `7c86b66825decedc133f0457671800ca3db90a7620c579e10396fa15859f9d71` |
| `evidence/landscape-lake-rtx/index.html` | `c44a9ad18fc8b559d7d6baddcd9caf6558e755d4b91b08113030f9b8c649f014` |
| `evidence/landscape-lake-rtx/input.wav` | `c0160a5c95669def70cfe43feeca1c06b81117cf01f2b4e43d59f1ef59e02297` |
| `evidence/landscape-lake-rtx/report.json` | `1c7b02477c537d779090d5edd863a17e4c7bdec4c850d3087f56bfe458bba77a` |
| `evidence/landscape-rtx.log` | `1823ded4ca107a1ef41492cd246df801ba5430eae15abe5eb008293811f0a524` |
| `evidence/landscape-rtx/classic/contact-sheet.png` | `f154ee65ca53d3ef0df9e3f7eb21668ac7b91f024539a61f771810fd976ece19` |
| `evidence/landscape-rtx/classic/index.html` | `99574a2f8a8f152c1f2c2d267f238bff7242327c9081ed64587fa335db0842b1` |
| `evidence/landscape-rtx/classic/manifest.json` | `bd8b44d7206e59c9cbc18aac6a94f24a2434e434d734c0443efe625de75c4e88` |
| `evidence/landscape-rtx/classic/report.json` | `a4bea6d72814751ac6cfd8cc0a5d6fcb8473fec74adefb1875db7cdd53948a30` |
| `evidence/landscape-rtx/classic/review-audio/audio.wav` | `c0160a5c95669def70cfe43feeca1c06b81117cf01f2b4e43d59f1ef59e02297` |
| `evidence/landscape-rtx/classic/review-audio/frame-00000.png` | `cc329894088275b9107b697fa5cd6411428eedb6a551601cb649a0fd0f1a9896` |
| `evidence/landscape-rtx/classic/review-audio/frame-00001.png` | `dd12745d25820c9a161aa6c482ad5dc36f675838e662275a64f4642b78135045` |
| `evidence/landscape-rtx/classic/review-audio/frame-00002.png` | `d21fc18f9bcbd305327e11c9e4ebc11027883b80cc5a9237af5237a2cbd05c22` |
| `evidence/landscape-rtx/classic/review-audio/frame-00003.png` | `8ed45312f42aeed99c0e13a6607c51d43810ac9357106d0136bbdeebecced082` |
| `evidence/landscape-rtx/classic/review-audio/frame-00004.png` | `f457ebc32b7919861659e99a29c505afaee140dcc86a1b3c38131d6e27a19274` |
| `evidence/landscape-rtx/classic/review-audio/frame-00005.png` | `05cad6263f6677ee0be76b09f3809a05e73051ed6ba48e5ff648da02bfa0102c` |
| `evidence/landscape-rtx/classic/review-audio/frame-00006.png` | `c1ffe9f47be430d2e6e715d8e96f8872fa8d796559298c93032acd49102fce8d` |
| `evidence/landscape-rtx/detailed/contact-sheet.png` | `52448fa225456620e39be8d73d6b5742ca70dab627639f2263f64c47e0e8c68d` |
| `evidence/landscape-rtx/detailed/index.html` | `99574a2f8a8f152c1f2c2d267f238bff7242327c9081ed64587fa335db0842b1` |
| `evidence/landscape-rtx/detailed/manifest.json` | `7d2c11ebce68907d1f7f784948c5593ed379b9eff3521b4f92455fa96290300d` |
| `evidence/landscape-rtx/detailed/report.json` | `cb59bda4bf47c4754ae5d75d603a0d04d27899d80692d16d1635b3fb2bc495cd` |
| `evidence/landscape-rtx/detailed/review-audio/audio.wav` | `c0160a5c95669def70cfe43feeca1c06b81117cf01f2b4e43d59f1ef59e02297` |
| `evidence/landscape-rtx/detailed/review-audio/frame-00000.png` | `e0110582663b3b04a668fe50b19b39fac715fb0cc396acff2300b37bdc978d9c` |
| `evidence/landscape-rtx/detailed/review-audio/frame-00001.png` | `9e89e31d3cf31473932692996e3286d729f924ff8ed42d425651077e0cca4cf1` |
| `evidence/landscape-rtx/detailed/review-audio/frame-00002.png` | `3375cd699277e29c10ce8c10147ac5896cce3fda5bfd941e4673b2dae8bb5932` |
| `evidence/landscape-rtx/detailed/review-audio/frame-00003.png` | `ffa6cd3066ecc5feec30800df6456328c49a1c8c45fa851ac73a8e3a6d68d66b` |
| `evidence/landscape-rtx/detailed/review-audio/frame-00004.png` | `1a0db06c13e479ce2af716a92c92c8bc556728de8b3e67caf17b3fbe059507db` |
| `evidence/landscape-rtx/detailed/review-audio/frame-00005.png` | `1bbf4cbe39773c4c4ff428164629edbcc0e97c5ee1e80f976f217ccc6eadb2f1` |
| `evidence/landscape-rtx/detailed/review-audio/frame-00006.png` | `f615bd669dba141ed03eca8f56d3fbfa8d9f55a8ab34f543343d1d676e84cdee` |
| `evidence/landscape-rtx/index.html` | `c7c6331bf2b36901cfe86d7abb0b79d8c4b99e1f171314dacec0b990e2578a3c` |
| `evidence/landscape-rtx/input.wav` | `c0160a5c95669def70cfe43feeca1c06b81117cf01f2b4e43d59f1ef59e02297` |
| `evidence/landscape-rtx/live-report.json` | `77948e848218ef63fb376bf0f8f17499754cc2cca676d07cecb5436ce0d9930b` |
| `evidence/landscape-rtx/report.json` | `13cfaa6c28a899fb2a92c3afd1cd1637c1568e0325321e7b5f3dc583b446a429` |
| `evidence/landscape-software-v2.log` | `3aed1cfb87be982ca118df49456304b6c716d3fec7ed3bac0f823c68c37aeed8` |
| `evidence/landscape-software-v2/classic/contact-sheet.png` | `b7c13b11bfd7dc64f94d14381f3106e5c559cfbc0a713683560b0f609f8d2dad` |
| `evidence/landscape-software-v2/classic/index.html` | `e595c0789694858e93c989c73b4622c85914aebbdbd77f2ef8b26ebbda27e05b` |
| `evidence/landscape-software-v2/classic/manifest.json` | `bd8b44d7206e59c9cbc18aac6a94f24a2434e434d734c0443efe625de75c4e88` |
| `evidence/landscape-software-v2/classic/report.json` | `95feee084971c6991db14c0118981a81035a341ac51b02f09fae70ea7dd85088` |
| `evidence/landscape-software-v2/classic/review-audio/audio.wav` | `c0160a5c95669def70cfe43feeca1c06b81117cf01f2b4e43d59f1ef59e02297` |
| `evidence/landscape-software-v2/classic/review-audio/frame-00000.png` | `64c411b5613e9d84ff478e84e4ab2c22a51d1a01f74b347e5dd3a8b617d1ce6d` |
| `evidence/landscape-software-v2/classic/review-audio/frame-00001.png` | `35b56a5e063cc76b7b2da6fb07f41aea771467c04f1cde501d78bc31feddbb9e` |
| `evidence/landscape-software-v2/classic/review-audio/frame-00002.png` | `cdaafd8ad9af9e1ccf1dbf77fc90d240186b662474078b914c8c6f9f71da0417` |
| `evidence/landscape-software-v2/classic/review-audio/frame-00003.png` | `3c41eac7b381b54f57ee82703922671948c2707f8f3948ccea115421051f07df` |
| `evidence/landscape-software-v2/classic/review-audio/frame-00004.png` | `257f42581ffe16d0ac25c50786d754905066d80fa849b0c68b919f0155a0f570` |
| `evidence/landscape-software-v2/classic/review-audio/frame-00005.png` | `575b0c36de0367d11df67d0001637ba7760a776668ca27dc063f9445b570240b` |
| `evidence/landscape-software-v2/classic/review-audio/frame-00006.png` | `6c0e21637c6be4a7c6147e827b31904e5d090afcbadfa9b40c131e47480aee7f` |
| `evidence/landscape-software-v2/detailed/contact-sheet.png` | `892516a5fc4b53c7ba0d279fe55b55fab3a04a23ae160c7a451a3270ee87463b` |
| `evidence/landscape-software-v2/detailed/index.html` | `56d0fd3c2831a3c1b1099386ec8041dc90bbcf955b85720901c5ae5b918048f5` |
| `evidence/landscape-software-v2/detailed/manifest.json` | `7d2c11ebce68907d1f7f784948c5593ed379b9eff3521b4f92455fa96290300d` |
| `evidence/landscape-software-v2/detailed/report.json` | `1dbc872124a1b2bdaf9b2b7fda2d210f80a626211d5ffac5b5dc3734cdb42e08` |
| `evidence/landscape-software-v2/detailed/review-audio/audio.wav` | `c0160a5c95669def70cfe43feeca1c06b81117cf01f2b4e43d59f1ef59e02297` |
| `evidence/landscape-software-v2/detailed/review-audio/frame-00000.png` | `07f3c8e35791f58ef401fc424118c765b9cb4f363514172cb97bcd83981c8816` |
| `evidence/landscape-software-v2/detailed/review-audio/frame-00001.png` | `c026ebb303be307d5ab58c5158d34630f334c4d492a016b1c361901e60697bc8` |
| `evidence/landscape-software-v2/detailed/review-audio/frame-00002.png` | `138a96c1394c77644e89a75e5da342a618d7e8a80c441ed6cf57c8f2bef1091e` |
| `evidence/landscape-software-v2/detailed/review-audio/frame-00003.png` | `3c61d158fcf508b03344d3af9a9f2159f6108b5ee518cba5c0320928c2578b19` |
| `evidence/landscape-software-v2/detailed/review-audio/frame-00004.png` | `1f9fdd2e27bef8b9ff64854f54232d14f2885e78331f4a4c14fa648d930149ca` |
| `evidence/landscape-software-v2/detailed/review-audio/frame-00005.png` | `a11e604ad6ecf7e7478d39af02333ac651329083315238a57dc9d287cc51b072` |
| `evidence/landscape-software-v2/detailed/review-audio/frame-00006.png` | `f7e4bae58c0ba13c909854a6b57c7807f6d707be3e3b8e298a745cb927dc7e28` |
| `evidence/landscape-software-v2/index.html` | `426521982b92c702fc677799f4e57f955a40f14b2a63b734dfe6411e287cd6ba` |
| `evidence/landscape-software-v2/input.wav` | `c0160a5c95669def70cfe43feeca1c06b81117cf01f2b4e43d59f1ef59e02297` |
| `evidence/landscape-software-v2/report.json` | `38d86bc90ea022c2d1c769403b9631e2907f55dc73996698f9a9aeb06d9c2341` |
| `evidence/landscape-software.log` | `241c7d32619d8f8c275ce6f99853beb8c434b1a6863d7c7a0e88d30cb75c27da` |
| `evidence/landscape-software/index.html` | `6e43d0e5d47852b9f71db67f42e64cb4b9ec11db14bdebb17b4cdca12810887b` |
| `evidence/landscape-software/report.json` | `c3212fc12164238b5969871d8e10ee5d69801ba95a0b7138d0be47a6527869cc` |
| `evidence/lint.log` | `e88a330e43e94d225537b8996e8937ff952ca169dcbd3a5f733b77b31285e84f` |
| `evidence/reliability-repros.json` | `fe2cded743e376af24070d0af51df87192ead7506eed4f0c2047ad2912c3ce19` |
| `evidence/rendering-repros.json` | `b60e33216dca9925ff5fc329c405ff56b13bc201e29bca1f48b6998ed15fdeda` |
| `evidence/repros/README.txt` | `2701a1a05ceb4afb73a149835d301dab8ffc46b5824f4d780c62bb2eb9b931f5` |
| `evidence/repros/reliability-repros.mjs` | `e13fd6bba5c78d991c79cdfe1cac2f6bcffcd724c10057e8228bfe6a09d62dd1` |
| `evidence/repros/rendering-repros.mjs` | `169b85dc755070360bc61e69d8eafc2949a8fa174e45878da6a70a549d5a2f33` |
| `evidence/repros/static-live-probe.mjs` | `78a3d92ba657b2bd7d729dd62eb90d2a8cb4775ea3729ae3c3ab2113f4565a38` |
| `evidence/repros/tour-differential-replay.mjs` | `b373deaeeaa982ee70beff006011c3f090d0c6c6e98d81d833e174278bc18b9e` |
| `evidence/repros/tour-minimal-repro.mjs` | `db0f49d1fb4635f97fba712fc93439692170401bcb61216b14a53ba549e79f28` |
| `evidence/repros/tour-probe.mjs` | `b7933b4418cadae312d10a85a2194d252338a1a5df0bf95f89e6c730fccc7912` |
| `evidence/repros/windows-loader.mjs` | `427bb51635b327e305aaff38970cb192d1cba1ba9659328173f463c7cf8880ab` |
| `evidence/review-notes/architecture-audit.md` | `c548ff6d3c14af30b3f0a960856de5fd1f968290102f25bcfeecd30b1fe36ec9` |
| `evidence/review-notes/reliability-audit.md` | `f79e0075da673cfd4ae6a5df82223ae56d76db7eca80cb1bab56711f6ff82a68` |
| `evidence/review-notes/rendering-audit.md` | `3f193d5ddd7bb1c4c02d79cc8bdd30a3c9701b0548ab08a1f2167a1dd0e43aa6` |
| `evidence/source-verification-final.json` | `efb21b2a23ab6249ae628ae474b265a190fa3ba9bfb4c511e42b27d5256a2094` |
| `evidence/source-verification.json` | `78da21c3ca8739ee5607352c3bc7867c2b01ef43e103ca1c01dc7d21b02a3b5d` |
| `evidence/stage.log` | `18586e56c3e9f1ccb35e7b30bd05522354ba943f17a4c1a3d3288310d595d5aa` |
| `evidence/static-live-rtx-concurrent.json` | `853db8f7c28b7053a88dfd9da93a2ee9f7c35a5b6df2702162d4dd567c063ad7` |
| `evidence/static-live-rtx-concurrent.log` | `1266d9133a5392f41220b32a2625f5ca635ee9f00c746a36eb53f5fbf075456d` |
| `evidence/static-live-rtx.json` | `446ce5f055e615796fc85bd2dcd4c5ae4a54f513b50e963bace96a18fad7ac12` |
| `evidence/static-live-rtx.log` | `26464075b354d3db5d0940b67e643d2696f6d1db88b4cb85fe393acedb79312e` |
| `evidence/tests.log` | `155cea7e232e1302b35a49fbd696b2ddbf198ea100f2211db59a8de80e8d729c` |
| `evidence/tour-differential-replay.json` | `3e64a5041d1ba1461e504d12a6ab17276db1d3a42ee57709e4967dba8184a73c` |
| `evidence/tour-differential-replay.log` | `89b9ed8e0e4817e631c4472bd2ef61afbb919466ddf5e4452bf8747dda282ab1` |
| `evidence/tour-minimal-repro.json` | `8395be61a8b0a7e7fcc8c6f27e7768e942823277418089f758db89767173edc7` |
| `evidence/tour-probe.json` | `6ce8bfbeee224602fba22896b4b64645d19457fa51063508de3f87bb446a3e24` |
| `evidence/tour-probe.log` | `09bbdb319bbba70580bfd795f7235108172f088d66436a9135afa7c4fcef7c7a` |
| `midio-pixel-prioritized-roadmap.csv` | `bbb8baf5c0463929cb34af7aca5f4147d5e051d8d7860258434c4bb2087d3a2c` |
| `midio-pixel-technical-audit.html` | `26dbe3185c076f7651f3fb0f16f670d8d0284212ec046aad6a5a57f72918711e` |
| `midio-pixel-technical-audit.md` | `9f8bb615b518b29ba2c3f9dfad5fe8eae003f34b1c1ce41a2756dab622fd282c` |
