// The expensive half of a song fingerprint (the FFT over the resampled
// channels) off the main thread. SongFingerprint is pure numeric code, so the
// worker returns exactly what fingerprintSignals returns on the main thread.
import { fingerprintSignals } from './SongFingerprint.js';

self.onmessage = (e) => {
  try {
    const { frames, frameHz } = fingerprintSignals(e.data?.signals || []);
    self.postMessage({ ok: true, frames, frameHz }, [frames.buffer]);
  } catch (err) {
    self.postMessage({ ok: false, error: String(err?.message || err) });
  }
};
