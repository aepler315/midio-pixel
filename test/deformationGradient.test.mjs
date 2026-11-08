import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFORM_GLSL } from '../src/world/alpine/TerrainDeform.js';
import { LAND_TOUR_FADE_END_M } from '../src/world/alpine/LandMotionLimits.js';
import * as gradient from '../src/world/alpine/DeformationGradient.js';

const fieldBody = DEFORM_GLSL.match(/float deformField\(float h, float along, float across\) \{([\s\S]*?)\n {2}\}/)[1];
const names = ['uDeformAmp', 'uDeformKick', 'uDeformStructural', 'uDeformMelodic',
  'uDeformGesture', 'uDeformK', 'uDeformPhase', 'uMelodyK', 'uMelodyPhase'];
const field = new Function('h', 'along', 'across', ...names, 'sin', fieldBody);
const clamp = v => Math.max(0, Math.min(1, v));
const smooth = (lo, hi, v) => { const t = clamp((v - lo) / (hi - lo)); return t * t * (3 - 2 * t); };
const fade = (y, eye, w) => 1 + w * (smooth(1500, LAND_TOUR_FADE_END_M, Math.abs(y - eye)) - 1);

function evaluateGradientY() {
  assert.ok(gradient, 'the factored gradient module is available');
  const source = gradient.FACTORED_DEFORM_GRAD_GLSL;
  const match = source.match(/float deformGradientY\(([^)]*)\) \{([\s\S]*?)\n {2}\}/);
  assert.ok(match, 'execute the production scalar GLSL helper');
  const parameters = match[1].split(',').map(v => v.trim().replace(/^float /, ''));
  return new Function(...parameters, match[2].replace(/\bfloat\b/g, 'let'));
}

test('the gradient experiment requires its exact opt-in query value', () => {
  assert.ok(gradient, 'the factored gradient module is available');
  for (const search of ['', '?other=factored', '?deformGradient=reference', '?deformGradient=1',
    '?deformGradient=Factored', '?deformGradient=factored-extra']) {
    assert.equal(gradient.deformationGradientMode(search), 'reference', search);
  }
  for (const search of ['?deformGradient=factored', '?other=1&deformGradient=factored']) {
    assert.equal(gradient.deformationGradientMode(search), 'factored', search);
  }
});

test('the production scalar factorization preserves the reference y stencil for every music channel', () => {
  const factored = evaluateGradientY();
  let state = 0x61a7d;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
  for (let i = 0; i < 2500; i++) {
    const values = names.map(() => (random() * 2 - 1) * 100);
    values[5] = 2 * Math.PI / 4800;
    values[7] = 2 * Math.PI / (2400 + random() * 2400);
    const along = random() * 100000 - 50000, across = random() * 100000 - 50000;
    const lo = random() * 3000 - 1500, span = Math.max(1, random() * 4000);
    const y = lo - 2 + random() * (span + 4), hPlus = clamp((y + 1 - lo) / span), hMinus = clamp((y - 1 - lo) / span);
    const receiver = i % 5 === 0 ? 0 : i % 5 === 1 ? 1 : random();
    const dance = i % 3 === 0 ? 0 : (random() * 2 - 1) * 180;
    const eye = random() * 10000 - 5000, tour = i % 3 === 0 ? 0 : i % 3 === 1 ? 1 : random();
    const fadePlus = fade(y + 1, eye, tour), fadeMinus = fade(y - 1, eye, tour);
    const noGesture = [...values]; noGesture[4] = 0;
    const harmonic = field(1, along, across, ...noGesture, Math.sin);
    const at = (h, f) => receiver * f * field(h, along, across, ...values, Math.sin) + receiver * f * dance;
    const expected = (at(hPlus, fadePlus) - at(hMinus, fadeMinus)) / 2;
    const actual = factored(hPlus, hMinus, harmonic, values[4], receiver, tour === 0 ? 0 : dance, fadePlus, fadeMinus);
    assert.ok(Math.abs(actual - expected) < 1e-10, `case ${i}: ${actual} vs ${expected}`);
  }
});

test('the factorization retains clamped-height and tour-shoulder stencil behavior', () => {
  const factored = evaluateGradientY();
  const values = [31, 17, -11, 14, 12, 2 * Math.PI / 4800, 1.1, 2 * Math.PI / 2400, -.7];
  const noGesture = [...values]; noGesture[4] = 0;
  const harmonic = field(1, 912, -632, ...noGesture, Math.sin);
  for (const [lo, hi] of [[-300, 1800], [10, 10.2], [-100, -100]]) {
    const span = Math.max(1, hi - lo);
    for (const y of [lo - 1.01, lo - 1, lo - .01, lo, lo + .01, lo + 1,
      lo + span - 1, lo + span - .01, lo + span, lo + span + .01, lo + span + 1]) {
      const hPlus = clamp((y + 1 - lo) / span), hMinus = clamp((y - 1 - lo) / span);
      for (const distance of [0, 1499, 1500, 1501, 3999, 4000, 4001]) {
        for (const receiver of [0, .01, .5, 1]) {
          const eye = y - distance, fp = fade(y + 1, eye, 1), fm = fade(y - 1, eye, 1), dance = 37;
          const at = (h, f) => receiver * f * field(h, 912, -632, ...values, Math.sin) + receiver * f * dance;
          const expected = (at(hPlus, fp) - at(hMinus, fm)) / 2;
          assert.ok(Math.abs(factored(hPlus, hMinus, harmonic, values[4], receiver, dance, fp, fm) - expected) < 1e-12);
        }
      }
    }
  }
});
