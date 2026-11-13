// Model/provider independent: records checks; never invents a model or score.
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { argumentsOf, gitState, readJson, writeJson, newDirectory } from './io.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tasks = (await readJson(path.join(root, 'evaluations/tasks.json'))).tasks;
const args = argumentsOf(process.argv.slice(2), ['--task', '--out', '--model', '--artifacts', '--assessment']);
if (!args.task) console.log(tasks.map(t => `${t.id}: ${t.title}`).join('\n'));
else {
  const task = tasks.find(t => t.id === args.task); assert.ok(task, 'unknown evaluation task'); assert.ok(args.out, '--out is required');
  const out = path.resolve(args.out); await newDirectory(out);
  const report = { version: 1, task, model: args.model || 'unspecified', state: gitState(root), checks: [],
    score: null, evaluationStatus: 'automated-checks-only; manual acceptance unassessed', artifacts: args.artifacts || null };
  try {
    // Files are selected from the committed task catalog, never from model output.
    for (const file of task.checks) {
      assert.match(file, /^[A-Za-z0-9-]+\.test\.(?:mjs|js)$/);
      const run = spawnSync(process.execPath, ['--test', `test/${file}`], { cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
      await fs.writeFile(path.join(out, `${file}.log`), (run.stdout || '') + (run.stderr || '') + (run.error?.stack || ''));
      report.checks.push({ file, status: run.status === 0 ? 'passed' : 'failed', exitCode: run.status, signal: run.signal, error: run.error?.message });
    }
    if (args.assessment) {
      const assessment = await readJson(path.resolve(args.assessment));
      assert.ok(assessment.reviewer && assessment.evidence && assessment.scores?.length === task.rubric.length, 'reviewer, evidence and rubric scores required');
      report.score = assessment.scores.reduce((sum, score, i) => {
        assert.ok(Number.isFinite(score) && score >= 0 && score <= task.rubric[i].points, 'invalid score'); return sum + score;
      }, 0);
      report.assessment = assessment; report.evaluationStatus = 'manually-assessed';
    }
  } finally { await writeJson(path.join(out, 'report.json'), report); }
  if (report.checks.some(c => c.status !== 'passed')) process.exitCode = 1;
  console.log(JSON.stringify({ task: task.id, checks: report.checks, score: report.score, status: report.evaluationStatus }, null, 2));
}
