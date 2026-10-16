import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRangeComposition, compositionErrors, compositionBars } from '../src/world/alpine/RangeComposition.js';
import { buildRockStage } from '../src/world/alpine/RockStage.js';

const ledge = { foreground: 'ledge', nearLedgeMaxFrac: .12 };
test('saved ledge metadata resolves to no foreground while tour ownership remains unspecified', () => {
  assert.deepEqual(resolveRangeComposition({ composition: ledge }), { foreground: 'none', nearLedgeMaxFrac: 0 });
  assert.equal(resolveRangeComposition({ id: 'teton-range-tour' }), null);
});
test('composition is optional, strict and deterministic', () => {
  assert.equal(resolveRangeComposition({}), null);
  assert.deepEqual(resolveRangeComposition({ composition: ledge }), { foreground: 'none', nearLedgeMaxFrac: 0 });
  for (const value of [null, {}, { ...ledge, foreground: 'sea' }, { ...ledge, nearLedgeMaxFrac: NaN }, { ...ledge, nearLedgeMaxFrac: .13 }, { ...ledge, nearLedgeMaxFrac: -.1 }]) {
    assert.ok(compositionErrors({ composition: value }).length);
    assert.throws(() => resolveRangeComposition({ composition: value }));
  }
});
test('one shallow ledge uses nominal height and one support curve without pools or striped risers', () => {
  const bars = Array.from({ length: 80 }, (_, i) => ({ x: i * 18, width: 18, y: 540 + Math.sin(i) * 90 }));
  const vp = { nominalHeight: 720, logicalHeight: 848, overscanPx: 64 };
  const framed = compositionBars(bars, vp, ledge, 51);
  for (const b of framed) assert.ok(b.y + 51 >= 64 + 720 * .88 && b.y + 51 <= 784);
  assert.deepEqual(compositionBars(bars, vp, null), bars);
  assert.deepEqual(compositionBars(bars, vp, { foreground: 'none', nearLedgeMaxFrac: 0 }), []);
  const stage = buildRockStage({ bars: framed, width: 1408, height: 848, slabCount: 1 });
  assert.equal(stage.pools.length, 0);
  assert.ok([...stage.surfaces].every(s => s < 1), 'no full-width repeated risers');
  assert.equal(stage.contactY(9), framed[0].y);
});
