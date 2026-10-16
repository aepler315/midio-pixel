// Reproducible, real-terrain frames on the app's heard-time export clock.
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { seedBrowserConstruction, installSeedReceiver } from './lib/landscape-browser.mjs';
const phase = process.argv[2] || 'after';
const variant = process.env.EVIDENCE_VARIANT || '';
const phaseLabel = variant || phase;
const out = process.env.EVIDENCE_OUT || '.smoke/pixel-storm-peaks';
const port = process.env.EVIDENCE_PORT || '8080';
const url = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['tools/serve.js', port], { stdio: 'ignore' });
let browser;
try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(url)).ok) break; } catch { /* server is still starting */ } await new Promise(r => setTimeout(r, 100)); }
  await fs.mkdir(out, { recursive: true });
  execFileSync(process.execPath, ['tools/gen-test-wav.mjs', '/tmp/midio-peak-fixture.wav', '120', '40']);
  browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH, headless: true, args: ['--ignore-gpu-blocklist', '--in-process-gpu'] });
  const results = [], errors = [];
  for (const view of (process.env.EVIDENCE_VIEWS || 'teton-jackson-lake,tombstone-north-klondike').split(',')) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, serviceWorkers: 'block' });
    page.on('pageerror', e => errors.push(e.message));
    page.on('console', msg => { if (/shader|VALIDATE|compile|GL_INVALID_OPERATION|feedback loop/i.test(msg.text()) && ['error', 'warning'].includes(msg.type())) errors.push(msg.text()); });
    if (phase === 'before') {
      await page.route('**/src/world/alpine/*.js', async route => {
        const path = new URL(route.request().url()).pathname.slice(1);
        let source;
        try { source = execFileSync('git', ['show', `96908d0:${path}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); }
        catch { return route.continue(); }
        if (path.endsWith('/RangeActors.js')) source = source.replace('if (Number.isFinite(forced)) for (const id of ACTOR_IDS) now[id].peak = unit(forced);',
          "if (Number.isFinite(forced)) for (const id of ACTOR_IDS) now[id].peak = unit(forced); else if (forced) for (const id of ACTOR_IDS) now[id].peak = unit(forced[id]);");
        await route.fulfill({ body: source, contentType: 'text/javascript' });
      });
      await page.route('**/src/world/BiomeManager.js', route => route.fulfill({ body: execFileSync('git', ['show', '96908d0:src/world/BiomeManager.js'], { encoding: 'utf8' }), contentType: 'text/javascript' }));
    }
    await page.addInitScript(seedBrowserConstruction, 24681357);
    await page.addInitScript(installSeedReceiver);
    await page.route(/^https:\/\//, route => route.abort());
    await page.addInitScript(() => { localStorage.setItem('smw:stageRes', '360'); localStorage.setItem('smw:lyricGrounding', 'off'); });
    await page.goto(`${url}/?bulkExport=1&exportW=960&exportH=540&rangeView=${view}&seed=24681357`);
    await page.locator('#fileInput').setInputFiles('/tmp/midio-peak-fixture.wav');
    console.log('loaded fixture', view);
    await page.waitForFunction(() => window.__SMW?.exportReady, null, { timeout: 180000 }).catch(async err => { throw Error(`${err.message}: ${JSON.stringify(errors)} ${await page.locator('#errorBannerText').textContent()}`); });
    console.log('export ready', view);
    await page.evaluate(async () => {
      window.__SMW.beginBulkExport({ width: 960, height: 540 });
      await window.__SMW.rangeReady({ timeoutMs: 180000 });
      window.__SMW.renderExportFrame(1000);
      await window.__SMW.rangeSettle({ timeoutMs: 180000 });
    });
    for (const actor of (/squall|clearing|shed/.test(variant) ? ['midio'] : (process.env.EVIDENCE_ACTORS || 'midio,broshi,midasus').split(','))) {
      const result = await page.evaluate(async ({ actor, phase, variant }) => {
        let app = window.__SMW;
        app.beginBulkExport({ width: 960, height: 540 });
        app = window.__SMW;
        app.renderExportFrame(250);
        const configure = () => {
          app.perf.setFixtureLevel(0);
          app.sim.biomes.actorPeakOverride = Object.fromEntries(['midio', 'broshi', 'midasus'].map(id => [id, id === actor ? 1 : 0]));
          app.sim.biomes.stormOverride = variant === 'squall' ? { amount: 1, flash: .85, break01: 0, wet01: 1 }
            : variant === 'clearing' ? { amount: 0, flash: 0, break01: 1, wet01: 1 }
            : { amount: 0, flash: 0, break01: 0, wet01: 0 };
          if (variant === 'dawn') app.sim.biomes._dayNightCycleMs = { phaseAt: () => .91 };
          if (variant === 'sunset') app.sim.biomes._dayNightCycleMs = { phaseAt: () => .40 };
          if (/squall|clearing/.test(variant)) app.sim.biomes._dayNightCycleMs = { phaseAt: () => .2 };
          if (variant === 'shed') app.perf.setFixtureLevel(4);
          app.sim.rangeCaption = null; app.sim.rangeCaptions = null;
          app.renderer.hudInFrame = false;
        };
        app.renderExportFrame(20000, { beforeDraw: configure });
        await app.rangeSettle({ timeoutMs: 180000 });
        app.renderExportFrame(20000, { beforeDraw: configure });
        const pres = app.sim.biomes.rangePresentation;
        const frame = pres.frame;
        const p = pres.scene.prepared.get(app.rangeState.viewId);
        const u = p?.uniforms;
        const debug = u ? { peak: u.uGiantPeak?.value, layout: p.giantLayout, camera: pres.scene.camera.position.toArray(),
          mist: [u.uMistTop.value,u.uMistFill.value], spans: u.uGiantSpan?.value,
          center: u.uGiantCenter?.value.map(v=>v.toArray()), hasTexture: !!u.uGiantMask?.value,
          mirrorAmount: u.uMirrorAmount.value } : null;
        return { actor, phase, view: app.rangeState, timeMs: frame?.timeMs, actors: frame?.actors, light: frame?.light, storm: frame?.storm, debug, giant: frame?.qualityLevel,
          png: document.querySelector('#stage').toDataURL('image/png').split(',')[1] };
      }, { actor, phase, variant });
      const name = `${view}-${actor}-${phaseLabel}.png`;
      await fs.writeFile(`${out}/${name}`, Buffer.from(result.png, 'base64'));
      delete result.png; results.push({ ...result, name });
      console.log(name, result.timeMs, result.view.active);
      if (result.actors?.[actor]?.peak !== 1) throw Error(`Peak override missed ${actor}: ${JSON.stringify(result.actors)}`);
      if (!result.view.active) throw Error(`Inactive Range: ${JSON.stringify(result.view)}`);
    }
    await page.close();
  }
  if (errors.length) throw new Error(errors.join('\n'));
  await fs.writeFile(`${out}/${phaseLabel}-manifest.json`, JSON.stringify({ phase: phaseLabel, timestamp: new Date().toISOString(), baseline: '96908d0', commit: execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(), browser: browser.version(), fixtureSha256: createHash('sha256').update(await fs.readFile('/tmp/midio-peak-fixture.wav')).digest('hex'), viewport: [1280,720], dpr: 1, seed: 24681357, size: [960, 540], errors, results }, null, 2));
} finally { await browser?.close(); server.kill(); }
