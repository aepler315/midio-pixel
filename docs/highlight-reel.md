# Highlight reel

The filmstrip on the song-complete panel holds up to five frames, one at the
peak of each major change in the picture's color scheme. Code:
`src/render/HighlightReel.js`; capture in `Renderer.draw`; strip in
`renderFilmstrip` (`src/main.js`).

## Regimes

Each regime is a 0..1 curve over heard time, built from the same pure
functions the renderer paints with, so the schedule is known before the song
plays and does not depend on reading pixels back.

| Regime | Label | Curve (source) | Worlds |
| --- | --- | --- | --- |
| `storm` | Storm peak | squall deck amount (`RangeStorm.stormAt`) | Landscape |
| `sunset` | Sunset | setting twilight amount, scaled by clear sky (`DayNight.twilightAt`) | both |
| `night` | Deepest night | night × (1 − twilight) (`DayNight.dayNight`) | both |
| `dawn` | First light | rising twilight amount, scaled by clear sky | both |
| `noon` | High sun | sun altitude, scaled by clear sky | both |
| `lightning` | Lightning | strongest strike, amp × deck amount at its attack | Landscape |
| `clearing` | After the storm | `break01 × (1 − amount)`, the sun through the torn deck | Landscape |
| `warmest` / `coolest` | Warmest / Coolest palette | red-over-blue of the cast palette's sky and silhouette colors, crossfaded by `BiomeSchedule.blendSections` | both, when sections cast contrasting palettes |
| `climax` | Climax | energy (`globalEnergyNorm`) smoothed over ±1 s | both |

Both worlds share the song's sky clock (`songSkyClock`, or the repeating
cycle under 30 s). Only Landscape draws the squall, and only when the Range v2
sky is drawn. Trio has no weather regimes.

## Selection

- Peaks are local maxima with topographic prominence of at least 0.2. A
  curve without that excursion never shows that regime, so it has no frame.
- The peak time is the middle of the hold within 0.01 of the maximum, kept
  between 1.5 s and the finale freeze (`freezeAtMs − FINALE_FREEZE_LEAD_MS`).
  The finale shatter is not a regime and has no frame.
- Score = regime weight × prominence. Selection is greedy by score, with at
  most one frame per regime and at least 5 s between frames. A peak that
  collides may slide inside its hold. Otherwise its regime falls back to its
  next-best peak.
- The schedule is deterministic and cached per simulation. Reached or decided
  peaks survive new analysis and the RidgeMusic handoff. Only the unheard
  future can change.

## Capture

The visible window is half-open in heard time: 1.5 s, or 100 ms for a
lightning strike. A drawn frame inside the window captures unless the finale
freeze, the opening assembly, a scene arrival, awaited terrain or a cut flash
hides the picture. Weather regimes also need the drawn Range sky, and palette
regimes need their settled palette on screen. A window that passes without a
visible frame is recorded as `missed` (no frame drawn) or `rejected` (drawn
but hidden). Seeking back cannot revive it.

The reel has no browser or device acceptance yet. `tools/highlight-reel-smoke.mjs`
runs a headless Trio fixture and writes to an output directory. Keep that
directory under `.smoke/` and never commit it.
