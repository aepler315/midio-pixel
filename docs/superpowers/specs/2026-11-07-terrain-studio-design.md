# Terrain Studio

Turn Viewfinder into a first-class, lazy-loaded app workspace for discovering real terrain and authoring personal cameras. Preserve the existing 642-candidate catalog and review progress. The studio opens inside the app from the title and playback controls.

## Experience

Browse/search/filter regions and review status; inspect the original study immediately; request a real regional terrain preview on demand. Edit geographic position, altitude, bearing, pitch, horizontal field of view, target, and motion. Lock individual values, generate deterministic variations at a chosen strength, and ask the assistant to improve clearance/composition with explicit reasons. Scrub and play the camera motion; compare with the original. Keep/maybe/pass and notes retain their existing semantics.

Named camera presets, drafts, locks, undo/redo, and validated portable import/export belong to the user. Storage failure must be visible. Candidate source signatures prevent old camera drafts silently applying to revised catalog entries. Saving a personal camera never grants production approval.

## Architecture and alternatives

Use browser-native ESM and existing styles/material palettes. Three independent modules handle camera intelligence, project persistence, and bounded terrain acquisition/rendering; the dialog orchestrates them. A worker renders one coarse regional view at a time. The original still remains available during loading/failure. A worker/main-thread fallback supports restricted browsers.

Considered adapting the detailed GPU scenery directly, but its static terrain packages deliberately omit occluded tiles and are unsafe for arbitrary geographic camera changes. Building all regional terrain ahead of time would add substantial downloads and bake work. Chosen approach: bundle 115 bounded coarse regional DEMs from the existing public Terrarium source, lazily load the selected same-origin region, cache two regions, and render honest exploration-quality scenery. The 8.2 MB total bundle covers 641 cameras without cross-site terrain requests; off-region edits can attempt bounded public acquisition. The geographic camera is portable for a future detailed bake.

A selected edited view can play on the app's normal stage with the song clock, using the same coarse renderer and existing output/capture compositor. Returning to automatic scenery restores the normal renderer. The app must clearly label this exploration mode; it does not claim full production weather/trees/water or detailed playback equivalence.

## Commercial boundary

The authoring/project modules remain independent of billing. No actual paywall, price, account system or client-side pretend enforcement is introduced. Future paid server operations (detailed baking, synced projects, jobs/quotas) require authenticated server-side entitlements. Local geographic editing works without account credentials.

## Validation

Behavior tests cover normalization, lock preservation, deterministic randomization, source identity and malformed/oversized imports, bounded terrain planning, stale/cancelled work, and stage/capture integration. Browser checks cover actual discovery/edit/save/import/preview failures, keyboard/modal isolation, desktop and narrow layout. Real device performance and a detailed camera-envelope bake are separate future validation.
