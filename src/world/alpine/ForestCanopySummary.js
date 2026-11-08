/** Distant crowns use the mean canopy once their projected width is unresolved. */
export function canopySummaryEnabled(search = '') {
  const value = new URLSearchParams(search).get('canopySummary');
  return value === null || value === '1' || value === 'on';
}

/** Weight of individual crown detail; the remaining weight uses the live mean canopy. */
export function canopySummaryWeight({ radius, footprint }) {
  if (!Number.isFinite(radius) || !Number.isFinite(footprint) || radius <= 0) return 0;
  if (footprint <= 0) return 1;
  const pixels = 2 * radius / Math.max(footprint, .001);
  const t = Math.max(0, Math.min(1, (pixels - .75) / .75));
  return t * t * (3 - 2 * t);
}

export const CANOPY_SUMMARY_GLSL = /* glsl */`
  float canopySummaryBlend(float pixels) {
    return smoothstep(.75, 1.5, pixels);
  }
  float canopySummaryWeight(vec2 meanCrown, float footprint) {
    if (meanCrown.x <= 0.) return 0.;
    if (footprint <= 0.) return 1.;
    return canopySummaryBlend(2. * max(meanCrown.x, 0.) / max(footprint, .001));
  }
`;
