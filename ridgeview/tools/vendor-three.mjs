// Copy the pinned three.js build into vendor/ so the page needs no CDN or
// bundler. Run after `npm install` whenever the three version changes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'node_modules', 'three');
const out = path.join(root, 'vendor');
const pkg = JSON.parse(await fs.readFile(path.join(src, 'package.json'), 'utf8'));
await fs.mkdir(out, { recursive: true });
for (const f of ['three.core.js', 'three.module.js']) {
  await fs.copyFile(path.join(src, 'build', f), path.join(out, f));
}
await fs.copyFile(path.join(src, 'LICENSE'), path.join(out, 'LICENSE-three.txt'));
await fs.writeFile(path.join(out, 'VERSION'), `three ${pkg.version}\n`);
console.log(`vendored three ${pkg.version}`);
