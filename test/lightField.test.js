import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLight, celestialScreenPos, lightDirTo, groundGlowLights, characterGlowLight } from '../src/render/LightField.js';

test('computeLight carries celestialYFrac through so contact shadows can stretch at the horizon', () => {
  const light = computeLight({ canvasWidth: 1280, canvasHeight: 720, celestialYFrac: 0.22, budget: 1 });
  assert.equal(light.celestialYFrac, 0.22);
});

test('light position tracks celestialYFrac and matches the celestial\'s own screen anchor', () => {
  const params = { canvasWidth: 1280, canvasHeight: 720, celestialYFrac: 0.22, budget: 1 };
  const light = computeLight(params);
  const pos = celestialScreenPos(1280, 720, 0.22);
  assert.equal(light.x, pos.x);
  assert.equal(light.y, pos.y);

  const higher = computeLight({ ...params, celestialYFrac: 0.6 });
  assert.ok(higher.y > light.y, 'a larger yFrac should move the light further down the canvas');
});

test('intensity is 0 once unravel reaches 1, regardless of budget', () => {
  const light = computeLight({ canvasWidth: 1280, canvasHeight: 720, budget: 1, unravel: 1 });
  assert.equal(light.intensity, 0);
});

test('intensity scales with budget and softens during dawn/dusk washes', () => {
  const full = computeLight({ canvasWidth: 1280, canvasHeight: 720, budget: 1, unravel: 0, dayArcAlpha: 0 });
  const dim = computeLight({ canvasWidth: 1280, canvasHeight: 720, budget: 1, unravel: 0, dayArcAlpha: 0.3 });
  const half = computeLight({ canvasWidth: 1280, canvasHeight: 720, budget: 0.5, unravel: 0, dayArcAlpha: 0 });
  assert.ok(dim.intensity < full.intensity);
  assert.ok(Math.abs(half.intensity - full.intensity * 0.5) < 1e-9);
});

test('color equals the crossfaded halo color passed in verbatim', () => {
  const light = computeLight({ canvasWidth: 1280, canvasHeight: 720, budget: 1, haloColorHex: '#abcdef' });
  assert.equal(light.colorHex, '#abcdef');
});

test('reducedFlash compresses intensity variance rather than capping a peak', () => {
  const dim = computeLight({ canvasWidth: 1280, canvasHeight: 720, budget: 0, reducedFlash: false });
  const bright = computeLight({ canvasWidth: 1280, canvasHeight: 720, budget: 1, reducedFlash: false });
  const dimReduced = computeLight({ canvasWidth: 1280, canvasHeight: 720, budget: 0, reducedFlash: true });
  const brightReduced = computeLight({ canvasWidth: 1280, canvasHeight: 720, budget: 1, reducedFlash: true });

  const spread = bright.intensity - dim.intensity;
  const spreadReduced = brightReduced.intensity - dimReduced.intensity;
  assert.ok(spreadReduced < spread, `expected a compressed spread, got ${spreadReduced} vs ${spread}`);
  assert.ok(spreadReduced > 0, 'reducedFlash should compress, not eliminate, the swing');
});

test('lightDirTo returns a unit vector pointing from the light toward the target', () => {
  const light = { x: 0, y: 0 };
  const dir = lightDirTo(light, 3, 4);
  assert.ok(Math.abs(dir.x - 0.6) < 1e-9);
  assert.ok(Math.abs(dir.y - 0.8) < 1e-9);
  assert.ok(Math.abs(Math.hypot(dir.x, dir.y) - 1) < 1e-9);
});

// --- Secondary lights (dynamic ground-glow / character glow) ---

test('groundGlowLights is empty when no glow is active, and never throws on missing input', () => {
  assert.deepEqual(groundGlowLights([], '#ffcc66'), []);
  assert.deepEqual(groundGlowLights(null, '#ffcc66'), []);
});

test('groundGlowLights carries each glow\'s screen position and the halo color, scaled down from the raw envelope', () => {
  const [l] = groundGlowLights([{ x: 200, y: 480, intensity: 1 }], '#ffcc66');
  assert.equal(l.x, 200);
  assert.equal(l.y, 480);
  assert.equal(l.colorHex, '#ffcc66');
  assert.ok(l.intensity > 0 && l.intensity < 1, 'a ground pulse should be modest, not as strong as a raw envelope of 1');
  assert.ok(l.radius > 0 && Number.isFinite(l.radius), 'a ground light must have a bounded, finite reach');
});

test('groundGlowLights drops glows below a negligible intensity instead of emitting a dead light', () => {
  const lights = groundGlowLights([{ x: 0, y: 0, intensity: 0.001 }], '#ffcc66');
  assert.deepEqual(lights, []);
});

test('characterGlowLight returns null below a negligible intensity, so callers can filter with a plain truthy check', () => {
  assert.equal(characterGlowLight(10, 20, 200, 0.01), null);
});

test('characterGlowLight carries hueDeg directly (no hex round-trip) plus a bounded radius', () => {
  const l = characterGlowLight(10, 20, 200, 0.5);
  assert.equal(l.x, 10);
  assert.equal(l.y, 20);
  assert.equal(l.hueDeg, 200);
  assert.equal(l.intensity, 0.5);
  assert.ok(l.radius > 0 && Number.isFinite(l.radius));
});

test('hidden shared celestial state cannot regain direct intensity from reduced flash', () => {
  const light = computeLight({ canvasWidth: 1280, canvasHeight: 720, reducedFlash: true,
    celestialState: { activeBody: null, sun: { xFrac: .08, yFrac: .6, directGain: 0 }, moon: { xFrac: .92, yFrac: .6, directGain: 0 } } });
  assert.equal(light.intensity, 0);
});
