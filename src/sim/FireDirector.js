// Wildfire: owns one strike's stateful lifecycle (mirrors QuakeDirector's
// shape) plus the permanent burn-scar record consequences read from --
// GroundScatter darkens burned ground, matching the "weather with
// consequences" pattern groundCover/snowCover already established.
import { clamp01 } from '../utils/math.js';
import {
  fireExtent, fireIntensity01, fireActive, windProjection,
} from '../world/Wildfire.js';

const SMOKE_RISE_SEC = 6;   // how long full-intensity burning takes to fully cloud the air
const SMOKE_SETTLE_SEC = 14; // and how long the smoke takes to clear afterward -- lingers longer than quake dust

export class FireDirector {
  constructor() {
    this.strikeAtMs = -Infinity;
    this.originWorldX = 0;
    this.windProjectionValue = 0;
    this.active = false;
    this.intensity01 = 0;
    this.x0 = 0; // current (or, once dead, final) world-x extent
    this.x1 = 0;
    this.smokeLevel01 = 0; // read by BiomeManager -- the sky stays smoke-reddened after the fire dies down
    this._burned = []; // sorted, non-overlapping [{x0,x1}] permanent scar record
  }

  /** Fires one wildfire. `windAngle` (radians) is sampled once at strike
   *  time from Atmosphere.prevailingAngle() -- the fire's asymmetry is
   *  fixed for its whole life, not re-read every frame, so its spread
   *  direction doesn't wobble as the slow prevailing bias keeps rotating. */
  strike(nowMs, originWorldX, windAngle = 0) {
    this.strikeAtMs = nowMs;
    this.originWorldX = originWorldX;
    this.windProjectionValue = windProjection(windAngle);
  }

  update(nowMs, dtSec = 0) {
    const ageMs = nowMs - this.strikeAtMs;
    const wasActive = this.active;
    this.active = fireActive(ageMs);
    this.intensity01 = this.active ? fireIntensity01(ageMs) : 0;
    if (this.active) {
      const { x0, x1 } = fireExtent(ageMs, this.windProjectionValue);
      this.x0 = this.originWorldX + x0;
      this.x1 = this.originWorldX + x1;
      this._recordScar(this.x0, this.x1);
    } else if (wasActive) {
      // The frame the fire dies: lock in its final extent one last time
      // (it may have grown since the last recorded scar interval).
      this._recordScar(this.x0, this.x1);
    }
    if (this.intensity01 > 0.05) {
      this.smokeLevel01 = clamp01(this.smokeLevel01 + dtSec * this.intensity01 / SMOKE_RISE_SEC);
    } else {
      this.smokeLevel01 = clamp01(this.smokeLevel01 - dtSec / SMOKE_SETTLE_SEC);
    }
  }

  _recordScar(x0, x1) {
    const last = this._burned[this._burned.length - 1];
    if (last && x0 <= last.x1 && x1 >= last.x0) {
      last.x0 = Math.min(last.x0, x0);
      last.x1 = Math.max(last.x1, x1);
    } else if (!last || x0 > last.x1) {
      this._burned.push({ x0, x1 });
    } else {
      // x1 < last.x0 -- a scar behind the most recent one (shouldn't
      // happen since fires only ever grow forward in time, but stay safe).
      this._burned.push({ x0, x1 });
      this._burned.sort((a, b) => a.x0 - b.x0);
    }
  }

  /** Is worldX inside any permanently-burned interval (past or present)?
   *  Linear scan is fine -- a song accumulates at most a couple of scars. */
  isBurned(worldX) {
    for (const iv of this._burned) {
      if (worldX >= iv.x0 && worldX <= iv.x1) return true;
    }
    return false;
  }

  /** Read-only view of the recorded scar intervals, for drawing. */
  get burnedIntervals() {
    return this._burned;
  }
}
