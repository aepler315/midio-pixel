import { test } from 'node:test';
import assert from 'node:assert/strict';

test('experience defaults, query overrides and blocked storage preserve independent display preferences', async () => {
  const mod = await import('../src/core/Experience.js').catch(() => null);
  assert.ok(mod, 'experience preference support must exist');
  const data = new Map([['midio-pixel:experience:v1', 'trio'], ['midio-pixel:display:v2', 'untouched']]);
  const storage = { getItem: k => data.get(k), setItem: (k, v) => data.set(k, v) };
  assert.equal(mod.readExperience(null), 'landscape');
  assert.equal(mod.readExperience(storage), 'trio');
  assert.equal(mod.readExperience(storage, '?experience=landscape'), 'landscape');
  assert.equal(data.get('midio-pixel:experience:v1'), 'trio', 'query does not overwrite saved choice');
  mod.writeExperience(storage, 'landscape');
  assert.equal(data.get('midio-pixel:display:v2'), 'untouched');
  assert.equal(mod.readExperience({ getItem() { throw Error('blocked'); } }), 'landscape');
  assert.equal(mod.resolveExperience('bad'), 'landscape');
});

test('bulk export explicitly selects the experience and rejects misspelled mode names', async () => {
  const { parseBulkArgs } = await import('../src/render/BulkExport.js');
  assert.equal(parseBulkArgs(['--experience', 'trio', 'song.wav']).experience, 'trio');
  assert.equal(parseBulkArgs(['song.wav']).experience, 'landscape');
  assert.throws(() => parseBulkArgs(['--experience', 'typo', 'song.wav']), /experience/i);
});

test('preview caches distinguish the same world and passage in Landscape and Trio Stage', async () => {
  const { previewCacheKey } = await import('../src/ui/WorldPreview.js');
  const request = { worldId: 'alpine', seed: 315, tMs: 12000 };
  assert.notEqual(previewCacheKey({ ...request, experience: 'trio' }), previewCacheKey({ ...request, experience: 'landscape' }));
});

test('visual evidence can request Trio Stage without changing historical Landscape settings', async () => {
  const { normalizeManifest } = await import('../tools/lib/visual-evaluation.mjs');
  const manifest = { version: 1, settings: { experience: 'trio', view: null, biome: null }, songs: [{ id: 'quiet', fixture: 'silence', seconds: 4 }] };
  assert.equal(normalizeManifest(manifest).settings.experience, 'trio');
  assert.throws(() => normalizeManifest({ ...manifest, settings: { experience: 'bad' } }), /experience/);
});
