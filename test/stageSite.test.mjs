import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { stageSite, verifyRangeRuntime } from '../tools/stage-site.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'midio-stage-'));
  const source = path.join(root, 'source');
  const output = path.join(root, 'site');
  await fs.mkdir(path.join(source, 'src'), { recursive: true });
  await fs.mkdir(path.join(source, 'soundfonts'), { recursive: true });
  await fs.writeFile(path.join(source, 'index.html'), '<script type="module" src="src/main.js"></script>');
  await fs.writeFile(path.join(source, 'CNAME'), 'example.test\n');
  await fs.writeFile(path.join(source, 'src/main.js'), 'export const boot = true;\n');
  await fs.writeFile(path.join(source, 'soundfonts/README.md'), 'runtime listing\n');
  await fs.writeFile(path.join(source, 'secret.txt'), 'do not publish\n');
  return { root, source, output };
}

test('stageSite writes only the public runtime contract', async (t) => {
  const { root, source, output } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await stageSite(source, output);
  assert.deepEqual((await fs.readdir(output)).sort(), ['.nojekyll', 'CNAME', 'index.html', 'soundfonts', 'src']);
  assert.equal(await fs.readFile(path.join(output, 'src/main.js'), 'utf8'), 'export const boot = true;\n');
  await assert.rejects(fs.access(path.join(output, 'secret.txt')));
});

test('stageSite fails when a required runtime input is missing', async (t) => {
  const { root, source, output } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.rm(path.join(source, 'src/main.js'));
  await assert.rejects(stageSite(source, output), /required runtime input.*src\/main\.js/i);
});

test('stageSite refuses to clean a source directory or one of its ancestors', async (t) => {
  const { root, source } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await assert.rejects(stageSite(source, source), /output.*source/i);
  await assert.rejects(stageSite(source, root), /output.*source/i);
});

test('stageSite refuses arbitrary source descendants before deleting them', async (t) => {
  const { root, source } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const main = path.join(source, 'src/main.js');
  await assert.rejects(stageSite(source, path.join(source, 'src')), /dedicated _site/i);
  assert.equal(await fs.readFile(main, 'utf8'), 'export const boot = true;\n');
});

test('stageSite follows symlinked ancestors when checking destructive overlap', async (t) => {
  const { root, source } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const alias = path.join(root, 'source-alias');
  await fs.symlink(source, alias, 'dir');
  await assert.rejects(stageSite(source, path.join(alias, 'src')), /dedicated _site/i);
  assert.equal(await fs.readFile(path.join(source, 'src/main.js'), 'utf8'), 'export const boot = true;\n');
});

test('staging verifies the Range v2 runtime bundle and shipped terrain assets', async t => {
  const { verifyRangeRuntime } = await import('../tools/stage-site.mjs');
  const fsp = fs, p = path;
  const root = p.resolve(p.dirname(new URL(import.meta.url).pathname), '..');
  const out = await fsp.mkdtemp(p.join(os.tmpdir(), 'midio-stage-range-'));
  t.after(() => fsp.rm(out, { recursive: true, force: true }));
  await fsp.cp(p.join(root, 'src'), p.join(out, 'src'), { recursive: true });
  const ok = await verifyRangeRuntime(root, out);
  assert.equal(ok.checked, true);
  assert.ok(ok.views.length >= 1);
  // A tampered payload must fail staging.
  const payload = p.join(out, 'src', 'assets', 'range', 'v2', 'terrain', `${ok.views[0]}.terrain.bin.gz`);
  const buf = await fsp.readFile(payload);
  buf[buf.length - 10] ^= 0xff;
  await fsp.writeFile(payload, buf);
  await assert.rejects(verifyRangeRuntime(root, out), /does not match/);
  // A staged runtime without its scene catalog is a broken site.
  await fsp.rm(p.join(out, 'src', 'world', 'terrain', 'sceneCatalogData.js'));
  await assert.rejects(verifyRangeRuntime(root, out), /scene catalog cannot be loaded/);
});


test('only a positively identified no-Range tree may skip runtime verification', async t => {
  const legacy = await fixture();
  t.after(() => fs.rm(legacy.root, { recursive: true, force: true }));
  await stageSite(legacy.source, legacy.output);
  assert.deepEqual(await verifyRangeRuntime(legacy.source, legacy.output), { checked: false });
  for (const [side, relative] of [
    ['source', 'src/world/alpine/RangePresentation.js'],
    ['output', 'src/vendor/range/three-range.module.js'],
    ['output', 'src/world/terrain/sceneCatalogData.js'],
    ['output', 'src/assets/range/v2/partial.txt'],
    ['source', 'src/main.js'],
  ]) {
    await t.test(`${side}: ${relative}`, async sub => {
      const f = await fixture();
      sub.after(() => fs.rm(f.root, { recursive: true, force: true }));
      await stageSite(f.source, f.output);
      const target = path.join(f[side], relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, "import './world/alpine/RangePresentation.js';");
      await assert.rejects(verifyRangeRuntime(f.source, f.output), /Range runtime.*runtime\.json/i);
    });
  }
});

async function rangeFixture(t) {
  const { root, source, output } = await fixture();
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const vendor = path.join(output, 'src/vendor/range');
  await fs.mkdir(vendor, { recursive: true });
  await fs.cp(path.join(repo, 'src/vendor/range'), vendor, { recursive: true });
  const catalog = path.join(output, 'src/world/terrain/sceneCatalogData.js');
  await fs.mkdir(path.dirname(catalog), { recursive: true });
  await fs.writeFile(catalog, 'export default { views: [] };');
  const metadata = path.join(vendor, 'runtime.json');
  const runtime = JSON.parse(await fs.readFile(metadata, 'utf8'));
  return { source, output, vendor, metadata, runtime };
}

test('Range runtime rejects malformed metadata and missing files instead of skipping', async t => {
  const f = await rangeFixture(t);
  await fs.writeFile(f.metadata, '{');
  await assert.rejects(verifyRangeRuntime(f.source, f.output), /runtime\.json.*JSON|runtime\.json.*parse/i);
  await fs.rm(f.metadata);
  await assert.rejects(verifyRangeRuntime(f.source, f.output), /Range runtime.*runtime\.json/i);
});

test('Range runtime requires its supported metadata schema and declared file records', async t => {
  const f = await rangeFixture(t);
  for (const mutate of [
    value => { delete value.files; },
    value => { value.files = {}; },
    value => { value.files['three-range.module.js'].bytes = 1; },
    value => { delete value.files['three-range.module.js'].sha256; },
    value => { delete value.files['LICENSE-three.txt']; },
    value => { value.schema = 'unsupported'; },
    value => { value.schemaVersion = 999; },
    value => { value.version = 999; },
  ]) {
    const runtime = structuredClone(f.runtime);
    mutate(runtime);
    await fs.writeFile(f.metadata, JSON.stringify(runtime));
    await assert.rejects(verifyRangeRuntime(f.source, f.output), /runtime\.json|runtime.*metadata/i);
  }
});

test('matching bundle bytes must still provide the required runtime exports', async t => {
  const f = await rangeFixture(t);
  const bundle = Buffer.from('export const incompleteRuntime = true;');
  f.runtime.files['three-range.module.js'] = { bytes: bundle.byteLength, sha256: createHash('sha256').update(bundle).digest('hex') };
  await fs.writeFile(path.join(f.vendor, 'three-range.module.js'), bundle);
  await fs.writeFile(f.metadata, JSON.stringify(f.runtime));
  await assert.rejects(verifyRangeRuntime(f.source, f.output), /runtime.*exports/i);
});
