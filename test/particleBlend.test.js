import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawParticleBlend, particleBlendAlphas } from '../src/world/WorldDraw.js';

test('different particle fields use complementary weights that sum to the opening gain', () => {
  const open = 1;
  const half = particleBlendAlphas(0.5, open, false, 1);
  assert.ok(Math.abs(half.outgoing - 0.5) < 1e-9);
  assert.ok(Math.abs(half.incoming - 0.5) < 1e-9);
  assert.ok(Math.abs(half.outgoing + half.incoming - open) < 1e-9);
  const start = particleBlendAlphas(0, open, false, 1);
  assert.equal(start.outgoing, 1);
  assert.equal(start.incoming, 0);
  const end = particleBlendAlphas(1, open, false, 1);
  assert.equal(end.outgoing, 0);
  assert.equal(end.incoming, 1);
});

test('matching names are one full-strength field, and the caller alpha is kept', () => {
  const same = particleBlendAlphas(0.4, 0.5, true, 0.8);
  assert.ok(Math.abs(same.outgoing - 0.4) < 1e-9);
  assert.equal(same.incoming, 0);
  const split = particleBlendAlphas(0.5, 1, false, 0.5);
  assert.ok(Math.abs(split.outgoing - 0.25) < 1e-9);
  assert.ok(Math.abs(split.incoming - 0.25) < 1e-9);
});

test('drawParticleBlend fades the outgoing field instead of holding it at full', () => {
  const drawn = [];
  const ctx = {
    _a: 0.8,
    get globalAlpha() { return this._a; },
    set globalAlpha(v) { this._a = v; },
    save() {},
    restore() {},
  };
  const fields = new Map([
    ['A', { draw(_ctx, mul) { drawn.push(['A', mul, ctx.globalAlpha]); } }],
    ['B', { draw(_ctx, mul) { drawn.push(['B', mul, ctx.globalAlpha]); } }],
  ]);
  const mgr = {
    currentBlend: { from: 'A', to: 'B' },
    openingGain: 1,
    unravel: 0,
    _rotated: (hex) => hex,
    lerpCache: { get: (a) => a },
    fields,
    _perf: { rimLightEnabled: false },
  };
  const A = { name: 'A', celestial: { haloColor: '#fff' } };
  const B = { name: 'B', celestial: { haloColor: '#fff' } };
  drawParticleBlend(mgr, {
    ctx, A, B, t: 0.5, worldX: 0, originX: 0, particleMul: 2,
  }, 0.6, null);
  assert.deepEqual(drawn, [
    ['A', 1.2, 0.4],
    ['B', 1.2, 0.4],
  ]);
});
