# Landscape clouds

The smooth sky keeps celestial objects at infinite distance, while clouds occupy
finite world positions. Both ordinary clouds and storm banks use the same
resolved terrain-camera descriptor, including its position, lens, off-axis crop
and the ordinary travel blend. Scenic roll is applied once by the existing
outer canvas transform.

`RangeCloudField.js` selects a bounded neighborhood of fixed world cells.
Changing the camera changes projection, rather than relocating the clouds.
Heard-time wind is deterministic, seeks reconstruct the same field, and reduced
motion freezes wind without detaching the field from the camera. Distance and
route weights also control the affine transform, so a cloud entering a blended
view does not acquire a discontinuous position. Visible banks draw far to near;
texture selection and weather opacity use their persistent identities.

`RangeCloudTexture.js` generates six small side-view cloud sprites with rounded
upper billows, a coherent base and shaded depth. The one-time bake integrates
12 samples through a turbulent 3D density field, deriving alpha from optical
coverage and shading from bounded sunward attenuation. Runtime drawing still
uses 2D sprites. Storm tinting multiplies the
sprite's internal luminance before restoring its alpha mask. It does not replace
the volume with a flat gradient or stretch the bank to a fixed screen height.
The sprite and tint buffers remain 192 by 128, owned by the existing residency
ledger and released on seed changes or disposal.

The previous storm path used legacy screen pan values that stayed zero during
the Teton tour. The previous ordinary cloud path projected celestial directions
and therefore ignored camera translation. These two paths could pass a generic
sky-rotation test while still producing visibly stationary clouds.

Run the cloud projection, integration, texture, and weather regression tests
before a visual comparison. Use `npm run review:landscape` for background
captures at 12, 24, and 40 seconds of the contrast fixture; retain both original
and candidate reports. Inspect actual frames, camera turns and travel rather
than treating changed pixels or structural texture tests as visual acceptance.

Water continues to consume the existing production sky backdrop and distant-ray
lookup. This repair does not introduce a separate physical cloud render through
the reflected camera. Fixed-clock camera probes do not establish live frame
pacing; the earlier full-resolution sky performance gate remains separate.
