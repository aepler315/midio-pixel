// Explicit, non-overwriting review operation. Capture/compare never call it.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { argumentsOf, readJson, writeJson, newDirectory } from './io.mjs';
import { compareCapture } from './contracts.mjs';
import { verifiedImage } from './images.mjs';
const args = argumentsOf(process.argv.slice(2), ['--candidate', '--out', '--reviewer', '--reason', '--source-commit']);
assert.ok(args.candidate && args.out && args.reviewer?.trim() && args.reason?.trim(), 'Usage: npm run verify:visual:approve -- --candidate DIR --out NEW_REFERENCE --reviewer NAME --reason TEXT [--source-commit FULL_SHA]');
const report = await readJson(path.join(args.candidate, 'report.json'));
assert.equal(report.status, 'passed', 'cannot approve a failed capture');
if (args['source-commit']) {
  assert.match(args['source-commit'], /^[a-f0-9]{40}$/);
  assert.equal(report.source.commit, args['source-commit'], 'approved-source commit mismatch');
  assert.equal(report.source.dirty, '', 'approved-source checkout must be clean');
}
report.approval = { reviewer: args.reviewer, reason: args.reason, at: new Date().toISOString(),
  kind: args['source-commit'] ? 'approved-source-comparison' : 'inspected-images', artisticVerdict: 'unreviewed' };
compareCapture(report, report);
for (const frame of report.frames) await verifiedImage(args.candidate, frame);
await newDirectory(path.resolve(args.out));
for (const frame of report.frames) await fs.copyFile(path.join(args.candidate, frame.png), path.join(args.out, frame.png));
// The corpus, identities, source and frames are sufficient to reproduce/check it;
// large state traces and copied audio stay with the candidate evidence.
report.frames = report.frames.map(({ id, png, sha256, width, height }) => ({ id, png, sha256, width, height }));
delete report.diagnostics;
await writeJson(path.join(args.out, 'report.json'), report);
console.log(`Reference created: ${args.out} (${report.approval.kind}; artistic judgment unreviewed)`);
