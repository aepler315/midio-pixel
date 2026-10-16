// On-device FPS HUD support (mobile performance round): an EMA'd fps
// readout from the raw rAF-to-rAF deltas already fed to PerfGovernor.sample,
// plus a `?fps` URL param to show it without hunting for a toggle key.

const EMA_ALPHA = 0.15; // settles to within ~10% of a step change in ~10 frames

/** Smooths a raw frame-to-frame delta into a display-stable fps. Ignores
 *  non-positive deltas (paused/backgrounded tabs) rather than spiking. */
export function emaFps(prevFps, deltaMs, alpha = EMA_ALPHA) {
  if (!(deltaMs > 0)) return prevFps;
  const instFps = 1000 / deltaMs;
  return prevFps == null ? instFps : prevFps + (instFps - prevFps) * alpha;
}

/** `?fps` (any value, or bare) shows the HUD on load without needing the toggle key. */
export function resolveFpsHudVisible(search = '') {
  try {
    const raw = search || '';
    const q = new URLSearchParams(raw.startsWith('?') ? raw.slice(1) : raw);
    return q.has('fps');
  } catch {
    return false;
  }
}

/** A bounded one-second window of completed presentations. Sample every
 * callback, including skipped/failed draws, so failures decay to zero. */
export class PresentedFpsMeter {
  constructor() { this.reset(); }
  reset() { this.times = []; this.started = null; this.last = null; this.fps = 0; }
  sample(nowMs, presented) {
    if (!Number.isFinite(nowMs)) return this.fps;
    if (this.last != null && (nowMs < this.last || nowMs - this.last > 2000)) this.reset();
    this.started ??= nowMs;
    if (presented && nowMs !== this.last) this.times.push(nowMs);
    this.last = nowMs;
    this.times = this.times.filter(t => t > nowMs - 1000 + 1e-6);
    const elapsed = Math.min(1000, nowMs - this.started);
    this.fps = elapsed >= 250 ? this.times.length * 1000 / elapsed : 0;
    return this.fps;
  }
}
