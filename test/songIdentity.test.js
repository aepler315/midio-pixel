import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseId3, identityFromFilename, resolveIdentity } from '../src/lyrics/SongIdentity.js';

function syncsafe(n) {
  return [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
}
function beBytes(n) {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
function textBytes(str) {
  return [0, ...Array.from(str, (c) => c.charCodeAt(0))]; // encoding byte 0 = ISO-8859-1
}
function utf16Bytes(str) {
  // encoding byte 1 = UTF-16 with a little-endian BOM
  const out = [1, 0xff, 0xfe];
  for (const ch of str) { const code = ch.charCodeAt(0); out.push(code & 0xff, (code >> 8) & 0xff); }
  out.push(0, 0); // NUL terminator
  return out;
}

function buildId3v2Frame(id, dataBytes, { syncsafeSize = false } = {}) {
  const sizeBytes = syncsafeSize ? syncsafe(dataBytes.length) : beBytes(dataBytes.length);
  return [...Array.from(id, (c) => c.charCodeAt(0)), ...sizeBytes, 0, 0, ...dataBytes];
}

function buildId3v2Tag(version, frames) {
  const body = frames.flat();
  const header = [0x49, 0x44, 0x33, version, 0, 0, ...syncsafe(body.length)];
  return new Uint8Array([...header, ...body]).buffer;
}

test('parseId3: reads TIT2/TPE1/TALB from an ISO-8859-1 ID3v2.3 tag (plain frame sizes)', () => {
  const buf = buildId3v2Tag(3, [
    buildId3v2Frame('TIT2', textBytes('Test Title')),
    buildId3v2Frame('TPE1', textBytes('Test Artist')),
    buildId3v2Frame('TALB', textBytes('Test Album')),
  ]);
  const tags = parseId3(buf);
  assert.equal(tags.title, 'Test Title');
  assert.equal(tags.artist, 'Test Artist');
  assert.equal(tags.album, 'Test Album');
});

test('parseId3: reads UTF-16 text frames from an ID3v2.4 tag (syncsafe frame sizes)', () => {
  const buf = buildId3v2Tag(4, [
    buildId3v2Frame('TIT2', utf16Bytes('Unicode Song'), { syncsafeSize: true }),
    buildId3v2Frame('TPE1', utf16Bytes('Unicode Artist'), { syncsafeSize: true }),
  ]);
  const tags = parseId3(buf);
  assert.equal(tags.title, 'Unicode Song');
  assert.equal(tags.artist, 'Unicode Artist');
  assert.equal(tags.album, null);
});

test('parseId3: falls back to an ID3v1 128-byte tail when no ID3v2 header is present', () => {
  const tail = new Uint8Array(128);
  const put = (str, offset, len) => { for (let i = 0; i < Math.min(str.length, len); i++) tail[offset + i] = str.charCodeAt(i); };
  put('TAG', 0, 3);
  put('V1 Title', 3, 30);
  put('V1 Artist', 33, 30);
  put('V1 Album', 63, 30);
  const buf = new Uint8Array([...new Uint8Array(50), ...tail]).buffer; // some junk audio data, then the tag tail
  const tags = parseId3(buf);
  assert.equal(tags.title, 'V1 Title');
  assert.equal(tags.artist, 'V1 Artist');
  assert.equal(tags.album, 'V1 Album');
});

test('parseId3: an untagged buffer returns all-null fields without throwing', () => {
  const buf = new Uint8Array(64).fill(0).buffer;
  assert.doesNotThrow(() => parseId3(buf));
  const tags = parseId3(buf);
  assert.deepEqual(tags, { title: null, artist: null, album: null });
});

test('identityFromFilename: splits "Artist - Title" patterns and strips junk/track numbers', () => {
  assert.deepEqual(identityFromFilename('01. Queen - Bohemian Rhapsody.mp3'), { artist: 'Queen', title: 'Bohemian Rhapsody', confidence: 0.5 });
  const withJunk = identityFromFilename('Artist - Song Title (Remastered).flac');
  assert.equal(withJunk.artist, 'Artist');
  assert.equal(withJunk.title, 'Song Title');
  const noSplit = identityFromFilename('justasongname.wav');
  assert.equal(noSplit.artist, null);
  assert.equal(noSplit.title, 'justasongname');
  assert.ok(noSplit.confidence < 0.5);
});

test('identityFromFilename: an empty/degenerate name never throws and yields zero confidence', () => {
  assert.doesNotThrow(() => identityFromFilename(''));
  assert.equal(identityFromFilename('').confidence, 0);
});

test('resolveIdentity: tags win over filename guesses, and duration passes through untouched', () => {
  const buf = buildId3v2Tag(3, [buildId3v2Frame('TIT2', textBytes('Real Title')), buildId3v2Frame('TPE1', textBytes('Real Artist'))]);
  const id = resolveIdentity('totally-different-name.mp3', buf, 214.2);
  assert.equal(id.title, 'Real Title');
  assert.equal(id.artist, 'Real Artist');
  assert.equal(id.source, 'tags');
  assert.equal(id.durationSec, 214.2);
  assert.ok(id.confidence > 0.9);
});

test('resolveIdentity: falls back to filename when there are no tags, and reports source/confidence honestly', () => {
  const buf = new Uint8Array(32).fill(0).buffer;
  const id = resolveIdentity('Muse - Knights of Cydonia.mp3', buf, 366);
  assert.equal(id.artist, 'Muse');
  assert.equal(id.title, 'Knights of Cydonia');
  assert.equal(id.source, 'filename');
  assert.ok(id.confidence > 0 && id.confidence <= 1);
});

test('resolveIdentity: no tags and no usable filename reports source "none"', () => {
  const buf = new Uint8Array(32).fill(0).buffer;
  const id = resolveIdentity('', buf, null);
  assert.equal(id.source, 'none');
  assert.equal(id.confidence, 0);
});
