# Cheap view discovery implementation plan

**Goal:** Let Ashton review a much broader set of real scenic possibilities from one sequential queue, before paying for detailed terrain and camera builds.

**Architecture:** Reuse the 262 calculated cameras across 88 existing geographic ranges, add four inexpensive exploratory angles per range, and include current authored scenes as examples. Render small stills from cached coarse elevation once. A standalone static reviewer displays only the selected image and optional reference, stores decisions locally and exports exact camera selections.

**Decision:** Use coarse CPU terrain stills. Reusing the full renderer would retain terrain baking and shader/mesh setup before review; merely loosening the existing scorer would retain its thousands of eye evaluations. The user requested broad discovery with much less selectivity, so aesthetic scores do not exclude candidates here. Source validity and honest coverage remain necessary.

**Scope:** This is discovery tooling. A Keep decision means a promising view for a later detailed build, without changing runtime admission, song selection, JOYING budgets or the single-stage rendering path. Existing PR #97 remains separate and unmerged.

## Interfaces

- `tools/lib/scout-preview.mjs`: bounded deterministic CPU preview over north-up real DEM arrays; no browser or GPU.
- `tools/lib/view-discovery.mjs`: pure reference/computed/exploratory candidate enumeration, stable identity and interleaving.
- `tools/build-view-discovery.mjs`: bounded cached coarse tile acquisition, small PNG generation and provenance catalog under `src/assets/view-discovery/`.
- `src/dev/view-discovery.html` and `src/dev/view-discovery/`: sequential mobile/desktop reviewer, filters, compare, persistent verdicts, notes and validated export/import.
- App entry and npm script make the workflow discoverable; documentation records cost, source detail and limitations.

## Review focus

- Missing terrain and below-ground cameras must be visible warnings, never fabricated flat ground.
- Changed cameras/data must invalidate old verdicts; untrusted imports must not inject markup or unrelated decisions.
- Filtering out a just-reviewed entry must advance to the immediate next entry, and Undo must restore it.
- Generation must bound tile counts, memory, concurrency and retries; failures must remain visible.
- Both static staging and a portable review export must resolve their own assets without unpublished source paths.

## Tasks

- [x] Test and implement deterministic coarse preview projection, coverage and input limits.
- [x] Test and implement broad enumeration and bounded cached acquisition; generate the initial queue.
- [x] Test and implement the central reviewer with signature-bound persistence/export/import.
- [x] Add entry points and usage/evidence documentation.
- [x] Inspect representative real previews, run focused tests/lint/module/staging checks, obtain independent review and resolve findings.
- [ ] Publish a separate reviewable branch/PR; do not retry the previously blocked PR #97 merge.

## Appearance preview refinement

The user requested previews that show what the views might actually look like.
Default to a daylight appearance study using the current Landscape's material
palettes, elevation/slope habitat rules, sky, lighting and atmosphere helpers.
Retain the exact coarse DEM silhouette and a Terrain shape toggle. Render both
once during generation; no live GPU work is added to the reviewer or playback.

- [x] Implement production-derived material shading and unchanged neutral output.
- [x] Generate both preview modes and bind image/material evidence to review identity.
- [x] Add a persistent mode selector and recoverable outdated review notices.
- [x] Inspect representative colors/relief and regenerate the complete collection.
- [x] Verify image delivery, browser controls and independent review findings.
- [x] Update the existing private Viewfinder site.

The user explicitly approved publishing this payload to aepler315/midio-pixel
and opening its PR on 2026-11-06, resolving the earlier automatic approval
review block. Publish this scoped branch separately from PR #97.
