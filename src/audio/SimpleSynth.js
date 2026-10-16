// Minimal role-aware synth so MIDI-sourced timelines (which carry no audio
// of their own) are audible: oscillator tones for MELODY/BASS/PAD, a pitched
// sine-sweep kick + filtered noise bursts for RHYTHM. Not a GM synth — just
// enough to make "audio-clock-mastered" mean something for .mid input.
// Every voice is routed through _connectOut() so a note's evt.pan (authored
// MIDI CC#10, or the intertwined-pair pan-out curve) is audible even on the
// no-soundfont fallback path.
import { Role } from '../core/NoteEvent.js';

export class SimpleSynth {
  constructor(audioEngine) {
    this.ae = audioEngine;
    this.enabled = true;
    // Per-channel patches from SynthPatchDesigner.designSynthPatches, set
    // once per MIDI load (main.js's loadMidiFile). null (the default, and
    // what every non-MIDI/no-timeline caller keeps) means "no composition
    // to optimize for" -- _tone falls back to the original fixed
    // sine/sawtooth/triangle-by-role voicing, byte-identical to before.
    this.patches = null;
    this._noiseBuffers = new Map();
    this._voices = new Set();
  }

  /** @param {Object<number, object>|null} patches keyed by MIDI channel */
  setPatches(patches) {
    this.patches = patches && Object.keys(patches).length ? patches : null;
  }

  connectConductor(conductor) {
    return conductor.on('*', (evt) => this.noteOn(evt));
  }

  noteOn(evt) {
    if (!this.enabled) return;
    if (evt.role === Role.RHYTHM) this._drum(evt);
    else this._tone(evt);
  }

  /** Release only voices that exist at teardown. A separate per-voice gain
   * keeps the authored envelope intact (including attack-phase stops) and
   * leaves the shared master and any incoming song/recording untouched.
   * Linear release reaches exact silence in 30 ms; sources stop there too.
   * Repeated teardown does not restart or extend a voice's release. */
  stopAll() {
    const t = this.ae.ctx.currentTime;
    const stopAt = t + 0.03;
    for (const voice of this._voices) {
      if (voice.stopping) continue;
      voice.stopping = true;
      voice.release.gain.setValueAtTime(1, t);
      voice.release.gain.linearRampToValueAtTime(0, stopAt);
      for (const source of voice.sources) source.stop(stopAt);
    }
  }

  /** Own every source and intermediate node, including inaudible LFOs.
   * Natural and forced completion share the same cleanup. Wait for every
   * sibling's ended event before disconnecting the voice's signal graph. */
  _ownVoice(output, sources, nodes, pan) {
    const release = this.ae.ctx.createGain();
    release.gain.value = 1;
    output.connect(release);
    const panner = this._connectOut(release, pan);
    const voice = { release, sources: new Set(sources), nodes: [...nodes, release], stopping: false };
    if (panner) voice.nodes.push(panner);
    this._voices.add(voice);
    for (const source of sources) {
      source.onended = () => {
        if (!voice.sources.delete(source) || voice.sources.size) return;
        this._voices.delete(voice);
        for (const node of voice.nodes) node.disconnect();
      };
    }
  }

  /** Connects `node` to master, inserting a StereoPannerNode when pan is non-negligible. */
  _connectOut(node, pan) {
    const ctx = this.ae.ctx;
    if (pan && Math.abs(pan) > 0.001 && typeof ctx.createStereoPanner === 'function') {
      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      node.connect(panner);
      panner.connect(this.ae.master);
      return panner;
    } else {
      node.connect(this.ae.master);
    }
  }

  _tone(evt) {
    const patch = this.patches?.[evt.channel];
    if (patch) this._patchedTone(evt, patch); else this._plainTone(evt);
  }

  _plainTone(evt) {
    const ctx = this.ae.ctx;
    const t = ctx.currentTime;
    const freq = 440 * Math.pow(2, (evt.pitch - 69) / 12);
    const osc = ctx.createOscillator();
    osc.type = evt.role === Role.BASS ? 'sawtooth' : evt.role === Role.PAD ? 'triangle' : 'sine';
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    const peak = (evt.role === Role.PAD ? 0.10 : 0.16) * evt.vel;
    const dur = Math.max(0.08, evt.durMs / 1000);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(peak, t + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain);
    this._ownVoice(gain, [osc], [osc, gain], evt.pan);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /** Voices a note through a patch designed for this song's own channel
   *  (SynthPatchDesigner): a primary oscillator, an optional detuned unison
   *  voice for chordal lines, a lowpass shaped for that channel's register/
   *  brightness, an attack/release scaled to how legato the line reads, and
   *  vibrato on sustained melodic lines. */
  _patchedTone(evt, patch) {
    const ctx = this.ae.ctx;
    const t = ctx.currentTime;
    const freq = 440 * Math.pow(2, (evt.pitch - 69) / 12);
    const dur = Math.max(0.08, evt.durMs / 1000);
    const stopAt = t + dur + patch.release + 0.05;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = patch.cutoffHz;
    filter.Q.value = patch.resonanceQ;

    const gain = ctx.createGain();
    const peak = patch.peakGain * evt.vel;
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(peak, t + patch.attack);
    gain.gain.setValueAtTime(peak, Math.max(t + patch.attack, t + dur));
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur + patch.release);

    const osc = ctx.createOscillator();
    osc.type = patch.type;
    osc.frequency.value = freq;
    osc.connect(filter);
    const sources = [osc];
    const nodes = [osc, filter, gain];

    if (patch.vibratoDepthCents > 0) {
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = patch.vibratoRateHz;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = patch.vibratoDepthCents;
      lfo.connect(lfoGain).connect(osc.detune);
      sources.push(lfo);
      nodes.push(lfo, lfoGain);
      lfo.start(t);
      lfo.stop(stopAt);
    }

    let unison = null;
    if (patch.unisonGain > 0) {
      unison = ctx.createOscillator();
      unison.type = patch.type;
      unison.frequency.value = freq;
      unison.detune.value = patch.unisonDetuneCents;
      const unisonGain = ctx.createGain();
      unisonGain.gain.value = patch.unisonGain;
      unison.connect(unisonGain).connect(filter);
      sources.push(unison);
      nodes.push(unison, unisonGain);
    }

    filter.connect(gain);
    this._ownVoice(gain, sources, nodes, evt.pan);
    osc.start(t);
    osc.stop(stopAt);
    if (unison) { unison.start(t); unison.stop(stopAt); }
  }

  _drum(evt) {
    const t = this.ae.ctx.currentTime;
    if (evt.pitch === 35 || evt.pitch === 36) this._kick(t, evt.vel, evt.pan);
    else if (evt.pitch === 38 || evt.pitch === 40) this._noiseBurst(t, evt.vel, 1200, 0.12, evt.pan);
    else this._noiseBurst(t, evt.vel * 0.7, 6000, 0.05, evt.pan);
  }

  _kick(t, vel, pan) {
    const ctx = this.ae.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const gain = ctx.createGain();
    osc.frequency.setValueAtTime(140, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.09);
    gain.gain.setValueAtTime(0.9 * vel, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    osc.connect(gain);
    this._ownVoice(gain, [osc], [osc, gain], pan);
    osc.start(t);
    osc.stop(t + 0.25);
  }

  _getNoiseBuffer(dur) {
    const ctx = this.ae.ctx;
    const bufSize = Math.max(1, Math.floor(ctx.sampleRate * dur));
    let buffer = this._noiseBuffers.get(bufSize);
    if (!buffer) {
      buffer = ctx.createBuffer(1, bufSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
      this._noiseBuffers.set(bufSize, buffer);
    }
    return buffer;
  }

  _noiseBurst(t, vel, hpFreq, dur, pan) {
    const ctx = this.ae.ctx;
    const buffer = this._getNoiseBuffer(dur);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = hpFreq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.5 * vel, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(hp).connect(gain);
    this._ownVoice(gain, [src], [src, hp, gain], pan);
    src.start(t);
    src.stop(t + dur + 0.01);
  }
}

