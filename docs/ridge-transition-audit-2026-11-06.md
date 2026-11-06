# Ridge and transition audit

Audit baseline: PR #94, merged as `432a146`, with base `575e19d` and
head `e2a7299`. Current starting main was `a12a641`. This review distinguishes
recorded visual observations, source/history findings and CPU regression tests.
It does not add GPU, song-motion or JOYING device evidence.

## Attribution

| Finding | Evidence and scope |
| --- | --- |
| Vertical boundaries in geographic travel predate #94. | The [November 5 range review](scenic-expansion-2026-11-05.md#growth-and-travel) records staggered boundaries and mixed foreground edges at `327f960`, before #94, using the synthetic 90-second fixture at 42/70 seconds. `TravelSeam.js` and the travel compositor were unchanged by #94. |
| The temporary inferred horizon also predates #94. | `RiseGround.js`, `LandRise.js` and the rise score were unchanged by #94. They came from the earlier flat-ground work (`ec82b20`, PR #89). [Landscape rise](landscape-rise.md#ground-coverage) explains why the cropped terrain packages need this temporary inferred support. |
| The new Sierra view exposes that existing limitation. | The [November 6 range evidence](scenic-expansion-sierra-san-juan-2026-11-06.md#controlled-travel) records especially visible boundaries in Superstition → Whitney at 42 seconds. Its range-only captures used the unchanged base renderer, independently of the ridge correction. This is increased exposure to an existing mechanism, not proof of a new crest defect. |
| Fine ridge ink is absent during two-view travel by design. | Both the base and #94 gate `crestOn` on `!incoming` in `RangePresentation`. A missing fine outline during travel is not by itself a regression. Return-to-steady behavior still needs motion review. |
| #94 adds bounded rendering cost on the measured GPU. | The [ridge evidence](ridge-output-edge-2026-11-06.md) reports 53.92 → 50.90 FPS at Detailed/960×540 and 30.75 → 28.27 FPS at Classic/Cinematic/1920×1080, fixed quality 0. The baseline was already below 60 FPS. These results support a measured regression on that RTX 3060 fixture, not a general device conclusion. |

The pale stripe removed by #94 also predates it. The recorded final
1920×1080/42-second comparison supports the corrected silhouette and color in
that paused frame. It does not establish temporal stability over a full song.

## Lifecycle regression and correction

#94 makes the fine target an explicit non-evictable residency entry and sizes it
to physical output. Previously, the fixed four-times-grid target was not charged
through that entry. During travel the probe is disabled, so its release branch
inside `_probeCrest` never executes. The unused fine target could therefore
remain charged while incoming terrain and the travel buffer tried to reserve
space. This is a newly relevant admission failure, distinct from the historical
vertical seam appearance.

`RangePresentation` now suspends the fine target before preparing the incoming
view. Suspension lasts through loading and any late-join fade. `RangeScene`
releases only that target and refuses to recreate it until steady playback
resumes; the native probe and asynchronous readback owner remain available.
Ordinary steady frames retain target reuse. The single-stage default, terrain
budgets, quality ladder and geometric travel blend are unchanged by this fix.

The CPU regression uses the real presentation selection and residency ledger
with a 192 MiB mobile budget, 168 MiB of retained outgoing terrain, a physical
fine target and an 8 MiB incoming view. Without the early suspension call the
incoming reservation fails. With it, preparation and the travel scratch both
fit, pending frames do not reallocate the fine target, a late join remains
suspended after the scheduled seam, and settled frames resume stable reuse.
The test does not allocate GPU storage or model actual head-unit frame timing.

## Verification and remaining evidence

The targeted run passed 100 tests on the combined working tree:

```sh
node --test test/rangeRailRuntime.test.js test/rangePresentation.test.js \
  test/crestGeometry.test.mjs test/crestOutputSizing.test.js \
  test/crestPixelColor.test.js test/crestProbeReadback.test.js \
  test/landscapeComposite.test.js
```

Targeted ESLint for the two changed runtime files and `rangeRailRuntime.test.js`
passed, as did whitespace checks. The presentation suite emits expected logs
from its deliberate failed-manifest/runtime/HTTP fixtures; all tests passed.
This audit did not run the full suite or GPU benchmarks.

Further visual checks should compare the pre-#94 and current renderers at the
same song times and travel fractions, especially Superstition → Whitney during
partial growth. Continuous playback should cover entry into travel, late joins,
the return to the fine outline, output/DPR changes, seeks and quality-rung
changes. Paused travel coverage cannot establish those motion outcomes.

JOYING JY-UTS18N12 remains the minimum target. Its native-resolution,
10-minute thermal and transition run remains a separate requirement described
in [device runs](range-v2-device-runs.md); no acceptance result for that device
is claimed here.
