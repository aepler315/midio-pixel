// Naming a recording by what it sounds like.
//
// The engine's expensive knowledge about a song -- band energies across the
// whole timeline, the bar grid, the structural boundaries, the note timeline
// -- takes tens of seconds to compute and is identical every time the same
// recording is analysed. To reuse it, or one day to serve it from a database
// while the listener's own app plays the audio, the analysis needs a KEY: a
// short, stable name for "this recording", derivable from the audio alone.
//
// A file hash cannot be that key. The same master as mp3 and as flac is the
// same performance and must get the same show, and their bytes share nothing.
// Nor can artist/title metadata: it is missing, misspelled, or attached to a
// remaster with different timings, and it cannot be checked against the sound
// at all.
//
// So this is an acoustic fingerprint, in the Haitsma-Kalker form: for each
// short frame, one bit per band saying whether that band's energy rose
// relative to its neighbour, compared against the previous frame. Two
// properties make it the right tool:
//
//   IT SURVIVES ENCODING. Every bit is a SIGN of a DIFFERENCE of a
//   DIFFERENCE. Lossy compression, EQ, a volume change and a different
//   sample rate all move absolute energies; they rarely flip the sign of a
//   local slope. Absolute-energy fingerprints do not survive any of that.
//
//   IT ALIGNS. The frames form a sequence, so two recordings are compared by
//   sliding one against the other and taking the lowest bit error rate. The
//   offset that wins is not just evidence of a match -- it is HOW FAR INTO
//   THE SONG the other recording is. The same routine that answers "is this
//   the same song?" answers "and what time is it?", which is exactly what
//   syncing a stored analysis to audio playing in the room requires.
//
// The band range is deliberately narrow (300-2000 Hz). That is where most
// music has energy and where perceptual codecs preserve the most detail;
// including the sub-bass and the top octave would add bits that MP3 and a
// phone speaker both destroy.
//
// One property worth knowing before trusting a reading: A BAND WITH NO
// SIGNAL IN IT PRODUCES A MEANINGLESS BIT. The sign of a difference between
// two empty bands is decided by numerical residue, so it is effectively a
// coin flip that any perturbation re-flips. Over music this does not matter
// -- the range is chosen precisely because music occupies it -- but it means
// near-silence, a lone sine tone, or a heavily band-limited source will
// report a high bit error rate against themselves under any noise at all.
// Treat a match verdict over near-silent audio as no verdict.
import { fft } from './PitchTracker.js';
import { throwIfAborted } from './loadLimits.js';

function exhaust(steps) {
  let step;
  do { step = steps.next(); } while (!step.done);
  return step.value;
}

async function exhaustCooperatively(steps, signal) {
  for (;;) {
    throwIfAborted(signal);
    const step = steps.next();
    if (step.done) return step.value;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

// Everything below happens at a reduced rate, and that single decision is
// what makes the fingerprint both fast and alignable.
//
// The bits only describe 300-2000 Hz, so a rate of 8k is already generous
// (Nyquist 4k). Resampling first shrinks every FFT by more than five times,
// and the saving is spent on OVERLAP -- which is what alignment actually
// needs. Two recordings of the same song rarely start on the same sample, so
// a probe's frame grid sits at a fractional hop offset from the reference's;
// with a quarter-window hop those frames straddle different audio and the
// match degrades badly even for an identical excerpt. An eighth-hop at this
// rate puts a reference frame within 8ms of every probe frame, and costs
// less than the coarse version did at full rate.
/** Rate the fingerprint is computed at, after resampling. */
export const FP_RATE = 8000;
/** Frame length in samples: 128ms at FP_RATE, several cycles even at 300Hz. */
export const FP_WINDOW = 1024;
/** Hop between frames: 16ms, an eighth of a window. */
export const FP_HOP = 128;
/** Bits per frame. 33 band edges give 32 differences, which is one uint32. */
export const FP_BITS = 32;
const FP_BANDS = FP_BITS + 1;
/** The band range that survives lossy encoding and a room. */
export const FP_LO_HZ = 300, FP_HI_HZ = 2000;

/** Logarithmically spaced band edges across FP_LO_HZ..FP_HI_HZ. */
export function bandEdges(sampleRate, fftSize) {
  const edges = new Array(FP_BANDS + 1);
  const ratio = FP_HI_HZ / FP_LO_HZ;
  const binHz = sampleRate / fftSize;
  for (let i = 0; i <= FP_BANDS; i++) {
    const hz = FP_LO_HZ * Math.pow(ratio, i / FP_BANDS);
    edges[i] = Math.max(1, Math.round(hz / binHz));
  }
  // Degenerate bands (two edges landing on the same bin, which happens at low
  // sample rates) would make every bit in that pair a constant. Nudge them
  // apart so each band owns at least one bin.
  for (let i = 1; i <= FP_BANDS; i++) if (edges[i] <= edges[i - 1]) edges[i] = edges[i - 1] + 1;
  return edges;
}

/** Plain average of an AudioBuffer's channels. Accepts anything with
 *  `numberOfChannels`, `length` and `getChannelData`, so tests can pass a
 *  stub rather than constructing a Web Audio buffer. */
export function toMono(buffer) {
  const n = buffer.length;
  const chans = buffer.numberOfChannels;
  const out = new Float32Array(n);
  for (let c = 0; c < chans; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += data[i] / chans;
  }
  return out;
}

/**
 * Resample to FP_RATE by averaging each output sample's source window.
 *
 * The box average is a crude low-pass, but it is the right crude one here:
 * without any anti-aliasing, content above the new Nyquist folds down INTO
 * the 300-2000 Hz range the bits are read from, and a cymbal would rewrite
 * the fingerprint of the bass line underneath it.
 */
export function resampleMono(mono, fromRate, toRate = FP_RATE) {
  return exhaust(resampleSteps(mono, fromRate, toRate));
}

function* resampleSteps(mono, fromRate, toRate) {
  if (!(fromRate > 0) || fromRate === toRate) return mono;
  const ratio = fromRate / toRate;
  const n = Math.floor(mono.length / ratio);
  const out = new Float32Array(Math.max(0, n));
  for (let i = 0; i < n; i++) {
    const start = i * ratio;
    const end = start + ratio;
    const i0 = Math.floor(start);
    const i1 = Math.min(mono.length, Math.ceil(end));
    let sum = 0, count = 0;
    for (let k = i0; k < i1; k++) { sum += mono[k]; count++; }
    out[i] = count > 0 ? sum / count : 0;
    if ((i + 1) % 8192 === 0) yield;
  }
  return out;
}

/**
 * The fingerprint sequence: one uint32 per frame.
 *
 * @param {Float32Array} mono
 * @param {number} sampleRate the rate `mono` is at; it is resampled to
 *   FP_RATE internally, so the returned sequence is comparable across
 *   sources recorded at different rates
 * @returns {{frames: Uint32Array, frameHz: number}}
 */
export function fingerprintMono(mono, sampleRate) {
  return fingerprintChannels([mono], sampleRate);
}

// Add spectral power, not signed samples: opposite-phase channels must not cancel.
function fingerprintChannels(channels, sampleRate) {
  return fingerprintSignals(channels.map((channel) => resampleMono(channel, sampleRate, FP_RATE)));
}

/** The frames from channels already resampled to FP_RATE -- the expensive
 *  half of a fingerprint, and the half fingerprintWorker.js runs off the
 *  main thread. */
export function fingerprintSignals(signals) {
  return exhaust(fingerprintSignalSteps(signals));
}

/** Same arithmetic and frames, yielding between bounded groups of FFTs. */
export function fingerprintSignalsAsync(signals, { signal = null } = {}) {
  return exhaustCooperatively(fingerprintSignalSteps(signals), signal);
}

function* fingerprintSignalSteps(signals) {
  const frameHz = FP_RATE / FP_HOP;
  const sig = signals[0];
  const count = Math.max(0, Math.floor((sig.length - FP_WINDOW) / FP_HOP) + 1);
  if (count < 2) return { frames: new Uint32Array(0), frameHz };
  const edges = bandEdges(FP_RATE, FP_WINDOW);
  const re = new Float64Array(FP_WINDOW);
  const im = new Float64Array(FP_WINDOW);
  // Hann window: without it, every frame boundary is a discontinuity whose
  // spectral splatter is louder than the music in the high bands.
  const win = new Float64Array(FP_WINDOW);
  for (let i = 0; i < FP_WINDOW; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FP_WINDOW - 1));

  const frames = new Uint32Array(count - 1);
  let prev = null;
  for (let f = 0; f < count; f++) {
    const off = f * FP_HOP;
    const energies = new Float64Array(FP_BANDS);
    for (const channel of signals) {
      for (let i = 0; i < FP_WINDOW; i++) { re[i] = channel[off + i] * win[i]; im[i] = 0; }
      fft(re, im);
      for (let b = 0; b < FP_BANDS; b++) {
        let sum = 0;
        for (let k = edges[b]; k < edges[b + 1]; k++) sum += re[k] * re[k] + im[k] * im[k];
        energies[b] += sum;
      }
    }
    if (prev) {
      let bits = 0;
      for (let b = 0; b < FP_BITS; b++) {
        // The double difference: this band against its neighbour, now against
        // then. Both subtractions are what make the bit survive a codec.
        const d = (energies[b] - energies[b + 1]) - (prev[b] - prev[b + 1]);
        if (d > 0) bits |= (1 << b);
      }
      frames[f - 1] = bits >>> 0;
    }
    prev = energies;
    if ((f + 1) % 128 === 0) yield;
  }
  return { frames, frameHz };
}

/** Fingerprint a decoded AudioBuffer. */
export function fingerprintBuffer(buffer) {
  const { signals, signal, durationMs } = fingerprintInputs(buffer);
  return fingerprintResult(fingerprintSignals(signals), signal, durationMs);
}

/** The cheap half of a fingerprint, taken from the decoded buffer: each
 *  channel resampled to FP_RATE, and the level and stereo measurements the
 *  cache key also depends on. */
export function fingerprintInputs(buffer) {
  return exhaust(fingerprintInputSteps(buffer));
}

/** Preparation yields during resampling and signal measurements so a replaced
 * selection can cancel before a worker is created. Summation order is shared
 * with the synchronous path to preserve fingerprint bytes and cache identity.
 * forTransfer privately copies only a resampled signal that aliases input. */
export function fingerprintInputsAsync(buffer, { signal = null, forTransfer = false } = {}) {
  return exhaustCooperatively(fingerprintInputSteps(buffer, forTransfer), signal);
}

function* fingerprintInputSteps(buffer, forTransfer = false) {
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const signals = [];
  for (const channel of channels) {
    let sampled = yield* resampleSteps(channel, buffer.sampleRate, FP_RATE);
    // Already-8k input is returned unchanged by resampling. A worker may
    // transfer only its private signals, never the decoded audio channels.
    // Chunk this exceptional copy so preparation remains abortable/bounded.
    if (forTransfer && sampled.buffer === channel.buffer) {
      const owned = new Float32Array(sampled.length);
      for (let i = 0; i < sampled.length; i += 8192) {
        owned.set(sampled.subarray(i, Math.min(i + 8192, sampled.length)), i);
        yield;
      }
      sampled = owned;
    }
    signals.push(sampled);
  }
  // Matching tolerates gain/phase changes; cached analysis does not (absolute
  // silence thresholds and stereo width differ). Carry those inputs separately.
  const channelRms = [];
  for (const channel of channels) {
    let power = 0;
    for (let i = 0; i < channel.length; i++) {
      const value = channel[i];
      power += value * value;
      if ((i + 1) % 65536 === 0) yield;
    }
    channelRms.push(Math.sqrt(power / Math.max(1, channel.length)));
  }
  let crossPower = 0;
  if (channels.length > 1) {
    for (let i = 0; i < buffer.length; i++) {
      crossPower += channels[0][i] * channels[1][i];
      if ((i + 1) % 65536 === 0) yield;
    }
  }
  const signal = { sampleRate: buffer.sampleRate, length: buffer.length,
    channelRms, crossPower: crossPower / Math.max(1, buffer.length) };
  return { signals, signal, durationMs: (buffer.duration || 0) * 1000 };
}

/** A fingerprint from its frames and its buffer's measurements. */
export function fingerprintResult({ frames, frameHz }, signal, durationMs) {
  const { channelRms } = signal;
  // Empty/constant fingerprints carry no distinguishing temporal information.
  // A new namespace prevents old channel-cancelled bundles from being reused.
  const informative = channelRms.some((rms) => rms > 1e-6)
    && frames.length > 1 && frames.some((frame) => frame !== frames[0]);
  const key = informative ? fingerprintKey(frames).replace('fp1_', 'fp2_') : null;
  return { frames, frameHz, key, signal, durationMs };
}

/**
 * A short, stable, printable name for a fingerprint sequence.
 *
 * This is an EXACT key -- the same decode of the same file always produces
 * it, and it is what a local cache looks up. It is deliberately not the
 * matching mechanism: two different rips of one master will differ in a small
 * fraction of their bits and therefore in this key. Matching those is
 * `bestAlignment`'s job, and a server would index the frames themselves.
 */
export function fingerprintKey(frames) {
  // FNV-1a over the byte view, in two independent lanes so the printed key
  // is 128 bits' worth of distinctness rather than 32.
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < frames.length; i++) {
    const v = frames[i];
    h1 ^= v; h1 = Math.imul(h1, 0x01000193);
    h2 = Math.imul(h2 ^ (v >>> 16), 0x85ebca6b);
    h2 ^= h2 >>> 13;
  }
  const n = frames.length >>> 0;
  const hex = (v) => (v >>> 0).toString(16).padStart(8, '0');
  return `fp1_${hex(h1)}${hex(h2)}${hex(n)}`;
}

/** Population count of a 32-bit word. */
function popcount(v) {
  v = v - ((v >> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
  v = (v + (v >> 4)) & 0x0f0f0f0f;
  return (Math.imul(v, 0x01010101) >> 24) & 0xff;
}

/**
 * Bit error rate between two equal-length fingerprint runs.
 *
 * 0 is identical; 0.5 is what two unrelated recordings give, because
 * independent bits agree half the time. That is the number to calibrate
 * against -- not 1.
 */
export function bitErrorRate(a, b, aOff = 0, bOff = 0, len = 0) {
  const n = len || Math.min(a.length - aOff, b.length - bOff);
  if (n <= 0) return 1;
  let diff = 0;
  for (let i = 0; i < n; i++) diff += popcount((a[aOff + i] ^ b[bOff + i]) >>> 0);
  return diff / (n * FP_BITS);
}

/**
 * Slide `probe` along `reference` and return the best-fitting position.
 *
 * This is the routine that makes a stored analysis usable against audio
 * someone else is playing: `offsetFrames` is how far into the reference the
 * probe begins, which converted by `frameHz` is a playback position in
 * milliseconds. A short probe (a few seconds heard through a microphone)
 * against a full-song reference answers both "is this that song?" and "and
 * where are we in it?" in one pass.
 *
 * @param {Uint32Array} reference the full song's fingerprint
 * @param {Uint32Array} probe a shorter run to locate within it
 * @param {object} [opts]
 * @param {number} [opts.step] stride in frames; >1 trades accuracy for speed
 * @returns {{offsetFrames:number, ber:number}} ber is the bit error rate at
 *   the winning offset -- the caller decides what counts as a match
 */
export function bestAlignment(reference, probe, { step = 1 } = {}) {
  if (!reference?.length || !probe?.length || probe.length > reference.length) {
    return { offsetFrames: 0, ber: 1 };
  }
  const last = reference.length - probe.length;
  let bestBer = 1, bestOff = 0;
  for (let off = 0; off <= last; off += step) {
    const ber = bitErrorRate(reference, probe, off, 0, probe.length);
    if (ber < bestBer) { bestBer = ber; bestOff = off; }
  }
  return { offsetFrames: bestOff, ber: bestBer };
}

/**
 * Do these two fingerprints name the same recording?
 *
 * The threshold is well under the 0.5 that unrelated audio produces and well
 * above the near-0 an identical decode gives, which leaves room for a
 * different encoding of the same master to land on the right side of it.
 */
export const MATCH_BER = 0.28;

export function sameRecording(a, b, { step = 4 } = {}) {
  if (!a?.length || !b?.length) return false;
  const [ref, probe] = a.length >= b.length ? [a, b] : [b, a];
  return bestAlignment(ref, probe, { step }).ber <= MATCH_BER;
}
