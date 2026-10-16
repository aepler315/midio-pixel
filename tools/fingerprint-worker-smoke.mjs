// Real file-loading flow with controlled fingerprint-worker faults. Run a
// local server first; optionally set PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const url = process.argv[2] || 'http://127.0.0.1:8080/?worlds=all';
const browser = await chromium.launch({ headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || '/usr/bin/chromium',
  args: ['--no-sandbox'] });

function wav(name, hz = 440) {
  const rate = 8000, n = rate * 2, bytes = Buffer.alloc(44 + n * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) bytes.writeInt16LE(Math.round(Math.sin(i * hz * Math.PI * 2 / rate) *
    (8000 + 4000 * Math.sin(i / 77))), 44 + i * 2);
  return { name, mimeType: 'audio/wav', buffer: bytes };
}

try {
  for (const mode of ['silent', 'throw', 'error', 'messageerror', 'unsupported', 'idb-unavailable', 'replacement', 'stems']) {
    const context = await browser.newContext();
    await context.addInitScript(mode => {
      const NativeWorker = window.Worker, nativeTimer = window.setTimeout;
      window.__fingerprintFault = { workers: [], lateReplies: 0 };
      if (mode === 'idb-unavailable') Object.defineProperty(window, 'indexedDB', { value: undefined });
      // Accelerate the documented watchdog only for this fault fixture.
      window.setTimeout = (fn, ms, ...args) => nativeTimer(fn,
        ms === 120000 && new Error().stack.includes('FingerprintWorkerClient')
          ? (mode === 'replacement' ? 15000 : 2000) : ms, ...args);
      window.Worker = class {
        constructor(url, options) {
          if (!String(url).includes('fingerprintWorker')) return new NativeWorker(url, options);
          if (mode === 'unsupported') throw new Error('module workers unsupported');
          const record = { terminations: 0 };
          window.__fingerprintFault.workers.push(record);
          const number = window.__fingerprintFault.workers.length;
          if (mode === 'idb-unavailable' || (mode === 'replacement' && number > 1)) {
            const worker = new NativeWorker(url, options), terminate = worker.terminate.bind(worker);
            worker.terminate = () => { record.terminations++; terminate(); };
            return worker;
          }
          this.record = record;
        }
        terminate() { this.record.terminations++; }
        postMessage() {
          if (mode === 'throw') throw new Error('injected postMessage throw');
          if (mode === 'error') queueMicrotask(() => this.onerror?.({ preventDefault() {} }));
          if (mode === 'messageerror') queueMicrotask(() => this.onmessageerror?.({}));
          if (mode === 'replacement') {
            const late = this.onmessage;
            nativeTimer(() => { window.__fingerprintFault.lateReplies++; late?.({ data: { ok: false } }); }, 10000);
          }
        }
      };
    }, mode);
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.locator('#fileInput').waitFor({ state: 'attached' });
    await page.locator('#titleWorld').selectOption('ask');
    const files = mode === 'stems' ? [wav('drums.wav'), wav('bass.wav', 110)] : wav('first.wav');
    await page.locator('#fileInput').setInputFiles(files);
    if (mode === 'replacement') {
      await page.waitForFunction(() => window.__fingerprintFault.workers.length === 1);
      await page.locator('#fileInput').setInputFiles(wav('replacement.wav', 220));
      assert.equal(await page.evaluate(() => window.__fingerprintFault.workers[0].terminations), 1,
        'replacement terminates the old worker before its deadline or delayed reply');
    }
    await page.locator('#worldSelect').waitFor({ state: 'visible', timeout: 60000 });
    await page.waitForFunction(() => window.__fingerprintFault.workers.every(w => w.terminations === 1));
    if (mode === 'replacement') await page.waitForFunction(() => window.__fingerprintFault.lateReplies === 1);
    const fault = await page.evaluate(() => window.__fingerprintFault);
    assert.equal(await page.locator('#errorBanner').isVisible(), false);
    assert.deepEqual(errors, []);
    if (mode !== 'unsupported') assert.ok(fault.workers.length > 0, 'fault reached fingerprint worker');
    if (mode === 'replacement') assert.equal(fault.workers.length, 2);
    console.log(JSON.stringify({ mode, ...fault, picker: true, errors }));
    await context.close();
  }
} finally { await browser.close(); }
