// The fever meter: how insane the visuals are allowed to get. Two hands on
// the dial — the PLAYER's (a run of accurate, steady taps) and the SONG's
// (live energy). Neither alone maxes it: sloppy taps through a drop stay
// tame, and perfect taps through a lullaby stay elegant. Both together is
// the fever. Pure logic; consumers (biomes, mountains, FX multipliers) read
// `level` each step.
import { clamp } from '../utils/math.js';

const QUALITY = { perfect: 1, great: 0.7, good: 0.35, sour: 0, miss: 0 };
const OFFSET_WINDOW = 8;   // recent hit offsets used for the steadiness read
const JITTER_FULL_MS = 45; // offset spread that zeroes steadiness
const ATTACK_SEC = 0.45;
const RELEASE_SEC = 1.6;

export class FeverMeter {
  constructor() {
    this.level = 0;    // 0..1 smoothed output
    this.peak = 0;     // high-water mark of level this run
    this.accuracy = 0; // 0..1 tap quality × steadiness (pre-energy)
    this.energy = 0;   // last sampled song energy
    this._quality = 0; // EMA over judged tiers
    this._offsets = [];
  }

  /** Feed every TapJudge step event. Only judged tiers move quality; hold
   *  ticks ride for free (holding well is already scored by the start). */
  onJudge(evt) {
    let q = null;
    if (evt.kind === 'hit' || evt.kind === 'holdStart') {
      if (evt.tier != null) q = QUALITY[evt.tier] ?? 0;
      if (evt.offsetMs != null) {
        this._offsets.push(evt.offsetMs);
        if (this._offsets.length > OFFSET_WINDOW) this._offsets.shift();
      }
    } else if (evt.kind === 'sour' || evt.kind === 'miss' || evt.kind === 'holdChoke') {
      q = 0;
    }
    if (q === null) return;
    // Misses cool faster than hits heat: the fever is earned, easily lost.
    const w = q === 0 ? 0.45 : 0.25;
    this._quality = this._quality * (1 - w) + q * w;
  }

  /** A direct spark (flourish air jump, milestone) — bypasses the attack. */
  spark(amount) {
    this.level = clamp(this.level + amount, 0, 1);
  }

  /** Steadiness: 1 when recent hit offsets cluster tightly (even if biased —
   *  a constant lag is the calibrator's business, not the player's fault),
   *  0 when they're all over the window. */
  get steadiness() {
    const n = this._offsets.length;
    if (n < 3) return 0.5; // not enough evidence either way
    let mean = 0;
    for (const o of this._offsets) mean += o;
    mean /= n;
    let varSum = 0;
    for (const o of this._offsets) varSum += (o - mean) * (o - mean);
    const sd = Math.sqrt(varSum / n);
    return clamp(1 - sd / JITTER_FULL_MS, 0, 1);
  }

  update(nowMs, dtSec, energyCurves) {
    this.energy = energyCurves ? clamp(energyCurves.globalEnergy(nowMs), 0, 1) : 0.3;
    this.accuracy = this._quality * (0.35 + 0.65 * this.steadiness);
    const target = this.accuracy * (0.2 + 0.8 * this.energy);
    const tau = target > this.level ? ATTACK_SEC : RELEASE_SEC;
    this.level += (target - this.level) * Math.min(1, dtSec / tau);
    this.level = clamp(this.level, 0, 1);
    if (this.level > this.peak) this.peak = this.level;
  }
}
