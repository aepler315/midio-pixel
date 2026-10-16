// The Key of the World (Movement III): VibeDirector already infers a
// rolling tonic from the pitch-class histogram -- this director turns that
// harmony into two things. Continuously: a slewed hue-rotation the whole
// palette leans toward, so a C-major verse and its F#-minor bridge read as
// genuinely different places. Occasionally: a confirmed modulation (the
// old tonic held stable, then a new one took over with real confidence and
// held) fires a one-shot key change -- a kick-synced transposition wave,
// and the mandala re-seeds its rosette.
import { Role } from '../core/NoteEvent.js';
import { clamp, clamp01 } from '../utils/math.js';

const STABLE_MS = 8000;        // a tonic must hold this long to count as "established"
const CANDIDATE_MARGIN = 0.15; // the new tonic's confidence must clear this to register at all
const HOLD_MS = 2500;          // ...and hold that confidently for this long before it's confirmed
const WAVE_SEC = 1.2;
const ROTATION_TAU_SEC = 8;
const DEG_PER_SEMITONE = 30 * 0.25; // 7.5deg
const ROTATION_MAX_DEG = 90;
const SNAP_WINDOW_MS = 220;

/** Shortest signed semitone distance from pitch-class 0 (C): 11 -> -1, not +11. */
function signedSemitone(pc) { return pc > 6 ? pc - 12 : pc; }

export class KeyDirector {
  constructor() {
    this.tonic = 0;
    this.paletteRotation = 0; // degrees, slewed toward _rotationTarget
    this._rotationTarget = 0;

    this._stableTonic = null;
    this._stableSinceMs = 0;
    this._candidateTonic = null;
    this._candidateSinceMs = 0;

    this.lastKeyChange = null; // {from, to, atMs} -- BiomeManager reads .to to reseed the mandala's rosette

    this.justKeyChange = false; // one-shot per step

    this._pendingChange = null;   // {from, to}, confirmed, awaiting the kick-synced fire
    this._pendingWaveAtMs = null;
    this.transitionActive = false;
    this.transitionProgress = 0;
    this._waveStartMs = -Infinity;
  }

  /** Conductor-cued modulation (ConductorTrack.js): fire the key-change wave
   *  at the next update regardless of what the pitch histogram thinks. The
   *  detector above is a guess about the music; an authored cue is not, so
   *  it bypasses the stability/confidence gates entirely -- but still routes
   *  through the same _pendingChange path so the wave, the mandala reseed
   *  and lastKeyChange all behave exactly as a detected modulation does. */
  forceChange(nowMs, toTonic = null) {
    const to = toTonic == null ? (this.tonic + 5) % 12 : ((toTonic % 12) + 12) % 12;
    this._pendingChange = { from: this._stableTonic ?? this.tonic, to };
    this._pendingWaveAtMs = nowMs;
    this._stableTonic = to;
    this._stableSinceMs = nowMs;
    this._candidateTonic = null;
  }

  update(nowMs, dtSec, { tonic = 0, tonicConfidence = 0, conductor = null } = {}) {
    this.justKeyChange = false;
    this.tonic = tonic;

    // Continuous palette rotation: always tracks the current best-guess
    // tonic, gated on confidence so silence/noise can't yank the palette.
    if (tonicConfidence >= CANDIDATE_MARGIN) {
      this._rotationTarget = clamp(signedSemitone(tonic) * DEG_PER_SEMITONE, -ROTATION_MAX_DEG, ROTATION_MAX_DEG);
    }
    this.paletteRotation += (1 - Math.exp(-dtSec / ROTATION_TAU_SEC)) * (this._rotationTarget - this.paletteRotation);

    // Modulation detector: a separate, stricter, event-oriented signal.
    if (this._stableTonic === null) {
      this._stableTonic = tonic;
      this._stableSinceMs = nowMs;
    } else if (tonic === this._stableTonic) {
      this._candidateTonic = null;
    } else if (this._pendingChange === null) {
      const establishedLongEnough = nowMs - this._stableSinceMs >= STABLE_MS;
      if (!establishedLongEnough) {
        // The "stable" tonic never actually held long enough to count --
        // re-baseline on whatever's current rather than false-firing later.
        this._stableTonic = tonic;
        this._stableSinceMs = nowMs;
        this._candidateTonic = null;
      } else if (tonicConfidence < CANDIDATE_MARGIN) {
        this._candidateTonic = null;
      } else if (this._candidateTonic !== tonic) {
        this._candidateTonic = tonic;
        this._candidateSinceMs = nowMs;
      } else if (nowMs - this._candidateSinceMs >= HOLD_MS) {
        this._pendingChange = { from: this._stableTonic, to: tonic };
        this._stableTonic = tonic;
        this._stableSinceMs = nowMs;
        this._candidateTonic = null;
        const isKick = (e) => e.role === Role.RHYTHM && e.kick;
        const kick = conductor ? conductor.nearestEventMs(isKick, nowMs, SNAP_WINDOW_MS) : null;
        this._pendingWaveAtMs = kick ? Math.max(kick.tMs, nowMs) : nowMs;
      }
    }

    if (this._pendingWaveAtMs != null && nowMs >= this._pendingWaveAtMs) {
      const { from, to } = this._pendingChange;
      this._pendingChange = null;
      this._pendingWaveAtMs = null;
      this.lastKeyChange = { from, to, atMs: nowMs };
      this.justKeyChange = true;
      this.transitionActive = true;
      this._waveStartMs = nowMs;
      this.transitionProgress = 0;
    }

    if (this.transitionActive) {
      this.transitionProgress = clamp01((nowMs - this._waveStartMs) / (WAVE_SEC * 1000));
      if (this.transitionProgress >= 1) this.transitionActive = false;
    }
  }
}
