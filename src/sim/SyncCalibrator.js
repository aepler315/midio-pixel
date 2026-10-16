// Setting the Bluetooth delay from the player's own tapping.
//
// ## Two passes, because one cannot see the whole problem
//
// A tap made by EAR says when the sound reached the ear. A tap made by EYE
// says when the picture reached the eye. Neither alone is the A/V skew, and
// a pass that only listens is blind to display latency entirely -- which is
// how a projected or re-encoded screen can be badly out of step while a
// by-ear pass keeps reporting that everything is fine.
//
// So Sync runs both, and the answer is the difference:
//
//     sound at the ear  =  kick + D_hw + audioDelay
//     picture at the eye =  kick + visualLag + D_display
//
// setting those equal gives `trim = (D_hw - reportedLatency) - D_display`,
// which is exactly `median(ear) - median(eye)` once each side is normalised
// for the trim in force when it was measured.
//
// The player's own bias -- the habit of anticipating a beat, which no two
// people share -- appears in BOTH passes and cancels in the subtraction.
// That is the real reason to run two: it removes the one term a single pass
// has to either trust or guess at.
//
// The premise, and it is the player's: their taps are canon. If they tap
// along with what they HEAR and those taps land 150ms after the song's
// kicks, then the sound is reaching them 150ms late, and that is the number
// -- not a figure to be second-guessed against published averages or
// corrected for the well-documented human tendency to anticipate a
// metronome. Whatever they tap is what they hear.
//
// ## The closed loop, and why raw offsets cannot be averaged
//
// A tap is timestamped on the clock the ear is on -- `visualNow`, which
// already has the current trim subtracted from it. So the offset measured
// after applying a trim of T is the RESIDUAL against T, not the absolute
// error. Once the trim moves after every tap (which is the point: the value
// updates live), successive offsets are each measured against a different
// trim and averaging them directly would mix incompatible quantities and
// converge on the wrong number.
//
// So each tap is stored as what it implies the trim SHOULD be --
// `trimInForce + offset` -- and the estimate is the robust middle of those.
// Every entry is then in the same units, whatever the trim was doing while
// they were collected.
//
// Pure: no clock, no DOM, no audio. Every timestamp is handed in.
import { clamp, clamp01 } from '../utils/math.js';
import { MAX_LATENCY_MS } from '../core/ChoreoClock.js';
import { median } from './LatencyCalibrator.js';

/** A gap this long starts a fresh measurement. Matches BeatAnchor's own
 *  session gap: someone who stopped tapping and came back a while later is
 *  making a new judgement, not continuing an old one. */
export const TAP_SESSION_GAP_MS = 4000;

/** The same rail the stored preference and the manual input use. */
export const MAX_TRIM_MS = 500;

/**
 * The largest POSITIVE trim that will actually do anything.
 *
 * A positive trim delays the visuals by adding to the lag handed to
 * `visualNow`, which clamps the total to MAX_LATENCY_MS. Past that ceiling
 * the number keeps rising and the picture stops moving -- and for a loop
 * that measures its own residual and pushes again, that is a runaway: the
 * error never closes, so the trim climbs until it hits its own rail.
 * Observed in a browser at 376ms against a 350ms clamp.
 *
 * The negative side has no such ceiling here: it delays the audio through a
 * DelayNode built with a full second of range, so the ±500ms rail is the
 * only limit that applies.
 */
export function positiveTrimCeilingMs(outputLatencyMs = 0) {
  const reported = Number.isFinite(outputLatencyMs) ? Math.max(0, outputLatencyMs) : 0;
  return clamp(MAX_LATENCY_MS - reported, 0, MAX_TRIM_MS);
}

/** How far from a kick a tap may land and still count as aimed at it, as a
 *  fraction of the beat. Half a beat either side is the whole beat's worth
 *  of territory and no more -- past that the tap is closer to its neighbour
 *  and attributing it here would fold a whole beat into the estimate. */
const MATCH_WINDOW_BEATS = 0.5;
const MATCH_WINDOW_MIN_MS = 80;
const MATCH_WINDOW_MAX_MS = 400;

/**
 * Onsets closer together than this are one event, not two.
 *
 * Onset lists are not a grid. A real one, measured off a 120bpm fixture,
 * ran 1010, 81, 917, 81 -- the kicks arrive in flammed pairs. Matching a
 * tap against the raw list picks whichever half happens to be nearer,
 * which does not average out: it pulls every tap in the pair's
 * neighbourhood toward zero. Measured doing exactly that, reading 16ms
 * where 78ms was true.
 *
 * The fix is to collapse the cluster rather than to reject taps near it.
 * A player tapping the beat taps where the cluster STARTS -- the flam is
 * an ornament on that beat, not a second beat -- so the first onset is the
 * one to keep, and rejecting the tap would have thrown away good data for
 * a problem the onset list could fix about itself.
 */
export const FLAM_GAP_MS = 120;

/**
 * ...and it scales with tempo, because a fixed gap cannot tell an ornament
 * from a fast pattern.
 *
 * The onset detector will report hits 60ms apart, and a double-kick figure
 * at 100ms spacing is a real one, not a flam. Collapsing those would
 * measure a player who tapped the second kick as 100ms late and persist a
 * delay they never had. But double-kick figures live in fast music, so a
 * threshold expressed as a fraction of the beat separates the two: the
 * ornament observed in the wild was 81ms against a ~713ms beat (11%),
 * while a 100ms double-kick at 200bpm is a third of its beat.
 */
const FLAM_GAP_BEAT_FRACTION = 0.2;

/** Taps kept. Long enough to be robust, short enough that a player who
 *  drifts mid-pass is followed rather than averaged against their own past. */
const HISTORY_MAX = 16;

/** Fraction of the sample kept after discarding the wildest taps. A stray
 *  tap during a real pass is normal; letting one drag the delay is not. */
const KEEP_FRACTION = 0.75;
const MIN_KEPT = 3;

/**
 * The signed distance from `tapMs` to the nearest onset, or null when the
 * tap is not near one.
 *
 * Positive means the tap was LATE. Null is a real answer and the common one
 * for a tap during a rest or a fill: a tap with nothing to be measured
 * against is not a measurement, and feeding it in as a zero would drag the
 * estimate toward "no correction needed".
 *
 * `onsets` must be ascending; the search is binary because a four-minute
 * song has thousands of kicks and this runs on every tap.
 */
export function nearestOnsetOffsetMs(onsets, tapMs, windowMs) {
  if (!onsets?.length || !Number.isFinite(tapMs)) return null;
  let lo = 0;
  let hi = onsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (onsets[mid] < tapMs) lo = mid + 1; else hi = mid;
  }
  // `lo` is the first onset at or after the tap; its predecessor is the last
  // one before. The nearer of the two wins. Callers measuring against a
  // real chart should pass a list through `collapseFlams` first -- this
  // takes the list it is given at face value.
  let best = null;
  for (const i of [lo - 1, lo]) {
    if (i < 0 || i >= onsets.length) continue;
    const delta = tapMs - onsets[i];
    if (best === null || Math.abs(delta) < Math.abs(best)) best = delta;
  }
  if (best === null || Math.abs(best) > windowMs) return null;
  return best;
}

/**
 * One entry per cluster of onsets, keeping the first of each.
 *
 * The first is the beat; anything within `minGapMs` after it is the same
 * event's tail. Ascending in, ascending out.
 */
export function flamGapMs(beatPeriodMs) {
  const beat = Number.isFinite(beatPeriodMs) && beatPeriodMs > 0 ? beatPeriodMs : 500;
  return Math.min(FLAM_GAP_MS, beat * FLAM_GAP_BEAT_FRACTION);
}

export function collapseFlams(onsets, minGapMs = FLAM_GAP_MS) {
  if (!onsets?.length) return [];
  const out = [onsets[0]];
  for (let i = 1; i < onsets.length; i++) {
    if (onsets[i] - out[out.length - 1] >= minGapMs) out.push(onsets[i]);
  }
  return out;
}

/** How wide a window a tap may land in, for this tempo. */
export function matchWindowMs(beatPeriodMs) {
  const beat = Number.isFinite(beatPeriodMs) && beatPeriodMs > 0 ? beatPeriodMs : 500;
  return clamp(beat * MATCH_WINDOW_BEATS, MATCH_WINDOW_MIN_MS, MATCH_WINDOW_MAX_MS);
}

/** The robust middle of a sample: the median of everything except the
 *  wildest quarter, measured by distance from the median. */
export function trimmedMedian(values) {
  if (!values?.length) return 0;
  if (values.length <= MIN_KEPT) return median(values);
  const mid = median(values);
  const byDistance = [...values].sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
  const keep = Math.max(MIN_KEPT, Math.ceil(byDistance.length * KEEP_FRACTION));
  return median(byDistance.slice(0, keep));
}

/** Median absolute deviation: how much the taps disagree with each other.
 *  Reported so the UI can say whether an estimate is settled or still
 *  wandering, without anyone having to guess from the number alone. */
export function spreadMs(values) {
  if (!values?.length) return 0;
  const mid = median(values);
  return median(values.map((v) => Math.abs(v - mid)));
}

/** How long the eye-phase marker takes to fall back after a beat. Short
 *  enough that two beats never overlap at any playable tempo, long enough
 *  to be seen on a display that is itself the thing being measured. */
const PULSE_DECAY_MS = 220;

/**
 * The eye-phase marker's brightness, 1 at the beat and falling to 0.
 *
 * Driven by the VISUAL clock -- the same clock, with the same lag applied,
 * that the characters' beat-anchored moves are drawn on. That is the whole
 * point: tapping this marker measures the path from "the app decided to
 * draw this beat" to "a person saw it", which is the term a by-ear pass
 * cannot reach. A marker on its own private timer would measure nothing.
 */
export function beatPulse01(onsets, visualBeatMs, decayMs = PULSE_DECAY_MS) {
  if (!onsets?.length || !Number.isFinite(visualBeatMs)) return 0;
  let lo = 0;
  let hi = onsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (onsets[mid] <= visualBeatMs) lo = mid; else hi = mid - 1;
  }
  if (onsets[lo] > visualBeatMs) return 0; // before the first beat
  const age = visualBeatMs - onsets[lo];
  return clamp01(1 - age / Math.max(1, decayMs));
}

/** Which half of the pass a tap belongs to. */
export const PHASE_EAR = 'ear';
export const PHASE_EYE = 'eye';

/** Taps per phase before it has enough to stand on. Below this the reading
 *  is shown but described as unfinished. */
export const TAPS_PER_PHASE = 6;

export class SyncCalibrator {
  constructor(trimMs = 0) {
    this.trimMs = clamp(Math.round(trimMs) || 0, -MAX_TRIM_MS, MAX_TRIM_MS);
    this.phase = PHASE_EAR;
    /** Ear taps, normalised to what each implied the trim should be --
     *  `trim + offset`, which cancels the trim in force at the time and so
     *  stays comparable across a pass that is moving the trim as it goes. */
    this._implied = [];
    /** Eye taps, kept as raw offsets: the distance between a beat's picture
     *  being drawn and the tap it drew is display latency plus the player's
     *  own bias, and neither depends on the trim. */
    this._eye = [];
    this._lastTapMs = -Infinity;
    /** The collapsed onset list, cached against the array it came from --
     *  this runs on every tap and the chart does not change under it. */
    this._onsetsRef = null;
    this._collapsedGap = null;
    this._collapsed = [];
  }

  get taps() { return this._implied.length + this._eye.length; }

  get earTaps() { return this._implied.length; }

  get eyeTaps() { return this._eye.length; }

  /** Has this phase heard enough to move on? */
  get phaseComplete() {
    return (this.phase === PHASE_EAR ? this._implied.length : this._eye.length) >= TAPS_PER_PHASE;
  }

  /** How far the picture is behind the moment it was drawn for, in ms --
   *  display latency plus the player's bias. Only meaningful once the eye
   *  phase has taps; it is the term a by-ear pass cannot see. */
  get displayLagMs() {
    return this._eye.length ? Math.round(trimmedMedian(this._eye)) : null;
  }

  /** Move to the eye half. The session clock resets with it: the pause
   *  while someone reads the new instruction is not a gap in tapping. */
  beginPhase(phase) {
    this.phase = phase === PHASE_EYE ? PHASE_EYE : PHASE_EAR;
    this._lastTapMs = -Infinity;
  }

  /** Start over from a known trim -- what the Sync button does on entry. */
  reset(trimMs = this.trimMs) {
    this.trimMs = clamp(Math.round(trimMs) || 0, -MAX_TRIM_MS, MAX_TRIM_MS);
    this.phase = PHASE_EAR;
    this._implied = [];
    this._eye = [];
    this._lastTapMs = -Infinity;
  }

  /**
   * What the two passes together say the trim should be.
   *
   * With only ear taps this is the old single-pass answer, which silently
   * assumes the picture is instant. The eye phase is what removes that
   * assumption -- and, with it, the player's own tapping bias.
   */
  _wantedTrimMs() {
    if (!this._implied.length) return this.trimMs;
    const ear = trimmedMedian(this._implied);
    if (!this._eye.length) return Math.round(ear);
    return Math.round(ear - trimmedMedian(this._eye));
  }

  /**
   * The onsets a tap is actually matched against: the chart's kicks with
   * flammed pairs collapsed to the first of each cluster.
   *
   * Exposed because the eye phase's marker has to pulse on this same list.
   * Driving the marker from the raw kicks would flash twice for an ornament
   * while the match resolved to the first onset, so a player timing the
   * second flash would have the flam gap -- tens of milliseconds -- recorded
   * as display latency and subtracted from the trim.
   *
   * Cached on the identity of the onset array AND the gap, so a tempo change
   * re-derives the grid rather than keeping whatever beat length the pass
   * first saw. Called every frame while the marker is up; the cache is what
   * makes that free.
   *
   * @param {number[]} onsets ascending chart onsets (the kicks)
   * @param {number} beatPeriodMs current beat length, for the flam gap
   * @returns {number[]} the collapsed list
   */
  collapsedOnsets(onsets, beatPeriodMs) {
    const gap = flamGapMs(beatPeriodMs);
    if (onsets !== this._onsetsRef || gap !== this._collapsedGap) {
      this._onsetsRef = onsets;
      this._collapsedGap = gap;
      this._collapsed = collapseFlams(onsets, gap);
    }
    return this._collapsed;
  }

  /**
   * Take one tap and return the new trim, or null when the tap told us
   * nothing.
   *
   * @param {number} tapMs   the tap, on the clock the ear is on -- already
   *                         carrying the trim currently in force
   * @param {number[]} onsets ascending chart onsets (the kicks)
   * @param {number} beatPeriodMs current beat length, for the match window
   */
  tap(tapMs, onsets, beatPeriodMs, { maxPositiveTrimMs = MAX_TRIM_MS } = {}) {
    if (!Number.isFinite(tapMs)) return null;
    const offsetMs = nearestOnsetOffsetMs(
      this.collapsedOnsets(onsets, beatPeriodMs),
      tapMs,
      matchWindowMs(beatPeriodMs),
    );
    if (offsetMs === null) return null;

    const sample = this.phase === PHASE_EYE ? this._eye : this._implied;
    if (tapMs - this._lastTapMs > TAP_SESSION_GAP_MS) sample.length = 0;
    this._lastTapMs = tapMs;

    // An ear tap is stored as what it implies the trim should be, so entries
    // collected under different trims stay comparable. An eye tap is stored
    // raw: what it measures -- how long the picture takes to arrive -- does
    // not move when the trim does.
    sample.push(this.phase === PHASE_EYE ? offsetMs : this.trimMs + offsetMs);
    if (sample.length > HISTORY_MAX) sample.shift();

    const previous = this.trimMs;
    const ceiling = clamp(maxPositiveTrimMs, 0, MAX_TRIM_MS);
    const wanted = this._wantedTrimMs();
    this.trimMs = clamp(wanted, -MAX_TRIM_MS, ceiling);
    return {
      trimMs: this.trimMs,
      offsetMs,
      phase: this.phase,
      earTaps: this._implied.length,
      eyeTaps: this._eye.length,
      taps: sample.length,
      displayLagMs: this.displayLagMs,
      spreadMs: Math.round(spreadMs(sample)),
      changed: this.trimMs !== previous,
      phaseComplete: this.phaseComplete,
      // The taps are asking for more delay than the visual clock can apply.
      // Said out loud rather than swallowed: a player tapping harder at a
      // number that has stopped moving deserves to know why.
      railed: wanted > ceiling,
    };
  }
}

/**
 * The one-line readout for a live pass.
 *
 * Says which way the correction goes in the words the control uses --
 * visuals delayed, or audio delayed -- because "+150" and "-150" are not
 * self-explanatory to someone holding a phone in a car.
 */
export function syncStatusText(result) {
  if (!result) return null;
  const { trimMs, phase, earTaps, eyeTaps, spreadMs: spread, phaseComplete } = result;
  const magnitude = Math.abs(trimMs);
  const direction = trimMs > 0 ? 'visuals delayed' : trimMs < 0 ? 'audio delayed' : 'no delay';
  const head = trimMs === 0 ? 'Bluetooth delay: none' : `Bluetooth delay: ${magnitude}ms (${direction})`;

  if (phase === PHASE_EAR) {
    // The first half cannot know the answer yet -- it has not measured the
    // picture. Saying "settled" here would be a promise about a number that
    // is about to move.
    const left = Math.max(0, TAPS_PER_PHASE - earTaps);
    return left > 0
      ? `Listening… ${earTaps} of ${TAPS_PER_PHASE} taps`
      : 'Got your ears — now watch the marker.';
  }

  const left = Math.max(0, TAPS_PER_PHASE - eyeTaps);
  if (left > 0) return `${head} · watching… ${eyeTaps} of ${TAPS_PER_PHASE} taps`;
  if (result.railed) return `${head} · as far as the visuals can be delayed`;
  if (!phaseComplete) return `${head} · keep tapping`;
  return spread <= 25 ? `${head} · settled` : `${head} · ±${spread}ms, keep tapping`;
}

/** What the finished pass found, for the log and the closing line. */
export function syncResultText(calibrator) {
  if (!calibrator?.earTaps) return 'Sync cancelled before it measured anything.';
  if (!calibrator.eyeTaps) return `Bluetooth delay ${calibrator.trimMs}ms, from your ears alone — the screen was never measured.`;
  const display = calibrator.displayLagMs;
  return `Bluetooth delay ${calibrator.trimMs}ms. Your screen runs about ${display}ms behind its own frames.`;
}
