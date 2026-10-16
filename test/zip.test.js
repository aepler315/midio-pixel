import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractZip } from '../src/utils/zip.js';
import { buildStoredZip, buildDeflateZip } from './helpers/zipFixture.js';

const fileA = new TextEncoder().encode('Hello SF2 World');
const fileB = new TextEncoder().encode('Second file content');

test('extractZip extracts a stored (method 0) single file', async () => {
  const zip = buildStoredZip([{ name: 'test.txt', data: fileA }]);
  const files = await extractZip(zip);
  assert.equal(files.size, 1);
  assert.ok(files.has('test.txt'));
  assert.deepEqual([...files.get('test.txt')], [...fileA]);
});

test('extractZip extracts multiple stored files', async () => {
  const zip = buildStoredZip([
    { name: 'a.txt', data: fileA },
    { name: 'b.txt', data: fileB },
  ]);
  const files = await extractZip(zip);
  assert.equal(files.size, 2);
  assert.deepEqual([...files.get('a.txt')], [...fileA]);
  assert.deepEqual([...files.get('b.txt')], [...fileB]);
});

test('extractZip decompresses deflate (method 8) entries', async () => {
  const zip = buildDeflateZip([{ name: 'deflated.txt', data: fileA }]);
  const files = await extractZip(zip);
  assert.equal(files.size, 1);
  assert.deepEqual([...files.get('deflated.txt')], [...fileA]);
});

test('extractZip skips directory entries (trailing slash)', async () => {
  const zip = buildStoredZip([{ name: 'fonts/', data: new Uint8Array(0) }]);
  const files = await extractZip(zip);
  assert.equal(files.size, 0);
  assert.ok(!files.has('fonts/'));
});

test('extractZip throws on invalid data', async () => {
  const bad = new Uint8Array([0, 1, 2, 3, 4, 5]).buffer;
  await assert.rejects(() => extractZip(bad), /EOCD/);
});

test('extractZip handles nested paths in filenames', async () => {
  const zip = buildStoredZip([{ name: 'subdir/nested.sf2', data: fileA }]);
  const files = await extractZip(zip);
  assert.equal(files.size, 1);
  assert.ok(files.has('subdir/nested.sf2'));
  assert.deepEqual([...files.get('subdir/nested.sf2')], [...fileA]);
});

test('extractZip rejects archives over the configured entry budget', async () => {
  const zip = buildStoredZip([
    { name: 'one.sf2', data: fileA },
    { name: 'two.sf2', data: fileB },
  ]);
  await assert.rejects(
    () => extractZip(zip, { maxEntries: 1 }),
    /entry count exceeds/i,
  );
});

test('extractZip rejects an entry before decompression exceeds its byte budget', async () => {
  const zip = buildDeflateZip([{ name: 'large.sf2', data: new Uint8Array(1024) }]);
  await assert.rejects(
    () => extractZip(zip, { maxEntryBytes: 128 }),
    /uncompressed size exceeds/i,
  );
});
