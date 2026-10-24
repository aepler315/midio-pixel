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
    // belong to the range that actually has a sea.
    sharedEffects: { ...OPEN_SKY, ocean: true },
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
  if (!identity.sharedEffects.astronomy || identity.kind !== 'alpine') {
    celestial.companions = [];
    celestial.ring = false;
  }
  return {
    ...palette,
    landmarkKey: admit('landmarks', palette.landmarkKey, stock?.landmarkKey),
    fx: admit('effects', palette.fx, stock?.fx),
    celestial,
    particles: {
      ...palette.particles,
      kind: admit('particles', palette.particles.kind, stock?.particles?.kind),
      // Keep particles near the stock pace even when the song is fast.
      speed: stock?.particles ? Math.min(palette.particles.speed, stock.particles.speed * 1.5) : palette.particles.speed,
    },
  };
}
