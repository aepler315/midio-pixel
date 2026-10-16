# Saving a performance as a video

Two ways in, one recorder:

* **The record dot in the HUD** captures from this moment. Press it again to
  stop and save. Good for grabbing the one passage you want.
* **Save a video on the complete screen** replays the song with the same
  seed and records it start to finish, then saves itself when the song ends.
  This is the one to use when you want the whole thing.

Both write a single file with the picture and the sound already together.

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
* The line you get afterwards is built from that. An H.264 file says it
  plays anywhere. A VP9 file says, in as many words, that most car head
  units and TVs will not decode it.

The sniff is a heuristic and is only ever used to *label* a file, never to
reject one: a miss costs a vaguer sentence and nothing else.

**In practice:** Chrome and Edge give you H.264 MP4. Firefox gives you WebM.
Open-source Chromium builds give you VP9 in an MP4 wrapper. The note under
the preset menu tells you which before you spend a song finding out.

## Presets

| Preset | Size | For |
| --- | --- | --- |
| Car display | 800×480 | A double-DIN head unit. See below. |
| 480p | 854×480 | Small file, fine on a phone. |
| 720p | 1280×720 | The stage at its own size — no rescaling at all. |
| 1080p | 1920×1080 | Upscaled from the 1280×720 stage. Bigger file, not more detail. |

Every preset is even-dimensioned, because H.264 subsamples chroma 2×2 and an
odd dimension is either rejected or silently rounded.

The car preset is the odd one, and the reason the letterbox maths exists:
800×480 is 5:3, and the stage is 16:9. The show is **fitted** into it —
800×450 of picture with a 15px black bar top and bottom — rather than
stretched to fill it. `npm run test:export` decodes the finished file and
asserts those bars are black and the middle is not, because a stretch and a
letterbox are indistinguishable from any check that only looks at the
dimensions.

## Capture clock

Live playback keeps the 52ms display-presentation lead. Recorded content
uses the captured source-audio clock instead:

* A full-song replay is constructed at time zero with no presentation lead.
* A mid-song recording first pays down the existing lead across frames. The
  render timestamp never moves backward; it briefly holds while the audio
  clock catches up, and capture begins only after both clocks align.
* Stopping capture restores the live lead gradually, so one-shot events are
  not replayed.

`CaptureClock` unit tests establish those monotonic transitions. The current
browser smoke checks that encoded audio and video exist, but it does not yet
decode and compare click/cue onsets. That measurement harness remains to be
implemented for both full-song and mid-song capture; a green internal clock
test is not a substitute for it.

## Why it composites instead of capturing the stage directly

`stage.captureStream()` would be less code and is wrong. The stage's backing
store is not a fixed size: the resolution selector runs from 320×180 to 4K,
and **Auto lets the perf governor change it mid-song** under frame pressure.
A video track whose dimensions change halfway through is not something an
encoder or a player handles gracefully.

So each rendered frame is composited into a canvas of the *export's* size.
That makes the recording independent of whatever the stage is doing, and
gives the letterboxing somewhere to happen.

Frames are **pushed**, not sampled: `captureStream(0)` plus an explicit
`requestFrame()` after each composite yields exactly one encoded frame per
rendered frame, where letting the browser sample on its own clock would
duplicate frames when it runs fast and drop them when it runs slow. A
browser without `requestFrame` falls back to timed sampling rather than
refusing to record.

## What it costs

* **Real time.** A four-minute song takes four minutes to record. There is
  no way around that in a browser: the audio has to play to be captured.
* **Memory.** The whole recording is held as chunks until it is saved.
  720p for four minutes is around 150MB; 1080p is more. The note under the
  preset menu gives an upper bound before you start — computed from the
  bitrate we *ask* for, so an encoder that finds the content easy will come
  in under it, measured at roughly half on a sparse test signal.
* **Frame drops are real drops.** This records what was actually drawn. If
  the show stutters, the file stutters. Lowering the stage resolution buys
  headroom without changing the export size.

## The car case

The whole path, for a Pioneer DMH-W3000NEX or anything like it:

1. Pick **Car display** and record the full song from the complete screen.
2. Put the file on a USB stick. The head unit plays H.264 MP4 from USB
   natively.
3. That is it — no dongle, no phone, no projection, no Bluetooth.

What this buys over mirroring, concretely: the visuals stay on the beat
because there is one clock; the audio goes through the head unit's own
decoder to the amp rather than through a Bluetooth codec; the display's
own video player keeps its own screen awake, so none of `car-mode.md`'s
wake-lock machinery is needed; and there is no projection re-encode between
the render and the panel.

Two things to know: most head units gate video playback on the parking-brake
lead, so expect video to appear only when parked; and **record in Chrome or
Edge**, because a WebM or a VP9-in-MP4 file will not play there. The export
tells you which one you got.

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

Recording preserves the active Look with the final source sampler: Pixel and Palette use nearest-neighbour sampling. Bulk export snapshots look and effective quality independently of output dimensions. Pixel looks compose and quantize at 320×180, then fit the finished frame into the selected export size with black bars. Integer scaling stays a whole physical-pixel multiple where it fits. Natural keeps its current direct render path.

The CLI accepts `--look`, `--quality`, `--palette`, `--dither` and `--scaling`; see [display presentation](pixel-presentation.md).
