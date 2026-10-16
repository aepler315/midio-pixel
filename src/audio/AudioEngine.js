// Owns the AudioContext — the master clock for the entire game (spec §0.2
// rule 2, §6.1). Every subsystem's "now" derives from ctx.currentTime.
// Because we query ctx.currentTime fresh every rAF frame rather than caching
// a performance.now()-based mirror, there is no drift to IIR-correct here.
import { outputLatencyMs } from '../core/ChoreoClock.js';
import { throwIfAborted } from './loadLimits.js';

export class AudioEngine {
  constructor() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('This browser does not support Web Audio.');
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.85;
    // Every audible source in the game -- the decoded buffer in playBuffer,
    // every synth voice (Sf2Synth, SimpleSynth, SoundfontLibrary) -- connects
    // into `master` before reaching the speakers, which makes it the one
    // choke point where ALL of the game's audio can be delayed uniformly
    // without threading a delay through each synth's own per-note
    // scheduling. Sits between master and destination rather than being
    // folded into master itself so setAudioDelayMs can change it live
    // (a GainNode has no equivalent "when" parameter to delay through).
    this._delay = this.ctx.createDelay(1); // 1s max -- well past MAX_BT_LATENCY_TRIM_MS
    this.master.connect(this._delay);
    this._delay.connect(this.ctx.destination);

    this._startCtxTime = null; // ctx.currentTime corresponding to song-time 0
    this._pausedAtMs = 0;
    this.playing = false;
    this.sourceNode = null;
  }

  /** @returns {Promise<boolean>} whether the context is actually running
   *  afterward -- previously unchecked, so a resume() that silently failed
   *  (or a context stuck 'suspended' for any reason) left the game
   *  rendering its first frame forever with no message, since ctx.currentTime
   *  never advances. Callers can check this and surface a real error. */
  async resume() {
    if (this.ctx.state === 'suspended') {
      try {
        await this.ctx.resume();
      } catch (err) {
        console.warn('[AudioEngine] resume() failed', err);
      }
    }
    return this.ctx.state === 'running';
  }

  start(offsetMs = 0) {
    this._startCtxTime = this.ctx.currentTime - offsetMs / 1000;
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this._pausedAtMs = this.nowMs;
    this.playing = false;
    if (this.sourceNode) {
      try { this.sourceNode.stop(); } catch { /* already stopped */ }
      this.sourceNode = null;
    }
  }

  /** Forget the decoded buffer from a previous raw-audio song. Without this,
   *  loading a MIDI/demo after playing raw audio leaves _audioBuffer set to
   *  the OLD song -- seekToMs (the mountain seekbar) would then start a
   *  BufferSource playing that stale audio on top of the new synth-driven
   *  song. MIDI/demo playback never calls playBuffer to set a fresh one, so
   *  nothing else would ever clear it. */
  clearBuffer() {
    this._audioBuffer = null;
  }

  get nowMs() {
    if (!this.playing || this._startCtxTime === null) return this._pausedAtMs;
    return (this.ctx.currentTime - this._startCtxTime) * 1000;
  }

  /**
   * Shift the clock by a small amount without restarting it.
   *
   * For syncing a show to music playing somewhere this page cannot read (see
   * SongMatcher.SyncTracker): the periodic re-match says the song is a little
   * ahead of or behind the clock, and the error is walked off a fraction of a
   * frame at a time. Expressed as a shift of the origin rather than a seek
   * because nothing should be re-dispatched -- the playhead is not moving to
   * a new place, it is correcting where it already is.
   */
  nudgeMs(deltaMs) {
    if (!deltaMs || this._startCtxTime === null) return;
    this._startCtxTime -= deltaMs / 1000;
  }

  /** How far the HEARD signal lags the clock above (see ChoreoClock.js):
   *  base (buffer) latency plus the device/output path. Decorative
   *  beat-anchored visuals subtract this so their peaks line up with the
   *  sound as heard rather than as scheduled. */
  get outputLatencyMs() {
    return outputLatencyMs(this.ctx);
  }

  /**
   * Delay ALL audio output by `ms` (0 = off), independent of the sim/visual
   * clock (`nowMs` above is untouched). For the manual Bluetooth trim's
   * negative case: a player who needs visuals to run AHEAD of the sound
   * cannot have a frame render before its own real time -- so instead the
   * sound itself is held back by that many ms via `_delay`, which reads as
   * the same relative correction. A ramp (not a hard jump) avoids an
   * audible click if this is ever changed mid-playback.
   */
  setAudioDelayMs(ms) {
    const sec = Math.max(0, Number(ms) || 0) / 1000;
    try {
      this._delay.delayTime.cancelScheduledValues(this.ctx.currentTime);
      this._delay.delayTime.linearRampToValueAtTime(sec, this.ctx.currentTime + 0.05);
    } catch {
      this._delay.delayTime.value = sec;
    }
  }

  async decodeFile(arrayBuffer, { signal = null } = {}) {
    throwIfAborted(signal);
    const decoded = await this.ctx.decodeAudioData(arrayBuffer);
    throwIfAborted(signal);
    return decoded;
  }

  /** Plays a decoded AudioBuffer and adopts it as the master clock's zero point. */
  playBuffer(audioBuffer, offsetSec = 0) {
    this._audioBuffer = audioBuffer;
    if (this.sourceNode) {
      try { this.sourceNode.stop(); } catch { /* already stopped */ }
      this.sourceNode = null;
    }
    const src = this.ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(this.master);
    this.sourceNode = src;
    src.start(0, offsetSec);
    this.start(offsetSec * 1000);
    // Restore level if a previous finale faded us out.
    try {
      this.master.gain.cancelScheduledValues(this.ctx.currentTime);
      this.master.gain.setValueAtTime(0.85, this.ctx.currentTime);
    } catch { /* ignore */ }
    return src;
  }

  /**
   * Seek the master clock (and buffer source, if any) to song time `ms`.
   * MIDI/SF2 paths only move the clock; buffer audio restarts the source.
   */
  seekToMs(ms) {
    const t = Math.max(0, ms);
    const wasPlaying = this.playing;
    if (this._audioBuffer) {
      if (this.sourceNode) {
        try { this.sourceNode.stop(); } catch { /* ignore */ }
        this.sourceNode = null;
      }
      if (wasPlaying) {
        const src = this.ctx.createBufferSource();
        src.buffer = this._audioBuffer;
        src.connect(this.master);
        this.sourceNode = src;
        const offsetSec = Math.min(t / 1000, Math.max(0, this._audioBuffer.duration - 0.01));
        src.start(0, offsetSec);
      }
    }
    this._startCtxTime = this.ctx.currentTime - t / 1000;
    this._pausedAtMs = t;
    this.playing = wasPlaying;
    this.restoreLevel(0.85);
  }

  /**
   * Fade master to silence over `durationSec` (song finale / shatter).
   * Clock keeps running — only the audible level drops.
   */
  fadeToSilence(durationSec = 0.35) {
    const g = this.master.gain;
    const now = this.ctx.currentTime;
    const dur = Math.max(0.05, durationSec);
    try {
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0.0001, now + dur);
    } catch {
      g.value = 0;
    }
  }

  /**
   * A brief ducked dip then recovery -- the sound half of an authored cut
   * (drop / apotheosis): the mix visibly flinches on the hit frame instead
   * of just riding the continuous mix. Clock and playback are untouched.
   */
  duck(strength = 0.85, holdSec = 0.06, recoverSec = 0.25) {
    const g = this.master.gain;
    const now = this.ctx.currentTime;
    const level = g.value;
    try {
      g.cancelScheduledValues(now);
      g.setValueAtTime(level * (1 - strength), now);
      g.setValueAtTime(level * (1 - strength), now + holdSec);
      g.linearRampToValueAtTime(level, now + holdSec + recoverSec);
    } catch {
      g.value = level;
    }
  }

  /** Instant restore of master level (new song / replay). */
  restoreLevel(level = 0.85) {
    const g = this.master.gain;
    const now = this.ctx.currentTime;
    try {
      g.cancelScheduledValues(now);
      g.setValueAtTime(level, now);
    } catch {
      g.value = level;
    }
  }
}
