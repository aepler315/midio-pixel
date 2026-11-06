// The range's opening starts as a quiet shallow sea. It is an artistic
// construction surface, not a geographic water classification. The existing
// analytic backdrop and actual flattened terrain share one display color, so
// a finite source window cannot leave a different-colored rectangle at rise 0.
export const OPENING_OCEAN_END = .25;
const unit = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/** One heard-time growth value drives material handoff and camera framing. */
export function openingOcean01(rise01 = 1) {
  const t = unit((Number.isFinite(rise01) ? rise01 : 1) / OPENING_OCEAN_END);
  return 1 - t * t * (3 - 2 * t);
}

/** Numerical twin of the featureless display color below. Only distance air
 * varies over the surface; there are no world-grid, wave or noise features. */
export function openingOceanColor({ water, sky, air, distanceM = 0, airDensity = 0 } = {}) {
  const brightness = unit((sky[0] * .2126 + sky[1] * .7152 + sky[2] * .0722) * 2);
  const light = .18 + .82 * brightness;
  const haze = Math.min(.96, 1 - Math.exp(-Math.max(0, distanceM) * Math.max(0, airDensity)));
  const shallow = [.035, .13, .14];
  return shallow.map((value, i) => {
    const body = (value * .75 + water[i] * .25) * light + sky[i] * .07;
    return Math.pow(Math.max(0, body + (air[i] - body) * haze), 1 / 2.2);
  });
}

// Arguments reuse existing terrain/support uniforms. This adds no texture
// sample, uniform, render target or pass. Both callers use the same transfer
// function even though the legacy support material has a different one.
export const BUILD_OCEAN_GLSL = /* glsl */`
  float openingOcean01(float rise01) {
    return 1.0 - smoothstep(0.0, ${OPENING_OCEAN_END.toFixed(2)}, clamp(rise01, 0.0, 1.0));
  }
  vec3 openingOceanDisplay(vec3 p, vec3 eye, vec3 water, vec3 sky, vec3 air, float density) {
    float brightness = clamp(dot(sky, vec3(.2126, .7152, .0722)) * 2.0, 0.0, 1.0);
    float light = .18 + .82 * brightness;
    vec3 body = mix(vec3(.035, .13, .14), water, .25) * light + sky * .07;
    float haze = min(.96, 1.0 - exp(-length(p - eye) * max(0.0, density)));
    return pow(max(mix(body, air, haze), vec3(0.0)), vec3(1.0 / 2.2));
  }
`;
