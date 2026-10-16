import { analyzeStructureAsync, boundedStructureInput } from './StructureAnalyzer.js';
import { audioAbortError, throwIfAborted } from './loadLimits.js';

/** A module worker owns both matrices and releases them on termination.
 * Startup/load/post failures use the bounded cooperative implementation. */
export async function analyzeStructureOffThread(input, { signal = null, workerFactory = null } = {}) {
  throwIfAborted(signal);
  const bounded = boundedStructureInput(input);
  let worker;
  try {
    worker = workerFactory ? workerFactory() : typeof Worker === 'function'
      ? new Worker(new URL('./structureWorker.js', import.meta.url), { type: 'module' }) : null;
  } catch { worker = null; }
  if (!worker) return analyzeStructureAsync(bounded, { signal });
  const result = await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      fn(value);
    };
    const onAbort = () => finish(reject, audioAbortError());
    const timeout = setTimeout(() => finish(resolve, { failed: true }), 15000);
    signal?.addEventListener('abort', onAbort, { once: true });
    worker.onmessage = e => finish(resolve, e.data?.ok ? { structure: e.data.structure } : { failed: true });
    worker.onerror = e => { e?.preventDefault?.(); finish(resolve, { failed: true }); };
    try {
      const c = bounded.energyCurves;
      worker.postMessage({ ...bounded, energyCurves: c ? { n: c.n, rateHz: c.rateHz, bands: c.bands, rmsBands: c.rmsBands } : null });
    } catch { finish(resolve, { failed: true }); }
    if (signal?.aborted) onAbort();
  });
  throwIfAborted(signal);
  return result.failed ? analyzeStructureAsync(bounded, { signal }) : result.structure;
}
