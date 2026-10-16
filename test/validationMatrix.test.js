// QA-001: the published matrix has to name every CI job. A new workflow
// job that never appears in docs/test-matrix.md is how coverage quietly
// drifts away from the document.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(join(root, '.github/workflows/test.yml'), 'utf8');
const matrix = readFileSync(join(root, 'docs/test-matrix.md'), 'utf8');
const worldEval = readFileSync(join(root, 'docs/world-quality-evaluation.md'), 'utf8');

function workflowJobs(text) {
  const jobs = [];
  let inJobs = false;
  for (const line of text.split('\n')) {
    if (/^jobs:\s*$/.test(line)) { inJobs = true; continue; }
    if (!inJobs) continue;
    if (/^\S/.test(line) && !line.startsWith(' ')) break;
    const m = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (m) jobs.push(m[1]);
  }
  return jobs;
}

test('every Test workflow job is named in the validation matrix', () => {
  const jobs = workflowJobs(workflow);
  assert.ok(jobs.length >= 2, `expected CI jobs, got ${jobs.join(',')}`);
  for (const job of jobs) {
    assert.match(matrix, new RegExp('`' + job + '`'), `docs/test-matrix.md must mention job ${job}`);
  }
});

test('the matrix states the unverified remainder instead of implying full coverage', () => {
  assert.match(matrix, /Real-browser IndexedDB/);
  assert.match(matrix, /Firefox and Safari/);
  assert.match(matrix, /Maximum-duration export/);
  assert.match(matrix, /claimed: false/);
});

test('world-quality evaluation still treats 80% as a target, not a result', () => {
  assert.match(worldEval, /target to validate/);
  assert.match(worldEval, /claimed: false/);
});
