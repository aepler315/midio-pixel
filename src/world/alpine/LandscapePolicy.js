import { hexLerp, hexToRgb, rgbToHsl, hslToRgb, rgbToHex } from '../../utils/color.js';
import { shiftLightness } from '../../render/VisualStyle.js';

// Artistic cover and material permissions, keyed by the actual real-biome name.
const ROWS = {
  ICEFIELD: [0.10, 0, 'ice', true],
  TUNDRA: [0.25, 0.10, 'mat', true],
  TAIGA: [0.55, 0.75, 'conifer', true],
  RAINFOREST: [0.85, 0.90, 'conifer', false],
  CONIFER: [0.45, 0.65, 'conifer', false],
  PINE_OAK: [0.25, 0.45, 'broadleaf', false],
  BROADLEAF: [0.55, 0.65, 'broadleaf', false],
  CHAPARRAL: [0.10, 0.25, 'scrub', false],
  STEPPE: [0.05, 0.10, 'grass', false],
  CANYON: [0.02, 0.10, 'stone', false],
  DESERT: [0, 0, 'sand', false],
};
const POLICIES = Object.fromEntries(Object.entries(ROWS).map(([key, [moisture, canopy, cover, snowAllowed]]) =>
  [key, Object.freeze({ key, moisture, canopy, cover, snowAllowed })]));
const DEFAULT = Object.freeze({ key: 'CUSTOM', moisture: 0, canopy: 0.08, cover: 'stone', snowAllowed: false });
const ALPINE_PASSES = Object.freeze({ scenicWire: false, connector: false, distantWavePaint: false, fullHaze: false, shimmerSlices: false });
const OTHER_PASSES = Object.freeze({ scenicWire: true, connector: true, distantWavePaint: true, fullHaze: true, shimmerSlices: true });

export function landscapePolicy(key) { return POLICIES[key] || DEFAULT; }
export function landscapeSnowAllowed(key, snowLine01) {
  const policy = landscapePolicy(key);
  return policy.snowAllowed || (['RAINFOREST', 'CONIFER'].includes(policy.key) && snowLine01 >= .9);
}
export function landscapePasses(kind) { return kind === 'alpine' ? ALPINE_PASSES : OTHER_PASSES; }
export function landscapeBudget(level = 0) {
  if (level >= 6) return { facetsPerLayer: 6, gulliesPerLayer: 0, standsPerLayer: 6, fogBanks: 0, localWetFx: false, groundPatches: 8, wetReceivers: 0, oceanRows: 3 };
  if (level >= 3) return { facetsPerLayer: 12, gulliesPerLayer: 4, standsPerLayer: 12, fogBanks: 2, localWetFx: false, groundPatches: 16, wetReceivers: 4, oceanRows: 5 };
  return { facetsPerLayer: 24, gulliesPerLayer: 12, standsPerLayer: 24, fogBanks: 4, localWetFx: true, groundPatches: 24, wetReceivers: 6, oceanRows: 8 };
}

function finite01(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

// Subdued mineral anchors. Depth and night shift these; they are not a second body paint.
const ANCHORS = {
  ICEFIELD: { mass: '#8ea4b0', soil: '#6e7c86', mineral: '#9aa8b0', organic: '#6d7c78', wet: '#5d7a86' },
  TUNDRA: { mass: '#7d8a78', soil: '#6a6456', mineral: '#8a8474', organic: '#5e6b58', wet: '#4e665c' },
  TAIGA: { mass: '#4d6254', soil: '#3c4638', mineral: '#6a6458', organic: '#2f4a38', wet: '#2a4450' },
  RAINFOREST: { mass: '#3d5344', soil: '#2c382c', mineral: '#4a5648', organic: '#1e3a2c', wet: '#1a3840' },
  CONIFER: { mass: '#51624e', soil: '#3e4638', mineral: '#6a6456', organic: '#2e4634', wet: '#2c4450' },
  PINE_OAK: { mass: '#6a624c', soil: '#5a4e3c', mineral: '#7a7060', organic: '#4a5838', wet: '#3a4c48' },
  BROADLEAF: { mass: '#5a6848', soil: '#463e32', mineral: '#6a6050', organic: '#3a4c32', wet: '#2e4440' },
  CHAPARRAL: { mass: '#7a6a52', soil: '#6a5a42', mineral: '#8a7a64', organic: '#5a5a3a', wet: '#4a5044' },
  STEPPE: { mass: '#8a7a58', soil: '#7a6a48', mineral: '#8e8068', organic: '#6a7040', wet: '#4a5444' },
  CANYON: { mass: '#8a5a48', soil: '#7a5240', mineral: '#a07058', organic: '#5a5840', wet: '#4a4440' },
  DESERT: { mass: '#a89068', soil: '#9a845c', mineral: '#b8a888', organic: '#7a7048', wet: '#6a6450' },
  CUSTOM: { mass: '#6e6a62', soil: '#5c5852', mineral: '#7a766e', organic: '#5a5e52', wet: '#4a504c' },
};
const AIR_MIX = { L2: 0.32, L3: 0.18, L4: 0.08, L5: 0 };
const LAYER_LIFT = { L2: 0.08, L3: 0.03, L4: -0.03, L5: -0.08 };

function anchorFor(key) { return ANCHORS[key] || ANCHORS.CUSTOM; }

// Distance already mixes the mineral with the air. A light/shade adjustment
// must not remove saturation again: repeated VisualStyle shifts made pale-sky
// forest faces completely gray before they reached the canvas.
function materialLightness(hex, delta) {
  const { r, g, b } = hexToRgb(hex);
  const { h, s, l } = rgbToHsl(r, g, b);
  const rgb = hslToRgb(h, s, Math.max(0, Math.min(1, l + delta)));
  return rgbToHex(rgb.r, rgb.g, rgb.b);
}

function layerTone(mass, air, layerKey, night01, organic) {
  const atDepth = (color) => {
    const mixed = hexLerp(color, air || color, AIR_MIX[layerKey] ?? 0);
    const lifted = materialLightness(mixed, (LAYER_LIFT[layerKey] ?? 0) * (1 - night01 * 0.35));
    return night01 > 0 ? materialLightness(lifted, -0.26 * night01) : lifted;
  };
  const base = atDepth(mass);
  return {
    base,
    cover: atDepth(organic),
    faceLight: materialLightness(base, 0.09 * (1 - night01 * 0.4)),
    faceShade: materialLightness(base, -0.11),
    gully: materialLightness(base, -0.16),
    intrinsicContrast: 1,
  };
}

/** One biome profile, one palette. Callers resolve A and B separately. */
export function resolveLandscapePalette({ profile, night01, airColor } = {}) {
  const biomeKey = landscapePolicy(profile?.landmarkKey || profile?.name || profile?.key || profile).key;
  const anchor = anchorFor(biomeKey);
  const night = finite01(night01, 0);
  const air = typeof airColor === 'string' && airColor.startsWith('#') ? airColor : anchor.mass;
  const authored = typeof profile?.silhouette === 'string' && profile.silhouette.startsWith('#')
    ? profile.silhouette : null;
  const mass = authored ? hexLerp(anchor.mass, authored, biomeKey === 'CUSTOM' ? 0.42 : 0.10) : anchor.mass;
  const soil = authored ? hexLerp(anchor.soil, authored, biomeKey === 'CUSTOM' ? 0.28 : 0.06) : anchor.soil;
  const groundBase = shiftLightness(hexLerp(soil, air, 0.06), -0.04 - 0.16 * night);
  return {
    biomeKey,
    layers: {
      L2: layerTone(mass, air, 'L2', night, anchor.organic),
      L3: layerTone(mass, air, 'L3', night, anchor.organic),
      L4: layerTone(mass, air, 'L4', night, anchor.organic),
      L5: layerTone(mass, air, 'L5', night, anchor.organic),
    },
    ground: {
      base: groundBase,
      shallowShade: shiftLightness(groundBase, -0.05),
      deepShade: shiftLightness(groundBase, -0.12),
      mineral: shiftLightness(anchor.mineral, -0.08 * night),
      organic: shiftLightness(anchor.organic, -0.06 * night),
      wet: shiftLightness(anchor.wet, -0.05 * night),
    },
    cover: landscapePolicy(biomeKey).cover,
  };
}

/** Alpine sky weights. Reconstructed from the current scene, never accumulated. */
export function resolveRangePresentation({
  night01 = 0, salienceSky = 1, voyageWeight = 0, quality = 0,
} = {}) {
  const sky = finite01(salienceSky, 1);
  const voyage = finite01(voyageWeight, 0);
  const night = finite01(night01, 0);
  const ambientScale = sky * (1 - 0.62 * voyage);
  const rows = landscapeBudget(Number.isFinite(quality) ? quality : 0).oceanRows;
  const unit = (n) => finite01(n, 0);
  return {
    // The cosmic ridge is the authored Range signature, not ambient garnish.
    spaceRidge: 1,
    liveWeaver: unit(0.30 * (0.55 + 0.45 * sky) * (1 - 0.35 * voyage)),
    retainedWeaver: unit(0.20 * ambientScale * (0.85 + 0.15 * night)),
    ensemble: unit(0.30 * ambientScale),
    beams: unit(0.15 * sky),
    ambient: unit(0.35 * ambientScale),
    oceanRows: rows,
    oceanMarks: unit(0.30),
    film: unit(0.82 * (0.75 + 0.25 * sky)),
  };
}

export function landscapeLayerColor(silhouetteHex, skyHex, layerKey, biomeKey) {
  const mix = { L2: .30, L3: .15, L4: .04, L5: 0 }[layerKey] ?? 0;
  const lift = { L2: .04, L3: .02, L4: 0, L5: -.02 }[layerKey] ?? 0;
  // Biome identity stays in the source hue; the sky mix is depth, not a new palette.
  void biomeKey;
  return shiftLightness(hexLerp(silhouetteHex, skyHex || silhouetteHex, mix), lift);
}

/** Whether the legacy sea plane belongs behind the Range v2 views on screen
 *  (natural-rendering Task 5). It is a stylised background ocean at a fixed
 *  horizon; behind an inland catalog view it showed through the gaps between
 *  real ridges as a flat teal strip. Only a view that opts in with
 *  `seaHorizon: true` keeps it; glacier views never did. `views` are the
 *  caption views v2 draws (null entries are legacy biomes, which keep it). */
export function rangeDrawsSea(views = []) {
  return !views.some(v => v && (v.glacier || !v.seaHorizon));
}
