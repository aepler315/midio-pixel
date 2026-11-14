import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildExportRuntime } from '../tools/build-export-runtime.mjs';
import { stageSite } from '../tools/stage-site.mjs';

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

test('production staging rejects a corrupted or incomplete exporter before replacing an existing site', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'midio-stage-export-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), output = path.join(root, 'output');
  const vendor = path.join(source, 'src/vendor/export');
  await fs.mkdir(vendor, { recursive: true });
  await fs.mkdir(path.join(source, 'src/render'), { recursive: true });
  await fs.writeFile(path.join(source, 'index.html'), '<html></html>');
  await fs.writeFile(path.join(source, 'src/main.js'), 'import "./render/Mp4Export.js";');
  await fs.writeFile(path.join(source, 'src/render/Mp4Export.js'), 'export const present = true;');
  await fs.cp(new URL('../src/vendor/export/', import.meta.url), vendor, { recursive: true });
  await stageSite(source, output);
  assert.ok((await fs.stat(path.join(output, 'src/vendor/export/mediabunny.module.js'))).size > 0);
  await fs.writeFile(path.join(output, 'keep-on-failure.txt'), 'old good build');
  await fs.appendFile(path.join(vendor, 'mediabunny.module.js'), '\n/* changed */');
  await assert.rejects(stageSite(source, output), /export.*match|export.*pin/i);
  assert.equal(await fs.readFile(path.join(output, 'keep-on-failure.txt'), 'utf8'), 'old good build');
  await fs.rm(vendor, { recursive: true });
  await assert.rejects(stageSite(source, output), /export.*runtime\.json/i);
});

test('the staging CLI runs through a directory alias instead of silently skipping its entry point', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'midio-stage-alias-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), output = path.join(root, 'output'), alias = path.join(root, 'tools-alias');
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.writeFile(path.join(source, 'index.html'), '<html></html>');
  await fs.writeFile(path.join(source, 'src/main.js'), 'export const present = true;');
  await fs.symlink(fileURLToPath(new URL('../tools/', import.meta.url)), alias, process.platform === 'win32' ? 'junction' : 'dir');
  execFileSync(process.execPath, [path.join(alias, 'stage-site.mjs'), source, output], { stdio: 'pipe', windowsHide: true });
  assert.equal(await fs.readFile(path.join(output, 'src/main.js'), 'utf8'), 'export const present = true;');
});
