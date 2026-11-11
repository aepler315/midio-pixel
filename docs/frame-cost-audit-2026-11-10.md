# Frame cost audit, 2026-11-10

What a Landscape frame costs on `main` at `e9d0945`, with composed song
ranges (`?songRange=1`) in focus and the approved catalog measured with the
same instruments. The owner's report that started it: on a composed range a
seek shows the lake reflecting every massif, and shortly after playback
resumes the reflections are gone.

The plan that follows from this audit is
[superpowers/plans/2026-11-10-frame-cost.md](superpowers/plans/2026-11-10-frame-cost.md).

## Evidence classes

Every figure below belongs to one of three classes, named where it appears.

- **Count.** Draw calls, triangles, uniform calls, 2D canvas operations and
  readbacks, counted from the running app. Exact and the same on any machine.
- **Rule.** What the code does, read from the source or produced by running
  the real `PerfGovernor` on synthetic frame traces.
- **Software.** Time or pixels from headless Chromium on this cloud host: two
  virtual CPUs and software WebGL (SwiftShader). Pixels are valid. Software
  rendering is fragment bound, so its milliseconds say nothing about a GPU.
  They are quoted as shares of one run, or where two runs on this host
  differ by a multiple, and always labelled.

No figure here was measured on the RTX 3060 or on the JOYING JY-UTS18N12.
Section 9 lists what only those machines can answer and how to get it.

## 1. Findings

| # | Finding | Class |
| --- | --- | --- |
| 1 | The quality ladder's first rung removes the lake mirror and, from that rung to the last, routes every sky operation drawn into the reflection backdrop through a canvas blur filter: 1,015 to 1,276 filtered operations per frame on a composed stage, 65 to 809 on the catalog views measured. A level 1 stage frame took 7 to 13 times as long as the level 0 frame of the same instant in the software rasterizer. | Count, software |
| 2 | On a composed stage the mirror is a large part of the picture: dropping it changes 29.6% of the frame's pixels at full rise (5.9% by more than 48 levels). The decision to shed it first rests on captures where it changed 0 to 2%. | Software pixels |
| 3 | Recovery from a shed needs ten seconds in which no frame period exceeds 18.5 ms and no callback exceeds 11.67 ms. One 30 ms frame every four seconds, or one 12 ms callback every eight, keeps a rung shed for the rest of the song. | Rule |
| 4 | Every seek builds a new governor at level 0 and discards what the old one learned, so a machine that cannot hold level 0 shows the full picture after each seek and loses it again at the earliest 3.6 s later. | Rule |
| 5 | The frame callback waits for the GPU every frame: `getImageData` on the GPU-backed pixel grid (the crest line, one to three calls per frame) and `gl.getError()` in the Cinematic presenter. In live playback on this host 93% of all callback time was inside `getImageData`. The wait serializes main-thread and GPU work, and the governor counts it as callback work. | Rule, count, software |
| 6 | The high-resolution sky is drawn twice per frame (output and reflection backdrop). A stage frame issues 3,136 to 3,672 2D canvas operations; the sky's two draws were 24 to 37% of the frame's main-thread time outside readbacks in profiles of three views on this host. | Count, software |
| 7 | A level 0 frame submits the terrain five to six times. A composed stage submits 7.8 to 16.2 million triangles per frame; the median approved catalog view submits 3.4 to 4.6 million; `nc-ross-lake-north` submits 205 to 245 million, 96% of them trees. | Count |
| 8 | Runtime assembly draws 1.4 to 2.2 times the triangles of an offline bake of the same layout. It plants 287,000 billboards and 9,162 mesh trees on the 285 tiles no rail framing ever shows, and keeps terrain at a one-pixel error budget for a 1080-row frame while the picture is a 360-row grid. | Count |
| 9 | Four of the ladder's six rungs remove no submitted work: levels 1 to 3 of a forested stage submit the same 8.97 million triangles, and levels 4 to 6 the same 3.72 million. Foliage thinning discards in the shader. | Count |
| 10 | Stage assembly and scene preparation run on the main thread before the first sound. See section 7. | Software |
| 11 | Three tests fail on `main`: two `songRangePlan` tests that Phase 5 left behind and one host-timing baseline. | Suite run |

An earlier statement of mine is withdrawn in section 10.

## 2. Instruments

All six are in `tools/` and lint clean. None changes application source.

| Tool | Measures | Class |
| --- | --- | --- |
| `range-frame-cost.mjs` | One export-clock frame of the real app: WebGL and 2D canvas calls per scene pass, at any governor level. `--dry` skips the draws after counting them. `--png` saves frames. `--profile N` saves a CPU profile. | Count; software |
| `range-live-callbacks.mjs` | Live playback: work per rAF callback, time inside calls that wait for rendering, governor level over time, with an optional seek. `--hardware-gpu` asks for a real GPU; that path has not been run on one. | Software |
| `perf-governor-sim.mjs` | The real `PerfGovernor` on named synthetic traces. | Rule |
| `song-range-stage-geometry.mjs` | Runtime stage assembly against the offline bake of the same pilot layouts. | Count |
| `range-prepare-cost.mjs` | Package load or stage assembly plus `RangeScene.prepare` in Node, for `node --cpu-prof`. | Software |
| `cpuprofile-top.mjs` | Self and inclusive time from a `.cpuprofile`. | Software |

Settings for every browser run: 1280×720 output, Cinematic, Detailed grid
(640×360; the scenic target is 704×424 with overscan), quality Auto, shot
tours on (the product default), seed 315, a 90 s generated song (`contrast`
fixture: calm, energetic from 31 s, calm from 68 s). Frames are taken at
12.0 s (rise 0.43, night 0.52) and 86.4 s (rise 1.00, night 1.00).

**Dry counts equal full-render counts.** The forced stage was run both ways
with identical arguments (`--warm 0`): every per-pass WebGL count is equal at
both instants. 2D canvas counts are equal at 12.0 s (3,136); at 86.4 s the
full render issues 3,672 operations and the dry run 2,719, because the crest
line reads pixels and has none to work on. Two full level 0 runs produced
byte-identical frames (equal SHA-256 at both instants), so pixel differences
below are differences between levels.

## 3. What a level 0 frame submits

### 3.1 A composed stage, pass by pass (count)

Forced stage for the fixture song: `song-range-911f810a0bd86424`, STEPPE,
template `offset-shore-c`, 1,225 tiles, geometry 1,326,068 triangles
(far 1,258,776, mid 67,172, near 120), trees 1,520 detail, 4,432 mesh,
60,627 billboards.

| Pass (scene method) | 12.0 s draws | 12.0 s triangles | 86.4 s draws | 86.4 s triangles |
| --- | --- | --- | --- | --- |
| Lake mirror (`_prepareMirror`) | 44 | 2,330,354 | 47 | 2,670,222 |
| Far partition with depth pre-pass (`renderPartition`) | 25 | 2,125,255 | 25 | 2,264,473 |
| Water at output resolution (`renderWater`) | 32 | 1,595,532 | 32 | 1,684,354 |
| Fine crest probe (`_probeFineCrest`) | 17 | 1,059,110 | 17 | 1,128,720 |
| Water at the grid (`renderWater`) | 26 | 536,433 | 26 | 555,645 |
| Mid partition | 7 | 103,825 | 7 | 112,019 |
| Near partition | 3 | 10,411 | 3 | 10,409 |
| Crest probe columns | 6 | 6 | 6 | 6 |
| **Frame** | **160** | **7,760,926** | **163** | **8,425,848** |

Instanced triangles (the forest) are 575,904 and 776,544 of those totals. The
terrain alone is drawn about 5.4 times per frame into a 704×424 target: 24
terrain triangles for every target pixel, every frame.

### 3.2 Forested stages and the offline bake of the same layout (count)

The three Phase 1 pilot layouts exist twice: baked offline with the catalog
baker's visibility tests (`song-range-pilot-a|b|c` views) and assembled at
runtime (`?songRangeLayout=`). Same template, same massifs, dry-conifer
material.

| Layout | Path | Tiles | Geometry triangles | Trees: detail / mesh / billboard | Frame at 12.0 s | Frame at 86.4 s |
| --- | --- | --- | --- | --- | --- | --- |
| A | runtime | 1,225 | 1,738,292 | 8,613 / 26,265 / 318,203 | 15,071,892 | 16,224,870 |
| A | offline | 599 | 1,170,958 | 8,064 / 16,894 / 31,112 | 7,481,100 | 10,823,024 |
| B | runtime | 1,225 | 1,596,074 | 8,611 / 26,335 / 316,932 | 11,135,764 | 10,901,092 |
| B | offline | 558 | 993,756 | 8,038 / 16,822 / 30,131 | 5,061,042 | 4,953,870 |
| C | runtime | 1,225 | 1,712,090 | 8,534 / 26,341 / 318,088 | 14,941,048 | 15,920,474 |
| C | offline | 678 | 1,312,692 | 7,993 / 16,721 / 30,744 | 8,362,656 | 11,474,188 |

Runtime assembly submits 2.0, 2.2 and 1.8 times the offline frame at 12.0 s
and 1.5, 2.2 and 1.4 times at 86.4 s. Two causes, both measured in Node:

- **Trees where no framing looks.** Assembly marks each tile `core`,
  `extended` or `outside` against the template rail and keeps all of them
  `visible`, so the forest is planted everywhere. Layout A has 772 core, 168
  extended and 285 outside tiles. Planting no trees on the 285 outside tiles
  gives 8,114 detail, 17,103 mesh and 31,201 billboard trees: the offline
  bake's forest to within a few hundred trees. All of the surplus (287,002
  billboards, 9,162 mesh trees, 499 detail trees) stands on tiles outside
  every rail framing. Whole-batch forest culling does not take them out of
  the frame: the runtime stage submits 4.9 million instanced triangles at
  12.0 s where the offline bake submits 0.9 million.
- **Terrain the offline bake dropped.** 626, 667 and 547 runtime tiles are
  absent from the offline bakes and hold 499,864, 442,196 and 342,974
  triangles: 29%, 28% and 20% of the runtime geometry. These are framed tiles
  the baker found occluded. The baker tests occlusion with the land fully
  risen; a stage raises each massif on its own schedule, so a back massif can
  stand in view while the one in front of it is still low. That share is
  therefore an upper bound for what a stage may hide.

**Level of detail.** Stage tiles take the `desktop` budget: one pixel of
error in a 1080-row frame. The picture is a 640×360 grid, where the `mobile`
budget (two pixels at 720 rows) is exactly one grid pixel. Layout A at the
mobile budget is 636,758 triangles against 1,738,292 (63% fewer); 189 tiles
at stride 1 hold 1.55 million of the desktop total. Mapped tours already
plan their terrain against the pixel grid (`pixelTerrainPlan` in
`TerrainWindow.js`); static rail views and stages use baked strides.

### 3.3 The approved catalog (count)

Same instrument, each view forced with `rangeView`, level 0.

| View | Status | Trees: detail / mesh / billboard | 12.0 s draws | 12.0 s triangles | 86.4 s draws | 86.4 s triangles |
| --- | --- | --- | --- | --- | --- | --- |
| `nc-ross-lake-north` | approved | 19,453 / 128,217 / 2,159,111 | 270 | 205,541,632 | 276 | 244,739,588 |
| `black-mountains-catawba` | approved | 10,504 / 118,281 / 2,081,670 | 171 | 36,391,378 | 180 | 32,381,962 |
| `sawtooth-redfish-north` | candidate | 8,827 / 62,875 / 1,235,761 | 275 | 28,015,688 | 169 | 13,494,260 |
| `teton-jackson-lake` | approved | 1,811 / 45,601 / 1,429,315 | 146 | 17,241,160 | 156 | 18,780,094 |
| composed stage, layout A | runtime | 8,613 / 26,265 / 318,203 | 186 | 15,071,892 | 150 | 16,224,870 |
| composed stage, STEPPE | runtime | 1,520 / 4,432 / 60,627 | 160 | 7,760,926 | 163 | 8,425,848 |
| `muncho-lake-south` | approved | 8,802 / 57,557 / 379,741 | 102 | 6,436,288 | 78 | 5,304,352 |
| `white-mountains-owens` | approved | 0 / 539 / 20,535 | 140 | 5,197,974 | 73 | 957,370 |
| `tombstone-north-klondike` | approved | 0 / 1,005 / 14,672 | 85 | 4,934,586 | 78 | 5,073,848 |
| `denali-wonder-lake` | approved | 0 / 0 / 0 | 75 | 4,606,228 | 79 | 2,557,976 |
| `sierra-whitney-east` | candidate | 0 / 0 / 5,329 | 83 | 4,246,400 | 68 | 3,195,510 |
| `san-gabriel-baldy` | approved | 2,754 / 17,793 / 203,700 | 70 | 3,662,219 | 64 | 3,074,025 |
| `panamint-dantes-view` | approved | 0 / 649 / 29,575 | 63 | 3,523,615 | 65 | 3,390,813 |
| `chugach-matanuska` | approved | 1 / 355 / 5,051 | 97 | 3,469,664 | 107 | 5,174,134 |
| `izta-popo-west` | approved | 0 / 35 / 129,613 | 52 | 3,127,861 | 63 | 2,555,837 |
| `monument-valley-163` | approved | 182 / 40 / 4,101 | 55 | 2,034,809 | 63 | 2,182,379 |
| `la-sal-castle-valley` | approved | 2,441 / 13,097 / 156,135 | 77 | 1,615,987 | 79 | 1,656,441 |

The median approved view submits 4.61 million triangles at 12.0 s and 3.39
million at 86.4 s. A composed stage submits two to four times that. The STEPPE
stage replaces `white-mountains-owens`, which its song would otherwise have
shown: 7.76 against 5.20 million at 12.0 s, and 8.43 against 0.96 million at
86.4 s, where the catalog view is on a mapped shot with pixel-grid terrain.

`nc-ross-lake-north` is an outlier of a different order. At 12.0 s its far
partition submits 90.2 million triangles, the grid water pass 34.3 million,
the fine crest probe 31.5 million, the mirror 24.4 million and the output
water pass 17.5 million; 197.5 of the 205.5 million are instanced trees. At
60 frames a second that is 12 billion triangles a second. The view was
rebuilt on 2026-11-03 (`docs/ross-lake-terrain-rebuild-2026-11-03.md`);
`docs/water-render-cost.md` last measured forest submission before that.

Every view also issues 1,839 to 4,503 2D canvas operations per frame at
12.0 s.

## 4. The quality ladder

### 4.1 What each rung sheds (count)

Composed stage, layout A, at full rise:

| Level | Draws | Triangles | of which trees | Filtered 2D operations |
| --- | --- | --- | --- | --- |
| 0 | 150 | 16,230,174 | 6,083,320 | 0 |
| 1 | 105 | 8,974,120 | 1,909,218 | 1,018 |
| 2 | 105 | 8,974,120 | 1,909,218 | 1,021 |
| 3 | 105 | 8,974,120 | 1,909,218 | 1,019 |
| 4 | 36 | 3,720,429 | 636,406 | 1,019 |
| 5 | 36 | 3,720,429 | 636,406 | 1,015 |
| 6 | 36 | 3,720,429 | 636,406 | 1,015 |

The ladder has two real steps for the GPU. Level 1 removes the mirror pass.
Level 4 removes both water passes and the fine crest probe. Levels 2, 3, 5
and 6 leave the submitted triangles of this stage unchanged (on
`teton-jackson-lake` they move by 0.5% or less). Foliage thins from level 2 by
discarding vertices in the shader, after they are submitted, as
`docs/adaptive-quality-cost-audit-2026-11-07.md` already noted. The STEPPE
stage, `white-mountains-owens` and `teton-jackson-lake` show the same two
steps (7.76 → 5.43 → 2.22 million; 5.20 → 4.14 → 2.31 million; 17.24 →
12.57 → 5.02 million at 12.0 s). On `nc-ross-lake-north` the steps are 205.5
→ 181.1 → 97.7 million: the lowest rung of the ladder still submits 97.7
million triangles per frame.

### 4.2 Level 1 adds work to the 2D canvas (count, software)

`RangeScene.captureBackdrop` copies the sky into a small canvas that the
water samples as its reflection. It draws the high-resolution sky into that
canvas through `drawHighResolutionSky`: a second complete sky draw per frame.
From level 1 it sets `ctx.filter = blur(…)` before that draw, so every star,
cloud, gradient and aurora band becomes its own filtered operation.

| View | Night | Filtered operations per frame, levels 1 to 6 |
| --- | --- | --- |
| Composed stage, STEPPE | 0.52 to 0.40 / 1.00 | 1,109 to 1,184 / 1,269 to 1,276 |
| Composed stage, layout A | 1.00 | 1,015 to 1,021 |
| `white-mountains-owens` | 0.52 to 0.40 / 1.00 | 339 to 351 / 680 to 682 |
| `teton-jackson-lake` | 0.52 to 0.40 / 1.00 | 65 to 188 / 288 to 293 |
| `nc-ross-lake-north` | 0.52 to 0.40 | 746 to 809 |

In the software rasterizer a full level 0 stage frame took 12.9 to 15.8 s.
The level 1 frame of the same instants took 165.0 s (12.0 s, 1,114 filtered
operations) and 102.8 s (86.4 s, 1,272), while submitting 30% fewer
triangles and the same number of 2D operations (these runs shared the same
background load on the host). The rung meant to relieve the machine
costs this host 7 to 13 times a level 0 frame. What 1,000 filtered
canvas operations cost on the RTX 3060 is not measured. If level 1 costs more
than level 0 there, the governor's own rules (4.4, trace 9) take it from
level 0 to level 4 in seven seconds and never back above level 3.

### 4.3 What the mirror is worth on a stage (software pixels)

The same stage frame at level 0 and level 1, compared pixel by pixel:

| Instant | Rise | Pixels that differ | by more than 8 levels | by more than 48 |
| --- | --- | --- | --- | --- |
| 12.0 s | 0.43 | 20.1% | 3.1% | 2.7% |
| 86.4 s | 1.00 | 29.6% | 7.1% | 5.9% |

At level 0 every massif stands on its reflection. At level 1 the lake shows a
blurred sky and the land ends at the waterline. `docs/water-render-cost.md`
records the comparison the current order rests on: dropping the mirror
changed 1.4%, 2.0%, 0% and 1.0% of pixels on the pilot song's view, and it
notes that "a low camera over a lake under a steep shore is where the mirror
shows most; that case was not captured". A composed stage is that case, on
every song.

### 4.4 The governor's rules, on traces (rule)

`PerfGovernor` constants: frame budget 18.5 ms of rAF period; shed after 60
units of pressure (about 1.1 s of over-budget time, any frame rate); work
pressure from 14.17 ms of callback; recovery after 10 s in which every period
is within budget and every callback is within 11.67 ms; a recovered rung
sheds again after 8 units and doubles its retry window; 2.5 s of warm-up
without votes. `tools/perf-governor-sim.mjs` output:

| # | Trace | Result |
| --- | --- | --- |
| 1 | Healthy 60 Hz, 7 ms of work | Stays at 0 |
| 2 | Level 0 misses every third vsync; other levels healthy | 0→1 at 5.5 s; tries 0 at 15.5 s, 35.9 s (backoff doubling), falls each time within 0.4 s |
| 3 | Level 0 at 20 ms; level 1 healthy with one 30 ms frame every 4 s | 0→1 at 3.6 s, never recovers in 180 s |
| 4 | Level 1, healthy periods, every callback 12.5 ms | Never recovers |
| 5 | Level 1, 9 ms of work, one 12 ms callback every 8 s | Never recovers |
| 6 | 1.5 s of 60 ms frames right after warm-up, then healthy with ±0.6 ms jitter | 0→1 at 3.6 s, back at 14.0 s |
| 7 | As 6, then exactly 16.67 ms periods and 6 ms of work | 0→1 at 3.6 s, back at 14.1 s |
| 8 | Recovered rung, then one 40 ms frame every 5 s | Holds level 0 |
| 9 | Levels 0 to 3 at 22 ms, healthy from level 4 | 0→4 in 7.0 s; probes level 3 at 17, 37, 77 and 157 s and falls each time |

Traces 3 and 5 are ordinary machines: a garbage collection, a section change
or a tile upload every few seconds is enough to hold a rung down for the rest
of the song, because any single frame over either line restarts the ten
seconds. Trace 9 is what finding 1 would look like on hardware.

### 4.5 Seeks and pauses (rule)

`seekSong` calls `startTimeline`, which constructs a new `PerfGovernor` at the
selected starting level (0 on a desktop) and begins a warm-up. Learned
fallbacks and backoff are gone. The mirror's fade snaps to full on the first
frame after a seek (`easeRungAmount`), and a shed drops it at once
(`down: 'snap'`). On a machine that cannot hold level 0 for a given scene,
each seek therefore shows the full picture and removes it no sooner than
2.5 s of warm-up plus 1.1 s of pressure later.

### 4.6 Reading the owner's report

The level 0 and level 1 frames of 4.3 are the two states the owner described,
reproduced by pinning the level. The rules explain the timing: full picture
after a seek, gone a few seconds into playback, never back. What the rules
cannot say is why level 0 does not hold on the RTX 3060 for a stage. The
candidates this audit can name are 7.8 to 16.2 million triangles per frame
(3.1, 3.2), 3,100 to 3,700 2D canvas operations with the sky drawn twice
(section 5), and a synchronous readback that adds the GPU's time to the
callback and to the governor's work signal (section 6). The performance
record of section 9 separates them in one run.

## 5. Main-thread work

**2D canvas operations (count).** A stage frame at level 0 issues 3,136
operations at 12.0 s and 3,672 at 86.4 s (102 and 137 `drawImage`, 1 and 3
`getImageData`). About 1,100 to 1,280 of them are one sky draw, and the sky
is drawn twice: once into the reflection backdrop during the mid partition
(`RangePresentation.drawPartition` → `captureBackdrop`) and once at output
resolution when the frame is composited (`PresentingRenderer` `background`).
`RangeSkyRenderer.draw` paints each visible star of a 4,000-star catalogue as
its own path fill, up to 432 galactic clouds as radial gradients, aurora
bands as gradient fills and clouds as sprite draws.

**Profile (software).** Forty consecutive dry frames of the STEPPE stage at
full rise cost 51 ms of main-thread time each on this host, outside the
export readback:

| Share | Work |
| --- | --- |
| 35% (18 ms) | `drawHighResolutionSky`, both draws: aurora 7 ms, clouds 7 ms, stars 1.6 ms |
| 20% (10 ms) | `gl.getError()` in `CinematicPixel.draw`, a synchronous call (section 6) |
| 17% (9 ms) | three.js submitting 163 draw calls and 340 uniform calls |
| 5% (2.5 ms) | `drawImage` composition outside the sky |
| 23% (12 ms) | everything else, including terrain and forest culling (under 2 ms) |

The same profile of `white-mountains-owens` and `teton-jackson-lake` puts the
sky at 37% and 24% of 38 and 31 ms. Shares carry to other CPUs better than
milliseconds do. A desktop CPU two to three times faster than this host
would spend 6 to 9 ms a frame on the stage's sky, against a recovery line of
11.67 ms for the whole callback.

A dry frame has no crest pixels, so that profile leaves the crest line out. A
five-frame profile of full renders at full rise (a small sample) shows its
own script work to be small: `drawCrest` 3.4 ms a frame and `prepareGrid`
under 1 ms outside its readback. The 19 ms that `RangeCrest.drawTerrain`
appears to take, and that the app reports as `crest.cutMs`, is the
presenter's `getError` running inside it.

## 6. Synchronous waits inside the frame callback

The governor's work signal is the duration of the whole rAF callback
(`frame` in `src/main.js`). A call that blocks until the GPU process has
caught up turns GPU-side load into "work".

| Call | Where | Calls per frame (count) |
| --- | --- | --- |
| `ctx.getImageData` on the working grid | `RangeCrest._prepareEdges` (edge colours) and `prepareGrid` (crest rows); the grid is GPU-backed in Cinematic (`PixelPresentation._workingContextHint`) | 1 at 12.0 s, 3 at full rise |
| `gl.getError()` | `CinematicPixel.draw`, after uploading the grid and drawing the reconstruction | 1, every frame, every view (Cinematic is the only look) |
| `gl.getBufferSubData` | `CrestProbe` collecting the asynchronous probe result | 1 when a result is ready |

`getImageData` on a GPU-backed canvas returns when the GPU process has
executed everything that canvas depends on, which is this frame's scene. Two
consequences follow from the rule alone:

- **Main-thread and GPU work run one after the other.** A frame whose script
  takes 7 ms and whose GPU work takes 10 ms would overlap across two vsyncs
  and hold 60 Hz; serialized it takes 17 ms and misses.
- **The governor's work signal contains the GPU's time.** Its headroom line
  (11.67 ms) and pressure line (14.17 ms) were written for main-thread work.
  With the wait inside, a frame that fits its vsync can still read as "no
  headroom" for ever.

Live playback of the forced stage on this host, level pinned at 0, full
software render (`range-live-callbacks.mjs --level 0`, 75 s): six callbacks,
78.7 s of callback time, 73.4 s of it (93%) inside `getImageData`, 1.1 s
inside `getBufferSubData`, 0.06 s inside `getError`. The app's own figure
agrees: `rangeState.crest.readbackMs` read 11,146 ms for the last callback.
In software the wait is the whole frame. On the RTX 3060 it is whatever the
GPU needs to finish the scene, and `crest.readbackMs` reports it there too.
An earlier change removed a readback of this kind for this reason
(`saturateMaskAlpha` in `RangePresentation.js`).

`getError` waits the same way and matters less only while `getImageData`
precedes it in the frame. With the draws skipped (`--dry`) the crest line has
no pixels and makes no `getImageData` call, and the wait moves to `getError`:
in 20 s of live playback at level 0, 47 callbacks spent 17.0 s of their 19.9 s
inside it (median callback 443 ms), waiting for the 2D canvas work the grid
upload depends on.

**The governor in the running app (software).** With draws skipped the app
still fell from level 0 to level 6 in 14.0 to 15.5 s on this host on three
views, which says only that this host's software canvas is slow. The seek
behaviour of 4.5 is visible in the same run: a seek at 25.0 s rebuilt the
governor, the level read 0 from 28.0 s, and the first shed followed 4.0 s
later.

## 7. Load path: time to first sound

Playback waits for the scenic view (`waitForScenicReady`), so stage assembly
and scene preparation delay the first sound. Assembly
(`loadSongRangeStage`) runs on the main thread: for each of 1,225 tiles it
evaluates the floor and relief at 65×65 samples, measures the triangulation
error of seven strides, encodes residuals, and then `decodeTerrain` decodes
the bytes it just encoded.

`tools/range-prepare-cost.mjs`, Node on this host, quiet machine (software;
the profiled repeat of each stage was within 8%):

| View | Template | Load | of which assembly | `RangeScene.prepare` | Total |
| --- | --- | --- | --- | --- | --- |
| Composed stage, first synthetic song (PINE_OAK) | `lake-narrows-b` | 2,454 ms | 2,342 ms | 3,598 ms | 6.1 s |
| Composed stage, pilot layout A | `lake-amphitheatre-a` | 955 ms | 832 ms | 4,755 ms | 5.7 s |
| `white-mountains-owens` | | inside prepare | | 1,996 ms | 2.0 s |
| `teton-jackson-lake` | | inside prepare | | 2,542 ms | 2.5 s |

A composed stage takes 2.2 to 3.0 times as long as these two catalog views to
reach a prepared scene, before any GPU upload or shader compilation. Shares
from the CPU profiles of the two stages:

| Share (narrows / amphitheatre) | Function | What it is |
| --- | --- | --- |
| 31% / 7% | `distanceToLake` (`StageFloor.js`) | The exact distance to the lake ellipse, by 80 bisection steps, for every floor sample outside the lake: 65% of 5.2 million samples on `lake-narrows-b`, 12.5% on `lake-amphitheatre-a`. It is 86% of assembly on the narrows template. |
| 16% / 20% | `terrainHeightAt` (`TerrainMesh.js`) | The general height sampler, called per sample by the horizon bake, hierarchy, coverage, mist and forest steps; each call builds a string key and looks the tile up in a map. |
| 12% / 12% | `surfaceTextureSteps` and the sampler beside it (`TerrainMesh.js`) | The surface texture, over a 2,241×2,241 grid. |
| 4% / 10% | `featureSteps` (`TerrainFeatures.js`) | Material features. |
| 2% / 2% | `tileStrideError` | Triangulation error of seven strides per tile. |
| under 1% | `decodeTerrain`, `encodeResiduals`, `sha256Hex` | The encode and decode round trip. |

The floor depends only on the template, and there are three templates.

## 8. Suite state on `main`

5,568 tests: 5,563 pass, 2 are skipped, 3 fail.

- `test/songRangePlan.test.mjs:52`, "songs without a family range keep no
  plan; candidate order cannot change a plan": Phase 5 gave every family a
  range, so the fixture it relied on no longer exists.
- `test/songRangePlan.test.mjs:113`, "the generated massif catalog matches the
  stage templates it was built from": it compares families against all
  families where Phase 5 publishes the plannable subset.
- `test/shotPlanner.test.mjs:177`, "an 18-shot library and a 3-minute song
  plan in under 50 ms": a host-timing assertion that also fails on unmodified
  `main` on this host.

Phase 5 was built without running tests on the owner's instruction; the first
two are its direct consequence and are the review findings on PR #122.

## 9. What only hardware can answer

| Question | How to get the answer |
| --- | --- |
| Does level 0 hold on the RTX 3060 for a stage and for a catalog view, and which signal sheds it: frame period or callback work? | Phase 0 of the plan adds a performance record to the graphics report and to `npm run test:gpu -- --live-seconds`. Until then: press `P` during a `?songRange=1` song and a song without it, and note the level and frame rates after 15 s. |
| What do 1,000 filtered canvas operations cost on a GPU-backed canvas? | Same record: the level timeline shows whether level 1 is slower than level 0. |
| How long do `getImageData` and `getError` block? | The same record carries the synchronous wait per frame. `rangeState.crest.readbackMs` in the console of a playing song already shows the larger of the two. |
| Can a GPU draw `nc-ross-lake-north` at any level? | `npm run test:gpu -- --view nc-ross-lake-north --live-seconds 30`. |
| Everything on the JOYING JY-UTS18N12 | `docs/range-v2-device-runs.md`, run A. Unverified, as before. |

## 10. Withdrawn

Earlier in this project I reported that a composed stage "costs roughly a
fifth of a standard lake view" and that the lost reflections pointed at the
owner's machine. Both rested on `rangeState.timings.frameRenderMs` under
SwiftShader (33 to 51 ms against 194 to 309 ms). That figure is the time to
submit commands; in a software render the work completes later, inside the
crest readback, where a stage frame spends 12.9 to 15.8 s. By count a stage
submits two to four times the median approved view. The statement is
withdrawn, and the lesson is rule 1 of the plan's rules of evidence.

## 11. Reproducing

```sh
mkdir -p .smoke/audit
node tools/gen-pilot-wav.mjs .smoke/audit/song.wav 90   # the `contrast` fixture
node tools/range-frame-cost.mjs --out .smoke/audit --audio .smoke/audit/song.wav --song-range force --dry
node tools/range-frame-cost.mjs --out .smoke/audit --audio .smoke/audit/song.wav --song-range-layout song-range-pilot-a --dry --quality 0,1,2,3,4,5,6 --times 86000
node tools/range-frame-cost.mjs --out .smoke/audit --audio .smoke/audit/song.wav --view nc-ross-lake-north --dry
node tools/range-frame-cost.mjs --out .smoke/audit-full --audio .smoke/audit/song.wav --song-range force --quality 0 --warm 0 --png
node tools/song-range-stage-geometry.mjs
node tools/perf-governor-sim.mjs
node tools/range-prepare-cost.mjs stage
```

A full level 1 frame takes minutes in software; give that run its own
process and a long timeout. Run reports and frames belong in `.smoke/`.
