// Dispatches the conductor track's LIVE cues (ConductorTrack.js) as the
// song plays -- the half of the cue sheet that isn't folded into the section
// plan at load time.
//
// Deliberately shaped like Conductor.dispatchUpTo rather than like a
// director: a forward-only cursor, never skips, never fires twice, and holds
// no opinion of its own. Every cue is an authored instruction, so unlike the
// engine's own directors there is no probability roll and no cooldown here --
// if the player wrote a crash, the crash happens. The one thing it does own
// is the seek contract: scrubbing backward has to rewind the cursor, or
// every cue behind the playhead would be silently swallowed for the rest of
// the run.
import { CueKind } from '../core/ConductorTrack.js';

export class CueDirector {
  /** @param {{tMs:number, kind:string, value:*, bucket:number}[]} cues
   *   live cues only, sorted by tMs (MidiAdapter guarantees both). */
  constructor(cues = []) {
    this.cues = cues || [];
    this.cursor = 0;
    /** One-shot per step, cleared by clearFrameFlags like every other
     *  one-shot in the sim. Read by Simulation to drive the engine. */
    this.fired = [];
  }

  clearFrameFlags() {
    this.fired.length = 0;
  }

  /** Collect every cue due at or before nowMs into `fired`. */
  update(nowMs) {
    while (this.cursor < this.cues.length && this.cues[this.cursor].tMs <= nowMs) {
      this.fired.push(this.cues[this.cursor++]);
    }
  }

  /** Mountain-seekbar scrub: re-place the cursor at the first cue still
   *  ahead of tMs. Forward seeks skip the cues jumped over (they belong to
   *  a moment that didn't happen); backward seeks make them live again. */
  seekTo(tMs) {
    this.cursor = 0;
    while (this.cursor < this.cues.length && this.cues[this.cursor].tMs <= tMs) this.cursor++;
    this.fired.length = 0;
  }

  /** How many cues of a given kind the sheet holds (debug overlay). */
  countOf(kind) {
    let n = 0;
    for (const c of this.cues) if (c.kind === kind) n++;
    return n;
  }

  get total() { return this.cues.length; }
  get remaining() { return this.cues.length - this.cursor; }
}

export { CueKind };
