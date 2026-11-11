// Synchronous waits inside one animation-frame callback.
//
// A few calls block the main thread until the GPU process has finished work
// already submitted: `getImageData` on a GPU-backed canvas (the crest line's
// grid reads), a probe collection that round-trips the command stream, and
// `gl.getError()` in the Cinematic presenter. The frame loop measures the
// whole callback as "work", so those waits reach the perf governor as CPU
// cost. The frame-cost plan (docs/superpowers/plans/2026-11-10-frame-cost.md,
// Phase 0) times each one at its own call site and sums them per frame; a
// later phase subtracts the sum from the work signal.
//
// Each site adds only the time of its own blocking call. Enclosing timers
// that already contain one of these calls (RangeCrest's `cutMs` wraps the
// presenter's draw, and with it `getError`) are never added here, so every
// wait is counted once.
//
// The ledger allocates nothing per frame: fixed numeric fields, one per kind.

export const SYNC_WAIT_KINDS = Object.freeze([
  'crestRead',        // RangeCrest.prepareGrid: getImageData of the working grid rows
  'crestEdgesRead',   // RangeCrest._prepareEdges: getImageData for edge colours
  'probeCollect',     // CrestProbe.collect: asynchronous readback poll (getBufferSubData)
  'probeSyncRead',    // CrestProbe.read: synchronous readPixels (live fallback, or export's intentional sync read)
  'presenterGetError', // CinematicPixelRenderer.draw: gl.getError()
]);

export class SyncWaitLedger {
  constructor() {
    this.crestRead = 0;
    this.crestEdgesRead = 0;
    this.probeCollect = 0;
    this.probeSyncRead = 0;
    this.presenterGetError = 0;
    this.calls = 0;
    this.frames = 0;
  }

  /** Start a new callback's tally. The frame loop calls this once per rAF callback. */
  beginFrame() {
    this.crestRead = 0;
    this.crestEdgesRead = 0;
    this.probeCollect = 0;
    this.probeSyncRead = 0;
    this.presenterGetError = 0;
    this.calls = 0;
    this.frames++;
  }

  /** Add one blocking call's duration. Unknown kinds and non-finite or negative values are ignored. */
  add(kind, ms) {
    if (typeof ms !== 'number' || !(ms >= 0) || ms === Infinity) return;
    switch (kind) {
      case 'crestRead': this.crestRead += ms; break;
      case 'crestEdgesRead': this.crestEdgesRead += ms; break;
      case 'probeCollect': this.probeCollect += ms; break;
      case 'probeSyncRead': this.probeSyncRead += ms; break;
      case 'presenterGetError': this.presenterGetError += ms; break;
      default: return;
    }
    this.calls++;
  }

  /** This callback's total synchronous wait so far, in milliseconds. */
  get totalMs() {
    return this.crestRead + this.crestEdgesRead + this.probeCollect + this.probeSyncRead + this.presenterGetError;
  }

  /** On-demand copy of the current tally (allocates; not for the frame path). */
  snapshot() {
    return {
      totalMs: this.totalMs, calls: this.calls,
      crestRead: this.crestRead, crestEdgesRead: this.crestEdgesRead,
      probeCollect: this.probeCollect, probeSyncRead: this.probeSyncRead,
      presenterGetError: this.presenterGetError,
    };
  }
}

/** The page's one ledger. Sites import it; the frame loop resets and reads it. */
export const syncWaits = new SyncWaitLedger();
