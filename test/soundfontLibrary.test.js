import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SoundfontLibrary, SynthRouter } from '../src/audio/SoundfontLibrary.js';
import { buildMinimalSf2 } from './helpers/sf2Fixture.js';
import { buildStoredZip } from './helpers/zipFixture.js';

// --- Mock synths for SynthRouter tests ---

function makeMockSynth() {
  return {
    enabled: true,
    sf2: null,
    calls: 0,
    stopAllCalls: 0,
    noteOn(evt) { this.calls++; },
    connectConductor() { return () => {}; },
    loadSf2(data) { this.sf2 = data; },
    stopAll() { this.stopAllCalls++; },
  };
}

// --- SoundfontLibrary ---

test('SoundfontLibrary starts empty', () => {
  const lib = new SoundfontLibrary();
  assert.equal(lib.count, 0);
  assert.equal(lib.active, null);
});

test('addBuffer parses and adds a font, auto-activating it', async () => {
  const lib = new SoundfontLibrary();
  await lib.addBuffer('test.sf2', buildMinimalSf2());
  assert.equal(lib.count, 1);
  assert.ok(lib.active);
  assert.equal(lib.active.name, 'TestFont'); // from INAM
});

test('addBuffer fires onChange when first font is added', async () => {
  const lib = new SoundfontLibrary();
  let called = false;
  lib.onChange = (active) => { called = true; assert.ok(active); };
  await lib.addBuffer('test.sf2', buildMinimalSf2());
  assert.ok(called);
});

test('cycle moves forward through fonts', async () => {
  const lib = new SoundfontLibrary();
  await lib.addBuffer('a.sf2', buildMinimalSf2('AlphaFont'));
  await lib.addBuffer('b.sf2', buildMinimalSf2('BetaFont'));
  assert.equal(lib.active.name, 'AlphaFont'); // first added is active
  lib.cycle(1);
  assert.equal(lib.active.name, 'BetaFont');
  lib.cycle(1);
  assert.equal(lib.active.name, 'AlphaFont'); // wraps around
});

test('cycle moves backward', async () => {
  const lib = new SoundfontLibrary();
  await lib.addBuffer('a.sf2', buildMinimalSf2('AlphaFont'));
  await lib.addBuffer('b.sf2', buildMinimalSf2('BetaFont'));
  lib.cycle(-1);
  assert.equal(lib.active.name, 'BetaFont'); // wraps backward to last
  lib.cycle(-1);
  assert.equal(lib.active.name, 'AlphaFont');
});

test('cycle notifies onChange', async () => {
  const lib = new SoundfontLibrary();
  await lib.addBuffer('a.sf2', buildMinimalSf2('AlphaFont'));
  await lib.addBuffer('b.sf2', buildMinimalSf2('BetaFont'));
  let lastActive = null;
  lib.onChange = (active) => { lastActive = active; };
  lib.cycle(1);
  assert.equal(lastActive.name, 'BetaFont');
});

test('addFiles extracts SF2 from a stored ZIP', async () => {
  const lib = new SoundfontLibrary();
  const sf2Data = new Uint8Array(buildMinimalSf2());
  const zip = buildStoredZip([{ name: 'inner.sf2', data: sf2Data }]);
  // Simulate a File object
  const file = { name: 'pack.zip', arrayBuffer: () => Promise.resolve(zip) };
  await lib.addFiles([file]);
  assert.equal(lib.count, 1);
  assert.equal(lib.active.name, 'TestFont'); // INAM from SF2 overrides filename
});

test('useDirectory scans a mock directory handle', async () => {
  const lib = new SoundfontLibrary();
  const sf2Data = new Uint8Array(buildMinimalSf2());

  // Mock FileSystemDirectoryHandle
  const dirHandle = {
    async *_values() {
      yield {
        kind: 'file',
        name: 'font.sf2',
        getFile: () => ({ arrayBuffer: () => Promise.resolve(sf2Data.buffer) }),
      };
    },
    values() { return this._values(); },
  };

  await lib.useDirectory(dirHandle);
  assert.equal(lib.count, 1);
  assert.equal(lib.active.name, 'TestFont');
});

test('rescanDirectory clears dir-sourced fonts and re-scans', async () => {
  const lib = new SoundfontLibrary();
  const sf2Data = new Uint8Array(buildMinimalSf2());
  const dirHandle = {
    async *_values() {
      yield {
        kind: 'file',
        name: 'font.sf2',
        getFile: () => ({ arrayBuffer: () => Promise.resolve(sf2Data.buffer) }),
      };
    },
    values() { return this._values(); },
  };

  await lib.useDirectory(dirHandle);
  assert.equal(lib.count, 1);
  await lib.rescanDirectory();
  assert.equal(lib.count, 1); // still 1, not 2 (dedup'd)
});

test('autoLoadFromServer loads every font listed in the manifest', async () => {
  const lib = new SoundfontLibrary();
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === '/soundfonts/') {
      return { ok: true, json: async () => ['a.sf2', 'b.sf2'] };
    }
    if (url.endsWith('a.sf2')) {
      return { ok: true, arrayBuffer: async () => buildMinimalSf2('AlphaFont') };
    }
    if (url.endsWith('b.sf2')) {
      return { ok: true, arrayBuffer: async () => buildMinimalSf2('BetaFont') };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const loaded = await lib.autoLoadFromServer('/soundfonts/');
    assert.equal(loaded, 2);
    assert.equal(lib.count, 2);
    assert.equal(lib.active.name, 'AlphaFont'); // first added auto-activates
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('autoLoadFromServer extracts SF2 fonts from a .zip listed in the manifest', async () => {
  const lib = new SoundfontLibrary();
  const sf2Data = new Uint8Array(buildMinimalSf2('ZippedFont'));
  const zip = buildStoredZip([{ name: 'inner.sf2', data: sf2Data }]);
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === '/soundfonts/') return { ok: true, json: async () => ['pack.zip'] };
    if (url.endsWith('pack.zip')) return { ok: true, arrayBuffer: async () => zip };
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const loaded = await lib.autoLoadFromServer('/soundfonts/');
    assert.equal(loaded, 1);
    assert.equal(lib.active.name, 'ZippedFont');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('autoLoadFromServer resolves to 0 (never throws) when the manifest 404s', async () => {
  const lib = new SoundfontLibrary();
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false });
  try {
    const loaded = await lib.autoLoadFromServer('/soundfonts/');
    assert.equal(loaded, 0);
    assert.equal(lib.count, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('autoLoadFromServer resolves to 0 (never throws) on a network error', async () => {
  const lib = new SoundfontLibrary();
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const loaded = await lib.autoLoadFromServer('/soundfonts/');
    assert.equal(loaded, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('autoLoadFromServer resolves to 0 when the manifest is not a JSON array', async () => {
  const lib = new SoundfontLibrary();
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ oops: 'not an array' }) });
  try {
    const loaded = await lib.autoLoadFromServer('/soundfonts/');
    assert.equal(loaded, 0);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('autoLoadFromServer skips an unreadable file but keeps loading the rest', async () => {
  const lib = new SoundfontLibrary();
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (url === '/soundfonts/') return { ok: true, json: async () => ['broken.sf2', 'good.sf2'] };
    if (url.endsWith('broken.sf2')) return { ok: false };
    if (url.endsWith('good.sf2')) return { ok: true, arrayBuffer: async () => buildMinimalSf2('GoodFont') };
    throw new Error(`unexpected fetch: ${url}`);
  };
  try {
    const loaded = await lib.autoLoadFromServer('/soundfonts/');
    assert.equal(loaded, 1);
    assert.equal(lib.count, 1);
    assert.equal(lib.active.name, 'GoodFont');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('hide excludes a font from visibleFonts and cycle, and adds it to hiddenFonts', async () => {
  const lib = new SoundfontLibrary();
  await lib.addBuffer('a.sf2', buildMinimalSf2('AlphaFont'));
  await lib.addBuffer('b.sf2', buildMinimalSf2('BetaFont'));
  lib.hide(0); // hide AlphaFont
  assert.deepEqual(lib.visibleFonts.map((v) => v.font.name), ['BetaFont']);
  assert.deepEqual(lib.hiddenFonts.map((v) => v.font.name), ['AlphaFont']);
  assert.equal(lib.count, 2, 'hiding never removes the font from memory');
});

test('hiding the active font auto-advances to the next visible one', async () => {
  const lib = new SoundfontLibrary();
  await lib.addBuffer('a.sf2', buildMinimalSf2('AlphaFont'));
  await lib.addBuffer('b.sf2', buildMinimalSf2('BetaFont'));
  assert.equal(lib.active.name, 'AlphaFont');
  lib.hide(0);
  assert.equal(lib.active.name, 'BetaFont');
});

test('hiding the only visible font clears active to null', async () => {
  const lib = new SoundfontLibrary();
  await lib.addBuffer('a.sf2', buildMinimalSf2('AlphaFont'));
  lib.hide(0);
  assert.equal(lib.active, null);
});

test('hide notifies onChange even when the hidden font was not active', async () => {
  const lib = new SoundfontLibrary();
  await lib.addBuffer('a.sf2', buildMinimalSf2('AlphaFont'));
  await lib.addBuffer('b.sf2', buildMinimalSf2('BetaFont'));
  let notified = false;
  lib.onChange = () => { notified = true; };
  lib.hide(1); // BetaFont, not the active one (Alpha stays active)
  assert.ok(notified, 'the switcher popup needs to re-render even if the active font is unchanged');
  assert.equal(lib.active.name, 'AlphaFont');
});

test('unhide restores a font to visibleFonts without auto-activating it', async () => {
  const lib = new SoundfontLibrary();
  await lib.addBuffer('a.sf2', buildMinimalSf2('AlphaFont'));
  await lib.addBuffer('b.sf2', buildMinimalSf2('BetaFont'));
  lib.hide(0);
  assert.equal(lib.active.name, 'BetaFont');
  lib.unhide(0);
  assert.deepEqual(lib.visibleFonts.map((v) => v.font.name), ['AlphaFont', 'BetaFont'], 'visibleFonts preserves stable index order, not restoration order');
  assert.equal(lib.active.name, 'BetaFont', 'unhide restores visibility but does not steal activation');
});

test('cycle skips hidden fonts entirely', async () => {
  const lib = new SoundfontLibrary();
  await lib.addBuffer('a.sf2', buildMinimalSf2('AlphaFont'));
  await lib.addBuffer('b.sf2', buildMinimalSf2('BetaFont'));
  await lib.addBuffer('c.sf2', buildMinimalSf2('GammaFont'));
  lib.hide(1); // hide BetaFont — cycling from Alpha should land on Gamma, not Beta
  assert.equal(lib.active.name, 'AlphaFont');
  lib.cycle(1);
  assert.equal(lib.active.name, 'GammaFont');
  lib.cycle(1);
  assert.equal(lib.active.name, 'AlphaFont', 'wraps around skipping the hidden font');
});

test('select activates a specific visible font and no-ops on a hidden one', async () => {
  const lib = new SoundfontLibrary();
  await lib.addBuffer('a.sf2', buildMinimalSf2('AlphaFont'));
  await lib.addBuffer('b.sf2', buildMinimalSf2('BetaFont'));
  lib.select(1);
  assert.equal(lib.active.name, 'BetaFont');
  lib.hide(0);
  lib.select(0); // AlphaFont is hidden — selecting it must not surface a hidden font
  assert.equal(lib.active.name, 'BetaFont');
});

test('addBuffer after every font was hidden activates the newly added font, not a stale index', async () => {
  const lib = new SoundfontLibrary();
  await lib.addBuffer('a.sf2', buildMinimalSf2('AlphaFont'));
  lib.hide(0);
  assert.equal(lib.active, null);
  await lib.addBuffer('b.sf2', buildMinimalSf2('BetaFont'));
  // Regression: a hardcoded `activeIndex = 0` here would point at the still-
  // hidden AlphaFont (index 0) instead of the font that was just added.
  assert.equal(lib.active.name, 'BetaFont');
});

// --- SynthRouter ---

test('SynthRouter routes to fallback when no SF2 is loaded', () => {
  const fallback = makeMockSynth();
  const router = new SynthRouter(fallback);
  router.noteOn({ pitch: 60, vel: 0.8, role: 'MELODY', durMs: 200 });
  assert.equal(fallback.calls, 1);
});

test('SynthRouter routes to SF2 when a font is loaded', () => {
  const fallback = makeMockSynth();
  const sf2Engine = makeMockSynth();
  sf2Engine.sf2 = { presets: new Map() }; // simulate loaded font
  const router = new SynthRouter(fallback);
  router.setSf2Engine(sf2Engine);
  router.noteOn({ pitch: 60, vel: 0.8, role: 'MELODY', durMs: 200 });
  assert.equal(fallback.calls, 0);
  assert.equal(sf2Engine.calls, 1);
});

test('SynthRouter routes back to fallback after SF2 unload', () => {
  const fallback = makeMockSynth();
  const sf2Engine = makeMockSynth();
  const router = new SynthRouter(fallback);
  router.setSf2Engine(sf2Engine);
  // Load then unload
  sf2Engine.sf2 = { presets: new Map() };
  router.noteOn({ pitch: 60, vel: 0.8, role: 'MELODY', durMs: 200 });
  assert.equal(sf2Engine.calls, 1);
  sf2Engine.sf2 = null; // unload
  router.noteOn({ pitch: 60, vel: 0.8, role: 'MELODY', durMs: 200 });
  assert.equal(fallback.calls, 1);
});

test('SynthRouter current getter returns the active engine', () => {
  const fallback = makeMockSynth();
  const sf2Engine = makeMockSynth();
  const router = new SynthRouter(fallback);
  assert.equal(router.current, fallback);
  sf2Engine.sf2 = {};
  router.setSf2Engine(sf2Engine);
  assert.equal(router.current, sf2Engine);
});

test('SynthRouter.stopAll forwards to the SF2 engine when one is set', () => {
  const fallback = makeMockSynth();
  const sf2Engine = makeMockSynth();
  const router = new SynthRouter(fallback);
  router.setSf2Engine(sf2Engine);
  router.stopAll();
  assert.equal(sf2Engine.stopAllCalls, 1);
  assert.equal(fallback.stopAllCalls, 1, 'release fallback voices even when SF2 is current');
});

test('SynthRouter.stopAll is a no-op (never throws) before an SF2 engine is set', () => {
  const fallback = makeMockSynth();
  const router = new SynthRouter(fallback);
  assert.doesNotThrow(() => router.stopAll());
});

test('SynthRouter.enabled=false blocks noteOn at the router, even if a child would voice', () => {
  const fallback = makeMockSynth();
  const router = new SynthRouter(fallback);
  router.enabled = false;
  router.noteOn({ pitch: 60, vel: 0.8, role: 'MELODY', durMs: 200 });
  assert.equal(fallback.calls, 0, 'muted router must not reach the engine');
  assert.equal(router.enabled, false);
  router.enabled = true;
  router.noteOn({ pitch: 60, vel: 0.8, role: 'MELODY', durMs: 200 });
  assert.equal(fallback.calls, 1);
});

test('SynthRouter.enabled=false still holds after an SF2 font is attached', () => {
  const fallback = makeMockSynth();
  const sf2Engine = makeMockSynth();
  const router = new SynthRouter(fallback);
  router.enabled = false;
  sf2Engine.sf2 = { presets: new Map() };
  router.setSf2Engine(sf2Engine);
  router.noteOn({ pitch: 36, vel: 1, role: 'RHYTHM', durMs: 90 });
  assert.equal(fallback.calls, 0);
  assert.equal(sf2Engine.calls, 0, 'a late-loaded font must not start voicing over a muted song');
});
