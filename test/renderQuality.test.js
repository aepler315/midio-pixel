import { test } from 'node:test';
import assert from 'node:assert/strict';

test('general quality migrates economy while keeping a separately stored render budget', async () => {
  const q = await import('../src/render/RenderQuality.js');
  assert.equal(q.readRenderQuality(null, 'economy'), 'low');
  assert.equal(q.readRenderQuality({ getItem: () => 'medium' }), 'medium');
  assert.equal(q.renderQualityLevel('low'), 6);
  assert.equal(q.renderQualityLevel('medium'), 3);
  assert.equal(q.renderQualityLevel('high'), 0);
  assert.equal(q.readRenderQuality({ getItem() { throw new Error('private'); } }), 'high');
});
