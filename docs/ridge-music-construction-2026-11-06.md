# Ridge work, musical direction and mountain construction

Starting main: `a12a64113cf9550d941c24423e45f84cea467e9b`, after PR #94
and the dependency merges. This change preserves the default single-stage
renderer and the JOYING JY-UTS18N12 performance target. It does not claim a
physical-device result or recovery of the previously measured FPS loss.

## Rendering investigation

The corrected hybrid/Cinematic ridge has several costs beyond its final line:

- `RangeScene._probeFineCrest` renders terrain ownership/depth at the physical
  output sampling resolution, including the scenic margin.
- `CrestProbe.fine` scans output columns for the first visible row in each
  terrain band and returns compact results through the existing readback path.
  Those column scans and the physical target remain necessary in this patch;
  reducing them without real-frame evidence risks missing narrow peaks.
- `RangeCrest` restores fine terrain coverage and clips each band's single
  patterned stroke behind nearer terrain. The pattern captures the composed
  image twice to average the physical rows immediately above and below.
- The color helper also cleared its entire allocated scratch canvas before a
  replacing `copy` draw, and padded for an older, wider stroke. Neither extra
  operation is necessary for the current one-physical-pixel stroke.

The helper now uses a fixed two-physical-pixel guard and removes the redundant
explicit clear. It retains the replacing first copy: replacing it with an
ordinary opaque `source-over` draw would leave old pixels in the unused fringe
after a shrinking/moving capture. All geometry, nearer-band clipping, gap
handling, above/below color arithmetic and quality settings remain unchanged.
This removes submitted work; a browser may already coalesce some redundant
operations, so operation counts cannot be translated directly into GPU time.

## Independent raster comparison

`tools/ridge-output-regression.mjs` compares the baseline helper from `a12a641`
against the current helper using actual `RangeCrest.drawCrest`. It separately
constructs an arithmetic neighbor-color reference. Eighteen cases cover
integer/fractional scaling, one-pixel width, gaps/skips, occlusion, fades,
moving/shrinking retained storage, offscreen slopes and first/last output rows.

The CPU Skia 1.1.0 run passed all 18 cases. Baseline and optimized output were
byte-identical, and the independent reference matched exactly in this run.
Production output `getImageData` was forced to throw; zero calls occurred.
The retained side-by-side full-frame and magnified comparisons were inspected.
These are explicitly synthetic silhouette fixtures, not captured White
Mountains, Sierra or Sneffels scenes, and CPU Skia is not a browser GPU.

| Controlled fixture | Baseline | Optimized |
| --- | ---: | ---: |
| 1920×1080 dense three-band copy pixels | 1,751,040 | 1,720,320 |
| Explicit scratch-clear pixels | 983,040 | 0 |
| Scratch allocation bytes | 3,932,160 | 3,440,640 |
| Neighbor copies / band strokes | 2 / 3 | 2 / 3 |
| 960×540 fractional dense copy pixels | 441,210 | 431,754 |
| Explicit scratch-clear pixels | 245,760 | 0 |

The narrower unit-test ridge gives 280,320 → 249,600 copied pixels (10.96%
less). Benefit depends on the silhouette's bounds; it is not an overall
frame-time percentage. No GPU timings or presented-FPS estimates are reported.

Run the browser oracle with a working Chromium installation:

```sh
node tools/ridge-output-regression.mjs --browser /path/to/chromium \
  --out .smoke/ridge-browser
```

The optional CPU fallback takes an externally installed `@napi-rs/canvas`
directory through `--cpu-canvas`; it is not a new product dependency.
Local evidence for this task is under `.smoke/ridge-cpu-oracle-final/`.

## Travel admission and attribution

The [transition audit](ridge-transition-audit-2026-11-06.md) separates historical
vertical seams and inferred growth-ground horizons from a newly relevant
residency failure. The accounted output-resolution fine target was retained
while incoming terrain tried to allocate, even though travel cannot use that
target. Suspension now releases it before incoming preparation and remains
held through loading/late joining, without releasing native async probes or
reallocating every pending frame. The real ledger/presentation test reproduces
the failure without the fix at 192 MiB and passes with the fix.

This fixes the admission mechanism; it does not claim to remove visible travel
seams, the Sierra's inferred horizon, or the reported early playback stalls.

## Musical direction and construction

Atmosphere follows a causal phrase envelope compiled once per analysis, with
constant-time reads during frames. Sustained energy clears valley mist and
strengthens existing key light, shafts and broad sky radiance. Isolated drums
retain localized accents. Quiet returns settle over seconds. The added
channels participate in the existing generation handoff and seek/pause model.

Camera moves use musical energy changes to choose build, reveal, settle or
hold behavior; a seed chooses a consistent side rather than unrelated moves.
Trusted major arrivals gather framing over three seconds and open over five,
remaining inside authored coverage. The scenic reveal does not drive stage
dip, shake or tilt, and no render pass or GPU buffer was added.

Landscape construction reads the exact terrain `rise01`. Midio directs the
work front, Broshi secures anchors, and Midasus surveys ahead. Preparation,
raising, settling and inspection follow actual relief; completed mountains
stop construction transfers. Existing lights, motes, ropes and survey threads
provide the operation, with tighter wandering. Source-space anchors retain
the shared terrain lift, and survey threads wait for their actual anchors.
Rail and tour routes share this behavior. No terrain is invented for a missing
route, and the separate Trio experience retains its existing stage behavior.

## Validation and release boundary

Targeted tests cover color parity/reuse, 192 MiB transition admission, musical
smoothness/causality/handoffs, authored FOV limits, construction dependencies,
shared rise and completed-state behavior. An independent source review found
and verified the fix for survey threads appearing before their anchors; its
final focused rerun passed 43 tests with no outstanding source findings.

The initial staging check exposed an existing mismatch on starting main:
the lockfile's merged Three.js 0.187.0 update still shipped the 0.186.1 runtime.
The pinned bundle was rebuilt with its manifest in a separate prerequisite
commit. Reproducibility and site staging then passed. This dependency repair
must also be included in the eventual browser validation.

Actual Chromium launch failed at `process_singleton_posix.cc` with
`socket() failed: Operation not permitted`; both available Playwright
headless-shell downloads returned unusable archives. No full-scene captures
were obtained. The connected desktop was offline, and this environment has
no hardware GPU. The generated 90-second pilot matches the original fixture
hash `c0160a5c95669def70cfe43feeca1c06b81117cf01f2b4e43d59f1ef59e02297`,
but that alone supplies no new visual or playback evidence.

Before merging, run the browser oracle, matched real-scene captures and
continuous playback across single-stage Pixel, Detailed hybrid 960×540,
Classic/Cinematic 1920×1080, fractional output scale, quality changes,
seeks and two-view transitions. Compare the ridge optimization separately
from intentional music/camera pixel changes. Repeat matched GPU timing and
evaluate the music against representative recordings. Physical JOYING
playback remains a separately unverified result. Until that rendering
validation exists, this work is a reviewable draft rather than a merged
performance claim.
