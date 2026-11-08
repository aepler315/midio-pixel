// Asynchronous crest probe readback (CrestProbe.js): scheduling against a
// fake WebGL2 context whose GPU finishes work only when the test says so.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CrestProbe, ProbeReadback, PROBE_ROWS, PROBE_READBACK_SLOTS, PROBE_MAX_LAG_FRAMES, acceptProbeResult, asyncReadbackSupported,
  timelineJump,
} from '../src/world/alpine/CrestProbe.js';

const W = 8;

/** A WebGL2 stand-in: the bound framebuffer holds `source`; readPixels
 *  into a pack buffer copies it at command time; fences signal only when
 *  `finish()` runs (the GPU catching up). */
function fakeGL() {
  const gl = {
    PIXEL_PACK_BUFFER: 0x88eb, STREAM_READ: 0x88e1, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401, SYNC_GPU_COMMANDS_COMPLETE: 0x9117,
    TIMEOUT_EXPIRED: 0x911b, ALREADY_SIGNALED: 0x911a, CONDITION_SATISFIED: 0x911c, WAIT_FAILED: 0x911d,
    source: new Uint8Array(W * PROBE_ROWS * 4), bound: null, buffers: [], fences: [], waits: [], log: [], unreadRewrites: 0,
    createBuffer() { const b = { data: null, unread: false }; gl.buffers.push(b); return b; },
    deleteBuffer(b) { b.deleted = true; },
    bindBuffer(target, b) { assert.equal(target, gl.PIXEL_PACK_BUFFER); gl.bound = b; },
    bufferData(target, bytes) { gl.bound.data = new Uint8Array(bytes); gl.bound.unread = false; },
    readPixels(x, y, w, h, format, type, offset) {
      assert.ok(gl.bound, 'reads into a pack buffer, never to client memory');
      assert.equal(offset, 0);
      if (gl.bound.unread) gl.unreadRewrites++;
      gl.bound.data.set(gl.source.subarray(0, w * h * 4));
      gl.bound.unread = true;
      gl.log.push('readPixels');
    },
    fenceSync() { const f = { done: false }; gl.fences.push(f); return f; },
    flush() {},
    clientWaitSync(f, flags, timeout) { gl.waits.push(timeout); return f.failed ? gl.WAIT_FAILED : f.done ? gl.ALREADY_SIGNALED : gl.TIMEOUT_EXPIRED; },
    deleteSync(f) { f.deleted = true; },
    getBufferSubData(target, offset, dst) { dst.set(gl.bound.data); gl.bound.unread = false; gl.log.push('getBufferSubData'); },
    finish() { for (const f of gl.fences) f.done = true; },
  };
  return gl;
}

/** A CrestProbe on the fake context (no THREE: only the readback path). */
function probeOn(gl) {
  const p = Object.create(CrestProbe.prototype);
  const renderer = { syncReads: 0,
    setRenderTarget() {},
    readRenderTargetPixels(target, x, y, w, h, out) { renderer.syncReads++; out.set(gl.source.subarray(0, w * h * 4)); } };
  Object.assign(p, { renderer, target: {}, width: W, height: 36, data: new Uint8Array(W * PROBE_ROWS * 4), frameId: -1, rows: 0,
    readMs: 0, async: gl && asyncReadbackSupported(gl) ? new ProbeReadback(gl) : null });
  return p;
}

/** Render frame `f`: the probe target now holds `f` in every byte. */
function render(p, gl, f, { sync = false } = {}) {
  if (!sync) p.collect?.();
  gl.log.push(`render:${f}`);
  p.frameId = f; p.rows = 0b11;
  gl.source.fill(f & 255);
}

test('live frames use the newest finished readback and never wait on the GPU', () => {
  const gl = fakeGL(), p = probeOn(gl);
  render(p, gl, 1);
  const first = p.read(1, { viewId: 'v', timeMs: 1000 / 60 });
  assert.equal(first, null, 'nothing has finished yet: omit the optional crest without waiting');
  for (let f = 2; f <= 12; f++) {
    gl.finish(); // the GPU finishes last frame's copy before this frame's read
    render(p, gl, f);
    const r = p.read(f, { viewId: 'v', timeMs: f * 1000 / 60 });
    assert.equal(r.mode, 'async');
    assert.equal(r.lag, 1);
    assert.equal(r.frameId, f - 1);
    assert.equal(r.data[0], f - 1, 'the data of the frame it names');
    assert.equal(r.rows, 0b11);
  }
  assert.equal(p.renderer.syncReads, 0, 'normal WebGL2 live frames never force synchronous reads');
  assert.ok(gl.waits.every(t => t === 0), 'fences are only polled, never waited on');
  assert.equal(gl.buffers.length, 1, 'healthy readbacks reuse their GPU storage');
  assert.equal(gl.unreadRewrites, 0);
});

test('reset retires stale completed buffers without reading them or rewriting unread storage', () => {
  const gl = fakeGL(), q = new ProbeReadback(gl);
  for (let frameId = 1; frameId <= PROBE_READBACK_SLOTS; frameId++) {
    gl.source.fill(frameId);
    assert.equal(q.submit({ frameId }, W, PROBE_ROWS), true);
  }
  const buffers = q.slots.map(s => s.buffer), arrays = q.slots.map(s => s.data);
  q.reset();
  assert.equal(q.latest, null);
  assert.equal(q.inFlight, PROBE_READBACK_SLOTS, 'reset never waits for copies in flight');
  assert.equal(q.submit({ frameId: 4 }, W, PROBE_ROWS), false, 'the ring stays bounded');
  gl.finish();
  assert.equal(q.poll(), 0);
  assert.equal(q.latest, null);
  assert.equal(gl.log.filter(c => c === 'getBufferSubData').length, 0, 'stale bytes are never read to the CPU');
  gl.source.fill(9);
  assert.equal(q.submit({ frameId: 9 }, W, PROBE_ROWS), true);
  assert.equal(gl.unreadRewrites, 0, 'discarding a result must retire its unread GPU storage');
  assert.ok(buffers.every(b => b.deleted));
  assert.equal(q.slots[0].data, arrays[0], 'retirement retains the same-sized CPU scratch array');
  gl.finish(); q.poll();
  assert.equal(q.latest.frameId, 9);
  assert.equal(q.latest.data[0], 9);
  assert.ok(gl.waits.every(t => t === 0));
});

test('an older completion retires its unread buffer while preserving the newest result', () => {
  const gl = fakeGL(), q = new ProbeReadback(gl);
  gl.source.fill(1); q.submit({ frameId: 1 }, W, PROBE_ROWS);
  gl.source.fill(2); q.submit({ frameId: 2 }, W, PROBE_ROWS);
  const older = q.slots[0].buffer, newest = q.slots[1].buffer;
  gl.fences[1].done = true;
  assert.equal(q.poll(), 1);
  const result = q.latest;
  gl.fences[0].done = true;
  assert.equal(q.poll(), 0);
  assert.equal(q.latest, result);
  assert.equal(q.latest.data[0], 2);
  assert.equal(gl.log.filter(c => c === 'getBufferSubData').length, 1);
  gl.source.fill(3); q.submit({ frameId: 3 }, W, PROBE_ROWS);
  assert.equal(gl.unreadRewrites, 0);
  assert.equal(older.deleted, true);
  assert.equal(newest.deleted, undefined, 'the healthy buffer remains reusable');
  gl.finish(); q.poll();
  assert.equal(q.latest.frameId, 3);
  assert.equal(q.latest.data[0], 3);
});

test('a failed fence retires its unread buffer without reading unverified bytes', () => {
  const gl = fakeGL(), q = new ProbeReadback(gl);
  q.submit({ frameId: 1 }, W, PROBE_ROWS);
  const failed = q.slots[0].buffer;
  gl.fences[0].failed = true;
  assert.equal(q.poll(), 0);
  assert.equal(q.inFlight, 0);
  assert.equal(q.latest, null);
  assert.equal(gl.log.filter(c => c === 'getBufferSubData').length, 0);
  q.submit({ frameId: 2 }, W, PROBE_ROWS);
  assert.equal(gl.unreadRewrites, 0);
  assert.equal(failed.deleted, true);
  assert.ok(gl.waits.every(t => t === 0));
});

test('fence creation failure retires the just-written buffer before another submission', () => {
  const gl = fakeGL(), q = new ProbeReadback(gl), fenceSync = gl.fenceSync;
  gl.fenceSync = () => null;
  assert.equal(q.submit({ frameId: 1 }, W, PROBE_ROWS), false);
  const failed = gl.buffers[0];
  assert.equal(q.inFlight, 0);
  gl.fenceSync = fenceSync;
  gl.source.fill(2);
  assert.equal(q.submit({ frameId: 2 }, W, PROBE_ROWS), true);
  assert.equal(gl.unreadRewrites, 0);
  assert.equal(failed.deleted, true);
  assert.equal(gl.log.filter(c => c === 'getBufferSubData').length, 0);
  gl.finish(); q.poll();
  assert.equal(q.latest.frameId, 2);
  assert.equal(q.latest.data[0], 2);
});

test('a GPU running behind keeps at most three reads in flight and serves results up to three frames old', () => {
  const gl = fakeGL(), p = probeOn(gl);
  render(p, gl, 1); p.read(1, { viewId: 'v', timeMs: 0 });
  gl.finish();
  render(p, gl, 2); assert.equal(p.read(2, { viewId: 'v', timeMs: 16 }).lag, 1);
  const epoch = p.async.epoch;
  // Lag 2 and 3 reuse frame 1. Expiry omits the crest while newer copies
  // remain in flight: it must not discard their epoch or force a sync read.
  const lags = [];
  for (let f = 3; f <= 6; f++) { render(p, gl, f); const r = p.read(f, { viewId: 'v', timeMs: f * 16 }); lags.push([r?.mode ?? 'none', r?.lag ?? 0]); }
  assert.deepEqual(lags, [['async', 2], ['async', 3], ['none', 0], ['none', 0]]);
  assert.equal(p.async.epoch, epoch, 'lag expiry preserves newer pending copies');
  assert.ok(p.async.inFlight <= PROBE_READBACK_SLOTS);
  assert.ok(p.async.skipped > 0, 'no fourth read is queued while three are in flight');
  assert.equal(PROBE_MAX_LAG_FRAMES, 3);
  gl.finish(); render(p, gl, 7);
  assert.equal(p.read(7, { viewId: 'v', timeMs: 112 }).frameId, 4, 'pending work still recovers without starvation');
  gl.finish(); render(p, gl, 8);
  assert.equal(p.read(8, { viewId: 'v', timeMs: 128 }).frameId, 7);
  assert.equal(p.renderer.syncReads, 0);
});

test('live collection happens before current rendering and never polls a second time in read', () => {
  const gl = fakeGL(), p = probeOn(gl);
  render(p, gl, 1); p.read(1, { viewId: 'v', timeMs: 0 });
  gl.finish(); render(p, gl, 2);
  const beforeRead = gl.waits.length;
  assert.equal(p.read(2, { viewId: 'v', timeMs: 16 }).frameId, 1);
  assert.equal(gl.waits.length, beforeRead, 'no late fence polling after rendering');
  assert.ok(gl.log.indexOf('getBufferSubData') < gl.log.indexOf('render:2'), 'CPU copy precedes all current frame GPU work');
  render(p, gl, 3); // frame 2 is not finished at the early collection
  const reads = gl.log.filter(x => x === 'getBufferSubData').length;
  gl.finish(); // even a copy finishing during rendering waits until next frame
  assert.equal(p.read(3, { viewId: 'v', timeMs: 32 }).frameId, 1);
  assert.equal(gl.log.filter(x => x === 'getBufferSubData').length, reads);
  render(p, gl, 4);
  assert.equal(p.read(4, { viewId: 'v', timeMs: 48 }).frameId, 2);
});

test('an early collection failure preserves the synchronous compatibility fallback', () => {
  const gl = fakeGL(), p = probeOn(gl);
  render(p, gl, 1); p.read(1, { viewId: 'v', timeMs: 0 });
  gl.clientWaitSync = () => { throw new Error('lost async readback'); };
  render(p, gl, 2);
  assert.equal(p.async, null);
  assert.equal(p.read(2, { viewId: 'v', timeMs: 16 }).mode, 'sync');
  assert.equal(p.renderer.syncReads, 1);
});

test('failed fence creation and failed waits use compatibility reads rather than normal pending misses', () => {
  for (const failure of ['fence', 'wait']) {
    const gl = fakeGL(), p = probeOn(gl);
    if (failure === 'fence') gl.fenceSync = () => null;
    render(p, gl, 1);
    const first = p.read(1, { viewId: 'v', timeMs: 0 });
    if (failure === 'wait') {
      assert.equal(first, null);
      gl.fences[0].failed = true;
      render(p, gl, 2);
      assert.equal(p.read(2, { viewId: 'v', timeMs: 16 }).mode, 'sync');
    } else assert.equal(first.mode, 'sync');
    assert.equal(p.async, null, `${failure}: failed async transport is retired`);
    assert.equal(p.renderer.syncReads, 1);
    assert.ok(gl.buffers.every(b => b.deleted));
  }
});

test('read timing includes early collection once and never carries live collection cost into exports', () => {
  const gl = fakeGL(), p = probeOn(gl);
  render(p, gl, 1); p.read(1, { viewId: 'v', timeMs: 0 });
  gl.finish(); render(p, gl, 2);
  p.collectMs = 1e6;
  assert.ok(p.read(2, { viewId: 'v', timeMs: 16 }).readMs >= 1e6);
  assert.equal(p.collectMs, 0, 'collection cost is consumed by this read');
  render(p, gl, 3, { sync: true });
  p.collectMs = 1e6;
  assert.ok(p.read(3, { sync: true, viewId: 'v', timeMs: 32 }).readMs < 1e6);
  assert.equal(p.collectMs, 0, 'an export also discards any unconsumed live cost');
});

test('a submission failure with a healthy latest keeps those bytes intact and reads the current compatibility frame', () => {
  const gl = fakeGL(), p = probeOn(gl);
  render(p, gl, 1); p.read(1, { viewId: 'v', timeMs: 0 });
  gl.finish(); render(p, gl, 2);
  assert.equal(p.read(2, { viewId: 'v', timeMs: 16 }).frameId, 1);
  gl.finish(); render(p, gl, 3);
  const latest = p.async.latest, bytes = latest.data.slice();
  gl.fenceSync = () => null;
  const r = p.read(3, { viewId: 'v', timeMs: 32 });
  assert.equal(r.mode, 'sync');
  assert.equal(r.frameId, 3);
  assert.equal(r.data[0], 3);
  assert.deepEqual(latest.data, bytes, 'failed submission never publishes unverified bytes');
  assert.equal(p.async, null);
});

test('a seek or a view change discards older results, including those still in flight', () => {
  const gl = fakeGL(), p = probeOn(gl);
  for (let f = 1; f <= 3; f++) { gl.finish(); render(p, gl, f); p.read(f, { viewId: 'a', timeMs: f * 16 }); }
  render(p, gl, 4);
  const view = p.read(4, { viewId: 'b', timeMs: 64 });
  assert.equal(view, null, 'a new view never shows the old view');
  // Reads queued before the change (frame 3, view a) finish late: dropped.
  gl.finish();
  render(p, gl, 5);
  const next = p.read(5, { viewId: 'b', timeMs: 80 });
  assert.equal(next.mode, 'async');
  assert.equal(next.frameId, 4, 'the first read of the new view');
  gl.finish();
  render(p, gl, 6);
  const seek = p.read(6, { viewId: 'b', timeMs: 5000 });
  assert.equal(seek, null, 'a result from before a seek is never used');
  gl.finish();
  render(p, gl, 7);
  const back = p.read(7, { viewId: 'b', timeMs: 40 });
  assert.equal(back, null, 'nor one from after a backward seek');
  p.reset();
  assert.equal(p.async.latest, null);
});

test('export draws read their own frame synchronously, every time', () => {
  const gl = fakeGL(), p = probeOn(gl);
  for (let f = 1; f <= 4; f++) { gl.finish(); render(p, gl, f); p.read(f, { viewId: 'v', timeMs: f * 16 }); }
  const reads = [];
  for (let f = 5; f <= 8; f++) {
    gl.finish();
    render(p, gl, f, { sync: true });
    const r = p.read(f, { sync: true, viewId: 'v', timeMs: f * 16 });
    reads.push([r.mode, r.lag, r.data[0]]);
  }
  assert.deepEqual(reads, [['sync', 0, 5], ['sync', 0, 6], ['sync', 0, 7], ['sync', 0, 8]]);
  // Rendering the same export frame again reproduces it exactly.
  render(p, gl, 8, { sync: true });
  assert.deepEqual([...p.read(8, { sync: true, viewId: 'v', timeMs: 128 }).data], [...p.data]);
});

test('without WebGL2 fences the probe reads synchronously', () => {
  assert.equal(asyncReadbackSupported(null), false);
  assert.equal(asyncReadbackSupported({ readPixels() {} }), false, 'a WebGL1 context');
  assert.equal(asyncReadbackSupported(fakeGL()), true);
  const gl = fakeGL(), p = probeOn(gl);
  p.async = null;
  for (let f = 1; f <= 3; f++) { render(p, gl, f); const r = p.read(f, { viewId: 'v', timeMs: f * 16 }); assert.equal(r.mode, 'sync'); assert.equal(r.data[0], f); }
  // A context that throws mid-readback drops to the synchronous path for good.
  const bad = fakeGL(), q = probeOn(bad);
  bad.fenceSync = () => { throw new Error('lost'); };
  render(q, bad, 1);
  assert.equal(q.read(1, { viewId: 'v', timeMs: 0 }).mode, 'sync');
  assert.equal(q.async, null);
});

test('only results of the same view, song, target size and timeline within the lag stand in for a frame', () => {
  const r = { frameId: 10, viewId: 'v', timeline: 1, timeMs: 1000, width: 64, height: 36 };
  const at = (o) => acceptProbeResult(r, { frameId: 11, viewId: 'v', timeline: 1, timeMs: 1016, width: 64, height: 36, ...o });
  assert.equal(at({}), true);
  assert.equal(at({ frameId: 10 }), false, 'never the same frame');
  assert.equal(at({ frameId: 10 + PROBE_MAX_LAG_FRAMES + 1 }), false);
  assert.equal(at({ viewId: 'w' }), false);
  assert.equal(at({ timeline: 2 }), false, 'another song (or a replay of it)');
  assert.equal(at({ width: 65 }), false);
  assert.equal(at({ height: 40 }), false, 'a resize of the height alone');
  assert.equal(at({ timeMs: 990 }), false, 'song time ran backwards');
  // Frame rate does not matter: a result 3 frames old at 5 fps stands in.
  assert.equal(at({ frameId: 13, timeMs: 1600 }), true);
});

test('seeks are found from the clocks at any frame rate', () => {
  const at = (timeMs, wallMs) => timelineJump({ timeMs: 1000, wallMs: 5000 }, { timeMs, wallMs });
  assert.equal(at(1016, 5016), false, '60 fps play');
  assert.equal(at(1200, 5200), false, '5 fps play');
  assert.equal(at(1000, 5016), false, 'a pause');
  assert.equal(at(3000, 7000), false, 'a hidden tab that kept playing');
  assert.equal(at(990, 5016), true, 'a backward seek');
  assert.equal(at(1116, 5016), true, 'a 100 ms forward seek at 60 fps');
  assert.equal(at(1800, 5200), true, 'a forward seek at 5 fps');
  assert.equal(timelineJump(null, { timeMs: 0, wallMs: 0 }), false);
});

test('a slow device (200 ms per frame) still reads asynchronously', () => {
  const gl = fakeGL(), p = probeOn(gl);
  const modes = [];
  for (let f = 1; f <= 10; f++) {
    gl.finish(); render(p, gl, f);
    const r = p.read(f, { viewId: 'v', timeline: 1, timeMs: f * 200, wallMs: 10000 + f * 200 });
    modes.push(r?.mode ?? 'none');
    if (f > 1) assert.equal(r.lag, 1);
  }
  assert.deepEqual(modes, ['none', ...Array(9).fill('async')]);
  assert.equal(p.renderer.syncReads, 0);
  // The GPU stalls for three frames at 5 fps: lag 2 and 3 are still served.
  const lags = [];
  for (let f = 11; f <= 13; f++) { render(p, gl, f); const r = p.read(f, { viewId: 'v', timeline: 1, timeMs: f * 200, wallMs: 10000 + f * 200 }); lags.push([r?.mode ?? 'none', r?.lag ?? 0]); }
  assert.deepEqual(lags, [['async', 2], ['async', 3], ['none', 0]]);
});

test('a short forward seek, a new song at the same time or a height change discards older results', () => {
  const gl = fakeGL(), p = probeOn(gl);
  const live = (f, o = {}) => { gl.finish(); render(p, gl, f); return p.read(f, { viewId: 'v', timeline: 1, timeMs: f * 16, wallMs: f * 16, ...o }); };
  for (let f = 1; f <= 3; f++) live(f);
  assert.equal(live(4).mode, 'async');
  // A 100 ms forward seek (well under any fixed time window).
  const seek = live(5, { timeMs: 5 * 16 + 100 });
  assert.equal(seek, null, 'a pre-seek result is never shown');
  assert.equal(live(6, { timeMs: 6 * 16 + 100 }).frameId, 5, 'the first read after the seek');
  // A replay of the song: same view, a similar time, a new timeline.
  assert.equal(live(7, { timeline: 2, timeMs: 6 * 16 + 116 }), null);
  assert.equal(live(8, { timeline: 2, timeMs: 6 * 16 + 132 }).mode, 'async');
  // A resize of the target height alone.
  p.height = 40;
  assert.equal(live(9, { timeline: 2, timeMs: 6 * 16 + 148 }), null, 'a result of the old height is not used');
  assert.equal(live(10, { timeline: 2, timeMs: 6 * 16 + 164 }).mode, 'async');
});
