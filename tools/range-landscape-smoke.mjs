// Deterministic, full-composite browser evidence. See docs/range-landscape-validation.md.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { casesForPreset, caseId, RANGE_FIXTURES, requireBiomes } from './lib/landscape-fixtures.mjs';
import { assertActualDpr, assertCaptureState, claimCase, sha256File, sha256Text, verifyServedIdentity } from './lib/landscape-evidence.mjs';
import { visibleCrestFraction, bodyAreaFraction } from './lib/landscape-visibility.mjs';
import { installLandscapeRanges, paintLandscapeFrame, seedBrowserConstruction } from './lib/landscape-browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULES = ['src/world/BiomeManager.js', 'src/world/SpaceRidge.js', 'src/world/ConstellationWeaver.js',
  'src/world/alpine/RidgeSurfaceDraw.js', 'src/world/alpine/RidgeSurface.js',
  'src/world/alpine/LandscapePolicy.js', 'src/render/Renderer.js',
  // The capture also asserts quality/draw-count state (main.js, the
  // governor) and draws Broshi deterministically: evidence must come from
  // the reviewed copies of those too.
  'src/main.js', 'src/render/PerfGovernor.js', 'src/sim/Broshi.js'];
const OPTIONAL_MODULES = ['src/world/alpine/RidgeComposition.js', 'src/world/alpine/RangeSkyComposition.js'];
const NAMED = new Set(['url', 'source-root', 'expect-sha', 'preset', 'output', 'stage', 'filter']);
export function parseLandscapeArgs(argv) {
  if (!argv.slice(2).some(arg => arg.startsWith('--'))) return {
    legacy: true, url: argv[2] || 'http://127.0.0.1:8080',
    output: argv[3] || '.smoke/range-landscape', stage: argv[4] || 'candidate', preset: 'primary',
  };
  const out = { legacy: false, preset: 'primary' };
  for (let i = 2; i < argv.length; i++) {
    const key = argv[i].slice(2);
    if (!argv[i].startsWith('--') || !NAMED.has(key)) throw new Error(`unknown landscape flag ${argv[i]}`);
    const value = argv[++i];
    if (value == null || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    out[key] = value;
  }
  if (!out.url || !out['source-root'] || !out['expect-sha']) {
    throw new Error('named landscape runs require --url, --source-root and --expect-sha');
  }
  casesForPreset(out.preset);
  return out;
}

function frameMetrics(detail, spec) {
  const scenic = detail.masks.filter(m => /^L[2-5]$/.test(m.id));
  const sceneMasks = detail.masks.filter(m => /^L[2-5]$/.test(m.id) || m.id === 'massif');
  // Settled frames have one opaque mask per layer. A/B seams are reported as
  // geometry only here; do not pretend both full side masks are fully visible.
  const visible = spec.transition ? null : {
    horizon: visibleCrestFraction(detail.horizon, sceneMasks),
    L2: visibleCrestFraction(scenic.find(m => m.id === 'L2')?.samples,
      scenic.filter(m => m.id !== 'L2')),
  };
  const layers = scenic.map(m => {
    const ys = m.samples.map(p => p.y);
    return { id: m.id, biome: m.biome, drawHeight: m.drawHeight,
      reliefPx: ys.length ? Math.max(...ys) - Math.min(...ys) : 0,
      topFraction: ys.length ? Math.min(...ys) / spec.height : null,
      // Body area above the actual rendered terrain. Front masks can occlude it.
      areaAboveGround: bodyAreaFraction(m.samples, detail.ground, spec.width, spec.height) };
  });
  return { visible, layers };
}

export async function captureLandscapeCase(page, spec) {
  const detail = await page.evaluate(paintLandscapeFrame, spec);
  assertActualDpr(spec.dpr, detail.dpr);
  assertCaptureState(detail);
  assert.equal(detail.worldKind, 'alpine');
  for (const side of detail.ranges) assert.deepEqual(side.ids, RANGE_FIXTURES[side.biome],
    `wrong range fixture for ${side.biome}`);
  assert.ok(Math.abs(detail.clock.timeMs - spec.timeMs) <= 1000 / 120 + 0.01, 'capture clock drift');
  if (spec.transition) {
    assert.equal(detail.blend.travel, true, 'travel seam fixture must activate biome travel');
    assert.equal(detail.blend.travelP, spec.transition.t, 'travel seam position drift');
    assert.deepEqual([...new Set(detail.travelCompositeLayers)].sort(), ['L2', 'L3', 'L4', 'L5'],
      'travel seam must composite every scenic layer');
  }
  const id = caseId(spec, { fixtureHash: spec.fixtureHash });
  const filename = spec.label === 'motion'
    ? `motion-${String(spec.station).padStart(4, '0')}.png`
    : `${spec.stage}-${id.replace(/[^a-zA-Z0-9._-]/g, '_')}.png`;
  await fs.writeFile(path.join(spec.output, filename), Buffer.from(detail.pngData, 'base64'));
  const metrics = frameMetrics(detail, spec);
  delete detail.pngData;
  delete detail.masks;
  delete detail.horizon;
  return { caseId: id, png: filename, spec: { ...spec, output: undefined }, ...detail, metrics };
}

async function verifySource(url, sourceRoot, sha, original = null) {
  const expectedHashes = {}, servedHashes = {};
  const files = original ? Object.keys(original.hashes) : MODULES.concat((await Promise.all(
    OPTIONAL_MODULES.map(async file => await fs.access(path.join(sourceRoot, file)).then(() => file, () => null)))).filter(Boolean));
  for (const file of files) {
    expectedHashes[file] = original?.hashes[file]
      || sha256Text((await fs.readFile(path.join(sourceRoot, file), 'utf8')).replace(/\r\n/g, '\n'));
    const response = await fetch(new URL(file, url.endsWith('/') ? url : url + '/'));
    if (!response.ok) throw new Error(`cannot fetch served ${file}: ${response.status}`);
    servedHashes[file] = sha256Text((await response.text()).replace(/\r\n/g, '\n'));
  }
  verifyServedIdentity({ expectSha: sha, expectedHashes, served: { hashes: servedHashes } });
  return { expectedCommit: sha, hashes: servedHashes };
}

async function main() {
  const args = parseLandscapeArgs(process.argv);
  const sourceRoot = path.resolve(args['source-root'] || root);
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
  if (args['expect-sha'] && !sha.startsWith(args['expect-sha'])) throw new Error(`source is ${sha}, not ${args['expect-sha']}`);
  const dirty = !!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal', '--', '.'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
  const output = path.resolve(args.output || '.smoke/range-landscape');
  await fs.mkdir(output, { recursive: true });
  const wav = path.join(output, 'synthetic-96s.wav');
  execFileSync(process.execPath, [path.join(root, 'tools/gen-test-wav.mjs'), wav, '120', '96']);
  const fixtureHash = await sha256File(wav);
  const served = await verifySource(args.url, sourceRoot, sha);
  const stage = args.stage || 'candidate';
  const report = { sha, dirty, sourceRoot, served, fixtureHash, stage, preset: args.preset, cases: [], pageErrors: [] };
  const jobs = casesForPreset(args.preset).filter(job => !args.filter || `${job.biome} ${job.label}`.includes(args.filter));
  if (!jobs.length) throw new Error('no matching capture cases');
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {});
  report.browser = browser.version();
  let context = null, page = null, loadedKey = null;
  const seen = new Set();
  try {
    for (const job of jobs) {
      const key = [job.seed, job.width, job.height, job.dpr].join(':');
      if (key !== loadedKey) {
        if (context) await context.close();
        context = await browser.newContext({ viewport: { width: job.width, height: job.height },
          deviceScaleFactor: job.dpr, serviceWorkers: 'block' });
        await context.addInitScript(seedBrowserConstruction, job.seed);
        page = await context.newPage();
        page.on('pageerror', e => report.pageErrors.push(e.message));
        await page.route('**/soundfonts/', route => route.fulfill({ json: [] }));
        const entry = new URL(args.url);
        entry.searchParams.set('bulkExport', '1');
        // This suite measures the legacy ridge painters (the L2-L5 masks);
        // Range v2 is the default renderer, so pin legacy explicitly.
        entry.searchParams.set('rangeRenderer', 'legacy');
        entry.searchParams.set('exportW', String(job.width * job.dpr));
        entry.searchParams.set('exportH', String(job.height * job.dpr));
        await page.goto(entry.href);
        await page.locator('#titleSettings').evaluate(node => { node.open = true; });
        const lyrics = page.locator('#lyricGroundingBtn');
        if (await lyrics.getAttribute('aria-pressed') === 'true') await lyrics.click();
        await page.locator('#fileInput').setInputFiles(wav);
        await page.waitForFunction(() => window.__SMW?.exportReady || window.__SMW_EXPORT_ERROR, null, { timeout: 120000 });
        const error = await page.evaluate(() => window.__SMW_EXPORT_ERROR);
        if (error) throw new Error(error);
        report.fixture = await page.evaluate(installLandscapeRanges, RANGE_FIXTURES);
        loadedKey = key;
      }
      claimCase(seen, caseId(job, { fixtureHash }));
      const record = await captureLandscapeCase(page, { ...job, output, stage, sha, fixtureHash });
      report.cases.push(record);
      console.log(`${stage} ${job.biome} ${job.label} ${Math.round(job.timeMs)}ms night=${record.night} horizon=${record.metrics.visible?.horizon.fraction.toFixed(2) ?? 'A/B'}`);
    }
    assert.equal(report.pageErrors.length, 0, report.pageErrors.join('\n'));
    if (!args.filter && (args.preset === 'primary' || args.preset === 'full')) {
      requireBiomes(report.cases.map(c => c.spec.biome));
    }
    await verifySource(args.url, sourceRoot, sha, served); // Compare to the frozen starting hashes.
  } finally {
    if (context) await context.close();
    await browser.close();
    await fs.writeFile(path.join(output, `${stage}-report.json`), JSON.stringify(report, null, 2));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
