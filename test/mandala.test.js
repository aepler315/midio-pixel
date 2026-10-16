import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Mandala, ROSETTE_TABLE } from '../src/world/Mandala.js';

function gcd(a, b) { return b === 0 ? a : gcd(b, a % b); }

test('ROSETTE_TABLE has exactly 12 entries, all genuinely coprime (p,q) pairs', () => {
  assert.equal(ROSETTE_TABLE.length, 12);
  for (const [p, q] of ROSETTE_TABLE) {
    assert.ok(Number.isInteger(p) && Number.isInteger(q) && p > q && q >= 2);
    assert.equal(gcd(p, q), 1, `[${p},${q}] must be coprime for the curve to close exactly`);
  }
});

test('reseed(pc) is deterministic and pulls exactly from ROSETTE_TABLE, layer 2 a fifth above layer 1', () => {
  const m = new Mandala(7);
  m.reseed(3);
  assert.deepEqual(m.layers[0].pair, ROSETTE_TABLE[3]);
  assert.deepEqual(m.layers[1].pair, ROSETTE_TABLE[(3 + 7) % 12]);
});

test('reseed(pc) wraps out-of-range pitch classes the same way as an in-range one', () => {
  const a = new Mandala(1);
  const b = new Mandala(1);
  a.reseed(2);
  b.reseed(2 + 12);
  assert.deepEqual(a.layers[0].pair, b.layers[0].pair);
  assert.deepEqual(a.layers[1].pair, b.layers[1].pair);

  const c = new Mandala(1);
  c.reseed(-1); // should behave like pc 11
  assert.deepEqual(c.layers[0].pair, ROSETTE_TABLE[11]);
});

test('reseed does not touch rotation state (rot), only the shape ratio -- no visual snap on the spin', () => {
  const m = new Mandala(5);
  const rot0 = m.layers[0].rot, rot1 = m.layers[1].rot;
  m.reseed(9);
  assert.equal(m.layers[0].rot, rot0);
  assert.equal(m.layers[1].rot, rot1);
});
