// A compressed interpretation of valley-lobe retreat, not a dated ice-sheet
// reconstruction. Coordinates are local X east / Z south in metres. The
// axis runs from the southern terminus toward the northern source.
const unit = v => Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
const smooth = (a, b, v) => { const u = unit((v - a) / (b - a)); return u * u * (3 - 2 * u); };

export function glacierErrors(config) {
  if (config == null) return [];
  const errors = [];
  for (const k of ['axisStartM', 'axisEndM']) {
    if (!Array.isArray(config[k]) || config[k].length !== 2 || !config[k].every(Number.isFinite)) errors.push(`glacier.${k} needs two finite metres`);
  }
  for (const k of ['halfWidthM', 'maxThicknessM']) if (!(Number.isFinite(config[k]) && config[k] > 0)) errors.push(`glacier.${k} must be positive finite metres`);
  for (const k of ['surfaceStartM', 'surfaceEndM']) if (!Number.isFinite(config[k])) errors.push(`glacier.${k} must be finite metres`);
  if (!errors.length && Math.hypot(...config.axisEndM.map((v, i) => v - config.axisStartM[i])) < 100) errors.push('glacier axis must span at least 100 metres');
  return errors;
}

/** progress01 is the normalized sustained-energy journey, never an
 * instantaneous energy. Time supplies a steady pace when the song is quiet. */
export function glacierStateAt({ timeMs = 0, durationMs = 0, progress01 } = {}) {
  if (!(Number.isFinite(durationMs) && durationMs > 0)) return { retreat01: .5, journey01: .5 };
  const t = unit(timeMs / durationMs);
  const p = Number.isFinite(progress01) ? unit(progress01) : t;
  const journey01 = t === 0 ? 0 : t === 1 ? 1 : .7 * t + .3 * p;
  return { retreat01: smooth(.04, .94, journey01), journey01 };
}

export function glacierSample(config, x, z, bedM, retreat01 = 0) {
  const dry = { thicknessM: 0, surfaceM: bedM, coverage01: 0, recovery01: 1 };
  if (!config || glacierErrors(config).length || ![x, z, bedM].every(Number.isFinite)) return dry;
  const dx = config.axisEndM[0] - config.axisStartM[0], dz = config.axisEndM[1] - config.axisStartM[1];
  const len = Math.hypot(dx, dz), px = x - config.axisStartM[0], pz = z - config.axisStartM[1];
  const along = (px * dx + pz * dz) / (len * len);
  const across = Math.abs(px * dz - pz * dx) / (len * config.halfWidthM);
  if (along < 0 || along > 1 || across >= 1) return dry;
  const dome = Math.sqrt(Math.max(0, 1 - across * across));
  const surface = config.surfaceStartM + (config.surfaceEndM - config.surfaceStartM) * along
    - config.halfWidthM * .10 * (1 - dome);
  const original = Math.min(config.maxThicknessM, Math.max(0, surface - bedM)) * (1 - smooth(.85, 1, across));
  const r = unit(retreat01);
  const thicknessM = original * smooth(r, r + .12, along) * Math.pow(1 - r, .7);
  // Forest recovery follows local exposure, with a later final recovery
  // ramp for the small northern remnant. A summit never buried stays green.
  const recovery01 = original < .5 ? 1 : thicknessM > .5 ? 0
    : Math.max(smooth(along + .025, along + .20, r), smooth(.94, 1, r));
  return { thicknessM, surfaceM: bedM + thicknessM, coverage01: smooth(.5, 12, thicknessM), recovery01 };
}

/** Complete per-view upload; disabled fields never inherit a prior lobe. */
export function applyGlacierUniforms(uniforms, config, state = {}) {
  const errors = glacierErrors(config);
  if (errors.length) throw new Error(errors.join('; '));
  uniforms.uGlacierEnabled.value = config ? 1 : 0;
  uniforms.uGlacierRetreat.value = unit(state.retreat01);
  uniforms.uGlacierStart.value.set(...(config?.axisStartM || [0, 0]));
  uniforms.uGlacierEnd.value.set(...(config?.axisEndM || [0, -100]));
  uniforms.uGlacierWidth.value = config?.halfWidthM || 1;
  uniforms.uGlacierSurface.value.set(config?.surfaceStartM || 0, config?.surfaceEndM || 0);
  uniforms.uGlacierMaxThickness.value = config?.maxThicknessM || 0;
}

// Numerical twin of glacierSample. Shared by scenic, depth and forest
// shaders, so buried trees cannot leave invisible depth occluders.
export const GLACIER_GLSL = /* glsl */`
  uniform float uGlacierEnabled;
  uniform vec2 uGlacierStart;
  uniform vec2 uGlacierEnd;
  uniform float uGlacierWidth;
  uniform vec2 uGlacierSurface;
  uniform float uGlacierMaxThickness;
  uniform float uGlacierRetreat;
  vec3 glacierAt(vec3 p) {
    if (uGlacierEnabled < 0.5) return vec3(0.0, 0.0, 1.0);
    vec2 d = uGlacierEnd - uGlacierStart;
    float len = max(100.0, length(d));
    vec2 v = p.xz - uGlacierStart;
    float q = dot(v, d) / (len * len);
    float c = abs(v.x * d.y - v.y * d.x) / (len * max(1.0, uGlacierWidth));
    if (q < 0.0 || q > 1.0 || c >= 1.0) return vec3(0.0, 0.0, 1.0);
    float dome = sqrt(max(0.0, 1.0 - c * c));
    float s = mix(uGlacierSurface.x, uGlacierSurface.y, q) - uGlacierWidth * 0.10 * (1.0 - dome);
    float original = min(uGlacierMaxThickness, max(0.0, s - p.y)) * (1.0 - smoothstep(0.85, 1.0, c));
    float r = clamp(uGlacierRetreat, 0.0, 1.0);
    float thick = original * smoothstep(r, r + 0.12, q) * pow(1.0 - r, 0.7);
    float recovery = original < 0.5 ? 1.0 : thick > 0.5 ? 0.0
      : max(smoothstep(q + 0.025, q + 0.20, r), smoothstep(0.94, 1.0, r));
    return vec3(thick, smoothstep(0.5, 12.0, thick), recovery);
  }
`;
