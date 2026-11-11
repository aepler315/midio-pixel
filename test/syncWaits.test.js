import test from 'node:test';
import assert from 'node:assert/strict';
import { noteSyncWait, takeSyncWaits, resetSyncWaits, lastSyncWaits } from '../src/render/SyncWaits.js';

test('synchronous waits sum per frame by site and start over each frame', () => {
  resetSyncWaits();
  noteSyncWait('crestRead', 2); noteSyncWait('crestEdges', 0.5); noteSyncWait('presenter', 1.5); noteSyncWait('presenter', 1);
  noteSyncWait('nonsense', 4); noteSyncWait('presenter', NaN); noteSyncWait('presenter', -1);
  assert.equal(takeSyncWaits(), 9);
  assert.deepEqual(lastSyncWaits(), { crestRead: 2, crestEdges: 0.5, probeCollect: 0, presenter: 2.5, total: 9, calls: 5 });
  assert.equal(takeSyncWaits(), 0, 'a new frame starts at zero');
  noteSyncWait('crestRead', 3); resetSyncWaits();
  assert.equal(takeSyncWaits(), 0, 'waits outside a measured frame are discarded');
});
