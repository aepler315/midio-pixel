# Repeatable song scenery and library world labels

## Goal and approach

Refine song-to-view matching and show each library song's Landscape home.
Normal planning will be a cheap deterministic operation shared by playback and
library labels. File analysis remains demand-driven; an unanalysed song says
"World: play to discover". Requested experiments are authorized by the current
user task and repository policy.

Transient recency currently reassigns the same song and re-ranks the remaining
views. Persisting only the last drawn label would disguise that inconsistency.
Instead, normal planning uses seed/profile identity, stable biome salts and one
validated catalog index. Deliberate recency-aware draws remain an explicit API.
The scenic lottery keeps its 15% floor and tempers rank separation on axes with
little measured physical contrast. Range/home-biome policies are separate.

Library records store only versioned seed + five finite musical watch values,
tied to the file's root/key/size/mtime. Labels resolve through the same current
planner. This avoids terrain loads, GPU work, whole-library audio analysis and
stale hardcoded labels when a catalog version changes. A changed file loses its
old record; missing storage keeps usable session metadata.

## Implementation

- [x] Add failing selector cases for tiny/large contrast, full-pool recency
  coordinates, biome-order independence and repeated song planning.
- [x] Refine SceneCatalog, introduce matching version 2 and a validated planner;
  add shared pure SongScenePlan and use it from RangeLibrary without transient
  scenic history. Keep legacy ridge recency independent.
- [x] Add compact SongWorld records, validation, memoized current-catalog labels,
  and analysis-to-library lifecycle wiring guarded against stale selections.
- [x] Persist metadata safely in LibraryDB/MusicLibrary; invalidate it when a
  recording changes and cover reload, rescan, races and storage failure.
- [x] Add world labels to pooled library rows with responsive layout; clear
  stale data on reuse and test row updates and activation.
- [x] Compare representative selection odds and CPU assignment cost, run focused
  tests/lint/module/staging checks, obtain independent review and fix findings.
- [x] Publish a reviewable branch/PR and report observed checks separately from
  unavailable browser/physical-device results.

## Review focus

1. The library and playback must select identical home scenery from the same
   identity; unrelated listening and biome ordering must not reshuffle it.
2. Tiny terrain-score noise must not imply an extreme musical preference.
3. Late analysis/storage from an old file or folder must not relabel its
   replacement, including same-path files changed during a rescan.
4. Old/unanalysed tracks remain playable; an absent world is explicit.
5. Large folders must not trigger audio/terrain fetches or repeated catalog
   validation for every row render, and mobile rows must retain their world.

## Evidence

See [implementation and measured validation](../../song-world-library-2026-11-06.md).
The final focused run passes; the full suite and physical/browser checks are
reported separately. Independent review findings were fixed and rechecked.
