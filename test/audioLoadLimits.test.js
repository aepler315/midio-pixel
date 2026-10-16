import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  AUDIO_LOAD_LIMITS,
  accumulateDecodedAudioBytes,
  accumulateDecodedByteLength,
  accumulateEncodedAudioBytes,
  decodedAudioByteLength,
  validateAudioFiles,
  validateDecodedByteLength,
  validateDecodedAudioBuffer,
} from '../src/audio/loadLimits.js';

test('audio input limits reject too many files and oversized declared files', () => {
  assert.throws(
    () => validateAudioFiles(Array.from({ length: AUDIO_LOAD_LIMITS.maxFiles + 1 }, () => ({ size: 1 }))),
    /at most/i,
  );
  assert.throws(
    () => validateAudioFiles([{ name: 'huge.wav', size: AUDIO_LOAD_LIMITS.maxFileBytes + 1 }]),
    /exceeds/i,
  );
  assert.equal(accumulateEncodedAudioBytes(100, 800), 900);
  assert.throws(
    () => accumulateEncodedAudioBytes(AUDIO_LOAD_LIMITS.maxTotalFileBytes - 100, 101),
    /total/i,
  );
});

test('audio input limits reject an oversized decoded duration or channel count', () => {
  assert.throws(
    () => validateDecodedAudioBuffer({ duration: AUDIO_LOAD_LIMITS.maxDurationSeconds + 1, numberOfChannels: 2 }),
    /duration/i,
  );
  assert.throws(
    () => validateDecodedAudioBuffer({ duration: 1, numberOfChannels: AUDIO_LOAD_LIMITS.maxChannels + 1 }),
    /channels/i,
  );
  assert.equal(decodedAudioByteLength({ length: 100, numberOfChannels: 2 }), 800);
  assert.equal(validateDecodedByteLength(800), 800);
  assert.equal(accumulateDecodedByteLength(100, 800), 900);
  assert.equal(
    accumulateDecodedAudioBytes(100, { length: 100, numberOfChannels: 2 }),
    900,
  );
  assert.throws(
    () => validateDecodedByteLength(AUDIO_LOAD_LIMITS.maxDecodedBytes + 1),
    /memory/i,
  );
  assert.throws(
    () => accumulateDecodedAudioBytes(
      AUDIO_LOAD_LIMITS.maxTotalDecodedBytes - 799,
      { length: 100, numberOfChannels: 2 },
    ),
    /decoded-memory/i,
  );
  assert.throws(
    () => validateDecodedAudioBuffer({
      duration: 1,
      length: Math.ceil(AUDIO_LOAD_LIMITS.maxDecodedBytes / 4) + 1,
      numberOfChannels: 1,
    }),
    /memory/i,
  );
});
