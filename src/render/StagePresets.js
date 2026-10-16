// Stage render presets: the size of the backing store the frame is
// rasterized into. The sim's own stage is always the logical 1280×720
// (Simulation canvasWidth/canvasHeight); only the buffer changes, and CSS
// upscales that buffer to fill the viewport.
//
// '8bit' is a MODE, not just another rung on this ladder. Every other
// preset changes one number — how many pixels get shaded. 8-bit changes
// three things at once, and only the combination is worth a menu entry:
//
//   1. Pixel count. 320×180 is 57,600 px against 1080p's 2,073,600 — a 36×
//      cut in rasterization, and every fill/composite/blit in the frame
//      scales with pixel count. This is the single biggest lever there is.
//      320×180 specifically (rather than something smaller still) because
//      it divides 1280×720 by exactly 4 and 1920×1080 by exactly 6, so the
//      upscale lands on whole pixels on the two commonest displays instead
//      of shimmering between them.
//   2. Draw-call count. Pixel count is only half the frame: the other half
//      is per-call overhead, which a smaller buffer does nothing about. So
//      8-bit also pins PerfGovernor to its cheapest rung (see its `retro`
//      flag) — every optional pass off, particles thinned, ridges blitted
//      in the widest columns. Without this a 320×180 frame is cheap enough
//      that the governor's own recovery would climb back to full quality
//      within a minute and undo the point of picking the mode.
//   3. Filtering. Nearest-neighbour on the way up (imageSmoothingEnabled
//      false, image-rendering: pixelated) is both cheaper than bilinear and
//      the thing that actually makes it read as 8-bit rather than as blur.
//
// What plain 8-bit deliberately leaves out is a palette-quantization pass.
// Real 8-bit hardware got its banded look for free from the framebuffer
// format; in Canvas 2D it costs a frame readback and a rewrite of every
// pixel, every frame — the kind of work this mode otherwise exists to
// remove. The chunky pixels carry the look on their own.
//
// '8bit-intensive' is that pass, offered as its own entry rather than
// folded into the cheap one. It keeps every saving plain 8-bit makes (same
// 320×180 buffer, same pinned governor, same nearest-neighbour) and adds
// the 256-color R3G3B2 palette on top — see PaletteQuantize.js. Two entries
// rather than one because they answer different questions: "my device
// cannot hold frame rate" and "I want it to look like a console". Someone
// on a genuinely weak machine should not have to buy the second to get the
// first, which is exactly what a single merged mode would force.

/** Automatic mode follows the visible stage and measured frame pressure.
 *  Its table dimensions are a safe pre-layout fallback; autoStageSize()
 *  supplies the live backing size once the canvas has a CSS box. */
export const AUTO_PRESET = 'auto';

/** Preset key for 8-bit mode. A string, unlike the numeric presets. */
export const RETRO_PRESET = '8bit';

/** Preset key for 8-bit intensive: everything RETRO_PRESET does, plus the
 *  per-frame palette quantization. */
export const PALETTE_PRESET = '8bit-intensive';

export const DEFAULT_STAGE_PRESET = AUTO_PRESET;

export const STAGE_PRESETS = {
  [AUTO_PRESET]: { w: 1920, h: 1080, auto: true },
  [RETRO_PRESET]: { w: 320, h: 180, retro: true },
  [PALETTE_PRESET]: { w: 320, h: 180, retro: true, palette: true },
  144: { w: 256, h: 144 },
  240: { w: 426, h: 240 },
  360: { w: 640, h: 360 },
  480: { w: 854, h: 480 },
  720: { w: 1280, h: 720 },
  1080: { w: 1920, h: 1080 },
  1440: { w: 2560, h: 1440 },
  2160: { w: 3840, h: 2160 },
};

/** Normalize an arbitrary value (a select's string value, a localStorage
 *  read, a URL param) to a real preset key, or null if it names nothing.
 *  Null rather than a default so callers can run their own fallback chain
 *  — the UI's value, then storage, then the house default — and tell the
 *  difference between "not set" and "set to something unknown". */
export function resolveStagePreset(value) {
  if (value == null) return null;
  const raw = String(value).trim().toLowerCase();
  const n = Number(raw);
  // Named (non-numeric) presets resolve against the table by key, rather
  // than each being spelled out here -- adding a row above is then all it
  // takes to add a mode. Numeric ones keep resolving to numbers, since
  // that is what every existing caller and stored value expects.
  const key = Number.isFinite(n) ? n : raw;
  return Object.prototype.hasOwnProperty.call(STAGE_PRESETS, key) ? key : null;
}

/** Backing-store dimensions for a preset, falling back to the house default
 *  rather than throwing — a bad stored value must never break boot. */
export function stageDims(preset) {
  return STAGE_PRESETS[preset] || STAGE_PRESETS[DEFAULT_STAGE_PRESET];
}

export function isAutoPreset(preset) {
  return !!STAGE_PRESETS[preset]?.auto;
}

/** Whether this preset is one of the 8-bit modes, i.e. whether the rest of
 *  the pipeline (governor floor, nearest-neighbour filtering) should engage.
 *  True for both the plain and the intensive variant. */
export function isRetroPreset(preset) {
  return !!STAGE_PRESETS[preset]?.retro;
}

/** Whether this preset additionally wants the per-frame palette pass. Only
 *  the intensive variant does; see PaletteQuantize.js for what it costs. */
export function isPalettePreset(preset) {
  return !!STAGE_PRESETS[preset]?.palette;
}

// A phone panel's device pixel ratio (commonly 3) is a print-density number,
// not a viewing-distance one: past ~2x, a 16:9 stage held at arm's length has
// no detail left to resolve, while every fill/composite/blit in the frame
// still scales with the pixel count. Capping the ratio we honour is what
// turns "match the panel exactly" into a power decision instead of a
// resolution one.
export const MAX_EFFECTIVE_DPR = 2;
export const MAX_COARSE_DPR = 1.5;
export const AUTO_DESKTOP_MAX_H = 1440;
export const AUTO_COARSE_MAX_H = 720;

/** Match Auto quality to the pixels the contained 16:9 stage can present.
 *  Coarse-pointer screens get a lower density/max-height ceiling because a
 *  phone's high panel DPR is not useful stage detail at arm's length. */
export function autoStageSize(cssW, cssH, dpr, isCoarsePointer = false) {
  const fallback = STAGE_PRESETS[AUTO_PRESET];
  if (!(cssW > 0) || !(cssH > 0) || !(dpr > 0)) {
    return { w: fallback.w, h: fallback.h };
  }
  const aspect = 16 / 9;
  const contentW = (cssW / cssH) > aspect ? cssH * aspect : cssW;
  const effectiveDpr = Math.min(dpr, isCoarsePointer ? MAX_COARSE_DPR : MAX_EFFECTIVE_DPR);
  const maxH = isCoarsePointer ? AUTO_COARSE_MAX_H : AUTO_DESKTOP_MAX_H;
  const h = Math.max(1, Math.round(Math.min(maxH, contentW * effectiveDpr / aspect)));
  return { w: Math.max(1, Math.round(h * aspect)), h };
}

/** Show rotation guidance only when a phone-like portrait viewport leaves
 *  less than 45% of its height for the contained stage. */
export function shouldSuggestLandscape(viewportW, viewportH) {
  if (!(viewportW > 0) || !(viewportH > 0)) return false;
  if (viewportW >= viewportH || viewportW > 600) return false;
  return (viewportW * 9 / 16) / viewportH < 0.45;
}

/** Shrink a preset's backing store to what the display can actually show.
 *
 *  The preset is a quality CEILING, not an instruction: rasterizing 1920×1080
 *  into a canvas the browser then draws at a fraction of that size spends
 *  power on pixels no display ever presents. That is the common case on a
 *  phone, and worst in portrait, where `object-fit: contain` (style.css)
 *  letterboxes the 16:9 stage into a thin strip a few hundred CSS px tall.
 *
 *  Returns preset-aspect dimensions that are never larger than the preset, so
 *  this can only ever REDUCE work: a desktop whose stage is displayed at or
 *  above its preset size keeps that preset unchanged. `cssW`/`cssH` are the
 *  element's own CSS box; a box with no area yet (measured before layout)
 *  falls back to the preset rather than guessing.
 */
export function displayLimitedSize(presetW, presetH, cssW, cssH, dpr) {
  if (!(presetW > 0) || !(presetH > 0)) return { w: presetW, h: presetH };
  if (!(cssW > 0) || !(cssH > 0) || !(dpr > 0)) return { w: presetW, h: presetH };
  const aspect = presetW / presetH;
  // object-fit: contain -- the drawn content is the largest preset-aspect box
  // fitting the element, so the bars carry no pixels worth rendering.
  const contentW = (cssW / cssH) > aspect ? cssH * aspect : cssW;
  // One scale for both axes, rather than clamping each independently: the
  // renderer derives its transform from canvas.width, so an aspect that
  // drifted by a rounding step would show up as a stretched frame.
  const scale = Math.min(1, (contentW * Math.min(dpr, MAX_EFFECTIVE_DPR)) / presetW);
  return {
    w: Math.max(1, Math.round(presetW * scale)),
    h: Math.max(1, Math.round(presetH * scale)),
  };
}
