# Playback smoothness implementation plan

**Goal:** Reduce repeated CPU work and unnecessary hybrid probe work while preserving the song's visual state and the existing single-stage rendering path.

**Starting point:** main `c10b820ad15caa5eaa198521c76c9e2ea155b33f`, including merged Viewfinder and song-world changes. Work in `codex/playback-smoothness`.

**Approach:** Keep the current rendering and music models. Use an interval index to skip expired notes, and return an empty terrain-edge mask before fine sampling when all coarse neighbors already prove it empty. More invasive render-target changes and quality reduction are unnecessary for these two findings.

## Evidence guiding the changes

- A five-minute MIDI fixture with one sustained note and 6,000 short notes makes canonical `RidgeMotionHistory.sample` repeatedly scan old events. Initial measurements: median 2.621 ms / p95 3.718 ms with the hold, compared with 0.0743 / 0.252 ms without it. The pressure sampler repeats the underlying query many times.
- `CrestProbe.edgeCell` calculates its neighborhood, then performs 16 fine samples and 128 neighbor tests even when no coarse neighbor can qualify. The adjacent water-cell shader already returns early in the equivalent case.
- The RTX workstation is offline and this executor has no GPU device. CPU timings, output equivalence and operation counts are available; delivered FPS, GPU duration and physical JOYING performance are not.

## Tasks

- [x] Add a maximum-end interval index and use it in RangeNarrative and RidgeMotionHistory. Preserve descending event order, overlapping/held notes, exact boundaries, seeks and reanalysis ownership. Compare against the original algorithm and record repeatable CPU timings and memory cost.
- [x] Add the terrain-edge early return. Compare the actual shader body's scalar logic before/after over deterministic masks; preserve edge, water, packing and readback behavior. Report skipped operations separately from GPU timing.
- [x] Add a small repeatable sampling benchmark, run relevant music/frame/probe/renderer tests, lint, module and staging checks, and obtain an independent review.
- [x] Document actual before/after results and the unmeasured hardware limits; prepare the focused change for review.

JOYING JY-UTS18N12 remains the minimum target. Existing graphics admission and quality settings remain in force. Source terrain and production approval metadata remain authoritative.

## Added visual direction

The user subsequently requested a wide opening over an infinite, featureless
shallow ocean, camera aim that follows the mountains' apex/action as they grow,
and removal of shorelines clamped to screen-pixel grids.

- [x] Extend `LandRiseCamera.js` with a deterministic overview driven by `rise01`:
  pull back roughly three times and crane above the area at the opening, track
  the existing source summit where available, and return to the authored pose.
  Give generated static-view shots the same overview/current-action tracking.
  Streamed mapped tours retain the original admitted camera after wider
  prototypes exceeded their triangle caps. Preserve exact completed-pose
  identity, ground clearance and seek reconstruction.
- [x] Add a shared ocean appearance to actual terrain and the existing analytic
  RiseGround horizon, featureless at zero rise and easing into the real material
  over the first quarter of growth. Hide forest/ink at the exact ocean opening.
  Reuse current geometry/targets/passes and preserve construction activity.
- [x] Correct the existing high-resolution water path's native-grid shoreline
  clamp with admitted resources and failure fallback. Preserve water/forest
  occlusion and avoid a new full-resolution terrain stage in single-stage mode.
  Describe residual native-raster limitations accurately.
- [x] Verify camera coverage, shoreline pass ownership, shader composition,
  ocean endpoints, default/smooth water configurations and integration tests.

These visual requests intentionally revise opening framing and appearance;
source terrain and completed geography remain authoritative.
