// Start npm start first. Verify volume shading stays inside static bitmaps.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
});
try {
  const page = await browser.newPage();
  await page.goto(process.argv[2] || 'http://127.0.0.1:8080');
  const results = await page.evaluate(async () => {
    const { BiomeManager } = await import('/src/world/BiomeManager.js');
    const { generateSilhouette, drawTiledStrip } = await import('/src/world/SilhouetteGenerator.js');
    const { PerfGovernor, MAX_LEVEL } = await import('/src/render/PerfGovernor.js');
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 720;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const results = [];
    for (const kind of ['city', 'airless', 'abyssal', 'strip', 'foundry', 'overgrowth', 'nave']) {
      const mgr = Object.assign(Object.create(BiomeManager.prototype), {
        world: { kind }, tSec: 3, _danceKickMs: 2950, _danceKickAmp: 1,
        _danceGroove: 1, _danceSustain: 1, _eqSmoothed: [1, 1, 1, 1, 1, 1, 1],
        _geoFeatures: [], groundY: 600, h: 720, _airColor: '#7090aa',
      });
      let cases = 0, worstLeak = 0, minPaint = Infinity, unexpectedEmpty = 0;
      for (const layer of ['L2', 'L3', 'L4', 'L5']) {
        const strip = generateSilhouette({ seed: 31, width: 400, height: 300,
          profile: kind === 'city' ? 'city' : 'columnar', kind, color: '#687080', step: 4 });
        for (const level of [0, MAX_LEVEL]) for (const growth of [0, 1]) for (const pullback of [0, 1]) {
          mgr._perf = new PerfGovernor(); mgr._perf.level = level;
          mgr.orogenyGrowth = growth; mgr.pullback01 = pullback;
          for (const kick of [0, 1]) for (const scroll of [-73.25, 450.5]) {
            mgr._danceKickAmp = kick;
            ctx.clearRect(0, 0, 640, 720);
            drawTiledStrip(ctx, strip, scroll, 640, 720, 12);
            const bitmap = ctx.getImageData(0, 0, 640, 720).data;
            ctx.clearRect(0, 0, 640, 720);
            mgr._drawRidgeVolume(ctx, canvas, strip, scroll, 12, layer, 1, 1, 1, 1,
              { geology: false, geometry: 'static' });
            const shading = ctx.getImageData(0, 0, 640, 720).data;
            let painted = 0, leaked = 0;
            for (let y = 1; y < 719; y++) for (let x = 1; x < 639; x++) {
              if (shading[(y * 640 + x) * 4 + 3] < 2) continue;
              painted++;
              // One pixel tolerance for independent bitmap/vector antialiasing.
              let inside = false;
              for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                if (bitmap[((y + dy) * 640 + x + dx) * 4 + 3]) inside = true;
              }
              if (!inside) leaked++;
            }
            if (!painted && !(kind === 'airless' && level === MAX_LEVEL)) unexpectedEmpty++;
            cases++; worstLeak = Math.max(worstLeak, leaked); minPaint = Math.min(minPaint, painted);
          }
        }
      }
      results.push({ kind, cases, worstLeak, minPaint, unexpectedEmpty });
    }
    return results;
  });
  console.log(JSON.stringify(results, null, 2));
  for (const r of results) {
    assert.equal(r.unexpectedEmpty, 0, `${r.kind}: shading did not paint`);
    assert.equal(r.worstLeak, 0, `${r.kind}: shading escaped its bitmap`);
  }
} finally { await browser.close(); }
