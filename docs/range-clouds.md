# Landscape clouds

The smooth sky keeps celestial objects at infinite distance, while clouds occupy
finite world positions. Both ordinary clouds and storm banks use the same
resolved terrain-camera descriptor, including its position, lens, off-axis crop
and the ordinary travel blend. Scenic roll is applied once by the existing
outer canvas transform.

`RangeCloudField.js` selects a bounded neighborhood of fixed world cells.
Changing the camera changes projection, rather than relocating the clouds.
Heard-time wind is deterministic, and seeks reconstruct the same field.
Distance and route weights also control the affine transform, so a cloud
entering a blended view does not acquire a discontinuous position. Visible
banks draw far to near; texture selection and weather opacity use their
persistent identities.

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
lookup. The backdrop no longer depends on the lake mirror. It is captured
whenever a prepared view has lake or river water, up to rung 4 (`waterBackdrop:
q < 5`, one rung after `waterMirror`). It is bound to the water as soon as the
frame's copy exists, whatever the water level, and the mirror's ground image
fades in over it. Rivers reflect the backdrop alone, with the shiver stretched
along the current. Without a bound backdrop (rung 5 and above, and the far
partition, whose water would otherwise reflect its own copy), water reflects
`skyReflectAt`: the horizon band at grazing angles, rising toward the zenith,
lifted by lightning in place. The far partition's water keeps that open-sky
fallback; it is not part of this change. This repair does not introduce a separate physical cloud render through
the reflected camera. Fixed-clock camera probes do not establish live frame
pacing; the earlier full-resolution sky performance gate remains separate.

## Cloud shadows on the land

On the default high-resolution sky path (no painted legacy `skyClouds`), the
fair-weather banks also shade the ground. `cloudShadowCasters` uses the same
cell placement (`cloudCell`), seed, salt and heard-time wind as `cloudBanks`,
so a shadow falls under the cloud the sky draws. It selects the banks around
the eye's footprint moved toward the light (a card centre about 9.5 km up
shades the ground that far back along the light), splits each into three soft
elliptical sub-discs along the fixed wind axis and keeps at most 16 discs,
ordered by distance and then cell id. It writes into a caller-owned
`Float32Array`; RangeScene fills the existing uniform arrays in place.

`CloudOcclusion` switches on `uCloudMode`. Mode 0 is the legacy moon-only
painted-puff occlusion, unchanged. Mode 1 intersects each disc's altitude
plane along the key light, multiplies soft disc coverage, and applies one
shared breakup noise per fragment. `uCloudStrength` is
`.4 * (1 - storm.amount) * light visibility`, capped at .4, and it fades out as
the light approaches the horizon (`dir.y` from .15 down to .05). Water receivers
keep full transmission. The quality ladder drops the shadows at rung 4
(`cloudShadows: q < 4`), together with the lake mirror.

Limitation: ForestGL trees do not receive cloud transmission. Crowns under a
shadow keep the full key, while the ground between them is shaded.
