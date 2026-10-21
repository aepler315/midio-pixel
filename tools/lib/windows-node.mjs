// Native Windows Node from WSL, as gpu-review.mjs runs the RTX 3060 review:
// WSL's Linux Chromium cannot reach the local GPU, native Windows Chromium can.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const exec = promisify(execFile);

export const isWsl = () => process.platform === 'linux' && /microsoft/i.test(os.release());
export const isWindowsPath = value => /^[a-z]:[\\/]|^\\\\/i.test(value);

export async function toWindowsPath(value) {
  return isWindowsPath(value) ? value
    : (await exec('wslpath', ['-w', path.resolve(value)], { windowsHide: true })).stdout.trim();
}

// npm dependencies may be symlinked to a Linux checkout. Resolve the installed
// Playwright package before crossing into native Windows Node. Returns the
// file URL to pass to Windows Node's --import.
export async function writePlaywrightLoader(dir) {
  const playwright = await toWindowsPath(await fs.realpath(fileURLToPath(import.meta.resolve('playwright'))));
  const loader = path.join(dir, 'windows-loader.mjs');
  await fs.writeFile(loader, `import {registerHooks} from 'node:module';\nimport {pathToFileURL} from 'node:url';\nconst url=pathToFileURL(${JSON.stringify(playwright)}).href;\nregisterHooks({resolve(s,c,next){return s==='playwright'?{url,shortCircuit:true}:next(s,c);}});\n`);
  return pathToFileURL(await toWindowsPath(loader), { windows: true }).href;
}

export async function runChild(executable, args, cwd) {
  const child = spawn(executable, args, { cwd, stdio: 'inherit', windowsHide: true });
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
