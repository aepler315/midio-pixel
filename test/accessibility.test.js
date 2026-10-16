import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getReducedFlash, setReducedFlash, getReducedMotion, capFlashAlpha, FLASH_CAP, flashCompositeOp,
  getBtLatencyTrimMs, setBtLatencyTrimMs, BT_LATENCY_TRIM_MS,
} from '../src/ui/Accessibility.js';

test('getReducedFlash defaults to false when no persisted value exists (or storage is unavailable)', () => {
  // Node has no localStorage global; getReducedFlash must degrade to false
  // rather than throwing.
  assert.equal(getReducedFlash(), false);
});

test('setReducedFlash does not throw even with no persistent storage available', () => {
  assert.doesNotThrow(() => setReducedFlash(true));
  assert.doesNotThrow(() => setReducedFlash(false));
});

test('capFlashAlpha passes alpha through untouched when reducedFlash is off', () => {
  assert.equal(capFlashAlpha(0.9, false), 0.9);
  assert.equal(capFlashAlpha(1, false), 1);
  assert.equal(capFlashAlpha(0.1, false), 0.1);
});

test('capFlashAlpha caps at FLASH_CAP (0.4) when reducedFlash is on', () => {
  assert.equal(capFlashAlpha(0.9, true), FLASH_CAP);
  assert.equal(capFlashAlpha(1, true), FLASH_CAP);
  assert.equal(capFlashAlpha(0.7, true), FLASH_CAP);
});

test('capFlashAlpha never raises a value that was already below the cap', () => {
  assert.equal(capFlashAlpha(0.1, true), 0.1);
  assert.equal(capFlashAlpha(0.39, true), 0.39);
  assert.equal(capFlashAlpha(0, true), 0);
});

test('capFlashAlpha at exactly FLASH_CAP is a no-op either way', () => {
  assert.equal(capFlashAlpha(FLASH_CAP, true), FLASH_CAP);
  assert.equal(capFlashAlpha(FLASH_CAP, false), FLASH_CAP);
});

// --- flashCompositeOp -------------------------------------------------
//
// Per-layer capFlashAlpha alone doesn't stop several capped-at-0.4 layers
// from summing to a blown-out white under additive ('lighter') blending --
// exactly the stacked-flash pattern a landing throws (ImpactFX ignition +
// RippleFX rings/pulses/puffs + RainbowBrush dabs all overlapping the same
// ground point). flashCompositeOp falls those effects back to normal
// ('source-over') compositing under reduced-flash so capped layers occlude
// instead of stacking.

test('flashCompositeOp is additive (lighter) when reducedFlash is off', () => {
  assert.equal(flashCompositeOp(false), 'lighter');
});

test('flashCompositeOp falls back to source-over when reducedFlash is on', () => {
  assert.equal(flashCompositeOp(true), 'source-over');
});

// --- prefers-reduced-motion fallback --------------------------------------
//
// A player who has never touched the reduced-flash toggle used to silently
// default to "off" no matter what their OS accessibility setting said.
// getReducedFlash now falls back to prefers-reduced-motion -- but only
// before any explicit choice has been persisted; an explicit off must still
// win over the OS setting.

function withFakeStorageAndMedia(storedValue, prefersReduced, fn) {
  const store = new Map();
  if (storedValue !== null) store.set('smw:reducedFlash', storedValue);
  const prevLocalStorage = globalThis.localStorage;
  const prevWindow = globalThis.window;
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, v),
  };
  globalThis.window = { matchMedia: () => ({ matches: prefersReduced }) };
  try {
    fn();
  } finally {
    globalThis.localStorage = prevLocalStorage;
    globalThis.window = prevWindow;
  }
}

test('with no persisted choice, getReducedFlash follows prefers-reduced-motion', () => {
  withFakeStorageAndMedia(null, true, () => assert.equal(getReducedFlash(), true));
  withFakeStorageAndMedia(null, false, () => assert.equal(getReducedFlash(), false));
});

test('an explicit persisted choice always overrides prefers-reduced-motion', () => {
  withFakeStorageAndMedia('0', true, () => assert.equal(getReducedFlash(), false));
  withFakeStorageAndMedia('1', false, () => assert.equal(getReducedFlash(), true));
});

// A1: storage that is missing or throws must not override the OS default.
// Before the fix a throwing getItem returned false for reduced flash even
// when the system asked for reduced motion.
function withEnv({ storage, media }, fn) {
  const prevLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const prevWindow = globalThis.window;
  if (storage === 'missing') delete globalThis.localStorage;
  else Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { if (storage === 'throws') throw new Error('SecurityError'); return storage; } });
  globalThis.window = media === 'missing' ? {} : media === 'throws' ? { matchMedia: () => { throw new Error('no media'); } } : { matchMedia: () => ({ matches: media }) };
  try { fn(); } finally {
    if (prevLocalStorage) Object.defineProperty(globalThis, 'localStorage', prevLocalStorage); else delete globalThis.localStorage;
    globalThis.window = prevWindow;
  }
}
const throwingStore = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
const store = (entries) => { const m = new Map(Object.entries(entries)); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v) }; };

for (const [label, storage] of [['missing', 'missing'], ['throwing accessor', 'throws'], ['throwing getItem', throwingStore]]) {
  test(`${label} storage falls back to the OS preference for both flash and motion`, () => {
    withEnv({ storage, media: true }, () => {
      assert.equal(getReducedFlash(), true);
      assert.equal(getReducedMotion(), true);
      assert.doesNotThrow(() => setReducedFlash(false));
    });
    withEnv({ storage, media: false }, () => {
      assert.equal(getReducedFlash(), false);
      assert.equal(getReducedMotion(), false);
    });
  });
}

test('unavailable or throwing matchMedia defaults both preferences to off', () => {
  for (const media of ['missing', 'throws']) {
    withEnv({ storage: store({}), media }, () => {
      assert.equal(getReducedFlash(), false);
      assert.equal(getReducedMotion(), false);
    });
  }
});

test('explicit stored on/off wins over the OS for each preference independently', () => {
  withEnv({ storage: store({ 'smw:reducedFlash': '0', 'smw:reducedMotion': '1' }), media: true }, () => {
    assert.equal(getReducedFlash(), false);
    assert.equal(getReducedMotion(), true);
  });
  withEnv({ storage: store({ 'smw:reducedFlash': '1', 'smw:reducedMotion': '0' }), media: false }, () => {
    assert.equal(getReducedFlash(), true);
    assert.equal(getReducedMotion(), false);
  });
  withEnv({ storage: store({ 'smw:reducedFlash': '1' }), media: false }, () => {
    assert.equal(getReducedMotion(), false, 'a stored flash choice says nothing about motion');
  });
});

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
