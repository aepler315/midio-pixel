import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
export const hash = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const readJson = async file => JSON.parse(await fs.readFile(file, 'utf8'));
export const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
export function gitState(root) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return { commit: git(['rev-parse', 'HEAD']), branch: git(['branch', '--show-current']), dirty: git(['status', '--porcelain']) };
}
export function argumentsOf(argv, allowed) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]; if (!allowed.includes(key) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw Error(`Unknown or incomplete option: ${key}`);
    out[key.slice(2)] = argv[++i];
  }
  return out;
}
export async function newDirectory(dir) { await fs.mkdir(path.dirname(dir), { recursive: true }); await fs.mkdir(dir); }
