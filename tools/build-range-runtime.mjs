// Build the pinned, local Range v2 rendering runtime:
//   src/vendor/range/three-range.module.js   (ES module, minified)
//   src/vendor/range/LICENSE-three.txt        (upstream MIT notice)
//   src/vendor/range/runtime.json             (versions + SHA-256)
// Deterministic for a given lockfile: rerunning must reproduce the same
// bytes, and `--check` fails when the committed output is stale. Staging
// runs `--check` so the published site always carries the committed bundle.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'src', 'vendor', 'range');
const entry = path.join(root, 'tools', 'range-runtime-entry.mjs');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

export async function buildRangeRuntime() {
  const threePkg = JSON.parse(await fs.readFile(path.join(root, 'node_modules', 'three', 'package.json'), 'utf8'));
  const esbuildPkg = JSON.parse(await fs.readFile(path.join(root, 'node_modules', 'esbuild', 'package.json'), 'utf8'));
  const result = await build({
    entryPoints: [entry], bundle: true, format: 'esm', minify: true, write: false,
    target: ['es2020'], legalComments: 'none', sourcemap: false, treeShaking: true,
    banner: { js: `/* three.js r${threePkg.version.split('.')[1]} (${threePkg.version}), MIT License, Copyright 2010-2026 three.js authors. Subset bundled for Midio Range v2; see LICENSE-three.txt. */` },
  });
  const code = Buffer.from(result.outputFiles[0].contents);
  const license = await fs.readFile(path.join(root, 'node_modules', 'three', 'LICENSE'));
  const meta = {
    about: 'Local Three.js subset for Range v2. Built by tools/build-range-runtime.mjs from tools/range-runtime-entry.mjs.',
    three: threePkg.version, esbuild: esbuildPkg.version,
    files: {
      'three-range.module.js': { bytes: code.byteLength, sha256: sha256(code) },
      'LICENSE-three.txt': { bytes: license.byteLength, sha256: sha256(license) },
    },
  };
  return { code, license, meta: Buffer.from(JSON.stringify(meta, null, 2) + '\n') };
}

async function main() {
  const check = process.argv.includes('--check');
  const out = process.argv.includes('--out') ? path.resolve(process.argv[process.argv.indexOf('--out') + 1]) : outDir;
  const { code, license, meta } = await buildRangeRuntime();
  const files = { 'three-range.module.js': code, 'LICENSE-three.txt': license, 'runtime.json': meta };
  if (check) {
    for (const [name, buf] of Object.entries(files)) {
      let have = null;
      try { have = await fs.readFile(path.join(outDir, name)); } catch { /* missing */ }
      if (!have || !have.equals(buf)) {
        console.error(`src/vendor/range/${name} is stale; run: node tools/build-range-runtime.mjs`);
        process.exitCode = 1;
        return;
      }
    }
    console.log('Range runtime bundle is current.');
    return;
  }
  await fs.mkdir(out, { recursive: true });
  for (const [name, buf] of Object.entries(files)) await fs.writeFile(path.join(out, name), buf);
  console.log(`Range runtime: ${code.byteLength} bytes -> ${path.relative(root, out)}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
