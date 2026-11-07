# Valley Mist Implementation Plan

**Goal:** Replace the rising fog slab with low, gradually forming banks moving through actual valleys.
**Architecture:** Static terrain drainage field plus deterministic local-bank sampling inside existing mist integration.
**Spec:** docs/superpowers/specs/2026-11-07-valley-mist-design.md

- [x] Build MistFlow.js field generation, packing, bilinear CPU sampling and Three texture; test synthetic valley connectivity, invalid terrain, bounds, cancellation and bytes.
- [x] Replace cloud-sea CPU/GLSL branch and emitter occupancy; test formation, upstream motion, bounded height, pause/seek, continuity and retained baseline mist.
- [x] Wire preparation, memory/scratch accounting, terrain modes and disposal in RangeScene/TerrainMaterial; test binding/disposal and existing preparation/lifecycle behavior.
- [x] Compile and render the actual shader in a surfaceless software GLES context; compare CPU numeric oracle where practical.
- [ ] Review integrated changes, run affected tests/lint/modules/staging and document limits; publish a draft PR including the adaptive-quality work.

Implementation, review and local verification are complete. External push and pull-request creation are pending publishing authorization after automatic approval review rejected the push.
