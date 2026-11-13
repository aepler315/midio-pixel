# Startup handoff: measured cloud rebuild

Follow-up to [the MP3 acceptance capture](2026-11-13-startup-mp3-acceptance.md), on the same isolated branch and RTX 3060 host. Keep the input, live loader, automatic catalog selection and presentation settings fixed.

## Evidence and bounded change

A 45-second CPU-profiled live run reproduced full-analysis adoption during playback. Samples beneath `adoptFullAnalysisLive` account for 542.5 ms, including 456.3 ms beneath `draw` and 86.2 ms beneath `startTimeline`. Cloud volume sampling dominates: `densityAt`, `noise3`, `noise`, `hash` and `sample` together account for about 386 ms of self time. Shader compilation is not the dominant sampled handoff cost.

The old biome manager disposes its sky painter and cloud canvases. Its replacement builds the same deterministic cloud RGBA pixels again. `buildCloudTexture` depends only on the combined cloud seed and dimensions, so a bounded shared cache can retain those pixels without retaining the old simulation, canvases, tint state or camera history. Retained CPU bytes must remain accounted and evictable; denial must preserve the existing uncached result.

Implementation and verification sequence:

1. Add a failing regression for reuse across sky-renderer disposal/recreation, then implement a cache scoped to the graphics residency ledger. Bound it to 48 entries and protect existing non-cache allocations when admitting optional cache data.
2. Verify deterministic pixels, distinct seed/dimension keys, mutation isolation, eviction, capacity and allocation refusal. Run relevant sky/residency tests and lint.
3. Compare current and candidate handoff gaps on the same MP3, verify the RTX renderer, and check exact rendered-pixel equivalence separately from timing.
4. Run integration checks and continuous playback, then record actual outcomes and remaining limits. Keep captures and diagnostic variants ignored under `.smoke/`; do not publish.

## Separate late-workload diagnostic

The completed continuous trace shows canvas reads beginning at 151.025 elapsed seconds, preceding the first quality reduction. At 100–140 seconds, callback median is 5.4 ms with no canvas reads. At 150–158.18 seconds, it is 20.6 ms, including 11.7 ms in canvas reads and 1.7 ms in probe collection. Readback calls can drain earlier GPU work; these figures are not direct GPU timings or exclusive crest-rendering cost.

A separate source-snapshot A/B changed only the working canvas's `willReadFrequently` hint to true, preserving automatic view `nc-ross-lake-north`, full analysis, Detailed 640×360 and pinned quality 0. Both runs sought to 430 seconds after 35 seconds of live playback. Comparing heard times 432.5–445 seconds excludes post-seek preparation: callback median was 21.0 ms in both, canvas reads 9.0 ms in both, and probe collection 3.6 ms in both. No useful improvement was measured, so this hint change is not included. The context's actual backing-store choice was not independently established by this timing experiment.

Local diagnostic artifacts: `.smoke/rtx-mp3-handoff-profile/`, `.smoke/rtx-mp3-late-baseline/`, `.smoke/rtx-mp3-late-read-frequently/`, and `.smoke/mp3-read-frequently-comparison.json`. The late experiment is a fixed-quality seek diagnostic, not continuous-play acceptance.

## Verified implementation and profile

`RangeSkyRenderer` now copies density pixels from `RangeCloudTextureCache` into its own canvas. The shared cache holds at most 48 entries (4.5 MiB at the maximum supported dimensions), scoped to the residency ledger. Its entries are evictable and independent of song generations; metadata does not retain a second unaccounted pixel buffer. Existing canvases and tint state still release on renderer disposal or seed changes. Optional cache admission cannot evict unrelated terrain resources.

Matched 45-second CPU-profiled RTX runs used the same MP3, live loader, automatic view, 48 kHz playback, seed and fixed Detailed presentation:

| Handoff metric | Before cache | After cache |
| --- | ---: | ---: |
| Sampled inclusive `adoptFullAnalysisLive` | 542.5 ms | 146.7 ms |
| Sampled inclusive `buildCloudTexture` beneath adoption | 395.6 ms | No samples |
| Actual callback-start gap across adoption | 755.6 ms | 343.7 ms |
| Elapsed time of first new-scene callback | 14.436 s | 13.864 s |

The sampled adoption work decreased about 73%, and the profiled presentation gap about 55%. The remaining gap is still visible; the cache does not remove simulation reconstruction or the transport/readiness hold. Cold first-use texture generation is unchanged.

The source digests were `d777c56ffa9c40b6247cb14eba268faa0389d92f6524c0c0f5314b3f0fecd750` before and `68309c12b32b361dbcf91023248519f12ba9476ea34453b2f102dbb0ba404c77` after. The candidate profile is in `.smoke/rtx-mp3-handoff-cache-profile/`; filtered sample summaries are `.smoke/handoff-profile-before-summary.json` and `.smoke/handoff-profile-after-summary.json`.

## Visual and automated checks

A separate RTX comparison loaded the MP3 through live analysis, waited for full analysis, then retained its permanent identity while switching to a fixed export clock. At 12, 86 and 430 seconds, PNG hashes and decoded RGBA pixels matched exactly: zero differing pixels in each 1280×720 frame. The opening and late images were inspected and contained the expected terrain, sky and clouds. This is visual-equivalence evidence, not pacing evidence. The candidate reused 18 resident density entries (1,769,472 bytes); the baseline retained none. Images and metadata are ignored in `.smoke/cloud-visual-equivalence/`.

The renderer-rebuild regression was observed failing before the cache and passing after it. Tests cover destination mutation isolation, seed/dimension separation, bounds, eviction, refusal, terrain protection and failed-build cleanup. The full suite passed **5,658 tests, with 11 skipped and zero failures** (5,669 total). Lint passed, and all 469 runtime modules parsed and linked. Independent review found no actionable ownership or budget issue. The full-suite log is `.smoke/handoff-tests.log`.

## Continuous before/after result

The unprofiled 520-second candidate capture also covered the complete 513.763-second MP3 and its ending. All 28,478 presented-frame IDs were contiguous, no browser errors occurred, and the final frame reached heard time 514.799 seconds. Rendering stopped 5.021 seconds before the observation ended. Input/instrument hashes, browser/GPU, seeds, sample rate and effective settings matched the earlier 520-second run; only the new cache module and its sky-renderer call changed.

The actual callback-start gap across full-analysis adoption fell from **703.5 to 325.1 ms**, about 54%. First-30-second callback median was 6.3 versus 6.2 ms, and median presentation period stayed 17.6 ms. Opening CPU spikes around 229 ms remain. This is a reduction of the single handoff stall, not a steady-frame-rate improvement.

Late quality pressure remains. Candidate reductions occurred at elapsed 156.9 seconds (0→1), 394.3 (1→2), 401.7 (2→3) and 453.1 (3→4), all recorded as period pressure. Both complete runs ended at level 4. The earlier run briefly recovered to level 0; this candidate run did not. These single runs do not establish a late-song improvement or regression, and full-quality continuous playback is not achieved.

Evidence: `.smoke/rtx-mp3-handoff-continuous/handoff-continuous.json` and `.smoke/handoff-comparison.json`. No governor policy or quality thresholds were changed.

## Upstream integration

During validation, `main` advanced to `58454dd93e6919c591835f6ccc0edefa02888f49` (#132). That cleanup removes 11 unreachable runtime modules and associated tests/tooling; its only retained-runtime edit is a comment in `Renderer.js`. Import/worker inspection found no live reference to the deleted modules. Cloud, crest, telemetry, residency and profiler paths are untouched, and `AGENTS.md` is unchanged. The hardware digests above identify the captured pre-rebase trees; they are not relabeled as captures of the cleanup revision. The full-suite count above is also pre-rebase.

The three local commits rebased cleanly onto that main revision; `git range-diff` confirmed their patches were preserved. On the rebased tree, **99 focused cloud/sky, residency, governor-recording and instrumentation tests passed**, lint passed, and all **458** remaining runtime modules parsed and linked. No long hardware rerun was performed solely for the unreachable-file deletions and comment edit. The focused log and final served-source digest are `.smoke/handoff-rebased-focused.log` and `.smoke/handoff-rebased-source.json`.
