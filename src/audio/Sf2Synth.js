// Sample-playback synth built on Sf2Parser output. Mirrors SimpleSynth's
// shape (constructor(audioEngine), connectConductor, noteOn) so SynthRouter
// can swap it in or out as the active engine.
//
// - One cached AudioBuffer per sampleIndex (pooled, not per-note)
// - 48-voice polyphony with oldest-voice stealing
// - Key/vel zone match with a 2-layer cap
// - ADSR gain envelope per zone
// - Role → GM program map; bank 128 for RHYTHM
import { Role } from '../core/NoteEvent.js';
import { parseSf2 } from './Sf2Parser.js';

const MAX_VOICES = 48;

// Role → (bank, program) for preset lookup.
const ROLE_PROGRAMS = {
  [Role.MELODY]: { bank: 0, program: 0 },   // Acoustic Grand Piano
  [Role.BASS]:   { bank: 0, program: 33 },   // Electric Bass (finger)
  [Role.PAD]:    { bank: 0, program: 89 },   // Pad 1 (new age)
  [Role.RHYTHM]: { bank: 128, program: 0 },  // Standard Drum Set
};

const presetKey = (bank, program) => bank * 128 + program;

/**
 * Blends a soundfont zone's own authored pan (its stereo-pair spread, or
 * just a static instrument placement) with the MIDI channel's pan (CC#10,
 * or the intertwined-pair pan-out curve). A plain sum+clamp lets an extreme
 * track pan fight the font's own L/R pair apart — e.g. a hard-right track
 * (evtPan=+1) plus a hard-left zone (zonePan=-1) sums to 0, dragging the
 * "left" half of a stereo pair back to dead center while its "right" half
 * clamps to +1, skewing the image. This blend instead treats `evtPan` as
 * the track's mandatory center: as it approaches ±1 it proportionally
 * compresses (never cancels) the zone's own spread, so a fully hard-panned
 * track collapses stereo zones to its single side by design, while a
 * centered track leaves the font's authored stereo width fully intact.
 * Bounded to [-1,1] by construction (|evtPan| + |zonePan|*(1-|evtPan|) <=
 * |evtPan| + (1-|evtPan|) = 1); the clamp is defensive only.
 */
export function combinePan(evtPan, zonePan) {
  return Math.max(-1, Math.min(1, evtPan + zonePan * (1 - Math.abs(evtPan))));
}

export class Sf2Synth {
  constructor(audioEngine) {
    this.ae = audioEngine;
    this.enabled = true;
    this.sf2 = null;
    this._buffers = new Map(); // sampleIndex → AudioBuffer (lazy, pooled)
    this._voices = [];
  }

  /** Immediately fades and stops every currently-sounding voice. Called
   *  before swapping fonts or starting a new song so the outgoing font's
   *  notes never bleed into the incoming one. */
  stopAll() {
    const ctx = this.ae?.ctx;
    for (const voice of this._voices) {
      try {
        if (voice.gain && ctx) {
          const now = ctx.currentTime;
          voice.gain.gain.cancelScheduledValues(now);
          voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
          voice.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.02);
        }
        voice.src?.stop?.(ctx ? ctx.currentTime + 0.03 : 0);
      } catch { /* already ended */ }
    }
    this._voices = [];
  }

  /** Load a parsed SF2 (from parseSf2) or an ArrayBuffer. Pass null to unload. */
  loadSf2(parsedOrBuffer, name) {
    this.stopAll();
    if (parsedOrBuffer == null) {
      this.sf2 = null;
      this._buffers.clear();
      return;
    }
    if (parsedOrBuffer instanceof ArrayBuffer) {
      this.sf2 = parseSf2(parsedOrBuffer, name);
    } else {
      this.sf2 = parsedOrBuffer;
    }
    this._buffers.clear();
    return this.sf2;
  }

  connectConductor(conductor) {
    return conductor.on('*', (evt) => this.noteOn(evt));
  }

  /**
   * @param {import('../core/NoteEvent.js').NoteEvent} evt
   * @param {number|null} [whenSec] explicit ctx-time start. Live play omits
   *   it (notes start "now"); the offline audition renderer passes each
   *   event's timeline offset so a whole song excerpt can be scheduled up
   *   front against an OfflineAudioContext.
   */
  noteOn(evt, whenSec = null) {
    if (!this.enabled || !this.sf2) return;
    const preset = this._findPreset(evt.role, evt.program ?? -1);
    if (!preset) return;

    const vel = Math.round(evt.vel * 127);
    const matching = preset.zones.filter(
      (z) => evt.pitch >= z.loKey && evt.pitch <= z.hiKey &&
            vel >= z.loVel && vel <= z.hiVel,
    );
    // 2-layer cap: only the first two matching zones play.
    for (const zone of matching.slice(0, 2)) {
      this._playZone(zone, evt, whenSec);
    }
  }

  /**
   * Resolves the preset to play: a real MIDI program (from the source file)
   * wins when the loaded font has a matching bank-0 preset, so a track keeps
   * its authored instrument instead of always falling back to the role's
   * generic default. RHYTHM always stays in bank 128 (drum kits) first, but
   * still honors the specific kit variant the MIDI selected via Program
   * Change. Every role ends in a last-resort scan of the whole font so a
   * font that simply doesn't have the "usual" programs (a single-instrument
   * export, a strings-only pack, a drum-kit-only pack) still makes SOME
   * sound instead of dropping notes silently — melodic roles never borrow a
   * drum-kit preset, and RHYTHM only borrows a melodic one if the font has
   * no drum kit at all.
   */
  _findPreset(role, program) {
    if (role === Role.RHYTHM) {
      const kit = program >= 0 ? program : 0;
      return this.sf2.presets.get(presetKey(128, kit))
          || this.sf2.presets.get(presetKey(128, 0))
          || this._firstInBank(128)
          || this._anyPreset();
    }
    if (program >= 0) {
      const p = this.sf2.presets.get(presetKey(0, program));
      if (p) return p;
    }
    const cfg = ROLE_PROGRAMS[role] || ROLE_PROGRAMS[Role.MELODY];
    return this.sf2.presets.get(presetKey(cfg.bank, cfg.program))
        || this.sf2.presets.get(0) // bank 0, program 0
        || this._firstInBank(0)
        || this._anyPreset(128); // never hand a melodic note a drum kit
  }

  /** First preset found in `bank`, in Map insertion (file) order, or null. */
  _firstInBank(bank) {
    for (const preset of this.sf2.presets.values()) {
      if (preset.bank === bank) return preset;
    }
    return null;
  }

  /** Any preset at all — the true last resort for a font with unconventional
   *  bank numbers (nothing in bank 0 or 128). `excludeBank` skips a bank
   *  (e.g. the drum bank for melodic-role callers). Null only when the font
   *  has zero presets. */
  _anyPreset(excludeBank = -1) {
    for (const preset of this.sf2.presets.values()) {
      if (preset.bank !== excludeBank) return preset;
    }
    return null;
  }

  _getBuffer(sampleIndex) {
    let buf = this._buffers.get(sampleIndex);
    if (buf) return buf;
    const sample = this.sf2.samples[sampleIndex];
    if (!sample) return null;
    buf = this._renderSample(sample);
    this._buffers.set(sampleIndex, buf);
    return buf;
  }

  _renderSample(sample) {
    const ctx = this.ae.ctx;
    const sd = this.sf2.sampleData;
    const start = sample.start;
    const end = Math.min(sample.end, sd.length);
    const len = Math.max(1, end - start);
    const buf = ctx.createBuffer(1, len, sample.sampleRate || 44100);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      ch[i] = sd[start + i] / 32768;
    }
    return buf;
  }

  _playZone(zone, evt, whenSec = null) {
    const ctx = this.ae.ctx;
    const buf = this._getBuffer(zone.sampleIndex);
    if (!buf) return;
    const sample = this.sf2.samples[zone.sampleIndex];
    if (!sample) return;

    const src = ctx.createBufferSource();
    src.buffer = buf;

    // Pitch ratio: 2^((pitch - rootKey - fineTune_cents/100 - coarseTune) / 12)
    const rootKey = sample.rootKey > 0 ? sample.rootKey : 60;
    const fineCents = (zone.fineTune || 0) + (sample.fineTune || 0);
    const semis = evt.pitch - rootKey - fineCents / 100 - (zone.coarseTune || 0);
    src.playbackRate.value = Math.pow(2, semis / 12);

    // Loop — AudioBuffer was rendered starting from sample.start, so loop
    // points must be offset by sample.start to land within the buffer.
    if (zone.loopMode === 1 && sample.loopEnd > sample.loopStart) {
      src.loop = true;
      const sr = sample.sampleRate || 44100;
      src.loopStart = Math.max(0, sample.loopStart - sample.start) / sr;
      src.loopEnd = Math.max(1, sample.loopEnd - sample.start) / sr;
    }

    // Gain envelope (AHDSR: attack → hold → decay → sustain → release)
    const gain = ctx.createGain();
    const t = whenSec != null ? whenSec : ctx.currentTime;
    const peak = evt.vel * (zone.attenuation ?? 1) * 0.25; // scale to prevent clipping
    const sustainLevel = Math.max(0.0001, peak * (zone.sustain ?? 1));
    const atk = Math.max(0.0005, zone.attack ?? 0.005);
    const hld = Math.max(0, zone.hold ?? 0);
    const dec = Math.max(0.001, zone.decay ?? 0.05);
    const rel = Math.max(0.01, zone.release ?? 0.05);
    const dur = Math.max(0.05, evt.durMs / 1000);
    const relStart = t + dur;

    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(peak, t + atk);
    const holdEnd = t + atk + hld;
    gain.gain.setValueAtTime(peak, holdEnd);
    const decEnd = holdEnd + dec;
    if (decEnd <= relStart) {
      gain.gain.exponentialRampToValueAtTime(sustainLevel, decEnd);
      gain.gain.setValueAtTime(sustainLevel, relStart);
    } else {
      const decElapsed = Math.max(0, relStart - holdEnd);
      const decFrac = dec > 0 ? decElapsed / dec : 1;
      const partialLevel = Math.max(0.0001, peak - (peak - sustainLevel) * decFrac);
      gain.gain.exponentialRampToValueAtTime(partialLevel, relStart);
    }
    gain.gain.exponentialRampToValueAtTime(0.0001, relStart + rel);

    // Routing: gain → (stereoPanner →) master. See combinePan() above.
    const combinedPan = combinePan(evt.pan || 0, zone.pan || 0);
    if (combinedPan && typeof ctx.createStereoPanner === 'function') {
      const panner = ctx.createStereoPanner();
      panner.pan.value = combinedPan;
      gain.connect(panner);
      panner.connect(this.ae.master);
    } else {
      gain.connect(this.ae.master);
    }

    src.connect(gain);
    src.start(t);
    const stopAt = Math.max(relStart + rel + 0.05, decEnd);
    src.stop(stopAt);

    // Offline (explicit-time) scheduling skips voice management entirely:
    // stealing happens at SCHEDULE time against ctx.currentTime, so with the
    // whole song scheduled up front it would fade voices at t≈0 regardless
    // of when they were due to sound — and an OfflineAudioContext has no
    // realtime polyphony budget to protect in the first place.
    if (whenSec != null) return;

    // Voice management (oldest steal with quick fade to avoid clicks)
    const voice = { src, gain, t };
    if (this._voices.length >= MAX_VOICES) {
      const old = this._voices.shift();
      if (old?.src && old?.gain) {
        const now = ctx.currentTime;
        try {
          old.gain.gain.cancelScheduledValues(now);
          old.gain.gain.setValueAtTime(old.gain.gain.value, now);
          old.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.02);
          old.src.stop(now + 0.03);
        } catch { /* already ended */ }
      }
    }
    src.onended = () => {
      const i = this._voices.indexOf(voice);
      if (i >= 0) this._voices.splice(i, 1);
    };
    this._voices.push(voice);
  }
}