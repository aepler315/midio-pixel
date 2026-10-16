# Evidence archive

New evidence is not committed here (see `AGENTS.md`). Captures belong in
`.smoke/`, in a CI artifact, or attached to a GitHub Release and linked
from the PR.

Two folders stay, because `src/world/terrain/sceneCatalogData.js` cites
them as view provenance:

- `range-v2/`: each view's acceptance captures.
- `terrain-continuation/`: the `reviewPath` of two views.

Every other folder was removed from the working tree; git history keeps
it. The last commit that holds the complete archive is `4952a45` (main,
2026-10-10). Restore a folder locally without committing it:

```sh
git checkout 4952a45 -- docs/evidence/<folder>   # e.g. pixel-repair
git restore --staged docs/evidence/<folder>
```

| Folder | Size | Recorded for |
| --- | --- | --- |
| `teton-tour` | 88 MB | Teton song highway (#418) |
| `pixel-repair` | 53 MB | Pixel/Palette presentation repair (#425) |
| `landscape-performance` | 24 MB | Earlier Range work, last re-added by #367 |
| `pixel-storm-peaks` | 23 MB | Earlier Range work, last re-added by #367 |
| `range-mobile-uniforms` | 11 MB | Mobile shader uniform packing (#426) |
| `range-20260926` | 3.3 MB | Earlier Range work, last re-added by #367 |
| `intentional-effects` | 1.4 MB | Range lens accents (#419) |
| `range-shader-fallback` | 0.6 MB | Shader link fallback (#420) |
| `remove-foreground-ground` | 0.5 MB | Foreground ground bar removal (#421) |
| `dancing-ridge-20260926`, `glacial-valley-flight`, `ridge-refinement` | < 0.2 MB each | Earlier Range work, last re-added by #367 |
