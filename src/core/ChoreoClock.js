// Anticipatory choreography: the timing discipline that makes character
// moves LAND on the beat instead of flinching after it.
//
// Three legs, used together:
//
//   1. Apex-on-beat anchoring. A reactive system hears an onset and starts
//      moving -- so the visible peak of the move (a hop's apex, a flash's
//      full brightness) arrives rise-time late, every time. A dancer does
//      the opposite: they know the music and begin the move EARLY so its
//      peak lands on the beat. Since the full NoteEvent timeline exists up
//      front (MIDI, or the audio analysis), the characters can know the
//      music too: Conductor.subscribeAhead delivers events lead-time early,
//      and the envelopes here are anchored so their maximum sits exactly at
//      the note's own tMs.
//
//   2. Output-latency compensation. ctx.currentTime says where the DSP
//      clock is, not what the ear is hearing -- the gap (baseLatency +
//      outputLatency) is ~10-30 ms on desktop speakers and can exceed
//      200 ms on Bluetooth, and every beat-anchored visual currently leads
//      the heard beat by that much. Decorative envelopes evaluate at
//      visualNow = songNow - outputLatency so their peaks coincide with
//      the sound as heard. (Physics stays on the song clock: obstacle
//      clearance can't rewind, and its error is not rhythmic.)
//
//   3. Closed-form envelopes. A "set flag to 1, decay per step" envelope
//      quantizes its onset to the 8.33 ms sim tick and bends its shape
//      with frame rate. These are pure functions of (now - anchor),
//      evaluated fresh each evaluation from the audio clock -- zero
//      accumulated state, zero tick error, and the same exact shape at any
//      step rate.
/** The compensation ceiling: latency readings clamp to [0, MAX_LATENCY_MS]
 *  everywhere (outputLatencyMs, visualNow, Simulation's per-step sample) so
 *  a transient outputLatency glitch can never throw the choreography
 *  seconds off. One constant -- raise it HERE to support higher-latency
 *  outputs, nowhere else. */
export const MAX_LATENCY_MS = 350;

/** Display presentation lead, ms.
 *
 *  The third latency in the chain, and the only one nothing used to answer.
 *  Legs 1 and 2 above line a visual's COMPUTED peak up with the heard beat,
 *  but a frame is not seen when it is computed: the canvas is composited and
 *  then scanned out, so the pixels reach the eye one to two refreshes later.
 *  Everything therefore reads slightly late no matter how exactly its
 *  envelope was anchored, and -- unlike draw throttling -- the error does not
 *  change with the frame-rate cap, because the panel refreshes at its own
 *  rate regardless.
 *
 *  So the world is stepped at `now + VISUAL_LEAD_MS`: each frame renders the
 *  moment it will actually be ON SCREEN rather than the moment it was built.
 *  No browser API reports this figure (there is no "time to photons"), so it
 *  is a fixed constant rather than a measurement -- roughly the compositor
 *  path's typical cost on ordinary hardware. Raise or lower it HERE; every
 *  consumer reads through Simulation's visualLeadMs.
 *  (Cross-session single-value bisection (50/45/35/25ms) produced a
 *  non-monotonic trend -- session-to-session noise swamping a small true
 *  difference. A guided in-game A/B run comparing candidates back-to-back
 *  on the same playback instant (LeadABTester, since removed) converged
 *  on 52ms.)
 *
 *  Scoring deliberately does NOT move with it: judging compares a tap's own
 *  timestamp against the chart, both on the true audio clock, so leading the
 *  render cannot make a hit score differently (see Simulation.step). */
export const VISUAL_LEAD_MS = 52;

/** How early ahead-subscriptions deliver character-choreography events.
 *  Must cover the longest anticipation rise plus a couple of sim steps of
 *  dispatch slack; output latency only ever ADDS margin (visualNow lags
 *  the dispatch clock), so it needs no term here. */
export const CHOREO_LEAD_MS = 220;

/**
 * An anticipated hop arc: a parabola spanning [anchor - riseMs, anchor +
 * riseMs] whose apex -- the full `height` -- lands exactly ON the anchor.
 * Returns 0 outside the span. The character leaves the ground before the
 * note sounds and is at the top of the hop the instant it does.
 */
export function apexHopY(nowMs, anchorMs, riseMs, height) {
  const half = Math.max(1, riseMs);
  const u = (nowMs - (anchorMs - half)) / (2 * half);
  if (u <= 0 || u >= 1) return 0;
  return height * 4 * u * (1 - u);
}

/**
 * The audio pipeline's output latency in ms: how far the heard signal lags
 * the AudioContext clock. Defensive about absent/NaN fields (OfflineAudio,
 * older WebKit) and clamped -- a transient outputLatency glitch must never
 * throw the choreography seconds off.
 *
 * @param {object|null} ctx AudioContext-like { baseLatency, outputLatency }
 */
export function outputLatencyMs(ctx) {
  if (!ctx) return 0;
  const base = Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0;
  const out = Number.isFinite(ctx.outputLatency) ? ctx.outputLatency : 0;
  const measured = Math.max(0, (base + out) * 1000);
  return Math.min(MAX_LATENCY_MS, measured);
}

/** Convenience shared by every consumer: the clock the EAR is on. */
export function visualNow(nowMs, latencyMs) {
  const lag = Number.isFinite(latencyMs) ? Math.min(MAX_LATENCY_MS, Math.max(0, latencyMs)) : 0;
  return nowMs - lag;
}
