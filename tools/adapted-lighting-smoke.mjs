// Start npm start first, then npm run test:lighting -- [url].
// Isolate the material light by comparing real Canvas pixels with/without it.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {}),
});
try {
  const page = await browser.newPage();
  await page.goto(process.argv[2] || 'http://127.0.0.1:8080');
  const results = await page.evaluate(async () => {
    const { BiomeManager } = await import('/src/world/BiomeManager.js');
    const { getWorld } = await import('/src/world/Worlds.js');
    const { adaptWorld } = await import('/src/world/WorldAdaptation.js');
    const { drawNaveWorld } = await import('/src/world/nave/drawNave.js');
    const { drawFoundryWorld } = await import('/src/world/foundry/drawFoundry.js');
    const { drawRedlineWorld } = await import('/src/world/redline/drawRedline.js');
    const noop = () => {};
    // Keep the world draw function and its musical response real. Shared sky,
    // terrain and particle passes are excluded to isolate material lighting.
    const mgr = {
      tSec: 5, groundY: 300, openingGain: 1, fields: new Map(),
      lerpCache: { get: (a) => a }, _rotated: (a) => a,
      stripsFor: () => null, weaver: { draw: noop }, meteors: { draw: noop },
      _drawSky: noop, _drawMoon: noop, drawDeepSky: noop,
      _drawGround: noop, _drawTerrainFooting: noop, _drawFlood: noop,
      _drawTransitionOverlays: noop,
      _drawSignature: BiomeManager.prototype._drawSignature,
    };
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 360;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const results = [];
    for (const [id, draw] of [['nave', drawNaveWorld], ['foundry', drawFoundryWorld], ['redline', drawRedlineWorld]]) {
      const base = getWorld(id);
      mgr.world = base;
      const { world } = adaptWorld(base, null, {
        durationMs: 120000, bpm: 120,
        structure: { boundariesMs: [0, 20000, 40000, 60000, 80000, 100000, 120000],
          labels: ['A', 'B', 'C', 'D', 'E', 'F'], confidence: 0.8 },
      });
      for (const reducedFlash of [false, true]) {
        mgr.reducedFlash = reducedFlash;
        for (const [index, palette] of world.palettes.entries()) {
          const paint = (p) => {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            draw(mgr, { ctx, canvas, A: p, B: p, t: 0, worldX: 0, originX: 0,
              phenomenaFull: true, particleMul: 1, dn: { sunAlt: 1, moonAlt: 0.5 } });
            return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          };
          const lit = paint(palette);
          const dark = paint({ ...palette, edgeLight: undefined });
          let changedPixels = 0;
          for (let i = 0; i < lit.length; i += 4) {
            if (lit[i] !== dark[i] || lit[i + 1] !== dark[i + 1] || lit[i + 2] !== dark[i + 2] || lit[i + 3] !== dark[i + 3]) changedPixels++;
          }
          results.push({ id, palette: palette.name, reducedFlash,
            expectsLight: !!base.palettes[index % base.palettes.length].edgeLight, changedPixels });
        }
      }
    }
    return results;
  });
  console.log(JSON.stringify(results, null, 2));
  for (const result of results) {
    assert.equal(result.changedPixels > 0, result.expectsLight, `${result.id}/${result.palette}, reducedFlash=${result.reducedFlash}: material light painted no pixels`);
  }
} finally {
  await browser.close();
}
