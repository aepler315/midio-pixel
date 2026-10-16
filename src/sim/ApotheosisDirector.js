// The Apotheosis (Movement I): Midio is the anchor -- he never leaves like
// Midasus or Broshi do -- so his spectacle is vertical, earned by play. A
// charge meter fills on clean landings and combo milestones; once full,
// and only when the music actually justifies it, he unfolds into a
// brighter 18-rim glyph for 12 seconds.
//
// Tuned toward the glyph being his PRIMARY state rather than a rare treat:
// charge builds faster and leaks away slower, the bar to trigger is lower,
// each activation runs longer, and the cooldown between them is much
// shorter -- at a steady clean-landing pace this cycles roughly every 28s
// (12s active / 16s cooldown), so across a normal song he spends close to
// half of it unfolded, cycling back to his base form only in between. Still
// gated on the music actually being ready and on real charge, so it reads
// as earned momentum, not a fixed timer.
import { clamp01 } from '../utils/math.js';

const CHARGE_PER_CLEAN_LANDING = 1.5;
const CHARGE_PER_MILESTONE = 3;
const DECAY_PER_SEC = 0.08;
const CHARGE_THRESHOLD = 6;
const ACTIVE_MS = 12000;
const COOLDOWN_MS = 16000;
const MAX_TRIGGERS = 8;
const MORPH_SEC = 0.6; // unfold/refold blend duration, both directions
const EPIC_GATE = 0.3;
const SURGE_GATE = 0.22;
const DEEP_CALM_GATE = 0.82; // calm.level at/above this blocks a transform outright

export class ApotheosisDirector {
  constructor() {
    this.charge = 0;
    this.active = false;
    this.progress = 0; // 0..1 unfold blend -- eases in on trigger, holds, eases out on end
    this.triggerCount = 0;
    this.justTriggered = false;
    this.justEnded = false;
    this._activeUntilMs = -Infinity;
    this._cooldownUntilMs = -Infinity;
  }

  onCleanLanding() { this.charge += CHARGE_PER_CLEAN_LANDING; }
  onMilestone() { this.charge += CHARGE_PER_MILESTONE; }

  update(nowMs, dtSec, { vibe, hype, calm } = {}) {
    this.justTriggered = false;
    this.justEnded = false;

    if (this.active && nowMs >= this._activeUntilMs) {
      this.active = false;
      this.justEnded = true;
      this._cooldownUntilMs = nowMs + COOLDOWN_MS;
    }

    if (!this.active) this.charge = Math.max(0, this.charge - DECAY_PER_SEC * dtSec);

    const musicallyReady = (vibe && vibe.epic > EPIC_GATE) || (hype && hype.surge > SURGE_GATE);
    const notDeepCalm = !calm || calm.level < DEEP_CALM_GATE;
    if (
      !this.active && nowMs >= this._cooldownUntilMs && this.triggerCount < MAX_TRIGGERS
      && this.charge >= CHARGE_THRESHOLD && notDeepCalm && musicallyReady
    ) {
      this.active = true;
      this.justTriggered = true;
      this.triggerCount++;
      this.charge = 0;
      this._activeUntilMs = nowMs + ACTIVE_MS;
    }

    const target = this.active ? 1 : 0;
    this.progress = target === 1
      ? Math.min(1, this.progress + dtSec / MORPH_SEC)
      : Math.max(0, this.progress - dtSec / MORPH_SEC);
    this.progress = clamp01(this.progress);
  }

  /** Test/debug hook: bypass gating and cooldown to force a transform right now. */
  forceTrigger(nowMs) {
    if (this.active || this.triggerCount >= MAX_TRIGGERS) return false;
    this.active = true;
    this.justTriggered = true;
    this.triggerCount++;
    this.charge = 0;
    this._activeUntilMs = nowMs + ACTIVE_MS;
    return true;
  }
}
