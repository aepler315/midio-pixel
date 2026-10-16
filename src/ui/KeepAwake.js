// Car mode: keeping a head-unit display awake during a song.
//
// The problem this solves (an Auto Pro X / Android Auto dongle projecting
// this page onto a car receiver): with no touch input the display blanks
// after a minute, and the tap that brings it back also lands on the page --
// on a button, or on Chrome's own fullscreen furniture -- so the show drops
// out of fullscreen just to be woken up.
//
// What this module does NOT do, because no web page can: synthesize a tap.
// A JS-dispatched PointerEvent is untrusted; it never leaves the browser's
// event loop, so it cannot reach the Android input stack or the receiver's
// own idle timer. Anything a page fakes is invisible to the thing counting
// the idle seconds. The two levers that do exist are both used here:
//
//   1. Screen Wake Lock (navigator.wakeLock) -- the sanctioned way to tell
//      the OS "do not blank the display". Supported by Chrome on Android,
//      which is what these dongles run. Held while a song is playing and
//      re-armed on a heartbeat, because the lock is dropped for us whenever
//      the page is backgrounded, the tab is hidden, or the system takes it.
//   2. A hidden looping video as a fallback for the (older) WebViews with no
//      wakeLock at all, where playing video is the only thing that still
//      counts as "in use". Best effort, and silent when it isn't honored.
//
// The residual case -- the display blanked anyway and the player taps to
// bring it back -- is handled by the caller (main.js), which spends that
// first tap entirely on restoring fullscreen rather than letting it reach
// the UI. Same "tap to unlock" beat the HUD auto-fade already uses.

/** Re-assert cadence. Matches the ask ("every 30 seconds") -- but it is a
 *  wake-lock refresh, not a fake tap: invisible, silent, no UI effect. */
export const HEARTBEAT_MS = 30000;

/** A render-loop gap this long means the page stopped being drawn at all:
 *  a blanked display, or the browser backgrounded. Nothing else produces it
 *  during playback -- even a bad frame is two orders of magnitude shorter --
 *  and requiring it is what keeps an ordinary long wait (a 40-second
 *  analysis with nobody touching the screen) from being mistaken for one. */
export const SLEEP_STALL_MS = 10000;

/** A gap this long with no input means the display plausibly blanked, so
 *  the next tap is a wake-up tap and belongs to the screen, not the page.
 *  Comfortably under the ~60s timeout being worked around, and far longer
 *  than any gap between deliberate taps. */
export const WAKE_TAP_IDLE_MS = 20000;

/** Fullscreen exits within this long of real input were asked for (the
 *  fullscreen button, Escape, a browser gesture). Anything later came from
 *  the system -- a display blank, a projection re-attach -- and is the kind
 *  worth restoring. */
export const FULLSCREEN_DROP_GRACE_MS = 2000;

/** True when a render-loop gap is long enough to mean the page was not being
 *  drawn -- the display slept, or the browser backgrounded it. */
export function isDisplaySleepGap(rafDeltaMs, stallMs = SLEEP_STALL_MS) {
  return rafDeltaMs >= stallMs;
}

/** True when the next tap should be spent on waking the display back up
 *  instead of reaching the page. Both halves are required, and deliberately
 *  so: `slept` (the page stopped being drawn, or was hidden) is the evidence
 *  that there was a display to wake, and the idle gap is the evidence that
 *  this tap is the one that woke it. Either alone has false positives that
 *  cost the player a real tap -- a page that was backgrounded an hour ago,
 *  or a long unattended wait on a screen that never blanked.
 *  `lastInputMs` of null (no input yet at all) is never a wake tap. */
export function shouldAbsorbTap(lastInputMs, nowMs, slept, idleMs = WAKE_TAP_IDLE_MS) {
  if (!slept) return false;
  if (lastInputMs == null) return false;
  return (nowMs - lastInputMs) >= idleMs;
}

/** True when a fullscreen exit looks like the system dropped it rather than
 *  the player asking for it -- the only kind worth silently restoring. */
export function isSystemFullscreenDrop(lastInputMs, nowMs, graceMs = FULLSCREEN_DROP_GRACE_MS) {
  if (lastInputMs == null) return true;
  return (nowMs - lastInputMs) > graceMs;
}

/** Holds a screen wake lock for as long as it is enabled, re-acquiring it
 *  whenever the platform takes it away. Every platform call is optional and
 *  guarded: on a browser with no wakeLock, no video, or no canvas capture,
 *  this degrades to doing nothing rather than throwing. */
export class KeepAwake {
  /**
   * @param {object} [deps] injected for tests; defaults to the real globals.
   * @param {Navigator} [deps.nav]
   * @param {Document} [deps.doc]
   * @param {number} [deps.heartbeatMs]
   * @param {(msg: string, err?: unknown) => void} [deps.onWarn]
   */
  constructor({
    nav = globalThis.navigator,
    doc = globalThis.document,
    heartbeatMs = HEARTBEAT_MS,
    onWarn = () => {},
  } = {}) {
    this.nav = nav;
    this.doc = doc;
    this.heartbeatMs = heartbeatMs;
    this.onWarn = onWarn;
    this.enabled = false;
    /** Live wake lock sentinel, or null when we hold nothing. */
    this.sentinel = null;
    /** One in-flight request at a time -- the heartbeat must not stack them. */
    this.requesting = false;
    this.usingFallback = false;
    this.fallbackVideo = null;
    this.nextHeartbeatMs = 0;
    this.onVisibility = () => { if (this.enabled) this.refresh(); };
    this.doc?.addEventListener?.('visibilitychange', this.onVisibility);
  }

  get supported() {
    return typeof this.nav?.wakeLock?.request === 'function';
  }

  /** Held right now (either lever). Exposed for the debug overlay and tests. */
  get held() {
    return !!this.sentinel || this.usingFallback;
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.nextHeartbeatMs = 0;
    this.refresh();
  }

  disable() {
    if (!this.enabled) return;
    this.enabled = false;
    this.stopFallback();
    const sentinel = this.sentinel;
    this.sentinel = null;
    try { sentinel?.release?.(); } catch (err) { this.onWarn('release failed', err); }
  }

  /** Drop every listener and lock. Call when tearing the page down. */
  dispose() {
    this.disable();
    this.doc?.removeEventListener?.('visibilitychange', this.onVisibility);
  }

  /** Drive from the render loop. Re-asserts on the heartbeat; a no-op on
   *  every other frame, so it is safe to call at 60fps. */
  tick(nowMs) {
    if (!this.enabled) return;
    if (nowMs < this.nextHeartbeatMs) return;
    this.nextHeartbeatMs = nowMs + this.heartbeatMs;
    this.refresh();
  }

  /** Real user input arrived -- nothing to do for the lock itself, but the
   *  moment is worth a refresh in case the wake-up also dropped the lock. */
  noteInput() {
    if (this.enabled) this.refresh();
  }

  /** Acquire the lock if we are missing it. Cheap and idempotent. */
  refresh() {
    if (!this.enabled) return;
    // Hidden pages cannot hold a screen wake lock at all (the request is
    // rejected by spec), so wait for the visibilitychange instead of burning
    // a guaranteed failure on every heartbeat.
    if (this.doc?.visibilityState === 'hidden') return;
    if (this.sentinel && this.sentinel.released !== true) return;
    this.sentinel = null;
    if (!this.supported) { this.startFallback(); return; }
    if (this.requesting) return;
    this.requesting = true;
    Promise.resolve()
      .then(() => this.nav.wakeLock.request('screen'))
      .then((sentinel) => {
        this.requesting = false;
        if (!this.enabled) { try { sentinel.release?.(); } catch { /* already gone */ } return; }
        this.sentinel = sentinel;
        // The platform releases the lock on its own whenever the page is
        // backgrounded or the system decides otherwise; the next heartbeat
        // picks it back up, and this just makes that immediate.
        sentinel.addEventListener?.('release', () => {
          if (this.sentinel === sentinel) this.sentinel = null;
        });
        this.stopFallback();
      })
      .catch((err) => {
        this.requesting = false;
        this.onWarn('wake lock request failed', err);
        this.startFallback();
      });
  }

  /** Last resort for WebViews with no wakeLock: a 2px, near-transparent,
   *  muted, looping video fed by a canvas capture stream (no asset to ship).
   *  Some Android WebViews keep the display on while video plays; where that
   *  heuristic does not apply this costs a captured frame per second and
   *  changes nothing else. */
  startFallback() {
    if (this.usingFallback || !this.doc?.createElement) return;
    try {
      const canvas = this.doc.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      const ctx = canvas.getContext?.('2d');
      if (!ctx || typeof canvas.captureStream !== 'function') return;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 2, 2);
      const video = this.doc.createElement('video');
      video.muted = true;
      video.defaultMuted = true;
      video.loop = true;
      video.playsInline = true;
      video.setAttribute?.('playsinline', '');
      // Rendered, but at 2px and 1% opacity in a corner: present enough for
      // the "video is playing" heuristic, invisible on a car screen.
      video.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;opacity:0.01;pointer-events:none;';
      video.srcObject = canvas.captureStream(1);
      this.doc.body?.appendChild?.(video);
      const played = video.play?.();
      played?.catch?.((err) => this.onWarn('fallback video blocked', err));
      this.fallbackVideo = video;
      this.usingFallback = true;
    } catch (err) {
      this.onWarn('fallback video unavailable', err);
    }
  }

  stopFallback() {
    if (!this.usingFallback) return;
    const video = this.fallbackVideo;
    this.fallbackVideo = null;
    this.usingFallback = false;
    try {
      video?.pause?.();
      video?.srcObject?.getTracks?.().forEach((t) => t.stop?.());
      video?.remove?.();
    } catch (err) {
      this.onWarn('fallback teardown failed', err);
    }
  }
}
