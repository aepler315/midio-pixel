// Runs the pitch analysis in Web Workers so it overlaps the band analysis
// instead of queueing behind it: on a 3.5-minute song the pitch pass alone
// was two of the seven seconds between choosing a file and the world
// picker. The workers compute exactly what the main-thread path does
// (PitchTracker.computePitchFeatures); anywhere a module worker cannot start
// -- Node, an old WebView, a blocked worker -- it falls back to that path.
//
// A long song is split across two workers. Every pitch frame is computed
// from its own window of samples alone, so frames [a, b) computed from the
// samples starting at a*hop are exactly frames a..b-1 of the whole song, and
// the halves concatenate to the same result.
import { DEFAULT_HOP, DEFAULT_WIN, computePitchFeaturesAsync } from './PitchTracker.js';
import { audioAbortError } from './loadLimits.js';

// Songs shorter than this gain too little from a second worker to pay for
// starting it.
const SPLIT_MIN_SECONDS = 90;
// The supported input reaches 20 minutes. Give slow devices 120s per worker
// before replacing a silent/failed worker with the cooperative calculation.
export const PITCH_WORKER_DEADLINE_MS = 120000;

function startWorker() {
  if (typeof Worker !== 'function' || typeof URL !== 'function') return null;
  try {
    return new Worker(new URL('./pitchWorker.js', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

/** How many workers to split a song's pitch pass across: two for a long
 *  song on a device with four or more cores, otherwise one. */
export function pitchWorkerCount({ seconds = 0, cores = null } = {}) {
  const n = Number.isFinite(cores) && cores > 0 ? cores : 2;
  return seconds >= SPLIT_MIN_SECONDS && n >= 4 ? 2 : 1;
}

/** Frame ranges [start, end) splitting `numFrames` into `parts`. */
export function frameRanges(numFrames, parts) {
  const out = [];
  for (let p = 0; p < parts; p++) {
    const start = Math.floor((numFrames * p) / parts);
    const end = Math.floor((numFrames * (p + 1)) / parts);
    if (end > start) out.push([start, end]);
  }
  return out;
}

/** Run one worker over already-copied channels. Resolves with its
 *  features, or null when the worker could not run (the caller falls
 *  back). Rejects only on abort. */
function runWorker(copies, sampleRate, options, signal, deadlineMs) {
  if (signal?.aborted) return Promise.reject(audioAbortError());
  const worker = startWorker();
  if (!worker) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener?.('abort', onAbort);
      worker.onmessage = worker.onerror = worker.onmessageerror = null;
      worker.terminate();
      fn(value);
    };
    const onAbort = () => finish(reject, audioAbortError());
    const timeout = setTimeout(() => finish(resolve, null), deadlineMs);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    worker.onmessage = (e) => finish(resolve, e.data?.ok ? e.data.features : null);
    // A worker that cannot load its module (a WebView without module
    // workers) reports an error event rather than throwing at construction.
    worker.onerror = (e) => {
      e?.preventDefault?.();
      finish(resolve, null);
    };
    worker.onmessageerror = () => finish(resolve, null);
    if (signal?.aborted) { onAbort(); return; }
    try { worker.postMessage({ channels: copies, sampleRate, options }, copies.map((c) => c.buffer)); }
    catch { finish(resolve, null); }
  });
}

/**
 * Pitch features for the mix. `channels` are the mix's Float32Arrays; they
 * are copied for the workers, so the caller's buffer is untouched. Aborting
 * `signal` terminates the workers and rejects with an AbortError.
 */
export async function computePitchFeaturesOffThread(channels, sampleRate, {
  signal = null, win = DEFAULT_WIN, hop = DEFAULT_HOP, parts = null,
  deadlineMs = PITCH_WORKER_DEADLINE_MS,
} = {}) {
  if (signal?.aborted) throw audioAbortError();
  const options = { win, hop };
  const fallback = () => computePitchFeaturesAsync(channels, sampleRate, { ...options, signal });
  if (typeof Worker !== 'function') return fallback();
  const length = channels.reduce((m, c) => Math.min(m, c.length), Infinity);
  const numFrames = Math.max(1, Math.floor((length - win) / hop) + 1);
  const count = parts ?? pitchWorkerCount({
    seconds: length / sampleRate,
    cores: typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : null,
  });
  const ranges = length > win ? frameRanges(numFrames, count) : [[0, numFrames]];
  const results = await Promise.all(ranges.map(([start, end]) => {
    const from = start * hop;
    const to = Math.min(length, (end - 1) * hop + win);
    const copies = channels.map((c) => c.slice(from, to));
    return runWorker(copies, sampleRate, options, signal,
      Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : PITCH_WORKER_DEADLINE_MS);
  }));
  if (signal?.aborted) throw audioAbortError();
  if (results.some((r) => !r)) return fallback();
  if (results.length === 1) return results[0];
  const brightness = new Float32Array(numFrames);
  const frames = [];
  let at = 0;
  for (const r of results) {
    for (const f of r.frames) frames.push(f);
    brightness.set(r.brightness, at);
    at += r.brightness.length;
  }
  return { rate: results[0].rate, frames, brightness };
}
