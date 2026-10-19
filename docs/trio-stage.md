# Trio Stage

Display > Experience selects Landscape (default) or Trio Stage. The experience
preference is independent of the world and pixel profile. `?experience=trio`
overrides the saved choice for that visit. Pixel/Palette, Classic/Detailed,
Auto/Economy and Fit/Integer continue to work. Stage uses uniform sampling;
Landscape's saved depth choice remains available on return.

The pre-real-terrain Midio-5 implementation at commit
3b64b7652813071b5984562a50a4501b0f56a654 supplies the platform/trio reference.
Maintained Midio, Broshi, Midasus, JumpController, MidioPerformer and
EnsembleDirector modules supply the choreography. TrioPerformance owns their
private conductor and lifecycle; no score keeper, tap judge, obstacles or failure
state are constructed. Shared Simulation continues to own the actual audio clock.

Midio's jumps use real kick times, with bounded lead-accent air jumps. Broshi's
body follows its cast bass lane (or bass-role events), and Midasus follows the
clean lane (or sufficiently confident melody). Missing lanes stay restrained.
Flourishes are sparse energy transitions; silence keeps small idle movement.
No voyage or burrow is triggered in this first stage release.

Ground samples used by both grounded performers also draw the continuous
platform. The camera stays fixed; distant procedural silhouettes and platform
seams provide scrolling. Reduced motion damps parallax and character travel;
reduced flash preserves the existing restrained character rendering.

Entering Stage constructs its performance at current heard time before releasing
Range graphics. Returning to Landscape prepares the existing song's views while
the trio continues, then releases actor listeners and switches the presentation.
The Simulation, Conductor, AudioEngine and current audio source remain the same;
recording and pause state continue. A replacement song cancels an obsolete switch.

Destination reconstruction primes musical motion history and warms six seconds
of companion physics. It clears effects from the discarded future. Repeated
destination reconstruction is deterministic; it is not a claim that every spring,
particle or random flourish matches an uninterrupted full-song replay byte for
byte. Repeated paused draws do match.

Chooser previews carry the experience and pixel profile. Bulk export accepts
`--experience landscape|trio`; the default is Landscape:

```sh
npm run export:bulk -- --experience trio --res 1080 --fps 30 --out exports song.wav
```

`npm run test:trio -- http://127.0.0.1:8080` tests real upload/analysis, both grids,
Pixel/Palette, paused draw parity, stage previews, live/paused switches and retained
resource counts. It also rejects terrain/tour/material requests in Stage. The
extended manual browser workflow runs it; captures remain outside Git.
