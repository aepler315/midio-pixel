// Synchronous waits per callback (src/render/SyncWaitLedger.js; frame-cost
// plan, Phase 0). The ledger itself, and each call site against recording
// stand-ins: a fake clock that only the blocking fakes advance, so each
// kind equals exactly the time its own calls took, and the enclosing timers
// (RangeCrest cutMs, CrestProbe readMs) are shown never to be added.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SYNC_WAIT_KINDS, SyncWaitLedger, syncWaits } from '../src/render/SyncWaitLedger.js';
import { RangeCrest, CREST_PIXEL_SPLIT_LEVEL } from '../src/world/alpine/RangeCrest.js';
import { CrestProbe, ProbeReadback, PROBE_BAND_ROWS, PROBE_ROWS, asyncReadbackSupported } from '../src/world/alpine/CrestProbe.js';
import { CinematicPixelRenderer } from '../src/render/CinematicPixel.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';

/** Run `fn` with performance.now() reading a clock that moves only by `advance`. */
function withClock(fn) {
  let now = 1000;
  const clock = { advance: ms => { now += ms; } };
  performance.now = () => now;
  try { return fn(clock); } finally { delete performance.now; }
}

// --- The ledger ---------------------------------------------------------------

test('the ledger sums known kinds, ignores bad input and starts each callback at zero', () => {
  const ledger = new SyncWaitLedger();
  assert.deepEqual(SYNC_WAIT_KINDS, ['crestRead', 'crestEdgesRead', 'probeCollect', 'probeSyncRead', 'presenterGetError']);
  assert.equal(ledger.totalMs, 0);
  ledger.add('crestRead', 1.5);
  ledger.add('crestRead', 0.5);
  ledger.add('crestEdgesRead', 0.25);
  ledger.add('probeCollect', 2);
  ledger.add('probeSyncRead', 4);
  ledger.add('presenterGetError', 0);
  for (const [kind, ms] of [['crestRead', -1], ['crestRead', NaN], ['crestRead', Infinity], ['crestRead', undefined],
    ['cutMs', 5], ['readMs', 5], [undefined, 1]]) ledger.add(kind, ms);
  assert.equal(ledger.crestRead, 2);
  assert.equal(ledger.totalMs, 8.25);
  assert.equal(ledger.calls, 6, 'a zero-length wait is still a call; rejected input is not');
  const snap = ledger.snapshot();
  assert.deepEqual(snap, { totalMs: 8.25, calls: 6, crestRead: 2, crestEdgesRead: 0.25, probeCollect: 2, probeSyncRead: 4, presenterGetError: 0 });
  ledger.add('crestRead', 1);
  assert.equal(snap.crestRead, 2, 'a snapshot is a copy');
  const frames = ledger.frames;
  ledger.beginFrame();
  assert.equal(ledger.frames, frames + 1);
  assert.equal(ledger.totalMs, 0);
  assert.equal(ledger.calls, 0);
  for (const kind of SYNC_WAIT_KINDS) assert.equal(ledger[kind], 0, kind);
});

// add() ignores bad input: without a typeof guard '3' would concatenate into
// the field, and null and true would coerce to 0 and 1.
test('the ledger ignores non-number durations', () => {
  const ledger = new SyncWaitLedger();
  ledger.add('crestRead', 2);
  for (const ms of ['3', null, true]) ledger.add('crestRead', ms);
  assert.equal(ledger.crestRead, 2);
  assert.equal(typeof ledger.totalMs, 'number');
  assert.equal(ledger.calls, 1);
});

// --- RangeCrest: both getImageData sites ------------------------------------

const W = 64, H = 36;
const STAGE = { width: W, height: H, targetHeight: H };
const GRID = { width: W, height: H };
const ID = [1, 0, 0, 1, 0, 0];
const farRow = j => 10 + Math.floor(j / 5);

/** A probe with only the far band's crest and colour rows. */
function probe() {
  const data = new Uint8Array(W * PROBE_ROWS * 4), row = PROBE_BAND_ROWS.far;
  for (let j = 0; j < W; j++) {
    const k = (row * W + j) * 4, v = farRow(j) + 1;
    data[k] = v & 255; data[k + 1] = v >> 8; data[k + 2] = 128; data[k + 3] = 255;
    const c = ((row + 1) * W + j) * 4;
    data[c] = 90; data[c + 1] = 80; data[c + 2] = 60; data[c + 3] = 255;
  }
  return { width: W, height: H, data, rows: 1 << row | 1 << (row + 1), readMs: 0.01 };
}

/** Land below the far crest, transparent sky above. */
function gridPixels() {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let r = 0; r < H; r++) for (let i = 0; i < W; i++) if (r >= farRow(i)) data.set([70, 80, 60, 255], (r * W + i) * 4);
  return data;
}

const makeCanvas = (w, h) => ({ width: w, height: h,
  getContext: () => ({ createImageData: (a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }), putImageData() {} }) });

/** A grid context whose reads take `readMs` each on the fake clock; writes take `putMs` (not a wait). */
function gridContext(clock, { readMs, putMs = 0 }) {
  const pixels = gridPixels(), reads = [];
  return { reads,
    getImageData(x, y, w, h) { clock.advance(readMs[reads.length % readMs.length]); reads.push(readMs[reads.length % readMs.length]); return { data: pixels.slice(y * W * 4, (y + h) * W * 4) }; },
    putImageData() { clock.advance(putMs); } };
}

test('prepareGrid adds one crestRead per row read, equal to readbackMs, and no edge read without edge cells', () => {
  withClock(clock => {
    const crest = new RangeCrest({ makeCanvas });
    for (let f = 1; f <= 40; f++) crest.update({ probe: probe(), frameId: f, timeMs: f * 16, viewId: 'v', transform: ID, stage: STAGE, grid: GRID });
    syncWaits.beginFrame();
    const ctx = gridContext(clock, { readMs: [2, 0.5], putMs: 8 });
    assert.equal(crest.prepareGrid({ ctx }), true);
    assert.ok(ctx.reads.length >= 1);
    const read = ctx.reads.reduce((a, b) => a + b, 0);
    assert.equal(syncWaits.calls, ctx.reads.length, 'one entry per blocking read');
    assert.equal(syncWaits.crestRead, read);
    assert.equal(crest.diagnostics.readbackMs, read, 'the ledger and the diagnostics carry the same measured time');
    assert.equal(syncWaits.crestEdgesRead, 0);
    assert.equal(crest.diagnostics.edgesReadMs, 0);
    assert.equal(syncWaits.totalMs, read, 'the write-back and the rest of prepareMs are not waits');
    assert.ok(crest.diagnostics.prepareMs > read);
  });
});

test('the edge colour read is timed as crestEdgesRead and exposed as edgesReadMs, reset each frame', () => {
  withClock(clock => {
    const crest = new RangeCrest({ makeCanvas });
    const frame = f => {
      crest.update({ probe: probe(), frameId: f, timeMs: f * 16, viewId: 'v', transform: ID, stage: STAGE, grid: GRID });
      // update() decodes the probe's edge cells (none here): place one on the crest.
      Object.assign(crest._edges, { count: 1 });
      crest._edges.x[0] = 20; crest._edges.y[0] = farRow(20); crest._edges.n[0] = 0;
    };
    for (let f = 1; f <= 40; f++) frame(f);
    syncWaits.beginFrame();
    const ctx = gridContext(clock, { readMs: [2], putMs: 8 });
    assert.equal(crest.prepareGrid({ ctx }), true);
    // _prepareCrest reads first, then _prepareEdges reads once.
    const edge = 2, crestReads = ctx.reads.length - 1;
    assert.ok(crestReads >= 1);
    assert.equal(syncWaits.calls, ctx.reads.length);
    assert.equal(syncWaits.crestRead, 2 * crestReads);
    assert.equal(syncWaits.crestEdgesRead, edge);
    assert.equal(crest.diagnostics.edgesReadMs, edge);
    assert.equal(syncWaits.totalMs, 2 * crestReads + edge);
    // A second preparation of the same frame reads nothing and keeps the value.
    assert.equal(crest.prepareGrid({ ctx }), false);
    assert.equal(ctx.reads.length, crestReads + 1);
    assert.equal(crest.diagnostics.edgesReadMs, edge);
    frame(41);
    assert.equal(crest.diagnostics.edgesReadMs, 0, 'reset with readbackMs on the next frame');
    // A read that throws adds nothing.
    syncWaits.beginFrame();
    crest._prepareEdges({ getImageData() { clock.advance(4); throw Error('tainted'); } });
    assert.equal(syncWaits.calls, 0);
  });
});

// --- CrestProbe: collect and the synchronous read -----------------------------

const PW = 8;

/** WebGL2 stand-in (as test/crestProbeReadback.test.js): fences signal on finish(). The poll's
 *  calls take `waitMs` on the clock; queuing a pack-buffer read takes `queueMs` (not a wait). */
function fakeGL(clock, { waitMs = 0, queueMs = 0 } = {}) {
  const gl = {
    PIXEL_PACK_BUFFER: 0x88eb, STREAM_READ: 0x88e1, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401, SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
    TIMEOUT_EXPIRED: 0x911b, ALREADY_SIGNALED: 0x911a, CONDITION_SATISFIED: 0x911c, WAIT_FAILED: 0x911d,
    source: new Uint8Array(PW * PROBE_ROWS * 4), bound: null, fences: [],
    createBuffer() { return { data: null }; },
    deleteBuffer() {},
    bindBuffer(target, b) { gl.bound = b; },
    bufferData(target, bytes) { gl.bound.data = new Uint8Array(bytes); },
    readPixels(x, y, w, h) { clock.advance(queueMs); gl.bound.data.set(gl.source.subarray(0, w * h * 4)); },
    fenceSync() { const f = { done: false }; gl.fences.push(f); return f; },
    flush() {},
    clientWaitSync(f) { clock.advance(waitMs); return f.done ? gl.ALREADY_SIGNALED : gl.TIMEOUT_EXPIRED; },
    deleteSync() {},
    getBufferSubData(target, offset, dst) { clock.advance(waitMs); dst.set(gl.bound.data); },
    finish() { for (const f of gl.fences) f.done = true; },
  };
  return gl;
}

/** A CrestProbe on the fake context (no THREE: only the readback path). */
function probeOn(gl, clock, { syncReadMs = 0, targetMs = 0 } = {}) {
  const p = Object.create(CrestProbe.prototype);
  const renderer = { syncReads: 0,
    setRenderTarget() { clock.advance(targetMs); },
    readRenderTargetPixels(target, x, y, w, h, out) { renderer.syncReads++; clock.advance(syncReadMs); out.fill(1, 0, w * h * 4); } };
  Object.assign(p, { renderer, target: {}, width: PW, height: 36, data: new Uint8Array(PW * PROBE_ROWS * 4), frameId: -1, rows: 0,
    readMs: 0, collectMs: 0, async: gl && asyncReadbackSupported(gl) ? new ProbeReadback(gl) : null });
  return p;
}

const render = (p, f) => { p.frameId = f; p.rows = 0b11; };

test('collect adds its poll once as probeCollect; the async read adds nothing although readMs includes it', () => {
  withClock(clock => {
    const gl = fakeGL(clock, { waitMs: 0.5, queueMs: 4 }), p = probeOn(gl, clock, { targetMs: 8 });
    syncWaits.beginFrame();
    p.collect();
    render(p, 1);
    assert.equal(p.read(1, { viewId: 'v', timeMs: 0 }), null, 'nothing finished yet');
    assert.equal(syncWaits.calls, 0, 'collect with nothing in flight makes no GL call and adds nothing');
    assert.equal(syncWaits.totalMs, 0);
    for (let f = 2; f <= 5; f++) {
      gl.finish();
      syncWaits.beginFrame();
      p.collect();
      const collected = p.collectMs;
      assert.equal(collected, 1, 'one fence poll and one getBufferSubData');
      render(p, f);
      const r = p.read(f, { viewId: 'v', timeMs: f * 1000 / 60 });
      assert.equal(r.mode, 'async');
      assert.equal(syncWaits.calls, 1);
      assert.equal(syncWaits.probeCollect, collected);
      assert.equal(syncWaits.probeSyncRead, 0);
      assert.equal(r.readMs, collected + 8 + 4, 'readMs holds collectMs, the target switch and the queued copy');
      assert.equal(syncWaits.totalMs, collected, 'readMs is never added');
    }
    assert.equal(p.renderer.syncReads, 0);
  });
});

test('a context without async readback times just the synchronous read as probeSyncRead', () => {
  withClock(clock => {
    const p = probeOn(null, clock, { syncReadMs: 4, targetMs: 8 });
    syncWaits.beginFrame();
    p.collect();
    assert.equal(syncWaits.calls, 0, 'no async readback: collect blocks on nothing');
    render(p, 1);
    const r = p.read(1, { viewId: 'v', timeMs: 0 });
    assert.equal(r.mode, 'sync');
    assert.equal(p.renderer.syncReads, 1);
    assert.equal(syncWaits.calls, 1);
    assert.equal(syncWaits.probeSyncRead, 4);
    assert.equal(syncWaits.totalMs, 4);
    // A read that throws adds nothing.
    syncWaits.beginFrame();
    p.renderer.readRenderTargetPixels = () => { clock.advance(2); throw Error('lost'); };
    render(p, 2);
    assert.equal(p.read(2, { viewId: 'v', timeMs: 1000 / 60 }), null);
    assert.equal(syncWaits.calls, 0);
  });
});

test('an export frame\'s intentional synchronous read counts as probeSyncRead; the collect before it is not added again', () => {
  withClock(clock => {
    const gl = fakeGL(clock, { waitMs: 0.5 }), p = probeOn(gl, clock, { syncReadMs: 2 });
    // One live frame leaves a copy in flight, so the export frame's collect polls.
    p.collect();
    render(p, 1);
    assert.equal(p.read(1, { viewId: 'v', timeMs: 0 }), null);
    syncWaits.beginFrame();
    p.collect();
    assert.equal(p.collectMs, 0.5, 'one fence poll (still pending)');
    render(p, 2);
    const r = p.read(2, { sync: true, viewId: 'v', timeMs: 1000 / 60 });
    assert.equal(r.mode, 'sync');
    assert.equal(syncWaits.calls, 2, 'the poll and the synchronous read');
    assert.equal(syncWaits.probeCollect, 0.5);
    assert.equal(syncWaits.probeSyncRead, 2);
    assert.equal(syncWaits.totalMs, 0.5 + 2);
    assert.equal(r.readMs, 2, 'an export read leaves collectMs out of readMs');
  });
});

test('the live fallback after an async failure times only the synchronous read, never readMs', () => {
  withClock(clock => {
    const gl = fakeGL(clock, { waitMs: 0.5, queueMs: 1 }), p = probeOn(gl, clock, { syncReadMs: 4, targetMs: 8 });
    p.collect();
    render(p, 1);
    assert.equal(p.read(1, { viewId: 'v', timeMs: 0 }), null, 'a copy is now in flight');
    gl.finish();
    syncWaits.beginFrame();
    p.collect();
    const collected = p.collectMs;
    assert.equal(collected, 1, 'one fence poll and one getBufferSubData');
    // This frame's fence fails: read() drops async readback and falls back to the sync read.
    gl.fenceSync = () => null;
    render(p, 2);
    const r = p.read(2, { viewId: 'v', timeMs: 1000 / 60 });
    assert.equal(r.mode, 'sync');
    assert.equal(p.async, null);
    assert.equal(p.renderer.syncReads, 1);
    assert.equal(syncWaits.calls, 2);
    assert.equal(syncWaits.probeCollect, collected);
    assert.equal(syncWaits.probeSyncRead, 4, 'only readRenderTargetPixels');
    assert.equal(syncWaits.totalMs, collected + 4);
    assert.equal(r.readMs, collected + 8 + 1 + 4, 'readMs adds the target switch and the failed queue');
    assert.ok(r.readMs > syncWaits.totalMs, 'readMs is never added');
  });
});

// --- CinematicPixelRenderer: getError, inside RangeCrest's cut ---------------

/** A WebGL stub whose getError takes `errorMs` and whose draw submission takes `drawMs`. */
function cinematicPass(clock, { errorMs, drawMs, error = 0 }) {
  const log = { getError: 0 };
  const gl = new Proxy({ NO_ERROR: 0 }, { get(target, name) {
    if (name in target) return target[name];
    if (typeof name === 'string' && /^[A-Z_0-9]+$/.test(name)) return name;
    if (name === 'getError') return () => { log.getError++; clock.advance(errorMs); return error; };
    if (name === 'drawArrays') return () => clock.advance(drawMs);
    if (name === 'isContextLost') return () => false;
    if (/^get(Shader|Program)Parameter$/.test(name)) return () => true;
    if (/^create/.test(name)) return () => ({});
    return () => {};
  } });
  const makeCanvas = () => ({ width: 300, height: 150, getContext: () => gl });
  const pass = new CinematicPixelRenderer({ residency: new GraphicsResidency(), makeCanvas });
  return { pass, log };
}

test('every Cinematic draw adds its getError call as presenterGetError and exposes getErrorMs', () => {
  withClock(clock => {
    const { pass, log } = cinematicPass(clock, { errorMs: 0.5, drawMs: 8 });
    assert.equal(pass.getErrorMs, 0);
    const ctx = { drawImage() {} }, source = { width: 320, height: 180 }, fit = { x: 0, y: 0, width: 1280, height: 720 };
    for (let n = 1; n <= 3; n++) {
      syncWaits.beginFrame();
      assert.equal(pass.draw(ctx, source, fit), true);
      assert.equal(log.getError, n, 'getError still runs on every draw');
      assert.equal(pass.getErrorMs, 0.5);
      assert.equal(syncWaits.calls, 1);
      assert.equal(syncWaits.presenterGetError, 0.5);
      assert.equal(syncWaits.totalMs, 0.5, 'the draw submission is not a wait');
    }
    pass.dispose();
    const failing = cinematicPass(clock, { errorMs: 0.5, drawMs: 0, error: 0x0505 });
    syncWaits.beginFrame();
    assert.equal(failing.pass.draw(ctx, source, fit), false);
    assert.equal(failing.pass.reason, 'draw-failed', 'behaviour unchanged on an error');
    assert.equal(syncWaits.presenterGetError, 0.5);
    failing.pass.dispose();
  });
});

test('RangeCrest cutMs contains the presenter draw and is never added: only getError counts', () => {
  withClock(clock => {
    const crest = new RangeCrest({ makeCanvas });
    // One frame at the split rung: the line is fading in, so the cut draws twice.
    crest.update({ probe: probe(), frameId: 1, timeMs: 0, viewId: 'v', transform: ID, stage: STAGE, grid: GRID, qualityLevel: CREST_PIXEL_SPLIT_LEVEL });
    assert.ok(crest.snapshot.fade < 1);
    const { pass, log } = cinematicPass(clock, { errorMs: 0.5, drawMs: 8 });
    const out = new Proxy({}, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } });
    const source = { width: W, height: H }, fit = { x: 0, y: 0, width: 1280, height: 720, scale: 20 };
    syncWaits.beginFrame();
    assert.equal(crest.drawTerrain(out, fit, 1, () => pass.draw(out, source, fit)), true);
    assert.equal(log.getError, 2);
    assert.equal(crest.diagnostics.cutMs, 2 * (8 + 0.5), 'the cut timer wraps both presenter draws');
    assert.equal(syncWaits.calls, 2);
    assert.equal(syncWaits.totalMs, 2 * 0.5, 'each getError counted once; cutMs is not a wait');
    pass.dispose();
  });
});
