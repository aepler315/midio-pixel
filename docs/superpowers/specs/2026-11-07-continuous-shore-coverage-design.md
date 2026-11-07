# Continuous native shoreline coverage

The requested growing-range overview, apex/action tracking and featureless ocean
opening are already merged in PR #99. All twenty ordinarily eligible views
receive that overview. The mapped Teton tour is diagnostic-only and retains its
admitted camera corridor. Recheck these contracts without duplicating that work.

The remaining bounded issue is a hard color switch at the native terrain
fragment's `waterCoverage > .5` threshold. Source contours are world-anchored,
but a camera crossing that threshold can change a whole native pixel's color.

Use the existing fragment's coverage derivative to filter material appearance
over approximately one native pixel. Blend land/water material and optical
contributions continuously; retain exact uniform dry/wet interiors. Source
classification, debug output, ice, mapped rivers and water-only coverage remain
authoritative. Direct water separation must keep its existing appearance owner.

Alternatives considered: a separate output-size shoreline stage would recover
more spatial detail but add rendering and memory work; always rendering terrain
at display size would undermine the Classic opening and JOYING target. A local
appearance filter is the implementation choice for this followup, reusing the
current path without either cost. It cannot create physical edge geometry beyond
the native raster; coarse Pixel cells will remain visible.

No new texture samples, render passes, targets or uniforms. Avoid a second full
material evaluation. Test production shader math and integration guards. Actual
rendered appearance and physical JOYING performance require subsequent device
review: this environment's Chromium launch fails at its singleton socket with
`Operation not permitted`, and the RTX workstation remains offline.
