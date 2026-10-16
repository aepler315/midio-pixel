// Real transport seek lifecycle, with future state deliberately injected.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { withAllWorlds } from './lib/allWorlds.mjs';
const browser = await chromium.launch({ headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
});
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/soundfonts/', route => route.fulfill({ json: [] }));
  await page.goto(withAllWorlds(process.argv[2] || 'http://127.0.0.1:8080'));
  for (const worldId of ['redline']) {
  await page.locator('#demoBtn').click();
  await page.locator('#worldSelect:not(.hidden)').waitFor({ timeout: 90000 });
  await page.locator(`.worldCard[data-world-id="${worldId}"]`).click();
  await page.waitForFunction(() => window.__SMW?.sim?.timeMs > 750, null, { timeout: 90000 });
  const results = await page.evaluate(() => {
    const count = c => [...c.listeners.values()].reduce((n, s) => n + s.size, 0) + c.aheadRegs.length + c.barListeners.size;
    const initial = window.__SMW;
    const listeners = count(initial.conductor);
    initial.seek(60000);
    const results = [];
    for (const destination of [1000, 20000, 1000]) {
      const old = window.__SMW;
      old.sim.hype.cueDrop(60000);

      old.sim.biomes._cutFlash = 1;
      old.sim.fire.strike(60000, 0);
      old.sim.quake.strike(60000, 0);
      old.sim.flood.active = true;
      old.sim.disasters._lastStruckMs = 60000;
      old.sim._pendingQuakeTsunamiAtMs = 62000;
      const painter = old.renderer.canvasRenderer || old.renderer;
      painter.brush?.update(60000, true, old.sim.worldX, 300);
      painter._authoredDropAtMs = 60000;
      painter._motionHistory = [document.createElement('canvas')];
      const started = performance.now();
      old.seek(destination);
      const fresh = window.__SMW;
      const nextPainter = fresh.renderer.canvasRenderer || fresh.renderer;
      results.push({ destination, elapsedMs: performance.now() - started,
        timeMs: fresh.sim.timeMs, freshSimulation: fresh.sim !== old.sim,
        seedPreserved: fresh.sim.songSeed === initial.sim.songSeed,
        listenersStable: count(fresh.conductor) === listeners,
        dropCooldown: fresh.sim.hype._cooldownUntilMs,
        actorsAbsent: !fresh.sim.broshi && !fresh.sim.midasus && !fresh.sim.ensemble && !fresh.sim.excursions && !fresh.sim.focus && !fresh.sim.apotheosis && !fresh.sim.noteChart,
        ridgeStatePreserved: JSON.stringify(fresh.ridgeStateKey) === JSON.stringify(initial.ridgeStateKey),
        shutter: Number.isFinite(fresh.sim.biomes._shutterStartMs), cutFlash: fresh.sim.biomes._cutFlash,
        fire: fresh.sim.fire.active, quake: fresh.sim.quake.active, flood: fresh.sim.flood.active,
        pendingTsunami: Number.isFinite(fresh.sim._pendingQuakeTsunamiAtMs),
        futureDabs: !!nextPainter.brush?.dabs.some(d => d.bornMs > fresh.sim.timeMs),
        futureAuthoredDrop: nextPainter._authoredDropAtMs === 60000,
        oldHistory: nextPainter._motionHistory === painter._motionHistory,
        snapshotsAgree: JSON.stringify(fresh.sim.prev) === JSON.stringify(fresh.sim.curr),
        nextNoteIsFuture: !fresh.conductor.timeline[fresh.conductor.cursor]
          || fresh.conductor.timeline[fresh.conductor.cursor].tMs > fresh.sim.timeMs,
      });
      const result = results[results.length - 1];
      const replayEnergy = { globalEnergyNorm: ms => Math.floor(ms / 4000) % 2 ? 0.95 : 0.05 };
      for (let ms = 1000; ms < 59000; ms += 20) fresh.sim.hype.update(ms, 0.02, replayEnergy);
      result.hypeCanDrop = fresh.sim.hype.dropCount > 0;
    }
    return results;
  });
  console.log(JSON.stringify(results, null, 2));
  for (const r of results) {
    for (const k of ['freshSimulation', 'seedPreserved', 'listenersStable', 'actorsAbsent', 'ridgeStatePreserved', 'snapshotsAgree', 'nextNoteIsFuture', 'hypeCanDrop']) assert.equal(r[k], true, k);
    for (const k of ['shutter', 'fire', 'quake', 'flood', 'pendingTsunami', 'futureDabs', 'futureAuthoredDrop', 'oldHistory']) assert.equal(r[k], false, k);
    assert.equal(r.cutFlash, 0);
    assert.ok(r.dropCooldown <= r.destination);
    assert.ok(Math.abs(r.timeMs - r.destination) < 100);
  }
  await page.locator('#pauseBtn').click();
  await page.evaluate(() => window.__SMW.seek(1000));
  await page.waitForTimeout(150);
  assert.equal(await page.locator('#pauseBtn').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.evaluate(() => window.__SMW.audioEngine.ctx.state), 'suspended');
  await page.locator('#stopBtn').click();
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); }
