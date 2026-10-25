import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || chromium.executablePath();

test('Cinematic WebGL cells preserve orientation, alpha and numerical ramps through context restoration', {
  skip: !existsSync(executablePath) && 'Chromium unavailable; set PLAYWRIGHT_CHROMIUM_PATH', timeout: 20000,
}, async t => {
  const files = new Map(await Promise.all(['CinematicPixel.js', 'GraphicsResidency.js'].map(async name =>
    [`/src/render/${name}`, await readFile(new URL(`../src/render/${name}`, import.meta.url), 'utf8')])));
  const browser = await chromium.launch({ headless: true, executablePath,
    args: ['--mute-audio', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage(), graphicsErrors = [];
    page.on('console', message => {
      if (/INVALID_(?:ENUM|VALUE|OPERATION)|shader.*(?:compile|link).*fail/i.test(message.text())) graphicsErrors.push(message.text());
    });
    page.on('pageerror', error => graphicsErrors.push(error.message));
    await page.route('**/*', route => {
      const pathname = new URL(route.request().url()).pathname;
      return route.fulfill({ contentType: pathname === '/' ? 'text/html' : 'application/javascript',
        body: pathname === '/' ? '<!doctype html><title>Cinematic WebGL fixture</title>' : files.get(pathname) || '' });
    });
    await page.goto('http://cinematic-fixture.test/');
    const result = await page.evaluate(async () => {
      const { CinematicPixelRenderer, cinematicCellColor } = await import('/src/render/CinematicPixel.js');
      const { GraphicsResidency } = await import('/src/render/GraphicsResidency.js');
      const canvas = (width, height) => { const c = document.createElement('canvas'); c.width = width; c.height = height; return c; };
      const source = canvas(5, 5), sourceContext = source.getContext('2d', { willReadFrequently: true });
      const output = canvas(50, 50), outputContext = output.getContext('2d', { willReadFrequently: true });
      const pixel = (context, x, y) => [...context.getImageData(x, y, 1, 1).data];
      const fill = colors => sourceContext.putImageData(new ImageData(new Uint8ClampedArray(colors.flat()), 5, 5), 0, 0);
      const fit = { x: 0, y: 0, width: 50, height: 50 };
      const residency = new GraphicsResidency(), pass = new CinematicPixelRenderer({ residency });
      try {
        fill(Array.from({ length: 25 }, (_, i) => i < 5 ? [255, 0, 0, 255] : i >= 20 ? [0, 0, 255, 255] : [0, 255, 0, 255]));
        const applied = pass.draw(outputContext, source, fit), gl = pass.gl;
        if (!applied || !gl) throw new Error(`Cinematic GPU fixture did not render: ${pass.reason}`);
        const debug = gl.getExtension('WEBGL_debug_renderer_info');
        const gpu = gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL || gl.RENDERER);
        const orientation = [pixel(outputContext, 25, 5), pixel(outputContext, 25, 25), pixel(outputContext, 25, 45)];
        fill(Array.from({ length: 25 }, (_, i) => {
          const x = i % 5, y = Math.floor(i / 5);
          return [80 + x * 3 + y * 2, 100 + x * 2 + y, 120 + x + y * 2, 255];
        }));
        if (!pass.draw(outputContext, source, fit)) throw new Error(pass.reason);
        const ramp = [[21, 21], [25, 25], [28, 28], [11, 17], [18, 12]].map(([x, y]) => {
          const cx = Math.floor(x / 10), cy = Math.floor(y / 10);
          const p = (sx, sy) => pixel(sourceContext, sx, sy).map(value => value / 255);
          // Texture Y increases upward; Canvas Y and its subcell offset increase downward.
          const expected = cinematicCellColor(p(cx, cy), p(cx - 1, cy), p(cx + 1, cy), p(cx, cy + 1), p(cx, cy - 1),
            [(x + .5) / 10 - cx - .5, .5 - ((y + .5) / 10 - cy)]).map(value => Math.round(value * 255));
          return { x, y, expected, actual: pixel(outputContext, x, y) };
        });
        fill(Array.from({ length: 25 }, (_, i) => i === 12 ? [180, 80, 40, 128] : [0, 255, 0, 0]));
        outputContext.clearRect(0, 0, 50, 50);
        if (!pass.draw(outputContext, source, fit)) throw new Error(pass.reason);
        const alpha = { source: pixel(sourceContext, 2, 2), left: pixel(outputContext, 20, 25), right: pixel(outputContext, 29, 25), transparent: pixel(outputContext, 19, 25) };
        const lose = gl.getExtension('WEBGL_lose_context');
        if (!lose) throw new Error('Cinematic GPU fixture requires WEBGL_lose_context');
        const event = name => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`${name} timed out`)), 4000);
          pass.canvas.addEventListener(name, () => { clearTimeout(timer); resolve(); }, { once: true });
        });
        const lost = event('webglcontextlost'); lose.loseContext(); await lost;
        const lostDraw = pass.draw(outputContext, source, fit);
        // Let the loss event finish before requesting a restored context.
        await new Promise(resolve => setTimeout(resolve, 100));
        const restored = event('webglcontextrestored'); lose.restoreContext(); await restored;
        outputContext.clearRect(0, 0, 50, 50);
        const restoredDraw = pass.draw(outputContext, source, fit), restoredReason = pass.reason;
        const restoredPixel = pixel(outputContext, 25, 25);
        pass.dispose();
        const pressureResidency = new GraphicsResidency({ budgetBytes: 40000 });
        const pressurePass = new CinematicPixelRenderer({ residency: pressureResidency });
        let pressure;
        try {
          if (!pressurePass.draw(outputContext, source, fit)) throw new Error(pressurePass.reason);
          const texture = pressurePass.texture, program = pressurePass.program, buffer = pressurePass.buffer;
          const denied = pressurePass.draw(outputContext, source, { x: 0, y: 0, width: 1000, height: 1000 });
          pressure = { denied, reason: pressurePass.reason, bytes: pressurePass.bytes, ledger: pressureResidency.usedBytes,
            textureLive: pressurePass.gl.isTexture(texture), programLive: pressurePass.gl.isProgram(program), bufferLive: pressurePass.gl.isBuffer(buffer) };
        } finally { pressurePass.dispose(); }
        return { gpu, orientation, ramp, alpha, lostDraw, restoredDraw, restoredReason, restoredPixel, pressure, finalBytes: residency.usedBytes };
      } finally { pass.dispose(); }
    });
    t.diagnostic(`Actual renderer: ${result.gpu}`);
    assert.deepEqual(result.orientation, [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255]]);
    for (const point of result.ramp) assert.ok(point.actual.every((value, i) => Math.abs(value - point.expected[i]) <= 1), JSON.stringify(point));
    assert.deepEqual(result.alpha.left, result.alpha.source);
    assert.deepEqual(result.alpha.right, result.alpha.source);
    assert.deepEqual(result.alpha.transparent, [0, 0, 0, 0]);
    assert.equal(result.lostDraw, false, 'a lost context must use the nearest fallback');
    assert.equal(result.restoredDraw, true, result.restoredReason);
    assert.deepEqual(result.restoredPixel, result.alpha.source);
    assert.deepEqual(result.pressure, { denied: false, reason: 'allocation-denied', bytes: 0, ledger: 0,
      textureLive: false, programLive: false, bufferLive: false }, 'denied resize must not leave GPU objects outside the released charge');
    assert.equal(result.finalBytes, 0);
    assert.deepEqual(graphicsErrors, [], 'restored contexts must not delete handles from their previous epoch');
  } finally { await browser.close(); }
});
