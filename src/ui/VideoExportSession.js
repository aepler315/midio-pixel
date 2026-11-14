const abortError = () => new DOMException('Video export cancelled.', 'AbortError');

/** Cancel a preparation wait without leaving an abort listener on the song. */
export function waitForExport(promise, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => { signal?.removeEventListener('abort', abort); reject(abortError()); };
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(value => {
      signal?.removeEventListener('abort', abort); resolve(value);
    }, error => {
      signal?.removeEventListener('abort', abort); reject(error);
    });
  });
}

/** One owner from preparation through encoder teardown and playback restore.
 * The renderer/encoder implement their own abort-aware work; restoring cannot
 * race a still-running encoder. A new song owns the page once isCurrent fails. */
export class VideoExportSession {
  constructor({ onState = () => {} } = {}) {
    this.onState = onState;
    this.state = Object.freeze({ phase: 'idle', busy: false, progress: 0, error: null });
    this.controller = null;
  }

  get busy() { return this.state.busy; }
  cancel() { this.controller?.abort(); }

  _state(patch) {
    this.state = Object.freeze({ ...this.state, ...patch });
    this.onState(this.state);
  }

  async run({ prepare, encode, restore = async () => {}, discard = async () => {}, isCurrent = () => true } = {}) {
    if (this.busy) throw Error('A video export is already running.');
    const controller = this.controller = new AbortController();
    const { signal } = controller;
    const check = () => { if (signal.aborted || !isCurrent()) throw abortError(); };
    this._state({ phase: 'preparing', busy: true, progress: 0, error: null });
    let context, result, failure = null, cancelled = false;
    try {
      check();
      context = await prepare(signal);
      check();
      this._state({ phase: 'encoding' });
      result = await encode(context, { signal, onProgress: progress => this._state(progress) });
      check();
    } catch (error) {
      cancelled = error?.name === 'AbortError';
      if (!cancelled) failure = error;
    } finally {
      this._state({ phase: 'restoring' });
      try {
        if (isCurrent()) await restore(context, { cancelled, error: failure });
        else await discard(context);
      } catch (error) { failure ||= error; }
      this.controller = null;
      this._state({ busy: false, phase: failure ? 'error' : cancelled ? 'cancelled' : 'complete',
        error: failure?.message || null, ...(!failure && !cancelled ? { progress: 1 } : {}) });
    }
    if (failure) throw failure;
    return cancelled ? null : result;
  }
}
