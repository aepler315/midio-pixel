export const LANDSCAPE_PASSES = Object.freeze([
  'L2', 'L3', 'L4', 'L5',
  'ridge-base', 'ridge-faces', 'cover', 'valley-fog',
  'ground-base', 'ground-material', 'ground-scatter', 'ground-response',
  'horizon-eq', 'ocean-backing', 'ocean-marks',
  'space-ridge', 'weaver', 'ensemble', 'beams', 'other-ornaments', 'film',
]);

const LAYER_PASSES = new Set(['L2', 'L3', 'L4', 'L5']);

/** Instance-local paint gate. A null state lets every pass draw. */
export function diagnosticAllows(state, passId, layerKey = null) {
  if (!state || state.pass === 'all') return true;
  if (state.passes instanceof Set) {
    return state.passes.has(passId) || (layerKey != null && state.passes.has(layerKey));
  }
  if (state.pass == null) return true;
  if (LAYER_PASSES.has(state.pass)) return state.pass === layerKey;
  return state.pass === passId;
}

export function classifyEmptyPass({ painted, offscreen, disabled, geometry }) {
  if (painted) return null;
  if (disabled) return 'disabled';
  if (offscreen) return 'offscreen';
  if (!geometry) return 'empty-geometry';
  return 'unexpected-zero';
}
