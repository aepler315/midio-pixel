# Midio Pixel

Pixel-only evolution of Midio-5. Source baseline: `aepler315/Midio-5` at `e53db1e0663ce0f8db6d9d89d168dc6d6dbdb308`, tree `3d4ca45c9d38b8bb7a26a2ce851e72dbb259df8b`.

All 1,431 source files were reconstructed and verified against their original Git blob hashes before development. The original repository was not changed.

The app preserves the existing audio, worlds, terrain, lighting, weather, reflections, palettes and export sizes. It defaults to Pixel / Classic / Auto / Depth. Depth uses physical camera distance to blend between nested 1×, 2× and 4× cells in Range v2 terrain. Uniform retains the original pixel sampling; existing saved choices migrate to Uniform. Other worlds and the legacy fallback retain their existing pixel rendering.

See [display controls](docs/pixel-presentation.md) and [validation results](docs/pixel-validation.md). Pages serves the `gh-pages` branch, published manually with `npm run publish:site` (staged site only).
