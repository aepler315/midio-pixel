// Render-cost profiler: draws fixed export frames, records per-frame wall time
// and a V8 CPU profile, and prints self time grouped by function. Frames are
// hashed so a change can be checked for pixel identity against a prior run.
//
//   node tools/render-hotspots.mjs --url http://localhost:8080/ --wav song.wav
//     [--width 1280] [--height 720] [--frames 40] [--from 2000] [--step 1500]
//     [--params k=v,k=v] [--out report.json] [--png-dir DIR] [--top 40]
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { openSong } from './range-scene-smoke.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].slice(2)] = process.argv[i + 1];
if (!args.url || !args.wav) throw new Error('--url and --wav required');
const width = +(args.width || 1280), height = +(args.height || 720);
const frames = +(args.frames || 40), from = +(args.from || 2000), step = +(args.step || 1500);
const top = +(args.top || 40);
const params = Object.fromEntries((args.params || '').split(',').filter(Boolean).map(kv => kv.split('=')));

const browser = await chromium.launch(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {});
const { page, context, errors } = await openSong(browser, { url: args.url, wav: path.resolve(args.wav), width, height, params });
const cdp = await context.newCDPSession(page);

const drawFrame = t => page.evaluate(async t => {
  const smw = window.__SMW;
  const t0 = performance.now();
  smw.renderExportFrame(t);
  const ms = performance.now() - t0;
  if (await smw.rangeSettle?.()) smw.renderExportFrame(t);
  return ms;
}, t);
const grab = () => page.evaluate(() => {
  const c = document.querySelector('#stage');
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (ctx) return Array.from(new Uint8Array(ctx.getImageData(0, 0, c.width, c.height).data.buffer));
  return null;
});

// Warm up: one pass over every timestamp so scenic views and lazy caches
// exist before measuring, then rewind via the export clock reset.
const times = Array.from({ length: frames }, (_, i) => from + i * step);
for (const t of times) await drawFrame(t);
await page.evaluate(() => window.__SMW.beginBulkExport(window.__SMW.exportSize));
await page.evaluate(() => window.__SMW.rangeReady({ timeoutMs: 600000 }));

await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
await cdp.send('Profiler.start');
const ms = [], hashes = [];
for (const t of times) {
  ms.push(await drawFrame(t));
  const png = await page.evaluate(() => document.querySelector('#stage').toDataURL('image/png').split(',')[1]);
  hashes.push(createHash('sha256').update(png).digest('hex').slice(0, 16));
  if (args['png-dir']) {
    await fs.mkdir(args['png-dir'], { recursive: true });
    await fs.writeFile(path.join(args['png-dir'], `f${String(t).padStart(6, '0')}.png`), Buffer.from(png, 'base64'));
  }
}
const { profile } = await cdp.send('Profiler.stop');
void grab;

// Self time per (function, file:line).
const byId = new Map(profile.nodes.map(n => [n.id, n]));
const dt = profile.timeDeltas, self = new Map();
for (let i = 0; i < profile.samples.length; i++) {
  const n = byId.get(profile.samples[i]); const f = n.callFrame;
  const key = `${f.functionName || '(anon)'}  ${f.url.replace(/^.*?\/src\//, 'src/')}:${f.lineNumber + 1}`;
  self.set(key, (self.get(key) || 0) + (dt[i] || 0) / 1000);
}
// Inclusive time per function key (count each sample once per distinct key on its stack).
const parent = new Map();
for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
const incl = new Map();
for (let i = 0; i < profile.samples.length; i++) {
  const seen = new Set();
  for (let id = profile.samples[i]; id != null; id = parent.get(id)) {
    const f = byId.get(id).callFrame;
    const key = `${f.functionName || '(anon)'}  ${f.url.replace(/^.*?\/src\//, 'src/')}:${f.lineNumber + 1}`;
    if (!seen.has(key)) { seen.add(key); incl.set(key, (incl.get(key) || 0) + (dt[i] || 0) / 1000); }
  }
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
const sorted = [...ms].sort((a, b) => a - b);
const report = {
  width, height, frames, params,
  frameMs: { mean: ms.reduce((a, b) => a + b, 0) / ms.length, p50: sorted[sorted.length >> 1], p90: sorted[Math.floor(sorted.length * 0.9)], max: sorted.at(-1) },
  perFrame: ms.map(v => +v.toFixed(2)), hashes,
  self: [...self].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, v]) => [k, +v.toFixed(1), +(100 * v / total).toFixed(1)]),
  inclusive: [...incl].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k, v]) => [k, +v.toFixed(1), +(100 * v / total).toFixed(1)]),
  errors,
};
if (args.out) await fs.writeFile(args.out, JSON.stringify(report, null, 1));
console.log(`frame ms mean ${report.frameMs.mean.toFixed(1)} p50 ${report.frameMs.p50.toFixed(1)} p90 ${report.frameMs.p90.toFixed(1)} max ${report.frameMs.max.toFixed(1)}`);
console.log('\nSELF ms  %');
for (const [k, v, p] of report.self) console.log(String(v).padStart(8), String(p).padStart(5), k);
console.log('\nINCLUSIVE ms  %');
for (const [k, v, p] of report.inclusive) console.log(String(v).padStart(8), String(p).padStart(5), k);
await browser.close();
