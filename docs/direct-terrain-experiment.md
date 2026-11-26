# Terrain-only pixel experiment

The Alpine Landscape player uses the direct renderer by default. It draws terrain at its original depth boundaries between the sky, water, weather and light. Turning off **Terrain-only pixel pipeline** selects the hybrid compositor.

Under **Settings → Appearance → Pixel motion**, **Free motion** lets the projected terrain move between grid positions. Material samples are anchored in world metres. The direct compositor carries the layer's translation and roll through its final copy. On a steady single view with overscan, it also compensates for the camera's fractional sampling offset. **Classic grid** restores the fixed screen grid.

On desktop, quality levels 0 and 1 can take extra terrain coverage samples within a 960×540 cap. At boundaries shared by two terrain layers, the scene depth selects the visible sample so opaque ridges stay opaque. Mobile and heavier quality levels use the selected resolution. GPU allocation refusal also falls back to that resolution.

Water uses its own projection and occlusion. During scene arrival or under memory pressure it can use the terrain grid. A direct-frame snapshot uses the finished display frame. A fixed-clock export renders at its requested output size. Physical Android head-unit performance still needs device verification.
