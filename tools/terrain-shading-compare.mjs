// Strict scene-state gate followed by the existing hash-checked artifact copy.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { compareTerrainReports } from './lib/terrain-shading-comparison.mjs';
import { renderTerrainReport } from './lib/terrain-shading-report.mjs';

const [before, after, out] = process.argv.slice(2);
assert.ok(before && after && out, 'usage: BEFORE AFTER OUTPUT');
const read = async dir => JSON.parse(await fs.readFile(path.join(dir, 'report.json'), 'utf8'));
const baseline = await read(before), candidate = await read(after);
const diff = compareTerrainReports(baseline, candidate);
execFileSync(process.execPath, ['tools/visual-evaluate.mjs', '--compare', before, after, '--out', out], { stdio: 'inherit' });
await fs.writeFile(path.join(out, 'terrain-state.json'), JSON.stringify(diff, null, 2));
await fs.writeFile(path.join(out, 'index.html'), renderTerrainReport(baseline, candidate));
console.log('Actual camera, lighting, weather, audio, loaded assets and presentation match. Artistic verdict remains unreviewed.');
