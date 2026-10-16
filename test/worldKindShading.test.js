// Every world kind has to shade its ranges.
//
// The strip bake is a single FLAT fill by design (silhouetteFlatFill.test.js
// enforces it: a baked gradient sliced into independently-offset dance columns
// is a hard seam at every column boundary). So the ONLY thing that gives a
// range any shading is _drawRidgeVolume -- and for a long time that was
// reachable only from BiomeManager's classic alpine path. Seven of the eight
// world kinds have their own draw function and `return` before reaching it,
// so every one of them blitted a bare flat silhouette and called it a range.
//
// That is a whole-game defect wearing the costume of a style choice: whichever
// kind a song happens to be assigned decided whether its mountains had any
// volume at all. This pins the fix so a new world kind cannot quietly ship
// flat, and so nobody removes these calls thinking they are alpine-only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WORLD_RENDERERS } from '../src/world/WorldRegistry.js';

const KINDS = ['city', 'airless', 'abyssal', 'foundry', 'overgrowth', 'nave', 'strip'];
const STOP_AFTER_FIRST_SHADE = new Error('first range shaded');

function recordingContext(events) {
  const gradient = () => ({ addColorStop() {} });
  return {
    canvas: { width: 640, height: 360 },
    save() {}, restore() {}, beginPath() {}, closePath() {}, clip() {}, fill() {}, stroke() {},
    moveTo() {}, lineTo() {}, rect() {}, arc() {}, ellipse() {}, translate() {}, rotate() {}, scale() {},
    fillRect() {}, strokeRect() {},
    drawImage(strip, x, y) { events.push({ type: 'blit', strip, x, y }); },
    createLinearGradient: gradient, createRadialGradient: gradient,
    globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '', strokeStyle: '', lineWidth: 1,
  };
}

function firstRangeContract(kind, draw, complete = false) {
  const events = [];
  const strip = { width: 200, height: 100 };
  const strips = { L2: strip, L3: strip, L4: strip, L5: strip };
  const noop = () => {};
  const mgr = {
    world: { kind }, tSec: 5, durationMs: 120000, openingGain: 1, reducedFlash: false,
    currentBlend: { from: 'fixture', to: 'fixture' }, unravel: 0, orogenyGrowth: 0.5,
    energyCurves: null, worldRhythm: null, sections: [], _lastSectionIdx: 0,
    visualStyle: null, _perf: { phenomenaFull: false, heavyPostFx: false, hazeLayers: 1, rimLightEnabled: false },
    lerpCache: { get: (a) => a }, _rotated: (a) => a,
    stripsFor: () => strips, fields: new Map(), weatherFields: new Map(),
    weaver: { draw: noop }, meteors: { draw: noop },
    _drawSky: noop, drawDeepSky: noop, _drawMoon: noop, _drawCelestial: noop,
    _drawHaze: noop, _drawFogBanks: noop, _drawGround: () => events.push({ type: 'ground' }), _drawTerrainFooting: noop,
    _drawFlood: noop, _drawTransitionOverlays: noop,
    _drawSignature: () => events.push({ type: 'signature' }),
    _moonPhase01: () => 0.5,
    _celestialApproachAt: (_canvas, x, y) => ({ x, y, scale: 1 }),
    _drawRidgeVolume(...args) {
      events.push({ type: 'shade', args });
      if (!complete) throw STOP_AFTER_FIRST_SHADE;
    },
  };
  const palette = {
    name: 'fixture', sky: ['#101820', '#182838', '#304050'], silhouette: '#506070',
    terrainEnergy: 0.75, fx: null, celestial: { color: '#d0c0a0', haloColor: '#80a0c0', radius: 80 },
  };
  const canvas = { width: 640, height: 360 };
  const ctx = recordingContext(events);
  const drawFrame = () => draw(mgr, {
    ctx, canvas, worldX: 137, originX: 0, A: palette, B: palette, t: 0,
    dn: { sunAlt: 0.6, moonAlt: 0.6, sunAz01: 0.5, moonAz01: 0.5 },
    phenomenaFull: false, particleMul: 0, groundView: null, skyVoyage: null,
  });
  if (complete) assert.doesNotThrow(drawFrame);
  else assert.throws(drawFrame, error => error === STOP_AFTER_FIRST_SHADE);
  return { events, strip, canvas };
}

for (const kind of KINDS) {
  test(`the ${kind} world shades the exact static range it blits`, () => {
    const { events, strip, canvas } = firstRangeContract(kind, WORLD_RENDERERS.get(kind));
    const shade = events.at(-1);
    const blits = events.slice(0, -1);
    assert.ok(blits.length > 0, 'the first range must be tiled before it is shaded');
    const blit = blits.at(-1);
    assert.ok(blits.every(event => event.type === 'blit' && event.strip === strip));
    assert.equal(blit.type, 'blit');
    assert.equal(shade.type, 'shade');
    const [ctxArg, canvasArg, stripArg, scrollX, yOff, layer, alpha, terrainEnergy,
      danceMul, growthMul, options] = shade.args;
    assert.ok(ctxArg && typeof ctxArg.drawImage === 'function');
    assert.equal(canvasArg, canvas);
    assert.equal(stripArg, strip);
    const tile = (blit.x + scrollX) / strip.width;
    assert.ok(Math.abs(tile - Math.round(tile)) < 1e-9,
      'shading and tiled bitmap must use the same scroll phase');
    assert.equal(yOff, blit.y - (canvas.height - strip.height), 'shading and bitmap must use the same y offset');
    assert.equal(layer, 'L2');
    assert.equal(alpha, 1);
    assert.equal(terrainEnergy, 0.75);
    assert.equal(danceMul, 1);
    assert.equal(growthMul, 1);
    assert.deepEqual(options, { geology: false, geometry: 'static' });
  });
}

test('every kind with its own renderer is covered here', () => {
  // If someone adds an eighth world kind, this fails until it is listed
  // above -- which is the point: the omission that caused this bug was
  // silent. Read from the registry rather than matching the dispatch's
  // source, so this pins the set of worlds and not the shape of an if-chain.
  const kinds = [...WORLD_RENDERERS.keys()];
  assert.ok(kinds.length > 0, 'the world renderer registry is empty');
  for (const k of kinds) {
    assert.ok(KINDS.includes(k), `world kind '${k}' has its own renderer but is not covered by this test`);
  }
  assert.equal(kinds.length, KINDS.length);
});

test('the air color is resolved before the dispatch, not after it', () => {
  // _airColor is what every range body and the ground are washed toward. It
  // used to be assigned in the classic path, BELOW the kind dispatch, so for
  // the seven early-returning kinds it was never set at all and every
  // consumer silently fell back to a default.
  const bm = readFileSync('src/world/BiomeManager.js', 'utf8');
  const assigned = bm.indexOf('this._airColor = skyHorizonNight;');
  const dispatch = bm.indexOf('WORLD_RENDERERS.get(this.world?.kind)');
  assert.ok(assigned > 0 && dispatch > 0, 'could not locate both landmarks');
  assert.ok(assigned < dispatch,
    'the air color is resolved after the world-kind dispatch, so non-alpine worlds never get one');
});

test('city complete frame reaches ground setup after its window and wet-sheen passes', () => {
  firstRangeContract('city', WORLD_RENDERERS.get('city'), true);
});

test('Foundry machinery remains in front of the nearest terrain strips', () => {
  const { events } = firstRangeContract('foundry', WORLD_RENDERERS.get('foundry'), true);
  const signature = events.findIndex(e => e.type === 'signature');
  assert.ok(signature > events.findLastIndex(e => e.type === 'shade'));
  assert.ok(signature > events.findIndex(e => e.type === 'ground'), 'fixed ground must not cover the furnace');
});
