import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseForestArgs, cropRect, runForestSmoke, fullForestWindow, forestBrowser } from '../tools/forest-closeup-smoke.mjs';
import { resetForestSkyline } from '../tools/lib/forest-window.mjs';
import { CameraDirector } from '../src/render/CameraDirector.js';
import { presentationCamera } from '../src/render/Renderer.js';
import { BiomeManager } from '../src/world/BiomeManager.js';
import { TourWindowCache } from '../src/world/alpine/TerrainWindow.js';

test('close-up times are explicit seconds, sorted and deduplicated', () => {
  const a = parseForestArgs(['http://localhost:8092', '.smoke/test', '--times', '22,0,4.5,22']);
  assert.deepEqual(a.timesMs, [0, 4500, 22000]);
  assert.equal(a.debug, false);
  for (const times of ['', 'NaN', '-1', '96', '2,,4']) {
    assert.throws(() => parseForestArgs(['http://localhost', '.smoke/test', '--times', times]));
  }
  assert.throws(() => parseForestArgs(['http://localhost', '.smoke/test']));
  assert.throws(() => parseForestArgs(['http://localhost', '.smoke/test', '--random']));
});

test('close-up crop keeps its 512 pixel extent at every frame edge', () => {
  assert.deepEqual(cropRect(1920, 1080, [960, 540]), { x: 704, y: 284, width: 512, height: 512 });
  assert.deepEqual(cropRect(1920, 1080, [0, 0]), { x: 0, y: 0, width: 512, height: 512 });
  assert.deepEqual(cropRect(1920, 1080, [1920, 1080]), { x: 1408, y: 568, width: 512, height: 512 });
});

test('ring-tone measurements keep the original untinted 76-second checkpoint', () => {
  const a = parseForestArgs(['http://localhost', '.smoke/ring', '--times', '76', '--ring-tone']);
  assert.equal(a.ringTone, true);
  assert.deepEqual(a.timesMs, [76000]);
  assert.throws(() => parseForestArgs(['http://localhost', '.smoke/ring', '--times', '40', '--ring-tone']));
  assert.throws(() => parseForestArgs(['http://localhost', '.smoke/ring', '--times', '76', '--ring-tone', '--debug']));
});

test('far-dot visibility is measured at the original untinted ring pose', () => {
  const a=parseForestArgs(['http://localhost','.smoke/dots','--times','76','--far-dots']);
  assert.equal(a.farDots,true);
  assert.throws(()=>parseForestArgs(['http://localhost','.smoke/dots','--times','40','--far-dots']));
  assert.throws(()=>parseForestArgs(['http://localhost','.smoke/dots','--times','76','--far-dots','--debug']));
});

test('motion evidence pins a consecutive two-second 24 fps interval inside the song', () => {
  const a = parseForestArgs(['http://localhost', '.smoke/motion', '--motion', '40']);
  assert.equal(a.motionStartMs, 40000);
  assert.deepEqual(a.timesMs, [40000]);
  for (const start of ['', 'NaN', '-1', '95', '96']) {
    assert.throws(() => parseForestArgs(['http://localhost', '.smoke/motion', '--motion', start]));
  }
  assert.throws(() => parseForestArgs(['http://localhost', '.smoke/motion', '--motion', '40', '--times', '54']));
});

test('flicker evidence holds one pose and rejects mixing the moving-camera protocol', () => {
  const a = parseForestArgs(['http://localhost', '.smoke/flicker', '--flicker', '40']);
  assert.equal(a.flickerTimeMs, 40000);
  assert.deepEqual(a.timesMs, [40000]);
  assert.throws(() => parseForestArgs(['http://localhost', '.smoke/flicker', '--flicker', '40', '--motion', '40']));
  assert.throws(() => parseForestArgs(['http://localhost', '.smoke/flicker', '--flicker', '40', '--times', '54']));
  for (const value of ['', '-1', 'NaN', '96']) assert.throws(() => parseForestArgs(['http://localhost', '.smoke/flicker', '--flicker', value]));
});

test('a rerun refuses an existing evidence directory before touching its contents', async () => {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'forest-evidence-'));
  try {
    await fs.writeFile(path.join(output, 'report.json'), 'original evidence');
    await assert.rejects(runForestSmoke({ output }), { code: 'EEXIST' });
    assert.equal(await fs.readFile(path.join(output, 'report.json'), 'utf8'), 'original evidence');
    assert.deepEqual(await fs.readdir(output), ['report.json']);
  } finally { await fs.rm(output, { recursive: true }); }
});

test('a sparse seek waits for the full replacement of its resident coarse window', async () => {
  const full = { index: 5, coarse: false, dispose() {} };
  const cache = new TourWindowCache({ build: async () => full });
  cache.current = 5;
  cache.resident.set(5, { index: 5, coarse: true, dispose() {} });
  try { assert.equal(await fullForestWindow(cache, 40000), full); }
  finally { cache.dispose(); }
});


test('a full-window swap refreshes the skyline latched by an earlier held draw', () => {
  const oldDocument = globalThis.document;
  globalThis.document = {};
  let reads = 0;
  const context = { clearRect() {}, drawImage() {}, getImageData(_x, _y, w, h) {
    reads++; return { data: new Uint8ClampedArray(w * h * 4) };
  } };
  const stale = { ys: new Float32Array([.5]), atSec: 54, weight: 1 };
  const biomes = Object.assign(Object.create(BiomeManager.prototype), {
    tSec: 54, _skyline: stale, spaceRidge: { skyline: stale, lastEchoed: true },
    _skylineCanvas: { getContext: () => context }, _skylineReadCanvas: { getContext: () => context },
  });
  const mask = { image: {}, width: 1920, height: 1080, arrival: 1 };
  try {
    biomes._readSkyline(mask);
    assert.equal(reads, 0, 'same-time reading retains the held-window skyline');
    resetForestSkyline(biomes);
    biomes._readSkyline(mask);
    assert.equal(reads, 1, 'the full-window skyline must be read again');
    assert.notEqual(biomes._skyline, stale);
    assert.equal(biomes.spaceRidge.skyline, biomes._skyline);
    assert.equal(biomes.takeSkylineUnsettled(), true, 'the sky must redraw with its own land');
  } finally { globalThis.document = oldDocument; }
});


test('the forest capture seeds construction so residual 2D impact shake repeats', async () => {
  const oldWindow = globalThis.window, oldRandom = Math.random;
  const capture = async random => {
    globalThis.window = {}; Math.random = () => random;
    const browser = forestBrowser({ async newContext() {
      return { async addInitScript(fn, seed) { fn(seed); } };
    } });
    await browser.newContext({});
    window.__resetLandscapeRandom();
    const camera = new CameraDirector();
    camera._shakeAmp = 2;
    camera.update(1 / 60, 0, null, 0);
    const residual = presentationCamera(camera, { enabled: true, active: true, arrival: 1 });
    return { seed: camera._shakeSeed, x: residual.shakeX, y: residual.shakeY };
  };
  try {
    const first = await capture(.1), second = await capture(.9);
    assert.ok(Math.abs(first.x) + Math.abs(first.y) > 0, 'test must exercise impact shake');
    assert.deepEqual(first, second);
  } finally { globalThis.window = oldWindow; Math.random = oldRandom; }
});
