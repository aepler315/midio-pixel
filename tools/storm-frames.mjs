// Climax-storm review frames on the heard-time export clock: one real-terrain
// view, the same moment rendered calm, mid-squall, on a lightning flash, and
// as the storm breaks. Usage: node tools/storm-frames.mjs [outDir] [views...]
import fs from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { seedBrowserConstruction, installSeedReceiver } from './lib/landscape-browser.mjs';
const out = process.argv[2] || 'storm-frames';
const views = process.argv.slice(3).length ? process.argv.slice(3) : ['teton-jackson-lake', 'tombstone-north-klondike'];
const port = process.env.EVIDENCE_PORT || '8091';
const url = `http://127.0.0.1:${port}`;
const phase = Number(process.env.STORM_DAY_PHASE || NaN);
const STATES = {
  calm: { amount: 0, flash: 0, break01: 0, wet01: 0 },
  gathering: { amount: .5, flash: 0, break01: 0, wet01: .3 },
  squall: { amount: 1, flash: 0, break01: 0, wet01: 1 },
  flash: { amount: 1, flash: 1, break01: 0, wet01: 1 },
  clearing: { amount: .15, flash: 0, break01: 1, wet01: 1 },
};
const nopass = (process.env.STORM_NOPASS || '').split(',').filter(Boolean);
const only = (process.env.STORM_STATES || '').split(',').filter(Boolean);
const server = spawn(process.execPath, ['tools/serve.js', port], { stdio: 'ignore' });
let browser;
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(url)).ok) break; } catch { /* starting */ } await new Promise(r => setTimeout(r, 100)); }
  await fs.mkdir(out, { recursive: true });
  execFileSync(process.execPath, ['tools/gen-test-wav.mjs', '/tmp/midio-storm-fixture.wav', '120', '40']);
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, headless: true, args: ['--ignore-gpu-blocklist', '--in-process-gpu'] });
  const errors = [];
  for (const view of views) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', msg => { if (/shader|VALIDATE|compile|GL_INVALID_OPERATION|feedback loop/i.test(msg.text()) && ['error', 'warning'].includes(msg.type())) errors.push(msg.text()); });
    await page.addInitScript(seedBrowserConstruction, 24681357);
    await page.addInitScript(installSeedReceiver);
    await page.route(/^https:\/\//, route => route.abort());
    await page.addInitScript(() => { localStorage.setItem('smw:stageRes', '360'); localStorage.setItem('smw:lyricGrounding', 'off'); });
    await page.goto(`${url}/?bulkExport=1&exportW=960&exportH=540&rangeView=${view}&seed=24681357`);
    await page.locator('#fileInput').setInputFiles('/tmp/midio-storm-fixture.wav');
    await page.waitForFunction(() => window.__SMW?.exportReady, null, { timeout: 180000 });
    await page.evaluate(async () => {
      window.__SMW.beginBulkExport({ width: 960, height: 540 });
      await window.__SMW.rangeReady({ timeoutMs: 180000 });
      window.__SMW.renderExportFrame(1000);
      await window.__SMW.rangeSettle({ timeoutMs: 180000 });
    });
    for (const [name, storm] of Object.entries(STATES)) {
      if (only.length && !only.includes(name)) continue;
      const png = await page.evaluate(async ({ storm, phase, nopass }) => {
        window.__SMW.beginBulkExport({ width: 960, height: 540 });
        const app = window.__SMW; // a fresh export app per begin
        app.renderExportFrame(250);
        for (const name of nopass) app.sim.biomes[name] = () => {};
        const configure = () => {
          app.perf.setFixtureLevel(0);
          app.sim.biomes.actorPeakOverride = { midio: 0, broshi: 0, midasus: 0 };
          app.sim.biomes.stormOverride = storm;
          if (Number.isFinite(phase)) app.sim.biomes._dayNightCycleMs = { phaseAt: () => phase };
          app.sim.rangeCaption = null; app.sim.rangeCaptions = null;
          app.renderer.hudInFrame = false;
        };
        app.renderExportFrame(20000, { beforeDraw: configure });
        await app.rangeSettle({ timeoutMs: 180000 });
        app.renderExportFrame(20000, { beforeDraw: configure });
        return document.querySelector('#stage').toDataURL('image/png').split(',')[1];
      }, { storm, phase, nopass });
      await fs.writeFile(`${out}/${view}-${name}.png`, Buffer.from(png, 'base64'));
      console.log(`${view}-${name}.png`);
    }
    await page.close();
  }
  if (errors.length) throw new Error(errors.join('\n'));
} finally { await browser?.close(); server.kill(); }
