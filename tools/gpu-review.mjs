#!/usr/bin/env node
// Local RTX 3060 validation, including native Windows rendering from WSL.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseReviewArgs } from './landscape-review.mjs';
import { snapshotSource, sha256 } from './lib/visual-evaluation-server.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function gpuReviewArgs(argv, now = Date.now()) {
  if (argv.includes('--help') || argv.includes('-h')) return null;
  // The underlying parser rejects headful/open and any unknown flags. Always
  // require real hardware and this GPU, even when called from another script.
  if (argv.includes('--gpu-match')) throw Error('test:gpu requires RTX 3060; use review:landscape for another GPU');
  const args = [...argv, '--hardware-gpu', '--gpu-match', 'RTX 3060', '--no-mp4'];
  if (!argv.includes('--out')) args.push('--out', path.join(root, '.smoke', `gpu-${now}`));
  parseReviewArgs(args);
  return args;
}
async function runChild(executable, args) {
  const child = spawn(executable, args, { cwd: root, stdio: 'inherit', windowsHide: true });
  const stop = signal => child.kill(signal);
  const interrupt = () => stop('SIGINT'), terminate = () => stop('SIGTERM');
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate);
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve(code ?? (signal === 'SIGINT' ? 130 : 143)));
    });
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
  }
}
export async function runGpuReview(argv) {
  const args = gpuReviewArgs(argv);
  if (!args) {
    console.log('npm run test:gpu -- [--out DIR] [--audio song.wav] [--start-ms 0] [--live-seconds 30]\nUses headless, muted Chromium; requires RTX 3060. Other review:landscape options apply.\nWSL automatically uses native Windows Node and Chrome. No hosted jobs or reports are opened.');
    return 0;
  }
  const wsl = process.platform === 'linux' && /microsoft/i.test(os.release());
  if (!wsl) return runChild(process.execPath, [path.join(root, 'tools/landscape-review.mjs'), ...args]);
  const toWindows = async value => (await exec('wslpath', ['-w', path.resolve(value)], { windowsHide: true })).stdout.trim();
  const node = process.env.MIDIO_WINDOWS_NODE || '/mnt/c/Program Files/nodejs/node.exe';
  const chrome = process.env.MIDIO_WINDOWS_CHROME || '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe';
  await fs.access(node);
  const options = parseReviewArgs(args), temp = await fs.mkdtemp(path.join(os.tmpdir(), 'midio-gpu-review-'));
  let frozen;
  try {
    if (!options.snapshot) {
      frozen = await snapshotSource(options.source);
      const snapshot = path.join(temp, 'snapshot'); await fs.mkdir(snapshot);
      for (const bytes of frozen.files.values()) await fs.writeFile(path.join(snapshot, sha256(bytes)), bytes);
      await fs.writeFile(path.join(snapshot, 'manifest.json'), JSON.stringify({ digest: frozen.digest, hashes: frozen.hashes,
        source: { label: 'Local RTX 3060 test', checkout: options.source } }));
      args.push('--snapshot', snapshot);
    }
    if (!options.browser) { await fs.access(chrome); args.push('--browser', chrome); }
    const paths = new Set(['--source', '--snapshot', '--baseline', '--audio', '--out', '--browser']);
    for (let i = 0; i < args.length; i++) if (paths.has(args[i])) {
      const value = args[++i];
      args[i] = /^[a-z]:[\\/]|^\\\\/i.test(value) ? value : await toWindows(value);
    }
    // npm dependencies may be symlinked to a Linux checkout. Resolve the
    // installed Playwright package before crossing into native Windows Node.
    const playwright = await toWindows(await fs.realpath(fileURLToPath(import.meta.resolve('playwright'))));
    const loader = path.join(temp, 'windows-loader.mjs');
    await fs.writeFile(loader, `import {registerHooks} from 'node:module';\nimport {pathToFileURL} from 'node:url';\nconst url=pathToFileURL(${JSON.stringify(playwright)}).href;\nregisterHooks({resolve(s,c,next){return s==='playwright'?{url,shortCircuit:true}:next(s,c);}});\n`);
    const code = await runChild(node, ['--import', pathToFileURL(await toWindows(loader), { windows: true }).href, await toWindows(path.join(root, 'tools/landscape-review.mjs')), ...args]);
    if (frozen && (await snapshotSource(options.source)).digest !== frozen.digest) throw Error('Source changed during GPU review; rerun against the final source');
    return code;
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runGpuReview(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
