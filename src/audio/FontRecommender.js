// FontRecommender: on every MIDI load, auditions each loaded SoundFont
// against THIS song (offline render → analysis → verdict, see
// FontAudition.js) and steers the library to the best fit. The MIDI file is
// the volatile variable — a font that was perfect for the last song can be
// dead silent for this one — so results live on each font as `font.review`
// and are rebuilt from scratch per song.
//
// Policy:
//  - Fonts are auditioned sequentially in the background (active font
//    first), never blocking song start. A newer audition run (new file
//    dropped mid-song) cancels the rest of an older one via a generation
//    token.
//  - The moment the ACTIVE font's own audition lands as disqualified, we
//    bail out of it immediately — to the best qualified font seen so far,
//    or to the built-in oscillator synth (library.deselect()) when nothing
//    qualified yet. Sitting in silence while the rest of the queue renders
//    would be exactly the bug this engine exists to fix.
//  - When the whole queue is done, the top-scoring qualified font is
//    activated — unless the user manually picked a font for this song
//    (pinUserChoice), in which case we only badge and never yank.
//  - All fonts disqualified → deselect to the built-in synth: a plain
//    oscillator beats silence, rumble, or clicks.
import { buildAuditionPlan, analyzeAudition, scoreAudition, REASON_LABEL } from './FontAudition.js';
import { Sf2Synth } from './Sf2Synth.js';

const PREFERRED_SAMPLE_RATE = 22050; // analysis needs nothing above ~10 kHz; halves render cost
const SWITCH_MARGIN = 6;             // don't hop fonts over a rounding-error score difference

export class FontRecommender {
  /**
   * @param {import('./SoundfontLibrary.js').SoundfontLibrary} library
   * @param {{onUpdate?: Function}} [opts] onUpdate fires after any review /
   *   recommendation change — wire it to UI re-render.
   */
  constructor(library, { onUpdate = null } = {}) {
    this.library = library;
    this.onUpdate = onUpdate;
    this.plan = null;
    this.recommendedIndex = -1;
    this.userPinned = false;
    // Master switch for the auto-selection side (audition + badges always
    // run). Off = observe-only; smoke tests that exercise raw switcher
    // mechanics use it so the engine doesn't fight their scripted clicks.
    this.autoApply = true;
    this._gen = 0;
    this.sampleRate = pickOfflineSampleRate();
  }

  get available() {
    return typeof OfflineAudioContext !== 'undefined';
  }

  /** Progress snapshot for the switcher popup's status line. */
  get status() {
    const visible = this.library.fonts.filter((f) => !f.hidden);
    const done = visible.filter((f) => f.review && f.review.status !== 'pending').length;
    return {
      planned: !!this.plan,
      total: visible.length,
      done,
      analyzing: !!this.plan && done < visible.length,
      recommendedIndex: this.recommendedIndex,
      allDisqualified: !!this.plan && visible.length > 0
        && visible.every((f) => f.review?.status === 'disqualified'),
    };
  }

  isDone() {
    const s = this.status;
    return s.planned && s.total > 0 && s.done >= s.total;
  }

  /** The user explicitly chose a font for this song — badge, never yank. */
  pinUserChoice() {
    this.userPinned = true;
  }

  /** Forget everything (raw-audio load, teardown): no plan, no badges. */
  clear() {
    this._gen++;
    this.plan = null;
    this.recommendedIndex = -1;
    this.userPinned = false;
    for (const f of this.library.fonts) delete f.review;
    this._notify();
  }

  /**
   * Audition every visible font against a freshly loaded timeline.
   * Fire-and-forget from the load path — never blocks song start.
   */
  async auditionForTimeline(timelineData) {
    this._gen++;
    const gen = this._gen;
    this.userPinned = false;
    this.recommendedIndex = -1;
    for (const f of this.library.fonts) delete f.review;
    this.plan = buildAuditionPlan(timelineData);
    this._notify();
    if (!this.plan || !this.available) return;

    // Active font first: it's the one currently sounding, so its verdict is
    // the one that can un-silence the song fastest.
    const fonts = this.library.fonts.filter((f) => !f.hidden);
    const active = this.library.active;
    fonts.sort((a, b) => (a === active ? -1 : 0) - (b === active ? -1 : 0));
    for (const f of fonts) f.review = { status: 'pending' };
    this._notify();

    for (const font of fonts) {
      if (gen !== this._gen) return; // a newer song took over
      await this._auditionOne(font, gen);
      if (gen !== this._gen) return;
      // Let the main thread breathe between renders (UI, note scheduling).
      await new Promise((r) => setTimeout(r, 0));
    }
    if (gen === this._gen) this._applyRecommendation(true);
  }

  /** Audition a font added mid-song against the current plan. */
  async auditionFont(font) {
    if (!this.plan || !this.available || font.hidden || font.review) return;
    const gen = this._gen;
    font.review = { status: 'pending' };
    this._notify();
    await this._auditionOne(font, gen);
    if (gen === this._gen) this._applyRecommendation(false);
  }

  /** Re-run the pick against existing reviews (e.g. after hide/unhide). */
  reapply() {
    if (this.plan) this._applyRecommendation(false);
  }

  async _auditionOne(font, gen) {
    let review;
    try {
      const rendered = await this._renderPlan(font.data);
      if (gen !== this._gen) return;
      const metrics = analyzeAudition(rendered, this.plan);
      const verdict = scoreAudition(metrics);
      review = verdict.disqualified
        ? { status: 'disqualified', dq: verdict.disqualified, reason: verdict.reason, score: 0 }
        : { status: 'ok', score: verdict.score, parts: verdict.parts };
    } catch (err) {
      console.warn('[font audition failed]', font.name, err);
      review = { status: 'disqualified', dq: 'error', reason: REASON_LABEL.error, score: 0 };
    }
    if (gen !== this._gen) return;
    font.review = review;
    this._notify();

    // Fast path out of a bad active font — silence is the enemy.
    if (this.autoApply && !this.userPinned
        && this.library.active === font && review.status === 'disqualified') {
      const bestSoFar = this._bestQualifiedIndex();
      if (bestSoFar >= 0) this.library.select(bestSoFar);
      else this.library.deselect();
      this.recommendedIndex = bestSoFar;
      this._notify();
    }
  }

  /** Renders the plan's two sections (song excerpt + isolated probes)
   *  through `parsed` with the same Sf2Synth the live path uses. */
  async _renderPlan(parsed) {
    const excerptData = await this._renderSection(parsed, this.plan.excerpt.events, this.plan.excerpt.renderDurationSec);
    const probeData = await this._renderSection(parsed, this.plan.probes.events, this.plan.probes.renderDurationSec);
    return { excerptData, probeData, sampleRate: this.sampleRate };
  }

  async _renderSection(parsed, events, durationSec) {
    const sr = this.sampleRate;
    const length = Math.max(sr, Math.ceil(durationSec * sr));
    const ctx = new OfflineAudioContext(1, length, sr);
    const master = ctx.createGain();
    master.gain.value = 0.85; // mirror AudioEngine's live master gain
    master.connect(ctx.destination);
    const synth = new Sf2Synth({ ctx, master });
    synth.loadSf2(parsed);
    for (const evt of events) synth.noteOn(evt, evt.tMs / 1000);
    const buf = await ctx.startRendering();
    return buf.getChannelData(0);
  }

  _bestQualifiedIndex() {
    let best = -1, bestScore = -1;
    this.library.fonts.forEach((font, index) => {
      if (font.hidden || font.review?.status !== 'ok') return;
      if (font.review.score > bestScore) { bestScore = font.review.score; best = index; }
    });
    return best;
  }

  _applyRecommendation(finalPass) {
    const best = this._bestQualifiedIndex();
    this.recommendedIndex = best;

    if (this.autoApply && !this.userPinned) {
      const active = this.library.active;
      const activeReview = active?.review;
      if (best < 0) {
        // Everything reviewed so far failed. On the final pass (or when the
        // active font itself is disqualified) fall back to the built-in
        // synth rather than leave a broken font sounding.
        if (active && activeReview?.status === 'disqualified') this.library.deselect();
      } else {
        const bestFont = this.library.fonts[best];
        const activeOk = activeReview?.status === 'ok';
        const shouldSwitch = !active
          || (!activeOk && (finalPass || activeReview?.status === 'disqualified'))
          || (activeOk && bestFont.review.score > activeReview.score + SWITCH_MARGIN);
        if (shouldSwitch && bestFont !== active) this.library.select(best);
      }
    }
    this._notify();
  }

  _notify() {
    if (this.onUpdate) this.onUpdate(this.status);
  }
}

function pickOfflineSampleRate() {
  if (typeof OfflineAudioContext === 'undefined') return PREFERRED_SAMPLE_RATE;
  try {
    // eslint-disable-next-line no-new
    new OfflineAudioContext(1, 1, PREFERRED_SAMPLE_RATE);
    return PREFERRED_SAMPLE_RATE;
  } catch {
    return 44100; // some engines only accept hardware-ish rates offline
  }
}
