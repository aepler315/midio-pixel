// Band-limit the mix to Songprint's 11,025 Hz before measuring chroma.
// A windowed sinc (Kaiser beta 5, ten zero crossings either side) retains
// filter history across blocks. Fractional phases share a bounded lookup
// table even at unusual native rates.
import { resamplePlan } from './songprintFable/dsp.js';
import { RATE as FABLE_RATE } from './songprintFable/analyze.js';
const PRINT_RATE = 11025;
const MAX_PHASES = 512;

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

function besselZero(x) {
  let term = 1, sum = 1;
  for (let i = 1; i < 50; i++) {
    term *= x * x / (4 * i * i);
    sum += term;
    if (term < sum * 1e-16) break;
  }
  return sum;
}

function polyphaseBank(up, down) {
  const scale = Math.max(1, down / up);
  const radius = Math.ceil(10 * scale);
  const phases = Math.min(up, MAX_PHASES);
  const width = 2 * radius + 1;
  const taps = new Float64Array(phases * width);
  const normalizer = besselZero(5);
  let weight = 0;
  for (let phase = 0; phase < phases; phase++) {
    for (let j = -radius; j <= radius; j++) {
      const x = (j - phase / phases) / scale;
      if (Math.abs(x) > 10) continue;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const value = sinc * besselZero(5 * Math.sqrt(Math.max(0, 1 - (x / 10) ** 2))) / normalizer;
      taps[phase * width + j + radius] = value;
      weight += value;
    }
  }
  // Equal DC gain independent of source sample rate.
  const gain = phases / weight;
  for (let i = 0; i < taps.length; i++) taps[i] *= gain;
  return { phases, taps, width, radius };
}

export class SongprintReducer {
  constructor(rate, frames, channels, { fable = false } = {}) {
    this.rate = rate;
    this.frames = frames;
    this.fable = fable;
    this.targetRate = fable ? FABLE_RATE : PRINT_RATE;
    this.output = new Float32Array(fable ? Math.floor(frames / (rate / FABLE_RATE)) : Math.ceil(frames * PRINT_RATE / rate));
    this.powers = new Float64Array(channels);
    this.monoPower = 0;
    this.singleChannel = null;
    this.framesRead = 0;
    this.cursor = 0;
    this.history = new Float64Array(0);
    this.finished = false;
    const divisor = Number.isInteger(rate) ? gcd(rate, this.targetRate) : 1;
    this.up = this.targetRate / divisor;
    this.down = rate / divisor;
    this.filter = rate === this.targetRate ? null : fable ? resamplePlan(rate, FABLE_RATE) : polyphaseBank(this.up, this.down);
  }

  push(planes) {
    const count = planes[0].length;
    let mono = planes[0];
    if (planes.length > 1) {
      mono = new Float64Array(count);
      for (let ch = 0; ch < planes.length; ch++) {
        let power = 0;
        for (let i = 0; i < count; i++) {
          const x = planes[ch][i];
          mono[i] += x;
          power += x * x;
        }
        this.powers[ch] += power;
      }
      for (let i = 0; i < count; i++) {
        mono[i] /= planes.length;
        this.monoPower += mono[i] * mono[i];
      }
      if (this.fable) mono = Float32Array.from(mono);
    }
    this.resample(mono);
    if (this.framesRead < this.frames) return;
    const channelPower = this.powers.reduce((sum, n) => sum + n, 0) / this.powers.length;
    if (this.fable && this.singleChannel === null)
      this.stereoWidth = planes.length === 2 && channelPower > 0 ? Math.max(0, 1 - this.monoPower / channelPower) : 0;
    if (this.singleChannel === null && this.monoPower < channelPower * 0.04)
      return this.reread(this.powers.indexOf(Math.max(...this.powers)));
    this.finished = true;
  }

  reread(channel) {
    this.singleChannel = channel;
    this.cursor = 0;
    this.framesRead = 0;
    this.history = new Float64Array(0);
    this.finished = false;
  }

  resample(block) {
    const start = this.framesRead - this.history.length;
    this.framesRead += block.length;
    if (this.rate === this.targetRate) {
      this.output.set(block, this.framesRead - block.length);
      return;
    }
    const samples = new Float64Array(this.history.length + block.length);
    samples.set(this.history);
    samples.set(block, this.history.length);
    const { taps, width, radius, phases } = this.filter;
    const final = this.framesRead === this.frames;
    for (; this.cursor < this.output.length; this.cursor++) {
      const position = this.cursor * this.down;
      const center = Math.floor(position / this.up);
      if (!final && center + radius >= this.framesRead) break;
      const phasePosition = (position % this.up) * phases / this.up;
      const phase = this.fable ? Math.min(phases - 1, Math.round(phasePosition)) : Math.floor(phasePosition);
      const left = Math.max(0, center - radius);
      const end = Math.min(this.framesRead - 1, center + radius);
      let tap = phase * width + radius + left - center;
      let sum = 0;
      for (let j = left; j <= end; j++) sum += samples[j - start] * taps[tap++];
      this.output[this.cursor] = sum;
    }
    const nextLeft = Math.floor(this.cursor * this.down / this.up) - radius;
    this.history = samples.slice(Math.max(0, nextLeft - start));
  }
}
