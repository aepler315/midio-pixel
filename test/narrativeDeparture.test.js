import test from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '../src/render/Renderer.js';

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
