// Seven-band stem separation via parallel OfflineAudioContext renders with
// Linkwitz-Riley 24dB/oct crossovers (spec §1.2.2). LR4 edges are chosen
// because adjacent bands sum flat and phase-coherent — the seven stems,
// summed, reconstruct the mix without comb notches.
import { BANDS } from './bands.js';
import { throwIfAborted } from './loadLimits.js';

async function renderBand(srcBuf, fLo, fHi, signal = null) {
  throwIfAborted(signal);
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new OfflineCtx(srcBuf.numberOfChannels, srcBuf.length, srcBuf.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = srcBuf;
  let node = src;

  const chain = [];
  if (fLo > 20) chain.push(['highpass', fLo], ['highpass', fLo]);
  if (fHi < 16000) chain.push(['lowpass', fHi], ['lowpass', fHi]);
  for (const [type, f] of chain) {
    const b = ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = Math.SQRT1_2; // 1/sqrt(2) — Butterworth Q, two cascaded = LR4
    node.connect(b);
    node = b;
  }
  node.connect(ctx.destination);
  src.start(0);
  const rendered = await ctx.startRendering();
  throwIfAborted(signal);
  return rendered;
}

/** @returns {Promise<AudioBuffer[]>} 7 band-limited AudioBuffers, same length/rate as the source. */
export async function separateStems(sourceBuffer, onProgress = null, signal = null) {
  let done = 0;
  const renders = BANDS.map(([lo, hi]) =>
    renderBand(sourceBuffer, lo, hi, signal).then((buf) => {
      done++;
      if (onProgress) onProgress(done / BANDS.length);
      return buf;
    }));
  return Promise.all(renders);
}

/**
 * Renders the 7 bands ONE AT A TIME rather than all in parallel, handing
 * each to `onBand(index, buffer)` as soon as it's ready. separateStems'
 * Promise.all keeps every band's full-length AudioBuffer resident
 * simultaneously purely so the caller can iterate them together afterward
 * -- 7 stereo buffers the length of the source track, ~565MB for a 4-minute
 * 44.1kHz song, and a real OOM risk on mobile. A caller that only needs each
 * band's compact envelope (a few hundred bytes/second, not the raw audio)
 * can extract it inside `onBand` and let the buffer fall out of scope before
 * the next render starts, so peak memory is bounded by ONE band's buffer
 * rather than all seven.
 *
 * Sequential rather than parallel: OfflineAudioContext rendering is native
 * and reasonably fast on its own, so the loss from giving up 7-way
 * concurrency is a rendering-time cost; the 565MB simultaneous peak is a
 * memory-budget cost that can crash the tab outright. The former is the
 * safer trade.
 */
export async function separateStemsSequential(sourceBuffer, onBand, onProgress = null, signal = null) {
  for (let i = 0; i < BANDS.length; i++) {
    throwIfAborted(signal);
    const [lo, hi] = BANDS[i];
    const buf = await renderBand(sourceBuffer, lo, hi, signal);
    await onBand(i, buf);
    throwIfAborted(signal);
    if (onProgress) onProgress((i + 1) / BANDS.length);
  }
}

/**
 * separateStemsSequential with up to `concurrency` bands rendering at once.
 * OfflineAudioContext renders on its own native thread, so two or three in
 * flight finish in about half the wall time of one after another -- on a
 * 3.5-minute song the seven renders were 3.4 of the 7 seconds before the
 * world picker. Memory stays bounded by `concurrency` band buffers, not
 * seven (the reason the sequential version exists). `onBand(index, buffer)`
 * is called once per band, one at a time, in completion order; each band's
 * index says which it is. The results are the same renders as the
 * sequential path, so the analysis is identical.
 */
export async function separateStemsPooled(sourceBuffer, onBand, onProgress = null, signal = null, concurrency = 3) {
  const n = BANDS.length;
  const limit = Math.max(1, Math.min(n, Math.floor(concurrency) || 1));
  let next = 0;
  let done = 0;
  // onBand runs strictly one at a time, so a caller's per-band work never
  // interleaves with another band's.
  let chain = Promise.resolve();
  const runOne = async () => {
    while (next < n) {
      const i = next++;
      throwIfAborted(signal);
      const [lo, hi] = BANDS[i];
      const buf = await renderBand(sourceBuffer, lo, hi, signal);
      chain = chain.then(async () => {
        throwIfAborted(signal);
        await onBand(i, buf);
        done++;
        if (onProgress) onProgress(done / n);
      });
      await chain;
    }
  };
  await Promise.all(Array.from({ length: limit }, runOne));
  await chain;
}

/**
 * How many bands to render at once without risking the tab. Each band in
 * flight is a full-length copy of the song (a 3.5-minute stereo 44.1kHz
 * track: ~74MB), and a phone that runs out kills the page, so the budget
 * scales with the device's reported memory (navigator.deviceMemory, in GB;
 * 4 assumed when unknown): 64MB per GB. A typical song on a 4GB phone gets
 * three; a long one, or a 2GB device, falls back toward one at a time.
 */
export function bandRenderConcurrency({ length = 0, channels = 2, deviceMemoryGb = null } = {}) {
  const gb = Number.isFinite(deviceMemoryGb) && deviceMemoryGb > 0 ? Math.min(8, deviceMemoryGb) : 4;
  const bandBytes = Math.max(1, length) * Math.max(1, channels) * 4;
  return Math.max(1, Math.min(3, Math.floor((gb * 64 * 1024 * 1024) / bandBytes)));
}
