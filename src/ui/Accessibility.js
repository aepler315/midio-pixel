// Persisted player preferences. Every read and write is guarded against
// environments with no localStorage (Node's test runner, most notably) -- a
// ReferenceError there is caught exactly like a disabled/blocked storage API
// in a locked-down browser. Reads fall back to the default, never throwing.
const NO_LYRICS_KEY = 'smw:noLyrics';

// "No lyrics": a persisted opt-out from the LRCLIB lyric fetch/prompt that
// runs for dropped audio files. When on, the whole identity/lyrics step is
// skipped -- for songs that have no lyrics, or when the player just doesn't
// want the search.
export function getLyricsDisabled() {
  try { return localStorage.getItem(NO_LYRICS_KEY) === '1'; } catch { return false; }
}

export function setLyricsDisabled(v) {
  try { localStorage.setItem(NO_LYRICS_KEY, v ? '1' : '0'); } catch { /* no persistent storage available */ }
}

// The groove fingerprint (GrooveFingerprint.js): the one piece of state that
// survives across SONGS, not just across sessions. Everything else in this
// file is a preference the player set; this one the engine learned.
//
// Note the key namespace: `smw:` with a colon, matching every other key here.
const GROOVE_KEY = 'smw:groove';

/** The saved profile blob, or null. Parsing/validation is
 *  GrooveFingerprint.load's job -- it tolerates anything. */
export function getStoredGroove() {
  try { return localStorage.getItem(GROOVE_KEY); } catch { return null; }
}

export function setStoredGroove(profile) {
  try { localStorage.setItem(GROOVE_KEY, JSON.stringify(profile.toJSON())); } catch { /* no persistent storage available */ }
}

export function clearStoredGroove() {
  try { localStorage.removeItem(GROOVE_KEY); } catch { /* no persistent storage available */ }
}

// Manual Bluetooth latency correction. ChoreoClock's outputLatencyMs already
// compensates automatically from AudioContext.baseLatency/outputLatency --
// but most Bluetooth stacks never report a real number there (0, or a wired-
// speaker-sized guess), so every beat-anchored visual leads the sound the
// player actually hears by however much the room's real BT round-trip is
// (commonly 100-200ms). Auto-detection cannot fix what the platform won't
// report; this is the manual trim for exactly that gap. 0 (off) by default --
// wired audio, where the automatic figure is usually close, should not pay
// an unrequested extra delay.
//
// Signed: a positive trim delays the VISUALS (ChoreoClock.visualNow) to
// match audio that is heard later than the platform reports -- the original
// (and by far the more common) case. A negative trim means the opposite
// correction is needed, and visuals cannot be rendered before their own
// real time arrives -- there is no way to "un-delay" a frame that hasn't
// happened yet -- so a negative value instead delays the actual AUDIO
// output by that many ms (AudioEngine's own delay node), which reads to the
// player as exactly the same relative correction.
const BT_LATENCY_KEY = 'smw:btLatencyTrimMs';
// Pre-v2 storage: a flat on/off flag, always +30ms when on. Migrated below
// so an existing "on" player keeps getting a correction after the update
// instead of silently landing back at 0.
const BT_LATENCY_KEY_LEGACY = 'smw:btLatencyTrim';
/** The pre-editable default and the popover's prefill: a deliberately
 *  conservative partial correction -- it will not fully cancel a 150ms BT
 *  stack, but it moves things in the right direction without a setup step.
 *  Someone who needs a precise number now types their own via the BT chip;
 *  someone who needs a *measured* number has the guided tap sync
 *  (LatencyCalibrator.js) for that instead. */
export const BT_LATENCY_TRIM_MS = 30;
const MAX_BT_LATENCY_TRIM_MS = 500; // sanity rail -- matches the input's own max

/** Current trim in ms, clamped to [-MAX_BT_LATENCY_TRIM_MS, MAX_BT_LATENCY_TRIM_MS].
 *  0 = off; positive delays visuals, negative delays audio (see comment above). */
export function getBtLatencyTrimMs() {
  try {
    const stored = localStorage.getItem(BT_LATENCY_KEY);
    if (stored != null) {
      const ms = Number(stored);
      return Number.isFinite(ms) ? Math.max(-MAX_BT_LATENCY_TRIM_MS, Math.min(MAX_BT_LATENCY_TRIM_MS, ms)) : 0;
    }
    // Migrate the old boolean flag once, then let the new key take over.
    if (localStorage.getItem(BT_LATENCY_KEY_LEGACY) === '1') return BT_LATENCY_TRIM_MS;
    return 0;
  } catch { return 0; }
}

export function setBtLatencyTrimMs(ms) {
  const clamped = Math.max(-MAX_BT_LATENCY_TRIM_MS, Math.min(MAX_BT_LATENCY_TRIM_MS, Math.round(Number(ms) || 0)));
  try { localStorage.setItem(BT_LATENCY_KEY, String(clamped)); } catch { /* no persistent storage available */ }
  return clamped;
}
