import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSourceMetadata, mergeSourceIdentity } from '../src/audio/SourceMetadata.js';
import { resolveIdentity } from '../src/lyrics/SongIdentity.js';

const source = { provider: 'plex', id: 'server:41', revision: 'revision-a', title: ' Real Song ', artist: null, album: 'Real Album', albumArtist: 'Album Artist', durationMs: 90000, artworkUrl: 'https://music.example/api/plex/v1/artwork/41' };

test('Plex title replaces filename guess and tag artist fills missing source artist', () => {
  const tags = { title: 'track-41', artist: 'Tag Artist', album: 'Tag Album', source: 'filename', confidence: 0.4, durationSec: 30 };
  const merged = mergeSourceIdentity({ sourceMetadata: source, tagIdentity: tags, durationSec: 91.2 });
  assert.equal(merged.title, 'Real Song');
  assert.equal(merged.artist, 'Tag Artist');
  assert.equal(merged.album, 'Real Album');
  assert.equal(merged.albumArtist, 'Album Artist');
  assert.equal(merged.durationSec, 91.2);
  assert.equal(merged.source, 'plex');
  assert.equal(tags.title, 'track-41');
});

test('normalization whitelists public identity and rejects other providers', () => {
  const normalized = normalizeSourceMetadata({ ...source, token: 'secret', url: 'http://plex/private', songIdentity: { seed: 41 } });
  assert.deepEqual(Object.keys(normalized).sort(), ['provider', 'id', 'revision', 'title', 'artist', 'album', 'albumArtist', 'durationMs', 'artworkUrl'].sort());
  assert.equal(normalized.title, 'Real Song');
  assert.equal(normalizeSourceMetadata({ ...source, provider: 'file' }), null);
  assert.equal(normalizeSourceMetadata({ ...source, id: '' }), null);
});

test('duplicate-title recordings retain distinct source IDs', () => {
  const one = mergeSourceIdentity({ sourceMetadata: source, durationSec: 90 });
  const two = mergeSourceIdentity({ sourceMetadata: { ...source, id: 'server:42' }, durationSec: 90 });
  assert.equal(one.title, two.title);
  assert.notEqual(one.id, two.id);
});

test('absent source preserves tag provenance and decoded duration is authoritative', () => {
  const merged = mergeSourceIdentity({ sourceMetadata: null, tagIdentity: { title: 'Tagged', source: 'id3', confidence: 0.9, durationSec: 80 }, durationSec: 92 });
  assert.equal(merged.title, 'Tagged');
  assert.equal(merged.source, 'id3');
  assert.equal(merged.confidence, 0.9);
  assert.equal(merged.durationSec, 92);
  assert.equal(mergeSourceIdentity({ sourceMetadata: source, durationSec: NaN }).durationSec, null);
});

test('normalization rejects unsafe generic artwork and invalid numeric metadata', () => {
  for (const artworkUrl of ['javascript:alert(1)', 'http://plex.example/library/metadata/1', 'https://user:secret@music.example/artwork/1', 'https://music.example/artwork/1?X-Plex-Token=secret']) {
    assert.equal(normalizeSourceMetadata({ ...source, artworkUrl, durationMs: -1 }).artworkUrl, null);
  }
  assert.equal(normalizeSourceMetadata({ ...source, durationMs: -1 }).durationMs, null);
});


test('album-only Plex metadata leaves synthetic adapter titles unknown', () => {
  const tagIdentity = resolveIdentity('plex-30.wav', new ArrayBuffer(4), 91);
  assert.equal(tagIdentity.title, 'plex-30');
  const merged = mergeSourceIdentity({ sourceMetadata: { ...source, id: 'server:30', title: null, artist: null, albumArtist: null }, tagIdentity, durationSec: 91 });
  assert.equal(merged.title, null);
  assert.equal(merged.artist, null);
  assert.equal(merged.album, 'Real Album');
  assert.equal(merged.confidence, 0);
  assert.equal(merged.id, 'server:30');
});

test('album-only Plex metadata preserves real embedded tag identity without inflating confidence', () => {
  const tagIdentity = { title: 'Embedded Title', artist: 'Embedded Artist', album: 'Embedded Album', source: 'tags', confidence: 0.95 };
  const merged = mergeSourceIdentity({ sourceMetadata: { ...source, title: null, artist: null }, tagIdentity, durationSec: 91 });
  assert.equal(merged.title, 'Embedded Title');
  assert.equal(merged.artist, 'Embedded Artist');
  assert.equal(merged.album, 'Real Album');
  assert.equal(merged.confidence, 0.95);
  assert.equal(merged.source, 'tags');
  assert.equal(merged.id, 'server:41');
});
