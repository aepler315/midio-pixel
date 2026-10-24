import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { snapshotSource, serveSnapshot } from '../tools/lib/visual-evaluation-server.mjs';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || chromium.executablePath();
test('narrative stars survive real Canvas transforms, both native grids and Palette', {
  skip: !existsSync(executablePath) ? 'Chromium unavailable; set PLAYWRIGHT_CHROMIUM_PATH' : false,
}, async () => {
  const snapshot = await snapshotSource(fileURLToPath(new URL('../', import.meta.url)));
  snapshot.files.set('/star-test.html', Buffer.from('<!doctype html><title>Star regression</title>'));
  const server = await serveSnapshot(snapshot);
  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage(); await page.goto(`${server.url}/star-test.html`);
    const { rows, tourRows } = await page.evaluate(async () => {
      const { BiomeManager } = await import('/src/world/BiomeManager.js');
      const { PixelPresentation } = await import('/src/render/PixelPresentation.js');
      const { pixelRenderPolicy, pixelGrid } = await import('/src/render/PixelRenderPolicy.js');
      const { hexLerp } = await import('/src/utils/color.js');
      const { tourSkyDirection } = await import('/src/world/alpine/RangeSkyComposition.js');
      const rows = [], palette = { fx: '', sky: ['#183044', '#38445a', '#706579'] };
      for (const grid of ['classic', 'detailed']) for (const paletteId of ['none', 'range32']) {
        const pixelScale = 'original';
        const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
        const presentation = { pixelated: true, grid: pixelGrid(grid), paletteId, pixelScale, dither: .35, ditherMode: 'selective', scaling: 'fit' };
        const output = new PixelPresentation({ canvas, presentation });
        const stars = [.15, .32, .48, .65, .83].map((xFrac, i) => ({ xFrac, yFrac: .18 + i * .09,
          layer: i % 3, bright: .25 + i * .18, phase: .5, mag: 1, altitude01: .6, ext: 1, hue: 0 }));
        const mgr = { world: { kind: 'alpine' }, rangeNarrative: { skyDark: 1 }, _rangeV2Active: true,
          rangePresentation: { pixelPolicy: pixelRenderPolicy(presentation) }, tSec: 0, openingGain: 1,
          calmLevel: 0, stars, _starBuckets: new Map(), _rangeSky: { starBrightnessAt: () => 1 },
          _rotated: c => c, lerpCache: { get: hexLerp } };
        const render = (enabled, night) => {
          const native = output.beginFrame(), ctx = native.getContext('2d');
          ctx.resetTransform(); ctx.clearRect(0, 0, native.width, native.height);
          ctx.setTransform(native.width / 1280, 0, 0, native.height / 720, .4, .6);
          mgr._drawStarfield = enabled ? BiomeManager.prototype._drawStarfield : () => {};
          BiomeManager.prototype._drawSky.call(mgr, ctx, { width: 1280, height: 720 }, palette, palette, 0, night);
          // An opaque terrain receiver must cover the star beneath it.
          ctx.fillStyle = '#12151a'; ctx.fillRect(0, 360, 1280, 360);
          ctx.resetTransform();
          const raw = [...ctx.getImageData(0, 0, native.width, native.height).data];
          output.finishFrame();
          return { raw, final: [...ctx.getImageData(0, 0, native.width, native.height).data] };
        };
        const off = render(false, 1), on = render(true, 1), dayOff = render(false, 0), dayOn = render(true, 0);
        const changed = [], rawChanged = [], levels = new Set();
        for (let p = 0; p < on.final.length / 4; p++) {
          if (on.raw.slice(p * 4, p * 4 + 3).some((v, c) => v !== off.raw[p * 4 + c])) rawChanged.push(p);
          if (on.final.slice(p * 4, p * 4 + 3).some((v, c) => v !== off.final[p * 4 + c])) {
            changed.push(p); levels.add(Math.max(...[0, 1, 2].map(c => on.final[p * 4 + c] - off.final[p * 4 + c])));
          }
        }
        rows.push({ grid, paletteId, pixelScale, changed, rawChanged, width: output.grid.width, levels: levels.size,
          unchangedDay: dayOff.final.every((v, i) => v === dayOn.final[i]), presented: output.diagnostics.frame.presented });
        output.dispose();
      }
      // A dark upward view checks the tour exposure away from the faint
      // horizon population, and checks persistence in actual raster pixels.
      const tourRows = [];
      for (const grid of ['classic', 'detailed']) {
        const canvas = document.createElement('canvas'); canvas.width = 1280; canvas.height = 720;
        const presentation = { pixelated: true, grid: pixelGrid(grid), paletteId: 'none', pixelScale: 'original', scaling: 'fit' };
        const output = new PixelPresentation({ canvas, presentation });
        const pose = { eyeM: [0, 0, 0], targetM: tourSkyDirection(0, 60), fovYDeg: 50, aspect: 16 / 9 };
        const mgr = { world: { kind: 'alpine' }, rangeNarrative: { skyDark: 1 }, _rangeV2Active: true,
          rangePresentation: { pixelPolicy: pixelRenderPolicy(presentation), skyPan: { tourPose: pose } },
          tSec: 0, openingGain: 1, calmLevel: 0, _starBuckets: new Map(), _rangeSky: { starBrightnessAt: () => 1 },
          _rotated: c => c, lerpCache: { get: hexLerp },
          stars: [350, 0, 10].map((az, i) => ({ xFrac: az / 360, yFrac: 1 - (50 + i * 10) / 90,
            layer: 2, bright: .04 + i * .06, phase: 0, mag: 1, altitude01: .6, ext: 1, hue: 0 })) };
        const render = (enabled, az) => {
          pose.targetM = tourSkyDirection(az, 60);
          const native = output.beginFrame(), ctx = native.getContext('2d');
          ctx.setTransform(native.width / 1280, 0, 0, native.height / 720, 0, 0);
          mgr._drawStarfield = enabled ? BiomeManager.prototype._drawStarfield : () => {};
          BiomeManager.prototype._drawSky.call(mgr, ctx, { width: 1280, height: 720 }, palette, palette, 0, 1);
          ctx.resetTransform(); output.finishFrame();
          return [...ctx.getImageData(0, 0, native.width, native.height).data];
        };
        const off = render(false, 0), first = render(true, 0), turn = render(true, 25), returned = render(true, 0);
        const changed = [], levels = new Set();
        for (let i = 0; i < first.length; i += 4) {
          const delta = Math.max(...[0, 1, 2].map(k => first[i + k] - off[i + k]));
          if (delta > 0) { changed.push(i / 4); levels.add(delta); }
        }
        tourRows.push({ grid, changed: changed.length, levels: levels.size,
          maximum: Math.max(...changed.flatMap(p => first.slice(p * 4, p * 4 + 3))),
          turned: first.some((v, i) => v !== turn[i]), returned: first.every((v, i) => v === returned[i]) });
        output.dispose();
      }
      return { rows, tourRows };
    });
    for (const row of rows) {
      assert.equal(row.presented, true);
      assert.equal(row.unchangedDay, false, 'daylight catalogue survives the final pixel/palette presentation: ' + JSON.stringify(row));
      assert.equal(row.rawChanged.length, 4, 'each unoccluded star covers exactly one native pixel');
      assert.ok(row.changed.length >= 3, 'Palette must retain visible stars');
      // Selective dithering reacts to the new point's immediate edge, but
      // cannot replace or blur the rest of the narrative sky.
      assert.ok(row.changed.every(p => row.rawChanged.some(q => Math.abs(p % row.width - q % row.width) <= 1
        && Math.abs(Math.floor(p / row.width) - Math.floor(q / row.width)) <= 1)), JSON.stringify(row));
      assert.ok(row.changed.every(p => Math.floor(p / row.width) < row.width * 9 / 32), 'no star painted over terrain');
      assert.ok(row.levels >= 2, 'brightness variation survives presentation');
    }
    for (const row of tourRows) {
      assert.equal(row.changed, 3, 'upward tour points retain a crisp native footprint');
      assert.equal(row.levels, 3, 'tour exposure retains distinct brightness');
      assert.ok(row.maximum < 250, 'faint high-altitude points must not all saturate');
      assert.equal(row.turned, true, 'turning changes the rasterized sky');
      assert.equal(row.returned, true, 'returning sees the identical persistent sky');
    }
  } finally { await browser.close(); await server.close(); }
});
