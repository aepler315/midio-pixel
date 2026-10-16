#!/usr/bin/env node
// Near conifer asset review (natural-rendering Task 2): renders
// src/dev/forest-asset-review.html close, oblique, as a stand and backlit,
// for both near LODs, from a frozen snapshot of the given tree. Evidence
// stays in the (new) output directory; never commit it.
//   node tools/forest-asset-review.mjs .smoke/forest-assets [--root DIR]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { snapshotSource, serveSnapshot } from './lib/visual-evaluation-server.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const out = path.resolve(args[0] || '');
const root = path.resolve(args.includes('--root') ? args[args.indexOf('--root') + 1] : here);
if (!args[0]) throw new Error('usage: forest-asset-review.mjs OUT [--root DIR]');
await fs.mkdir(out);
const server = await serveSnapshot(await snapshotSource(root));
const browser = await chromium.launch({ ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const results = [];
try {
  for (const lod of [0, 1]) for (const shot of ['close', 'oblique', 'stand', 'backlit']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${server.url}/src/dev/forest-asset-review.html?shot=${shot}&lod=${lod}`);
    await page.waitForFunction(() => window.__REVIEW_READY || window.__REVIEW_ERROR, null, { timeout: 300000 });
    const info = await page.evaluate(() => window.__REVIEW);
    const file = `${shot}-lod${lod}.png`;
    await page.locator('canvas').screenshot({ path: path.join(out, file) });
    results.push({ shot, lod, file, info, errors });
    console.log(file, JSON.stringify(info?.assets?.map(a => a.triangles) ?? null), errors.length ? errors : '');
    await page.close();
  }
} finally {
  await browser.close(); await server.close();
  await fs.writeFile(path.join(out, 'review.json'), JSON.stringify({ root, results }, null, 2));
}
