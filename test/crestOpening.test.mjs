import test from 'node:test';
import assert from 'node:assert/strict';
import * as crestModule from '../src/world/alpine/RangeCrest.js';

test('the opening source footprint supplies no reconstructed ink until the overview settles', () => {
  assert.equal(typeof crestModule.crestBuildOpacity, 'function');
  for (const rise of [0, .05, .25, .55]) assert.equal(crestModule.crestBuildOpacity(rise), 0);
  assert.ok(Math.abs(crestModule.crestBuildOpacity(.625) - .5) < 1e-12);
  for (const rise of [.7, .9, 1, undefined]) assert.equal(crestModule.crestBuildOpacity(rise), 1);
});

test('crest cut, split and stroke share the same heard-time build opacity on isolated exports and seeks', () => {
  const crest = new crestModule.RangeCrest();
  const base = { qualityLevel: 4, scan: true, palette: 'rgb332', grid: { width: 8, height: 12 },
    viewId: 'source-view', instant: true };
  for (const [frameId, timeMs, opacity] of [[1, 15000, 0], [2, 200000, .5], [3, 15000, 0], [4, 300000, 1]]) {
    const snap = crest.update({ ...base, frameId, timeMs, opacity });
    assert.equal(snap.fade, opacity, 'all consumers see the same frozen opacity, including backwards seeks');
    if (opacity === 0) {
      assert.equal(crest.prepareGrid({}), false);
      assert.equal(crest.drawTerrain({}, { scale: 1 }, frameId, () => { throw new Error('opening must retain its uncut pixels'); }), false);
      assert.equal(crest.drawCrest({}, { scale: 1 }, frameId), true);
    }
  }
});
