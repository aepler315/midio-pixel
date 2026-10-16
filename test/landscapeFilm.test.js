import test from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '../src/render/Renderer.js';

test('film diagnostic suppression removes grade, space wash and vignette together', () => {
  let operations = 0;
  const ctx = { save() {}, restore() {}, fillRect() { operations++; },
    createRadialGradient() { return { addColorStop() {} }; } };
  Renderer.prototype._drawFilmFinish.call({ _filmLerpCache: { get: () => '#8899aa' } }, ctx,
    { width: 1280, height: 720 }, { filmFinish: { warmth: 0.5, vignetteDepth: 0.3 },
      biomes: { _pass: () => false } });
  assert.equal(operations, 0);
});
