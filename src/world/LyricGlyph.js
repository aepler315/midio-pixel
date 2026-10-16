// Constellation glyph shapes: normalized {x,y} dots in a 0-1 square,
// suggesting a recognizable form — abstract enough to be a discovery when
// you notice it, not a label stamped on the sky.
//
// Two ways to author a shape:
//   - A flat array of dots: the ORIGINAL, still-supported form. Connected
//     sequentially (dot 0→1→2→...) by the weaver's edge system -- a single
//     unbroken line, since the weaver's connect-the-dots reveal has no way
//     to lift the pen mid-figure.
//   - `{ outline, interior }`: `outline` is that same single unbroken
//     connect-the-dots line (the shape's own silhouette/identity), and
//     `interior` is a LIST of separate strokes -- each its own independent
//     polyline, pen lifted between them -- for detail that can't be reached
//     by backtracking a single path: a mast rising off a hull, a crack
//     down a heart, gems set into a crown's band. The weaver reveals
//     `interior` together, right after `outline` finishes connecting, so a
//     shape reads as "recognizable, and here's what confirms it" rather
//     than every stroke arriving at once.
// `normalizeGlyphShape` below accepts either and always returns the
// `{outline, interior}` form, so every consumer only has to handle one
// shape.
//
// Also contains a minimal single-stroke font for Midasus's sky writing:
// uppercase A-Z laid out as polyline paths she traces with her trail.

import { clamp } from '../utils/math.js';

// ── Constellation glyph shapes ─────────────────────────────────────────

export const GLYPH_SHAPES = {
  heart: [
    { x: 0.50, y: 0.23 }, { x: 0.36, y: 0.06 }, { x: 0.16, y: 0.10 },
    { x: 0.04, y: 0.30 }, { x: 0.08, y: 0.52 }, { x: 0.24, y: 0.72 },
    { x: 0.50, y: 0.95 }, { x: 0.76, y: 0.72 }, { x: 0.92, y: 0.52 },
    { x: 0.96, y: 0.30 }, { x: 0.84, y: 0.10 }, { x: 0.64, y: 0.06 },
    { x: 0.50, y: 0.23 },
  ],
  // The five-point outline traced as one continuous path; a small sparkle
  // glint at the core is a separate stroke, since the path has no pen-lift
  // to spare mid-trace.
  star: {
    outline: [
      { x: 0.50, y: 0.00 }, { x: 0.79, y: 0.90 }, { x: 0.02, y: 0.35 },
      { x: 0.98, y: 0.35 }, { x: 0.21, y: 0.90 },
    ],
    interior: [
      [{ x: 0.44, y: 0.45 }, { x: 0.56, y: 0.45 }],
      [{ x: 0.50, y: 0.39 }, { x: 0.50, y: 0.51 }],
    ],
  },
  crown: {
    outline: [
      { x: 0.05, y: 0.90 }, { x: 0.05, y: 0.50 }, { x: 0.25, y: 0.10 },
      { x: 0.40, y: 0.45 }, { x: 0.50, y: 0.05 },
      { x: 0.60, y: 0.45 }, { x: 0.75, y: 0.10 },
      { x: 0.95, y: 0.50 }, { x: 0.95, y: 0.90 }, { x: 0.05, y: 0.90 },
    ],
    // Two gems set into the band -- separate strokes since the outline's
    // own single path already has to go up-down-up-down for the points and
    // has no pen-lift left to spare for them.
    interior: [
      [{ x: 0.36, y: 0.72 }, { x: 0.40, y: 0.78 }, { x: 0.36, y: 0.84 }],
      [{ x: 0.64, y: 0.72 }, { x: 0.60, y: 0.78 }, { x: 0.64, y: 0.84 }],
    ],
  },
  flame: {
    outline: [
      { x: 0.50, y: 0.02 }, { x: 0.62, y: 0.18 }, { x: 0.56, y: 0.32 },
      { x: 0.68, y: 0.46 }, { x: 0.72, y: 0.62 }, { x: 0.60, y: 0.82 },
      { x: 0.50, y: 0.97 }, { x: 0.40, y: 0.82 }, { x: 0.28, y: 0.64 },
      { x: 0.34, y: 0.48 }, { x: 0.26, y: 0.32 }, { x: 0.38, y: 0.16 },
      { x: 0.50, y: 0.02 },
    ],
    // A smaller inner flame lick, nested inside the outer tongue.
    interior: [
      [
        { x: 0.50, y: 0.34 }, { x: 0.58, y: 0.48 }, { x: 0.55, y: 0.62 },
        { x: 0.50, y: 0.76 }, { x: 0.45, y: 0.62 }, { x: 0.42, y: 0.48 },
        { x: 0.50, y: 0.34 },
      ],
    ],
  },
  moon: [
    { x: 0.62, y: 0.04 }, { x: 0.82, y: 0.16 }, { x: 0.92, y: 0.36 },
    { x: 0.92, y: 0.64 }, { x: 0.82, y: 0.84 }, { x: 0.62, y: 0.96 },
    { x: 0.74, y: 0.82 }, { x: 0.80, y: 0.64 }, { x: 0.80, y: 0.36 },
    { x: 0.74, y: 0.18 }, { x: 0.62, y: 0.04 },
  ],
  // The outline already doubles back down the center for the vertical
  // facet; the girdle -- the widest horizontal cut of a faceted gem -- is
  // a separate stroke straight across.
  diamond: {
    outline: [
      { x: 0.50, y: 0.00 }, { x: 0.85, y: 0.30 },
      { x: 0.50, y: 1.00 }, { x: 0.15, y: 0.30 },
      { x: 0.50, y: 0.00 }, { x: 0.50, y: 1.00 },
    ],
    interior: [
      [{ x: 0.15, y: 0.30 }, { x: 0.85, y: 0.30 }],
    ],
  },
  lightning: [
    { x: 0.55, y: 0.00 }, { x: 0.30, y: 0.40 },
    { x: 0.58, y: 0.42 }, { x: 0.28, y: 0.95 },
    { x: 0.65, y: 0.50 }, { x: 0.42, y: 0.48 },
  ],
  // Two eye sockets and a jaw's teeth-line -- each a separate stroke, since
  // the outline's single path has no way to double back into the hollows
  // it's tracing the rim of.
  skull: {
    outline: [
      { x: 0.50, y: 0.03 }, { x: 0.80, y: 0.14 }, { x: 0.90, y: 0.40 },
      { x: 0.78, y: 0.60 }, { x: 0.62, y: 0.80 }, { x: 0.50, y: 0.97 },
      { x: 0.38, y: 0.80 }, { x: 0.22, y: 0.60 }, { x: 0.10, y: 0.40 },
      { x: 0.20, y: 0.14 }, { x: 0.50, y: 0.03 },
    ],
    interior: [
      [{ x: 0.32, y: 0.42 }, { x: 0.40, y: 0.48 }, { x: 0.32, y: 0.54 }],
      [{ x: 0.68, y: 0.42 }, { x: 0.60, y: 0.48 }, { x: 0.68, y: 0.54 }],
      [
        { x: 0.40, y: 0.85 }, { x: 0.45, y: 0.92 }, { x: 0.50, y: 0.85 },
        { x: 0.55, y: 0.92 }, { x: 0.60, y: 0.85 },
      ],
    ],
  },
  // A pupil at the eye's center -- a separate stroke, since the almond
  // outline is already an open path with nowhere to lift the pen inward.
  eye: {
    outline: [
      { x: 0.02, y: 0.50 }, { x: 0.25, y: 0.20 }, { x: 0.50, y: 0.12 },
      { x: 0.75, y: 0.20 }, { x: 0.98, y: 0.50 },
      { x: 0.75, y: 0.80 }, { x: 0.50, y: 0.88 }, { x: 0.25, y: 0.80 },
    ],
    interior: [
      [
        { x: 0.50, y: 0.38 }, { x: 0.60, y: 0.50 }, { x: 0.50, y: 0.62 },
        { x: 0.40, y: 0.50 }, { x: 0.50, y: 0.38 },
      ],
    ],
  },
  sword: [
    { x: 0.50, y: 0.00 }, { x: 0.50, y: 0.62 },
    { x: 0.22, y: 0.68 }, { x: 0.78, y: 0.68 },
    { x: 0.50, y: 0.68 }, { x: 0.50, y: 0.95 },
  ],
  wave: [
    { x: 0.00, y: 0.50 }, { x: 0.15, y: 0.25 }, { x: 0.30, y: 0.50 },
    { x: 0.50, y: 0.75 }, { x: 0.70, y: 0.50 },
    { x: 0.85, y: 0.25 }, { x: 1.00, y: 0.50 },
  ],
  infinity: [
    { x: 0.50, y: 0.50 }, { x: 0.35, y: 0.25 }, { x: 0.15, y: 0.22 }, { x: 0.04, y: 0.40 }, { x: 0.06, y: 0.62 }, { x: 0.20, y: 0.78 }, { x: 0.36, y: 0.74 }, { x: 0.50, y: 0.50 }, { x: 0.64, y: 0.26 }, { x: 0.80, y: 0.22 }, { x: 0.96, y: 0.40 }, { x: 0.94, y: 0.62 }, { x: 0.80, y: 0.78 }, { x: 0.64, y: 0.74 }, { x: 0.50, y: 0.50 },
  ],
  mountain: [
    { x: 0.00, y: 0.95 }, { x: 0.25, y: 0.40 }, { x: 0.42, y: 0.10 },
    { x: 0.58, y: 0.10 }, { x: 0.75, y: 0.40 }, { x: 1.00, y: 0.95 },
  ],
  cross: [
    { x: 0.50, y: 0.00 }, { x: 0.50, y: 1.00 },
    { x: 0.50, y: 0.35 }, { x: 0.15, y: 0.35 },
    { x: 0.85, y: 0.35 },
  ],
  ghost: {
    outline: [
      { x: 0.50, y: 0.05 }, { x: 0.75, y: 0.12 }, { x: 0.86, y: 0.35 }, { x: 0.86, y: 0.90 }, { x: 0.72, y: 0.80 }, { x: 0.58, y: 0.92 }, { x: 0.44, y: 0.80 }, { x: 0.30, y: 0.92 }, { x: 0.14, y: 0.80 }, { x: 0.14, y: 0.35 }, { x: 0.25, y: 0.12 }, { x: 0.50, y: 0.05 },
    ],
    interior: [
      [{ x: 0.34, y: 0.36 }, { x: 0.40, y: 0.44 }],
      [{ x: 0.66, y: 0.36 }, { x: 0.60, y: 0.44 }],
    ],
  },
  wings: {
    outline: [
      { x: 0.50, y: 0.55 }, { x: 0.38, y: 0.30 }, { x: 0.20, y: 0.12 }, { x: 0.04, y: 0.18 }, { x: 0.08, y: 0.40 }, { x: 0.20, y: 0.60 }, { x: 0.36, y: 0.66 }, { x: 0.50, y: 0.55 }, { x: 0.64, y: 0.66 }, { x: 0.80, y: 0.60 }, { x: 0.92, y: 0.40 }, { x: 0.96, y: 0.18 }, { x: 0.80, y: 0.12 }, { x: 0.62, y: 0.30 }, { x: 0.50, y: 0.55 },
    ],
    interior: [
      [{ x: 0.14, y: 0.30 }, { x: 0.30, y: 0.46 }],
      [{ x: 0.86, y: 0.30 }, { x: 0.70, y: 0.46 }],
    ],
  },
  // A ship's hull alone (no waves named) -- the mast+flag are a separate
  // stroke because the hull's own outline has no pen-lift to spare for
  // them without a straight line cutting back across the deck.
  ship: {
    outline: [
      { x: 0.04, y: 0.72 }, { x: 0.22, y: 0.60 }, { x: 0.50, y: 0.55 },
      { x: 0.78, y: 0.60 }, { x: 0.96, y: 0.72 },
      { x: 0.74, y: 0.80 }, { x: 0.26, y: 0.80 }, { x: 0.04, y: 0.72 },
    ],
    interior: [
      [{ x: 0.50, y: 0.55 }, { x: 0.50, y: 0.08 }],
      [{ x: 0.50, y: 0.08 }, { x: 0.74, y: 0.18 }, { x: 0.50, y: 0.28 }],
    ],
  },
  // "Ship over waves" -- the two-image combo LyricLexicon builds when a
  // line names both a vessel and the sea in the same breath. Same hull and
  // rigging as plain `ship`, with a wave-crest stroke added beneath it so
  // the water is unmistakably part of the same image, not a coincidence.
  ship_wave: {
    outline: [
      { x: 0.04, y: 0.68 }, { x: 0.22, y: 0.56 }, { x: 0.50, y: 0.51 },
      { x: 0.78, y: 0.56 }, { x: 0.96, y: 0.68 },
      { x: 0.74, y: 0.76 }, { x: 0.26, y: 0.76 }, { x: 0.04, y: 0.68 },
    ],
    interior: [
      [{ x: 0.50, y: 0.51 }, { x: 0.50, y: 0.06 }],
      [{ x: 0.50, y: 0.06 }, { x: 0.74, y: 0.16 }, { x: 0.50, y: 0.26 }],
      [
        { x: 0.00, y: 0.90 }, { x: 0.14, y: 0.83 }, { x: 0.28, y: 0.90 },
        { x: 0.42, y: 0.83 }, { x: 0.58, y: 0.90 }, { x: 0.72, y: 0.83 },
        { x: 0.86, y: 0.90 }, { x: 1.00, y: 0.85 },
      ],
    ],
  },
  // "Heart with a fracture" -- LyricLexicon's combo for a line that names
  // both the heart and its breaking, rather than the plain, whole `heart`
  // above. Same outline; the crack is what a single connect-the-dots path
  // could never draw (it would have to double back across itself).
  heart_break: {
    outline: [
      { x: 0.50, y: 0.23 }, { x: 0.36, y: 0.06 }, { x: 0.16, y: 0.10 },
      { x: 0.04, y: 0.30 }, { x: 0.08, y: 0.52 }, { x: 0.24, y: 0.72 },
      { x: 0.50, y: 0.95 }, { x: 0.76, y: 0.72 }, { x: 0.92, y: 0.52 },
      { x: 0.96, y: 0.30 }, { x: 0.84, y: 0.10 }, { x: 0.64, y: 0.06 },
      { x: 0.50, y: 0.23 },
    ],
    interior: [
      [
        { x: 0.50, y: 0.28 }, { x: 0.44, y: 0.42 }, { x: 0.56, y: 0.52 },
        { x: 0.42, y: 0.64 }, { x: 0.54, y: 0.76 }, { x: 0.50, y: 0.90 },
      ],
    ],
  },
  // "Wings of fire" -- the combo for a line naming both wings/an angel and
  // fire in the same breath. A wingspan with a flame-shaped tail dropping
  // from the body, since the outline's own path (wingtip-to-wingtip through
  // the body) has no pen-lift left to spare for the tail.
  phoenix: {
    outline: [
      { x: 0.50, y: 0.15 }, { x: 0.35, y: 0.35 }, { x: 0.15, y: 0.20 },
      { x: 0.02, y: 0.45 }, { x: 0.20, y: 0.62 }, { x: 0.50, y: 0.55 },
      { x: 0.80, y: 0.62 }, { x: 0.98, y: 0.45 }, { x: 0.85, y: 0.20 },
      { x: 0.65, y: 0.35 }, { x: 0.50, y: 0.15 },
    ],
    interior: [
      [
        { x: 0.50, y: 0.55 }, { x: 0.44, y: 0.72 }, { x: 0.50, y: 0.90 },
        { x: 0.56, y: 0.72 }, { x: 0.50, y: 0.55 },
      ],
    ],
  },
  // "Moonlit tide" -- the combo for a line naming both the moon and the
  // sea/tide. The moon crescent above, a wave-crest stroke below it --
  // separate because a single path can't retrace up to the crescent
  // without a straight line slashing across the water.
  moon_tide: {
    outline: [
      { x: 0.66, y: 0.02 }, { x: 0.84, y: 0.10 }, { x: 0.92, y: 0.26 },
      { x: 0.92, y: 0.42 }, { x: 0.84, y: 0.58 }, { x: 0.66, y: 0.66 },
      { x: 0.76, y: 0.56 }, { x: 0.80, y: 0.42 }, { x: 0.80, y: 0.26 },
      { x: 0.76, y: 0.12 }, { x: 0.66, y: 0.02 },
    ],
    interior: [
      [
        { x: 0.02, y: 0.88 }, { x: 0.16, y: 0.80 }, { x: 0.30, y: 0.88 },
        { x: 0.44, y: 0.80 }, { x: 0.58, y: 0.88 }, { x: 0.72, y: 0.80 },
        { x: 0.86, y: 0.88 }, { x: 0.98, y: 0.82 },
      ],
    ],
  },
  // Easter eggs
  leaf: [
    { x: 0.50, y: 0.02 }, { x: 0.72, y: 0.20 }, { x: 0.58, y: 0.28 },
    { x: 0.82, y: 0.48 }, { x: 0.62, y: 0.50 }, { x: 0.74, y: 0.74 },
    { x: 0.50, y: 0.60 }, { x: 0.50, y: 0.92 }, { x: 0.50, y: 0.60 },
    { x: 0.26, y: 0.74 }, { x: 0.38, y: 0.50 }, { x: 0.18, y: 0.48 },
    { x: 0.42, y: 0.28 }, { x: 0.28, y: 0.20 }, { x: 0.50, y: 0.02 },
  ],
  rocket: {
    outline: [
      { x: 0.50, y: 0.00 }, { x: 0.63, y: 0.20 }, { x: 0.63, y: 0.62 }, { x: 0.80, y: 0.82 }, { x: 0.63, y: 0.76 }, { x: 0.58, y: 0.90 }, { x: 0.42, y: 0.90 }, { x: 0.37, y: 0.76 }, { x: 0.20, y: 0.82 }, { x: 0.37, y: 0.62 }, { x: 0.37, y: 0.20 }, { x: 0.50, y: 0.00 },
    ],
    interior: [
      [{ x: 0.50, y: 0.30 }, { x: 0.56, y: 0.36 }, { x: 0.50, y: 0.42 }, { x: 0.44, y: 0.36 }, { x: 0.50, y: 0.30 }],
      [{ x: 0.46, y: 0.92 }, { x: 0.50, y: 1.00 }, { x: 0.54, y: 0.92 }],
    ],
  },
  alien: {
    outline: [
      { x: 0.50, y: 0.05 }, { x: 0.78, y: 0.10 }, { x: 0.92, y: 0.32 }, { x: 0.80, y: 0.60 }, { x: 0.62, y: 0.82 }, { x: 0.50, y: 0.90 }, { x: 0.38, y: 0.82 }, { x: 0.20, y: 0.60 }, { x: 0.08, y: 0.32 }, { x: 0.22, y: 0.10 }, { x: 0.50, y: 0.05 },
    ],
    interior: [
      [{ x: 0.26, y: 0.38 }, { x: 0.42, y: 0.48 }],
      [{ x: 0.74, y: 0.38 }, { x: 0.58, y: 0.48 }],
    ],
  },
  serpent: [
    { x: 0.15, y: 0.15 }, { x: 0.30, y: 0.10 }, { x: 0.50, y: 0.25 },
    { x: 0.70, y: 0.45 }, { x: 0.85, y: 0.55 },
    { x: 0.65, y: 0.70 }, { x: 0.35, y: 0.80 }, { x: 0.20, y: 0.92 },
  ],
  trident: [
    { x: 0.50, y: 0.95 }, { x: 0.50, y: 0.35 }, { x: 0.50, y: 0.05 },
    { x: 0.50, y: 0.35 }, { x: 0.20, y: 0.10 },
    { x: 0.50, y: 0.35 }, { x: 0.80, y: 0.10 },
  ],

  // Symbols for lyric THEMES rather than literal objects (see LyricLexicon's
  // symbolism layer): time, freedom, secrets, beauty, light, grief, roots,
  // steadfastness, captivity.
  hourglass: {
    outline: [
      { x: 0.22, y: 0.06 }, { x: 0.78, y: 0.06 }, { x: 0.53, y: 0.50 }, { x: 0.78, y: 0.94 }, { x: 0.22, y: 0.94 }, { x: 0.47, y: 0.50 }, { x: 0.22, y: 0.06 },
    ],
    interior: [
      [{ x: 0.12, y: 0.02 }, { x: 0.88, y: 0.02 }],
      [{ x: 0.12, y: 0.98 }, { x: 0.88, y: 0.98 }],
      [{ x: 0.36, y: 0.84 }, { x: 0.50, y: 0.72 }, { x: 0.64, y: 0.84 }],
    ],
  },
  bird: [
    { x: 0.00, y: 0.36 }, { x: 0.15, y: 0.25 }, { x: 0.32, y: 0.30 }, { x: 0.45, y: 0.48 }, { x: 0.50, y: 0.56 }, { x: 0.55, y: 0.48 }, { x: 0.68, y: 0.30 }, { x: 0.85, y: 0.25 }, { x: 1.00, y: 0.36 },
  ],
  key: {
    outline: [
      { x: 0.34, y: 0.50 }, { x: 0.32, y: 0.42 }, { x: 0.20, y: 0.36 }, { x: 0.08, y: 0.42 }, { x: 0.06, y: 0.50 }, { x: 0.08, y: 0.58 }, { x: 0.20, y: 0.64 }, { x: 0.32, y: 0.58 }, { x: 0.34, y: 0.50 }, { x: 0.96, y: 0.50 },
    ],
    interior: [
      [{ x: 0.80, y: 0.50 }, { x: 0.80, y: 0.66 }],
      [{ x: 0.90, y: 0.50 }, { x: 0.90, y: 0.62 }],
    ],
  },
  rose: {
    outline: [
      { x: 0.50, y: 0.08 }, { x: 0.68, y: 0.14 }, { x: 0.75, y: 0.30 }, { x: 0.67, y: 0.45 }, { x: 0.50, y: 0.50 }, { x: 0.33, y: 0.45 }, { x: 0.25, y: 0.30 }, { x: 0.32, y: 0.14 }, { x: 0.50, y: 0.08 },
    ],
    interior: [
      [{ x: 0.50, y: 0.20 }, { x: 0.61, y: 0.28 }, { x: 0.50, y: 0.38 }, { x: 0.41, y: 0.30 }, { x: 0.49, y: 0.25 }],
      [{ x: 0.50, y: 0.50 }, { x: 0.50, y: 0.98 }],
      [{ x: 0.50, y: 0.74 }, { x: 0.67, y: 0.64 }, { x: 0.57, y: 0.80 }],
    ],
  },
  sun: {
    outline: [
      { x: 0.50, y: 0.28 }, { x: 0.63, y: 0.32 }, { x: 0.71, y: 0.43 }, { x: 0.71, y: 0.57 }, { x: 0.63, y: 0.68 }, { x: 0.50, y: 0.72 }, { x: 0.37, y: 0.68 }, { x: 0.29, y: 0.57 }, { x: 0.29, y: 0.43 }, { x: 0.37, y: 0.32 }, { x: 0.50, y: 0.28 },
    ],
    interior: [
      [{ x: 0.80, y: 0.50 }, { x: 0.96, y: 0.50 }],
      [{ x: 0.71, y: 0.71 }, { x: 0.83, y: 0.83 }],
      [{ x: 0.50, y: 0.80 }, { x: 0.50, y: 0.96 }],
      [{ x: 0.29, y: 0.71 }, { x: 0.17, y: 0.83 }],
      [{ x: 0.20, y: 0.50 }, { x: 0.04, y: 0.50 }],
      [{ x: 0.29, y: 0.29 }, { x: 0.17, y: 0.17 }],
      [{ x: 0.50, y: 0.20 }, { x: 0.50, y: 0.04 }],
      [{ x: 0.71, y: 0.29 }, { x: 0.83, y: 0.17 }],
    ],
  },
  tear: [
    { x: 0.50, y: 0.02 }, { x: 0.64, y: 0.32 }, { x: 0.76, y: 0.58 }, { x: 0.74, y: 0.78 }, { x: 0.62, y: 0.92 }, { x: 0.50, y: 0.96 }, { x: 0.38, y: 0.92 }, { x: 0.26, y: 0.78 }, { x: 0.24, y: 0.58 }, { x: 0.36, y: 0.32 }, { x: 0.50, y: 0.02 },
  ],
  tree: {
    outline: [
      { x: 0.50, y: 0.05 }, { x: 0.72, y: 0.12 }, { x: 0.86, y: 0.30 }, { x: 0.82, y: 0.50 }, { x: 0.64, y: 0.60 }, { x: 0.50, y: 0.56 }, { x: 0.36, y: 0.60 }, { x: 0.18, y: 0.50 }, { x: 0.14, y: 0.30 }, { x: 0.28, y: 0.12 }, { x: 0.50, y: 0.05 },
    ],
    interior: [
      [{ x: 0.46, y: 0.58 }, { x: 0.46, y: 0.94 }],
      [{ x: 0.54, y: 0.58 }, { x: 0.54, y: 0.94 }],
      [{ x: 0.46, y: 0.94 }, { x: 0.34, y: 0.99 }],
      [{ x: 0.54, y: 0.94 }, { x: 0.66, y: 0.99 }],
    ],
  },
  anchor: {
    outline: [
      { x: 0.14, y: 0.62 }, { x: 0.30, y: 0.80 }, { x: 0.50, y: 0.88 }, { x: 0.70, y: 0.80 }, { x: 0.86, y: 0.62 },
    ],
    interior: [
      [{ x: 0.50, y: 0.13 }, { x: 0.50, y: 0.88 }],
      [{ x: 0.30, y: 0.25 }, { x: 0.70, y: 0.25 }],
      [{ x: 0.50, y: 0.13 }, { x: 0.56, y: 0.07 }, { x: 0.50, y: 0.01 }, { x: 0.44, y: 0.07 }, { x: 0.50, y: 0.13 }],
      [{ x: 0.14, y: 0.62 }, { x: 0.08, y: 0.72 }],
      [{ x: 0.86, y: 0.62 }, { x: 0.92, y: 0.72 }],
    ],
  },
  chain: {
    outline: [
      { x: 0.50, y: 0.28 }, { x: 0.57, y: 0.32 }, { x: 0.61, y: 0.43 }, { x: 0.61, y: 0.57 }, { x: 0.57, y: 0.68 }, { x: 0.50, y: 0.72 }, { x: 0.43, y: 0.68 }, { x: 0.39, y: 0.57 }, { x: 0.39, y: 0.43 }, { x: 0.43, y: 0.32 }, { x: 0.50, y: 0.28 },
    ],
    interior: [
      [{ x: 0.39, y: 0.50 }, { x: 0.35, y: 0.57 }, { x: 0.26, y: 0.61 }, { x: 0.14, y: 0.61 }, { x: 0.05, y: 0.57 }, { x: 0.01, y: 0.50 }, { x: 0.05, y: 0.43 }, { x: 0.14, y: 0.39 }, { x: 0.26, y: 0.39 }, { x: 0.35, y: 0.43 }, { x: 0.39, y: 0.50 }],
      [{ x: 0.61, y: 0.50 }, { x: 0.65, y: 0.43 }, { x: 0.74, y: 0.39 }, { x: 0.86, y: 0.39 }, { x: 0.95, y: 0.43 }, { x: 0.99, y: 0.50 }, { x: 0.95, y: 0.57 }, { x: 0.86, y: 0.61 }, { x: 0.74, y: 0.61 }, { x: 0.65, y: 0.57 }, { x: 0.61, y: 0.50 }],
    ],
  },
};

// ── Single-stroke font for sky writing ─────────────────────────────────
// Each letter: { width, strokes: [ [{x,y}, ...], ... ] }
// Coordinates in a cell where x∈[0,w] and y∈[0,1] (top=0, bottom=1).
// Multiple strokes = pen-up between them (the trail records a gap).

const _F = {
  A: { w: 0.8, s: [[[0, 1], [0.4, 0], [0.8, 1]], [[0.15, 0.6], [0.65, 0.6]]] },
  B: { w: 0.7, s: [[[0, 1], [0, 0], [0.5, 0], [0.7, 0.12], [0.7, 0.38], [0.5, 0.5], [0, 0.5]], [[0.5, 0.5], [0.7, 0.62], [0.7, 0.88], [0.5, 1], [0, 1]]] },
  C: { w: 0.7, s: [[[0.7, 0.15], [0.45, 0], [0.2, 0], [0, 0.2], [0, 0.8], [0.2, 1], [0.45, 1], [0.7, 0.85]]] },
  D: { w: 0.7, s: [[[0, 1], [0, 0], [0.4, 0], [0.7, 0.2], [0.7, 0.8], [0.4, 1], [0, 1]]] },
  E: { w: 0.65, s: [[[0.65, 0], [0, 0], [0, 1], [0.65, 1]], [[0, 0.5], [0.5, 0.5]]] },
  F: { w: 0.6, s: [[[0.6, 0], [0, 0], [0, 1]], [[0, 0.5], [0.45, 0.5]]] },
  G: { w: 0.75, s: [[[0.7, 0.15], [0.45, 0], [0.18, 0], [0, 0.2], [0, 0.8], [0.18, 1], [0.52, 1], [0.75, 0.82], [0.75, 0.5], [0.45, 0.5]]] },
  H: { w: 0.7, s: [[[0, 0], [0, 1]], [[0.7, 0], [0.7, 1]], [[0, 0.5], [0.7, 0.5]]] },
  I: { w: 0.15, s: [[[0.075, 0], [0.075, 1]]] },
  J: { w: 0.55, s: [[[0.55, 0], [0.55, 0.78], [0.38, 1], [0.18, 1], [0, 0.82]]] },
  K: { w: 0.7, s: [[[0, 0], [0, 1]], [[0.7, 0], [0, 0.5], [0.7, 1]]] },
  L: { w: 0.6, s: [[[0, 0], [0, 1], [0.6, 1]]] },
  M: { w: 0.9, s: [[[0, 1], [0, 0], [0.45, 0.45], [0.9, 0], [0.9, 1]]] },
  N: { w: 0.7, s: [[[0, 1], [0, 0], [0.7, 1], [0.7, 0]]] },
  O: { w: 0.75, s: [[[0.38, 0], [0.7, 0.15], [0.75, 0.5], [0.7, 0.85], [0.38, 1], [0.08, 0.85], [0, 0.5], [0.08, 0.15], [0.38, 0]]] },
  P: { w: 0.7, s: [[[0, 1], [0, 0], [0.5, 0], [0.7, 0.12], [0.7, 0.38], [0.5, 0.5], [0, 0.5]]] },
  Q: { w: 0.75, s: [[[0.38, 0], [0.7, 0.15], [0.75, 0.5], [0.7, 0.85], [0.38, 1], [0.08, 0.85], [0, 0.5], [0.08, 0.15], [0.38, 0]], [[0.52, 0.78], [0.78, 1.02]]] },
  R: { w: 0.7, s: [[[0, 1], [0, 0], [0.5, 0], [0.7, 0.12], [0.7, 0.38], [0.5, 0.5], [0, 0.5]], [[0.42, 0.5], [0.7, 1]]] },
  S: { w: 0.65, s: [[[0.62, 0.12], [0.45, 0], [0.2, 0], [0, 0.15], [0, 0.35], [0.2, 0.5], [0.45, 0.5], [0.65, 0.65], [0.65, 0.85], [0.45, 1], [0.2, 1], [0.03, 0.88]]] },
  T: { w: 0.7, s: [[[0, 0], [0.7, 0]], [[0.35, 0], [0.35, 1]]] },
  U: { w: 0.7, s: [[[0, 0], [0, 0.78], [0.15, 1], [0.55, 1], [0.7, 0.78], [0.7, 0]]] },
  V: { w: 0.8, s: [[[0, 0], [0.4, 1], [0.8, 0]]] },
  W: { w: 1.0, s: [[[0, 0], [0.22, 1], [0.5, 0.42], [0.78, 1], [1, 0]]] },
  X: { w: 0.7, s: [[[0, 0], [0.7, 1]], [[0.7, 0], [0, 1]]] },
  Y: { w: 0.7, s: [[[0, 0], [0.35, 0.5], [0.7, 0]], [[0.35, 0.5], [0.35, 1]]] },
  Z: { w: 0.7, s: [[[0, 0], [0.7, 0], [0, 1], [0.7, 1]]] },
  "'": { w: 0.12, s: [[[0.06, 0], [0.04, 0.12]]] },
  '!': { w: 0.12, s: [[[0.06, 0], [0.06, 0.65]], [[0.06, 0.85], [0.06, 0.92]]] },
};

const CHAR_GAP = 0.15;
const SPACE_W = 0.35;

/** Build a flat path array for sky-writing text. Each entry is {x, y, gap}
 *  where gap=true means pen-up (don't stroke from the previous point).
 *  Coordinates are in a roughly unit-scale space centered at origin. */
export function layoutTextPath(text) {
  if (!text) return [];
  const upper = text.toUpperCase();

  // Measure total width.
  let totalW = 0;
  for (const ch of upper) {
    if (ch === ' ') { totalW += SPACE_W; continue; }
    const def = _F[ch];
    if (!def) continue;
    totalW += def.w + CHAR_GAP;
  }
  if (totalW > CHAR_GAP) totalW -= CHAR_GAP;
  if (totalW <= 0) return [];

  // Normalize so the text spans roughly -1..1 in x.
  const scale = 2 / Math.max(totalW, 0.5);
  const charH = 0.55; // character height relative to width scale

  const path = [];
  let cx = -totalW / 2;

  for (const ch of upper) {
    if (ch === ' ') { cx += SPACE_W; continue; }
    const def = _F[ch];
    if (!def) continue;

    for (const stroke of def.s) {
      for (let i = 0; i < stroke.length; i++) {
        const pt = stroke[i];
        path.push({
          x: (cx + pt[0]) * scale,
          y: (pt[1] - 0.5) * charH * scale,
          gap: i === 0 && path.length > 0,
        });
      }
    }
    cx += def.w + CHAR_GAP;
  }

  return path;
}

/** Place glyph dots into a sky region. Returns an array of {x, y}
 *  pixel positions scattered around (cx, cy) at the given size, with
 *  clamping to stay within bounds. */
/** Accepts either authoring form a GLYPH_SHAPES entry can take (a flat dot
 *  array, or `{outline, interior}`) and always returns the latter, so every
 *  consumer only ever has to handle one shape. */
export function normalizeGlyphShape(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) return { outline: raw, interior: [] };
  return { outline: raw.outline || [], interior: raw.interior || [] };
}

/** Place a glyph into a sky region. Returns `{outline, interior}`: `outline`
 *  is the array of {x,y} pixel positions the weaver connects sequentially
 *  (unchanged shape, just placed/scaled/clamped), and `interior` is the
 *  array of separately-stroked detail lines (each already placed the same
 *  way), empty for a glyph authored as a plain dot chain. `null` for an
 *  unknown glyph id. */
export function placeGlyph(glyphId, cx, cy, size, bounds) {
  const shape = normalizeGlyphShape(GLYPH_SHAPES[glyphId]);
  if (!shape) return null;
  const place = (d) => ({
    x: clamp(cx + (d.x - 0.5) * size, bounds.xMin, bounds.xMax),
    y: clamp(cy + (d.y - 0.5) * size * 0.85, bounds.yMin, bounds.yMax),
  });
  return {
    outline: shape.outline.map(place),
    interior: shape.interior.map((stroke) => stroke.map(place)),
  };
}

/** A glyph as one pen path for Midasus to sky-write: the outline, then each
 *  interior stroke after a pen-lift. Same {x, y, gap} form and roughly
 *  -1..1 extent as layoutTextPath, so SkyVoyage can trace a lyric SYMBOL
 *  exactly the way it traces lyric text. Empty for an unknown glyph. */
export function glyphTracePath(glyphId) {
  const shape = normalizeGlyphShape(GLYPH_SHAPES[glyphId]);
  if (!shape || shape.outline.length < 2) return [];
  const map = (d, gap) => ({ x: (d.x - 0.5) * 2, y: (d.y - 0.5) * 2 * 0.85, gap });
  const path = shape.outline.map((d, i) => map(d, false));
  for (const stroke of shape.interior) stroke.forEach((d, i) => path.push(map(d, i === 0)));
  return path;
}
