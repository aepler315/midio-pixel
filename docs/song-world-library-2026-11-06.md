# Song scenery matching and library worlds

Base: `93e4f3c69b130c30c883107e059c8ee4ca6ac744` (PR #96 merged).

## Result

Normal Landscape selection now derives a repeatable home/view plan from the
song's musical identity. Library rows and the recent-song chips display that
same home, such as `World: Crater Lake`. Songs without analyzed identity say
`World: play to discover`; this change does not scan/decode an entire library.
The label describes the assigned Landscape home. Trio is a separate playback
experience, and explicit diagnostic/camera-tour overrides can still select
another scene. It is not a list of every chapter a song will visit.

The compact world record is learned from the exact identity profile/seed used
by the world chooser, including a cached opening identity when later whole-song
analysis differs. It contains five musical watch values, the seed and format/
profile versions. It contains no audio, terrain data or giant analysis object.
Descriptions use the current catalog/matcher and are cached for row reuse.
Records survive reloads and unchanged rescans; changed file size/mtime clears
them. Storage failure retains a marked session value. Root/key/size/mtime guards
protect writes, and the audio loader also checks the originating root object
through analysis. Plex/local selections cannot credit an old library row.

The world stays visible in narrow-screen rows. Folder/song row recycling clears
stale labels, experimental/pending styles and tooltips; mouse and keyboard
activation continue to play the current song. Recent chips use the same labels.

## Matching changes

- Matching version **2** is separate from terrain catalog version **57** and
  artistic approval. Terrain packages, eligibility and approval hashes remain
  unchanged.
- Normal song planning omits transient recent-view history. Listening to another
  track cannot reshuffle this song on its next play. Biome tickets derive from
  stable biome names, so candidate ordering cannot reshuffle assignments.
  Algorithm/catalog updates can intentionally change a previous assignment;
  subsequent plays use the new deterministic result.
- Explicit variety draws still accept view/region history and avoid repeats.
  Their character coordinates come from the complete biome pool, so removing
  a recent view does not redefine the other views' musical character.
- Scenic rank coordinates contract toward neutral when an axis has little
  measured variation: `0.5 + (rank - 0.5) * min(1, span / 0.25)`. A quarter of
  the fixed character scale supplies full rank contrast. This is a documented
  heuristic, not a learned aesthetic model. It keeps the 15% fair-share floor.
- The shared planner validates/indexes each immutable catalog revision once.
  Labels perform no terrain downloads, decoding or GPU work. Home-biome and
  legacy ridge matching policies remain separate.

## Measurements

These controlled comparisons isolate a grandeur-heavy target while its other
axes stay at the midpoint. They measure selection probabilities, not artistic
quality of a rendered song.

| Biome and measured grandeur | Before | After |
| --- | --- | --- |
| Black Mountains .066 / Shenandoah .069 | 7.66% / 92.34% | 48.41% / 51.59% |
| Denali .733 / Chugach .394 | 92.34% / 7.66% | 92.34% / 7.66% |

A local Node 24 CPU check over the existing 16-profile evaluation corpus compared
500 three-biome assignments per batch, after warmup, three runs:

| Selector path | Batch timings | Median |
| --- | --- | --- |
| Base assignment with repeated validation | 1509.98 / 1465.83 / 1442.30 ms | 1465.83 ms |
| Compiled assignment | 8.56 / 9.13 / 9.27 ms | 9.13 ms |

This is CPU planning cost. It is not a GPU, startup, frame-rate or physical
JOYING benchmark. In 10,000 comparisons across the 16 profiles, compact-record
labels and full-profile plans had **zero home-view mismatches**. These checks
are recorded in `.smoke/song-world-matching-evaluation.json`.

## Verification

- **283 tests passed, zero failures**: 269 matching/library/audio/chooser tests
  plus 14 shot-catalog compatibility tests. Relevant logs are
  `.smoke/song-world-final-tests.log` and `.smoke/song-world-shot-catalog.log`.
- ESLint, the **515-module** parse/link check and whitespace checks pass.
- Independent code review found shared-region ordering and stale-source/root
  metadata races. These were fixed and covered by passing regression tests;
  the final review reported no remaining findings.
- The whole repository suite was not rerun for this focused data/UI change.
  The previously recorded planner timing gate remains a separate baseline issue.
- Browser layout/playback capture could not run: Chromium launch is blocked by
  the environment's socket restriction. DOM tests exercise production pooled
  rows and actual main-function wiring, but do not establish visual layout or
  physical head-unit results. JOYING JY-UTS18N12 remains the performance target;
  this change adds no terrain rendering pass or GPU asset allocation.

Reproduce the focused coverage:

```sh
node --test --test-concurrency=1 test/sceneCatalog.test.js test/songWorld.test.js \
  test/librarySongWorldMain.test.mjs test/libraryPanelWorld.test.js \
  test/libraryDb.test.js test/musicLibrary.test.js test/libraryScanner.test.js \
  test/trackIndex.test.js test/continuousPlaybackMain.test.mjs \
  test/audioLoadLifecycle.test.js test/audioSessionIdentity.test.js \
  test/analysisBundle.test.js test/songProfile.test.js test/profileTravel.test.js \
  test/rangeBasket.test.js test/experimentalScenes.test.mjs test/worldChooser.test.js \
  test/shotCatalog.test.mjs
```
