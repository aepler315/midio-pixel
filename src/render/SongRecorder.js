// Recording a performance to a file, live, in the page.
//
// Two streams, one clock. The video track is a canvas this class composites
// every rendered frame into; the audio track is tapped off the audio
// engine's master bus. MediaRecorder timestamps both from the same source,
// which is the entire reason a recording stays in sync when a mirrored or
// projected screen does not: there, the audio and the picture reach the
// player by different paths with independent latency, and a show
// choreographed to the beat drifts off it.
//
// ## Why composite instead of capturing the stage directly
//
// `stage.captureStream()` would be less code and is wrong here. The stage's
// backing store is not a fixed size: the resolution selector offers 320x180
// through 4K, and the Auto setting lets the perf governor CHANGE it mid-song
// under frame pressure. A video track whose dimensions change halfway
// through is not something an encoder or a player handles gracefully.
// Compositing into a canvas of the export's own size makes the recording
// independent of all of that, and gives the letterboxing somewhere to
// happen for targets that are not 16:9.
//
// ## Why frames are pushed rather than sampled
//
// `captureStream(fps)` lets the browser sample the canvas on its own clock,
// which duplicates frames when it samples faster than the app draws and
// drops them when it samples slower. `captureStream(0)` plus an explicit
// `requestFrame()` after each composite yields exactly one encoded frame per
// rendered frame. Where `requestFrame` is missing, it falls back to timed
// sampling rather than refusing to record.
import {
  STAGE_W, STAGE_H, fitLetterbox, needsLetterbox, pickMimeType,
  videoBitsPerSecond, AUDIO_BITS_PER_SECOND, sniffVideoCodec, presetById,
} from './VideoExport.js';

import { fitPixelRect } from './PixelPresentation.js';

const FALLBACK_SAMPLE_FPS = 60;
/** Chunk cadence. Frequent enough that a crash loses a second rather than a
 *  song, rare enough not to fragment a long recording into thousands of
 *  blobs. */
const TIMESLICE_MS = 1000;
/** Keep long exports bounded even when a browser retains every recorder chunk in memory. */
export const MAX_RECORDING_BYTES = 512 * 1024 * 1024;

export class SongRecorder {
  /**
   * @param {object} opts
   * @param {HTMLCanvasElement} opts.stage  the canvas the show is drawn on
   * @param {AudioContext} opts.audioContext
   * @param {AudioNode} opts.audioSource  the bus to record (the master gain)
   * @param {object} [opts.scope]  window, injected for testing
   */
  constructor({ stage, audioContext = null, audioSource = null, onAutoStop = null, scope = (typeof window !== 'undefined' ? window : null) } = {}) {
    this.stage = stage;
    this.audioContext = audioContext;
    this.audioSource = audioSource;
    this.scope = scope;
    this.onAutoStop = onAutoStop;

    this.recording = false;
    // MediaRecorder.stop() finalises its container asynchronously.  Keep
    // start() locked until that work (including codec sniffing) is complete,
    // otherwise a late onstop callback could tear down the next session.
    this.finalizing = false;
    this.startedMs = 0;
    this.bytes = 0;
    this.error = null;

    this._recorder = null;
    this._chunks = [];
    this._canvas = null;
    this._ctx = null;
    this._videoTrack = null;
    this._audioDest = null;
    this._preset = null;
    this._candidate = null;
    this._stopPromise = null;
    this._resolveStop = null;
  }

  /** Can this browser record at all? */
  get supported() {
    const MR = this.scope?.MediaRecorder;
    return !!MR && !!pickMimeType((type) => MR.isTypeSupported(type));
  }

  /** What container/codec this browser will give us, for the UI to state
   *  before anyone commits four minutes to a recording. */
  get candidate() {
    const MR = this.scope?.MediaRecorder;
    return MR ? pickMimeType((type) => MR.isTypeSupported(type)) : null;
  }

  get elapsedMs() {
    return this.recording ? (this.scope?.performance?.now?.() ?? Date.now()) - this.startedMs : 0;
  }

  /**
   * Begin recording. Resolves true once the recorder is running.
   *
   * Never throws: a browser that cannot record, a canvas that will not
   * capture, an audio graph that refuses the tap -- all come back as false
   * with `this.error` set, because a failed export must not take the song
   * down with it.
   */
  start({ presetId, deferFirstFrame = false } = {}) {
    if (this.recording || this.finalizing) return false;
    this.error = null;
    const MR = this.scope?.MediaRecorder;
    if (!MR || !this.stage) { this.error = 'This browser cannot record video.'; return false; }

    const candidate = this.candidate;
    if (!candidate) { this.error = 'This browser cannot record video.'; return false; }

    const preset = presetById(presetId);
    try {
      this._setupCanvas(preset);
      const stream = this._buildStream(preset);
      if (!stream) return false;

      this._recorder = new MR(stream, {
        mimeType: candidate.mimeType,
        videoBitsPerSecond: videoBitsPerSecond(preset.width, preset.height),
        audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
      });
      this._chunks = [];
      this.bytes = 0;
      this._recorder.ondataavailable = (e) => {
        if (!e.data?.size) return;
        if (this.bytes + e.data.size > MAX_RECORDING_BYTES) {
          this.error = 'Recording reached the 512 MB export limit.';
          if (this._recorder?.state !== 'inactive') this.onAutoStop?.(this.error);
          return;
        }
        this._chunks.push(e.data);
        this.bytes += e.data.size;
      };
      this._recorder.onerror = (e) => {
        this.error = e?.error?.message || 'Recording failed.';
        this.onAutoStop?.(this.error);
      };
      this._recorder.onstop = () => this._finish();
      this._recorder.start(TIMESLICE_MS);
    } catch (err) {
      this.error = err?.message || String(err);
      this._teardown();
      return false;
    }

    this._preset = preset;
    this._candidate = candidate;
    this.recording = true;
    this.startedMs = this.scope?.performance?.now?.() ?? Date.now();
    this._stopPromise = new Promise((resolve) => { this._resolveStop = resolve; });
    // One frame right away, so a recording stopped immediately still holds a
    // picture rather than an empty track.
    if (!deferFirstFrame) this.captureFrame();
    return true;
  }

  _setupCanvas(preset) {
    const canvas = this.scope.document.createElement('canvas');
    canvas.width = preset.width;
    canvas.height = preset.height;
    this._canvas = canvas;
    this._ctx = canvas.getContext('2d', { alpha: false });
    this._lastCaptureFit = null;
    this._fit = fitLetterbox(STAGE_W, STAGE_H, preset.width, preset.height);
    this._bars = needsLetterbox(STAGE_W, STAGE_H, preset.width, preset.height);
    if (this._bars && this._ctx) {
      // Paint the bars once. Nothing draws over them afterwards, so they
      // never need clearing again -- and clearing the whole frame every
      // frame would be a full-canvas fill this export does not need.
      this._ctx.fillStyle = '#000';
      this._ctx.fillRect(0, 0, preset.width, preset.height);
    }
  }

  _buildStream(preset) {
    const stream = this._canvas.captureStream(0);
    this._videoTrack = stream.getVideoTracks()[0] || null;
    if (!this._videoTrack) {
      this.error = 'This browser will not capture the canvas.';
      this._teardown();
      return null;
    }
    if (typeof this._videoTrack.requestFrame !== 'function') {
      // No manual frame pushing here; let the browser sample instead.
      this._videoTrack.stop();
      const sampled = this._canvas.captureStream(FALLBACK_SAMPLE_FPS);
      this._videoTrack = sampled.getVideoTracks()[0] || null;
      if (!this._videoTrack) { this.error = 'This browser will not capture the canvas.'; this._teardown(); return null; }
      this._pushesFrames = false;
      return this._withAudio(sampled);
    }
    this._pushesFrames = true;
    void preset;
    return this._withAudio(stream);
  }

  /** Tap the master bus into the recording.
   *
   *  A missing or failing audio graph yields a silent video rather than no
   *  video: the picture is most of what an export is for, and a person who
   *  gets a silent file can see that and try again. */
  _withAudio(stream) {
    if (!this.audioContext || !this.audioSource) return stream;
    try {
      this._audioDest = this.audioContext.createMediaStreamDestination();
      this.audioSource.connect(this._audioDest);
      for (const track of this._audioDest.stream.getAudioTracks()) stream.addTrack(track);
    } catch (err) {
      console.warn('[export] recording without audio', err);
      this._audioDest = null;
    }
    return stream;
  }

  /**
   * Composite one rendered frame. Called from the render loop, after the
   * stage has been drawn and before anything reads it back.
   *
   * Cheap by construction: one `drawImage` into a canvas of the export's
   * size. At the car preset that is a downscale into 800x480.
   */
  captureFrame(source = {}) {
    if (source == null) return;
    const { canvas = this.stage, pixelated = false, scaling = 'fit' } = source;
    if (!this.recording || !this._ctx || !canvas) return;
    const fit = pixelated ? fitPixelRect(canvas.width, canvas.height, this._canvas.width, this._canvas.height, scaling) : this._fit;
    if (JSON.stringify(fit) !== this._lastCaptureFit) {
      if (scaling === 'integer' || this._lastCaptureFit) {
        this._ctx.fillStyle = '#000000';
        this._ctx.fillRect(0, 0, this._canvas.width, this._canvas.height);
      }
      this._lastCaptureFit = JSON.stringify(fit);
    }
    try {
      const sourceCanvas = canvas;
      this._ctx.imageSmoothingEnabled = !pixelated;
      this._ctx.drawImage(sourceCanvas, fit.x, fit.y, fit.width, fit.height);
      if (this._pushesFrames) this._videoTrack.requestFrame();
    } catch {
      // A canvas in a bad state for one frame is not worth ending a
      // recording over; the next frame usually works.
    }
  }

  /** Stop and resolve to `{blob, url, fileName-ready parts}` — or null if
   *  nothing was captured. */
  stop() {
    if (this.finalizing) return this._stopPromise;
    if (!this.recording) return null;
    this.recording = false;
    this.finalizing = true;
    const pending = this._stopPromise;
    try {
      this._recorder.stop();
    } catch {
      this._finish();
    }
    return pending;
  }

  async _finish() {
    const durationMs = (this.scope?.performance?.now?.() ?? Date.now()) - this.startedMs;
    const candidate = this._candidate;
    const chunks = this._chunks;
    const preset = this._preset;
    const resolveStop = this._resolveStop;
    this._teardown();
    if (!chunks.length) {
      this._completeFinalization(resolveStop, null);
      return;
    }

    const blob = new Blob(chunks, { type: candidate?.mimeType || 'video/mp4' });
    let codec = null;
    try {
      // Only the head of the file is needed: the sample description that
      // names the codec is written near the front when the recorder
      // finalises the container.
      const head = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
      codec = sniffVideoCodec(head);
    } catch { /* labelling is a nicety, never a failure */ }

    this._completeFinalization(resolveStop, {
      blob,
      candidate,
      codec,
      bytes: blob.size,
      durationMs,
      preset,
    });
  }

  _completeFinalization(resolveStop, result) {
    // Unlock only after every await in _finish has completed.  Clearing the
    // session references here also ensures a subsequent recording receives
    // its own promise and resolver.
    this.finalizing = false;
    this._stopPromise = null;
    this._resolveStop = null;
    this._preset = null;
    this._candidate = null;
    resolveStop?.(result);
  }

  _teardown() {
    try { this._videoTrack?.stop(); } catch { /* already stopped */ }
    try { this.audioSource?.disconnect(this._audioDest); } catch { /* never connected */ }
    for (const track of this._audioDest?.stream?.getAudioTracks() || []) {
      try { track.stop(); } catch { /* already stopped */ }
    }
    this._recorder = null;
    this._videoTrack = null;
    this._audioDest = null;
    this._canvas = null;
    this._ctx = null;
    this._chunks = [];
    this.recording = false;
  }

  /** Abandon a recording without producing a file.
   *
   *  The handlers come off BEFORE the recorder is stopped. A real
   *  MediaRecorder flushes what it is holding as a final `dataavailable`
   *  and then fires `onstop`, so leaving them attached would run `_finish`
   *  and hand back a blob -- and since a promise resolves once, that blob
   *  would win the race against the null this is trying to deliver. A
   *  cancelled export would quietly produce a file. */
  cancel() {
    if (!this.recording) return;
    this.recording = false;
    if (this._recorder) {
      this._recorder.ondataavailable = null;
      this._recorder.onstop = null;
      this._recorder.onerror = null;
      try { this._recorder.stop(); } catch { /* already stopped */ }
    }
    const resolveStop = this._resolveStop;
    this._teardown();
    this._stopPromise = null;
    this._resolveStop = null;
    this._preset = null;
    this._candidate = null;
    resolveStop?.(null);
  }
}
