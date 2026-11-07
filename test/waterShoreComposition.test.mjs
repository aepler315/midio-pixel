import test from 'node:test';
import assert from 'node:assert/strict';
import { RangePresentation } from '../src/world/alpine/RangePresentation.js';
import { SCENE_FRAG } from '../src/world/alpine/TerrainMaterial.js';

function setup() {
  const calls = [];
  const transform = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const makeCanvas = (width, height) => {
    const canvas = { width, height };
    const ctx = { canvas, setTransform() {}, clearRect() {}, getTransform: () => transform,
      drawImage(image) { calls.push(['copy', image.width, image.height]); },
      set globalCompositeOperation(value) { calls.push(['blend', value]); },
      set imageSmoothingEnabled(_value) {} };
    canvas.getContext = () => ctx;
    return canvas;
  };
  const output = makeCanvas(1280, 720), ctx = output.getContext();
  ctx.save = ctx.restore = () => {};
  const scene = { size: { width: 320, height: 180 }, waterOutputScale: 4, hasWater: () => true,
    pinView(ids, keys) { calls.push(['pin', ids, keys]); },
    renderWater(frame, view, w, h, opts) { calls.push(['render', view, w, h, opts]); return { width: w, height: h }; } };
  const pres = Object.assign(Object.create(RangePresentation.prototype), {
    scene, frame: { rise01: 1 }, frameId: 7, viewId: 'lake', arrival: 1, residency: null,
    directTerrainMode: true, directCastAvailable: true, outputSize: { width: 1280, height: 720 },
    _makeCanvas: makeCanvas, drawTerrainImage(_ctx, image) { calls.push(['native', image.width, image.height]); return true; },
  });
  return { pres, scene, ctx, calls, stage: { width: 1280, height: 720 } };
}

test('an admitted direct water layer owns its physical shoreline without a native mask or duplicate render', () => {
  const h = setup();
  assert.equal(h.pres._admitDirectWater('lake'), true);
  assert.equal(h.scene.separateWater, true);
  assert.equal(h.pres._drawDirectWater(h.ctx, h.stage, 'mid'), true);
  assert.deepEqual(h.calls.filter(c => c[0] === 'render').map(c => c.slice(1, 4)), [['lake', 1280, 720]]);
  assert.ok(!h.calls.some(c => c[0] === 'native' || c[0] === 'blend' && c[1] === 'destination-in'));
  assert.ok(h.calls.some(c => c[0] === 'pin' && c[2].includes('range:water-layer')));
});

test('travel water retains side-specific physical depth and column ownership', () => {
  const h = setup();
  assert.equal(h.pres._admitDirectWater('a', 'b'), true);
  const a = { near: [0, .6] }, b = { near: [.4, 1] };
  for (const [view, side, columns] of [['a', 'A', a], ['b', 'B', b]]) {
    assert.ok(h.pres._renderDirectWater(h.ctx, h.stage, 'near', view, side, columns));
  }
  const renders = h.calls.filter(c => c[0] === 'render');
  assert.equal(renders.length, 2);
  assert.deepEqual(renders.map(c => [c[1], c[4].side, c[4].bandColumns]), [['a', 'A', a], ['b', 'B', b]]);
});

test('target or canvas denial retains native wet appearance before the base terrain draws', () => {
  for (const denial of ['target', 'canvas']) {
    const h = setup();
    if (denial === 'target') h.pres.directCastAvailable = false;
    else h.pres.residency = { entries: new Map(), reserve: () => null, release() {} };
    assert.equal(h.pres._admitDirectWater('lake'), false);
    assert.equal(h.scene.separateWater, false);
    assert.equal(h.pres.directWaterAvailable, false);
  }
});

test('an arriving view retains native water if its combined arrival layer is denied', () => {
  const h = setup(); h.pres.arrival = .4;
  const reservations = [];
  h.pres.residency = { entries: new Map(), reserve({ key }) { reservations.push(key); return null; }, release() {} };
  assert.equal(h.pres._admitDirectWater('lake'), false, 'water color is not deferred while another arrival canvas is required');
  assert.equal(h.pres._drawDirectArrival(h.ctx, h.stage, 'mid', {}), false);
  assert.equal(h.scene.separateWater, false, 'the unassembled native partition keeps its water');
  assert.equal(h.pres.directWaterAvailable, false);
  assert.deepEqual(reservations, ['range:direct-arrival']);
});

test('the outer scenic wrapper admits water only after current arrival and departure resolve', () => {
  for (const departure of [false, true]) {
    const h = setup();
    h.pres.arrival = 1; h.scene.separateWater = true; h.pres.directWaterAvailable = true;
    h.pres._beginScenic = () => true;
    h.pres._updateArrival = () => { h.pres.arrival = departure ? 1 : .4; };
    h.pres._departure = departure ? .3 : 1;
    assert.equal(h.pres.beginScenic(), true);
    assert.equal(h.scene.separateWater, false);
    assert.equal(h.pres.directWaterAvailable, false);
  }
  const h = setup(); h.pres.arrival = 0;
  h.pres._beginScenic = () => true;
  h.pres._updateArrival = () => { h.pres.arrival = 1; };
  assert.equal(h.pres.beginScenic(), true);
  assert.equal(h.scene.separateWater, true, 'a fully arrived frame can admit its water even when the prior frame could not');
});

test('a water render lost after admission falls back to native water instead of exposing dry underlay', () => {
  const h = setup();
  assert.equal(h.pres._admitDirectWater('lake'), true);
  h.scene.renderWater = (_frame, _view, w, height) => { h.calls.push(['attempt', w, height]); return w > 320 ? null : { width: w, height }; };
  assert.equal(h.pres._drawDirectWater(h.ctx, h.stage, 'mid'), true);
  assert.deepEqual(h.calls.filter(c => c[0] === 'attempt'), [['attempt', 1280, 720], ['attempt', 320, 180]]);
  assert.ok(h.calls.some(c => c[0] === 'native'));
  assert.equal(h.scene.separateWater, false);
  assert.equal(h.pres.directWaterAvailable, false);
});

test('ordinary hybrid keeps native water behind its translucent mid-depth effect masks', () => {
  const h = setup(); h.pres.directTerrainMode = false;
  assert.equal(h.pres._admitDirectWater('lake'), false);
  assert.equal(h.scene.separateWater, false);
  assert.match(SCENE_FRAG, /bool paintWater = water && \(uWaterOnly > \.5 \|\| uSeparateWater < \.5\)/);
  assert.match(SCENE_FRAG, /float dots=water\?0\./, 'sourced wet classification still avoids canopy work in the deferred base');
  assert.match(SCENE_FRAG, /if \(uWaterOnly > 0\.5 && !water\) discard/, 'the physical layer still uses real terrain water classification');
});

test('the exactly flat opening draws no source shoreline or additional water layer', () => {
  const h = setup(); h.pres.frame = { rise01: 0 }; h.pres.active = true;
  let shores = 0, releases = 0, nativeDraws = 0;
  h.pres.crest = { drawShore() { shores++; } };
  h.pres._releaseWater = () => { releases++; };
  assert.equal(h.pres._admitDirectWater('lake'), false);
  assert.equal(h.pres._drawDirectWater(h.ctx, h.stage, 'mid'), false);
  h.pres._keepWater(h.ctx, h.stage);
  h.pres.drawShoreForeground(h.ctx, {});
  h.pres.directTerrainMode = false;
  h.pres.drawMidDepthForWater(h.ctx, {}, () => { nativeDraws++; });
  assert.equal(shores, 0); assert.equal(releases, 1); assert.equal(nativeDraws, 1);
  assert.ok(!h.calls.some(c => c[0] === 'render'));
  assert.equal(h.scene.separateWater, false);
});

test('source shoreline opacity grows with the same material handoff as the ocean', () => {
  const h = setup(); h.pres.active = true;
  const opacity = [];
  h.pres.crest = { drawShore(_ctx, _fit, _frame, land) { opacity.push(land); return true; } };
  for (const rise01 of [.125, .25, 1]) { h.pres.frame = { rise01 }; h.pres.drawShoreForeground(h.ctx, {}); }
  assert.deepEqual(opacity, [.5, 1, 1]);
});
