// Crest rim falloff. The rim used to be stroked at a constant alpha all the
// way across the frame, which is the one thing a backlit ridge never looks
// like -- a uniform saturated outline reads as neon piping drawn around the
// mountain rather than as light spilling over its edge. These pin the shape
// of the falloff that replaced it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rimGain } from '../src/render/LightField.js';

const W = 960;

test('brightest at the light, dimmest away from it', () => {
  const atLight = rimGain(700, 700, W);
  const nearby = rimGain(760, 700, W);
  const across = rimGain(60, 700, W);
  assert.equal(atLight, 1, 'the point under the light burns at full strength');
  assert.ok(nearby < atLight, 'and it falls off immediately');
  assert.ok(across < nearby);
});

test('it is a falloff, not an on/off mask -- the far side keeps an edge', () => {
  // A rim that vanished completely would lose the edge that separates this
  // ridge from the range behind it, which is the reason it exists at all.
  for (const lightX of [0, 480, 960]) {
    for (let x = 0; x <= W; x += 40) {
      const g = rimGain(x, lightX, W);
      assert.ok(g > 0.1, `x=${x} light=${lightX} went dark at ${g}`);
      assert.ok(g <= 1 + 1e-9, `x=${x} light=${lightX} exceeded 1 at ${g}`);
    }
  }
});

test('symmetric about the light -- no preferred side', () => {
  for (const d of [40, 150, 400]) {
    assert.ok(Math.abs(rimGain(480 + d, 480, W) - rimGain(480 - d, 480, W)) < 1e-12,
      `asymmetric at ${d}px`);
  }
});

test('monotonic: it never brightens as you walk away from the light', () => {
  let prev = Infinity;
  for (let x = 300; x <= W; x += 15) {
    const g = rimGain(x, 300, W);
    assert.ok(g <= prev + 1e-12, `rim brightened again at x=${x}`);
    prev = g;
  }
});

test('the bright region is tight, not a smear across the whole sky', () => {
  // Quadratic falloff: by a third of the frame away it should already be
  // well down, or the rim goes back to reading as a uniform outline.
  assert.ok(rimGain(480 + W / 3, 480, W) < 0.7);
  assert.ok(rimGain(480 + W / 2, 480, W) < 0.5);
});

test('scale-invariant in the frame, and safe at degenerate widths', () => {
  // The same relative position gives the same gain at any canvas size --
  // the rim shouldn't change character between a phone and a desktop.
  assert.ok(Math.abs(rimGain(480, 240, 960) - rimGain(240, 120, 480)) < 1e-12);
  assert.ok(Number.isFinite(rimGain(0, 0, 0)));
  assert.ok(Number.isFinite(rimGain(100, 0, 0)));
});

test('a light parked off-frame still lights the near edge more than the far', () => {
  // celestialXFrac can put the body past the edge of the canvas.
  assert.ok(rimGain(0, -200, W) > rimGain(W, -200, W));
});
