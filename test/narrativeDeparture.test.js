import test from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '../src/render/Renderer.js';
import { SpaceRidge } from '../src/world/SpaceRidge.js';

test('departed performers never allocate reflection captures', () => {
  const renderer = Object.create(Renderer.prototype);
  renderer.reflectionsEnabled = true;
  renderer._capture = { capture() { throw new Error('departed body captured'); } };
  const bounds = () => ({ x: 0, y: 0, w: 100, h: 100 });
  const sim = { rangeNarrativeAt: () => ({ cast: { midio: 0, broshi: 0, midasus: 0 } }),
    broshi: { drawBounds: bounds }, midio: { groundY: 0 },
    midasus: { drawBounds: bounds, voyage: { depth: 0 }, yFloor: 0, p: { y: 0 } } };
  const biomeManager = { _rangeV2Active: true, rangePresentation: { frame: { frameId: 1 } },
    _groundReceivers: { pools: [{ polygon: [{ x: -1000 }, { x: 1000 }] }] } };
  const captured = renderer._captureCastForReflections({}, sim, { midioDrawX: 0, midioY: 0 }, biomeManager, {}, {});
  assert.deepEqual(captured, { broshi: null, midio: null, midasus: null });
});

test('SpaceRidge keeps its landscape but loses the satellite with Midasus', () => {
  const strokes = [];
  const ctx = { globalAlpha: 1, save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {},
    closePath() {}, fill() {}, arc() {}, createLinearGradient: () => ({ addColorStop() {} }),
    stroke() { strokes.push(this.lineWidth); } };
  const ridge = new SpaceRidge(4);
  ridge.draw(ctx, { width: 1280, height: 720 }, '#abcdef', 50, false, 1, .5, false, 0);
  assert.ok(strokes.length > 30, 'principal ridge survives');
  assert.ok(!strokes.includes(1.4), 'the tumbling satellite is absent');
});
