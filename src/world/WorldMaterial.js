// Scenic-poster material language.
//
// The Halloween read — black cutout ridges, a creamy moonlight rim, purple-
// orange night, a void underfoot with roots hanging into it — is what you
// get when every landform is a HOLE in the sky. This recipe uses
// limited-value scenic painting: WPA
// travel posters, woodblock prints, animation background plates. Colored
// masses, a ground that is a different material from the ridge, rims in the
// world's own light, no moonlight edge on cardboard teeth.
//
// Current world landforms are described in docs/worlds.md. This file is the
// paint and the bake recipe those landforms use. Landscape and Trio are both
// the alpine kind; an unknown kind reads the alpine recipe.
import { clamp01 } from '../utils/math.js';
import { hexToRgb, rgbToHex, rgbToHsl, hslToRgb, hexLerp } from '../utils/color.js';
import { shiftLightness, ensureMinLightness } from '../render/VisualStyle.js';

export const CATCHLIGHT = {
  // Low sun on the crest — warm light, not ghost-cream.
  warm: { r: 255, g: 220, b: 176 },
};

const LAYERS = {
  alpine: {
    L2: { profile: 'alpine', characterIndex: 0, amplitude: 0.50, baseline: 0.44, height: 400, octaves: 4, soften: 0.40, anchor: 'ground' },
    L3: { profile: 'alpine', characterIndex: 1, amplitude: 0.42, baseline: 0.52, height: 360, octaves: 3, soften: 0.62, anchor: 'ground' },
    L4: { profile: 'alpine', characterIndex: 2, amplitude: 0.32, baseline: 0.66, height: 330, octaves: 3, soften: 0.85, anchor: 'ground' },
    L5: { profile: 'rolling', characterIndex: null, amplitude: 0.40, baseline: 0.84, height: 220, octaves: 2, soften: 1, anchor: 'ground' },
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
  return { css: `rgba(${r},${g},${b},${a})`, alpha: a, width: 1.8 };
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

/** Far-layer mix toward a material's `deep` color, for a layer bake that
 *  sets `depthMix`. The alpine recipe sets neither, so this is identity. */
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
