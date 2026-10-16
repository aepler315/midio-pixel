import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveAudioIdentity, sessionSongName, adoptAudioSessionAnalysis, adoptAudioSessionLyrics,
} from '../src/audio/AudioSessionIdentity.js';

const source = { provider: 'plex', id: 'plex:server:30', revision: 'rev1', title: 'Catalog title' };
function taggedFile() {
  const bytes = new Uint8Array(128);
  bytes.set(new TextEncoder().encode('TAGTagged title'));
  return { name: 'Fallback name.wav', arrayBuffer: async () => bytes.buffer };
}

test('local identity precedence and filename fallback remain independent of lyric/network work', async () => {
  const file = taggedFile();
  const tagged = await resolveAudioIdentity(file, 12);
  assert.equal(tagged.title, 'Tagged title');
  const catalog = await resolveAudioIdentity(file, 12, { sourceMetadata: source });
  assert.equal(catalog.title, 'Catalog title');
  assert.equal(catalog.durationSec, 12);
  const filename = await resolveAudioIdentity({ name: file.name, arrayBuffer: async () => new ArrayBuffer(0) }, 12);
  assert.equal(filename.title, 'Fallback name');
  assert.equal(sessionSongName({ sourceTrack: source, lyricIdentity: tagged, sourceFileName: file.name }), 'Catalog title');
  assert.equal(sessionSongName({ lyricIdentity: tagged, sourceFileName: file.name }), 'Tagged title');
  assert.equal(sessionSongName({ lyricIdentity: null, sourceFileName: file.name }), file.name);
  assert.equal(sessionSongName(null, 'Proof'), 'Proof');
  assert.equal(sessionSongName(null, ''), 'song');
});

test('aborted local identity retains the pre-existing neutral result', async () => {
  const controller = new AbortController(); controller.abort();
  const identity = await resolveAudioIdentity(taggedFile(), 12, { signal: controller.signal, sourceMetadata: source });
  assert.equal(identity.title, null);
  assert.equal(identity.source, 'none');
});

test('whole analysis replaces analysis fields but preserves session evidence object identity', () => {
  const session = { generation: 8, admissions: [{ revision: 1, heardTimeMs: 5000 }] };
  const identity = { title: 'Current title' }, lines = [{ tMs: 6000, text: 'heart' }], sections = [{ kind: 'verse' }];
  const data = { sourceTrack: source, lyricIdentity: identity, sourceFileName: 'file.wav',
    lyricSession: session, syncedLyrics: lines, lyricSections: sections, opening: { provisional: true }, durationMs: 15000 };
  const full = { durationMs: 60000, sourceTrack: { title: 'Old' }, lyricIdentity: { title: 'Old' },
    sourceFileName: 'old.wav', lyricSession: null, syncedLyrics: null, lyricSections: null };
  adoptAudioSessionAnalysis(data, full);
  assert.equal(data.durationMs, 60000); assert.equal(data.opening, undefined);
  assert.equal(data.sourceTrack, source); assert.equal(data.lyricIdentity, identity);
  assert.equal(data.lyricSession, session); assert.equal(data.syncedLyrics, lines); assert.equal(data.lyricSections, sections);
  assert.equal(data.sourceFileName, 'file.wav');
});

test('the ownership gate precedes publication and live consumer invocation', () => {
  const data = { lyricIdentity: { title: 'Old' }, lyricSession: { generation: 8, admissions: [] } };
  const before = structuredClone(data), order = [];
  const result = { identity: { title: 'Resolved' }, lyricSections: null, syncedLyrics: [{ tMs: 0, text: 'heart' }] };
  const sim = { heardTimeMs: 5100, biomes: { adoptLyrics(admission) {
    order.push('consumer');
    assert.equal(data.lyricIdentity, result.identity);
    assert.equal(data.lyricSession.admissions[0], admission);
    assert.equal(admission.heardTimeMs, 5100); assert.equal(admission.generation, 8);
    assert.ok(Object.isFrozen(admission));
  } } };
  const options = { canUpdatePrepared: () => { order.push('gate'); return false; }, generation: 8,
    lyricsDisabled: false, sim, activeData: data };
  assert.equal(adoptAudioSessionLyrics(data, result, options), false);
  assert.deepEqual(data, before); assert.deepEqual(order, ['gate']);
  options.canUpdatePrepared = () => { order.push('gate'); return true; };
  assert.equal(adoptAudioSessionLyrics(data, result, options), true);
  assert.deepEqual(order, ['gate', 'gate', 'consumer']);
});

test('disabled lyrics still publish identity; a prepared session cannot call another session consumer', () => {
  const data = { lyricSession: { generation: 8, admissions: [] } };
  const result = { identity: { title: 'Resolved' }, lyricSections: null, syncedLyrics: [{ tMs: 0, text: 'heart' }] };
  const options = { canUpdatePrepared: () => true, generation: 8, lyricsDisabled: true,
    sim: { biomes: { adoptLyrics() { assert.fail('wrong session'); } } }, activeData: {} };
  assert.equal(adoptAudioSessionLyrics(data, result, options), true);
  assert.equal(data.lyricIdentity, result.identity); assert.equal(data.lyricSession.admissions.length, 0);
  options.lyricsDisabled = false;
  assert.equal(adoptAudioSessionLyrics(data, result, options), true);
  assert.equal(data.lyricSession.admissions[0].heardTimeMs, 0);
});
