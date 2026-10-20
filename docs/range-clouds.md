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

`RangeCloudTexture.js` generates a stable individual shape for each world bank.
Irregular overlapping volumes and warped density replace the shared four-lobe
layout and its tall protrusion. The bake integrates 12 samples through a
turbulent 3D field, with broad upper lighting rather than circular dark centres.
A 48-entry least-recently-used cache retains shapes across frames and releases
both density and tint together on eviction. Returning to an evicted bank
reconstructs the same pixels. Density and tint storage is bounded to 9 MiB
combined (plus the moon), subject to the shared graphics budget. Runtime drawing still
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
captures at 0, 12, and 40 seconds of the contrast fixture; retain both original
and candidate reports. Inspect actual frames, camera turns and travel rather
than treating changed pixels or structural texture tests as visual acceptance.

Water continues to consume the existing production sky backdrop and distant-ray
lookup. This repair does not introduce a separate physical cloud render through
the reflected camera. Fixed-clock camera probes do not establish live frame
pacing; the earlier full-resolution sky performance gate remains separate.
