import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getLyricsDisabled, setLyricsDisabled, getStoredGroove,
  getBtLatencyTrimMs, setBtLatencyTrimMs, BT_LATENCY_TRIM_MS,
} from '../src/ui/Accessibility.js';

// --- Storage guards ---------------------------------------------------------
//
// Every preference reads and writes through a try/catch, so storage that is
// missing, or whose accessor or methods throw (a locked-down or private-mode
// browser), leaves the default in place instead of throwing into the caller.

function withStorage(storage, fn) {
  const prevLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  if (storage === 'missing') delete globalThis.localStorage;
  else Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { if (storage === 'throws') throw new Error('SecurityError'); return storage; } });
  try { fn(); } finally {
    if (prevLocalStorage) Object.defineProperty(globalThis, 'localStorage', prevLocalStorage); else delete globalThis.localStorage;
  }
}
const throwingStore = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };

for (const [label, storage] of [['missing', 'missing'], ['throwing accessor', 'throws'], ['throwing getItem/setItem', throwingStore]]) {
  test(`${label} storage leaves every preference at its default without throwing`, () => {
    withStorage(storage, () => {
      assert.equal(getLyricsDisabled(), false);
      assert.doesNotThrow(() => setLyricsDisabled(true));
      assert.equal(getStoredGroove(), null);
      assert.equal(getBtLatencyTrimMs(), 0);
      assert.equal(setBtLatencyTrimMs(75), 75, 'the clamped value still comes back');
    });
  });
}

// --- Bluetooth latency trim -------------------------------------------------

function withFakeStorage(initial, fn) {
  const store = new Map(Object.entries(initial));
  const prevLocalStorage = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  };
  try {
    fn(store);
  } finally {
    globalThis.localStorage = prevLocalStorage;
  }
}

test('getBtLatencyTrimMs defaults to 0 (off) with no persisted value, or no storage at all', () => {
  assert.equal(getBtLatencyTrimMs(), 0); // Node has no localStorage global
  withFakeStorage({}, () => assert.equal(getBtLatencyTrimMs(), 0));
});

test('setBtLatencyTrimMs does not throw with no persistent storage, and clamps its return value', () => {
  assert.doesNotThrow(() => setBtLatencyTrimMs(75));
  assert.equal(setBtLatencyTrimMs(-10), -10, 'negative input is kept -- it delays audio instead of visuals');
  assert.equal(setBtLatencyTrimMs(9999), 500, 'absurd positive input clamps to the sanity rail');
  assert.equal(setBtLatencyTrimMs(-9999), -500, 'absurd negative input clamps to the sanity rail too');
  assert.equal(setBtLatencyTrimMs(12.6), 13, 'rounds to a whole ms');
  assert.equal(setBtLatencyTrimMs(-12.6), -13, 'rounds a negative value to a whole ms too');
});

test('a set value round-trips through getBtLatencyTrimMs', () => {
  withFakeStorage({}, () => {
    setBtLatencyTrimMs(75);
    assert.equal(getBtLatencyTrimMs(), 75);
  });
});

test('a stored value is clamped on read too, not just on write (a hand-edited or stale value)', () => {
  withFakeStorage({ 'smw:btLatencyTrimMs': '-5' }, () => assert.equal(getBtLatencyTrimMs(), -5));
  withFakeStorage({ 'smw:btLatencyTrimMs': '9999' }, () => assert.equal(getBtLatencyTrimMs(), 500));
  withFakeStorage({ 'smw:btLatencyTrimMs': '-9999' }, () => assert.equal(getBtLatencyTrimMs(), -500));
  withFakeStorage({ 'smw:btLatencyTrimMs': 'not-a-number' }, () => assert.equal(getBtLatencyTrimMs(), 0));
});

test('migrates the old on/off flag: an existing "on" player gets BT_LATENCY_TRIM_MS once, not silently 0', () => {
  withFakeStorage({ 'smw:btLatencyTrim': '1' }, () => assert.equal(getBtLatencyTrimMs(), BT_LATENCY_TRIM_MS));
  withFakeStorage({ 'smw:btLatencyTrim': '0' }, () => assert.equal(getBtLatencyTrimMs(), 0));
});

test('the new numeric key always wins over the legacy flag once it exists', () => {
  withFakeStorage({ 'smw:btLatencyTrim': '1', 'smw:btLatencyTrimMs': '0' }, () => assert.equal(getBtLatencyTrimMs(), 0));
  withFakeStorage({ 'smw:btLatencyTrim': '0', 'smw:btLatencyTrimMs': '75' }, () => assert.equal(getBtLatencyTrimMs(), 75));
});
