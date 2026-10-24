# Panamint and Teton transfer and ending repair

The user authorized implementation, rebuilding and actual-app review, with Panamint and Teton first and further locations on hold. This pass starts from main `1b46e5e3fad38b7b8c75d2391af2e6b79500bfff` and retains the exact R3 candidate assets as the comparison baseline. The preceding R4 source and evidence remain preserved separately.

## Design and choices

The builder estimates transit durations without the runtime's supported-curve climb cap. Panamint's selected direct transit is advertised at approximately 49 seconds but needs at least 84 seconds under the current runtime cap. The scout graph has 120 usable shots and 903 links; the final package keeps ten shots and 26 links. Teton similarly retains ten of 136 cached shots. Its long route can potentially use a nearby distinct-subject staging shot already in the scout graph.

Correct authoring estimates and rebuild the two local networks before changing global planner weights. Raising flight limits would hide the mismatch. Increasing transit penalties alone cannot create missing short connections. The working choice is to price admissible connections using the actual runtime geometry, preserve legal nearby staging and review the result. Any budget change must name its measured cost. No approved rail or geography is promoted.

Both previous endings stop partway through a link. Links lack subject-framing guarantees. An in-frame subject center is insufficient: the saved final frames contain cropped foreground ridges despite passing the existing composition score. Prefer a legal closing shot with sustained subject extent and depth separation. If network changes alone cannot achieve this, add a narrowly tested terminal-selection rule, retaining legal continuation fallback. Broad exposure or sky changes are outside this first camera experiment. Evaluate any remaining receiver-lighting change at a fixed camera separately.

## Implementation and verification

- [x] Preserve a current-main baseline, exact candidate asset identities, actual audio hashes and headless app probes/captures for both views.
- [x] Reproduce the authoring/runtime duration mismatch with a failing behavioral test; implement shared supported-curve bounds and refresh cached selection estimates. Preserve clearance, visibility, decoded geometry and motion checks.
- [x] Rebuild the Panamint and Teton candidate libraries from the cached scored graphs, retaining shorter staging where required. Measure actual payoff times, longest/total transit and ending item; retain improvements that do not create illegal movement or lose all meaningful climaxes.
- [x] Evaluate whether a terminal rule is needed. Both rebuilt networks reach closing shots, so no new runtime terminal policy or corresponding regression fixture was added. Existing short-song and committed-continuation checks remain in the full suite.
- [x] Freeze the final source/assets. Bind actual-worker plans and Float32 keys to CPU replay, select matched windows before candidate images, and capture/review all changed moves, climax, quiet and ending windows. Keep failed attempts and media outside Git.
- [x] Run focused behavior tests, all-library CPU controls, full `npm test`, lint and an independent review. Record exact source/candidate identities and the publication/readback procedure in the [completed review](scenic-transfer-endings-review-2026-10-23.md).

The final Panamint edit rejects the first 48-second-payoff opening, retains a
visible trimmed opening at 16 seconds, and repairs the unused return geometry.
The final packages fit the original regional caps; temporary headroom was not
retained. Publication/readback records stay with the external verification
bundle, while camera approval and deployment remain separate.

The saved export-clock captures establish their recorded images and motion. They do not establish live/device FPS, deployment or owner artistic acceptance. New locations remain on hold throughout this pass.
