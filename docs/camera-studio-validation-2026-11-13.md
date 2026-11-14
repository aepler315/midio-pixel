# Camera Studio and MP4 export validation

Source: feature branch `feat/camera-studio-export`, based on `a2ff8f5`.
Main's subsequent Playwright 1.65 update (`0885b73`) was merged while retaining
the pinned exporter dependency. Fresh dependency installation, tracked module
verification and the real 360p30/60/direct-file smoke passed after that update
(`.smoke/mp4-export-playwright-165/`). Application source was unchanged by it.
This records host evidence; JOYING/Android device performance is not established.

## Reproduction

Use Node 24 (`24.22.2` for this run). On this Windows host, `fnm exec --using 24`
selects it. Keep outputs in new `.smoke/` directories.

```
npm test
npm --prefix ridgeview test
npm run lint
npm run check:modules
npm run stage:site
npm run build:export-runtime -- --check
npm run test:mp4export
node tools/camera-studio-smoke.mjs .smoke/camera-studio-check
node tools/camera-studio-tour-smoke.mjs .smoke/camera-studio-tour-check
```

## Native browser and encoded audio/video

Isolated muted Chrome `157.0.8103.52`, Windows x64, NVIDIA RTX 3060 through ANGLE
Direct3D11. The smoke serves a frozen source and blocks external requests.
The 12-second generated WAV has SHA-256
`f4d4613bd1250a2d14df27168d06d0887460248ab280aa08531e71d86e9fd48f`.
Its title is `camera-studio-fixture`; snapshots sample heard time 5,000 ms.

The final upload/export parity run passed 26 checks with no page/console errors.
At the shared heard time, edited live and encoded camera eye, target, forward
direction and padded FOV matched exactly. Crop edits retained the authored eye
and target. MP4: 640×360, 30 fps, 360 H.264 frames, 12-second video, AAC 48 kHz
mono with non-silent decoded audio (RMS 0.11156), 1,706,528 bytes. AAC padding
extended its decoded duration to 12.010667 s. Cancel and successful completion
restored pause, source position, seed and camera settings.

The codec fixture separately passed all six output sizes at 30 and 60 fps, using
synthetic canvas frames and stereo PCM. The bounded-memory revision passed a
fresh 360p30/60 encode/decode plus direct-file success/cancellation rollback.
These establish encoding/cadence and lifecycle behavior. They do not establish
physical-device FPS or artistic quality across a music corpus.

Inspected the native UI screenshots, the five-second decoded MP4 frame, and
desktop/phone panel layouts. HUD controls stay out of the encoded frame;
geographic source captions remain in the artwork. Captures and videos are in
`.smoke/camera-studio-app-20261113-parity/`; codec reports are in
`.smoke/mp4-export-repeatable/` and `.smoke/mp4-export-bounded-memory/`.

The full-terrain browser run selected Teton Range through the visible Settings
control before uploading, with no initial `rangeTour` URL argument. Actual
`teton-range-tour` Arc orbit frames at 4, 12, 16 and 24 seconds had full spatial
capability and no camera fallback; the sampled eye moved 2,263.84 metres. Inspected
the 12- and 24-second images. An extreme request at 26 seconds used the stable
safe camera, with reported maximum terrain/summit errors 0.392/0.368 pixels.
The scene remained intact. There were no diagnostics errors; expected cancelled
preparation requests and the existing `f_celestialCloudTransmission` shader
warning were recorded. Evidence: `.smoke/camera-studio-tour-20261113-3/`.
These checkpoints demonstrate camera changes and safe framing; continuous live
delivery and physical-device motion quality remain unverified.
The tour fixture SHA-256 is
`db0eae46d5f25023a5a2d7ac7a7da96a6df62d44a9de2570f7dc9ff9957e78ff`;
the observed run seed was 2,933,324,640.

## Final automated results

- Full application Node suite: 5,676 tests, 5,665 passed, 11 skipped, zero failed
  (`.smoke/release-full-tests.log`, 317.5 seconds).
- Ridgeview: 26 passed, zero failed (`.smoke/ridgeview-tests.log`).
- Full ESLint: clean (`.smoke/release-lint.log`).
- Module graph: all 463 source modules parse and link.
- Production staging: passed, including runtime/license/file integrity checks.
- Export runtime regeneration check: pinned bundle current.

Iteration exposed source-extraction test fixtures that needed the new camera
boundary bindings and a pre-song terrain selector null-world bug. Focused
regressions and the final full run above cover their fixes. The existing
50 ms shot-planner timing assertion varied around its threshold during concurrent
browser work; it passed in the final full run without changing its threshold or
planner code. Earlier incomplete/red logs are retained separately in `.smoke/`.

## Camera geometry and CPU scope

Actual 2,280-tile Teton package, 410 protected summit tiles, 180-second route,
180p native terrain policy and mobile triangle cap, Intel i9-14900KF desktop CPU:

| Mode | Pose cost | First plan | Warm plan | Triangles | Maximum terrain / summit error |
| --- | ---: | ---: | ---: | ---: | ---: |
| Authored, Studio disabled | 0.065 µs | 24.5 ms | 13.83 ms | 820,566 | 2.000 / 1.994 px |
| Default Arc orbit | 0.798 µs | 309.7 ms | 9.15 ms | 686,022 | 1.999 / 1.993 px |
| Extreme request, safe authored fallback | 0.823 µs | 47.6 ms | 9.29 ms | 820,566 | 2.000 / 1.994 px |

These modes use different cameras, so their cost figures do not prove equivalent
visual output or a performance improvement. The first Arc plan checks the whole
route; warmed plans use its cached admission policy. All 23 window probes kept
one deterministic policy, with zero sampled coverage misses. The source error
ceiling is 16 native pixels and the existing triangle caps remain authoritative.

First-time camera preflight is synchronous and can briefly stall input/rendering.
Long songs and slower target devices can amplify this cost. Moving preflight to
a worker is a remaining performance improvement. No JOYING run, long mobile
thermal test or universal smoothness/FPS claim is included.

## Independent review

Independent review found and verified fixes for allocation-before-limit checks,
superseded export cleanup, paused refinement redraw, snapshot camera locking,
and crop/aim ordering. A final policy review found no new correctness blocker
and retained the synchronous-preflight performance limitation above.

The in-memory 512 MiB limit caps encoded output bytes. Canvas, source audio,
encoder/muxer buffers and Blob snapshot overhead use additional memory.
