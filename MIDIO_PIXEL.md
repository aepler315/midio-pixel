# Midio Pixel

An experimental music visualizer developed independently from Midio-5. Current
development follows [AGENTS.md](AGENTS.md) and
[experimental development](docs/experimental-development.md). The bootstrap
choices below are provenance, not permanent limits on renderers, features,
worlds, appearance or defaults.

## Origin

Source baseline: `aepler315/Midio-5` at
`e53db1e0663ce0f8db6d9d89d168dc6d6dbdb308`, tree
`3d4ca45c9d38b8bb7a26a2ce851e72dbb259df8b`.

The initial copy reconstructed 1,431 source files and verified their original
Git blob hashes. This repository's development does not edit the upstream
repository.

## Current implementation

Landscape and Trio share audio analysis and playback. Landscape combines
pixel terrain with smooth skies, water and effects, and includes experimental
terrain and presentation paths. Display preferences currently default to
Pixel / Classic / Auto / Fit / Uniform. Older Depth preferences migrate to
Uniform; the previous depth-pixel effect is removed.

See the [README](Readme.md), [display controls](docs/pixel-presentation.md) and
[validation records](docs/pixel-validation.md). Those records describe checks
at their recorded revisions. Pages serves the `gh-pages` branch, published
with `npm run publish:site` using the staged site.
