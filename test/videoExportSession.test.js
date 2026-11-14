import test from 'node:test';
import assert from 'node:assert/strict';
import { VideoExportSession, waitForExport } from '../src/ui/VideoExportSession.js';

test('an export owns one run, reports progress, and restores before releasing busy', async () => {
  const phases = [], order = [];
  const session = new VideoExportSession({ onState: state => phases.push(state.phase) });
  const run = session.run({
    prepare: async () => { order.push('prepare'); return 42; },
    encode: async (context, { onProgress }) => { assert.equal(context, 42); onProgress({ progress: .5 }); order.push('encode'); return 'mp4'; },
    restore: async () => { assert.equal(session.busy, true); order.push('restore'); },
  });
  assert.equal(session.busy, true);
  await assert.rejects(session.run({}), /already/);
  assert.equal(await run, 'mp4');
  assert.deepEqual(order, ['prepare', 'encode', 'restore']);
  assert.ok(phases.includes('encoding'));
  assert.equal(session.state.phase, 'complete');
  assert.equal(session.busy, false);
});

test('cancel interrupts preparation, restores the owned scene, and never starts the encoder', async () => {
  const session = new VideoExportSession();
  let encoded = false, restored = 0;
  const run = session.run({
    prepare: signal => waitForExport(new Promise(() => {}), signal),
    encode: async () => { encoded = true; },
    restore: async () => { restored++; },
  });
  session.cancel();
  assert.equal(await run, null);
  assert.equal(encoded, false);
  assert.equal(restored, 1);
  assert.equal(session.state.phase, 'cancelled');
  assert.equal(session.busy, false);
});

test('encoder errors still restore the scene and propagate an honest failure', async () => {
  const session = new VideoExportSession();
  let restored = false;
  await assert.rejects(session.run({
    prepare: async () => ({}),
    encode: async () => { throw Error('AAC unavailable'); },
    restore: async () => { restored = true; },
  }), /AAC unavailable/);
  assert.equal(restored, true);
  assert.equal(session.state.phase, 'error');
  assert.equal(session.busy, false);
});

test('a superseded export never restores over a newly selected song', async () => {
  const session = new VideoExportSession();
  let current = true, restored = false, discarded = false;
  assert.equal(await session.run({
    prepare: async () => { current = false; return {}; },
    encode: async () => assert.fail('stale export encoded'),
    restore: async () => { restored = true; },
    discard: async () => { discarded = true; },
    isCurrent: () => current,
  }), null);
  assert.equal(restored, false);
  assert.equal(discarded, true, 'superseded output must release only its own renderer');
  assert.equal(session.state.phase, 'cancelled');
});

test('restoration failure is reported and does not permanently lock exports', async () => {
  const session = new VideoExportSession();
  await assert.rejects(session.run({ prepare: async () => ({}), encode: async () => 'file',
    restore: async () => { throw Error('restore failed'); } }), /restore failed/);
  assert.equal(session.busy, false);
  assert.equal(session.state.phase, 'error');
});

test('abortable waits reject immediately for an already aborted signal', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(waitForExport(Promise.resolve(1), controller.signal), { name: 'AbortError' });
});
