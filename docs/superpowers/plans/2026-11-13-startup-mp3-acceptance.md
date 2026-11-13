# Supplied MP3: RTX startup and continuous playback

Follow-up to [the startup performance change](2026-11-13-startup-performance.md), using the user-supplied `LANDR-ds182-Open-High.mp3` and the requested automatic scene selection. No additional runtime changes were made for this check.

## Result

The historical opening fall to quality level 6 did not reproduce. Both the 90-second baseline and the candidate's first 90 seconds stayed at level 0. The crest visibility guard substantially reduced callback waits in this recording's opening, while median presentation timing stayed unchanged.

| Matched elapsed window / metric | Before guard | After guard |
| --- | ---: | ---: |
| First 10 s callback median / p95 | 14.8 / 17.3 ms | 7.1 / 8.7 ms |
| First 30 s callback median / p95 | 14.9 / 17.0 ms | 6.3 / 8.2 ms |
| First 30 s governor CPU-work median | 5.8 ms | 5.5 ms |
| First 30 s product synchronous-wait median | 8.8 ms | 0.8 ms |
| First 30 s summed canvas reads | 12,500.2 ms | 0 ms |
| First 90 s callback median / p95 | 15.5 / 16.5 ms | 5.6 / 7.5 ms |
| First 90 s presentation-period median | 17.6 ms | 17.6 ms |

First-30-second callback median decreased about 58%. This is callback-cost improvement, not a frame-rate improvement. The first 10 seconds compare opening analysis in both runs. Full analysis became active at different elapsed times, so the longer aggregate windows contain different proportions of opening/full analysis.

The candidate ran continuously for the entire 513.763-second recording and its ending, without seeking or a quality pin. Its 520.008-second observation contains 28,337 contiguous presented-frame IDs. The last frame reached heard time 514.795 seconds, and rendering had stopped 4.636 seconds before capture ended. No browser errors were recorded.

Continuous playback did not hold maximum quality. Changes, measured from the first presented callback, were:

| Elapsed seconds | Quality change |
| ---: | --- |
| 158.2 | 0 → 1 |
| 374.9 | 1 → 0 |
| 394.5 | 0 → 1 |
| 398.6 | 1 → 2 |
| 421.2 | 2 → 3 |
| 457.2 | 3 → 4 |

Level 4 persisted through the ending. The baseline ends at 90 seconds; no before/after conclusion about later quality, recovery or callback cost follows from this pair.

All five reductions were governor period-pressure decisions: deciding frame periods were 34.7–36.3 ms, CPU work 6.9–8.4 ms and product synchronous waits 12.2–14.5 ms, with `workOverCount: 0`. This records missed frame deadlines with substantial waits, not CPU-pressure shedding. These waits are not direct GPU timings. There is one matched run per variant for this MP3.

## Remaining startup stalls

Full-analysis adoption preserved the catalog view and permanent song seed but rebuilt the simulation once during playback. The first new-scene callback arrived at 25.951 seconds before the guard and 13.119 seconds after it. The callback-start gap across that transition was 671.1 and 703.5 ms respectively; almost all of it occurred outside the preceding presented callback. These are presentation gaps, not callback work durations. The crest guard does not remove that handoff stall.

Isolated opening CPU callbacks also remain: maximum governor CPU work was 229.9 ms before and 229.3 ms after. The repaired diagnostics retained both opening records, each subsequent scene's separate startup record, and whole-scene aggregates without truncation or omitted scenes. Per-scene startup statistics must not be mistaken for the original song's startup after a rebuild.

## Comparison identity

- Input SHA-256: `e85b3e2fd88f616bdcf562c8c52193c26e5e2a686c9c5fb935b81bc07d5ec7a0`; encoded stereo MP3 at 44,100 Hz, decoded playback at 48,000 Hz. Decoded duration: 513.762770833 seconds.
- Chrome 157.0.8103.40, isolated headless and muted sessions on MSI-WORKSTATION. Actual rendering context: `ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002504) Direct3D11 vs_5_0 ps_5_0, D3D11)`.
- Same live upload loader, construction seed 315, permanent song seed 3960232214, 1280×720 output, Cinematic / fixed Detailed 640×360, Auto quality and 60 FPS cap. Progressive detail inactive. No CPU profiler or dry drawing suppression.
- Automatic view: `nc-ross-lake-north`, preserved across the full-analysis transition and the entire candidate run. No forced catalog view, song-range admission or authored performance. The catalog view has no composed-stage key; the reports correctly record `null`.
- Baseline served-source digest: `dc6dc24b0619800d2238ab696e330cda8610c1357525dc4a3a3e8e49f8e11045`. Candidate: `d777c56ffa9c40b6247cb14eba268faa0389d92f6524c0c0f5314b3f0fecd750` (runtime from local commit `fd9a163`). Both include the measurement repairs; source hashes differ only in `src/world/alpine/RangeCrest.js`.
- Same capture harness SHA-256: `e24a5a3b828d04e080d45601a71e0d68444c5d30ad12c94f46c1cea1f7305af8`. Capture stops before report serialization. Stop overshoot was 13.6 ms before and 8.2 ms after.

This MP3 does not match the canonical Dual Summits WAV hash and selected ordinary catalog terrain. These results do not establish authored Dual Summits musical/visual acceptance, physical-display pacing or other-device performance.

## Local evidence and reproduction

Generated evidence is ignored under `.smoke/`: `rtx-mp3-baseline/mp3-baseline.json`, `rtx-mp3-continuous/mp3-continuous.json`, and `mp3-comparison.json`. The comparison verifies equal input, instrument, browser/GPU, sample rate, seed, settings and effective presentation; the only runtime source difference is the crest guard. The raw logs preserve the actual boundaries, transitions and every presented frame.

The local `.smoke/prepare-mp3-live.mjs` generates `.smoke/mp3-live.mjs` from the tracked live profiler. It permits absent scene flags and optionally swaps saved pre-guard crest bytes into the served snapshot, updating its source hashes. Both runs use that same wrapper. `MIDIO_CREST_BASELINE=1` enables the override; leave it unset for the candidate. Independent review checked the override and automatic-selection path.

To repeat the candidate using the locally retained wrapper, replace `<mp3-path>` with the supplied file and choose a fresh output directory:

```powershell
$env:MIDIO_CREST_BASELINE='0'
fnm exec --using 24.22.2 node .smoke/mp3-live.mjs --audio '<mp3-path>' --seconds 520 --hardware-gpu --browser 'C:/Program Files/Google/Chrome/Application/chrome.exe' --out .smoke/mp3-repeat --label mp3-repeat
```

The tracked tool requires a scene flag and its manifest validation rejects `--song-range 0`; this is why these automatic-selection captures use the ignored wrapper. `--song-range 1` opts into composed stages and is not the automatic catalog-selection baseline. No tests or lint were rerun for this documentation-only follow-up; the runtime remains the previously validated change. The two captures and their comparison passed all recorded identity/continuity checks.
