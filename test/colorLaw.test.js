import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIDIO_IDENTITY_HUE, HAZARD_HEX, HAZARD_HUE, REWARD_HEX, REWARD_HUE } from '../src/render/ColorLaw.js';
import { drawMeshEdges } from '../src/render/MeshDrawer.js';
import { hexToRgb } from '../src/utils/color.js';

test('the three protected hues are distinct, finite degrees in [0,360)', () => {
  for (const h of [MIDIO_IDENTITY_HUE, HAZARD_HUE, REWARD_HUE]) {
    assert.ok(Number.isFinite(h) && h >= 0 && h < 360);
  }
  assert.notEqual(MIDIO_IDENTITY_HUE, HAZARD_HUE);
  assert.notEqual(MIDIO_IDENTITY_HUE, REWARD_HUE);
  assert.notEqual(HAZARD_HUE, REWARD_HUE);
});

test('HAZARD_HUE/REWARD_HUE are genuinely derived from HAZARD_HEX/REWARD_HEX, not independent guesses', () => {
  const h = (hex) => {
    const { r, g, b } = hexToRgb(hex);
    const max = Math.max(r, g, b) / 255, min = Math.min(r, g, b) / 255;
    if (max === min) return 0;
    const d = max - min;
    switch (max) {
      case r / 255: return (60 * (((g - b) / 255 / d) % 6) + 360) % 360;
      case g / 255: return 60 * ((b - r) / 255 / d + 2);
      default: return 60 * ((r - g) / 255 / d + 4);
    }
  };
  assert.ok(Math.abs(h(HAZARD_HEX) - HAZARD_HUE) < 0.01);
  assert.ok(Math.abs(h(REWARD_HEX) - REWARD_HUE) < 0.01);
});

test('drawMeshEdges never varies hue by edge angle: a horizontal and a vertical edge get the identical stroke hue', () => {
  const calls = [];
  const ctx = {
    save() {}, restore() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {},
    stroke() { calls.push(this._stroke); },
    set strokeStyle(v) { this._stroke = v; },
    set lineWidth(_v) {}, set lineJoin(_v) {}, set lineCap(_v) {},
  };
  // Same hub, one edge horizontal, one vertical -- under the old angle-
  // driven hue term these landed on opposite ends of the hue band.
  const mesh = { vertices: [{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 }], edges: [[0, 1], [0, 2]] };
  const points = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 0, y: 50 }];
  const restLengths = [50, 50]; // exact match -> zero deform -> no glow-pass stroke to filter out
  drawMeshEdges(ctx, mesh, restLengths, points, 178);
  assert.equal(calls.length, 2, 'expected exactly one stroke per edge (no deform-glow pass)');
  const hueOf = (s) => Number(s.match(/hsla\((\d+)/)[1]);
  assert.equal(hueOf(calls[0]), hueOf(calls[1]), `edges of different angles produced different hues: ${calls[0]} vs ${calls[1]}`);
  assert.equal(hueOf(calls[0]), 178);
});

