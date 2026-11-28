import { audioAbortError, throwIfAborted } from './loadLimits.js';
import { copySongprint } from './SongprintData.js';

// One transfer in flight. Keep playback's AudioBuffer intact even when a worker
// dies or the user loads another song. Null means analysed with no tonal
// evidence; undefined means the optional job failed and may be retried.
export async function analyzeSongprintOffThread(buffer, { signal, workerFactory, timeoutMs = 120000, phrases = false, fable = false } = {}) {
  throwIfAborted(signal);
  let worker;
  try {
    worker = workerFactory ? workerFactory() : new Worker(new URL('./songprintWorker.js', import.meta.url), { type: 'module' });
  } catch { return undefined; }
  if (!worker) return undefined;
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      fn(value);
    };
    const abort = () => finish(reject, audioAbortError());
    const fail = () => finish(resolve, undefined);
    const timeout = setTimeout(fail, timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    worker.onerror = e => { e?.preventDefault?.(); fail(); };
    worker.onmessageerror = fail;
    worker.onmessage = ({ data }) => {
      if (done) return;
      try {
        if (data?.type === 'done') {
          const print = data.songprint === null ? null : copySongprint(data.songprint, buffer.duration * 1000) ?? undefined;
          finish(resolve, phrases && print?.skyline && !print.phraseFamilies ? undefined : print);
        } else if (data?.type === 'read') {
          const { start, channel } = data;
          if (!Number.isInteger(start) || start < 0 || start >= buffer.length) return fail();
          const planes = [];
          const startChannel = channel ?? 0;
          const stopChannel = channel == null ? buffer.numberOfChannels : channel + 1;
          for (let ch = startChannel; ch < stopChannel; ch++) {
            planes.push(buffer.getChannelData(ch).slice(start, start + 65536));
          }
          worker.postMessage({ type: 'block', planes }, planes.map(p => p.buffer));
        } else fail();
      } catch { fail(); }
    };
    if (signal?.aborted) return abort();
    try {
      worker.postMessage({ type: 'start', rate: buffer.sampleRate, frames: buffer.length, channels: buffer.numberOfChannels, phrases, fable });
    } catch { fail(); }
  });
}
