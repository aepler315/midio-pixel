import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import { readJson, writeJson, argumentsOf, newDirectory } from './io.mjs';
import { compareCapture, imageMetrics } from './contracts.mjs';
import { verifiedImage } from './images.mjs';
import { escapeHtml } from '../lib/visual-evaluation-report.mjs';
const args = argumentsOf(process.argv.slice(2), ['--baseline', '--candidate', '--out']);
assert.ok(args.baseline && args.candidate && args.out, 'Usage: npm run verify:visual -- --baseline DIR --candidate DIR --out NEW_DIR');
const out = path.resolve(args.out); await newDirectory(out);
const report = { status: 'failed', rows: [], reproduction: process.argv.slice(1), baseline: args.baseline, candidate: args.candidate };
try {
  const base = await readJson(path.join(args.baseline, 'report.json')), candidate = await readJson(path.join(args.candidate, 'report.json'));
  report.referenceApproval = base.approval; report.source = { baseline: base.source, candidate: candidate.source };
  report.browserVersions = { baseline: base.browserVersion, candidate: candidate.browserVersion };
  report.thresholds = base.corpus.thresholds;
  for (const { expected, observed } of compareCapture(base, candidate)) {
    const a = await verifiedImage(args.baseline, expected), b = await verifiedImage(args.candidate, observed);
    const { difference, ...metrics } = imageMetrics(a, b, report.thresholds);
    const png = new PNG({ width: a.width, height: a.height }); png.data = difference;
    const diff = `${observed.id}-diff.png`, before = `${observed.id}-before.png`, after = `${observed.id}-after.png`;
    await fs.writeFile(path.join(out, diff), PNG.sync.write(png));
    await fs.copyFile(path.join(args.baseline, expected.png), path.join(out, before));
    await fs.copyFile(path.join(args.candidate, observed.png), path.join(out, after));
    report.rows.push({ id: observed.id, ...metrics, before, after, diff });
  }
  assert.ok(report.rows.every(r => r.pass), 'visual regression: inspect before/after/difference artifacts');
  report.status = 'passed';
} catch (error) { report.error = error.stack; process.exitCode = 1; console.error(error.message); }
finally {
  await writeJson(path.join(out, 'report.json'), report);
  const summary = `Visual verification: **${report.status}**\n\n` + report.rows.map(r => `- ${r.id}: ${r.pass ? 'pass' : 'FAIL'}; changed ${(r.changedRatio * 100).toFixed(3)}%, SSIM ${r.ssim.toFixed(5)}, edge MAE ${r.edgeMae.toFixed(5)}`).join('\n') + (report.error ? '\n\n' + report.error : '') + '\n';
  await fs.writeFile(path.join(out, 'summary.md'), summary);
  await fs.writeFile(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Visual comparison</title><style>body{background:#182331;color:white;font:16px sans-serif}img{width:32%;image-rendering:pixelated}</style><pre>' + escapeHtml(summary) + '</pre>' + report.rows.map(r => `<h2>${escapeHtml(r.id)}</h2><p>Reference / candidate / absolute difference (magenta)</p><img src="${r.before}"><img src="${r.after}"><img src="${r.diff}">`).join(''));
  console.log(summary);
}
