# midio-pixel — technical audit and implementation roadmap

> **Publication note.** This is the complete previously concluded investigation, published without re-auditing the repository or changing application code. Its findings and measurements remain pinned to the audited SHA above. The publication parent is that same commit. All 27 finding IDs, their confidence/disposition, source references, technical analysis, alternatives, validation procedures, and the full implementation roadmap are preserved.
>
> Original audit-local evidence links now lead to the evidence register below. The register preserves artifact identities, SHA-256 hashes, measurements, reproduction output, and reproduction source. Raw image/audio captures, HTML reports, and capture JSON remain outside Git in accordance with `AGENTS.md`; they are not remotely downloadable through this Markdown. Hashes identify retained evidence but do not substitute for examining those artifacts. No claim is made that raw captures were uploaded or that artistic acceptance was completed.


**Read-only audit · 20 October 2026 · `aepler315/midio-pixel`**

**Audited commit:** [`8f7c10fecdb9c436f7e789ec094c79efe88eff31`](https://github.com/aepler315/midio-pixel/commit/8f7c10fecdb9c436f7e789ec094c79efe88eff31)
**Git tree:** `47c19e2fc48dbd9594684dd6b9fe99989a431d8a`
**Runtime snapshot SHA-256:** `48e26ef1e214c0df19642074b06fc3e575c998f9e4cae972009e19bedfd2c9e4`

## Assessment

The strongest immediate work is protecting library history and batch exports, making the remaining whole-recording calculations cooperative, and closing asynchronous cleanup holes. These findings have concrete reproductions or directly traced execution paths. They deserve attention ahead of an expensive renderer replacement.

The rendering system already contains substantial engineering: streamed terrain, instanced forest representations, bounded residency, deterministic audio-driven simulation, readiness gates, planar water reflection, analytic atmosphere, and a deliberately hybrid pixel-foreground/smooth-sky presentation. The best graphical advance would be **consistent light and weather across terrain, trees, water, and atmosphere**, followed by more geographically appropriate forest silhouettes. Increasing resolution or adding generic anti-aliasing would not address those limitations.

This audit identifies six reliability findings, eight CPU/asynchronous/resource findings, eight graphical opportunities or inconsistencies, and five measurement/architecture/validation findings. Four reliability mechanisms have narrow reproductions; two are ownership gaps exposed by controlled completion-order injection whose native IndexedDB reachability remains unconfirmed. Some findings share an implementation package. Priorities express expected impact and evidence strength, not a claim that every issue occurs frequently in production. No P0 outage, exploitable security vulnerability, or reproduced numerical rendering corruption is asserted.

The full root test suite passes despite the reproduced lifecycle and persistence holes. That makes focused interleaving tests and durable-state assertions especially valuable. Technical capture success also remains separate from musical or artistic acceptance.

## Scope, provenance, and evidence standard

GitHub main was resolved through the authenticated repository connection. The existing local development checkout was behind that revision and contained unrelated working-tree changes. It was left untouched. An isolated audit snapshot was reconstructed from committed content and verified against **all 1,518 Git blob hashes** in the pinned remote tree, with zero mismatches. The hardware harness used a separately frozen, hash-verified runtime snapshot rather than the development checkout. Dependency installation, temporary tests, staging, logs, and captures stayed in the audit workspace. No application source was edited, no PR was created, and no hosted validation or deployment was dispatched.

Evidence categories used throughout:

| Category | What it establishes | What it does not establish |
|---|---|---|
| **Measured** | An observed result in the stated runtime, input, and configuration | Other hardware, other songs, physical-display cadence, or a performance improvement after a proposed fix |
| **Reproduced mechanism** | Actual production functions fail under a controlled input/interleaving or injected dependency failure | How often physical storage, native audio, or browser scheduling produces that condition |
| **Code-supported** | The current executable call chain or shader establishes the behavior | Perceptual severity, user incidence, or an exact latency |
| **Hypothesis / opportunity** | A plausible direction supported by implementation constraints | A proven bottleneck or guaranteed artistic improvement |

Source citations use immutable commit URLs and line spans. Reproductions and raw validation results are retained in the accompanying evidence directory. The investigation traced upload/analysis/cache publication, local-library scan/persistence, render preparation and partition composition, terrain-window requests, recording/export naming, and wake-lock lifecycle. It reviewed relevant recent history and tests. This was not an exhaustive review of every optional server adapter, all third-party code, every supported browser, or every musical/landscape combination.

### What the current architecture does

| Layer | Current responsibilities and important boundaries |
|---|---|
| Application/session orchestration | `main.js` binds file input, library, playback, settings, analysis, renderer preparation, recorder/export, and diagnostics. Selection tickets and generations already guard many stale asynchronous completions. |
| Analysis | Web Audio decodes selected files; stems may be mixed; fingerprint/cache lookup runs alongside analysis; band envelopes, pitch workers, rhythm/structure, and opening-first preparation produce the simulation timeline. Several full-buffer stem passes remain synchronous. |
| Time and simulation | Audio/heard time is authoritative. Fixed stepping and draw cadence are separate. Long background gaps collapse rather than causing unlimited catch-up. Paused redraw and offline capture have explicit behavior. |
| World composition | The Canvas renderer and `BiomeManager` orchestrate scenery, characters, weather and painter ordering. Alpine uses `RangePresentation` and `RangeScene` for WebGL2 terrain, forest, depth consumers and reflections; legacy fallback remains explicit. |
| Terrain preparation | Manifest/data preparation, conservative coverage planning, resource admission, workers, geometry/forest construction, shader preparation and readiness publication form a multistage pipeline. Generations, pins, bounded caches and retained reservations protect ownership. |
| Presentation | `PresentingRenderer` renders a Classic 320×180 or Detailed 640×360 foreground. Pixel preserves unrestricted colors; Palette quantizes the native foreground. Alpine's smooth, full-color sky is composited at output resolution. Nearest-neighbor terrain and zero-MSAA product policy are intentional. |
| Capture/export | Capture is unavailable until a complete frame succeeds. The recorder reproduces the hybrid picture at encoded dimensions; export freezes session settings. Batch output names are constructed separately and currently lack collision safety. |
| Storage/resources | IndexedDB stores analysis and local-library metadata. GraphicsResidency accounts admitted graphics resources; this is not total browser/process memory. Audio copies and native analysis buffers have separate, incomplete aggregate accounting. |

Key execution paths:

```text
Local file or stem selection
  → selection ticket / generation → decode and admission
  → mix + fingerprint/cache lookup + timeline analysis
  → current-owner publication → terrain/render readiness → audio/playback

Audio/heard time → bounded fixed simulation → draw cadence
  → native foreground → Canvas painter layers / Range GPU partitions
  → optional native Palette transform
  → output-resolution smooth sky + foreground → completed-frame capture

Library init/pick/rescan
  → root identity → directory enumeration → metadata carry-forward
  → IndexedDB update/prune → visible listing
```

Representative source anchors: [src/main.js:2537–2684](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/main.js#L2537-L2684), [src/main.js:3347–3414](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/main.js#L3347-L3414), [src/core/FixedStepClock.js:19–27](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/core/FixedStepClock.js#L19-L27), [src/render/PresentingRenderer.js:32–78](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/render/PresentingRenderer.js#L32-L78), [src/render/PixelPresentation.js:203–225](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/render/PixelPresentation.js#L203-L225), [src/world/alpine/RangeScene.js:600–677](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangeScene.js#L600-L677), [src/world/alpine/RangeScene.js:1848–1933](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangeScene.js#L1848-L1933), and [src/library/MusicLibrary.js:74–84](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/library/MusicLibrary.js#L74-L84).

### History that changes how findings should be interpreted

The recent history includes cloud parallax and shape repairs (PRs 15–16), Classic/Detailed grid and forest-retention work (PR 14), terrain planning/admission/backoff work (PRs 12–13), and earlier water/forest/camera/sky continuity repairs (PR 7). Those fixes are present in this snapshot. Their historical symptoms are not automatically current defects. See the [retained recent commit list](#publication-evidence-01).

The change to local validation and manually dispatched hosted tests is explicit in [commit 51dae09](https://github.com/aepler315/midio-pixel/commit/51dae09ffb673c2b26317219c5530973eb48fb33). A missing automatic hosted test run is therefore not itself a regression. Some documents still describe the earlier policy; A05 addresses that contradiction. No finding below claims an introducing commit without a historical reproduction or bisect.

## Diagnostics and observed results

| Check | Observed result | Scope and qualification |
|---|---|---|
| Pinned source verification | 1,518/1,518 blobs match; zero mismatches | Committed snapshot, not the unrelated development working tree |
| Root `npm test` | **4,795 pass, 0 fail, 6 skipped**, 338.1 s | Node 24.10.0 on WSL/Linux; 4,801 tests counted, three suites |
| `npm run lint` | Passed, exit 0 | Static lint gate |
| Ridgeview tests | **26 pass, 0 fail** | Separate companion package |
| Site staging + staged bootstrap | Passed | Actual staged allowlist loads; Browse opens the file chooser in headless Chromium |
| `npm audit --json` | Zero reported vulnerabilities | Advisory database result for locked dependencies; not proof of application security |
| Reliability probes | Four reproduced mechanisms plus two completion-order ownership leads; three export-collision pairs | Real modules with controlled dependencies; R-02/R-04 native-IDB reachability unconfirmed; no destructive real export |
| Pitch-worker failure probe | Worker remains alive after analysis rejects; manual abort terminates it | Injected OfflineAudioContext allocation failure |
| Fixed-clock RTX 3060 capture | Classic and Detailed each passed 25-frame capture plus paused lifecycle/absence checks | 1280×720 output; 12–14 s of generated contrast fixture; fixed 12 fps sampling is not live FPS |
| Five-minute live RTX trace | See live-trace section below | Separate real upload/playback path, isolated headless browser |

The actual hardware renderer string was **ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)**. Browser version and full controls are in the capture reports. The images show coherent pixel terrain under the smoother sky at the sampled times; Detailed provides finer forest/terrain structure. They do not directly render the low-sun, ridge-occluded fixtures needed to validate G1/G2, and no audio-based artistic verdict is claimed.

The [Classic contact sheet](#publication-evidence-02), [Detailed contact sheet](#publication-evidence-03), and [hardware capture index](#publication-evidence-04) retain the actual evidence. Each capture folder includes frame metadata and matching audio. The harness deliberately labels artistic acceptance unreviewed.

### CPU mechanism probes

These are isolated single-process Node measurements after the test suite stopped, using a generated 90-second stereo 44.1 kHz buffer. Four stem entries intentionally refer to that same input to isolate repeated computations. The mix probe executes the production function extracted into a VM with a minimal AudioBuffer factory. These are single samples, not calibrated browser benchmarks or promised savings; an earlier contended exploratory run is excluded from the table.

| Actual operation | Elapsed time |
|---|---:|
| One synchronous fingerprint | 267.6 ms |
| Four-stem synchronous cache-key construction | **1,001.1 ms** |
| Four activity envelopes | **151.6 ms** |
| Four-stem mix with clipping normalization | **439.2 ms** |
| One band-envelope pass | 22.0 ms |

These results substantiate substantial uninterrupted computation in PERF-01/PERF-02. Browser long-task and interaction measurements are still needed to quantify affected-device latency.

The repository's warm palette benchmark ran 120 measured iterations per profile after ten warmups. Landscape32 Selective took **1.69 ms at Classic and 7.12 ms at Detailed**; Chroma32 Selective took **1.70 and 7.23 ms**. Landscape32 Ordered took **0.92 and 3.47 ms**. RGB332 took **0.10 and 0.42 ms**. These exclude Canvas readback, writeback, copying and GPU work. Pixel mode does not run this palette transform. The results justify a targeted Palette experiment, not a claim that all playback is palette-bound.

Raw records: [CPU probe](#publication-evidence-05), [palette arithmetic](#publication-evidence-06), [root tests](#publication-evidence-07), [reliability reproductions](#publication-evidence-08), [worker failure reproduction](#publication-evidence-09), and [staged bootstrap](#publication-evidence-10).


### Five-minute live RTX 3060 trace

The separate real-upload/playback test **passed all eight repository gates**. It ran in native Windows Chrome **155.0.8059.80** on the verified RTX 3060, headless and muted, with a new browser context, 1280×720 output, Classic 320×180 foreground, Pixel, Uniform, a 60 fps cap, and the Teton tour. The generated input was approximately 315 seconds. This was one run; it does not establish a cross-device benchmark or repeatability distribution.

| Measurement | Observed value |
|---|---:|
| Requested trace duration | 300 seconds |
| Upload to render-ready | 14.377 seconds |
| Delivered FPS over measured intervals | **58.65** |
| Callback FPS | 58.68 |
| Delivered median / p95 / p99 | **16.7 / 16.8 / 33.3 ms** |
| Largest delivered gap | **250 ms** |
| Gaps over 100 ms | **1** in five minutes |
| Distinct completed frames / repeated observations | 17,596 / 10 |
| Failed presentations / hidden or paused samples | **0 / 0** |
| Heard-time advance | Approximately 300.06 seconds |
| Final quality rung | 0; full rung history was not recorded by this harness |
| Peak accounted graphics ownership | **510.38 MiB** against 512 MiB budget |
| Final accounted ownership | 290.83 MiB; zero pending bytes |
| Admission denials / overcommits | **23 / 0** |
| Browser errors | 0 |

The peak is close to the configured budget and the denials show admission actively constraining work. Neither proves a leak or allocation failure visible to the listener. The ledger includes named CPU and GPU graphics resources; it is **not measured VRAM, JS heap, total process memory, or the complete audio-analysis peak**. The retained report shows which owners contributed to peak and final totals.

The repository gates require delivered p95 ≤20 ms, no failed presentations, no hidden samples, at most one >100 ms gap per minute, accounted graphics within 512 MiB, sufficient heard-time advance, frames delivered and no browser errors. Passing them does not imply perfect 60 fps: the observed p99 and single 250 ms stall remain in the report. The two-second fixed capture ran before this separate context, so upload-to-ready is not a rigorously cold driver/cache measurement.

No test-suite or CPU benchmark workload was running during this trace. The desktop environment was not placed under exclusive laboratory control. The run does not time Detailed/Palette, real songs, integrated/mobile GPUs, foreground OS fullscreen, physical panel delivery, or artist acceptance. A01's phase attribution and repeated configuration matrix should precede a renderer-wide performance claim.

Evidence: [live report](#publication-evidence-11), [run log](#publication-evidence-12), and [capture/run index](#publication-evidence-13). The gate implementation is at [tools/landscape-review.mjs:189–222](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/tools/landscape-review.mjs#L189-L222); the delivery counter explicitly distinguishes callbacks from newly completed frames at [src/render/FrameDelivery.js:1–15](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/render/FrameDelivery.js#L1-L15).


## Reliability and durable-state findings

### R-01 — [P1] A transient file-read failure permanently prunes stored library history

**Affected behavior.** Rescanning a folder while one existing file cannot be opened removes that track's durable row, including earned play count, duration and auto-tags. A later healthy scan restores a fresh row with playCount 0. No source audio is deleted. This is metadata loss, not deletion of music files.

**Active path.** LibraryPanel Rescan → [src/main.js:4536–4543](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/main.js#L4536-L4543) → `MusicLibrary.rescan` → `scanDirectory` → `pruneTracks`.

**Root cause and exact source.** [src/library/LibraryScanner.js:165–183](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/library/LibraryScanner.js#L165-L183), particularly 168-172, swallows every `entry.getFile()` error and omits the path from its returned scanned set. [src/library/MusicLibrary.js:255–265](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/library/MusicLibrary.js#L255-L265) allows pruning whenever writes succeeded and cancellation is false; it receives no completeness/error indicator. [src/library/LibraryDB.js:227–238](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/library/LibraryDB.js#L227-L238) deletes every stored path absent from that set. The synchronous `dirHandle.values()` catch at [LibraryScanner.js:56–64](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/library/LibraryScanner.js#L56-L64) has the same incompleteness issue for a directory, though the reproduction specifically uses a file-read failure. An iterator that rejects asynchronously is already propagated, so that distinct case is protected.

**Reproduction and diagnostics.** Repro 2 seeds a directory containing `a.mp3`, records playCount 1 and duration 180, then makes the still-listed entry's `getFile()` throw `NotReadableError`. `rescan()` resolves normally and durable row count becomes 0. On the next healthy scan the track returns with playCount 0. Uses actual production scan/persistence code with the existing fake IDB.

**Recommended solution.** Return `{ tracks, observedPaths, complete, errors }` from scans, retaining observed names separately from successful reads. Only prune after a complete walk; keep a known file's old metadata if opening failed. Surface a concise incomplete-scan status. Alternative: fail the entire scan on any read failure; simpler and safe, but one bad file prevents pruning all genuine deletions.

**Benefit.** Temporary storage/device/permission trouble cannot erase listening history.

**Cost/risk.** Medium: scan result/caller contract and UI status changes. A blanket no-prune policy can retain genuinely removed tracks until a healthy scan; this is preferable to metadata loss. Add a meaningful regression for an existing but unreadable file followed by a healthy retry.

**Confidence.** High, reproduced; frequency on physical drives unmeasured.

### R-02 — [P2, validate first] Durable prune has no current-scan authorization

**Affected behavior and disposition.** An old scan's prune may be able to delete records belonging to a newer scan. The missing ownership check is source-supported. The specific destructive interleaving has been demonstrated only with an artificially delayed fake callback; its reachability with native IndexedDB remains unconfirmed.

**Evidence.** [src/library/MusicLibrary.js:255–260](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/library/MusicLibrary.js#L255-L260) checks generation before and after awaiting `pruneTracks`, but the mutation has no signal/revision contract. [src/library/LibraryDB.js:229–238](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/library/LibraryDB.js#L229-L238) reads rows in a readonly transaction and later deletes keys in a separate write transaction. Library close can cancel the service ([src/main.js:4463–4467](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/main.js#L4463-L4467)).

**Probe and its limitation.** Repro 5 withholds the production wrapper's callback after the underlying fake request fires, permits a newer scan to complete, then releases the old prune. The injected schedule leaves one visible row and zero durable rows. However, the lightweight fake permits transaction progression while that callback is withheld. Native IndexedDB request events, microtasks and overlapping-store transaction ordering may prevent this exact ordering. This is an ownership fault-injection test, not a browser-reproduced data-loss report. The gap arises in the audit harness and is explicitly retained here rather than hidden.

**Root cause / hypothesis.** Generation checks protect in-memory publication but do not themselves authorize an already-issued durable deletion. The separate read/delete transactions motivate investigation; they do not by themselves prove a reachable destructive race.

**Solution and alternatives.** First write a real-IDB regression that attempts cancellation/replacement at observable operation boundaries without overriding native request callback delivery. If reachable, use a root-scoped durable scan revision checked and advanced consistently inside the deletion transaction, or serialize scans/prunes and await the previous durable critical section. Read/delete atomicity alone does not define which scan may commit. A current-owner predicate immediately before creating the write transaction is a smaller single-tab defense; durable revisions provide stronger multi-tab ownership.

**Benefit.** An explicit rule for which scan may remove stored metadata, with stronger cancellation semantics and future multi-tab safety.

**Cost / risk / confidence / validation.** Approximately one day for native reachability tests, then 2–4 days for a justified ownership repair. High confidence in the missing contract; medium-to-low confidence in the exact native-browser outcome until reproduced. Validate stored rows after both scans and reload, including multiple tabs if supported. R-01 addresses scan completeness; this finding addresses authorization to mutate, so keep those responsibilities distinct.


### R-03 — [P2] Re-picking a fallback folder creates a new identity and makes previous history inaccessible

**Affected behavior.** On the supported `webkitdirectory` path, the UI instructs users to re-pick their remembered folder after reload to make it playable. Re-picking the same `Music/a.mp3` instead creates another root and resets the visible track's play count, duration and earned tags. The original metadata remains stored under the previous root, so this is fragmentation/unreachable history, not proof of deletion.

**Active path.** [src/main.js:4501–4511](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/main.js#L4501-L4511) chooses fallback input; `main.js:4592-4603` → `MusicLibrary.adoptFileList`. `LibraryPanel.setRoot` at [src/ui/LibraryPanel.js:238–245](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/ui/LibraryPanel.js#L238-L245) specifically tells users to pick it again. `MusicLibrary.init` only loads newest root, and the UI exposes no root chooser.

**Root cause and exact source.** [src/library/MusicLibrary.js:138–150](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/library/MusicLibrary.js#L138-L150) calls `addRoot` with `handle:null` for every pick. [src/library/LibraryDB.js:126–145](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/library/LibraryDB.js#L126-L145) only looks for a prior root when a handle exists; `collisionSafeRootId` at 102-107 then generates a UUID if the base ID already exists. New track keys include this root ID, so `carryForward` never encounters the old rows.

**Reproduction and diagnostics.** Repro 1 adopts `Music/a.mp3`, notes a play with 180-second duration, initializes remembered state, and adopts the identical file/path again. Root ID changes from `root:music` to `root:music:<uuid>`; visible playCount is 0; original durable row still has playCount 1; roots count is 2. No browser upload required to reproduce the production state logic.

**Recommended solution.** Add an explicit "reconnect this remembered folder" operation that supplies the remembered root ID to adoption, verifies relative-path/size/mtime overlap, and preserves existing keys. Keep "Change folder" distinct. Alternative: match name plus a stable file-set signature, but equal folder names alone must not merge two different libraries.

**Benefit.** The documented Firefox/Safari/fallback workflow retains history and avoids growing abandoned roots every visit.

**Cost/risk.** Medium: reconnection semantics and identity verification; careless name-only reuse would undo the existing same-name folder collision protection. Add a reload/re-pick regression that asserts the same root ID, play history and tags survive.

**Confidence.** High, reproduced; no claim about browser-version-specific picker support.

### R-04 — [P2, validate first] Background library restore lacks a root-operation revision

**Affected behavior and disposition.** Startup restore could publish a remembered root after a newer explicit choice. The source lacks a guard, and controlled completion injection exposes inconsistent state; native IndexedDB reachability of the demonstrated schedule is not established.

**Evidence.** [src/main.js:4619](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/main.js#L4619) starts `musicLibrary.init()` without awaiting it or gating folder controls. [src/library/MusicLibrary.js:74–84](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/library/MusicLibrary.js#L74-L84) assigns `root` and `tracks` after awaits without checking an operation revision. New folder adoption at [src/library/MusicLibrary.js:145–158](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/library/MusicLibrary.js#L145-L158) is a separate asynchronous flow.

**Probe and its limitation.** Repro 4 delays the wrapper callback for the initial root listing, completes adoption of New/new.mp3, then releases the captured Old/old.mp3 result. Actual service code reverts to Old and cannot open its row using the new session file map. As in R-02, the fake has already delivered its request underneath the delayed callback and does not model native transaction ordering fully. It establishes a missing service-level publication invariant under injected completion ordering, not a naturally observed browser/UI race.

**Root cause / hypothesis.** Scan operations have a generation, but init/pick/reconnect/forget do not share a root-operation owner. Whether native scheduling currently masks the demonstrated case needs a targeted real-IDB test.

**Solution and alternatives.** Capture a root-operation revision before init/pick/reconnect/grant/forget awaits, publish only while current, and snapshot root/handle locals across those awaits. This is a small defensive contract even if the exact current schedule is unreachable. Alternatively gate folder actions until initialization settles, accepting that slow storage delays an explicit new choice. Validate the actual race before presenting the guard as a confirmed user-visible bug fix.

**Benefit.** Explicit user choices have a documented precedence over background restore, making future asynchronous changes safer.

**Cost / risk / confidence / validation.** About 0.5–1 day for native timing investigation and 1–2 days for a scoped revision guard. High confidence in absent guard; native outcome and practical incidence unconfirmed. Test delayed storage and open/upgrade paths without violating native callback ordering, picker adoption during startup, forget/reconnect, and reload. Assert both visible root and file-open identity; preserve same-name distinct-folder protection.


### R-05 — [P1] Bulk export output-name collisions overwrite earlier completed videos

**Affected behavior.** A multi-song export can silently replace the output from an earlier song. Same song stems in different encodings, common filenames in identically named album folders, and sanitized/truncated names all collide. If the later pass fails, cleanup can remove the path entirely after it has already replaced the earlier output. This affects generated MP4 deliverables, not source audio.

**Active path.** `npm run export:bulk` → [tools/bulk-export.mjs:401](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/tools/bulk-export.mjs#L401) (`songLabels`) → each render pass at 318-325.

**Root cause and exact source.** [src/render/BulkExport.js:194–201](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/render/BulkExport.js#L194-L201) strips extensions, sanitizes punctuation and truncates to 80 characters; `songLabels` at 208-217 only compares raw basenames, and adds only one parent segment. [tools/bulk-export.mjs:319–325](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/tools/bulk-export.mjs#L319-L325) uses the resulting path directly. [src/render/BulkExport.js:245](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/render/BulkExport.js#L245) includes ffmpeg `-y`, authorizing overwrite. Failure cleanup at [tools/bulk-export.mjs:377–382](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/tools/bulk-export.mjs#L377-L382) unconditionally unlinks that output path.

**Reproduction and diagnostics.** Repro 3 asserts these exact input pairs produce one identical final filename per pair:

1. `/a/Album/Song.wav`, `/b/Album/Song.wav` → `Album - Song - 1080p60.mp4`.
2. `/a/Song.wav`, `/a/Song.mp3` → `Song - 1080p60.mp4`.
3. `/a/Song?.wav`, `/a/Song*.wav` → `Song- - 1080p60.mp4`.

The collision is proven by actual production naming helpers; ffmpeg overwrite/cleanup is source-confirmed. No full video export or real prior artifact destruction was performed. In this Linux environment punctuation inputs are valid filenames; same basename with different supported extensions and nested Album names are cross-platform examples.

**Recommended solution.** Build and validate the complete output-path plan before rendering, deduplicate input paths, and assign deterministic unique suffixes based on source identity after all normalization. Write each output to a unique temporary path and publish to a reserved final path only after encoder success, refusing an existing destination unless overwrite was explicitly requested. An atomic rename alone can overwrite on some platforms. Alternative: fail immediately on collisions/existing files; safe and low complexity, but requires the user to rename inputs or select another output folder. Make overwriting an explicit CLI option if needed.

**Benefit.** Long-running batch exports cannot lose earlier completed deliverables because of naming ambiguity or a later failure.

**Cost/risk.** Low for rejecting collisions, medium for unique naming/atomic publish. Output names change for colliding inputs. Test final normalized names, same stem/different extension, repeated directory basenames, case folding and long-name truncation.

**Confidence.** High, deterministic collision proof plus direct overwrite call path. P1 for loss of generated deliverables; P2 if project severity policy reserves P1 for ordinary UI/data paths.

### R-06 — [P2] A rejected wake-lock request can create a fallback video after disable/dispose

**Affected behavior.** Stopping playback/exiting fullscreen while a wake-lock request is pending can leave a hidden fallback video and canvas capture stream running after KeepAwake has been disabled. A subsequent disable call returns early. This contradicts resource ownership and can continue keep-awake work on a title screen. Whether a given car/OS honors this video as a wake lock is unverified.

**Active path.** [src/main.js:968–970](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/main.js#L968-L970) enables while running/fullscreen and disables otherwise; `main.js:1082` synchronizes this on stop.

**Root cause and exact source.** [src/ui/KeepAwake.js:171–188](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/ui/KeepAwake.js#L171-L188) checks `enabled` when a request succeeds (175), but the rejection callback at 185-188 unconditionally calls `startFallback()`. `startFallback` at 197-221 does not check `enabled`, so it appends/plays a video and captures a stream after disable/dispose. `disable` at 129-136 starts with `if (!this.enabled) return`, so repeated disable does not clean this resurrected fallback.

**Reproduction and diagnostics.** Repro 6 creates the actual `KeepAwake` with a controlled pending request and minimal fake DOM/canvas/stream. Enable, let request start, dispose, reject with `NotAllowedError`, flush promises. Assertions: `enabled===false`, `usingFallback===true`, one video appended; repeated `disable()` has stopped zero fake tracks. Explicit `stopFallback()` cleans up the reproduction. Existing tests cover late success after disable and ordinary rejection separately, but not this combination.

**Recommended solution.** Guard rejection and `startFallback()` with the current enabled/operation generation. Make teardown idempotently stop fallback even if already disabled. If fallback `video.play()` rejects, release its stream/node rather than reporting `held=true` solely because creation succeeded. Alternative: remove fallback on supported platforms when wake-lock permission rejects; simpler, but may reduce coverage on WebViews where it is useful.

**Benefit.** A completed stop/dispose reliably releases every owned capture/video resource.

**Cost/risk.** Low: two ownership guards plus idempotent cleanup, regression for late rejection after disable/dispose. Validate actual car-device behavior separately before making claims about display/battery impact.

**Confidence.** High for JavaScript lifecycle defect; fake DOM only, no physical wake-lock or battery proof.


## CPU, scheduling, asynchronous work, and memory findings

### PERF-01 — Stem cache keys reintroduce synchronous whole-recording fingerprint work (P1)

- **Evidence/state:** reproduced mechanism. [src/audio/AnalysisCache.js:184–192](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/audio/AnalysisCache.js#L184-L192) calls synchronous `fingerprintBuffer(buffer)` for every stem. [src/main.js:2656–2661](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/main.js#L2656-L2661) invokes this immediately after the mix's asynchronous fingerprint. [src/audio/SongFingerprint.js:222–224](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/audio/SongFingerprint.js#L222-L224) exhausts preparation and FFT steps synchronously. Four 90-second stereo 44.1 kHz stem entries took **1001.1 ms** in the isolated Node probe, as one uninterrupted task. Repeated entries intentionally share the same synthetic buffer: this isolates four repeated computations; it does not claim four-file decode costs.
- **Cause/impact:** the mix path was moved into a cancellable worker, but stem identity still serially resamples, measures and fingerprints each full stem on the UI thread. A new user selection cannot deliver its abort event during that task. Stem drops also bypass opening analysis, so this sits on their chooser path.
- **Fix alternatives:** accept precomputed stem fingerprints and generate them with `fingerprintBufferOffThread`, with bounded concurrency and the existing selection signal; or add a cooperative asynchronous key builder using `fingerprintInputsAsync`/`fingerprintSignalsAsync`. Preserve names, order, signal measurements, duration and groove in the exact key. Worker transfer must use private copies, as the mix client already does.
- **Benefit/complexity/risk:** high responsiveness benefit for stems; medium complexity; medium identity/cache regression risk. Do not simply omit stems from keys: different contents and renamed roles intentionally invalidate cached analysis.
- **Confidence/validation:** high on mechanism, unknown on affected-device latency. Add byte-identical key parity tests and an actual multi-stem replacement/cancellation test; record browser long tasks and chooser latency across 2/4/8 stems. Existing `test/audioLoadLifecycle.test.js` checks rename/content/groove identity, and `test/fingerprintLoadLifecycle.test.js` checks mix failure/cancellation; neither makes the synchronous stem calculation cooperative.

### PERF-02 — Stem mixing and stem voting are long synchronous tasks despite abort checks (P2)

- **Evidence/state:** reproduced mechanism. [src/main.js:2250–2284](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/main.js#L2250-L2284) sums all source samples and possibly normalizes the complete stereo mix; checks call `throwIfAborted` but never yield. [src/audio/AudioAdapter.js:79–100](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/audio/AudioAdapter.js#L79-L100) computes activity sample by sample; `:234-240` maps that over all user stems synchronously. Actual extracted `sumToMixBuffer` with four synthetic 90-second stereo sources took **439.2 ms**, including clipping normalization; four activity envelopes took **151.6 ms** in the isolated Node probe. One synchronous band envelope for that recording took 22.0 ms (context, not a separate finding).
- **Cause/impact:** AbortSignal polling cannot observe a new click/drop while the same main-thread task runs. Even before renderer startup, this freezes the loading show and replacement input. These are separate numerical passes from PERF-01; fixing cache fingerprint work alone leaves them.
- **Fix alternatives:** process chunks with the existing `yieldToMain`/`createYielder`, keeping summation order and normalization invariant; alternatively offload mix + voting to a dedicated worker over privately owned or shared channels with an admitted copy budget. A cooperative implementation is likely the smallest change. Do not add `await` per sample.
- **Benefit/complexity/risk:** high input/loading responsiveness; medium complexity; low to medium numerical regression risk if arithmetic order is preserved. Wall-clock throughput may stay similar or worsen slightly while interaction improves.
- **Confidence/validation:** high mechanism, unmeasured browser impact. Validate cancellation delivered between chunks, unchanged mixed samples/peak normalization, phase-safe voting and unchanged casting, then browser task-length tracing under long supported stem loads. `test/audioLoadLimits.test.js` and lifecycle tests verify budgets and ownership; polling alone does not establish responsive cancellation.

### PERF-03 — Optional fingerprint/cache lookup can hold a completed short/stem analysis for its full deadline (P2)

- **Evidence/state:** code-supported. [src/main.js:2678–2684](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/main.js#L2678-L2684) awaits `lookUp()` before it can use an already-completed `analysis`; lookup waits on fingerprint at `:2658`, then IndexedDB at `:2661`. [src/audio/FingerprintWorkerClient.js:18](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/audio/FingerprintWorkerClient.js#L18) gives fingerprint work a **120000 ms** deadline. Short/stem/export paths select the non-opening branch ([src/audio/OpeningAnalysis.js:25–27](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/audio/OpeningAnalysis.js#L25-L27)). [test/fingerprintLoadLifecycle.test.js:43–61](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/test/fingerprintLoadLifecycle.test.js#L43-L61) proves eventual graceful fallback with an injected **25 ms** deadline, but not publication before that deadline when analysis finishes sooner.
- **Cause/impact:** parallel start saves work when a cache hit wins, but publication is serialized behind the optional path. A silent worker or extremely slow fingerprint can postpone chooser availability after successful analysis, for up to the configured fingerprint deadline, plus an independently unbounded IDB request. Long ordinary single-file loads use opening-first and do not have this same chooser dependency.
- **Fix alternatives:** race usable analysis against valid cached analysis; if actual analysis wins, offer it immediately while optional identity/cache persistence continues under the same ownership guard. Alternatively cap the optional lookup's foreground wait separately from its background completion deadline. Handle early analysis rejection separately so a valid cache hit remains a recovery option if desired.
- **Benefit/complexity/risk:** high tail-latency reduction under worker/storage trouble; medium orchestration complexity; medium risk of late cache adoption overwriting live data or aborting the winning branch.
- **Confidence/validation:** high call-chain confidence, failure frequency unknown. Test analysis resolved immediately + silent fingerprint, slow IndexedDB, cache wins, analysis rejects, selection replaced, and no stale publication. Existing failure tests must continue passing with the production deadline behavior changed only through orchestration.

### PERF-04 — Cache eviction materializes every full analysis bundle on every write (P2)

- **Evidence/state:** code-supported. [src/audio/AnalysisCache.js:128–131](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/audio/AnalysisCache.js#L128-L131) runs eviction after every successful put; `:142-147` issues `getAll()` before checking whether count exceeds 100. `:152-165` also reads all full payloads for metadata listing. The `usedMs` index is already created at `:50-51` but not used for eviction.
- **Cause/impact:** IndexedDB must read and structured-clone all bundles even when no eviction is necessary; the JS array then keeps all payloads alive while sorting. Work and transient heap grow with total cache payload, not just the number of rows to delete. Because writes may land after playback starts, this is a plausible source of GC/deserialization pauses. No cache-population memory/latency measurement was run, and the size of 100 current real bundles is not established here.
- **Fix alternatives:** `count()` first, then open a key cursor over the `usedMs` index and delete only excess keys inside one transaction. For metadata listing, keep metadata in a small separate store/indexed record, or use a cursor and avoid retaining payloads (a cursor over full values still deserializes each value, so it is a weaker improvement). Verify write+eviction commit semantics too.
- **Benefit/complexity/risk:** O(total cached bytes) to O(excess keys) eviction work; low to medium complexity; medium transaction/LRU behavior risk. The existing cap and failure handling are useful and should be retained.
- **Confidence/validation:** high algorithmic confidence; browser performance gain requires measurement. Populate 100 realistically sized bundles, measure allocation and write/eviction latency during playback. Existing [test/analysisCache.test.js:140–165](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/test/analysisCache.test.js#L140-L165) covers LRU/cap semantics with a lightweight fake; extend it for cursor/count behavior and use a real-IDB browser check for transaction completion.

### PERF-05 — Audio load budgets omit analysis copies and retained band buffers (P2, device-risk hypothesis)

- **Evidence/state:** code-supported accounting gap; device OOM is a hypothesis. [src/audio/loadLimits.js:4–11](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/audio/loadLimits.js#L4-L11) permits one decoded buffer up to 512 MiB and selected decoded total up to 768 MiB. [src/main.js:2537–2579](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/main.js#L2537-L2579) accounts input stems + mix. [src/audio/PitchWorkerClient.js:103–109](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/audio/PitchWorkerClient.js#L103-L109) privately copies essentially the entire mix across pitch worker ranges. [src/audio/AudioAdapter.js:129–146](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/audio/AudioAdapter.js#L129-L146) starts that pitch job and renders full-length bands, retaining bass channel data. [src/audio/StemSeparator.js:121–124](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/audio/StemSeparator.js#L121-L124) budgets band concurrency independently using only band size/deviceMemory, with a floor of one.
- **Cause/impact:** decoded-file admission, worker copies and band pool are independent budgets; retention of bass means later single-band renders can overlap another full recording even at concurrency one. At supported 20-minute stereo 44.1 kHz, a recording is **423,360,000 bytes (~403.7 MiB)**. Source + worker-owned pitch copies + retained bass + another band could therefore exceed **1.5 GiB** of channel data if lifetimes overlap, before decoder/native context overhead, fingerprint signals, original stems or graphics. This is an analytical potential overlap, not a measured peak or a claim that pitch always remains live that long. A slow/silent pitch worker makes prolonged overlap plausible.
- **Fix alternatives:** a shared analysis admission budget that reserves decoded source, worker copies, bass retention and in-flight native output before starting each phase; lower accepted duration/rate for constrained devices only when the complete plan cannot fit. A more substantial option is chunked band rendering with filter state continuity or windowed pitch transfers. Preserve exact onset/bass behavior and channel phase semantics.
- **Benefit/complexity/risk:** potentially high stability benefit for long/high-rate/stem recordings; medium complexity for unified admission, high for streaming/filter changes; risk of rejecting previously accepted material or changing analysis at chunk boundaries.
- **Confidence/validation:** high that accounting is incomplete; medium that real constrained devices hit the problematic overlap, unmeasured crash frequency. Measure process/tab memory and simultaneous ownership on physical low-memory devices for long inputs and silent workers; test reservations release after cancellation/failure. [test/loadSpeed.test.js:60–67](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/test/loadSpeed.test.js#L60-L67) intentionally tests per-band concurrency; `test/audioLoadLimits.test.js` tests selected decoded budgets. Neither demonstrates a global analysis-peak bound. This does not repeat the historical seven-bands-retained bug: that was already addressed by the pool.

### PERF-06 — Tour planner worker leaks on post failure and has no completion deadline (P2)

- **Evidence/state:** reproduced injected failure plus code-supported silent-worker risk. [src/world/terrain/TourRuntime.js:8–18](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/terrain/TourRuntime.js#L8-L18) installs abort/listeners then calls `worker.postMessage` without cleanup catch. A synchronous post exception rejects the Promise executor but bypasses `finish`, leaving the worker alive and abort listener installed. Actual function fault injection produced **0 terminations after rejection**, then **1 only after an explicit later signal abort**. It also lacks `onmessageerror` and a deadline; a worker that neither responds nor errors holds its promise and resources until external cancellation.
- **Cause/impact:** success/error handlers share partial cleanup, but executor exceptions and undecodable/silent responses do not. Long/complex route planning is therefore capable of lingering past a failed request. A later replacement/disposal can still abort it; this is not asserted to be permanently uncollectable after every UI failure.
- **Fix alternatives:** match the already more robust `FingerprintWorkerClient`/`PitchWorkerClient` settled-guard pattern: one finish routine, post try/catch, messageerror, bounded deadline, handler detachment, terminate and listener removal on all terminal paths. Check abort before energy/role preprocessing too.
- **Benefit/complexity/risk:** bounded worker and request lifetime; low to medium complexity; low regression risk if valid route output remains unchanged. Deadline must tolerate largest supported tours on slow devices rather than borrowing an arbitrary short timeout.
- **Confidence/validation:** high on injected post failure, high on absence of timeout/messageerror, unknown production incidence. Add constructor/post throws, silent worker, messageerror, late reply, already-aborted signal, normal success and cancellation tests. Current `test/tourEnergy.test.mjs` validates unit handling, not these terminal paths.

### PERF-07 — Tour window prefetch still runs full conservative planning on the main thread (P2, benchmark candidate)

- **Evidence/state:** code-supported UI-thread work; no real-route CPU timing collected. [src/world/alpine/RangeScene.js:600–618](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangeScene.js#L600-L618) calls `forestPlacementBound` and `planTerrainWindow` synchronously to obtain admission size before it posts work (`:643-651`, `:663-677`). [src/world/alpine/TerrainWindow.js:175–239](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/TerrainWindow.js#L175-L239) constructs up to 81 poses then scans every tile against those poses; later LOD/seam passes add work. `_ensureTourWindow` at [RangeScene.js:842–853](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangeScene.js#L842-L853) triggers current/next/ahead requests from playback rendering. [terrainWindowWorker.js:8](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/terrainWindowWorker.js#L8) receives the precomputed plan, so relocating mesh construction already does not relocate this planning stage.
- **Cause/impact:** the exact memory-admission design intentionally computes a conservative bound before worker allocation. That is valuable, but its tile-by-pose pass can block the frame making the request, particularly after a seek, route change or viewport invalidation. Four-entry plan caching and 250 ms budget retry backoff already prevent a naive every-frame repeat; do not report this as unconditionally recalculating every frame.
- **Fix alternatives:** a two-stage worker protocol: first plan/bound with a small pre-reserved planning/scratch budget, return exact bytes, then admit geometry/forest allocation and build with the immutable plan. Or a cooperative planner prewarm outside frame callbacks using existing `yieldToMain`, protected by route/coverage generations. Keep exact-byte admission before geometry allocation and existing retention pins intact.
- **Benefit/complexity/risk:** fewer main-thread spikes; benefit unquantified until traced. Medium to high complexity and high residency/coverage regression risk; never remove pre-admission to gain smoothness. Candidate should be profiled before changing architecture.
- **Confidence/validation:** high thread/call-chain confidence, medium prioritization confidence. Profile long real tours across eight-second boundaries, rapid seeks/resizes and budget denial; trace planning duration separately from mesh work. Preserve `test/terrainBuildAdmission.test.js`, `test/tourWindow.test.mjs`, coverage/budget tests. `test/rangeSkyCpuReuse.test.mjs` already guards recent sky CPU reuse and should not be mistaken for evidence this stage is off-thread.

### PERF-08 — Analysis errors leave sibling pitch workers running after the request has failed (P2)

- **Evidence/state:** reproduced injected native failure. [src/audio/AudioAdapter.js:133–146](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/audio/AudioAdapter.js#L133-L146) starts `pitchPromise`, adds a rejection sink, then awaits band separation without a child cancellation/finally scope. [src/main.js:2802–2810](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/main.js#L2802-L2810) returns failure without aborting either controller. Actual `audioToTimeline` with a silent fake pitch worker and an injected OfflineAudioContext allocation exception rejected with **one worker, zero terminations, caller signal not aborted**; explicit manual abort then terminated it. `PitchWorkerClient.js:18-20,54-74` eventually bounds a silent worker at 120 seconds, so this is wasted work/lifetime, not an infinite pitch-worker leak.
- **Cause/impact:** preventing unhandled Promise rejection does not cancel computation. Real native render/allocation errors can return the UI to the loader while pitch CPU and copied sample memory remain live; other native pooled renders may also continue until their own completion. During memory stress this retains exactly the resources a failed request should release.
- **Fix alternatives:** make `audioToTimeline` own a child AbortController linked to caller cancellation; on any failed prerequisite abort sibling pitch work and prevent queued bands from starting. Detach the linkage in finally. Native OfflineAudioContext renders already underway may be non-interruptible, so drain/discard their completion while guaranteeing no fresh phases launch. A parent catch abort is a useful second defense, but internal ownership also protects direct callers.
- **Benefit/complexity/risk:** immediate worker/copy release on analysis failure, reduced failure-time CPU; medium complexity; low to medium cancellation/exception precedence risk. Preserve the root error and avoid converting a native failure to an uninformative AbortError.
- **Confidence/validation:** high mechanism with injected errors, actual failure rate unmeasured. Add a test with a live pitch worker and failed band; assert immediate termination, no new band dispatch and eventual native result discard. Existing cancellation tests cover caller-driven aborts; add error-driven sibling cancellation specifically.


## Graphical quality and presentation findings

G6 from the graphical subreview is consolidated into A02 to avoid counting the same composition architecture twice. G1/G2 require static horizon-enabled fixtures; the captured streamed tour cannot establish their perceptual severity.

### G1 — Instanced forest direct light ignores the terrain horizon

**Classification:** code-supported current shading inconsistency; likely P2. **Confidence:** high for missing visibility factor; medium for perceptual severity. **Priority:** address before adding more lighting effects.

Terrain computes `sunVis = sunHorizonVisibility(vUv,uLightDir)` and uses it in both the diffuse key (with an intentional 0.5 bounce residual) and dry-surface specular. That includes the far forest canopy painted inside the terrain shader. Forest meshes/billboards instead compute a wrapped normal/light dot product and multiply `uLightColor` directly. Their backlight and gust sheen likewise use the unoccluded key. The uniforms are shared by reference, but no horizon visibility is folded globally into `uLightColor`: the horizon varies by receiver. A forested valley in a static view can therefore receive a geographic shadow on terrain/far canopy while near/middle instanced crowns retain full direct light. The existing crown self-occlusion is a different effect and does not fix ridge shadowing.

**Evidence:** [ForestGL.js L211–249](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/ForestGL.js#L211-L249), [ForestGL.js L490–504](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/ForestGL.js#L490-L504), [TerrainMaterial.js L709–752](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/TerrainMaterial.js#L709-L752), [RangeScene.js L1563–1591](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangeScene.js#L1563-L1591).

**Root cause:** receiver-light visibility is implemented within the terrain fragment program rather than as a shared lighting contract consumed by all receiver shaders.

**Proposed fix:** share a world-position-to-horizon visibility function with forest shading. Reuse the admitted horizon texture; map a tree root/world XZ into the same geographic UV domain. Apply a consistent residual to diffuse and actual visibility to transmission/direct sheen. Avoid suppressing ambient or authored lantern light. Tree-top height should eventually be considered to avoid treating a tall crown exactly like its ground receiver.

**Alternatives:** sample horizon per instance/root in the vertex shader and interpolate a single scalar (cheaper, less accurate around a shadow boundary); or move to a shared low-resolution light-visibility atlas. A dynamic shadow map would be more general but materially larger scope.

**Benefit:** forest and land occupy the same lighting space; fewer tonal discontinuities across distance representations. **Complexity/risk:** medium; shader parity, mobile uniform/sampler budget, terrain-to-tree mapping, and the 0.5 residual all need explicit coverage. Static light additions must not break darker narrative phases.

**Validation:** use a static approved forest view with a horizon bake, lock camera/song time, sweep a low celestial behind a known ridge, and capture mesh/billboard/far-canopy regions with matched audio/time labels. A synthetic ridge fixture can prove both receiver programs respond to horizon visibility; visual review must establish the useful residual. The Teton tour alone cannot exercise this gap because it currently omits the horizon bake (G4).

### G2 — Lake celestial glints bypass geographic shadowing

**Classification:** code-supported current shading inconsistency; likely P2. **Confidence:** high for omitted term; medium for visibility in representative compositions.

The water branch obtains a tight `pow(cosine,600)` glint and adds `uLightColor * glint * moonTransmission`; it does not multiply the `sunVis` already computed earlier. Dry-ground specular does multiply `sunVis`. A ridge-occluded celestial can consequently leave a direct glint on a lake even when the underlying water receiver is geographically shadowed. The glint correctly suppresses a zero-energy key and respects cloud transmission when that older cloud path is active; those recent fixes are present and are not findings.

**Evidence:** [TerrainMaterial.js L713–752](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/TerrainMaterial.js#L713-L752), [TerrainMaterial.js L775–797](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/TerrainMaterial.js#L775-L797), [TerrainMaterial.js L488–491](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/TerrainMaterial.js#L488-L491).

**Root cause:** the lake has a separate direct-specular branch outside the dry-material specular visibility contract.

**Proposed fix:** multiply only the direct celestial glint by geographic visibility. Keep sky reflection, planar terrain reflection, and actor glints separate: they are different light paths.

**Alternatives:** centralize receiver visibility into a reusable factor consumed by terrain, water, and forest; preserve a clearly named artistic glint residual if a deliberate magical effect is desired.

**Benefit:** water and shore agree when a celestial sets behind relief. **Complexity/risk:** low implementation complexity, medium visual risk because existing lake art direction may rely on the extra highlight. The surface slope glint remains tightly peaked and requires a fixture that actually aligns view/light/normal.

**Validation:** synthetic constant-normal water under a tall ridge with high glint gain, compare visibility 0 and 1 while fixing key energy and view. Include a real static lake low-sun passage at both grids. Existing `rangeWaterResponse` tests prove zero-key behavior but do not test ridge occlusion.

### G3 — The smooth sky deliberately disconnects density clouds from surface lighting

**Classification:** confirmed current architectural limitation/design opportunity, not a malfunction of the old ellipse occluder. **Confidence:** high.

The active hybrid sky clears `scene.skyClouds` explicitly because the old ellipse banks cannot describe the new density clouds. `_setCloudUniforms` sets cloud count to zero and returns without input. Consequently the visible new fair-weather clouds can cross the moon while terrain/water direct-light transmission remains one. Storm-wide darkening and the authored storm openings still work, but they do not represent the individual density cloud visible in the sky. The old ellipse-to-receiver moon model exists in source and should not be cited as functioning density-cloud shadowing in the primary path.

**Evidence:** [PresentingRenderer.js L50–55](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/render/PresentingRenderer.js#L50-L55), [BiomeManager.js L3782–3812](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/BiomeManager.js#L3782-L3812), [RangeScene.js L1679–1695](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangeScene.js#L1679-L1695), [RangeSkyRenderer.js L295–303](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangeSkyRenderer.js#L295-L303), [CloudOcclusion.js L54–76](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/CloudOcclusion.js#L54-L76).

**Proposed direction:** derive render opacity and receiver transmittance from one seeded world weather field. `RangeCloudField` already exposes world centers, sizes, IDs, and stable shape seeds. A small admitted weather-density atlas could serve the sky, celestial-disc attenuation, ground/water light, forest transmission, and eventually shadows in mist. Compute along each actual receiver ray, not merely a screen-space alpha at the moon disc.

**Alternatives:** first implement a bounded analytic density-cloud transmittance approximating the current sprites; or deliberately retain decoupling as an authored style and document it. Reusing the obsolete ellipse fields would introduce physically incorrect agreement with a shape no longer displayed.

**Benefit:** stronger coherence among moon/cloud/terrain/water, enabling moving shafts and openings that belong to the visible weather. **Complexity/risk:** high; density texture ownership, receiver-ray transforms, mirror camera, blend travel, shader budgets, and deterministic seeks. A screen-space moon alpha alone is an inexpensive approximation but not a substitute for receiver transmission.

**Validation:** matched direct image/receiver-ray tests for one cloud, multiple camera positions, low moon, mirror, and reduced motion. Disable only the visible cloud or transmission to attribute differences. No artistic judgment is established for this proposed receiver-lighting change.

### G4 — The streamed Teton tour has no geographic light occlusion

**Classification:** intentional current limitation/design opportunity. **Confidence:** high.

Static views bake an eight-azimuth horizon texture; streamed tour views explicitly set its cost to zero and retain an unshadowed key. Thus improvements to the static-view horizon do not reach the flagship moving tour. The horizon itself models static terrain on a coarse grid, ignores trees and musical deformation, and considers relief out to 9 km; it is not a dynamic shadowing system. These are explicit tradeoffs, not evidence that all Range lighting lacks shadows.

**Evidence:** [RangeScene.js L964–1005](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangeScene.js#L964-L1005), [TerrainOcclusion.js L1–21](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/TerrainOcclusion.js#L1-L21).

**Proposed direction:** bake a coarse horizon atlas over the full route geography offline, independent of the active geometry window, and stream/retain the required tiles alongside surface data. Geographic lighting should not change merely because a different mesh window is resident.

**Alternatives:** coarse clipmap sunlight visibility; cascaded shadow maps at the high-quality rung with a baked coarse fallback; per-window horizons with overlap and continuity bounds. The latter is cheaper to prototype but can pop at window boundaries or miss occluders outside a window.

**Benefit:** low-angle sun/moon can carve readable valley and ridge shadow throughout the tour, with coherent forest lighting after G1. **Complexity/risk:** high; offline build/data format, hash manifests, residency, world alignment, and seam continuity. This investment should preserve deterministic seek reconstruction and avoid new readiness stalls.

**Validation:** same route/time/camera on both sides of a window boundary with a fixed celestial, then a full low-sun tour. Verify identical light visibility for overlapping receivers while swapping window order; compare at Classic and Detailed. Physical-device cost remains unmeasured here.

### G5 — Forest ecology is constrained to four western conifers, including Broadleaf scenery

**Classification:** code-supported content/identity limitation; a graphical opportunity rather than a correctness/security defect. **Confidence:** high for supported species, medium for priority at these pixel scales.

Approved Black Mountains in the North Carolina Blue Ridge selects the BROADLEAF material pack. Placement chooses only lodgepole, Engelmann spruce, subalpine fir, or Douglas fir from elevation/hash; the near geometry has two conifer families. Material rules adjust density, slope, treeline, wetness and palette, but cannot select a deciduous crown family. Near/mid silhouettes therefore cannot express the advertised broadleaf ecology. The existing terrain habitat masks are explicitly derived, not measured land cover; a real DEM is not proof of actual vegetation accuracy.

**Evidence:** [sceneCatalogData.js L1119–1131](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/terrain/sceneCatalogData.js#L1119-L1131), [ForestCover.js L63–86](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/ForestCover.js#L63-L86), [ForestSpeciesAssets.js L25–35](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/ForestSpeciesAssets.js#L25-L35), [broadleaf.json L261–270](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/assets/range/v2/materials/broadleaf.json#L261-L270), [ForestCover.js L11–15](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/ForestCover.js#L11-L15).

**Proposed direction:** add a biome vegetation profile selecting species/crown families, then implement at least a rounded deciduous family across mesh, billboard, far-dot, and mean-canopy representations. Preserve root IDs, placements and ring coverage while changing species traits. Extend all JS/GLSL trait twins together.

**Alternatives:** a small curated per-view vegetation palette with two or three unmistakable silhouettes; a larger asset atlas; or a consciously stylized universal conifer forest. If ecological accuracy is a product aim, introduce land-cover inputs independently of elevation masks.

**Benefit:** stronger place and biome identity, especially at Detailed and near-camera passages, without increasing scenery count. **Complexity/risk:** medium–high; all distance representations must share mass, shade, normal statistics, density, and silhouette character to avoid visible ring changes. Adding only near deciduous meshes would amplify the mismatch.

**Validation:** neutral-light forest contacts at same camera across all rings, actual approved Broadleaf and conifer views, then same song/time Palette versus Pixel. Human review must confirm that the extra family is distinguishable at 320×180, not just attractive in asset closeups.


### G7 — Existing atmosphere is good analytic depth fog, but does not support spatially shadowed volumetric light

**Classification:** architectural/art-direction opportunity, not a defect. **Confidence:** high on model; aesthetic improvement remains a hypothesis.

The atmosphere integrates an exponential/slab layer and samples drifting world noise along the eye-to-surface ray, with an exact layer integral and a 2–6 sample quality ladder. It already avoids a common mistake of placing opaque fog cards in front of terrain. Its color, however, is a lifted air/key color with procedural cloud-sea billow shading; it does not evaluate sunlight visibility or a scattering phase at each volume sample. Sun shafts use screen-space depth/aperture sampling separately. That limits coherent light shafts through clouds, valley-shadowed mist and forward/back-scattering around the sun. This is not evidence that the current atmosphere looks bad.

**Evidence:** [RangeAtmosphere.js L126–169](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangeAtmosphere.js#L126-L169), [RangeAtmosphere.js L251–298](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangeAtmosphere.js#L251-L298), [RangeScene.js L1667–1671](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangeScene.js#L1667-L1671), [SunShaftGL.js L20–64](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/SunShaftGL.js#L20-L64).

**Proposed direction:** preserve the analytic extinction and add a bounded scattering-light term driven by shared geographic/cloud transmittance, with a restrained phase function. Begin at a small number of samples or a coarse light-volume grid; use spatially stable upsampling into the chosen pixel style.

**Alternatives:** improve only the analytic color/phase term first; retain screen-space shafts and provide world-weather masking; froxel volume with optional temporal accumulation only after proving pause/seek/export reconstruction. Temporal history cannot silently become a prerequisite for a correct exported frame.

**Benefit:** valleys with readable light volume and atmospheric depth tied to actual weather and relief. **Complexity/risk:** high; overdraw, banding at Classic, double-counting existing air/shafts, and hidden temporal state. It depends on G3/G4 light visibility more than on adding more noise octaves.

**Validation:** retain matched song/time cloud-sea and low-sun clips, plus analytic no-fog/constant-density fixtures, occluded light, mirrored land, Classic/Detailed and low-quality rungs. Judge musical legibility and composition, not changed-pixel count.

### G8 — Gust choreography is tied to the observing camera rather than a shared world wind field

**Classification:** deliberate current motion convention and opportunity for more physical scene coherence; not a claim that screen-relative choreography is wrong. **Confidence:** high for implementation, medium for visual importance.

Trees determine gust age from their projected screen X, and bend along camera right. Water cat's paws determine age from `gl_FragCoord.x`. During mirror rendering the observing camera and viewport change, so the same world tree/water point can receive a different gust phase/direction in its reflection; a camera turn also changes the wavefront through the landscape. The shaders intentionally document this choice because it makes music sweep visibly across the screen. Generic advice to make the gust world-fixed would change authored behavior and should be treated as a design variant.

**Evidence:** [ForestGL.js L74–102](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/ForestGL.js#L74-L102), [TerrainMaterial.js L465–480](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/TerrainMaterial.js#L465-L480), [RangeScene.js L476–504](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangeScene.js#L476-L504).

**Proposed direction:** derive each musical gust as a world plane/front with origin, direction, speed, onset heard time and deterministic ID. Evaluate it identically for trees and water in main and mirror cameras. Select its heading from the camera at onset, preserving an authored initial left/right sweep while avoiding reorientation as the camera moves.

**Alternatives:** keep the screen-relative art style; or evaluate both main and reflected tree gusts using the primary camera projection/right vector rather than whichever camera is currently drawing. That is a narrower consistency repair which preserves the screen choreography and avoids new physical wind semantics.

**Benefit:** continuous wind moving through forest, lake and reflections, especially during camera movement. **Complexity/risk:** medium; reconstructing onset pose after arbitrary seeks, matching CPU/GLSL domains, and preserving the song's readable front timing. A world-plane front should remain bounded, deterministic and reduced-motion aware.

**Validation:** synthetic one-front scene with a static main camera and planar mirror, then yaw the camera while following fixed tree IDs. Compare same world point's phase in both draw cameras. Review a music-backed mirror clip to choose whether physical coherence or screen sweep is preferable.


### G9 — Scenic-score success does not establish delivery of musical hero shots

**Classification:** measured planned-timeline diagnostic and code-supported acceptance gap; P2. Safe short-song fallback is intentional; this is not a claim that the inspected clip shows all later misses.

1. **Observed evidence and affected scope.** [Classic report](#publication-evidence-14), JSON pointer `/songs/0/frames/0/range/tour`, contains a complete 89,984 ms planned timeline with `meanQualityRatio=0.8651151808010646` and nine heroes: one station, four distant, and four missed. Each missed hero has `framedFraction=0`: 23,178.668 ms (pre-chorus), 31,731.474 ms (bridge), 83,012.313 ms (**final chorus**), and 87,885.126 ms (outro). Notes record seven sections with no legal junction route and two explicitly composed distant alternatives. The artifact has status `passed`; its actual rendered evidence is **25 consecutive frames from 12,000–14,000 ms only**, generated `review-audio`, Classic, quality 0, seed setting 315, Teton tour, headless ANGLE/NVIDIA RTX 3060. Thus the future missed windows are evidenced planned projection outcomes, not inspected PNGs from those times. All 25 stored frame snapshots contain the same whole-tour framing array. Snapshot serialization is explicit at [RangePresentation.js L1150–1156](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangePresentation.js#L1150-L1156).

2. **Exact implementation and gate locations.** `meanQualityRatio` is a ratio of accumulated baked view-field heading scores to maximum available field scores, [TourTimeline.js L37–43](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/terrain/TourTimeline.js#L37-L43), [L188–205](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/terrain/TourTimeline.js#L188-L205), [L303](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/terrain/TourTimeline.js#L303). Independent `heroFraming` samples the planned pose every 250 ms across ±1.5 seconds of a hero; it requires the subject to be in front and inside NDC ±0.8 in both axes for at least 80% of samples. It separately labels station visits and distant shots, [L221–240](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/terrain/TourTimeline.js#L221-L240). Slower-route quality retries start only below `.8`, [L205–217](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/terrain/TourTimeline.js#L205-L217). The dedicated browser tour smoke asserts `.8` quality but filters framing assertions to `stationVisit`, excluding missed distant heroes, [teton-tour-smoke.mjs L24–28](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/tools/teton-tour-smoke.mjs#L24-L28). Landscape frame validation checks grid, Uniform scale, active/ready terrain and output size, [landscape-review.mjs L69–74](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/tools/landscape-review.mjs#L69-L74); it marks success after frame/lifecycle/removed-overlay/source/error checks, without a hero acceptance criterion, [L258–267](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/tools/landscape-review.mjs#L258-L267). Its artistic judgment is explicitly unreviewed, [L228–229](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/tools/landscape-review.mjs#L228-L229).

3. **Root cause and interpretation.** Two useful measurements answer different questions: scenery score asks whether the camera points toward a broadly good view; hero framing asks whether a planned musical subject occupies its viewing window. The route planner deliberately preserves legal roads, speed/climb/yaw constraints and marks infeasible sections passed-at-range, [TourPlanner.js L19–60](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/terrain/TourPlanner.js#L19-L60). Timeline repair demotes **station** misses but does not establish a minimum count/fraction of successfully framed distant heroes. Distant composition tries the intended subject and up to six same-role alternatives within yaw and aggregate scenic-quality limits; it can retain a missed result, [TourTimeline.js L243–303](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/terrain/TourTimeline.js#L243-L303). The diagnostics honestly expose this; it is not concealed or mislabeled by `outcome`. The default review's 90-second generated song has dense detected roles, so physical station misses are expected. Zero framing of selected distant heroes, particularly the final chorus/outro, is a distinct presentation limitation that a high overall scenic score cannot dismiss.

4. **Proposed improvement and alternatives.** Add an explicit semantic coverage summary to reports: total eligible heroes, successful station/distant shots, missed main/subheroes, final-chorus/outro results, fallback reasons, and which windows actually received rendered review. Introduce a documented regression policy for missed hero framing separately from `.8` scenic score; start with “no worsening from accepted fixture baseline” and mandatory render review for missed final-chorus/endings, rather than inventing a universal coverage target. Add a bounded timeline correction pass for missed distant main heroes that selects a feasible alternate subject/shot or deliberately marks an unscheduled hero, while preserving road/clearance/yaw constraints. Alternatives: reduce the number of scheduled heroes for short or dense inputs; select an itinerary around critical heroes first; or keep current safe fallback and surface semantic partial completion clearly. Do not make the renderer unsafe or distort song time to force impossible visits.

5. **Expected user benefit.** The camera is more likely to deliver the intended musical landmarks, and reports distinguish attractive continuous scenery from successful musical staging. A passing technical capture remains useful without being mistaken for whole-tour hero coverage or artistic acceptance. Final-chorus and ending regressions become reviewable instead of being diluted into a global average.

6. **Complexity, risk, confidence, and priority.** Reporting/regression policy is low–medium complexity; better itinerary/shot optimization is medium–high. Risk is overconstraining legitimate short-song fallbacks, silently replacing distinctive subjects with generic alternatives, or trading comfortable camera motion for shot count. Confidence is **high** for this artifact's counts and gate omission; **medium** that hero misses explain a perceptible weakness; **unestablished** for frequency across real music. Treat as presentation-validation scope, not a claim of generalized rendering failure. Existing `test/tourFraming.test.mjs` already tests successful synthetic station/distant composition; `test/tourShortSongQuality.test.mjs` L14–34 checks a different approximately 96-second four-phrase fixture's scenic score and optical corridor, not this generated song's nine-hero coverage. Do not claim those tests are absent or that their fixture failed.

7. **Validation needed before claiming a fix or artistic problem.** Preserve this input and its detected sections; add it and a diverse longer-song corpus as semantic framing regressions. Capture **continuous** music-backed windows around 23.179, 31.731, 83.012 and 87.885 seconds, including the complete ±1.5-second framing intervals, and label song/time. Compare native Classic/Detailed, actual moved camera and zoom, projection, terrain occlusion and subject pixel footprint. `measureHeroFraming` explicitly measures projection only and uses the tour's own 16:9 `poseAt`; it is not proof that a subject is visible above terrain, large enough to read at the grid, or framed identically after cinematic/user camera transforms. Review intended named subjects and explicit alternatives separately. Passing those semantic checks still does not replace artistic judgment or live/device performance evidence.


## Architecture, measurement, and maintainability findings

### A01 — Attribute frame cost before choosing a GPU optimization

**Classification / priority / confidence:** code-supported observability gap; P1 as an enabling measurement task; high confidence in timer semantics, no attribution of a particular live stall yet.

**Behavior and evidence.** [src/world/alpine/RangeScene.js:1852](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangeScene.js#L1852) starts a JavaScript timer and `:1932` stores `lastPartitionMs`. It measures CPU time around WebGL submission, possible synchronization, and copies, not elapsed GPU execution. [src/render/PixelPresentation.js:132–232](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/render/PixelPresentation.js#L132-L232) separately measures presentation/quantization CPU work. [src/main.js:3351–3362](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/main.js#L3351-L3362) feeds callback timing into the governor. The repository already distinguishes completed presentation from callback FPS through `src/render/FrameDelivery.js`; that useful distinction should remain. No application use of GPU disjoint timer queries was found in the reviewed source.

**Root cause.** Several render domains have partial diagnostics, but no single frame record attributes scene update, window planning, draw submission, GPU passes, Canvas transfers, native palette processing, completed presentation, and memory ownership.

**Solution and alternatives.** Add a bounded diagnostic trace keyed by frame/generation with CPU phase marks, nonblocking WebGL2 timer-query results where supported, pass/copy counts, terrain-worker events and readiness holds. Poll old GPU queries without waiting; discard disjoint intervals. Reset renderer counters once per complete application frame, accounting for all partitions/reflections. On unsupported devices retain CPU and delivery metrics with GPU time explicitly unavailable. Browser Performance traces are a lower-cost investigative alternative before adding permanent instrumentation. The [Khronos timer-query specification](https://registry.khronos.org/webgl/extensions/EXT_disjoint_timer_query_webgl2/) defines asynchronous query availability and disjoint handling; [Three's renderer documentation](https://threejs.org/docs/pages/WebGLRenderer.html) explains multi-pass counter reset control.

**Benefit.** Separates CPU preparation, GPU saturation, synchronization and compositor symptoms, making later spending evidence-driven. It also prevents interpreting graphics accounting as total tab memory.

**Cost / trade-offs / risk.** About 2–4 engineering days for a useful bounded trace, then device capture time. Queries and logging themselves have overhead; compare diagnostics on/off, sample selectively, cap buffers, and avoid forcing GPU completion.

**Validation.** Attribute a fixed set of scenes on Classic/Detailed and Pixel/Palette, with/without mirrors and during window changes. Include source hash, song hash/time, browser/GPU, output size/DPR, quality rung, cap, visibility, warmup, readiness time and delivered p50/p95/p99/max. Run at least three independent five-minute traces per representative configuration; do not average away rare stalls.

### A02 — Consolidate measured graphics boundaries; begin with Palette

**Classification / priority / confidence:** confirmed topology, measured native palette arithmetic, unmeasured end-to-end speedup; P2 targeted experiment, P3 full renderer migration.

**Behavior and evidence.** GPU partitions render to targets, copy into a drawing buffer, then enter a Canvas2D stage; view travel introduces further composition. Water uses a separate reflection and Canvas backdrop upload. Palette reads and transforms the native foreground before the smooth sky is composited. See [src/world/alpine/RangeScene.js:1848–1933](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangeScene.js#L1848-L1933), [src/world/alpine/RangePresentation.js:972–995](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangePresentation.js#L972-L995), [src/world/alpine/RangePresentation.js:1018–1038](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangePresentation.js#L1018-L1038), [src/world/alpine/RangeScene.js:404–435](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangeScene.js#L404-L435), and [src/render/PaletteQuantize.js:129–152](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/render/PaletteQuantize.js#L129-L152). The measured Detailed Selective arithmetic alone was about 7.1–7.2 ms in Node, excluding transfer costs.

**Root cause.** Legacy painter ordering, Range depth effects, pixel presentation, and the new smooth sky meet at Canvas boundaries rather than one explicit render graph. This helps compatibility but makes consistent depth/light/color ownership and future volumetric effects harder.

**Solution and alternatives.** First prototype a deterministic GPU palette/LUT and spatial Bayer/selective-mask path at the exact native grid; verify color-space and alpha parity. Then benchmark a GPU-native Alpine composition in which sky, terrain, depth, and final exposure have explicit ownership, with necessary legacy layers entering through admitted textures. Smaller alternatives are caching stable backdrop inputs or eliminating only transfers shown expensive by A01. Do not rewrite the entire renderer based on topology alone. WebGL guidance explains why synchronous readbacks can be costly, but current measurements do not establish their contribution here. [WebGL best practices](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices).

**Benefit.** Potentially lower Palette CPU cost and more room for coherent lighting, with fewer implicit Canvas lifetime boundaries. No FPS improvement percentage is defensible yet.

**Cost / trade-offs / risk.** Palette prototype 3–7 days; broader composition migration 4–8 weeks depending on parity scope. High risk around painter interleaving, premultiplied alpha, linear versus display color, recorder/export capture, context restore and fallback. A shader still needs the source transferred if the scene remains Canvas-based; savings must include that cost.

**Validation.** Exact native opaque palette membership, partial-alpha and dither-origin fixtures; same-time frame comparisons; music-backed continuous clips; live delivery and GPU/CPU traces; independently decoded recordings. Keep the current implementation selectable until full parity and a worthwhile gain are demonstrated.

### A03 — Prepare shader programs asynchronously without weakening failure handling

**Classification / priority / confidence:** code-supported potentially blocking preparation path; P2 profiling candidate; high source confidence, cold-start impact unmeasured.

**Behavior and evidence.** [src/world/alpine/RangeScene.js:1080–1111](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangeScene.js#L1080-L1111) compiles all terrain/forest/depth/actor targets, then immediately queries `LINK_STATUS`. The link check is important: publishing failed shaders would suppress fallback while terrain is missing. Immediate status queries can, however, serialize CPU preparation with unfinished driver compilation.

**Root cause.** Correct shader validation currently shares a synchronous readiness loop.

**Solution and alternatives.** Submit the required programs, wait for asynchronous compilation completion where supported, then retain the existing link checks and diagnostic logs. The vendored renderer contains `compileAsync`; verify its behavior against this pinned version rather than assuming latest Three implementation details. Revalidate context and generation ownership after every await and dispose superseded preparations. If asynchronous support is absent, retain the current explicit failure path or prewarm likely variants outside critical playback. [KHR_parallel_shader_compile](https://registry.khronos.org/webgl/extensions/KHR_parallel_shader_compile/) and [Three's compileAsync API](https://threejs.org/docs/pages/WebGLRenderer.html) describe the available mechanism.

**Benefit.** Potentially more responsive loading and fewer preparation stalls; total compilation work may be unchanged.

**Cost / trade-offs / risk.** 2–4 days after A01 identifies whether this matters. Medium lifecycle risk: an asynchronous prepare can finish after a view, context or budget owner has changed.

**Validation.** Cold and warm program caches; slow device; forced link failure; context loss during compilation; replacement selection and resize; no readiness publication until all required programs are valid. Compare upload-to-ready and worst main-thread task, not just total load time.

### A04 — Extract ownership boundaries from large orchestrators incrementally

**Classification / priority / confidence:** code-supported maintainability constraint; P2 ongoing refactoring within functional work; high concentration evidence, medium expected productivity benefit.

**Behavior and evidence.** The snapshot has 479 non-vendor JavaScript modules and about 95,537 lines, including generated catalog/index data. `BiomeManager.js` has 8,812 lines, `main.js` 4,964, `RangeScene.js` 2,044, `Renderer.js` 1,678, and `RangePresentation.js` 1,180. These counts are navigation indicators, not complexity scores. More actionable is the responsibility spread: main owns analysis publication ([src/main.js:2638–2684](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/main.js#L2638-L2684)), error return (`:2802-2810`), playback/cadence (`:3347-3414`) and library startup/UI (`:4463-4619`); RangeScene handles worker planning, residency, GPU preparation and submission.

**Root cause.** Session ownership, domain behavior and UI orchestration share large objects and informal mutable state. Lifecycle contracts differ between otherwise similar worker/cache/library operations, contributing to the confirmed holes in this audit. Size alone does not prove a bug.

**Solution and alternatives.** Extract a small audio-load session owner with child cancellation, a root-scoped library operation owner, and an explicit render-preparation transaction. Centralize shared light visibility separately from material style. Keep stable interfaces, migrate one active call path at a time, and retain deterministic fixtures. JSDoc/types for result states and resource ownership can be adopted before any file movement. Avoid a framework migration or wholesale TypeScript rewrite as a prerequisite.

**Benefit.** Makes cancellation, publication, failure cleanup and resource release reviewable in one place, reducing duplicated guards and allowing graphics work without changing unrelated loaders/UI.

**Cost / trade-offs / risk.** 3–5 days per extracted boundary, spread across relevant fixes; larger work should wait for demonstrated need. Medium to high risk if refactoring and behavior changes are mixed. Inactive adapters or legacy fallback should only be removed after an import/support inventory confirms no promised use.

**Validation.** Characterization of real public behavior, fault injection at each await boundary, source-parity rendering corpus, and unchanged durable keys/export formats. Measure code ownership and reduced duplicate paths, not a target file-length number.

### A05 — Align validation documentation and cover real persistence interleavings

**Classification / priority / confidence:** confirmed documentation contradiction and demonstrated test gap; P2; high.

**Behavior and evidence.** [MIDIO_PIXEL.md:7](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/MIDIO_PIXEL.md#L7) describes default Depth and a distance-dependent pixel effect, while [docs/pixel-presentation.md:28](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/docs/pixel-presentation.md#L28) states all current profiles migrate to Uniform with no Depth branch. [docs/test-matrix.md:29–34](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/docs/test-matrix.md#L29-L34) still describes automatic PR/main/reusable core gates, whereas [.github/workflows/test.yml:1–5](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/.github/workflows/test.yml#L1-L5) is manual-only and [docs/local-validation.md:1–6](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/docs/local-validation.md#L1-L6) explicitly documents local validation. Four reliability reproductions and two injected-ordering ownership probes pass through real modules despite the green full suite; fake-based happy paths do not cover those particular interleavings.

**Root cause.** Historical implementation and assurance descriptions survive policy changes. Tests often exercise one operation to completion without asserting durable state after overlapping or canceled operations.

**Solution and alternatives.** Reconcile documents around the actual product/workflow contract and clearly mark historical evidence. Generate a small local validation manifest containing SHA, commands, counts, skips, browser/GPU and evidence paths. Add targeted real-IDB browser checks alongside deterministic delayed-fake tests for R-01–R-04; include late rejection and error-driven worker cancellation cases. Keep hosted tests manual as currently intended. A simpler first step is one authoritative current validation page with historical documents linking to it.

**Benefit.** Reviewers can distinguish current guarantees from old results, and the highest-risk persistence bugs receive meaningful regression protection.

**Cost / trade-offs / risk.** Documentation and manifest 1–2 days; real-browser persistence matrix 2–4 days. Browser tests add maintenance and runtime cost; choose critical ownership transitions instead of multiplying every setting combination.

**Validation.** Source-linked documentation spot checks; reproducible failure-before/fix-after tests; browser reload verifies stored metadata, not only current UI rows. Add Firefox/WebKit and physical-device coverage according to the actual support promise. This audit's Chromium evidence does not validate those targets, live Plex deployment, head-unit behavior, or release/public bytes.


## Prioritized implementation roadmap

Priorities combine impact, confidence, implementation cost and prerequisite value. **P1** means fix or measure early because of data loss, long blocking work, or a decision-critical evidence gap. **P2** means important bounded work or a well-supported improvement. **P3** means a larger experiment whose benefit needs validation. Estimates are engineering effort for an experienced contributor, including focused tests; they are not delivery promises and exclude broader artistic/device acceptance. Tasks sharing a subsystem should be combined rather than having their estimates added mechanically.

| ID | Priority / phase | Impact; confidence | Estimated effort | Depends on | Acceptance gate |
|---|---|---|---|---|---|
| **R-01** — Incomplete scan deletes library history | P1; 1 | High; High | 1–3 days | None | Unreadable file and healthy retry preserve metadata |
| **R-02** — Durable prune lacks current-scan authorization | P2 validate first; 1 | Potentially high; High gap; native reachability unconfirmed | 1 day native test; 2–4 days repair | Shared scan-result contract; R-04 revision | Native-IDB reachability tested; old owner cannot delete newer records |
| **R-05** — Batch export names collide and overwrite outputs | P1; 1 | High; High | 1–3 days | None | Unique paths; no-clobber publication; later failure preserves files |
| **R-04** — Startup restore lacks root-operation revision | P2 validate first; 1 | Potentially medium; High gap; native reachability unconfirmed | 0.5–1 day native test; 1–2 days guard | Shared root-operation revision | Native ordering tested; stale restore cannot replace newer root |
| **R-03** — Fallback folder reconnect loses visible history | P2; 1 | Medium; High | 2–4 days | R-04; root identity contract | Reconnect keeps ID and metadata; distinct folders stay distinct |
| **R-06** — Wake-lock rejection resurrects disposed fallback | P2; 1 | Medium; High | 0.5–1 day | None | Late rejection leaves no video/capture track |
| **PERF-06** — Tour worker cleanup/deadline gap | P2; 1 | Medium; High | 0.5–2 days | None | Every terminal path settles and terminates |
| **PERF-08** — Failed analysis leaves sibling pitch worker alive | P2; 1 | Medium; High | 1–3 days | Scoped child cancellation | Error aborts siblings while preserving root error |
| **A01** — Attribute CPU/GPU/copy/delivery costs | P1 enabling; 1 | High enabling; High | 2–4 days | None | Bounded nonblocking trace with reproducible five-minute runs |
| **A05** — Reconcile docs and persistence validation | P2; 1 | Medium; High | 1–2 days docs; 2–4 days browser tests | R-01–R-04 contracts | Current policy manifest; real-IDB reload assertions |
| **PERF-01** — Synchronous stem fingerprints block publication | P1; 2 | High; High | 2–4 days | Cache identity parity | Identical keys; bounded task duration and responsive cancellation |
| **PERF-02** — Synchronous mixing/activity ignores new abort events | P2; 2 | High; High | 2–4 days | Preserve sample arithmetic | Mix/envelope parity and cancellation between chunks |
| **PERF-03** — Optional cache lookup delays usable analysis | P2; 2 | High tail latency; High mechanism | 2–3 days | Selection/session ownership | Silent worker or slow IDB cannot hold completed analysis |
| **PERF-04** — Eviction clones every cached analysis bundle | P2; 2 | Medium; High mechanism | 1–2 days | Real-IDB cursor validation | LRU cap holds without fetching payloads |
| **PERF-05** — No aggregate analysis-memory admission | P2; 2 | High on constrained devices; High gap; medium impact | 3–7 days admission; 2–4 weeks streaming | Ownership inventory; PERF-08 | Measured peak fits admitted plan under long input/failure |
| **PERF-07** — Terrain pre-admission planning remains synchronous | P2 profile first; 2 | Potentially high; High path; medium impact | 1 day trace; 4–8 days protocol | A01; preserve admission/pins | No frame-request planning spike; unchanged coverage/budget |
| **A03** — Synchronous shader compilation/status checks | P2 profile first; 2 | Potentially medium; High path; medium impact | 2–4 days | A01; preparation ownership | Responsive cold prepare with shader/context failure parity |
| **A02** — Palette GPU path and explicit composition graph | P2/P3; 2 / 4 | Potentially high; High cost; unmeasured gain | 3–7 days palette; 4–8 weeks graph | A01; capture/color contracts | Exact native parity plus measured end-to-end advantage |
| **A04** — Extract lifecycle/resource ownership boundaries | P2 ongoing; 1–4 | Medium enabling; High concentration; medium benefit | 3–5 days per boundary | Characterization within each fix | One owner per operation; behavior and format parity |
| **G1** — Forest direct light misses terrain horizon | P2; 3 | Medium visual; High term; medium severity | 2–4 days | Static horizon fixture | Near/mid/far forest and ground agree behind ridge |
| **G2** — Lake direct glint misses geographic visibility | P2; 3 | Medium visual; High term; medium severity | 0.5–1.5 days | Static aligned-glint fixture | Occluded direct glint suppressed; reflections preserved |
| **G3** — Visible density clouds do not light receivers | P3; 3 / 4 | High visual potential; High model; unproven preference | 1–3 weeks | G1/G2 shared visibility; A01 | Cloud/receiver rays agree across camera/mirror |
| **G4** — Streamed tour lacks geographic light occlusion | P3; 3 / 4 | High visual potential; High model | 1–3 weeks | Shared visibility; terrain data format | Light stable across window swaps and low-sun route |
| **G5** — Broadleaf scenes reuse western conifer families | P2; 3 | Medium/high place identity; High assets; unproven preference | 1–2 weeks | All-distance asset/placement contract | Regional silhouette readable across rings and native grids |
| **G9** — Scenic score does not gate hero-shot coverage | P2; 3 | Medium/high musical staging; High diagnostic; medium perceptual | 1–3 days reporting; 1–2 weeks shots | Accepted corpus; preserve route constraints | Independent hero coverage and rendered endings reviewed |
| **G8** — Camera-relative gusts versus coherent world wind | P3; 3 / 4 | Medium visual potential; High code; unmeasured severity | 2–5 days camera parity; 1–2 weeks world field | Deterministic onset pose; mirror fixture | Same world point phase in both views; musical sweep accepted |
| **G7** — Spatially lit atmosphere and scattering | P3; 4 | High visual potential; High model; unproven preference | 3–6 weeks | G3/G4 visibility; A01; possibly A02 | Continuous accepted clips; bounded GPU cost; seek/export parity |


### Phase 1 — Protect owned state and establish the performance baseline

Repair scan completeness in R-01. Test native-IDB reachability for R-02/R-04 before classifying their injected schedules as browser bugs; establish durable scan authorization and root-operation precedence together where justified. Keep those contracts distinct from completeness and use them when implementing R-03 reconnect semantics. Reject batch output collisions immediately (R-05), then introduce unique temporary outputs and publication that refuses existing destinations unless overwrite is explicit. R-06, PERF-06 and PERF-08 are small lifecycle repairs that can proceed independently. Start A01's attribution work and A05's evidence manifest at the same time.

**Exit gate:** the four reproduced reliability mechanisms become meaningful regression tests that fail before repair and pass afterward. R-02/R-04 receive explicit native-IDB dispositions plus service ownership tests; do not manufacture callback scheduling to claim native reachability. Later export failures cannot remove earlier completed files; every terminal worker/wake-lock path releases owned resources. Run a real IndexedDB reload check and preserve the full root/lint/staging gates. Keep generated evidence outside repository history.

### Phase 2 — Improve loading responsiveness and bound complete analysis memory

Address PERF-01/PERF-02 together without changing cache identities or sample arithmetic. Then decouple completed analysis publication from optional cache lookup (PERF-03), replace full-value eviction (PERF-04), and reserve the total simultaneous audio-analysis ownership (PERF-05). Profile actual terrain-window planning and shader preparation before committing to PERF-07 or A03. Prototype A02's Palette path only with attributable cost and raster parity.

**Exit gate:** long supported inputs and multi-stem replacement remain interactive; cancellation is delivered between chunks; cached and uncached musical analysis agrees; slow cache/fingerprint workers do not hold usable analysis; failure/cancel releases reservations. Record maximum browser task length and input-to-chooser latency alongside throughput. Memory acceptance requires measured process/native peaks on a constrained device, not only bookkeeping totals.

### Phase 3 — Make light, place and musical composition coherent

Start with the bounded G1/G2 receiver-light corrections in static fixtures, then define the shared visibility contract before implementing G3/G4. Add G5's geographically appropriate forest families across every distance representation. G9's semantic coverage report can precede shot changes: capture the identified missed windows and decide the acceptance policy before tightening planner constraints. Evaluate G8 as an authored variant, preserving comfortable motion and deterministic onset reconstruction.

**Exit gate:** same world location receives consistent direct light across terrain/forest/water and remains stable at terrain-window boundaries; broadleaf/conifer identity survives Classic resolution; musical hero coverage is reported separately from scenic score. Every aesthetic decision has matched audio/time/camera/seed evidence and continuous motion review. Pixel/Palette, Classic/Detailed, pause/seek, reduced motion/flashing and mirror views remain valid.

### Phase 4 — Fund ambitious experiments only after their dependencies work

The most promising larger direction is a **shared world-weather and light system** feeding clouds, terrain shadows, forest transmission, lake glints and spatially lit atmosphere. This has a clearer visual purpose than adding independent effects. G3/G4 establish visibility; G7 adds bounded scattering; A02 may simplify the render graph if measured transfers or color/depth ownership justify it.

A second direction is a **musically constrained camera director**: prioritize achievable hero subjects and meaningful endings while maintaining legal route, clearance, comfortable angular velocity and exact song time. G9's coverage corpus supplies the acceptance contract. A third is **streaming audio analysis under one memory budget**, especially if long recordings are central to the product; it could admit more material without repeated full-recording copies, but filter/pitch continuity makes it a substantial project.

**Exit gate:** a prototype demonstrates a meaningful perceptual or measured performance advantage on representative accepted fixtures without reducing reliability. No default rollout based solely on changed pixels, shorter code, a new API, or one desktop GPU.

## Modern browser and GPU capabilities: where they fit

| Capability | Appropriate use here | Constraint or prerequisite |
|---|---|---|
| WebGL2 GPU timer queries | Attribute actual GPU pass time in A01 | Optional support; poll asynchronously; discard disjoint results; never force completion |
| Parallel shader compilation | Keep preparation responsive in A03 | Preserve link-error reporting, context/generation checks and readiness ownership |
| Existing scheduler/worker infrastructure | Move remaining full-recording work off long main-thread tasks | `yieldToMain` already uses `scheduler.yield` with fallback; apply it where missing instead of adding a second scheduler |
| GPU palette/mask pass | Target Detailed Selective CPU work in A02 | Include Canvas-to-GPU upload in comparisons; exact color/alpha/Bayer parity matters |
| Worker-owned OffscreenCanvas | Potentially separate a future self-contained rendering/composition loop from UI work | Current DOM/Canvas/painter/capture dependencies must be untangled; moving work does not guarantee less total work |
| WebGPU compute and explicit resources | Research terrain culling/LOD, weather-density/light volumes, or large batched GPU work after profiling | A second backend and browser/device fallback are major maintenance costs; it is not required for the first several roadmap phases |
| Shared sample/terrain memory | Avoid redundant copies when ownership and isolation permit | Terrain code already conditionally uses SharedArrayBuffer; do not claim this capability is wholly absent. Audio sharing needs security headers/support review and strict immutable ownership. |

OffscreenCanvas supports worker use, making it a possible ownership boundary rather than a universal speed switch. [MDN OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas). WebGPU exposes compute and modern resource control, but availability and limits must be negotiated at runtime and evaluated against the supported device matrix. [MDN WebGPU](https://developer.mozilla.org/en-US/docs/Web/API/WebGPU_API). Neither API should be made a prerequisite for correcting the confirmed library or audio-lifecycle defects.

The project already uses instancing, multiple forest detail representations, workers, sampleable depth, deterministic seeks and explicit graphics admission. Recommendations that merely “add workers,” “use instancing,” “add fog,” or “use modern scheduling” would ignore existing implementation.

## Safeguards verified and leads not promoted to defects

- **Background stepping and cadence:** [src/core/FixedStepClock.js:19–27](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/core/FixedStepClock.js#L19-L27) bounds long resume gaps; [src/main.js:3347–3414](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/main.js#L3347-L3414) deliberately maintains simulation while suppressing draws. Moving all simulation behind the FPS cap would risk musical timing.
- **Worker and terrain ownership:** pitch/fingerprint clients already have deadlines and cleanup paths. Terrain caches, admission bounds, retained reservations, stale generations and denial backoff already exist. PERF-06 is specific to the tour planner worker; PERF-07 must preserve terrain admission.
- **Selection and recorder lifecycle:** current audio-selection tickets protect many stale loads. Recorder finalization and preparation-session ownership are implemented and tested. Those historical race reports were not recycled into current findings.
- **Numerical half-vector lead:** [src/world/alpine/TerrainLighting.js:32–57](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/TerrainLighting.js#L32-L57) has an unguarded GLSL `normalize(l+v)` versus a guarded JavaScript twin; water guards its denominator at [src/world/alpine/TerrainMaterial.js:788–790](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/TerrainMaterial.js#L788-L790). No reachable approved-camera NaN or GPU artifact was reproduced. Test adversarial opposing/grazing vectors before asserting a current visual bug.
- **Depth precision lead:** near/far 20/150000 and unsigned depth ([src/world/alpine/RangeScene.js:132–143](https://github.com/aepler315/midio-pixel/blob/8f7c10fecdb9c436f7e789ec094c79efe88eff31/src/world/alpine/RangeScene.js#L132-L143), `:255-268`) warrant a distant-feature fixture if instability appears. These settings alone do not prove z-fighting. Reversed depth or logarithmic depth should follow a demonstrated precision need and shader/depth-consumer compatibility review.
- **Intentional visual choices:** zero-MSAA native pixels, full-color sky above a palette foreground, mirror lift/reflection floor, and screen-relative gusts are authored behavior. Each can be auditioned, but departure from physical optics is not sufficient evidence of a bug.
- **Recent cloud fixes:** world parallax, shape variety, storm tint, bounded aurora, and zero-key water glints are present. The inspected capture is not evidence that all possible views and songs are free of visual defects.
- **Scope of negative results:** zero dependency advisories does not establish absence of application vulnerabilities. No broader security certification, physical device battery result, long-export container validation, public deployment state, or artistic acceptance is claimed.

## Validation plan for implementation work

| Scenario group | Required observable assertions |
|---|---|
| Library persistence | Transient unreadable file, incomplete traversal, canceled old prune/new scan, startup restore/new pick, reconnect/reload, same-name distinct roots; inspect durable records after all operations settle |
| Async cleanup | Constructor/post failure, messageerror, silent worker deadline, late reply, already-aborted request, sibling failure, late wake-lock rejection; no live worker/track/node or retained reservation after teardown |
| Audio responsiveness | 2/4/8 stems, short/long/high-rate inputs, cancellation during each full-buffer pass, slow/blocked cache, memory-denied plan; record browser tasks, input response and byte/sample parity |
| Rendering correctness | Static horizon valley/lake, streamed boundary overlap, mirror, cloud receiver ray, forest distance transitions, shader failure and context loss; fixed seeds/times and exact presentation controls |
| Live performance | At least three five-minute traces per target configuration; upload-to-ready separate; delivered p50/p95/p99/max and stalls, CPU/GPU phase attribution, quality rung changes, measured memory versus accounted bytes |
| Musical presentation | Continuous labeled clips around major heroes, final chorus/outro, calm/loud transitions; projection coverage and actual occlusion/pixel footprint separately; human acceptance of named subjects and alternatives |
| Recording/export | Real encode and independent decode; fixed dimensions during display changes, pause/preparation duration, failure cleanup, collision pairs and pre-existing outputs; no corrupt/overwritten completed artifacts |
| Compatibility | Current supported Chromium, Firefox/WebKit as promised, integrated/mobile GPU and actual constrained/head-unit devices; no extrapolation from this RTX run |

## Evidence and reproducibility

The accompanying [evidence index](#publication-evidence-15) lists source verification, command results, probe scripts, CPU measurements, full test logs, staging/bootstrap checks and hardware reports. Probe dependencies are synthetic and intentionally inject failures; they are not recordings of private user data. The generated audio fixture is retained with captures.

The audit's application snapshot remains unchanged. The [post-audit source verification](#publication-evidence-16) repeats all pinned blob hashes. The [evidence manifest](#publication-evidence-17) gives SHA-256 hashes for retained files. Failed setup-only attempts were excluded from conclusions and are identified in the evidence index; they were not treated as application failures.

Follow implementation with the stated gates rather than treating this roadmap as authorization to make changes. No implementation was performed in this audit.


## Publication evidence register

This appendix makes the published report self-contained for findings, quantitative results, reproduction logic, and artifact provenance. It supplements the unchanged investigation above. Original relative paths are relative to the audit's `outputs/` directory. The complete evidence folder remains retained with the original audit workspace; it is not part of this documentation commit.

<a id="publication-evidence-01"></a>

### evidence/recent-history.json

- Original artifact: `evidence/recent-history.json`
- Size: 9,516 bytes
- SHA-256: `7d7905af1e2b5bbe362d00e0a62a643b805efd18837be1b57797ba16b3ab19cd`
- Availability: retained outside Git; the report above contains the associated findings and scope limitations.

<a id="publication-evidence-02"></a>

### evidence/gpu-fixed-verified/classic/contact-sheet.png

- Original artifact: `evidence/gpu-fixed-verified/classic/contact-sheet.png`
- Size: 538,547 bytes
- SHA-256: `e78f598bbd4c17e822b45f2a0fa317119c95eab982f1f8f9ca1ffb7cd7ddccaf`
- Availability: retained outside Git; the report above contains the associated findings and scope limitations.

<a id="publication-evidence-03"></a>

### evidence/gpu-fixed-verified/detailed/contact-sheet.png

- Original artifact: `evidence/gpu-fixed-verified/detailed/contact-sheet.png`
- Size: 531,555 bytes
- SHA-256: `1727a8b337a2f390b1891e9fa27b96cf5e4626e8b0553beb3b05b10f43691348`
- Availability: retained outside Git; the report above contains the associated findings and scope limitations.

<a id="publication-evidence-04"></a>

### evidence/gpu-fixed-verified/index.html

- Original artifact: `evidence/gpu-fixed-verified/index.html`
- Size: 1,353 bytes
- SHA-256: `a2d764bf6223bd8b69aef62a85ff64ff3def012adcffa1595dfd679a2ae38296`
- Availability: retained outside Git; the report above contains the associated findings and scope limitations.

<a id="publication-evidence-05"></a>

### evidence/cpu-probe-idle.jsonl

- Original artifact: `evidence/cpu-probe-idle.jsonl`
- Size: 100,575 bytes
- SHA-256: `99fce79b200b27ef7be5057336abd6706c11bba0cc72d223601e8cec405e91c4`
- Availability: retained outside Git; the report above contains the associated findings and scope limitations.

<a id="publication-evidence-06"></a>

### evidence/palette-arithmetic.json

- Original artifact: `evidence/palette-arithmetic.json`
- Size: 2,926 bytes
- SHA-256: `8a2abfa3becd77a15e4e3abe80473b5bf5371095c91299e37cd704859e339332`
- Availability: retained outside Git; the report above contains the associated findings and scope limitations.

<a id="publication-evidence-07"></a>

### evidence/npm-test.log

- Original artifact: `evidence/npm-test.log`
- Size: 441,714 bytes
- SHA-256: `e528fc600b03c891c6a148d3b334d75b1acfed4ebafa5d5905c9b79df8ecb8a3`
- Availability: retained outside Git; the report above contains the associated findings and scope limitations.

<a id="publication-evidence-08"></a>

### evidence/reliability-reproductions.log

- Original artifact: `evidence/reliability-reproductions.log`
- Size: 843 bytes
- SHA-256: `c2505e291c4a581b47ba04e78157d52d836ca63f1004d8f4b39a2247bbc18dfd`
- Availability: retained outside Git; the report above contains the associated findings and scope limitations.

<a id="publication-evidence-09"></a>

### evidence/worker-failure-reproduction.jsonl

- Original artifact: `evidence/worker-failure-reproduction.jsonl`
- Size: 212 bytes
- SHA-256: `075395ee7981cd9e5467a0ea26bd3559e6687c54a3f29df265cb48e38ada4b0e`
- Availability: retained outside Git; the report above contains the associated findings and scope limitations.

<a id="publication-evidence-10"></a>

### evidence/bootstrap-staged.log

- Original artifact: `evidence/bootstrap-staged.log`
- Size: 72 bytes
- SHA-256: `cab6f77f5bbdb81712554db21a771fea5cbd81ef8f10b9ee578c325b3c5899b6`
- Availability: retained outside Git; the report above contains the associated findings and scope limitations.

<a id="publication-evidence-11"></a>

### evidence/gpu-live-300/live-report.json

- Original artifact: `evidence/gpu-live-300/live-report.json`
- Size: 11,104 bytes
- SHA-256: `1ef8a6bb4b032518a15f9ec93b8bc6e7dbce0a35b4bdebb33d3bd68671019e59`
- Availability: retained outside Git; the report above contains the associated findings and scope limitations.

<a id="publication-evidence-12"></a>

### evidence/gpu-live-300.log

- Original artifact: `evidence/gpu-live-300.log`
- Size: 419 bytes
- SHA-256: `49119e4a0a0d6c28a7fe62f09b05458cc1bb87d740a6c5b8621d7336ecc58dd2`
- Availability: retained outside Git; the report above contains the associated findings and scope limitations.

<a id="publication-evidence-13"></a>

### evidence/gpu-live-300/index.html

- Original artifact: `evidence/gpu-live-300/index.html`
- Size: 1,122 bytes
- SHA-256: `a58c4ba4118ef24079d7d81416f4f366eab203a083755631e0a79083c09b8a35`
- Availability: retained outside Git; the report above contains the associated findings and scope limitations.

<a id="publication-evidence-14"></a>

### evidence/gpu-fixed-verified/classic/report.json

- Original artifact: `evidence/gpu-fixed-verified/classic/report.json`
- Size: 14,813,135 bytes
- SHA-256: `3399830d28c242c58d9fb9f2b0de06324c30abd18ac1e9d59e1bbf04e8058de4`
- Availability: retained outside Git; the report above contains the associated findings and scope limitations.

<a id="publication-evidence-15"></a>

### evidence/index.html

- Original artifact: `evidence/index.html`
- Size: 7,832 bytes
- SHA-256: `1cbfbfb3fa726954d8d3c9ec3d5bb786b38f54eff454a384a6ce798e79d87fe7`
- Availability: retained outside Git; the report above contains the associated findings and scope limitations.

<a id="publication-evidence-16"></a>

### evidence/source-verification-final.json

- Original artifact: `evidence/source-verification-final.json`
- Size: 375 bytes
- SHA-256: `2e277c68dd7e4006ff1806c603685a9018b6c54b9f111319b79d2a68b522154d`
- Availability: retained outside Git; the report above contains the associated findings and scope limitations.

<a id="publication-evidence-17"></a>

### evidence/evidence-manifest.json

- Original artifact: `evidence/evidence-manifest.json`
- Size: 17,412 bytes
- SHA-256: `971dbcdfbb4b3dc36b50672d795ed386165f344e291b174468b622c3cff20d93`
- Availability: retained outside Git; the report above contains the associated findings and scope limitations.

## Retained textual observations

These are observations from the completed audit, not reruns performed for publication. A successful reproduction script means the problematic mechanism was reproduced; it does not mean the application was repaired. Probes 4 and 5 use artificial fake-IDB completion ordering, and native-browser reachability remains unconfirmed.

### Reliability probe output

```text
REPRO 1: fallback re-pick root root:music => root:music:3f4043ae-83e0-4aec-b19f-7a537d8c9d44 ; visible count 0, old durable count 1, roots 2
REPRO 2: transient getFile error prunes durable row and play history; next healthy scan count 0
REPRO 3: export collision ["/a/Album/Song.wav","/b/Album/Song.wav"] => Album - Song - 1080p60.mp4
REPRO 3: export collision ["/a/Song.wav","/a/Song.mp3"] => Song - 1080p60.mp4
REPRO 3: export collision ["/a/Song?.wav","/a/Song*.wav"] => Song- - 1080p60.mp4
REPRO 4: delayed startup init overwrites newly imported root with Old ; old row cannot play
REPRO 5: canceled old prune deletes a row committed by a newer completed scan; view retains 1 while durable rows 0
REPRO 6: rejected in-flight wake lock resurrects fallback video after dispose; enabled false, fallback true; disable does not stop its stream
```

### Error-driven pitch worker lifetime

```text
{"case":"native band setup failed","error":"injected OfflineAudioContext allocation failure","workers":1,"terminations":[0],"signalAborted":false}
{"case":"manual abort after failed analysis","terminations":[1]}
```

### Staged browser bootstrap

```text
Bootstrap smoke passed: app loaded and Browse files opened the chooser.
```

### Lint output

```text

> midio-pixel@0.1.0 lint
> eslint src tools test ridgeview
```

### Public-site staging output

```text
Staged site at /mnt/c/Users/aeple/Documents/Codex/2026-10-20/conduct-a-comprehensive-evidence-based-technical/work/staged
```

### Root test summary

Full log identified in the manifest below. Retained final summary:

```text
✔ extractZip throws on invalid data (0.329557ms)
✔ extractZip handles nested paths in filenames (0.143533ms)
✔ extractZip rejects archives over the configured entry budget (0.191628ms)
✔ extractZip rejects an entry before decompression exceeds its byte budget (0.449045ms)
ℹ tests 4801
ℹ suites 3
ℹ pass 4795
ℹ fail 0
ℹ cancelled 0
ℹ skipped 6
ℹ todo 0
ℹ duration_ms 338074.527126
```

### Ridgeview test summary

Full log identified in the manifest below. Retained final summary:

```text
✔ micro-relief appears only past the data resolution and only on land (66.019153ms)
✔ crest analysis finds the north-south axis and the summit (292.890609ms)
✔ the best view looks at the crest across the lake, not over the plateau (5370.446333ms)
✔ an eye hidden behind the plateau scores lower than one across the lake (340.212466ms)
ℹ tests 26
ℹ suites 0
ℹ pass 26
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 6119.565222
```

### Isolated CPU observations

The computed fingerprint payload is omitted from this presentation; the input, result-file hash, computation source, and every timing are preserved. This omission does not remove an audit finding or measurement.

```text
{"node": "v24.10.0", "platform": "linux", "inputSeconds": 90, "sampleRate": 44100, "channels": 2, "decodedBytes": 31752000, "interpretation": "Node synthetic single-process mechanism probe; not browser or device benchmark"}
{"name": "one synchronous fingerprint", "elapsedMs": 267.59230800000006}
{"name": "four-stem synchronous analysisCacheKey", "elapsedMs": 1001.14342}
{"name": "four activity envelopes", "elapsedMs": 151.62513400000012}
{"name": "one synchronous bandEnvelope", "elapsedMs": 21.957983999999897}
{"name": "actual sumToMixBuffer four stems clipping normalization", "elapsedMs": 439.2143510000001}
{"name": "tour postMessage failure", "error": "synthetic DataCloneError", "terminatedBeforeAbort": 0, "hasOnMessageError": false}
{"name": "tour post failure after external abort", "terminations": 1}
```

### Palette arithmetic observations

| Grid | Palette | Dither | Frames | Mask ms | Transform ms | Total ms |
|---|---|---|---:|---:|---:|---:|
| classic | range32 | ordered | 120 | 0.000202 | 0.919101 | 0.919303 |
| classic | range32 | selective | 120 | 0.679326 | 1.012510 | 1.691836 |
| classic | chroma32 | ordered | 120 | 0.000128 | 0.888964 | 0.889092 |
| classic | chroma32 | selective | 120 | 0.713601 | 0.987904 | 1.701505 |
| classic | rgb332 | ordered | 120 | 0.000082 | 0.103760 | 0.103841 |
| detailed | range32 | ordered | 120 | 0.000259 | 3.468405 | 3.468664 |
| detailed | range32 | selective | 120 | 2.922263 | 4.197118 | 7.119382 |
| detailed | chroma32 | ordered | 120 | 0.000328 | 3.861718 | 3.862046 |
| detailed | chroma32 | selective | 120 | 3.097646 | 4.127960 | 7.225606 |
| detailed | rgb332 | ordered | 120 | 0.000125 | 0.419653 | 0.419778 |

Warm Node arithmetic only; excludes source copying, Canvas readback/writeback and GPU work.

### Source and dependency verification

`source-verification.json`:

```text
{
  "repository": "aepler315/midio-pixel",
  "commit": "8f7c10fecdb9c436f7e789ec094c79efe88eff31",
  "tree": "47c19e2fc48dbd9594684dd6b9fe99989a431d8a",
  "verifiedFiles": 1518,
  "mismatches": []
}
```

`source-verification-final.json`:

```text
{
  "repository": "aepler315/midio-pixel",
  "commit": "8f7c10fecdb9c436f7e789ec094c79efe88eff31",
  "tree": "47c19e2fc48dbd9594684dd6b9fe99989a431d8a",
  "verifiedFiles": 1518,
  "mismatches": [],
  "verifiedAtUtc": "2026-10-20T11:29:08.878326+00:00",
  "scope": "Every pinned source blob after all test and GPU runs; generated dependencies, staging and evidence excluded"
}
```

`dependency-audit.json`:

```text
{
  "auditReportVersion": 2,
  "vulnerabilities": {},
  "metadata": {
    "vulnerabilities": {
      "info": 0,
      "low": 0,
      "moderate": 0,
      "high": 0,
      "critical": 0,
      "total": 0
    },
    "dependencies": {
      "prod": 4,
      "dev": 107,
      "optional": 26,
      "peer": 0,
      "peerOptional": 0,
      "total": 110
    }
  }
}
```

`report-validation.json`:

```text
{
  "findings": 27,
  "words": 13567,
  "pinnedSourceLinks": 114,
  "invalidSourceLinks": []
}
```

## Reproduction source retained from the investigation

The following scripts are the retained probe sources, not application changes. Their imports assume this workspace layout: `work/repository/` contains the audited checkout and `outputs/evidence/probes/` contains the scripts. Use Node 24. For another workspace, retain that relative layout or adjust only probe import paths to a checkout of `8f7c10fecdb9c436f7e789ec094c79efe88eff31`. The scripts use synthetic fixtures and controlled dependencies, not private recordings.

### cpu-probe.mjs

```javascript
// Audit probe: resolves the unchanged pinned snapshot in this audit workspace.
import fs from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { fingerprintBuffer } from '../../../work/repository/src/audio/SongFingerprint.js';
import { analysisCacheKey } from '../../../work/repository/src/audio/AnalysisCache.js';
import { activityEnvelope } from '../../../work/repository/src/audio/AudioAdapter.js';
import { bandEnvelope, envelopeFrameCount } from '../../../work/repository/src/audio/OnsetDetector.js';
import { prepareTourTimeline } from '../../../work/repository/src/world/terrain/TourRuntime.js';
const N=44100*90;
const chans=[new Float32Array(N),new Float32Array(N)];
for(let c=0;c<2;c++)for(let i=0;i<N;i++)chans[c][i]=.4*Math.sin(i*(.025+c*.0001))*(.6+.4*Math.sin(i*.000007));
const buffer={sampleRate:44100,length:N,duration:90,numberOfChannels:2,getChannelData:c=>chans[c]};
const measure=(name,fn)=>{const start=performance.now();let answer=fn();console.log(JSON.stringify({name,elapsedMs:performance.now()-start,answer}));return answer;};
console.log(JSON.stringify({node:process.version,platform:process.platform,inputSeconds:90,sampleRate:44100,channels:2,decodedBytes:N*8,interpretation:'Node synthetic single-process mechanism probe; not browser or device benchmark'}));
const fp=measure('one synchronous fingerprint',()=>fingerprintBuffer(buffer));
measure('four-stem synchronous analysisCacheKey',()=>analysisCacheKey(fp,{stems:Array.from({length:4},(_,i)=>({name:`stem${i}`,buffer}))}).length);
measure('four activity envelopes',()=>{for(let i=0;i<4;i++)activityEnvelope(chans,44100);return null;});
measure('one synchronous bandEnvelope',()=>bandEnvelope(buffer,envelopeFrameCount(N,44100).numFrames).length);
const main=fs.readFileSync(new URL('../../../work/repository/src/main.js',import.meta.url),'utf8');
const mixSource=main.slice(main.indexOf('function sumToMixBuffer('),main.indexOf('\nconst LYRICS_AUTO_SKIP_MS'));
const mixContext=vm.createContext({Float32Array,Math,throwIfAborted(){},audioEngine:{ctx:{createBuffer(ch,length,sampleRate){const a=Array.from({length:ch},()=>new Float32Array(length));return{length,sampleRate,numberOfChannels:ch,getChannelData:c=>a[c]};}}}});
vm.runInContext(mixSource+'\nthis.mix=sumToMixBuffer;',mixContext);
measure('actual sumToMixBuffer four stems clipping normalization',()=>mixContext.mix([buffer,buffer,buffer,buffer]).length);
let worker;globalThis.Worker=class{constructor(){worker=this;this.terminated=0;}terminate(){this.terminated++;}postMessage(){throw new Error('synthetic DataCloneError');}};
const controller=new AbortController();
try{await prepareTourTimeline({}, {durationMs:1000,sections:[]},{signal:controller.signal});}catch(e){console.log(JSON.stringify({name:'tour postMessage failure',error:e.message,terminatedBeforeAbort:worker.terminated,hasOnMessageError:typeof worker.onmessageerror==='function'}));}
controller.abort();console.log(JSON.stringify({name:'tour post failure after external abort',terminations:worker.terminated}));
```

### reproduce-reliability.mjs

```javascript
// CAUTION: probes 4 and 5 use artificial fake-IDB completion ordering.
// Native-browser reachability is NOT established; see ../README.md and the audit.
// Audit probe: resolves the unchanged pinned snapshot in this audit workspace.
import assert from 'node:assert/strict';
import { MusicLibrary } from '../../../work/repository/src/library/MusicLibrary.js';
import { listTracks, listRoots } from '../../../work/repository/src/library/LibraryDB.js';
import { fakeIdb } from '../../../work/repository/test/helpers/fakeLibraryIdb.js';
import { songLabels, bulkFileName } from '../../../work/repository/src/render/BulkExport.js';
const file = (name, path = `Music/${name}`) => ({ name, size: 64, lastModified: 1, webkitRelativePath: path, slice: () => ({ arrayBuffer: async () => new ArrayBuffer(64) }) });
{
 const scope = fakeIdb(); const lib = new MusicLibrary({ scope });
 await lib.adoptFileList([file('a.mp3')]); const originalId = lib.root.id;
 await lib.notePlayed(lib.tracks[0], 180);
 await new MusicLibrary({ scope }).init();
 await lib.adoptFileList([file('a.mp3')]);
 assert.notEqual(lib.root.id, originalId); assert.equal(lib.tracks[0].playCount, 0);
 assert.equal((await listTracks(originalId, scope))[0].playCount, 1);
 console.log('REPRO 1: fallback re-pick root', originalId, '=>', lib.root.id, '; visible count 0, old durable count 1, roots', (await listRoots(scope)).length);
}
{
 const scope = fakeIdb(); const lib = new MusicLibrary({ scope });
 lib.root = { id: 'root:music', name: 'Music' };
 let unreadable = false;
 lib.handle = { values: () => (async function* () { yield {kind:'file',name:'a.mp3', getFile: async () => {if (unreadable) throw Error('NotReadableError'); return file('a.mp3');}}; })() };
 await lib.rescan(); await lib.notePlayed(lib.tracks[0], 180); unreadable = true;
 await lib.rescan(); assert.equal((await listTracks(lib.root.id, scope)).length, 0);
 unreadable = false; await lib.rescan(); assert.equal(lib.tracks[0].playCount, 0);
 console.log('REPRO 2: transient getFile error prunes durable row and play history; next healthy scan count', lib.tracks[0].playCount);
}
{
 for (const inputs of [['/a/Album/Song.wav','/b/Album/Song.wav'], ['/a/Song.wav','/a/Song.mp3'], ['/a/Song?.wav','/a/Song*.wav']]) {
  const names = songLabels(inputs).map(songName=>bulkFileName({ songName, resolutionId: '1080p', fps: 60 }));
  assert.equal(new Set(names).size, 1);
  console.log('REPRO 3: export collision', JSON.stringify(inputs), '=>', names[0]);
 }
}
{
 const scope = fakeIdb(); const lib = new MusicLibrary({ scope });
 await lib.adoptFileList([file('old.mp3', 'Old/old.mp3')]);
 const originalOpen = scope.indexedDB.open;
 let release, reached;
 const barrier = new Promise(r=>reached=r);
 let holdNextRoots = true;
 scope.indexedDB.open = (...args) => {
  const raw = originalOpen(...args), req = {};
  raw.onsuccess = () => {
   const db = raw.result;
   req.result = new Proxy(db, { get(target, key) {
    if (key !== 'transaction') return target[key];
    return (...txargs) => {
     const tx = target.transaction(...txargs), getStore = tx.objectStore;
     tx.objectStore = (name) => {
      const store = getStore(name);
      if (name !== 'roots' || !holdNextRoots) return store;
      const getAll = store.getAll;
      store.getAll = () => {
       if (!holdNextRoots) return getAll();
       holdNextRoots = false;
       const rawRead = getAll(), delayed = {};
       rawRead.onsuccess = () => { delayed.result = rawRead.result; release = () => delayed.onsuccess?.(); reached(); };
       return delayed;
      };
      return store;
     }; return tx;
    };
   }});
   req.onsuccess?.();
  }; return req;
 };
 const initializing = lib.init(); await barrier;
 await lib.adoptFileList([file('new.mp3', 'New/new.mp3')]);
 assert.equal(lib.root.name, 'New');
 release(); await initializing;
 assert.equal(lib.root.name, 'Old'); assert.equal(lib.tracks[0].name, 'old.mp3');
 // The retained fallback Files are for New, while the visible library is Old.
 assert.equal(await lib.openFile(lib.tracks[0]), null);
 console.log('REPRO 4: delayed startup init overwrites newly imported root with', lib.root.name, '; old row cannot play');
}
{
 const scope = fakeIdb(); const lib = new MusicLibrary({ scope });
 lib.root = {id:'root:music',name:'Music'};
 const directory = (present) => ({values:()=> (async function*(){if(present) yield {kind:'file',name:'a.mp3',getFile:async()=>file('a.mp3')};})()});
 lib.handle = directory(true); await lib.rescan(); await lib.notePlayed(lib.tracks[0], 180);
 const originalOpen = scope.indexedDB.open;
 let release, reached; const barrier = new Promise(r=>reached=r); let holdNext = true;
 scope.indexedDB.open = (...args) => {
  const raw = originalOpen(...args), req = {};
  raw.onsuccess=()=> {
   const db = raw.result;
   req.result=new Proxy(db,{get(target,key){
    if(key!=='transaction') return target[key];
    return (...txargs)=>{
     const tx=target.transaction(...txargs), getStore=tx.objectStore;
     tx.objectStore=(name)=>{
      const store=getStore(name);
      if(name!=='tracks')return store;
      const index=store.index;
      store.index=(field)=>{
       const idx=index(field), getAll=idx.getAll;
       idx.getAll=(value)=>{
        if(!holdNext) return getAll(value);
        holdNext=false;
        const source=getAll(value), delayed={};
        source.onsuccess=()=>{delayed.result=source.result;release=()=>delayed.onsuccess?.();reached();};
        return delayed;
       };return idx;
      };return store;
     };return tx;
    };
   }});req.onsuccess?.();
  };return req;
 };
 lib.handle=directory(false);const stale=lib.rescan();await barrier;
 lib.cancel();lib.handle=directory(true);await lib.rescan();
 assert.equal(lib.tracks.length,1);assert.equal((await listTracks(lib.root.id,scope)).length,1);
 release();await stale;
 assert.equal(lib.tracks.length,1);assert.equal((await listTracks(lib.root.id,scope)).length,0);
 console.log('REPRO 5: canceled old prune deletes a row committed by a newer completed scan; view retains 1 while durable rows 0');
}
{
 const { KeepAwake } = await import('../../../work/repository/src/ui/KeepAwake.js');
 let rejectRequest;const pending=new Promise((_r,reject)=>rejectRequest=reject);
 const appended=[];let stopped=0;
 const doc={visibilityState:'visible',addEventListener(){},removeEventListener(){},body:{appendChild:video=>appended.push(video)},createElement(tag){
  if(tag==='canvas')return {getContext:()=>({fillRect(){}}),captureStream:()=>({getTracks:()=>[{stop(){stopped++;}}]})};
  return {style:{},setAttribute(){},play(){return Promise.resolve();},pause(){},remove(){}};
 }};
 const ka=new KeepAwake({nav:{wakeLock:{request:()=>pending}},doc});
 ka.enable();await Promise.resolve();ka.dispose();rejectRequest(Error('NotAllowedError'));
 await new Promise(r=>setTimeout(r,0));
 assert.equal(ka.enabled,false);assert.equal(ka.usingFallback,true);assert.equal(appended.length,1);
 ka.disable();assert.equal(stopped,0);
 console.log('REPRO 6: rejected in-flight wake lock resurrects fallback video after dispose; enabled false, fallback true; disable does not stop its stream');
 // Explicitly clean repro fake.
 ka.stopFallback();
}
```

### worker-failure-probe.mjs

```javascript
// Audit probe: resolves the unchanged pinned snapshot in this audit workspace.
import { audioToTimeline } from '../../../work/repository/src/audio/AudioAdapter.js';
const instances=[];
globalThis.Worker=class{constructor(){this.terminations=0;instances.push(this);}postMessage(){}terminate(){this.terminations++;}};
globalThis.window={OfflineAudioContext:class{constructor(){throw new Error('injected OfflineAudioContext allocation failure');}}};
const channels=[new Float32Array(48000)];
const buffer={numberOfChannels:1,length:48000,sampleRate:48000,duration:1,getChannelData:c=>channels[c]};
const controller=new AbortController();
try{await audioToTimeline(buffer,{signal:controller.signal});}catch(error){console.log(JSON.stringify({case:'native band setup failed',error:error.message,workers:instances.length,terminations:instances.map(w=>w.terminations),signalAborted:controller.signal.aborted}));}
controller.abort();console.log(JSON.stringify({case:'manual abort after failed analysis',terminations:instances.map(w=>w.terminations)}));
```

## Commands used during the completed audit

Commands ran from the isolated `work/repository`, with Node 24.10.0 selected and unrelated Git environment variables unset. GPU review used native Windows Node/Chrome to reach the RTX 3060. These commands were not rerun merely to publish documentation.

```sh
npm ci --ignore-scripts --no-fund --no-audit
npm test
npm run lint
npm --prefix ridgeview test
npm audit --json
node tools/stage-site.mjs . ../staged
SITE_ROOT=../staged BOOTSTRAP_SMOKE_PORT=4197 \
  PLAYWRIGHT_CHROMIUM_PATH=/home/aepler315/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome \
  node tools/bootstrap-smoke.mjs
node tools/palette-bench.mjs
node tools/gpu-review.mjs --snapshot ../runtime-snapshot \
  --out ../../outputs/evidence/gpu-fixed-verified --seconds 2 --fps 12
node tools/gpu-review.mjs --snapshot ../runtime-snapshot \
  --out ../../outputs/evidence/gpu-live-300 --grid classic \
  --seconds .25 --fps 4 --live-seconds 300
```

## Reviewed history

| Commit | Author date | Subject |
|---|---|---|
| [8f7c10fecdb9](https://github.com/aepler315/midio-pixel/commit/8f7c10fecdb9c436f7e789ec094c79efe88eff31) | 2026-10-20T11:01:50Z | Merge pull request #16 from aepler315/codex/cloud-variety-gpu-tests-20261020 |
| [65b227860a02](https://github.com/aepler315/midio-pixel/commit/65b227860a02de7124d7b5cf214f7581ab6fd971) | 2026-10-20T11:00:55Z | Vary world cloud shapes and add local RTX 3060 validation |
| [51dae09ffb67](https://github.com/aepler315/midio-pixel/commit/51dae09ffb673c2b26317219c5530973eb48fb33) | 2026-10-20T10:46:46Z | Run validation locally and keep hosted tests manual |
| [9a500dfbb07b](https://github.com/aepler315/midio-pixel/commit/9a500dfbb07b3f389c4efae47f8a30e3b9cce4ac) | 2026-10-20T09:44:00Z | Merge pull request #15 from aepler315/codex/world-clouds-20261020 |
| [b00124a71e60](https://github.com/aepler315/midio-pixel/commit/b00124a71e60c4fa07e47f68a1c04aac792f6769) | 2026-10-20T09:11:27Z | Fix world-space cloud motion and replace flat cloud masks |
| [2f134cea621f](https://github.com/aepler315/midio-pixel/commit/2f134cea621ff83f02fa53c805e629f7e4c035c6) | 2026-10-20T08:18:32Z | Merge pull request #14 from aepler315/codex/pixel-grid-detail-20261019 |
| [da76c706cb95](https://github.com/aepler315/midio-pixel/commit/da76c706cb95045655d98f95cfd50720b1b2c9e4) | 2026-10-20T07:39:39Z | Keep visual review headless and noninterrupting by default |
| [b70285e3d066](https://github.com/aepler315/midio-pixel/commit/b70285e3d066ec84d51d75e3e5b92d5044191fcb) | 2026-10-20T07:36:17Z | Preserve pixel crowns and isolate background review lifecycle |
| [e546764fa593](https://github.com/aepler315/midio-pixel/commit/e546764fa593625a5022e3f69b572348798d7970) | 2026-10-20T07:08:24Z | Compose smooth Landscape skies and review playback in the background |
| [0fe7c31671d8](https://github.com/aepler315/midio-pixel/commit/0fe7c31671d8f31b2683c8a77abbacf82995cde2) | 2026-10-20T06:24:25Z | Keep displayed forests through pixel detail rebuilds |
| [052ce85e5b72](https://github.com/aepler315/midio-pixel/commit/052ce85e5b729d4405a7906272ce20b8f42badb2) | 2026-10-20T06:14:00Z | Match landscape detail work to the pixel grid |
| [fd3256472fa9](https://github.com/aepler315/midio-pixel/commit/fd3256472fa9733cdb52ddb64ae550983aee9714) | 2026-10-20T03:50:21Z | Merge pull request #13 from aepler315/codex/terrain-window-performance-20261019 |
| [99ad7ca00777](https://github.com/aepler315/midio-pixel/commit/99ad7ca0077791a44eb5b76ff5147169c66b8afd) | 2026-10-20T03:39:17Z | Reduce terrain window planning and prioritize the current view |
| [9dfbf1974582](https://github.com/aepler315/midio-pixel/commit/9dfbf19745820506e2ba772e155b0947d555b7f2) | 2026-10-20T03:22:52Z | Merge pull request #12 from aepler315/codex/teton-tour-skyline-20261019 |
| [33d20f9a24d1](https://github.com/aepler315/midio-pixel/commit/33d20f9a24d165e1501b2a260d56d18311d7e016) | 2026-10-20T01:14:15Z | Reclaim uncovered terrain before fallback admission |
| [86ce3a90f291](https://github.com/aepler315/midio-pixel/commit/86ce3a90f2910028292157903d2207559235813c) | 2026-10-20T00:58:28Z | Back off denied terrain admission without delaying export settling |
| [dca5fb86c649](https://github.com/aepler315/midio-pixel/commit/dca5fb86c649bc0f4da7fa2934fccc8b3716189c) | 2026-10-20T00:44:27Z | Preserve summit detail within wide tour terrain budgets |
| [38e8046962aa](https://github.com/aepler315/midio-pixel/commit/38e8046962aaf075415e1f05d34b929301ddf619) | 2026-10-20T00:30:22Z | Preserve the full Teton skyline through wide tour views and window changes |
| [4afdb5c84363](https://github.com/aepler315/midio-pixel/commit/4afdb5c8436384a09169b9b8fb0c96210d529d97) | 2026-10-19T22:51:08Z | Merge pull request #10 from aepler315/codex/automatic-trio-stage-20261017 |
| [2d306ca6a30f](https://github.com/aepler315/midio-pixel/commit/2d306ca6a30f2811bc7e9d59c51ed82e1e15d4f5) | 2026-10-18T06:03:42Z | Restore automatic Trio Stage with playback-safe experience switching |
| [6cacb1b8691a](https://github.com/aepler315/midio-pixel/commit/6cacb1b8691ae438670c1a861bb3464038e96628) | 2026-10-18T07:00:35Z | Yield landscape surface and contour preparation between frames |
| [abe1dc2943c6](https://github.com/aepler315/midio-pixel/commit/abe1dc2943c6df827f768cbec1f42fdf09bb8320) | 2026-10-18T06:38:05Z | Fix frame-probe segment boundaries and preserve real quality-transition gaps |
| [40b8fbb59aea](https://github.com/aepler315/midio-pixel/commit/40b8fbb59aeafb11c984f3fcda5fd49926d0c0c7) | 2026-10-18T06:30:15Z | Resolve sky camera bases once per frame; preserve exact rendered pixels |
| [79aed28c4e71](https://github.com/aepler315/midio-pixel/commit/79aed28c4e715d6e44abaf7d87b54a5de5cc26c5) | 2026-10-18T06:03:28Z | Compile song-shaped Landscape weather and compose safe musical views |
| [27b70462afe4](https://github.com/aepler315/midio-pixel/commit/27b70462afe468f5af44e0e8662e21a47e2b0277) | 2026-10-19T22:50:55Z | Merge pull request #8 from aepler315/codex/core-validation-20261017 |
| [7fb942dc31a5](https://github.com/aepler315/midio-pixel/commit/7fb942dc31a564bfc230954b31a32595d925a47d) | 2026-10-18T06:01:15Z | Bound core validation and reconcile companion pin and Pages evidence |
| [0a82fba1e29f](https://github.com/aepler315/midio-pixel/commit/0a82fba1e29f99347a22ecf98db40b7d8cb1834d) | 2026-10-18T05:10:30Z | Merge pull request #7 from aepler315/fix/landscape-sky-continuity |
| [fb266c2ea37d](https://github.com/aepler315/midio-pixel/commit/fb266c2ea37d6b6a6fea08f4016d0b2a4f1a8823) | 2026-10-18T04:56:56Z | Repair Range water, forest, camera and musical sky continuity |
| [5fade9d4645f](https://github.com/aepler315/midio-pixel/commit/5fade9d4645f6dab23fe8d0f756abb34b0715719) | 2026-10-17T13:19:39Z | Merge pull request #6 from aepler315/fix/range-tour-stars |
| [57678190c93b](https://github.com/aepler315/midio-pixel/commit/57678190c93b8b8b76e018a295e550fa5deadca7) | 2026-10-17T11:44:48Z | Restore Range camera tour access and narrative stars |

## Complete retained evidence manifest

This records all evidence files in the original manifest, including raw captures retained outside Git. The manifest identifies bytes; it does not assert remote availability. Paths are relative to the original evidence directory.

| Artifact | Bytes | SHA-256 |
|---|---:|---|
| `README.md` | 6437 | `0463d4fd6e54f3469de7c6ad0da6150798b1de110793418ce8c072c2f224068d` |
| `bootstrap-staged.log` | 72 | `cab6f77f5bbdb81712554db21a771fea5cbd81ef8f10b9ee578c325b3c5899b6` |
| `cpu-probe-idle.jsonl` | 100575 | `99fce79b200b27ef7be5057336abd6706c11bba0cc72d223601e8cec405e91c4` |
| `deliverable-validation.json` | 575 | `445311e065f2ee987c6b6056f5795a4bdfc9f3c8b49e3a0037a308df68a2ea44` |
| `dependency-audit.json` | 363 | `ba25ae31d3d502246ec0b587edfff9fb3b7d14fa249cbda2ee31b095385e2c15` |
| `gpu-fixed-verified/classic/contact-sheet.png` | 538547 | `e78f598bbd4c17e822b45f2a0fa317119c95eab982f1f8f9ca1ffb7cd7ddccaf` |
| `gpu-fixed-verified/classic/index.html` | 10193 | `93a28a535e233daa2022d5f319e4a65aafee4daca9b308355e4647998713d828` |
| `gpu-fixed-verified/classic/manifest.json` | 893 | `f17cf80ed517ae02ba3f4ac99b39eba71d87ed5aab50c45b11dbe09e0f185d8a` |
| `gpu-fixed-verified/classic/report.json` | 14813135 | `3399830d28c242c58d9fb9f2b0de06324c30abd18ac1e9d59e1bbf04e8058de4` |
| `gpu-fixed-verified/classic/review-audio/audio.wav` | 7938044 | `c0160a5c95669def70cfe43feeca1c06b81117cf01f2b4e43d59f1ef59e02297` |
| `gpu-fixed-verified/classic/review-audio/frame-00000.png` | 402272 | `cc329894088275b9107b697fa5cd6411428eedb6a551601cb649a0fd0f1a9896` |
| `gpu-fixed-verified/classic/review-audio/frame-00001.png` | 404976 | `d688cab3fb4674a29c4eb64bdfdbaca1faf1332c119f062117fa9e3c032d6097` |
| `gpu-fixed-verified/classic/review-audio/frame-00002.png` | 415603 | `dd12745d25820c9a161aa6c482ad5dc36f675838e662275a64f4642b78135045` |
| `gpu-fixed-verified/classic/review-audio/frame-00003.png` | 381317 | `8f8fd13da204f4830df3c63413d5755a32033e66868dd7a76acb3035c234236e` |
| `gpu-fixed-verified/classic/review-audio/frame-00004.png` | 399627 | `d21fc18f9bcbd305327e11c9e4ebc11027883b80cc5a9237af5237a2cbd05c22` |
| `gpu-fixed-verified/classic/review-audio/frame-00005.png` | 410442 | `72faf07fcbfa14f5acc21de8e308fb27eb93d58c796f7d0291cc38fb2e6814b9` |
| `gpu-fixed-verified/classic/review-audio/frame-00006.png` | 415796 | `8ed45312f42aeed99c0e13a6607c51d43810ac9357106d0136bbdeebecced082` |
| `gpu-fixed-verified/classic/review-audio/frame-00007.png` | 414521 | `cd4fef26ed6be439a2193b06c117c4c336b8299e81fa35d0a3d5c245e3440a57` |
| `gpu-fixed-verified/classic/review-audio/frame-00008.png` | 415619 | `f457ebc32b7919861659e99a29c505afaee140dcc86a1b3c38131d6e27a19274` |
| `gpu-fixed-verified/classic/review-audio/frame-00009.png` | 418128 | `3a23b302d36f692c5f64097d324209e9c1baab2b62798ab1d0ff7243ac3a7c0d` |
| `gpu-fixed-verified/classic/review-audio/frame-00010.png` | 416588 | `05cad6263f6677ee0be76b09f3809a05e73051ed6ba48e5ff648da02bfa0102c` |
| `gpu-fixed-verified/classic/review-audio/frame-00011.png` | 418108 | `e2b6c95948c491fa94509ab9ae2c2cc63568ac3caea3f1a057ecd2a15946a346` |
| `gpu-fixed-verified/classic/review-audio/frame-00012.png` | 408740 | `c1ffe9f47be430d2e6e715d8e96f8872fa8d796559298c93032acd49102fce8d` |
| `gpu-fixed-verified/classic/review-audio/frame-00013.png` | 412606 | `e2fc52f9a3e37244170e6a55c56b3c3b6d3def0ef9fd57c8732417f072e35088` |
| `gpu-fixed-verified/classic/review-audio/frame-00014.png` | 409905 | `e4ea3ad3d3c036542ea289524567aa20d10f4ed38479188e58dfb0b05ee680f4` |
| `gpu-fixed-verified/classic/review-audio/frame-00015.png` | 413596 | `9fd9180af9f0375dec18a159ededcc4e139466b4617f34d8ed1bb3e490a0cb86` |
| `gpu-fixed-verified/classic/review-audio/frame-00016.png` | 414188 | `823a10c66957690fd5589001793bc8854fd16b77824e141b95d1e95e857db326` |
| `gpu-fixed-verified/classic/review-audio/frame-00017.png` | 415813 | `59bea78b4668877eb4474f662b2e9d7610772fde509d1bd02aae8cd2ef20fe29` |
| `gpu-fixed-verified/classic/review-audio/frame-00018.png` | 409256 | `986ad41fc65f97d3269b15712b77f74be7f5f4ed1800ffea01d45ed949fd034f` |
| `gpu-fixed-verified/classic/review-audio/frame-00019.png` | 409667 | `4a2aa5b061db6d45b2032de12d752aaa43bad735426f6f38500068189fbf7423` |
| `gpu-fixed-verified/classic/review-audio/frame-00020.png` | 407954 | `445b158cac2ec952344e24992c9ebf2ab51a4a1092d3b4bf70b84ded7a88445e` |
| `gpu-fixed-verified/classic/review-audio/frame-00021.png` | 411107 | `7067f3da338f8b8c376ecffc63dd6675e84d170bf6ecb7a96a7707b9d2b9e67f` |
| `gpu-fixed-verified/classic/review-audio/frame-00022.png` | 407570 | `9d8f92df53bd7006432f68a2c4b16ad13dcd26288db9caa2b6981d1e7f57fb7b` |
| `gpu-fixed-verified/classic/review-audio/frame-00023.png` | 406502 | `96a4e72321ce2140e162a714accc04c1a3e4744b723fb1a5cdd50b2b427a5c90` |
| `gpu-fixed-verified/classic/review-audio/frame-00024.png` | 402669 | `2510ced9236e862e5a049ca0335878770cd46e86365a76870073bc6f017b9e01` |
| `gpu-fixed-verified/detailed/contact-sheet.png` | 531555 | `1727a8b337a2f390b1891e9fa27b96cf5e4626e8b0553beb3b05b10f43691348` |
| `gpu-fixed-verified/detailed/index.html` | 10007 | `bce80e9ce1e1f0176dbe40d012339e5d332905dd9efec68a7e51d29ea5759836` |
| `gpu-fixed-verified/detailed/manifest.json` | 894 | `821c354513cd8fa9b5ca25230e800be2ff90a9601b144242be7322186ec132f0` |
| `gpu-fixed-verified/detailed/report.json` | 14805536 | `9612fd5ede69e3f26be07b8e72de8d5d94a33ded14d08e3e7550b25190b856b4` |
| `gpu-fixed-verified/detailed/review-audio/audio.wav` | 7938044 | `c0160a5c95669def70cfe43feeca1c06b81117cf01f2b4e43d59f1ef59e02297` |
| `gpu-fixed-verified/detailed/review-audio/frame-00000.png` | 596701 | `e0110582663b3b04a668fe50b19b39fac715fb0cc396acff2300b37bdc978d9c` |
| `gpu-fixed-verified/detailed/review-audio/frame-00001.png` | 599828 | `0da98725e65627e94bfb62d668f5c04181379ce2c3a4d46668805881d06a0eb4` |
| `gpu-fixed-verified/detailed/review-audio/frame-00002.png` | 611176 | `9e89e31d3cf31473932692996e3286d729f924ff8ed42d425651077e0cca4cf1` |
| `gpu-fixed-verified/detailed/review-audio/frame-00003.png` | 561534 | `9390ac01a2fc8bdfd4e42b2584fb63747cf5dd1a7274bc2e39c46eafc4d740d7` |
| `gpu-fixed-verified/detailed/review-audio/frame-00004.png` | 581897 | `3375cd699277e29c10ce8c10147ac5896cce3fda5bfd941e4673b2dae8bb5932` |
| `gpu-fixed-verified/detailed/review-audio/frame-00005.png` | 599709 | `f7e4ab5885f5a14fa6b79d858f63ca78edba454058ea055483da5377eaf6931f` |
| `gpu-fixed-verified/detailed/review-audio/frame-00006.png` | 611220 | `ffa6cd3066ecc5feec30800df6456328c49a1c8c45fa851ac73a8e3a6d68d66b` |
| `gpu-fixed-verified/detailed/review-audio/frame-00007.png` | 608963 | `299ca34367618993922ec0103910969fd52079ef7455e8fee7dcbe3627bb75f5` |
| `gpu-fixed-verified/detailed/review-audio/frame-00008.png` | 609434 | `1a0db06c13e479ce2af716a92c92c8bc556728de8b3e67caf17b3fbe059507db` |
| `gpu-fixed-verified/detailed/review-audio/frame-00009.png` | 613670 | `8d1b02e1c3a6563043db62011f2cc86cbef5793337ab64a66e0f12acec7548bc` |
| `gpu-fixed-verified/detailed/review-audio/frame-00010.png` | 612755 | `1bbf4cbe39773c4c4ff428164629edbcc0e97c5ee1e80f976f217ccc6eadb2f1` |
| `gpu-fixed-verified/detailed/review-audio/frame-00011.png` | 607071 | `3056f259ce809dda3f22363c1177a28e24cf9986d051795e277b275100719135` |
| `gpu-fixed-verified/detailed/review-audio/frame-00012.png` | 606015 | `f615bd669dba141ed03eca8f56d3fbfa8d9f55a8ab34f543343d1d676e84cdee` |
| `gpu-fixed-verified/detailed/review-audio/frame-00013.png` | 608264 | `6d6e2f23dc2fb7784deea28c83c2321a55ea3b9891f693bd817952fe4dd74870` |
| `gpu-fixed-verified/detailed/review-audio/frame-00014.png` | 601175 | `2cb0e4cb5a1be2cce72cd712f21da030f716202b27993d98813a23369a298782` |
| `gpu-fixed-verified/detailed/review-audio/frame-00015.png` | 605752 | `b351695143c166d94e183f69e81f07a6f7652c589fa24c61c60d8095fd18bf9d` |
| `gpu-fixed-verified/detailed/review-audio/frame-00016.png` | 607832 | `434b5a33b13c83d112a66c57f0983eef37c07060e312aefe54c289331642d8b4` |
| `gpu-fixed-verified/detailed/review-audio/frame-00017.png` | 607869 | `533cfef629044ec61116065fbadbf655b05ff40c4f57c8040d6e63a838cadfa4` |
| `gpu-fixed-verified/detailed/review-audio/frame-00018.png` | 600354 | `51aba1dd0c09e73d2d86045abd7823fd849e2b388d5924735ca081f20f64af00` |
| `gpu-fixed-verified/detailed/review-audio/frame-00019.png` | 599436 | `20dc8807a20e3382a3e33a7d1daeb1ae7c00ffca8a0278e25d0b2608fade8f8a` |
| `gpu-fixed-verified/detailed/review-audio/frame-00020.png` | 600590 | `7d5628f8a2745c0654cf717ff39f34f3d69dccacfb09718d766c40e1778fa198` |
| `gpu-fixed-verified/detailed/review-audio/frame-00021.png` | 601845 | `9bd1a308636a8111c7896e86bdb1acc1973cdcf97be370b7c184d83fab4188a8` |
| `gpu-fixed-verified/detailed/review-audio/frame-00022.png` | 594791 | `8305d321c535d328477863880b1d072f4cf6f0cc6cf3a6e47aa0938d3d78cd84` |
| `gpu-fixed-verified/detailed/review-audio/frame-00023.png` | 594518 | `56fa623e156290ac16a1d3ffb0320f0560c2015ba7b410acefc68a05a950a5a3` |
| `gpu-fixed-verified/detailed/review-audio/frame-00024.png` | 592370 | `709f1e2429019107ce5b50c267fc190d6953f81c40a19714531ce1584098ddbd` |
| `gpu-fixed-verified/index.html` | 1353 | `a2d764bf6223bd8b69aef62a85ff64ff3def012adcffa1595dfd679a2ae38296` |
| `gpu-fixed-verified/input.wav` | 7938044 | `c0160a5c95669def70cfe43feeca1c06b81117cf01f2b4e43d59f1ef59e02297` |
| `gpu-fixed-verified/report.json` | 76101 | `8417b9dddcdaaedb4a335f7a7d70ab4878b313db4c093f4e39e57f05aa9e9ce4` |
| `gpu-fixed-verified.log` | 652 | `20681a2642f198d63448f30ccf02c292c3056d4c9b95cda4789a46e514405f93` |
| `gpu-live-300/classic/contact-sheet.png` | 187158 | `bc193f85a5c826bd9f643872ffa8b3b59d0915d7b3ad5836f0c62fff8b335ab0` |
| `gpu-live-300/classic/index.html` | 4688 | `99968f3d271004f2d06d65b5967b4b9bd1762ac999a6ec2fa08e3e0629b07fd3` |
| `gpu-live-300/classic/manifest.json` | 892 | `ed1f21bafb674f05bb8757b6fb17754016c059cf69bd07cd069cca8660930496` |
| `gpu-live-300/classic/report.json` | 1325262 | `4d2f31c9425e8759743c72112d6e24e8c9df84b290a4931013e9ccbba9017995` |
| `gpu-live-300/classic/review-audio/audio.wav` | 27783044 | `4abe08f92ded6d0748211e75297438a11f663435cbebd3a3b29fdd17f6001f15` |
| `gpu-live-300/classic/review-audio/frame-00000.png` | 374182 | `fc2ddd0f0dcc02b54c4b596b48dbe984e1f4fc534b15dcc9926ad41c03f43cc1` |
| `gpu-live-300/classic/review-audio/frame-00001.png` | 374587 | `d4699ec74a739f5e8d1ac5ef44c1dabe1c50d9a18d68a01a83410b207d9e514a` |
| `gpu-live-300/index.html` | 1122 | `a58c4ba4118ef24079d7d81416f4f366eab203a083755631e0a79083c09b8a35` |
| `gpu-live-300/input.wav` | 27783044 | `4abe08f92ded6d0748211e75297438a11f663435cbebd3a3b29fdd17f6001f15` |
| `gpu-live-300/live-report.json` | 11104 | `1ef8a6bb4b032518a15f9ec93b8bc6e7dbce0a35b4bdebb33d3bd68671019e59` |
| `gpu-live-300/report.json` | 87553 | `833862fee9a1f0fe8e3e76f817227e255ead23cab59010bb24667b68d1529c9c` |
| `gpu-live-300.log` | 419 | `49119e4a0a0d6c28a7fe62f09b05458cc1bb87d740a6c5b8621d7336ecc58dd2` |
| `index.html` | 7832 | `1cbfbfb3fa726954d8d3c9ec3d5bb786b38f54eff454a384a6ce798e79d87fe7` |
| `lint.log` | 61 | `e88a330e43e94d225537b8996e8937ff952ca169dcbd3a5f733b77b31285e84f` |
| `npm-test.log` | 441714 | `e528fc600b03c891c6a148d3b334d75b1acfed4ebafa5d5905c9b79df8ecb8a3` |
| `palette-arithmetic.json` | 2926 | `8a2abfa3becd77a15e4e3abe80473b5bf5371095c91299e37cd704859e339332` |
| `pinned-source-manifest.json` | 160099 | `26d9bbf16526412475e4b2f8a69ed2dff3d4a3bb607c33a1f59f9016dc81da42` |
| `probes/cpu-probe.mjs` | 3068 | `aeacab5c40925e7528fbdc16d3da770663348434da547d2e9fbb2dd65e8b752d` |
| `probes/reproduce-reliability.mjs` | 7204 | `eff51245d30f6e2ae574b0d215de55cc7f99c0669b0ecbe23b3353c19c6e03b6` |
| `probes/worker-failure-probe.mjs` | 1046 | `2ec2e833e841d9d6d6acd65f8be6d980bc5edb45f69eadcc590b70f222b96024` |
| `recent-history.json` | 9516 | `7d7905af1e2b5bbe362d00e0a62a643b805efd18837be1b57797ba16b3ab19cd` |
| `reliability-reproductions.log` | 843 | `c2505e291c4a581b47ba04e78157d52d836ca63f1004d8f4b39a2247bbc18dfd` |
| `report-validation.json` | 94 | `c8258ee29fc03e9be0b6b1f872fe08f24a9aeec74769e4c459557c83ce45ab5f` |
| `ridgeview-test.log` | 1917 | `4446b61df9c69db6630fddb6da338b661e9750cb85574f82ee427549b5b031c6` |
| `source-verification-final.json` | 375 | `2e277c68dd7e4006ff1806c603685a9018b6c54b9f111319b79d2a68b522154d` |
| `source-verification.json` | 198 | `f9d561cada3b09a19eeb0a6915c674961321e841c018541d37233d287cf4ea38` |
| `staging.log` | 122 | `9f7bb36ee1a57df84aadf7d6f18159f888cd69150b08b0eeb766231864ce70b7` |
| `worker-failure-reproduction.jsonl` | 212 | `075395ee7981cd9e5467a0ea26bd3559e6687c54a3f29df265cb48e38ada4b0e` |
