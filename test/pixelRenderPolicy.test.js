import test from 'node:test';
import assert from 'node:assert/strict';

const policy = await import('../src/render/PixelRenderPolicy.js').catch(() => ({}));
test('Natural has no grid or pixel-specific dimensions', () => {
  assert.equal(typeof policy.pixelRenderPolicy, 'function');
  assert.deepEqual(policy.pixelRenderPolicy({ pixelated: false }), {
    active: false, grid: null, unit: 0, minGlyphHeight: 0, heatMaxOffset: 0, materialMinPeriodPx: 0, pixelScale: 'original',
  });
});
test('Classic dimensions and rendering policy are frozen and shared', () => {
  assert.equal(typeof policy.pixelGrid, 'function');
  const grid = policy.pixelGrid();
  assert.deepEqual(grid, { id: 'classic', width: 320, height: 180, pixels: 57600 });
  assert.equal(grid, policy.pixelGrid('classic'));
  assert.ok(Object.isFrozen(grid));
  const active = policy.pixelRenderPolicy({ pixelated: true, grid });
  assert.deepEqual(active, { active: true, grid, unit: 1, minGlyphHeight: 7, heatMaxOffset: 1, materialMinPeriodPx: 2, pixelScale: 'depth' });
  assert.ok(Object.isFrozen(active));
});
test('Depth is the pixel default and Original remains an explicit independent comparison', () => {
  assert.equal(policy.pixelRenderPolicy({ pixelated: true }).pixelScale, 'depth');
  assert.equal(policy.pixelRenderPolicy({ pixelated: true, pixelScale: 'original' }).pixelScale, 'original');
  assert.equal(policy.pixelRenderPolicy({ pixelated: true, pixelScale: 'unknown' }).pixelScale, 'depth');
  assert.equal(policy.pixelRenderPolicy({ pixelated: false, pixelScale: 'depth' }).pixelScale, 'original');
});
test('motion preference independently disables pixel heat', () => {
  assert.equal(typeof policy.pixelRenderPolicy, 'function');
  assert.equal(policy.pixelRenderPolicy({ pixelated: true, reducedMotion: true, reducedFlash: false }).heatMaxOffset, 0);
  assert.equal(policy.pixelRenderPolicy({ pixelated: true, reducedMotion: false, reducedFlash: true }).heatMaxOffset, 1);
});
test('Detailed is an opt-in frozen grid with doubled pixel-space dimensions', () => {
  const grid = policy.pixelGrid('detailed');
  assert.deepEqual(grid, { id: 'detailed', width: 640, height: 360, pixels: 230400 });
  assert.ok(Object.isFrozen(grid));
  const active = policy.pixelRenderPolicy({ pixelated: true, grid });
  assert.equal(active.unit, 2); assert.equal(active.minGlyphHeight, 14); assert.equal(active.heatMaxOffset, 2);
  assert.equal(active.materialMinPeriodPx, 2);
  assert.equal(policy.pixelGrid('arbitrary'), policy.pixelGrid('classic'));
  assert.equal(policy.pixelRenderPolicy({ pixelated: false, grid }).grid, null);
});
test('unknown prototype-named grid IDs fall back to Classic', () => {
  for (const id of ['constructor', 'toString', '__proto__']) assert.equal(policy.pixelGrid(id), policy.pixelGrid());
});
