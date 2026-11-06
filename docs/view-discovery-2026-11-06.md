# Viewfinder: broad, inexpensive terrain discovery

Viewfinder separates choosing a promising composition from building production
scenery. It offers one sequential queue, with Keep / Maybe / Pass, notes,
Previous / Next, keyboard controls, undo, filtering, comparison and portable
review files. A Keep is a shortlist decision for later terrain/camera work.

Open **Scout landscape views** on the app's start screen, or run `npm start`
and visit `http://localhost:8080/src/dev/view-discovery.html`.

The private standalone reviewer is at
<https://midio-view-scout.aepler315.chatgpt.site>.

## What enters the queue

The initial collection has 642 entries:

| Kind | Count | Treatment |
| --- | ---: | --- |
| Current authored examples | 20 | Approved or explicitly experimental scenes; used for comparison |
| Saved computed cameras | 262 | Every camera from the existing 88-range Ridgeview snapshot, including low scores |
| Broad new angles | 352 | Four fixed bearings per range, varying distance and height; no scenic score rejection |
| Historical authored leads | 8 | Rejected or unfinished records retained with accurate labels; excluded from the reference pool |

One existing Teton tour has no single reference camera, so its card explains
why no still is available. The other 641 entries have actual elevation-derived
previews. A broad range of weak, obstructed and unconventional compositions is
intentional: the user makes the aesthetic decision.

Candidates are interleaved across geographic ranges. The full scenic production
scorer, its summit-visibility checks, and its movement/connection searches are
absent from this discovery step. The older global discovery rules—minimum
relief, confident range-name matching, large spacing and exclusion around
existing locations—are not applied to this queue.

## Why it costs less

The old Ridgeview finder tests 36 bearings × 6 radii × 4 heights, then refines
eight seeds with repeated local searches. The saved Tetons record reports
2,352 evaluated eyes. Full scenic-tour construction additionally evaluates
motion, terrain footprints, baked packages, production frames and links.

The new builder reuses existing camera records and generates four deterministic
positions per range. It downloads coarse tiles once, shares them across nearby
cameras, and renders 320×180 stills directly on the CPU. The review page loads
only the selected preview and a requested comparison. There is no WebGL setup,
terrain mesh, forest, audio analysis, live ray marching or background camera
animation in the reviewer.

Each camera has two stills. **Landscape** is the default: current material
palettes, elevation/slope snow/vegetation/rock rules, Range sky colors, celestial
light color and Cinematic lighting/air/grade helpers. **Terrain shape** keeps the
original neutral rendering for checking composition. Both share the exact DEM
geometry, camera and coverage; switching modes does not move the camera.

Computed cameras use the current runtime's eleven-biome classification. This
corrects 21 ranges whose older Ridgeview classifications were less specific,
including Colorado Plateau canyon colors and coastal rainforest greens.
Authored scenes retain their material and rule overrides. Material JSON hashes,
the original/resolved biomes, overrides and both image hashes are recorded.

Lighting is a consistent front-side daylight study. Its reduced light budget
and preview exposure retain color and relief without the production renderer's
normal maps and cast shadows. This is a production-derived appearance estimate,
not a screenshot from full playback. Vegetation and snow are procedural surface
colors; they are not surveyed cover or added tree geometry.

Default terrain is Terrarium z9 resampled to a 250 m grid. A 64-tile regional
cap switches Arctic Cordillera to z8 with a visible explanation. Fetches have
bounded concurrency, size, timeout and decoded PNG dimensions; failed sources
remain explicit unavailable cards. Cached tiles carry hashes in the catalog.

Previews are PNGs in small, content-addressed JSON payloads. This permits batched
source publication while keeping per-view lazy loading. The catalog is replaced
atomically. Review signatures bind the camera, source identity and image bytes,
so a changed preview cannot silently inherit an old decision.

## Review and handoff

- **Keep / Maybe / Pass** advances through the current selection. **Undo**
  restores the previous decision and position.
- Arrow keys navigate; **K**, **M** and **P** rate a candidate. Typing a note
  does not trigger shortcuts.
- **Compare with existing scene** uses the nearest current reference in the
  same biome when available. Rating is disabled until returning to the candidate.
- **Landscape / Terrain shape** applies to both candidates and comparisons,
  and the preference survives reload and review import.
- Decisions and notes stay in this browser. **Export review** saves a portable
  copy; **Import review** restores valid decisions, filters and position.
  Changed-preview decisions are visibly marked outdated, kept recoverable in
  exports and excluded from the active shortlist.
- **Download shortlist** exports kept/maybe candidates with exact geographic
  camera records, source provenance and notes for detailed authoring.

Nothing is automatically added to song selection or marked production-approved.
The runtime renderer, single-stage path, JOYING JY-UTS18N12 budgets and existing
terrain packages are unchanged.

## Regeneration

```sh
npm run scout:views
# Smaller experiment; explicit output prevents replacing the main queue.
npm run scout:views -- --only tetons,book-cliffs,selkirk-mountains --out .smoke/scout-sample
# Cheapest first look, accepting visibly rounder terrain.
npm run scout:views -- --zoom 8 --cell 500 --out .smoke/scout-fast
```

Existing tiles are reused. New source data, edited camera inputs and different
grid settings intentionally change review signatures. Generation does not alter
the runtime scene catalog or its approval fields.

## Evidence and limits

The initial z8/500 m sample visibly rounded the Tetons, so the default moved to
z9/250 m after a same-camera comparison. The sharper sample took 6.534 seconds
for 24 previews, including 35 tile requests / 2,805,880 bytes; CPU rendering was
210 ms. These timings measure this development machine and network.

The first broad acquisition took 35.894 seconds and downloaded 51,276,799 bytes
across 689 requests, with sample tiles already cached. It exposed seven Arctic
previews exceeding the original tile cap. The bounded z8 fallback resolved those
failures. A subsequent complete build took 26.731 seconds, including 5.839 seconds
of CPU rendering, with 851 disk-cache hits and 25 additional downloads.
This is not a clean-cache comparison with the old production builder.

The finished content-addressed pack rebuilt in **20.686 seconds**, including
**4.580 seconds of CPU rendering**, with **zero network downloads**. It contains
641 ready previews and one explicitly unsupported tour reference, with zero
acquisition/render failures. Catalog plus image payloads total **9,649,484 bytes**
before HTTP compression; the page fetches individual previews on demand.
Adding landmark search metadata brought the final source pack to **9,667,447
bytes**; its cached regeneration took 19.451 seconds, with 4.590 seconds of CPU
rendering and zero downloads. The image bytes and review signatures stayed the same.

Coarse previews show terrain shape, obstruction, depth, approximate framing and
a material/lighting estimate. They omit water classification, tree geometry,
fine material maps, cast shadows, weather and motion; small cliffs and sharp
summits can disappear or become rounded. The heightfield
column projection is approximate at large camera pitch. Saved camera AGL is
reapplied to coarse ground, with the original camera retained in provenance.
These images do not establish a production-ready view or physical head-unit
performance. Detailed builds and real rendering review follow the shortlist.

Initial gray-preview validation: **77 focused tests pass**, including generator, projection,
delivery, persistent decisions, import/export, real page event handlers, stale
preview requests and browser-native fetch receiver behavior. ESLint passes,
515 source modules parse/link, site staging passes and whitespace checks pass.
Independent review findings were fixed, including partial-build replacement,
bounded PNG decoding, imported review position and historical reference labels.

Browser inspection in cloud Chromium covered desktop layout at 1348×926 and a
390×844 embedded mobile viewport: actual final preview loading, landmark search,
Keep/advance, Undo, reload persistence and reference comparison. This exposed
and verified a fix for the browser's native fetch receiver requirement that
Node's fetch implementation did not reproduce. Final desktop and mobile controls
and actual Rainier terrain were observed. The mobile viewport is browser layout
evidence, not a physical phone/head-unit measurement. Full application playback,
the full repository suite and physical JOYING performance were not rerun.


## Appearance refinement validation

The completed dual-mode collection contains **641 Landscape/Terrain shape
pairs**, one explicitly unsupported tour and no acquisition/render failures.
A final cached regeneration took **50.492 seconds**, including **33.758 seconds
of CPU rendering**, with **zero network requests/downloads**. These timings
cover both previews. A prior run during concurrent development took 85.632
seconds; these are development-machine build timings, not stable device
benchmarks or playback frame rates.

All **641 original neutral PNGs remain byte-identical**. Verified all 1,282 PNG
hashes/dimensions, full candidate signatures, current material hashes and updated
reference selections. The catalog plus preview JSON payloads total **21,803,117
bytes** before HTTP compression; each image remains loaded only on demand.

Final validation: **93 focused tests pass**, ESLint passes, **515 source modules
parse/link**, site staging and whitespace checks pass. Independent review found
and resolved an actual generator/UI appearance-field mismatch; a regression now
feeds real generated catalog/PNG records through the UI. The viewer verifies
SHA-256 image bytes before displaying/caching them, so a mismatched response
cannot silently be reviewed under another preview's identity.

Cloud Chromium validation at 1348×926 and an embedded 390×844 mobile viewport
confirmed the Landscape image, same-camera shape toggle, reload persistence,
matching comparison mode, disabled comparison ratings, current canyon labels,
and visible phone review controls. Pixel-preserving image scaling avoids
blurring the small stills. [Browser evidence](evidence/view-discovery/landscape-preview.png).
Physical JOYING performance and full application playback remain untested;
these tooling changes introduce no new runtime rendering stage or GPU work.

The user explicitly approved publishing this source/assets payload to
aepler315/midio-pixel and opening a separate Viewfinder PR on 2026-11-06.
The existing private reviewer is updated separately without changing its
audience. This publication does not merge the unrelated song-world PR #97.
