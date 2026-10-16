// CPU twin of the GLSL atmosphere (same constants), sampled a few times a
// frame for values the shaders treat as uniforms: sky irradiance on the
// ground (ambient light), zenith and horizon colours (water reflections,
// storm veils) and the light reaching a cloud deck.
const RP = 6378.137, RA = RP + 80;
const BR = [5.802e-3, 13.558e-3, 33.1e-3], HR = 8, BM = 3.996e-3, HM = 1.2;
const BO = [0.650e-3, 1.881e-3, 0.085e-3];
const PI = Math.PI;

const phaseR = (mu) => (3 / (16 * PI)) * (1 + mu * mu);
function phaseM(mu, g = 0.76) {
  const g2 = g * g;
  return (3 / (8 * PI)) * ((1 - g2) * (1 + mu * mu)) / ((2 + g2) * Math.pow(Math.max(1e-4, 1 + g2 - 2 * g * mu), 1.5));
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function lightTransmittance(hKm, cosZ, p) {
  const h = Math.max(hKm, 0);
  const dip = -Math.sqrt(Math.max(0, (2 * h) / RP));
  const zen = (Math.acos(Math.min(1, Math.max(-1, Math.max(cosZ, dip * 0.5 + cosZ * 0.5)))) * 180) / PI;
  const c = Math.max(cosZ, 0);
  const am = Math.min(40, 1 / (c + 0.50572 * Math.pow(Math.max(96.07995 - zen, 0.6), -1.6364)));
  const t = (dip - 0.012 <= cosZ) ? Math.min(1, Math.max(0, (cosZ - (dip - 0.012)) / 0.016)) : 0;
  const shadow = t * t * (3 - 2 * t);
  return [0, 1, 2].map((i) => Math.exp(-(BR[i] * p.rayMul * HR * Math.exp(-h / HR) * am + BM * 1.11 * p.mieMul * HM * Math.exp(-h / HM) * am + BO[i] * 15 * am * 0.6)) * shadow);
}

function raySphere(o, d, r) {
  const b = dot(o, d), c = dot(o, o) - r * r, disc = b * b - c;
  if (disc < 0) return [1e9, -1e9];
  const s = Math.sqrt(disc);
  return [-b - s, -b + s];
}

/** Single-scattering sky radiance; p = { sunDir, sunPower, moonDir, moonPower, mieMul, rayMul, ambient }. */
export function skyRadiance(o, d, p, steps = 10) {
  const ta = raySphere(o, d, RA);
  if (ta[1] < 0 || ta[0] > ta[1]) return [0, 0, 0];
  const t0 = Math.max(ta[0], 0);
  let t1 = ta[1];
  const tp = raySphere(o, d, RP);
  if (tp[0] > 0 && tp[0] < t1) t1 = tp[0];
  const dt = (t1 - t0) / steps;
  const L = [0, 0, 0], trans = [1, 1, 1];
  const mu = dot(d, p.sunDir), muM = dot(d, p.moonDir);
  const pR = phaseR(mu), pM = phaseM(mu), pRm = phaseR(muM), pMm = phaseM(muM);
  for (let i = 0; i < steps; i++) {
    const t = t0 + dt * (i + 0.5);
    const q = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
    const r = Math.hypot(q[0], q[1], q[2]), h = r - RP, up = [q[0] / r, q[1] / r, q[2] / r];
    const dR = Math.exp(-h / HR), dM = Math.exp(-h / HM), dO = Math.max(0, 1 - Math.abs(h - 25) / 15);
    const sunT = lightTransmittance(h, dot(up, p.sunDir), p);
    const moonT = lightTransmittance(h, dot(up, p.moonDir), p);
    for (let k = 0; k < 3; k++) {
      const sR = BR[k] * p.rayMul * dR, sM = BM * p.mieMul * dM;
      const ext = sR + sM * 1.11 + BO[k] * dO;
      const stepT = Math.exp(-ext * dt);
      const S = (sR * pR + sM * pM) * sunT[k] * p.sunPower + (sR * pRm + sM * pMm) * moonT[k] * p.moonPower + (sR + sM) * p.ambient[k];
      L[k] += trans[k] * S * (1 - stepT) / Math.max(ext, 1e-6);
      trans[k] *= stepT;
    }
  }
  return L;
}

/**
 * Light the shaders need, for a camera at oKm with local up `up`.
 * Returns { irradiance, zenith, horizon, sunAtGround } (linear RGB).
 */
export function sampleSkyLight(oKm, up, p) {
  const east = norm(cross([0, 0, 1], up)), north = cross(up, east);
  const irr = [0, 0, 0];
  const horizon = [0, 0, 0];
  let wsum = 0;
  // Hemisphere: zenith ring + two elevation rings x 6 azimuths, cosine weighted.
  const dirs = [[90, 0]];
  for (const el of [12, 40]) for (let az = 0; az < 360; az += 60) dirs.push([el, az]);
  for (const [el, az] of dirs) {
    const ce = Math.cos((el * PI) / 180), se = Math.sin((el * PI) / 180);
    const sa = Math.sin((az * PI) / 180), ca = Math.cos((az * PI) / 180);
    const d = [0, 1, 2].map((i) => east[i] * ce * sa + north[i] * ce * ca + up[i] * se);
    const L = skyRadiance(oKm, d, p, 8);
    const w = se;
    for (let k = 0; k < 3; k++) irr[k] += L[k] * w;
    wsum += w;
  }
  for (let k = 0; k < 3; k++) irr[k] = (irr[k] / wsum) * PI;
  for (let az = 0; az < 360; az += 90) {
    const sa = Math.sin((az * PI) / 180), ca = Math.cos((az * PI) / 180), ce = Math.cos(0.05), se = Math.sin(0.05);
    const d = [0, 1, 2].map((i) => east[i] * ce * sa + north[i] * ce * ca + up[i] * se);
    const L = skyRadiance(oKm, d, p, 8);
    for (let k = 0; k < 3; k++) horizon[k] += L[k] / 4;
  }
  const zenith = skyRadiance(oKm, up, p, 8);
  const hKm = Math.hypot(...oKm) - RP;
  const sunAtGround = lightTransmittance(hKm, dot(up, p.sunDir), p);
  const moonAtGround = lightTransmittance(hKm, dot(up, p.moonDir), p);
  return { irradiance: irr, zenith, horizon, sunAtGround, moonAtGround };
}

function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function norm(a) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
