# Camera Studio and MP4 export

The owner requested an optional camera configuration engine and frame-by-frame
MP4 export, and explicitly delegated the feature decisions. Camera Studio is
worthwhile for composing a personal performance and exporting that composition;
ordinary playback keeps its automatic camera until the studio is enabled.

## Approach

Extend the native browser modules. A persistent Settings toggle opens stationary
HUD controls outside the rendered canvas. Offer authored motion, orbit, sweep,
push and static compositions; expose radius, elevation, orbit direction/rate,
focus offsets, lens, travel/hold timing, delay and damped overshoot. Use heard
song time so pause, seek, replay and export are independent of delivered FPS.
Keep terrain clearance, package coverage and admission authoritative. Pruned
static packages use safe projection edits; full coverage permits spatial moves.
Explain effective limitations in the panel instead of exposing missing terrain.

A separate browser exporter reuses the existing fixed-step render clock, then
encodes every requested frame with WebCodecs and muxes H.264 video and AAC source
audio into MP4 using a pinned, locally served Mediabunny runtime. This works on
static hosting and avoids an additional local server API. Native ffmpeg remains
available to the existing CLI. Real-time MediaRecorder was considered but cannot
guarantee every frame; server-only encoding would exclude the hosted app.

## Acceptance

- Settings toggle, labeled accessible controls, useful presets/reset and a compact
  collapsible panel that remains stationary and does not disappear with HUD idle.
- Deterministic bounded custom motion and a tunable delayed, overshooting settle.
- Saved settings survive reload, blocked storage falls back safely, disabled
  studio preserves existing behavior, and a render uses an immutable snapshot.
- MP4 outputs 640×360, 854×480, 1280×720, 1920×1080, 2560×1440 or 3840×2160;
  exactly 30 or 60 frame timestamps per second, with original decoded song audio.
- Full-song export freezes scene, seed, camera and presentation, waits for full
  analysis/terrain, provides progress/cancel and restores usable playback after
  success/failure/cancel. No silent size/FPS downgrade or silent video-only file.
- Check H.264/AAC support before expensive rendering. Stream directly to a chosen
  file when supported; bound the in-memory fallback to 512 MiB.
- No uploads, runtime CDN, merge or deployment. Keep geographic assets unchanged.

## Validation

Focused camera/export state tests, full Node suite, lint, module graph and
production staging. Run isolated muted browser captures of the controls and
motion, plus encode/decode MP4 checks for frame count/dimensions/audio when host
codecs allow it. Compare relevant CPU work and report physical-device/GPU gaps
honestly. Independent whole-change review before delivery.
