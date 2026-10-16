// Pitch analysis off the main thread. PitchTracker is pure numeric code, so
// the worker runs the exact same computation (computePitchFeatures) on a
// copy of the mix and posts the features back: the result is identical to
// the main-thread path, it just no longer queues behind the band analysis.
import { computePitchFeatures } from './PitchTracker.js';

self.onmessage = (e) => {
  const { channels, sampleRate, options } = e.data || {};
  try {
    const features = computePitchFeatures(channels, sampleRate, options || {});
    const transfer = [];
    for (const f of features.frames) if (f?.buffer instanceof ArrayBuffer) transfer.push(f.buffer);
    if (features.brightness?.buffer instanceof ArrayBuffer) transfer.push(features.brightness.buffer);
    self.postMessage({ ok: true, features }, transfer);
  } catch (err) {
    self.postMessage({ ok: false, error: String(err?.message || err) });
  }
};
