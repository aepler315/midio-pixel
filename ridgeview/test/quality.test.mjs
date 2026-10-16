import test from 'node:test';
import assert from 'node:assert/strict';
import { TerrainTiles, QUALITY } from '../src/engine/TerrainTiles.js';
import { Engine } from '../src/engine/Engine.js';

const cases = [
  ...Object.keys(QUALITY).map(name => [name, name]),
  ['HIGH', 'high'], ['MeDiUm', 'medium'], ['bogus', 'high'], ['', 'high'],
  ['constructor', 'high'], ['__proto__', 'high'], ['toString', 'high'],
  [undefined, 'high'], [null, 'high'], [42, 'high'], [{}, 'high'],
];

test('TerrainTiles constructor and setter retain only canonical own-key quality names', () => {
  for (const [input, expected] of cases) {
    const tiles = new TerrainTiles({ dem: {}, globals: { uMicro: { value: -1 } }, quality: input, workers: 0 });
    assert.equal(tiles.qualityName, expected, String(input));
    assert.equal(tiles.q, QUALITY[expected]);
    assert.equal(tiles.globals.uMicro.value, QUALITY[expected].micro);
    for (const [next, resolved] of cases) {
      tiles.setQuality(next);
      assert.equal(tiles.qualityName, resolved);
      assert.equal(tiles.q, QUALITY[resolved]);
    }
  }
});

test('Engine setter resolves quality before consuming shadow and tree settings', () => {
  const oldWindow = globalThis.window;
  globalThis.window = { devicePixelRatio: 2 };
  try {
    for (const [input, expected] of cases) {
      const calls = [];
      const engine = {
        tiles: { setQuality: name => calls.push(['tiles', name]) },
        shadows: { setSize: size => calls.push(['shadows', size]) },
        trees: { setRange: range => calls.push(['trees', range]) },
        resize: () => calls.push(['resize']),
      };
      Engine.prototype.setQuality.call(engine, input);
      assert.deepEqual(calls, [['tiles', expected], ['shadows', QUALITY[expected].shadowSize], ['trees', QUALITY[expected].treeFar], ['resize']]);
      assert.equal(engine.trees.enabled, QUALITY[expected].treeFar > 0);
      assert.equal(engine.pixelRatio, expected === 'low' ? 1 : expected === 'medium' ? 1.25 : 2);
    }
  } finally {
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  }
});
