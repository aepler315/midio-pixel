import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { compareFlickerReports } from './lib/forest-flicker.mjs';

const [baseline, candidate, output] = process.argv.slice(2);
assert.ok(baseline && candidate && output, 'baseline directory, candidate directory and new output directory required');
await fs.mkdir(output, { recursive: false });
const b = JSON.parse(await fs.readFile(path.join(baseline, 'report.json')));
const c = JSON.parse(await fs.readFile(path.join(candidate, 'report.json')));
const result = compareFlickerReports(b, c);
await fs.writeFile(path.join(output, 'comparison.json'), JSON.stringify(result, null, 2) + '\n');
const rel = directory => encodeURI(path.relative(output, directory).split(path.sep).join('/'));
const rows = [['Baseline', rel(baseline)], ['Candidate', rel(candidate)]];
await fs.writeFile(path.join(output, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Forest flicker comparison</title>
<style>body{background:#171b20;color:#e2e8ef;font:16px system-ui;margin:24px}a{color:#9dcaff}.pair{display:flex;gap:20px;flex-wrap:wrap}img{max-width:100%}figure{margin:0}pre{white-space:pre-wrap}</style>
<h1>Fixed 40s pose: ${result.pass ? 'PASS' : 'FAIL'}</h1><p>Original 512×512 crop; 16 lateral steps across one pixel at 6 km. Time, orientation, gusts and history fixed. Gate: candidate mean absolute crop-brightness change is no greater than baseline.</p>
<input id="step" type="range" min="0" max="16" value="0"><span id="offset">0 px</span>
<div class="pair">${rows.map(([label, directory]) => `<figure><figcaption>${label}</figcaption><img data-directory="${directory}" src="${directory}/flicker/crop-step-00.png"><p><a href="${directory}/index.html">Full frames, audio and provenance</a></p></figure>`).join('')}</div>
<pre>${JSON.stringify(result, null, 2)}</pre><p><a href="comparison.json">Comparison JSON</a></p>
<script>step.oninput=()=>{offset.textContent=(step.value/16).toFixed(4)+' px';for(const img of document.querySelectorAll('img'))img.src=img.dataset.directory+'/flicker/crop-step-'+String(step.value).padStart(2,'0')+'.png';};</script>`);
console.log(JSON.stringify(result));
assert.equal(result.pass, true, 'candidate crop brightness flicker exceeds baseline');
