# Display presentation

Display settings are available on the title screen and from **Display** during playback. Look and quality are independent:

| Setting | Behavior |
|---|---|
| Pixel | Compose on the selected native grid with unrestricted scene colors, then nearest-neighbour presentation |
| Palette | Same grid, then World, Landscape32, Chroma32 or legacy RGB332 |
| Pixel scale | Depth uses camera-distance cell sampling in Range v2; Uniform preserves original sampling |
| Pixel detail | Classic 320×180 (default) or Detailed 640×360; Detailed processes four times as many pixels |
| Dither strength | Off (0), Subtle (0.35), Full (1) |
| Dither style | Ordered Bayer or Selective, which reduces stippling at original-RGB boundaries; RGB332 remains Ordered |
| Auto quality | Existing governor and recovery hysteresis |
| Economy | Pin the cheapest governor rung |
| Fit | Largest aspect-preserving image with opaque black bars |
| Integer | Whole-number physical-pixel scaling; aspect-preserving downscale when smaller than the grid |

Palette and dither controls are enabled for Palette. Style is disabled for RGB332 and Off. Pixel detail and scaling apply to both looks. The grid hint reflects the selected grid. There is no Natural look or Stage resolution control in this fork. Changing display settings while paused draws a new completed frame without advancing song time.

World uses Landscape32 for Alpine and Overgrowth and Chroma32 for the other six shipped worlds. Title and unknown/custom world kinds use Chroma32. It follows the stable world kind, not the camera, biome, song energy or image histogram. Chroma32 retains distinct cyan, blue, violet and rose accents. Both authored palettes have 32 fixed colors; RGB332 keeps its legacy quantizer.

Preferences live in `midio-pixel:display:v1` (profile schema version 2):

```js
{ version: 2, look: 'pixel', quality: 'auto', palette: 'world',
  dither: 0.35, ditherMode: 'selective', pixelGrid: 'classic', scaling: 'fit', pixelScale: 'depth' }
```

Read the new key first, then legacy `smw:display:v2`, then `smw:display:v1`, then the old Stage preset. Never write or delete Midio-5 keys. Legacy records without a scale choice retain `original` (Uniform); fresh installs default to Depth. Stale Natural settings migrate to Pixel. Migrated v1 choices retain their look, quality, palette, strength and scaling, adding Classic/Ordered; v1 is not deleted. Old `8bit` presets migrate to Pixel/Economy/Classic/Ordered; `8bit-intensive` migrates to Palette/Economy/RGB332/Full/Classic/Ordered. Optional fields are validated independently so a bad grid or style does not discard a valid look. Blocked storage uses usable defaults. Cathode is retired; stale saved world IDs resolve to The Range, including replay and previews. Registered custom worlds still work.

`PixelRenderPolicy` owns both frozen grids and pixel-space dimensions. `PresentingRenderer` supplies that policy to Canvas and Range before drawing and resolves the current world palette before `beginFrame`. Repeating the same effective palette does not invalidate capture or compile another lookup. Product presentation is always pixelated, including stale raw export overrides. Shared internal rendering utilities remain available to the pixel scene.

Pixel captions use a bundled 5×7 bitmap body at integer native coordinates, doubled at Detailed. Names and required credits wrap into at most six lines per page (54 Classic pixels); longer captions page through the existing hold interval using caption-local song time. Required text is never silently truncated or shrunk. Unsupported characters display a readable `[U+XXXX]` spelling; **Landscape details** retains the original names, regions, statistics, ecoregion and credits. It stays visible while open or focused. Captions are drawn after effects and before quantization, in the captured composition.

Illustrated-world glow uses one instantaneous admitted highlight snapshot and four integer neighboring copies, with total strength capped at 0.10 (0.05 with reduced flashing). Alpine glow remains disabled. Heat uses eight-native-pixel cells and integer offsets limited to one Classic pixel or two Detailed pixels, using heard time when available. Reduced motion disables heat and releases its buffers. Title stars retain their seeded layout and transparent backing, with fixed grid clusters and brightness twinkle. Natural effects, Range geometry, materials, forest/water filtering and camera movement are unchanged; the material pilot concluded without a justified shader edit.

Title, playback, live recording and bulk export share the presentation profile. A non-grid pixel output reserves one native-grid working canvas through GraphicsResidency before allocation. Palette processing accepts only a supported native grid and at most 230,400 pixels, never the enlarged output. Selective owns one admitted byte mask (57,600 or 230,400 bytes), computed from the original RGB in the same readback before quantization. Bayer phase is fixed at the grid origin; there is no time term or frame history. Mask admission/commit failure falls back to Ordered for that generation and reports its reason, without retrying every frame. Off, Pixel and RGB332 allocate no edge mask. Scratch surfaces and masks release on grid changes or disposal.

The recorder samples the completed source with smoothing disabled and fits it to its fixed encoded dimensions. A live look/grid/scaling change affects the next completed capture without changing video dimensions. Offline export freezes its session profile and quality. A tainted palette canvas falls back to Pixel and reports that status; it retries only after a new presentation generation.

The 30/60 fps cap controls title and playback drawing independently of simulation. Offline export never treats capture cost as governor pressure. The debug overlay reports requested/effective look and grid, requested/resolved/effective palette, dither style/fallback, generation, policy version, scratch bytes and readback/mask/transform/writeback CPU times. Presentation CPU covers the presentation boundary, excluding scene drawing; these CPU measurements are not GPU time or delivered FPS. Copied graphics reports currently include the older subset of these fields; use the overlay or frame evidence for the new settings and fallback details.

Drawing returns an explicit `presented` result. Capture is nullable until a frame finishes successfully; profile/backing resets, allocation failure, context loss, released buffers and disposal invalidate readiness. Export aborts and discards the partial recording on presentation failure. Live playback keeps its audio/simulation clocks running and reports failures at bounded intervals. A successfully drawn Pixel fallback after palette taint is still a valid frame.

Title and playback keep independent phase-preserving draw deadlines. The playback HUD labels delivered presentation FPS separately from callback FPS; the governor still receives raw callback timing. Integer layout resolves both origin and scale in physical pixels, including the parent's origin and DPR, and applies the logical image dimensions through a transform to avoid CSS layout rounding at fractional DPR.

`npm run test:retro` verifies default Range v2 and explicit legacy, shader/context failures, both-grid checkerboard raster boundaries at four DPRs/eight layouts, meaningful content and temporal changes, exact opaque pre-encode palettes, and export rejection. Live recording/decode needs a running local app server; its optional `v2` argument requests and verifies the actual v2 backend. Lossy decoded frames use stated brightness/coverage tolerances for bars rather than exact palette membership. The bounded pixel browser CI job preserves diagnostic artifacts on failure.

```sh
npm test
npm run lint
npm run test:retro
node tools/palette-bench.mjs
node tools/bulk-export.mjs --help
node tools/serve.js 8091
# In another terminal:
node tools/export-smoke.mjs http://127.0.0.1:8091 .smoke/pixel-export
# Optional production Range v2 recording check:
node tools/export-smoke.mjs http://127.0.0.1:8091 .smoke/pixel-export-v2 v2
```

The bulk CLI supports `--look`, `--quality`, `--palette world|range32|chroma32|rgb332`, `--dither off|subtle|full`, `--dither-mode ordered|selective`, `--pixel-grid classic|detailed` `--pixel-scale depth|original` and `--scaling fit|integer`.

The browser smoke needs installed Playwright Chromium or `PLAYWRIGHT_CHROMIUM_PATH`. Software WebGL validates raster output and shaders; it does not establish device FPS, battery use or GPU timings. `palette-bench` reports warm mask/transform arithmetic at both grids, excluding readback, writeback, copying and GPU work. Detailed is an optional detail choice, with higher cost. Implementation evidence, retained variants and unavailable motion/device checks are recorded in the task report (`docs/superpowers/plans/2026-10-14-pixel-mode-progress.md`, removed; see [removed docs](removed-docs.md)); generated captures stay under ignored `.smoke/pixel-mode/`.

## Physical depth scale

Range v2 reuses its scenic depth buffer and existing color-copy pass. Near terrain uses larger nested pixel cells; far terrain returns to the original cell. Sampling stays aligned to fixed 1×1, 2×2 and 4×4 grids, with broad distance transitions and guards at alpha/depth discontinuities. Alpha coverage is preserved. The effect changes color sampling, not geometry, music timing, weather, or camera motion. It has no temporal history and adds no extra scene draw.

Uniform is an exact shader bypass. Depth attachments belong to scenic targets, so turning sun shafts off at night or on a lower quality rung does not remove depth. Each travel side supplies its own depth/camera. Other worlds and the legacy fallback retain their existing pixel rendering; they do not use a screen-height depth approximation.
