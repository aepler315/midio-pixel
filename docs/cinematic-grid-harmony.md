# Cinematic Pixel: choosing its detail level

The Cinematic Pixel look now runs at **Detailed, 640×360** unless another
level is chosen. Pixel and Palette keep **Classic, 320×180**. This page records
how the grid was chosen, what the engine was tuned to it, and what was found
along the way. Evidence is local under `.smoke/grid-harmony/` and is never
committed.

## What the grid touches

A read-only map of every grid-dependent constant and allow-list found:
- **Overscan:** `SHAKE_MARGIN_PX` is 64 stage px, so `w/20` native px.
- **Scene backing:** `round(1.1w) × round(53h/45)`, exact only when 80 divides `w`.
- **Derived buffers:** the half-size mirror and the quarter-size shafts.
- **Text and effects:** `pixelUnit` rounding, which sets captions, glow and stars.
- **Cast:** `CastRaster` filter supports in native px.
- **Forest:** footprint thresholds in native px.
- **Cinematic reconstruction:** cell geometry and its fixed slope gain.
- **Palette:** the `MAX_PIXEL_PIXELS` cap.

Three structural facts narrow the field:

- **The lattice.** Only widths that are multiples of 80 keep both exact 16:9
  and a whole-pixel overscan. Off-lattice sizes (384×216, 512×288) resample
  partition columns. Candidates: 240, 320, 400, 480, 560, 640, 720, 800, 960.
- **Whole-number scaling.** 320×180 and 640×360 are the only candidates
  integer at 720p, 1080p, 1440p and 2160p. 480×270 and 960×540 are integer
  at 1080p and 2160p only.
- **Exact pixel units.** Only 320, 640 and 960 wide.

The cinematic reconstruction is sensitive to the cell width `k` (output px per
native cell). With a fixed slope gain `g`, the step a cell boundary keeps on a
ramp is `R = 1 + k(1-g)/g` times the in-cell step. The look was validated at
Classic+ on 720p: `k = 3.2`, `g = 0.8`, `R = 1.8`. At the 1080p live ceiling,
640×360 gives `R = 1.75`, the nearest to it; Classic gives 2.5.

## Measurement

`.smoke/probes/grid-sweep.mjs` registers each candidate in the page, so grids
outside the five render for real. It asserts the working buffer and the scene
size per capture. For each grid it measures, at 1920×1080:

- **Cell visibility:** mean |ΔY| across cell boundaries over mean |ΔY|
  inside cells, on the land.
- **Reconstruction effect:** an ablation with the cell pass off.
- **Crawl index:** high-frequency temporal change over true motion, from a
  short consecutive clip.
- **Cost on the hardware GPU (RTX 3060, ANGLE D3D11):** frames drawn back to
  back with one fence.

Image metrics come from four views (two lakes, desert, inland forest) at three
times of day, rendered with software WebGL. Timing comes from two views on the
hardware GPU. The live behaviour comes from `npm run review:landscape --
--hardware-gpu --look cinematic --live-seconds 30` at Classic, Medium and
Detailed.

The rubric's weights were fixed before measuring:
- performance 25%;
- whole-number scaling coverage 15%;
- pixel-unit exactness 10%;
- reconstruction harmony 15%;
- crawl 15%;
- cast legibility 10%;
- scene sampling 10%.

It was amended once, dated, before the second timing pass. Min-max
normalisation of the near-flat costs turned a 1 ms gap, inside the measured
3.6 ms run-to-run noise, into 28 points. Cost is now scored as a ratio, with
grids within noise tied.

## Round 1

| Grid | Fenced ms/frame | Cell visibility (pass / nearest) | Crawl | Amended score | As written |
|---|---:|---:|---:|---:|---:|
| 240×135 | 30.4 | 29.0 / 102 | 1.030 | 0.616 | 0.616 |
| 320×180 | 30.7 | 24.6 / 84 | 1.046 | 0.724 | **0.706** |
| 400×225 | 31.2 | 22.2 / 70 | 1.050 | 0.641 | 0.593 |
| 480×270 | 31.3 | 20.2 / 64 | 1.057 | 0.665 | 0.613 |
| 560×315 | 31.7 | 18.9 / 57 | 1.057 | 0.649 | 0.572 |
| 640×360 | 32.1 | 15.3 / 49 | 1.063 | **0.746** | 0.648 |
| 720×405 | 32.5 | 16.6 / 50 | 1.061 | 0.605 | 0.488 |
| 800×450 | 33.3 | 15.8 / 48 | 1.072 | 0.531 | 0.370 |
| 960×540 | 34.8 | 16.1 / 51 | 1.087 | 0.526 | 0.308 |

Live, on the RTX 3060:

| Grid | Delivered fps | Governor rung | Cell pass | Peak memory |
|---|---:|---:|---|---:|
| Classic | 47.98 | 4 | shed (quality) | 481 MiB |
| Medium | 47.64 | 4 | shed (quality) | 482 MiB |
| Detailed | 46.84 | 4 | shed (quality) | 484 MiB |

**The grid barely moves the cost.** Most of a 1080p frame is GPU-process work
at output resolution: the full-resolution sky, the composite and the
cross-context copy.

**Live traces.** These ran the Teton tour at 1080p, the path
`review:landscape` always uses. The governor settled at rung 4 on every
grid, and the reconstruction sheds at rung 2 and above, so there it was
shed at every grid.

**Rail views.** These were measured only as fenced 1080p export frames:
about 30–35 ms, also over the 18.5 ms budget. So the cell pass most
likely sheds live there too. That is inferred, not traced, and a smaller
window may differ.

**Exports.** In-app exports freeze the governor at the live rung, so after
live play they shed the pass too. CLI bulk exports, which arm a fresh page
at rung 0, keep it.

Choosing a coarser grid would not bring the pass back. Making the cinematic
output pipeline cheaper is the next lever; the grid is not.

With cost a tie, structure and image quality decide. 640×360 has:
- whole-number scaling at every common output;
- exact pixel units and exact derived buffers;
- the validated reconstruction residual;
- the least visible cells with the pass on;
- lantern cores above the filter floor;
- 4.8 px threads at 1080p.

Its one cost is four times Classic's scene fill. That is about 1.4 ms per frame
on this desktop GPU, but untested on mobile web.

## Tuned toward it

- **Reconstruction strength follows the cell width.** `cellStrength(k) =
  k / (k + R − 1)` keeps `R = 1.8` at every grid and output size. It is
  exactly 0.8 at the validated point. For Detailed it is 0.71 at 720p, 0.79
  at 1080p, 0.83 at 1440p and 0.88 at a 4K export. The diagnostics report the
  strength used.
- **Resolved site cores no longer clip a channel.** From about 354 lines up,
  a placed light's core passes 1. It is now scaled as a whole, keeping its hue.
- **The detail level follows the look.**
  - A record or export without a chosen grid runs Cinematic at Detailed.
  - Choosing Cinematic in the UI moves the grid to Detailed. Leaving it while
    still at Detailed returns to Classic.
  - `review:landscape --look cinematic` defaults to Detailed.
  - Saved and requested grids are kept, so existing captures reproduce.

## Round 2: the loop closes

Round 2 re-ran the same image sweep on the tuned engine. Timing was reused
from round 1, because the tuning adds one uniform and one clamp, and costs
nothing.

**The amended rubric picked 640×360 again.**

| Grid | Score |
|---|---:|
| 640×360 | 0.757 |
| 320×180 | 0.737 |
| 480×270 | 0.674 |
| 560×315 | 0.663 |
| 400×225 | 0.658 |
| 240×135 | 0.621 |
| 720×405 | 0.615 |
| 800×450 | 0.537 |
| 960×540 | 0.525 |

The strength now grows with the cell width, so coarse grids gained most:
Classic's cell visibility fell from 24.6 to 23.3. At 1080p the strength at
640×360 is almost unchanged (0.79 against 0.80), so its frames are visually
identical.

**The loop stopped.** The winner held two rounds, and its score moved only
0.011, inside the 0.02 margin.

Under the rubric as first written, Classic leads (0.719 against 0.659).
That ordering rests entirely on min-max scoring of a 1.4 ms cost gap inside
the 3.6 ms noise.

## Not settled here

- **Mobile web.** 640×360 is four times Classic's scene fill, and mobile web
  is the second-priority platform. It has not been measured on a device.
- **The live cell pass.** It sheds on this desktop's Teton-tour trace at
  every grid, and in-app exports inherit that rung. The 1080p output
  pipeline (sky, composite, copies), not the grid, holds the frame over
  budget. Profiling and slimming that pipeline, or decoupling the pass's
  shed rung from the scene's, is the next step if the reconstruction is to
  be seen live.
- **Trio.** Trio shares the one grid preference, so choosing Cinematic also
  moves Trio, which ignores the cinematic look, to Detailed. That is four
  times its pixel work. The level is supported there; it is a side effect,
  not a bug.
- **Software-rendered image metrics.** The image metrics came from software
  WebGL. Their trends match the hardware frames inspected by eye, but
  absolute values may differ slightly.
