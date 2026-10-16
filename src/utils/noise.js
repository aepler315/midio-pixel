// 1-D value noise with fractal (multi-octave) summation. Used for terrain
// silhouettes, screen-shake direction, and heat-shimmer.
import { mulberry32 } from './math.js';

export class ValueNoise1D {
  constructor(seed = 1, size = 256) {
    const rand = mulberry32(seed);
    this.size = size;
    this.table = new Float32Array(size);
    for (let i = 0; i < size; i++) this.table[i] = rand() * 2 - 1;
  }

  /** Smooth-interpolated single-octave noise at arbitrary x. */
  sample(x) {
    const s = this.size;
    const xi = Math.floor(x);
    const t = x - xi;
    const a = this.table[((xi % s) + s) % s];
    const b = this.table[(((xi + 1) % s) + s) % s];
    const ft = t * t * (3 - 2 * t);
    return a + (b - a) * ft;
  }

  /** Fractal Brownian motion: sum of octaves, each half the amplitude and double the frequency. */
  fbm(x, octaves = 3, lacunarity = 2, gain = 0.5) {
    let amp = 1, freq = 1, sum = 0, norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.sample(x * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }
}

/** Ridged variant: folds noise around zero, producing mountain-ridge silhouettes. */
export function ridged(noise, x, octaves = 2, lacunarity = 2, gain = 0.5) {
  let amp = 1, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = 1 - Math.abs(noise.sample(x * freq));
    sum += amp * n * n;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
