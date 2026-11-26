import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import * as THREE from 'three';
import { createSceneMaterial } from '../src/world/alpine/TerrainMaterial.js';

test('surface samples belong only to the free Pixel terrain material', () => {
  for (const [pixelated, freePixelMotion, riverSurface, expected] of [
    [true, true, false, 1], [true, false, false, undefined],
    [false, true, false, undefined], [true, true, true, undefined],
  ]) {
    const m = createSceneMaterial(THREE, {}, { pixelated, freePixelMotion, riverSurface });
    assert.equal(m.defines.FREE_TERRAIN_PIXELS, expected);
    m.dispose();
  }
});

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH || chromium.executablePath();
test('world material samples travel fractionally with the camera while the water pass retains its colours', {
  skip: !existsSync(executablePath) && 'Chromium unavailable; set PLAYWRIGHT_CHROMIUM_PATH', timeout: 45000,
}, async () => {
  const browser = await chromium.launch({ headless: true, executablePath,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
  try {
    const page = await browser.newPage(), errors = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('**/*', async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Terrain sample coverage</title>' });
      if (!pathname.startsWith('/src/')) return route.fulfill({ status: 204 });
      return route.fulfill({ contentType: 'application/javascript', body: await readFile(new URL('..' + pathname, import.meta.url)) });
    });
    await page.goto('http://terrain-samples.test/');
    const result = await page.evaluate(async () => {
      const T = await import('/src/vendor/range/three-range.module.js');
      const { sceneUniforms, createSceneMaterial } = await import('/src/world/alpine/TerrainMaterial.js');
      const width = 64, height = 8, samples = 128;
      const renderer = new T.WebGLRenderer({ antialias: false });
      renderer.setSize(width, height, false);
      const gl = renderer.getContext();
      // Lighting from a band of real surface normals. The far half of the
      // rendered strip is a mapped lake; both share one opaque triangle.
      const bytes = new Uint8Array(samples * 2 * 4);
      for (let z = 0; z < 2; z++) for (let x = 0; x < samples; x++) {
        bytes.set([Math.round(128 + 104 * Math.sin(x * .63)), 128, 128, x < samples / 2 ? 0 : 255], (z * samples + x) * 4);
      }
      const texture = new T.DataTexture(bytes, samples, 2, T.RGBAFormat);
      texture.minFilter = texture.magFilter = T.LinearFilter;
      texture.needsUpdate = true;
      const u = sceneUniforms(T, { uGridOrigin: { value: new T.Vector2(-32, -16) },
        uGridExtent: { value: new T.Vector2(64, 32) }, uTexel: { value: new T.Vector2(1 / samples, .5) },
        uHeightRange: { value: new T.Vector2(0, 100) }, uSurface: { value: texture } });
      u.uNarrative.value.set(1, 0, 1, 1);
      u.uLightDir.value.set(.8, .6, 0);
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(new Float32Array([-100, 0, -100, 0, 0, 100, 100, 0, -100]), 3));
      const old = createSceneMaterial(T, u, { pixelated: true });
      const free = createSceneMaterial(T, u, { pixelated: true, freePixelMotion: true });
      const mesh = new T.Mesh(geo, old), scene = new T.Scene();
      scene.add(mesh);
      const camera = new T.OrthographicCamera(-16, 16, 2, -2, .1, 100);
      camera.up.set(0, 0, -1);
      const draw = (material, panPx) => {
        mesh.material = material;
        camera.position.set(.5 * panPx, 10, 0);
        camera.lookAt(.5 * panPx, 0, 0);
        u.uCameraPos.value.copy(camera.position);
        renderer.render(scene, camera);
        const row = new Uint8Array(width * 4);
        gl.readPixels(0, 4, width, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);
        return [...row].filter((_, i) => i % 4 === 0);
      };
      const reference = draw(old, 0), first = draw(free, 0);
      const phases = [0, .25, .5, .75, 1].map(pan => draw(free, pan));
      const repeated = draw(free, 0);
      // Constant terrain normal isolates pigment from the lighting-normal
      // sampling above. Rock height varies across a fixed physical swatch.
      for (let i = 0; i < bytes.length; i += 4) { bytes[i] = 128; bytes[i + 1] = 240; }
      texture.needsUpdate = true;
      const pigment = new Uint8Array(32 * 32 * 4);
      for (let i = 0; i < 32 * 32; i++)
        pigment.set([128, 128, 128, Math.round(128 + 100 * Math.sin(i % 32 * .62))], i * 4);
      const rock = new T.DataTexture(pigment, 32, 32, T.RGBAFormat);
      rock.wrapS = rock.wrapT = T.RepeatWrapping;
      rock.minFilter = rock.magFilter = T.LinearFilter;
      rock.needsUpdate = true;
      u.uHasMaterial.value = 1;
      u.tRock.value = u.tRockNear.value = rock;
      u.sRock.value = 13;
      u.rForestDensity.value = 0;
      u.pRockShade.value.setRGB(.06, .04, .04);
      const rockReference = draw(old, 0), rockFree = draw(free, 0);
      return { reference, first, phases, repeated, rockReference, rockFree, glError: gl.getError() };
    });
    assert.deepEqual(errors, []);
    assert.equal(result.glError, 0);
    assert.deepEqual(result.repeated, result.first, 'seek/pause returns exactly the same world marks');
    assert.deepEqual(result.first.slice(37, 62), result.reference.slice(37, 62), 'wet interiors keep the same shading');
    assert.ok(result.first.slice(2, 27).some((v, x) => Math.abs(v - result.reference[x + 2]) >= 2),
      'the production terrain shader lights world-space normal samples');
    assert.ok(result.rockFree.slice(2, 27).some((v, x) => Math.abs(v - result.rockReference[x + 2]) >= 2),
      'rock pigment moves across a constant-normal face');
    assert.deepEqual(result.rockFree.slice(37, 62), result.rockReference.slice(37, 62));
    const { phases } = result;
    const moving = phases[0].slice(2, 27).filter((_, i) => {
      const levels = phases.map(row => row[i + 2]);
      return new Set(levels).size >= 4 && Math.abs(levels.at(-1) - phases[0][i + 3]) <= 1;
    });
    assert.ok(moving.length >= 5, `${moving.length} slopes travelled through at least four positions before one old pixel`);
  } finally { await browser.close(); }
});
