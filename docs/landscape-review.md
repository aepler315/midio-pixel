# Background Landscape review

`npm run review:landscape` captures actual output without opening a browser
window or report. The command always launches headless Chromium. It does not
honour `VISUAL_HEADFUL`, and has no `--headful` or `--open` option.
Chromium uses a fresh temporary profile and isolated contexts; the tool never
attaches to an existing Chrome session. Its default headless `--mute-audio`
flag stays enabled, so decoding and analysis do not play through speakers.
Git, audio-generation and optional FFmpeg helper processes also request hidden
windows on Windows.

Ctrl+C (`SIGINT`) or `SIGTERM` cancels the owned run, stops helper processes,
closes its browser and loopback server, and saves a `cancelled` root report
with the signal and any cleanup errors. The command exits nonzero (130 or
143); the root report never marks an interrupted run as passed.
Already saved files remain for diagnosis. Forced termination such as `SIGKILL`,
power loss, or closing the process outside this signal path cannot guarantee a
completed report.

```sh
npm run review:landscape -- --out .smoke/landscape-baseline --record-baseline
# Make a scoped change, then use the same recording and controls.
npm run review:landscape -- --out .smoke/landscape-candidate --baseline .smoke/landscape-baseline
```

The bounded default is one generated 90-second contrast recording, a two-second
continuous window beginning at 12 seconds, 12 saved frames per second, both
Classic and Detailed grids, and fixed quality 0. The app still takes its normal
upload and analysis path. All recorded frames use Uniform raster scaling; old
Depth preferences cannot activate the removed mode. Use `--audio recording.wav`
for a representative recording, `--view teton-jackson-lake` for a static lake
view, or `--start-ms 40000 --seconds 4 --fps 24` for another continuous passage.
Use `--look cinematic` to review the experimental Cinematic Pixel Look;
`--look pixel` remains the default. The selected Look applies to both the
fixed-clock clips and optional live trace, and each checks the effective
presentation diagnostics. `--grid classicPlus` selects the 400×225 native
terrain raster without changing the Look.
The default view is the authored Teton tour. Clip length is bounded at ten
seconds; use the existing visual manifest workflow for larger corpora.

The tool freezes and hashes public runtime files before serving its own
loopback snapshot. For a retained snapshot, `--snapshot DIR` reads
`manifest.json` containing `hashes` (logical runtime path to SHA-256) and
`digest` (SHA-256 of `JSON.stringify(hashes)`), plus files named by those
hashes. Optional `source` metadata records the original commit/dirty state.
Every byte is verified before use. This format preserves case-distinct source
paths on hosts where a normal directory copy would merge them. It records the source commit and dirty state, browser,
actual renderer, actual grid and Uniform setting, resolved camera projection
and position, heard time, sky mode, window coverage and detail, forest counts,
and graphics ledger. A source change during capture fails the run. Output must
be a new directory; evidence is never silently replaced.

Each grid saves exact PNGs, their hashes, copied source audio, an audio-backed
HTML frame player, and a labelled contact sheet. If `ffmpeg` is available, it
also creates `motion.mp4`; set `FFMPEG_PATH` or pass `--no-mp4` when appropriate.
The exact PNG/audio player remains available when MP4 encoding is unavailable.
The MP4 is a lossy motion preview. The report and contact sheets are saved only;
open them manually when convenient.

By default the tool explicitly uses software WebGL for portable repeatable
review. Hardware review must be requested and verified from the actual renderer:

```sh
PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome npm run review:landscape -- \
  --out .smoke/landscape-hardware --hardware-gpu --gpu-match "RTX 3060"
```

`--browser /path/to/chrome` is equivalent to selecting the executable through
the environment. Hardware mode rejects SwiftShader, llvmpipe, softpipe, Windows
WARP (`Microsoft Basic Render Driver`) and other software renderers, and the
masked `WebKit WebGL` string, which cannot show what rendered. The route gate's
hardware configuration uses the same check. `--gpu-match` additionally checks a
substring of the actual renderer.
A headless hardware run is separate evidence from a headed physical-display run.
Capture both sides again under the same transport before comparing them.

The candidate gate instruments paint operations inside removed Landscape
overlay methods. It rejects synthetic equalizer mountains, crest glow, ocean
plates and foreground ovals that actually paint. `--record-baseline` records
these old defects without treating their presence as candidate acceptance.
The report also checks a paused presenter grid/backing-size round trip without
advancing heard time or replacing the audio engine. This check does not replace
the unit tests or the separate delayed-worker lifecycle fixture.

Revision comparisons through `--baseline` require the same requested Look
and every other matched setting. Capture Classic+ Pixel and Cinematic Pixel
into separate, explicitly labelled reference folders for a visual comparison;
their different Look requests cannot pass as an identical-settings revision
comparison. Do not edit saved baseline settings to make them match.

Optional live timing uses a separate real upload and waits for `renderReady`
before measuring delivered frames. It uses the authored Teton tour and the
first selected grid; a `--view` choice applies to the fixed-clock clips:

```sh
npm run review:landscape -- --out .smoke/landscape-live --hardware-gpu \
  --audio long-enough-recording.wav --live-seconds 300
```

The startup wait and readiness result are recorded separately from the live
trace. Its report retains observed metrics and explicit targets: delivered p95
at most 20 ms, at most one gap over 100 ms per minute, no failed presentations,
no hidden time or browser
errors, advancing heard time, and no graphics overcommit within the ledger
budget (at most 512 MiB). A completed trace that misses a target is failed, not
reported as successful. The live duration is bounded at 300 seconds, and the input must be long
enough for it. This background trace does not claim OS fullscreen, optical
scanout, foreground scheduling or physical-device acceptance. Fixed-clock clips
never measure live pacing.
An invalidated presentation with reason `not-rendered` has not attempted a
draw and does not count as a rejected presentation. Its complete delivery
interval and any stall still count; an actual rejected draw remains a failure.

A passing run means its technical controls and checks passed. Artistic judgment
remains **unreviewed**. Inspect the actual frames and matching audio, note the
song and time, and record a retain/revert decision and remaining uncertainty.
Do not infer visual quality from changed pixels, a GPU string, or passing tests.
Keep all generated evidence outside Git as required by `AGENTS.md`.

Use `--ablate-aurora` for a diagnostic at the first captured frame. The tool
repeats that frame, disables only the aurora painter for one draw, restores it,
and saves both PNGs with exact clock/control and repeated/restored hash checks.
Only a matched ablation can attribute an image artifact to that layer. It does
not change the captured source or establish artistic acceptance.
