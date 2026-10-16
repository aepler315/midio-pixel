import test from 'node:test';
import assert from 'node:assert/strict';
import { groupHistory, isPublicPath } from '../tools/lib/version-history.mjs';
const rev = (n, files, uiOnly = false) => ({ sha: n.toString(16).padStart(40, '0'), date: '2026-07-02', subject: `Version ${n}`, files: { 'index.html': 'a', 'src/main.js': 'b', ...files }, uiOnly });
test('folds UI-only updates onto newest code while retaining visual label and every audit row', () => {
  const result = groupHistory([rev(1, { 'src/render/World.js': 'c' }), rev(2, { 'src/render/World.js': 'c', 'src/ui/style.css': 'd' }), rev(3, { 'src/render/World.js': 'e' }), rev(4, { 'src/render/World.js': 'e', 'src/main.js': 'f' }, true)]);
  assert.deepEqual(result.entries.map(e => e.sourceSha), [rev(2).sha, rev(4).sha]);
  assert.deepEqual(result.entries.map(e => e.visualSha), [rev(1).sha, rev(3).sha]);
  assert.equal(result.entries[1].label, 'Version 3');
  assert.equal(result.audit.length, 4);
  assert.equal(result.entries[1].live, true);
  assert.equal(result.entries[0].live, false);
});
test('retains a return to an earlier renderer as its own chronological version', () => {
  assert.equal(groupHistory([rev(1, { 'src/render/World.js': 'c' }), rev(2, { 'src/render/World.js': 'd' }), rev(3, { 'src/render/World.js': 'c' })]).entries.length, 3);
});
test('main runtime changes are retained unless explicitly reviewed as UI-only', () => {
  assert.equal(groupHistory([rev(1), rev(2, { 'src/main.js': 'changed' })]).entries.length, 2);
});
test('excludes pre-application history and permits only regular public paths', () => {
  const result = groupHistory([{ sha: '0'.repeat(40), files: {}, subject: 'README' }, rev(1)]);
  assert.equal(result.entries.length, 1); assert.equal(result.audit[0].reason, 'no-runnable-app');
  for (const p of ['index.html', 'src/main.js', 'soundfonts/a.sf2']) assert.equal(isPublicPath(p), true);
  for (const p of ['src/../private', 'src/.secret', '/src/main.js', 'src\\main.js', 'tools/key.js']) assert.equal(isPublicPath(p), false);
});

test('complete staging stores shared bytes once and records every revision', async t => {
  const fs = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  const { execFileSync } = await import('node:child_process');
  const { stageHistory } = await import('../tools/stage-history.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'midio-history-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'), out = path.join(dir, 'site');
  await fs.mkdir(path.join(repo, 'src/ui'), { recursive: true }); await fs.mkdir(path.join(repo, 'src/render'), { recursive: true }); await fs.mkdir(path.join(repo, 'soundfonts'));
  for (const [name, body] of Object.entries({ 'index.html': '<html><head></head><body></body></html>', CNAME: 'example.test', 'src/main.js': 'export const boot = true;', 'src/render/World.js': 'old', 'src/ui/history-shell.html': '<html>picker</html>', 'src/ui/history-worker.js': '/* worker */', 'soundfonts/test.bin': 'large shared bytes', 'private.txt': 'never publish' })) await fs.writeFile(path.join(repo, name), body);
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  const commit = title => { git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', title); return git('rev-parse', 'HEAD'); };
  commit('first visual'); await fs.writeFile(path.join(repo, 'src/render/World.js'), 'second'); const second = commit('second visual');
  await fs.writeFile(path.join(repo, 'src/ui/style.css'), 'new UI'); const newest = commit('UI update');
  await fs.writeFile(path.join(repo, 'src/render/World.js'), 'third'); commit('third visual');
  const report = await stageHistory({ sourceDir: repo, outputDir: out });
  assert.equal(report.commits, 4); assert.equal(report.versions, 3);
  const manifest = JSON.parse(await fs.readFile(path.join(out, 'versions/manifest.json'), 'utf8'));
  assert.equal(manifest.entries[1].visualSha, second); assert.equal(manifest.entries[1].sourceSha, newest);
  const maps = await Promise.all(manifest.entries.filter(e => !e.live).map(async e => JSON.parse(await fs.readFile(path.join(out, 'versions/maps', e.id + '.json'), 'utf8'))));
  assert.equal(maps[0]['soundfonts/test.bin'], maps[1]['soundfonts/test.bin']);
  const hash = maps[0]['soundfonts/test.bin']; assert.equal(await fs.readFile(path.join(out, 'versions/objects', hash), 'utf8'), 'large shared bytes');
  assert.ok(report.uniqueObjects < maps.reduce((n, m) => n + Object.keys(m).length, 0));
  await assert.rejects(fs.access(path.join(out, 'private.txt')));
  assert.equal(report.audit.length, 4);
});

test('HTML renderer bootstrap changes remain versions, while root URL portability is UI-only', async () => {
  const { indexRuntimeSignature } = await import('../tools/lib/version-history.mjs');
  const a = '<canvas id="stage" width="1280" height="720"></canvas><script type="module" src="/src/main.js"></script>';
  assert.equal(indexRuntimeSignature(a), indexRuntimeSignature(a.replace('/src/', './src/')));
  const first = { ...rev(1), indexRuntime: indexRuntimeSignature(a) };
  const second = { ...rev(2), indexRuntime: indexRuntimeSignature(a.replace('1280', '640')) };
  assert.equal(groupHistory([first, second]).entries.length, 2);
});
