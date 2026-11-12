# Dual Summits signature Landscape

Dual Summits is an explicit song performance built with the existing composed-range terrain, per-slot growth, water, sky and quality systems. Its two hero masses are measured Grand Teton and Mount Moran pieces, arranged on the existing offset-shore stage. It is a composed artwork, not a reconstruction of their geographic relationship. Existing framed relief scaling remains in use.

## Play it

Upload the canonical `ds182/ds182.wav` mix (513.762789 seconds). A SHA-256 match selects the signature automatically. Alternatively use `?performance=dual-summits&rangeTour=off` and upload a recording. `?performance=off` suppresses automatic selection. A user-forced catalog view or Teton highway tour remains an explicit camera override; use tours Off for this authored performance.

Measured stem roles require the exact canonical mix hash, not its name or duration alone. Another recording can use the same directional vocabulary, but its diagnostics say `roleSource: unavailable` and its cues use mix-energy analysis. The older root `ds182.WAV` (509.138 seconds) is a different render and does not receive the canonical stem evidence.

## Music and direction

Summit A (Grand Teton, slot B1) represents the clean guitar texture; summit B (Mount Moran, B2) represents the distorted guitar texture. Four-second smoothed power shares shift the camera's emphasis between them. These are actual exported guitar groups, not inferred instrument separation. The third group contains piano, bass, drums and remaining parts together; no isolated drum or note-level claims are made.

The compact evidence asset contains 500 ms RMS measurements and source hashes, without audio. The three aligned stem groups have the canonical mix's sample count, rate and channels. Their sum correlates 0.99999913 with that mix. `tools/build-dual-summits-evidence.mjs` regenerates measurements from the four PCM WAV exports using `--mix`, `--clean`, `--distortion`, `--other` and `--out`.

The canonical score directs five acts:

| Act | Heard time | Direction |
| --- | --- | --- |
| First presence | 0–38.5 s | Tight 18-degree view of A; B stays outside the frame. |
| Emergence | 38.5–164.4 s | Widen and shift attention toward B as the arrangement develops. |
| Interplay | 164.4–299.5 s | Slow clean/distorted emphasis inside the same geography. |
| Convergence | 299.5–335.5 s | Both reach full relief at the measured 317.5 s energy arrival; widen to the shared 40-degree image. |
| Afterglow | 335.5 s onward | Hold the earned pair and reflection while the existing sky and light continue. |

The arrival falls in the mix's strongest sustained 316–324 s passage. It is an energy-based artistic choice, not a claim that RMS establishes the song's definitive emotional climax. Both mountains grow monotonically; local musical displacement is restrained to 18% of the ordinary field. No beat-driven height alternation or flash is added. Storm light clears during convergence, and signature lightning is suppressed.

## Implementation and failure behavior

`DualSummitsScene` supplies the two-piece plan and actual assembled summit positions. A bounded whole-tile slot offset tightens their shared composition; camera and placement participate in the stage key. Assembly, tile ownership, per-slot rise and LOD read the same transformed template. The 18-degree LOD allowance covers the opening lens. The existing camera/renderer consume the resulting stage.

`DualSummitsMusic` validates recording evidence; `DualSummitsPerformance` compiles bounded, immutable cue/envelope readers. `LandscapeScore` retains the admitted score across late analysis and manager recreation on seek/replay, keyed weakly by the terrain identity. Canonical cues do not depend on mutable detected section labels. The frame enables signature effects only while the actual signature view renders; a catalog fallback regains ordinary scalar growth, camera and weather.

Package/hash/decode failures, missing catalog heroes and the existing 1.8 s preparation deadline keep the catalog choice without later adoption. Signature GPU budget failures have bounded retries before that fallback; ordinary landscape retry policy is retained. No terrain assets, new renderer, new world mode or broad UI were introduced.

## Review evidence

Generated evidence stays untracked in `.smoke/`:

- `dual-summits-before-final`: origin/main `a10d49e`, verified frozen snapshot.
- `dual-summits-after-final`: final artistic direction, same canonical audio and controls.
- `dual-summits-comparison/index.html`: matched before/after views and technical comparison.
- `dual-summits-push-validation.log`: final complete Node test run.

The seven matched times are 3, 75, 150, 240, 300, 320 and 505 seconds: opening, developing reveal, clear B, interplay, preparation, climax and final hold. Captures use isolated muted headless Chromium, SwiftShader, 1280 by 720, Classic+, quality 0, natural scene selection, tours Off and construction seed 315.

Observed in these captures: the baseline stays low and geographically generic; the signature isolates A, reveals a distinct B, alternates emphasis and resolves to two separated hero crests with large reflections. The closer lake eye removes the distracting foreground shore. At 320 and 505 seconds both hero peaks remain legible; the camera pose is held through the ending. The final captured graphics ledger peaks at 188,481,052 bytes (179.75 MiB), with zero overcommits. This is renderer-ledger evidence, not total process memory or device frame pacing.

Unit coverage includes deterministic selection, source guards, independent monotonic growth, direct sampling, analysis handoff, fresh-manager seek reconstruction, actual fallback-stage metadata, slot bounds/identity, missing packages, deadlines, preparation and render-target budget refusal. Existing tests cover the underlying renderer and ordinary playback paths.

Unverified: JOYING JY-UTS18N12 hardware, physical-display pacing, full-song continuous playback/listening acceptance, and exact MIDI/Guitar Pro alignment. Remaining artistic opportunities are a less prolonged afterglow, closer listening-led climax placement, and more distinctive lighting across the two masses. These do not change the recorded evidence or claim device/artistic approval.
