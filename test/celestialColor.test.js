import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager } from '../src/world/BiomeManager.js';
import { LerpCache } from '../src/utils/color.js';
import { resolveCelestialState } from '../src/world/CelestialState.js';
import { getWorld } from '../src/world/Worlds.js';

function fixture() {
  const A = { celestial: { type: 'sun', color: '#eef4ff', haloColor: '#9fe6c8', radius: 40 } };
  const B = { celestial: { type: 'sun', color: '#ffddaa', haloColor: '#ff0088', radius: 40 } };
  const mgr = Object.assign(Object.create(BiomeManager.prototype), {
    currentBlend: { from: A, to: B, t: .35 }, _profile: x => x, lerpCache: new LerpCache(),
    world: getWorld('alpine'), _rotationCache: new Map(), _specShift: 27, sectionHueBias: 0,
    _drawCompanions() {}, reducedFlash: true,
  });
  return { mgr, A, B };
}
test('physical sun colour follows authored body blend and is independent of decorative halos', () => {
  const { mgr, A, B } = fixture();
  const color = mgr.currentCelestialColor();
  const expected = mgr.lerpCache.get(mgr._rotated(A.celestial.color), mgr._rotated(B.celestial.color), .35);
  assert.equal(color, expected);
  const state = () => resolveCelestialState({ timeMs: 21000, cycleMs: 100000, viewport: { width: 960, height: 540 }, sunColor: mgr.currentCelestialColor() });
  const before = state(); A.celestial.haloColor = '#00ff00'; B.celestial.haloColor = '#ff0000';
  assert.deepEqual(state(), before);
  A.celestial.color = '#aaccff'; assert.notEqual(state().sun.colorHex, before.sun.colorHex);
});
test('both painted celestial bodies consume the final resolved physical colour during travel', () => {
  const { mgr, A, B } = fixture(), painted = [];
  const resolved = resolveCelestialState({ timeMs: 21000, cycleMs: 100000, viewport: { width: 960, height: 540 }, sunColor: '#ddecfa' }).sun;
  mgr._drawOneCelestial = (_ctx, _x, _y, body) => painted.push(body);
  const ctx = { save() {}, restore() {}, beginPath() {}, arc() {}, fill() {} };
  mgr._drawCelestial(ctx, { width: 960, height: 540 }, A, B, .35, .2, 1, .5, resolved);
  assert.equal(painted.length, 2);
  for (const body of painted) assert.equal(body.color, resolved.colorHex);
  assert.notEqual(painted[0].haloColor, painted[1].haloColor, 'decorative halo colours remain authored');
});
