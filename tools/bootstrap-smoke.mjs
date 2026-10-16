import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suppliedUrl = process.argv[2] || '';
const port = Number(process.env.BOOTSTRAP_SMOKE_PORT || 4179);
const url = suppliedUrl || `http://127.0.0.1:${port}`;

async function waitForServer() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      await response.body?.cancel();
      if (response.ok) return;
    } catch { /* server is still starting */ }
    await delay(100);
  }
  throw new Error(`App unavailable at ${url}`);
}

const server = suppliedUrl ? null : spawn(process.execPath, ['tools/serve.js', String(port)], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
try {
  await waitForServer();
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
  });
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(`[pageerror] ${String(error)}`));
  page.on('response', (response) => {
    const responseUrl = response.url();
    if (responseUrl.startsWith(url)
      && new URL(responseUrl).pathname.endsWith('.js')
      && response.status() >= 400) {
      errors.push(`${response.status()} ${responseUrl}`);
    }
  });
  await page.goto(url, { waitUntil: 'load' });
  const browse = page.getByText('Browse files', { exact: true });
  await browse.waitFor({ state: 'visible' });
  try {
    await Promise.all([
      page.waitForEvent('filechooser', { timeout: 5_000 }),
      browse.click(),
    ]);
  } catch (error) {
    errors.push(`[browse] ${error.message}`);
  }
  assert.deepEqual(errors, []);
  console.log('Bootstrap smoke passed: app loaded and Browse files opened the chooser.');
} finally {
  await browser?.close();
  if (server) {
    server.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => server.once('exit', resolve)),
      delay(2_000).then(() => server.kill('SIGKILL')),
    ]);
  }
}
