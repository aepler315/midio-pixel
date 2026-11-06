# Sierra Nevada and San Juan range expansion

**Goal:** Add two new geographic regions to normal Landscape playback, retaining flat-ground growth, progressive detail, atmosphere and the single-stage renderer.

**Architecture:** Author and bake two new 20 m USGS 3DEP terrain corridors through the existing offline pipeline. Reuse the STEPPE and CONIFER materials and ordinary scheduled camera rails. Enable the resulting packages as explicit experimental candidates after bounded visual and GPU checks; do not fabricate artistic approvals or shot libraries.

**Tech stack:** Existing Node terrain builder, installed WSL Ubuntu Python/GDAL, WebGL renderer, isolated muted Chrome with ANGLE D3D11 on the RTX 3060.

The user chose more mountain ranges. Current task authorization and AGENTS.md cover routine location/camera/implementation choices without another approval round. This pass focuses on new geography rather than the unrelated pacing investigation.

## Design choices

- Add `sierra-whitney-east` (Sierra Nevada, STEPPE) and `san-juan-sneffels-north` (San Juan Mountains, CONIFER), aiming for contrasting granite-front and alpine-ridge compositions.
- New camera positions and heights are authored estimates, checked against the actual normalized DEM. Named landmark coordinates must have recorded source attribution. Material habitat thresholds are artistic rules, not measured land cover.
- Use dated 3DEP source pins and `windowCache: tile`, with source/payload hashes recorded by the existing builder. Fetch only the required terrain windows into this task's cache.
- Existing alternatives were enabling the Pend Oreille glacier journey or same-geography Teton/Monument pilots. The glacier's separate whole-song journey and the repeated geography make them a weaker fit for this request.
- Add only these new packages, authoring, catalog entries and coverage/selection tests. Retain existing package identities and playback controls.

## Implementation and verification

- [x] Add source-backed authoring and focused assertions in `test/experimentalScenes.test.mjs`; distinguish five enabled experiments from the three attached shot libraries and test normal regional selection/recency.
- [x] Resolve dated USGS source URLs, normalize and bake each explicit view with `tools/build-range-scene.mjs`. Review geometry before publishing each package triple under `src/assets/range/v2/terrain/`, then regenerate `src/world/terrain/sceneCatalogData.js`.
- [x] Check ordinary rail coverage and cross-view crest width, source/package integrity and reproducible payload hashes. Adjust authored camera framing where evidence shows a poor composition.
- [x] Capture flat opening, partial rise, full height and rewind on the actual RTX 3060. Check both new views and controlled incoming/outgoing travel at Detailed/full effects; retain evidence outside Git.
- [ ] Benchmark both new views at Detailed/Auto, reporting whole and settled intervals, quality changes and limits. Run focused tests/lint and the normal full pre-push gate with system Chrome and `VISUAL_ANGLE=d3d11`.
- [ ] Open a follow-up PR with the new regions, ridge correction, source/evidence notes and validation results. PR #90 was merged during this work; the follow-up starts from its merge commit. Do not merge without an explicit merge request.

## Review focus

- Terrain extent and camera pull-back must not expose missing ground or crop-edge walls.
- New regions must start on the same truly flat plane as existing ranges and deterministically rewind.
- Far terrain and transitions must retain coverage even when brief skyline occlusion is allowed.
- Forests and simultaneous views must fit the existing residency budget and retain the culling optimization.
- Candidate metadata, absent shot libraries and the actual scope of device/visual evidence must remain explicit.

## Added ridge-edge correction

The user supplied a crop from supermaudio.com showing a pale skyline stripe
with coarse diagonal steps. The fetched live presentation/crest modules match
the starting revision. Pixel defaults to the single-stage path; Cinematic or
an explicit hybrid override activates the affected crest overlay.

- Preserve the fine terrain silhouette through output-resolution cutting and
  drawing instead of averaging its subcolumns back onto the working grid.
- Blend actual composite pixels immediately above and below each edge segment,
  without a constant sky-color estimate, eight-cell average or palette snapping.
- Keep the single-stage default. Verify the affected path separately against
  the starting revision, including actual RTX 3060 timing and output scaling.
