import { VISUAL_LEAD_MS } from './ChoreoClock.js';

export class CaptureClock {
  constructor({ liveLeadMs = VISUAL_LEAD_MS } = {}) {
    this.liveLeadMs = Math.max(0, Number(liveLeadMs) || 0);
    this.leadMs = this.liveLeadMs;
    this.targetLeadMs = this.liveLeadMs;
    this.lastAudioMs = null;
    this.captureRequested = false;
  }

  get captureReady() {
    return this.captureRequested && this.leadMs === 0;
  }

  arm(nowMs) {
    this.captureRequested = true;
    this.targetLeadMs = 0;
    this.lastAudioMs = Number(nowMs) || 0;
  }

  beginFullCapture(nowMs = 0) {
    this.captureRequested = true;
    this.targetLeadMs = 0;
    this.leadMs = 0;
    this.lastAudioMs = Number(nowMs) || 0;
  }

  release(nowMs) {
    this.captureRequested = false;
    this.targetLeadMs = this.liveLeadMs;
    this.lastAudioMs = Number(nowMs) || 0;
  }

  resetLive(nowMs = 0) {
    this.captureRequested = false;
    this.targetLeadMs = this.liveLeadMs;
    this.leadMs = this.liveLeadMs;
    this.lastAudioMs = Number(nowMs) || 0;
  }

  renderNow(nowMs) {
    const audioMs = Number(nowMs) || 0;
    if (this.lastAudioMs === null) this.lastAudioMs = audioMs;
    const elapsed = Math.max(0, audioMs - this.lastAudioMs);
    if (this.leadMs > this.targetLeadMs) {
      this.leadMs = Math.max(this.targetLeadMs, this.leadMs - elapsed);
    } else if (this.leadMs < this.targetLeadMs) {
      this.leadMs = Math.min(this.targetLeadMs, this.leadMs + elapsed);
    }
    this.lastAudioMs = audioMs;
    return audioMs + this.leadMs;
  }
}
