import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager } from '../src/world/BiomeManager.js';
import { SpaceRidge } from '../src/world/SpaceRidge.js';
import { RidgeMotionHistory } from '../src/world/RidgeMotionHistory.js';
import { buildRangeFrame } from '../src/world/alpine/RangeFrame.js';
import { RangeSkyRenderer } from '../src/world/alpine/RangeSkyRenderer.js';
import { createRangeSkyComposition } from '../src/world/alpine/RangeSkyComposition.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';
import { LerpCache } from '../src/utils/color.js';

const camera = { tourPose: { eyeM: [0, 0, 0], targetM: [0, 0, -1], fovYDeg: 50 } };
const profile = { name: 'CONIFER', sky: ['#123456', '#234567', '#345678'],
  celestial: { color: '#ffffff', haloColor: '#ccddee', radius: 30 } };
const viewport = { width: 320, height: 180 };
const pose = { worldX: 0, midioX: 160, midioY: 150 };
function fixture(overrides = {}) {
  const history = new RidgeMotionHistory({ durationMs: 60000, timeline: [
    { tMs: 0, durMs: 20000, vel: .8, src: 'midi', role: 'BASS', lane: 'MIDIO', pitch: 72 },
    { tMs: 11800, durMs: 100, vel: .9, src: 'midi', role: 'RHYTHM', kick: true },
  ] });
  const samples = [];
  const session = { stateKey: history.stateKey, sample: at => { samples.push(at); return history.sample(at); } };
  const spaceRidge = new SpaceRidge(315);
  spaceRidge.history = session; spaceRidge._tSec = 12;
  const manager = Object.assign(Object.create(BiomeManager.prototype), {
    world: { kind: 'alpine' }, tSec: 12, durationMs: 60000, _dayNightCycleMs: 60000,
    _progress: .2, _lightBudget: 1, visualStyle: 'rendered', openingGain: 1,
    currentBlend: { from: 'CONIFER', to: 'CONIFER', t: 1 },
    sections: [{ profile: 'CONIFER', startMs: 0, endMs: 60000 }],
    _profile: () => profile, _rotated: value => value, lerpCache: new LerpCache(),
    currentCelestialColor: () => '#ffffff', currentHaloColor: () => '#ccddee',
    ridgeMusicSession: session, spaceRidge, highResolutionSky: true,
    rangePresentation: { enabled: true, skyPan: camera }, ...overrides,
  });
  return { manager, samples };
}
function drawPrelude(manager) {
  const stop = new Error('scenic boundary');
  manager.rangePresentation.beginScenic = () => { throw stop; };
  assert.throws(() => manager.draw({ save() { throw stop; },
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) }, viewport, 0),
    error => error === stop);
}
const frameFor = manager => buildRangeFrame({ frameId: 1, pose,
  sim: { biomes: manager, stageW: 320, stageH: 180, songSeed: 315, perf: { level: 0 } } });

test('active compact hybrid sky skips legacy ridge measurements and eager corridor reads', () => {
  const { manager, samples } = fixture();
  drawPrelude(manager);
  assert.deepEqual(samples, [], 'no hidden trailing diagnostic reads before the scenic frame');
  assert.equal(manager._frameRidges, null);
  const frame = frameFor(manager);
  assert.deepEqual(samples, [12000], 'the primary heard-time sample still drives terrain and forest music');
  assert.equal(frame.ridges, null);
  assert.ok(frame.music.source.melodicM > 0);
  assert.equal(manager._rangeSky.celestialShafts, false, 'existing legacy accent exclusions remain intact');
});

test('direct, unresolved and preview callers retain diagnostic ridges and the identical primary music', () => {
  const hybrid = fixture();
  drawPrelude(hybrid.manager);
  const hybridFrame = frameFor(hybrid.manager);
  for (const overrides of [
    { highResolutionSky: false },
    { rangePresentation: { enabled: true } },
    { rangePresentation: { enabled: false, skyPan: camera } },
    { terrainPreview: true },
  ]) {
    const { manager, samples } = fixture(overrides);
    drawPrelude(manager);
    assert.ok(samples.some(at => at < 12000), 'legacy relationship diagnostics retain their causal history');
    const frame = frameFor(manager);
    assert.ok(frame.ridges?.dance?.points.length > 0 && frame.ridges?.space?.points.length > 0);
    if (!overrides.terrainPreview) assert.deepEqual(frame.music, hybridFrame.music);
  }
});

test('a frame that skips the Range scene leaves no cast layer from the last one to composite', () => {
  for (const overrides of [{ terrainPreview: true }, { world: { kind: 'canyon' } }]) {
    const stale = { canvas: { width: 1 }, alpha: 1 };
    const { manager } = fixture({ ...overrides, rangePresentation: { enabled: true, skyPan: camera, castLayer: stale } });
    manager.rangePresentation.beginScenic = () => assert.fail('the preview never begins the Range scene');
    try { manager.draw({ save() { throw new Error('scenic boundary'); }, getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) }, viewport, 0); }
    catch (err) { if (err.message !== 'scenic boundary') throw err; }
    assert.equal(manager.rangePresentation.castLayer, null, `${JSON.stringify(overrides)}: the presenter adds nothing stale`);
  }
});

test('standalone hybrid frames skip the fallback even with an old legacy diagnostic snapshot', () => {
  for (const _frameRidges of [null, { stale: true }]) {
    const { manager, samples } = fixture({ _frameRidges });
    const frame = frameFor(manager);
    assert.deepEqual(samples, [12000]);
    assert.equal(frame.ridges, null, 'old native-sky diagnostics do not leak across a presentation switch');
  }
});

test('optional lazy corridor keeps eager default and measures once on the first actual point request', () => {
  let calls = 0;
  const ridge = new SpaceRidge(315), corridor = ridge.corridor.bind(ridge);
  ridge.corridor = canvas => { calls++; return corridor(canvas); };
  const eager = createRangeSkyComposition(ridge, viewport);
  assert.equal(calls, 1, 'ordinary legacy callers retain eager per-frame geometry');
  const lazy = createRangeSkyComposition(ridge, viewport, { lazyCorridor: true });
  assert.equal(calls, 1, 'an unused hybrid corridor performs no geometry work');
  assert.equal(lazy.allowPoint(120, 40), eager.allowPoint(120, 40));
  assert.equal(calls, 2, 'the first actual point request resolves one corridor');
  for (const [x, y] of [[0, 0], [160, 75], [319, 179]]) {
    assert.equal(lazy.starBrightnessAt(x, y), eager.starBrightnessAt(x, y));
    assert.equal(lazy.weaverOptions.allowPoint(x, y), eager.weaverOptions.allowPoint(x, y));
  }
  assert.equal(calls, 2, 'all point consumers share this frame\'s resolved corridor');
});

function tintFixture() {
  let paints = 0, density = { id: 1 };
  const residency = new GraphicsResidency({ budgetBytes: 1024 ** 2 });
  const sky = new RangeSkyRenderer({ residency, makeCanvas: () => {
    const canvas = { width: 0, height: 0, pixels: null };
    const ctx = {
      clearRect() { paints++; canvas.pixels = null; },
      createLinearGradient() { const stops = []; return { stops, addColorStop: (...stop) => stops.push(stop) }; },
      fillRect() { canvas.pixels = { stops: this.fillStyle.stops.map(stop => [...stop]) }; },
      drawImage(source) { canvas.pixels.density = source.id; },
    };
    canvas.getContext = () => ctx;
    return canvas;
  } });
  sky._cloud = () => density;
  const banks = [{ id: 'bank0', x: 100, y: 20, w: 80, h: 12, alpha: .7 }];
  const style = { dark: [26, 31, 39], lit: [70, 76, 86], directGain: .35 };
  const draw = (options = style, placements = banks) => {
    const output = [];
    sky._stormClouds({ save() {}, restore() {}, drawImage(image, ...rect) {
      output.push({ pixels: structuredClone(image.pixels), alpha: this.globalAlpha, rect });
    } }, placements, options);
    return output;
  };
  return { sky, residency, banks, style, draw, paints: () => paints, replaceDensity: () => { density = { id: density.id + 1 }; } };
}

test('unchanged storm tint reuses pixels while bank placement and opacity remain live', () => {
  const f = tintFixture();
  try {
    const first = f.draw();
    assert.deepEqual(first[0].pixels, { stops: [[0, 'rgb(41,47,55)'], [1, 'rgb(26,31,39)']], density: 1 });
    const moved = f.draw({ ...f.style, dark: [...f.style.dark], lit: [...f.style.lit] },
      [{ ...f.banks[0], x: 130, alpha: .4 }]);
    assert.equal(f.paints(), 1, 'identical scalar inputs must not re-rasterize the tinted density');
    assert.deepEqual(moved[0].pixels, first[0].pixels);
    assert.deepEqual(moved[0].rect, [90, 8, 80, 24]);
    assert.equal(moved[0].alpha, .4);
    assert.equal(f.residency.usedBytes, 192 * 128 * 4, 'reuse does not allocate another sprite');
  } finally { f.sky.dispose(); }
  assert.equal(f.residency.usedBytes, 0);
});

test('storm tint invalidates on exact gain, every color, density, flash and storage replacement', () => {
  const f = tintFixture();
  try {
    f.draw();
    const styles = [
      { ...f.style, directGain: .35000000001 },
      ...[0, 1, 2].map(channel => ({ ...f.style, dark: f.style.dark.map((value, i) => value + (i === channel ? 1 : 0)) })),
      ...[0, 1, 2].map(channel => ({ ...f.style, lit: f.style.lit.map((value, i) => value + (i === channel ? 1 : 0)) })),
      { dark: [150, 168, 215], lit: [222, 232, 255], directGain: 1.2 },
      f.style,
    ];
    for (const [index, style] of styles.entries()) {
      f.draw(style);
      assert.equal(f.paints(), index + 2, 'all exact style changes, including flash restoration, repaint');
    }
    f.style.dark[0]++;
    f.draw();
    assert.equal(f.paints(), styles.length + 2, 'mutating a supplied array cannot reuse its old colors');
    f.replaceDensity();
    assert.equal(f.draw()[0].pixels.density, 2);
    assert.equal(f.paints(), styles.length + 3);
    f.sky.buffers.release('storm-cloud-0');
    f.draw();
    assert.equal(f.paints(), styles.length + 4, 'released storage cannot inherit a valid tint');
    f.sky._seed(316);
    f.draw();
    assert.equal(f.paints(), styles.length + 5, 'seed changes recreate the output sprite');
  } finally { f.sky.dispose(); }
});
