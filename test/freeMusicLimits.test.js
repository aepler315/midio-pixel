import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_DOWNLOAD_BYTES, readBoundedDownload } from '../tools/free-music.mjs';

test('free-music downloads reject an oversized declared response before reading it', async () => {
  const response = new Response('', {
    headers: { 'content-length': String(MAX_DOWNLOAD_BYTES + 1) },
  });
  await assert.rejects(
    readBoundedDownload(response, 'fixture download'),
    /fixture download exceeds/i,
  );
});

test('free-music downloads preserve small response bytes', async () => {
  const response = new Response(new Uint8Array([1, 2, 3]));
  assert.deepEqual([...await readBoundedDownload(response)], [1, 2, 3]);
});
