// Reads the emotional weather of the music: two axes every other system
// can consume.
//   valence [-1, 1]  sad <-> happy. Dominated by the major-vs-minor-third
//                    balance against the inferred tonic over a rolling 6s
//                    window, tinted by spectral
//                    brightness (air/presence vs bass energy).
//   epic    [0, 1]   trivial <-> epic. Loudness + note density + how many
//                    octaves the writing spans right now.
// Both are EMA-smoothed: vibes turn like weather, not like switches.
import { Role } from '../core/NoteEvent.js';
import { clamp, clamp01 } from '../utils/math.js';
import { FLAT_WEIGHTS } from '../audio/bands.js';

const WINDOW_MS = 6000;
const EVAL_EVERY_MS = 240;
const VAL_TAU = 2.5, EPIC_TAU = 2.0;

export class VibeDirector {
  constructor(timeline, tonalityTimeline = null) {
    this.notes = timeline
      .filter((e) => e.role !== Role.RHYTHM && Number.isFinite(e.pitch))
      .sort((a, b) => a.tMs - b.tMs);
    this._lo = 0;
    this._hi = 0;
    this._nextEvalMs = 0;
    this._rawValence = 0;
    this._rawEpic = 0.3;
    this.valence = 0;
    this.epic = 0.3;
    // The Key of the World (Movement III): the argmax pitch class already
    // computed below for the major/minor third balance, exposed for
    // BiomeManager's harmony-driven palette. Held from the last window with
    // enough evidence (count>=3) rather than reset every thin-evidence eval.
    this.tonic = 0;
    this.tonicConfidence = 0;
    // Raw-audio analysis supplies a Krumhansl key timeline from its spectral
    // chroma. Prefer it when confident so the live world does not disagree
    // with AudioAdapter's global-key fingerprint; MIDI/demo keep the exact
    // note-event fallback below.
    this.tonalityTimeline = Array.isArray(tonalityTimeline)
      ? tonalityTimeline
        .filter((k) => Number.isFinite(k?.tMs) && Number.isFinite(k?.tonic))
        .sort((a, b) => a.tMs - b.tMs)
      : [];
    // Additive external bias (-1..1), set each step by Simulation from the
    // fused lyric structure's current section kind (SectionFusion.
    // epicBiasForKind) -- the "epic bridge" reads as genuinely epic even
    // when the music alone wouldn't have said so. Zero (no-op) when there's
    // no lyric data at all.
    this.epicBias = 0;
  }

  _tonalityAt(nowMs) {
    const keys = this.tonalityTimeline;
    if (keys.length === 0) return null;
    let lo = 0, hi = keys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keys[mid].tMs <= nowMs) lo = mid + 1; else hi = mid;
    }
    return keys[Math.max(0, lo - 1)] || null;
  }

  _evaluate(nowMs, energyCurves) {
    while (this._lo < this.notes.length && this.notes[this._lo].tMs < nowMs - WINDOW_MS) this._lo++;
    while (this._hi < this.notes.length && this.notes[this._hi].tMs <= nowMs) this._hi++;

    const hist = new Array(12).fill(0);
    let minP = Infinity, maxP = -Infinity, count = 0;
    for (let i = this._lo; i < this._hi; i++) {
      const n = this.notes[i];
      hist[((n.pitch % 12) + 12) % 12] += n.vel;
      if (n.pitch < minP) minP = n.pitch;
      if (n.pitch > maxP) maxP = n.pitch;
      count++;
    }

    let third = 0;
    const spectralKey = this._tonalityAt(nowMs);
    if (spectralKey && spectralKey.confidence >= 0.15) {
      this.tonic = ((Math.round(spectralKey.tonic) % 12) + 12) % 12;
      this.tonicConfidence = clamp01(spectralKey.confidence);
      third = clamp(spectralKey.majorness ?? 0, -1, 1);
    } else if (count >= 3) {
      let tonic = 0;
      for (let pc = 1; pc < 12; pc++) if (hist[pc] > hist[tonic]) tonic = pc;
      const M = hist[(tonic + 4) % 12], m = hist[(tonic + 3) % 12];
      third = (M - m) / (M + m + 0.5); // +0.5: thin evidence shouldn't swing hard

      let second = 0;
      for (let pc = 0; pc < 12; pc++) if (pc !== tonic && hist[pc] > second) second = hist[pc];
      this.tonic = tonic;
      this.tonicConfidence = clamp01((hist[tonic] - second) / (hist[tonic] + 0.5));
    }

    let bright = 0;
    if (energyCurves) {
      const hi = energyCurves.sample(5, nowMs) + energyCurves.sample(6, nowMs);
      const lo = energyCurves.sample(1, nowMs) + energyCurves.sample(2, nowMs);
      bright = clamp((hi - lo) * 0.8, -1, 1);
    }
    this._rawValence = clamp(0.72 * third + 0.28 * bright, -1, 1);

    const E = energyCurves ? clamp01(energyCurves.globalEnergyNorm(nowMs, FLAT_WEIGHTS)) : 0.3;
    const density = count / (WINDOW_MS / 1000);
    const octaves = count >= 2 ? (maxP - minP) / 12 : 0;
    this._rawEpic = clamp01(0.45 * E + 0.25 * Math.min(1, density / 6) + 0.30 * Math.min(1, octaves / 3));
  }

  update(nowMs, dtSec, energyCurves) {
    if (nowMs >= this._nextEvalMs) {
      this._evaluate(nowMs, energyCurves);
      this._nextEvalMs = nowMs + EVAL_EVERY_MS;
    }
    this.valence += (1 - Math.exp(-dtSec / VAL_TAU)) * (this._rawValence - this.valence);
    const epicTarget = clamp01(this._rawEpic + this.epicBias);
    this.epic += (1 - Math.exp(-dtSec / EPIC_TAU)) * (epicTarget - this.epic);
  }
}
