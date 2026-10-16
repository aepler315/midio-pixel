import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDisplayPrefs, resolvePresentation, readDisplayPrefs, writeDisplayPrefs } from '../src/render/DisplayProfile.js';
import { PerfGovernor } from '../src/render/PerfGovernor.js';
import { DISPLAY_PREFS_KEY } from '../src/render/DisplayProfile.js';

const defaults = { version: 2, look: 'natural', quality: 'auto', palette: 'world', dither: .35, ditherMode: 'selective', pixelGrid: 'classic', scaling: 'fit' };
const v1 = { version: 1, look: 'palette', quality: 'economy', palette: 'rgb332', dither: 1, scaling: 'integer' };
test('default and numeric resolutions keep Natural Auto', () => {
  assert.deepEqual(resolveDisplayPrefs({}), defaults);
  assert.deepEqual(resolveDisplayPrefs({ legacyStagePreset: 1080 }), defaults);
});
test('legacy modes migrate without losing Economy and RGB332', () => {
  assert.deepEqual(resolveDisplayPrefs({ legacyStagePreset: '8bit' }), { ...defaults, look: 'pixel', quality: 'economy', palette: 'range32', ditherMode: 'ordered' });
  assert.deepEqual(resolveDisplayPrefs({ legacyStagePreset: '8bit-intensive' }), { ...defaults, look: 'palette', quality: 'economy', palette: 'rgb332', dither: 1, ditherMode: 'ordered' });
});
test('validated saved settings take precedence; malformed input has usable defaults', () => {
  const saved = { ...defaults, look: 'palette', scaling: 'integer' };
  assert.deepEqual(resolveDisplayPrefs({ saved: JSON.stringify(saved), legacyStagePreset: '8bit' }), saved);
  for (const value of ['bad', '{}', '{"version":1,"look":"garbage"}', 'null']) {
    assert.deepEqual(resolveDisplayPrefs({ saved: value }), defaults);
  }
  assert.deepEqual(resolveDisplayPrefs({ saved: { ...saved, dither: -1, pixelGrid: 'unknown' } }), saved);
});
test('pixel grid and palette selection are independent of quality', () => {
  assert.deepEqual(resolvePresentation({ ...defaults, look: 'pixel' }), { pixelated: true, grid: { id: 'classic', width: 320, height: 180, pixels: 57600 }, paletteId: 'none', dither: .35, ditherMode: 'selective', quality: 'auto', scaling: 'fit' });
  assert.equal(resolvePresentation({ ...defaults, look: 'palette' }).paletteId, 'world');
  assert.equal(resolvePresentation(defaults).grid, null);
});
test('blocked storage never prevents boot or a settings change', () => {
  const blocked = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
  assert.deepEqual(readDisplayPrefs(blocked), defaults);
  assert.equal(writeDisplayPrefs(blocked, defaults), false);
});
test('v1 choices migrate independently to Classic and Ordered without deleting storage', () => {
  assert.deepEqual(resolveDisplayPrefs({ saved: v1 }), { ...defaults, ...v1, version: 2, ditherMode: 'ordered' });
  assert.deepEqual(resolveDisplayPrefs({ saved: { ...v1, dither: -1, quality: 'garbage' } }), { ...defaults, look: 'palette', palette: 'rgb332', scaling: 'integer', ditherMode: 'ordered' });
  const records = new Map([['smw:display:v1', JSON.stringify(v1)]]);
  const storage = { getItem: k => records.get(k), setItem: (k, v) => records.set(k, v) };
  const migrated = readDisplayPrefs(storage);
  assert.equal(DISPLAY_PREFS_KEY, 'smw:display:v2');
  assert.deepEqual(migrated, { ...defaults, ...v1, version: 2, ditherMode: 'ordered' });
  assert.equal(writeDisplayPrefs(storage, migrated), true);
  assert.ok(records.has('smw:display:v1')); assert.ok(records.has('smw:display:v2'));
});
test('valid v2 takes precedence; invalid v2 falls through to v1 and legacy stage', () => {
  const v2 = { ...defaults, look: 'palette', palette: 'chroma32' };
  const records = new Map([['smw:display:v2', JSON.stringify(v2)], ['smw:display:v1', JSON.stringify(v1)], ['smw:stageRes', '8bit']]);
  const storage = { getItem: k => records.get(k) };
  assert.deepEqual(readDisplayPrefs(storage), v2);
  records.set('smw:display:v2', '{broken');
  assert.equal(readDisplayPrefs(storage).palette, 'rgb332');
  records.delete('smw:display:v1');
  assert.equal(readDisplayPrefs(storage).look, 'pixel');
});
test('Detailed survives valid v2 storage, without changing look or quality', () => {
  const saved = { ...defaults, look: 'pixel', pixelGrid: 'detailed', quality: 'auto' };
  assert.deepEqual(resolveDisplayPrefs({ saved }), saved);
  assert.equal(resolvePresentation(saved).grid.width, 640);
  assert.equal(resolvePresentation(saved).grid.height, 360);
  assert.equal(resolvePresentation({ ...saved, look: 'natural' }).grid, null);
  assert.equal(resolveDisplayPrefs({ saved: { ...saved, pixelGrid: 'broken' } }).pixelGrid, 'classic');
});
test('Economy stays pinned over two clean minutes while Pixel Auto keeps device quality', () => {
  const auto = new PerfGovernor({ startLevel: 2, economy: false });
  assert.equal(auto.level, 2);
  const economy = new PerfGovernor({ economy: true });
  for (let t = 0; t < 120000; t += 16) economy.sample(16, t);
  assert.equal(economy.level, 6);
  economy.economy = false;
  assert.equal(economy.economy, false);
});
test('offline rendering freezes the effective quality rather than forcing full quality', () => {
  const governor = new PerfGovernor({ startLevel: 3 });
  governor.freezeQuality();
  for (let t = 0; t < 120000; t += 1000) governor.sample(1000, t);
  assert.equal(governor.level, 3);
});
