import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDisplayPrefs, resolvePresentation, readDisplayPrefs, writeDisplayPrefs } from '../src/render/DisplayProfile.js';
import { PerfGovernor } from '../src/render/PerfGovernor.js';
import { DISPLAY_PREFS_KEY } from '../src/render/DisplayProfile.js';

const defaults = { version: 2, look: 'pixel', quality: 'auto', palette: 'world', dither: .35, ditherMode: 'selective', pixelGrid: 'classic', scaling: 'fit', pixelScale: 'original' };
const v1 = { version: 1, look: 'palette', quality: 'economy', palette: 'rgb332', dither: 1, scaling: 'integer' };
test('new and numeric legacy defaults use Pixel Classic Uniform with independent Auto quality', () => {
  assert.deepEqual(resolveDisplayPrefs({}), defaults);
  assert.deepEqual(resolveDisplayPrefs({ legacyStagePreset: 1080 }), defaults);
});
test('legacy modes migrate without losing Economy and RGB332', () => {
  assert.deepEqual(resolveDisplayPrefs({ legacyStagePreset: '8bit' }), { ...defaults, look: 'pixel', quality: 'economy', palette: 'range32', ditherMode: 'ordered', pixelScale: 'original' });
  assert.deepEqual(resolveDisplayPrefs({ legacyStagePreset: '8bit-intensive' }), { ...defaults, look: 'palette', quality: 'economy', palette: 'rgb332', dither: 1, ditherMode: 'ordered', pixelScale: 'original' });
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
  assert.deepEqual(resolvePresentation({ ...defaults, look: 'pixel' }), { pixelated: true, grid: { id: 'classic', width: 320, height: 180, pixels: 57600 }, paletteId: 'none', dither: .35, ditherMode: 'selective', quality: 'auto', scaling: 'fit', pixelScale: 'original' });
  assert.equal(resolvePresentation({ ...defaults, look: 'palette' }).paletteId, 'world');
  assert.equal(resolvePresentation(defaults).grid.id, 'classic');
});
test('blocked storage never prevents boot or a settings change', () => {
  const blocked = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
  assert.deepEqual(readDisplayPrefs(blocked), defaults);
  assert.equal(writeDisplayPrefs(blocked, defaults), false);
});
test('v1 choices migrate independently to Classic and Ordered without deleting storage', () => {
  assert.deepEqual(resolveDisplayPrefs({ saved: v1 }), { ...defaults, ...v1, version: 2, ditherMode: 'ordered', pixelScale: 'original' });
  assert.deepEqual(resolveDisplayPrefs({ saved: { ...v1, dither: -1, quality: 'garbage' } }), { ...defaults, look: 'palette', palette: 'rgb332', scaling: 'integer', ditherMode: 'ordered', pixelScale: 'original' });
  const records = new Map([['smw:display:v1', JSON.stringify(v1)]]);
  const storage = { getItem: k => records.get(k), setItem: (k, v) => records.set(k, v) };
  const migrated = readDisplayPrefs(storage);
  assert.equal(DISPLAY_PREFS_KEY, 'midio-pixel:display:v1');
  assert.deepEqual(migrated, { ...defaults, ...v1, version: 2, ditherMode: 'ordered', pixelScale: 'original' });
  assert.equal(writeDisplayPrefs(storage, migrated), true);
  assert.equal(records.get('smw:display:v1'), JSON.stringify(v1));
  assert.equal(records.has('smw:display:v2'), false);
  assert.ok(records.has(DISPLAY_PREFS_KEY));
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
  assert.equal(resolvePresentation({ ...saved, look: 'natural' }).grid.width, 640);
  assert.equal(resolveDisplayPrefs({ saved: { ...saved, pixelGrid: 'broken' } }).pixelGrid, 'classic');
});
for (const [pixelGrid, size] of [['classicPlus', [400, 225]], ['medium', [480, 270]]]) test(`${pixelGrid} survives valid v2 storage as a ${size.join('x')} grid`, () => {
  const saved = { ...defaults, look: 'pixel', pixelGrid, quality: 'auto' };
  assert.deepEqual(resolveDisplayPrefs({ saved }), saved);
  assert.deepEqual([resolvePresentation(saved).grid.width, resolvePresentation(saved).grid.height], size);
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

test('legacy v2 migration preserves every pixel option and leaves source storage untouched', () => {
  const legacy = { version: 2, look: 'palette', quality: 'auto', palette: 'chroma32', dither: 0, ditherMode: 'selective', pixelGrid: 'detailed', scaling: 'integer' };
  const records = new Map([['smw:display:v2', JSON.stringify(legacy)], ['smw:display:v1', JSON.stringify(v1)]]);
  const storage = { getItem: k => records.get(k), setItem: (k, v) => records.set(k, v) };
  const migrated = readDisplayPrefs(storage);
  assert.deepEqual(migrated, { ...legacy, pixelScale: 'original' });
  writeDisplayPrefs(storage, migrated);
  assert.equal(records.get('smw:display:v2'), JSON.stringify(legacy));
  records.set('smw:display:v2', JSON.stringify({ ...legacy, look: 'pixel' }));
  assert.deepEqual(readDisplayPrefs(storage), migrated, 'migration reads source only until own preferences exist');
});
test('stale Natural settings coerce to Pixel without pinning quality or losing display choices', () => {
  const stale = { ...defaults, look: 'natural', quality: 'auto', palette: 'chroma32', pixelGrid: 'detailed', scaling: 'integer' };
  const resolved = resolveDisplayPrefs({ saved: stale });
  assert.deepEqual(resolved, { ...stale, look: 'pixel' });
  const presentation = resolvePresentation(stale);
  assert.equal(presentation.pixelated, true);
  assert.equal(presentation.paletteId, 'none');
  assert.equal(presentation.grid.width, 640);
  assert.equal(presentation.quality, 'auto');
});
test('saved Depth and unknown pixel scale values migrate to Uniform without losing grid or quality', () => {
  for (const pixelScale of ['depth', 'original', 'random']) {
    const saved = { ...defaults, pixelScale, pixelGrid: 'detailed' };
    assert.deepEqual(resolveDisplayPrefs({ saved }), { ...saved, pixelScale: 'original' });
    assert.equal(resolvePresentation(saved).pixelScale, 'original');
    assert.equal(resolvePresentation(saved).quality, 'auto');
  }
});
test('persisted Depth preferences are read and rewritten as Uniform while legacy storage remains intact', () => {
  for (const key of [DISPLAY_PREFS_KEY, 'smw:display:v2']) {
    const saved = { ...defaults, pixelScale: 'depth', pixelGrid: 'detailed', quality: 'economy' };
    const original = JSON.stringify(saved), records = new Map([[key, original]]);
    const storage = { getItem: k => records.get(k), setItem: (k, v) => records.set(k, v) };
    const migrated = readDisplayPrefs(storage);
    assert.deepEqual(migrated, { ...saved, pixelScale: 'original' });
    assert.equal(writeDisplayPrefs(storage, migrated), true);
    assert.equal(JSON.parse(records.get(DISPLAY_PREFS_KEY)).pixelScale, 'original');
    if (key !== DISPLAY_PREFS_KEY) assert.equal(records.get(key), original);
  }
});
