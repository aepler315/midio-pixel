# Performance budget and evidence

Minimum intended device: **JOYING JY-UTS18N12 Android head unit**. This is a product
target, not a claim this change was run on that hardware. No fabricated hardware
FPS or universal timing ceiling is used in the new CPU suite.

| Constraint | Current source / scope |
|---|---|
| Normal graphics residency | mobile/Android 320 MiB; desktop 512 MiB |
| Low-memory residency | mobile 192 MiB; desktop 256 MiB. Android with unknown memory uses the low mobile budget. `GraphicsResidency.js` and its tests are authoritative. |
| Native terrain rasters | Classic 320×180, Classic+ 400×225, Medium 480×270, Medium+ 560×315, Detailed 640×360 |
| Output resolution | Windowed backing cap 1920×1080 with adaptive output scale; fullscreen uses viewport×DPR with cover crop. The terrain raster and output canvas are distinct. |
| Adaptive target | Governor period budget 18.5 ms, levels 0–6; 60 FPS is the existing desired playback target, not a measured JOYING guarantee. |
| Existing live-review targets | Delivered p95 ≤20 ms, at most one >100 ms gap/minute, advancing heard clock and no overcommit; existing `liveReviewGates` targets, not new hardware measurements. |
| Existing fallback | Admission before allocation, bounded retries, cancelled-generation release, rail-only tour fallback, legacy fallback on unavailable Range assets/shaders |

Current `RangeQuality.js` sheds terrain mirror at level 1, near-detail assets at
2, progressively thins stable foliage/fog samples, and disables pool reflections
at 6. Sky reflection stays. Crest/probe work and Building detail have separate
consumer caps. Do not copy the older device-run table that kept the terrain mirror
through level 5. Preserve fallback behavior without assuming every tour fits at
192 MiB. Existing Ross Lake evidence records rail fallback at 192 MiB versus full
tour at 512 MiB; it is a scenario result, not proof of universal admission.

## Measurement tiers

1. `npm run bench:engineering -- --out NEW_DIR`: real pinned Teton package load,
   four geometry budget/detail combinations, score construction/sampling, growing
   camera updates, quality/grid resolution and geographic sampling. Seven measured
   samples after two warmups, with hashes of output, median/p95/max and process
   memory snapshots. Initialization includes filesystem/decode/hash cost. This
   measures Node CPU work. Quality-grid timing is policy lookup, not GPU allocation
   or live resizing. RSS is process memory, not GPU or Android residency.
2. `tools/range-frame-cost.mjs`: actual browser frame pass/operation counts,
   synchronous waits and host timing; `--dry` counts do not measure rendered FPS.
   `range-prepare-cost.mjs` isolates CPU preparation with a stub GL owner. Neither
   is a physical GPU benchmark.
3. `review:landscape --live-seconds N`, `test:gpu`, graphics reports and
   `range-device-probe.js`: delivered frame distributions, governor levels,
   residency and actual renderer. Software WebGL and headless delivery are labeled
   separately. GPU timing is unavailable unless a supported non-disjoint GPU
   query actually returns a result. Never infer GPU time by subtracting CPU time.
4. Physical JOYING run: record browser/OS, resolution/DPR, song hash, route, starting
   grid, thermal condition, quality history and at least five minutes of playback.
   Retest upload/seek, Classic→Detailed building and low-memory fallback. This is
   the missing evidence needed to establish an actual head-unit FPS floor.

Same-environment CPU comparison defaults to +50% plus 1 ms per median/p95/max.
These are configurable diagnostic allowances, not established JOYING or product
budgets. CI uses +100% plus 5 ms for shared-runner noise and separately gates
identical outputs. Workload/asset hashes, sample counts and environment must match.
No baseline means collection only, visibly reported. Compare sequentially on one
host, avoid other heavy work, investigate deltas before changing allowances.

## Previously measured evidence

The [frame-cost implementation record](superpowers/plans/2026-11-10-frame-cost.md) records
owner RTX 3060 runs before Phase 1: early sheds to level 6, eventual recovery,
composed-stage delivered p95 50 ms and three >100 ms gaps. Those failed the live
review targets. They are not measurements of this infrastructure branch or the
JOYING. [Dual Summits evidence](dual-summits.md) reports 179.75 MiB peak accounted
graphics in fixed-clock software captures, with no device FPS claim.

New results belong in [implementation validation](agent-infrastructure-validation.md)
and PR/CI artifacts. Performance optimization requires comparable output and
geometry as well as timing; removing terrain detail to win a benchmark is not an
implicit success. Intentional budget/quality changes need their affected consumers,
checks and rationale updated together.
