// Slippery surfaces: settled snow -> lost grip -> bounded render-only skids,
// plus WeatherDirector's ground-cover accumulation itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skidOffset, skidParams, tractionFrom, SKID_MAX_PX, SKID_MIN_COVER } from '../src/sim/Traction.js';
import { WeatherDirector } from '../src/sim/WeatherDirector.js';

test('skidOffset: zero at both ends, positive in between, bounded by 1.1', () => {
  assert.equal(skidOffset(0), 0);
  assert.equal(skidOffset(1), 0);
  assert.equal(skidOffset(-0.5), 0);
  assert.equal(skidOffset(2), 0);
  let peak = 0;
  for (let u = 0.01; u < 1; u += 0.01) {
    const v = skidOffset(u);
    assert.ok(v >= -0.05, `never slides backwards past the anchor, got ${v} at ${u}`);
    peak = Math.max(peak, v);
  }
  assert.ok(peak > 0.6 && peak <= 1.1, `a real slide with a bounded shape, got peak ${peak}`);
});

test('skidParams: grip below the cover threshold, bounded slides above it', () => {
  assert.equal(skidParams(0, 0.9), null, 'dry ground never skids');
  assert.equal(skidParams(SKID_MIN_COVER - 0.01, 0.9), null);
  assert.equal(skidParams(0.9, 0.1), null, 'a feather landing does not slide');
  const s = skidParams(1, 1);
  assert.ok(s.amp <= SKID_MAX_PX, 'the hard rail on screen offset holds');
  assert.ok(s.durMs > 400, 'deep cover slides longer');
  const shallow = skidParams(0.4, 1);
  assert.ok(shallow.amp < s.amp, 'less cover, shorter slide');
});

test('tractionFrom: dry rock is 1, full ice floors at 0.3', () => {
  assert.equal(tractionFrom(0), 1);
  assert.ok(Math.abs(tractionFrom(1) - 0.3) < 1e-9);
  assert.ok(tractionFrom(0.5) > tractionFrom(1));
});

test('WeatherDirector: sustained snowfall settles ground cover; other skies melt it', () => {
  const w = new WeatherDirector();
  // Force a live snowfall directly (kind defaults to snow) and integrate.
  w.intensity = 0.9;
  for (let t = 0; t < 30000; t += 100) w.update(t, 0.1, { valence: 0, energySlow: 0.9 });
  assert.ok(w.groundCover > 0.5, `expected real accumulation after ~30s of snow, got ${w.groundCover}`);
  assert.ok(w.state.groundCover === w.groundCover, 'cover rides the public state');

  // A mood swing to petals melts it back down.
  const covered = w.groundCover;
  for (let t = 30000; t < 50000; t += 100) w.update(t, 0.1, { valence: 0.9, energySlow: 0.9 });
  assert.ok(w.groundCover < covered * 0.3, `expected a thaw under petals, got ${w.groundCover} (was ${covered})`);
});

// The skid must move Midio's BODY, never the world->screen origin that
// ground/obstacles/burrow anchor on -- folding it into midioX translated
// the whole world with him and cancelled the visible slide.
test('lerpState: stage anchor owns the world origin independently of deprecated actor coordinates', async () => {
  const { Simulation } = await import('../src/sim/Simulation.js');
  const stub = {
    prev: { worldX: 0, midioY: 540, slipX: 10, scaleX: 1, scaleY: 1, leanDeg: 0 },
    curr: { worldX: 2, midioY: 540, slipX: 20, scaleX: 1, scaleY: 1, leanDeg: 0 },
    stageAnchor: { x: 220 },
    midio: { screenX: 999, slipX: 20 },
    jump: { airborne: false },
  };
  const pose = Simulation.prototype.lerpState.call(stub, 0.5);
  assert.equal(pose.originX, 220, 'stage origin never slips or follows an actor');
  assert.equal(pose.midioX, 220, 'deprecated origin alias remains compatible');
  assert.ok(Math.abs(pose.midioDrawX - 235) < 1e-9, 'his body slides by the lerped skid (15px)');
});
