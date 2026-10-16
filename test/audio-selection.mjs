import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioSelection } from '../src/audio/AudioSelection.js';

test('new-selection-synchronously-aborts-the-preceding-ticket', () => {
  const owner = createAudioSelection();
  const a = owner.begin('plex'), b = owner.begin('local');
  assert.equal(a.signal.aborted, true);
  assert.equal(owner.isCurrent(a), false);
  assert.equal(owner.isCurrent(b), true);
  owner.cancel();
  assert.equal(b.signal.aborted, true);
  assert.equal(owner.isCurrent(b), false);
});
test('stale-cleanup-cannot-cancel-a-newer-selection', () => {
  const owner = createAudioSelection();
  const a = owner.begin('plex'), b = owner.begin('url');
  owner.cancel(a);
  assert.equal(owner.isCurrent(b), true);
  assert.equal(b.signal.aborted, false);
});
for (const [aSource, bSource] of [['plex','local'],['local','plex'],['url','plex'],['plex','url'],['plex','plex']]) {
  for (const phase of ['fetch', 'decode', 'analysis']) {
    test(`${aSource}-followed-by-${bSource}-only-current-commits-during-${phase}`, async () => {
      const owner = createAudioSelection(), committed = [];
      let unblock, reached;
      const barrier = new Promise(resolve => { unblock = resolve; });
      const started = new Promise(resolve => { reached = resolve; });
      const run = async (ticket, wait) => {
        for (const step of ['fetch','decode','analysis']) {
          if (step === phase && wait) { reached(); await barrier; }
          if (!owner.isCurrent(ticket)) return;
        }
        committed.push(ticket.id);
      };
      const a = owner.begin(aSource), pending = run(a, true);
      await started;
      const b = owner.begin(bSource);
      await run(b, false);
      unblock(); await pending;
      assert.deepEqual(committed, [b.id]);
    });
  }
}
