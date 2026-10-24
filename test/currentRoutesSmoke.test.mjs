import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || chromium.executablePath();

test('a blocked renderer is closed at the route deadline and leaves a failed report', {
  skip: !existsSync(executablePath) && 'Chromium unavailable; set PLAYWRIGHT_CHROMIUM_PATH', timeout: 30000,
}, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'current-routes-deadline-'));
  let child;
  try {
    const site = path.join(directory, 'site'), out = path.join(directory, 'out'), audio = path.join(directory, 'unused.wav');
    await fs.mkdir(path.join(site, 'src'), { recursive: true });
    await fs.writeFile(path.join(site, 'index.html'), '<!doctype html><script src="/src/main.js"></script>');
    await fs.writeFile(path.join(site, 'src/main.js'), 'for (;;) {}');
    // The blocked entry never reaches upload. No audio decoder is substituted.
    await fs.writeFile(audio, 'unused before upload');
    const env = { ...process.env, PLAYWRIGHT_CHROMIUM_PATH: executablePath };
    for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete env[key];
    child = spawn(process.execPath, [path.join(root, 'tools/current-routes-smoke.mjs'),
      '--site-root', site, '--out', out, '--audio', audio, '--timeout-ms', '1000'],
    { cwd: root, env, detached: process.platform !== 'win32', stdio: 'ignore' });
    let timer;
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => { clearTimeout(timer); resolve({ code, watchdog: false }); });
      timer = setTimeout(() => resolve({ watchdog: true }), 20000);
    });
    assert.equal(result.watchdog, false, 'a page stuck in JavaScript defeated the route deadline');
    assert.equal(result.code, 1, 'blocked routes must exit nonzero');
    const report = JSON.parse(await fs.readFile(path.join(out, 'report.json'), 'utf8'));
    assert.equal(report.status, 'failed');
    assert.equal(report.routes.length, 4);
    assert.ok(report.routes.every(row => row.status === 'failed' && /exceeded 1000 ms/.test(row.failure)));
  } finally {
    if (child?.pid) {
      try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill(); } catch { /* already closed */ }
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
});
