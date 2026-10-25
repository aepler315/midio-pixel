# Cinematic Pixel: investigation and design

Base: `387f9631b43e254c56eb2d6e1545aef140f4392e` (origin/main, 2026-10-24). New work uses `feat/cinematic-pixel` in an isolated checkout; the existing Windows checkout is untouched.

## Artistic reading

The supplied goal.jpg and before.png share a valley/river composition. The goal has a substantially deeper navy/green foreground, cooler shadow faces, brighter blue-white snow, separated receding ridges, luminous low valley haze, and quiet sky between sparse celestial objects. Broad tonal gradients coexist with stepped contours. Forest texture gathers into crowns rather than white speckle. Scale comes primarily from contrast declining with depth. The reference is an artistic target, not evidence that the renderer already produces those qualities. Its exact mountain arrangement is authored composition; illumination, attenuation, grouped material detail and frequency control can be procedural.

## Current image construction and losses

`DisplayProfile.js` resolves Look separately from five fixed `PixelRenderPolicy.js` grids: Classic 320x180, Classic+ 400x225, Medium 480x270, Medium+ 560x315 and Detailed 640x360. `PresentingRenderer.js` paints the main Canvas renderer into that native raster, then `PixelPresentation.js` composites a separate full-resolution sky behind nearest-neighbor terrain. Recording rebuilds this same hybrid picture at its requested size. Classic+ is a resolution, not a lighting recipe.

`Renderer.js` and `BiomeManager.js` place Range v2 partitions among the existing music, weather, actor and VFX painters. `RangePresentation.js` resolves song/biome/view/tour camera and frame, then `RangeScene.js` owns WebGL2, scene depth, ownership, terrain bands, forest, mirrors and shafts. One scene depth pass occludes all partitions. The camera and LOD/window machinery remain authoritative. Fallback legacy scenery and Trio remain supported.

`TerrainGL.js` uploads normals/curvature/flow and receiver textures; `TerrainMaterial.js` shades real mesh geometry with triplanar material detail, mapped normals, GGX/specular filtering, horizon shadows, far canopy, storm and lunar light, six-sample integrated valley mist, air perspective, water reflections and tone mapping. `ForestGL.js` uses mesh/billboard representations, procedural species and derivative-based filtering. `RangeQuality.js`, `RangeRenderPolicy.js`, terrain windows and `GraphicsResidency.js` bound cost and shed work. Pixel materials intentionally bypass texture detail that cannot be resolved. `RangeSkyRenderer.js` already supplies smooth gradients, procedural cloud textures, celestial discs and stars.

The largest suspected losses are excessive hemispheric fill (`RangeScene._setUniforms`: ambient 2.5 times sky radiance), 50% residual key even behind the terrain horizon, broad wrap diffuse, and independent mist plus air terms reducing local contrast. Individual forest trees do not consult the same horizon as terrain canopy, weakening geographic shadow continuity. A final RGB contrast curve alone cannot fix that. Blurring the combined image would lose silhouette structure. Adding more high-frequency noise would make motion worse.

## Approaches

1. **Post-only grading and bloom:** inexpensive, but has no surface orientation or world depth. Cannot recover directional shading; bloom can worsen haze and crush detail. Rejected as the primary architecture.
2. **Deferred sharp coverage plus smooth irradiance/atmosphere targets:** strongest independent control, but introduces extra targets, ownership reconciliation, mirror paths, GPU budget and lifecycle complexity across travel sides. Deferred until a measured benefit justifies the cost.
3. **Art-directed forward lighting plus bounded edge-aware cell reconstruction (selected):** reuse the true normals, depth, horizon, haze and hybrid sky; add a gated shared cinematic shading profile, forest horizon consistency and conservative output-space color interpolation. This is the smallest architecture that directly addresses the observed failure mechanisms.

## Selected design

Add `look: cinematic` as an opt-in display preference and export/capture option. It retains the selected native grid and palette-free color. Default Pixel and Palette behavior remain unchanged. Feed a boolean through PresentingRenderer -> RangePresentation -> RangeScene and a snapshot flag into the smooth sky. Shared cinematic shader helpers operate in linear/display-linear space before sRGB encoding. Use a uniform gate so live switching does not require terrain asset regeneration. Parameters live in named source constants/uniforms, documented with units.

Terrain: reduce broad ambient wash while retaining moon/storm readability; narrower diffuse wrap; lower shadow residual; cool skylight in shadows and restrained warm key; gentle toe/shoulder and saturation that preserve snow highlights. Distance-aware shading keeps large forms at long range. Atmosphere: preserve the existing ray-integrated mist and cloud-sea behavior; reduce the generic veil near the eye and use blue distance air with sun-facing scattering where supported. Forest: reuse the baked terrain horizon for direct and transmitted light; maintain crown/understory separation and the existing filtered handoff to far canopy.

Presentation: optionally reconstruct small continuous color slopes inside native cells from compatible adjacent samples. Keep each cell's nearest owner, reject alpha/large color discontinuities and clamp to local compatible extrema. This is a conservative color heuristic, not a depth reconstruction; close-color boundaries remain a limitation. No temporal history or jitter. If unavailable, fall back to the already shaded nearest frame and report it. The smooth sky remains independent. Capture/export use the same compositor.

Sky: keep real camera projection and sky authority; cinematic-only restrained solar halo and directional cloud light/color separation, with reduced activity in quiet sky. Preserve weather and musical timing.

## Constraints and acceptance

No static backgrounds, pre-generated landscape replacements, simulation changes, camera changes, automatic default promotion or changes to baseline artistic parameters. Do not commit captured media. Account owned scratch memory and release it. Tests establish ingress, switching, capture/export, lifecycle and numerical behavior. They do not establish beauty.

First capture Classic+ before edits. Then render identical song/seed/time/camera/quality at Classic+ with each Look. Inspect actual frames, multi-frame motion, lake/inland, closer/farther, night/storm where feasible. Repeat baseline after edits for regression evidence. Run the full test suite, lint and site staging. Headless native Windows Chrome on verified RTX 3060 is the preferred GPU path; software timings are never desktop FPS claims. Report all aesthetic and hardware coverage limits.
