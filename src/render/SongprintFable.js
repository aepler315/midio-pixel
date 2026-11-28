// Adapted from songprint-fable (project author's repo, V:\Development\songprint).
// Deterministic tree-ring song representation: geometry from pitch-class structure,
// colour from recording/timeline tone. This is a Midio Pixel prototype adaptation
// that can build a descriptor from available heard-time Songprint timeline data.

const TAU = Math.PI * 2;
const FIFTHS = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];
const CHROMA_MAX = 0.16;
export const GEOMETRY = { mean: 0.55, detail: 1.2, kappa: 8 };
export const RIDGE_SECONDS = 2;
const RIDGE_MIN_PX = 5;
export const TONE_CAL = { tilt0: 2.9, curve0: -1.7, tiltSpan: 5.0, curveSpan: 5.0 };

export function fifthsAngle(pc) { return (TAU * ((7 * pc) % 12)) / 12; }

function clamp01(x) { return x < 0 ? 0 : x > 1 ? 1 : x; }

function oklabToSrgb(L, a, b, out, o) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
  out[o] = encode(r); out[o + 1] = encode(g); out[o + 2] = encode(bl);
}
function encode(x) {
  const c = x <= 0 ? 0 : x >= 1 ? 1 : x;
  return 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
}

export function buildDescriptorFromSongprint(songprint, durationMs) {
  const timeline = songprint?.timeline;
  if (!timeline?.loudness?.length) return null;
  const stepMs = timeline.stepMs || 2000;
  const slices = timeline.loudness.length;
  const chroma = new Float32Array(slices * 12);
  const tone = new Float32Array(slices * 3);
  const tonic = Number.isInteger(timeline.key?.tonic) ? timeline.key.tonic : 0;
  const keyAngle = fifthsAngle(tonic);
  for (let s = 0; s < slices; s++) {
    const loud = clamp01(timeline.loudness[s] ?? 0);
    const bright = clamp01(timeline.brightness[s] ?? 0.5);
    const tension = clamp01(timeline.tension[s] ?? 0.3);
    const novelty = clamp01(timeline.novelty[s] ?? 0.2);
    const major = clamp01(timeline.major[s] ?? 0.5);
    // Tone: tilt/curve/level proxy in fable-like units.
    tone[s * 3] = 0.5 + bright * 5.0 - tension * 1.5;
    tone[s * 3 + 1] = -3.5 + major * 3.5 - tension * 2.0;
    tone[s * 3 + 2] = -24 + loud * 36;

    // Pseudo-chroma: tonic-centered distribution shaped by tension/novelty/major.
    const third = (tonic + (major > 0.5 ? 4 : 3)) % 12;
    const fifth = (tonic + 7) % 12;
    const lead = (tonic + Math.round(bright * 11)) % 12;
    const weights = new Float64Array(12);
    weights[tonic] += 1.0;
    weights[third] += 0.55 + (1 - tension) * 0.2;
    weights[fifth] += 0.65;
    weights[lead] += 0.25 + novelty * 0.35;
    weights[(tonic + 2) % 12] += 0.15 * tension;
    weights[(tonic + 10) % 12] += 0.12 * tension;
    for (let pc = 0; pc < 12; pc++) weights[pc] += 0.05 + 0.03 * Math.sin(s * 0.17 + pc);
    let sum = 0;
    for (let pc = 0; pc < 12; pc++) sum += weights[pc];
    for (let pc = 0; pc < 12; pc++) chroma[s * 12 + pc] = (weights[pc] / (sum || 1)) * (0.4 + loud * 0.8);
  }
  const lastFraction = Math.min(1, Math.max(1e-3, (durationMs / stepMs) - (slices - 1)));
  return {
    version: 1,
    slices,
    sliceSeconds: stepMs / 1000,
    lastFraction,
    keyAngle,
    chroma,
    tone,
  };
}

export function growthField(desc, { rays = 720 } = {}) {
  const { slices, chroma, keyAngle } = desc;
  const last = desc.lastFraction ?? 1;
  const { mean, detail, kappa } = GEOMETRY;
  const stride = slices + 1;
  const field = new Float32Array(rays * stride);
  const kernel = new Float64Array(12);
  const average = new Float64Array(12);
  for (let s = 0; s < slices; s++) for (let pc = 0; pc < 12; pc++) average[pc] += chroma[s * 12 + pc] / slices;
  let max = 0;
  for (let j = 0; j < rays; j++) {
    const theta = (TAU * j) / rays;
    let ksum = 0;
    for (let pc = 0; pc < 12; pc++) {
      const k = Math.exp(kappa * (Math.cos(theta - (fifthsAngle(pc) - keyAngle)) - 1));
      kernel[pc] = k; ksum += k;
    }
    let base = 0;
    for (let pc = 0; pc < 12; pc++) { kernel[pc] /= ksum; base += kernel[pc] * average[pc]; }
    let acc = 0;
    const row = j * stride;
    for (let s = 0; s < slices; s++) {
      let v = 0;
      for (let pc = 0; pc < 12; pc++) v += kernel[pc] * chroma[s * 12 + pc];
      const layer = Math.exp(mean * base + detail * (v - base));
      acc += s === slices - 1 ? layer * last : layer;
      field[row + s + 1] = acc;
    }
    if (acc > max) max = acc;
  }
  for (let i = 0; i < field.length; i++) field[i] /= max;
  return { field, rays, stride, slices };
}

export function sliceColours(desc, cal = TONE_CAL) {
  const { slices, tone } = desc;
  const lab = new Float32Array(slices * 3);
  for (let s = 0; s < slices; s++) {
    let a = (tone[s * 3] - cal.tilt0) / cal.tiltSpan;
    let b = (tone[s * 3 + 1] - cal.curve0) / cal.curveSpan;
    const rad = Math.hypot(a, b);
    const k = rad > 0 ? Math.tanh(rad) / rad : 1;
    const level = tone[s * 3 + 2];
    const x = Math.min(1, Math.max(0, (level + 50) / 25));
    const audible = x * x * (3 - 2 * x);
    a *= k * CHROMA_MAX * audible; b *= k * CHROMA_MAX * audible;
    const L = 0.72 + 0.4 * Math.tanh(level / 24);
    lab[s * 3] = L; lab[s * 3 + 1] = a; lab[s * 3 + 2] = b;
  }
  const out = new Float32Array(lab.length);
  const taps = [1, 4, 6, 4, 1];
  for (let s = 0; s < slices; s++) {
    for (let c = 0; c < 3; c++) {
      let v = 0;
      for (let t = -2; t <= 2; t++) v += taps[t + 2] * lab[Math.min(slices - 1, Math.max(0, s + t)) * 3 + c];
      out[s * 3 + c] = v / 16;
    }
  }
  return out;
}

export function renderFable(desc, size = 512, { ridges = true } = {}) {
  const data = new Uint8ClampedArray(size * size * 4);
  const { field, rays, stride, slices } = growthField(desc);
  const lab = sliceColours(desc);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let j = 0; j < rays; j++) {
    const theta = (TAU * j) / rays, rim = field[j * stride + slices];
    const px = rim * Math.sin(theta), py = -rim * Math.cos(theta);
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
  }
  const radius = (size * 0.47) / (0.5 * Math.max(maxX - minX, maxY - minY));
  const centreX = (size - 1) / 2 - 0.5 * (minX + maxX) * radius;
  const centreY = (size - 1) / 2 - 0.5 * (minY + maxY) * radius;
  const ridgeSlices = RIDGE_SECONDS / desc.sliceSeconds;
  const last = desc.lastFraction ?? 1;
  const rgb = new Float64Array(3);

  const locate = (row, r) => {
    const end = field[row + slices];
    if (r >= end) return slices + (r - end) / (end - field[row + slices - 1] + 1e-9);
    let lo = 0, hi = slices;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (field[row + mid] <= r) lo = mid; else hi = mid;
    }
    return lo + (r - field[row + lo]) / (field[row + hi] - field[row + lo] + 1e-12);
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - centreX, dy = y - centreY;
      const r = Math.hypot(dx, dy) / radius;
      if (r > 1.02) continue;
      let ang = Math.atan2(dx, -dy);
      if (ang < 0) ang += TAU;
      const jf = (ang / TAU) * rays;
      const j0 = Math.floor(jf) % rays, j1 = (j0 + 1) % rays, jw = jf - Math.floor(jf);
      const u = (1 - jw) * locate(j0 * stride, r) + jw * locate(j1 * stride, r);
      const s = Math.min(slices - 1, Math.max(0, Math.floor(u)));
      const thick = ((1 - jw) * (field[j0 * stride + s + 1] - field[j0 * stride + s])
        + jw * (field[j1 * stride + s + 1] - field[j1 * stride + s])) * radius;
      const alpha = Math.min(1, Math.max(0, (slices - u) * thick + 0.5));
      if (alpha <= 0) continue;
      const cf = Math.min(slices - 1, Math.max(0, u - 0.5));
      const c0 = Math.floor(cf), c1 = Math.min(slices - 1, c0 + 1), cw = cf - c0;
      let L = (1 - cw) * lab[c0 * 3] + cw * lab[c1 * 3];
      const a = (1 - cw) * lab[c0 * 3 + 1] + cw * lab[c1 * 3 + 1];
      const b = (1 - cw) * lab[c0 * 3 + 2] + cw * lab[c1 * 3 + 2];
      if (ridges) {
        const tail = u > slices - 1;
        const periodPx = (tail ? thick / last : thick) * ridgeSlices;
        const lod = Math.max(0, Math.log2(RIDGE_MIN_PX / Math.max(periodPx, 1e-6)));
        const n = Math.floor(lod), f = lod - n;
        const time = tail ? slices - 1 + (u - (slices - 1)) * last : u;
        const phase = (TAU * time) / ridgeSlices;
        const wave = (1 - f) * Math.cos(phase / 2 ** n) + f * Math.cos(phase / 2 ** (n + 1));
        L += 0.1 * wave;
      }
      const o = (y * size + x) * 4;
      oklabToSrgb(L, a, b, rgb, 0);
      data[o] = rgb[0]; data[o + 1] = rgb[1]; data[o + 2] = rgb[2];
      data[o + 3] = 255 * alpha;
    }
  }
  return { width: size, height: size, data, field, rays, stride, slices, centreX, centreY, radius };
}

export function revealedSliceIndex(desc, timeMs, durationMs) {
  const totalSlices = desc?.slices || 1;
  const dur = Math.max(1, durationMs || 1);
  const t = clamp01(timeMs / dur);
  const end = (totalSlices - 1) + (desc?.lastFraction ?? 1);
  return t * end;
}
