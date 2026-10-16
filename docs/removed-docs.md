# Removed documents

These finished plans, handoffs, progress logs and audit write-ups were
removed from the working tree. Git history keeps them. The last commit that
holds all of them is `f5c09b3` (main, 2026-10-14). Read one without
restoring it:

```sh
git show f5c09b3:docs/superpowers/plans/2026-10-08-teton-song-highway.md
```

Or restore it locally without committing it:

```sh
git checkout f5c09b3 -- audit/master
git restore --staged audit/master
```

| Path | What it was |
| --- | --- |
| `audit/master/` (12 files) | Independent cross-audit and its WP01–WP27 implementation report (#454) |
| `docs/superpowers/plans/` (14 files) | Implementation plans: world identity, Range hierarchy, glacial flight, geodata, audio/Range v2, coherent terrain, landscape performance, revelation, full version picker, Teton highway, visual evaluation loop, Plex, VFX addendum, pixel mode |
| `docs/superpowers/specs/` (7 files) | Design specs paired with those plans |
| `docs/naturalistic-forest-*.md` (7 files) | Forest plan, Phase 0 protocol and Phase 1–5 reports (#435–#444) |
| `docs/teton-tour-handoff.md` | Environment handoff for the paused Teton work (#418) |
| `docs/teton-tour-pr-description.md` | Saved PR text for #418 |
| `docs/ground-catches-light-plan.md` | Legacy Canvas lighting upgrade plan |
| `docs/vertical-ground-seams-plan.md` | Legacy ground-seam diagnosis plan |
| `docs/dancing-ridge-validation.md` | Dancing Ridge fix note; its evidence images were already removed |
| `docs/range-visual-audit.md` | Range visual correction audit (after #329) |
| `docs/graphics/implementation-ledger.md` | Graphics task ledger (2026-09-21 baseline) |
| `docs/visual-review-20432ab.md` | Visual review of `20432ab` |

The version picker's own guide, [version-picker.md](version-picker.md),
stays; only its implementation plan was removed.
