const cancelled = () => Object.assign(new Error('Playback preparation cancelled'), { name: 'AbortError' });

/** One owner may release the transport. Superseded readiness never plays audio. */
export function createRenderReadyPlayback() {
  let owner = null, status = 'idle', error = null;
  return {
    get status() { return status; },
    get error() { return error; },
    cancel() { owner?.abort(); owner = null; status = 'idle'; error = null; },
    begin({ hold, prepare, start, fail = () => {}, isCurrent = () => true }) {
      owner?.abort();
      const mine = new AbortController(); owner = mine; status = 'preparing'; error = null;
      hold();
      return Promise.resolve().then(() => {
        if (mine.signal.aborted || !isCurrent()) throw cancelled();
        return prepare(mine.signal);
      }).then(() => {
        if (owner !== mine || mine.signal.aborted || !isCurrent()) return { status: 'cancelled' };
        start(); status = 'ready'; return { status };
      }).catch(reason => {
        if (owner !== mine || mine.signal.aborted || !isCurrent()) return { status: 'cancelled' };
        status = 'failed'; error = reason; fail(reason); return { status, error: reason };
      });
    },
  };
}

function bounded(promise, signal, timeoutMs) {
  if (signal?.aborted) return Promise.reject(cancelled());
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(cancelled()); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('Landscape preparation timed out. Please retry.')); }, Math.max(1, timeoutMs));
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, reason => { cleanup(); reject(reason); });
  });
}

/** Prime the fixed destination, then await its real scenic draw and full window. */
export async function waitForScenicReady({ presentation, draw, signal, timeoutMs = 120000,
  wait = () => new Promise(resolve => setTimeout(resolve, 25)) }) {
  if (!presentation?.enabled) return;
  const deadline = Date.now() + timeoutMs;
  const check = () => { if (signal?.aborted) throw cancelled(); };
  check(); draw({ preparing: true });
  await bounded(presentation.whenReady({ timeoutMs, signal }), signal, deadline - Date.now());
  while (Date.now() < deadline) {
    check(); draw({ preparing: true });
    const snapshot = presentation.snapshot();
    const wanted = presentation._wants || [];
    const failure = wanted.map(view => snapshot.failures?.[view.id]).find(Boolean);
    if (snapshot.runtime === 'failed' || failure)
      throw new Error(failure || snapshot.reason || 'The landscape renderer could not start.');
    await bounded(presentation.settle?.({ timeoutMs: Math.max(1, deadline - Date.now()) }), signal, deadline - Date.now());
    check(); const frame = draw({ preparing: true });
    const complete = wanted.every(view => {
      const prepared = presentation.scene?.prepared?.get(view.id);
      return prepared && (!prepared.windowCache || (!prepared.activeWindow?.coarse && prepared.windowCoverage?.covered
        && prepared.activeWindow?.index === prepared.windowCache.current
        && prepared.windowCache.resident.get(prepared.windowCache.current) === prepared.activeWindow));
    });
    if (frame?.presented && presentation.active && !(presentation._needed?.size > 0) && complete) {
      // Priming may paint a covering coarse window. Only this final full
      // destination draw can consume assembly/finale/highlight captures.
      check();
      const admitted = draw({ preparing: false });
      if (admitted?.presented) return;
    }
    if (!wanted.length && presentation.runtimeState === 'ready' && !presentation.scene?.contextLost)
      throw new Error(snapshot.reason || 'No prepared landscape is available for this song.');
    await bounded(wait(), signal, deadline - Date.now());
  }
  throw new Error('Landscape preparation timed out. Please retry.');
}
