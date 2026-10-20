import test from 'node:test';
import assert from 'node:assert/strict';
import { RangePresentation } from '../src/world/alpine/RangePresentation.js';

for (const cancellation of ['same-generation replay', 'disposal', 'signal']) {
  test(`readiness stops obsolete preparation and pins after ${cancellation}`, async () => {
    const presentation = new RangePresentation({ mode: 'v2' });
    presentation.setSong({ generation: 7 });
    presentation.runtimeState = 'ready';
    const calls = [], controller = new AbortController();
    presentation.scene = { prepared: new Map(), contextLost: false, isReady: () => false,
      pinView: ids => calls.push(['pin', ids]), dispose() {}, snapshot: () => ({}) };
    presentation._songViews = () => [{ id: 'obsolete-view' }];
    presentation._prepare = view => {
      calls.push(['prepare', view.id]);
      if (calls.length === 1) queueMicrotask(() => {
        if (cancellation === 'same-generation replay') presentation.setSong({ generation: 7 });
        else if (cancellation === 'disposal') presentation.dispose();
        else controller.abort();
      });
    };
    await assert.rejects(presentation.whenReady({ timeoutMs: 80, signal: controller.signal }), { name: 'AbortError' });
    assert.deepEqual(calls, [['prepare', 'obsolete-view']], 'no old view can be retried or pinned after ownership changes');
    if (cancellation === 'same-generation replay') assert.equal(presentation.generation, 7);
  });
}
