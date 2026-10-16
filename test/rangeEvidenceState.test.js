import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertCaptureState, buildManifest } from '../tools/lib/landscape-evidence.mjs';

test('capture state passes only when the requested rung drew exactly once', () => {
  assert.equal(assertCaptureState({ quality: { requested: 6, actual: 6 }, finalDraws: 1 }), true);
  assert.throws(() => assertCaptureState({ quality: { requested: 6, actual: 0 }, finalDraws: 1 }), /quality 0 !== requested 6/);
  assert.throws(() => assertCaptureState({ quality: { requested: 0, actual: 0 }, finalDraws: 2 }), /2 times/);
  assert.throws(() => assertCaptureState({ quality: { requested: 0, actual: 0 }, finalDraws: 0 }), /0 times/);
  assert.throws(() => assertCaptureState({}), /quality/);
});

test('manifest records what actually produced the frame', () => {
  const m = buildManifest({ caseId: 'x', quality: { requested: 6, actual: 6 }, finalDraws: 1,
    generation: 3, renderer: 'canvas', rangeRenderer: 'legacy', passes: { disabled: ['film'] } });
  assert.deepEqual(m.quality, { requested: 6, actual: 6 });
  assert.equal(m.finalDraws, 1);
  assert.equal(m.generation, 3);
  assert.equal(m.renderer, 'canvas');
  assert.equal(m.rangeRenderer, 'legacy');
  assert.deepEqual(m.passes, { disabled: ['film'] });
});
