// Continuous microphone samples, batched to the main thread.
//
// Loaded by URL through AudioContext.audioWorklet.addModule, so this file
// runs in AudioWorkletGlobalScope -- a separate thread with no DOM, no
// window, and none of the app's modules. It cannot import from the rest of
// src/, which is why it is this small and this self-contained.
//
// Why a worklet at all, when an AnalyserNode is already attached: the
// analyser gives the CURRENT buffer whenever you happen to ask, and there is
// no way to know how much new audio arrived between two asks. Concatenating
// successive reads duplicates and drops samples in unknown amounts, which is
// fine for a level meter and fatal for a fingerprint. `process` is called for
// every block exactly once, in order, so this is the only path that yields a
// gapless signal.
//
// Batched to 4096 samples per message rather than posting each 128-sample
// block: at 48kHz that is 375 messages a second, and the postMessage overhead
// would dwarf the work.
const BATCH = 4096;

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(BATCH);
    this._n = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    // No input connected yet, or a silent block the browser elides. Staying
    // alive matters: returning false would permanently remove the node.
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this._buf[this._n++] = channel[i];
      if (this._n === BATCH) {
        // A copy, because the buffer is reused immediately: transferring the
        // backing store would leave this side with a detached array.
        this.port.postMessage(this._buf.slice());
        this._n = 0;
      }
    }
    return true;
  }
}

registerProcessor('midio-capture', CaptureProcessor);
