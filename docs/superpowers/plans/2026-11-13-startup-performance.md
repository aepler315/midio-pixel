# Startup performance investigation

**Goal:** Reproduce the opening quality collapse on current main, repair the measurement gaps, and make a bounded fix supported by matched RTX 3060 evidence.

**Architecture:** Keep the live audio loader and existing rendering/governor architecture. Add explicit playback presentation telemetry, reliable capture boundaries, and bounded startup records before choosing any performance change.

**Environment:** Node 24.x, MSI-WORKSTATION, isolated headless muted Chrome. Reject software or unknown GPU identities for hardware claims. Evidence stays in `.smoke/`; no merge or publication.

## Tasks

- [x] Add regression tests and fix live capture ordering, real presentation classification, atomic stop, and separate callback/CPU/wait quantities in `tools/range-live-callbacks.mjs` and `test/frameCostInstruments.test.mjs`.
- [x] Add stable frame and analysis lifecycle diagnostics in `src/main.js`; pin fixture quality before playback and retain it across timeline replacements and seeks. Test lifecycle boundaries.
- [x] Preserve first-30-second statistics and whole-run aggregates in `src/render/PerfGovernor.js`, with deciding synchronous waits; test runs longer than the rolling ring.
- [x] Capture the opening and recovery observation window through the same live loader with matching audio, sample rate, source, seed, stage identity, presentation settings and GPU. Compare full and dry runs, and record any analysis replacement.
- [x] Use measured evidence to choose a bounded fix; add a focused regression and repeat identical captures including continuous playback.
- [x] Run focused tests, lint and appropriate integration checks; independently review changes and document limitations.

## Review focus

Fast 2D presentations count while slow HUD callbacks do not. Readiness and profiler shutdown must not trim or extend the playback window. Pins survive seeks and analysis replacement. Startup records survive long songs. Full/dry comparisons must use identical live song identity and actual hardware.

## Initial verification

Remote main remains `e2725b70982e2b424b229de31f4cea8d00732d3c`. Baseline focused tests: 25 passed. Native Chrome 157.0.8103.40 reports ANGLE NVIDIA GeForce RTX 3060 Direct3D11 from the actual WebGL2 context. Node 24.22.2 is available via `fnm exec --using 24.22.2`.

## Measured result

The historical opening descent to level 6 was **not reproduced on current main**. With measurement repairs and no performance change, the 90-second live fixture stayed at level 0 until 75.4 seconds, then descended to level 2. A separate CPU-profiled baseline held level 0 until 73.7 seconds. This does not establish which earlier commit resolved the historical behavior.

Canvas `getImageData` dominated callback waits: 33.6 seconds summed across the unprofiled baseline. The CPU profile attributed 15.2 seconds inclusive to `_prepareEdges`, which read colors even when the frozen crest opacity was zero and `drawCrest` could not consume them. The bounded fix adds the same visibility guard to `_prepareEdges`. Probe updates and smoothing continue, and the first visible frame refreshes its colors. No adaptive-governor policy changes were made.

Matched unprofiled hardware observations (milliseconds unless stated):

| Window / metric | Before | After |
| --- | ---: | ---: |
| First 10 s callback median | 14.6 | 7.4 |
| First 10 s callback p95 | 18.2 | 9.9 |
| First 30 s callback median | 10.4 | 6.3 |
| First 30 s callback p95 | 16.7 | 14.6 |
| First 30 s product synchronous-wait median | 5.6 | 0.9 |
| First 30 s governor CPU-work median | 5.2 | 5.3 |
| First 30 s summed canvas reads | 9,353.5 | 426.6 |
| First 30 s presentation-period median | 17.6 | 17.6 |
| Quality at 90 s | 2 | 2 |

This reduces opening callback cost, not the headless presentation interval. Late-song pressure remains: candidate quality first fell at 74.4 seconds and reached 2 at 81.1 seconds. The 60–90 second callback median was 19.4 ms before and 19.7 ms after; no late-song improvement or recovery is claimed. The separate profiled candidate confirmed a 6.5 ms first-30-second callback median and only 397 ms summed canvas reads.

A final 95-second capture after the scene-history repair covered the complete 90-second recording and its ending. It confirmed a 6.4 ms first-30-second callback median, with 421 ms summed canvas reads, no browser errors and contiguous presented-frame IDs 1–4919. Its final frame reached heard time 91.15 seconds and rendering then stopped within the observation window. Quality reached level 3, so the observed late-song outcome varies between levels 2 and 3; full-quality continuous playback is not established.

## Comparison identity and artifacts

All runs used the same real live loader and generated 90-second WAV (SHA-256 `c0160a5c95669def70cfe43feeca1c06b81117cf01f2b4e43d59f1ef59e02297`), actual decoded 48,000 Hz, construction seed 315, song seed 3018423234, 1280×720 output, Cinematic / Detailed 640×360, Auto quality and 60 FPS cap. Progressive detail was inactive. The actual stage was `song-range-c7c9c4b0ccb5131e`; complete stage keys and effective settings are in every report. Full analysis replaced the opening scene during preparation, before the first playback frame, in these runs. Frame IDs began at 1 and remained contiguous.

The baseline served-source digest was `e3f2430d1c61dcdaecd8be6dbcef390f8b0745c7cfdc998dd20339f0171a88b7`; candidate `ef092e5124b867e5bf476910188a7c54a25b6f5ef5cbd193153de77784dde6a2`. These include measurement repairs; their only product-performance difference is the crest visibility guard. A matched 30-second dry baseline verified equal source/audio hashes, sample rate, song seed and stage key; its callback median was 5.3 ms. Dry rendering suppresses pixel-dependent work and is diagnostic, not a rendered performance result.

Evidence remains local and ignored under `.smoke/`:

- `rtx-baseline-live/`, `rtx-baseline-profile/`, `rtx-baseline-dry/`
- `rtx-candidate-live/`, `rtx-candidate-profile/`
- `rtx-final-continuous/`, `rtx-final-pin-seek/`
- `crest-visual-equivalence/`: identical PNG hashes and decoded RGBA at 12 and 86 seconds (zero differing pixels at both times). This separate visual check loaded through live analysis, then switched to the fixed export clock while retaining and verifying the live stage identity; it is not pacing evidence.
- `comparison.json`, capture/profile reports and validation logs.

The raw CPU profile includes preparation and a small shutdown tail; page-clock boundaries identify playback separately. Callback logs and ending governor diagnostics are frozen before profiler transfer and file writing.

Final served-source digest: `d777c56ffa9c40b6247cb14eba268faa0389d92f6524c0c0f5314b3f0fecd750`. The additional change retains outgoing governor diagnostics across rebuilds. Statistics explicitly describe one scene; the snapshot also retains the first measured scene and the seven most recent completed scenes, with omitted middle scenes counted. New loads reset that history. The existing 32-event ring remains bounded; it is not a complete event archive for arbitrarily long oscillating runs.

The final 20-second hardware dry seek check pinned level 3 before upload, sought to 12 seconds after five seconds of playback, and observed 1,113 frames all at level 3 across scene epochs 2 and 3. The outgoing scene retained all 277 timing samples in its startup and whole-run records. This validates pin/history behavior, not rendered pacing.

## Reproduce

Use Node 24.x and native Chrome on the RTX host. For example, generate the same fixture and capture through the live loader:

```powershell
fnm exec --using 24.22.2 node tools/gen-pilot-wav.mjs .smoke/startup-input-90s.wav 90
fnm exec --using 24.22.2 node tools/range-live-callbacks.mjs --song-range force --audio .smoke/startup-input-90s.wav --seconds 95 --hardware-gpu --browser 'C:/Program Files/Google/Chrome/Application/chrome.exe' --out .smoke/startup-review --label startup-review
```

Add `--profile` for preparation and playback CPU sampling. Use `--dry` with the same live loader for diagnostic comparison. `--level 3 --seek-at 5 --seek-to 12000` exercises a pin through a seek. These commands use isolated browser profiles and muted headless operation; output paths should be unique to preserve earlier evidence.

## Validation

Final full suite: **5,651 passed, 11 skipped, zero failures** (5,662 total, Node 24.22.2). `npm run lint` passed; all 468 runtime modules parsed and linked. Initial full suite: 5,638 passed, 11 skipped, zero failures. The skips cover unavailable cached DEM fixtures and Python GDAL bindings. Focused failing-first regressions cover frame classification and boundaries, quality pins, retained timing/event history, hidden-edge reads, fresh visible colors and unchanged smoothing. Independent review identified the outgoing-history gap; it was fixed and covered by regression and the real seek run. A final Windows helper-window option change passed the nine instrument tests and scoped lint again; it does not change served application source.

## Limits

The 90-second contrast fixture is the historical composed-stage reproduction case, not the canonical 513.8-second Dual Summits recording. Dual Summits continuous musical acceptance, physical-display pacing, other catalog views and JOYING hardware remain unverified. Approximately 270 ms isolated CPU callbacks remain in both full and dry traces, and late visible-crest readbacks remain costly. Neither is hidden by changing governor thresholds.

A subsequent [supplied-MP3 automatic-selection check](2026-11-13-startup-mp3-acceptance.md) covers the complete 513.8-second recording on the RTX. It confirms lower opening callback cost, while documenting a remaining analysis-handoff pause and later quality drops in the automatically selected catalog view. It does not activate or validate authored Dual Summits.
