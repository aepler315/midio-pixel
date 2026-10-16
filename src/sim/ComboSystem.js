// Cascading combo-streak multiplier (spec §2.2.2), rules 1-6 verbatim.
const CLEAN_WINDOW_MS = 90;
const DISPLAY_CAP = 3.0;

export class ComboSystem {
  constructor() {
    this.streak = 0;
    this.M = 1;
    this.peakM = 1;
    this.cleanLandings = 0;
    this.lastCleanMs = -Infinity;
    this._lastUpdateMs = 0;

    // One-shot per-step flags for FX/HUD to react to.
    this.justClean = false;
    this.justBroke = false;
  }

  get displayM() { return Math.min(DISPLAY_CAP, this.M); }

  /** @param {boolean} isClean touchdown within +/-90ms of the kick grid */
  onLanding(nowMs, isClean) {
    if (isClean) {
      this.streak += 1;
      this.cleanLandings += 1;
      this.M = 1 + 0.1 * Math.min(this.streak, 20); // RULE 1
      if (this.M > this.peakM) this.peakM = this.M;
      this.lastCleanMs = nowMs;
      this.justClean = true;
    }
  }

  onStumble() {
    this.streak = 0;
    this.M = 1;
    this.justBroke = true;
  }

  /** Player-rhythm layer: a well-judged press refreshes combo freshness
   * without growing the streak. Landings stay the only source of streak
   * (rules 1-6 untouched); this just keeps RULE 3/4's clocks from counting
   * the airtime of a jump the player was literally scored "clean" for —
   * without it, every hold exit sits exactly on the 2-beat break boundary. */
  sustain(nowMs) {
    if (this.streak > 0 && nowMs > this.lastCleanMs) this.lastCleanMs = nowMs;
  }

  static isCleanLanding(landingMs, nearestKickMs) {
    return nearestKickMs !== null && Math.abs(landingMs - nearestKickMs) <= CLEAN_WINDOW_MS;
  }

  update(nowMs, beatPeriodMs) {
    const dt = Math.max(0, nowMs - this._lastUpdateMs);
    this._lastUpdateMs = nowMs;

    const sinceClean = nowMs - this.lastCleanMs;
    const graceMs = beatPeriodMs;      // RULE 2
    const breakMs = beatPeriodMs * 2;  // RULE 4

    if (sinceClean > breakMs) {
      if (this.streak !== 0 || this.M !== 1) {
        this.streak = 0;
        this.M = 1;
        this.justBroke = true;
      }
    } else if (sinceClean > graceMs) {
      const excess = this.M - 1;       // RULE 3: drains at 0.5*excess per beat, streak untouched
      if (excess > 0 && beatPeriodMs > 0) {
        const decayPerMs = (0.5 * excess) / beatPeriodMs;
        this.M = Math.max(1, this.M - decayPerMs * dt);
      }
    }
  }

  /** Call once per sim step after update() to clear one-shot flags for the next step. */
  clearFrameFlags() {
    this.justClean = false;
    this.justBroke = false;
  }
}
