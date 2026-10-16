import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { stageSite, assertStagePaths } from './stage-site.mjs';
import { readHistory } from './lib/version-history.mjs';
import { HISTORY_ENGINE_BRIDGE } from '../src/ui/HistoryFiles.js';

export const MAX_HISTORY_BYTES = 838860800;
export async function stageHistory({ sourceDir = '.', outputDir = '_site', ref = 'HEAD', historyDir = sourceDir } = {}) {
  const { source, output } = await assertStagePaths(sourceDir, outputDir);
  const history = readHistory(path.resolve(historyDir), ref);
  const bySha = new Map(history.revisions.map(r => [r.sha, r]));
  const objects = new Set();
  for (const entry of history.entries.filter(e => !e.live)) for (const blob of Object.values(bySha.get(entry.sourceSha).files)) objects.add(blob);
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'midio-history-')); const staged = path.join(scratch, 'site');
  try {
    await stageSite(source, staged);
    const mainPath = path.join(staged, 'src/main.js');
    const main = await fs.readFile(mainPath, 'utf8');
    if (!main.includes('__MIDIO_VERSION_ADAPTER')) await fs.appendFile(mainPath, HISTORY_ENGINE_BRIDGE);
    await fs.mkdir(path.join(staged, 'engine'));
    const original = await fs.readFile(path.join(staged, 'index.html'), 'utf8');
    await fs.writeFile(path.join(staged, 'engine/index.html'), cleanEngineHtml(original).replace('<head>', '<head><base href="../">'));
    await fs.copyFile(path.join(source, 'src/ui/history-shell.html'), path.join(staged, 'index.html'));
    await fs.copyFile(path.join(source, 'src/ui/history-worker.js'), path.join(staged, 'history-worker.js'));
    const versions = path.join(staged, 'versions');
    await fs.mkdir(path.join(versions, 'maps'), { recursive: true });
    await fs.mkdir(path.join(versions, 'objects'), { recursive: true });
    for (const entry of history.entries.filter(e => !e.live)) {
      await fs.writeFile(path.join(versions, 'maps', `${entry.id}.json`), JSON.stringify(bySha.get(entry.sourceSha).files));
      entry.entryPath = `versions/run/${entry.id}/`;
    }
    history.entries.at(-1).entryPath = 'engine/index.html';
    // One batch reads each unique Git object exactly once. Unlike git archive
    // per version, this neither duplicates large soundfonts nor patches renderers.
    const ids = [...objects];
    const batch = execFileSync('git', ['-C', path.resolve(historyDir), 'cat-file', '--batch'], { input: ids.join('\n') + '\n', maxBuffer: MAX_HISTORY_BYTES });
    let cursor = 0, objectBytes = 0;
    for (const id of ids) {
      const end = batch.indexOf(10, cursor); const header = batch.subarray(cursor, end).toString();
      const match = /^([a-f0-9]{40}) blob (\d+)$/.exec(header);
      if (!match || match[1] !== id) throw new Error(`Historical blob missing: ${id}`);
      const size = Number(match[2]); cursor = end + 1;
      await fs.writeFile(path.join(versions, 'objects', id), batch.subarray(cursor, cursor + size));
      cursor += size + 1; objectBytes += size;
    }
    const manifest = { schema: 2, buildSha: history.buildSha, liveId: history.liveId, entries: history.entries };
    await fs.writeFile(path.join(versions, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    const report = { schema: 2, buildSha: history.buildSha, commits: history.revisions.length, versions: history.entries.length, uniqueObjects: ids.length, objectBytes, audit: history.audit };
    await fs.writeFile(path.join(versions, 'build-report.json'), JSON.stringify(report, null, 2) + '\n');
    report.totalBytes = await treeBytes(staged);
    if (report.totalBytes > MAX_HISTORY_BYTES) throw new Error(`Complete history exceeds the site budget: ${report.totalBytes} bytes. No versions were omitted.`);
    await fs.writeFile(path.join(versions, 'build-report.json'), JSON.stringify(report, null, 2) + '\n');
    await fs.rm(output, { recursive: true, force: true });
    await fs.cp(staged, output, { recursive: true });
    return report;
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }
}
export function cleanEngineHtml(html) {
  return html.replace(/<script[^>]*id="midio-version-metadata"[\s\S]*?<\/script>/g, '')
    .replace(/<script[^>]*src="[^"]*VersionBootstrap\.js"[^>]*><\/script>/g, '')
    .replace(/<link[^>]*href="[^"]*version-navigation\.css"[^>]*>/g, '');
}
async function treeBytes(root) {
  let size = 0;
  for (const item of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, item.name);
    if (item.isDirectory()) size += await treeBytes(file);
    else if (item.isFile()) size += (await fs.stat(file)).size;
    else throw new Error('Non-regular staged file.');
  }
  return size;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  stageHistory({ sourceDir: process.argv[2] || '.', outputDir: process.argv[3] || '_site' }).then(r => console.log(`Staged ${r.versions} versions from ${r.commits} commits; ${r.uniqueObjects} shared objects; ${r.totalBytes} bytes.`)).catch(e => { console.error(e.message); process.exitCode = 1; });
}
