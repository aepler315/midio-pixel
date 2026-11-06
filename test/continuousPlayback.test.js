import test from 'node:test';
import assert from 'node:assert/strict';

const { ContinuousPlayback } = await import('../src/library/ContinuousPlayback.js');
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
function clock() {
  let now = 0, serial = 0; const timers = new Map();
  return { now: () => now, setTimer(fn, ms) { const id = ++serial; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimer: id => timers.delete(id), async advance(ms) {
      const end = now + ms;
      for (;;) { const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at; timers.delete(next[0]); next[1].fn(); await flush();
      }
      now = end; await flush();
    } };
}

test('five second countdown starts only after recording has finalized', async () => {
  const time = clock(); let finish, starts = 0;
  const ready = new Promise(resolve => { finish = resolve; });
  const playback = new ContinuousPlayback(time);
  const ticket = playback.schedule({ ready, start: () => { starts++; } });
  await time.advance(20000); assert.equal(starts, 0); assert.equal(playback.snapshot.phase, 'finalizing');
  finish(); await flush(); assert.equal(playback.snapshot.remainingSeconds, 5);
  await time.advance(4999); assert.equal(starts, 0);
  await time.advance(1); assert.equal(starts, 1); assert.equal(playback.snapshot.phase, 'idle');
  assert.equal(ticket.signal.aborted, false, 'a completed handoff must not abort the playing selection');
});

test('cancel and superseding completion prevent stale readiness from starting a song', async () => {
  const time = clock(); let finish, starts = 0;
  const playback = new ContinuousPlayback(time);
  const old = playback.schedule({ ready: new Promise(resolve => { finish = resolve; }), start: () => { starts++; } });
  playback.cancel('Next song cancelled.'); finish(); await flush(); await time.advance(10000);
  assert.equal(starts, 0); assert.equal(old.signal.aborted, true);
  playback.schedule({ start: () => { starts++; } }); await flush();
  playback.schedule({ start: () => { starts += 10; } }); await flush();
  await time.advance(5000); assert.equal(starts, 10);
});

test('cancelling an in-flight start revokes its ticket and suppresses its late status', async () => {
  const time = clock(); let settle;
  const playback = new ContinuousPlayback(time);
  const ticket = playback.schedule({ start: () => new Promise(resolve => { settle = resolve; }) });
  await flush(); await time.advance(5000); assert.equal(playback.isCurrent(ticket), true);
  playback.cancel('Cancelled.'); settle({ message: 'Old failure' }); await flush();
  assert.equal(playback.isCurrent(ticket), false); assert.equal(playback.snapshot.message, 'Cancelled.');
});

test('failed finalization stops visibly rather than advancing', async () => {
  const playback = new ContinuousPlayback(); let starts = 0;
  playback.schedule({ ready: Promise.reject(new Error('Save failed')), start: () => { starts++; } });
  await flush(); assert.equal(starts, 0); assert.match(playback.snapshot.message, /Save failed/);
});

test('default browser timers never receive the playback instance as their receiver', () => {
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
  const pending = new Set(); let serial = 0;
  function browserSet() {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    const timer = ++serial; pending.add(timer); return timer;
  }
  function browserClear(timer) {
    if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
    pending.delete(timer);
  }
  try {
    globalThis.setTimeout = browserSet; globalThis.clearTimeout = browserClear;
    const playback = new ContinuousPlayback();
    assert.doesNotThrow(() => {
      playback.timer = playback.setTimer(() => {}, 1000);
      playback.cancel();
    });
    assert.equal(pending.size, 0);
  } finally {
    globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear;
  }
});
