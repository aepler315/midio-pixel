import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KeepAwake, shouldAbsorbTap, isSystemFullscreenDrop, isDisplaySleepGap,
  WAKE_TAP_IDLE_MS, FULLSCREEN_DROP_GRACE_MS, HEARTBEAT_MS, SLEEP_STALL_MS,
} from '../src/ui/KeepAwake.js';

const flush = () => new Promise((r) => setTimeout(r, 0));

function fakeSentinel() {
  const sentinel = {
    released: false,
    releaseCalls: 0,
    listeners: {},
    addEventListener(type, fn) { sentinel.listeners[type] = fn; },
    release() { sentinel.releaseCalls++; sentinel.released = true; return Promise.resolve(); },
    /** What the platform does on its own when the page is backgrounded. */
    systemRelease() { sentinel.released = true; sentinel.listeners.release?.(); },
  };
  return sentinel;
}

function fakeDoc({ visibilityState = 'visible', withElements = false } = {}) {
  const doc = {
    visibilityState,
    listeners: {},
    appended: [],
    addEventListener(type, fn) { doc.listeners[type] = fn; },
    removeEventListener(type) { delete doc.listeners[type]; },
  };
  if (withElements) {
    doc.body = { appendChild: (el) => doc.appended.push(el) };
    doc.createElement = (tag) => {
      if (tag === 'canvas') {
        return {
          width: 0, height: 0,
          getContext: () => ({ fillRect() {}, set fillStyle(_v) {} }),
          captureStream: () => ({ getTracks: () => [{ stop() {} }] }),
        };
      }
      return {
        style: {}, playCalls: 0, paused: true,
        setAttribute() {}, remove() {}, pause() { this.paused = true; },
        play() { this.playCalls++; this.paused = false; return Promise.resolve(); },
      };
    };
  }
  return doc;
}

function fakeNav(sentinels = []) {
  const nav = {
    requests: 0,
    wakeLock: {
      request(type) {
        nav.requests++;
        nav.lastType = type;
        return Promise.resolve(sentinels[nav.requests - 1] ?? fakeSentinel());
      },
    },
  };
  return nav;
}

test('shouldAbsorbTap treats the first input of a session as a real tap', () => {
  assert.equal(shouldAbsorbTap(null, 999999, true), false);
});

test('shouldAbsorbTap only absorbs after a display-blanking-length idle gap', () => {
  assert.equal(shouldAbsorbTap(1000, 1000 + WAKE_TAP_IDLE_MS - 1, true), false);
  assert.equal(shouldAbsorbTap(1000, 1000 + WAKE_TAP_IDLE_MS, true), true);
  assert.equal(shouldAbsorbTap(1000, 1000 + 60000, true), true);
});

test('shouldAbsorbTap never eats a tap when the display never slept', () => {
  // The long unattended wait that is NOT a display timeout: a 40-second
  // analysis, or a song watched straight through. The next tap is real.
  assert.equal(shouldAbsorbTap(1000, 1000 + 60000, false), false);
  assert.equal(shouldAbsorbTap(1000, 1000 + 3600000, false), false);
});

test('isDisplaySleepGap ignores ordinary frame hitches and catches a stopped loop', () => {
  assert.equal(isDisplaySleepGap(16), false);
  assert.equal(isDisplaySleepGap(250), false);
  assert.equal(isDisplaySleepGap(SLEEP_STALL_MS - 1), false);
  assert.equal(isDisplaySleepGap(SLEEP_STALL_MS), true);
  assert.equal(isDisplaySleepGap(90000), true);
});

test('isSystemFullscreenDrop is false right after real input (the player asked to exit)', () => {
  assert.equal(isSystemFullscreenDrop(1000, 1000), false);
  assert.equal(isSystemFullscreenDrop(1000, 1000 + FULLSCREEN_DROP_GRACE_MS), false);
});

test('isSystemFullscreenDrop is true when nothing was touched (the system took it)', () => {
  assert.equal(isSystemFullscreenDrop(1000, 1000 + FULLSCREEN_DROP_GRACE_MS + 1), true);
  assert.equal(isSystemFullscreenDrop(null, 5000), true);
});

test('enable() acquires a screen wake lock exactly once', async () => {
  const nav = fakeNav();
  const ka = new KeepAwake({ nav, doc: fakeDoc() });
  ka.enable();
  ka.enable();
  await flush();
  assert.equal(nav.requests, 1);
  assert.equal(nav.lastType, 'screen');
  assert.equal(ka.held, true);
});

test('the heartbeat does not stack duplicate locks while one is held', async () => {
  const nav = fakeNav();
  const ka = new KeepAwake({ nav, doc: fakeDoc() });
  ka.enable();
  await flush();
  for (let t = 0; t <= HEARTBEAT_MS * 4; t += HEARTBEAT_MS) ka.tick(t);
  await flush();
  assert.equal(nav.requests, 1);
});

test('a lock the platform released is re-acquired on the next heartbeat', async () => {
  const first = fakeSentinel();
  const nav = fakeNav([first, fakeSentinel()]);
  const ka = new KeepAwake({ nav, doc: fakeDoc() });
  ka.enable();
  await flush();
  first.systemRelease();
  assert.equal(ka.held, false);
  ka.tick(1);
  assert.equal(nav.requests, 1, 'a tick before the heartbeat elapses is a no-op');
  ka.tick(HEARTBEAT_MS + 1);
  await flush();
  assert.equal(nav.requests, 2);
  assert.equal(ka.held, true);
});

test('ticks are ignored once disabled, and the held lock is released', async () => {
  const sentinel = fakeSentinel();
  const nav = fakeNav([sentinel]);
  const ka = new KeepAwake({ nav, doc: fakeDoc() });
  ka.enable();
  await flush();
  ka.disable();
  assert.equal(sentinel.releaseCalls, 1);
  ka.tick(HEARTBEAT_MS * 10);
  await flush();
  assert.equal(nav.requests, 1);
  assert.equal(ka.held, false);
});

test('a hidden page does not burn a guaranteed-to-fail request', async () => {
  const nav = fakeNav();
  const doc = fakeDoc({ visibilityState: 'hidden' });
  const ka = new KeepAwake({ nav, doc });
  ka.enable();
  await flush();
  assert.equal(nav.requests, 0);
  doc.visibilityState = 'visible';
  doc.listeners.visibilitychange();
  await flush();
  assert.equal(nav.requests, 1, 'coming back to the foreground re-arms it');
});

test('a lock arriving after disable() is released rather than retained', async () => {
  const sentinel = fakeSentinel();
  const nav = fakeNav([sentinel]);
  const ka = new KeepAwake({ nav, doc: fakeDoc() });
  ka.enable();
  ka.disable();
  await flush();
  assert.equal(ka.sentinel, null);
  assert.equal(sentinel.releaseCalls, 1);
});

test('no wakeLock API at all falls back to a hidden looping video', async () => {
  const doc = fakeDoc({ withElements: true });
  const ka = new KeepAwake({ nav: {}, doc });
  ka.enable();
  await flush();
  assert.equal(ka.supported, false);
  assert.equal(ka.usingFallback, true);
  assert.equal(doc.appended.length, 1);
  assert.equal(doc.appended[0].playCalls, 1);
  assert.equal(ka.held, true);
  ka.disable();
  assert.equal(ka.usingFallback, false);
  assert.equal(doc.appended[0].paused, true);
});

test('a rejected wake lock request warns and falls back instead of throwing', async () => {
  const warnings = [];
  const nav = { wakeLock: { request: () => Promise.reject(new Error('NotAllowedError')) } };
  const ka = new KeepAwake({ nav, doc: fakeDoc({ withElements: true }), onWarn: (m) => warnings.push(m) });
  ka.enable();
  await flush();
  assert.equal(warnings.length, 1);
  assert.equal(ka.usingFallback, true);
});

test('a browser with neither wakeLock nor usable elements degrades to a no-op', async () => {
  const ka = new KeepAwake({ nav: {}, doc: fakeDoc() });
  assert.doesNotThrow(() => ka.enable());
  await flush();
  assert.equal(ka.held, false);
  assert.doesNotThrow(() => ka.tick(HEARTBEAT_MS + 1));
  assert.doesNotThrow(() => ka.dispose());
});

test('dispose() unhooks the visibility listener', () => {
  const doc = fakeDoc();
  const ka = new KeepAwake({ nav: fakeNav(), doc });
  assert.equal(typeof doc.listeners.visibilitychange, 'function');
  ka.dispose();
  assert.equal(doc.listeners.visibilitychange, undefined);
});
