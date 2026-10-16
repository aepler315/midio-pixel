// Finding out whether the file chooser actually exists, and stopping the
// page from lying about it.
//
// THE SYMPTOM. In Fermata's built-in browser, tapping "Browse files" opens
// the Android soft keyboard instead of a file chooser. Nothing is being
// typed and no chooser ever appears.
//
// THE CAUSE. A WebView has no chooser of its own; it asks the host app via
// `WebChromeClient.onShowFileChooser()`. An app that does not override that
// method gets no chooser, and the click leaves the (visually hidden) input
// as the focused element -- so Android raises the IME for it. The keyboard
// is not the bug, it is the residue of a click that went nowhere.
//
// WHY THIS CANNOT BE FEATURE-DETECTED. There is no API that reports whether
// a chooser will appear. `HTMLInputElement` exists, `type="file"` is
// supported, `.click()` resolves without throwing, and no event fires on
// failure -- from script, a WebView with no chooser is indistinguishable
// from a player who opened a chooser and is still looking through it.
//
// So it is detected by consequence instead. Opening a real chooser is a
// separate activity or window: the page loses focus, or is hidden, or gets
// a `change`/`cancel` event when the player is done. A WebView with no
// chooser produces none of those -- it just quietly focuses the input. So:
// click, then wait. If nothing observable happened within the grace period
// AND the file input is still the focused element, no chooser opened.
//
// That last clause carries the weight. A slow chooser and a missing chooser
// both produce silence; only the missing one leaves *our* input focused,
// because a real chooser takes focus away from the document entirely.
//
// The verdict is remembered, so a player pays the wait once per browser and
// every later tap goes straight to the alternatives.
const VERDICT_KEY = 'smw:fileChooser';
const GRACE_MS = 1200;

// How long a remembered "this browser has no chooser" is trusted.
//
// An absent verdict must not be permanent. The whole point of
// docs/fermata-upstream-issue.md is that Fermata may implement
// `onShowFileChooser` -- and on the day it does, anyone carrying a cached
// `absent` would be locked out of the now-working chooser forever, with no
// in-page way back and no reason to suspect site data was the cause. So the
// negative verdict expires and the probe runs again. One 1200ms wait a
// month is a small price for not stranding people on a fixed bug.
//
// A positive verdict never expires: a browser that has a chooser does not
// lose one, and if it somehow did the next probe would catch it anyway.
const ABSENT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export const CHOOSER_OPENED = 'opened';
export const CHOOSER_ABSENT = 'absent';

/**
 * A WebView, as opposed to a real browser, on Android. Chrome stamps `wv`
 * into the platform section of a WebView's user agent and nowhere else.
 *
 * This is a hint used only for wording -- plenty of WebViews DO implement a
 * chooser, so it must never disable the button on its own. The runtime
 * probe is what decides; this just lets the explanation say "the app you
 * are browsing in" rather than "your browser".
 */
export function isAndroidWebView(userAgent) {
  const ua = String(userAgent || '');
  return /\bAndroid\b/.test(ua) && /\(\s*[^)]*;\s*wv\s*[;)]/.test(ua);
}

/** Reading `window.localStorage` can itself throw a SecurityError where
 *  site data is blocked -- before any try/catch inside the accessor
 *  functions gets a chance. main.js constructs FileChooserSupport during
 *  module initialisation, so an unguarded access there takes the whole app
 *  down instead of merely forgetting a verdict. */
function defaultStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Reads the remembered verdict, discarding an `absent` that has aged out.
 *
 * Values are stored as `<verdict>:<epoch ms>`. A bare verdict with no
 * timestamp is what earlier versions wrote; it is treated as expired if it
 * says `absent`, so upgrading re-probes once rather than honouring a
 * verdict of unknown age.
 */
function readStoredVerdict(storage, now = Date.now()) {
  let raw;
  try {
    raw = storage?.getItem(VERDICT_KEY);
  } catch {
    return null; // private mode / disabled storage: probe again, don't crash
  }
  if (!raw) return null;
  const [verdict, stamp] = String(raw).split(':');
  if (verdict !== CHOOSER_OPENED && verdict !== CHOOSER_ABSENT) return null;
  if (verdict === CHOOSER_OPENED) return verdict;
  const written = Number(stamp);
  if (!Number.isFinite(written) || written <= 0) return null; // unknown age
  if (now - written >= ABSENT_TTL_MS) return null; // aged out: probe again
  return verdict;
}

function writeStoredVerdict(storage, verdict, now = Date.now()) {
  try {
    storage?.setItem(VERDICT_KEY, `${verdict}:${now}`);
  } catch { /* nothing to do; the verdict just won't be remembered */ }
}

/**
 * Watches one `.click()` on a file input and reports whether a chooser
 * opened. Everything the probe touches is injected so the logic is
 * testable without a browser.
 *
 * @param {HTMLInputElement} input
 * @param {object} [deps]
 * @param {Document} [deps.doc]
 * @param {Window} [deps.win]
 * @param {(fn: Function, ms: number) => any} [deps.setTimer]
 * @param {(handle: any) => void} [deps.clearTimer]
 * @param {number} [deps.graceMs]
 * @returns {Promise<'opened'|'absent'>}
 */
export function probeFileChooser(input, deps = {}) {
  const doc = deps.doc || globalThis.document;
  const win = deps.win || globalThis;
  const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer || ((handle) => clearTimeout(handle));
  const graceMs = Number.isFinite(deps.graceMs) ? deps.graceMs : GRACE_MS;

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    const cleanup = () => {
      clearTimer(timer);
      input.removeEventListener('change', onInteracted);
      input.removeEventListener('cancel', onInteracted);
      win.removeEventListener?.('blur', onInteracted);
      doc?.removeEventListener?.('visibilitychange', onHidden);
    };

    const settle = (verdict) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(verdict);
    };

    // Any of these means something outside the page took over, which only a
    // real chooser does. `cancel` counts too: dismissing a chooser proves
    // there was one.
    function onInteracted() { settle(CHOOSER_OPENED); }
    function onHidden() { if (doc?.visibilityState === 'hidden') settle(CHOOSER_OPENED); }

    input.addEventListener('change', onInteracted, { once: true });
    input.addEventListener('cancel', onInteracted, { once: true });
    win.addEventListener?.('blur', onInteracted, { once: true });
    doc?.addEventListener?.('visibilitychange', onHidden);

    timer = setTimer(() => {
      // Silence alone is not a verdict -- a player can stare at a real
      // chooser for a minute. The tell is that the input is STILL focused
      // here: a chooser would have taken focus out of the document.
      settle(doc?.activeElement === input ? CHOOSER_ABSENT : CHOOSER_OPENED);
    }, graceMs);

    try {
      input.click();
    } catch {
      settle(CHOOSER_ABSENT);
    }
  });
}

/**
 * The picker as the rest of the app should use it: try to open a chooser,
 * and if this browser has none, say so instead of leaving a keyboard up.
 *
 * `onAbsent` is called on every attempt once the verdict is known, so the
 * UI can show its fallback immediately rather than re-probing each tap.
 */
export class FileChooserSupport {
  /**
   * @param {object} [options]
   * @param {Storage} [options.storage]
   * @param {string}  [options.userAgent]
   * @param {object}  [options.probeDeps]  forwarded to probeFileChooser
   */
  constructor({ storage = undefined, userAgent = undefined, probeDeps = {}, now = undefined } = {}) {
    this.storage = storage === undefined ? defaultStorage() : storage;
    this.userAgent = userAgent === undefined ? globalThis.navigator?.userAgent : userAgent;
    this.probeDeps = probeDeps;
    this.now = now || (() => Date.now());
    this.verdict = readStoredVerdict(this.storage, this.now());
    this.pending = null;
  }

  /** True once we know this browser cannot open a chooser. */
  get isAbsent() { return this.verdict === CHOOSER_ABSENT; }

  /** Wording help only -- never a reason to skip the probe. */
  get looksLikeWebView() { return isAndroidWebView(this.userAgent); }

  /**
   * Opens the chooser if there is one. Returns the verdict so a caller can
   * react without waiting on `onAbsent`.
   *
   * @param {HTMLInputElement} input
   * @param {() => void} [onAbsent] run when this browser has no chooser
   */
  async open(input, onAbsent = null) {
    if (!input) return CHOOSER_ABSENT;

    // Already known to be chooserless: don't click at all. Clicking is what
    // summons the phantom keyboard, so the fix for "the button opens the
    // keyboard" is, precisely, to stop pressing a button that does nothing.
    if (this.verdict === CHOOSER_ABSENT) {
      onAbsent?.();
      return CHOOSER_ABSENT;
    }

    if (this.verdict === CHOOSER_OPENED) {
      input.click();
      return CHOOSER_OPENED;
    }

    // First tap on an unknown browser. One probe at a time -- a double tap
    // must not start two.
    if (!this.pending) {
      this.pending = probeFileChooser(input, this.probeDeps).finally(() => {
        this.pending = null;
      });
    }
    const verdict = await this.pending;
    this.verdict = verdict;
    writeStoredVerdict(this.storage, verdict, this.now());
    if (verdict === CHOOSER_ABSENT) {
      // Dismiss the keyboard the dead click raised. Blurring the focused
      // element is what lowers the Android IME; there is no direct API.
      try { input.blur(); } catch { /* not focusable any more; fine */ }
      onAbsent?.();
    }
    return verdict;
  }

  /** Test/support hook: forget the remembered verdict and probe again. */
  reset() {
    this.verdict = null;
    try { this.storage?.removeItem(VERDICT_KEY); } catch { /* not stored anyway */ }
  }
}
