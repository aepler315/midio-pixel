// The arbiter for large-scale hazard events: earthquake (pre-scheduled,
// anchored to a song hotspot) and wildfire (threshold-triggered, gated on
// WeatherDirector.dryness01 rather than a fixed time -- a fire needs the
// world to actually be dry, which is a live weather-history quantity, not
// something knowable in advance at construction time). Flood registers
// here too, but purely reactively (see FloodDirector.armFromTsunami) --
// it never competes for this arbiter's exclusivity lock since it's a
// consequence layer, not a standalone spectacle.
//
// Owns exclusivity (only one disaster live at a time), a cooldown floor,
// and -- for the pre-scheduled kinds -- anchoring to the song's own energy
// hotspots, the same technique OceanLife.tsunamiSchedule and
// OrogenyDirector.findClimaxMs already use, so a disaster reads as a
// musical event rather than a wall-clock timer.
//
// Pure scheduling lives in buildDisasterSchedule (directly testable); the
// class just walks that schedule forward and fires the matching director's
// strike(), plus the separate threshold check for fire. Each kind's own
// director (QuakeDirector, FireDirector) owns its actual envelope/
// rendering -- this file only decides WHEN and IF one may start.
import { mulberry32, hashSeed } from '../utils/math.js';

const MIN_GAP_MS = 45000; // hard cooldown floor between any two disasters
const QUAKE_MIN_DURATION_MS = 30000; // too short a song for a full quake arc to land meaningfully
const FIRE_DRYNESS_TRIGGER = 0.72;   // weather.dryness01 must cross this to arm a wildfire
const FIRE_BUDGET_PER_SONG = 1;

/**
 * One quake slot per song (the only implemented kind so far), anchored
 * near a hotspot the same way tsunamiSchedule anchors its walls -- jittered
 * off the exact peak so it doesn't always coincide with whatever else is
 * also scheduled against that same hotspot. Returns [] for songs too short
 * to give the ~7s quake arc room to read, or with no candidate window at
 * all. Pure, exported for direct testing.
 */
export function buildDisasterSchedule(rand, durationMs, hotspotMs = []) {
  if (!(durationMs >= QUAKE_MIN_DURATION_MS)) return [];
  const base = hotspotMs.length > 0
    ? hotspotMs[Math.floor(rand() * hotspotMs.length)]
    : durationMs * (0.45 + rand() * 0.3);
  const tMs = Math.min(durationMs * 0.94, Math.max(durationMs * 0.1, base + (rand() - 0.5) * 6000));
  return [{ tMs, kind: 'quake' }];
}

export class DisasterDirector {
  constructor(seed = 1, durationMs = 0, hotspotMs = []) {
    this.durationMs = durationMs;
    const rand = mulberry32(hashSeed(`${seed}:disaster`) || 1);
    this._schedule = buildDisasterSchedule(rand, durationMs, hotspotMs);
    this._nextIdx = 0;
    this._lastStruckMs = -Infinity;
    this._fireCount = 0;
    this.activeKind = null;   // which disaster (if any) currently owns the stage -- exclusivity
    this.justStruck = false;  // one-frame flag, true only on the update() call that fires a strike
    this.struckKind = null;
  }

  /** Skip past slots on a fresh scene; do not strike a backlog of disasters. */
  seekTo(nowMs) {
    this._nextIdx = 0;
    while (this._nextIdx < this._schedule.length && this._schedule[this._nextIdx].tMs <= nowMs) this._nextIdx++;
  }

  /**
   * @param {number} nowMs
   * @param {number} worldX current scroll position -- new strikes are
   *   centered here (a quake's epicenter, a fire's origin), so the effect
   *   reads strongest right where the player already is.
   * @param {{
   *   quake?: import('./QuakeDirector.js').QuakeDirector,
   *   fire?: import('./FireDirector.js').FireDirector,
   *   weather?: import('./WeatherDirector.js').WeatherDirector,
   *   windAngle?: number,
   * }} deps live directors this arbiter can trigger and must defer to,
   *   plus the live weather reading fire's precondition needs.
   */
  update(nowMs, worldX, deps = {}) {
    this.justStruck = false;
    this.struckKind = null;

    this.activeKind = deps.quake && deps.quake.active ? 'quake'
      : deps.fire && deps.fire.active ? 'fire'
        : null;
    if (this.activeKind) return; // exclusivity: nothing new starts while one is live

    // Pre-scheduled kinds (quake): walk the schedule forward.
    if (this._nextIdx < this._schedule.length) {
      const next = this._schedule[this._nextIdx];
      if (nowMs >= next.tMs && nowMs - this._lastStruckMs >= MIN_GAP_MS) {
        this._nextIdx++;
        this._lastStruckMs = nowMs;
        this.justStruck = true;
        this.struckKind = next.kind;
        if (next.kind === 'quake' && deps.quake) deps.quake.strike(nowMs, worldX);
        return;
      }
    }

    // Threshold-triggered kinds (wildfire): fires whenever the world has
    // actually dried out enough, not on a pre-committed schedule -- a fire
    // needs live weather history, which can't be known at construction
    // time the way a song's energy hotspots can.
    if (deps.fire && deps.weather && this._fireCount < FIRE_BUDGET_PER_SONG
      && nowMs - this._lastStruckMs >= MIN_GAP_MS
      && deps.weather.dryness01 >= FIRE_DRYNESS_TRIGGER) {
      this._fireCount++;
      this._lastStruckMs = nowMs;
      this.justStruck = true;
      this.struckKind = 'fire';
      deps.fire.strike(nowMs, worldX, deps.windAngle ?? 0);
    }
  }
}
