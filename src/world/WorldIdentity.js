import { hexLerp } from '../utils/color.js';
// The visual facts that must survive song adaptation.
//
// A world may take on a song's color, timing, and terrain variation, but it
// may not lose the landmark and atmosphere that make it recognizable. Keep
// these policies keyed by kind: adapted worlds use the `custom` overlay id,
// while their kind remains the selected world's stable visual identity.

function policy({
  kind, landmark, signatureMotion, lightSource, paletteFloor, castPlacement,
  sharedEffects, vocabulary, foreground, supportLight = 1,
}) {
  return Object.freeze({
    kind,
    landmark,
    signatureMotion,
    lightSource,
    paletteFloor,
    castPlacement,
    vocabulary: Object.freeze(Object.fromEntries(Object.entries(vocabulary).map(([key, value]) => [key, Array.isArray(value) ? Object.freeze(value) : value]))),
    foreground: Object.freeze(foreground),
    supportLight,
    sharedEffects: Object.freeze({ ...sharedEffects }),
  });
}

const OPEN_SKY = Object.freeze({ astronomy: true, celestialBodies: true, deepSky: true, constellations: true, meteors: true });
const ENCLOSED = Object.freeze({ astronomy: false, celestialBodies: false, deepSky: false, constellations: false, meteors: false });

export const WORLD_IDENTITIES = Object.freeze({
  alpine: policy({
    kind: 'alpine',
    vocabulary: { particles: ["snow", "petals", "embers", "pollen", "spores", "sunshine", "rain", "wind", "antigrav", "fireflies", "flaresparks", "fog", "bubbles", "digitalrain"], effects: ["aurora", "nebulaBloom", "starTwinkle", "bioluminescence", "canopyDapple", "godRays", "mirage", "petalPile", "sunMotes", "crystalGlint", "prominence", "lightning"], landmarks: ["JADE", "ARCTIC", "STORM", "MIRROR", "DUNE", "GEODE"] },
    foreground: { maxHeight: 0.18, hanging: false },
    landmark: 'a ridge line spanning the lower frame',
    signatureMotion: 'slow breathing contours',
    lightSource: 'a horizon sun or moon',
    paletteFloor: 0.22,
    castPlacement: 'figures cross the foreground ridge, never float in the sky',
    // Ocean walls, the flood they spill, and the camera accent on arrival
    // belong to the range that actually has a sea. Other worlds do not
    // inherit that hazard just because they share the manager.
    sharedEffects: { ...OPEN_SKY, ocean: true },
  }),
  city: policy({
    kind: 'city',
    supportLight: 0.55,
    vocabulary: { particles: ["rain", "embers"], effects: ["starTwinkle", "neonGrid", "emberGlow", "sunMotes"], landmarks: ["CYBER"] },
    foreground: { maxHeight: 0.2, hanging: false },
    landmark: 'a layered skyline with lit districts',
    signatureMotion: 'window districts pulse with the groove',
    lightSource: 'street glow and a restrained moon',
    paletteFloor: 0.36,
    castPlacement: 'figures remain street-level, framed by buildings',
    sharedEffects: OPEN_SKY,
  }),
  airless: policy({
    kind: 'airless',
    supportLight: 0.55,
    vocabulary: { particles: ["antigrav"], effects: ["starTwinkle", "crystalGlint"], landmarks: ["VOID", "GEODE", "ARCTIC"] },
    foreground: { maxHeight: 0.14, hanging: false },
    landmark: 'a giant banded primary above the regolith',
    signatureMotion: 'slow libration and ballistic surface traces',
    lightSource: 'hard, unscattered primary light',
    paletteFloor: 0.40,
    castPlacement: 'figures stay grounded against the cratered horizon',
    sharedEffects: OPEN_SKY,
  }),
  abyssal: policy({
    kind: 'abyssal',
    supportLight: 0.6,
    vocabulary: { particles: ["bubbles", "spores", "embers"], effects: ["godRays", "bioluminescence", "emberGlow"], landmarks: ["ABYSS", "CORAL"] },
    foreground: { maxHeight: 0.2, hanging: false },
    landmark: 'a water ceiling with descending shafts',
    signatureMotion: 'slow pressure drift and caustic sway',
    lightSource: 'veiled sunlight through the surface',
    paletteFloor: 0.38,
    castPlacement: 'figures drift below the surface, never in an open sky',
    sharedEffects: ENCLOSED,
  }),
  strip: policy({
    kind: 'strip',
    supportLight: 0.8,
    vocabulary: { particles: ["wind", "flaresparks", "digitalrain"], effects: ["heatShimmer", "neonGrid", "prominence"], landmarks: ["CYBER"] },
    foreground: { maxHeight: 0.16, hanging: false },
    landmark: 'a road vanishing into the horizon',
    signatureMotion: 'constant forward cruise',
    lightSource: 'a dominant horizon sun or moon plus signage',
    paletteFloor: 0.30,
    castPlacement: 'figures stay on the road corridor',
    sharedEffects: OPEN_SKY,
  }),
  foundry: policy({
    kind: 'foundry',
    supportLight: 0.65,
    vocabulary: { particles: ["fog", "embers", "flaresparks"], effects: ["starTwinkle", "emberGlow", "prominence", "heatShimmer"], landmarks: ["CYBER"] },
    foreground: { maxHeight: 0.2, hanging: true },
    landmark: 'smokestacks and a furnace glow from below',
    signatureMotion: 'machine strokes and molten pour pulses',
    lightSource: 'furnace uplight through smoke',
    paletteFloor: 0.32,
    castPlacement: 'figures move through the mill floor and gantries',
    sharedEffects: ENCLOSED,
  }),
  overgrowth: policy({
    kind: 'overgrowth',
    supportLight: 0.6,
    vocabulary: { particles: ["pollen", "spores", "fireflies"], effects: ["godRays", "canopyDapple", "sporeGlow", "bioluminescence"], landmarks: ["JADE", "LUMEN"] },
    foreground: { maxHeight: 0.24, hanging: true },
    landmark: 'a dense canopy closing the upper frame',
    signatureMotion: 'canopy growth and opening light shafts',
    lightSource: 'filtered sunlight and dappled floor light',
    paletteFloor: 0.30,
    castPlacement: 'figures stay beneath the canopy among trunks and spores',
    sharedEffects: ENCLOSED,
  }),
  nave: policy({
    kind: 'nave',
    supportLight: 0.6,
    vocabulary: { particles: ["fog", "sunshine"], effects: ["starTwinkle", "godRays", "crystalGlint", "prominence"], landmarks: ["TWILIGHT"] },
    foreground: { maxHeight: 0.22, hanging: true },
    landmark: 'vaulted bays framing a central rose window',
    signatureMotion: 'returning bays resonate with phrases',
    lightSource: 'stained glass and interior shafts',
    paletteFloor: 0.34,
    castPlacement: 'figures occupy the nave floor beneath the vault',
    sharedEffects: ENCLOSED,
  }),
});

/** Return an immutable policy for a kind, world, or previously resolved policy. */
export function identityFor(subject) {
  if (subject && typeof subject === 'object' && subject.sharedEffects && subject.landmark) return subject;
  const kind = typeof subject === 'string' ? subject : subject?.kind;
  return WORLD_IDENTITIES[kind] || WORLD_IDENTITIES.alpine;
}

/** Shared effects must be opted into by each world's physical setting. */
export function identityAllows(subject, effect) {
  return !!identityFor(subject).sharedEffects[effect];
}

/** Shared update/draw permission; sky opacity remains a painter concern. */
export function constellationsAllowed(subject, perf) {
  return identityAllows(subject, 'constellations') && (!perf || perf.constellationsEnabled !== false);
}

/** Keep adaptation's stock-palette contribution above the world-specific floor. */
export function stockPaletteMixFor(subject, requested = 0) {
  return Math.max(identityFor(subject).paletteFloor, Number(requested) || 0);
}

/** Physical choices are world-owned; color, timing and intensity remain musical. */
export function constrainPalette(subject, palette, stock = null) {
  const identity = identityFor(subject);
  const vocabulary = identity.vocabulary;
  const admit = (key, value, preferred) => vocabulary[key].includes(value)
    ? value : vocabulary[key].includes(preferred) ? preferred : vocabulary[key][0];
  const celestial = stock?.celestial ? {
    ...stock.celestial,
    color: palette.celestial.color, haloColor: palette.celestial.haloColor,
    radius: palette.celestial.radius,
  } : { ...palette.celestial };
  if (!identity.sharedEffects.astronomy || !['alpine', 'airless'].includes(identity.kind)) {
    celestial.companions = [];
    celestial.ring = false;
  }
  // Generated register direction is a small bias, never the dominant force.
  // Rise/fall behavior remains owned by ParticleField's admitted kind.
  const driftLimit = { airless: 2, abyssal: 3, overgrowth: 3, nave: 3, foundry: 8, city: 8, strip: 12 }[identity.kind];
  const drift = palette.particles.driftBias;
  const boundedDrift = drift && driftLimit !== undefined ? Object.fromEntries(
    ['vx', 'vy'].map(axis => [axis, Math.max(-driftLimit, Math.min(driftLimit, Number.isFinite(drift[axis]) ? drift[axis] : 0))]),
  ) : drift;
  const skyAttenuation = { airless: 0.97, city: 0.85 }[identity.kind] || 0;
  return {
    ...palette,
    // Vacuum stays dark; urban skies yield to windows and street lighting.
    // Retain musical hue, once at materialization, without changing primary size.
    ...(stock && skyAttenuation ? {
      sky: palette.sky.map(color => hexLerp(color, '#020408', skyAttenuation)),
      skyStops: palette.skyStops?.map(color => hexLerp(color, '#020408', skyAttenuation)),
    } : {}),
    landmarkKey: admit('landmarks', palette.landmarkKey, stock?.landmarkKey),
    fx: admit('effects', palette.fx, stock?.fx),
    celestial,
    particles: {
      ...palette.particles,
      ...(drift ? { driftBias: boundedDrift } : {}),
      kind: admit('particles', palette.particles.kind, stock?.particles?.kind),
      // Keep a vacuum or spores slow even when the song is fast.
      speed: stock?.particles ? Math.min(palette.particles.speed, stock.particles.speed * 1.5) : palette.particles.speed,
    },
  };
}
