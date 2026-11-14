import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildExportRuntime } from '../tools/build-export-runtime.mjs';

test('the static exporter runtime rebuilds to the committed licensed, pinned bytes', async () => {
  const files = await buildExportRuntime();
  for (const [name, bytes] of Object.entries(files)) {
    const committed = await fs.readFile(new URL(`../src/vendor/export/${name}`, import.meta.url));
    assert.ok(committed.equals(bytes), `${name} differs from its reproducible build`);
  }
  const meta = JSON.parse(files['runtime.json']);
  for (const [name, record] of Object.entries(meta.files)) {
    assert.equal(files[name].byteLength, record.bytes);
    assert.equal(createHash('sha256').update(files[name]).digest('hex'), record.sha256);
  }
});

test('the served exporter bundle provides every source and encoder probe the exporter needs', async () => {
  const runtime = await import('../src/vendor/export/mediabunny.module.js');
  for (const name of ['Output', 'Mp4OutputFormat', 'BufferTarget', 'StreamTarget', 'CanvasSource', 'AudioSampleSource', 'AudioSample', 'Quality', 'canEncodeVideo', 'canEncodeAudio']) {
    assert.equal(typeof runtime[name], 'function', `${name} is available without a CDN`);
  }
});
