import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDisplayPrefs, resolvePresentation, readDisplayPrefs, writeDisplayPrefs } from '../src/render/DisplayProfile.js';
import { PerfGovernor } from '../src/render/PerfGovernor.js';
import { DISPLAY_PREFS_KEY } from '../src/render/DisplayProfile.js';

// Cinematic is the only look. Records saved under the removed Pixel, Palette
// and Natural looks still migrate; their palette and dither choices drop out.
const defaults = { version: 2, look: 'cinematic', quality: 'auto', pixelGrid: 'detailed', scaling: 'fit', pixelScale: 'original', buildPixelDetail: true };
const v1 = { version: 1, look: 'palette', quality: 'economy', palette: 'rgb332', dither: 1, scaling: 'integer' };
test('new and numeric legacy defaults use Cinematic Detailed Uniform with independent Auto quality', () => {
  assert.deepEqual(resolveDisplayPrefs({}), defaults);
  assert.deepEqual(resolveDisplayPrefs({ legacyStagePreset: 1080 }), defaults);
});
test('both retired 8-bit stage presets migrate keeping Economy', () => {
  for (const legacyStagePreset of ['8bit', '8bit-intensive']) {
    assert.deepEqual(resolveDisplayPrefs({ legacyStagePreset }), { ...defaults, quality: 'economy' });
  }
});
test('validated saved settings take precedence; malformed input has usable defaults', () => {
  const saved = { ...defaults, pixelGrid: 'medium', scaling: 'integer' };
  assert.deepEqual(resolveDisplayPrefs({ saved: JSON.stringify(saved), legacyStagePreset: '8bit' }), saved);
  for (const value of ['bad', '{}', '{"version":1,"look":"garbage"}', 'null']) {
    assert.deepEqual(resolveDisplayPrefs({ saved: value }), defaults);
  }
  assert.deepEqual(resolveDisplayPrefs({ saved: { ...saved, quality: 'garbage', scaling: 'stretch' } }), { ...saved, quality: 'auto', scaling: 'fit' });
  assert.deepEqual(resolveDisplayPrefs({ saved: { ...saved, pixelGrid: 'unknown' } }), { ...saved, pixelGrid: 'detailed' });
});
test('the Cinematic presentation keeps pixel grid and quality independent and carries no palette or dither', () => {
  assert.deepEqual(resolvePresentation(defaults), { pixelated: true, cinematicPixel: true, buildPixelDetail: true,
    grid: { id: 'detailed', width: 640, height: 360, pixels: 230400 }, quality: 'auto', scaling: 'fit', pixelScale: 'original' });
  const economy = resolvePresentation({ ...defaults, pixelGrid: 'classic', quality: 'economy' });
  assert.equal(economy.grid.id, 'classic');
  assert.equal(economy.quality, 'economy');
  // Records of the removed looks present as Cinematic too.
  for (const look of ['pixel', 'palette', 'natural']) {
    const presentation = resolvePresentation({ ...defaults, look, palette: 'chroma32', dither: 1, ditherMode: 'ordered' });
    assert.equal(presentation.cinematicPixel, true, look);
    for (const removed of ['paletteId', 'dither', 'ditherMode']) assert.equal(removed in presentation, false, `${look}: ${removed}`);
  }
});
test('blocked storage never prevents boot or a settings change', () => {
  const blocked = { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } };
  assert.deepEqual(readDisplayPrefs(blocked), defaults);
  assert.equal(writeDisplayPrefs(blocked, defaults), false);
});
test('v1 choices migrate to Cinematic without palette or dither and without deleting storage', () => {
  const migrated = { ...defaults, quality: 'economy', scaling: 'integer' };
  assert.deepEqual(resolveDisplayPrefs({ saved: v1 }), migrated);
  assert.deepEqual(resolveDisplayPrefs({ saved: { ...v1, dither: -1, quality: 'garbage' } }), { ...defaults, scaling: 'integer' });
  // v1 never chose a grid: a stray one is ignored.
  assert.equal(resolveDisplayPrefs({ saved: { ...v1, look: 'pixel', pixelGrid: 'medium' } }).pixelGrid, 'detailed');
  const records = new Map([['smw:display:v1', JSON.stringify(v1)]]);
  const storage = { getItem: k => records.get(k), setItem: (k, v) => records.set(k, v) };
  assert.equal(DISPLAY_PREFS_KEY, 'midio-pixel:display:v1');
  assert.deepEqual(readDisplayPrefs(storage), migrated);
  assert.equal(writeDisplayPrefs(storage, readDisplayPrefs(storage)), true);
  assert.equal(records.get('smw:display:v1'), JSON.stringify(v1));
  assert.equal(records.has('smw:display:v2'), false);
  assert.deepEqual(JSON.parse(records.get(DISPLAY_PREFS_KEY)), migrated);
});
test('valid v2 takes precedence; invalid v2 falls through to v1 and legacy stage', () => {
  const v2 = { ...defaults, pixelGrid: 'medium' };
  const records = new Map([['smw:display:v2', JSON.stringify(v2)], ['smw:display:v1', JSON.stringify(v1)], ['smw:stageRes', '8bit']]);
  const storage = { getItem: k => records.get(k) };
  assert.deepEqual(readDisplayPrefs(storage), v2);
  records.set('smw:display:v2', '{broken');
  assert.deepEqual(readDisplayPrefs(storage), { ...defaults, quality: 'economy', scaling: 'integer' }, 'v1');
  records.delete('smw:display:v1');
  assert.deepEqual(readDisplayPrefs(storage), { ...defaults, quality: 'economy' }, 'legacy 8-bit stage');
});
test('a Cinematic record keeps its chosen grid; records of the removed looks start at Detailed', () => {
  const saved = { ...defaults, pixelGrid: 'classic', quality: 'auto' };
  assert.deepEqual(resolveDisplayPrefs({ saved }), saved);
  assert.deepEqual([resolvePresentation(saved).grid.width, resolvePresentation(saved).grid.height], [320, 180]);
  for (const look of ['pixel', 'palette', 'natural']) {
    assert.deepEqual(resolveDisplayPrefs({ saved: { ...saved, look } }), defaults, `${look} Classic starts at Detailed`);
    assert.equal(resolvePresentation({ ...saved, look }).grid.width, 640);
  }
  assert.equal(resolveDisplayPrefs({ saved: { ...saved, pixelGrid: 'broken' } }).pixelGrid, 'detailed');
});
for (const [pixelGrid, size] of [['classicPlus', [400, 225]], ['medium', [480, 270]], ['mediumPlus', [560, 315]]]) test(`${pixelGrid} survives valid v2 Cinematic storage as a ${size.join('x')} grid`, () => {
  const saved = { ...defaults, pixelGrid, quality: 'auto' };
  assert.deepEqual(resolveDisplayPrefs({ saved }), saved);
  assert.deepEqual([resolvePresentation(saved).grid.width, resolvePresentation(saved).grid.height], size);
});
test('Economy stays pinned over two clean minutes while Auto keeps device quality', () => {
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

test('legacy v2 migration preserves every surviving display option and leaves source storage untouched', () => {
  const legacy = { version: 2, look: 'cinematic', quality: 'economy', palette: 'chroma32', dither: 0, ditherMode: 'selective', pixelGrid: 'medium', scaling: 'integer', buildPixelDetail: false };
  const records = new Map([['smw:display:v2', JSON.stringify(legacy)], ['smw:display:v1', JSON.stringify(v1)]]);
  const storage = { getItem: k => records.get(k), setItem: (k, v) => records.set(k, v) };
  const migrated = readDisplayPrefs(storage);
  assert.deepEqual(migrated, { version: 2, look: 'cinematic', quality: 'economy', pixelGrid: 'medium', scaling: 'integer', pixelScale: 'original', buildPixelDetail: false });
  writeDisplayPrefs(storage, migrated);
  assert.equal(records.get('smw:display:v2'), JSON.stringify(legacy));
  records.set('smw:display:v2', JSON.stringify({ ...legacy, look: 'pixel', pixelGrid: 'classic' }));
  assert.deepEqual(readDisplayPrefs(storage), migrated, 'migration reads source only until own preferences exist');
  // A Palette-era record keeps quality, scaling and the detail-build choice.
  records.clear(); records.set('smw:display:v2', JSON.stringify({ ...legacy, look: 'palette' }));
  assert.deepEqual(readDisplayPrefs(storage), { ...migrated, pixelGrid: 'detailed' });
});
test('stale Natural settings coerce to Cinematic without pinning quality or losing display choices', () => {
  const stale = { ...defaults, look: 'natural', quality: 'auto', palette: 'chroma32', pixelGrid: 'classic', scaling: 'integer' };
  const resolved = resolveDisplayPrefs({ saved: stale });
  assert.deepEqual(resolved, { ...defaults, scaling: 'integer' });
  const presentation = resolvePresentation(stale);
  assert.equal(presentation.pixelated, true);
  assert.equal(presentation.cinematicPixel, true);
  assert.equal('paletteId' in presentation, false);
  assert.equal(presentation.grid.width, 640);
  assert.equal(presentation.quality, 'auto');
});
test('saved Depth and unknown pixel scale values migrate to Uniform without losing grid or quality', () => {
  for (const pixelScale of ['depth', 'original', 'random']) {
    const saved = { ...defaults, pixelScale, pixelGrid: 'medium', quality: 'economy' };
    assert.deepEqual(resolveDisplayPrefs({ saved }), { ...saved, pixelScale: 'original', buildPixelDetail: true });
    assert.equal(resolvePresentation(saved).pixelScale, 'original');
    assert.equal(resolvePresentation(saved).grid.id, 'medium');
    assert.equal(resolvePresentation(saved).quality, 'economy');
  }
});
test('persisted Depth preferences are read and rewritten as Uniform while legacy storage remains intact', () => {
  for (const key of [DISPLAY_PREFS_KEY, 'smw:display:v2']) {
    const saved = { ...defaults, pixelScale: 'depth', pixelGrid: 'medium', quality: 'economy' };
    const original = JSON.stringify(saved), records = new Map([[key, original]]);
    const storage = { getItem: k => records.get(k), setItem: (k, v) => records.set(k, v) };
    const migrated = readDisplayPrefs(storage);
    assert.deepEqual(migrated, { ...saved, pixelScale: 'original', buildPixelDetail: true });
    assert.equal(writeDisplayPrefs(storage, migrated), true);
    assert.equal(JSON.parse(records.get(DISPLAY_PREFS_KEY)).pixelScale, 'original');
    if (key !== DISPLAY_PREFS_KEY) assert.equal(records.get(key), original);
  }
});
