// The static forest's six materials, pinned to what main 7d48f2f built:
// vertex and fragment shaders, defines, blend and depth state, side,
// default attributes, uniform names and creation order. The rail draws
// these, so they must not change when the forest gains other materials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinPlaced, forestPins, MAIN_PINS } from './helpers/forestShaderPins.mjs';

test('the static forest materials are the ones main built', () => {
  assert.deepEqual(forestPins(pinPlaced()), MAIN_PINS);
});
