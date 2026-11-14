// Reproduce the pinned static WebCodecs/MP4 runtime. No CDN imports at run time.
// node tools/build-export-runtime.mjs [--check]
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'src', 'vendor', 'export');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function buildExportRuntime() {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'node_modules', 'mediabunny', 'package.json'), 'utf8'));
  const esbuildPkg = JSON.parse(await fs.readFile(path.join(root, 'node_modules', 'esbuild', 'package.json'), 'utf8'));
  const result = await build({
    entryPoints: [path.join(root, 'tools', 'export-runtime-entry.mjs')],
    bundle: true, format: 'esm', platform: 'browser', minify: true, write: false,
    target: ['es2021'], legalComments: 'none', sourcemap: false, treeShaking: true,
    banner: { js: `/* Mediabunny ${pkg.version}, MPL-2.0, Copyright Vanilagy. Bundled subset; see LICENSE-mediabunny.txt and runtime.json for corresponding source. */` },
  });
  const files = {
    'mediabunny.module.js': Buffer.from(result.outputFiles[0].contents),
    'LICENSE-mediabunny.txt': await fs.readFile(path.join(root, 'node_modules', 'mediabunny', 'LICENSE')),
  };
  const meta = {
    about: 'Static offline H.264/AAC MP4 export. Rebuild with node tools/build-export-runtime.mjs.',
    mediabunny: pkg.version, esbuild: esbuildPkg.version, license: pkg.license,
    source: `https://registry.npmjs.org/mediabunny/-/mediabunny-${pkg.version}.tgz`,
    upstream: 'https://github.com/Vanilagy/mediabunny',
    files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, { bytes: bytes.byteLength, sha256: sha256(bytes) }])),
  };
  files['runtime.json'] = Buffer.from(JSON.stringify(meta, null, 2) + '\n');
  return files;
}

async function main() {
  const files = await buildExportRuntime();
  if (process.argv.includes('--check')) {
    for (const [name, bytes] of Object.entries(files)) {
      let committed = null;
      try { committed = await fs.readFile(path.join(outDir, name)); } catch { /* missing output */ }
      if (!committed?.equals(bytes)) throw new Error(`src/vendor/export/${name} is stale; run node tools/build-export-runtime.mjs`);
    }
    console.log('MP4 export runtime bundle is current.');
    return;
  }
  await fs.mkdir(outDir, { recursive: true });
  for (const [name, bytes] of Object.entries(files)) await fs.writeFile(path.join(outDir, name), bytes);
  console.log(`MP4 export runtime: ${files['mediabunny.module.js'].byteLength} bytes -> ${path.relative(root, outDir)}`);
}

if (process.argv[1] && await fs.realpath(process.argv[1]) === await fs.realpath(fileURLToPath(import.meta.url))) await main();
