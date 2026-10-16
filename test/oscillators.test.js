import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModalRing, hypotrochoid } from '../src/render/oscillators.js';

test('ModalRing starts silent, gains energy on excite, and rings down toward zero', () => {
  const ring = new ModalRing({ seed: 7 });
  assert.equal(ring.energy, 0);
  ring.excite(3);
  const struck = ring.energy;
  assert.ok(struck > 0, 'excite should inject amplitude');

  for (let i = 0; i < 240; i++) ring.update(1 / 120); // 2 seconds of decay
  assert.ok(ring.energy < struck * 0.05, `expected near-complete ring-down, got ${ring.energy} of ${struck}`);
});

test('ModalRing displacement is bounded by total live amplitude', () => {
  const ring = new ModalRing({ seed: 7 });
  ring.excite(5);
  for (let step = 0; step < 50; step++) {
    ring.update(1 / 120);
    for (let i = 0; i < 32; i++) {
      const theta = (i / 32) * Math.PI * 2;
      assert.ok(Math.abs(ring.displacementAt(theta)) <= ring.energy + 1e-9);
    }
  }
});

test('ModalRing higher modes decay faster than the fundamental', () => {
  const ring = new ModalRing({ modes: 4, seed: 7 });
  ring.excite(3);
  const before = ring.modes.map((m) => m.A);
  for (let i = 0; i < 60; i++) ring.update(1 / 120);
  const ratios = ring.modes.map((m, k) => m.A / before[k]);
  for (let k = 1; k < ratios.length; k++) {
    assert.ok(ratios[k] < ratios[k - 1], `mode ${k} should retain less energy than mode ${k - 1}`);
  }
});

test('ModalRing per-mode amplitude respects its cap under repeated strikes', () => {
  const ring = new ModalRing({ seed: 7 });
  for (let i = 0; i < 50; i++) ring.excite(10);
  for (const m of ring.modes) assert.ok(m.A <= 3 + 1e-9);
});

test('hypotrochoid closes exactly after theta = 2*pi*q for coprime (p,q)', () => {
  for (const [p, q] of [[5, 2], [7, 3], [8, 3], [9, 4], [11, 4]]) {
    const d = 1.3 * q;
    const a = hypotrochoid(0, p, q, d);
    const b = hypotrochoid(2 * Math.PI * q, p, q, d);
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-9, `(${p},${q}) should close after ${q} turns`);
  }
});

test('hypotrochoid stays within its analytic max radius (R-r)+d', () => {
  const [p, q] = [9, 4];
  const d = 1.1 * q;
  const maxR = (p - q) + d;
  for (let i = 0; i < 500; i++) {
    const theta = (i / 500) * 2 * Math.PI * q;
    const pt = hypotrochoid(theta, p, q, d);
    assert.ok(Math.hypot(pt.x, pt.y) <= maxR + 1e-9);
  }
});
