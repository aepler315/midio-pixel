# Adaptive quality and visual value audit

## What changed

The existing PerfGovernor remains the single quality authority. It now receives CPU work from completed, visible rendered callbacks as well as raw callback periods. CPU submission timing is an estimate of available CPU capacity; asynchronous GPU pressure still appears through missed callback deadlines. Sustained headroom permits one-rung recovery, failed recovery retains fast rollback/backoff, and near-budget CPU work can reduce detail before callback deadlines fail. Skipped draws never count as cheap renders. The General quality slider remains a maximum detail setting; selected FPS, warmup, pause/visibility, export and fixture policies remain effective.

The Landscape ladder retains sun shafts, cloud shadows, reflected sky and the Milky Way at low detail. The reduced Milky Way uses a deterministic subset of the existing galactic cloud catalogue; it preserves the band and its heard-time/lunar behavior. Rare music-triggered streaks remain bounded to one. Terrain data, growth, camera paths, event timing, weather and artistic pixel-grid selection are unchanged by this work. Existing tree thinning and lighter near-tree representations remain available; low/high images are consequently not pixel-identical. Memory admission can still refuse optional targets when residency is exhausted.

Two resource fixes accompany the policy: disabled near-tree detail skips unused projected-footprint scans, and mist sampling drops immediately under pressure rather than temporarily evaluating two more expensive banks. Recovery also switches directly to an integer sample count, so a temporary dual-bank workload cannot reject an affordable rung. Sample-count changes leave bank formation and transport timing intact. The follow-up [valley mist engine](valley-mist-engine-2026-11-07.md) intentionally replaces the earlier rising slab.

This is an empirical controller with bounded probes, not a promise that an unknown device will never miss a frame. CPU timing cannot measure GPU headroom directly. Actual JOYING performance and the new low-detail appearance require device/motion review.

## Ranked visual return per resource

Rankings combine source inspection with the historical evidence identified below. They are not a fresh GPU benchmark or universal perceptual scores.

| Priority | Feature or repeated work | Evidence | Decision / next optimization |
| --- | --- | --- | --- |
| 1 | Planar lake mirror | `RangeScene` renders reflected depth, terrain and forests again. Historical matched captures changed 0–2% of image pixels without it; the same software-rendered pilot was about 11% faster. View dependence matters, especially low shoreline angles. | Retain opportunistically at q0; first fallback remains the reflected-sky water appearance. |
| 2 | Near-tree branch detail and unused footprint scans | Full tree assets contain roughly 1,620–2,132 triangles, quality-lite 248–320, pixel-lite 820–1,076. Much branch detail can resolve below one displayed terrain cell. `ForestDetail.forestBatchFootprintPx` visits every drawn instance; this scan previously continued after `nearDetail=false`. | Keep lighter representations before stronger thinning. **Implemented:** disabled detail performs no footprint projection or instance-position scan; regression verifies identical visibility/counts/geometry selection. |
| 3 | Reflected-sky backdrop replay/copy/upload | `RangeScene.captureBackdrop` reserves eight bytes per target pixel, may redraw the smooth sky, copies/filters the image and marks its CanvasTexture dirty every frame. Eligibility considers any prepared water view, including inactive prefetches. No isolated device timing available. | Preserve reflection. Future work should restrict production to water actually drawn and reuse sky work when projection/transform allow it; reduce target resolution before removing it. |
| 4 | Fractional mist-sampling transitions | The shader evaluates both `mistBanks(n)` and `mistBanks(n+1)` at fractional step counts. Easing 6→4 therefore temporarily costs 11 then 9 samples instead of the original 6. Cloud sea can evaluate two masks per sample. | **Implemented:** switch directly between integer sample counts in both directions; avoid transient extra bank work on recovery too. Preserve fog density and motion. |
| 5 | Fair-weather cloud shadows | Dry terrain fragments evaluate breakup noise and up to 15 elliptical shadow discs, including repeated mirrored shading. No isolated timing available. | Preserve the weather/lighting cue across tiers. Candidate later optimization: a lower-resolution projected field or reduced whole banks; profile before implementing. Keeping this cue adds work to old q4–q6. |
| 6 | Milky Way clouds and cinematic cloud blending | The galactic catalogue contains 432 seeded cloud entries; visible entries produce radial gradients, and lunar masking can repeat painting. Cinematic cloud interpolation performs three sprite draws per cloud. | **Implemented:** q3+ uses 144 fixed galactic entries with compensated opacity, instead of removing the band. Existing cheaper cloud rendering remains. Visual similarity requires rendered review. |
| 7 | Repeated per-pass uniform preparation | `RangeScene._setUniforms` runs for each terrain partition and both water sizes. It repeats forest visibility, tour setup, cloud-caster updates and `tourMistCap`; the latter evaluates a bounded route neighborhood. | Cache camera-independent frame/view calculations. Keep viewport, projection, reflection and camera-dependent fields fresh. No new cache introduced in this change. |

The first mirror comparison is recorded in [water-render-cost.md](water-render-cost.md), “The mirror is shed first.” Its timings used SwiftShader and establish work differences for those fixtures, not hardware FPS. Tree counts are asset geometry counts, not measured frame time. Mist fetch counts follow directly from the shader control flow.

Reproduce the mesh counts from the repository root:

```sh
node --input-type=module -e 'import { buildConiferAsset } from "./src/world/alpine/ForestSpeciesAssets.js"; for (let family=0; family<2; family++) for(let variant=0;variant<3;variant++) { const counts=[0,1,2].map(lod=>buildConiferAsset({family,variant,lod}).stats.triangles); console.log(JSON.stringify({family,variant,full:counts[0],qualityLite:counts[1],pixelLite:counts[2]})); }'
```

## Preserve these before spending time on them

- Sun shafts already use quarter width and height (1/16 the pixels), cap their largest dimension at 512, reuse existing depth, and perform 32 depth samples plus one composite. Their recognizable lighting cue warrants retention while larger repeated renders/copies are reduced.
- Current scenic giants render nothing; disabling their legacy quality flag saves nothing.
- Alpine bloom already returns early. Historical performer motion-history costs do not describe ordinary Landscape, where those copies require performers.
- Forest thinning exits vertices in the shader; it does not reduce submitted instance counts or resident RAM. Stable-order compaction/spatial spans need an upload-cost comparison before adoption.

## Validation and evidence limits

Behavioral verification covers the governor's frame caps, headroom, failed probes, explicit ceilings and locks; actual main-loop timing covers capped skips, failed/hidden presentations and complete callback CPU work. Feature tests cover retained sky/lighting, fog sample reductions and forest visibility. Final commands and counts are recorded in the PR.

Attempted `PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium npm run test:bootstrap`: Chromium aborted at `process_singleton_posix.cc` because `socket()` returned `Operation not permitted`. No rendered outcome or device FPS is claimed from this attempt. Physical JOYING testing was not available in this executor.

Follow-up profiling should use matched song/time/rung captures with `tools/render-hotspots.mjs`, and live p50/p95/p99 frame periods plus GPU timer queries where supported. Include forested tours, visible/absent water, cloud sea, night sky and transitions. Separate Canvas preparation/copy/upload, vertex submission and fragment work.

## Follow-up: valley-born mist

The new user-requested fog model and its actual software shader evidence are documented in [valley-mist-engine-2026-11-07.md](valley-mist-engine-2026-11-07.md). It replaces the old second-mask cloud-sea branch with one small drainage lookup, preserves the same ray-sample budget and keeps the terrain uniform guard. Coarse-field detachment and angular source regions remain documented limits.
