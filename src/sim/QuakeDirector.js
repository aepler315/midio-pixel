// Earthquake: a single event's ground/camera/dust response, decoupled into
// a pure time envelope (testable, no engine state) plus a thin stateful
// wrapper (mirrors CutDirector/HypeDirector's own shape).
//
// Real seismic events arrive in three phases -- the fast, small P-wave
// (the "tell"), the slower, larger S-wave (the "hit"), and the slowest,
// biggest, longest-lingering surface wave (the "rumble") -- and that shape
// is reused here directly rather than invented, because it hands the game
// a free three-beat telegraph structure that matches the vocabulary every
// other hazard in this codebase already uses (a tell, then a payoff).
//
// Deliberately simplified relative to real seismology: distance-based
// P/S arrival-time separation only matters over kilometers, not across a
// ~1280px screen, so all three phases are modeled purely as a function of
// time-since-strike rather than travel time across the visible stage.
// What DOES vary with distance from the epicenter is amplitude (ground
// shakes harder nearby) -- see QuakeDirector.groundOffsetAt.
import { clamp01, mulberry32, hashSeed } from '../utils/math.js';

export const QUAKE_P_DELAY_SEC = 0;
export const QUAKE_P_DUR_SEC = 0.9;
export const QUAKE_P_AMP = 0.18;

export const QUAKE_S_DELAY_SEC = 1.1;
export const QUAKE_S_DUR_SEC = 1.6;
export const QUAKE_S_AMP = 0.55;

export const QUAKE_SURFACE_DELAY_SEC = 2.4;
export const QUAKE_SURFACE_DUR_SEC = 4.2;
export const QUAKE_SURFACE_AMP = 1.0;

export const QUAKE_TOTAL_SEC = QUAKE_SURFACE_DELAY_SEC + QUAKE_SURFACE_DUR_SEC;

const GROUND_SHAKE_MAX_PX = 22;
const CAMERA_SHAKE_MAX = 6;
const EPICENTER_FALLOFF_PX = 2600; // distance at which ground shake has halved
const JITTER_HZ = 26; // re-roll rate for the per-bar tremor direction
const DUST_RISE_SEC = 5;   // how long full-intensity shaking takes to fully cloud the air
const DUST_SETTLE_SEC = 9; // and how long the dust takes to settle afterward

/** One phase's contribution: a quick attack (12% of its own duration) into
 *  an exponential release, zero outside [delaySec, delaySec+durSec]. Pure,
 *  exported for direct testing. */
export function quakePhaseEnvelope(ageSec, delaySec, durSec) {
  const t = ageSec - delaySec;
  if (t < 0 || t > durSec) return 0;
  const u = t / durSec;
  const attack = Math.min(1, t / Math.max(1e-6, durSec * 0.12));
  const release = Math.exp(-3 * u);
  return attack * release;
}

/** Combined 0..1 shake intensity at ageSec (seconds since the quake
 *  struck) -- the loudest of the three phases active at that instant, not
 *  their sum, so overlap between phases never overshoots 1. Pure. */
export function quakeEnvelope01(ageSec) {
  const p = quakePhaseEnvelope(ageSec, QUAKE_P_DELAY_SEC, QUAKE_P_DUR_SEC) * QUAKE_P_AMP;
  const s = quakePhaseEnvelope(ageSec, QUAKE_S_DELAY_SEC, QUAKE_S_DUR_SEC) * QUAKE_S_AMP;
  const surf = quakePhaseEnvelope(ageSec, QUAKE_SURFACE_DELAY_SEC, QUAKE_SURFACE_DUR_SEC) * QUAKE_SURFACE_AMP;
  return clamp01(Math.max(p, s, surf));
}

export function quakeActive(ageSec) {
  return ageSec >= 0 && ageSec <= QUAKE_TOTAL_SEC;
}

/** How much of a nearby-epicenter amplitude reaches worldX -- 1 at the
 *  epicenter, halving every EPICENTER_FALLOFF_PX. Pure. */
export function quakeDistanceFalloff(distancePx) {
  return 1 / (1 + Math.abs(distancePx) / EPICENTER_FALLOFF_PX);
}

export class QuakeDirector {
  constructor(seed = 1) {
    this.rand = mulberry32(hashSeed(`${seed}:quake`) || 1);
    this.strikeAtMs = -Infinity;
    this.epicenterWorldX = 0;
    this.active = false;
    this.intensity01 = 0;
    this.dustLevel01 = 0; // read by BiomeManager -- the air stays hazy after the shaking stops
    this._jitterY = 0;
    this._nextJitterMs = 0;
  }

  /** Fires one quake. Re-striking while one is already active simply
   *  restarts its clock at the new epicenter -- DisasterDirector's own
   *  exclusivity lock is what actually prevents overlap in practice. */
  strike(nowMs, epicenterWorldX = 0) {
    this.strikeAtMs = nowMs;
    this.epicenterWorldX = epicenterWorldX;
  }

  update(nowMs, dtSec, camera) {
    const ageSec = (nowMs - this.strikeAtMs) / 1000;
    this.active = quakeActive(ageSec);
    this.intensity01 = this.active ? quakeEnvelope01(ageSec) : 0;

    if (this.active && nowMs >= this._nextJitterMs) {
      this._nextJitterMs = nowMs + 1000 / JITTER_HZ;
      this._jitterY = this.rand() * 2 - 1;
    }
    if (this.intensity01 > 0.02 && camera) camera.shake(CAMERA_SHAKE_MAX * this.intensity01);

    if (this.intensity01 > 0.05) {
      this.dustLevel01 = clamp01(this.dustLevel01 + dtSec * this.intensity01 / DUST_RISE_SEC);
    } else {
      this.dustLevel01 = clamp01(this.dustLevel01 - dtSec / DUST_SETTLE_SEC);
    }
  }

  /** Render-only ground offset (px) at a world-x, for GroundField.visibleBars
   *  to fold in alongside its existing ripple/groove contributions. Zero
   *  whenever no quake is active -- a hard skip, not just a small number,
   *  so idle songs pay nothing for this. */
  groundOffsetAt(worldX) {
    if (!(this.intensity01 > 0.01)) return 0;
    const falloff = quakeDistanceFalloff(worldX - this.epicenterWorldX);
    return GROUND_SHAKE_MAX_PX * this.intensity01 * falloff * this._jitterY;
  }
}
