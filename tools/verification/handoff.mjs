import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { argumentsOf, gitState, hash, readJson, writeJson, newDirectory } from './io.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [mode, ...argv] = process.argv.slice(2);
function snapshot() {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const changedFiles = [...new Set([...git(['diff', '--name-only', 'HEAD']).trim().split('\n'),
    ...git(['ls-files', '--others', '--exclude-standard']).trim().split('\n')].filter(Boolean))];
  return { ...gitState(root), changedFiles, diffHash: hash(git(['diff', 'HEAD', '--binary'])) };
}
if (mode === 'create') {
  const args = argumentsOf(argv, ['--record', '--out']);
  assert.ok(args.record && args.out, 'agent:handoff -- --record progress.json --out NEW_DIR');
  const record = await readJson(path.resolve(args.record));
  for (const key of ['objective', 'decisions', 'tests', 'visual', 'performance', 'problems', 'remaining', 'next']) {
    assert.ok(typeof record[key] === 'string' && record[key].trim(), `handoff requires ${key}; use an explicit unrun/none statement when appropriate`);
  }
  const state = snapshot(), out = path.resolve(args.out); await newDirectory(out);
  await writeJson(path.join(out, 'report.json'), { version: 1, createdAt: new Date().toISOString(), state, record });
  await fs.writeFile(path.join(out, 'HANDOFF.md'), '# Continuation handoff\n\nVerify current Git state before trusting this record.\n\n' +
    `Branch: ${state.branch}; commit: ${state.commit}\n\nActual uncommitted files:\n${state.changedFiles.map(f => '- ' + f).join('\n') || 'None'}\n\n` +
    Object.entries(record).map(([key, value]) => `## ${key}\n\n${value}\n`).join('\n') + '\nCommitted changes: inspect `git log` and `git diff <task-base>...HEAD`; uncommitted files above are not the whole task history.\n');
  console.log(path.join(out, 'HANDOFF.md'));
} else if (mode === 'resume') {
  const args = argumentsOf(argv, ['--handoff']); assert.ok(args.handoff, 'agent:resume -- --handoff DIR');
  const saved = await readJson(path.join(path.resolve(args.handoff), 'report.json')), current = snapshot();
  assert.equal(saved.version, 1, 'unsupported handoff');
  const matches = JSON.stringify(current) === JSON.stringify(saved.state);
  console.log(JSON.stringify({ matches, saved: saved.state, current, instruction: matches ?
    'Git state matches. Verify named evidence and current requirements before the recorded next action.' :
    'Git state changed. Reconcile git log/status/diff, evidence and current requirements before following the recorded next action.' }, null, 2));
  if (!matches) process.exitCode = 1;
} else throw Error('Expected create or resume');
