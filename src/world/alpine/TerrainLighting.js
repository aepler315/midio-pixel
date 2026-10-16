// Terrain surface response (natural-rendering Task 4). Before this, the
// terrain shader computed a roughness per material and then never used it:
// dry rock, scree, snow and wet ground differed only in colour. Here a
// bounded dielectric GGX lobe (Fresnel-Schlick, Smith-Schlick visibility)
// makes roughness change the image: snow and wet rock catch the low sun,
// rough soil and canopy stay matte. JS twins mirror the GLSL so the
// response is testable without a GPU.
//
// Units match the existing diffuse term, which is albedo * light * N.L
// (no 1/pi: the light colour is pre-scaled radiance). The specular lobe is
// therefore multiplied by pi so both share one convention.

/** Normal-incidence reflectance: rock/soil/vegetation ~4 %, snow and ice a
 *  little lower (refractive index of ice ~1.31). */
export const F0_DIELECTRIC = 0.04;
export const F0_ICE = 0.02;
/** Cap on the specular radiance factor: keeps a sharp wet glint bounded. */
export const SPEC_MAX = 4.0;
/** Most roughness specular anti-aliasing may add (variance clamp). */
export const SPEC_AA_MAX_VARIANCE = 0.5;

export const TERRAIN_LIGHTING_GLSL = /* glsl */`
  float materialF0(float snow, float ice) { return mix(${F0_DIELECTRIC.toFixed(3)}, ${F0_ICE.toFixed(3)}, clamp(max(snow, ice), 0.0, 1.0)); }
  // Widen the lobe by the normal's variation inside the pixel.
  float terrainRoughness(float rough, vec3 n) {
    vec3 dx = dFdx(n), dy = dFdy(n);
    float variance = min(.5 * (dot(dx, dx) + dot(dy, dy)), ${SPEC_AA_MAX_VARIANCE.toFixed(3)});
    return clamp(sqrt(rough * rough + variance), .04, 1.0);
  }
  // x: specular radiance factor (times N.L, pi-scaled), y: Fresnel at the
  // half vector (the share of energy the diffuse term gives up).
  vec2 terrainSpecular(vec3 n, vec3 v, vec3 l, float rough, float f0) {
    float nl = dot(n, l), nv = max(dot(n, v), 1e-4);
    if (nl <= 0.0) return vec2(0.0);
    vec3 h = normalize(l + v);
    float nh = max(dot(n, h), 0.0), vh = max(dot(v, h), 0.0);
    float a = rough * rough, a2 = a * a;
    float d = nh * nh * (a2 - 1.0) + 1.0;
    float D = a2 / max(3.14159265 * d * d, 1e-6);
    float k = (rough + 1.0) * (rough + 1.0) / 8.0;
    float G = (nl / (nl * (1.0 - k) + k)) * (nv / (nv * (1.0 - k) + k));
    // Roughness-aware Schlick: a rough surface's grazing reflectance stays
    // low (its microfacets shadow the glancing ray), a polished one rises.
    float F = f0 + (max(1.0 - rough, f0) - f0) * pow(1.0 - vh, 5.0);
    float spec = D * G * F / (4.0 * nl * nv) * nl * 3.14159265;
    return vec2(min(spec, ${SPEC_MAX.toFixed(1)}), F);
  }
`;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(...a) || 1; return a.map(x => x / l); };

/** JS twin of terrainSpecular. */
export function terrainSpecular(n, v, l, rough, f0 = F0_DIELECTRIC) {
  const nl = dot(n, l), nv = Math.max(dot(n, v), 1e-4);
  if (nl <= 0) return { spec: 0, fresnel: 0 };
  const h = norm([l[0] + v[0], l[1] + v[1], l[2] + v[2]]);
  const nh = Math.max(dot(n, h), 0), vh = Math.max(dot(v, h), 0);
  const a = rough * rough, a2 = a * a, d = nh * nh * (a2 - 1) + 1;
  const D = a2 / Math.max(Math.PI * d * d, 1e-6);
  const k = (rough + 1) ** 2 / 8;
  const G = (nl / (nl * (1 - k) + k)) * (nv / (nv * (1 - k) + k));
  const F = f0 + (Math.max(1 - rough, f0) - f0) * (1 - vh) ** 5;
  return { spec: Math.min(D * G * F / (4 * nl * nv) * nl * Math.PI, SPEC_MAX), fresnel: F };
}

/** JS twin of terrainRoughness for a given normal variance. */
export function terrainRoughness(rough, variance) {
  return Math.max(0.04, Math.min(1, Math.sqrt(rough * rough + Math.min(variance, SPEC_AA_MAX_VARIANCE))));
}
