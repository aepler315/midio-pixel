# Terrain-only pixel experiment

Add `?directTerrain=1` to the app URL to try the Alpine Landscape direct renderer. The normal renderer remains the default. The experiment composes the sky, water, weather, light, and screen effects at output resolution, with terrain partitions sampled onto the selected output-aligned grid at their original depth boundaries.

This is a work in progress. Palette and cinematic reconstruction happen per terrain layer, so the resulting colors can differ from applying them to a finished scene. During scene arrival and under memory pressure, some water or cast may fall back to the pixel grid. Captures use the finished display frame; a larger export upscales that frame and can soften terrain cells rather than re-rendering effects at export resolution. Integer scaling is not yet reproduced exactly. Effects and terrain appearance, mobile performance and memory use have not been reviewed on a real device.
