// The Landscape renderer is downloaded by RangePresentation's own loaders
// (three bundle + a dynamic import of RangeScene.js). A module that fails to
// parse or link there (e.g. a merge that kept both sides of an import, so
// `ACTOR_IDS` is declared twice) only surfaces in the browser as
// "Could not prepare the landscape: runtime-unavailable: ...". Load the
// runtime exactly the way production does so that breaks here first.
// test/moduleGraph.test.mjs checks every other module the same way.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RangePresentation } from '../src/world/alpine/RangePresentation.js';

test('the Landscape runtime downloads through the production loaders', async () => {
  const p = new RangePresentation({ mode: 'v2', shots: false, retryDelaysMs: [] });
  const [THREE, sceneModule] = await p._downloadRuntime();
  assert.equal(typeof THREE.Scene, 'function', 'three bundle loaded');
  assert.equal(typeof sceneModule.RangeScene, 'function', 'RangeScene.js parsed, linked and exported RangeScene');
});

test('preparing the Landscape gets past the runtime download', async (t) => {
  const p = new RangePresentation({ mode: 'v2', shots: false, retryDelaysMs: [] });
  p._availabilityChanged = () => {};
  t.mock.method(console, 'warn', () => {});
  await p._ensureRuntime();
  t.after(() => p.scene?.dispose?.());
  // Node has no DOM, so the renderer itself may refuse to start. Only a
  // failed download (a module that does not parse or link) schedules a
  // retry; a renderer that cannot start does not.
  assert.equal(p._runtimeRetryAt, null, `the runtime download failed: ${p.reason}`);
  if (p.runtimeState === 'failed') assert.match(p.reason, /^runtime-unavailable: /);
  else assert.equal(p.runtimeState, 'ready');
});
