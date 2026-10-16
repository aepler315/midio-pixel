// Shared GLSL. Units: the atmosphere works in kilometres around the planet
// centre (ECEF); everything else in metres, camera-relative.

export const LOGDEPTH_VS = /* glsl */ `
uniform float uLogDepthFC;
void applyLogDepth() {
  gl_Position.z = (log2(max(1e-6, 1.0 + gl_Position.w)) * uLogDepthFC - 1.0) * gl_Position.w;
}
`;

export const NOISE = /* glsl */ `
// Hash and value noise with analytic derivatives, periodic so that tile-local
// coordinates taken modulo the period stay continuous across tiles.
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash13(vec3 p3) {
  p3 = fract(p3 * 0.1031);
  p3 += dot(p3, p3.zyx + 31.32);
  return fract((p3.x + p3.y) * p3.z);
}
// returns (value in [-1,1], d/dx, d/dy) for lattice period 'per' cells
vec3 noised(vec2 x, float per) {
  vec2 i = floor(x), f = fract(x);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  vec2 i0 = mod(i, per), i1 = mod(i + 1.0, per);
  float a = hash12(i0), b = hash12(vec2(i1.x, i0.y));
  float c = hash12(vec2(i0.x, i1.y)), d = hash12(i1);
  float k1 = b - a, k2 = c - a, k4 = a - b - c + d;
  float v = a + k1 * u.x + k2 * u.y + k4 * u.x * u.y;
  return vec3(v * 2.0 - 1.0, 2.0 * du * vec2(k1 + k4 * u.y, k2 + k4 * u.x));
}
float vnoise(vec2 x, float per) { return noised(x, per).x; }
// Periodic cellular noise: (F1, F2, id of the nearest cell in [0,1)).
// F2 - F1 is ~0 on the joints between cells: rock blocks and their cracks.
vec3 cellular(vec2 x, float per) {
  vec2 i = floor(x), f = fract(x);
  float d1 = 8.0, d2 = 8.0, id = 0.0;
  for (int y = -1; y <= 1; y++) for (int xx = -1; xx <= 1; xx++) {
    vec2 g = vec2(float(xx), float(y));
    vec2 c = mod(i + g, per);
    vec2 o = vec2(hash12(c), hash12(c + 19.19));
    float d = length(g + o - f);
    if (d < d1) { d2 = d1; d1 = d; id = hash12(c + 7.3); } else if (d < d2) d2 = d;
  }
  return vec3(d1, d2, id);
}
// Non-periodic 3D value noise in [0, 1] and its fbm.
float vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y);
  float b = mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y);
  return mix(a, b, f.z);
}
float fbm3(vec3 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise3(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return s;
}
`;

export const ATMOS = /* glsl */ `
const float RP = 6378.137;          // planet radius, km
const float RA = RP + 80.0;         // top of atmosphere, km
const vec3 BR = vec3(5.802e-3, 13.558e-3, 33.1e-3); // Rayleigh scattering /km
const float HR = 8.0;
const float BM = 3.996e-3;          // Mie scattering /km
const float HM = 1.2;
const vec3 BO = vec3(0.650e-3, 1.881e-3, 0.085e-3); // ozone absorption /km
const float PI = 3.14159265;

uniform vec3 uSunDir;        // unit, ECEF
uniform float uSunPower;     // HDR sun irradiance
uniform vec3 uMoonDir;
uniform float uMoonPower;
uniform vec3 uCamKm;         // camera position, km, ECEF
uniform float uMieMul;       // haze / storm
uniform float uRayMul;
uniform vec3 uAmbientTint;   // multiple-scattering stand-in

float phaseR(float mu) { return 3.0 / (16.0 * PI) * (1.0 + mu * mu); }
float phaseM(float mu, float g) {
  float g2 = g * g;
  return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + mu * mu)) / ((2.0 + g2) * pow(max(1e-4, 1.0 + g2 - 2.0 * g * mu), 1.5));
}

// Transmittance from altitude hKm toward a light at cosZ (cosine of zenith
// angle) through the whole atmosphere, using the Kasten-Young air mass, and
// the Earth's shadow: below the geometric horizon (lowered by the altitude's
// dip) the light is blocked. This is what turns high summits pink while the
// valleys are already in shade.
vec3 lightTransmittance(float hKm, float cosZ) {
  float h = max(hKm, 0.0);
  float dip = -sqrt(max(0.0, 2.0 * h / RP));      // cos of zenith at the true horizon
  float zen = degrees(acos(clamp(max(cosZ, dip * 0.5 + cosZ * 0.5), -1.0, 1.0)));
  float c = max(cosZ, 0.0);
  float am = 1.0 / (c + 0.50572 * pow(max(96.07995 - zen, 0.6), -1.6364));
  am = min(am, 40.0);
  vec3 tau = BR * uRayMul * HR * exp(-h / HR) * am + vec3(BM * 1.11 * uMieMul) * HM * exp(-h / HM) * am
           + BO * 15.0 * am * 0.6;
  float shadow = smoothstep(dip - 0.012, dip + 0.004, cosZ);
  return exp(-tau) * shadow;
}

// Aerial perspective between two points (km): transmittance and in-scatter
// along a straight segment through an exponential atmosphere.
void aerial(vec3 aKm, vec3 bKm, vec3 viewDir, out vec3 T, out vec3 L) {
  float ha = max(0.0, length(aKm) - RP), hb = max(0.0, length(bKm) - RP);
  float len = length(bKm - aKm);
  float dh = hb - ha;
  float odR, odM;
  if (abs(dh) < 1e-3) { odR = len * exp(-ha / HR); odM = len * exp(-ha / HM); }
  else {
    odR = len * HR * (exp(-ha / HR) - exp(-hb / HR)) / dh;
    odM = len * HM * (exp(-ha / HM) - exp(-hb / HM)) / dh;
  }
  vec3 sR = BR * uRayMul * odR;
  vec3 sM = vec3(BM * uMieMul * odM);
  vec3 tau = sR + sM * 1.11;
  T = exp(-tau);
  // Most of the scattering happens in the dense air near the lower end, so
  // light it with the sunlight that reaches there (not a midpoint that,
  // seen from orbit, would be out in space).
  vec3 low = ha < hb ? aKm : bKm;
  float hm = min(ha, hb) + min(abs(dh), 2.0);
  vec3 up = normalize(low);
  float mu = dot(viewDir, uSunDir);
  vec3 sunT = lightTransmittance(hm, dot(up, uSunDir));
  vec3 moonT = lightTransmittance(hm, dot(up, uMoonDir));
  float muM = dot(viewDir, uMoonDir);
  vec3 scat = sR * phaseR(mu) + sM * phaseM(mu, 0.76);
  vec3 scatM = sR * phaseR(muM) + sM * phaseM(muM, 0.76);
  vec3 f = (1.0 - T) / max(tau, vec3(1e-5));
  L = f * (scat * sunT * uSunPower + scatM * moonT * uMoonPower + (sR + sM) * uAmbientTint);
}

// Underside of a thick cloud deck at uDeckH (m): lit by the sky and the
// little sunlight that diffuses through. Shared by the deck mesh and the
// terrain it hides, so a summit inside the cloud matches the cloud.
uniform float uDeckH, uDeckDark;
uniform vec3 uSkyIrr;
vec3 deckUnderside(vec3 up) {
  vec3 sunT = lightTransmittance(uDeckH * 0.001, dot(up, uSunDir));
  vec3 moonT = lightTransmittance(uDeckH * 0.001, dot(up, uMoonDir));
  vec3 e = uSkyIrr * 0.8 + uSunPower * sunT * max(dot(up, uSunDir) + 0.1, 0.0) * 0.25 + uMoonPower * moonT * 0.2;
  return vec3(0.9) / PI * e * (1.0 - uDeckDark * 0.65);
}

vec2 raySphere(vec3 o, vec3 d, float r) {
  float b = dot(o, d), c = dot(o, o) - r * r, disc = b * b - c;
  if (disc < 0.0) return vec2(1e9, -1e9);
  float s = sqrt(disc);
  return vec2(-b - s, -b + s);
}

// Single-scattering sky by ray marching (16 steps), from anywhere: on the
// ground or in orbit looking at the limb.
vec3 skyRadiance(vec3 o, vec3 d, out vec3 transOut) {
  transOut = vec3(1.0);
  vec2 ta = raySphere(o, d, RA);
  if (ta.y < 0.0 || ta.x > ta.y) return vec3(0.0);
  float t0 = max(ta.x, 0.0), t1 = ta.y;
  vec2 tp = raySphere(o, d, RP);
  if (tp.x > 0.0 && tp.x < t1) t1 = tp.x;
  const int N = 16;
  float dt = (t1 - t0) / float(N);
  vec3 trans = vec3(1.0), L = vec3(0.0);
  float mu = dot(d, uSunDir), muM = dot(d, uMoonDir);
  float pR = phaseR(mu), pM = phaseM(mu, 0.76), pRm = phaseR(muM), pMm = phaseM(muM, 0.76);
  for (int i = 0; i < N; i++) {
    vec3 p = o + d * (t0 + dt * (float(i) + 0.5));
    float r = length(p), h = r - RP;
    vec3 up = p / r;
    float dR = exp(-h / HR), dM = exp(-h / HM), dO = max(0.0, 1.0 - abs(h - 25.0) / 15.0);
    vec3 sR = BR * uRayMul * dR, sM = vec3(BM * uMieMul * dM);
    vec3 ext = sR + sM * 1.11 + BO * dO;
    vec3 stepT = exp(-ext * dt);
    vec3 sunT = lightTransmittance(h, dot(up, uSunDir));
    vec3 moonT = lightTransmittance(h, dot(up, uMoonDir));
    vec3 S = (sR * pR + sM * pM) * sunT * uSunPower + (sR * pRm + sM * pMm) * moonT * uMoonPower + (sR + sM) * uAmbientTint;
    L += trans * S * (1.0 - stepT) / max(ext, vec3(1e-6));
    trans *= stepT;
  }
  transOut = trans;
  return L;
}
`;
