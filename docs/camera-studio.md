# Camera Studio

Open Settings and enable **Camera Studio**. Its
collapsible controls stay fixed on the HUD independently of idle fading, and
are excluded from snapshots and video pixels. Settings are saved on this device.
Turn it off to return to the automatic camera.

Choose Follow rail, Arc orbit, Pendulum sweep, Push / pull or Locked frame. Distance
is relative to the camera's range-center radius; elevation, azimuth and focus
offsets compose the subject. Lens is a vertical angle. Orbit direction and
pace control the moving presets. Travel, hold, delay and overshoot
produce delayed spring arrivals that glide into an exact hold. Zero overshoot
uses a monotone ease. Heard song time controls the path, so pause, seek, replay
and video export agree without accumulating display frames.

Some landscapes contain only terrain visible from an authored camera. These
views support inward distance/lens crops and disable spatial controls. Full
terrain tours support spatial moves with terrain clearance, shared terrain and
forest coverage, and resource admission. The panel reports effective capability.
Choose **Settings → Camera → Camera tours → Teton highway tour** to access the
spatial controls without changing a URL. Choose **Music-timed tours** to return.
Arc orbit uses a bounded front-side arc because existing terrain is coarser on
its far side; it does not promise a full 360° revolution.
Wide or close views can need more geometry than a rail; the renderer retains its
budget and may limit detail or use safe framing. Controls that have no effect in
the selected mode are disabled.

An entire route is checked before admitting a changed full-terrain composition.
This prevents frame-dependent fallback or camera jumps at terrain-window seams.
The first check for a new view/settings/detail configuration can cause a brief
setup pause (about 310 ms in the recorded desktop CPU probe); cached frames do
not repeat it. This is not a target-device performance guarantee.

**Reset zoom** clears wheel/pinch zoom. **Reset camera** restores the studio's
defaults while leaving it enabled. The current configuration applies to the whole
song; the studio does not record a timeline of live knob edits. Highlight redraws
retain the camera settings of their captured moments.

See [video export](video-export.md) to save the composition with music.
