# Midio Pixel

An independent, private copy of [Midio-5](https://github.com/aepler315/Midio-5), pinned at `e53db1e0663ce0f8db6d9d89d168dc6d6dbdb308`. All source assets, worlds, audio integrations and modern rendering systems are preserved. The original project is unchanged.

**Pixel only:** Pixel and Palette looks, Classic and Detailed grids, Auto quality, Fit/Integer scaling, and Uniform pixel sampling. Saved Depth selections migrate to Uniform; the current renderer has no Depth pixel effect. Existing saved display choices migrate without changing Midio-5 settings. Other worlds retain their existing pixel rendering.

Hosting needs reconciliation: the repository still carries its inherited CNAME and the observed Pages path is a dynamic Jekyll branch build. The staged manual workflow and the current limits are documented in [the validation matrix](docs/test-matrix.md).

Drop a song and watch The Range carry the music. Midio Pixel is a
browser music visualizer with moving landscapes and musical effects. Your
original recording supplies the sound; its analysed rhythm, pitch, energy,
and structure drive the scenery. **Play a sample** starts the authored song
*Proof*, performed live by the built-in synth.

The default experience is **Landscape**, showing **The Range**, with no world chooser. Choose **Trio Stage** in Display for Midio, Broshi and Midasus performing automatically on a scrolling platform. Midio jumps to rhythmic accents, Broshi follows the bass, and Midasus follows confident melodic notes. Experience changes keep the current song and playhead; the choice is remembered independently of display preferences. `?experience=trio` opens the stage directly.

Add
`?worlds=all` to explore the eight registered landscape styles
and their shared quiet/peak previews. The current landscapes have no
performer cast. Trio Stage and Landscape both use Uniform pixel scaling.

The root app uses plain JavaScript modules and Web Audio, with Canvas 2D
composition and **Range v2** WebGL2 scenery. If that scenery cannot load or
WebGL2 is unavailable, painted Range scenery keeps playback running. There
is no frontend build step for this app.

## Run locally

Use Node.js 24.x (the supported root toolchain, also used in CI) and npm:

```sh
npm ci
npm start
```

Root development and validation target native Node.js 24.x. Other major versions
are outside the tested root contract; npm's engines warning is not a runtime
preflight. Ridgeview retains its separate package contract in
[`ridgeview/package.json`](ridgeview/package.json).

Open [localhost:8080](http://localhost:8080). The server binds to
`127.0.0.1` by default. Set `HOST=0.0.0.0` only when you intentionally need
LAN access, or set `PORT` to change the port.

1. Drop an audio file anywhere on the page, choose **Browse files**, or
   pick a music folder once and play from your library (see below).
   The picker accepts MP3, WAV, FLAC, OGG, M4A, AAC, and other audio formats
   your browser can decode.
2. Wait while the recording is pulled apart: frequency bands, onsets,
   tempo, pitch, and section structure become one song profile.
3. The song starts in **The Range**. With `?worlds=all`, you can choose a
   world before loading, or preview the same quiet and peak passages in
   the chooser. **Choose for me** is optional.
4. Watch Landscape or switch to Trio Stage in Display. Both play automatically with no score or failure condition.
   Optional taps help calibrate the groove.

Several files selected or dropped together are treated as **stems of one
song**, summed for playback and analysis. Use descriptive names such as
`bass.wav`, `piano.wav`, `lead.wav`, and `vocals.wav` to help assign
musical parts. They should share a common start time. This is not a playlist.

Selecting or dropping a new recording stops current playback while it loads.
URL and library downloads keep playing the current song until the download
hands off to the loader. **Stop** returns to the upload screen.

The current page accepts local recordings, a music folder, URL loads and
the live sample. MIDI uploads, paired MIDI/audio playback and song-search
controls are no longer exposed. MIDI/SoundFont modules and the local
Soulseek/free-music bridge remain for internal or legacy use; Docker, a
Soulseek account and SoundFonts are not required for playback. Recorded
songs play their original audio with timeline synthesis muted; the sample
uses the fallback synth.

## Your music library

An optional **Plex library** entry can browse approved music sections and
load original recordings through a dedicated private adapter. It is disabled
by default. See [Plex setup and deployment](docs/plex-integration.md) for the
private environment inputs, public endpoint configuration, limits, and
verification steps. The adapter reads the library used by Plexamp; playback
runs in Midio's normal audio and visualizer path.

**Use a music folder** remembers a folder you choose, so a returning visit
opens on your own music instead of an empty dropzone. Nothing is uploaded
and nothing is copied: the browser hands the page a durable reference to a
folder already on your disk, and a file is read only when you play it.

The library sorts by title, artist, album, folder, date added, last played,
play count or length; filters as you type (`artist:radiohead`,
`folder:"kid a"`, or just words, which also match the path); and switches
between one flat list and the folders as they are on disk. **Auto-tag**
fills in titles and artists for tracks that only have a filename, using the
free MusicBrainz API at the one request per second it asks for.

Chromium-based browsers can reopen the folder by themselves. Firefox and
Safari cannot, so there the listing is remembered and the folder is picked
again once per visit before anything plays from it. Where the browser has no
storage at all, there is simply no library and dropping a song still works.

See [docs/library.md](docs/library.md) for the details.

Some in-app browsers have no file chooser at all. A `WebView` does not
implement one itself -- it asks the host app via
`WebChromeClient.onShowFileChooser()` -- so in an app that never overrides
that callback (Fermata's browser, for one) tapping **Browse files** opens
the soft keyboard and nothing else, because the click leaves the hidden
input focused. Nothing a page serves can add a chooser there. So the dead
click is detected once, suppressed from then on, and a **Load from a URL**
field is offered instead: point it at a song to play it, or at a folder to
browse what is in it. `tools/music-server.mjs` serves a music folder for
that purpose. See
[docs/chooserless-webviews.md](docs/chooserless-webviews.md).

## Saving a video

The show can be recorded to a file: the record dot in the HUD captures from
wherever you are, and **Save a video** on the complete screen replays the
song and records it end to end. Picture and sound come out in one file, in
sync, with no mirroring or projection in between.

Presets cover 480p, 720p and 1080p, plus **Car display** (800×480) for a
double-DIN head unit, letterboxed rather than stretched. Chrome and Edge
produce H.264 MP4, which plays anywhere; Firefox produces WebM and some
Chromium builds produce VP9 in an MP4 wrapper, neither of which most car
stereos or TVs will decode. The app checks the finished file and tells you
which one you got rather than trusting the extension.

Recording runs in real time — a four-minute song takes four minutes.

To render a folder of songs at 1080p, 1440p, or 2160p, and at 30 or 60 fps:

```
node tools/bulk-export.mjs --out exports --res 1080,1440,2160 --fps 30,60 path\to\songs
```

That path steps every frame and muxes H.264 with ffmpeg. See [docs/video-export.md](docs/video-export.md) for the details.

## Controls and preferences

| Control | Effect |
| --- | --- |
| Pause / Resume | Freeze or continue the performance and audio together |
| Stop | Stop playback and return to the upload screen |
| Fullscreen button | Expand the performance |
| **Record** (HUD dot) | Record the show to a video file from this moment; press again to stop and save |
| **Save a video** (complete screen) | Replay the song with the same seed and record it start to finish |
| **Use a music folder** / **Change folder** | Choose the folder your library reads from; remembered between sessions |
| **Browse library** | Open the library: search, sort, folder view, auto-tag. `Esc` closes it |
| **Timed lyric grounding: on/off** | Enable or skip lyric lookup; remembered between sessions |
| Stage selector | Choose the render resolution, including 8-bit and 8-bit intensive presets |
| Frame-rate selector | Cap rendering at 30 or 60 fps |
| **BT** chip | The Bluetooth delay, set by **Sync** or typed in by hand. Fades with the rest of the HUD; held open while its editor is |
| **Sync** button or `C` | Tap along with what you hear; the Bluetooth delay follows your taps, live ([docs](docs/sync-calibration.md)) |
| `F` / `J` | Tap the low / high percussion parts for groove calibration |
| `R` | Toggle reduced flashes, shake, and cuts |
| `P` | Toggle the FPS display |
| `T` | Toggle track details when available |
| `F3` | Toggle section labels on the mountain seekbar |

On a car head unit, the first tap after a long idle gap is spent entirely on
waking the display and restoring fullscreen, never on a control; a screen
wake lock is held while a song plays. See [car mode](docs/car-mode.md).

Settings has two independent, remembered chips: **Reduced flashing** (also
the `R` key) caps flashes and softens shake and cuts; **Reduced motion** holds
terrain movement, stops heat shimmer and calms the camera. Until you choose,
both follow your system's reduced-motion setting, even when browser storage
is blocked.
The show can contain flashing lights, camera shake, and sudden cuts.
Playback controls fade after inactivity; tap the canvas to bring them back.

Lyric grounding looks up available lyrics through LRCLIB to inform section
timing and visual interpretation. It does not display the lyrics as
karaoke text. Turn it off to skip those requests; the recording's own
analysis still drives the show.

## How a song becomes a performance

The audio adapter decodes a recording and filters it into seven frequency
bands, then estimates onsets, tempo, melody and bass pitches, sustain,
harmony, and section boundaries. These become a unified `NoteEvent`
timeline, continuous energy curves, and one shared **song profile**.
Worlds do not invent their own summaries of the mix. Pulse confidence and
free-time are kept separate from BPM, so a missing beat never becomes a
fake tempo.

Here, “stem separation” in the implementation means frequency-band
filtering. It is not learned instrument isolation. Pitch and role estimates
from a mixed recording are approximate; sharing a timeline format with the
MIDI adapter does not imply MIDI-level transcription accuracy.

The **Conductor** dispatches that timeline against the audio clock.
Ahead-of-time subscriptions let a performer prepare a move whose peak
lands on a note's onset. The visual clock compensates for reported audio
output latency, with the optional Bluetooth trim above. Simulation runs at
a fixed 120 Hz and rendering interpolates between steps.

Melody, bass, pad and percussion estimates drive landscape motion and
color. With uploaded stems, filenames and each stem's activity help assign
these musical roles. Legacy performer modules remain in the repository;
the current presentation disables performers and decorative actors.

The world registry contains eight landscape styles. Cathode has been retired; old playback IDs resolve to The Range.

- **The Range** — mountains that breathe with the mix. The Display preference **Range: Tetons only** (or `?rangeTour=tetons`) enables a song-timed flight through real Teton terrain. Use `?rangeTour=off` to override the saved preference. The tour remains a candidate; [validation and review evidence](docs/teton-tour-validation.md) record its limits.
- **After Hours** — a city that glows with the groove.
- **Far Side** — a lunar landscape. No air. Nothing softens.
- **The Fathom** — an underwater world, slow on purpose.
- **Redline** — a road that only exists at speed.
- **The Foundry** — an industrial world that only stops when the song does.
- **Understory** — a forest. Nothing is built. Everything grows.
- **The Nave** — a cathedral whose glass rebuilds with returning sections.

With `?worlds=all`, the chooser shows one equal card per world, in authored
order. A **Preview** plays the same quiet or peak passage through that
world's treatment of the song. **Play** adapts palette, terrain, and
musical response for the selected world — alpine never grows a city, and
a dense mix is filtered rather than amplified. There is no privileged
“custom” card and no public score.

**Choose for me** uses a private post-adaptation fit: would this world's
response sit in a sweet spot for this song, without clipping into noise.
Ties stay ties. Explicit exclusions stay out of that pick.
The number is never shown on the cards.

The parallax ranges are laid out as a timeline rather than as decoration.
Each depth travels at its own speed, so one tile of it stands for a fixed
stretch of music — roughly a song at the horizon, a section, a passage, and
a phrase at the front — and a summit sits at the point in that stretch its
moment occupies. The gaps between mountains are the gaps between events,
the wider mountains are the longer events, and a summit shows its steep
face toward whichever side the music rose or fell fastest on. Where the
recording has a tempo, the gullies striping the flanks are cut on the beat
grid, so the texture of the rock passes the eye at the song's own pulse.

Analysis bundles are cached in IndexedDB so repeat plays can reuse the
expensive analysis. Missing or unreadable cache entries fall back to fresh
analysis. Older bundles without a song profile still play; the profile is
rebuilt from the unpacked analysis. The performance governor reduces
optional effects under sustained frame pressure; the low-resolution
presets provide additional controls.

## Rendering and developer tools

Canvas 2D composes the scene; Range v2 supplies WebGL2 terrain by default.
A current browser with Web Audio and audio-format decoding is required.
WebGL2 enables the v2 scenery, while unsupported devices keep the painted
Range fallback. `?rangeRenderer=legacy` selects that fallback explicitly.
`?renderer=webgl` separately enables an optional post-processing overlay;
it is not the switch for Range v2.

Add `?dev=1` to enable developer shortcuts. During playback, the backtick
key opens the debug overlay, and `V` toggles the optional vision tuning
loop. That loop is off by default and needs a configured local or remote
provider. Its provider/model/endpoint settings live in the debug overlay;
external providers can require a user-supplied API key. Playback does not
require this feature.

## Version archive

`npm run archive` opens a timeline of every version on the checked-out
branch, back to the first commit, and runs whichever one you pick. Tagged
releases get a jump button, and "PRs and releases only" thins the list to
one entry per pull request. Nothing is checked out: each version
is served straight from git at its own address
(`http://<sha>.localhost:8090/`), so versions keep separate saved settings
and libraries.

Inside a version, the bar at the top moves between neighbours: `Alt+,`
older, `Alt+.` newer, `Alt+L` back to the timeline, `Alt+H` hide the bar.
The query string carries across, so a song loaded by URL follows you.

To browse a different branch (for instance the published `main` when your
checkout is behind), or to use another port:
`node tools/archive-serve.mjs 8090 origin/main --open`.

## Repository layout

```text
index.html   Recording/sample entry, opt-in world chooser, playback controls
src/
  main.js    Loading, chooser, playback lifecycle, and app coordination
  core/      NoteEvent timeline, Conductor, ParamBus, MIDI utilities
  audio/     Filtering, onset/tempo/pitch analysis, song profile, caching, playback
  lyrics/    Song identity, lyric lookup, alignment, and section interpretation
  sim/       Fixed-step music simulation, calibration, effects, legacy performers
  world/     World registry, adaptation, private fit, palettes, terrain, scenery
  eval/      Private world-quality corpus (no audio, no public scores)
  render/    Canvas compositor, pixel presentation, optional overlay, governor
  vision/    Optional vision tuning loop and provider adapters
  ui/        Controls, world chooser, previews, accessibility, overlays, styles
test/        Main app's Node tests and fixtures
tools/       Local server, fixture generators, browser smoke checks, legacy tools
```

The root GitHub Pages workflow publishes `index.html`, `src/`,
`soundfonts/`, and `CNAME`. It does not run the Node bridge.

## Testing

The main app suite:

```sh
npm ci
npm test
```

`npm test` runs the Node tests under `test/` (`test/*.js`, `test/*.mjs`,
and `test/helpers/*.js`). To discover any nested packages instead:

```sh
npm run test:all
```

To score section boundaries and repeat labels against a held-out annotated
corpus, see [audio-analysis evaluation](docs/analysis-evaluation.md).

To review whether worlds actually look good — same quiet / transition / peak
in every world, scores hidden — see
[world quality evaluation](docs/world-quality-evaluation.md).

Terrain bake regression tests pin decoded bytes and the semantic manifest. Only
`payload.sha256` and `payload.byteLength` vary with compression; tests still
verify the actual emitted compressed and decoded artifact lengths and hashes.
A second canonical-header gzip encoding must preserve decoded bytes and every
other manifest field. Exact compressed bytes are not a default release contract;
requiring them would need a pinned compressor/build image and a separate release
lane. The root Playwright dependency supports browser validation.

### Current browser smoke check

Install Chromium once and start the app:

```sh
npx playwright install chromium
npm start
```

In another terminal:

```sh
npm run test:smoke
# Optional server URL and artifact directory:
npm run test:smoke -- http://localhost:8080 .smoke/local
```

The check generates a deterministic 24-second PCM WAV and opens a fresh
browser context. It turns off optional lyric lookup, selects 720p, and
uploads through **Browse files**, preserving the browser gesture needed to
unlock audio. It exercises the real decoder, OfflineAudioContext filtering,
analysis, the opt-in world chooser (eight equal cards), and playback after
a world is picked. This smoke enables `?worlds=all` and the legacy Range renderer; ordinary entry
starts in The Range directly.

Assertions require a populated timeline, an active recording with the
timeline synth muted, advancing audio and simulation clocks, a populated
and changing canvas, controls that wake on a canvas tap, working pause/resume
and stop controls, and no browser
errors or visible error banner. Failure exits nonzero. Optional SoundFont
discovery is stubbed to an empty library to avoid loading local user files.

Artifacts are written to `.smoke/`: `fixture.wav`, `playback.png`,
`report.json`, and a Playwright `trace.zip`; failures also attempt to
capture `failure.png`. Open a trace with
`npx playwright show-trace .smoke/trace.zip`. Set
`PLAYWRIGHT_CHROMIUM_PATH` only when using a custom Chromium executable.

An existing recording can use the same checks (choose one at least
15 seconds long):

```sh
node tools/smoke.mjs http://localhost:8080 .smoke/custom path/to/recording.wav
```

Car mode (wake lock, wake-up-tap absorption) has its own check against a
running server:

```sh
npm run test:car
```

For the current staged routes, build the site and run a separate check:

```sh
npm run stage:site
npm run test:routes -- --site-root _site --out .smoke/current-routes
# Optional real recording (long enough for preparation and playback):
npm run test:routes -- --site-root _site --out .smoke/current-routes-song --audio path/to/song.wav
```

This freezes the staged public `index.html` and `src/` bytes and serves them on
an isolated loopback port. Four fresh headless contexts exercise clean default
Landscape v2, Tetons selected through its control, Tetons restored after a clean
reload in the same context, and Trio selected before upload. It records the
checkout SHA, public source digest, audio hash, browser version, actual route,
decoded audio clocks and matching completed presentation/capture IDs. A changed
canvas alone cannot pass. The generated 120-second fixture leaves room for
software-GPU startup; only the short observed playback window is checked. This is
integration coverage; it does not establish real-song quality or device speed.
Invalid WebGL/shader/program warnings and unexpected context loss fail the run
with their original severity and phase retained. Every route must pass; a known
failure remains a failed acceptance result. Existing output directories are
rejected to preserve earlier evidence.

The optional manual Test workflow runs both suites and uploads diagnostics.
The other `tools/smoke-*.mjs` scripts are legacy or specialized diagnostics;
some still target removed MIDI/demo/SoundFont UI and are not the maintained
upload regression suite.

## Additional references

- [World design notes](docs/worlds.md) — design background; the current
  registry, chooser, and per-world musical responses are described above.
- [VFX suite](docs/vfx-suite.md) — visual-system design notes.
- [Car mode](docs/car-mode.md) — keeping a head-unit display awake and in
  fullscreen, and why a page cannot fake a tap.
- [Browsers with no file chooser](docs/chooserless-webviews.md) — why the
  upload button opens the keyboard in some in-app browsers, why that is not
  fixable from the page, and the URL route offered instead.
- [Soulseek bridge notes](docs/soulseek.md) — retained backend tooling;
  the current upload page does not expose its search/connect controls.
- [SoundFont tooling](soundfonts/README.md) — retained synthesis support;
  uploaded recordings play their own audio with the timeline synth muted.

Display settings now separate **Natural / Pixel / Palette** from **Auto / Economy** quality. Open **Display** during playback to change them. [Pixel presentation](docs/pixel-presentation.md) explains migration, palettes and exports; [landscape peaks](docs/landscape-peaks.md) explains climax storms and the three landscape-scale instrument characters.
