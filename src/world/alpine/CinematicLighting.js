// A receiver profile for the opt-in Cinematic Pixel look. Geography, source
// radiance and weather stay authoritative; these values shape their response.
const unit = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
const mix = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = unit((x - a) / (b - a)); return t * t * (3 - 2 * t); };

export const CINEMATIC_LIGHTING = Object.freeze({
  dayFill: .72, nightFill: .96, dayShadow: .18, nightShadow: .42,
  dayWrap: .09, nightWrap: .15, dayAir: .68, nightAir: .84,
  dayMist: .58, nightMist: .82, airStartM: 900, mistNearM: 1200,
  mistNearSkyGain: .72, mistColorNearM: 1800, mistColorFarM: 18000,
});

/** Two packed vectors, shared by terrain and every resident forest window.
 * light: gate, receiver-fill gain, shadow residual, rock wrap.
 * air: density gain, ordinary-mist gain, clear near-air m, mist shoulder m. */
export function cinematicLightingProfile({ enabled = false, night01 = 0, storm01 = 0 } = {}) {
  if (!enabled) return { light: [0, 1, .5, .18], air: [1, 1, 0, 0] };
  const p = CINEMATIC_LIGHTING;
  // Dense overcast already removes the direct key; retain its receiver fill.
  const daylight = (1 - unit(night01)) * (1 - .8 * unit(storm01));
  return {
    light: [1, mix(p.nightFill, p.dayFill, daylight), mix(p.nightShadow, p.dayShadow, daylight), mix(p.nightWrap, p.dayWrap, daylight)],
    air: [mix(p.nightAir, p.dayAir, daylight), mix(p.nightMist, p.dayMist, daylight), p.airStartM, p.mistNearM],
  };
}

/** Numerical twins of the shared shader response, for boundedness checks. */
export function cinematicAirAmount({ distanceM, density, heightTerm = 1, scale = CINEMATIC_LIGHTING.dayAir, startM = CINEMATIC_LIGHTING.airStartM } = {}) {
  const opticalDistance = Math.max(0, (Number.isFinite(distanceM) ? distanceM : 0) - startM);
  return Math.min(.96, Math.max(0, 1 - Math.exp(-opticalDistance * Math.max(0, density || 0) * scale * (.35 + .65 * unit(heightTerm)))));
}

export function cinematicMistAmount({ amount = 0, distanceM = 0, fill = 0, scale = CINEMATIC_LIGHTING.dayMist, nearM = CINEMATIC_LIGHTING.mistNearM } = {}) {
  const weight = mix(scale * smooth(0, nearM, distanceM), 1, unit(fill));
  if (weight === 1) return unit(amount);
  return 1 - Math.pow(Math.max(1 - unit(amount), 1e-6), weight);
}

/** Near atmospheric light comes from the actual zenith; far banks retain
 * the authored horizon light. This changes color, never the cloud-sea volume. */
export function cinematicMistColor(mistColor, skyZenith, distanceM) {
  const p = CINEMATIC_LIGHTING;
  const distance = Number.isFinite(distanceM) ? Math.max(0, distanceM) : 0;
  const far = smooth(p.mistColorNearM, p.mistColorFarM, distance);
  return mistColor.map((value, i) => {
    const original = Number.isFinite(value) ? Math.max(0, value) : 0;
    const sky = Number.isFinite(skyZenith[i]) ? Math.max(0, skyZenith[i]) : 0;
    return mix(Math.min(original, sky * p.mistNearSkyGain), original, far);
  });
}

export function cinematicGrade(color) {
  const c = color.map(x => Number.isFinite(x) ? Math.max(0, x) : 0);
  const luma = c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
  const shadow = 1 - smooth(.04, .5, luma), high = smooth(.5, .95, luma);
  const cool = [.91, .98, 1.06], warm = [1.015, 1.005, .99];
  return c.map((value, i) => unit((luma + (value - luma) * 1.08)
    * mix(1, cool[i], shadow * .45) * mix(1, warm[i], high * .4)
    * (.94 + .06 * smooth(0, .4, luma))));
}

export const CINEMATIC_LIGHTING_GLSL = /* glsl */`
  uniform vec4 uCinematic;
  uniform vec4 uCinematicAir;
  vec3 cinematicFill(vec3 hemi, float key) {
    // Cool sky-facing shadow, close to neutral under the direct key.
    return hemi * uCinematic.y * mix(vec3(.91, .98, 1.06), vec3(1.0), clamp(key, 0.0, 1.0));
  }
  vec3 cinematicKey(vec3 key) { return key * vec3(1.025, 1.005, .98); }
  float cinematicAirAmount(float distanceM, float heightTerm, float density) {
    float opticalDistance = max(0.0, distanceM - uCinematicAir.z);
    return clamp(1.0 - exp(-opticalDistance * density * uCinematicAir.x * (.35 + .65 * heightTerm)), 0.0, .96);
  }
  float cinematicMistAmount(float amount, float distanceM, float fill) {
    float nearWeight = smoothstep(0.0, max(1.0, uCinematicAir.w), distanceM);
    float weight = mix(uCinematicAir.y * nearWeight, 1.0, clamp(fill, 0.0, 1.0));
    // Scale optical depth, not opacity: a deep bank still converges.
    if (weight >= 1.0) return amount;
    return 1.0 - pow(max(1.0 - amount, 1e-6), weight);
  }
  vec3 cinematicMistColor(vec3 mistColor, vec3 skyZenith, float distanceM) {
    vec3 nearColor = min(mistColor, max(skyZenith, vec3(0.0)) * ${CINEMATIC_LIGHTING.mistNearSkyGain.toFixed(2)});
    return mix(nearColor, mistColor, smoothstep(${CINEMATIC_LIGHTING.mistColorNearM.toFixed(1)}, ${CINEMATIC_LIGHTING.mistColorFarM.toFixed(1)}, distanceM));
  }
  vec3 cinematicGrade(vec3 c) {
    float luma = dot(c, vec3(.2126, .7152, .0722));
    float shadow = 1.0 - smoothstep(.04, .5, luma);
    float high = smoothstep(.5, .95, luma);
    c = vec3(luma) + (c - luma) * 1.08;
    c *= mix(vec3(1.0), vec3(.91, .98, 1.06), shadow * .45);
    c *= mix(vec3(1.0), vec3(1.015, 1.005, .99), high * .4);
    c *= .94 + .06 * smoothstep(0.0, .4, luma);
    return clamp(c, 0.0, 1.0);
  }
`;
