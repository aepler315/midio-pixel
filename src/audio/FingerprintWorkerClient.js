// Fingerprint a decoded song without holding the main thread for it.
//
// A five-minute song's fingerprint is about 1.2s of FFTs, and it runs while
// the song's opening is analysed (OpeningAnalysis.js), so on the main thread
// it held the world picker back by that much. The cheap half -- resampling
// each channel to 8kHz, and the level and stereo measurements -- stays here;
// the FFTs run in fingerprintWorker.js. The result is identical to
// fingerprintBuffer's. Anywhere a module worker cannot start, it falls back
// to a cooperative main-thread calculation. Runtime worker failures reject;
// the optional cache lookup treats those as a cache miss.
import { fingerprintInputsAsync, fingerprintSignalsAsync, fingerprintResult } from './SongFingerprint.js';
import { audioAbortError, throwIfAborted } from './loadLimits.js';

// The original desktop measurement was about 1.2s of FFTs for five minutes.
// Allow 120s for the supported 20-minute input, including preparation and
// startup, well above that extrapolation. Constrained devices may expire;
// optional caching then yields to analysis instead of waiting forever.
export const FINGERPRINT_DEADLINE_MS = 120000;

function startWorker() {
  if (typeof Worker !== 'function' || typeof URL !== 'function') return null;
  try {
    return new Worker(new URL('./fingerprintWorker.js', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
}

/** Resolves with fingerprintBuffer(buffer)'s identical result. The deadline
 * covers preparation, worker work and unsupported-worker fallback. Abort never
 * starts fallback. A runtime failure rejects so the caller can skip caching. */
export async function fingerprintBufferOffThread(buffer, {
  signal = null, deadlineMs = FINGERPRINT_DEADLINE_MS,
} = {}) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const cancellation = new AbortController();
    let worker = null, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      if (worker) {
        worker.onmessage = worker.onerror = worker.onmessageerror = null;
        worker.terminate();
      }
      cancellation.abort();
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(audioAbortError());
    const timeout = setTimeout(() => {
      const error = new Error('Fingerprint deadline exceeded');
      error.name = 'TimeoutError';
      finish(error);
    }, Number.isFinite(deadlineMs) && deadlineMs > 0 ? deadlineMs : FINGERPRINT_DEADLINE_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    const prepare = async () => {
      const inputs = await fingerprintInputsAsync(buffer, {
        signal: cancellation.signal,
        forTransfer: typeof Worker === 'function' && typeof URL === 'function',
      });
      if (settled) return;
      worker = startWorker();
      if (!worker) {
        const frames = await fingerprintSignalsAsync(inputs.signals, { signal: cancellation.signal });
        if (!settled) finish(null, fingerprintResult(frames, inputs.signal, inputs.durationMs));
        return;
      }
      worker.onmessage = e => {
        if (settled) return;
        if (!e.data?.ok) { finish(new Error('Fingerprint worker failed')); return; }
        try { finish(null, fingerprintResult(e.data, inputs.signal, inputs.durationMs)); }
        catch (error) { finish(error); }
      };
      worker.onerror = e => { e?.preventDefault?.(); finish(new Error('Fingerprint worker failed')); };
      worker.onmessageerror = () => finish(new Error('Fingerprint worker message could not be decoded'));
      worker.postMessage({ signals: inputs.signals }, inputs.signals.map(s => s.buffer));
    };
    prepare().catch(error => finish(error));
  });
}
