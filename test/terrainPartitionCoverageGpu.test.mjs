import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || chromium.executablePath();

test('depth-aware terrain copies cover adjoining ridges and transfer fractional coverage onto sky', {
  skip: !existsSync(executablePath) && 'Chromium unavailable; set PLAYWRIGHT_CHROMIUM_PATH', timeout: 45000,
}, async () => {
  const browser = await chromium.launch({ headless: true, executablePath,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage({ deviceScaleFactor: 2 }), errors = [];
    page.on('console', message => { if (message.type() === 'error' || /feedback loop|INVALID_OPERATION/i.test(message.text())) errors.push(message.text()); });
    await page.route('**/*', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Terrain partition coverage</title>' });
      if (!pathname.startsWith('/src/')) return route.fulfill({ status: 204 });
      return route.fulfill({ contentType: 'application/javascript', body: await readFile(new URL('..' + pathname, import.meta.url)) });
    });
    await page.goto('http://terrain-coverage.test/');
    const result = await page.evaluate(async () => {
      const T = await import('/src/vendor/range/three-range.module.js');
      const { RangeScene } = await import('/src/world/alpine/RangeScene.js');
      const renderer = new T.WebGLRenderer({ alpha: true, antialias: false, premultipliedAlpha: true });
      renderer.autoClear = false;
      renderer.setPixelRatio(1); // RangeScene.resize receives physical dimensions.
      const gl = renderer.getContext();
      gl.disable(gl.DITHER);
      const range = Object.assign(Object.create(RangeScene.prototype), { THREE: T, renderer, canvas: renderer.domElement });
      range._copy = range._createCopy();
      const source = range._scenicTarget(6, 6, 0);
      const u = { pattern: { value: 0 }, band: { value: 0 } };
      const material = new T.ShaderMaterial({ glslVersion: T.GLSL3, uniforms: u,
        vertexShader: 'void main() { gl_Position = vec4(position.xy, 0., 1.); }',
        fragmentShader: `
          uniform int pattern, band;
          out vec4 color;
          void main() {
            ivec2 p = ivec2(gl_FragCoord.xy);
            bool far = pattern == 0 ? p.x + p.y < 5 : pattern == 1 ? p.x < 2 : pattern == 2 || (p.x < 2 && p.y < 2);
            bool near = pattern == 0 && !far;
            gl_FragDepth = far ? .6 : near ? .2 : 1.;
            vec4 red = vec4(1.,0.,0.,1.), blue = vec4(0.,0.,1.,1.);
            color = band == 0 && far ? (pattern == 2 && p.x >= 2 ? blue : red) : band == 1 && near ? blue : vec4(0.);
          }` });
      const patches = new T.Scene(), mesh = new T.Mesh(range._copy.mesh.geometry, material);
      mesh.frustumCulled = false;
      patches.add(mesh);
      range._setCanvasSize(11, 9); // A prior full-resolution water pass can leave a larger default framebuffer.
      renderer.setClearColor(0xff00ff, 1);
      renderer.clear();
      renderer.setClearColor(0, 0);
      const output = document.createElement('canvas');
      output.width = output.height = 4;
      const ctx = output.getContext('2d', { willReadFrequently: true });
      const draw = (pattern, band, useDepth = true) => {
        renderer.setRenderTarget(source);
        renderer.clear();
        u.pattern.value = pattern;
        u.band.value = band;
        renderer.render(patches, range._copy.camera);
        renderer.setRenderTarget(null);
        range._setCanvasSize(4, 4);
        range._clearCanvas();
        range._copyTexture(source.texture, null, useDepth ? source.depthTexture : null);
        const crop = range.imageRect(range.canvas);
        ctx.drawImage(range.canvas, crop.x, crop.y, crop.width, crop.height, 0, 0, 4, 4);
        const rgba = new Uint8Array(64);
        gl.readPixels(0, range.canvas.height - 4, 4, 4, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
        return [...rgba];
      };
      ctx.fillStyle = '#00ff00'; ctx.fillRect(0, 0, 4, 4);
      draw(0, 0); draw(0, 1);
      const joined = [...ctx.getImageData(0, 0, 4, 4).data];
      ctx.fillRect(0, 0, 4, 4);
      const sky = draw(1, 0);
      const compositedSky = [...ctx.getImageData(0, 0, 4, 4).data];
      const opaque = draw(2, 0), corner = draw(3, 0), grid = draw(1, 0, false);
      const slack = new Uint8Array(4);
      gl.readPixels(10, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, slack);
      return { joined, sky, compositedSky, opaque, corner, grid, slack: [...slack], error: gl.getError(), dpr: devicePixelRatio };
    });
    assert.deepEqual(errors, []);
    assert.equal(result.error, 0);
    assert.equal(result.dpr, 2);
    const pixel = (rgba, x, y) => rgba.slice((4 * y + x) * 4, (4 * y + x + 1) * 4);
    // At a disjoint opaque edge the same nearest owner must win in both
    // copies. Filtering far and near independently would expose green.
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
      const nearestX = Math.floor((x + .5) * 1.5), nearestY = Math.floor((3.5 - y) * 1.5);
      assert.deepEqual(pixel(result.joined, x, y), nearestX + nearestY < 5 ? [255,0,0,255] : [0,0,255,255]);
    }
    // Output column 1 sees a quarter red and three quarters open sky, or
    // a quarter red and three quarters blue if both are the same surface.
    assert.deepEqual(pixel(result.sky, 1, 2), [64,0,0,64]);
    assert.deepEqual(pixel(result.compositedSky, 1, 1), [64,191,0,255]);
    assert.deepEqual(pixel(result.opaque, 1, 2), [64,0,191,255]);
    assert.deepEqual(pixel(result.corner, 1, 1), [16,0,0,16], 'a two-axis sky corner keeps 1/16 coverage');
    assert.deepEqual(pixel(result.grid, 1, 2), [0,0,0,0], 'Grid releases the previous depth resolve');
    assert.deepEqual(result.slack, [255,0,255,255], 'the copy writes only the active image rectangle');
  } finally { await browser.close(); }
});
