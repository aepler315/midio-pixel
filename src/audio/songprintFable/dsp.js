// Adapted from songprint-fable (V:\Development\songprint, project author's repo).
// Deterministic DSP primitives for Songprint Fable descriptor analysis.

export function createFft(n) {
  if (n < 2 || (n & (n - 1)) !== 0) throw new Error(`FFT size must be a power of two, got ${n}`);
  const bits = Math.log2(n) | 0;
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >>> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  return function fft(re, im) {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        const tr = re[i]; re[i] = re[j]; re[j] = tr;
        const ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const stride = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += stride) {
          const a = start + k, b = a + half;
          const wr = cos[t], wi = -sin[t];
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  };
}

export function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

function gcd(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }
function besselI0(x) {
  let sum = 1, term = 1;
  const q = (x * x) / 4;
  for (let k = 1; k < 40; k++) {
    term *= q / (k * k);
    sum += term;
    if (term < 1e-12 * sum) break;
  }
  return sum;
}

export function resample(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const g = gcd(Math.round(fromRate), Math.round(toRate));
  const up = Math.round(toRate) / g;
  const down = Math.round(fromRate) / g;
  const scale = Math.min(1, toRate / fromRate);
  const zeros = 16;
  const half = Math.ceil(zeros / scale);
  const taps = 2 * half + 1;
  const phases = Math.min(up, 1024);
  const beta = 8.6;
  const i0b = besselI0(beta);
  const cutoff = 0.92 * scale;
  const table = new Float64Array(phases * taps);
  for (let p = 0; p < phases; p++) {
    const frac = p / phases;
    let sum = 0;
    for (let t = 0; t < taps; t++) {
      const x = t - half - frac;
      const xs = x * cutoff;
      const s = Math.abs(xs) < 1e-9 ? 1 : Math.sin(Math.PI * xs) / (Math.PI * xs);
      const r = x / (half + 1);
      const k = Math.abs(r) >= 1 ? 0 : besselI0(beta * Math.sqrt(1 - r * r)) / i0b;
      const v = s * k * cutoff;
      table[p * taps + t] = v;
      sum += v;
    }
    for (let t = 0; t < taps; t++) table[p * taps + t] /= sum;
  }
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Float32Array(outLen);
  const n = input.length;
  for (let i = 0; i < outLen; i++) {
    const num = i * down;
    const base = Math.floor(num / up);
    const rem = num - base * up;
    const p = phases === up ? rem : Math.min(phases - 1, Math.round((rem / up) * phases));
    const row = p * taps;
    let acc = 0;
    const first = base - half;
    const t0 = first < 0 ? -first : 0;
    const t1 = first + taps > n ? n - first : taps;
    for (let t = t0; t < t1; t++) acc += input[first + t] * table[row + t];
    out[i] = acc;
  }
  return out;
}

export function dctMatrix(n) {
  const m = new Float64Array(n * n);
  for (let k = 0; k < n; k++) {
    const a = k === 0 ? Math.sqrt(1 / n) : Math.sqrt(2 / n);
    for (let i = 0; i < n; i++) m[k * n + i] = a * Math.cos((Math.PI * (i + 0.5) * k) / n);
  }
  return m;
}
