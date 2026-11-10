import test from 'node:test';
import assert from 'node:assert/strict';
import { fitPixelRect, PixelPresentation } from '../src/render/PixelPresentation.js';
import { createPresentingRenderer } from '../src/render/PresentingRenderer.js';
import { GraphicsResidency } from '../src/render/GraphicsResidency.js';
import { pixelGrid, runtimePixelGrid } from '../src/render/PixelRenderPolicy.js';

// Cinematic is the only look the live renderer presents. `pixel` is the plain
// nearest presentation the title backdrop still draws (main.js passes
// cinematicPixel: false); Cinematic itself composites the same nearest way
// when it sheds its cell reconstruction (qualityLevel >= 2).
const pixel = { pixelated: true, grid: { width: 320, height: 180 }, quality: 'auto', scaling: 'fit' };
const cinematic = { ...pixel, cinematicPixel: true };
function surface(width = 800, height = 480) {
  const canvas = { width, height, reads: 0, writes: 0, draws: [], fills: [] };
  const ctx = { canvas, setTransform() {}, imageSmoothingEnabled: true, fillRect(...a) { canvas.fills.push(a); },
    drawImage(...a) { canvas.draws.push({ args: a, smooth: this.imageSmoothingEnabled }); },
    getImageData() { canvas.reads++; return { width: canvas.width, height: canvas.height, data: new Uint8ClampedArray(canvas.width * canvas.height * 4) }; },
    putImageData() { canvas.writes++; } };
  canvas.contextRequests = [];
  // No WebGL here, as in Node: the cell reconstruction reports it unavailable.
  canvas.getContext = (type, options) => { canvas.contextRequests.push({ type, options }); return String(type).startsWith('webgl') ? null : ctx; };
  canvas.ownerDocument = { createElement: () => surface(0, 0) };
  return canvas;
}

test('only Cinematic native rasters request the explicit GPU hint on their first context', () => {
  for (const [presentation, options] of [
    [cinematic, { willReadFrequently: false }],
    [pixel, undefined],
  ]) {
    const output = surface(), owner = new PixelPresentation({ canvas: output, presentation, residency: new GraphicsResidency() });
    const working = owner.beginFrame({ separate: true });
    assert.deepEqual(working.contextRequests[0], { type: '2d', options });
    assert.equal(output.contextRequests[0].options, undefined, 'the output stage policy remains unchanged');
    assert.equal(owner.beginFrame({ separate: true }), working, 'steady frames retain their actual context');
    owner.dispose();
  }
});

test('admitted Cinematic growth creates the replacement with its GPU hint before publishing it', () => {
  const owner = new PixelPresentation({ canvas: surface(), presentation: cinematic, residency: new GraphicsResidency() });
  owner.setFrameGrid(runtimePixelGrid(320, 180));
  const original = owner.beginFrame({ separate: true });
  assert.equal(owner.setFrameGrid(runtimePixelGrid(400, 225)), true);
  const next = owner.working;
  assert.notEqual(next, original);
  assert.deepEqual(next.contextRequests[0], { type: '2d', options: { willReadFrequently: false } });
  assert.equal(original.width, 0);
  assert.equal(owner.beginFrame({ separate: true }), next);
  owner.dispose();
});

test('denied Cinematic growth keeps the prior context and its actual hint until replacement commits', () => {
  for (const failure of ['budget', 'commit']) {
    const residency = new GraphicsResidency(), owner = new PixelPresentation({ canvas: surface(), presentation: pixel, residency });
    const original = owner.beginFrame({ separate: true }), oldBytes = residency.usedBytes;
    owner.setPresentation(cinematic);
    if (failure === 'budget') residency.budgetBytes = oldBytes;
    else residency.commit = () => false;
    assert.equal(owner.setFrameGrid(runtimePixelGrid(400, 225)), false);
    assert.equal(owner.working, original);
    assert.equal(original.width, 320);
    assert.equal(owner._workingReadFrequently, undefined, 'requested false is not published over the actual default context');
    assert.equal(original.contextRequests[0].options, undefined);
    assert.equal(residency.usedBytes, oldBytes);
    assert.equal(residency.pendingBytes, 0);
    owner.dispose();
  }
});

test('same-grid Cinematic and plain policy changes recreate native contexts in both directions', () => {
  const owner = new PixelPresentation({ canvas: surface(), presentation: cinematic, residency: new GraphicsResidency() });
  const first = owner.beginFrame({ separate: true });
  owner.setPresentation(pixel);
  const plain = owner.beginFrame({ separate: true });
  assert.notEqual(plain, first);
  assert.equal(plain.contextRequests[0].options, undefined);
  assert.equal(first.width, 0);
  owner.setPresentation(cinematic);
  const restored = owner.beginFrame({ separate: true });
  assert.notEqual(restored, plain);
  assert.deepEqual(restored.contextRequests[0].options, { willReadFrequently: false });
  assert.equal(plain.width, 0);
  assert.equal(owner._workingReadFrequently, false);
  owner.dispose();
});

test('Cinematic native hints leave an explicitly readable output context untouched', () => {
  const output = surface(); output.getContext('2d', { willReadFrequently: true });
  const owner = new PixelPresentation({ canvas: output, presentation: cinematic, residency: new GraphicsResidency() });
  const working = owner.beginFrame({ separate: true });
  assert.deepEqual(output.contextRequests[0].options, { willReadFrequently: true });
  assert.deepEqual(working.contextRequests[0].options, { willReadFrequently: false });
  owner.dispose();
});
test('pixel fitting preserves aspect, integer scale and sub-grid targets', () => {
  assert.deepEqual(fitPixelRect(320, 180, 800, 480, 'integer'), { x: 80, y: 60, width: 640, height: 360, scale: 2 });
  assert.deepEqual(fitPixelRect(320, 180, 800, 480, 'fit'), { x: 0, y: 15, width: 800, height: 450, scale: 2.5 });
  assert.deepEqual(fitPixelRect(320, 180, 720, 720, 'fit'), { x: 0, y: 157.5, width: 720, height: 405, scale: 2.25 });
  assert.equal(fitPixelRect(320, 180, 160, 90, 'integer').scale, .5);
  assert.equal(fitPixelRect(320, 180, 1920, 1080, 'integer').scale, 6);
  assert.equal(fitPixelRect(320, 180, 540, 960, 'fit').height, 303.75);
});
test('fullscreen cover fills a non-16:9 viewport without stretching or black bars', () => {
  assert.deepEqual(fitPixelRect(320, 180, 800, 600, 'cover'), { x: -133.33333333333337, y: 0, width: 1066.6666666666667, height: 600, scale: 600 / 180 });
});
test('Cinematic\'s quality fallback composites the native grid nearest-neighbour without readback', () => {
  const output = surface();
  const owner = new PixelPresentation({ canvas: output, presentation: cinematic });
  owner.qualityLevel = 2;
  const working = owner.beginFrame();
  assert.equal(working.width * working.height, 57600);
  assert.equal(owner.finishFrame().presented, true);
  assert.deepEqual(owner.diagnostics.cinematicReconstruction, { applied: false, reason: 'quality', bytes: 0 });
  assert.equal(owner.diagnostics.effectiveLook, 'cinematic');
  assert.equal(working.reads, 0);
  assert.equal(working.writes, 0);
  assert.equal(output.reads, 0);
  assert.equal(output.draws.at(-1).smooth, false);
  assert.equal(output.draws.at(-1).args[0], working);
  assert.deepEqual(output.draws.at(-1).args.slice(1), [0, 15, 800, 450]);
  assert.deepEqual(output.fills.at(-1), [0, 0, 800, 480]);
  assert.equal(owner.getCaptureSource().canvas, working);
  owner.dispose(); owner.dispose();
});
test('adapter forwards compositor state and draws at the working resolution', () => {
  let drawn;
  const inner = { backend: 'canvas', drawCount: 0, draw() { this.drawCount++; drawn = [this.canvas.width, this.canvas.height]; }, dispose() {} };
  const adapter = createPresentingRenderer({ canvas: surface(), presentation: pixel, rendererFactory: canvas => { inner.canvas = canvas; return inner; } });
  const range = {}, composer = {};
  adapter.rangePresentation = range; adapter.hudInFrame = true; adapter.composer = composer;
  adapter.draw({}, 0);
  assert.deepEqual(drawn, [320, 180]);
  assert.equal(inner.rangePresentation, range); assert.equal(inner.composer, composer); assert.equal(inner.hudInFrame, true);
  assert.equal(adapter.drawCount, 1); assert.equal(adapter.getCaptureSource().pixelated, true);
  adapter.dispose();
});
for (const backend of ['canvas', 'webgl']) test(`pixel context reaches ${backend} scene and Range before drawing`, () => {
  const range = {}, scene = {};
  const inner = backend === 'canvas' ? scene : { canvasRenderer: scene };
  inner.rangePresentation = range;
  inner.dispose = () => {};
  inner.draw = () => {
    assert.equal(scene.pixelPolicy?.active, true);
    assert.equal(scene.pixelPolicy?.minGlyphHeight, 7);
    assert.equal(range.pixelPolicy, scene.pixelPolicy);
    assert.equal(range.pixelated, true);
  };
  const adapter = createPresentingRenderer({ canvas: surface(), presentation: pixel, rendererFactory: () => inner });
  assert.equal(adapter.draw({ biomes: { world: { kind: 'alpine' } } }, 0).presented, true);
  adapter.dispose();
});
test('identical frame context preserves a completed capture and generation', () => {
  const owner = new PixelPresentation({ canvas: surface(), presentation: pixel });
  assert.equal(typeof owner.setFrameContext, 'function');
  owner.setFrameContext({ worldKind: 'alpine' });
  owner.beginFrame(); owner.finishFrame();
  const capture = owner.getCaptureSource(), generation = owner.generation;
  owner.setFrameContext({ worldKind: 'alpine' });
  assert.equal(owner.generation, generation);
  assert.equal(owner.getCaptureSource(), capture);
  owner.setPresentation({ ...pixel, scaling: 'integer' });
  assert.equal(owner.getCaptureSource(), null);
  assert.ok(owner.generation > generation);
  owner.dispose();
});
test('profile and song changes release bounded working resources', () => {
  const residency = new GraphicsResidency({ budgetBytes: 1000000 });
  const baseline = residency.entries.size;
  for (let song = 0; song < 20; song++) {
    const owner = new PixelPresentation({ canvas: surface(), presentation: pixel, residency });
    // Cinematic and the title's plain policy alternate, recreating the native raster each time.
    owner.qualityLevel = 2;
    for (let i = 0; i < 100; i++) { owner.setPresentation(i % 2 ? cinematic : pixel); owner.beginFrame(); owner.finishFrame(); }
    assert.equal(residency.entries.size, baseline + 1);
    owner.dispose(); owner.dispose();
    assert.equal(residency.entries.size, baseline);
  }
});
test('allocation refusal never bypasses the residency budget', () => {
  const residency = new GraphicsResidency({ budgetBytes: 1 });
  const owner = new PixelPresentation({ canvas: surface(), presentation: cinematic, residency });
  assert.equal(owner.beginFrame(), null);
  assert.equal(owner.diagnostics.frame.reason, 'allocation-denied');
  assert.equal(residency.entries.size, 0);
  owner.dispose();
});
test('changing to a grid-sized output releases its obsolete working buffer', () => {
  const canvas = surface(), residency = new GraphicsResidency();
  const owner = new PixelPresentation({ canvas, presentation: pixel, residency });
  const working = owner.beginFrame(); owner.finishFrame();
  canvas.width = 320; canvas.height = 180;
  assert.equal(owner.beginFrame(), canvas);
  assert.equal(residency.usedBytes, 0);
  assert.equal(working.width, 0);
  assert.equal(owner.finishFrame().presented, true);
  owner.dispose();
});
test('the frame context labels captures with their world without invalidating them', () => {
  const owner = new PixelPresentation({ canvas: surface(), presentation: cinematic });
  owner.qualityLevel = 2;
  owner.setFrameContext({ worldKind: 'alpine' });
  owner.beginFrame(); owner.finishFrame();
  const capture = owner.getCaptureSource(), generation = owner.generation;
  assert.equal(capture.worldKind, 'alpine');
  // No palette depends on the world any more, so a new world is metadata only.
  owner.setFrameContext({ worldKind: 'custom' });
  assert.equal(owner.generation, generation);
  assert.equal(owner.getCaptureSource(), capture);
  owner.beginFrame(); owner.finishFrame();
  assert.equal(owner.getCaptureSource().worldKind, 'custom');
  owner.setFrameContext();
  owner.beginFrame(); owner.finishFrame();
  assert.equal(owner.getCaptureSource().worldKind, null);
  for (const removed of ['paletteId', 'ditherMode']) assert.equal(removed in owner.getCaptureSource(), false, removed);
  owner.dispose();
});
test('the presenting renderer labels Cinematic captures with the drawn world', () => {
  const inner = { backend: 'canvas', drawCount: 0, draw() {}, dispose() {} };
  const adapter = createPresentingRenderer({ canvas: surface(), presentation: cinematic, rendererFactory: canvas => { inner.canvas = canvas; return inner; } });
  const world = { kind: 'alpine' };
  assert.equal(adapter.draw({ biomes: { world } }, 0).presented, true);
  assert.equal(adapter.diagnostics.effectiveLook, 'cinematic');
  assert.equal(adapter.diagnostics.cinematicReconstruction.reason, 'webgl-unavailable', 'composited nearest instead');
  assert.equal(adapter.getCaptureSource().worldKind, 'alpine');
  assert.equal(adapter.getCaptureSource().cinematicPixel, true);
  assert.equal('experience' in adapter.getCaptureSource(), false);
  adapter.dispose();
});
for (const phase of ['before-first-frame', 'pending-frame', 'completed-paused-frame']) test(`grid changes invalidate capture and release all old dimensions during ${phase}`, () => {
  const residency = new GraphicsResidency({ budgetBytes: 4000000 });
  const profile = { ...cinematic, grid: pixelGrid() };
  const owner = new PixelPresentation({ canvas: surface(1280, 720), presentation: profile, residency });
  owner.qualityLevel = 2; // the nearest fallback: no cell-reconstruction buffer
  let old;
  if (phase !== 'before-first-frame') { old = owner.beginFrame(); if (phase === 'completed-paused-frame') owner.finishFrame(); }
  const generation = owner.generation;
  owner.setPresentation({ ...profile, grid: pixelGrid('detailed') });
  assert.ok(owner.generation > generation);
  assert.equal(owner.getCaptureSource(), null);
  assert.equal(owner.finishFrame().presented, false);
  assert.equal(residency.usedBytes, 0, 'the old working surface retires');
  if (old) assert.equal(old.width, 0);
  const source = owner.beginFrame();
  assert.deepEqual([source.width, source.height], [640, 360]);
  assert.equal(owner.finishFrame().presented, true);
  assert.equal(owner.getCaptureSource().grid.id, 'detailed');
  assert.equal(residency.usedBytes, 230400 * 4, 'working storage only');
  owner.setPresentation(profile); assert.equal(owner.getCaptureSource(), null);
  assert.equal(residency.usedBytes, 0);
  owner.beginFrame(); owner.finishFrame();
  assert.equal(owner.getCaptureSource().width, 320);
  owner.dispose(); assert.equal(residency.usedBytes, 0);
});
test('direct-source optimization requires the selected grid and retires obsolete working storage', () => {
  const canvas = surface(320, 180), residency = new GraphicsResidency();
  const owner = new PixelPresentation({ canvas, presentation: { ...pixel, grid: pixelGrid('detailed') }, residency });
  const source = owner.beginFrame();
  assert.notEqual(source, canvas); assert.equal(source.width, 640);
  owner.finishFrame();
  canvas.width = 640; canvas.height = 360;
  assert.equal(owner.getCaptureSource(), null);
  assert.equal(owner.beginFrame(), canvas);
  assert.equal(residency.usedBytes, 0); assert.equal(source.width, 0);
  assert.equal(owner.finishFrame().presented, true);
  owner.dispose();
});
test('disposal diagnostics discard readiness and owned scratch charges', () => {
  const owner = new PixelPresentation({ canvas: surface(), presentation: pixel });
  owner.beginFrame(); owner.finishFrame();
  assert.ok(owner.diagnostics.ownedPixelScratchBytes > 0);
  owner.dispose();
  assert.equal(owner.diagnostics.ownedPixelScratchBytes, 0);
  assert.equal(owner.diagnostics.frame.presented, false);
});

for (const failure of ['denied', 'output-context', 'working-context', 'creation', 'commit']) {
  test(`failed ${failure} presentation publishes no first or stale capture and cleans up`, () => {
    const canvas = surface();
    const residency = new GraphicsResidency({ budgetBytes: 1000000 });
    const owner = new PixelPresentation({ canvas, presentation: pixel, residency });
    assert.equal(owner.getCaptureSource(), null, 'a canvas reference is not a frame');
    const source = owner.beginFrame();
    assert.ok(source);
    const good = owner.finishFrame();
    assert.equal(good.presented, true);
    assert.equal(owner.getCaptureSource().generation, good.generation);
    owner.setPresentation({ ...pixel, grid: pixelGrid('detailed') }); // retires the previous working dimensions
    assert.equal(owner.getCaptureSource(), null);
    owner.setPresentation(cinematic);
    if (failure === 'denied') residency.budgetBytes = 1;
    if (failure === 'output-context') canvas.getContext = () => null;
    if (failure === 'working-context') canvas.ownerDocument.createElement = () => ({ width: 0, height: 0, getContext: () => null });
    if (failure === 'creation') canvas.ownerDocument.createElement = () => { throw Error('creation failed'); };
    if (failure === 'commit') {
      const commit = residency.commit.bind(residency);
      residency.commit = (reservation, resource, dispose) => { residency.release(reservation.key); return commit(reservation, resource, dispose); };
    }
    assert.equal(owner.beginFrame(), null);
    assert.equal(owner.finishFrame().presented, false);
    assert.equal(owner.getCaptureSource(), null, 'failed new profile must not advertise the previous frame');
    assert.equal(residency.usedBytes, 0);
    owner.dispose();
    assert.equal(owner.getCaptureSource(), null);
    const first = new PixelPresentation({ canvas, presentation: pixel, residency });
    assert.equal(first.beginFrame(), null);
    assert.equal(first.finishFrame().presented, false);
    assert.equal(first.getCaptureSource(), null);
    assert.equal(residency.usedBytes, 0);
    first.dispose();
  });
}
test('capture is invalid during a draw, after resize, external release and disposal', () => {
  const canvas = surface(), residency = new GraphicsResidency();
  const owner = new PixelPresentation({ canvas, presentation: pixel, residency });
  owner.beginFrame(); owner.finishFrame();
  const first = owner.getCaptureSource();
  owner.beginFrame();
  assert.equal(owner.getCaptureSource(), null);
  owner.finishFrame();
  assert.ok(owner.getCaptureSource().frameId > first.frameId);
  canvas.width = 1920;
  assert.equal(owner.getCaptureSource(), null);
  owner.beginFrame(); owner.finishFrame();
  residency.release(owner.key);
  assert.equal(owner.getCaptureSource(), null);
  assert.equal(owner.beginFrame().width, 320, 'released buffers are recreated with a reservation');
  owner.finishFrame(); owner.dispose();
  assert.equal(owner.getCaptureSource(), null);
});
test('a failed output composite invalidates the capture of a completed frame', () => {
  const canvas = surface(), owner = new PixelPresentation({ canvas, presentation: pixel });
  owner.beginFrame();
  assert.equal(owner.finishFrame().presented, true);
  assert.ok(owner.getCaptureSource());
  owner.beginFrame();
  canvas.getContext('2d').drawImage = () => { throw Error('composite failed'); };
  assert.equal(owner.finishFrame().presented, false);
  assert.equal(owner.getCaptureSource(), null);
  owner.dispose();
});
test('adapter explicitly reports an unsuccessful allocation without drawing', () => {
  let draws = 0;
  const adapter = createPresentingRenderer({ canvas: surface(), presentation: pixel, residency: new GraphicsResidency({ budgetBytes: 1 }),
    rendererFactory: () => ({ draw() { draws++; }, dispose() {} }) });
  assert.equal(adapter.draw({}, 0).presented, false);
  assert.equal(draws, 0);
  assert.equal(adapter.getCaptureSource(), null);
  adapter.dispose();
});

test('disposed adapters and context loss after begin cannot publish successful presentation', () => {
  const canvas=surface(320,180),owner=new PixelPresentation({canvas,presentation:pixel});
  owner.beginFrame();
  canvas.getContext('2d').isContextLost=()=>true;
  assert.equal(owner.finishFrame().presented,false);
  assert.equal(owner.getCaptureSource(),null);
  const adapter=createPresentingRenderer({canvas:surface(),presentation:pixel,rendererFactory:()=>({draw(){},dispose(){}})});
  assert.equal(adapter.draw({},0).presented,true);
  adapter.dispose();
  assert.equal(adapter.draw({},0).presented,false);
  assert.equal(adapter.getCaptureSource(),null);
  owner.dispose();
});

test('throwing inner disposal still invalidates capture and releases residency', () => {
  const residency=new GraphicsResidency({budgetBytes:1000000});
  const adapter=createPresentingRenderer({canvas:surface(),presentation:pixel,residency,
    rendererFactory:()=>({draw(){},dispose(){throw new Error('inner cleanup failed');}})});
  assert.equal(adapter.draw({},0).presented,true);
  assert.ok(adapter.getCaptureSource());
  assert.throws(()=>adapter.dispose(),/inner cleanup failed/);
  assert.equal(adapter.getCaptureSource(),null);
  assert.equal(residency.entries.size,0);
  assert.equal(adapter.draw({},0).presented,false);
  assert.doesNotThrow(()=>adapter.dispose());
});

test('failed reservation commit releases the uncommitted canvas storage', () => {
  const canvas=surface(),buffer=surface(0,0);
  canvas.ownerDocument.createElement=()=>buffer;
  const residency=new GraphicsResidency({budgetBytes:1000000});
  residency.commit=()=>false;
  const owner=new PixelPresentation({canvas,presentation:pixel,residency});
  assert.equal(owner.beginFrame(),null);
  assert.deepEqual([buffer.width,buffer.height],[0,0]);
  assert.equal(residency.pendingBytes,0);
  owner.dispose();
});

test('reapplying a profile before a backing reset invalidates capture without a new generation', () => {
  const owner=new PixelPresentation({canvas:surface(),presentation:pixel});
  owner.beginFrame();const first=owner.finishFrame();assert.ok(owner.getCaptureSource());
  owner.setPresentation({...pixel});
  assert.equal(owner.getCaptureSource(),null);
  assert.equal(owner.generation,first.generation);
  owner.beginFrame();assert.equal(owner.finishFrame().presented,true);owner.dispose();
});

test('raw Natural presentation overrides stay pixelated through drawing and recorder capture', () => {
  const canvas = surface(1920, 1080);
  let sourceSize, scenePolicy;
  const adapter = createPresentingRenderer({ canvas, presentation: { ...pixel, pixelated: false, grid: null },
    rendererFactory: () => ({ draw() { sourceSize = [this.canvas.width, this.canvas.height]; scenePolicy = this.pixelPolicy; }, dispose() {} }) });
  assert.equal(adapter.draw({}, 0).presented, true);
  assert.deepEqual(sourceSize, [320, 180]);
  assert.equal(scenePolicy.active, true);
  assert.equal(canvas.draws.at(-1).smooth, false);
  assert.deepEqual([canvas.width, canvas.height], [1920, 1080]);
  assert.equal(adapter.diagnostics.effectiveLook, 'pixel');
  assert.equal(adapter.getCaptureSource().pixelated, true);
  adapter.dispose();
});
test('unscoped stale Natural input still uses pixels', () => {
  const canvas = surface(1280, 720);
  const owner = new PixelPresentation({ canvas, presentation: { ...pixel, pixelated: false } });
  assert.equal(owner.beginFrame().width, 320);
  assert.equal(owner.finishFrame().presented, true);
  assert.equal(owner.getCaptureSource().pixelated, true);
  owner.dispose();
});

test('Uniform scale keeps the plain nearest compositor free of readback or color transforms', () => {
  const canvas = surface(1920, 1080);
  const owner = new PixelPresentation({ canvas, presentation: { ...pixel, pixelScale: 'original' } });
  const source = owner.beginFrame();
  assert.equal(owner.finishFrame().presented, true);
  assert.equal(source.reads, 0);
  assert.equal(source.writes, 0);
  assert.equal(canvas.draws.at(-1).smooth, false);
  assert.equal(owner.getCaptureSource().pixelScale, 'original');
  owner.dispose();
});

test('a full-resolution sky is composed behind the pixel terrain and exported with it', () => {
  const canvas = surface(1280, 720), order = [];
  let expectedTransform = [4, 0, 0, 4, 40, 80];
  const ctx = canvas.getContext();
  Object.assign(ctx, { save() {}, restore() {}, beginPath() {}, rect() {}, clip() {} });
  const originalDraw = ctx.drawImage;
  ctx.drawImage = function (...args) { order.push('terrain'); return originalDraw.apply(this, args); };
  const manager = { world: { kind: 'alpine' },
    drawHighResolutionSky(_, output, options) {
      order.push('sky'); assert.equal(output, canvas);
      assert.deepEqual(options.transform, expectedTransform); return true;
    } };
  const inner = { rangePresentation: { enabled: true }, draw(sim) {
    assert.equal(manager.highResolutionSky, true);
    manager.rangeSkyLayer = { scenicTransform: [1, 0, 0, 1, 10, 20] };
  }, dispose() {} };
  const adapter = createPresentingRenderer({ canvas, presentation: pixel, rendererFactory: () => inner });
  assert.equal(adapter.draw({ biomes: manager }, 0).presented, true);
  assert.deepEqual(order, ['sky', 'terrain']);
  const capture = adapter.getCaptureSource();
  assert.equal(capture.canvas, canvas);
  assert.equal(capture.width, 1280);
  assert.equal(capture.height, 720);
  assert.equal(capture.pixelCanvas.width, 320);
  assert.equal(capture.hybridSky, true);
  assert.equal(capture.pixelated, false, 'recording must not nearest-neighbour rescale the smooth sky');
  assert.equal(capture.terrainPixelated, true);
  assert.equal(adapter.diagnostics.skyResolution.width, 1280);
  const recorded = surface(800, 450), recordedCtx = recorded.getContext();
  Object.assign(recordedCtx, { save() {}, restore() {}, beginPath() {}, rect() {}, clip() {} });
  expectedTransform = [2.5, 0, 0, 2.5, 25, 50];
  assert.equal(capture.drawCaptureFrame(recordedCtx, 800, 450), true);
  assert.equal(recorded.draws.at(-1).smooth, false, 'the recorder target receives native terrain without interpolated edges');
  assert.equal(recorded.draws.at(-1).args[0], capture.pixelCanvas);
  assert.equal(adapter.diagnostics.skyResolution.width, 1280, 'recording cannot alter display diagnostics');
  adapter.draw({ biomes: manager }, 0);
  assert.equal(capture.drawCaptureFrame(recordedCtx, 800, 450), false, 'an obsolete capture painter cannot redraw another frame');
  adapter.dispose();
});

test('Landscape screen effects run after the composite at live and recording resolutions', () => {
  const canvas = surface(1280, 720), order = [];
  stateful(canvas, order, 'live');
  const manager = { world: { kind: 'alpine' }, drawHighResolutionSky() { return true; } };
  const inner = { hudInFrame: true, rangePresentation: { enabled: true }, draw() {
    assert.equal(this.deferPostEffects, true);
    manager.rangeSkyLayer = { scenicTransform: [1, 0, 0, 1, 0, 0] };
  }, drawDeferredPostEffects(ctx, fit) {
    order.push([ctx === canvas.getContext() ? 'live' : 'recorded', 'effects', fit.width, fit.height]);
  }, dispose() {} };
  const adapter = createPresentingRenderer({ canvas, presentation: pixel, rendererFactory: () => inner });
  assert.equal(adapter.draw({ biomes: manager }, 0).presented, true);
  assert.deepEqual(order.at(-1), ['live', 'effects', 1280, 720]);
  const capture = adapter.getCaptureSource(), recorded = surface(640, 360);
  stateful(recorded, order, 'recorded');
  assert.equal(capture.drawCaptureFrame(recorded.getContext(), 640, 360), true);
  assert.deepEqual(order.at(-1), ['recorded', 'effects', 640, 360]);
  adapter.dispose();
});

test('Landscape water composites over the pixel frame in live and recorded output', () => {
  const canvas = surface(1280, 720), order = [];
  stateful(canvas, order, 'live');
  const range = { enabled: true,
    drawWaterForeground(ctx, fit) {
      order.push([ctx === canvas.getContext() ? 'live' : 'recorded', 'water', ctx.globalCompositeOperation, fit.width]); return true;
    } };
  const inner = { rangePresentation: range, draw() { assert.deepEqual(range.waterOutputSize, { width: 1280, height: 720 }); }, dispose() {} };
  const adapter = createPresentingRenderer({ canvas, presentation: pixel, rendererFactory: () => inner });
  assert.equal(adapter.draw({ biomes: { world: { kind: 'alpine' } } }, 0).presented, true);
  assert.deepEqual(order.slice(-1), [['live', 'water', 'source-over', 1280]]);
  const recorded = surface(640, 360); stateful(recorded, order, 'recorded');
  assert.equal(adapter.getCaptureSource().drawCaptureFrame(recorded.getContext(), 640, 360), true);
  assert.deepEqual(order.slice(-1), [['recorded', 'water', 'source-over', 640]]);
  adapter.dispose();
});

test('a grid-sized hybrid output retains a separate transparent foreground buffer', () => {
  const canvas = surface(320, 180), owner = new PixelPresentation({ canvas, presentation: pixel });
  const source = owner.beginFrame({ separate: true });
  assert.notEqual(source, canvas, 'painting the sky cannot destroy an aliased terrain source');
  assert.equal(source.width, 320); assert.equal(source.height, 180);
  owner.dispose();
});

test('smooth mid-depth effects compose above water in live and recording frames', () => {
  const canvas = surface(1280, 720), order = [];
  stateful(canvas, order, 'live');
  const range = { enabled: true, drawWaterForeground() { order.push('water'); return true; } };
  const manager = { world: { kind: 'alpine' }, drawHighResolutionMidEffects(ctx, fit) {
    order.push(['mid', ctx.globalCompositeOperation, fit.width]); return true;
  } };
  const inner = { rangePresentation: range, draw() { assert.equal(manager.highResolutionMidEffects, true); }, dispose() {} };
  const adapter = createPresentingRenderer({ canvas, presentation: pixel, rendererFactory: () => inner });
  assert.equal(adapter.draw({ biomes: manager }, 0).presented, true);
  assert.deepEqual(order.slice(-2), ['water', ['mid', 'source-over', 1280]]);
  const recorded = surface(640, 360); stateful(recorded, order, 'recorded');
  assert.equal(adapter.getCaptureSource().drawCaptureFrame(recorded.getContext(), 640, 360), true);
  assert.deepEqual(order.slice(-2), ['water', ['mid', 'source-over', 640]]);
  adapter.dispose();
});

test('a refused smooth effect composite is reported instead of publishing missing weather', () => {
  const canvas = surface(1280, 720);
  stateful(canvas, [], 'live');
  const adapter = createPresentingRenderer({ canvas, presentation: pixel,
    rendererFactory: () => ({ draw() {}, dispose() {} }) });
  const manager = { world: { kind: 'alpine' }, drawHighResolutionMidEffects() { return false; } };
  assert.equal(adapter.draw({ biomes: manager }, 0).presented, false);
  assert.equal(adapter.getCaptureSource(), null);
  adapter.dispose();
});

test('unready terrain holds the last completed output instead of publishing loading scenery', () => {
  const canvas = surface(), manager = { world: { kind: 'alpine' }, _awaitingTerrain: true };
  const adapter = createPresentingRenderer({ canvas, presentation: pixel,
    rendererFactory: () => ({ rangePresentation: { enabled: true }, draw() {}, dispose() {} }) });
  const result = adapter.draw({ biomes: manager }, 0);
  assert.equal(result.presented, false);
  assert.equal(result.reason, 'terrain-not-ready');
  assert.equal(canvas.draws.length, 0);
  assert.equal(adapter.getCaptureSource(), null);
  adapter.dispose();
});

/** A 2D context whose smoothing and compositing follow save/restore. */
function stateful(canvas, order, name) {
  const ctx = canvas.getContext(), stack = [];
  Object.assign(ctx, { globalCompositeOperation: 'source-over',
    save() { stack.push([this.imageSmoothingEnabled, this.globalCompositeOperation]); },
    restore() { [this.imageSmoothingEnabled, this.globalCompositeOperation] = stack.pop(); },
    beginPath() {}, rect() {}, clip() {} });
  const draw = ctx.drawImage;
  ctx.drawImage = function (...args) { order.push([name, 'pixels', this.imageSmoothingEnabled, this.globalCompositeOperation]); return draw.apply(this, args); };
  return ctx;
}

for (const [gridId, unit] of [['classicPlus', 1], ['medium', 2], ['mediumPlus', 2]]) test(`${gridId} pixel effects use a whole-pixel unit`, async () => {
  const { pixelRenderPolicy } = await import('../src/render/PixelRenderPolicy.js');
  const { pixelHeatOffset } = await import('../src/render/PixelEffects.js');
  const policy = pixelRenderPolicy({ pixelated: true, grid: pixelGrid(gridId) });
  assert.equal(policy.unit, unit);
  assert.ok(Number.isInteger(policy.minGlyphHeight));
  for (const v of [-3, -1.2, .4, 1.6, 3]) assert.ok(Number.isInteger(pixelHeatOffset(v, { unit: policy.unit })));
});
