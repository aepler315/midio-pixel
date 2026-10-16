// Hold the show back until the song has actually started.
//
// The staging budget (Dramaturgy.intensityBudget) is a function of elapsed
// TIME: it lifts from 0.55 to full over the first 22% of the song and cannot
// hear a note. On a track that fades in over forty seconds, or opens on a
// lone pad, or takes a verse to find itself, the world is already at full
// strength long before the music is -- every phenomenon running, bloom up,
// particles out, over near-silence.
//
// This watches the song's own level instead. `globalEnergyNorm` is already
// normalized against the song's own p10/p90 (EnergyCurves.calibration), so
// "quiet" here means quiet *for this track* -- a whisper-soft ambient piece
// is not permanently muted, and a wall-of-sound master is not permanently
// loud. No new analysis, no new state on the audio side.
//
// Three properties worth stating, because each is a mistake avoided:
//
//   * ONE-WAY. Once the song has genuinely arrived, the hush never returns.
//     A quiet verse two minutes in is CalmDirector's job; re-applying the
//     intro hush there would read as the world losing interest in the song.
//   * TIME-LIMITED. The hold expires on its own. A misread of a genuinely
//     strange track can cost a few seconds of restraint, never a whole song.
//   * INERT WITHOUT AUDIO. No energy curves (MIDI, demo) means gain 1 from
//     the first frame -- exactly today's behaviour.
//
// Pure: no DOM, no clock of its own, timestamps passed in. Same shape as
// CalmDirector/HypeDirector so it drops into the same update chain.
import { clamp01 } from '../utils/math.js';
import { FLAT_WEIGHTS } from '../audio/bands.js';
import { FLAT_SPREAD_MIN } from '../audio/EnergyCurves.js';

// How far the world is held back at its most restrained. Not zero: an empty
// screen is not "calm", it is broken. This still leaves the sky, the ranges
// and the trio present -- it takes the phenomena down, not the world.
export const OPENING_FLOOR = 0.35;
// Song-relative level (globalEnergyNorm) at which we consider the song to
// have properly arrived. NORM_LO is 0.15 and NORM_HI 0.85, so this sits a
// little above the song's own p10 -- comfortably clear of a fade-in's tail
// but well under anything that has actually kicked in.
const ARRIVED_LEVEL = 0.34;
// ...sustained for this long, so a single stray transient in an ambient
// intro doesn't count as the song starting.
const ARRIVE_SUSTAIN_MS = 900;
// The hold can never outlast this, whatever the analysis says. Kept short:
// this is a backstop against a misread, and a world that stays dim for the
// better part of a minute is a worse bug than the one being fixed.
export const MAX_HOLD_MS = 25000;
// Release easing. Deliberately quick: this is a greeting, not a dimmer. At
// 1.6s a track that opens at full blast still spent four seconds climbing
// out of the hold -- which is muzzling the very songs that should never have
// been held. Fast enough that the first real bar lands lit, slow enough that
// it reads as the world waking rather than a switch being thrown.
const RELEASE_TAU_SEC = 0.7;
// The level EMA. Short -- we want to notice the song arriving promptly; the
// sustain window above is what supplies the patience.
const LEVEL_TAU_SEC = 0.25;

export class OpeningDirector {
  constructor() {
    /** 0..1 multiplier for the world's phenomena budget. */
    this.gain = OPENING_FLOOR;
    /** True until the song is judged to have started. */
    this.holding = true;
    this.level = 0;
    this._aboveSinceMs = null;
    this._startedAtMs = null;
    this._checkedDynamics = false;
  }

  /**
   * @param {number} nowMs      song time
   * @param {number} dtSec      frame delta
   * @param {object|null} energyCurves  EnergyCurves, or null on the MIDI/demo
   *   path -- in which case this is a no-op and the gain is 1 immediately.
   */
  update(nowMs, dtSec, energyCurves) {
    if (!energyCurves) {
      this.holding = false;
      this.gain = 1;
      return;
    }

    // A song with no dynamic range has no quiet opening to protect, and
    // trying to find one in it goes wrong: below FLAT_SPREAD_MIN,
    // globalEnergyNorm deliberately blends back toward the RAW absolute
    // level (EnergyCurves guards against manufacturing fake dynamics out of
    // dither), and that raw value can sit under any fixed threshold for the
    // entire song -- so the hold would run to its backstop on a track that
    // was never quiet in the first place. Checked once, from the song-wide
    // calibration that already exists.
    if (!this._checkedDynamics) {
      this._checkedDynamics = true;
      const cal = energyCurves.calibration ? energyCurves.calibration(FLAT_WEIGHTS) : null;
      if (cal && cal.spread < FLAT_SPREAD_MIN) { this.holding = false; this._startedAtMs = nowMs; }
    }

    if (this.holding) {
      const raw = clamp01(energyCurves.globalEnergyNorm(nowMs, FLAT_WEIGHTS));
      this.level += (1 - Math.exp(-dtSec / LEVEL_TAU_SEC)) * (raw - this.level);

      if (this.level >= ARRIVED_LEVEL) {
        if (this._aboveSinceMs == null) this._aboveSinceMs = nowMs;
        if (nowMs - this._aboveSinceMs >= ARRIVE_SUSTAIN_MS) this.holding = false;
      } else {
        // Dipping back below restarts the patience, but only while still
        // holding -- once released this branch is unreachable.
        this._aboveSinceMs = null;
      }

      if (nowMs >= MAX_HOLD_MS) this.holding = false;
      if (!this.holding) this._startedAtMs = nowMs;
    }

    // Release eases; the hold does not re-engage. `holding` is the latch.
    const target = this.holding ? OPENING_FLOOR : 1;
    this.gain += (1 - Math.exp(-dtSec / RELEASE_TAU_SEC)) * (target - this.gain);
    this.gain = clamp01(this.gain);
  }

  /** For the debug readout: what this is doing and why. */
  get status() {
    if (this.holding) return `holding (level ${this.level.toFixed(2)}/${ARRIVED_LEVEL})`;
    return this._startedAtMs == null ? 'open' : `open since ${(this._startedAtMs / 1000).toFixed(1)}s`;
  }
}
