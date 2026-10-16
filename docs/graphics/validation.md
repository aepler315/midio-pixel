# Graphics validation

## Current candidate

The current registry retains eight public worlds. Cathode is retired; removed IDs normalize to The Range. Terrain work is confined to The Range's optional real-profile path; missing profiles still use procedural terrain.

Local checks at functional candidate `e158f3dddf1e3db804cf27e81f36e451cd0edf96`:

- `npm test`: 2,964 passed, 0 failed.
- `npm run lint`: passed.
- Focused terrain profile, builder, travel, strip-cache, library, clock, and recorder regressions: passed.
- Staged artifact allowlist test: passed.

The local executor could not install Playwright Chromium because its CDN returned empty archives. Browser captures and the staged Browse probe are therefore CI gates, not local claims.

## Historical comparison evidence

`docs/graphics/evidence/refactor-comparison.json` records the earlier behavior-preserving world-render refactor comparison. It belongs to the revisions named inside that file; it is not relabeled as evidence for this candidate.

## Acceptance still required

- Run the final all-world capture protocol on the exact candidate revision and inspect actual motion, not only still pixels.
- Complete blinded holdout ratings for appeal, musical timing, identity, quiet interest, climax headroom, and clutter.
- Measure target desktop and Android/Fermata frame pacing and recovery behavior.
- Generate a third sourced terrain ridge before describing the geographic stack as three real profiles.
- Decode a recorded click/cue fixture and report audio-to-picture offsets at multiple positions.

Until those items have revision-tagged outputs, world aesthetics, three-ridge geography, physical-device performance, and encoded A/V synchronization remain unclaimed.
