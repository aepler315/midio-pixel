# Evidence archive

These retained files record historical runs and view provenance. Their review
states, measurements and limitations describe the versions captured, not current
development prerequisites; see the [current development policy](../experimental-development.md).
This context also applies to the JSON reports in the retained folders.

Large new captures are normally kept in `.smoke/`, a CI artifact or a GitHub
Release and linked from the PR, keeping source history small. Captures are useful
review evidence when relevant; they are not required before experimentation or
local commits.

Two folders stay, because `src/world/terrain/sceneCatalogData.js` cites
them as view provenance:

- `range-v2/`: each view's acceptance captures.
- `terrain-continuation/`: the `reviewPath` of two views.

The remaining historical folders are in the original Midio-5 repository.
Browse the [evidence archive at the October 10 snapshot](https://github.com/aepler315/Midio-5/tree/4952a459acfa5c24b4b6b7e8013048a70eb01a14/docs/evidence) or restore a folder with a GitHub account that can read Midio-5. From the Midio Pixel checkout, for example:

```sh
git fetch --no-tags https://github.com/aepler315/Midio-5.git 4952a459acfa5c24b4b6b7e8013048a70eb01a14
git restore --source=FETCH_HEAD --worktree -- docs/evidence/pixel-repair
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
