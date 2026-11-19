// A file opened before finds its cached analysis without being fingerprinted
// again (src/audio/AnalysisCache.js recallFingerprint/rememberFingerprint).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analysisCacheKey, fileSignature, MAX_FILE_INDEX, recallFingerprint, rememberFingerprint,
} from '../src/audio/AnalysisCache.js';
import { ANALYSIS_REVISION } from '../src/audio/AnalysisRevision.js';
import { SONGPRINT_VERSION } from '../src/audio/SongprintData.js';
import { GrooveFingerprint } from '../src/sim/GrooveFingerprint.js';

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), map };
}
const file = { name: 'song.wav', size: 26460044, lastModified: 1763000000000 };
const buffer = { length: 6615000, sampleRate: 44100 };
const fingerprint = { key: 'fp2_abc', durationMs: 150000, frames: new Uint32Array(4),
  signal: { sampleRate: 44100, length: 6615000, channelRms: [0.21345678901234, 0.2], crossPower: 0.0312345678 } };

test('a remembered file gives the cache key its fingerprint would, under the current groove', () => {
  const storage = memoryStorage();
  const sig = fileSignature(file, buffer);
  rememberFingerprint(sig, fingerprint, storage);
  const recalled = recallFingerprint(sig, storage);
  assert.equal(recalled.recalled, true);
  for (const groove of [null, new GrooveFingerprint()]) {
    assert.equal(analysisCacheKey(recalled, { groove }), analysisCacheKey(fingerprint, { groove }));
  }
});

test('any difference in the file is a miss', () => {
  const storage = memoryStorage();
  rememberFingerprint(fileSignature(file, buffer), fingerprint, storage);
  for (const [f, b] of [[{ ...file, size: file.size + 1 }, buffer], [{ ...file, lastModified: 1 }, buffer],
    [{ ...file, name: 'other.wav' }, buffer], [file, { ...buffer, length: buffer.length - 1 }], [file, { ...buffer, sampleRate: 48000 }]]) {
    assert.equal(recallFingerprint(fileSignature(f, b), storage), null);
  }
});

test('the index is bounded, newest first, and survives unusable storage', () => {
  const storage = memoryStorage();
  for (let i = 0; i < MAX_FILE_INDEX + 20; i++) rememberFingerprint(`sig${i}`, { ...fingerprint, key: `fp2_${i}` }, storage);
  assert.equal(JSON.parse(storage.map.get('smw:fingerprintIndex')).length, MAX_FILE_INDEX);
  assert.equal(recallFingerprint('sig0', storage), null, 'the oldest is forgotten');
  assert.equal(recallFingerprint(`sig${MAX_FILE_INDEX + 19}`, storage).key, `fp2_${MAX_FILE_INDEX + 19}`);
  const broken = { getItem: () => '{not json', setItem: () => { throw Error('quota'); } };
  assert.equal(recallFingerprint('sig1', broken), null);
  assert.doesNotThrow(() => rememberFingerprint('sig1', fingerprint, broken));
  assert.equal(recallFingerprint('sig1', undefined), null);
});

test('a recalled or uninformative fingerprint is never written back', () => {
  const storage = memoryStorage();
  rememberFingerprint('a', { ...fingerprint, recalled: true }, storage);
  rememberFingerprint('b', { ...fingerprint, key: null }, storage);
  assert.equal(storage.map.size, 0);
});

test('enabling Songprint separates new analyses and old cache keys stay usable when off', () => {
  const oldFields = [ANALYSIS_REVISION, fingerprint.key, fingerprint.durationMs, fingerprint.signal, [], null];
  assert.equal(analysisCacheKey(fingerprint), JSON.stringify(oldFields));
  assert.equal(analysisCacheKey(fingerprint, { songprint: false }), JSON.stringify(oldFields));
  const enhanced = JSON.stringify([...oldFields, `songprint:${SONGPRINT_VERSION}`]);
  assert.equal(analysisCacheKey(fingerprint, { songprint: true }), enhanced);
  const storage = memoryStorage();
  rememberFingerprint('known', fingerprint, storage);
  assert.equal(analysisCacheKey(recallFingerprint('known', storage), { songprint: true }), enhanced);
});
