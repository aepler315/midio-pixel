// Drawing never owns simulation/audio advancement. Each loop owns its phase.
export class FrameCadence {
  reset() { this.deadline = null; this.lastCallback = null; this.fps = null; }
  constructor() { this.reset(); }
  shouldDraw(nowMs, fps) {
    if (!Number.isFinite(nowMs)) return false;
    const target = Math.round(fps) === 30 ? 30 : 60, period = 1000 / target;
    if (nowMs === this.lastCallback) return false;
    const rebase = this.deadline == null || target !== this.fps || nowMs < this.lastCallback || nowMs - this.lastCallback > 250;
    this.lastCallback = nowMs;
    this.fps = target;
    if (rebase) { this.deadline = nowMs + period; return true; }
    if (nowMs + 1e-6 < this.deadline) return false;
    // Advance from the phase, not the actual callback. Discard missed slots
    // in one operation; no backlog/catch-up draws after a slow callback.
    this.deadline += (Math.floor((nowMs - this.deadline + 1e-6) / period) + 1) * period;
    return true;
  }
}
