// Scenic-poster material language.
//
// The Halloween read — black cutout ridges, a creamy moonlight rim, purple-
// orange night, a void underfoot with roots hanging into it — is what you
// get when every landform is a HOLE in the sky. We do not replace that with
// photoreal rock. We replace it with limited-value scenic painting: WPA
// travel posters, woodblock prints, animation background plates. Colored
// masses, a ground that is a different material from the ridge, rims in the
// world's own light, no moonlight edge on cardboard teeth.
//
// A world is still a landform contract (docs/worlds.md). This file is the
// paint and the bake recipe those landforms use, so six worlds cannot
// converge on "Range, but night."
import { clamp01 } from '../utils/math.js';
import { hexToRgb, rgbToHex, rgbToHsl, hslToRgb, hexLerp } from '../utils/color.js';
import { shiftLightness, ensureMinLightness } from '../render/VisualStyle.js';

export const CATCHLIGHT = {
  none: null,
  // Sun on stone — warm paper, not ghost-cream.
  stone: { r: 236, g: 228, b: 214 },
  warm: { r: 255, g: 220, b: 176 },
  cool: { r: 176, g: 214, b: 214 },
  ember: { r: 255, g: 168, b: 88 },
  glass: { r: 232, g: 214, b: 255 },
};

const LAYERS = {
  alpine: {
    L2: { profile: 'alpine', characterIndex: 0, amplitude: 0.50, baseline: 0.44, height: 400, octaves: 4, soften: 0.40, anchor: 'ground' },
    L3: { profile: 'alpine', characterIndex: 1, amplitude: 0.42, baseline: 0.52, height: 360, octaves: 3, soften: 0.62, anchor: 'ground' },
    L4: { profile: 'alpine', characterIndex: 2, amplitude: 0.32, baseline: 0.66, height: 330, octaves: 3, soften: 0.85, anchor: 'ground' },
    L5: { profile: 'rolling', characterIndex: null, amplitude: 0.40, baseline: 0.84, height: 220, octaves: 2, soften: 1, anchor: 'ground' },
  },
  city: {
    L2: { profile: 'city', amplitude: 0.56, baseline: 0.38, height: 400, octaves: 3, soften: 0.88, anchor: 'ground' },
    L3: { profile: 'city', amplitude: 0.46, baseline: 0.46, height: 360, octaves: 3, soften: 0.94, anchor: 'ground' },
    L4: { profile: 'city', amplitude: 0.30, baseline: 0.66, height: 300, octaves: 2, soften: 1, anchor: 'ground' },
    L5: { profile: 'city', amplitude: 0.12, baseline: 0.92, height: 220, octaves: 2, soften: 1, anchor: 'ground' },
  },
  airless: {
    // Limb, not a mountain: low amplitude, no aerial softening, no teeth.
    L2: { profile: 'alpine', characterIndex: 0, amplitude: 0.18, baseline: 0.62, height: 280, octaves: 3, soften: 1, anchor: 'ground', teethMax: 0.02 },
    L3: { profile: 'alpine', characterIndex: 1, amplitude: 0.22, baseline: 0.58, height: 300, octaves: 3, soften: 1, anchor: 'ground', teethMax: 0.03 },
    L4: { profile: 'rolling', characterIndex: null, amplitude: 0.16, baseline: 0.72, height: 260, octaves: 2, soften: 1, anchor: 'ground' },
    L5: { profile: 'rolling', characterIndex: null, amplitude: 0.08, baseline: 0.88, height: 200, octaves: 2, soften: 1, anchor: 'ground' },
  },
  abyssal: {
    L2: { profile: 'rolling', amplitude: 0.22, baseline: 0.28, height: 280, octaves: 3, soften: 0.9, anchor: 'ceiling', depthMix: 0.50 },
    L3: { profile: 'alpine', characterIndex: 1, amplitude: 0.34, baseline: 0.22, height: 320, octaves: 3, soften: 0.85, anchor: 'ceiling', depthMix: 0.32, teethMax: 0.04 },
    L4: { profile: 'alpine', characterIndex: 2, amplitude: 0.28, baseline: 0.70, height: 300, octaves: 3, soften: 0.94, anchor: 'ground', depthMix: 0.14, teethMax: 0.05 },
    L5: { profile: 'rolling', amplitude: 0.10, baseline: 0.90, height: 200, octaves: 2, soften: 1, anchor: 'ground' },
  },
  strip: {
    L2: { profile: 'rolling', amplitude: 0.16, baseline: 0.62, height: 240, octaves: 2, soften: 0.7, anchor: 'ground' },
    L3: { profile: 'rolling', amplitude: 0.10, baseline: 0.70, height: 220, octaves: 2, soften: 0.85, anchor: 'ground' },
    L4: { profile: 'rolling', amplitude: 0.06, baseline: 0.82, height: 200, octaves: 2, soften: 1, anchor: 'ground' },
    L5: { profile: 'rolling', amplitude: 0.03, baseline: 0.92, height: 160, octaves: 1, soften: 1, anchor: 'ground' },
  },
  foundry: {
    L2: { profile: 'columnar', amplitude: 0.48, baseline: 0.42, height: 380, octaves: 2, soften: 0.7, anchor: 'ground', colH: 0.92, archAmp: 0.18, bayPx: 140 },
    L3: { profile: 'columnar', amplitude: 0.36, baseline: 0.52, height: 340, octaves: 2, soften: 0.82, anchor: 'ground', colH: 0.70, archAmp: 0.12, bayPx: 110 },
    L4: { profile: 'rolling', amplitude: 0.20, baseline: 0.70, height: 280, octaves: 3, soften: 0.94, anchor: 'ground' },
    L5: { profile: 'rolling', amplitude: 0.10, baseline: 0.88, height: 200, octaves: 2, soften: 1, anchor: 'ground' },
  },
  overgrowth: {
    L2: { profile: 'rolling', amplitude: 0.28, baseline: 0.20, height: 360, octaves: 4, soften: 0.75, anchor: 'ceiling' },
    L3: { profile: 'alpine', characterIndex: 1, amplitude: 0.30, baseline: 0.28, height: 340, octaves: 3, soften: 0.82, anchor: 'ceiling', teethMax: 0.06 },
    L4: { profile: 'columnar', amplitude: 0.55, baseline: 0.58, height: 360, octaves: 2, soften: 1, anchor: 'ground', colH: 0.95, archAmp: 0.08, bayPx: 88, colFrac: 0.16, organic: true },
    L5: { profile: 'rolling', amplitude: 0.18, baseline: 0.88, height: 200, octaves: 3, soften: 1, anchor: 'ground' },
  },
  nave: {
    L2: { profile: 'columnar', amplitude: 0.40, baseline: 0.18, height: 360, octaves: 2, soften: 0.8, anchor: 'ceiling', colH: 0.55, archAmp: 0.42, bayPx: 128, colFrac: 0.18 },
    L3: { profile: 'columnar', amplitude: 0.46, baseline: 0.48, height: 340, octaves: 2, soften: 0.9, anchor: 'ground', colH: 0.72, archAmp: 0.28, bayPx: 112, colFrac: 0.16 },
    L4: { profile: 'columnar', amplitude: 0.58, baseline: 0.55, height: 360, octaves: 2, soften: 1, anchor: 'ground', colH: 0.96, archAmp: 0.22, bayPx: 96, colFrac: 0.20 },
    L5: { profile: 'rolling', amplitude: 0.08, baseline: 0.90, height: 180, octaves: 2, soften: 1, anchor: 'ground' },
  },
};

export const KIND_MATERIAL = {
  alpine: {
    fillLift: 0.05,
    rimAlpha: 0.12,
    catchlight: 'warm',
    aerial: true,
    scheme: 'song',
    ground: { hueShift: 18, satAdd: 0.06, lightAdd: 0.18, voidAlpha: 0.20, roots: true, minL: 0.34, aerial: true },
    layers: LAYERS.alpine,
    deep: null,
  },
  city: {
    fillLift: 0.04,
    rimAlpha: 0.08,
    catchlight: 'stone',
    aerial: true,
    scheme: null,
    ground: { hueShift: -12, satAdd: -0.04, lightAdd: 0.16, voidAlpha: 0.28, roots: false, minL: 0.22, aerial: true },
    layers: LAYERS.city,
    deep: null,
  },
  airless: {
    fillLift: 0.08,
    rimAlpha: 0.04,
    catchlight: 'none',
    aerial: false,
    scheme: 'monumental',
    ground: { hueShift: 0, satAdd: -0.16, lightAdd: 0.10, voidAlpha: 0.06, roots: false, minL: 0.22, aerial: false },
    layers: LAYERS.airless,
    deep: null,
  },
  abyssal: {
    fillLift: 0.04,
    rimAlpha: 0.10,
    catchlight: 'cool',
    aerial: 'invert',
    scheme: 'monumental',
    ground: { hueShift: 8, satAdd: 0.04, lightAdd: 0.10, voidAlpha: 0.45, roots: false, minL: 0.16, aerial: false },
    layers: LAYERS.abyssal,
    deep: '#020a0e',
  },
  strip: {
    fillLift: 0.06,
    rimAlpha: 0.10,
    catchlight: 'warm',
    aerial: true,
    scheme: null,
    ground: { hueShift: -8, satAdd: 0.10, lightAdd: 0.14, voidAlpha: 0.18, roots: false, minL: 0.24, aerial: true },
    layers: LAYERS.strip,
    deep: null,
  },
  foundry: {
    fillLift: 0.05,
    rimAlpha: 0.10,
    catchlight: 'ember',
    aerial: true,
    scheme: 'monumental',
    ground: { hueShift: 14, satAdd: 0.12, lightAdd: 0.12, voidAlpha: 0.32, roots: false, minL: 0.18, aerial: true },
    layers: LAYERS.foundry,
    deep: null,
  },
  overgrowth: {
    fillLift: 0.06,
    rimAlpha: 0.08,
    catchlight: 'stone',
    aerial: true,
    scheme: 'monumental',
    ground: { hueShift: 28, satAdd: 0.10, lightAdd: 0.16, voidAlpha: 0.24, roots: true, minL: 0.22, aerial: true },
    layers: LAYERS.overgrowth,
    deep: null,
  },
  nave: {
    fillLift: 0.06,
    rimAlpha: 0.10,
    catchlight: 'glass',
    aerial: true,
    scheme: null,
    ground: { hueShift: -6, satAdd: -0.06, lightAdd: 0.14, voidAlpha: 0.36, roots: false, minL: 0.20, aerial: true },
    layers: LAYERS.nave,
    deep: null,
  },
};

export function materialFor(kind) {
  return KIND_MATERIAL[kind] || KIND_MATERIAL.alpine;
}

export function layerBake(kind, layerKey) {
  const mat = materialFor(kind);
  return mat.layers[layerKey] || KIND_MATERIAL.alpine.layers[layerKey];
}

/** Rim along a baked skyline: the world's own light, never moonlight cream. */
export function rimStroke(color, kind) {
  const mat = materialFor(kind);
  const lifted = shiftLightness(color, 0.28);
  const { r, g, b } = hexToRgb(lifted);
  const a = mat.rimAlpha;
  return { css: `rgba(${r},${g},${b},${a})`, alpha: a, width: kind === 'city' ? 1.2 : 1.8 };
}

export function catchlightRgb(kind) {
  const mat = materialFor(kind);
  return CATCHLIGHT[mat.catchlight] || null;
}

function wrapHue(h) {
  let x = h % 360;
  if (x < 0) x += 360;
  return x;
}

export function shiftHueHex(hex, deg) {
  const { r, g, b } = hexToRgb(hex);
  const hsl = rgbToHsl(r, g, b);
  const rgb = hslToRgb(wrapHue(hsl.h + deg), hsl.s, hsl.l);
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

/**
 * Ground is a different material from the ridge, not the same cutout
 * continued downward. Hue-shifted, a little more (or less) chroma, lifted
 * so the film-grade wash cannot eat it.
 */
export function groundColorFor(silhouetteHex, kind) {
  const mat = materialFor(kind);
  const g = mat.ground;
  const { r, g: gg, b } = hexToRgb(silhouetteHex);
  const hsl = rgbToHsl(r, gg, b);
  const s = clamp01(hsl.s + (g.satAdd || 0));
  const l = clamp01(hsl.l + (g.lightAdd || 0));
  const rgb = hslToRgb(wrapHue(hsl.h + (g.hueShift || 0)), s, l);
  return ensureMinLightness(rgbToHex(rgb.r, rgb.g, rgb.b), g.minL ?? 0.30);
}

/** Far-layer mix toward a world's deep color (Fathom's water column). */
export function layerColor(silhouetteHex, kind, layerKey) {
  const mat = materialFor(kind);
  const bake = layerBake(kind, layerKey);
  const mix = bake.depthMix || 0;
  if (mix > 0.001 && mat.deep) return hexLerp(silhouetteHex, mat.deep, mix);
  return silhouetteHex;
}

export function terrainModsForLayer(baseMods, bake) {
  if (!bake?.teethMax && bake?.teethMax !== 0) return baseMods;
  const next = { ...(baseMods || {}) };
  const cap = bake.teethMax;
  const current = (baseMods?.teethAdd ?? 0);
  // Force the resulting teeth (character.teeth + teethAdd) under the cap
  // by shrinking the add. The generator clamps add onto the character;
  // a negative add is how a world refuses spiky Halloween teeth.
  next.teethAdd = Math.min(current, cap - 0.20);
  return next;
}
