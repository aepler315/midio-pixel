// The detection that turns "the upload button just opens the keyboard"
// into an honest UI.
//
// There is no API that reports whether a file chooser will appear, so it is
// detected by consequence: click, wait, and see whether anything that only
// a real chooser does actually happened. The subtle case is the one these
// tests exist for -- a slow chooser and a missing chooser both produce
// silence, and the only thing separating them is whether our own input is
// still the focused element when the grace period ends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  probeFileChooser, FileChooserSupport, isAndroidWebView,
  CHOOSER_OPENED, CHOOSER_ABSENT,
} from '../src/ui/FileChooserProbe.js';

/** A minimal EventTarget-ish stand-in, so no DOM is needed. */
function fakeNode() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    emit(type, event = {}) {
      for (const fn of [...(listeners.get(type) || [])]) fn(event);
    },
    /** Every listener the probe attached has been taken back off again. */
    get listenerCount() {
      let n = 0;
      for (const set of listeners.values()) n += set.size;
      return n;
    },
  };
}

/**
 * A probe harness with a clock the test drives by hand.
 * `focusedAfterClick` decides what the world looks like when the grace
 * period expires: the input itself (no chooser took focus) or something
 * else (a chooser did).
 */
function harness({ focusedAfterClick = 'input', visibilityState = 'visible' } = {}) {
  const input = fakeNode();
  const win = fakeNode();
  const doc = fakeNode();
  const other = {};
  let clicks = 0;
  let blurs = 0;
  const timers = [];

  input.click = () => { clicks++; };
  input.blur = () => { blurs++; };
  doc.visibilityState = visibilityState;
  Object.defineProperty(doc, 'activeElement', {
    get: () => (focusedAfterClick === 'input' ? input : other),
  });

  const deps = {
    doc,
    win,
    graceMs: 1200,
    setTimer: (fn) => { timers.push(fn); return timers.length - 1; },
    clearTimer: (handle) => { if (handle != null) timers[handle] = null; },
  };

  return {
    input,
    win,
    doc,
    deps,
    get clicks() { return clicks; },
    get blurs() { return blurs; },
    /** Fire the grace-period timeout, if it hasn't been cleared. */
    elapse() { for (const fn of timers) if (fn) fn(); },
  };
}

test('the input is clicked, once, when a probe starts', async () => {
  const h = harness();
  const verdict = probeFileChooser(h.input, h.deps);
  assert.equal(h.clicks, 1);
  h.input.emit('change');
  assert.equal(await verdict, CHOOSER_OPENED);
});

test('a change event proves a chooser opened', async () => {
  const h = harness();
  const verdict = probeFileChooser(h.input, h.deps);
  h.input.emit('change');
  assert.equal(await verdict, CHOOSER_OPENED);
});

test('a cancel event also proves a chooser opened -- dismissing one needs one', async () => {
  const h = harness();
  const verdict = probeFileChooser(h.input, h.deps);
  h.input.emit('cancel');
  assert.equal(await verdict, CHOOSER_OPENED);
});

test('losing window focus proves a chooser opened', async () => {
  // A chooser is a separate activity or window, so the page goes background.
  const h = harness();
  const verdict = probeFileChooser(h.input, h.deps);
  h.win.emit('blur');
  assert.equal(await verdict, CHOOSER_OPENED);
});

test('the page being hidden proves a chooser opened', async () => {
  const h = harness();
  const verdict = probeFileChooser(h.input, h.deps);
  h.doc.visibilityState = 'hidden';
  h.doc.emit('visibilitychange');
  assert.equal(await verdict, CHOOSER_OPENED);
});

test('a visibilitychange back to visible is not a verdict on its own', async () => {
  const h = harness({ focusedAfterClick: 'input' });
  const verdict = probeFileChooser(h.input, h.deps);
  h.doc.visibilityState = 'visible';
  h.doc.emit('visibilitychange');
  // Still undecided, so the grace period is what settles it.
  h.elapse();
  assert.equal(await verdict, CHOOSER_ABSENT);
});

test('silence with our input still focused means there is no chooser', async () => {
  // This is the Fermata case exactly: the click went nowhere, so the input
  // kept focus -- which is also why Android raised the keyboard for it.
  const h = harness({ focusedAfterClick: 'input' });
  const verdict = probeFileChooser(h.input, h.deps);
  h.elapse();
  assert.equal(await verdict, CHOOSER_ABSENT);
});

test('silence with focus gone is a slow chooser, not a missing one', async () => {
  // A player can stare at a real chooser for much longer than the grace
  // period. Without this clause, every unhurried person would be told their
  // browser has no chooser.
  const h = harness({ focusedAfterClick: 'other' });
  const verdict = probeFileChooser(h.input, h.deps);
  h.elapse();
  assert.equal(await verdict, CHOOSER_OPENED);
});

test('a click that throws is an absent chooser, not an unhandled rejection', async () => {
  const h = harness();
  h.input.click = () => { throw new Error('nope'); };
  assert.equal(await probeFileChooser(h.input, h.deps), CHOOSER_ABSENT);
});

test('every listener is removed once a verdict is reached', async () => {
  const h = harness();
  const verdict = probeFileChooser(h.input, h.deps);
  h.input.emit('change');
  await verdict;
  assert.equal(h.input.listenerCount, 0);
  assert.equal(h.win.listenerCount, 0);
  assert.equal(h.doc.listenerCount, 0);
});

test('a late second event cannot change a settled verdict', async () => {
  const h = harness({ focusedAfterClick: 'input' });
  const verdict = probeFileChooser(h.input, h.deps);
  h.elapse();
  assert.equal(await verdict, CHOOSER_ABSENT);
  h.input.emit('change'); // must not throw or re-resolve
  assert.equal(await verdict, CHOOSER_ABSENT);
});

// --- the WebView hint ----------------------------------------------------

test('the WebView marker is read from the platform section only', () => {
  const webview = 'Mozilla/5.0 (Linux; Android 13; K; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36';
  assert.equal(isAndroidWebView(webview), true);

  // Chrome on Android is not a WebView, and must not be described as one.
  const chrome = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  assert.equal(isAndroidWebView(chrome), false);

  // A desktop UA with "wv" somewhere in a product token is not a WebView.
  assert.equal(isAndroidWebView('Mozilla/5.0 (X11; Linux x86_64) wv/1.0'), false);
  assert.equal(isAndroidWebView(''), false);
  assert.equal(isAndroidWebView(undefined), false);
});

// --- the remembered verdict ---------------------------------------------

function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    get size() { return map.size; },
  };
}

test('a chooserless browser is not clicked again after the first probe', async () => {
  const h = harness({ focusedAfterClick: 'input' });
  const storage = fakeStorage();
  const support = new FileChooserSupport({ storage, userAgent: '', probeDeps: h.deps });

  let absentCalls = 0;
  const first = support.open(h.input, () => { absentCalls++; });
  h.elapse();
  assert.equal(await first, CHOOSER_ABSENT);
  assert.equal(h.clicks, 1);
  assert.equal(absentCalls, 1);
  // The dead click left the keyboard up; blurring is what lowers it.
  assert.equal(h.blurs, 1);

  // Clicking is what summons the phantom keyboard, so the second tap must
  // not click at all -- it goes straight to the alternative.
  assert.equal(await support.open(h.input, () => { absentCalls++; }), CHOOSER_ABSENT);
  assert.equal(h.clicks, 1, 'no second click');
  assert.equal(absentCalls, 2);
});

test('a working browser is clicked directly on later taps, with no wait', async () => {
  const h = harness();
  const support = new FileChooserSupport({ storage: fakeStorage(), userAgent: '', probeDeps: h.deps });
  const first = support.open(h.input);
  h.input.emit('change');
  assert.equal(await first, CHOOSER_OPENED);
  assert.equal(await support.open(h.input), CHOOSER_OPENED);
  assert.equal(h.clicks, 2);
});

test('the verdict survives a reload, so the wait is paid once per browser', async () => {
  const storage = fakeStorage();
  const h = harness({ focusedAfterClick: 'input' });
  const first = new FileChooserSupport({ storage, userAgent: '', probeDeps: h.deps });
  const verdict = first.open(h.input);
  h.elapse();
  await verdict;

  const reloaded = new FileChooserSupport({ storage, userAgent: '', probeDeps: h.deps });
  assert.equal(reloaded.isAbsent, true);
  // Which lets the page show the alternative before anything is tapped.
  assert.equal(h.clicks, 1);
});

test('disabled storage does not break the probe, it only forgets', async () => {
  const throwing = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); },
  };
  const h = harness({ focusedAfterClick: 'input' });
  const support = new FileChooserSupport({ storage: throwing, userAgent: '', probeDeps: h.deps });
  const verdict = support.open(h.input);
  h.elapse();
  assert.equal(await verdict, CHOOSER_ABSENT);
  assert.equal(support.isAbsent, true);
});

test('a double tap starts one probe, not two', async () => {
  const h = harness({ focusedAfterClick: 'input' });
  const support = new FileChooserSupport({ storage: fakeStorage(), userAgent: '', probeDeps: h.deps });
  const a = support.open(h.input);
  const b = support.open(h.input);
  h.elapse();
  assert.equal(await a, CHOOSER_ABSENT);
  assert.equal(await b, CHOOSER_ABSENT);
  assert.equal(h.clicks, 1);
});

test('a missing input is reported absent rather than throwing', async () => {
  const support = new FileChooserSupport({ storage: fakeStorage(), userAgent: '' });
  assert.equal(await support.open(null), CHOOSER_ABSENT);
});

test('reset() forgets the verdict so the next tap probes again', async () => {
  const storage = fakeStorage();
  const h = harness({ focusedAfterClick: 'input' });
  const support = new FileChooserSupport({ storage, userAgent: '', probeDeps: h.deps });
  const verdict = support.open(h.input);
  h.elapse();
  await verdict;
  assert.equal(support.isAbsent, true);
  support.reset();
  assert.equal(support.isAbsent, false);
  assert.equal(storage.size, 0);
});

test('a localStorage property that throws on ACCESS does not take the app down', () => {
  // Where site data is blocked, reading `window.localStorage` itself throws
  // a SecurityError -- before any try/catch inside the accessors runs. main.js
  // constructs this class during module init, so an unguarded read there
  // aborts the whole page instead of merely forgetting a verdict.
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('SecurityError: access denied'); },
  });
  try {
    let support;
    assert.doesNotThrow(() => { support = new FileChooserSupport({ userAgent: '' }); });
    assert.equal(support.isAbsent, false);
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had);
    else delete globalThis.localStorage;
  }
});

// --- the negative verdict must not be permanent --------------------------

test('an aged-out absent verdict is discarded, so a fixed browser works again', () => {
  // The upstream fix this PR documents would otherwise strand every user who
  // had already recorded `absent`: no in-page reset, no reason to suspect
  // site data, permanently unable to use a chooser that now exists.
  const day = 24 * 60 * 60 * 1000;
  const storage = fakeStorage({ 'smw:fileChooser': `absent:${1000 * day}` });

  const fresh = new FileChooserSupport({
    storage, userAgent: '', now: () => 1000 * day + (29 * day),
  });
  assert.equal(fresh.isAbsent, true, '29 days old: still trusted');

  const stale = new FileChooserSupport({
    storage, userAgent: '', now: () => 1000 * day + (31 * day),
  });
  assert.equal(stale.isAbsent, false, '31 days old: must re-probe');
});

test('a positive verdict never expires', () => {
  const day = 24 * 60 * 60 * 1000;
  const storage = fakeStorage({ 'smw:fileChooser': `opened:${1000 * day}` });
  const support = new FileChooserSupport({
    storage, userAgent: '', now: () => 1000 * day + (365 * day),
  });
  // A browser with a chooser does not lose one, and a re-probe would be a
  // pointless 1200ms wait on every fresh load.
  assert.equal(support.verdict, CHOOSER_OPENED);
});

test('a verdict written by an older version, with no timestamp, is not trusted', () => {
  // Earlier builds stored a bare "absent". Its age is unknowable, so it is
  // treated as expired rather than honoured forever.
  const storage = fakeStorage({ 'smw:fileChooser': 'absent' });
  assert.equal(new FileChooserSupport({ storage, userAgent: '' }).isAbsent, false);
  // A bare "opened" is harmless to honour: it only skips a probe.
  const opened = fakeStorage({ 'smw:fileChooser': 'opened' });
  assert.equal(new FileChooserSupport({ storage: opened, userAgent: '' }).verdict, CHOOSER_OPENED);
});

test('a stored verdict carries a timestamp so it can be aged', async () => {
  const storage = fakeStorage();
  const h = harness({ focusedAfterClick: 'input' });
  const support = new FileChooserSupport({
    storage, userAgent: '', probeDeps: h.deps, now: () => 12345,
  });
  const verdict = support.open(h.input);
  h.elapse();
  await verdict;
  assert.equal(storage.getItem('smw:fileChooser'), 'absent:12345');
});
