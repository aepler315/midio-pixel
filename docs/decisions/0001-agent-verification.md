# 0001 — Verification built on production capture paths

Status: accepted for this implementation, 2026-11-13. Supersedes no runtime decision.

Main inspected: `58454dd93e6919c591835f6ccc0edefa02888f49`. No open PRs were returned by the connected GitHub query at reconnaissance. Recent deliberate changes include #132 dead-code removal, #130 Dual Summits, #129 geometric composed-range growth, #128 mood hue and #126 frame-cost reductions.

## Decision

Reuse the Node test runner, ESLint, stage-site production packager, frozen-source server and real upload/export capture API. Add a bounded scenario runner, explicit baseline approval, thresholded full-size PNG comparisons and a separate CPU benchmark. Keep costly full-song/GPU/device work opt-in. Automatic PR checks use read-only permissions and upload evidence even on failure.

A small reviewed PNG corpus under `test/fixtures/verification/baseline/` is an intentional exception to the usual untracked-capture policy. Full captures/audio/logs remain in `.smoke/`. Baselines have reviewer/reason, controls, audio hashes, renderer, browser and source provenance. Generating a candidate never approves it. Initial technical approval does not imply owner artistic approval.

## Alternatives and costs

Replacing existing harnesses would duplicate boot, audio, diagnostics and teardown. Pixel-exact screenshots across GPU/browser versions would be brittle. Instead use per-channel tolerance, changed-area ratio, local luminance SSIM and edge differences; reject mismatched controls/environments. CPU timing comparisons require matching environment and workload, with broad relative allowances; deterministic outputs remain the hard contract. Timing alone cannot establish improvement.

## Current-code findings and documentation conflicts

Cinematic is the only effective Look (`DisplayProfile.js`); Uniform is the only pixel scale. Smooth output sky, water and fine crest composition are deliberate exceptions to terrain pixel structure. Historical Pixel/Palette/Depth instructions in `docs/landscape-review.md`, `docs/pixel-presentation.md` and inherited `MIDIO_PIXEL.md` are not current options. The older device-run quality table retains mirrors until level 6; current `RangeQuality.js` sheds terrain mirrors at level 1. The older scalar-rise description does not describe composed stages (5% geometric opening) or Dual Summits. New engineering docs resolve these conflicts without deleting their historical evidence.

Measured DEM catalog scenes and composed artworks have different geographic claims: StageAssembly deliberately relocates measured massif pieces and may exaggerate relief. Do not claim the composite is a reconstruction of the source mountains' relative positions. ValleyMistEngine is implemented, not a future promise. Compiled terrain, material/shading and direct-terrain investigations remain experiments, not release requirements.

## Consequences

Small PR gates cannot certify motion, full-song listening or JOYING frame pacing. Browser upgrades require a reviewed baseline migration. Missing baselines, altered controls, failed capture and missing timing results fail visibly rather than being treated as zero error. Artistic evolution remains authorized by the current task and experimental-development policy.
