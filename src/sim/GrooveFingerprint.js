// What THIS player means when they tap.
//
// Every tap used to be an anonymous timestamp: BeatAnchor took it, pulled the
// phase grid toward it, and threw the rest away. So the engine could never
// learn anything about the person playing -- not how early or late they sit
// against the beat, and certainly not what they consider "a bass hit". Two
// people tapping the same song taught it exactly the same nothing, and every
// new song started from zero again.
//
// This is the memory. A tap arrives with a ROLE (which hand -- low or high),
// and we record the spectral signature of the moment it landed on. Over time
// that builds two templates: what low hits look like to this player, and what
// high hits look like. Those supervise OnsetDetector's classifier, which today
// splits KICK/HAT/SNARE on fixed band-share thresholds that are the same for
// everybody and every genre.
//
// Design constraints, all deliberate:
//   * Pure. No DOM, no wall clock, no storage -- timestamps and features are
//     passed in, serialization is the caller's problem (see toJSON/fromJSON).
//     Same discipline as BeatAnchor.js and SyncMonitor.js, and the reason this
//     is testable at all.
//   * Inert until earned. Below MIN_ROLE_SAMPLES a role's template is not
//     consulted and callers get exactly today's behavior. A cold-start player
//     must not be experimented on.
//   * Blended in, never switched on. Influence scales with sample count, so a
//     profile maturing mid-song eases in instead of lurching the world.
//   * Robust to a fumbled tap. The timing offset is a MEDIAN, so one wild tap
//     moves it by nothing.
import { clamp, clamp01 } from '../utils/math.js';

// Below this many taps of a given role, that role's template is not trusted
// at all. Roughly two bars of committed tapping.
export const MIN_ROLE_SAMPLES = 8;
// ...and influence only reaches full strength here.
export const FULL_ROLE_SAMPLES = 32;
// The say a role gets the instant it clears MIN_ROLE_SAMPLES. Small, so the
// built-in rule still dominates early, but non-zero so the threshold means
// what it says.
const MIN_ROLE_STRENGTH = 0.15;
// A tap further than this from any detected onset was not aimed at one, so it
// teaches us nothing about timing (it still teaches us about spectrum).
export const OFFSET_MATCH_WINDOW_MS = 180;
// Offsets kept for the median. Bounded so the profile keeps adapting rather
// than fossilizing around a session from last month.
const OFFSET_HISTORY_MAX = 64;
// Cap on the learned timing bias. This is musical feel, not audio latency
// (that's LatencyCalibrator's own persisted offset), so it has no business
// applying a huge shift.
export const MAX_OFFSET_MS = 120;

export const ROLE_LOW = 'LOW';
export const ROLE_HIGH = 'HIGH';

const BAND_COUNT = 7;

/** Band energies -> shares summing to 1. Shares, not levels: we want the
 *  SHAPE of the moment (where the energy sat), not how loud it was, or every
 *  template would just encode the loudest passage the player tapped along to. */
export function bandShares(bands) {
  const out = new Array(BAND_COUNT).fill(0);
  if (!bands) return out;
  let sum = 0;
  for (let i = 0; i < BAND_COUNT; i++) sum += Math.max(0, bands[i] || 0);
  if (sum <= 1e-9) return out;
  for (let i = 0; i < BAND_COUNT; i++) out[i] = Math.max(0, bands[i] || 0) / sum;
  return out;
}

/** Cosine similarity of two share vectors, 0 when either has no energy. */
export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < BAND_COUNT; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  if (na <= 1e-12 || nb <= 1e-12) return 0;
  return dot / Math.sqrt(na * nb);
}

function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export class GrooveFingerprint {
  constructor(saved = null) {
    /** Running mean band-share vector per role, with its sample count. */
    this.low = { template: new Array(BAND_COUNT).fill(0), count: 0 };
    this.high = { template: new Array(BAND_COUNT).fill(0), count: 0 };
    this._offsets = [];
    /** Median signed tap-minus-onset offset, ms. Positive = taps late. */
    this.offsetMs = 0;
    /** Mean song-relative energy the player taps at: how hot they like it. */
    this.intensity = 0;
    this._intensityCount = 0;
    if (saved) this.load(saved);
  }

  _roleBucket(role) {
    if (role === ROLE_LOW) return this.low;
    if (role === ROLE_HIGH) return this.high;
    return null;
  }

  /**
   * Record one tap.
   * @param {string|null} role      ROLE_LOW / ROLE_HIGH, or null for an
   *   unroled tap (the catch-all any-key resync) -- those still inform timing
   *   and intensity, but must not pollute either spectral template, since we
   *   don't know which drum the player meant.
   * @param {number[]|null} bands   the 7-band energies at the tap instant
   * @param {number|null} nearestOnsetMs  the detected onset closest to the tap
   * @param {number} tMs            the tap itself
   * @param {number} energyNorm     song-relative energy at the tap, 0..1
   */
  observe({ role = null, bands = null, tMs = 0, nearestOnsetMs = null, energyNorm = 0 } = {}) {
    const bucket = this._roleBucket(role);
    if (bucket && bands) {
      const shares = bandShares(bands);
      // Running mean: cheap, order-independent, and it keeps every tap's
      // contribution equal rather than letting the most recent dominate.
      const n = bucket.count + 1;
      for (let i = 0; i < BAND_COUNT; i++) {
        bucket.template[i] += (shares[i] - bucket.template[i]) / n;
      }
      bucket.count = n;
    }

    if (nearestOnsetMs != null) {
      const d = tMs - nearestOnsetMs;
      if (Math.abs(d) <= OFFSET_MATCH_WINDOW_MS) {
        this._offsets.push(d);
        if (this._offsets.length > OFFSET_HISTORY_MAX) this._offsets.shift();
        this.offsetMs = clamp(median(this._offsets), -MAX_OFFSET_MS, MAX_OFFSET_MS);
      }
    }

    this._intensityCount++;
    this.intensity += (clamp01(energyNorm) - this.intensity) / this._intensityCount;
  }

  /** 0..1: how far to trust this role's template. Exactly zero below
   *  MIN_ROLE_SAMPLES so a cold profile is genuinely inert, then a small but
   *  real say the moment the threshold is met, ramping to full at
   *  FULL_ROLE_SAMPLES. The floor matters: without it the ramp starts at zero
   *  *at* the threshold, so the profile stays mute for one more tap than
   *  MIN_ROLE_SAMPLES advertises, and "earned" would mean nothing yet. */
  strength(role) {
    const bucket = this._roleBucket(role);
    if (!bucket || bucket.count < MIN_ROLE_SAMPLES) return 0;
    const span = Math.max(1, FULL_ROLE_SAMPLES - MIN_ROLE_SAMPLES);
    const ramp = clamp01((bucket.count - MIN_ROLE_SAMPLES) / span);
    return MIN_ROLE_STRENGTH + (1 - MIN_ROLE_STRENGTH) * ramp;
  }

  /** True once either template is worth consulting at all. */
  get ready() {
    return this.strength(ROLE_LOW) > 0 || this.strength(ROLE_HIGH) > 0;
  }

  /**
   * How much this moment looks like each of the player's own templates.
   * Returns `null` when neither template has earned its keep -- callers must
   * treat that as "use your existing rule", not as "no match".
   */
  score(bands) {
    const sLow = this.strength(ROLE_LOW), sHigh = this.strength(ROLE_HIGH);
    if (sLow <= 0 && sHigh <= 0) return null;
    const shares = bandShares(bands);
    return {
      low: sLow > 0 ? cosine(shares, this.low.template) : 0,
      high: sHigh > 0 ? cosine(shares, this.high.template) : 0,
      lowStrength: sLow,
      highStrength: sHigh,
    };
  }

  toJSON() {
    return {
      v: 1,
      low: { template: [...this.low.template], count: this.low.count },
      high: { template: [...this.high.template], count: this.high.count },
      offsets: [...this._offsets],
      intensity: this.intensity,
      intensityCount: this._intensityCount,
    };
  }

  /** Tolerant of anything: a corrupt or older blob leaves a blank profile
   *  rather than throwing, because this is loaded from user storage. */
  load(saved) {
    try {
      const data = typeof saved === 'string' ? JSON.parse(saved) : saved;
      if (!data || typeof data !== 'object') return;
      for (const key of ['low', 'high']) {
        const src = data[key];
        if (!src || !Array.isArray(src.template) || src.template.length !== BAND_COUNT) continue;
        if (!src.template.every((x) => Number.isFinite(x))) continue;
        this[key].template = src.template.map(Number);
        this[key].count = Number.isFinite(src.count) ? Math.max(0, src.count) : 0;
      }
      if (Array.isArray(data.offsets)) {
        this._offsets = data.offsets.filter(Number.isFinite).slice(-OFFSET_HISTORY_MAX);
        this.offsetMs = clamp(median(this._offsets), -MAX_OFFSET_MS, MAX_OFFSET_MS);
      }
      if (Number.isFinite(data.intensity)) this.intensity = clamp01(data.intensity);
      if (Number.isFinite(data.intensityCount)) this._intensityCount = Math.max(0, data.intensityCount);
    } catch {
      /* a blank profile is always a valid answer */
    }
  }

  reset() {
    this.low = { template: new Array(BAND_COUNT).fill(0), count: 0 };
    this.high = { template: new Array(BAND_COUNT).fill(0), count: 0 };
    this._offsets = [];
    this.offsetMs = 0;
    this.intensity = 0;
    this._intensityCount = 0;
  }
}
