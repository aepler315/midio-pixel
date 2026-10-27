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
| `sunset` | Sunset (Landscape), Dusk (Trio) | Landscape: setting twilight amount, scaled by clear sky (`DayNight.twilightAt`). Trio: dayNight's indigo dusk wash (`duskAlpha`) | both |
| `night` | Deepest night | night with the sun down; Landscape also × (1 − twilight) (`DayNight.dayNight`) | both |
| `dawn` | First light | Landscape: rising twilight amount, scaled by clear sky. Trio: dayNight's peach dawn wash (`dawnAlpha`) | both |
| `noon` | High sun | sun altitude, scaled by clear sky | both |
| `lightning` | Lightning | strongest strike, amp × deck amount at its attack | Landscape |
| `clearing` | After the storm | `break01 × (1 − amount)`, the sun through the torn deck | Landscape |
| `warmest` / `coolest` | Warmest / Coolest palette | red-over-blue of the cast palette's sky and silhouette colors, crossfaded by `BiomeSchedule.blendSections` | Landscape, when sections cast contrasting palettes |
| `climax` | Climax | energy (`globalEnergyNorm`) smoothed over ±1 s | both |

Both worlds share the song's sky clock (`songSkyClock`, or the repeating
cycle under 30 s), but paint sunrise and sunset differently: Landscape's Range
sky paints `twilightAt`, Trio paints only dayNight's dawn and dusk washes, so
each world's dawn and dusk curves follow what it paints. Only Landscape draws
the squall, and only when the Range v2 sky is drawn. Trio has no weather
regimes, and no palette regimes either: it hue-rotates every palette color by
the live key (One Spectrum), which is not known before the song plays.

## Selection

- Peaks are local maxima with topographic prominence of at least 0.2. A
  curve without that excursion never shows that regime, so it has no frame.
- A palette peak is narrowed to the longest stretch of its hold where that
  one palette is fully on screen (no crossfade or travel), and dropped when
  that stretch is shorter than a window.
- The peak time is the middle of the hold within 0.01 of the maximum, kept
  between 1.5 s and the finale freeze (`freezeAtMs − FINALE_FREEZE_LEAD_MS`).
  The finale shatter is not a regime and has no frame.
- Score = regime weight × prominence. Selection is greedy by score, with at
  most one frame per regime and at least 5 s between frames. A peak that
  collides may slide inside its hold. Otherwise its regime falls back to its
  next-best peak.
- The schedule is deterministic and cached per simulation, and each regime
  group (sky, squall, palettes, climax) is cached under the evidence it reads,
  so new lyric sections re-read only the palettes. Reached or decided peaks
  survive new analysis and the RidgeMusic handoff. Only the unheard future can
  change.
- The pool's unselected peaks are kept as standbys, best first.

## Capture

The visible window is half-open in heard time: 1.5 s, or 100 ms for a
lightning strike. A drawn frame inside the window captures unless the finale
freeze, the opening assembly, a scene arrival, awaited terrain or a cut flash
hides the picture. Weather regimes also need the drawn Range sky, and palette
regimes need their settled palette on screen. A window that passes without a
visible frame is recorded as `missed` (no frame drawn) or `rejected` (drawn
but hidden). Seeking back cannot revive it. A lost peak keeps its record but
frees its slot: the best standby whose window is still ahead and that fits
the plan (one live frame per regime, 5 s apart) takes it. This matters most
for the opening night, which often falls while Landscape's terrain is still
loading. Once five frames are taken the renderer stops consulting the reel.

## Saving at 4K

The strip keeps 320×180 JPEG thumbnails. Saving a frame draws that moment
again at 3840×2160 and saves it as a lossless PNG: the modal's
**Save 3840×2160 PNG** button saves the open frame, **Save all in 4K** under
the strip saves every frame, and **Thumbnail** still downloads the JPEG.
Code: `src/ui/ReelExport.js` (pure: plan, size ladder, stepping chunks, file
names, the report) and `saveReelFrames` in `src/main.js`.

- **What a frame records.** `HighlightReel.capture` stores `moment` on each
  frame: its heard time (`atMs`), the run's `songSeed` and `worldId`, the
  player's display preferences (`displayPrefs`, including the pixel grid)
  and the quality floor they chose (`qualityLevel`). main.js supplies them
  through `highlightReel.describeMoment`. A frame without `moment` keeps its
  thumbnail but cannot be redrawn, and the save says so.
- **How the moment is drawn again.** When the COMPLETE panel shows, the
  live sim has played through the finale and cannot go back. The save
  rebuilds the song the way a bulk export does (`beginBulkExport`: same
  seed, world, display preferences, decoded audio and chapter plan), steps
  it from 0 with `stepExportClock` (in 2 s chunks, yielding to the page
  between them, which takes the same fixed steps as one run), draws the last
  six 60 fps frames before the instant so motion blur and echo have their
  history, and draws again after `rangePresentation.settle()` as bulk export
  does. Frames sharing a run and look are drawn in one rebuild, in song
  order. Each rebuild draws with Fit scaling, so every pixel grid fills the
  frame.
- **When.** Only from the COMPLETE panel, after the song and any recording
  have finished. Nothing is playing, so the save cannot cause a playback
  hitch. The panel's buttons wait while it runs, and a second save is
  refused while one is running. A new song, Title or replay cancels it.
- **Size limits.** If the stage cannot be armed at 3840×2160, the frame
  does not finish drawing, or the PNG cannot be encoded, the save tries
  2560×1440 and then 1920×1080. The file name and a banner give the size
  actually saved. Nothing is upscaled or relabeled.
- **File name.** `midio_<song>_<regime>_<mmss>_<W>x<H>.png`, for example
  `midio_heroes_sunset_0307_3840x2160.png`.
- **Afterwards.** The rebuild is torn down, and the COMPLETE panel, world,
  seed, pause state, audio level and display presentation are restored.
  `window.__SMW` still names the torn-down rebuild until the next song
  starts.
- **What can differ from the thumbnail.** The redraw is the song's
  deterministic performance at that heard time, the frame a bulk export
  draws. It does not replay live-only input: the listener's zoom, beat taps
  and pointer, or a groove fingerprint changed during the song. It also
  draws at the quality floor the player chose, not at a level the
  performance governor shed to. A song that ended on its opening analysis
  alone cannot be redrawn until the whole analysis has landed, and
  `beginBulkExport` reports that.

The reel has no browser or device acceptance yet. `tools/highlight-reel-smoke.mjs`
runs a headless Trio fixture and writes to an output directory. Keep that
directory under `.smoke/` and never commit it.
