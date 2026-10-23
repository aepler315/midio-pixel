# Climax weather

`RangeStorm` selects the loudest measured section, or the strongest sustained window when structural sections are unavailable. Heard time drives the cloud approach, distant rain, snare-lit cloud interior, clearing and wet-land response. Percussion role/channel and GM snare pitch both qualify a flash; a 700 ms spacing limit prevents clusters. No measurements means no invented climax.

The same weather snapshot reaches the sky backdrop, celestial receiver light, water glints, gust amplitudes, wet ground and solar scattering. The clearing strengthens shafts from the actual visible sun; it never creates a light source at night.

The cast no longer peak. Their giant figures (Midio's mirrored sheet, Broshi's shadow, Midasus's cloud) and the outline gathering are removed. What the three lanterns do in each view now follows song structure: see [landscape-cast.md](landscape-cast.md). `biomes.castProgressOverride` holds a view's job progress for review; `stormOverride` still supports weather review.

Reproduce frames with `npm run test:peaks`, which now renders each view's cast job at progress 0.3, 0.7 and 1 (`EVIDENCE_PROGRESS`). Its `before` mode serves the alpine render modules from commit `96908d0`, where the progress override does nothing. The evidence records seed, heard time, actual quality/view and mirror availability.
