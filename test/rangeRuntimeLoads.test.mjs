// The Landscape renderer is downloaded by RangePresentation's own loaders
// (three bundle + a dynamic import of RangeScene.js). A module that fails to
// parse or link there (e.g. a merge that kept both sides of an import, so
// `ACTOR_IDS` is declared twice) only surfaces in the browser as
// "Could not prepare the landscape: runtime-unavailable: ...". Load the
// runtime exactly the way production does so that breaks here first.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RangePresentation } from '../src/world/alpine/RangePresentation.js';

test('the Landscape runtime downloads through the production loaders', async () => {
  const p = new RangePresentation({ mode: 'v2', shots: false, retryDelaysMs: [] });
  const [THREE, sceneModule] = await p._downloadRuntime();
  assert.equal(typeof THREE.Scene, 'function', 'three bundle loaded');
  assert.equal(typeof sceneModule.RangeScene, 'function', 'RangeScene.js parsed, linked and exported RangeScene');
});

test('a Landscape runtime load never fails on a module syntax or link error', async () => {
  const p = new RangePresentation({ mode: 'v2', shots: false, retryDelaysMs: [] });
  p._availabilityChanged = () => {};
  await p._ensureRuntime();
  // Without WebGL the scene may still refuse to start in Node; that is a
  // renderer failure, not a broken module graph.
  if (p.runtimeState === 'failed') {
    assert.doesNotMatch(p.reason, /already been declared|does not provide an export|SyntaxError|Cannot find module|Unexpected token/,
      `runtime failed to load: ${p.reason}`);
  } else {
    assert.equal(p.runtimeState, 'ready');
  }
  p.scene?.dispose?.();
});
