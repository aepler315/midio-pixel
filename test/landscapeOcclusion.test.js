import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleCrestFraction, bodyAreaFraction } from '../tools/lib/landscape-visibility.mjs';

test('crest visibility interpolates by x and names the occluder', () => {
  const crest = [{ x: 0, y: 100 }, { x: 100, y: 100 }];
  const open = visibleCrestFraction(crest, []);
  assert.equal(open.fraction, 1);
  assert.equal(open.longestRun, 1);
  const blocked = visibleCrestFraction(crest, [
    { id: 'L5', samples: [{ x: 0, y: 80 }, { x: 100, y: 80 }] },
  ]);
  assert.equal(blocked.fraction, 0);
  assert.equal(blocked.dominant, 'L5');
  const ground = visibleCrestFraction(crest, [
    { id: 'ground', samples: [{ x: 0, y: 140 }, { x: 100, y: 140 }] },
  ]);
  assert.equal(ground.fraction, 1);
  const half = visibleCrestFraction(
    [{ x: 0, y: 100 }, { x: 50, y: 100 }, { x: 100, y: 100 }],
    [{ id: 'L4', samples: [{ x: 0, y: 90 }, { x: 40, y: 90 }, { x: 100, y: 140 }] }],
  );
  assert.ok(half.fraction > 0 && half.fraction < 1);
});

test('a partial massif mask only hides the crest inside its true span', () => {
  const crest = [0, 25, 50, 75, 100].map(x => ({ x, y: 100 }));
  const result = visibleCrestFraction(crest, [
    { id: 'massif', samples: [{ x: 30, y: 80 }, { x: 70, y: 80 }] },
  ]);
  assert.equal(result.fraction, 0.8);
  assert.equal(result.longestRun, 0.4);
});

test('body area measures the rendered ground curve rather than a nominal screen fraction', () => {
  const crest = [{ x: 0, y: 40 }, { x: 100, y: 40 }];
  const ground = [{ x: 0, y: 60 }, { x: 100, y: 80 }];
  assert.equal(bodyAreaFraction(crest, ground, 100, 100), .3);
  assert.equal(bodyAreaFraction(crest, [], 100, 100), null);
});
