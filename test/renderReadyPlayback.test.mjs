import test from 'node:test';
import assert from 'node:assert/strict';

const implementation = await import('../src/render/RenderReadyPlayback.js').catch(error => {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  return {};
});
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const gate = () => {
  assert.equal(typeof implementation.createRenderReadyPlayback, 'function');
  return implementation.createRenderReadyPlayback();
};

test('render preparation holds the transport until readiness completes', async () => {
  const controller = gate(), ready = deferred(), events = [];
  const pending = controller.begin({ hold: () => events.push('hold'), prepare: () => ready.promise,
    start: () => events.push('start'), fail: () => events.push('fail') });
  assert.equal(controller.status, 'preparing'); assert.deepEqual(events, ['hold']);
  await Promise.resolve(); assert.deepEqual(events, ['hold']);
  ready.resolve(); await pending;
  assert.deepEqual(events, ['hold', 'start']); assert.equal(controller.status, 'ready');
});

test('a replaced or stopped preparation can never start its old audio', async () => {
  const controller = gate(), old = deferred(), current = deferred(), events = [];
  const first = controller.begin({ hold() {}, prepare: () => old.promise, start: () => events.push('old') });
  const second = controller.begin({ hold() {}, prepare: () => current.promise, start: () => events.push('new') });
  old.resolve(); await first; assert.deepEqual(events, []);
  controller.cancel(); current.resolve(); await second;
  assert.deepEqual(events, []); assert.equal(controller.status, 'idle');
});

test('render failure keeps the transport held and reports only the current failure', async () => {
  const controller = gate(), failed = new Error('terrain shader failed'), events = [];
  await controller.begin({ hold: () => events.push('hold'), prepare: async () => { throw failed; },
    start: () => events.push('start'), fail: error => events.push(error.message) });
  assert.deepEqual(events, ['hold', 'terrain shader failed']); assert.equal(controller.status, 'failed');
});

test('readiness release respects a pause or seek selected while preparing', async () => {
  const controller = gate(), ready = deferred(); let paused = false, position = 15950;
  const starts = [];
  const pending = controller.begin({ hold() {}, prepare: () => ready.promise,
    start: () => starts.push({ paused, position }) });
  paused = true; ready.resolve(); await pending;
  assert.deepEqual(starts, [{ paused: true, position: 15950 }]);
});

test('scenic readiness draws the destination and waits for its complete covering forest window', async () => {
  assert.equal(typeof implementation.waitForScenicReady, 'function');
  const window = { index: 0, coarse: true };
  const prepared = { windowCache: { current: 0, resident: new Map([[0, window]]) }, activeWindow: window,
    windowCoverage: { covered: true } };
  let settles = 0, draws = 0;
  const presentation = { enabled: true, active: false, runtimeState: 'ready', _needed: new Set(),
    _wants: [{ id: 'destination' }], scene: { prepared: new Map([['destination', prepared]]) },
    async whenReady() {}, async settle() { settles++; if (settles === 2) prepared.activeWindow.coarse = false; },
    snapshot: () => ({ runtime: 'ready', failures: {}, reason: 'preparing' }) };
  await implementation.waitForScenicReady({ presentation, draw() { draws++; presentation.active = true; return { presented: true }; },
    wait: async () => {}, timeoutMs: 1000 });
  assert.equal(settles, 2); assert.ok(draws >= 3);
});

test('a covering neighbouring window cannot release a seek before its destination forest is resident', async () => {
  const previous = { index: 0, coarse: false }, destination = { index: 1, coarse: false };
  const prepared = { windowCache: { current: 1, resident: new Map([[0, previous]]) },
    activeWindow: previous, windowCoverage: { covered: true } };
  let settles = 0;
  const presentation = { enabled: true, active: true, runtimeState: 'ready', _needed: new Set(),
    _wants: [{ id: 'destination' }], scene: { prepared: new Map([['destination', prepared]]) },
    async whenReady() {}, async settle() {
      settles++; if (settles === 2) { prepared.activeWindow = destination; prepared.windowCache.resident.set(1, destination); }
    }, snapshot: () => ({ runtime: 'ready', failures: {} }) };
  await implementation.waitForScenicReady({ presentation, draw: () => ({ presented: true }), wait: async () => {}, timeoutMs: 1000 });
  assert.equal(settles, 2, 'the destination forest, rather than a covering neighbour, owns readiness');
});

test('scenic readiness waits for a completed presentation rather than a rejected draw', async () => {
  let settles = 0;
  const prepared = {};
  const presentation = { enabled: true, active: true, runtimeState: 'ready', _needed: new Set(),
    _wants: [{ id: 'destination' }], scene: { prepared: new Map([['destination', prepared]]) },
    async whenReady() {}, async settle() { settles++; }, snapshot: () => ({ runtime: 'ready', failures: {} }) };
  await implementation.waitForScenicReady({ presentation, draw: () => ({ presented: settles >= 2 }),
    wait: async () => {}, timeoutMs: 1000 });
  assert.equal(settles, 2, 'a frame rejected for terrain readiness cannot release audio');
});

test('scenic terminal errors reject readiness instead of starting over a missing scene', async () => {
  assert.equal(typeof implementation.waitForScenicReady, 'function');
  const presentation = { enabled: true, active: false, _needed: new Set(), _wants: [{ id: 'destination' }],
    async whenReady() {}, snapshot: () => ({ runtime: 'failed', failures: {}, reason: 'WebGL unavailable' }) };
  await assert.rejects(implementation.waitForScenicReady({ presentation, draw() {}, timeoutMs: 1000 }), /WebGL unavailable/);
});

test('only the full destination draw admits semantic scene captures after readiness primes', async () => {
  const window = { index: 0, coarse: true };
  const prepared = { windowCache: { current: 0, resident: new Map([[0, window]]) },
    activeWindow: window, windowCoverage: { covered: true } };
  const captures = [], options = [];
  let settles = 0;
  const presentation = { enabled: true, active: true, runtimeState: 'ready', _needed: new Set(),
    _wants: [{ id: 'destination' }], scene: { prepared: new Map([['destination', prepared]]) },
    async whenReady() {}, async settle() { if (++settles === 2) window.coarse = false; },
    snapshot: () => ({ runtime: 'ready', failures: {} }) };
  await implementation.waitForScenicReady({ presentation,
    draw(option) { options.push(option); if (!option?.preparing) captures.push(window.coarse); return { presented: true }; },
    wait: async () => {}, timeoutMs: 1000 });
  assert.deepEqual(captures, [false], 'one complete destination frame owns all semantic captures');
  assert.ok(options.slice(0, -1).every(option => option.preparing));
});
test('readiness waits for asynchronous source startup before admitting playback', async () => {
  const playback = gate();
  let release;
  const startup = new Promise(resolve => { release = resolve; });
  const ready = playback.begin({ hold() {}, prepare() {}, start: () => startup });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(playback.status, 'preparing');
  release(); await ready;
  assert.equal(playback.status, 'ready');
});
