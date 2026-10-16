import test from 'node:test';
import assert from 'node:assert/strict';
import { BiomeManager } from '../src/world/BiomeManager.js';

// A real horizon painter with a recording canvas; only the palette lookup is
// fixed so contrast can be checked against a known dusky sky.
function paintedHorizon({ budget = .08, band = .35, openingGain = 1, reducedFlash = false } = {}) {
  const manager = Object.create(BiomeManager.prototype);
  manager.lerpCache = { get: a => a };
  manager._rotated = color => color;
  manager._horizonCrest = null;
  manager.tSec = 20;
  manager.durationMs = 96000;
  manager._eqSmoothed = Float32Array.from({ length: 7 }, () => band);
  manager.budget = budget;
  manager.openingGain = openingGain;
  manager.reducedFlash = reducedFlash;
  const strokes = [], saved = [];
  const ctx = {
    globalAlpha: 1, globalCompositeOperation: 'source-over', strokeStyle: '', lineWidth: 1,
    save() { saved.push({ alpha: this.globalAlpha, blend: this.globalCompositeOperation }); },
    restore() { const state = saved.pop(); this.globalAlpha = state.alpha; this.globalCompositeOperation = state.blend; },
    beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {},
    stroke() { strokes.push({ alpha: this.globalAlpha, width: this.lineWidth,
      color: this.strokeStyle, blend: this.globalCompositeOperation }); },
  };
  const profile = { celestial: { haloColor: '#774826' } };
  manager._drawHorizonEQ(ctx, { width: 1280, height: 720 }, 0, profile, profile, 0);
  return strokes;
}

function luminance(hex) {
  const [r, g, b] = hex.match(/[0-9a-f]{2}/gi).map(n => parseInt(n, 16));
  return .2126 * r + .7152 * g + .0722 * b;
}

test('the Dancing Ridge stays distinctly luminous in a subdued scene', () => {
  const sky = luminance('#69515f');
  const strokes = paintedHorizon();
  const contrast = Math.max(...strokes.map(s => s.alpha * (luminance(s.color) - sky)));
  assert.ok(contrast >= 55, `best ridge stroke adds only ${contrast.toFixed(1)} luma over dusk`);
  assert.ok(strokes.some(s => s.width >= 6 && s.alpha > .07), 'a contained halo surrounds the crisp line');
  assert.ok(strokes.every(s => s.width <= 16), 'the glow does not become a wide sky wash');
});

test('music strengthens the halo while reduced flash keeps a steady bright crest', () => {
  const quiet = paintedHorizon({ band: .04, budget: .4 });
  const active = paintedHorizon({ band: .9, budget: .4 });
  const reduced = paintedHorizon({ band: .9, budget: .4, reducedFlash: true });
  const glowWeight = strokes => strokes.filter(s => s.width >= 4)
    .reduce((sum, s) => sum + s.width * s.alpha, 0);
  assert.ok(glowWeight(active) > glowWeight(quiet) * 1.35, 'a loud section visibly lights its contour');
  assert.ok(glowWeight(reduced) < glowWeight(active), 'reduced flash limits the energetic halo');
  assert.ok(reduced.some(s => s.width <= 3 && s.alpha >= .55), 'steady crest survives reduced flash');
});

test('the crest respects the opening fade without vanishing at the lowest scene budget', () => {
  const normal = paintedHorizon({ budget: 0 });
  const opening = paintedHorizon({ budget: 0, openingGain: .35 });
  const hidden = paintedHorizon({ budget: 0, openingGain: 0 });
  const crest = strokes => strokes.find(s => s.width <= 3)?.alpha ?? 0;
  assert.ok(crest(normal) >= .6, 'the contour remains visible when decorative effects shed');
  assert.ok(crest(opening) < crest(normal) * .4, 'the opening still fades the contour in');
  assert.deepEqual(hidden, [], 'the first opening frame draws no ridge');
});
