import test from 'node:test';
import assert from 'node:assert/strict';
import { GraphicsResidency, MiB } from '../src/render/GraphicsResidency.js';
import { RangePresentation, TRAVEL_SCRATCH_KEY } from '../src/world/alpine/RangePresentation.js';
import { sceneTargetBytes, sideTargetBytes } from '../src/world/alpine/RangeRenderPolicy.js';

// 1280x720 output with a 64px margin and a 320x180 design grid.
const viewport = { backingWidth: 1408, backingHeight: 848 };
const outputSize = { width: 1280, height: 720 };
const nativeBytes = sceneTargetBytes(352, 212);
const fineBytes = sceneTargetBytes(528, 318);
const travelTargets = [
  ['range:render-target-B', sideTargetBytes(352, 212)],
  [TRAVEL_SCRATCH_KEY, viewport.backingWidth * viewport.backingHeight * 4],
];
const waterTargets = [
  ['range:water-output', sceneTargetBytes(viewport.backingWidth, viewport.backingHeight)],
  ['range:water-layer', outputSize.width * outputSize.height * 4],
];
const hybridWaterTargets = [
  ...waterTargets,
  ['range:water-native-mask', sceneTargetBytes(352, 212)],
  ['range:water-shore-mask', 320 * 180 * 4],
  ['range:water-effect-mask', 320 * 180 * 4],
];

for (const [name, device, budgetMiB, travel, wet, required] of [
  ['travel', 'desktop', 256, viewport, false, travelTargets],
  ['water', 'desktop', 256, null, true, waterTargets],
  ['wet travel', 'desktop', 256, viewport, true, [...travelTargets, ...waterTargets]],
  ['wet travel on a low-memory mobile device', 'mobile', 192, viewport, true, [...travelTargets, ...waterTargets]],
  ['hybrid water', 'desktop', 256, null, true, hybridWaterTargets],
]) test(`optional terrain coverage preserves ${name} under residency pressure`, () => {
  const residency = new GraphicsResidency({ budgetBytes: budgetMiB * MiB });
  function allocate(key, bytes) {
    const reservation = residency.reserve({ key, bytes, owner: 'fixture' });
    assert.ok(reservation, key);
    assert.ok(residency.commit(reservation, { key }));
  }
  const needed = nativeBytes + required.reduce((sum, [, bytes]) => sum + bytes, 0);
  allocate('scenery', residency.budgetBytes - needed - 1024);
  assert.ok(residency.budgetBytes - residency.usedBytes > fineBytes, 'the fine main target alone would fit');
  const sizes = [];
  const presentation = Object.assign(Object.create(RangePresentation.prototype), {
    directTerrainMode: name !== 'hybrid water', freePixelMotion: true, pixelated: true, budget: device,
    residency, outputSize, waterOutputSize: outputSize, pixelPolicy: { grid: { width: 320, height: 180 } },
    scene: { resize(options) { sizes.push(options.widthPx); } },
  });
  const scenicViewport = presentation.directTerrainMode ? viewport : { backingWidth: 352, backingHeight: 212 };
  presentation._resizeTerrain(scenicViewport, 0, travel, wet);
  assert.equal(sizes.at(-1), 352);
  allocate('range:render-target', nativeBytes);
  for (const [key, bytes] of required) allocate(key, bytes);
  presentation._resizeTerrain(scenicViewport, 0, travel, wet);
  assert.deepEqual(sizes, [352, 352], 'no attempt to grow and tear down the working targets');
  assert.ok(residency.has('scenery'), 'resident art survived the optional allocation');
  assert.equal(residency.denials, 0);
});
