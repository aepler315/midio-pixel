# Midio Pixel design

The user wants an independent private `aepler315/midio-pixel` copy of Midio-5, pixel-only, preserving the excellent current pixel appearance while adding dynamic pixel size to communicate dramatic scale. The source is pinned to `e53db1e0663ce0f8db6d9d89d168dc6d6dbdb308`, tree `3d4ca45c9d38b8bb7a26a2ce851e72dbb259df8b`. Original repository files and settings must not change.

## Preserve

Keep all worlds, music analysis, camera choreography, terrain, forest, lighting, weather, reflections, audio integrations, quality governor, palettes, selective dithering, Classic/Detailed grids, and export sizes. Pixel presentation uses these systems. Do not replace the renderer, pin Economy, restrict colors by default, or reintroduce removed characters. Existing pixel settings migrate without loss. Uniform pixel scale remains available as an exact rendering comparison.

## Pixel-only product

Default to Pixel, Classic grid, Auto quality, and Depth scale. Palette remains a pixel color treatment. Resolve stale Natural settings and programmatic display overrides to Pixel. Use a `midio-pixel` preference key, reading old preferences once without writing them. Remove Natural and its Stage resolution control from the product. Keep shared internal nonpixel rendering math used by assets and tests where required.

## Depth scale

Use actual camera-space terrain depth at the existing Range GPU color-copy boundary. Nested nearest samples at 1, 2 and 4 pixels share fixed screen-space integer grids. Broad smooth distance blends avoid abrupt resolution bands; no time-driven jitter, temporal history, random sampling, or extra scene draws. Distant terrain converges to the original sample. Preserve original alpha; suppress coarser samples at alpha/depth discontinuities. Uniform scale bypasses this branch exactly.

RangeScene owns sampleable scenic depth attachments independently of sun-shaft lifetime. A/B travel sides use their own texture and current camera. Every copy resets the depth uniforms; unrelated ownership, ground, and mirror copies retain their existing behavior. Failure to obtain depth falls back to the current uniform pixel rendering.

Depth scaling is initially supported by Range v2's physical terrain. Other worlds and legacy fallback retain their existing pixel rendering; do not approximate their depth from screen height. The requested optional modern effects are already supported through current lighting, weather, reflections, music-reactive terrain, and camera motion; retain them instead of adding unrelated spectacle.

## Repository identity and validation

Remove the inherited `supermaudio.com` CNAME and make staging domain-neutral. Do not publish or reconfigure the original site. Keep deployments manually triggered until the new hosting destination is configured. Preserve source attribution and license.

Verify source tree hashes, test preference migration/export/pixel enforcement, depth sampling continuity/edge protection, depth ownership/lifecycle, and shader uniform reset. Run full unit tests and lint. Capture source baseline before edits, then identical original-scale candidate and separately labeled depth-scale candidate, inspecting actual images and movement. Document software-rendering limits honestly; no visual-quality claim from tests alone.
