// Ordinary npm start serves the same complete picker as Pages. A source ZIP
// obtains its public Git history automatically; a clone uses its own objects.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { stageHistory } from './stage-history.mjs';
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let historyDir = source;
if (!process.env.SITE_ROOT) {
  try {
    const gitRoot = execFileSync('git', ['-C', source, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (path.resolve(gitRoot) !== source) throw new Error('Source ZIP');
    if (execFileSync('git', ['-C', source, 'rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim() === 'true') {
      console.log('Fetching complete published history…');
      execFileSync('git', ['-C', source, 'fetch', '--unshallow', 'origin'], { stdio: 'inherit' });
    }
  } catch {
    historyDir = path.join(source, '.midio-history');
    try { await fs.access(path.join(historyDir, 'HEAD')); }
    catch {
      console.log('Downloading published version history (first start only)…');
      execFileSync('git', ['clone', '--bare', 'https://github.com/aepler315/Midio-5.git', historyDir], { stdio: 'inherit' });
    }
  }
  console.log('Building the complete version picker…');
  const report = await stageHistory({ sourceDir: source, outputDir: path.join(source, '_site'), historyDir });
  console.log(`${report.versions} versions ready, from ${report.commits} published revisions.`);
}
const child = spawn(process.execPath, [path.join(source, 'tools/serve.js'), ...process.argv.slice(2)], {
  stdio: 'inherit', env: { ...process.env, SITE_ROOT: process.env.SITE_ROOT || path.join(source, '_site') },
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', code => { process.exitCode = code || 0; });
