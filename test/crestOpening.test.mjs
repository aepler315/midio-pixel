import test from 'node:test';
import assert from 'node:assert/strict';
import * as crestModule from '../src/world/alpine/RangeCrest.js';

test('the opening source footprint supplies no reconstructed ink until the overview settles', () => {
  assert.equal(typeof crestModule.crestBuildOpacity, 'function');
  for (const rise of [0, .05, .25, .55]) assert.equal(crestModule.crestBuildOpacity(rise), 0);
  assert.ok(Math.abs(crestModule.crestBuildOpacity(.625) - .5) < 1e-12);
  for (const rise of [.7, .9, 1, undefined]) assert.equal(crestModule.crestBuildOpacity(rise), 1);
});

/** A probe over an 8x12 grid with fine output geometry, as crestGeometry.test.mjs builds it. */
function probe() {
  const W = 8, H = 12, F = 6, layout = { width: W * F, height: H * F, row: 20, rowsPerBand: 3, edgeRow: 29 };
  const data = new Uint8Array(W * layout.edgeRow * 4);
  for (let j = 0; j < W; j++) { const o = j * 4; data[o] = 5; data[o + 2] = 128; data[o + 3] = 255; }
  for (let i = 0; i < W * F; i++) {
    const pixel = Math.floor(i / 2), o = ((layout.row + Math.floor(pixel / W)) * W + pixel % W) * 4 + i % 2 * 2;
    data[o] = (i === 2 ? 22 : 24) + 1;
  }
  return { width: W, height: H, data, rows: 3, fine: layout };
}

// Without a probe there is no crest at all (the palette-frame scan went with
// the Palette look), so export frames carry one, as the export path does on
// every rung: refined with split cells at q0, light (no split cells) at q4.
test('crest cut, split and stroke share the same heard-time build opacity on isolated exports and seeks', () => {
  for (const qualityLevel of [0, 4]) {
    const crest = new crestModule.RangeCrest({ makeCanvas: (width, height) => ({ width, height,
      getContext: () => ({ setTransform() {}, clearRect() {}, drawImage() {} }) }) });
    const base = { probe: probe(), qualityLevel, grid: { width: 8, height: 12 }, stage: { width: 8, height: 12 },
      transform: [1, 0, 0, 1, 0, 0], viewId: 'source-view', instant: true };
    for (const [frameId, timeMs, opacity] of [[1, 15000, 0], [2, 200000, .5], [3, 15000, 0], [4, 300000, 1]]) {
      const snap = crest.update({ ...base, frameId, timeMs, opacity });
      assert.equal(snap.fade, opacity, `q${qualityLevel}: all consumers see the same frozen opacity, including backwards seeks`);
      assert.equal(snap.cut, true);
      assert.equal(snap.split, qualityLevel === 0, `q${qualityLevel}: split cells only below the split rung`);
      if (opacity === 0) {
        assert.equal(crest.prepareGrid({}), false);
        assert.equal(crest.drawTerrain({}, { scale: 1 }, frameId, () => { throw new Error('opening must retain its uncut pixels'); }), false);
        assert.equal(crest.drawCrest({}, { scale: 1 }, frameId), true);
      }
    }
  }
});
