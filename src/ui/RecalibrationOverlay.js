// The tap-recalibration overlay.
//
// BeatAnchor has always been able to take a tapped-in tempo and phase and
// steer the whole show with it -- but the only feedback it ever gave was a
// neutral splat, so nothing told the player the feature existed, what to tap,
// or how long to keep tapping. This is that missing half: a big block count
// through eight measures, one line of instruction, and a live view of the
// anchor's confidence so the tapping visibly lands.
//
// Two deliberate properties:
//   * It never interrupts. The song plays on, the world keeps moving, the
//     panel is pointer-events:none, and taps fall straight through to the
//     canvas handler that already feeds BeatAnchor. Nothing here handles
//     input -- it only draws.
//   * The instruction is about GROOVE, not subdivision. Tapping straight
//     time tells the anchor almost nothing it didn't already have; tapping
//     what you'd slap the table to lands on the kick/snare pattern, which is
//     where the downbeat actually lives.
//
// It reads the clock the caller hands it, so it stays in step with whatever
// the sim considers "now" -- including output-latency compensation.

export const RECAL_MEASURES = 8;

/** What each half of the pass asks for. The wording is the measurement:
 *  one half times the sound reaching the ear, the other the picture
 *  reaching the eye, and the difference between them is the answer. */
export const PHASE_COPY = {
  ear: {
    title: 'Tap the kick, when you HEAR it.',
    body: 'The low drum. Go by your ears — ignore what the screen is doing.',
  },
  eye: {
    title: 'Now tap when the ring FLASHES.',
    body: 'Go by your eyes this time. The difference between the two is your delay.',
  },
};
const BEATS_PER_MEASURE = 4;
// Fade the instruction once the player has clearly read it; the count is the
// useful part after that.
const INSTRUCTION_MEASURES = 2;
// The eye marker's pulse, as opacity. The reduced-flash pair keeps a legible
// onset without the full-brightness swing (see update()).
const MARKER_DIM = 0.12;
const MARKER_LIT = 1;
const MARKER_DIM_SOFT = 0.45;
const MARKER_LIT_SOFT = 0.8;

export class RecalibrationOverlay {
  /**
   * @param {object} els {panel, number, instruction, pips, confFill, status}
   */
  constructor(els = {}) {
    this.els = els;
    this.active = false;
    this.startMs = 0;
    this.beatPeriodMs = 500;
    this._lastBeat = -1;
    this._startConfidence = 0;
    this._raf = 0;
    /** A line the caller owns, shown in place of the generic progress text.
     *  The Sync pass puts the Bluetooth delay it is deriving here, so the
     *  number the tapping is setting is visible while it is being set. */
    this.syncNote = '';
    /** Which half of the pass is running. The caller owns the transition. */
    this.phase = 'ear';
    this._buildPips();
  }

  _buildPips() {
    const { pips } = this.els;
    if (!pips || pips.childElementCount) return;
    for (let i = 0; i < BEATS_PER_MEASURE; i++) pips.appendChild(document.createElement('span'));
  }

  /**
   * @param {number} nowMs        the sim clock the count should run on
   * @param {number} beatPeriodMs current beat length (JumpController's EMA)
   * @param {number} confidence   BeatAnchor.confidence at entry, for the delta
   */
  /**
   * Switch halves. Re-shows the instruction, because it has changed, and
   * re-bases the pass deadline.
   *
   * The eight measures are a budget for ONE half. Measured from the start
   * of the pass they are shared, and on a sparse chart -- one kick per
   * measure -- the ear half can spend six of them on its six taps, leaving
   * two measures in which to collect six eye taps. The overlay would close
   * mid-instruction and the trim would be persisted from a two-sample eye
   * median, which is exactly the noisy number the six-tap requirement
   * exists to prevent.
   *
   * @param {number} [nowMs] the sim clock, to restart the count from here
   */
  setPhase(phase, nowMs = null) {
    const next = phase === 'eye' ? 'eye' : 'ear';
    if (next === this.phase) return;
    this.phase = next;
    if (Number.isFinite(nowMs)) {
      this.startMs = nowMs;
      this._lastBeat = -1;
      this._lastMeasure = -1;
    }
    const { instruction, marker, number } = this.els;
    instruction?.classList.remove('faded');
    this._phaseShownAtMs = null;
    this._writeInstruction();
    // The count belongs to the ear half; the eye half has a target instead,
    // and two big things pulsing at once would give the eye a choice.
    marker?.classList.toggle('hidden', next !== 'eye');
    if (number) number.style.opacity = next === 'eye' ? '0' : '';
  }

  _writeInstruction() {
    const { instruction } = this.els;
    if (!instruction) return;
    const copy = PHASE_COPY[this.phase] || PHASE_COPY.ear;
    instruction.innerHTML = '';
    const strong = document.createElement('strong');
    strong.textContent = copy.title;
    instruction.append(strong, document.createTextNode(copy.body));
  }

  start(nowMs, beatPeriodMs, confidence = 0) {
    if (this.active) return;
    this.active = true;
    this.startMs = nowMs;
    this.beatPeriodMs = Math.max(1, beatPeriodMs || 500);
    this._lastBeat = -1;
    this._startConfidence = confidence;
    const { panel, instruction, status } = this.els;
    instruction?.classList.remove('faded');
    this.syncNote = '';
    this.phase = 'ear';
    this._phaseShownAtMs = null;
    this._writeInstruction();
    this.els.marker?.classList.add('hidden');
    if (this.els.number) this.els.number.style.opacity = '';
    if (status) status.textContent = '';
    panel?.classList.remove('hidden');
    panel?.setAttribute('aria-hidden', 'false');
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    const { panel } = this.els;
    panel?.classList.add('hidden');
    panel?.setAttribute('aria-hidden', 'true');
  }

  /** Total length of a full pass, so callers can reason about it without
   *  duplicating the arithmetic. */
  durationMs(beatPeriodMs = this.beatPeriodMs) {
    return RECAL_MEASURES * BEATS_PER_MEASURE * Math.max(1, beatPeriodMs);
  }

  /**
   * Draw one frame. Call every sim step while active.
   * @returns {boolean} false once the eight measures are done (the caller
   *   should stop() and, if it likes, report the confidence delta).
   */
  update(nowMs, {
    beatPeriodMs = null, confidence = 0, beatPulse01 = 0, reducedFlash = false,
  } = {}) {
    if (!this.active) return false;
    // Track live tempo so a drifting/retuning estimate doesn't desynchronize
    // the count from what's actually playing.
    if (beatPeriodMs > 0) this.beatPeriodMs = beatPeriodMs;

    const elapsed = nowMs - this.startMs;
    const beat = Math.floor(elapsed / this.beatPeriodMs);
    const totalBeats = RECAL_MEASURES * BEATS_PER_MEASURE;
    if (beat >= totalBeats) return false;

    const measure = Math.floor(beat / BEATS_PER_MEASURE) + 1;
    const beatInMeasure = ((beat % BEATS_PER_MEASURE) + BEATS_PER_MEASURE) % BEATS_PER_MEASURE;
    const phase = Math.max(0, Math.min(1, (elapsed % this.beatPeriodMs) / this.beatPeriodMs));

    const { number, instruction, pips, confFill, status } = this.els;

    // The count belongs to the ear half only. Without this guard the
    // per-frame swell below rewrites the opacity that setPhase() zeroed,
    // and the big number ghosts through the eye half -- a second thing
    // pulsing next to the one the player is trying to time.
    if (number && this.phase === 'eye') {
      number.style.opacity = '0';
    } else if (number) {
      if (measure !== this._lastMeasure) {
        number.textContent = String(measure);
        this._lastMeasure = measure;
      }
      // Swell into the beat and snap on it -- the same shape the old
      // calibration beacon used, so the count is readable as a pulse even
      // with the sound off.
      const swell = 1 + 0.10 * (1 - phase) ** 3;
      number.style.transform = `scale(${swell.toFixed(3)})`;
      number.style.opacity = (0.55 + 0.45 * (1 - phase) ** 2).toFixed(3);
    }

    if (pips && beat !== this._lastBeat) {
      for (let i = 0; i < pips.childElementCount; i++) {
        pips.children[i].classList.toggle('on', i === beatInMeasure);
      }
      this._lastBeat = beat;
    }

    // The instruction fades once it has clearly been read -- measured from
    // when THIS phase's wording went up, not from the start of the pass, or
    // the eye half's instruction would arrive already faded.
    if (this._phaseShownAtMs === null) this._phaseShownAtMs = nowMs;
    const phaseElapsed = nowMs - this._phaseShownAtMs;
    if (instruction && phaseElapsed > INSTRUCTION_MEASURES * this.beatPeriodMs * BEATS_PER_MEASURE) {
      instruction.classList.add('faded');
    }

    // The eye half's target, on the visual clock the caller hands in.
    //
    // Reduced flash caps the swing rather than removing it. The pulse is the
    // thing being timed -- a marker that does not visibly change gives the
    // player nothing to tap, and the pass would measure noise -- so the
    // floor comes up and the ceiling comes down, keeping the ONSET sharp
    // (the edge is what a tap is timed against) while the flash itself stays
    // well short of a full-brightness strobe. The CSS media rule only ever
    // suppressed the scale, which left the brightness jump untouched for
    // anyone whose OS preference had turned this on by default.
    const { marker } = this.els;
    if (marker && this.phase === 'eye') {
      const lit = Math.max(0, Math.min(1, beatPulse01));
      const low = reducedFlash ? MARKER_DIM_SOFT : MARKER_DIM;
      const high = reducedFlash ? MARKER_LIT_SOFT : MARKER_LIT;
      marker.style.opacity = (low + (high - low) * lit).toFixed(3);
      const scale = reducedFlash ? 0.94 + 0.06 * lit : 0.82 + 0.28 * lit;
      marker.style.transform = `scale(${scale.toFixed(3)})`;
    }
    if (confFill) confFill.style.width = `${Math.round(Math.max(0, Math.min(1, confidence)) * 100)}%`;
    if (status) {
      // The caller's line wins when there is one: a live delay readout is
      // more use than a measure count, and it is what the pass is FOR.
      status.textContent = this.syncNote ? this.syncNote : confidence >= 0.85
        ? 'Locked on — keep going or stop whenever.'
        : confidence >= 0.4
          ? 'Got it, keep tapping…'
          : `Measure ${measure} of ${RECAL_MEASURES}`;
    }
    return true;
  }

  /** A short human summary of what the pass achieved, for the status line. */
  resultText(confidence) {
    const gained = confidence - this._startConfidence;
    if (confidence >= 0.85) return 'Synced to your groove.';
    if (gained > 0.2) return 'Better — tap again anytime to tighten it.';
    return 'No change kept. Tap along whenever it drifts.';
  }
}
