# Saving a performance as a video

Choose **Export video** on the front screen before choosing a song. Configure
resolution, aspect ratio, FPS, encoding quality and Fit/Fill framing, then drop a
song, play a sample or use **Random song**. The world picker offers **Export**
for Landscape and Trio. Recording starts after readiness, before the first
source audio, and saves when the complete source duration has elapsed. Full
exports analyze the entire song first; the opening-only fast path is disabled.
The completion screen no longer starts an export or replays a song to record it.

The record dot in the HUD still captures a passage from the current position.
Press it again to stop and save. **Cancel export** discards the current recording
and returns to the title. Stop saves a partial recording. Seek and world changes
are blocked at their shared entry points while recording. Pausing suspends both
the source and recorder, including a pause requested during terrain preparation.

Output settings are remembered; enabling export is an explicit choice for each
selection. A selection owns a snapshot of its settings, so a stale download or a
later selection cannot alter another recording. Files contain picture and sound.

## Why a file and not a mirror

A recording is two tracks stamped from one clock. Everything else — screen
mirroring, a projection dongle, casting — sends the picture and the sound to
the viewer by different paths, each with its own variable latency. For a show
whose entire premise is that things land *on the beat*, that difference is
not cosmetic: it is the difference between the world reacting to the music
and the world reacting near the music.

The app already carries the scar. The Bluetooth trim in the HUD exists
because a Bluetooth speaker delays the audio by 100–200ms and no browser
reports it, so the visuals have to be nudged by hand to match. A file needs
none of that — and the trim is deliberately *not* baked into an export,
because it is a correction for a room, not a property of the show.

## The codec problem, which is the real work here

`MediaRecorder.isTypeSupported('video/mp4')` can answer **true** in a
Chromium build with no proprietary codecs, and then hand back **VP9 inside an
MP4 container**. That file has the right extension. It opens fine in a
browser. A car head unit, a TV and most hardware players refuse it.

Handing someone that file and calling it an MP4 is worse than telling them
their browser cannot make one, so:

* `VideoExport.js` asks for codecs **explicitly**, best first, and never
  claims "plays anywhere" for a container whose codec the browser chose.
* When a recording finishes, the codec is read **out of the bytes** — the
  sample-entry four-character code (`avc1`, `vp09`, `av01`) near the front
  of the file — not assumed from what was requested.
* The line you get afterwards is built from that. H.264 with explicitly requested
  AAC is labeled for hardware playback; unknown audio stays qualified. A VP9
  file warns that most car head units and TVs will not decode it.

The sniff is a heuristic and is only ever used to *label* a file, never to
reject one: a miss costs a vaguer sentence and nothing else.

**In practice:** browsers offering explicit H.264 plus AAC use MP4. Otherwise
explicit WebM video/Opus pairs take priority over browser-chosen MP4 codecs. The front-screen format note tells you which before selecting a song.

## Independent controls

| Control | Choices | Changes |
| --- | --- | --- |
| Resolution | 480p, 720p, 1080p, 1440p, 4K | Encoded frame dimensions; pixel artwork retains its native grid. |
| Aspect ratio | 16:9, 9:16, 1:1, 4:3, car | Frame shape. Car is fixed at 800×480. |
| Frame rate | 24, 30, 60 fps | Capture target and temporary draw cap, independent of the saved playback cap. |
| Encoding quality | Compact, Balanced, Best | Requested compression bitrate; dimensions and scene detail stay fixed. |
| Framing | Fit or Fill | Preserve the whole scene with bars, or crop its center to fill. |
| General quality | Low, Medium, High | Live scene detail/effects ceiling, independent of compression and file size. |

The shorter output edge is the selected resolution. Dimensions are rounded to
even values for chroma subsampling: 1080p portrait is 1080×1920, 720p square is
720×720, and 480p landscape is 854×480. Fit/Fill applies one explicit rectangle
to the hybrid smooth sky and native pixel terrain. The front-screen preview
illustrates the framing policy; it is not a live preview of the selected song.

The general slider maps High/Medium/Low to governor floors 0/3/6. The adaptive
governor can shed additional detail under pressure, but recovery cannot undo the
selected ceiling. Old Economy preferences migrate to Low. Legacy recorder preset
IDs (`car`, `480p`, `720p`, `1080p`) remain accepted for existing integrations.

File estimates use the requested bitrate and are approximate. Once duration is
known, a combination estimated above the existing 512 MiB in-memory limit is
rejected before playback, with instructions to lower resolution, FPS or encoding
quality. The live byte limit remains enforced and explicitly labels a partial
save if reached. Unsupported browser recording formats fail before source audio
starts; the actual finished codec is still read from the file.

## Capture clock

Live playback keeps the 52ms display-presentation lead. Recorded content
uses the captured source-audio clock instead:

* A full-song export is constructed at time zero with no presentation lead.
* A mid-song recording first pays down the existing lead across frames. The
  render timestamp never moves backward; it briefly holds while the audio
  clock catches up, and capture begins only after both clocks align.
* Stopping capture restores the live lead gradually, so one-shot events are
  not replayed.

`CaptureClock` unit tests establish those monotonic transitions. The front-screen browser smoke also
compares decoded source audio with the recording in opening and quiet-tail
windows. It measures source preservation and audio timing, not visual cue/onset
synchronization. A matched audiovisual cue harness and physical-device review
remain separate gates for both full-song and mid-song capture.

## Why it composites instead of capturing the stage directly

`stage.captureStream()` would be less code and is wrong. The stage's backing
store is not a fixed size: the resolution selector runs from 320×180 to 4K,
and **the perf governor can change it mid-song** under frame pressure.
A video track whose dimensions change halfway through is not something an
encoder or a player handles gracefully.

So each rendered frame is composited into a canvas of the *export's* size.
That makes the recording independent of whatever the stage is doing, and
gives the letterboxing somewhere to happen.

Frames are **pushed**, not sampled: `captureStream(0)` plus an explicit
`requestFrame()` after each composite requests a completed frame without
independent timed sampling. The browser may coalesce requests or drop frames
under load; the resulting stream has variable timestamps. A
browser without `requestFrame` falls back to timed sampling rather than
refusing to record.

## What it costs

* **Real time.** A four-minute song takes four minutes to record. There is
  no way around that in a browser: the audio has to play to be captured.
* **Memory.** The whole recording is held as chunks until it is saved.
  The default 720p/30 Balanced request estimates roughly 84 MiB for four minutes; 1080p is more. The note under the
  export controls give an estimate before you start — computed from the
  bitrate we *ask* for, so an encoder that finds the content easy will come
  in under it. The estimate is not a file-size guarantee.
* **Frame drops are real drops.** This records what was actually drawn. If
  the show stutters, the file stutters. Lowering the stage resolution buys
  headroom without changing the export size.

## The car case

The whole path, for a Pioneer DMH-W3000NEX or anything like it:

1. Enable **Export video** on the front screen, choose **Car display** under Aspect ratio, then select a song and world.
2. Check the format note for H.264/AAC MP4 and confirm the target player
   supports the selected dimensions and frame rate, then put the file on USB.
3. That is it — no dongle, no phone, no projection, no Bluetooth.

What this buys over mirroring, concretely: the visuals stay on the beat
because there is one clock; the audio goes through the head unit's own
decoder to the amp rather than through a Bluetooth codec; the display's
own video player keeps its own screen awake, so none of `car-mode.md`'s
wake-lock machinery is needed; and there is no projection re-encode between
the render and the panel.

Two things to know: most head units gate video playback on the parking-brake
lead, so expect video to appear only when parked; and browser format support varies. Use a browser offering explicit H.264/AAC
for this target; a WebM or a VP9-in-MP4 file will not work on most head units.
The export tells you which format it can produce before you select a song.

## Bulk export

`node tools/bulk-export.mjs` (or `npm run export:bulk`) renders a file or a
folder of songs to H.264 MP4 at 1080p, 1440p, and 2160p, and at 30fps and
60fps. The default is that whole matrix. Narrow it with `--res` and `--fps`.

```
node tools/bulk-export.mjs --out exports --res 1080,1440,2160 --fps 30,60 D:\songs
```

The page steps the sim on the audio clock, one output frame at a time, and
posts the pixels to ffmpeg, which muxes them with the source audio as AAC.
A pass that asks for both frame rates draws at 60 and writes the 30fps file
from every other frame. The same seed is reused across sizes, so those
files are one performance. Each frame is the picture at that audio time,
to within one 120Hz sim step: the export clock only takes whole steps, so
physics never depends on the frame rate being exported to.

It needs ffmpeg on PATH, with libx264. A long song at 2160p takes as long
as the frames take to draw.

## Testing

* `test/videoExport.test.js` — the codec ladder, the letterbox maths, the
  bitrate clamps, filenames, the codec sniff, and the sentences built from
  all of it.
* `test/songRecorder.test.js` — the recorder's state machine against fakes:
  the compositor is sized by the preset and not the stage, one frame pushed
  per rendered frame, the master-bus tap connected and released, a cancel
  that produces nothing, and every failure path coming back as a message
  rather than a throw.
* `npm run test:export` (`tools/export-smoke.mjs`) — a real browser:
  record, save, then **decode the saved file back** and assert it has a
  picture, has sound, is the size the preset asked for, and is letterboxed
  rather than stretched. This is the only check that can see the two places
  the feature touches the app — the render-loop hook and the audio tap —
  both of which fail silently.

## Pixel look and output size

Recording preserves the active Look with the final source sampler: Pixel and Palette use nearest-neighbour sampling. Bulk export snapshots look and effective quality independently of output dimensions. Pixel looks compose and quantize at 320×180, then fit the finished frame into the selected export size with black bars. Export Fit/Fill controls are independent of live integer scaling; the same centered rectangle places hybrid sky and native terrain.

The CLI accepts `--look`, `--quality`, `--palette`, `--dither` and `--scaling`; see [display presentation](pixel-presentation.md).

## Full-source export and observed cadence

Full exports bypass the live finale fade and authored audio ducks, keeping the
source intact at the normal playback gain. Their endpoint is the decoded source
duration, even if the visual finale is already complete. Ordinary playback and
mid-song clips retain the authored show audio behavior.

Real-time capture cannot guarantee the requested FPS on a device that cannot
draw that fast. Recorder status and the save notice show completed composite
frames per second against the target. These are drawn-frame statistics, not a
claim about encoded constant-rate frames; a timed-sampling fallback may duplicate
frames. Lower general quality for rendering headroom. The saved playback FPS
preference is restored after recording.

`node tools/start-export-smoke.mjs URL OUTDIR` uses a separate muted headless
browser, connects a real folder, selects a random song, records through the
front-screen controls, downloads and decodes the file, probes audio/dimensions/
frame timestamps, checks preference restoration and captures desktop/mobile UI.
Its reports and media stay under ignored `.smoke/` evidence directories.

Explicit codec pairs also avoid a measured Chromium Opus-in-MP4 delay mismatch:
a minimal two-second chirp recorded with H.264/unspecified-audio MP4 decoded
about 73.5 ms early; explicit VP9/Opus WebM decoded about 6.5 ms late on the same
software runner. These measurements apply to that browser build, not all devices.
The source-audio smoke correlates opening and tail windows, records measured
offset/gain, and rejects source onset trimming. Browser startup holds the primed
opening frame before audio starts, while completion allows the final requested
video sample to reach the encoder before stopping. Stopping freezes the output
surface, flushes pending GPU copies and disconnects source audio synchronously,
so immediate completion navigation cannot damage that recording. The drain
has a timer fallback when a hidden tab suspends animation callbacks.
