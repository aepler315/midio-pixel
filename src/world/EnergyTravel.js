// Cumulative travel from finalized song energy. Cache by curve identity so
// replacement songs cannot inherit distance. Prefixes are extended lazily;
// seeking backward only reads them, and seeking forward builds the same
// prefix as playback. Never multiply today's speed by the song's age.
const cache = new WeakMap();
const STEP_MS = 20;

export function energyTravel(tSec, curves, rateForEnergy, response = null) {
  if (!Number.isFinite(tSec) || tSec <= 0) return 0;
  if (!curves?.globalEnergyNorm) return tSec * rateForEnergy(0);
  const windowMs = Number.isFinite(response?.smoothingMs) ? response.smoothingMs : 1200;
  const n = Math.max(8, Math.round(windowMs / STEP_MS));
  let byRate = cache.get(curves);
  if (!byRate) { byRate = new Map(); cache.set(curves, byRate); }
  let byWindow = byRate.get(rateForEnergy);
  if (!byWindow) { byWindow = new Map(); byRate.set(rateForEnergy, byWindow); }
  let state = byWindow.get(n);
  if (!state) {
    state = { distance: [0], rates: [rateForEnergy(0)], samples: [], sum: 0 };
    byWindow.set(n, state);
  }
  const cell = Math.floor(tSec * 1000 / STEP_MS);
  // At each node this trailing midpoint average matches WorldMusic's
  // energy envelope, including the zero-padded opening. A left-endpoint
  // velocity holds for 20ms, so no query samples future song energy.
  while (state.rates.length <= cell) {
    const i = state.rates.length;
    const raw = curves.globalEnergyNorm((i - 0.5) * STEP_MS);
    const value = Number.isFinite(raw) ? Math.max(0, Math.min(1, raw)) : 0;
    state.samples.push(value);
    state.sum += value;
    if (i > n) state.sum -= state.samples[i - n - 1];
    state.distance.push(state.distance[i - 1] + state.rates[i - 1] * STEP_MS / 1000);
    state.rates.push(rateForEnergy(Math.max(0, Math.min(1, state.sum / n))));
  }
  return state.distance[cell] + state.rates[cell] * (tSec - cell * STEP_MS / 1000);
}
