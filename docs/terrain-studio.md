# Terrain Studio

Open **Terrain Studio** on the title screen or **Studio** during playback. The workspace is part of the app; music can continue while you edit.

## Discover and edit

The collection contains 642 entries, of which 641 have an individual geographic camera. Search names, regions, landmarks or biomes, filter your shortlist, and use **Surprise me** within the active filters. The camera-less Teton tour remains visible with editing disabled; use a related Teton viewpoint.

An original still appears immediately. **Enable live terrain** loads the selected region from the same site and renders your actual edited camera. Controls cover geographic eye position, above-ground height, compass heading, pitch, horizontal field of view, geographic target, orbit, forward travel, crane rise, duration and motion amount. Choose compass aiming or target tracking; inactive controls are identified. Authored absolute heights remain intact until an above-ground edit replaces them.

Lock controls to preserve them during changes. **Randomize** evaluates up to 24 deterministic variations at the selected seed and strength. **Improve** looks for visible real terrain subjects and adjusts framing, clearance and travel. Scores and warnings describe sampled coarse geometry. They do not certify canopy, detailed ground or animated terrain clearance.

Scrub the move, play it, or compare the original camera. Built-in Wide, Intimate, Aerial and Calm settings provide starting points. Drafts, locks, named presets, review notes, and shortlist decisions persist locally. Camera edits have independent bounded undo/redo. Import/export provides portable backup and validates source identity; an old camera draft cannot silently attach to a revised catalog entry. Shortlist decisions continue to refer to the original catalog camera.

## Use with a song

**Play this view** selects your edited camera for Landscape playback. If no song is running, close the workspace and choose a song in Landscape. The move spans the heard song duration, so pause/seek/replay follow its clock. Studio's Duration control times the editor's standalone move preview; playback fits that move to the song. **Exit personal view** or **Return to automatic landscapes** restores normal scenery. Trio continues to use its own presentation.

This is exploration terrain: real elevation at coarse regional resolution with Landscape-derived palette and lighting. It has no detailed water masks, trees, production weather or song-reactive land deformation. Original stills and live regional terrain can therefore differ. A future detailed build must bake the complete edited camera envelope before claiming equivalent detail to the authored scenery. Personal projects confer no production approval.

The normal stage compositor displays personal views and supplies captures. Offline exports request synchronous exact-time camera renders; a missing/invalid personal frame fails capture instead of substituting automatic scenery. Interactive views use a worker where available, with a CPU fallback and at most one frame in flight.

## Terrain delivery and performance

`src/assets/studio-terrain/index.json` maps 641 cameras to 115 verified regional DEM files. The complete bundle is 8,199,841 bytes; only the selected region is downloaded on demand, and two grids are retained per preview. The longest regional grid dimension is 193 cells. The original bundle uses Terrarium z8, with the Arctic group at z7 to keep source acquisition bounded. Each grid records source tile hashes, attribution and missing data; all delivered source camera positions have measured ground.

The preview is 320×180. It renders on demand; personal playback requests at most 12.5 camera updates per second while the stage composites at its chosen frame rate. An edited eye moved beyond bundled regional coverage may request a new bounded public Terrarium region. Such requests depend on browser CORS/network access and fail explicitly when unavailable. Normal catalog editing requires no cross-site elevation requests.

Rebuild the bundle with `node tools/build-studio-terrain.mjs`. The builder uses real cached/public elevation tiles, records actual resolution and fails atomically if any region cannot be acquired or the bundle exceeds 12 MiB. It never substitutes procedural terrain.

## Future paid capability

Camera/project persistence, view discovery and terrain rendering are separate modules. They can sit behind a future product capability boundary without tying saved project documents to billing. No accounts, price, checkout or entitlement enforcement have been added. Paid remote builds, sync or quotas require authenticated server-side enforcement; a client-side feature flag would not secure them.

## Verification for this change

- Camera engine, source-bound project storage, terrain decoding/rendering, exact capture, and builder tests pass.
- All 641 camera entries were SHA-verified, decoded and painted through the production CPU preview pipeline: zero errors. Ross Lake, Tetons and Arctic source/edited stills were inspected. This was a Node canvas fallback run, without music or a browser; its timings are not device FPS evidence.
- Sixteen grouped DOM integration checks exercise actual UI controls, bundled live terrain, comparison, presets, locks, import/export, modal isolation and failure/retry/playback handoff.
- Lint and module graph checks pass.
- A full suite run exposed four unrelated failures also reproduced on base `fecd83a`: Cinematic Pixel preference round-trip, terrain fragment uniform budget, the 50 ms shot-planner timing check, and water material sampling. New keyboard/entry-point regressions exposed by that run were fixed and their focused tests pass.
- Real browser desktop/mobile layout, native download behavior, GPU playback and sustained JOYING performance remain unverified: local Chromium cannot create its required Unix socket here, and the cloud browser cannot reach the command environment's localhost service.
